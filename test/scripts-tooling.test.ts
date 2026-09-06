// The 8k fan-out CLIs, exercised through the functions they export: scripts:queue's selection language and
// similarity measure, scripts:promote's dirty-tree gate and status derivation, scripts:quarantine's move (and the
// fact that ScriptStore really ignores the quarantine), and scripts:needs' aggregation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { oracleHash, ScriptStore, scriptHash, type CardScript, type Verification } from '../src/cards/scripts.js';
import { judgeCountFor, readReview, reviewPathFor, stateOf, unlockedOpFamilies, type BlockedNote } from '../src/cards/scriptState.js';
import { judgeRuleOver } from '../src/cards/waveScope.js';
import { clauseTokens, jaccard, ownerDeckIds, parseSelection, typeBucket } from '../scripts/scripts-queue.js';
import { deriveStatus, dirtyPaths, GUARDED_PATHS, humanReview, judgeBlock, readResult, scenarioBlock } from '../scripts/scripts-promote.js';
import { idsOfBatch, move, quarantinePathFor } from '../scripts/scripts-quarantine.js';
import { aggregate } from '../scripts/scripts-needs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-tooling-'));
const ID = 'aabbccdd-1111-2222-3333-444455556666';
const ID2 = '99887766-1111-2222-3333-444455556666';

// ---------------------------------------------------------------------------
// scripts:queue
// ---------------------------------------------------------------------------

test('the --select language parses every term and rejects anything else', () => {
  assert.deepEqual(parseSelection('decks:owner'), { ownerDecks: true, tier: 'paper', commanderLegal: false, raw: 'decks:owner' });
  const s = parseSelection('edhrec<=5000 commander:legal pool:paper');
  assert.equal(s.edhrecMax, 5000);
  assert.equal(s.commanderLegal, true);
  assert.equal(s.tier, 'paper');
  assert.equal(parseSelection('pool:all').tier, 'all');
  assert.equal(parseSelection('edhrec>=100').edhrecMin, 100);
  assert.throws(() => parseSelection('edhrec<5000'), /unknown selection term/);
  assert.throws(() => parseSelection('rarity:mythic'), /unknown selection term/);
});

test('decks:owner reads every decks/*.csv and *.txt into distinct oracle ids', () => {
  const db = CardDB.shared();
  const { ids, missing } = ownerDeckIds(db);
  assert.deepEqual(missing, [], 'every deck name must resolve in master.db');
  assert.ok(ids.length > 400, `expected the owner's six decks plus the four test decks, got ${ids.length}`);
  assert.deepEqual(ids, [...new Set(ids)].sort(), 'ids are distinct and sorted');
});

test('decks:owner returns nothing (rather than throwing) when there is no decks directory', () => {
  assert.deepEqual(ownerDeckIds(CardDB.shared(), path.join(tmp(), 'nope')), { ids: [], missing: [] });
});

test('clause similarity: identical clauses score 1, unrelated ones 0', () => {
  const a = clauseTokens(['Destroy target creature. It can\'t be regenerated.']);
  const b = clauseTokens(['Destroy target creature. It can\'t be regenerated.']);
  const c = clauseTokens(['Target player draws three cards.']);
  assert.equal(jaccard(a, b), 1);
  assert.ok(jaccard(a, c) < 0.2);
  assert.equal(jaccard(a, new Set<string>()), 0);
  // numbers and mana symbols are folded, so "deals 3 damage" and "deals 5 damage" are near neighbours
  assert.ok(jaccard(clauseTokens(['~ deals 3 damage to any target.']), clauseTokens(['~ deals 5 damage to any target.'])) === 1);
});

test('the type bucket puts creatures first and falls back to the printed type', () => {
  const db = CardDB.shared();
  assert.equal(typeBucket(db.get('Grizzly Bears')!), 'Creature');
  assert.equal(typeBucket(db.get('Lightning Bolt')!), 'Instant');
  assert.equal(typeBucket(db.get('Forest')!), 'Land');
});

// ---------------------------------------------------------------------------
// scripts:promote
// ---------------------------------------------------------------------------

test('the dirty-tree gate looks at exactly the guarded roots and honours --allow-dirty', () => {
  assert.deepEqual([...GUARDED_PATHS], ['src', 'test', 'apps', 'scripts', 'package.json']);
  const all = dirtyPaths();
  for (const p of all) assert.ok(GUARDED_PATHS.some(g => p === g || p.startsWith(g + '/')), `${p} is outside the guarded roots`);
  // excluding every guarded root leaves nothing: the allow list is a path-PREFIX match, not a substring match
  assert.deepEqual(dirtyPaths([...GUARDED_PATHS]), []);
  // a prefix that only shares characters must not swallow a path
  const dirty = dirtyPaths(['src/cards/scriptSta']);
  assert.deepEqual(dirty.filter(p => p === 'src/cards/scriptState.ts'), all.filter(p => p === 'src/cards/scriptState.ts'));
});

