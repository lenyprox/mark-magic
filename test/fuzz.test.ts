// The game fuzzer (Phase 8f): seeded decks are deterministic, failures bucket by signature, ddmin recovers the
// minimal failing subset, and a short in-process run is a ratchet — the number of distinct failure buckets over
// 30 two-player games and 10 four-player games at seed 1 may go down but never up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketId, ddmin, buildDecks, runGame, signatureOf, topFrames, type FuzzOptions } from '../src/verify/fuzz.js';
import { candidates, DECK_SHAPE, deckList, makeDeck, parseDeckList, poolIndex, withPicks } from '../src/verify/fuzzDecks.js';
import { inlineFuzzWorker, runFuzz, type FromFuzzWorker, type FuzzWorkerLike } from '../src/verify/fuzzWorker.js';
import { assertInvariants, InvariantError } from '../src/engine/invariants.js';
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

const MASK = (cs: readonly string[]) => cs.reduce((m, c) => m | (1 << ['W', 'U', 'B', 'R', 'G'].indexOf(c)), 0);

test('deck generation is a pure function of (seed, game, seat) and builds a legal 60-card deck', () => {
  const idx = poolIndex(db, 'paper');
  const one = makeDeck(db, idx, 12345, { format: 'freeform', pool: 'parsed' });
  const two = makeDeck(db, idx, 12345, { format: 'freeform', pool: 'parsed' });
  assert.deepEqual(deckList(two.cards), deckList(one.cards), 'the same seed builds the same deck');
  assert.equal(one.cards.length, 60);
  assert.equal(one.picks.length, DECK_SHAPE.freeform.spells + DECK_SHAPE.freeform.lands);
  assert.equal(one.basics.length, DECK_SHAPE.freeform.basics);
  assert.ok(one.colors.length === 1 || one.colors.length === 2, `mono or two colours, got ${one.colors.join('')}`);
  const mask = MASK(one.colors);
  for (const d of one.picks) {
    assert.ok(d.fullyParsed, `${d.name} is only partly parsed but --pool parsed asked for whole cards`);
    assert.ok(!d.supertypes.includes('Basic'), `${d.name} is a basic land; those come from the mana base, not the pool`);
    assert.equal(MASK(d.colorIdentity) & ~mask, 0, `${d.name} (${d.colorIdentity.join('')}) does not fit ${one.colors.join('')}`);
  }
  for (const d of one.basics) assert.ok(d.supertypes.includes('Basic'), `${d.name} is not a basic land`);
  const counts = new Map<string, number>();
  for (const d of one.picks) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 4, 'at most four copies of a card');
  assert.notDeepEqual(deckList(makeDeck(db, idx, 999, { format: 'freeform', pool: 'parsed' }).cards), deckList(one.cards));
});

test('nonbasic lands are a first-class part of the pool, not a class the fuzzer cannot reach', () => {
  const idx = poolIndex(db, 'paper');
  assert.ok(idx.lands > 500, `${idx.lands} nonbasic lands indexed`);
  const lands = candidates(idx, 31, 'parsed', 'land');
  assert.ok(lands.length > 200, `${lands.length} fully parsed nonbasic lands`);
  for (const e of lands.slice(0, 50)) {
    const def = db.getByOracleId(e.oracleId)!;
    assert.ok(def.types.includes('Land') && !def.supertypes.includes('Basic'), `${def.name} is not a nonbasic land`);
  }
  const spells = candidates(idx, 31, 'parsed');
  assert.equal(spells.filter(e => lands.some(l => l.oracleId === e.oracleId)).length, 0, 'the spell and land slices are disjoint');
  // and they actually reach the decks: every seat of a four-seat table gets its land slots filled
  const decks = buildDecks(db, { seed: 1, seats: 4, format: 'freeform', pool: 'parsed', tier: 'paper' }, 0);
  for (const d of decks) {
    const nonbasic = d.picks.filter(c => c.types.includes('Land'));
    assert.equal(nonbasic.length, DECK_SHAPE.freeform.lands, `${d.colors.join('')} deck drew ${nonbasic.length} nonbasic lands`);
  }
});

test('a Commander deck is a singleton 99 behind a legendary creature inside its colour identity', () => {
  const idx = poolIndex(db, 'paper');
  const d = makeDeck(db, idx, 4242, { format: 'commander', pool: 'parsed' });
  assert.ok(d.commander, 'a commander was chosen');
  assert.ok(d.commander!.supertypes.includes('Legendary') && d.commander!.types.includes('Creature'));
  assert.equal(d.picks.length, DECK_SHAPE.commander.spells + DECK_SHAPE.commander.lands);
  assert.equal(d.basics.length, DECK_SHAPE.commander.basics);
  assert.equal(d.cards.length, 99);
  assert.equal(new Set(d.picks.map(x => x.name)).size, d.picks.length, 'singleton');
  assert.deepEqual(d.colors, d.commander!.colorIdentity.filter(c => d.colors.includes(c)), 'the basics follow the commander');
});

