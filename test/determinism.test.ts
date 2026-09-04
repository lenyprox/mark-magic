// Determinism: a batch is a pure function of (spec, game index). The same ten games are played twice in-process and
// once through a real worker_threads pool, and all three must agree game by game on the winner and on the event
// vector (a hash of the per-type event counts) — the pool splits games into chunks across threads, so an ordering or
// shared-state bug shows up as a differing vector. The second test pins the entropy: nothing under src/ may call
// Math.random(); every random number comes from the seeded Rng in the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDeckList } from '../src/cards/db.js';
import { buildDeckPayload } from '../src/play/payload.js';
import { runMatches } from '../src/sim/batch.js';
import { BatchPool } from '../src/sim/batchPool.js';
import { fingerprint } from '../src/sim/golden.js';
import { nodeBatchWorker } from '../src/sim/nodeWorker.js';
import type { MatchSpec } from '../src/sim/types.js';
import { db } from './helpers.js';

const payload = (file: string) => buildDeckPayload(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'), file), { name: file });
const spec = (): MatchSpec => ({ id: 'determinism', decks: [payload('mono-red-burn'), payload('mono-green-stompy')], games: 10, baseSeed: 5, seating: 'rotate', agent: 'rollout', format: 'freeform', maxTurns: 30, mulligans: 'lands', record: 'events' });
const vectors = (games: { index: number; winner: number | null; eventVector: string }[]) => games.map(g => `${g.index}:${g.winner}:${g.eventVector}`);

test('the same ten games replay identically in-process and through the node worker pool', async () => {
  const a = await runMatches(spec(), { yieldEvery: 1000 });
  const b = await runMatches(spec(), { yieldEvery: 1000 });
  const inProcess = vectors(a.games.map(fingerprint));
  assert.equal(inProcess.length, 10);
  assert.deepEqual(vectors(b.games.map(fingerprint)), inProcess, 'two in-process runs of the same spec');
  assert.ok(a.games.every(g => g.eventCounts && Object.keys(g.eventCounts).length > 3), 'every game recorded an event vector');

  const pool = new BatchPool(nodeBatchWorker, 2);
  await pool.ready();
  try {
    const r = await pool.run(spec(), { chunk: 3 }).result;
    assert.deepEqual(vectors(r.games.map(fingerprint)), inProcess, 'a chunked worker_threads run of the same spec');
    assert.deepEqual(r.games.map(g => g.index), a.games.map(g => g.index), 'the pool returns the games in index order');
  } finally { pool.dispose(); }
});

// Only the seeded Rng may produce randomness. Files listed here are grandfathered exceptions: the list may shrink,
// never grow, and a stale entry (one that no longer calls Math.random) fails the test so it gets deleted.
const RNG_MODULE = path.join('src', 'engine', 'game.ts');
const ALLOWLIST: string[] = [];

test('Math.random is confined to the engine RNG module', () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
      if (fs.readFileSync(f, 'utf8').includes('Math.random(')) hits.push(f);
    }
  };
  walk('src');
  const stray = hits.filter(f => f !== RNG_MODULE && !ALLOWLIST.includes(f));
  assert.deepEqual(stray, [], `route these through the seeded Rng (src/engine/game.ts) or add them to ALLOWLIST: ${stray.join(', ')}`);
  const stale = ALLOWLIST.filter(f => !hits.includes(f));
  assert.deepEqual(stale, [], `allowlist entries that no longer call Math.random — delete them: ${stale.join(', ')}`);
  assert.ok(fs.readFileSync(RNG_MODULE, 'utf8').includes('class Rng'), 'the seeded RNG still lives in src/engine/game.ts');
});