const baseVerification = (over: Partial<Verification> = {}): Verification => ({
  at: '2026-01-01T00:00:00.000Z', parserVersion: 2, registryHash: 'abc', oracleHash: 'def', scriptHash: 'ghi',
  schema: 'ok', lint: 'ok',
  sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true }] },
  roundTrip: { score: 0.8, lowest: [] },
  scenarios: { file: 'x', passed: 1, failed: 0, names: [] },
  status: 'scripted', problems: [],
  ...over,
});

test('deriveStatus walks the plan 2.4 ladder', () => {
  const faithful = { model: 'opus', verdict: 'faithful' as const, issues: [], at: 'now' };
  assert.equal(deriveStatus(baseVerification({ schema: 'fail' }), 1), 'scripted');
  assert.equal(deriveStatus(baseVerification({ lint: 'fail' }), 1), 'scripted');
  assert.equal(deriveStatus(baseVerification({ sandbox: { seats2: 'throws', seats4: 'ok', abilities: [] } }), 1), 'scripted');
  assert.equal(deriveStatus(baseVerification({ roundTrip: { score: 0.4, lowest: [] } }), 1), 'scripted');
  assert.equal(deriveStatus(baseVerification({ scenarios: { file: '', passed: 0, failed: 0, names: [] } }), 1), 'verified');
  assert.equal(deriveStatus(baseVerification({ scenarios: { file: 'x', passed: 2, failed: 1, names: [] } }), 1), 'verified');
  assert.equal(deriveStatus(baseVerification(), 1), 'tested');
  assert.equal(deriveStatus(baseVerification({ judge: [faithful] }), 1), 'judged');
  assert.equal(deriveStatus(baseVerification({ judge: [faithful] }), 2), 'tested');
  assert.equal(deriveStatus(baseVerification({ judge: [faithful, faithful] }), 2), 'judged');
  assert.equal(deriveStatus(baseVerification({ judge: [faithful, { ...faithful, verdict: 'unfaithful' }] }), 1), 'tested');
  // an unreachable ability is excused: one scenario is enough
  assert.equal(deriveStatus(baseVerification({ sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true }, { index: 1, reached: false }] } }), 1), 'tested');
});

test('deriveStatus: a verification that records a problem is scripted, whatever its sub-scores or judges say', () => {
  const faithful = { model: 'opus', verdict: 'faithful' as const, issues: [], at: 'now' };
  const unclaimed = 'applyScript does not make the card fully simulated (unclaimed: If you control a commander, you may cast ~ without paying its mana cost.)';
  assert.equal(deriveStatus(baseVerification({ problems: [unclaimed] }), 1), 'scripted');
  assert.equal(deriveStatus(baseVerification({ problems: [unclaimed], judge: [faithful] }), 1), 'scripted');
  assert.equal(deriveStatus(baseVerification({ problems: [unclaimed], status: 'verified' }), 1), 'scripted');
  // the file the 10.0 re-run promoted to `verified` with that exact problem recorded (quarantined in fbf6f97)
  const swat = JSON.parse(fs.readFileSync(path.join('test', 'fixtures', 'scripts', 'deflecting-swat.verified-with-problems.json'), 'utf8')) as CardScript;
  assert.equal(swat.verification?.status, 'verified');
  assert.equal(swat.verification?.problems.length, 1);
  assert.equal(deriveStatus(swat.verification!, 1), 'scripted');
});

test('scenario and judge blocks fold the workflow rows the tools write back', () => {
  const block = scenarioBlock([
    { oracleId: ID, scenarioFile: 'data/scenarios/aa/x.json', passed: true, names: ['etb draws'] },
    { oracleId: ID, scenarioFile: 'data/scenarios/aa/x.json', passed: false, failure: 'life 20 != 18', names: ['drain'] },
  ]);
  assert.deepEqual(block, { file: 'data/scenarios/aa/x.json', passed: 1, failed: 1, names: ['drain', 'etb draws'] });
  const judge = judgeBlock([{ oracleId: ID, verdict: 'unfaithful', confidence: 0.9, model: 'opus', issues: [{ line: 'Draw a card.', expected: 'draw 1', scripted: 'draw 2', cr: '121.1' }] }], 'now');
  assert.deepEqual(judge, [{ model: 'opus', verdict: 'unfaithful', issues: ['Draw a card. — expected draw 1 — scripted draw 2 — CR 121.1'], at: 'now' }]);
});

