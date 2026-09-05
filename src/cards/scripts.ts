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
// both modes. See `abilityIsSubstantive`, `coverProblem`, `claimedLines` and `secondFaceUnclaimed`.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
import { keywordFromText } from './parse.js';
import type { PoolTier } from './pool.js';
import type { Ability, AbilityCost, AltCost, AsEnters, CardDef, Condition, CostModifier, Filter, Keyword, ManaCost } from './types.js';

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

/** Parameterised keyword lines the parser recognises ("Ward {2}", "Toxic 1", "Islandwalk", "Protection from red"). */
const PARAMETERISED_KEYWORD: [RegExp, Keyword][] = [
  [/^protection from .+$/i, 'protection'],
  [/^ward\b.*$/i, 'ward'],
  [/^toxic \d+$/i, 'toxic'],
  [/^bushido \d+$/i, 'bushido'],
  [/^rampage \d+$/i, 'rampage'],
  [/^firebending \d+$/i, 'firebending'],
  [/^(plains|island|swamp|mountain|forest|desert)walk$/i, 'landwalk'],
];

/** The keyword one comma-separated part of a keyword line names, or null when the part is not a keyword at all. */
export function keywordOfLinePart(part: string): Keyword | null {
  const p = part.trim().replace(/\.$/, '');
  if (!p) return null;
  for (const [re, kw] of PARAMETERISED_KEYWORD) if (re.test(p)) return kw;
  return keywordFromText(p);
}

/**
 * Whether a whole oracle line is nothing but keywords the face has. The parser splits keyword lines on commas
 * (parse.ts:1212), so "Flying, first strike" is claimed by `['flying', 'first strike']` and a parameterised keyword
 * ("Ward {2}", "Toxic 1") is claimed by the bare keyword the parser records for it.
 */
