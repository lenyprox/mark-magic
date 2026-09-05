// Per-card scripts (B7): a checked-in JSON file per oracle id under data/scripts/ that overrides or completes what
// the oracle-text parser produced for that card. The parser stays the generator of first drafts; a script is the
// canonical, reviewed form. A script names the oracle text hash it was written against so a Scryfall refresh that
// changes the card's text flags the script as stale instead of silently applying it.
//
// Layout (format v2, plan 1.5): data/scripts/<first two hex chars of the oracle id>/<oracle_id>.json — 256 shards so
// the directory stays usable at ~34k files. Flat files at the root are still read (and `scripts:shard` migrates them).
//
// A script never asserts that a card is finished. It CLAIMS the card's oracle lines one at a time — by an ability
// that carries behaviour and whose `text` is the line, by the face's keywords, by a typed `covers` entry naming the
// declaration that implements the line, or by an `ignore` entry the whitelist accepts — and `applyScript` re-derives
// `unparsed` from what is left over. `fullyParsed` is "nothing unclaimed AND nothing `unknown` anywhere in the face",
// for EVERY face that has playable text (front, `backFace`, and `secondFace` for split / adventure / flip) and in
// both modes.
//
// Every claim is BUDGETED, so that a claim always costs the author real behaviour:
//
//   * an ability claims a line only when it has a SUBSTANTIVE effect (`substantiveCount`: parser-internal fold
//     markers and `unknown` count 0), and only one line per substantive effect (`abilityClaimProblem`);
//   * a keyword claims a line only when the face declares that keyword's PARAMETER too (`Ward {2}` needs
//     `wardCost: 2`, not just `ward` — `keywordLineProblem`);
//   * a `covers` entry claims a line only when the declaration it names exists on the face, the line matches an
//     ANCHORED shape that declaration prints, and the declared VALUE is the one the line prints (`COVER_RULES`);
//   * no line may be claimed twice (`faceClaimProblems`).
//
// See `substantiveCount`, `abilityClaimProblem`, `keywordLineProblem`, `coverProblem`, `claimedLines` and
// `secondFaceUnclaimed`.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
import { keywordFromText } from './parse.js';
import type { PoolTier } from './pool.js';
import type { Ability, AbilityCost, AltCost, AsEnters, CardDef, Condition, CostModifier, Effect, Filter, Keyword, ManaCost } from './types.js';

/** Where a script came from. Precedence for `put()`: hand > reviewed > llm > generated. */
export type ScriptSource = 'generated' | 'llm' | 'reviewed' | 'hand';

/** Ascending authority. A lower-ranked script never overwrites a higher-ranked one without `force`. */
export const SOURCE_RANK: Record<ScriptSource, number> = { generated: 0, llm: 1, reviewed: 2, hand: 3 };

/** Why a line is deliberately not simulated. Only lines that cannot matter inside a game may be ignored. */
export const IGNORE_REASONS = [
  'draft-matters',        // "Draft X face up" and other limited-only text
  'ante',                 // playing for ante (CR 104.3a; ante cards are banned in every sanctioned format)
  'outside-the-game',     // wishes, sideboard, "from outside the game"
  'deck-construction',    // "A deck can have any number of cards named ~", companion-style build rules
  'un-physical',          // physical-world un-set mechanics (dexterity, assembling contraptions)
  'digital-only',         // Arena/Alchemy-only mechanics (conjure, perpetually, seek)
] as const;

export type IgnoreReason = typeof IGNORE_REASONS[number];

export interface IgnoredLine {
  /** The line exactly as `scriptableLines(def)` names it (a normalised oracle line, or a fragment the parser itself reported). */
  line: string;
  reason: IgnoreReason;
}

/**
 * A WHITELIST, not a denylist: a line may be ignored only when it matches the pattern of the reason given (matched
 * case-insensitively against the normalised line, back-face `// ` marker stripped). A denylist of "simulable verbs"
 * was the previous rule and it failed in both directions — it passed anything without a listed verb ("Destroy target
 * creature." was the only class it caught) while its per-reason exemptions were broad enough that a
 * deck-construction marker excused ordinary game text. Every entry below is a phrase that can only appear in text
 * outside the game.
 *
 * `un-physical` and `digital-only` additionally require the card's pool tier (`tierOf(row)`): un-set physical
 * mechanics are ignorable only on an `un` card, Alchemy keywords only on a `digital` one, so a paper card can never
 * be waved through by claiming its text is an un-card's. Neither is a blanket exemption for its tier: an un-card's
 * line must ALSO name a physical-world marker, because most of an un-card's text is ordinary Magic that the engine
 * has to run.
 */
