// Batch runner: seat rotation, determinism (same spec twice → identical JSON), pool == serial, cancellation at a
// game boundary, a worker dying mid-run, instrumentation (mulligans, opening hands, seen sets) and the rerun verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDeckList } from '../src/cards/db.js';
import { buildDeckPayload } from '../src/play/payload.js';
import { aggregateMatches, assembleResult, deckArray, deckHash, runMatches, seatOrderFor, specRef, verifyRerun } from '../src/sim/batch.js';
import { BatchPool, inlineBatchWorker, type BatchWorkerLike } from '../src/sim/batchPool.js';
import type { GameRecordLite, MatchSpec } from '../src/sim/types.js';
import { db } from './helpers.js';

const payload = (file: string) => buildDeckPayload(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'), file), { name: file });
const spec = (over: Partial<MatchSpec> = {}): MatchSpec => ({ id: 't', decks: [payload('mono-red-burn'), payload('mono-green-stompy')], games: 6, baseSeed: 99, seating: 'rotate', agent: 'rollout', format: 'freeform', maxTurns: 25, mulligans: 'lands', record: 'summary', ...over });

test('seatOrderFor: Latin rotation gives every deck every seat equally; fixed keeps deck i in seat i', () => {
  const counts = [[0, 0], [0, 0]];
  for (let i = 0; i < 10; i++) { const o = seatOrderFor(i, 2); counts[o[0]][0]++; counts[o[1]][1]++; }
  assert.deepEqual(counts, [[5, 5], [5, 5]]);
  for (let i = 0; i < 8; i++) { const o = seatOrderFor(i, 4, 4); assert.deepEqual([...o].sort(), [0, 1, 2, 3]); assert.equal(o[0], i % 4); }
  assert.deepEqual(seatOrderFor(3, 2, 2, 'fixed'), [0, 1]);
  assert.throws(() => seatOrderFor(0, 3, 2), /one deck per seat/);
});

test('deckArray is canonical (sorted) and deckHash is content-based', () => {
  const p = payload('mono-red-burn');
  const a = deckArray(p);
  assert.equal(a.length, 60);
  assert.ok(a.every((d, i) => i === 0 || d.name >= a[i - 1].name));
  const q = { ...p, main: [...p.main].reverse() };
  assert.equal(deckHash(p), deckHash(q), 'order of entries does not change the hash');
  assert.notEqual(deckHash(p), deckHash(payload('mono-green-stompy')));
});

test('runMatches: the same spec twice produces byte-identical results; records carry seats, hands and seen sets', async () => {
  const a = await runMatches(spec());
  const b = await runMatches(spec());
  const strip = (r: typeof a) => JSON.stringify({ ...r, aggregate: { ...r.aggregate, ms: 0, gamesPerSecond: 0 }, games: r.games.map(g => ({ ...g, ms: 0 })) });
  assert.equal(strip(a), strip(b));
  assert.equal(a.games.length, 6);
  for (const g of a.games) {
    assert.deepEqual([...g.seatOrder].sort(), [0, 1]);
    assert.ok(g.turns > 0 || g.error, `game ${g.index} played turns`);
    assert.ok(g.openingHand[0].length >= 5 && g.openingHand[0].length <= 7, `opening hand ${g.openingHand[0].length}`);
    assert.ok(g.seen[0].length >= g.openingHand[0].length, 'seen includes at least the opening hand');
    assert.ok(g.winner === null || g.winner === 0 || g.winner === 1);
  }
  assert.deepEqual(a.games.map(g => g.seatOrder[0]), [0, 1, 0, 1, 0, 1], 'rotation alternates');
  assert.equal(a.aggregate.games, 6); assert.equal(a.aggregate.byDeck[0].wins + a.aggregate.byDeck[0].losses + a.aggregate.byDeck[0].draws, 6 - a.aggregate.errors);
  assert.equal(a.derivation.method, 'montecarlo'); assert.equal(a.derivation.sim?.n, 6 - a.aggregate.errors);
  assert.ok(a.derivation.inputs.some(i => i.name === 'baseSeed' && i.value === 99));
});

test('a chunked pool run equals the serial run and cancellation stops at a game boundary', async () => {
  const serial = await runMatches(spec({ games: 8 }));
  const pool = new BatchPool(() => inlineBatchWorker(), 3);
  await pool.ready();
  try {
    const progress: number[] = [];
    const r = await pool.run(spec({ games: 8 }), { chunk: 3, onProgress: p => progress.push(p.done), throttleMs: 0 }).result;
    const key = (g: GameRecordLite) => JSON.stringify({ ...g, ms: 0 });
    assert.deepEqual(r.games.map(key), serial.games.map(key));
    assert.equal(r.games.map(g => g.index).join(','), '0,1,2,3,4,5,6,7');
    assert.ok(progress.length >= 1 && progress[progress.length - 1] <= 8);
    const h = pool.run(spec({ games: 40 }), { chunk: 4 });
    setTimeout(() => h.cancel(), 30);
    const partial = await h.result;
    assert.ok(h.cancelled); assert.ok(partial.games.length < 40, `cancelled with ${partial.games.length} games`);
    assert.ok(partial.games.every(g => g.turns > 0 || g.error), 'no half-played game leaked out');
  } finally { pool.dispose(); }
});

/**
 * A worker that dies part-way through a run: it plays its first chunk, then answers the next `run` with the bare
 * `error` a dead thread produces (nodeWorker turns worker_threads' 'error'/'exit' into exactly this — no jobId, no
 * chunkId) and goes silent for good.
 */
function dyingBatchWorker(): BatchWorkerLike {
  const inner = inlineBatchWorker();
  let runs = 0; let dead = false;
  const w: BatchWorkerLike = {
    onmessage: null,
    postMessage(msg) {
      if (dead) return;
      if (msg.type === 'run' && ++runs === 2) { dead = true; setTimeout(() => w.onmessage?.({ data: { type: 'error', message: 'batch worker thread exited with code 1' } }), 0); return; }
      inner.postMessage(msg);
    },
    terminate() { dead = true; w.onmessage = null; inner.terminate(); },
  };
  inner.onmessage = ev => { if (!dead) w.onmessage?.(ev); };
  return w;
}

test('a worker that dies after init settles its run instead of hanging', async () => {
  const pool = new BatchPool(() => dyingBatchWorker(), 1);
  await pool.ready();
  const within5s = async (p: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = await Promise.race([p.then(() => 'resolved' as const, (e: Error) => e), new Promise<'hung'>(r => { timer = setTimeout(() => r('hung'), 5000); })]);
    clearTimeout(timer);
    return out;
  };
  try {
    // The worker takes chunk 0, then dies on chunk 1: nothing will ever report that chunk done, so the run must reject.
    const first = await within5s(pool.run(spec({ games: 8 }), { chunk: 2 }).result);
    assert.ok(first instanceof Error, `the run settled within 5 s (got ${first})`);
    assert.match(first.message, /exited with code 1/, 'the run rejects with the worker\'s own message');
    // The pool has no live worker left, so a later run must fail fast rather than wait for a load that cannot come.
    const second = await within5s(pool.run(spec({ games: 4 }), { chunk: 2 }).result);
    assert.ok(second instanceof Error, `a run on a dead pool settled within 5 s (got ${second})`);
  } finally { pool.dispose(); }
});

test('dispose settles the runs still in flight', async () => {
  const pool = new BatchPool(() => inlineBatchWorker(), 2);
  await pool.ready();
  const h = pool.run(spec({ games: 40 }), { chunk: 4 });
  pool.dispose();
  const r = await h.result.then(x => x, (e: Error) => e);
  assert.ok(!(r instanceof Error) ? r.games.length <= 40 : true, 'a disposed pool settles its run either way');
});

test('aggregate: per-deck stats and best-deck call', () => {
  const ref = specRef(spec({ games: 4 }));
  const mk = (index: number, seatOrder: number[], winner: number | null, firstSeat: number): GameRecordLite => ({ index, seed: index, seatOrder, winner, firstSeat, turns: 8, mulligans: [index % 2, 0], openingHand: [[], []], seen: [[], []], firstCommanderCastTurn: [null, null], lossReason: [null, null], unsimulated: 0, ms: 1 });
  const recs = [mk(0, [0, 1], 0, 0), mk(1, [1, 0], 0, 1), mk(2, [0, 1], null, 1), mk(3, [1, 0], 1, 0)];
  const a = aggregateMatches(ref, recs);
  assert.equal(a.games, 4); assert.equal(a.decided, 3); assert.equal(a.draws, 1);
  const d0 = a.byDeck[0];
  assert.equal(d0.wins, 2); assert.equal(d0.losses, 1); assert.equal(d0.draws, 1); assert.equal(d0.winRate.value, 0.625);
  assert.deepEqual(d0.seatWins, [1, 1]); assert.deepEqual(d0.seatGames, [2, 2]); assert.equal(d0.mulliganRate, 0.5);
  assert.deepEqual(d0.onThePlay, { games: 2, wins: 2 }); assert.deepEqual(d0.onTheDraw, { games: 2, wins: 0 });
  const r = assembleResult(ref, recs, 10);
  assert.equal(r.best, null, 'four games cannot separate the decks');
  const lop = Array.from({ length: 60 }, (_, i) => mk(i, i % 2 ? [1, 0] : [0, 1], 0, i % 2));
  assert.equal(assembleResult(ref, lop, 10).best, 0);
});

test('verifyRerun replays a derivation reference and reports identical', async () => {
  const s = spec({ games: 4, baseSeed: 5 });
  const r = await runMatches(s);
  const v = await verifyRerun(r.derivation.sim!, s.decks);
  assert.ok(v.identical, `successes ${v.successes} vs ${r.derivation.sim!.successes}`);
});
