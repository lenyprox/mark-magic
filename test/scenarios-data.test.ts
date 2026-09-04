// The JSON scenario corpus (data/scenarios/**.json) inside `npm test`. The corpus is meant to grow to thousands of
// cards, so this file runs a deterministic sample in-process — every file while there are few, otherwise the first
// 200 by sorted oracle id — and leaves the full sharded run to `npm run verify:scenarios`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_DB } from '../src/config/paths.js';
import { runScenario } from '../src/verify/scenarioDsl.js';
import { listScenarioFiles, readScenarioFile, shardPathFor, type LoadedScenarioFile } from '../src/verify/scenarioFiles.js';

/** Sample rule: all files up to this many, else the first SAMPLE by sorted oracle id (listScenarioFiles is sorted). */
const ALL_UP_TO = 300, SAMPLE = 200;

const hasDb = fs.existsSync(MASTER_DB());
const all = listScenarioFiles();
const picked = all.length <= ALL_UP_TO ? all : all.slice(0, SAMPLE);

// Reading validates; a broken file is reported by the first test rather than crashing the whole test file.
const loaded: LoadedScenarioFile[] = []; const badFiles: string[] = [];
for (const f of picked) { try { loaded.push(readScenarioFile(f)); } catch (e) { badFiles.push((e as Error).message); } }

test('every sampled scenario file parses and validates', () => {
  assert.deepEqual(badFiles, []);
  assert.equal(loaded.length, picked.length);
  for (const f of loaded) assert.equal(path.resolve(f.path), path.resolve(shardPathFor(f.oracleId, path.resolve(f.path, '..', '..'))), `${f.name} is in the right shard`);
});

test('the corpus sample is deterministic', () => {
  const ids = loaded.map(f => f.oracleId);
  assert.deepEqual(ids, [...ids].sort(), 'files are visited in oracle id order');
  assert.ok(picked.length === all.length || picked.length === SAMPLE, `sample is all ${all.length} files or the first ${SAMPLE}`);
});

for (const file of loaded) for (const sc of file.scenarios) {
  test(`[${file.name}] ${sc.name}${sc.cr ? ` (CR ${sc.cr})` : ''}`, { skip: !hasDb }, async () => {
    const run = await runScenario(sc);
    assert.deepEqual(run.failures, [], `${file.name}: ${sc.name}\n${run.game.state.log.join('\n')}`);
  });
}
