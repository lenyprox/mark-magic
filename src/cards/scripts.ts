// Per-card scripts (B7): a checked-in JSON file per oracle id under data/scripts/ that overrides or completes what
// the oracle-text parser produced for that card. The parser stays the generator of first drafts; a script is the
// canonical, reviewed form. A script names the oracle text hash it was written against so a Scryfall refresh that
// changes the card's text flags the script as stale instead of silently applying it.
//
// Layout (format v2, plan 1.5): data/scripts/<first two hex chars of the oracle id>/<oracle_id>.json — 256 shards so
// the directory stays usable at ~34k files. Flat files at the root are still read (and `scripts:shard` migrates them).
//
// A script never asserts that a card is finished. It CLAIMS the card's oracle lines one at a time — by an ability
// whose `text` is the line, by the face's keywords, by a justified `covers` entry or by an `ignore` entry — and
// `applyScript` re-derives `unparsed` from what is left over. `fullyParsed` is "nothing unclaimed AND nothing
// `unknown` anywhere in the face", for both faces of a double-faced card and in both modes. See `claimedLines`.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
import { keywordFromText } from './parse.js';
import type { PoolTier } from './pool.js';
import type { Ability, AltCost, AsEnters, CardDef, CostModifier, Keyword } from './types.js';

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
  'reminder-only',        // reminder text the parser kept as a line
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
 * be waved through by claiming its text is an un-card's.
 */
const REASON_RULE: Record<IgnoreReason, RegExp | null> = {
  // "Draft ~ face up.", "Reveal ~ as you draft it.", conspiracies and the "as you draft a card" clauses
  'draft-matters': /^(draft ~ face up|reveal ~ as you draft|.*\byou drafted\b|.*\bdraft(ed)? (a |this )?card\b|.*\bconspiracy\b)/i,
  'ante': /\bante\b/i,
  'outside-the-game': /\bfrom outside the game\b/i,
  // whole-line phrases only: these are the printed deck-building keywords, never a clause inside game text
  'deck-construction': /^(partner(\b.*)?|choose a background|doctor's companion|friends forever|companion — .*|a deck can have any number of cards named ~\.?|commander enchantment|spell commander|legendary landwalk)$/i,
  // the parser strips parentheses, so a line that is nothing but a parenthetical almost never survives to a script
  'reminder-only': /^\([^)]*\)$/,
  'un-physical': null,      // gated on tier === 'un' alone
  'digital-only': /\b(conjure|seek|perpetual|spellbook|draft a card from)/i,
};

/** Reasons that are only available to one pool tier, whatever the line says. */
const REASON_TIER: Partial<Record<IgnoreReason, PoolTier>> = { 'un-physical': 'un', 'digital-only': 'digital' };

/**
 * Whether a line may be ignored for the reason given: `null` when it may, otherwise why it may not.
 * `scripts:check` turns a non-null result into a problem and passes the card's pool tier.
 */
