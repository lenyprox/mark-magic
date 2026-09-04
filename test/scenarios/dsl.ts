// Scenario DSL for behavioural engine tests (the XMage-style vocabulary from the plan's B10): a typed object
// describes a board, a script of actions and a list of expectations; `runScenario` builds the game from real cards,
// executes the script through the public engine API and checks every expectation. Scenarios are plain data so the
// same files can later feed the coverage dashboard and the table's tutorial puzzles.
import assert from 'node:assert/strict';
import { findObject, isCreature, keywords, power, toughness } from '../../src/engine/characteristics.js';
import type { GameEventType } from '../../src/engine/events.js';
import { Game } from '../../src/engine/game.js';
import { legalActions } from '../../src/engine/legal.js';
import { makeObject, type Agent, type Decision, type GameObject, type GameState, type LegalAction, type PlayerId, type Step, type TargetRef } from '../../src/engine/state.js';
import { C } from '../helpers.js';
import { defaultAnswer } from '../../src/engine/agents/defaults.js';

export interface SeatSetup {
  hand?: string[]; bf?: string[]; graveyard?: string[]; exile?: string[]; libraryTop?: string[]; life?: number;
  /** Commander games: cards that start in the command zone. */
  command?: string[];
  /** Per card name: counters to place (first match on the battlefield). */
  counters?: Record<string, Record<string, number>>;
  tapped?: string[];
}

export type Ref = string | `P${number}`;

export type ScriptStep =
  | { cast: string; targets?: Ref[][]; x?: number; by?: number; modes?: number[] }
  | { activate: string; ability?: number; targets?: Ref[][]; by?: number }
  | { playLand: string; by?: number }
  | { attack: string[] }
  | { block: [string, string][] }
  | { resolve: true }
  | { sba: true }
  | { passUntil: Step }
  | { turns: number }
  | { answer: unknown };

export type Expectation =
  | { zone: [string, 'battlefield' | 'graveyard' | 'exile' | 'hand' | 'library' | 'stack' | 'command'] }
  | { life: [number, number] }
  | { pt: [string, number, number] }
  | { keywords: [string, string[]] }
  | { counters: [string, Record<string, number>] }
  | { tapped: [string, boolean] }
  | { control: [string, number] }
  | { events: { type: GameEventType; min?: number; max?: number } }
  | { log: RegExp }
  | { unsimulated: number }
  | { winner: number | null }
  | { stack: number };

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
      const l = legalFor(g, by, x => x.action.type === 'cast' && x.action.cardId === card.id && (st.x === undefined || x.action.x !== undefined) && (!st.modes || JSON.stringify(x.action.modes) === JSON.stringify(st.modes)));
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
      const ok = await g.performAction(by, { type: 'play-land', cardId: card.id });
      if (!ok) throw new Error(`scenario: play land ${st.playLand} was rejected`);
      continue;
    }
    if ('resolve' in st) { await g.resolveStackFully(); continue; }
    if ('sba' in st) { g.checkSBA(); continue; }
    if ('attack' in st) {
      const ids = st.attack.map(n => findByName(s, n, s.activePlayer)!.id);
      s.step = 'declare-attackers';
      await g.simulateCombat(ids, []);
      continue;
    }
    if ('block' in st) {
      // attackers must already be declared through `attack`; blocks are applied by re-running combat from scratch
      throw new Error('scenario: use { attackBlocks } via simulateCombat — block steps must be combined with attack (see attackWith)');
    }
    if ('passUntil' in st) { await g.resumeTurn(); continue; }
    if ('turns' in st) { await g.playTurns(st.turns); continue; }
  }
}

/** Combined attack + block declaration in one step (the engine's simulateCombat takes both). */
export function attackWith(attackers: string[], blocks: [string, string][] = []): ScriptStep {
  return { attack: attackers, ...(blocks.length ? { __blocks: blocks } : {}) } as ScriptStep;
}

export function checkExpectations(g: Game, sc: Scenario): string[] {
  const s = g.state; const fails: string[] = [];
  const obj = (n: string) => findByName(s, n);
  for (const e of sc.expect) {
    try {
      if ('zone' in e) { const o = obj(e.zone[0]); assert.ok(o, `no object ${e.zone[0]}`); assert.equal(o.zone, e.zone[1], `${e.zone[0]} zone`); }
      else if ('life' in e) assert.equal(s.players[e.life[0] as PlayerId].life, e.life[1], `P${e.life[0]} life`);
      else if ('pt' in e) { const o = obj(e.pt[0])!; assert.ok(o && isCreature(o), `${e.pt[0]} is a creature`); assert.deepEqual([power(s, o), toughness(s, o)], [e.pt[1], e.pt[2]], `${e.pt[0]} P/T`); }
      else if ('keywords' in e) { const o = obj(e.keywords[0])!; const kw = keywords(s, o); for (const k of e.keywords[1]) assert.ok(kw.includes(k as never), `${e.keywords[0]} has ${k}`); }
      else if ('counters' in e) { const o = obj(e.counters[0])!; for (const [k, v] of Object.entries(e.counters[1])) assert.equal(o.counters[k] ?? 0, v, `${e.counters[0]} ${k} counters`); }
      else if ('tapped' in e) { const o = obj(e.tapped[0])!; assert.equal(o.tapped, e.tapped[1], `${e.tapped[0]} tapped`); }
      else if ('control' in e) { const o = obj(e.control[0])!; assert.equal(o.controller, e.control[1], `${e.control[0]} controller`); }
      else if ('events' in e) { const n = s.eventCounts?.[e.events.type] ?? 0; if (e.events.min !== undefined) assert.ok(n >= e.events.min, `${e.events.type} events ${n} >= ${e.events.min}`); if (e.events.max !== undefined) assert.ok(n <= e.events.max, `${e.events.type} events ${n} <= ${e.events.max}`); }
      else if ('log' in e) assert.ok(s.log.some(l => e.log.test(l)), `log matches ${e.log}`);
      else if ('unsimulated' in e) assert.equal(s.eventCounts?.unsimulated ?? 0, e.unsimulated, 'unsimulated clauses');
      else if ('winner' in e) assert.equal(s.winner, e.winner, 'winner');
      else if ('stack' in e) assert.equal(s.stack.length, e.stack, 'stack size');
    } catch (err) { fails.push((err as Error).message); }
  }
  return fails;
}

export async function runScenario(sc: Scenario): Promise<ScenarioRun> {
  const g = buildScenario(sc);
  const steps = sc.script.map(st => {
    const b = (st as { __blocks?: [string, string][] }).__blocks;
    return b ? { attackBlocks: { attack: (st as { attack: string[] }).attack, blocks: b } } : st;
  });
  for (const st of steps) {
    if ('attackBlocks' in st) {
      const s = g.state; const ap = s.activePlayer; const dp = ap === 0 ? 1 : 0;
      const ids = st.attackBlocks.attack.map(n => findByName(s, n, ap)!.id);
      const blocks = st.attackBlocks.blocks.map(([b, a]) => ({ blocker: findByName(s, b, dp)!.id, attacker: findByName(s, a, ap)!.id }));
      s.step = 'declare-attackers';
      await g.simulateCombat(ids, blocks);
    } else await runScript(g, [st as ScriptStep]);
  }
  g.checkSBA();
  return { game: g, failures: checkExpectations(g, sc) };
}

export { findObject };