const REASON_RULE: Record<IgnoreReason, RegExp> = {
  // "Draft ~ face up.", "Reveal ~ as you draft it.", conspiracies and the "as you draft a card" clauses
  'draft-matters': /^(draft ~ face up|reveal ~ as you draft|.*\byou drafted\b|.*\bdraft(ed)? (a |this )?card\b|.*\bconspiracy\b)/i,
  'ante': /\bante\b/i,
  'outside-the-game': /\bfrom outside the game\b/i,
  // whole-line phrases only: these are the printed deck-building keywords, never a clause inside game text
  'deck-construction': /^(partner(\b.*)?|choose a background|doctor's companion|friends forever|companion — .*|a deck can have any number of cards named ~\.?|commander enchantment|spell commander|legendary landwalk)$/i,
  // A CONSERVATIVE APPROXIMATION of "this clause happens outside the game state": the physical-world verbs and nouns
  // un-set text uses (dexterity, speech, the artwork, the sticker sheet, the shop). It is deliberately broader than
  // the true set — `word`, `name a card` and `vote` also occur in ordinary Magic — and is only reachable at all on a
  // card whose pool tier is `un`, where the surrounding rules are already outside the engine's contract. Un-card text
  // that is ordinary Magic ("Draw a card.") matches nothing here and must be scripted like any other line.
  'un-physical': /\b(flip ~ onto|physically|dexterity|toss|touch|say|speak|sing|whisper|shout|clap|name a (card|word)|letters?|word|art(ist|work)?|flavor|watermark|border|silver|rules text|hidden|game store|judge|outside the game|host|augment|contraption|attraction|sticker|vote)\b/i,
  'digital-only': /\b(conjure|seek|perpetual|spellbook|draft a card from)/i,
};

/** Reasons that are only available to one pool tier, whatever the line says. */
const REASON_TIER: Partial<Record<IgnoreReason, PoolTier>> = { 'un-physical': 'un', 'digital-only': 'digital' };

/**
 * Whether a line may be ignored for the reason given: `null` when it may, otherwise why it may not.
 * `scripts:check` turns a non-null result into a problem, and `applyScript` honours an `ignore` entry ONLY when this
 * returns `null` — so an invalid ignore leaves its line unparsed at runtime instead of being caught by the tool
 * alone. Both pass the card's pool tier (`tierOf(row)`); `applyScript` defaults it to `'paper'`, the strictest tier.
 */
export function ignoreLineProblem(line: string, reason: IgnoreReason, tier?: PoolTier): string | null {
  const norm = normalizeOracleLine(line.trim().replace(/^\/\/ /, ''));
  const needTier = REASON_TIER[reason];
  if (needTier && tier !== needTier) {
    return `is only available to a card in the '${needTier}' pool tier (this card is ${tier ? `'${tier}'` : 'of an unknown tier'})`;
  }
  const rule = REASON_RULE[reason];
  if (!rule) return `is not a known ignore reason`;
  if (rule.test(norm)) return null;
  return `does not match the '${reason}' rule ${rule.source} — script the line instead of ignoring it`;
}

/**
 * Tool-owned verification block (plan 1.5 / 2.2). `applyScript` never reads it; `scriptHash` excludes it so a
 * verification run never invalidates itself.
 */
export interface Verification {
  at: string;
  parserVersion: number;
  registryHash: string;
  oracleHash: string;
  /** `scriptHash(script)` at the time the verification ran; a mismatch means the verification is stale. */
  scriptHash: string;
  schema: 'ok' | 'fail';
  lint: 'ok' | 'warn' | 'fail';
  sandbox: {
    seats2: 'ok' | 'throws' | 'invariant' | 'unreachable';
    seats4: 'ok' | 'throws' | 'invariant' | 'unreachable';
    abilities: { index: number; reached: boolean; how?: string }[];
  };
  roundTrip: { score: number; lowest: { text: string; rendered: string; score: number }[] };
  scenarios: { file: string; passed: number; failed: number; names: string[] };
  judge?: { model: string; verdict: 'faithful' | 'unfaithful' | 'uncertain'; issues: string[]; at: string }[];
  status: 'scripted' | 'verified' | 'tested' | 'judged';
  problems: string[];
}

/**
 * The DECLARATION a `covers` entry points at. Every non-ability field a face can declare has a kind here, so a
 * covered line always names the thing that implements it — `covers` is never an anonymous budget.
 */
export const COVER_KINDS = [
  'keywords', 'altCosts', 'asEnters', 'costModifiers', 'kicker', 'cycling', 'entersTapped', 'morph', 'cascade',
  'storm', 'rebound', 'dredge', 'graveyardReplacement', 'protection', 'ward', 'additionalCosts', 'toxic', 'bushido',
  'rampage', 'landwalk', 'firebending',
] as const;

export type CoverKind = typeof COVER_KINDS[number];

/** One oracle line claimed by a named declaration rather than by an ability of its own. */
export interface CoverEntry {
  /** The line exactly as `scriptableLines(def)` names it. */
  line: string;
  /** Which declaration on this face accounts for it. */
  by: CoverKind;
}

/**
 * The scriptable part of one card face. `CardScript` carries these for the front face, `backFace` for the back face
 * of a transforming / modal DFC, and `secondFace` for the second half of a split / adventure / flip card.
 *
 * Every non-ability declaration the parser can put on a `CardDef` is here, so the format can express everything the
 * parser can — and so every `covers` entry has a real declaration to name.
 */
export interface ScriptFace {
  keywords?: Keyword[];
  abilities?: Ability[];
  altCosts?: AltCost[];
  asEnters?: AsEnters[];
  costModifiers?: CostModifier[];
  additionalCosts?: AbilityCost[];
  kicker?: ManaCost;
  cycling?: ManaCost;
  cyclingSearch?: Filter;
  entersTapped?: boolean | { unless: Condition };
  morph?: { cost: ManaCost; megamorph?: boolean; disguise?: boolean };
  cascade?: boolean;
  storm?: boolean;
  rebound?: boolean;
  dredge?: number;
  graveyardReplacement?: 'exile' | 'shuffle';
  protectionFrom?: string[];
  wardCost?: number;
  toxic?: number;
  bushido?: number;
  rampage?: number;
  landwalk?: string[];
  firebending?: number;
  /**
   * Oracle lines (as `scriptableLines(def)` names them) this face claims WITHOUT an ability of its own — the only way
   * a non-ability declaration can account for a line. There is no wildcard and no budget: each entry names the
   * declaration that covers it (`by`), and `coverProblem` checks that the declaration is really on this face AND that
   * the line has the shape that declaration produces. A throwaway keyword therefore buys nothing.
   */
  covers?: CoverEntry[];
}

export interface CardScript extends ScriptFace {
  oracleId: string;
  name: string;
  /** fnv-1a of the normalised oracle text the script was written for (see oracleHash). */
  oracleHash: string;
  source: ScriptSource;
  /** 0..1 confidence for generated/llm scripts; reviewed/hand scripts are 1. */
  confidence?: number;
  /** 'replace' (default): the script's declarations stand in for the parser's, and only they claim lines; 'extend': they are appended to the parser's and both sets of claims count. */
  mode?: 'replace' | 'extend';
  /** Back face of a transforming / modal double-faced card; applied to `def.backFace` with the same semantics. */
  backFace?: ScriptFace;
  /**
   * Second half of a `split` / `adventure` / `flip` card — the face whose `faces[1].oracle_text` the PARSER never
   * looks at (parse.ts:1146 parses `faces[0]` only, and builds a `backFace` for `transform` / `modal_dfc` alone).
   * Its lines are lines a script must claim all the same: a script that finishes only the first half is not
   * `fullyParsed`. See `secondFaceLines`.
   */
  secondFace?: ScriptFace;
  /** Oracle lines that are deliberately not simulated. They are dropped from `unparsed` and do not block `fullyParsed`. */
  ignore?: IgnoredLine[];
  /** Scenario names in test/scenarios/ that verify this script. */
  scenarios?: string[];
  aiHints?: { role?: string; value?: number; timing?: 'main' | 'instant' | 'end-step' | 'response' };
  notes?: string;
  /** Written by `scripts:verify`; never hand-edited and never part of `scriptHash`. */
  verification?: Verification;
}

export interface ScriptStatus { applied: boolean; stale: boolean; source?: ScriptSource; confidence?: number }

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export function oracleHash(text: string): string { return fnv1a(text.replace(/\s+/g, ' ').trim()); }

/** JSON.stringify with object keys sorted, so a re-serialised script hashes the same whatever the key order was. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

/**
 * fnv-1a of the script with `verification` removed and every object's keys sorted. Stable across key order and
 * across verification write-backs, so `verification.scriptHash !== scriptHash(script)` means the script itself
 * changed since it was verified.
 */
export function scriptHash(script: CardScript): string {
  const { verification: _drop, ...rest } = script;
  void _drop;
  return fnv1a(stableStringify(rest));
}

// ---------------------------------------------------------------------------
// Oracle line normalisation — the same transformation `parse.ts` applies before it splits a card into lines, so
// `covers` / `ignore` entries can be compared to what the parser saw. Exposed so the tools do not re-derive it.
// ---------------------------------------------------------------------------

/** Ability words carry no rules meaning (CR 207.2c); the parser strips them. Mirrors parse.ts:ABILITY_WORD_RE. */
const ABILITY_WORD_RE = /^(Revolt|Converge|Delirium|Metalcraft|Threshold|Landfall|Domain|Morbid|Raid|Ferocious|Formidable|Hellbent|Spell mastery|Flurry|Imprint|Constellation|Coven|Magecraft|Pack tactics|Alliance|Celebration|Valiant|Eerie|Survival|Paradox|Corrupted|Fateful hour|Lieutenant|Undergrowth|Enrage|Adamant|Addendum|Kinship|Chroma|Grandeur|Radiance|Parley|Descend \d+|Fathomless descent|Max speed|Heist|Mayhem|Job select|Renew|Endure|Exhaust|Mobilize|Harmonize|Behold|Channel|Battalion|Heroic|Inspired|Bloodrush|Strive|Tempting offer|Will of the council|Council's dilemma|Secret council|Cohort|Rally|Sweep|Join forces|Hero's reward|Undaunted|Legacy|Eminence|Start your engines!) — /i;

const FLAVOUR_PREFIX_RE = /^(?![IVX]+ — )[A-Z0-9][^—.]{0,30} — (?=When\b|Whenever\b|At |\{|[A-Z])/;

/** Normalise a whole oracle text the way `parseCard` does: card name -> `~`, reminder text dropped, `−` -> `-`. */
export function normalizeOracleText(text: string, cardName: string): string {
  const shortName = cardName.split(' // ')[0];
  const nick = shortName.includes(',') ? shortName.split(',')[0] : null;
  const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let norm = text.replace(new RegExp(escaped, 'g'), '~');
  if (nick) norm = norm.replace(new RegExp(nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g'), '~');
  norm = norm.replace(/\bthis (creature|permanent|artifact|enchantment|land|spell|planeswalker|saga|vehicle|aura|equipment|card)\b/gi, '~').replace(/\(([^)]*)\)/g, '').replace(/−/g, '-');
  const cut = norm.split('\n');
  const back = cut.findIndex(l => l.trim().startsWith('//'));
  return back >= 0 ? cut.slice(0, back).join('\n') : norm;
}

/** Strip the per-line prefixes the parser removes before it matches a line (ability words, "Foo — " flavour heads). */
export function normalizeOracleLine(line: string): string {
  return line.trim().replace(ABILITY_WORD_RE, '').replace(FLAVOUR_PREFIX_RE, '').trim();
}

/**
 * Every oracle LINE of a card as the parser normalises it: the front face's lines, any modal bullet embedded in a
 * line, and the back face's lines prefixed with `// ` (the marker `parse.ts` uses for back-face text). Deduplicated
 * and order-preserving — a line that is itself a bullet is emitted once, not twice.
 *
 * This is not by itself the set an authored `covers` / `ignore` may name: `parse.ts` also reports sub-sentence
 * FRAGMENTS in `unparsed` (`e.text` at parse.ts:1357 and `• ${e.text}` at parse.ts:1401), and 4,736 of the pool's
 * 35,108 unparsed entries — 13.5%, across 2,716 cards, e.g. Veil of Summer's "Spells you control can't be countered
 * this turn." — are such fragments and appear in no whole line. Use `scriptableLines(def)` for the authoring
 * contract; this function is the oracle-text half of it.
 */
export function normalizeOracleLines(def: Pick<CardDef, 'name' | 'oracleText' | 'layout' | 'faces' | 'backFace'>): string[] {
  const text = (def.faces && def.faces.length > 1 && ['adventure', 'split', 'transform', 'modal_dfc', 'flip'].includes(def.layout))
    ? (def.faces[0].oracleText ?? '')
    : (def.oracleText ?? '');
  const out: string[] = [];
  const push = (l: string) => { const t = l.trim(); if (t && !out.includes(t)) out.push(t); };
  for (const raw of normalizeOracleText(text, def.name).split('\n')) {
    const line = normalizeOracleLine(raw);
    if (!line) continue;
    push(line);
    // a line that *starts* with a bullet is already the bullet; only split a line that embeds further ones
    if (line.indexOf('• ') > 0) for (const bullet of line.split(/\n?• /).slice(1)) push('• ' + bullet.trim());
  }
  if (def.backFace) for (const l of normalizeOracleLines(def.backFace)) push('// ' + l);
  return out;
}

/**
 * The exact set of strings a script's `covers` / `ignore` may name for this card, and what `scripts:check` validates
 * against: every normalised oracle line (above) plus every entry the parser actually put in `unparsed` — including
 * the back face's own, prefixed with `// `. The parser's `unparsed` is authoritative because it reports some clauses
 * as fragments rather than whole lines (see `normalizeOracleLines`); copying from `def.unparsed` is always correct.
 */
export function scriptableLines(def: Pick<CardDef, 'name' | 'oracleText' | 'layout' | 'faces' | 'backFace' | 'unparsed'>): string[] {
  const out: string[] = [];
  const push = (l: string) => { const t = l.trim(); if (t && !out.includes(t)) out.push(t); };
  for (const l of normalizeOracleLines(def)) push(l);
  for (const u of def.unparsed) push(u);
  if (def.backFace) for (const u of def.backFace.unparsed) push('// ' + u.trim());
  // the second half of a split / adventure / flip card: real lines a script must claim, which the parser never sees
  for (const l of secondFaceLines(def)) push(l);
  return out;
}

/**
 * The lines ONE face's own `covers` entries may name — its normalised oracle lines (modal bullets included) plus the
 * entries the parser itself reported unparsed for that face. `scriptableLines` is the whole card; this is the per-face
 * split `scripts:check` needs so a front-face `covers` entry cannot claim a back-face line. Call it on `def` for the
 * front face and on `def.backFace` for the back; the second face has no `CardDef`, so use `secondFaceLines`.
 */
export function faceScriptableLines(def: Pick<CardDef, 'name' | 'oracleText' | 'layout' | 'faces' | 'backFace' | 'unparsed'>): string[] {
  const out: string[] = [];
  const push = (l: string) => { const t = l.trim(); if (t && !out.includes(t)) out.push(t); };
  for (const l of normalizeOracleLines({ ...def, backFace: undefined })) push(l);
  for (const u of def.unparsed) push(u);
  return out;
}

export const DEFAULT_SCRIPTS_DIR = () => path.join(projectRoot(), 'data', 'scripts');

/** The shard directory name for an oracle id: its first two hex characters. */
export function shardOf(oracleId: string): string { return oracleId.slice(0, 2).toLowerCase(); }

/** Directories under data/scripts that hold tooling output, never scripts. */
const NON_SHARD_DIRS = new Set(['drafts', 'reports', 'batches', 'blocked', '_quarantine', 'scenarios']);

const SHARD_RE = /^[0-9a-f]{2}$/;

/** Script file names are oracle ids (Scryfall UUIDs); anything else under data/scripts is tooling output. */
export const ORACLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scriptIdOf = (fileName: string) => {
  if (!fileName.endsWith('.json')) return null;
  const id = fileName.slice(0, -5);
  return ORACLE_ID_RE.test(id) ? id : null;
};

/** Lazily indexed script directory: `<2-hex>/<oracle_id>.json` shards plus any flat `<oracle_id>.json` at the root. */
export class ScriptStore {
  private index: Map<string, string> | null = null;
  private cache = new Map<string, CardScript | null>();
  constructor(readonly dir: string = DEFAULT_SCRIPTS_DIR()) {}

  private load() {
    if (this.index) return;
    this.index = new Map();
    if (!fs.existsSync(this.dir)) return;
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (NON_SHARD_DIRS.has(e.name) || !SHARD_RE.test(e.name)) continue;
        const sub = path.join(this.dir, e.name);
        for (const f of fs.readdirSync(sub)) { const id = scriptIdOf(f); if (id) this.index.set(id, path.join(sub, f)); }
      } else {
        // flat files are still accepted (scripts:shard migrates them); a shard entry wins
        const id = scriptIdOf(e.name);
        if (id && !this.index.has(id)) this.index.set(id, path.join(this.dir, e.name));
      }
    }
  }
  size(): number { this.load(); return this.index!.size; }
  ids(): string[] { this.load(); return [...this.index!.keys()]; }
  /** The file a script for this id is (or would be) read from. */
  fileOf(oracleId: string): string | undefined { this.load(); return this.index!.get(oracleId); }
  /** The canonical (sharded) path a `put()` writes to, whether or not the file exists. */
  pathFor(oracleId: string): string { return path.join(this.dir, shardOf(oracleId), `${oracleId}.json`); }

  get(oracleId: string): CardScript | null {
    this.load();
    if (this.cache.has(oracleId)) return this.cache.get(oracleId)!;
    const file = this.index!.get(oracleId);
    let script: CardScript | null = null;
    if (file) { try { script = JSON.parse(fs.readFileSync(file, 'utf8')) as CardScript; } catch { script = null; } }
    this.cache.set(oracleId, script);
    return script;
  }

  /**
   * Write (or overwrite) a script into its shard. Precedence hand > reviewed > llm > generated: a lower-ranked source
   * never overwrites a higher-ranked one, and an `llm` script only overwrites another `llm` script when the existing
   * one carries no passing verification (status 'verified' or better). `force` overrides everything.
   */
  put(script: CardScript, opts: { force?: boolean } = {}): boolean {
    this.load();
    const existing = this.get(script.oracleId);
    if (existing && !opts.force && !this.mayOverwrite(script, existing)) return false;
    const file = this.pathFor(script.oracleId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(script, null, 2) + '\n');
    // a flat file for the same id would shadow nothing (the shard wins) but would linger; drop it
    const flat = path.join(this.dir, `${script.oracleId}.json`);
    if (flat !== file && fs.existsSync(flat)) fs.rmSync(flat);
    this.index!.set(script.oracleId, file); this.cache.set(script.oracleId, script);
    return true;
  }

  private mayOverwrite(next: CardScript, existing: CardScript): boolean {
    const a = SOURCE_RANK[next.source] ?? 0, b = SOURCE_RANK[existing.source] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
    // same rank: only `llm` is restricted — it must not discard a verified sibling
    if (next.source !== 'llm') return true;
    return !isVerified(existing);
  }

  /** Forget cached contents (tests). */
  reset() { this.index = null; this.cache.clear(); }
}

/** True when the script carries a verification that reached 'verified' or better. */
export function isVerified(script: CardScript): boolean {
  const s = script.verification?.status;
  return s === 'verified' || s === 'tested' || s === 'judged';
}

let shared: ScriptStore | null = null;
export function scriptStore(): ScriptStore { return (shared ??= new ScriptStore()); }
export function useScriptStore(store: ScriptStore | null) { shared = store; }

// ---------------------------------------------------------------------------
// Line-claim accounting
//
// A face is finished when every oracle LINE of that face is claimed and nothing in it is `unknown`. Nothing else
// counts: a script that lists `covers` entries but declares no behaviour, or one whose declarations still contain an
// `unknown` marker, leaves the card unfinished however it is written.
// ---------------------------------------------------------------------------

/**
 * True when the value (an ability, effect, condition, static effect or trigger event, at any depth) contains an
 * `unknown` variant. A generic walk rather than a hand-written recursion over `conditional` / `optional-then` /
 * `optional-pay` / `choose-mode` / `delayed-trigger` / `gain-ability`: those are exactly the nested carriers, and a
 * new one added to `types.ts` is covered the day it is added. `{ op: 'unknown' }`, `{ kind: 'unknown' }` and
 * `{ on: 'unknown' }` are the only shapes in the AST that use the word.
 */
export function hasUnknown(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnknown);
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (o.op === 'unknown' || o.kind === 'unknown' || o.on === 'unknown') return true;
  return Object.values(o).some(hasUnknown);
}

