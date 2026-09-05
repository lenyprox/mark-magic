// Runs every TypeScript scenario suite under test/scenarios/ (see dsl.ts and ./scenarios/README.md).
// `npm run test:scenarios` runs only this file; `npm run verify:scenarios` runs these suites *and* the JSON corpus
// under data/scenarios/ across worker threads (scripts/verify-scenarios.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MASTER_DB } from '../src/config/paths.js';
import { basics } from './scenarios/basics.js';
import { mechanics } from './scenarios/mechanics.js';
import { owned } from './scenarios/owned.js';
import { owned2 } from './scenarios/owned2.js';
import { owned3 } from './scenarios/owned3.js';
import { keywords } from './scenarios/keywords.js';
import { foreach } from './scenarios/foreach.js';
import { dslExtras } from './scenarios/dsl-extras.js';
import { runScenario, type Scenario } from './scenarios/dsl.js';

const hasDb = fs.existsSync(MASTER_DB());
const suites: { file: string; scenarios: Scenario[] }[] = [{ file: 'basics', scenarios: basics }, { file: 'mechanics', scenarios: mechanics }, { file: 'owned', scenarios: owned }, { file: 'owned2', scenarios: owned2 }, { file: 'owned3', scenarios: owned3 }, { file: 'keywords', scenarios: keywords }, { file: 'for-each', scenarios: foreach }, { file: 'dsl-extras', scenarios: dslExtras }];

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
