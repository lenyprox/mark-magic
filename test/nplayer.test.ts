// Three- and four-player games: priority goes around the table, APNAP trigger order, attack targets per attacker,
// blockers asked of each defender, elimination cleanup (CR 800.4a) and the last player standing winning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDeck, parseDeckList } from '../src/cards/db.js';
import { Game } from '../src/engine/game.js';
import { alive, apnapOrder, nextInTurnOrder, opponentsOf, primaryOpponent } from '../src/engine/players.js';
import { makeObject, type Agent, type Decision, type GameState, type PlayerId } from '../src/engine/state.js';
import { legalActions } from '../src/engine/legal.js';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import { evaluate } from '../src/ai/search.js';
import { C, db, Script } from './helpers.js';

const filler = () => Array(20).fill(C('Mountain'));
const deck = (file: string) => loadDeck(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'))).cards;

/** A recording agent: passes and remembers every decision it was asked. */
class Recorder implements Agent {
  name: string; asked: Decision['kind'][] = [];
  constructor(name: string, private script?: (s: GameState, me: PlayerId, d: Decision) => unknown) { this.name = name; }
  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    this.asked.push(d.kind);
    const r = this.script?.(s, me, d); if (r !== undefined) return r;
    return new Script(this.name).decide(s, me, d);
  }
}

function pod(n: number, agents?: Agent[]) {
  const a = agents ?? Array.from({ length: n }, (_, i) => new Script(`P${i}`));
  const g = new Game(Array.from({ length: n }, filler), a, { seed: 1, quiet: true, mulligans: false, events: 'full' });
  const s = g.state; s.turn = 5; s.activePlayer = 0; s.step = 'main1'; s.priority = 0;
  const put = (pid: number, names: string[], zone: 'battlefield' | 'hand') => { for (const nm of names) { const o = makeObject(s.nextId++, C(nm), pid, zone, 1); o.enteredTurn = 1; s.players[pid][zone].push(o); } };
  return { g, s, put };
}

test('players helpers: turn order, opponents, next alive, APNAP', () => {
  const { s } = pod(4);
  assert.deepEqual(alive(s), [0, 1, 2, 3]);
  assert.deepEqual(opponentsOf(s, 1), [2, 3, 0]);
  assert.equal(nextInTurnOrder(s, 3), 0);
  s.players[2].lost = true;
  assert.deepEqual(alive(s), [0, 1, 3]); assert.equal(nextInTurnOrder(s, 1), 3); assert.equal(primaryOpponent(s, 1), 3);
  s.activePlayer = 3; assert.deepEqual(apnapOrder(s), [3, 0, 1, 2]);
});

test('a 3-player game: priority visits every seat before the stack resolves; turns rotate; game ends with one player left', async () => {
  const recs = [0, 1, 2].map(i => new Recorder(`P${i}`));
  const { g, s } = pod(3, recs);
  const orderSeen: number[] = [];
  const orig = g.ask.bind(g);
  g.ask = async (p, d) => { if (d.kind === 'priority') orderSeen.push(p); return orig(p, d); };
  await g.resumeTurn();
  // in main1 with an empty stack, every living player passes once per step
  assert.deepEqual(orderSeen.slice(0, 3), [0, 1, 2]);
  await g.playTurns(2);
  assert.equal(s.activePlayer, 2, 'turn passes around the table');
  s.players[1].life = 0; s.players[2].life = 0; g.checkSBA();
  assert.equal(s.winner, 0); assert.ok(s.players[1].lost && s.players[2].lost);
  assert.ok(s.events!.filter(e => e.type === 'player-eliminated').length === 2);
});

test('elimination in a 4-player game removes the player\'s permanents and keeps the game going', () => {
  const { g, s, put } = pod(4);
  put(1, ['Grizzly Bears', 'Mountain'], 'battlefield');
  s.players[1].life = 0; g.checkSBA();
  assert.equal(s.winner, null, 'three players remain');
  assert.ok(s.players[1].lost); assert.equal(s.players[1].battlefield.length, 0, 'their permanents left the game');
  assert.deepEqual(alive(s), [0, 2, 3]);
  assert.ok(s.log.some(l => /leaves the game/.test(l)));
  assert.equal(nextInTurnOrder(s, 0), 2);
});

