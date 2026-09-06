// Script state, derived from FILES ONLY (plan 2.4). There is no database of state: everything below is a pure
// function of the master row (what the parser alone understands), the script under data/scripts/<2-hex>/, the
// blocked note under data/scripts/blocked/<2-hex>/, the scenario shard under data/scenarios/<2-hex>/ and the op
// vocabulary that is registered right now. Two runs on the same tree therefore agree, and a wave can be resumed
// after a crash without any bookkeeping surviving it.
//
//   parsed    the parser alone fully simulates the card — no script is wanted
//   todo      not parsed, no script, nothing blocking it: the queue may issue it
//   blocked   a blocked note names op families that do not exist yet (auto-cleared when they all land)
//   scripted  a fresh script applies (its oracleHash matches), but it carries no current verification
//   verified  the mechanical gate passed (schema/lint/sandbox/round-trip) — verification.status >= 'verified'
//   tested    + at least one PASSING blind scenario per REACHABLE ability (unreachable abilities are excused)
//   judged    + the judge(s) called it faithful (one judge, or two for wave 10.0 / the owner's decks)
//   reviewed  a PERSON signed off on this exact script — a review note under data/scripts/reviewed/<2-hex>/ whose
//             scriptHash and oracleHash still match (written only by `scripts:promote --human`). A script that
//             merely DECLARES `source: 'hand' | 'reviewed'` is not reviewed: an author agent can write that word.
//   stale     a script exists but the oracle text changed under it — it is NOT applied
//
// "Simulated" (what the engine actually plays with) is `parsed` + `scripted` and up; "covered" — the headline number
// — is `judged` and up. `SCRIPT_STATE_TABLE` is the typed table both the dashboard and the queue read.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
import {
  AMOUNTS, CONDITIONS, EFFECT_OPS, MODULES, STATICS, TRIGGERS,
} from '../engine/ops/_registry.js';
import { CardDB } from './db.js';
import { parseCard } from './parse.js';
import { CONDITION_VARIANTS, EFFECT_VARIANTS, STATIC_VARIANTS, TRIGGER_VARIANTS } from './schema.js';
import {
  DEFAULT_SCRIPTS_DIR, oracleHash, ScriptStore, scriptHash, shardOf,
  type CardScript, type ScriptSource, type Verification,
} from './scripts.js';
import type { CardDef } from './types.js';
import { defaultJudgeRule, type JudgeRule, type Judges } from './waveScope.js';

export type { JudgeRule, Judges } from './waveScope.js';

// ---------------------------------------------------------------------------
// The state table
// ---------------------------------------------------------------------------

/** Every state, in promotion order. A card is in exactly one of them. */
export const SCRIPT_STATES = ['parsed', 'todo', 'blocked', 'scripted', 'verified', 'tested', 'judged', 'reviewed', 'stale'] as const;
export type ScriptState = typeof SCRIPT_STATES[number];

/** What one state means, and how the reports count it. */
export interface ScriptStateRow {
  /** Promotion rank: a state only ever moves UP the ladder within one wave. `parsed` and `stale` are off-ladder (-1). */
  rank: number;
  /** One-line description, printed by `scripts:needs` and the dashboard legend. */
  description: string;
  /** Counted in "simulated": the engine plays these cards without an `unknown`. */
  simulated: boolean;
  /** Counted in "covered": the headline number (plan 2.4 — `covered` = judged). */
  covered: boolean;
  /** The queue may issue this card to a script author. */
  queueable: boolean;
}

export const SCRIPT_STATE_TABLE: Record<ScriptState, ScriptStateRow> = {
  parsed: { rank: -1, description: 'the parser alone fully simulates the card', simulated: true, covered: false, queueable: false },
  todo: { rank: 0, description: 'unparsed, unscripted and unblocked — the queue may issue it', simulated: false, covered: false, queueable: true },
  blocked: { rank: 0, description: 'waiting for op families that do not exist yet', simulated: false, covered: false, queueable: false },
  scripted: { rank: 1, description: 'a fresh script applies; no current verification', simulated: true, covered: false, queueable: true },
  verified: { rank: 2, description: 'the mechanical gate passed (schema, lint, sandbox, round-trip)', simulated: true, covered: false, queueable: true },
  tested: { rank: 3, description: 'a passing blind scenario per reachable ability', simulated: true, covered: false, queueable: true },
  judged: { rank: 4, description: 'the judge(s) called it faithful', simulated: true, covered: true, queueable: false },
  reviewed: { rank: 5, description: 'a person wrote or checked the script', simulated: true, covered: true, queueable: false },
  stale: { rank: -1, description: 'the oracle text changed under the script — it is not applied', simulated: false, covered: false, queueable: true },
};