test('withPicks keeps the library size by paying for removed cards in basics', () => {
  const idx = poolIndex(db, 'paper');
  const deck = makeDeck(db, idx, 7, { format: 'freeform', pool: 'parsed' });
  const shrunk = withPicks(db, deck, deck.picks.slice(0, 3));
  assert.equal(shrunk.cards.length, deck.cards.length);
  assert.equal(shrunk.picks.length, 3);
  assert.equal(shrunk.basics.length, deck.basics.length + deck.picks.length - 3);
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
  assert.ok(candidates(idx, 31, 'all', 'land').length > candidates(idx, 31, 'parsed', 'land').length, 'and the land slice too');
});

test('the pool tier is part of the table: paper and all build different decks', () => {
  const paper = buildDecks(db, { seed: 1, seats: 2, format: 'freeform', pool: 'parsed', tier: 'paper' }, 0);
  const all = buildDecks(db, { seed: 1, seats: 2, format: 'freeform', pool: 'parsed', tier: 'all' }, 0);
  assert.notDeepEqual(deckList(all[0].cards), deckList(paper[0].cards), 'a report that does not record its tier cannot be replayed');
  const dflt = buildDecks(db, { seed: 1, seats: 2, format: 'freeform', pool: 'parsed' }, 0);
  assert.deepEqual(deckList(dflt[0].cards), deckList(paper[0].cards), "the fuzzer's default tier is the paper pool it documents");
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

test('a report records every setting --repro needs to rebuild the table, resolved', async () => {
  const report = await runFuzz({ seed: 3, seats: 2, format: 'commander', pool: 'parsed', games: 0 }, { workers: 1, inline: true });
  assert.equal(report.tier, 'paper', 'the tier is written down even when the caller left it to the default');
  assert.equal(report.maxTurns, 40, 'and the turn limit, resolved from the format');
  assert.equal(report.assertInvariants, 'game');
  const pinned = await runFuzz({ seed: 3, seats: 2, format: 'freeform', pool: 'parsed', tier: 'all', maxTurns: 7, assertInvariants: 'event', games: 0 }, { workers: 1, inline: true });
  assert.deepEqual({ tier: pinned.tier, maxTurns: pinned.maxTurns, assertInvariants: pinned.assertInvariants }, { tier: 'all', maxTurns: 7, assertInvariants: 'event' });
});

test("assertInvariants 'event' checks inside the engine and pins a violation to the action, not the turn", { timeout: 600_000 }, async () => {
  // the transient form skips only the checks that need a settled board; the structural ones still hold at every instant
  const halfBlocked = { players: [{ name: 'A', life: 20, hand: [], library: [], graveyard: [], exile: [], command: [], battlefield: [
    { id: 1, def: { name: 'Attacker' }, zone: 'battlefield', counters: {}, blocking: [], blockedBy: [2], token: false, attachedTo: null },
    { id: 2, def: { name: 'Blocker' }, zone: 'battlefield', counters: {}, blocking: [], blockedBy: [], token: false, attachedTo: null },
  ] }], stack: [] } as never;
  assert.match(assertInvariants(halfBlocked) ?? '', /blockedBy but does not block it/, 'at rest a half-written block is a violation');
  assert.equal(assertInvariants(halfBlocked, { transient: true }), null, 'mid-declaration it is not');
  const err = new InvariantError('object 4 in two zones', 'zone-change');
  assert.equal(err.message, 'object 4 in two zones (after zone-change)');
  assert.equal(err.violation, 'object 4 in two zones');
  // and a real game plays clean under the strict mode (a false positive here would make the mode unusable)
  const opts: FuzzOptions = { seed: 1, seats: 2, format: 'freeform', pool: 'parsed', tier: 'paper', assertInvariants: 'event' };
  for (const i of [0, 1, 2]) {
    const out = await runGame(db, opts, i);
    assert.equal(out.failure, null, `game ${i} under 'event': ${out.failure?.message}\n  ${out.failure?.frames.join('\n  ')}`);
  }
});

test('30 two-player games at seed 1 stay inside the bucket ratchet', { timeout: 600_000 }, async () => {
  const report = await runFuzz({ seed: 1, seats: 2, format: 'freeform', pool: 'parsed', tier: 'paper', games: 30, at: '2026-01-01T00:00:00.000Z' }, { workers: 2, inline: true });
  assert.deepEqual({ seed: report.seed, games: report.games, seats: report.seats, format: report.format, pool: report.pool, tier: report.tier, at: report.at }, { seed: 1, games: 30, seats: 2, format: 'freeform', pool: 'parsed', tier: 'paper', at: '2026-01-01T00:00:00.000Z' });
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