test('attack declarations name a defender per attacker; each defender is asked for blocks; damage goes to the right player', async () => {
  let asked: { seat: number; attackers: number[] }[] = [];
  const agents = [0, 1, 2].map(i => new Recorder(`P${i}`, (s, me, d) => {
    if (d.kind === 'attackers' && me === 0) { const [a, b] = d.candidates; return { attackers: [a, b], targets: { [a]: 1, [b]: 2 } }; }
    if (d.kind === 'blockers') { asked.push({ seat: me, attackers: d.attackers }); return { blocks: me === 2 ? [{ blocker: s.players[2].battlefield.find(o => o.def.name === 'Grizzly Bears')!.id, attacker: d.attackers[0] }] : [] }; }
    return undefined;
  }));
  const { g, s, put } = pod(3, agents);
  put(0, ['Hill Giant', 'Grizzly Bears'], 'battlefield');
  put(1, ['Grizzly Bears'], 'battlefield');
  put(2, ['Grizzly Bears'], 'battlefield');
  s.step = 'main1';
  await g.resumeTurn();
  assert.deepEqual(asked.map(a => a.seat).sort(), [1, 2], 'both defenders were asked');
  assert.ok(asked.every(a => a.attackers.length === 1), 'each defender sees only the attackers pointed at them');
  assert.equal(s.players[1].life, 17, 'Hill Giant (3) unblocked into seat 1');
  assert.equal(s.players[2].life, 20, 'the Bears attacking seat 2 were blocked');
  const attack = s.events!.find(e => e.type === 'attack')!;
  assert.equal(attack.type === 'attack' && attack.attackers.length, 2);
});

test('legal targets in a pod include every living opponent and player', () => {
  const { g, s, put } = pod(4);
  put(0, ['Mountain'], 'battlefield'); put(0, ['Lightning Bolt'], 'hand');
  const bolt = legalActions(g, 0).find(l => l.action.type === 'cast')!;
  const players = bolt.targetOptions![0].options.filter(o => o.kind === 'player').map(o => o.id);
  assert.deepEqual(players, [0, 1, 2, 3]);
  s.players[2].lost = true;
  const again = legalActions(g, 0).find(l => l.action.type === 'cast')!;
  assert.deepEqual(again.targetOptions![0].options.filter(o => o.kind === 'player').map(o => o.id), [0, 1, 3]);
});

test('evaluate: two-player value is the classic difference; multiplayer weighs the strongest opponent extra', () => {
  const { s } = pod(2);
  const two = evaluate(s, 0);
  assert.equal(two, 0, 'symmetric start');
  const { s: s4, put } = pod(4);
  put(1, ['Hill Giant', 'Hill Giant'], 'battlefield');
  const v = evaluate(s4, 0);
  assert.ok(v < 0, 'a stronger opponent lowers my evaluation');
  put(2, ['Hill Giant', 'Hill Giant'], 'battlefield'); put(3, ['Hill Giant', 'Hill Giant'], 'battlefield');
  assert.ok(evaluate(s4, 0) < v, 'more strong opponents is worse');
});

test('a full 3-player rollout game between real decks finishes with one winner and no engine error', async () => {
  const decks = [deck('mono-red-burn'), deck('mono-green-stompy'), deck('mono-red-burn')];
  const g = new Game(decks, decks.map((_, i) => new RolloutAgent(`P${i}`)), { seed: 4, quiet: true, maxTurns: 90 });
  const w = await g.play();
  const s = g.state;
  assert.ok(w === null || (typeof w === 'number' && !s.players[w].lost));
  if (w !== null) assert.equal(alive(s).length, 1, 'exactly one player left');
  assert.ok(s.turn > 3);
  assert.ok(s.eventCounts!['attack'] ?? 0 > 0, 'combat happened');
});
