// src/cards/scriptState.ts: every state transition, driven by FIXTURE FILES in a temp directory — no database of
// state, and (except for the one test that pins the playable-row SQL) no master.db either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import {
  blockedPathFor, defaultSources, deriveStates, emptyHistogram, listBlocked, openNeeds, PLAYABLE_SQL, poolRows,
  readBlocked, SCRIPT_STATES, SCRIPT_STATE_TABLE, stateOf, unlockedOpFamilies,
  type BlockedNote, type ScriptState, type StateDef, type StateSources,
} from '../src/cards/scriptState.js';
import { oracleHash, ScriptStore, scriptHash, shardOf, type CardScript, type Verification } from '../src/cards/scripts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ID = '11111111-2222-3333-4444-555555555555';
const TEXT = 'Draw a card.\nUntil end of turn, ~ has flying.';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'script-state-'));

/** A temp tree with a scripts / blocked / scenarios directory and the sources that read them. */
function fixture(over: Partial<StateSources> = {}): StateSources & { root: string } {
  const root = tmp();
  const scriptsDir = path.join(root, 'scripts');
  const blockedDir = path.join(root, 'blocked');
  const scenarioDir = path.join(root, 'scenarios');
  for (const d of [scriptsDir, blockedDir, scenarioDir]) fs.mkdirSync(d, { recursive: true });
  return { root, scripts: new ScriptStore(scriptsDir), blockedDir, scenarioDir, unlocked: new Set(['draw']), judges: 1, ...over };
}

const def = (over: Partial<StateDef> = {}): StateDef => ({ oracleId: ID, name: 'Fixture Card', oracleText: TEXT, fullyParsed: false, ...over });

/** A fresh script for the fixture card; `verification` is filled in by `withVerification`. */
function script(over: Partial<CardScript> = {}): CardScript {
  return { oracleId: ID, name: 'Fixture Card', oracleHash: oracleHash(TEXT), source: 'llm', confidence: 0.8, abilities: [{ kind: 'spell', effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'Draw a card.' }], ...over };
}

/** A verification block whose hashes match `s`, so `stateOf` treats it as current. */
function verification(s: CardScript, over: Partial<Verification> = {}): Verification {
  return {
    at: '2026-01-01T00:00:00.000Z', parserVersion: 2, registryHash: 'deadbeef', oracleHash: oracleHash(TEXT), scriptHash: scriptHash(s),
    schema: 'ok', lint: 'ok',
    sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true, how: 'cast' }] },
    roundTrip: { score: 0.9, lowest: [] },
    scenarios: { file: '', passed: 0, failed: 0, names: [] },
    status: 'verified', problems: [],
    ...over,
  };
}