/** Everything about one face that must be free of `unknown` for the face to count as simulated. */
function faceHasUnknown(def: CardDef): boolean {
  return hasUnknown(def.abilities) || hasUnknown(def.altCosts) || hasUnknown(def.asEnters)
    || hasUnknown(def.costModifiers) || hasUnknown(def.additionalCosts) || hasUnknown(def.entersTapped);
}

// ---------------------------------------------------------------------------
// Substantive effects
//
// "Does this ability DO anything?" is asked twice: once to decide whether it may claim its oracle line at all, and
// once as a BUDGET — an ability may claim at most one line per thing it does.
// ---------------------------------------------------------------------------

/**
 * The `Effect` ops that carry no behaviour of their own: the parser-internal markers `types.ts` lists under
 * "parser-internal markers folded into the previous effect (never reach the engine)", plus `unknown`. `parse.ts`
 * emits them so a later pass can fold them into the effect before them; the engine never executes one. An ability
 * built out of nothing but markers therefore implements no oracle line, and claims none.
 */
export const MARKER_OPS = [
  'alt-if-target', 'alt-take', 'fold-counter-if-yours', 'alt-kicked-amount', 'fold-restriction', 'fold-alt-mana',
  'fold-new-targets', 'unknown',
] as const;

const MARKER_OP_SET: ReadonlySet<string> = new Set<string>(MARKER_OPS);

