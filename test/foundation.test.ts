// Tests for the Step 1 refactors: deck-list parsing, DeferredAgent, cloneState, serialize round-trip, AI reasoning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDeckList, formatDeckList, loadDeck } from '../src/cards/db.js';
import { DeferredAgent, ReplayAgent } from '../src/engine/agents/deferred.js';
import { cloneState } from '../src/engine/clone.js';
import { serializeState, deserializeState, collectDefs } from '../src/engine/serialize.js';
import { Game } from '../src/engine/game.js';
import { legalActions } from '../src/engine/legal.js';
import { AiAgent, cloneGame } from '../src/ai/ai.js';
import { C, db, find, inHand, Script, setup } from './helpers.js';
import type { GameObject, PlayerAction, StackItem } from '../src/engine/state.js';

// ---------------------------------------------------------------- deck lists
test('deck list: plain, Arena and Moxfield formats; split names survive; comments only at line start', () => {
  const text = `// My deck\n4 Lightning Bolt\n2x Fire // Ice\n1 Wear // Tear (DGM) 135\n\nSideboard\n3 Pyroblast\n# comment\nCommander\n1 Krenko, Mob Boss (M13) 140`;
  const l = parseDeckList(text, 'x');
  assert.deepEqual(l.cards.map(c => [c.name, c.count, c.board, c.set, c.number]), [
    ['Lightning Bolt', 4, 'main', undefined, undefined], ['Fire // Ice', 2, 'main', undefined, undefined], ['Wear // Tear', 1, 'main', 'dgm', '135'],
    ['Pyroblast', 3, 'side', undefined, undefined], ['Krenko, Mob Boss', 1, 'commander', 'm13', '140']]);
  const { cards, missing } = loadDeck(db, l);
  assert.deepEqual(missing, []);
  assert.equal(cards.length, 8, 'main + commander only');
  assert.ok(cards.some(c => c.name === 'Fire // Ice'));
  const round = parseDeckList(formatDeckList(l));
  const key = (c: { name: string; count: number; board: string }) => `${c.board}:${c.name}:${c.count}`;
  assert.deepEqual(round.cards.map(key).sort(), l.cards.map(key).sort());
});

test('deck list: the bundled decks still load in full', () => {
  for (const f of ['mono-red-burn', 'mono-green-stompy', 'ub-control', 'wu-fliers']) {
    const { cards, missing } = loadDeck(db, parseDeckList(fs.readFileSync(`decks/${f}.txt`, 'utf8')));
    assert.deepEqual(missing, []); assert.ok(cards.length >= 40, f);
  }
});

// ---------------------------------------------------------------- deferred agent
test('DeferredAgent: auto-passes outside stops, asks inside, records answers; ReplayAgent replays them', async () => {
  const asked: string[] = [];
  const agent = new DeferredAgent({ name: 'H', ask: async ({ decision }) => { asked.push(decision.kind); return decision.kind === 'priority' ? { type: 'pass' } : { attackers: [] }; } });
  const g = setup({ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }, [agent, new Script('P1')]);
  // my main phase with an action available -> asks
  const a1 = await agent.decide(g.state, 0, { kind: 'priority', legal: legalActions(g, 0) });
  assert.deepEqual(a1, { type: 'pass' }); assert.deepEqual(asked, ['priority']);
  // opponent's main phase, empty stack -> auto pass without asking
  g.state.activePlayer = 1; g.state.step = 'main1';
  await agent.decide(g.state, 0, { kind: 'priority', legal: legalActions(g, 0) });
  assert.deepEqual(asked, ['priority']);
  // something on the stack -> asks even outside stops
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Lightning Bolt', 0).id, targets: [[{ kind: 'object', id: find(g, 'Grizzly Bears').id }]] });
  await agent.decide(g.state, 0, { kind: 'priority', legal: legalActions(g, 0) });
  assert.deepEqual(asked, ['priority', 'priority']);
  assert.equal(agent.recorded.length, 2);
  const replay = new ReplayAgent('R', agent.recorded);
  assert.deepEqual(await replay.decide(g.state, 0, { kind: 'priority', legal: [] }), { type: 'pass' });
});