const put = (src: StateSources, s: CardScript) => {
  const file = src.scripts.pathFor(s.oracleId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  src.scripts.reset();
};

const putBlocked = (src: StateSources, note: Partial<BlockedNote> = {}) => {
  const full: BlockedNote = { oracleId: ID, name: 'Fixture Card', clause: 'Until end of turn, ~ has flying.', needs: [{ opFamily: 'layers-lite', proposedSignature: '{ op: "animate", … }', semantics: 'grant a keyword with a duration', cr: '613.1f' }], wave: '10.0', attempts: 1, ...note };
  const file = blockedPathFor(ID, src.blockedDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(full, null, 2) + '\n');
  return full;
};

const putScenarios = (src: StateSources) => {
  const file = path.join(src.scenarioDir, shardOf(ID), `${ID}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ oracleId: ID, name: 'Fixture Card', scenarios: [] }, null, 2) + '\n');
};

const stateIn = (src: StateSources, d = def(), s?: CardScript): ScriptState => stateOf(ID, { ...src, def: d, ...(s !== undefined ? { script: s } : {}) }).state;

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

test('the state table names every state exactly once, and only judged/reviewed count as covered', () => {
  assert.deepEqual(Object.keys(SCRIPT_STATE_TABLE).sort(), [...SCRIPT_STATES].sort());
  assert.deepEqual(SCRIPT_STATES.filter(s => SCRIPT_STATE_TABLE[s].covered), ['judged', 'reviewed']);
  assert.deepEqual(SCRIPT_STATES.filter(s => SCRIPT_STATE_TABLE[s].simulated).sort(), ['judged', 'parsed', 'reviewed', 'scripted', 'tested', 'verified']);
  // the queue may only issue a card it can improve
  assert.deepEqual(SCRIPT_STATES.filter(s => SCRIPT_STATE_TABLE[s].queueable).sort(), ['scripted', 'stale', 'tested', 'todo', 'verified']);
  assert.deepEqual(emptyHistogram(), Object.fromEntries(SCRIPT_STATES.map(s => [s, 0])));
});

// ---------------------------------------------------------------------------
// No script
// ---------------------------------------------------------------------------

test('parsed: the parser alone claims every line', () => {
  const src = fixture();
  const info = stateOf(ID, { ...src, def: def({ fullyParsed: true }) });
  assert.equal(info.state, 'parsed');
  assert.equal(info.parsedAlone, true);
  assert.match(info.why, /parser alone/);
});

test('todo: not parsed, no script, no blocked note', () => {
  const src = fixture();
  assert.equal(stateIn(src), 'todo');
});

test('blocked: a note whose needs are not in the registry', () => {
  const src = fixture();
  const note = putBlocked(src);
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'blocked');
  assert.deepEqual(info.openNeeds, ['layers-lite']);
  assert.match(info.why, /layers-lite/);
  assert.deepEqual(readBlocked(ID, src.blockedDir), note);
  assert.deepEqual(listBlocked(src.blockedDir).map(n => n.oracleId), [ID]);
});

test('blocked auto-clears to todo when every needed family lands', () => {
  const src = fixture({ unlocked: new Set(['draw', 'layers-lite']) });
  putBlocked(src);
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'todo');
  assert.deepEqual(info.openNeeds, []);
  assert.match(info.why, /spent/);
});

test('a needed family is matched case- and separator-insensitively', () => {
  const note = { ...putBlocked({ ...fixture(), blockedDir: tmp() }), needs: [{ opFamily: 'Layers_Lite' }, { opFamily: 'dice coin' }] };
  assert.deepEqual(openNeeds(note, new Set(['layers-lite'])), ['dice coin']);
  assert.deepEqual(openNeeds(note, new Set(['layers-lite', 'dice-coin'])), []);
});

test('a partly blocked card keeps its open needs in every state', () => {
  const src = fixture();
  putBlocked(src);
  const s = script();
  put(src, s);
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'scripted');
  assert.deepEqual(info.openNeeds, ['layers-lite']);   // this is what `scripts:queue --only-unlocked` drops on
});

// ---------------------------------------------------------------------------
// With a script
// ---------------------------------------------------------------------------

test('stale: the oracle text changed under the script', () => {
  const src = fixture();
  const s = script({ oracleHash: 'ffffffff' });
  put(src, s);
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'stale');
  assert.match(info.why, /oracle text changed/);
});

test('reviewed: a person wrote or checked the script, whatever the verification says', () => {
  for (const source of ['reviewed', 'hand'] as const) {
    const src = fixture();
    put(src, script({ source }));
    assert.equal(stateIn(src), 'reviewed');
  }
});

test('scripted: a fresh script with no verification', () => {
  const src = fixture();
  put(src, script());
  assert.equal(stateIn(src), 'scripted');
});

test('scripted: the verification is stale because the script changed', () => {
  const src = fixture();
  const s = script();
  const stale = { ...s, verification: verification(s, { scriptHash: '00000000' }) };
  put(src, stale);
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'scripted');
  assert.equal(info.verificationStale, true);
});

test('scripted: the verification is stale because the oracle text changed under it', () => {
  const src = fixture();
  const s = script();
  put(src, { ...s, verification: verification(s, { oracleHash: 'ffffffff' }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'scripted');
  assert.equal(info.verificationStale, true);
});

test("scripted: a verification that never got past 'scripted'", () => {
  const src = fixture();
  const s = script();
  put(src, { ...s, verification: verification(s, { status: 'scripted' }) });
  assert.equal(stateIn(src), 'scripted');
});

test('verified: the mechanical gate passed but there is no scenario shard', () => {
  const src = fixture();
  const s = script();
  put(src, { ...s, verification: verification(s, { scenarios: { file: 'x', passed: 1, failed: 0, names: ['a'] } }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'verified');
  assert.match(info.why, /no blind scenario shard/);
});

test('verified: the shard exists but the verification records no scenario run', () => {
  const src = fixture();
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: verification(s) });
  assert.equal(stateIn(src), 'verified');
});

test('verified: a failing scenario never promotes', () => {
  const src = fixture();
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: verification(s, { scenarios: { file: 'x', passed: 3, failed: 1, names: [] } }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'verified');
  assert.match(info.why, /1 blind scenario\(s\) fail/);
});

test('verified: fewer passing scenarios than reachable abilities', () => {
  const src = fixture();
  putScenarios(src);
  const s = script();
  const v = verification(s, {
    sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true }, { index: 1, reached: true }, { index: 2, reached: false }] },
    scenarios: { file: 'x', passed: 1, failed: 0, names: [] },
  });
  put(src, { ...s, verification: v });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'verified');
  assert.match(info.why, /1 passing scenario\(s\) for 2 reachable abilities/);
});

test('tested: a passing scenario per reachable ability, unreachable ones excused', () => {
  const src = fixture();
  putScenarios(src);
  const s = script();
  const v = verification(s, {
    sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true }, { index: 1, reached: false }] },
    scenarios: { file: 'x', passed: 1, failed: 0, names: ['draws'] },
  });
  put(src, { ...s, verification: v });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'tested');
  assert.match(info.why, /0 of 1 faithful/);
});

const tested = (s: CardScript, over: Partial<Verification> = {}) => verification(s, { scenarios: { file: 'x', passed: 1, failed: 0, names: ['draws'] }, ...over });
const judge = (verdict: 'faithful' | 'unfaithful' | 'uncertain', issues: string[] = []) => ({ model: 'opus', verdict, issues, at: '2026-01-01T00:00:00.000Z' });

test('judged: one faithful verdict is enough when one judge is required', () => {
  const src = fixture();
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: tested(s, { judge: [judge('faithful')] }) });
  assert.equal(stateIn(src), 'judged');
});

test('tested: one faithful verdict is NOT enough when two judges are required (wave 10.0)', () => {
  const src = fixture({ judges: 2 });
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: tested(s, { judge: [judge('faithful')] }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'tested');
  assert.match(info.why, /1 of 2 faithful/);
});

test('judged: two faithful verdicts satisfy the two-judge rule', () => {
  const src = fixture({ judges: 2 });
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: tested(s, { judge: [judge('faithful'), judge('faithful')] }) });
  assert.equal(stateIn(src), 'judged');
});

test('tested: one unfaithful verdict outranks any number of faithful ones', () => {
  const src = fixture();
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: tested(s, { judge: [judge('faithful'), judge('unfaithful', ['the pump is +1/+1, not +2/+2'])] }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'tested');
  assert.match(info.why, /unfaithful.*\+1\/\+1/);
});

test('tested: an uncertain verdict neither promotes nor rejects', () => {
  const src = fixture();
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: tested(s, { judge: [judge('uncertain', ['hinges on CR 613']) ] }) });
  assert.equal(stateIn(src), 'tested');
});

test('an unreadable blocked note is treated as none, not as a crash', () => {
  const src = fixture();
  const file = blockedPathFor(ID, src.blockedDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.equal(readBlocked(ID, src.blockedDir), null);
  assert.equal(stateIn(src), 'todo');
});

// ---------------------------------------------------------------------------
// The real pool
// ---------------------------------------------------------------------------

test('unlockedOpFamilies carries the core vocabulary and no `unknown`', () => {
  const u = unlockedOpFamilies();
  for (const op of ['draw', 'destroy', 'move', 'set-pt', 'lose-abilities', 'etb', 'anthem']) assert.ok(u.has(op), `expected ${op}`);
  assert.ok(!u.has('unknown'));
});

test('PLAYABLE_SQL selects exactly the rows CardDB.all() walks', () => {
  // pinned over a rowid window so the test stays cheap; the predicate is a copy of db.ts's private NON_PLAYABLE
  const db = CardDB.shared();
  const want = new Set<string>();
  for (const { def: d } of db.allWithTier({ from: 1, to: 1500 })) want.add(d.oracleId);
  const got = (db.db.prepare(`SELECT oracle_id AS id FROM oracle_cards WHERE ${PLAYABLE_SQL} AND rowid BETWEEN 1 AND 1500`).all() as { id: string }[]).map(r => r.id);
  assert.equal(got.length, want.size);
  for (const id of got) assert.ok(want.has(id), `${id} is in PLAYABLE_SQL but not in CardDB.all()`);
});

test('deriveStates over a handful of real ids agrees with stateOf and fills the histogram', () => {
  const db = CardDB.shared();
  const ids = ['Lightning Bolt', 'Llanowar Elves', 'Grizzly Bears'].map(n => db.get(n)!.oracleId);
  const out = deriveStates({ ids, ...defaultSources() });
  assert.equal(out.cards.length, ids.length);
  for (const c of out.cards) assert.ok(SCRIPT_STATES.includes(c.state));
  assert.equal(Object.values(out.histogram).reduce((a, b) => a + b, 0), ids.length);
  // and the same ids read one at a time give the same answer
  for (const row of poolRows({ ids })) {
    assert.equal(stateOf(row.def.oracleId, { def: row.def }).state, out.cards.find(c => c.oracleId === row.def.oracleId)!.state);
  }
});