/** Ops whose whole content is other effects: substantive only when something inside them is. */
const CONTAINER_OPS: ReadonlySet<string> = new Set<string>([
  'conditional', 'optional-then', 'optional-pay', 'choose-mode', 'delayed-trigger', 'gain-ability',
]);

/**
 * Every `Effect[]` nested anywhere inside ONE effect's own fields, found generically — an array whose every element
 * is an object with an `op`. `conditional.then` / `.else`, `optional-then.first` / `.then`, `optional-pay.then`,
 * `delayed-trigger.effects` and `choose-mode.modes[i]` are all covered without a hand-written list, and so is any
 * container added to `types.ts` later.
 */
function nestedEffectArrays(effect: Effect): Effect[][] {
  const out: Effect[][] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      if (v.length && v.every(x => !!x && typeof x === 'object' && !Array.isArray(x) && 'op' in (x as object))) { out.push(v as Effect[]); return; }
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  for (const v of Object.values(effect as unknown as Record<string, unknown>)) walk(v);
  return out;
}

/**
 * How many of these effects DO something.
 *
 *   * a `MARKER_OPS` op counts 0 — it is a parser-internal fold marker, not behaviour;
 *   * a CONTAINER (`conditional`, `optional-then`, `optional-pay`, `delayed-trigger`, plus any op the generic walk
 *     finds a nested `Effect[]` in) counts 1 only when it holds at least one substantive effect, recursively;
 *   * `choose-mode` counts once per SUBSTANTIVE MODE: each mode is a separate thing the card can do, and a two-mode
 *     spell printed as two lines needs both;
 *   * `gain-ability` counts 1 when the ability it grants is itself substantive;
 *   * everything else counts 1.
 *
 * This is the budget `abilityClaimProblem` spends: one line per substantive effect, so a single `draw` cannot buy a
 * three-line card. An activated mana ability whose only effect is `add-mana` counts 1 — `add-mana` is not a marker.
 */
export function substantiveCount(effects: readonly Effect[] | undefined): number {
  let n = 0;
  for (const e of effects ?? []) {
    if (!e || typeof e !== 'object') continue;
    const op = (e as { op?: string }).op;
    if (!op || MARKER_OP_SET.has(op)) continue;
    if (op === 'choose-mode') {
      for (const mode of (e as Extract<Effect, { op: 'choose-mode' }>).modes ?? []) if (substantiveCount(mode) > 0) n++;
      continue;
    }
    if (op === 'gain-ability') {
      const granted = (e as Extract<Effect, { op: 'gain-ability' }>).ability;
      if (granted && abilityIsSubstantive(granted)) n++;
      continue;
    }
    const nested = nestedEffectArrays(e);
    if (CONTAINER_OPS.has(op) || nested.length) { if (nested.some(arr => substantiveCount(arr) > 0)) n++; continue; }
    n++;
  }
  return n;
}

/**
 * Whether an ability CARRIES BEHAVIOUR, and so may claim an oracle line at all. Without this a script of empty
 * abilities — one per line, each with the right `text` — would read as fully simulated while doing nothing in the
 * engine, and a script of fold markers would do the same one level down.
 *
 *   * `spell` / `triggered` / `activated`: `substantiveCount(effects) >= 1`;
 *   * `static`: an `effect` whose `kind` is not `unknown`.
 *
 * An `unknown` anywhere inside the ability disqualifies it too, so the line it was meant to cover is reported as
 * unclaimed rather than silently swallowed.
 *
 * The parser's own output contains 56 empty-effect abilities across the 34,513-card pool (Populate, Manifest dread,
 * Amass, "The Ring tempts you", …), so the PARSER-output schema (`AbilitySchema`) stays lenient and only the
 * SCRIPT-level schema requires an effect. Those 56 cards are already not `fullyParsed`.
 */
export function abilityIsSubstantive(ability: Ability): boolean {
  if (!ability || hasUnknown(ability)) return false;
  if (ability.kind === 'static') return !!ability.effect && ability.effect.kind !== 'unknown';
  return substantiveCount(ability.effects) > 0;
}

// ---------------------------------------------------------------------------
// Keyword lines
// ---------------------------------------------------------------------------

/**
 * The face fields a keyword line's PARAMETER is checked against. `Ward {2}` is not implemented by the bare `ward`
 * keyword — the engine needs `wardCost: 2` — so a keyword claim compares the printed number to the declared one.
 */
export type KeywordParams = Pick<ScriptFace, 'keywords' | 'protectionFrom' | 'wardCost' | 'toxic' | 'bushido' | 'rampage' | 'landwalk' | 'firebending'>;

/** Numeric keyword lines: the printed shape, the keyword it needs, and the field that must carry the number. */
const PARAM_KEYWORD: [re: RegExp, keyword: Keyword, field: 'toxic' | 'bushido' | 'rampage' | 'firebending'][] = [
  [/^toxic (\d+)$/i, 'toxic', 'toxic'],
  [/^bushido (\d+)$/i, 'bushido', 'bushido'],
  [/^rampage (\d+)$/i, 'rampage', 'rampage'],
  [/^firebending (\d+|x)$/i, 'firebending', 'firebending'],
];

const LANDWALK_RE = /^(plains|island|swamp|mountain|forest|desert)walk$/i;
const PROTECTION_RE = /^protection from (.+)$/i;
const WARD_LINE_RE = /^ward (\{(\d+)\}|[—-].+)$/i;

/** The qualities a "Protection from X" line lists, split the way `parse.ts` splits them (parse.ts:1214, :1226). */
function protectionQualities(rest: string): string[] {
  return rest.toLowerCase().replace(/\.$/, '').split(/ and from | and | or |, /).map(s => s.trim()).filter(Boolean);
}

/** The keyword one part of a keyword line names, ignoring its parameter, or null when the part is not a keyword. */
export function keywordOfLinePart(part: string): Keyword | null {
  const p = part.trim().replace(/\.$/, '');
  if (!p) return null;
  if (PROTECTION_RE.test(p)) return 'protection';
  if (WARD_LINE_RE.test(p)) return 'ward';
  if (LANDWALK_RE.test(p)) return 'landwalk';
  for (const [re, kw] of PARAM_KEYWORD) if (re.test(p)) return kw;
  return keywordFromText(p);
}

/**
 * Why one comma-separated part of a keyword line is not implemented by this face, or `null` when it is. The part
 * must name a keyword the face declares AND, for a parameterised keyword, the face must carry the same parameter:
 * `Ward {2}` needs `wardCost: 2`, `Toxic 1` needs `toxic: 1`, `Protection from red` needs `red` in `protectionFrom`,
 * `Swampwalk` needs `Swamp` in `landwalk`. The bare keyword alone never claims a parameterised line.
 */
export function keywordPartProblem(part: string, face: KeywordParams): string | null {
  const p = part.trim().replace(/\.$/, '');
  if (!p) return 'is empty';
  const kws = face.keywords ?? [];
  const needs = (kw: Keyword) => kws.includes(kw) ? null : `${JSON.stringify(p)} needs the '${kw}' keyword (declared ${JSON.stringify(kws)})`;
  let m: RegExpExecArray | null;
  if ((m = PROTECTION_RE.exec(p))) {
    const why = needs('protection'); if (why) return why;
    const have = (face.protectionFrom ?? []).map(s => s.toLowerCase());
    const missing = protectionQualities(m[1]).filter(q => !have.includes(q));
    return missing.length ? `${JSON.stringify(p)} needs protectionFrom to list ${JSON.stringify(missing)} (declared ${JSON.stringify(face.protectionFrom ?? [])})` : null;
  }
  if ((m = WARD_LINE_RE.exec(p))) {
    const why = needs('ward'); if (why) return why;
    if (m[2] !== undefined && face.wardCost !== Number(m[2])) return `${JSON.stringify(p)} needs wardCost ${m[2]} (declared ${String(face.wardCost)})`;
    return null;
  }
  if ((m = LANDWALK_RE.exec(p))) {
    const why = needs('landwalk'); if (why) return why;
    const type = m[1].toLowerCase();
    return (face.landwalk ?? []).some(t => t.toLowerCase() === type) ? null
      : `${JSON.stringify(p)} needs landwalk to list ${JSON.stringify(m[1])} (declared ${JSON.stringify(face.landwalk ?? [])})`;
  }
  for (const [re, kw, field] of PARAM_KEYWORD) {
    if (!(m = re.exec(p))) continue;
    const why = needs(kw); if (why) return why;
    const declared = face[field];
    return String(declared).toLowerCase() === m[1].toLowerCase() ? null
      : `${JSON.stringify(p)} needs ${field} ${m[1]} (declared ${String(declared)})`;
  }
  const k = keywordFromText(p);
  if (!k) return `${JSON.stringify(p)} is not a keyword`;
  return kws.includes(k) ? null : `${JSON.stringify(p)} is not a keyword this face declares (declared ${JSON.stringify(kws)})`;
}

