// The scenario DSL's own guard rails. A JSON corpus authored blind is unvalidated data, so the three things that
// would let a scenario be green while testing nothing are pinned here: an unknown key must be rejected (not skipped)
// at every layer, a `noLog` must really fail when the line it names is printed, and combat must ask the *defending*
// seat for its blocks. The vocabulary itself is exercised by test/scenarios/dsl-extras.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_DB } from '../src/config/paths.js';
import { attackWith, buildScenario, checkExpectations, runScenario, runScript, scenarioShape, validateScenario, type Expectation, type Scenario, type ScriptStep } from '../src/verify/scenarioDsl.js';
import { oracleIdOf, ownerDeckOracleIds, sampleScenarioFiles } from '../src/verify/scenarioFiles.js';

const hasDb = fs.existsSync(MASTER_DB());
/** A scenario that works: Bolt to the face. Each test breaks one thing about it. */
const bolt = (over: Partial<Scenario> = {}): Scenario => ({
  name: 'Lightning Bolt deals 3 damage to a player', cr: '120.3',
  seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}],
  script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
  expect: [{ life: [1, 17] }, { life: [0, 20] }],
  ...over,
});
/** A deliberately malformed member, the way a JSON file (which TypeScript never sees) can hand one to the loader. */
const bad = <T>(v: unknown): T => v as T;
const fakeCorpus = (n: number): string[] => Array.from({ length: n }, (_, i) => path.join('data', 'scenarios', 'xx', `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000.json`));

test('the well-formed scenario the other tests break still validates and passes', { skip: !hasDb }, async () => {
  assert.deepEqual(validateScenario(bolt(), { card: 'Lightning Bolt' }), []);
  const run = await runScenario(bolt());
  assert.deepEqual(run.failures, []);
});

test('a misspelled script step is rejected, never silently skipped', async () => {
  const sc = bolt({ script: [bad<ScriptStep>({ casts: 'Lightning Bolt', targets: [['P1']] }), bad<ScriptStep>({ resolv: true })] });
  const problems = validateScenario(sc, { card: 'Lightning Bolt' });
  assert.ok(problems.some(p => p.includes('script[0]') && p.includes('casts')), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('script[1]') && p.includes('resolv')), problems.join('\n'));
  await assert.rejects(() => runScenario(sc), /malformed/);
});

test('a misspelled expectation is rejected, never silently unchecked', async () => {
  const sc = bolt({ expect: [bad<Expectation>({ lifee: [1, 17] }), bad<Expectation>({ zonee: ['Lightning Bolt', 'graveyard'] })] });
  const problems = validateScenario(sc, { card: 'Lightning Bolt' });
  assert.ok(problems.some(p => p.includes('expect[0]') && p.includes('lifee')), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('expect[1]') && p.includes('zonee')), problems.join('\n'));
  await assert.rejects(() => runScenario(sc), /malformed/);
});

test('a typo beside a good key, a bad value and an unknown seat or top-level field are all rejected', () => {
  const of = (over: Partial<Scenario>) => scenarioShape(bolt(over)).join('\n');
  assert.match(of({ script: [bad<ScriptStep>({ cast: 'Lightning Bolt', target: [['P1']] })] }), /unknown key "target" on a cast step/);
  assert.match(of({ expect: [bad<Expectation>({ life: [1, 17], noLogg: 'x' })] }), /unknown key "noLogg" next to life/);
  assert.match(of({ expect: [bad<Expectation>({ life: 17 })] }), /life has a bad value/);
  assert.match(of({ expect: [bad<Expectation>({ zone: ['Lightning Bolt', 'graveyrd'] })] }), /zone has a bad value/);
  assert.match(of({ seats: [bad<Scenario['seats'][number]>({ bff: ['Mountain'] })] }), /seats\[0\]: unknown key "bff"/);
  assert.match(of(bad<Partial<Scenario>>({ expects: [] })), /unknown key "expects"/);
  assert.match(of({ script: [bad<ScriptStep>({ passUntil: 'endd' })] }), /passUntil has a bad value/);
  assert.deepEqual(scenarioShape(bolt()), [], 'the good scenario has no shape problems');
});

test('the runner layers refuse an unknown step and an unknown expectation on their own', { skip: !hasDb }, async () => {
  const g = buildScenario(bolt());
  await assert.rejects(() => runScript(g, [bad<ScriptStep>({ resolv: true })]), /unknown script step/);
  const fails = checkExpectations(g, bolt({ expect: [bad<Expectation>({ lifee: [1, 17] })] }));
  assert.equal(fails.length, 1, fails.join('\n'));
  assert.match(fails[0], /unknown expectation/);
});