// ---------------------------------------------------------------- clone
test('cloneState: shares defs, copies mutable data, keeps stack source aliasing, and isolates the original', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain', 'Glorious Anthem'], hand: ['Lightning Bolt', 'Grizzly Bears'] }, { bf: ['Grizzly Bears'] });
  const bears = find(g, 'Grizzly Bears', 1);
  (bears as GameObject & { deathtouched?: boolean }).deathtouched = true;
  bears.activatedThisTurn.add(3); bears.counters['+1/+1'] = 2;
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Lightning Bolt', 0).id, targets: [[{ kind: 'object', id: bears.id }]] });
  const anthem = find(g, 'Glorious Anthem', 0); (anthem as GameObject & { kicked?: boolean }).kicked = true;
  const c = cloneState(g.state);
  const cb = c.players[1].battlefield[0];
  assert.equal(cb.def, bears.def, 'def shared by identity');
  assert.notEqual(cb.activatedThisTurn, bears.activatedThisTurn); assert.ok(cb.activatedThisTurn.has(3));
  assert.notEqual(cb.counters, bears.counters); assert.equal(cb.counters['+1/+1'], 2);
  assert.equal((cb as GameObject & { deathtouched?: boolean }).deathtouched, true, 'ad-hoc flag copied');
  assert.equal((c.players[0].battlefield.find(o => o.def.name === 'Glorious Anthem') as GameObject & { kicked?: boolean }).kicked, true);
  // the spell on the stack is not in any zone, but its targetsByEffect map is a fresh Map
  assert.ok(c.stack[0].targetsByEffect instanceof Map); assert.notEqual(c.stack[0].targetsByEffect, g.state.stack[0].targetsByEffect);
  assert.notEqual(c.stack[0].source, g.state.stack[0].source);
  // mutate the clone through the engine: original untouched
  const cg = Game.fromState(c, [new Script('a'), new Script('b')], { quiet: true });
  await cg.resolveStackFully();
  assert.equal(cb.zone, 'graveyard'); assert.equal(bears.zone, 'battlefield');
});

test('cloneState: ability on the stack keeps its source aliased to the battlefield instance', () => {
  const g = setup({ bf: ['Grizzly Bears'] }, {});
  const bears = find(g, 'Grizzly Bears', 0);
  g.state.stack.push({ id: 5, kind: 'ability', name: 'x', source: bears, controller: 0, effects: [], targets: [], targetsByEffect: new Map(), x: 0, text: '' } as StackItem);
  const c = cloneState(g.state);
  assert.equal(c.stack[0].source, c.players[0].battlefield[0]);
});

// ---------------------------------------------------------------- serialize
test('serializeState/deserializeState round-trip preserves everything (including a spell on the stack and ad-hoc props)', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain', 'Grizzly Bears'], hand: ['Lightning Bolt', 'Pacifism'] }, { bf: ['Grizzly Bears'] });
  const bears = find(g, 'Grizzly Bears', 1); bears.activatedThisTurn.add(1);
  (bears as GameObject & { wasBlocked?: boolean }).wasBlocked = true;
  (g.state as { fog?: number }).fog = 5;
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Lightning Bolt', 0).id, targets: [[{ kind: 'object', id: bears.id }]] });
  const ser = serializeState(g.state);
  const json = JSON.stringify(ser);
  const back = deserializeState(JSON.parse(json), collectDefs(g.state));
  assert.deepEqual(serializeState(back), JSON.parse(json));
  assert.ok(back.players[1].battlefield[0].activatedThisTurn instanceof Set);
  assert.equal(back.stack[0].source.def.name, 'Lightning Bolt');
  assert.equal((back as { fog?: number }).fog, 5);
  // the rebuilt state plays on
  const g2 = Game.fromState(back, [new Script('a'), new Script('b')], { quiet: true });
  await g2.resolveStackFully();
  assert.equal(back.players[1].battlefield.length, 0);
});

// ---------------------------------------------------------------- reasoning
test('AI: structured reasoning lists every candidate and the chosen one is the maximum', async () => {
  const ai = new AiAgent({ name: 'AI', verbose: false });
  const g = setup({ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'], life: 3 }, [ai, new Script('P1')]);
  ai.attach(g);
  const seen: string[] = []; ai.onReasoning = r => seen.push(r.kind);
  const action = await ai.decide(g.state, 0, { kind: 'priority', legal: legalActions(g, 0) }) as PlayerAction;
  assert.equal(action.type, 'cast');
  const r = ai.lastReasoning!;
  assert.equal(r.kind, 'priority'); assert.deepEqual(seen, ['priority']);
  assert.ok(r.candidates.length >= 3, 'pass + face + bears');
  assert.equal(r.chosen!.score, Math.max(...r.candidates.map(c => c.score)));
  assert.ok(r.candidates.some(c => c.label === 'pass'));
  assert.equal(r.candidates[0].score, r.chosen!.score, 'sorted best first');
  assert.match(r.summary, /Lightning Bolt/);
});

test('cloneGame no longer deep-copies defs', () => {
  const g = setup({ bf: ['Grizzly Bears'] }, {});
  const c = cloneGame(g);
  assert.equal(c.state.players[0].battlefield[0].def, C('Grizzly Bears'));
});