/**
 * Why a whole oracle line is not claimed by this face's keywords, or `null` when it is. The parser splits keyword
 * lines on commas (parse.ts:1212), so "Flying, first strike" needs both keywords and "Ward {2}" needs `wardCost`.
 */
export function keywordLineProblem(line: string, face: KeywordParams): string | null {
  const parts = line.trim().replace(/\.$/, '').split(/,\s*/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return 'is empty';
  for (const p of parts) { const why = keywordPartProblem(p, face); if (why) return why; }
  return null;
}

/** Whether a whole oracle line is nothing but keywords this face has, parameters included. */
export function keywordLineClaimed(line: string, face: KeywordParams): boolean {
  return keywordLineProblem(line, face) === null;
}

// ---------------------------------------------------------------------------
// What an ability claims
// ---------------------------------------------------------------------------

/** The oracle lines an ability's `text` NAMES, normalised the way the parser normalises the card's own text. */
export function abilityNamedLines(text: string, cardName: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeOracleText(text, cardName).split('\n')) {
    const l = normalizeOracleLine(raw);
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

/**
 * The same lines, with a Scryfall MID-SENTENCE BREAK healed: Scryfall sometimes splits one printed sentence across
 * two oracle lines, and such a continuation always starts with a LOWER-CASE letter ("…, then" / "and that creature
 * …"). Those two physical lines are one thing the card says, so they cost one effect from the budget rather than
 * two. A part that starts with a capital, a `{`, a digit or a bullet is a line of its own and is never joined.
 */
export function abilityLogicalLines(text: string, cardName: string): string[] {
  const out: string[] = [];
  for (const l of abilityNamedLines(text, cardName)) {
    if (out.length && /^[a-z]/.test(l)) out[out.length - 1] += ' ' + l;
    else out.push(l);
  }
  return out;
}

/**
 * Why this ability claims NO line, or `null` when it claims the lines its text names. Two rules, both budgets:
 *
 *   1. the ability must carry behaviour at all (`abilityIsSubstantive`);
 *   2. it may name at most one line per SUBSTANTIVE EFFECT (`substantiveCount`). Without this one ability could
 *      name a card's whole text — the parser writes an instant/sorcery's entire face text into its single `spell`
 *      ability (parse.ts:1358) — and finish every line of it with a single `draw`.
 *
 * A `static` / `triggered` / `activated` ability is printed as ONE line, so it may name only one (after the
 * mid-sentence join above); only a `spell` ability may name several, and only as many as it has effects.
 */
export function abilityClaimProblem(ability: Ability, cardName: string): string | null {
  if (!abilityIsSubstantive(ability)) {
    if (hasUnknown(ability)) return 'ability has no substantive effect: it is nothing but an unknown';
    if (ability.kind === 'static') return 'ability has no substantive effect: its static effect is unknown or missing';
    return (ability.effects?.length ?? 0) === 0
      ? 'ability has no substantive effect: it declares no effect'
      : 'ability has no substantive effect: every effect it declares is a parser-internal fold marker';
  }
  const lines = abilityLogicalLines(ability.text, cardName);
  if (lines.length <= 1) return null;
  if (ability.kind !== 'spell') return `ability names ${lines.length} lines but a '${ability.kind}' ability is printed as one line and may name only the one that contains it`;
  const have = substantiveCount(ability.effects);
  return have < lines.length ? `ability names ${lines.length} lines but declares only ${have} substantive effect${have === 1 ? '' : 's'}` : null;
}

/** The oracle lines this ability really claims: the lines its text names, or none when `abilityClaimProblem` fails. */
export function abilityClaimLines(ability: Ability, cardName: string): string[] {
  return abilityClaimProblem(ability, cardName) === null ? abilityNamedLines(ability.text, cardName) : [];
}

/**
 * Every reason this face's abilities and `covers` entries do not claim what they say they do: each ability's
 * `abilityClaimProblem` first, then any line two of them claim. A line claimed twice means one of the two
 * declarations is wrong or redundant, and it hides a line nothing implements behind one that two things do.
 */
export function faceClaimProblems(face: ScriptFace | null | undefined, cardName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const twice = new Set<string>();
  const take = (line: string) => { if (seen.has(line)) twice.add(line); else seen.add(line); };
  for (const a of face?.abilities ?? []) {
    const why = abilityClaimProblem(a, cardName);
    if (why) { out.push(`${why}: ${JSON.stringify(a.text)}`); continue; }
    for (const l of abilityNamedLines(a.text, cardName)) take(l);
  }
  for (const l of validCovers(face)) take(l.replace(/^\/\/ /, ''));
  for (const l of twice) out.push(`line claimed twice: ${JSON.stringify(l)}`);
  return out;
}

// ---------------------------------------------------------------------------
// `covers`: one line, one named declaration, one matched value
// ---------------------------------------------------------------------------

/** Mana symbols as one comparable string: `"{2} {R}"`, `"{2}{R}"` and `"{2}{r}"` are the same cost. */
const manaKey = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase();
/** The run of mana symbols a line prints, in order. */
const manaIn = (s: string) => (s.match(/\{[^}]*\}/g) ?? []).join('');

const NUM_WORD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** "four" / "4" / "any number of" as the AST writes such a count, or null when the word is not a number at all. */
function countWord(s: string): number | 'any' | null {
  const t = s.trim().toLowerCase();
  if (t === 'any number of') return 'any';
  if (/^\d+$/.test(t)) return Number(t);
  return t in NUM_WORD ? NUM_WORD[t] : null;
}

/**
 * One `CoverKind`'s rule: the ANCHORED line shapes it may claim, whether the face declares it at all, and — rule
 * (iii), which was shape-only until now — whether the DECLARED VALUE is the one the line prints. `value` is handed
 * the index of the shape that matched and its capture groups, so `~ enters tapped.` and `~ enters tapped unless …`
 * can demand different declarations from the same kind.
 */
interface CoverRule {
  lines: RegExp[];
  declared: (f: ScriptFace) => boolean;
  value: (f: ScriptFace, m: RegExpExecArray, idx: number) => string | null;
}

/** The `AbilityCost` fields the leading verb of an "additional cost" clause stands for. */
const ADDITIONAL_COST_VERB: [re: RegExp, has: (c: AbilityCost) => boolean, fields: string][] = [
  [/^sacrifice\b/i, c => c.sacrifice !== undefined || c.sacrificeSelf === true, 'sacrifice / sacrificeSelf'],
  [/^discard\b/i, c => c.discard !== undefined || c.discardSelf === true || c.discardHand === true, 'discard / discardSelf / discardHand'],
  [/^pay\b.*\blife\b/i, c => c.payLife !== undefined, 'payLife'],
  [/^exile\b/i, c => c.exileFromHand !== undefined || c.exileFromGraveyard !== undefined || c.exileOtherFromGraveyard !== undefined, 'exileFromHand / exileFromGraveyard / exileOtherFromGraveyard'],
  [/^tap\b/i, c => c.tap === true || c.tapUntappedCreature !== undefined || c.tapCreaturesTotalPower !== undefined, 'tap / tapUntappedCreature / tapCreaturesTotalPower'],
  [/^return\b/i, c => c.returnToHand !== undefined, 'returnToHand'],
];

/** A kind whose declaration carries no value to match: existing at all is the whole of rule (iii). */
const noValue = (): string | null => null;

/** An `AsEnters` of the kind and parameters the line printed, or a description of what is missing. */
function asEntersProblem(f: ScriptFace, want: (a: AsEnters) => boolean, describe: string): string | null {
  return (f.asEnters ?? []).some(want) ? null
    : `the line needs an asEnters entry ${describe}, and this face declares ${JSON.stringify(f.asEnters ?? [])}`;
}

/** An `AltCost` matching the line's keyword and cost, or a description of what is missing. */
function altCostProblem(f: ScriptFace, want: (a: AltCost) => boolean, describe: string): string | null {
  return (f.altCosts ?? []).some(want) ? null
    : `the line needs an altCost ${describe}, and this face declares ${JSON.stringify((f.altCosts ?? []).map(a => ({ id: a.id, mana: a.cost.mana?.raw })))}`;
}

/**
 * THE cover table — every anchored line shape and every value check, in ONE place. `applyScript` (through
 * `validCovers`) and `scripts:check` / `CardScriptChecked` (through `coverProblems`) both read it, so a `covers`
 * entry the tool rejects claims nothing at runtime either.
 *
 * Every regex here is anchored at both ends, and `test/scripts.test.ts` asserts it: an unanchored shape lets a
 * `covers` entry claim any line that merely CONTAINS the keyword.
 */
export const COVER_RULES: Record<CoverKind, CoverRule> = {
  // the whole line must be keywords this face declares, parameters and all — see `keywordLineProblem`
  keywords: {
    lines: [/^.+$/],
    declared: f => !!f.keywords?.length,
    value: (f, m) => keywordLineProblem(m[0], f),
  },
  altCosts: {
    lines: [
      /^(flashback|evoke|warp|buyback|dash)(?:[—-] ?| )(.+?)\.?$/i,
      /^jump-start$/i,
      /^impending (\d+)[—-] ?(\{.+\})$/i,
      /^escape[—-] ?(\{.+\}), exile (.+?)\.?$/i,
      /^(?:if .+?, )?you may (.+?) rather than pay ~'s mana cost\.?$/i,
    ],
    declared: f => !!f.altCosts?.length,
    value: (f, m, idx) => {
      if (idx === 0) {
        const id = m[1].toLowerCase() as AltCost['id'];
        const symbols = manaIn(m[2]);
        // buyback is the one keyword whose altCost holds the TOTAL cost (parse.ts adds the increment to the card's
        // own mana cost), so the printed increment is the tail of the declared raw rather than the whole of it
        const costOk = (a: AltCost) => !symbols || manaKey(a.cost.mana?.raw) === manaKey(symbols)
          || (id === 'buyback' && manaKey(a.cost.mana?.raw).endsWith(manaKey(symbols)));
        return altCostProblem(f, a => a.id === id && costOk(a), `with id '${id}'${symbols ? ` and cost ${symbols}` : ''}`);
      }
      if (idx === 1) return altCostProblem(f, a => a.id === 'jump-start', "with id 'jump-start'");
      if (idx === 2) {
        return altCostProblem(f, a => a.id === 'impending' && manaKey(a.cost.mana?.raw) === manaKey(m[2]) && a.timeCounters === Number(m[1]),
          `with id 'impending', cost ${m[2]} and timeCounters ${m[1]}`);
      }
      if (idx === 3) {
        const want = countWord(m[2].replace(/^(.+?) other cards?\b[\s\S]*$/i, '$1'));
        return altCostProblem(f, a => a.id === 'escape' && manaKey(a.cost.mana?.raw) === manaKey(m[1])
          && (want === null || a.cost.exileOtherFromGraveyard?.count === want),
        `with id 'escape', cost ${m[1]} and exileOtherFromGraveyard.count ${String(want)}`);
      }
      // the pitch clauses: "You may pay 1 life and exile a blue card from your hand rather than pay ~'s mana cost."
      let life: number | undefined; let exile = false;
      for (const part of m[1].split(/ and /i)) {
        const pm = /^pay (\d+) life$/i.exec(part.trim());
        if (pm) { life = Number(pm[1]); continue; }
        if (/^exile .*from your hand$/i.test(part.trim())) exile = true;
      }
      if (life === undefined && !exile) return `the pitch clause ${JSON.stringify(m[1])} names neither "pay N life" nor "exile … from your hand"`;
      return altCostProblem(f, a => (a.id === 'pitch' || a.id === 'life')
        && (life === undefined || a.cost.payLife === life)
        && (!exile || a.cost.exileFromHand !== undefined),
      `with id 'pitch' or 'life'${life === undefined ? '' : `, payLife ${life}`}${exile ? ', exileFromHand' : ''}`);
    },
  },
  asEnters: {
    lines: [
      /^~ enters (?:the battlefield )?tapped\.?$/i,
      /^~ enters (?:the battlefield )?tapped unless (.+?)\.?$/i,
      /^as ~ enters, you may pay (\d+) life\. if you don't, it enters tapped\.?$/i,
      /^(?:if ~ was kicked, it|~) enters with ([a-z]+|\d+) ([+-]1\/[+-]1|[a-z]+) counters? on it(?: (?:if|for each) .+?)?\.?$/i,
      /^as ~ enters, choose a (creature type|color)\.?$/i,
      /^if ~ would enter, you may discard an? (.+?) card instead\. if you do, put ~ onto the battlefield\. if you don't, put it into its owner's graveyard\.?$/i,
    ],
    declared: f => !!f.asEnters?.length,
    value: (f, m, idx) => {
      if (idx === 0) return asEntersProblem(f, a => a.kind === 'tapped', "of kind 'tapped'");
      if (idx === 1) return asEntersProblem(f, a => a.kind === 'tapped-unless', "of kind 'tapped-unless'");
      if (idx === 2) return asEntersProblem(f, a => a.kind === 'pay-life-or-tapped' && a.life === Number(m[1]), `of kind 'pay-life-or-tapped' with life ${m[1]}`);
      if (idx === 3) {
        const counter = m[2].toLowerCase();
        const amount = countWord(m[1]);
        return asEntersProblem(f, a => a.kind === 'counters' && a.counter === counter && (typeof amount !== 'number' || a.amount === amount),
          `of kind 'counters' with counter ${JSON.stringify(counter)}${typeof amount === 'number' ? ` and amount ${amount}` : ''}`);
      }
      if (idx === 4) {
        const what = m[1].toLowerCase() === 'color' ? 'color' : 'creature-type';
        return asEntersProblem(f, a => a.kind === 'choose' && a.what === what, `of kind 'choose' with what '${what}'`);
      }
      return asEntersProblem(f, a => a.kind === 'discard-or-graveyard', "of kind 'discard-or-graveyard'");
    },
  },
  costModifiers: {
    lines: [
      /^(delve|convoke|improvise)$/i,
      /^affinity for (.+?)\.?$/i,
      /^~ costs \{.+\} less to cast(?: .+?)?\.?$/i,
    ],
    declared: f => !!f.costModifiers?.length,
    value: (f, m, idx) => {
      const want = idx === 0 ? m[1].toLowerCase() : 'reduce';
      return (f.costModifiers ?? []).some(c => c.kind === want) ? null
        : `the line needs a costModifier of kind '${want}', and this face declares ${JSON.stringify((f.costModifiers ?? []).map(c => c.kind))}`;
    },
  },
  kicker: {
    lines: [/^(multi)?kicker (\{.+\})$/i],
    declared: f => f.kicker !== undefined,
    value: (f, m) => manaKey(f.kicker?.raw) === manaKey(m[2]) ? null
      : `the line prints kicker ${m[2]} but this face declares ${JSON.stringify(f.kicker?.raw)}`,
  },
  // "Cycling {2}", "Plainscycling {2}", "Basic landcycling {1}{G}" (parse.ts:1296)
  cycling: {
    lines: [/^((?:[a-z]+ )?[a-z]+cycling|cycling) (\{.+\})$/i],
    declared: f => f.cycling !== undefined,
    value: (f, m) => {
      if (manaKey(f.cycling?.raw) !== manaKey(m[2])) return `the line prints cycling ${m[2]} but this face declares ${JSON.stringify(f.cycling?.raw)}`;
      const typed = m[1].toLowerCase() !== 'cycling';
      return typed && f.cyclingSearch === undefined ? `${JSON.stringify(m[1])} is typecycling and needs a cyclingSearch filter` : null;
    },
  },
  entersTapped: {
    lines: [/^~ enters (?:the battlefield )?tapped\.?$/i, /^~ enters (?:the battlefield )?tapped unless (.+?)\.?$/i],
    declared: f => f.entersTapped !== undefined,
    value: (f, _m, idx) => {
      const unless = typeof f.entersTapped === 'object' && f.entersTapped !== null;
      if (idx === 1) return unless ? null : "the line is the 'unless' form, so entersTapped must be { unless: <condition> }";
      if (unless) return 'the line is the unconditional form, so entersTapped must be true';
      return f.entersTapped === true ? null : 'entersTapped is false, so it claims no line';
    },
  },
  morph: {
    lines: [/^(morph|megamorph|disguise) (\{.+\})$/i],
    declared: f => f.morph !== undefined,
    value: (f, m) => {
      const word = m[1].toLowerCase();
      if (manaKey(f.morph?.cost.raw) !== manaKey(m[2])) return `the line prints ${word} ${m[2]} but this face declares ${JSON.stringify(f.morph?.cost.raw)}`;
      if (!!f.morph?.megamorph !== (word === 'megamorph')) return `the line prints '${word}' but megamorph is ${String(!!f.morph?.megamorph)}`;
      if (!!f.morph?.disguise !== (word === 'disguise')) return `the line prints '${word}' but disguise is ${String(!!f.morph?.disguise)}`;
      return null;
    },
  },
  cascade: { lines: [/^cascade$/i], declared: f => f.cascade === true, value: noValue },
  storm: { lines: [/^storm$/i], declared: f => f.storm === true, value: noValue },
  rebound: { lines: [/^rebound$/i], declared: f => f.rebound === true, value: noValue },
  dredge: {
    lines: [/^dredge (\d+)$/i],
    declared: f => f.dredge !== undefined,
    value: (f, m) => f.dredge === Number(m[1]) ? null : `the line prints dredge ${m[1]} but this face declares ${String(f.dredge)}`,
  },
  graveyardReplacement: {
    lines: [
      /^if ~ would be put into a graveyard from anywhere, exile it instead\.?$/i,
      /^if ~ would be put into a graveyard from anywhere, (?:reveal ~ and )?shuffle it into its owner's library instead\.?$/i,
    ],
    declared: f => f.graveyardReplacement !== undefined,
    value: (f, _m, idx) => {
      const want = idx === 0 ? 'exile' : 'shuffle';
      return f.graveyardReplacement === want ? null : `the line says '${want}' but this face declares ${JSON.stringify(f.graveyardReplacement)}`;
    },
  },
  protection: {
    lines: [/^protection from (.+?)\.?$/i],
    declared: f => !!f.protectionFrom?.length,
    value: (f, m) => {
      const have = (f.protectionFrom ?? []).map(s => s.toLowerCase());
      const missing = protectionQualities(m[1]).filter(q => !have.includes(q));
      return missing.length ? `the line names ${JSON.stringify(missing)}, which protectionFrom does not list (declared ${JSON.stringify(f.protectionFrom ?? [])})` : null;
    },
  },
  ward: {
    lines: [WARD_LINE_RE],
    declared: f => f.wardCost !== undefined,
    value: (f, m) => m[2] === undefined || f.wardCost === Number(m[2]) ? null
      : `the line prints ward ${m[1]} but this face declares wardCost ${String(f.wardCost)}`,
  },
  additionalCosts: {
    lines: [/^as an additional cost to cast ~, (.+?)\.?$/i],
    declared: f => !!f.additionalCosts?.length,
    value: (f, m) => {
      const clause = m[1].trim();
      const verb = ADDITIONAL_COST_VERB.find(([re]) => re.test(clause));
      if (!verb) return `the clause ${JSON.stringify(clause)} starts with no verb this format can match (sacrifice / discard / pay … life / exile / tap / return)`;
      return (f.additionalCosts ?? []).some(c => verb[1](c)) ? null
        : `the clause ${JSON.stringify(clause)} needs an additionalCosts entry with ${verb[2]}, and this face declares ${JSON.stringify(f.additionalCosts ?? [])}`;
    },
  },
  toxic: {
    lines: [/^toxic (\d+)$/i],
    declared: f => f.toxic !== undefined,
    value: (f, m) => f.toxic === Number(m[1]) ? null : `the line prints toxic ${m[1]} but this face declares ${String(f.toxic)}`,
  },
  bushido: {
    lines: [/^bushido (\d+)$/i],
    declared: f => f.bushido !== undefined,
    value: (f, m) => f.bushido === Number(m[1]) ? null : `the line prints bushido ${m[1]} but this face declares ${String(f.bushido)}`,
  },
  rampage: {
    lines: [/^rampage (\d+)$/i],
    declared: f => f.rampage !== undefined,
    value: (f, m) => f.rampage === Number(m[1]) ? null : `the line prints rampage ${m[1]} but this face declares ${String(f.rampage)}`,
  },
  landwalk: {
    lines: [/^(plains|island|swamp|mountain|forest|desert)walk\.?$/i],
    declared: f => !!f.landwalk?.length,
    value: (f, m) => (f.landwalk ?? []).some(t => t.toLowerCase() === m[1].toLowerCase()) ? null
      : `the line prints ${JSON.stringify(m[1])} but landwalk declares ${JSON.stringify(f.landwalk ?? [])}`,
  },
  firebending: {
    lines: [/^firebending (\d+|x)$/i],
    declared: f => f.firebending !== undefined,
    value: (f, m) => String(f.firebending).toLowerCase() === m[1].toLowerCase() ? null
      : `the line prints firebending ${m[1]} but this face declares ${String(f.firebending)}`,
  },
};

/** Every line shape in the table, one entry per kind — read by the anchoring test and by the README table. */
export const COVER_LINE_RE: Record<CoverKind, readonly RegExp[]> =
  Object.fromEntries(COVER_KINDS.map(k => [k, COVER_RULES[k].lines])) as unknown as Record<CoverKind, readonly RegExp[]>;

/**
 * Why this `covers` entry does not claim its line, or `null` when it does. Three rules, and all three must hold:
 *
 *   (i)   the line is a real oracle line of that face — that needs the card, so `scripts:check` checks it; an entry
 *         naming a line the face does not have simply claims nothing here;
 *   (ii)  the named declaration really exists on this face;
 *   (iii) the line has a shape that declaration prints AND the declared VALUE is the one the line prints — the mana
 *         cost of the flashback, the number after `dredge`, the counter named in the as-enters clause.
 */
export function coverProblem(face: ScriptFace | null | undefined, entry: CoverEntry): string | null {
  const line = normalizeOracleLine(entry.line.trim().replace(/^\/\/ /, ''));
  const by = entry.by;
  if (!COVER_KINDS.includes(by)) return `'${by}' is not a cover kind`;
  const f = face ?? {};
  const rule = COVER_RULES[by];
  if (!rule.declared(f)) return `names by '${by}' but this face declares no ${by}`;
  for (let i = 0; i < rule.lines.length; i++) {
    const m = rule.lines[i].exec(line);
    if (!m) continue;
    const why = rule.value(f, m, i);
    return why === null ? null : `names by '${by}' but ${why}`;
  }
  return `names by '${by}' but the line matches none of the shapes that declaration prints (${rule.lines.map(r => r.source).join(' | ')})`;
}

/** Every `covers` entry of this face that is invalid, as `"<line> <why>"`. Empty when the face's covers are sound. */
export function coverProblems(face: ScriptFace | null | undefined): string[] {
  const out: string[] = [];
  for (const c of face?.covers ?? []) { const why = coverProblem(face, c); if (why) out.push(`${JSON.stringify(c.line)} ${why}`); }
  return out;
}

/** The lines the face's VALID `covers` entries claim — the only ones that count. */
export function validCovers(face: ScriptFace | null | undefined): string[] {
  return (face?.covers ?? []).filter(c => coverProblem(face, c) === null).map(c => c.line.trim());
}

/** Whether every `covers` entry of this face is valid — the rule `CardScriptChecked` enforces on the file. */
export function coversValid(face: ScriptFace | null | undefined): boolean {
  return coverProblems(face).length === 0;
}

/**
 * Every line the resulting face claims: the lines each of its abilities really claims (see `abilityClaimLines` — an
 * ability with no substantive effect, or one naming more lines than it has effects, claims nothing), the face's
 * valid `covers` entries and the script's honoured `ignore` lines. Lines made only of keywords the face has are
 * claimed separately, by `keywordLineClaimed`, because they need the face's keyword PARAMETERS too. In mode
 * 'replace' `def` holds only the script's declarations, so only the script claims; in mode 'extend' it holds the
 * parser's plus the script's, so both do.
 */
export function claimedLines(def: CardDef, face: ScriptFace | null | undefined, ignored: Set<string>): Set<string> {
  const claimed = new Set<string>(ignored);
  for (const a of def.abilities) for (const l of abilityClaimLines(a, def.name)) claimed.add(l);
  for (const c of validCovers(face)) claimed.add(c);
  return claimed;
}
/**
 * The lines of ONE face that a script must account for: `normalizeOracleLines` without the back face's `// …`
 * entries and without modal bullets. A `• …` bullet is not an independent line — it is part of the "Choose one —"
 * clause above it, and the parser folds it into that line's `choose-mode` effect (parse.ts:1199-1208), so the
 * ability that claims the parent claims the bullets with it. A bullet the parser did not understand still leaves an
 * `unknown` inside `choose-mode`, which fails the face on its own. `scriptableLines` keeps the bullets, so a
 * `covers` / `ignore` entry may still name one.
 */
export function faceLines(def: Pick<CardDef, 'name' | 'oracleText' | 'layout' | 'faces' | 'backFace'>): string[] {
  return normalizeOracleLines({ ...def, backFace: undefined }).filter(l => !l.startsWith('• '));
}

// ---------------------------------------------------------------------------
// The second face of a split / adventure / flip card
// ---------------------------------------------------------------------------

/** Layouts whose `faces[1]` carries castable / playable text that `parse.ts` never parses (parse.ts:1146, :1362). */
export const SECOND_FACE_LAYOUTS: readonly string[] = ['split', 'adventure', 'flip'];

/** The second face of a split / adventure / flip card, or null when this card has none with text. */
export function secondFaceOf(def: Pick<CardDef, 'layout' | 'faces'>): { name: string; oracleText: string } | null {
  if (!SECOND_FACE_LAYOUTS.includes(def.layout)) return null;
  const f = def.faces?.[1];
  if (!f || !(f.oracleText ?? '').trim()) return null;
  return { name: f.name, oracleText: f.oracleText };
}

/**
 * The lines `script.secondFace` must claim: `faces[1].oracle_text` normalised against the SECOND face's own name, so
 * "Stomp deals 2 damage to any target." reads as "~ deals 2 damage to any target." exactly as the parser would have
 * written it. Empty for every other layout, so nothing changes for the rest of the pool.
 */
export function secondFaceLines(def: Pick<CardDef, 'layout' | 'faces'>): string[] {
  const face = secondFaceOf(def);
  if (!face) return [];
  const out: string[] = [];
  for (const raw of normalizeOracleText(face.oracleText, face.name).split('\n')) {
    const l = normalizeOracleLine(raw);
    if (l && !l.startsWith('• ') && !out.includes(l)) out.push(l);
  }
  return out;
}

/** Everything a script face declares that must be free of `unknown` for that face to count as simulated. */
function scriptFaceHasUnknown(face: ScriptFace | null | undefined): boolean {
  if (!face) return false;
  return hasUnknown(face.abilities) || hasUnknown(face.altCosts) || hasUnknown(face.asEnters)
    || hasUnknown(face.costModifiers) || hasUnknown(face.additionalCosts) || hasUnknown(face.entersTapped);
}

/**
 * The second face's lines that `script.secondFace` leaves unclaimed. The parser contributed nothing to this face, so
 * `mode` makes no difference here: only the script claims. Empty for every layout without a second face.
 */
export function secondFaceUnclaimed(def: Pick<CardDef, 'layout' | 'faces'>, script: CardScript, ignored: Set<string> = new Set()): string[] {
  const lines = secondFaceLines(def);
  if (!lines.length) return [];
  const face = script.secondFace;
  const name = def.faces![1].name;
  const claimed = new Set<string>(ignored);
  for (const a of face?.abilities ?? []) for (const l of abilityClaimLines(a, name)) claimed.add(l);
  for (const c of validCovers(face)) claimed.add(c);
  return lines.filter(l => !claimed.has(l) && !keywordLineClaimed(l, face ?? {}));
}

/**
 * Apply one face's declarations to a def (front face or `def.backFace`); returns a copy, the input is untouched.
 *
 * `mode: 'replace'` means "this face's declarations stand in for the parser's": the parser's abilities, keywords and
 * costs are dropped and the script's take their place. It does NOT mean "every line is accounted for" — `unparsed`
 * is recomputed the same way in both modes, from the face's own oracle lines minus the ones the resulting face
 * claims, so a `replace` script that declares nothing (or only `covers`, with no behaviour behind it) leaves every
 * line unparsed instead of silently marking the card simulated.
 */
function applyFace(def: CardDef, face: ScriptFace | null | undefined, mode: 'replace' | 'extend', ignored: Set<string>): CardDef {
  const out: CardDef = { ...def, keywords: [...def.keywords], abilities: [...def.abilities], unparsed: [], producesMana: [...def.producesMana] };
  // Every scalar declaration a face can carry. 'replace' sets each from the script (dropping the parser's), 'extend'
  // overrides only the ones the script states.
  const SCALARS = ['kicker', 'cycling', 'cyclingSearch', 'entersTapped', 'morph', 'cascade', 'storm', 'rebound',
    'dredge', 'graveyardReplacement', 'wardCost', 'toxic', 'bushido', 'rampage', 'firebending'] as const;
  if (mode === 'replace') {
    out.keywords = [...(face?.keywords ?? [])];
    out.abilities = [...(face?.abilities ?? [])];
    out.altCosts = face?.altCosts ? [...face.altCosts] : undefined;
    out.asEnters = face?.asEnters ? [...face.asEnters] : undefined;
    out.costModifiers = face?.costModifiers ? [...face.costModifiers] : undefined;
    out.additionalCosts = face?.additionalCosts ? [...face.additionalCosts] : undefined;
    out.protectionFrom = face?.protectionFrom ? [...face.protectionFrom] : undefined;
    out.landwalk = face?.landwalk ? [...face.landwalk] : undefined;
    for (const k of SCALARS) (out as unknown as Record<string, unknown>)[k] = face?.[k];
  } else {
    if (face?.keywords) for (const k of face.keywords) if (!out.keywords.includes(k)) out.keywords.push(k);
    if (face?.abilities) out.abilities.push(...face.abilities);
    if (face?.altCosts) out.altCosts = [...(out.altCosts ?? []), ...face.altCosts];
    if (face?.asEnters) out.asEnters = [...(out.asEnters ?? []), ...face.asEnters];
    if (face?.costModifiers) out.costModifiers = [...(out.costModifiers ?? []), ...face.costModifiers];
    if (face?.additionalCosts) out.additionalCosts = [...(out.additionalCosts ?? []), ...face.additionalCosts];
    if (face?.protectionFrom) out.protectionFrom = [...new Set([...(out.protectionFrom ?? []), ...face.protectionFrom])];
    if (face?.landwalk) out.landwalk = [...new Set([...(out.landwalk ?? []), ...face.landwalk])];
    for (const k of SCALARS) if (face?.[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = face[k];
  }
  const claimed = claimedLines(out, face, ignored);
  out.unparsed = faceLines(out).filter(l => !claimed.has(l) && !keywordLineClaimed(l, out));
  out.fullyParsed = out.unparsed.length === 0 && !faceHasUnknown(out);
  // producesMana follows mana abilities the script may have added
  for (const a of out.abilities) if (a.kind === 'activated' && a.manaAbility) for (const e of a.effects) if (e.op === 'add-mana' && Array.isArray(e.mana)) for (const m of e.mana) if (!out.producesMana.includes(m)) out.producesMana.push(m);
  return out;
}

/**
 * Apply a card's script to the parser's output. A stale script (oracle text changed since it was written) is not
 * applied; the def records the status either way so coverage reports can list stale scripts.
 *
 * `unparsed` is recomputed from scratch for each face — the face's own oracle lines minus the ones the applied face
 * claims (see `claimedLines`) — so it lists what is really unaccounted for rather than what the parser happened to
 * report. `ignore` lines count as claimed; an entry may be written with or without the `// ` back-face marker.
 * `fullyParsed` is "nothing unclaimed AND nothing `unknown` anywhere in the face".
 *
 * `backFace` is applied to `def.backFace` (set by parse.ts for transform / modal double-faced cards) with the same
 * replace/extend semantics, and the back face is applied WHETHER OR NOT the script declares one: a card is fully
 * simulated only when both of its faces are, so a script that finishes the front and says nothing about the back
 * leaves `fullyParsed` false. The back face's lines live in `def.backFace.unparsed`; the front face's `unparsed`
 * holds only its own lines. The SECOND face of a split / adventure / flip card is checked the same way through
 * `secondFaceUnclaimed` — the parser never parses it, so there is no `CardDef` to hang it on, but its lines still
 * have to be claimed for the card to be `fullyParsed`. `verification` is tool-owned and ignored here.
 *
 * `tier` is the card's pool tier (`tierOf(row)`): it gates the two tier-only `ignore` reasons. An `ignore` entry is
 * HONOURED ONLY WHEN `ignoreLineProblem` passes it, so an ignore the tool would reject also fails at runtime instead
 * of quietly finishing the card whenever `scripts:check` is not the one applying it. It defaults to `'paper'`, the
 * tier that grants no exemption at all.
 */
export function applyScript(def: CardDef, script: CardScript | null, tier: PoolTier = 'paper'): CardDef {
  if (!script) return def;
  const status: ScriptStatus = { applied: false, stale: false, source: script.source, confidence: script.confidence };
  if (script.oracleHash !== oracleHash(def.oracleText)) { status.stale = true; def.script = status; return def; }
  const mode = script.mode ?? 'replace';
  const ignoreLines = (script.ignore ?? []).filter(i => ignoreLineProblem(i.line, i.reason, tier) === null).map(i => i.line.trim());
  // a back-face line may be named either as the parser reports it on the front ("// X") or as the back face sees it ("X")
  const ignored = new Set([...ignoreLines, ...ignoreLines.map(l => l.replace(/^\/\/ /, ''))]);
  const out = applyFace(def, script, mode, ignored);
  if (def.backFace) {
    const back = applyFace(def.backFace, script.backFace, mode, ignored);
    out.backFace = back;
    out.fullyParsed = out.fullyParsed && back.fullyParsed;
  }
  if (secondFaceLines(def).length) {
    out.fullyParsed = out.fullyParsed && secondFaceUnclaimed(def, script, ignored).length === 0 && !scriptFaceHasUnknown(script.secondFace);
  }
  status.applied = true; out.script = status;
  return out;
}

/**
 * Ability texts in the script that name no line of the card — `scripts:check` reports these as a warning. A script
 * whose ability text does not match the oracle is usually a copy/paste slip; it also means the ability claims
 * nothing, so the line it was meant to cover stays unparsed.
 */
export function unmatchedAbilityTexts(def: Pick<CardDef, 'name' | 'oracleText' | 'layout' | 'faces' | 'backFace' | 'unparsed'>, script: CardScript): string[] {
  const lines = new Set(scriptableLines(def));
  const out: string[] = [];
  const check = (abilities: Ability[] | undefined, name: string, prefix: string) => {
    for (const a of abilities ?? []) {
      const claims = abilityNamedLines(a.text, name);
      if (!claims.some(c => lines.has(c) || lines.has(prefix + c))) out.push(prefix + a.text);
    }
  };
  check(script.abilities, def.name, '');
  check(script.backFace?.abilities, def.backFace?.name ?? def.name, '// ');
  check(script.secondFace?.abilities, secondFaceOf(def)?.name ?? def.name, '');
  return out;
}
