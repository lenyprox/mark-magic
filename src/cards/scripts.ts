// Per-card scripts (B7): a checked-in JSON file per oracle id under data/scripts/ that overrides or completes what
// the oracle-text parser produced for that card. The parser stays the generator of first drafts; a script is the
// canonical, reviewed form. A script names the oracle text hash it was written against so a Scryfall refresh that
// changes the card's text flags the script as stale instead of silently applying it.
//
// Layout (format v2, plan 1.5): data/scripts/<first two hex chars of the oracle id>/<oracle_id>.json — 256 shards so
// the directory stays usable at ~34k files. Flat files at the root are still read (and `scripts:shard` migrates them).
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
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
  /** The oracle line, normalised exactly as `normalizeOracleLines` produces it. */
  line: string;
  reason: IgnoreReason;
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
   * Oracle lines (normalised, `~` for the card name) this face accounts for; with mode 'extend' they are removed
   * from `unparsed`. The single entry `'*'` means "every remaining unparsed line" and is only allowed with
   * mode 'replace' (where it is implied anyway).
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
  /** 'replace' (default): the script's abilities replace the parser's; 'extend': they are appended and unparsed lines it covers are cleared. */
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
 * Every oracle line of a card in the exact form `covers` / `ignore` must name it: the front face's normalised lines,
 * each modal bullet, and the back face's lines prefixed with `// ` (the marker `parse.ts` uses for back-face text).
 */
export function normalizeOracleLines(def: Pick<CardDef, 'name' | 'oracleText' | 'layout' | 'faces' | 'backFace'>): string[] {
  const text = (def.faces && def.faces.length > 1 && ['adventure', 'split', 'transform', 'modal_dfc', 'flip'].includes(def.layout))
    ? (def.faces[0].oracleText ?? '')
    : (def.oracleText ?? '');
  const out: string[] = [];
  for (const raw of normalizeOracleText(text, def.name).split('\n')) {
    const line = normalizeOracleLine(raw);
    if (!line) continue;
    out.push(line);
    for (const bullet of line.split(/\n?• /).slice(1)) if (bullet.trim()) out.push('• ' + bullet.trim());
  }
  if (def.backFace) for (const l of normalizeOracleLines(def.backFace)) out.push('// ' + l);
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

const hasUnknownEffect = (abilities: Ability[]) => abilities.some(a => 'effects' in a && a.effects.some(e => e.op === 'unknown'));

/** Apply one face's declarations to a def (front face or `def.backFace`); returns a copy, the input is untouched. */
function applyFace(def: CardDef, face: ScriptFace, mode: 'replace' | 'extend', ignored: Set<string>): CardDef {
  const out: CardDef = { ...def, keywords: [...def.keywords], abilities: [...def.abilities], unparsed: [...def.unparsed], producesMana: [...def.producesMana] };
  if (mode === 'replace') {
    if (face.keywords) out.keywords = [...face.keywords];
    if (face.abilities) out.abilities = [...face.abilities];
    if (face.altCosts) out.altCosts = [...face.altCosts];
    if (face.asEnters) out.asEnters = [...face.asEnters];
    if (face.costModifiers) out.costModifiers = [...face.costModifiers];
    out.unparsed = []; out.fullyParsed = true;
  } else {
    if (face.keywords) for (const k of face.keywords) if (!out.keywords.includes(k)) out.keywords.push(k);
    if (face.abilities) out.abilities.push(...face.abilities);
    if (face.altCosts) out.altCosts = [...(out.altCosts ?? []), ...face.altCosts];
    if (face.asEnters) out.asEnters = [...(out.asEnters ?? []), ...face.asEnters];
    if (face.costModifiers) out.costModifiers = [...(out.costModifiers ?? []), ...face.costModifiers];
    const covers = (face.covers ?? []).map(c => c.trim());
    const covered = new Set(covers);
    out.unparsed = covers.includes('*') ? [] : out.unparsed.filter(u => {
      const t = u.trim();
      return !covered.has(t) && !ignored.has(t) && !ignored.has(t.replace(/^\/\/ /, ''));
    });
    out.fullyParsed = out.unparsed.length === 0 && !hasUnknownEffect(out.abilities);
  }
  // producesMana follows mana abilities the script may have added
  for (const a of out.abilities) if (a.kind === 'activated' && a.manaAbility) for (const e of a.effects) if (e.op === 'add-mana' && Array.isArray(e.mana)) for (const m of e.mana) if (!out.producesMana.includes(m)) out.producesMana.push(m);
  return out;
}

/**
 * Apply a card's script to the parser's output. A stale script (oracle text changed since it was written) is not
 * applied; the def records the status either way so coverage reports can list stale scripts.
 *
 * `ignore` lines are dropped from `unparsed` and therefore stop blocking `fullyParsed`. `covers: ['*']` clears every
 * remaining unparsed line. `backFace` is applied to `def.backFace` (set by parse.ts for transform / modal
 * double-faced cards) with the same replace/extend semantics; the back face's `// `-prefixed entries in the front
 * face's `unparsed` are cleared as the back face's own lines are. `verification` is tool-owned and ignored here.
 */
export function applyScript(def: CardDef, script: CardScript | null): CardDef {
  if (!script) return def;
  const status: ScriptStatus = { applied: false, stale: false, source: script.source, confidence: script.confidence };
  // types.ts still carries the pre-8a `source` union; 'llm' is written at runtime and read back by the tooling.
  if (script.oracleHash !== oracleHash(def.oracleText)) { status.stale = true; def.script = status as CardDef['script']; return def; }
  const mode = script.mode ?? 'replace';
  const ignored = new Set((script.ignore ?? []).map(i => i.line.trim()));
  const out = applyFace(def, script, mode, ignored);
  if (script.backFace && def.backFace) {
    const back = applyFace(def.backFace, script.backFace, mode, ignored);
    out.backFace = back;
    if (mode === 'extend') {
      const stillUnparsed = new Set(back.unparsed.map(u => '// ' + u.trim()));
      out.unparsed = out.unparsed.filter(u => !u.trim().startsWith('// ') || stillUnparsed.has(u.trim()));
      out.fullyParsed = out.unparsed.length === 0 && !hasUnknownEffect(out.abilities);
    }
  }
  status.applied = true; out.script = status as CardDef['script'];
  return out;
}
