// The JSON scenario corpus (data/scenarios/**.json) inside `npm test`. The corpus is meant to grow to thousands of
// cards, so this file runs a deterministic *sample* in-process — every file for a card in the owner's decks plus 200
// drawn with a fixed seed — and leaves the full sharded run to `npm run verify:scenarios`. A lexicographic prefix
// would pin the fast run to the alphabetically first shards forever; the seeded draw spreads it over the whole
// corpus and still gives the same files on every machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_DB } from '../src/config/paths.js';
import { runScenario } from '../src/verify/scenarioDsl.js';
import { listScenarioFiles, oracleIdOf, ownerDeckOracleIds, readScenarioFile, sampleScenarioFiles, shardPathFor, type LoadedScenarioFile } from '../src/verify/scenarioFiles.js';

/** How many files beyond the owner's decks the fast run covers. */
const SEEDED = 200;

const hasDb = fs.existsSync(MASTER_DB());
const all = listScenarioFiles();
const owner = ownerDeckOracleIds();
const picked = sampleScenarioFiles(all, { seeded: SEEDED, must: owner });

// Reading validates; a broken file is reported by the first test rather than crashing the whole test file.
const loaded: LoadedScenarioFile[] = []; const badFiles: string[] = [];
for (const f of picked) { try { loaded.push(readScenarioFile(f)); } catch (e) { badFiles.push((e as Error).message); } }

test('every sampled scenario file parses and validates', () => {
  assert.deepEqual(badFiles, []);
  assert.equal(loaded.length, picked.length);
  for (const f of loaded) assert.equal(path.resolve(f.path), path.resolve(shardPathFor(f.oracleId, path.resolve(f.path, '..', '..'))), `${f.name} is in the right shard`);
});

test('the corpus sample is deterministic and covers the owner\'s decks', () => {
  assert.deepEqual(picked, sampleScenarioFiles(all, { seeded: SEEDED, must: owner }), 'the same corpus and seed draw the same files');
  assert.deepEqual(picked, [...picked].sort((a, b) => (oracleIdOf(a) < oracleIdOf(b) ? -1 : 1)), 'files are visited in oracle id order');
  const ids = new Set(picked.map(oracleIdOf));
  const ownerFiles = all.filter(f => owner.includes(oracleIdOf(f)));
  for (const f of ownerFiles) assert.ok(ids.has(oracleIdOf(f)), `${path.basename(f)} is an owner's-deck card and must be in every sample`);
  assert.ok(picked.length === all.length || picked.length === ownerFiles.length + SEEDED, `sample is all ${all.length} files, or the owner's ${ownerFiles.length} plus ${SEEDED}`);
});

for (const file of loaded) for (const sc of file.scenarios) {
  test(`[${file.name}] ${sc.name}${sc.cr ? ` (CR ${sc.cr})` : ''}`, { skip: !hasDb }, async () => {
    const run = await runScenario(sc);
    assert.deepEqual(run.failures, [], `${file.name}: ${sc.name}\n${run.game.state.log.join('\n')}`);
  });
}