export function keywordLineClaimed(line: string, keywords: readonly Keyword[]): boolean {
  const parts = line.trim().replace(/\.$/, '').split(/,\s*/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every(p => { const k = keywordOfLinePart(p); return !!k && keywords.includes(k); });
}

/**
 * The oracle lines an ability's `text` claims. Usually one — the parser writes the normalised line it came from —
 * but an instant/sorcery's single `spell` ability carries the WHOLE face text (parse.ts:1358), so each of its lines
 * is claimed. That is safe: a line the parser did not understand leaves an `unknown` effect behind, and `unknown`
 * fails the face independently of who claimed the line.
 */
export function abilityClaimLines(text: string, cardName: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeOracleText(text, cardName).split('\n')) {
    const l = normalizeOracleLine(raw);
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
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

/**
 * Whether an ability CARRIES BEHAVIOUR, and so may claim its oracle line. An ability that declares no effect claims
 * nothing: without this a script of empty abilities — one per line, each with the right `text` — would read as fully
 * simulated while doing nothing at all in the engine. An `unknown` anywhere inside it disqualifies it too, so the
 * line it was meant to cover is reported as unclaimed rather than silently swallowed.
 *
 *   * `spell` / `triggered` / `activated`: at least one effect, and no `unknown` at any depth;
 *   * `static`: an `effect` that is not `unknown` at any depth.
 *
 * The parser's own output contains 56 empty-effect abilities across the 34,513-card pool (Populate, Manifest dread,
 * Amass, "The Ring tempts you", …), so the PARSER-output schema (`AbilitySchema`) stays lenient and only the
 * SCRIPT-level schema requires an effect. Those 56 cards are already not `fullyParsed`.
 */
export function abilityIsSubstantive(ability: Ability): boolean {
  if (hasUnknown(ability)) return false;
  if (ability.kind === 'static') return !!ability.effect;
  return (ability.effects?.length ?? 0) > 0;
}

/** Per-kind shape of the oracle line a declaration produces. `keywords` and `altCosts` need the face itself. */
const COVER_LINE_RE: Record<Exclude<CoverKind, 'keywords' | 'altCosts'>, RegExp> = {
  asEnters: /^(as ~ enters|~ enters (the battlefield )?(tapped|with))/i,
  costModifiers: /^(delve|convoke|improvise|affinity for|~ costs \{.*\} less)/i,
  kicker: /^(multi)?kicker /i,
  cycling: /cycling /i,
  entersTapped: /^~ enters (the battlefield )?tapped/i,
  morph: /^(morph|megamorph|disguise) /i,
  cascade: /^cascade$/i,
  storm: /^storm$/i,
  rebound: /^rebound$/i,
  dredge: /^dredge \d/i,
  graveyardReplacement: /^if ~ would be put into a graveyard from anywhere/i,
  protection: /^protection from/i,
  ward: /^ward/i,
  additionalCosts: /^as an additional cost to cast ~/i,
  toxic: /^toxic \d+\.?$/i,
  bushido: /^bushido \d+\.?$/i,
  rampage: /^rampage \d+\.?$/i,
  landwalk: /^(plains|island|swamp|mountain|forest|desert)walk\.?$/i,
  firebending: /^firebending (\d+|x\b)/i,
};

/** Whether the face really declares the thing a `covers` entry names. */
const COVER_DECLARED: Record<CoverKind, (f: ScriptFace) => boolean> = {
  keywords: f => !!f.keywords?.length,
  altCosts: f => !!f.altCosts?.length,
  asEnters: f => !!f.asEnters?.length,
  costModifiers: f => !!f.costModifiers?.length,
  additionalCosts: f => !!f.additionalCosts?.length,
  kicker: f => f.kicker !== undefined,
  cycling: f => f.cycling !== undefined,
  entersTapped: f => f.entersTapped !== undefined,
  morph: f => f.morph !== undefined,
  cascade: f => f.cascade === true,
  storm: f => f.storm === true,
  rebound: f => f.rebound === true,
  dredge: f => f.dredge !== undefined,
  graveyardReplacement: f => f.graveyardReplacement !== undefined,
  protection: f => !!f.protectionFrom?.length,
  ward: f => f.wardCost !== undefined,
  toxic: f => f.toxic !== undefined,
  bushido: f => f.bushido !== undefined,
  rampage: f => f.rampage !== undefined,
  landwalk: f => !!f.landwalk?.length,
  firebending: f => f.firebending !== undefined,
};

/** The keyword word an alternative-cost line starts with, and the `AltCost.id`s the pitch phrasing stands for. */
const ALT_COST_WORD_RE = /^(flashback|escape|evoke|warp|impending|buyback|dash|jump-start)\b/i;
const ALT_COST_PITCH_RE = /^you may pay\b[\s\S]*\brather than pay\b/i;

function altCostCovers(face: ScriptFace, line: string): boolean {
  const alts = face.altCosts ?? [];
  const m = ALT_COST_WORD_RE.exec(line);
  if (m) { const w = m[1].toLowerCase(); return alts.some(a => a.id.toLowerCase() === w || a.label.toLowerCase().startsWith(w)); }
  if (ALT_COST_PITCH_RE.test(line)) return alts.some(a => a.id === 'pitch' || a.id === 'life');
  return false;
}

/**
 * Why this `covers` entry does not claim its line, or `null` when it does. Two of the three rules live here:
 *
 *   (ii) the named declaration really exists on this face, and
 *   (iii) the line has the shape that declaration produces.
 *
 * Rule (i) — the line is a real oracle line of that face — needs the card and is checked by `scripts:check`; a
 * `covers` entry naming a line the face does not have simply claims nothing here.
 */
export function coverProblem(face: ScriptFace | null | undefined, entry: CoverEntry): string | null {
  const line = normalizeOracleLine(entry.line.trim().replace(/^\/\/ /, ''));
  const by = entry.by;
  if (!COVER_KINDS.includes(by)) return `'${by}' is not a cover kind`;
  const f = face ?? {};
  if (!COVER_DECLARED[by](f)) return `names by '${by}' but this face declares no ${by}`;
  if (by === 'keywords') {
    return keywordLineClaimed(line, f.keywords ?? [])
      ? null
      : `names by 'keywords' but the line is not made only of keywords this face declares (${JSON.stringify(f.keywords ?? [])})`;
  }
  if (by === 'altCosts') {
    return altCostCovers(f, line)
      ? null
      : `names by 'altCosts' but the line does not start with the keyword word of an alternative cost this face declares`;
  }
  const re = COVER_LINE_RE[by];
  return re.test(line) ? null : `names by '${by}' but the line does not match ${re.source}`;
}

/** Every `covers` entry of this face that is invalid, as `"<line>: <why>"`. Empty when the face's covers are sound. */
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
 * Every line the resulting face claims: the normalised `text` of each of its SUBSTANTIVE abilities (see
 * `abilityIsSubstantive` — an empty-effect or unknown-bearing ability claims nothing), each line that is wholly made
 * of keywords it has, the face's valid `covers` entries and the script's honoured `ignore` lines. In mode 'replace'
 * `def` holds only the script's declarations, so only the script claims; in mode 'extend' it holds the parser's plus
 * the script's, so both do. An invalid `covers` entry claims nothing here as well as failing the schema.
 */
export function claimedLines(def: CardDef, face: ScriptFace | null | undefined, ignored: Set<string>): Set<string> {
  const claimed = new Set<string>(ignored);
  for (const a of def.abilities) if (abilityIsSubstantive(a)) for (const l of abilityClaimLines(a.text, def.name)) claimed.add(l);
  for (const c of validCovers(face)) claimed.add(c);
  return claimed;
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
  for (const a of face?.abilities ?? []) if (abilityIsSubstantive(a)) for (const l of abilityClaimLines(a.text, name)) claimed.add(l);
  for (const c of validCovers(face)) claimed.add(c);
  return lines.filter(l => !claimed.has(l) && !keywordLineClaimed(l, face?.keywords ?? []));
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
  out.unparsed = faceLines(out).filter(l => !claimed.has(l) && !keywordLineClaimed(l, out.keywords));
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
      const claims = abilityClaimLines(a.text, name);
      if (!claims.some(c => lines.has(c) || lines.has(prefix + c))) out.push(prefix + a.text);
    }
  };
  check(script.abilities, def.name, '');
  check(script.backFace?.abilities, def.backFace?.name ?? def.name, '// ');
  check(script.secondFace?.abilities, secondFaceOf(def)?.name ?? def.name, '');
  return out;
}