/** States the queue drops (plan 2.8: judged / reviewed / blocked are never re-issued). */
export const NOT_QUEUEABLE: readonly ScriptState[] = SCRIPT_STATES.filter(s => !SCRIPT_STATE_TABLE[s].queueable);

// ---------------------------------------------------------------------------
// Blocked notes
// ---------------------------------------------------------------------------

/** One missing op family, as a script author described it (plan Part 4, `needs[]`). */
export interface BlockedNeed {
  /** The family name the orchestrator will queue as a vocabulary wave — matched against the live registry. */
  opFamily: string;
  proposedSignature?: string;
  semantics?: string;
  /** Comprehensive Rules citation, when the author could give one. */
  cr?: string;
  /** The clause that needs it, when it is not the note's own `clause`. */
  clause?: string;
}

/** data/scripts/blocked/<2-hex>/<oracle_id>.json */
export interface BlockedNote {
  oracleId: string;
  name: string;
  /** The clause that could not be expressed (the first one, when there were several). */
  clause: string;
  needs: BlockedNeed[];
  /** The wave that blocked it ('10.0', '10.1.3', …). */
  wave: string;
  /** How many times a wave has tried and failed on this card. */
  attempts: number;
}

export const DEFAULT_BLOCKED_DIR = (): string => path.join(DEFAULT_SCRIPTS_DIR(), 'blocked');
export const DEFAULT_SCENARIO_DIR = (): string => path.join(projectRoot(), 'data', 'scenarios');

/** Where a card's blocked note is (or would be). */
export function blockedPathFor(oracleId: string, dir = DEFAULT_BLOCKED_DIR()): string {
  return path.join(dir, shardOf(oracleId), `${oracleId}.json`);
}

/** Read one blocked note, or null when there is none (an unreadable one is treated as none and reported by the caller). */
export function readBlocked(oracleId: string, dir = DEFAULT_BLOCKED_DIR()): BlockedNote | null {
  const file = blockedPathFor(oracleId, dir);
  if (!fs.existsSync(file)) return null;
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BlockedNote>;
    if (!n || typeof n !== 'object') return null;
    return {
      oracleId: n.oracleId ?? oracleId, name: n.name ?? '', clause: n.clause ?? '',
      needs: Array.isArray(n.needs) ? n.needs.filter(x => x && typeof x.opFamily === 'string') : [],
      wave: n.wave ?? '', attempts: typeof n.attempts === 'number' ? n.attempts : 0,
    };
  } catch { return null; }
}

/** Every blocked note under `dir`, sorted by oracle id so any run order is reproducible. */
export function listBlocked(dir = DEFAULT_BLOCKED_DIR()): BlockedNote[] {
  if (!fs.existsSync(dir)) return [];
  const out: BlockedNote[] = [];
  for (const shard of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!shard.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, shard.name)).sort()) {
      if (!f.endsWith('.json')) continue;
      const note = readBlocked(path.basename(f, '.json'), dir);
      if (note) out.push(note);
    }
  }
  return out.sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Human review notes
// ---------------------------------------------------------------------------

/**
 * data/scripts/reviewed/<2-hex>/<oracle_id>.json — the ONLY thing that makes a card `reviewed`.
 *
 * The note is written by `scripts:promote --human` (plan 2.4) and pins BOTH hashes of the script the person
 * actually read, so any later edit to the script or to the oracle text drops the card back onto the mechanical
 * ladder instead of leaving a human's name on someone else's work. A script's own `source` field is metadata an
 * author agent can write, and is therefore never evidence of a review.
 */
export interface ReviewNote {
  oracleId: string;
  name: string;
  /** The person who signed off (`--by`). */
  by: string;
  /** ISO timestamp. */
  at: string;
  /** `scriptHash(script)` of the reviewed script — a later edit invalidates the review. */
  scriptHash: string;
  /** `oracleHash(oracleText)` at review time — an oracle update invalidates it too. */
  oracleHash: string;
  /** What the reviewer wants remembered (optional). */
  note?: string;
}

export const DEFAULT_REVIEWED_DIR = (): string => path.join(DEFAULT_SCRIPTS_DIR(), 'reviewed');

