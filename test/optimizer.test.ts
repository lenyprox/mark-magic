// Optimiser: paired maths, swap bookkeeping, neighbour constraints, and a small real run (deterministic, resumable,
// with game reuse) between the bundled 60-card decks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDeckList } from '../src/cards/db.js';
import { Rng } from '../src/engine/game.js';
import { buildPool, neighbours, orderOf, seedCandidate, swapCandidate } from '../src/optimizer/candidates.js';
import { pairedCompare } from '../src/optimizer/evaluator.js';
import { runOptimizer } from '../src/optimizer/runner.js';
import { OptimizerStore } from '../src/optimizer/store.js';
import type { OptimizerSpec, StoredGame } from '../src/optimizer/types.js';
import { openUserDb } from '../src/user/db.js';
import { DeckStore } from '../src/user/decks.js';
import { CollectionStore } from '../src/collection/store.js';
import { db } from './helpers.js';

const game = (index: number, winner: number | null, seen: string[] = []): StoredGame => ({ candidateId: 'x', index, seed: index, seatOrder: [0, 1], winner, firstSeat: 0, turns: 5, mulligans: [0, 0], openingHand: [[], []], seen: [seen, []], firstCommanderCastTurn: [null, null], lossReason: [null, null], unsimulated: 0, ms: 1, opponent: 'o', reusedFrom: null });

test('pairedCompare: discordant counts, standard error and acceptance', () => {
  const inc = new Map<number, StoredGame>(); const cand = new Map<number, StoredGame>();
  for (let i = 0; i < 100; i++) { inc.set(i, game(i, i % 2 === 0 ? 0 : 1)); cand.set(i, game(i, i % 2 === 0 || i % 5 === 1 ? 0 : 1)); }
  const c = pairedCompare(cand, inc);
  assert.equal(c.n, 100); assert.equal(c.a, 10); assert.equal(c.b, 0); assert.equal(c.delta, 0.1);
  assert.ok(c.accepted, 'ten discordant wins and none lost is significant');
  const noisy = new Map<number, StoredGame>(); for (let i = 0; i < 100; i++) noisy.set(i, game(i, i % 3 === 0 ? 0 : 1));
  const d = pairedCompare(noisy, inc);
  assert.ok(!d.accepted); assert.ok(d.ci95[0] < 0 && d.ci95[1] > 0 || d.delta < 0);
  assert.equal(pairedCompare(new Map(), inc).n, 0);
});

test('swapCandidate keeps every other card\'s slot in the explicit order', () => {
  const seed = seedCandidate([{ name: 'Lightning Bolt', count: 4 }, { name: 'Mountain', count: 20 }, { name: 'Shock', count: 2 }]);
  assert.equal(seed.order.length, 26); assert.deepEqual(orderOf(seed.list).slice(0, 4), ['Lightning Bolt', 'Lightning Bolt', 'Lightning Bolt', 'Lightning Bolt']);
  const c = swapCandidate(seed, 'Shock', 'Lava Spike', false, 1, 0);
  assert.deepEqual(c.list.find(e => e.name === 'Shock'), { name: 'Shock', count: 1 }); assert.deepEqual(c.list.find(e => e.name === 'Lava Spike'), { name: 'Lava Spike', count: 1 });
  const i = seed.order.indexOf('Shock');
  assert.equal(c.order[i], 'Lava Spike'); assert.deepEqual(c.order.filter((_, k) => k !== i), seed.order.filter((_, k) => k !== i));
  assert.equal(c.parentId, 'seed'); assert.notEqual(c.listHash, seed.listHash);
});

test('neighbours respect lock-ins, bans, singleton and the land target; deterministic for a seed', () => {
  const owned = new Map<string, number>();
  for (const n of ['Lightning Bolt', 'Shock', 'Lava Spike', 'Rift Bolt', 'Monastery Swiftspear', 'Goblin Guide', 'Mountain', 'Skullcrack', 'Searing Spear']) { const d = db.get(n); if (d) owned.set(d.oracleId, 4); }
  const constraints = { lands: null, lockIn: ['Lightning Bolt'], ban: ['Searing Spear'], onlyFullyParsedSwapIns: false };
  const pool = buildPool(db, { commander: null, owned, constraints, format: 'freeform' });
  assert.ok(pool.some(p => p.name === 'Lava Spike')); assert.ok(!pool.some(p => p.name === 'Searing Spear'), 'banned card is not in the pool');
  const seed = seedCandidate([{ name: 'Lightning Bolt', count: 4 }, { name: 'Shock', count: 4 }, { name: 'Mountain', count: 20 }]);
  const lookup = (n: string) => db.get(n) ?? undefined;
  const mk = () => neighbours(seed, 0, 0, { count: 6, contributions: new Map([['Shock', -0.1]]), landTarget: 20, tried: new Set(), rng: new Rng(5), pool, constraints, lookup });
  const a = mk(), b = mk();
  assert.ok(a.length > 0);
  assert.deepEqual(a.map(c => c.id), b.map(c => c.id), 'same rng seed → same proposals');
  assert.ok(a.every(c => c.swapOut !== 'Lightning Bolt'), 'locked card never leaves');
  assert.ok(a.every(c => c.swapOut !== 'Mountain'), 'lands stay at the target count');
  assert.ok(a.every(c => c.swapIn !== 'Searing Spear'));
  assert.ok(a.every(c => c.swapIn !== 'Shock' && c.swapIn !== 'Lightning Bolt'), 'no duplicates of cards already in the list');
});