test('scripts:promote --human is the only route to `reviewed`, and it signs what it read', () => {
  const dir = tmp();
  const store = new ScriptStore(path.join(dir, 'scripts'));
  const reviewedDir = path.join(dir, 'reviewed');
  const bolt = CardDB.shared().get('Lightning Bolt')!;
  const s: CardScript = {
    oracleId: bolt.oracleId, name: bolt.name, oracleHash: oracleHash(bolt.oracleText), source: 'llm',
    abilities: [{ kind: 'spell', effects: [{ op: 'damage', amount: 3, target: { kind: 'any' } }], text: bolt.oracleText }],
  };
  store.put(s);

  const rows = humanReview([bolt.oracleId], { by: 'Jared', at: 'NOW', note: 'checked the printed card', store, reviewedDir });
  assert.deepEqual(rows, [{ oracleId: bolt.oracleId, name: bolt.name, wrote: true }]);
  const note = readReview(bolt.oracleId, reviewedDir)!;
  assert.equal(note.by, 'Jared');
  assert.equal(note.at, 'NOW');
  assert.equal(note.note, 'checked the printed card');
  assert.equal(note.scriptHash, scriptHash(s), 'the note pins the script the person actually read');
  assert.equal(note.oracleHash, oracleHash(bolt.oracleText));

  // that note, and only that note, makes the card `reviewed`
  assert.equal(stateOf(bolt.oracleId, { scripts: store, reviewedDir, judges: 1 }).state, 'reviewed');
  assert.equal(stateOf(bolt.oracleId, { scripts: store, reviewedDir: tmp(), judges: 1 }).state, 'scripted');

  // editing the script after the review drops the card back onto the mechanical ladder
  store.put({ ...s, abilities: [...(s.abilities ?? []), { kind: 'spell', effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'Draw a card.' }] }, { force: true });
  const after = stateOf(bolt.oracleId, { scripts: store, reviewedDir, judges: 1 });
  assert.equal(after.state, 'scripted');
  assert.equal(after.reviewStale, true);
});

test('--human refuses a card with no script, and one whose script went stale', () => {
  const dir = tmp();
  const store = new ScriptStore(path.join(dir, 'scripts'));
  const reviewedDir = path.join(dir, 'reviewed');
  const bolt = CardDB.shared().get('Lightning Bolt')!;
  assert.match(humanReview([bolt.oracleId], { by: 'x', at: 'NOW', store, reviewedDir })[0].why ?? '', /no script to review/);
  store.put({ oracleId: bolt.oracleId, name: bolt.name, oracleHash: 'deadbeef', source: 'llm', abilities: [] });
  assert.match(humanReview([bolt.oracleId], { by: 'x', at: 'NOW', store, reviewedDir })[0].why ?? '', /stale/);
  store.put({ oracleId: ID, name: 'Not A Real Card', oracleHash: 'deadbeef', source: 'llm', abilities: [] });
  assert.match(humanReview([ID], { by: 'x', at: 'NOW', store, reviewedDir })[0].why ?? '', /no such card in master.db/);
  assert.equal(fs.existsSync(reviewPathFor(bolt.oracleId, reviewedDir)), false, 'nothing is written for a refusal');
  // --dry-run writes nothing either
  store.put({ oracleId: bolt.oracleId, name: bolt.name, oracleHash: oracleHash(bolt.oracleText), source: 'llm', abilities: [] }, { force: true });
  assert.equal(humanReview([bolt.oracleId], { by: 'x', at: 'NOW', store, reviewedDir, dryRun: true })[0].wrote, true);
  assert.equal(fs.existsSync(reviewPathFor(bolt.oracleId, reviewedDir)), false);
});

test('promotion asks the per-card judge rule, not one number for the whole run', () => {
  const faithful = { model: 'opus', verdict: 'faithful' as const, issues: [], at: 'now' };
  const two = judgeRuleOver(new Set([ID]));
  // the same verification promotes or does not, depending on the CARD
  assert.equal(deriveStatus(baseVerification({ judge: [faithful] }), judgeCountFor({ judges: two }, ID)), 'tested');
  assert.equal(deriveStatus(baseVerification({ judge: [faithful] }), judgeCountFor({ judges: two }, ID2)), 'judged');
});

test('a workflow result may be the bare array or the stamped object', () => {
  const dir = tmp();
  const rows = [{ batch: '001', written: [ID], verified: [ID] }];
  const a = path.join(dir, 'a.json'); fs.writeFileSync(a, JSON.stringify(rows));
  const b = path.join(dir, 'b.json'); fs.writeFileSync(b, JSON.stringify({ wave: '10.0', results: rows }));
  assert.deepEqual(readResult(a), { wave: null, results: rows });
  assert.deepEqual(readResult(b), { wave: '10.0', results: rows });
  const bad = path.join(dir, 'c.json'); fs.writeFileSync(bad, JSON.stringify({ nope: 1 }));
  assert.throws(() => readResult(bad), /expected an array of batch results/);
});

// ---------------------------------------------------------------------------
// scripts:quarantine
// ---------------------------------------------------------------------------