// ---------------------------------------------------------------- noLog is a real assertion
const atHillGiant = (spell: string, expect: Expectation[]): Scenario => ({
  name: `${spell} at a Hill Giant`, cr: '704.5g',
  seats: [{ bf: ['Mountain'], hand: [spell] }, { bf: ['Hill Giant'] }],
  script: [{ cast: spell, targets: [['Hill Giant']] }, { resolve: true }],
  expect,
});

test('noLog fails when the creature it names really is destroyed', { skip: !hasDb }, async () => {
  const run = await runScenario(atHillGiant('Lightning Bolt', [{ noLog: 'Hill Giant is destroyed' }]));
  assert.equal(run.failures.length, 1, run.game.state.log.join('\n'));
  assert.match(run.failures[0], /no log line matches/);
  assert.ok(run.game.state.log.some(l => /Hill Giant#\d+ is destroyed\./.test(l)), run.game.state.log.join('\n'));
});

test('the same pattern as a positive log expectation matches that line', { skip: !hasDb }, async () => {
  const run = await runScenario(atHillGiant('Lightning Bolt', [{ log: 'Hill Giant is destroyed' }, { log: 'Hill Giant#\\d+ is destroyed' }, { zone: ['Hill Giant', 'graveyard'] }]));
  assert.deepEqual(run.failures, []);
});

test('noLog passes when the creature survives', { skip: !hasDb }, async () => {
  const run = await runScenario(atHillGiant('Shock', [{ noLog: 'Hill Giant is destroyed' }, { zone: ['Hill Giant', 'battlefield'] }]));
  assert.deepEqual(run.failures, []);
});

// ---------------------------------------------------------------- combat asks the defending seat
test('blocks are declared by the seat being attacked, not by seat 0', { skip: !hasDb }, async () => {
  const sc: Scenario = {
    name: 'three-player block', cr: '509.1a',
    seats: [{ bf: ['Hill Giant'] }, { bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    active: 1,
    script: [attackWith(['Grizzly Bears'], [['Hill Giant', 'Grizzly Bears']])],
    expect: [{ life: [0, 20] }, { life: [2, 20] }, { zoneCount: [1, 'graveyard', 1] }],
  };
  const run = await runScenario(sc);
  assert.deepEqual(run.failures, [], run.game.state.log.join('\n'));
  const s = run.game.state;
  assert.equal(s.players[0].battlefield[0].damage, 0, 'the bystander seat kept its creature out of combat');
  assert.equal(s.players[2].battlefield[0].damage, 2, 'the defending seat blocked and took the damage');
});

test('a blocker that the defending seat does not have is an error, not a silent miss', { skip: !hasDb }, async () => {
  const sc: Scenario = {
    name: 'no such blocker', cr: '509.1a',
    seats: [{ bf: ['Hill Giant'] }, { bf: ['Grizzly Bears'] }, {}],
    active: 1,
    script: [attackWith(['Grizzly Bears'], [['Hill Giant', 'Grizzly Bears']])],
    expect: [{ life: [2, 18] }],
  };
  await assert.rejects(() => runScenario(sc), /no blocker named Hill Giant/);
});

// ---------------------------------------------------------------- the npm-test sample
test('the corpus sample is a seeded draw over the whole corpus, not a lexicographic prefix', () => {
  const files = fakeCorpus(1000);
  const picked = sampleScenarioFiles(files, { seeded: 200 });
  assert.equal(picked.length, 200);
  assert.deepEqual(picked, sampleScenarioFiles(files, { seeded: 200 }), 'same corpus and seed, same files');
  assert.notDeepEqual(picked, files.slice(0, 200), 'not the alphabetically first 200');
  const late = picked.filter(f => f > files[499]).length;
  assert.ok(late > 50, `the draw reaches the back half of the corpus (${late} of 200)`);
  assert.notDeepEqual(sampleScenarioFiles(files, { seeded: 200, seed: 1 }), picked, 'a different seed rotates the sample');
});

test("every owner's-deck card is in the sample whatever the draw", () => {
  const files = fakeCorpus(1000);
  const must = [files[999], files[900]].map(oracleIdOf);
  const picked = sampleScenarioFiles(files, { seeded: 200, must });
  assert.equal(picked.length, 202);
  for (const id of must) assert.ok(picked.some(f => oracleIdOf(f) === id), `${id} is in the sample`);
  assert.deepEqual(sampleScenarioFiles(files, { seeded: 0, must }).map(oracleIdOf), [...must].sort(), 'the owner cards alone when nothing else is drawn');
  assert.deepEqual(sampleScenarioFiles(files.slice(0, 10), { seeded: 200 }), files.slice(0, 10), 'a small corpus runs whole');
});

test('the owner deck lookup never creates or migrates a database', () => {
  const missing = path.join('data', 'no-such-user.db');
  assert.deepEqual(ownerDeckOracleIds(missing), []);
  assert.equal(fs.existsSync(missing), false);
  for (const id of ownerDeckOracleIds()) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
