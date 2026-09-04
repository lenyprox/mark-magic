// The scenario DSL's own guard rails. A JSON corpus authored blind is unvalidated data, so the three things that
// would let a scenario be green while testing nothing are pinned here: an unknown key must be rejected (not skipped)
// at every layer, a `noLog` must really fail when the line it names is printed, and combat must ask the *defending*
// seat for its blocks. The vocabulary itself is exercised by test/scenarios/dsl-extras.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MASTER_DB, projectRoot } from '../src/config/paths.js';
import { STEPS } from '../src/engine/state.js';
import { attackWith, buildScenario, checkExpectations, EXPECTATION_KEYS, PASS_STEPS, runScenario, runScript, scenarioShape, SCRIPT_STEP_KEYS, seatSetupProblems, validateScenario, type Expectation, type Scenario, type ScriptStep } from '../src/verify/scenarioDsl.js';
import { changed, oracleIdOf, ownerDeckOracleIds, sampleScenarioFiles } from '../src/verify/scenarioFiles.js';

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

// ---------------------------------------------------------------- seat setup names are strict
/** A seat setup that names something the game will not contain seeds nothing; both layers must say so. */
const seatsOf = (seat: Scenario['seats'][number]): Scenario => bolt({ seats: [seat, {}] });

test('a seat zone that names a card which does not exist is rejected before any step runs', { skip: !hasDb }, () => {
  for (const [field, seat] of [
    ['hand', { bf: ['Mountain'], hand: ['Lightning Bolt', 'Lightning Bolt Deluxe'] }],
    ['bf', { bf: ['Mountain', 'Mt Doom'], hand: ['Lightning Bolt'] }],
    ['libraryTop', { bf: ['Mountain'], hand: ['Lightning Bolt'], libraryTop: ['Nonesuch Card'] }],
    ['command', { bf: ['Mountain'], hand: ['Lightning Bolt'], command: ['Nonesuch Commander'] }],
    ['graveyard', { bf: ['Mountain'], hand: ['Lightning Bolt'], graveyard: ['Nonesuch Corpse'] }],
  ] as [string, Scenario['seats'][number]][]) {
    const sc = seatsOf(seat);
    const re = new RegExp(`scenario: seats\\[0\\]\\.${field} names [^ ]+.* but there is no card of that name`);
    assert.ok(validateScenario(sc, { card: 'Lightning Bolt' }).some(p => re.test(p)), `${field}: ${validateScenario(sc).join('\n')}`);
    assert.throws(() => buildScenario(sc), re, field);
  }
});

