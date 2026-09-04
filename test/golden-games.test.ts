// Golden event stream: the mono-red / mono-green pair replays byte-for-byte the fingerprint committed under
// test/fixtures/golden. Only that one case runs here (about half a second); the other cases — the ub/wu pair and the
// three-player pod — are checked by `npm run golden:check`, which is part of verify:deep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareGolden, fnv1a, GOLDEN_CASES, readGolden, replayGolden, turnSegments } from '../src/sim/golden.js';
import { db } from './helpers.js';

test('fnv1a and turnSegments: stable hash, one segment per turn with the pre-game as segment 0', () => {
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.notEqual(fnv1a('abc'), fnv1a('abd'));
  const log = ['A shuffles.', '\n=== Turn 1: A ===', 'A draws a card.', '\n=== Turn 2: B ===', 'B draws a card.'];
  const segs = turnSegments(log);
  assert.deepEqual(segs.map(s => s.turn), [0, 1, 2]);
  assert.deepEqual(segs.map(s => s.lines.length), [1, 2, 2]);
});

test('golden: the mono-red / mono-green pair reproduces its committed fingerprints', async () => {
  const c = GOLDEN_CASES[0];
  const fixture = readGolden(c.name);
  assert.ok(fixture, `test/fixtures/golden/${c.name}.json is missing — run npm run golden:accept`);
  assert.deepEqual(fixture.case, c, 'the fixture was recorded for a different case; run npm run golden:accept');
  const { games, logs } = await replayGolden(c, db);
  assert.equal(games.length, c.games);
  assert.ok(games.every(g => g.turnHashes.length > 1), 'every golden game logged at least one turn');
  const diffs = compareGolden(fixture.games, games, logs);
  const first = diffs[0];
  assert.equal(diffs.length, 0, first ? `game ${first.index} changed (${first.fields.join('; ')}), first differing turn ${first.turn}:\n${first.lines.join('\n')}` : '');
});
