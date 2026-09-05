// `scripts:verify` end to end (plan 2.2): one case per stage, over hand-written fixture scripts for real cards in a
// temp directory. Nothing here touches data/scripts — verification writes a `verification` block back into every
// file it reads, and the tracked corpus must not collect one from a test run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyCards } from '../scripts/scripts-verify.js';
import { idsInBatch, batchNameOf, ROUND_TRIP_PASS, staleIds } from '../src/verify/scriptVerify.js';
import { oracleHash, ScriptStore, shardOf, type CardScript } from '../src/cards/scripts.js';
import { scoreCard } from '../src/cards/render.js';
import { probeAbilities } from '../src/verify/probes.js';
import type { Row } from '../src/verify/sandbox.js';
import { freshDir, goodFixtures, head, parsedDef, writeScript } from './scripts-verify-fixtures.js';
import { db } from './helpers.js';

const fixtures = goodFixtures(db);
/** Verify one script in a directory of its own and return its report row. */
async function verifyOne(script: CardScript, opts: Parameters<typeof verifyCards>[1] = {}) {
  const dir = freshDir();
  writeScript(dir, script);
  const report = await verifyCards([script.oracleId], { dir, cards: db, ...opts });
  return { dir, row: report.cards[0], report };
}

test('a correct hand script for a real card verifies: every stage green, the block written back', async () => {
  const { dir, row } = await verifyOne(fixtures['Lightning Bolt']);
  assert.deepEqual(row.problems, [], 'no stage should report a problem');
  assert.equal(row.status, 'verified');
  assert.equal(row.schema, 'ok');
  assert.equal(row.lint, 'ok');
  assert.equal(row.sandbox.seats2, 'ok');
  assert.equal(row.sandbox.seats4, 'ok');
  assert.ok(row.roundTrip.score >= ROUND_TRIP_PASS, `round trip ${row.roundTrip.score} should reach ${ROUND_TRIP_PASS}`);
  assert.deepEqual(row.sandbox.abilities, [{ index: 0, reached: true, how: 'cast' }]);

  // stage 7: the block is in the file, `scriptHash` covers the script WITHOUT it, and the file is still LF only
  const store = new ScriptStore(dir);
  const written = store.get(row.oracleId)!;
  assert.equal(written.verification?.status, 'verified');
  assert.equal(written.verification?.schema, 'ok');
  assert.equal(written.verification?.roundTrip.score, row.roundTrip.score);
  assert.deepEqual(written.verification?.scenarios, { file: '', passed: 0, failed: 0, names: [] }, 'the scenarios block is left for slice 8d');
  assert.equal(fs.readFileSync(store.fileOf(row.oracleId)!, 'utf8').includes('\r'), false);
  // and re-verifying the written file is a no-op: nothing is stale
  assert.deepEqual(staleIds(store), [], 'a freshly verified script is not stale');
});