test('a small real run: deterministic, reuses games, checkpoints, resumes and reports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-')); const file = path.join(dir, 'user.db');
  const u = openUserDb(file);
  const decks = new DeckStore(u); const store = new OptimizerStore(u);
  const list = (f: string) => parseDeckList(fs.readFileSync(`decks/${f}.txt`, 'utf8'), f);
  const toCards = (f: string) => list(f).cards.filter(c => c.board === 'main').map((c, i) => ({ board: 'main' as const, oracleId: db.get(c.name)!.oracleId, name: c.name, printingId: null, count: c.count, position: i }));
  const burn = decks.create({ name: 'Burn', format: 'modern', cards: toCards('mono-red-burn') });
  const stompy = decks.create({ name: 'Stompy', format: 'modern', role: 'opponent', cards: toCards('mono-green-stompy') });
  // register both decks as owned so the pool has swap-ins
  const coll = new CollectionStore(u, db);
  coll.importRows([...list('mono-red-burn').cards, ...list('mono-green-stompy').cards].filter(c => c.board === 'main').map((c, i) => ({ count: c.count, name: c.name, line: i + 1 })), { kind: 'text', ref: 'test' });
  const spec: OptimizerSpec = { name: 'test', seed: 11, commander: null, seedDeckId: burn.id, format: 'freeform', pool: 'owned', maxUnowned: 0, field: [{ kind: 'deck', deckId: stompy.id, name: 'Stompy', weight: 1 }], players: 2, agent: 'rollout', maxTurns: 20, mulligans: 'lands', budget: { games: 400, maxIterations: 2, blockSize: 12, swapsPerIteration: 3, race: { stage1: 6, keep: 1 }, rotateBlockEvery: 5 }, constraints: { lands: null, lockIn: [], ban: [], onlyFullyParsedSwapIns: false } };
  const run = store.create(spec, { deckId: burn.id, commander: null });
  const report = await runOptimizer({ db: u, cards: db }, run.id);
  assert.ok(report);
  const stored = store.get(run.id)!;
  assert.equal(stored.status, 'done');
  assert.equal(report.baseline.games, 12); assert.ok(report.baseline.winRate.ci95);
  assert.ok(report.swaps.length >= 1, 'swaps were evaluated');
  const counts = store.gameCount(run.id);
  assert.ok(counts.reused > 0, `some games were inherited (${counts.reused})`);
  assert.ok(report.derivations.length >= 2 && report.derivations.every(d => d.formula));
  assert.ok(report.keepGuidance.length >= 1);
  assert.equal(report.budget.iterations, 2);
  // determinism: a second run with the same spec reports the same swaps and numbers
  const run2 = store.create(spec, { deckId: burn.id, commander: null });
  const report2 = await runOptimizer({ db: u, cards: db }, run2.id);
  const strip = (r: typeof report) => JSON.stringify({ ...r!, budget: { ...r!.budget, seconds: 0 } });
  assert.equal(strip(report), strip(report2));
  // resume: a run paused after the seed evaluation continues to the same end state
  const run3 = store.create({ ...spec, budget: { ...spec.budget, maxIterations: 1 } }, { deckId: burn.id, commander: null });
  await runOptimizer({ db: u, cards: db }, run3.id);
  const cp = store.get(run3.id)!.checkpoint!; assert.equal(cp.iteration, 1);
  // pretend the daemon died: extend the budget and resume from the checkpoint
  u.prepare('UPDATE optimizer_runs SET status = ?, spec = ? WHERE id = ?').run('paused', JSON.stringify(spec), run3.id);
  const report3 = await runOptimizer({ db: u, cards: db }, run3.id);
  assert.equal(strip(report3), strip(report), 'resumed run reaches the identical end state');
  u.close(); fs.rmSync(dir, { recursive: true, force: true });
});