export function ignoreLineProblem(line: string, reason: IgnoreReason, tier?: PoolTier): string | null {
  const norm = normalizeOracleLine(line.trim().replace(/^\/\/ /, ''));
  const needTier = REASON_TIER[reason];
  if (needTier && tier !== needTier) {
    return `is only available to a card in the '${needTier}' pool tier (this card is ${tier ? `'${tier}'` : 'of an unknown tier'})`;
  }
  const rule = REASON_RULE[reason];
  if (!rule || rule.test(norm)) return null;
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

/** The scriptable part of one card face. `CardScript` carries these for the front face and `backFace` for the back. */
export interface ScriptFace {
  keywords?: Keyword[];
  abilities?: Ability[];
  altCosts?: AltCost[];
  asEnters?: AsEnters[];
  costModifiers?: CostModifier[];
  /**
   * Oracle lines (as `scriptableLines(def)` names them) this face claims WITHOUT an ability of its own — the only way
   * a `keywords` / `altCosts` / `asEnters` / `costModifiers` declaration can account for a line. There is no wildcard:
   * every claimed line is written out, and `CardScriptChecked` caps the number of covers entries that are not simply
   * an ability's own text at the number of such declarations on the face.
   */
  covers?: string[];
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

/** The structural part of a script face the `covers` budget is computed from (also used by `CardScriptChecked`). */
export interface CoverableFace {
  covers?: string[];
  abilities?: { text: string }[];
  keywords?: unknown[];
  altCosts?: unknown[];
  asEnters?: unknown[];
  costModifiers?: unknown[];
}

/**
 * How many lines a face may claim through `covers` alone: one per keyword / altCost / asEnters / costModifier
 * declaration, because `covers` is the only way those declarations can account for a line. A `covers` entry that
 * simply repeats one of the face's own ability texts is free — the ability already claims that line.
 */
export function coversBudget(face: CoverableFace | null | undefined): number {
  return (face?.keywords?.length ?? 0) + (face?.altCosts?.length ?? 0) + (face?.asEnters?.length ?? 0) + (face?.costModifiers?.length ?? 0);
}

/** The `covers` entries that are backed by a declaration — the only ones that claim a line. */
export function justifiedCovers(face: CoverableFace | null | undefined): string[] {
  const covers = (face?.covers ?? []).map(c => c.trim());
  if (!covers.length) return [];
  const abilityTexts = new Set((face?.abilities ?? []).map(a => a.text.trim()));
  const budget = coversBudget(face);
  let spent = 0;
  return covers.filter(c => abilityTexts.has(c) || spent++ < budget);
}

/** Whether every `covers` entry of this face is justified — the rule `CardScriptChecked` enforces on the file. */
export function coversWithinBudget(face: CoverableFace | null | undefined): boolean {
  return justifiedCovers(face).length === (face?.covers ?? []).length;
}

/**
 * Every line the resulting face claims: the normalised `text` of each of its abilities, each line that is wholly
 * made of keywords it has, the face's justified `covers` entries and the script's `ignore` lines. In mode 'replace'
 * `def` holds only the script's declarations, so only the script claims; in mode 'extend' it holds the parser's plus
 * the script's, so both do. An unjustified `covers` entry claims nothing here as well as failing the schema, so a
 * script that lists lines under `covers` without a declaration behind them can never read as fully simulated.
 */
export function claimedLines(def: CardDef, face: ScriptFace | null | undefined, ignored: Set<string>): Set<string> {
  const claimed = new Set<string>(ignored);
  for (const a of def.abilities) for (const l of abilityClaimLines(a.text, def.name)) claimed.add(l);
  for (const c of justifiedCovers(face)) claimed.add(c);
  return claimed;
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
  if (mode === 'replace') {
    out.keywords = [...(face?.keywords ?? [])];
    out.abilities = [...(face?.abilities ?? [])];
    out.altCosts = face?.altCosts ? [...face.altCosts] : undefined;
    out.asEnters = face?.asEnters ? [...face.asEnters] : undefined;
    out.costModifiers = face?.costModifiers ? [...face.costModifiers] : undefined;
  } else {
    if (face?.keywords) for (const k of face.keywords) if (!out.keywords.includes(k)) out.keywords.push(k);
    if (face?.abilities) out.abilities.push(...face.abilities);
    if (face?.altCosts) out.altCosts = [...(out.altCosts ?? []), ...face.altCosts];
    if (face?.asEnters) out.asEnters = [...(out.asEnters ?? []), ...face.asEnters];
    if (face?.costModifiers) out.costModifiers = [...(out.costModifiers ?? []), ...face.costModifiers];
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
 * holds only its own lines. `verification` is tool-owned and ignored here.
 */
export function applyScript(def: CardDef, script: CardScript | null): CardDef {
  if (!script) return def;
  const status: ScriptStatus = { applied: false, stale: false, source: script.source, confidence: script.confidence };
  if (script.oracleHash !== oracleHash(def.oracleText)) { status.stale = true; def.script = status; return def; }
  const mode = script.mode ?? 'replace';
  const ignoreLines = (script.ignore ?? []).map(i => i.line.trim());
  // a back-face line may be named either as the parser reports it on the front ("// X") or as the back face sees it ("X")
  const ignored = new Set([...ignoreLines, ...ignoreLines.map(l => l.replace(/^\/\/ /, ''))]);
  const out = applyFace(def, script, mode, ignored);
  if (def.backFace) {
    const back = applyFace(def.backFace, script.backFace, mode, ignored);
    out.backFace = back;
    out.fullyParsed = out.fullyParsed && back.fullyParsed;
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
  return out;
}