/** Where a card's review note is (or would be). */
export function reviewPathFor(oracleId: string, dir = DEFAULT_REVIEWED_DIR()): string {
  return path.join(dir, shardOf(oracleId), `${oracleId}.json`);
}

/** Read one review note, or null when there is none (an unreadable or unsigned one is treated as none). */
export function readReview(oracleId: string, dir = DEFAULT_REVIEWED_DIR()): ReviewNote | null {
  const file = reviewPathFor(oracleId, dir);
  if (!fs.existsSync(file)) return null;
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReviewNote>;
    if (!n || typeof n !== 'object') return null;
    if (typeof n.scriptHash !== 'string' || typeof n.oracleHash !== 'string') return null;
    if (typeof n.by !== 'string' || !n.by.trim()) return null;
    return {
      oracleId: n.oracleId ?? oracleId, name: n.name ?? '', by: n.by, at: n.at ?? '',
      scriptHash: n.scriptHash, oracleHash: n.oracleHash, ...(n.note ? { note: n.note } : {}),
    };
  } catch { return null; }
}

/** Every review note under `dir`, sorted by oracle id. */
export function listReviews(dir = DEFAULT_REVIEWED_DIR()): ReviewNote[] {
  if (!fs.existsSync(dir)) return [];
  const out: ReviewNote[] = [];
  for (const shard of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!shard.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, shard.name)).sort()) {
      if (!f.endsWith('.json')) continue;
      const note = readReview(path.basename(f, '.json'), dir);
      if (note) out.push(note);
    }
  }
  return out.sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0));
}

/**
 * True when the script CLAIMS a human source without a matching review note — the shape the 8k review found: an
 * author agent copies `"source": "hand"` out of a worked example and its card silently counts as covered. Every
 * tool that reads scripts prints these, and `stateOf` ignores the claim.
 */
export function unearnedHumanSource(script: CardScript, review: ReviewNote | null): boolean {
  return (script.source === 'hand' || script.source === 'reviewed') && !review;
}

// ---------------------------------------------------------------------------
// What the engine can express today
// ---------------------------------------------------------------------------

/** The discriminator literal of one zod variant (`z.strictObject({ op: z.literal('draw'), … })` → `'draw'`). */
function literalOf(variant: unknown, key: string): string | null {
  const shape = (variant as { shape?: Record<string, { value?: unknown }> }).shape;
  const v = shape?.[key]?.value;
  return typeof v === 'string' ? v : null;
}

/**
 * Every op family name that EXISTS right now: the registered mechanic families and their flat lookups
 * (src/engine/ops/_registry.ts) plus the core vocabulary's own discriminators (src/cards/schema.ts) — the
 * "composition vocabulary" of plan 1.4, which lives in the core unions rather than in a family file.
 *
 * A blocked note's `needs[].opFamily` is matched against this set by name (case-insensitively, `_` and spaces
 * folded to `-`), which is why the orchestrator names a vocabulary wave after the family the authors asked for.
 */
export function unlockedOpFamilies(): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => { if (s) out.add(s.toLowerCase().replace(/[\s_]+/g, '-')); };
  for (const m of MODULES) add(m.name);
  for (const rec of [EFFECT_OPS, CONDITIONS, TRIGGERS, STATICS, AMOUNTS]) for (const k of Object.keys(rec)) add(k);
  for (const v of EFFECT_VARIANTS) add(literalOf(v, 'op'));
  for (const v of CONDITION_VARIANTS) add(literalOf(v, 'kind'));
  for (const v of TRIGGER_VARIANTS) add(literalOf(v, 'on'));
  for (const v of STATIC_VARIANTS) add(literalOf(v, 'kind'));
  out.delete('unknown');
  return out;
}