test('a static and a keyword-only card verify, and the report file is written', async () => {
  const dir = freshDir();
  for (const name of ['Glorious Anthem', 'Serra Angel']) writeScript(dir, fixtures[name]);
  const ids = ['Glorious Anthem', 'Serra Angel'].map(n => fixtures[n].oracleId);
  const report = await verifyCards(ids, { dir, cards: db, batch: 'unit' });
  assert.deepEqual(report.cards.flatMap(c => c.problems), []);
  assert.deepEqual(report.cards.map(c => c.status), ['verified', 'verified']);
  assert.equal(report.summary.verified, 2);
  // Serra Angel has no abilities at all — its two lines are claimed by keywords, so the renderer scores nothing
  const angel = report.cards.find(c => c.name === 'Serra Angel')!;
  assert.equal(angel.roundTrip.score, 1, 'a card whose every line is a keyword line has nothing to render');
  assert.deepEqual(angel.sandbox.abilities, []);
  const file = path.join(dir, 'reports', 'unit.json');
  assert.ok(fs.existsSync(file), 'the batch report is written to <dir>/reports/<batch>.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.batch, 'unit');
  assert.equal(onDisk.summary.total, 2);
  assert.equal(typeof onDisk.parserVersion, 'number');
  assert.equal(typeof onDisk.registryHash, 'string');
});

test('an op-name typo fails the schema stage and stops the card there', async () => {
  const bad = structuredClone(fixtures['Lightning Bolt']) as CardScript;
  (bad.abilities![0] as { effects: { op: string }[] }).effects[0].op = 'drawww';
  const { row } = await verifyOne(bad);
  assert.equal(row.schema, 'fail');
  assert.equal(row.status, 'scripted');
  assert.ok(row.problems.some(p => p.startsWith('schema —')), row.problems.join('\n'));
  // schema stops the card: nothing downstream ran
  assert.deepEqual(row.sandbox.abilities, []);
  assert.equal(row.roundTrip.score, 0);
});

test('a stale oracleHash is reported as stale and the script is not applied', async () => {
  const stale = { ...fixtures['Lightning Bolt'], oracleHash: 'deadbeef' };
  const { row } = await verifyOne(stale);
  assert.equal(row.status, 'stale');
  assert.ok(row.problems.some(p => p.startsWith('stale:')), row.problems.join('\n'));
});

test('a content-free container-only script fails the gate: it claims nothing', async () => {
  const bolt = parsedDef(db, 'Lightning Bolt');
  const empty: CardScript = {
    ...fixtures['Lightning Bolt'],
    abilities: [{ kind: 'spell', effects: [{ op: 'bind', as: 'that', from: 'targets' }], text: bolt.oracleText.replace(bolt.name, '~') }],
  };
  const { row } = await verifyOne(empty);
  assert.equal(row.schema, 'ok', 'a `bind` is a legal effect — only the accounting rejects it');
  assert.equal(row.status, 'scripted');
  assert.ok(row.problems.some(p => p.includes('does not make the card fully simulated')), row.problems.join('\n'));
});

test("a script whose numbers differ from the oracle line scores 0 on that line and lists it in `lowest`", async () => {
  const wrong = structuredClone(fixtures['Lightning Bolt']) as CardScript;
  (wrong.abilities![0] as { effects: { amount: number }[] }).effects[0].amount = 2;
  const { row } = await verifyOne(wrong);
  assert.equal(row.schema, 'ok');
  assert.ok(row.roundTrip.score < ROUND_TRIP_PASS, `expected a failing round trip, got ${row.roundTrip.score}`);
  assert.equal(row.roundTrip.score, 0, 'a missing number is a hard zero');
  assert.deepEqual(row.roundTrip.lowest.map(l => l.text), ['~ deals 3 damage to any target.']);
  assert.match(row.roundTrip.lowest[0].rendered, /2 damage/);
  assert.equal(row.status, 'scripted');
  assert.ok(row.problems.some(p => p.startsWith('round trip')), row.problems.join('\n'));
});

test('an ability no probe can reach is a WARNING, not a failure — the card still verifies', async () => {
  const { row } = await verifyOne(fixtures['Ainok Survivalist']);
  assert.deepEqual(row.problems, [], row.problems.join('\n'));
  assert.equal(row.status, 'verified');
  assert.deepEqual(row.sandbox.abilities, [{ index: 0, reached: false }]);
  assert.ok(row.warnings.some(w => w.includes('was never reached')), row.warnings.join('\n'));
});

test('a two-effect trigger on one line verifies and its trigger is reached by a probe', async () => {
  const { row } = await verifyOne(fixtures['Blood Artist']);
  assert.deepEqual(row.problems, [], row.problems.join('\n'));
  assert.equal(row.status, 'verified');
  assert.equal(row.sandbox.abilities[0].reached, true);
  assert.match(row.sandbox.abilities[0].how ?? '', /trigger fired/);
});

test("a sandbox that throws at four seats is recorded as sandbox 'throws' and fails the card", async () => {
  const boom = async (_cards: unknown, def: { name: string; oracleId: string }, opts: { seats: 2 | 4 }): Promise<Row> => {
    if (opts.seats === 4) throw new Error('boom at four seats');
    return { name: def.name, oracleId: def.oracleId, verdict: 'sandbox-ok', actions: 1, abilities: 0, reached: 0 };
  };
  const { row } = await verifyOne(fixtures['Lightning Bolt'], { trial: boom as never });
  assert.equal(row.sandbox.seats2, 'ok');
  assert.equal(row.sandbox.seats4, 'throws');
  assert.equal(row.status, 'scripted');
  assert.ok(row.problems.some(p => p.includes('sandbox (4 seats) threw: boom at four seats')), row.problems.join('\n'));
});

test('an id with no script file, and one that is not a card at all, are reported rather than skipped', async () => {
  const dir = freshDir();
  const report = await verifyCards(['00000000-0000-0000-0000-000000000000'], { dir, cards: db });
  assert.equal(report.cards[0].status, 'missing');
  assert.match(report.cards[0].problems[0], /no script file/);
  assert.equal(report.summary.missing, 1);
});

test('--batch accepts the 8k queue format and anything else that carries oracle ids', () => {
  const id = fixtures['Lightning Bolt'].oracleId;
  const other = fixtures['Blood Artist'].oracleId;
  assert.deepEqual(idsInBatch({ manifest: { wave: 'S1', batch: 3 }, cards: [{ oracleId: id, name: 'x' }, { oracleId: other }] }), [id, other]);
  assert.deepEqual(idsInBatch([id, other]), [id, other]);
  assert.deepEqual(idsInBatch([{ oracle_id: id }]), [id]);
  assert.deepEqual(idsInBatch({ cards: [{ oracleId: id }, { oracleId: id }] }), [id], 'ids are deduplicated');
  assert.equal(batchNameOf({ manifest: { wave: 'S1', batch: 3 } }, '/tmp/x.json'), 'S1-3');
  assert.equal(batchNameOf({ cards: [] }, '/tmp/wave-2.json'), 'wave-2');
});

// ---------------------------------------------------------------------------
// Review fixes 1
// ---------------------------------------------------------------------------

/** Write a script into the shard of `underId` whatever its own `oracleId` field says — the author's copy-paste slip. */
function writeAs(dir: string, underId: string, script: CardScript): string {
  const file = path.join(dir, shardOf(underId), `${underId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(script, null, 2) + '\n');
  return file;
}

test('stage 7 writes back into the file it READ, never into the file the oracleId field names', async () => {
  const dir = freshDir();
  const bolt = fixtures['Lightning Bolt'];
  const shock = { ...head(parsedDef(db, 'Shock')), abilities: [{ kind: 'spell' as const, effects: [{ op: 'damage' as const, amount: 2, target: { kind: 'any' as const } }], text: '~ deals 2 damage to any target.' }] };
  writeScript(dir, shock);                                   // a correct, verifiable script for Shock
  writeAs(dir, bolt.oracleId, { ...bolt, oracleId: shock.oracleId });   // Bolt's file, carrying SHOCK's oracle id
  const report = await verifyCards([shock.oracleId, bolt.oracleId], { dir, cards: db });
  const store = new ScriptStore(dir);

  // 1: the run does not die, so the rest of the batch is still verified
  assert.equal(report.cards.length, 2);
  assert.equal(report.cards[0].name, 'Shock');
  assert.deepEqual(report.cards[0].problems, [], report.cards[0].problems.join('\n'));
  assert.equal(report.cards[0].status, 'verified');
  // 2: Shock's own file still holds Shock's verification, not the mislabelled card's
  const onDisk = store.get(shock.oracleId)!;
  assert.equal(onDisk.verification?.status, 'verified');
  assert.deepEqual(onDisk.verification?.problems, [], "a stranger's problems must never land in this file");
  // 3: the mislabelled file got its OWN verification, reporting the mismatch
  const mislabelled = JSON.parse(fs.readFileSync(path.join(dir, shardOf(bolt.oracleId), `${bolt.oracleId}.json`), 'utf8')) as CardScript;
  assert.equal(mislabelled.verification?.status, 'scripted');
  assert.ok(mislabelled.verification?.problems.some(p => p.includes('does not match the file name')), JSON.stringify(mislabelled.verification?.problems));
});

test('a skipped or partial sandbox is RECORDED and cannot mint `verified`', async () => {
  const skipped = await verifyOne(fixtures['Lightning Bolt'], { skipSandbox: true });
  assert.equal(skipped.row.status, 'scripted', 'stage 5 never ran, so the card is not verified');
  assert.ok(skipped.row.problems.some(p => p.includes('--no-sandbox')), skipped.row.problems.join('\n'));
  assert.equal(new ScriptStore(skipped.dir).get(skipped.row.oracleId)!.verification!.status, 'scripted');

  const partial = await verifyOne(fixtures['Lightning Bolt'], { seats: [4] });
  assert.equal(partial.row.sandbox.seats2, 'unreachable');
  assert.ok(partial.row.problems.some(p => p.includes('2-seat sandbox trial was not run')), partial.row.problems.join('\n'));
  assert.equal(partial.row.status, 'scripted');
});

test('stage 6 scores the SECOND face of a split / adventure card', async () => {
  const def = parsedDef(db, 'Midgar, City of Mako // Reactor Raid');
  const script: CardScript = {
    oracleId: def.oracleId, name: def.name, oracleHash: oracleHash(def.oracleText), source: 'hand', mode: 'extend',
    secondFace: {
      abilities: [{
        kind: 'spell',
        effects: [
          { op: 'may', effects: [{ op: 'sacrifice', who: 'you', what: { types: ['Artifact'] }, amount: 1 }] },
          { op: 'draw', amount: 9, who: 'you' },
        ],
        text: 'You may sacrifice an artifact or creature. If you do, draw two cards.',
      }],
    },
  };
  const { row } = await verifyOne(script);
  assert.equal(row.schema, 'ok');
  assert.equal(row.roundTrip.score, 0, `"draw 9" for a line that prints "draw two cards" must be a hard zero, got ${row.roundTrip.score}`);
  assert.ok(row.problems.some(p => p.startsWith('round trip')), row.problems.join('\n'));
  assert.ok(row.roundTrip.lowest.some(l => l.text.includes('draw two cards')), JSON.stringify(row.roundTrip.lowest));
});

test('the static reachability probe reports a static that does nothing on the probe board', async () => {
  const anthem = parsedDef(db, 'Glorious Anthem');
  const real = await probeAbilities(db, anthem);
  assert.deepEqual(real.map(p => p.reached), [true], 'the real Glorious Anthem pumps the probe creature');

  // the same card with a filter nothing on the probe board matches: the static is REACHABLE code that never fires
  const kavuOnly = { ...anthem, abilities: [{ ...anthem.abilities[0], effect: { ...(anthem.abilities[0] as { effect: object }).effect, filter: { types: ['Creature'], subtypes: ['Kavu'] } } }] };
  const inert = await probeAbilities(db, kavuOnly as never);
  assert.deepEqual(inert, [{ index: 0, reached: false }], 'no Kavu is on the probe board, so nothing about it changes');
});

test('scripts:render reports the number scripts:verify gated on', () => {
  const names = ['Outland Colossus', 'Aethersnipe', 'Kami of the Palace Fields'];
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/scripts-render.ts', '--names', names.join(','), '--parsed'], { encoding: 'utf8' });
  const printed = [...out.matchAll(/card score (\d\.\d\d)/g)].map(m => Number(m[1]));
  assert.equal(printed.length, names.length, out);
  for (let i = 0; i < names.length; i++) {
    const gate = scoreCard(parsedDef(db, names[i])).score;
    assert.equal(printed[i], Math.round(gate * 100) / 100, `${names[i]}: scripts:render says ${printed[i]}, the gate scores ${gate}`);
  }
});
