// Scenario DSL for behavioural engine tests (the XMage-style vocabulary from the plan's B10): a typed object
// describes a board, a script of actions and a list of expectations; `runScenario` builds the game from real cards,
// executes the script through the public engine API and checks every expectation. Scenarios are plain data (every
// field is JSON-serialisable, so `log`/`noLog` also take a regex *source* string) which lets the same objects live in
// data/scenarios/*.json, cross a worker_threads postMessage in scripts/verify-scenarios.ts and feed the dashboard.
// test/scenarios/dsl.ts re-exports this module for the suites under test/.
import assert from 'node:assert/strict';
import { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import { canBlock, findObject, isCreature, keywords, power, toughness } from '../engine/characteristics.js';
import type { GameEventType } from '../engine/events.js';
import { Game } from '../engine/game.js';
import { legalActions } from '../engine/legal.js';
import { primaryOpponent } from '../engine/players.js';
import { makeObject, STEPS, type Agent, type Decision, type GameObject, type GameState, type LegalAction, type PlayerId, type Step, type TargetRef, type Zone } from '../engine/state.js';
import { defaultAnswer } from '../engine/agents/defaults.js';

// The card database is opened on first use so importing the DSL (for its types, or for validateScenario in the
// file loader) never touches master.db.
let cards: CardDB | null = null;
const C = (n: string): CardDef => { const d = (cards ??= CardDB.shared()).get(n); if (!d) throw new Error('missing card ' + n); return d; };
let noCardDb = false;
/**
 * Does the database know this card name? `null` means there is no database (CI, a fresh clone), in which case the
 * name checks are skipped rather than reported as missing cards.
 */
function cardKnown(n: string): boolean | null {
  if (noCardDb) return null;
  try { return !!(cards ??= CardDB.shared()).get(n); } catch { noCardDb = true; return null; }
}
/** Card names are compared the way CardDB looks them up: trimmed and case-insensitively. */
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface SeatSetup {
  hand?: string[]; bf?: string[]; graveyard?: string[]; exile?: string[]; libraryTop?: string[]; life?: number;
  /** Commander games: cards that start in the command zone. */
  command?: string[];
  /** Per card name: counters to place (first match on the battlefield). */
  counters?: Record<string, Record<string, number>>;
  tapped?: string[];
}
/** Every seat zone a scenario can seed a card into (used by validateScenario). */
export const SEAT_ZONE_FIELDS = ['hand', 'bf', 'graveyard', 'exile', 'libraryTop', 'command'] as const;

export type Ref = string | `P${number}`;

/**
 * The steps `passUntil` can stop at: every step except `untap`, in which no player ever receives priority
 * (CR 502.3), so there is nowhere in it for the script to stand.
 */
export const PASS_STEPS: Step[] = STEPS.filter(st => st !== 'untap');
export type PassStep = Exclude<Step, 'untap'>;

export type ScriptStep =
  | { cast: string; targets?: Ref[][]; x?: number; by?: number; modes?: number[]; alt?: string }
  | { activate: string; ability?: number; targets?: Ref[][]; by?: number }
  | { playLand: string; by?: number }
  /**
   * Declare attackers, and optionally the defending seat's blocks as [blocker, attacker] pairs (see attackWith).
   * Every pair in `blocks` must be accepted by the engine; every pair in `refused` must be rejected by it (that is
   * how evasion is tested — the block is really offered, not merely left out).
   */
  | { attack: string[]; blocks?: [string, string][]; refused?: [string, string][] }
  | { block: [string, string][] }
  | { resolve: true }
  | { sba: true }
  | { turnFaceUp: string; by?: number }
  /** Advance to that step of this turn (or of the next turn when it is not still ahead) and stop there. */
  | { passUntil: PassStep }
  | { turns: number }
  | { answer: unknown };

/** A regular expression, or its source as a string so the scenario stays JSON-serialisable. */
export type Pattern = RegExp | string;
export const toRegExp = (p: Pattern): RegExp => (typeof p === 'string' ? new RegExp(p) : p);

/**
 * The log line a pattern matches, if any. The engine disambiguates permanents by object id ("Hill Giant#12 is
 * destroyed."), which a scenario author writing from the card text cannot know, so every line is tried both as
 * printed and with those ids removed — `"Hill Giant is destroyed"` therefore means what it says, and a `noLog`
 * written that way really does fail when the creature dies.
 */
export const matchingLog = (log: string[], p: Pattern): string | undefined => {
  const re = toRegExp(p);
  return log.find(l => re.test(l) || re.test(l.replace(/#\d+/g, '')));
};

export type Expectation =
  | { zone: [string, 'battlefield' | 'graveyard' | 'exile' | 'hand' | 'library' | 'stack' | 'command'] }
  | { life: [number, number] }
  | { pt: [string, number, number] }
  | { keywords: [string, string[]] }
  | { counters: [string, Record<string, number>] }
  /** Counters on a *player* (experience, rad, ...; poison and energy have their own fields). */
  | { playerCounters: [number, Record<string, number>] }
  | { tapped: [string, boolean] }
  | { control: [string, number] }
  | { events: { type: GameEventType; min?: number; max?: number } }
  | { log: Pattern }
  /** No log line may match — the expectation that a thing did *not* happen. */
  | { noLog: Pattern }
  | { unsimulated: number }
  | { winner: number | null }
  | { stack: number }
  /** Number of objects in a seat's zone ('stack' counts the items that seat controls). */
  | { zoneCount: [number, Zone, number] }
  | { handCount: [number, number] }
  | { graveyardCount: [number, number] }
  | { libraryCount: [number, number] }
  /** Names of the items on the stack, top first. */
  | { stackNames: string[] }
  /** Unspent mana in a seat's pool as a string of symbols ('RR', 'WU', 'CC'); order does not matter. */
  | { mana: [number, string] }
  /** The permanent an Aura/Equipment is attached to, by name (null = attached to nothing). */
  | { attachedTo: [string, string | null] }
  | { faceDown: [string, boolean] }
  /** Combat damage a seat has taken from the named commander (CR 704.6c). */
  | { commanderDamage: [number, string, number] }
  /** Deep-equals an entry of the object's open-ended `ext` bag (engine extension data). */
  | { ext: [string, string, unknown] };

export interface Scenario {
  name: string;
  /** Rule and ruling the scenario pins (shown in failures and on the dashboard). */
  cr?: string; ruling?: string;
  seats: SeatSetup[];
  format?: 'freeform' | 'commander';
  /** Which seat is active and in which step (default seat 0, main1, turn 5). */
  active?: number; step?: Step; turn?: number;
  script: ScriptStep[];
  expect: Expectation[];
}

// ------------------------------------------------------------------ the vocabulary, as runtime data
// A JSON scenario is unvalidated data and TypeScript's unions give it no protection: without these tables a typo in a
// step or expectation key ("casts", "lifee") would be dropped on the floor by the if-chains below, so a scenario that
// runs nothing and asserts nothing would report "ok". They are the single source of truth for the shapes above —
// every key a scenario may use, with a guard for its value — and nothing outside them is accepted.
type Guard = (v: unknown) => boolean;
const isStr: Guard = v => typeof v === 'string';
const isNum: Guard = v => typeof v === 'number' && Number.isFinite(v);
const isInt: Guard = v => isNum(v) && Number.isInteger(v);
const isBool: Guard = v => typeof v === 'boolean';
const isPlainObj: Guard = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** `{ "+1/+1": 2 }` — a counter bag, name to count. */
const isCounterBag: Guard = v => isPlainObj(v) && Object.values(v as Record<string, unknown>).every(isNum);
const isPattern: Guard = v => typeof v === 'string' || v instanceof RegExp;
const anything: Guard = () => true;
const arrOf = (g: Guard): Guard => v => Array.isArray(v) && v.every(g);
const tuple = (...gs: Guard[]): Guard => v => Array.isArray(v) && v.length === gs.length && gs.every((g, i) => g(v[i]));
const oneOf = (...vals: unknown[]): Guard => v => vals.includes(v);
const ZONE_NAMES: Zone[] = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'stack', 'command'];
const isZone: Guard = v => ZONE_NAMES.includes(v as Zone);
const isStep: Guard = v => STEPS.includes(v as Step);
const isPassStep: Guard = v => PASS_STEPS.includes(v as Step);
const isTargets: Guard = arrOf(arrOf(isStr));                  // one group per targeting clause
const isBlocks: Guard = arrOf(tuple(isStr, isStr));            // [blocker, attacker] pairs

/** Seat setup fields (a typo here seeds nothing, so it is rejected like any other unknown key). */
const SEAT_FIELDS: Record<string, Guard> = {
  hand: arrOf(isStr), bf: arrOf(isStr), graveyard: arrOf(isStr), exile: arrOf(isStr), libraryTop: arrOf(isStr), command: arrOf(isStr),
  life: isInt, counters: v => isPlainObj(v) && Object.values(v as Record<string, unknown>).every(isCounterBag), tapped: arrOf(isStr),
};
/** Top-level scenario fields. */
const SCENARIO_FIELDS: Record<string, Guard> = {
  name: isStr, cr: isStr, ruling: isStr, seats: arrOf(isPlainObj), format: oneOf('freeform', 'commander'),
  active: isInt, step: isStep, turn: isInt, script: arrOf(anything), expect: arrOf(anything),
};
/** Script steps: the discriminating key with a guard for its value, plus the extra keys that step may carry. */
const SCRIPT_STEPS: Record<string, { value: Guard; opts: Record<string, Guard> }> = {
  cast: { value: isStr, opts: { targets: isTargets, x: isInt, by: isInt, modes: arrOf(isInt), alt: isStr } },
  activate: { value: isStr, opts: { ability: isInt, targets: isTargets, by: isInt } },
  playLand: { value: isStr, opts: { by: isInt } },
  attack: { value: arrOf(isStr), opts: { blocks: isBlocks, refused: isBlocks } },
  block: { value: isBlocks, opts: {} },
  resolve: { value: oneOf(true), opts: {} },
  sba: { value: oneOf(true), opts: {} },
  turnFaceUp: { value: isStr, opts: { by: isInt } },
  passUntil: { value: isPassStep, opts: {} },
  turns: { value: isInt, opts: {} },
  answer: { value: anything, opts: {} },
};
/** Expectations: one key each, with a guard for its value. */
const EXPECTATIONS: Record<string, Guard> = {
  zone: tuple(isStr, isZone),
  life: tuple(isInt, isInt),
  pt: tuple(isStr, isNum, isNum),
  keywords: tuple(isStr, arrOf(isStr)),
  counters: tuple(isStr, isCounterBag),
  playerCounters: tuple(isInt, isCounterBag),
  tapped: tuple(isStr, isBool),
  control: tuple(isStr, isInt),
  events: v => isPlainObj(v) && isStr((v as { type?: unknown }).type)
    && Object.keys(v as object).every(k => ['type', 'min', 'max'].includes(k))
    && (['min', 'max'] as const).every(k => (v as Record<string, unknown>)[k] === undefined || isInt((v as Record<string, unknown>)[k])),
  log: isPattern,
  noLog: isPattern,
  unsimulated: isInt,
  winner: v => v === null || isInt(v),
  stack: isInt,
  zoneCount: tuple(isInt, isZone, isInt),
  handCount: tuple(isInt, isInt),
  graveyardCount: tuple(isInt, isInt),
  libraryCount: tuple(isInt, isInt),
  stackNames: arrOf(isStr),
  mana: tuple(isInt, isStr),
  attachedTo: tuple(isStr, v => v === null || isStr(v)),
  faceDown: tuple(isStr, isBool),
  commanderDamage: tuple(isInt, isStr, isInt),
  ext: v => Array.isArray(v) && v.length === 3 && isStr(v[0]) && isStr(v[1]),
};
/** Every script step keyword, for error messages and for authoring tools. */
export const SCRIPT_STEP_KEYS = Object.keys(SCRIPT_STEPS);
/** Every expectation keyword. */
export const EXPECTATION_KEYS = Object.keys(EXPECTATIONS);

const show = (v: unknown): string => (v instanceof RegExp ? String(v) : JSON.stringify(v) ?? String(v));

function keyedProblems(at: string, v: unknown, fields: Record<string, Guard>): string[] {
  const pre = at ? `${at}: ` : '';
  if (!isPlainObj(v)) return [`${at || 'scenario'} is not an object`];
  const rec = v as Record<string, unknown>; const out: string[] = [];
  for (const k of Object.keys(rec)) {
    if (!(k in fields)) out.push(`${pre}unknown key "${k}" (known: ${Object.keys(fields).join(', ')})`);
    else if (rec[k] !== undefined && !fields[k](rec[k])) out.push(`${pre}${k} has a bad value ${show(rec[k])}`);
  }
  return out;
}

/** One script step: exactly one known step keyword, a well-formed value and no unknown extras. */
function scriptStepProblems(st: unknown, i: number): string[] {
  const at = `script[${i}]`;
  if (!isPlainObj(st)) return [`${at} is not an object`];
  const rec = st as Record<string, unknown>; const keys = Object.keys(rec);
  const heads = keys.filter(k => k in SCRIPT_STEPS);
  if (!heads.length) return [`${at}: not a step — no known keyword in {${keys.join(', ')}} (one of: ${SCRIPT_STEP_KEYS.join(', ')})`];
  if (heads.length > 1) return [`${at}: ${heads.join(' and ')} in one step (write one step per entry)`];
  const head = heads[0]; const spec = SCRIPT_STEPS[head];
  const out = spec.value(rec[head]) ? [] : [`${at}: ${head} has a bad value ${show(rec[head])}`];
  for (const k of keys) {
    if (k === head) continue;
    if (!(k in spec.opts)) out.push(`${at}: unknown key "${k}" on a ${head} step (allowed: ${[head, ...Object.keys(spec.opts)].join(', ')})`);
    else if (rec[k] !== undefined && !spec.opts[k](rec[k])) out.push(`${at}: ${k} has a bad value ${show(rec[k])}`);
  }
  return out;
}

/** One expectation: exactly one known expectation keyword and a well-formed value. */
function expectationProblems(e: unknown, i: number): string[] {
  const at = `expect[${i}]`;
  if (!isPlainObj(e)) return [`${at} is not an object`];
  const rec = e as Record<string, unknown>; const keys = Object.keys(rec);
  const heads = keys.filter(k => k in EXPECTATIONS);
  if (!heads.length) return [`${at}: not an expectation — no known keyword in {${keys.join(', ')}} (one of: ${EXPECTATION_KEYS.join(', ')})`];
  if (heads.length > 1) return [`${at}: ${heads.join(' and ')} in one expectation (write one per entry)`];
  const head = heads[0];
  const out = keys.filter(k => k !== head).map(k => `${at}: unknown key "${k}" next to ${head}`);
  if (!EXPECTATIONS[head](rec[head])) out.push(`${at}: ${head} has a bad value ${show(rec[head])}`);
  return out;
}

/**
 * Shape checks: every key a scenario uses is in the vocabulary and every value has the right form. These are the
 * checks `runScenario` enforces itself (a malformed scenario throws rather than passing silently), so they hold for
 * the TypeScript suites too — `validateScenario` adds the policy checks a committed corpus file must also pass.
 */
export function scenarioShape(sc: Scenario): string[] {
  if (!isPlainObj(sc)) return ['scenario is not an object'];
  const out = keyedProblems('', sc, SCENARIO_FIELDS);
  (Array.isArray(sc.seats) ? sc.seats : []).forEach((seat, i) => out.push(...keyedProblems(`seats[${i}]`, seat, SEAT_FIELDS)));
  (Array.isArray(sc.script) ? sc.script : []).forEach((st, i) => out.push(...scriptStepProblems(st, i)));
  (Array.isArray(sc.expect) ? sc.expect : []).forEach((e, i) => out.push(...expectationProblems(e, i)));
  return out;
}

/**
 * Seat setup names, checked statically. A name that is not a real card seeds nothing, and a `counters` or `tapped`
 * entry that names no permanent on that seat's `bf` list changes nothing — either way the scenario would run a board
 * that is not the one it describes, which is exactly the "green while testing nothing" failure the corpus must not
 * have. `buildScenario` repeats the battlefield check against the objects it really placed and throws the same way.
 */
export function seatSetupProblems(sc: Scenario): string[] {
  const out: string[] = [];
  for (const [i, cfg] of (Array.isArray(sc?.seats) ? sc.seats : []).entries()) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const at = (f: string) => `scenario: seats[${i}].${f}`;
    for (const f of SEAT_ZONE_FIELDS) {
      const list = cfg[f]; if (!Array.isArray(list)) continue;
      for (const n of list) if (typeof n === 'string' && cardKnown(n) === false) out.push(`${at(f)} names ${n} but there is no card of that name`);
    }
    const bf = (Array.isArray(cfg.bf) ? cfg.bf : []).filter((n): n is string => typeof n === 'string');
    const board = `that seat's battlefield is [${bf.join(', ')}]`;
    for (const n of isPlainObj(cfg.counters) ? Object.keys(cfg.counters as object) : []) {
      if (cardKnown(n) === false) out.push(`${at('counters')} names ${n} but there is no card of that name`);
      else if (!bf.some(b => sameName(b, n))) out.push(`${at('counters')} names ${n} but ${board}`);
    }
    const untapped = [...bf];
    if (Array.isArray(cfg.tapped)) for (const n of cfg.tapped) {
      if (typeof n !== 'string') continue;
      if (cardKnown(n) === false) { out.push(`${at('tapped')} names ${n} but there is no card of that name`); continue; }
      const j = untapped.findIndex(b => sameName(b, n));
      if (j < 0) out.push(`${at('tapped')} names ${n} but ${board}${bf.some(b => sameName(b, n)) ? ' and every copy of it is already tapped' : ''}`);
      else untapped.splice(j, 1);
    }
  }
  return out;
}

/**
 * Static checks a scenario must pass before it is worth running: it has to be built from the vocabulary above, cite a
 * rule, do something and assert something, and (for a card's own file) actually put that card on the table. Returns a
 * list of problems.
 */
export function validateScenario(sc: Scenario, opts: { card?: string } = {}): string[] {
  const out: string[] = [];
  const where = sc?.name ? `"${sc.name}"` : '(unnamed scenario)';
  if (!sc || typeof sc !== 'object') return ['scenario is not an object'];
  if (!sc.name || typeof sc.name !== 'string') out.push('scenario has no name');
  if (!sc.cr) out.push(`${where}: no cr citation (every scenario pins a rule)`);
  if (!Array.isArray(sc.seats) || sc.seats.length < 1) out.push(`${where}: needs at least one seat`);
  if (!Array.isArray(sc.script) || !sc.script.length) out.push(`${where}: script is empty`);
  if (!Array.isArray(sc.expect) || !sc.expect.length) out.push(`${where}: expect is empty`);
  out.push(...scenarioShape(sc).map(p => `${where}: ${p}`));
  out.push(...seatSetupProblems(sc));
  if (opts.card) {
    const placed = (sc.seats ?? []).some(seat => SEAT_ZONE_FIELDS.some(z => (seat[z] ?? []).includes(opts.card!)));
    if (!placed) out.push(`${where}: never puts ${opts.card} into a seat zone (hand/bf/graveyard/exile/libraryTop/command)`);
  }
  return out;
}

/** Where a `passUntil` step wants the game to stop: the first decision the active player is asked at or after it. */
interface StopAt { turn: number; step: Step; hit: boolean }
/** Thrown by the scenario agent to stop the engine at that point; caught by `passUntilStep`, never seen elsewhere. */
class PassUntilStop extends Error { constructor(at: Step) { super(`passUntil ${at}`); } }
const atOrAfter = (s: GameState, stop: StopAt): boolean =>
  s.turn > stop.turn || (s.turn === stop.turn && STEPS.indexOf(s.step) >= STEPS.indexOf(stop.step));

/** An agent that answers with defaults and lets the script pre-load one-off answers (yes/no, choose-cards...). */
class ScenarioAgent implements Agent {
  name: string; queue: unknown[] = [];
  /** Set by `passUntilStep` while the game runs; refusing a decision is how the DSL stops the engine at a step. */
  stop: StopAt | null = null;
  constructor(name: string) { this.name = name; }
  async decide(_s: GameState, _me: PlayerId, d: Decision): Promise<unknown> {
    const stop = this.stop;
    if (stop && !stop.hit && _me === _s.activePlayer && atOrAfter(_s, stop)) { stop.hit = true; throw new PassUntilStop(_s.step); }
    if (this.queue.length) return this.queue.shift();
    switch (d.kind) {
      case 'priority': return { type: 'pass' };
      case 'attackers': return { attackers: d.mustAttack };
      case 'blockers': return { blocks: [] };
      case 'choose-cards': return d.from.slice(0, d.count);
      case 'yes-no': return d.tag === 'dredge' || d.tag === 'optional' ? false : !d.prompt.startsWith('Mulligan');
      case 'choose-mode': return [0];
      case 'choose-color': return 'R';
      case 'choose-option': return d.options[0];
      case 'order-blockers': return d.blockers;
      default: return defaultAnswer(_s, _me, d);
    }
  }
}

export interface ScenarioRun { game: Game; failures: string[] }

function place(g: Game, pid: PlayerId, names: string[] | undefined, zone: 'hand' | 'battlefield' | 'graveyard' | 'exile'): GameObject[] {
  const out: GameObject[] = [];
  for (const n of names ?? []) {
    const o = makeObject(g.state.nextId++, C(n), pid, zone, zone === 'battlefield' ? 1 : g.state.turn);
    if (zone === 'battlefield') { o.enteredTurn = 1; if (o.def.types.includes('Planeswalker') && o.def.loyalty != null) o.counters.loyalty = o.def.loyalty; }
    g.state.players[pid][zone].push(o); out.push(o);
  }
  return out;
}

function findByName(s: GameState, name: string, seat?: number): GameObject | undefined {
  const players = seat === undefined ? s.players : [s.players[seat as PlayerId]];
  for (const p of players) for (const z of [p.battlefield, p.hand, p.graveyard, p.exile, p.library, p.command]) { const o = z.find(x => x.def.name === name); if (o) return o; }
  for (const it of s.stack) if (it.source.def.name === name) return it.source;
  return undefined;
}

/**
 * The commander of that name that has actually dealt this seat commander damage. Names repeat across seats — two
 * opponents can play the same legend — and the damaged seat's *own* commander never deals it damage, so a plain
 * name search would resolve `commanderDamage` to the wrong object and read 0. Falls back to `undefined` when no
 * commander of that name has damaged the seat, and the caller then asserts against any object of that name (which
 * is how `{ commanderDamage: [i, name, 0] }` still means something).
 */
function commanderNamed(s: GameState, p: GameState['players'][number], name: string): GameObject | undefined {
  for (const id of Object.keys(p.commanderDamage ?? {})) {
    const o = findObject(s, Number(id));
    if (o && o.def.name === name) return o;
  }
  return undefined;
}

function toRef(s: GameState, r: Ref): TargetRef {
  const m = /^P(\d)$/.exec(r); if (m) return { kind: 'player', id: Number(m[1]) as PlayerId };
  const st = s.stack.find(i => i.source.def.name === r || i.name === r); if (st) return { kind: 'stack', id: st.id };
  const o = findByName(s, r); if (!o) throw new Error(`scenario: no object named ${r}`);
  return { kind: 'object', id: o.id };
}

function legalFor(g: Game, p: PlayerId, pred: (l: LegalAction) => boolean): LegalAction {
  const l = legalActions(g, p).find(pred);
  if (!l) throw new Error(`scenario: no legal action matched for ${g.state.players[p].name} (have: ${legalActions(g, p).map(x => x.label).join('; ')})`);
  return l;
}

export function buildScenario(sc: Scenario): Game {
  // Before a single card is placed: a seat that names a card that does not exist, or puts counters on / taps a
  // permanent that is not on its battlefield, describes a board the run would never build.
  const badSeats = seatSetupProblems(sc);
  if (badSeats.length) throw new Error(badSeats.join('\n'));
  const agents = sc.seats.map((_, i) => new ScenarioAgent(`P${i}`));
  const filler = Array(20).fill(C('Mountain'));
  const g = new Game(sc.seats.map(() => filler), agents, { seed: 1, quiet: true, mulligans: false, events: 'full', format: sc.format ?? 'freeform', commanders: sc.seats.map(cfg => (cfg.command ?? []).map(C)) });
  const s = g.state;
  s.turn = sc.turn ?? 5; s.activePlayer = (sc.active ?? 0) as PlayerId; s.step = sc.step ?? 'main1'; s.priority = s.activePlayer;
  sc.seats.forEach((cfg, i) => {
    const pid = i as PlayerId; const pl = s.players[pid];
    pl.life = cfg.life ?? (sc.format === 'commander' ? 40 : 20);
    place(g, pid, cfg.bf, 'battlefield'); place(g, pid, cfg.hand, 'hand'); place(g, pid, cfg.graveyard, 'graveyard'); place(g, pid, cfg.exile, 'exile');
    for (const n of [...(cfg.libraryTop ?? [])].reverse()) pl.library.unshift(makeObject(s.nextId++, C(n), pid, 'library', 0));
    for (const [n, cs] of Object.entries(cfg.counters ?? {})) {
      const o = pl.battlefield.find(x => sameName(x.def.name, n));
      if (!o) throw new Error(`scenario: seats[${i}].counters names ${n} but no permanent of that name was placed on that seat's battlefield`);
      for (const [k, v] of Object.entries(cs)) o.counters[k] = v;
    }
    for (const n of cfg.tapped ?? []) {
      const o = pl.battlefield.find(x => !x.tapped && sameName(x.def.name, n));
      if (!o) throw new Error(`scenario: seats[${i}].tapped names ${n} but no untapped permanent of that name was placed on that seat's battlefield`);
      o.tapped = true;
    }
  });
  return g;
}

export async function runScript(g: Game, steps: ScriptStep[]) {
  const s = g.state;
  const agent = (p: number) => g.agents[p as PlayerId] as ScenarioAgent;
  for (const st of steps) {
    if ('answer' in st) { agent(s.priority).queue.push(st.answer); continue; }
    if ('cast' in st) {
      const by = (st.by ?? s.priority) as PlayerId;
      const card = findByName(s, st.cast, by); if (!card) throw new Error(`scenario: ${st.cast} not found for P${by}`);
      const l = legalFor(g, by, x => x.action.type === 'cast' && x.action.cardId === card.id && (st.x === undefined || x.action.x !== undefined) && (!st.modes || JSON.stringify(x.action.modes) === JSON.stringify(st.modes)) && (st.alt === undefined || (x.action as { alt?: string }).alt === st.alt));
      const targets = st.targets?.map(group => group.map(r => toRef(s, r)));
      const ok = await g.performAction(by, { ...l.action, ...(targets ? { targets } : {}), ...(st.x !== undefined ? { x: st.x } : {}) } as typeof l.action);
      if (!ok) throw new Error(`scenario: cast ${st.cast} was rejected`);
      continue;
    }
    if ('activate' in st) {
      const by = (st.by ?? s.priority) as PlayerId;
      const obj = findByName(s, st.activate, by); if (!obj) throw new Error(`scenario: ${st.activate} not found`);
      const l = legalFor(g, by, x => x.action.type === 'activate' && x.action.objectId === obj.id && (st.ability === undefined || x.action.abilityIndex === st.ability));
      const targets = st.targets?.map(group => group.map(r => toRef(s, r)));
      const ok = await g.performAction(by, { ...l.action, ...(targets ? { targets } : {}) } as typeof l.action);
      if (!ok) throw new Error(`scenario: activate ${st.activate} was rejected`);
      continue;
    }
    if ('playLand' in st) {
      const by = (st.by ?? s.priority) as PlayerId;
      const card = findByName(s, st.playLand, by)!;
      const l = legalFor(g, by, x => x.action.type === 'play-land' && x.action.cardId === card.id);
      const ok = await g.performAction(by, l.action);
      if (!ok) throw new Error(`scenario: play land ${st.playLand} was rejected`);
      continue;
    }
    if ('turnFaceUp' in st) {
      const by = (st.by ?? s.priority) as PlayerId;
      const o = s.players[by].battlefield.find(x => x.def.name === st.turnFaceUp);
      if (!o) throw new Error(`scenario: ${st.turnFaceUp} is not on P${by}'s battlefield`);
      const ok = await g.performAction(by, { type: 'turn-face-up', objectId: o.id });
      if (!ok) throw new Error(`scenario: turning ${st.turnFaceUp} face up was rejected`);
      continue;
    }
    if ('resolve' in st) { await g.resolveStackFully(); continue; }
    if ('sba' in st) { g.checkSBA(); continue; }
    if ('attack' in st) { await declareCombat(g, st.attack, st.blocks ?? [], st.refused ?? []); continue; }
    if ('block' in st) {
      // attackers must already be declared through `attack`; blocks are applied by re-running combat from scratch
      throw new Error('scenario: blocks belong on the { attack, blocks } step (see attackWith)');
    }
    if ('passUntil' in st) { await passUntilStep(g, st.passUntil); continue; }
    if ('turns' in st) { await g.playTurns(st.turns); continue; }
    // No silent skips: an unknown step is a typo, and a typo that ran nothing would make the scenario green.
    throw new Error(`scenario: unknown script step ${show(st)} (one of: ${SCRIPT_STEP_KEYS.join(', ')})`);
  }
}

/**
 * `{ passUntil: <step> }` — advance to that step of the current turn, or of the *next* turn when it is not still
 * ahead of the current one, and stop there with priority back on the active player. The engine exposes no "run to
 * step" entry point (`resumeTurn` runs to the end of the turn, `playTurns` runs whole turns), so the stop is made
 * where a real game already pauses: the scenario's own agent refuses the first decision the active player is asked
 * at or after the target, which unwinds `resumeTurn`/`playTurns` at a decision boundary — after that step's
 * turn-based actions, with its triggers already on the stack, and never beyond it. A step in which the active
 * player is asked nothing at all (an empty combat, or `cleanup` with a legal hand) cannot be stood in: if the run
 * ends up somewhere else this throws instead of leaving the scenario in a position it never asked for.
 */
async function passUntilStep(g: Game, target: PassStep) {
  const s = g.state;
  const ahead = STEPS.indexOf(target) > STEPS.indexOf(s.step);
  const stop: StopAt = { turn: ahead ? s.turn : s.turn + 1, step: target, hit: false };
  const agents = g.agents.filter((a): a is ScenarioAgent => a instanceof ScenarioAgent);
  if (agents.length !== g.agents.length) throw new Error('scenario: passUntil needs the scenario agents');
  for (const a of agents) a.stop = stop;
  try {
    await g.resumeTurn();                                  // stops early if the target is in this turn
    if (!stop.hit && !ahead && s.winner === null) await g.playTurns(1);
  } catch (e) {
    if (!(e instanceof PassUntilStop)) throw e;
  } finally { for (const a of agents) a.stop = null; }
  if (s.winner === null && s.step !== target) throw new Error(`scenario: passUntil ${target} stopped in ${s.step} on turn ${s.turn} — the active player is never asked anything in ${target} from this position`);
  s.priority = s.activePlayer;
}

/**
 * Attack + block declaration in one go (the engine's simulateCombat takes both at once). The defending seat is the
 * one the engine actually sends the attackers at (primaryOpponent, CR 506.2) — never seat 1 — so blocks are looked up
 * on the right player in a multiplayer scenario (CR 509.1a: only the defending player declares blockers).
 */
async function declareCombat(g: Game, attackers: string[], blocks: [string, string][], refused: [string, string][] = []) {
  const s = g.state; const ap = s.activePlayer; const dp = primaryOpponent(s, ap);
  const ids = attackers.map(n => { const o = findByName(s, n, ap); if (!o) throw new Error(`scenario: no attacker named ${n}`); return o.id; });
  const resolve = ([b, a]: [string, string]) => {
    const blocker = findByName(s, b, dp); if (!blocker) throw new Error(`scenario: no blocker named ${b}`);
    const attacker = findByName(s, a, ap); if (!attacker) throw new Error(`scenario: no attacker named ${a}`);
    return { blocker: blocker.id, attacker: attacker.id, why: blockRefusal(s, blocker, attacker) };
  };
  const pairs = blocks.map(resolve); const nope = refused.map(resolve);
  s.step = 'declare-attackers';
  const mark = s.events?.length ?? 0;
  await g.simulateCombat(ids, [...pairs, ...nope]);
  // simulateCombat silently drops a block the rules do not allow (flying, tapped, already blocking) and clears
  // every attacking/blocking field once damage is done, so the declarations are read back off the typed event it
  // emitted. A scenario that meant to test a blocked attacker must never quietly test the unblocked path instead,
  // and one testing evasion must see the block it offered actually turned down.
  if ((pairs.length || nope.length) && s.events) {
    const declared: { blocker: number; attacker: number }[] = [];
    for (const ev of s.events.slice(mark)) if (ev.type === 'block') declared.push(...ev.blocks);
    const accepted = (p: { blocker: number; attacker: number }) => declared.some(d => d.blocker === p.blocker && d.attacker === p.attacker);
    for (const [i, p] of pairs.entries()) if (!accepted(p)) throw new Error(`scenario: block ${blocks[i][0]} → ${blocks[i][1]} was not accepted by the engine (${p.why})`);
    for (const [i, p] of nope.entries()) if (accepted(p)) throw new Error(`scenario: block ${refused[i][0]} → ${refused[i][1]} was listed as refused but the engine accepted it`);
  }
}

/** Evasion keywords worth naming when a block is refused (CR 509.1b): the reason an author most likely missed. */
const EVASION = ['flying', 'unblockable', 'shadow', 'horsemanship', 'landwalk', 'fear', 'intimidate', 'skulk', 'menace'];
/** Why the engine would refuse this block, read off the board as it stands when the block is declared. */
function blockRefusal(s: GameState, blocker: GameObject, attacker: GameObject): string {
  const bk = keywords(s, blocker) as string[]; const ak = keywords(s, attacker) as string[];
  const why: string[] = [];
  if (blocker.zone !== 'battlefield') why.push(`${blocker.def.name} is in the ${blocker.zone}`);
  if (!isCreature(blocker)) why.push(`${blocker.def.name} is not a creature`);
  if (blocker.tapped) why.push(`${blocker.def.name} is tapped`);
  for (const k of EVASION) if (ak.includes(k)) why.push(`${attacker.def.name} has ${k}`);
  if (ak.includes('flying') && !bk.includes('flying') && !bk.includes('reach')) why.push(`${blocker.def.name} has neither flying nor reach`);
  if (!why.length && canBlock(s, blocker, attacker)) why.push('the block was legal when declared but another declared blocker took its place');
  return why.join('; ') || `${blocker.def.name} [${bk.join(', ') || 'no keywords'}] cannot block ${attacker.def.name} [${ak.join(', ') || 'no keywords'}]`;
}

/** Combined attack + block declaration in one step; plain data, so it also works from a JSON scenario file. */
export function attackWith(attackers: string[], blocks: [string, string][] = [], refused: [string, string][] = []): ScriptStep {
  return { attack: attackers, ...(blocks.length ? { blocks } : {}), ...(refused.length ? { refused } : {}) };
}

export function checkExpectations(g: Game, sc: Scenario): string[] {
  const s = g.state; const fails: string[] = [];
  const obj = (n: string) => findByName(s, n);
  const need = (n: string): GameObject => { const o = findByName(s, n); assert.ok(o, `no object named ${n}`); return o; };
  const seat = (i: number) => { const p = s.players[i as PlayerId]; assert.ok(p, `no seat P${i}`); return p; };
  for (const e of sc.expect) {
    try {
      if ('zone' in e) { const o = obj(e.zone[0]); assert.ok(o, `no object ${e.zone[0]}`); assert.equal(o.zone, e.zone[1], `${e.zone[0]} zone`); }
      else if ('life' in e) assert.equal(seat(e.life[0]).life, e.life[1], `P${e.life[0]} life`);
      else if ('pt' in e) { const o = need(e.pt[0]); assert.ok(isCreature(o), `${e.pt[0]} is a creature`); assert.deepEqual([power(s, o), toughness(s, o)], [e.pt[1], e.pt[2]], `${e.pt[0]} P/T`); }
      else if ('keywords' in e) { const kw = keywords(s, need(e.keywords[0])); for (const k of e.keywords[1]) assert.ok(kw.includes(k as never), `${e.keywords[0]} has ${k}`); }
      else if ('counters' in e) { const o = need(e.counters[0]); for (const [k, v] of Object.entries(e.counters[1])) assert.equal(o.counters[k] ?? 0, v, `${e.counters[0]} ${k} counters`); }
      else if ('playerCounters' in e) { const p = seat(e.playerCounters[0]); for (const [k, v] of Object.entries(e.playerCounters[1])) assert.equal(k === 'poison' ? p.poison : k === 'energy' ? p.energy : p.counters?.[k] ?? 0, v, `P${e.playerCounters[0]} ${k} counters`); }
      else if ('tapped' in e) assert.equal(need(e.tapped[0]).tapped, e.tapped[1], `${e.tapped[0]} tapped`);
      else if ('control' in e) assert.equal(need(e.control[0]).controller, e.control[1], `${e.control[0]} controller`);
      else if ('events' in e) { const n = s.eventCounts?.[e.events.type] ?? 0; if (e.events.min !== undefined) assert.ok(n >= e.events.min, `${e.events.type} events ${n} >= ${e.events.min}`); if (e.events.max !== undefined) assert.ok(n <= e.events.max, `${e.events.type} events ${n} <= ${e.events.max}`); }
      else if ('log' in e) assert.ok(matchingLog(s.log, e.log), `log matches ${toRegExp(e.log)}`);
      else if ('noLog' in e) { const hit = matchingLog(s.log, e.noLog); assert.ok(!hit, `no log line matches ${toRegExp(e.noLog)} (got "${hit}")`); }
      else if ('unsimulated' in e) assert.equal(s.eventCounts?.unsimulated ?? 0, e.unsimulated, 'unsimulated clauses');
      else if ('winner' in e) assert.equal(s.winner, e.winner, 'winner');
      else if ('stack' in e) assert.equal(s.stack.length, e.stack, 'stack size');
      else if ('zoneCount' in e) { const [i, z, n] = e.zoneCount; assert.equal(z === 'stack' ? s.stack.filter(it => it.controller === i).length : seat(i)[z].length, n, `P${i} ${z} count`); }
      else if ('handCount' in e) assert.equal(seat(e.handCount[0]).hand.length, e.handCount[1], `P${e.handCount[0]} hand count`);
      else if ('graveyardCount' in e) assert.equal(seat(e.graveyardCount[0]).graveyard.length, e.graveyardCount[1], `P${e.graveyardCount[0]} graveyard count`);
      else if ('libraryCount' in e) assert.equal(seat(e.libraryCount[0]).library.length, e.libraryCount[1], `P${e.libraryCount[0]} library count`);
      else if ('stackNames' in e) assert.deepEqual([...s.stack].reverse().map(it => it.name), e.stackNames, 'stack names (top first)');
      else if ('mana' in e) { const p = seat(e.mana[0]); const got = [...p.manaPool, ...(p.stickyMana ?? [])].sort().join(''); assert.equal(got, [...e.mana[1]].sort().join(''), `P${e.mana[0]} mana pool`); }
      else if ('attachedTo' in e) { const o = need(e.attachedTo[0]); const host = o.attachedTo == null ? null : findObject(s, o.attachedTo)?.def.name ?? null; assert.equal(host, e.attachedTo[1], `${e.attachedTo[0]} attached to`); }
      else if ('faceDown' in e) assert.equal(!!need(e.faceDown[0]).faceDown, e.faceDown[1], `${e.faceDown[0]} face down`);
      else if ('commanderDamage' in e) { const [i, from, n] = e.commanderDamage; const p = seat(i); const cmd = commanderNamed(s, p, from) ?? need(from); assert.equal(p.commanderDamage?.[cmd.id] ?? 0, n, `P${i} commander damage from ${from}`); }
      else if ('ext' in e) { const [n, key, want] = e.ext; const bag = (need(n) as { ext?: Record<string, unknown> }).ext; assert.deepEqual(bag?.[key], want, `${n} ext.${key}`); }
      // No silent skips: an unchecked expectation is a typo, and a typo that checked nothing would make it green.
      else throw new Error(`unknown expectation ${show(e)} (one of: ${EXPECTATION_KEYS.join(', ')})`);
    } catch (err) { fails.push((err as Error).message); }
  }
  return fails;
}

export async function runScenario(sc: Scenario): Promise<ScenarioRun> {
  const bad = scenarioShape(sc);
  if (bad.length) throw new Error(`scenario ${sc?.name ? `"${sc.name}"` : '(unnamed)'} is malformed:\n  - ${bad.join('\n  - ')}`);
  const g = buildScenario(sc);
  for (const st of sc.script) await runScript(g, [st]);
  g.checkSBA();
  return { game: g, failures: checkExpectations(g, sc) };
}

export { findObject };
