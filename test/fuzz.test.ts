// The game fuzzer (Phase 8f): seeded decks are deterministic, failures bucket by signature, ddmin recovers the
// minimal failing subset, and a short in-process run is a ratchet — the number of distinct failure buckets over
// 30 two-player games and 10 four-player games at seed 1 may go down but never up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketId, ddmin, buildDecks, signatureOf, topFrames, type FuzzOptions } from '../src/verify/fuzz.js';
import { candidates, deckList, makeDeck, parseDeckList, poolIndex, withNonland } from '../src/verify/fuzzDecks.js';
import { inlineFuzzWorker, runFuzz, type FromFuzzWorker, type FuzzWorkerLike } from '../src/verify/fuzzWorker.js';
import { db } from './helpers.js';

/**
 * The ratchet: distinct buckets the short run may produce. It is 0 today — the engine survives 40 seeded games at
 * seed 1 unscathed. A failure here is a finding to record and shrink (`npm run fuzz -- --repro <bucketId>`), not a
 * number to bump; only a fix may lower it.
 */
const RATCHET = { two: 0, four: 0 };

test('ddmin: the minimal failing subset of a synthetic predicate is recovered', async () => {
  const items = Array.from({ length: 16 }, (_, i) => i + 1);
  let calls = 0;
  // monotone predicate: any subset containing both 3 and 11 fails, so the 1-minimal subset is exactly [3, 11]
  const { minimal, runs, capped } = await ddmin(items, async sub => { calls++; return sub.includes(3) && sub.includes(11); });
  assert.deepEqual(minimal, [3, 11]);
  assert.equal(capped, false);
  assert.equal(runs, calls);
  assert.ok(runs < items.length * 4, `ddmin used ${runs} runs`);
});

test('ddmin: duplicates are reduced by position, not by value (a deck holds four of a card)', async () => {
  const items = ['a', 'a', 'a', 'b', 'c', 'a'];
  const { minimal } = await ddmin(items, async sub => sub.filter(x => x === 'a').length >= 2);
  assert.deepEqual(minimal, ['a', 'a'], 'two copies are needed and two copies are what is left');
});

test('ddmin: an unshrinkable input comes back whole, and the run cap is honoured', async () => {
  const items = Array.from({ length: 8 }, (_, i) => i);
  const whole = await ddmin(items, async sub => sub.length === items.length);
  assert.deepEqual(whole.minimal, items, 'only the full set fails, so nothing can be removed');
  const capped = await ddmin(items, async sub => sub.includes(0) && sub.includes(7), 2);
  assert.equal(capped.capped, true);
  assert.equal(capped.runs, 2, 'the cap stops the search rather than the search stopping itself');
});

test('failures bucket by signature: digits move between games, the bug does not', () => {
  const a = signatureOf('object 417 in two zones', ['game.ts:Game.moveTo']);
  const b = signatureOf('object 12 in two zones', ['game.ts:Game.moveTo']);
  assert.equal(a, b);
  assert.equal(bucketId(a), bucketId(b));
  assert.notEqual(bucketId(a), bucketId(signatureOf('object # in two zones', ['game.ts:Game.draw'])), 'the frames are part of the key');
  assert.match(bucketId(a), /^[0-9a-f]{8}$/);
});

test('topFrames: the top three project frames as file:function, node internals dropped', () => {
  const err = new Error('boom');
  err.stack = [
    'Error: boom',
    '    at Object.<anonymous> (node:internal/process/task_queues:95:5)',
    '    at Game.performAction (C:\\repo\\src\\engine\\game.ts:400:15)',
    '    at async RolloutAgent.priority (/repo/src/analysis/rolloutAgent.ts:60:3)',
    '    at /repo/src/engine/legal.ts:12:9',
    '    at Game.play (C:\\repo\\src\\engine\\game.ts:221:7)',
  ].join('\n');
  assert.deepEqual(topFrames(err), ['game.ts:Game.performAction', 'rolloutAgent.ts:RolloutAgent.priority', 'legal.ts']);
  assert.deepEqual(topFrames(undefined), [], 'a non-Error rejection still buckets, on its message alone');
});

test('deck generation is a pure function of (seed, game, seat) and builds a legal 60-card deck', () => {
  const idx = poolIndex(db, 'paper');
  const one = makeDeck(db, idx, 12345, { format: 'freeform', pool: 'parsed' });
  const two = makeDeck(db, idx, 12345, { format: 'freeform', pool: 'parsed' });
  assert.deepEqual(deckList(two.cards), deckList(one.cards), 'the same seed builds the same deck');
  assert.equal(one.cards.length, 60);
  assert.equal(one.nonland.length, 36);
  assert.equal(one.basics.length, 24);
  assert.ok(one.colors.length === 1 || one.colors.length === 2, `mono or two colours, got ${one.colors.join('')}`);
  const mask = one.colors.reduce((m, c) => m | (1 << ['W', 'U', 'B', 'R', 'G'].indexOf(c)), 0);
  for (const d of one.nonland) {
    assert.ok(d.fullyParsed, `${d.name} is only partly parsed but --pool parsed asked for whole cards`);
    assert.ok(!d.types.includes('Land'), `${d.name} is a land; lands come from the basics`);
    const ci = d.colorIdentity.reduce((m, c) => m | (1 << ['W', 'U', 'B', 'R', 'G'].indexOf(c)), 0);
    assert.equal(ci & ~mask, 0, `${d.name} (${d.colorIdentity.join('')}) does not fit ${one.colors.join('')}`);
  }
  const counts = new Map<string, number>();
  for (const d of one.nonland) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 4, 'at most four copies of a card');
  assert.notDeepEqual(deckList(makeDeck(db, idx, 999, { format: 'freeform', pool: 'parsed' }).cards), deckList(one.cards));
});

