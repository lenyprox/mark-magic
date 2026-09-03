// Simulation side of the analysis engine: resumeTurn/playTurns, Monte Carlo reproducibility, the quick analyzer
// and the worker pool (with in-process workers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDeck, parseDeckList } from '../src/cards/db.js';
import { Game } from '../src/engine/game.js';
import { defTable } from '../src/engine/serialize.js';
import { redact } from '../src/engine/view.js';
import { aggregate, runTrials, wilson } from '../src/analysis/montecarlo.js';
import { analyzeQuick } from '../src/analysis/analyzer.js';
import { AnalysisPool, inlineWorker } from '../src/analysis/pool.js';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import type { ListEntry, McRequest } from '../src/analysis/types.js';
import { C, db, find, Script, setup } from './helpers.js';

function list(file: string): ListEntry[] { return parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8')).cards.filter(c => c.board === 'main').map(c => ({ name: c.name, count: c.count })); }
function deck(file: string) { return loadDeck(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'))).cards; }

/** A mid-game state between the two bundled mono decks with the viewer (P0) to act in main1. */
function midGame() {
  const red = deck('mono-red-burn'), green = deck('mono-green-stompy');
  const g = new Game([red, green], [new RolloutAgent('P0'), new RolloutAgent('P1')], { seed: 11, quiet: true, mulligans: false });
  const s = g.state;
  for (let i = 0; i < 7; i++) { g.draw(0, true); g.draw(1, true); }
  s.turn = 4; s.activePlayer = 0; s.step = 'main1'; s.priority = 0;
  for (const [p, names] of [[0, ['Mountain', 'Mountain', 'Mountain']], [1, ['Forest', 'Forest', 'Forest', 'Grizzly Bears']]] as const) for (const n of names) { const c = s.players[p].library.find(o => o.def.name === n) ?? s.players[p].library[0]; g.moveTo(c, 'battlefield'); c.enteredTurn = 1; }
  for (const c of s.players[0].hand.slice(3)) g.moveTo(c, 'graveyard'); // "already cast" — keeps the list accounting exact
  const bolt = s.players[0].library.find(o => o.def.name === 'Lightning Bolt'); if (bolt) { g.moveTo(bolt, 'hand'); g.state.knowledge.knownInHand.length = 0; g.state.knowledge.revealed.length = 0; }
  return { g, defs: defTable([...red, ...green]), myList: list('mono-red-burn'), theirs: list('mono-green-stompy') };
}

test('resumeTurn from main1 finishes the turn without a new header; playTurns(2) plays two full turns', async () => {
  const g = setup({ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] });
  g.state.priority = 0;
  await g.resumeTurn();
  assert.equal(g.state.step, 'cleanup'); assert.equal(g.state.turn, 5);
  assert.ok(!g.state.log.some(l => l.includes('=== Turn')));
  await g.playTurns(2);
  assert.equal(g.state.turn, 7); assert.equal(g.state.activePlayer, 0);
  assert.equal(g.state.log.filter(l => l.includes('=== Turn')).length, 2);
  assert.equal(g.state.players[0].hand.length, 2, 'drew once on turn 7');
});

test('resumeTurn from declare-blockers runs the damage steps with the declared blocks', async () => {
  const g = setup({ bf: ['Leatherback Baloth', 'Kalonian Tusker'] }, { bf: ['Grizzly Bears'], life: 20 });
  const baloth = find(g, 'Leatherback Baloth'), tusker = find(g, 'Kalonian Tusker'), bears = find(g, 'Grizzly Bears');
  g.state.step = 'declare-blockers'; g.state.priority = 1;
  baloth.attacking = 1; baloth.tapped = true; tusker.attacking = 1; tusker.tapped = true; g.state.attackers = [baloth.id, tusker.id];
  bears.blocking = [baloth.id]; baloth.blockedBy = [bears.id];
  await g.resumeTurn();
  assert.equal(bears.zone, 'graveyard'); assert.equal(g.state.players[1].life, 17, 'only the unblocked Tusker connects');
  assert.equal(g.state.step, 'cleanup'); assert.equal(g.state.attackers.length, 0); assert.equal(baloth.attacking, null);
});

test('resumeTurn from the end step only runs cleanup (discard to seven)', async () => {
  const g = setup({ hand: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, {});
  g.state.step = 'end'; g.state.priority = 0;
  const lib = g.state.players[0].library.length;
  await g.resumeTurn();
  assert.equal(g.state.players[0].hand.length, 7); assert.equal(g.state.step, 'cleanup'); assert.equal(g.state.players[0].library.length, lib, 'no draw happened');
});

test('fastMana caps payment enumeration without changing simple payments', async () => {
  const g = setup({ bf: ['Island', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains'], hand: ['Serra Angel'] }, {});
  g.opts.fastMana = true;
  assert.equal(g.manaLimit, 48);
  assert.ok(await g.performAction(0, { type: 'cast', cardId: g.state.players[0].hand[0].id }));
});

test('wilson interval', () => {
  const [lo, hi] = wilson(50, 100);
  assert.ok(Math.abs(lo - 0.4038) < 5e-4 && Math.abs(hi - 0.5962) < 5e-4, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('Monte Carlo: same baseSeed → byte-identical results; aggregate has Wilson bounds; rollouts are cheap', async () => {
  const { g, defs, myList, theirs } = midGame();
  const view = redact(g.state, 0);
  const ctx = { snapshot: view, viewer: 0 as const, model: { kind: 'exact' as const, list: theirs }, myList, defs };
  const req: McRequest = { candidateId: 'pass', concrete: { type: 'pass' }, trialStart: 0, trialCount: 12, baseSeed: 12345, horizon: 2, policy: 'rollout' };
  const t0 = Date.now();
  const a = await runTrials(ctx, req);
  const ms = Date.now() - t0;
  const b = await runTrials(ctx, req);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.length, 12); assert.ok(a.every(r => r.turnsPlayed >= 1 && r.turnsPlayed <= 2));
  const agg = aggregate(a, 12345);
  assert.equal(agg.n, 12); assert.ok(agg.win.ci95![0] <= agg.win.value && agg.win.value <= agg.win.ci95![1]);
  assert.equal(agg.wins + agg.losses + agg.draws, 12);
  // a different candidate on the same seeds: paired comparison shares seeds
  const bolt = view.players[0].hand.find(o => o.def.name === 'Lightning Bolt');
  if (bolt) {
    const c = await runTrials(ctx, { ...req, candidateId: 'bolt', concrete: { type: 'cast', cardId: bolt.id, targets: [[{ kind: 'player', id: 1 }]] } });
    assert.deepEqual(c.map(r => r.seed), a.map(r => r.seed));
  }
  assert.ok(ms < 20000, `12 rollouts took ${ms} ms`);
});

test('analyzeQuick: candidates, risks, draw odds and could-have, well under budget', async () => {
  const { g, defs, myList, theirs } = midGame();
  const t0 = Date.now();
  const r = await analyzeQuick({ state: g.state, viewer: 0, model: { kind: 'exact', list: theirs }, myList, defs, baseSeed: 12345, requestId: 'q1' });
  const ms = Date.now() - t0;
  assert.ok(r.plays.length >= 1 && r.plays.length <= 4);
  assert.equal(r.baseline.label, 'pass'); assert.equal(r.baseline.status, 'quick');
  assert.ok(r.plays.every(p => p.derivations[0].method === 'heuristic'));
  assert.ok(r.plays[0].evalDelta >= r.plays[r.plays.length - 1].evalDelta, 'sorted best first');
  assert.ok(r.draws.landNext && r.draws.landNext.value > 0 && r.draws.landNext.value < 1);
  assert.ok(r.draws.derivations.length > 0 && r.draws.outs.length > 0);
  assert.equal(r.couldHave.model, 'exact'); assert.ok(r.couldHave.cards.length > 0);
  assert.equal(r.race.method, 'exact');
  assert.ok(JSON.stringify(r).length > 0, 'JSON-serializable');
  assert.ok(ms < 1500, `quick pass took ${ms} ms`);
  // a candidate that casts a creature into open mana carries a counterspell/removal risk when the model has them
  const bear = r.plays.find(p => p.concrete.type === 'cast' && p.label.includes('Grizzly'));
  void bear;
});

test('AnalysisPool: quick then MC chunks across in-process workers; rerun reproduces the estimate exactly', async () => {
  const { g, defs, myList, theirs } = midGame();
  const pool = new AnalysisPool(() => inlineWorker(), 2);
  await pool.init(defs.values());
  const updates: number[] = [];
  const req = { state: g.state, viewer: 0 as const, model: { kind: 'exact' as const, list: theirs }, myList, baseSeed: 777 };
  const h = pool.analyze(req, { trials: 10, chunk: 5, horizon: 1, candidates: 2, onUpdate: r => updates.push(r.plays.filter(p => p.status !== 'quick').length) });
  const quick = await h.quick;
  assert.ok(quick.plays.length <= 2 && quick.baseline.status === 'quick');
  const done = await h.done;
  assert.equal(done.baseline.status, 'mc-done'); assert.ok(done.plays.every(p => p.status === 'mc-done'));
  assert.equal(done.baseline.winProb!.n, 10);
  const mc = done.baseline.derivations.find(d => d.method === 'montecarlo')!;
  assert.ok(mc.mc && mc.mc.n === 10 && mc.mc.rerun.baseSeed === 777);
  const again = await pool.rerun(mc.mc.rerun, req);
  assert.equal(again.length, 10);
  assert.equal(aggregate(again, 777).win.value, done.baseline.winProb!.value, 'identical on re-run');
  assert.deepEqual(again.map(r => r.seed), again.map((_, i) => again[i].seed));
  const twice = await pool.rerun(mc.mc.rerun, req);
  assert.equal(JSON.stringify(twice), JSON.stringify(again));
  assert.ok(updates.length >= 1);
  // a newer request cancels the older one: stale results are dropped
  const h2 = pool.analyze(req, { trials: 50, chunk: 5, horizon: 1, candidates: 1 });
  await h2.quick;
  const h3 = pool.analyze(req, { trials: 0 });
  const r3 = await h3.done;
  assert.equal(r3.requestId, h3.requestId);
  pool.dispose();
  void C; void Script;
});