test('counters and tapped must name a permanent that seat really puts on the battlefield', { skip: !hasDb }, () => {
  const strays = seatsOf({ bf: ['Mountain'], hand: ['Lightning Bolt'], counters: { 'Grizzly Bears': { '+1/+1': 1 } } });
  assert.ok(validateScenario(strays).some(p => /seats\[0\]\.counters names Grizzly Bears but that seat's battlefield is \[Mountain\]/.test(p)), validateScenario(strays).join('\n'));
  assert.throws(() => buildScenario(strays), /seats\[0\]\.counters names Grizzly Bears/);

  const ghost = seatsOf({ bf: ['Mountain'], hand: ['Lightning Bolt'], tapped: ['Grizzly Bears'] });
  assert.ok(validateScenario(ghost).some(p => /seats\[0\]\.tapped names Grizzly Bears but that seat's battlefield is \[Mountain\]/.test(p)), validateScenario(ghost).join('\n'));
  assert.throws(() => buildScenario(ghost), /seats\[0\]\.tapped names Grizzly Bears/);

  const twice = seatsOf({ bf: ['Mountain'], hand: ['Lightning Bolt'], tapped: ['Mountain', 'Mountain'] });
  assert.ok(validateScenario(twice).some(p => /every copy of it is already tapped/.test(p)), validateScenario(twice).join('\n'));
  assert.throws(() => buildScenario(twice), /seats\[0\]\.tapped names Mountain/);

  // …and the well-formed version of each still builds the board it describes.
  const good = seatsOf({ bf: ['Mountain', 'Grizzly Bears'], hand: ['Lightning Bolt'], tapped: ['Mountain'], counters: { 'Grizzly Bears': { '+1/+1': 2 } } });
  assert.deepEqual(seatSetupProblems(good), []);
  const g = buildScenario(good);
  assert.equal(g.state.players[0].battlefield.find(o => o.def.name === 'Mountain')!.tapped, true);
  assert.equal(g.state.players[0].battlefield.find(o => o.def.name === 'Grizzly Bears')!.counters['+1/+1'], 2);
});

test('a seat on the other side is named in its own message', { skip: !hasDb }, () => {
  const sc = bolt({ seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'], tapped: ['Hill Giant'] }] });
  assert.throws(() => buildScenario(sc), /seats\[1\]\.tapped names Hill Giant/);
});

// ---------------------------------------------------------------- passUntil really stops at the step
const board = (): Scenario => ({
  name: 'a board to pass on', cr: '500.1',
  seats: [{ bf: ['Mountain', 'Grizzly Bears'] }, { bf: ['Hill Giant'] }],
  script: [], expect: [],
});

test('passUntil stops in the named step of this turn, with priority on the active player', { skip: !hasDb }, async () => {
  for (const step of ['combat-begin', 'declare-attackers', 'main2', 'end', 'cleanup'] as const) {
    const g = buildScenario(board());
    await runScript(g, [{ passUntil: step }]);
    assert.equal(g.state.step, step, `stopped in ${g.state.step} instead of ${step}`);
    assert.equal(g.state.turn, 5, `${step} is in this turn`);
    assert.equal(g.state.priority, g.state.activePlayer, `${step} leaves priority with the active player`);
  }
});

test('passUntil a step that is not still ahead runs the next turn, turn-based actions and all', { skip: !hasDb }, async () => {
  const g = buildScenario(board());
  await runScript(g, [{ passUntil: 'main1' }]);
  assert.equal(g.state.turn, 6);
  assert.equal(g.state.step, 'main1');
  assert.equal(g.state.activePlayer, 1, 'the next turn belongs to the next seat');
  assert.equal(g.state.players[1].hand.length, 1, 'the draw step really ran');
  assert.equal(g.state.players[1].battlefield[0].tapped, false);
});

test('passUntil throws instead of stopping somewhere the scenario did not ask for', { skip: !hasDb }, async () => {
  const g = buildScenario({ ...board(), seats: [{ bf: ['Mountain'] }, {}] });
  await assert.rejects(() => runScript(g, [{ passUntil: 'declare-blockers' }]), /passUntil declare-blockers stopped in combat-end/);
});

test('untap is not a passUntil target — no player ever holds priority in it', () => {
  assert.match(scenarioShape(bolt({ script: [{ passUntil: 'untap' } as ScriptStep] })).join('\n'), /passUntil has a bad value "untap"/);
  assert.deepEqual(scenarioShape(bolt({ script: [{ passUntil: 'end' }] })), []);
});

// ---------------------------------------------------------------- a declared block must be accepted
const angel = (over: Partial<Scenario> = {}): Scenario => ({
  name: 'Serra Angel flies over the Bears', cr: '509.1b',
  seats: [{ bf: ['Serra Angel'] }, { bf: ['Grizzly Bears'] }],
  script: [attackWith(['Serra Angel'], [['Grizzly Bears', 'Serra Angel']])],
  expect: [{ life: [1, 16] }],
  ...over,
});

test('a block the engine refuses is an error, never a silently unblocked attack', { skip: !hasDb }, async () => {
  await assert.rejects(() => runScenario(angel()), /block Grizzly Bears .* Serra Angel was not accepted by the engine \(Serra Angel has flying; Grizzly Bears has neither flying nor reach\)/);
});

test('the same pair listed as refused passes, and a legal pair listed as refused fails', { skip: !hasDb }, async () => {
  const ok = await runScenario(angel({ script: [attackWith(['Serra Angel'], [], [['Grizzly Bears', 'Serra Angel']])] }));
  assert.deepEqual(ok.failures, [], ok.game.state.log.join('\n'));
  const wrong = angel({
    name: 'a ground attacker can be blocked', seats: [{ bf: ['Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    script: [attackWith(['Hill Giant'], [], [['Grizzly Bears', 'Hill Giant']])], expect: [{ life: [1, 20] }],
  });
  await assert.rejects(() => runScenario(wrong), /was listed as refused but the engine accepted it/);
});

test('a block that is accepted still runs the blocked path', { skip: !hasDb }, async () => {
  const run = await runScenario(angel({
    name: 'Hill Giant is blocked by the Bears', seats: [{ bf: ['Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    script: [attackWith(['Hill Giant'], [['Grizzly Bears', 'Hill Giant']])],
    expect: [{ life: [1, 20] }, { zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }],
  }));
  assert.deepEqual(run.failures, [], run.game.state.log.join('\n'));
});

// ---------------------------------------------------------------- the expectations that name one object
test('attachedTo fails when the aura is somewhere else', { skip: !hasDb }, async () => {
  const rancor = (expect: Expectation[]): Scenario => ({
    name: 'Rancor enchants the Bears', cr: '303.4',
    seats: [{ bf: ['Forest', 'Grizzly Bears'], hand: ['Rancor'] }, {}],
    script: [{ cast: 'Rancor', targets: [['Grizzly Bears']] }, { resolve: true }], expect,
  });
  assert.deepEqual((await runScenario(rancor([{ attachedTo: ['Rancor', 'Grizzly Bears'] }]))).failures, []);
  const bad = await runScenario(rancor([{ attachedTo: ['Rancor', null] }]));
  assert.equal(bad.failures.length, 1, bad.failures.join('\n'));
  assert.match(bad.failures[0], /Rancor attached to/);
});

test('faceDown fails when the permanent is face up', { skip: !hasDb }, async () => {
  const run = await runScenario({
    name: 'a face-up creature is not face down', cr: '708.2',
    seats: [{ bf: ['Grizzly Bears'] }, {}], script: [{ sba: true }],
    expect: [{ faceDown: ['Grizzly Bears', false] }, { faceDown: ['Grizzly Bears', true] }],
  });
  assert.equal(run.failures.length, 1, run.failures.join('\n'));
  assert.match(run.failures[0], /Grizzly Bears face down/);
});

test('commanderDamage fails on the wrong total, and reads the seat that took the damage', { skip: !hasDb }, async () => {
  const cmd = (expect: Expectation[]): Scenario => ({
    name: 'the commander connects', cr: '704.6c', format: 'commander',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], command: ['The Whizzer, Classic Speedster'] }, {}],
    script: [{ cast: 'The Whizzer, Classic Speedster' }, { resolve: true }, attackWith(['The Whizzer, Classic Speedster'])], expect,
  });
  assert.deepEqual((await runScenario(cmd([{ commanderDamage: [1, 'The Whizzer, Classic Speedster', 3] }]))).failures, []);
  const bad = await runScenario(cmd([{ commanderDamage: [1, 'The Whizzer, Classic Speedster', 5] }, { commanderDamage: [0, 'The Whizzer, Classic Speedster', 3] }]));
  assert.equal(bad.failures.length, 2, bad.failures.join('\n'));
  for (const f of bad.failures) assert.match(f, /commander damage from The Whizzer, Classic Speedster/);
});

test('commanderDamage names the commander that dealt it, not the victim\'s own copy of that legend', { skip: !hasDb }, async () => {
  // Seat 2 attacks seat 0, and both seats command a legend of the same name: resolving the name by a plain search
  // would find seat 0's own copy (which has dealt nobody anything) and read 0 for a seat that took three.
  const run = await runScenario({
    name: 'two seats share a commander name', cr: '704.6c', format: 'commander', active: 2,
    seats: [
      { command: ['The Whizzer, Classic Speedster'] },
      {},
      { bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], command: ['The Whizzer, Classic Speedster'] },
    ],
    script: [{ cast: 'The Whizzer, Classic Speedster' }, { resolve: true }, attackWith(['The Whizzer, Classic Speedster'])],
    expect: [{ commanderDamage: [0, 'The Whizzer, Classic Speedster', 3] }, { commanderDamage: [1, 'The Whizzer, Classic Speedster', 0] }, { life: [0, 37] }],
  });
  assert.deepEqual(run.failures, [], run.game.state.log.join('\n'));
});

// ---------------------------------------------------------------- the runner's arguments
const runner = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.join(projectRoot(), 'scripts', 'verify-scenarios.ts'), ...args], { cwd: projectRoot(), encoding: 'utf8' });

test('a count flag must be a whole number of at least one, in either spelling', { skip: !hasDb }, () => {
  for (const args of [['--workers', '0'], ['--workers=x'], ['--limit', '2.5'], ['--limit='], ['--workers']]) {
    const r = runner(args);
    assert.equal(r.status, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /must be a whole number ≥ 1|needs a value/, args.join(' '));
  }
  const unknown = runner(['--wokers=2']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument "--wokers=2"/);
});

test('an unknown --family lists the suites that exist and exits 2', { skip: !hasDb }, () => {
  const r = runner(['--family', 'mechanix']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--family: no suite named mechanix \(available: .*mechanics.*\)/);
  const ok = runner(['--family=owned3', '--workers=1', '--json', path.join(os.tmpdir(), 'verify-scenarios-argtest.json')]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /owned3/);
});

test('--changed with nothing changed is a no-op that succeeds', { skip: !hasDb || changed().length > 0 }, () => {
  const r = runner(['--changed']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no changed scenario files/);
});

// ---------------------------------------------------------------- the reference page is the vocabulary
test('the README, the shape validator and the types describe the same DSL', () => {
  const doc = fs.readFileSync(path.join(projectRoot(), 'test', 'scenarios', 'README.md'), 'utf8');
  // `block` is a keyword only so that writing one produces an explanation; the page says where blocks go instead.
  const notInTheTable = ['block'];
  const rows = [...doc.matchAll(/^\| `\{ "(\w+)"/gm)].map(m => m[1]);
  for (const k of SCRIPT_STEP_KEYS) {
    if (notInTheTable.includes(k)) continue;
    assert.ok(rows.includes(k), `README's step table documents ${k}`);
  }
  for (const k of rows) assert.ok(SCRIPT_STEP_KEYS.includes(k), `README documents a step the DSL has: ${k}`);
  assert.match(doc, /there is no separate block step/);
  assert.match(doc, /"refused"/, 'README documents blocks that must be turned down');

  for (const k of EXPECTATION_KEYS) assert.ok(new RegExp('^\\| `' + k + '` \\|', 'm').test(doc), `README documents the ${k} expectation`);

  // passUntil: the page, the guard and the type all exclude untap and nothing else.
  assert.deepEqual(PASS_STEPS, STEPS.filter(st => st !== 'untap'));
  assert.match(doc, /every step except `untap`/);
  for (const st of PASS_STEPS) assert.deepEqual(scenarioShape(bolt({ script: [{ passUntil: st }] })), [], st);
});