const script = (id: string): CardScript => ({ oracleId: id, name: 'Quarantine Fixture', oracleHash: oracleHash('Draw a card.'), source: 'llm', abilities: [{ kind: 'spell', effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'Draw a card.' }] });

test('a quarantined script is invisible to ScriptStore, and restoring brings it back', () => {
  const dir = tmp();
  const store = new ScriptStore(dir);
  store.put(script(ID));
  store.put(script(ID2));
  assert.deepEqual(store.ids().sort(), [ID, ID2].sort());

  const held = path.join(dir, '_quarantine');
  const m = move(ID, { store, quarantineDir: held });
  assert.equal(m.done, true);
  assert.equal(m.to, quarantinePathFor(ID, held));
  assert.ok(fs.existsSync(m.to));

  // a NEW store over the same directory must not see it: `_quarantine` is in ScriptStore's NON_SHARD_DIRS
  const fresh = new ScriptStore(dir);
  assert.deepEqual(fresh.ids(), [ID2]);
  assert.equal(fresh.get(ID), null);

  const back = move(ID, { store: fresh, quarantineDir: held, restore: true });
  assert.equal(back.done, true);
  assert.deepEqual(new ScriptStore(dir).ids().sort(), [ID, ID2].sort());
});

test('quarantine never clobbers and never moves what is not there', () => {
  const dir = tmp();
  const store = new ScriptStore(dir);
  const held = path.join(dir, '_quarantine');
  assert.match(move(ID, { store, quarantineDir: held }).why ?? '', /no script to quarantine/);
  store.put(script(ID));
  fs.mkdirSync(path.dirname(quarantinePathFor(ID, held)), { recursive: true });
  fs.writeFileSync(quarantinePathFor(ID, held), '{}');
  assert.match(move(ID, { store, quarantineDir: held }).why ?? '', /already exists/);
  // --dry-run leaves the tree alone
  fs.rmSync(quarantinePathFor(ID, held));
  assert.equal(move(ID, { store, quarantineDir: held, dryRun: true }).done, true);
  assert.equal(fs.existsSync(quarantinePathFor(ID, held)), false);
  assert.ok(fs.existsSync(store.pathFor(ID)));
});

test('a batch file names the ids the quarantine acts on', () => {
  const dir = tmp();
  const file = path.join(dir, '001.json');
  fs.writeFileSync(file, JSON.stringify({ manifest: { wave: '10.0', batch: '001' }, cards: [{ oracleId: ID }, { oracleId: ID2 }, { oracleId: 'not-an-id' }] }));
  assert.deepEqual(idsOfBatch(file), [ID, ID2]);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ manifest: {} }));
  assert.throws(() => idsOfBatch(bad), /not a batch file/);
});

// ---------------------------------------------------------------------------
// scripts:needs
// ---------------------------------------------------------------------------

const note = (over: Partial<BlockedNote> = {}): BlockedNote => ({
  oracleId: ID, name: 'Blocked Fixture', clause: 'Roll a d20.', wave: '10.0', attempts: 1,
  needs: [{ opFamily: 'dice-coin', proposedSignature: '{ op: "roll", die: 20 }', semantics: 'roll a die', cr: '705' }],
  ...over,
});

test('needs are aggregated by family, ranked by cards blocked, unlocked families last', () => {
  const rows = aggregate([
    note(),
    note({ oracleId: ID2, clause: 'Flip a coin.', needs: [{ opFamily: 'dice-coin', proposedSignature: '{ op: "flip" }' }], attempts: 3 }),
    note({ oracleId: '11111111-1111-1111-1111-111111111111', needs: [{ opFamily: 'draw' }] }),
  ], new Set(['draw']));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].opFamily, 'dice-coin');
  assert.equal(rows[0].unlocked, false);
  assert.equal(rows[0].cards, 2);
  assert.deepEqual(rows[0].exampleClauses, ['Roll a d20.', 'Flip a coin.']);
  assert.deepEqual(rows[0].proposedSignatures, ['{ op: "flip" }', '{ op: "roll", die: 20 }']);
  assert.equal(rows[0].maxAttempts, 3);
  assert.deepEqual(rows[0].crCitations, ['705']);
  // a family that already exists sorts last and is flagged
  assert.equal(rows[1].opFamily, 'draw');
  assert.equal(rows[1].unlocked, true);
});

test('example clauses are capped at five and cards are counted once', () => {
  const many = Array.from({ length: 8 }, (_, i) => note({ oracleId: `0000000${i}-1111-2222-3333-444455556666`, clause: `clause ${i}` }));
  const rows = aggregate([...many, ...many], unlockedOpFamilies());
  assert.equal(rows[0].cards, 8);
  assert.equal(rows[0].exampleClauses.length, 5);
  assert.deepEqual(rows[0].cardIds, [...new Set(rows[0].cardIds)].sort());
});