test('a Commander deck is a singleton 99 behind a legendary creature inside its colour identity', () => {
  const idx = poolIndex(db, 'paper');
  const d = makeDeck(db, idx, 4242, { format: 'commander', pool: 'parsed' });
  assert.ok(d.commander, 'a commander was chosen');
  assert.ok(d.commander!.supertypes.includes('Legendary') && d.commander!.types.includes('Creature'));
  assert.equal(d.nonland.length, 63);
  assert.equal(d.basics.length, 36);
  assert.equal(d.cards.length, 99);
  assert.equal(new Set(d.nonland.map(x => x.name)).size, 63, 'singleton');
  assert.deepEqual(d.colors, d.commander!.colorIdentity.filter(c => d.colors.includes(c)), 'the basics follow the commander');
});

test('withNonland keeps the library size by paying for removed cards in basics', () => {
  const idx = poolIndex(db, 'paper');
  const deck = makeDeck(db, idx, 7, { format: 'freeform', pool: 'parsed' });
  const shrunk = withNonland(db, deck, deck.nonland.slice(0, 3));
  assert.equal(shrunk.cards.length, deck.cards.length);
  assert.equal(shrunk.nonland.length, 3);
  assert.equal(shrunk.basics.length, 24 + 33);
  assert.deepEqual(deckList(parseDeckList(db, deckList(shrunk.cards))), deckList(shrunk.cards), 'the report format round-trips');
});

test('--pool all reaches cards the parser only partly understood', () => {
  const idx = poolIndex(db, 'paper');
  const parsed = candidates(idx, 31, 'parsed');
  const all = candidates(idx, 31, 'all');
  assert.ok(parsed.length > 5000, `${parsed.length} fully parsed cards`);
  assert.ok(all.length > parsed.length, `${all.length} cards in the whole pool`);
  assert.ok(all.some(e => !e.parsed));
  assert.ok(parsed.every(e => e.parsed));
});

test('buildDecks seats one deck per seat and every seat gets its own', () => {
  const opts: FuzzOptions = { seed: 1, seats: 4, format: 'freeform', pool: 'parsed', tier: 'paper' };
  const decks = buildDecks(db, opts, 3);
  assert.equal(decks.length, 4);
  const lists = decks.map(d => deckList(d.cards).join('|'));
  assert.equal(new Set(lists).size, 4, 'four seats, four different decks');
  assert.deepEqual(buildDecks(db, opts, 3).map(d => deckList(d.cards).join('|')), lists, 'and they rebuild identically');
});

test('runFuzz fails the run when a chunk errors instead of quietly playing fewer games', async () => {
  let n = 0;
  const broken: FromFuzzWorker = { type: 'error', chunkId: 0, message: 'out of memory' };
  const makeWorker = (): FuzzWorkerLike => {
    if (n++) return inlineFuzzWorker();
    const w: FuzzWorkerLike = { onmessage: null, postMessage(msg) { setTimeout(() => w.onmessage?.(msg.type === 'init' ? { type: 'ready' } : broken), 0); }, terminate() { w.onmessage = null; } };
    return w;
  };
  await assert.rejects(runFuzz({ seed: 1, seats: 2, format: 'freeform', pool: 'parsed', games: 4 }, { workers: 2, makeWorker }), /chunk 0: out of memory/);
});

test('30 two-player games at seed 1 stay inside the bucket ratchet', { timeout: 600_000 }, async () => {
  const report = await runFuzz({ seed: 1, seats: 2, format: 'freeform', pool: 'parsed', tier: 'paper', games: 30, at: '2026-01-01T00:00:00.000Z' }, { workers: 2, inline: true });
  assert.deepEqual({ seed: report.seed, games: report.games, seats: report.seats, format: report.format, pool: report.pool, at: report.at }, { seed: 1, games: 30, seats: 2, format: 'freeform', pool: 'parsed', at: '2026-01-01T00:00:00.000Z' });
  assert.ok(report.buckets.length <= RATCHET.two, describe(report.buckets, RATCHET.two));
  assert.deepEqual([...report.buckets].sort((a, b) => (a.signature < b.signature ? -1 : 1)), report.buckets, 'buckets come back sorted by signature');
});

test('10 four-player games at seed 1 stay inside the bucket ratchet', { timeout: 600_000 }, async () => {
  const report = await runFuzz({ seed: 1, seats: 4, format: 'freeform', pool: 'parsed', tier: 'paper', games: 10 }, { workers: 2, inline: true });
  assert.equal(report.at, undefined, 'the timestamp is passed in, never read from the clock in the worker path');
  assert.ok(report.buckets.length <= RATCHET.four, describe(report.buckets, RATCHET.four));
});

/** A ratchet failure has to say what broke and how to replay it, or the number is just a number. */
function describe(buckets: { id: string; signature: string; n: number; minimalDeck: string[] }[], ceiling: number): string {
  return [`${buckets.length} failure bucket(s), ratchet is ${ceiling}:`,
    ...buckets.map(b => `  [${b.id}] n=${b.n} ${b.signature}\n    minimal deck: ${b.minimalDeck.join(', ')}`)].join('\n');
}