/** The op families a blocked note still waits for (empty = the note is spent and the card is queueable again). */
export function openNeeds(note: BlockedNote, unlocked: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const n of note.needs) {
    const key = n.opFamily.toLowerCase().replace(/[\s_]+/g, '-');
    if (!unlocked.has(key)) seen.add(n.opFamily);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// stateOf
// ---------------------------------------------------------------------------

/** The file sources a derivation reads. Every one is overridable, which is what lets the unit tests run on fixtures. */
export interface StateSources {
  scripts: ScriptStore;
  blockedDir: string;
  scenarioDir: string;
  /** Where `scripts:promote --human` writes its review notes. */
  reviewedDir: string;
  /** Op families that exist (see `unlockedOpFamilies`). */
  unlocked: ReadonlySet<string>;
  /**
   * Faithful verdicts needed for `judged`. Plan 2.4 wants TWO for the owner's decks and the EDHREC top-1k and one
   * elsewhere — a per-CARD question, so this is normally a `JudgeRule`; a bare count is for fixtures and for
   * `scripts:promote --judges N`.
   */
  judges: Judges | JudgeRule;
}

/** How many faithful verdicts THIS card needs under `src`. */
export function judgeCountFor(src: Pick<StateSources, 'judges'>, oracleId: string): Judges {
  return typeof src.judges === 'function' ? src.judges(oracleId) : src.judges;
}

export function defaultSources(over: Partial<StateSources> = {}): StateSources {
  return {
    scripts: over.scripts ?? new ScriptStore(),
    blockedDir: over.blockedDir ?? DEFAULT_BLOCKED_DIR(),
    scenarioDir: over.scenarioDir ?? DEFAULT_SCENARIO_DIR(),
    reviewedDir: over.reviewedDir ?? DEFAULT_REVIEWED_DIR(),
    unlocked: over.unlocked ?? unlockedOpFamilies(),
    judges: over.judges ?? defaultJudgeRule(cardDb),
  };
}

/** The parser-alone facts `stateOf` needs. A whole `CardDef` satisfies it. */
export type StateDef = Pick<CardDef, 'oracleId' | 'name' | 'oracleText' | 'fullyParsed'>;

export interface ScriptStateInfo {
  oracleId: string;
  name: string;
  state: ScriptState;
  /** One sentence saying why — printed by every tool that shows a state. */
  why: string;
  /** Whether the parser alone finishes the card (a `parsed` card needs no script). */
  parsedAlone: boolean;
  source?: ScriptSource;
  /** The script's own verification status, when it carries a CURRENT one. */
  verification?: Verification['status'];
  /** True when a verification exists but was invalidated by an edit to the script or the oracle text. */
  verificationStale?: boolean;
  /** The blocked note, when one exists (even a spent one — `openNeeds` says whether it still blocks). */
  blocked?: BlockedNote;
  /** The human review note, when one exists (even a stale one — see `reviewStale`). */
  review?: ReviewNote;
  /** True when a review note exists but names a different script or a different oracle text. */
  reviewStale?: boolean;
  /** True when the script says `source: 'hand' | 'reviewed'` and no review note backs that up. */
  unearnedHumanSource?: boolean;
  /** Op families the card still waits for. Non-empty for `blocked`, and for any other state whose card kept a note. */
  openNeeds: string[];
}

export interface StateOptions extends Partial<StateSources> {
  /** The PARSER-ALONE def (no script applied). Omit and it is parsed from master.db. */
  def?: StateDef;
  /** The script, when the caller already has it (avoids a second read). */
  script?: CardScript | null;
}

/**
 * The state of one card. `def` must be the def the PARSER alone produced: `CardDB.get()` applies scripts, so pass
 * `parseCard(row)` (that is what `deriveStates` does) or leave it out and let this read master.db itself.
 */
export function stateOf(oracleId: string, opts: StateOptions = {}): ScriptStateInfo {
  const src = defaultSources(opts);
  const def = opts.def ?? parseAlone(oracleId);
  if (!def) throw new Error(`stateOf: no such card in master.db: ${oracleId}`);
  const script = opts.script !== undefined ? opts.script : src.scripts.get(oracleId);
  const note = readBlocked(oracleId, src.blockedDir) ?? undefined;
  const review = readReview(oracleId, src.reviewedDir);
  const open = note ? openNeeds(note, src.unlocked) : [];
  // `openNeeds` is reported for EVERY state, not only `blocked`: a partly-scripted card can still carry a note whose
  // families have not landed, and `scripts:queue --only-unlocked` drops exactly those.
  const base = { oracleId, name: def.name, parsedAlone: def.fullyParsed, blocked: note, openNeeds: open, ...(review ? { review } : {}) };

  if (script) {
    const fresh = oracleHash(def.oracleText);
    const claimed = unearnedHumanSource(script, review) ? { unearnedHumanSource: true } : {};
    if (script.oracleHash !== fresh) {
      return { ...base, ...claimed, state: 'stale', source: script.source, why: `the oracle text changed since the script was written (hash ${fresh}, script says ${script.oracleHash})` };
    }
    // A PERSON signed THIS script off: the one rung above `judged`, and the only one a script cannot claim for
    // itself. Both hashes must still match, so an edit after the review drops the card back onto the ladder.
    if (review && review.scriptHash === scriptHash(script) && review.oracleHash === fresh) {
      return { ...base, state: 'reviewed', source: script.source, verification: script.verification?.status, why: `${review.by || 'a person'} reviewed this exact script${review.at ? ` on ${review.at}` : ''}` };
    }
    const reviewStale = review ? { reviewStale: true } : {};
    const v = script.verification;
    const rest = { ...base, ...claimed, ...reviewStale, source: script.source };
    if (!v) return { ...rest, state: 'scripted', why: 'the script applies but has never been verified' };
    if (v.scriptHash !== scriptHash(script)) {
      return { ...rest, state: 'scripted', verificationStale: true, why: 'the script changed since it was verified — re-run scripts:verify --stale' };
    }
    if (v.oracleHash !== fresh) {
      return { ...rest, state: 'scripted', verificationStale: true, why: 'the oracle text changed since the verification ran' };
    }
    // A verification that records a problem is `scripted` whatever its `status` field says: scripts:verify never writes
    // a higher status with a non-empty problems list, and scripts:promote agrees (deriveStatus) — this guard makes a
    // hand-edited or historically mis-promoted file read the same way the tools would rewrite it.
    if (v.problems?.length) {
      return { ...rest, state: 'scripted', verification: v.status, why: `the verification records ${v.problems.length} problem(s): ${v.problems[0]}` };
    }
    const rank = VERIFICATION_RANK[v.status] ?? 0;
    if (rank < 2) return { ...rest, state: 'scripted', verification: v.status, why: `verification status is '${v.status}'` };
    const scenarios = scenarioVerdict(oracleId, v, src.scenarioDir);
    if (!scenarios.ok) return { ...rest, state: 'verified', verification: v.status, why: scenarios.why };
    const judge = judgeVerdict(v, judgeCountFor(src, oracleId));
    if (!judge.ok) return { ...rest, state: 'tested', verification: v.status, why: judge.why };
    return { ...rest, state: 'judged', verification: v.status, why: judge.why };
  }

  if (def.fullyParsed) return { ...base, state: 'parsed', why: 'the parser alone claims every line' };
  if (note && open.length) return { ...base, state: 'blocked', why: `waiting for ${open.join(', ')} (wave ${note.wave || '?'}, ${note.attempts} attempt(s))` };
  if (note) return { ...base, state: 'todo', why: `the blocked note is spent — every family it needed (${note.needs.map(n => n.opFamily).join(', ') || 'none'}) exists now` };
  return { ...base, state: 'todo', why: 'not parsed and not scripted' };
}

/** `Verification.status` as a rank, so the ladder is one comparison (scriptVerify keeps a higher rung on re-run). */
export const VERIFICATION_RANK: Record<Verification['status'], number> = { scripted: 1, verified: 2, tested: 3, judged: 4 };

/**
 * `tested` needs a PASSING blind scenario per REACHABLE ability, and the scenario shard has to be on disk — the
 * verification block alone is not evidence, because a shard can be deleted after a verification was written.
 * A card whose abilities are all unreachable (or which has none) still needs one passing scenario.
 */
function scenarioVerdict(oracleId: string, v: Verification, dir: string): { ok: boolean; why: string } {
  const file = path.join(dir, shardOf(oracleId), `${oracleId}.json`);
  if (!fs.existsSync(file)) return { ok: false, why: 'no blind scenario shard under data/scenarios' };
  const s = v.scenarios;
  if (!s || (!s.passed && !s.failed)) return { ok: false, why: 'the verification records no scenario run' };
  if (s.failed > 0) return { ok: false, why: `${s.failed} blind scenario(s) fail` };
  const reachable = (v.sandbox?.abilities ?? []).filter(a => a.reached).length;
  const want = Math.max(1, reachable);
  if (s.passed < want) return { ok: false, why: `${s.passed} passing scenario(s) for ${want} reachable abilit${want === 1 ? 'y' : 'ies'}` };
  return { ok: true, why: `${s.passed} blind scenario(s) pass` };
}

/** `judged` needs `judges` faithful verdicts and no unfaithful one (an `uncertain` neither promotes nor rejects). */
function judgeVerdict(v: Verification, judges: Judges): { ok: boolean; why: string } {
  const list = v.judge ?? [];
  const bad = list.filter(j => j.verdict === 'unfaithful');
  if (bad.length) return { ok: false, why: `a judge called it unfaithful: ${bad[0].issues.slice(0, 2).join('; ') || 'no issue given'}` };
  const good = list.filter(j => j.verdict === 'faithful').length;
  if (good < judges) return { ok: false, why: `${good} of ${judges} faithful verdict(s)` };
  return { ok: true, why: `${good} faithful verdict(s)` };
}

// ---------------------------------------------------------------------------
// deriveStates — the whole pool, or a list of ids
// ---------------------------------------------------------------------------

/**
 * The playable rows `CardDB.all()` walks. This mirrors `NON_PLAYABLE` in src/cards/db.ts, which is not exported;
 * `test/script-state.test.ts` pins the two against each other over a rowid window so the copy cannot drift.
 */
export const PLAYABLE_SQL = "layout NOT IN ('art_series','token','double_faced_token','emblem','vanguard','planar','scheme','front_card') AND type_line NOT LIKE 'Card%' AND type_line NOT LIKE 'Stickers%' AND type_line NOT LIKE 'Dungeon%' AND type_line NOT LIKE 'Phenomenon%' AND type_line NOT LIKE 'Conspiracy%'";

/** The raw oracle row plus the parser-alone def — everything the queue and the state derivation read per card. */
export interface PoolRowDef {
  /** The `oracle_cards.json` blob, parsed. Carries `keywords` (Scryfall's), `games`, `set_type`, `representative_id`, … */
  raw: Record<string, unknown>;
  /** `parseCard(raw)` — NO script applied. */
  def: CardDef;
}

let sharedDb: CardDB | null = null;
/** master.db is opened on FIRST USE only: `stateOf` with a `def` never touches it, which is what lets the unit tests run on fixtures alone. */
function cardDb(): CardDB {
  if (!sharedDb) sharedDb = CardDB.shared();
  return sharedDb;
}

/** Let a caller (a CLI that already opened the database) supply the CardDB this module reads. */
export function useCardDb(db: CardDB | null): void { sharedDb = db; }

function parseAlone(oracleId: string): StateDef | null {
  const db = cardDb();
  const row = db.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as { json: string } | undefined;
  if (!row) return null;
  return parseRow(JSON.parse(row.json) as Record<string, unknown>).def;
}

/** Parse one raw `oracle_cards` row with the parser ALONE (no script, no tier logic). */
export function parseRow(raw: Record<string, unknown>): PoolRowDef {
  const o = raw as Record<string, any>;
  const def = parseCard({ ...(o as any), representative_id: o.representative_id ?? o.id ?? null });
  return { raw, def };
}

/** Iterate the playable pool as raw rows + parser-alone defs. `ids` restricts it to those cards, in that order. */
export function* poolRows(opts: { ids?: string[] } = {}): Generator<PoolRowDef> {
  const db = cardDb();
  if (opts.ids) {
    const stmt = db.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?');
    for (const id of opts.ids) {
      const row = stmt.get(id) as { json: string } | undefined;
      if (row) yield parseRow(JSON.parse(row.json) as Record<string, unknown>);
    }
    return;
  }
  for (const row of db.db.prepare(`SELECT json FROM oracle_cards WHERE ${PLAYABLE_SQL}`).iterate() as Iterable<{ json: string }>) {
    yield parseRow(JSON.parse(row.json) as Record<string, unknown>);
  }
}

export interface DerivedStates {
  cards: ScriptStateInfo[];
  histogram: Record<ScriptState, number>;
  sources: StateSources;
}

/** Empty histogram with every state present, so a report never has to guard for a missing key. */
export function emptyHistogram(): Record<ScriptState, number> {
  return Object.fromEntries(SCRIPT_STATES.map(s => [s, 0])) as Record<ScriptState, number>;
}

/**
 * Derive the state of every card in `ids` (or of the whole playable pool). `onCard` is called with the row, the
 * parser-alone def and the state, so a caller that needs both (the queue does) walks the pool once.
 */
export function deriveStates(opts: StateOptions & { ids?: string[]; onCard?: (row: PoolRowDef, state: ScriptStateInfo) => void } = {}): DerivedStates {
  const sources = defaultSources(opts);
  const cards: ScriptStateInfo[] = [];
  const histogram = emptyHistogram();
  for (const row of poolRows({ ids: opts.ids })) {
    const state = stateOf(row.def.oracleId, { ...sources, def: row.def });
    histogram[state.state]++;
    cards.push(state);
    opts.onCard?.(row, state);
  }
  return { cards, histogram, sources };
}
