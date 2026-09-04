// Scenario DSL for behavioural engine tests (the XMage-style vocabulary from the plan's B10): a typed object
// describes a board, a script of actions and a list of expectations; `runScenario` builds the game from real cards,
// executes the script through the public engine API and checks every expectation. Scenarios are plain data (every
// field is JSON-serialisable, so `log`/`noLog` also take a regex *source* string) which lets the same objects live in
// data/scenarios/*.json, cross a worker_threads postMessage in scripts/verify-scenarios.ts and feed the dashboard.
// test/scenarios/dsl.ts re-exports this module for the suites under test/.
import assert from 'node:assert/strict';
import { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import { findObject, isCreature, keywords, power, toughness } from '../engine/characteristics.js';
import type { GameEventType } from '../engine/events.js';
import { Game } from '../engine/game.js';
import { legalActions } from '../engine/legal.js';
import { makeObject, type Agent, type Decision, type GameObject, type GameState, type LegalAction, type PlayerId, type Step, type TargetRef, type Zone } from '../engine/state.js';
import { defaultAnswer } from '../engine/agents/defaults.js';

// The card database is opened on first use so importing the DSL (for its types, or for validateScenario in the
// file loader) never touches master.db.
let cards: CardDB | null = null;
const C = (n: string): CardDef => { const d = (cards ??= CardDB.shared()).get(n); if (!d) throw new Error('missing card ' + n); return d; };

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

export type ScriptStep =
  | { cast: string; targets?: Ref[][]; x?: number; by?: number; modes?: number[]; alt?: string }
  | { activate: string; ability?: number; targets?: Ref[][]; by?: number }
  | { playLand: string; by?: number }
  /** Declare attackers, and optionally the defending seat's blocks as [blocker, attacker] pairs (see attackWith). */
  | { attack: string[]; blocks?: [string, string][] }
  | { block: [string, string][] }
  | { resolve: true }
  | { sba: true }
  | { turnFaceUp: string; by?: number }
  | { passUntil: Step }
  | { turns: number }
  | { answer: unknown };

/** A regular expression, or its source as a string so the scenario stays JSON-serialisable. */
export type Pattern = RegExp | string;
export const toRegExp = (p: Pattern): RegExp => (typeof p === 'string' ? new RegExp(p) : p);

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

/**
 * Static checks a scenario must pass before it is worth running: it has to cite a rule, do something and assert
 * something, and (for a card's own file) actually put that card on the table. Returns a list of problems.
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
  if (opts.card) {
    const placed = (sc.seats ?? []).some(seat => SEAT_ZONE_FIELDS.some(z => (seat[z] ?? []).includes(opts.card!)));
    if (!placed) out.push(`${where}: never puts ${opts.card} into a seat zone (hand/bf/graveyard/exile/libraryTop/command)`);
  }
  return out;
}

/** An agent that answers with defaults and lets the script pre-load one-off answers (yes/no, choose-cards...). */
class ScenarioAgent implements Agent {
  name: string; queue: unknown[] = [];
  constructor(name: string) { this.name = name; }
  async decide(_s: GameState, _me: PlayerId, d: Decision): Promise<unknown> {
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
    for (const [n, cs] of Object.entries(cfg.counters ?? {})) { const o = pl.battlefield.find(x => x.def.name === n); if (o) for (const [k, v] of Object.entries(cs)) o.counters[k] = v; }
    for (const n of cfg.tapped ?? []) { const o = pl.battlefield.find(x => x.def.name === n && !x.tapped); if (o) o.tapped = true; }
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
    if ('attack' in st) { await declareCombat(g, st.attack, st.blocks ?? []); continue; }
    if ('block' in st) {
      // attackers must already be declared through `attack`; blocks are applied by re-running combat from scratch
      throw new Error('scenario: blocks belong on the { attack, blocks } step (see attackWith)');
    }
    if ('passUntil' in st) { await g.resumeTurn(); continue; }
    if ('turns' in st) { await g.playTurns(st.turns); continue; }
  }
}

/** Attack + block declaration in one go (the engine's simulateCombat takes both at once). */
async function declareCombat(g: Game, attackers: string[], blocks: [string, string][]) {
  const s = g.state; const ap = s.activePlayer; const dp = ap === 0 ? 1 : 0;
  const ids = attackers.map(n => { const o = findByName(s, n, ap); if (!o) throw new Error(`scenario: no attacker named ${n}`); return o.id; });
  const pairs = blocks.map(([b, a]) => {
    const blocker = findByName(s, b, dp); if (!blocker) throw new Error(`scenario: no blocker named ${b}`);
    const attacker = findByName(s, a, ap); if (!attacker) throw new Error(`scenario: no attacker named ${a}`);
    return { blocker: blocker.id, attacker: attacker.id };
  });
  s.step = 'declare-attackers';
  await g.simulateCombat(ids, pairs);
}

/** Combined attack + block declaration in one step; plain data, so it also works from a JSON scenario file. */
export function attackWith(attackers: string[], blocks: [string, string][] = []): ScriptStep {
  return { attack: attackers, ...(blocks.length ? { blocks } : {}) };
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
      else if ('log' in e) { const re = toRegExp(e.log); assert.ok(s.log.some(l => re.test(l)), `log matches ${re}`); }
      else if ('noLog' in e) { const re = toRegExp(e.noLog); const hit = s.log.find(l => re.test(l)); assert.ok(!hit, `no log line matches ${re} (got "${hit}")`); }
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
      else if ('commanderDamage' in e) { const [i, from, n] = e.commanderDamage; const cmd = need(from); assert.equal(seat(i).commanderDamage?.[cmd.id] ?? 0, n, `P${i} commander damage from ${from}`); }
      else if ('ext' in e) { const [n, key, want] = e.ext; const bag = (need(n) as { ext?: Record<string, unknown> }).ext; assert.deepEqual(bag?.[key], want, `${n} ext.${key}`); }
    } catch (err) { fails.push((err as Error).message); }
  }
  return fails;
}

export async function runScenario(sc: Scenario): Promise<ScenarioRun> {
  const g = buildScenario(sc);
  for (const st of sc.script) await runScript(g, [st]);
  g.checkSBA();
  return { game: g, failures: checkExpectations(g, sc) };
}

export { findObject };
