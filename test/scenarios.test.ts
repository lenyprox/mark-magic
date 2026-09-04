// Runs every scenario file under test/scenarios/ (see dsl.ts). `npm run verify:scenarios` runs only this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { basics } from './scenarios/basics.js';
import { mechanics } from './scenarios/mechanics.js';
import { owned } from './scenarios/owned.js';
import { owned2 } from './scenarios/owned2.js';
import { owned3 } from './scenarios/owned3.js';
import { runScenario, type Scenario } from './scenarios/dsl.js';

const hasDb = fs.existsSync('data/master/master.db');
const suites: { file: string; scenarios: Scenario[] }[] = [{ file: 'basics', scenarios: basics }, { file: 'mechanics', scenarios: mechanics }, { file: 'owned', scenarios: owned }, { file: 'owned2', scenarios: owned2 }, { file: 'owned3', scenarios: owned3 }];

for (const suite of suites) for (const sc of suite.scenarios) {
  test(`[${suite.file}] ${sc.name}${sc.cr ? ` (CR ${sc.cr})` : ''}`, { skip: !hasDb }, async () => {
    const run = await runScenario(sc);
    assert.deepEqual(run.failures, [], `${sc.name}\n${run.game.state.log.join('\n')}`);
  });
}

test('scenario inventory is exported for the dashboard', () => {
  const all = suites.flatMap(s => s.scenarios);
  assert.ok(all.length >= 10);
  assert.ok(all.every(s => s.name && s.script.length && s.expect.length));
  const cited = new Set(all.map(s => s.cr).filter(Boolean));
  assert.ok(cited.size >= 6, 'scenarios cite distinct rules');
});
