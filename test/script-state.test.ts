// src/cards/scriptState.ts: every state transition, driven by FIXTURE FILES in a temp directory — no database of
// state, and (except for the one test that pins the playable-row SQL) no master.db either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import {
  blockedPathFor, defaultSources, deriveStates, emptyHistogram, judgeCountFor, listBlocked, listReviews, openNeeds,
  PLAYABLE_SQL, poolRows, readBlocked, readReview, reviewPathFor, SCRIPT_STATES, SCRIPT_STATE_TABLE, stateOf,
  unearnedHumanSource, unlockedOpFamilies,
  type BlockedNote, type ReviewNote, type ScriptState, type StateDef, type StateSources,
} from '../src/cards/scriptState.js';
import { blindSample, edhrecTopIds, judgeRuleOver, ownerDeckIds, twoJudgeIds } from '../src/cards/waveScope.js';
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
  const reviewedDir = path.join(root, 'reviewed');
  for (const d of [scriptsDir, blockedDir, scenarioDir, reviewedDir]) fs.mkdirSync(d, { recursive: true });
  return { root, scripts: new ScriptStore(scriptsDir), blockedDir, scenarioDir, reviewedDir, unlocked: new Set(['draw']), judges: 1, ...over };
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

/** What `scripts:promote --human` writes: a signed note pinning both hashes of the script the person read. */
const putReview = (src: StateSources, s: CardScript, over: Partial<ReviewNote> = {}): ReviewNote => {
  const note: ReviewNote = {
    oracleId: ID, name: 'Fixture Card', by: 'Jared', at: '2026-02-01T10:00:00.000Z',
    scriptHash: scriptHash(s), oracleHash: oracleHash(TEXT), ...over,
  };
  const file = reviewPathFor(ID, src.reviewedDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(note, null, 2) + '\n');
  return note;
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

// ---------------------------------------------------------------------------
// reviewed — a REVIEW NOTE, never the script's own `source`
// ---------------------------------------------------------------------------

test("a script that merely DECLARES source 'hand' / 'reviewed' is not reviewed and is not covered", () => {
  for (const source of ['reviewed', 'hand'] as const) {
    const src = fixture();
    put(src, script({ source }));
    const info = stateOf(ID, { ...src, def: def() });
    // the whole point: an author agent can copy this word out of a worked example, so it buys the card nothing
    assert.equal(info.state, 'scripted', `source '${source}' must not promote a card`);
    assert.equal(SCRIPT_STATE_TABLE[info.state].covered, false);
    assert.equal(SCRIPT_STATE_TABLE[info.state].queueable, true, 'and the queue must issue it again');
    assert.equal(info.unearnedHumanSource, true);
    assert.equal(info.review, undefined);
  }
  // an 'llm' script is never flagged
  const clean = fixture();
  put(clean, script());
  assert.equal(stateOf(ID, { ...clean, def: def() }).unearnedHumanSource, undefined);
});

test('reviewed: a review note for THIS script, whatever the verification says', () => {
  const src = fixture();
  const s = script();
  put(src, s);
  const note = putReview(src, s);
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'reviewed');
  assert.equal(SCRIPT_STATE_TABLE.reviewed.covered, true);
  assert.match(info.why, /Jared reviewed this exact script/);
  assert.deepEqual(info.review, note);
  assert.equal(info.unearnedHumanSource, undefined, 'a note makes the claim earned');
  assert.deepEqual(listReviews(src.reviewedDir).map(n => n.oracleId), [ID]);
  assert.deepEqual(readReview(ID, src.reviewedDir), note);
});

test('a review note for a DIFFERENT script (or a changed oracle text) does not promote', () => {
  for (const over of [{ scriptHash: 'deadbeef' }, { oracleHash: 'deadbeef' }] as const) {
    const src = fixture();
    const s = script();
    put(src, s);
    putReview(src, s, over);
    const info = stateOf(ID, { ...src, def: def() });
    assert.equal(info.state, 'scripted', `${JSON.stringify(over)} must invalidate the review`);
    assert.equal(info.reviewStale, true);
  }
});

test('an unsigned or unreadable review note is treated as none', () => {
  for (const body of ['{ not json', JSON.stringify({ oracleId: ID, scriptHash: 'x', oracleHash: 'y' }), JSON.stringify({ by: '  ', scriptHash: 'x', oracleHash: 'y' })]) {
    const src = fixture();
    const file = reviewPathFor(ID, src.reviewedDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    assert.equal(readReview(ID, src.reviewedDir), null);
    put(src, script());
    assert.equal(stateIn(src), 'scripted');
  }
});

test('unearnedHumanSource is exactly "claims a person, has no note"', () => {
  const s = script({ source: 'hand' });
  const note = { oracleId: ID, name: 'x', by: 'Jared', at: 'now', scriptHash: scriptHash(s), oracleHash: oracleHash(TEXT) };
  assert.equal(unearnedHumanSource(s, null), true);
  assert.equal(unearnedHumanSource(s, note), false);
  assert.equal(unearnedHumanSource(script({ source: 'llm' }), null), false);
  assert.equal(unearnedHumanSource(script({ source: 'generated' }), null), false);
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

test('the judge count is a property of the CARD, not of the invocation', () => {
  // process rule 5: two judges for the owner's decks, one elsewhere. Before this the queue decided it once per RUN,
  // so the same card was `judged` under `defaultSources()` and `tested` under the owner-decks queue.
  const other = '99999999-8888-7777-6666-555555555555';
  const rule = judgeRuleOver(new Set([ID]));
  assert.equal(judgeCountFor({ judges: rule }, ID), 2);
  assert.equal(judgeCountFor({ judges: rule }, other), 1);
  assert.equal(judgeCountFor({ judges: 2 }, other), 2, 'a bare count still forces the whole run');

  const src = fixture({ judges: rule });
  putScenarios(src);
  const s = script();
  put(src, { ...s, verification: tested(s, { judge: [judge('faithful')] }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'tested', 'a two-judge card is not judged on one verdict');
  assert.match(info.why, /1 of 2 faithful/);
  // the same script under a card the rule does not name IS judged
  assert.equal(stateOf(ID, { ...src, judges: judgeRuleOver(new Set([other])), def: def() }).state, 'judged');
});

// ---------------------------------------------------------------------------
// The sampled blind leg (process rule 8): `scenarios.sampled === false` skips the `tested` rung
// ---------------------------------------------------------------------------

const unsampled = (s: CardScript, over: Partial<Verification> = {}) => verification(s, { scenarios: { file: '', passed: 0, failed: 0, names: [], sampled: false }, ...over });

test('judged: an unsampled card with one faithful verdict and NO scenario shard', () => {
  const src = fixture();
  const s = script();
  put(src, { ...s, verification: unsampled(s, { judge: [judge('faithful')] }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'judged');
  assert.equal(info.blindSampled, false);
  assert.match(info.why, /1 faithful verdict/);
  assert.equal(SCRIPT_STATE_TABLE.judged.covered, true, 'it counts as covered like any judged card');
});

test('verified (never tested): an unsampled card whose judge is missing, uncertain, unfaithful or short of the count', () => {
  const cases: [label: string, over: Partial<Verification>, count: 1 | 2][] = [
    ['no judge', {}, 1],
    ['uncertain', { judge: [judge('uncertain', ['hinges on CR 613'])] }, 1],
    ['unfaithful', { judge: [judge('faithful'), judge('unfaithful', ['the pump is +1/+1'])] }, 1],
    ['one of two', { judge: [judge('faithful')] }, 2],
  ];
  for (const [label, over, count] of cases) {
    const src = fixture({ judges: count });
    putScenarios(src);   // even a stale shard on disk does not make it `tested`
    const s = script();
    put(src, { ...s, verification: unsampled(s, over) });
    const info = stateOf(ID, { ...src, def: def() });
    assert.equal(info.state, 'verified', label);
    assert.equal(info.blindSampled, false, label);
    assert.match(info.why, /not sampled for this wave/, label);
    assert.equal(SCRIPT_STATE_TABLE.verified.queueable, true, 'so a rejected unsampled card is re-issued');
  }
});

test('an unsampled card: the problems guard still comes first, and absence of `sampled` means sampled', () => {
  const src = fixture();
  const s = script();
  put(src, { ...s, verification: unsampled(s, { judge: [judge('faithful')], problems: ['unclaimed: Until end of turn, ~ has flying.'] }) });
  const info = stateOf(ID, { ...src, def: def() });
  assert.equal(info.state, 'scripted');
  assert.equal(info.blindSampled, undefined);
  // a 10.0 file (no `sampled` key, no scenario run) with a faithful verdict is still only verified without a shard
  put(src, { ...s, verification: verification(s, { judge: [judge('faithful')] }) });
  const old = stateOf(ID, { ...src, def: def() });
  assert.equal(old.state, 'verified');
  assert.equal(old.blindSampled, undefined);
  assert.match(old.why, /no blind scenario shard/);
});

test('blindSample: one id in N by index over the sorted unique ids, plus every always-id', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
  const shuffled = [ids[7], ids[2], ids[0], ids[9], ids[4], ids[1], ids[8], ids[3], ids[6], ids[5], ids[2]];
  assert.deepEqual(blindSample(shuffled, 3, new Set()), [ids[0], ids[3], ids[6], ids[9]]);
  assert.deepEqual(blindSample(shuffled, 3, new Set([ids[5], 'not-in-the-batch'])), [ids[0], ids[3], ids[5], ids[6], ids[9]]);
  assert.deepEqual(blindSample(shuffled, 1, new Set()), ids, 'rate 1 keeps every id');
  assert.deepEqual(blindSample([], 3, new Set()), []);
  assert.deepEqual(blindSample([ids[4]], 3, new Set()), [ids[4]], 'a single id is index 0 and always drawn');
  // the workflow file carries the same body (the reviewer diffs them by eye; this pins that the text is there)
  const wave = fs.readFileSync(path.join('docs', 'workflows', 'script-wave.js'), 'utf8');
  assert.ok(wave.includes('[...new Set(ids)].sort().filter((id, i) => always.has(id) || i % rate === 0)'), 'script-wave.js mirrors blindSample');
});

/** A dry run of docs/workflows/script-wave.js under the Workflow runtime's hooks, with `agent` replaced by a recorder
 *  that answers each phase with `answers[phase]` — the same harness as the brief's syntax check, plus stubs. */
async function dryRunWave(args: Record<string, unknown>, answers: Record<string, unknown>) {
  const src = fs.readFileSync(path.join('docs', 'workflows', 'script-wave.js'), 'utf8').replace(/^export const meta/m, 'const meta');
  const calls: { prompt: string; label: string; phase: string }[] = [];
  const logs: string[] = [];
  const agent = (prompt: string, opts: { label: string; phase: string }) => { calls.push({ prompt, label: opts.label, phase: opts.phase }); return Promise.resolve(answers[opts.phase]); };
  const parallel = (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map(t => t()));
  const pipeline = (items: unknown[], ...stages: ((prev: unknown, item: unknown, i: number) => unknown)[]) =>
    Promise.all(items.map(async (item, i) => { let v: unknown = item; for (const stage of stages) v = await stage(v, item, i); return v; }));
  const body = new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', 'return (async()=>{' + src + '})()');
  const rows = await body(args, agent, parallel, pipeline, () => {}, (m: string) => logs.push(m), { total: null, remaining: () => Infinity }, () => { throw new Error('no nested workflow'); });
  return { calls, logs, rows };
}

test('script-wave dry run: the blind author is never told to read under data/scripts (the vocabulary rule is author-only), rerun is in every prompt, blindRate 3 samples by index', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
  const batch = 'data/scripts/batches/10.1/001.json';
  const { calls, logs, rows } = await dryRunWave(
    { wave: '10.1', judges: 1, blindRate: 3, alwaysSample: [ids[5]], rerun: 2, batches: [batch] },
    { Author: { written: ids, verified: ids, blocked: [], needs: [], iterations: 1 }, Scenario: { results: [], failures: [] }, Judge: { verdicts: [] } });
  assert.deepEqual(calls.map(c => c.phase), ['Author', 'Scenario', 'Judge']);
  const [author, scenario, judge] = calls.map(c => c.prompt);
  // C-1c: the author reads the vocabulary; the blind author's composed prompt (its own text + HARD) must not point at any
  // file under data/scripts/ — the only mention of that directory is the ban itself
  assert.match(author, /Read data\/scripts\/README\.md .*data\/scripts\/VOCABULARY\.md/);
  assert.match(author, /Use only ops documented in data\/scripts\/VOCABULARY\.md/);
  assert.match(scenario, /never open or list anything under data\/scripts\//);
  assert.ok(!scenario.includes('VOCABULARY.md') || /not README\.md or VOCABULARY\.md either/.test(scenario), 'VOCABULARY.md appears in the blind prompt only inside the ban');
  assert.doesNotMatch(scenario, /Use only ops documented|no 'unknown' effect|Read data\/scripts/);
  assert.deepEqual([...scenario.matchAll(/data\/scripts\/\S*/g)].map(m => m[0]), [`${batch.replace('.json', '.blind.json')}`, 'data/scripts/', 'data/scripts/<2-hex>/<oracle_id>.json'],
    'data/scripts/ in the blind prompt: the blind file, the ban, and the script authors\' write scope — nothing else');
  assert.match(scenario, /never run 'npx tsx -e'/);
  assert.match(scenario, /never import or query src\/cards\/db\.ts/);
  assert.match(scenario, /missing from the blind file, report it in toolProblems/);
  // rerun folded into every prompt (reviewer lens 5)
  for (const c of calls) assert.ok(c.prompt.endsWith('Run 2.'), `${c.label} ends with the rerun marker`);
  // blindRate 3 over ten sorted ids: indices 0, 3, 6, 9 plus the always-id, logged and carried in the row
  assert.deepEqual(logs.filter(l => l.includes('blind scenarios')), [`${batch}: blind scenarios for 5/10`]);
  assert.match(scenario, new RegExp(JSON.stringify([ids[0], ids[3], ids[5], ids[6], ids[9]]).replace(/[[\]]/g, '\\$&')));
  assert.match(judge, /compare the oracle text/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blindRate, 3);
  assert.deepEqual(rows[0].blindSampling.filter((s: { blindSampled: boolean }) => s.blindSampled).map((s: { oracleId: string }) => s.oracleId), [ids[0], ids[3], ids[5], ids[6], ids[9]]);
  assert.equal(rows[0].blindSampling.length, 10);
});

test('script-wave dry run: resume reuses the prior author row unless the batch is in reauthor; a batch with no sampled id skips the scenario agent', async () => {
  const a = 'data/scripts/batches/10.1/001.json', b = 'data/scripts/batches/10.1/002.json';
  const id = '00000001-0000-0000-0000-000000000000';
  const priorRow = { batch: a, written: [id], verified: [], blocked: [{ oracleId: id, clause: 'x', reason: 'y' }], needs: [], parserRuleSuggestions: ['r'], toolProblems: ['t'] };
  const { calls, logs, rows } = await dryRunWave(
    { wave: '10.1', judges: 1, blindRate: 1, rerun: 1, batches: [a, b], resume: { results: [priorRow, { batch: b, written: [], verified: [] }], reauthor: [b] } },
    { Author: { written: [id], verified: [id], blocked: [], needs: [], iterations: 1 }, Scenario: { results: [], failures: [] }, Judge: { verdicts: [] } });
  assert.deepEqual(calls.map(c => c.label), ['author:002.json', 'scenario:002.json', 'judge1:002.json'], 'batch 001 reused its row: no author, nothing verified so no scenario, no judge');
  assert.ok(logs.includes(`${a}: author result reused from the prior run`));
  assert.ok(logs.includes(`${a}: blind scenarios for 0/0`));
  const reused = rows.find((r: { batch: string }) => r.batch === a);
  assert.deepEqual([reused.written, reused.verified, reused.blocked, reused.parserRuleSuggestions, reused.toolProblems], [[id], [], priorRow.blocked, ['r'], ['t']]);
  assert.deepEqual(reused.blindSampling, []);
  for (const c of calls) assert.ok(c.prompt.endsWith('Run 1.'));
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

test('the real two-judge set is the owner decks ONLY (process rule 5; the EDHREC top-1k was dropped 2026-09-06)', () => {
  const db = CardDB.shared();
  const decks = ownerDeckIds(db).ids;
  assert.ok(decks.length > 400);
  const two = twoJudgeIds(db);
  assert.deepEqual([...two].sort(), decks, 'exactly the owner\'s decks');
  // EDHREC rank no longer buys a second judge: a top-1k card outside the decks needs one
  const top = edhrecTopIds(db, 1000);
  assert.ok(top.size > 500 && top.size <= 1000, `top-1k has ${top.size} cards`);
  const rule = judgeRuleOver(two);
  const popular = [...top].filter(id => !two.has(id));
  assert.ok(popular.length > 0, 'some top-1k card is not in the owner\'s decks');
  for (const id of popular) assert.equal(rule(id), 1, `${id} is EDHREC top-1k but not an owner card: one judge`);
  // Lightning Bolt is in decks/mono-red-burn.txt; a random un-ranked card needs one judge
  assert.equal(rule(db.get('Lightning Bolt')!.oracleId), 2);
  assert.equal(rule('00000000-0000-0000-0000-000000000000'), 1);
  // a temp decks dir is the whole set
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'one.txt'), '1 Grizzly Bears\n');
  assert.deepEqual([...twoJudgeIds(db, { decksDir: dir })], [db.get('Grizzly Bears')!.oracleId]);
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

// ---------------------------------------------------------------------------
// A recorded problem beats the status field
// ---------------------------------------------------------------------------

test('scripted: a verification whose status says verified (or judged) but whose problems are non-empty', () => {
  const src = fixture();
  const s = script();
  const unclaimed = 'applyScript does not make the card fully simulated (unclaimed: Until end of turn, ~ has flying.)';
  put(src, { ...s, verification: verification(s, { status: 'verified', problems: [unclaimed] }) });
  const st = stateOf(ID, { ...src, def: def() });
  assert.equal(st.state, 'scripted');
  assert.match(st.why, /records 1 problem/);
  // even a faithful judge and a scenario shard do not lift it: the promoter never writes this shape any more,
  // and a file that carries it must not read as covered
  putScenarios(src);
  put(src, { ...s, verification: verification(s, { status: 'judged', problems: [unclaimed], scenarios: { file: 'x', passed: 1, failed: 0, names: ['n'] }, judge: [{ model: 'opus', verdict: 'faithful', issues: [], at: 'now' }] }) });
  assert.equal(stateIn(src), 'scripted');
  // and the 10.0 re-run file itself (Deflecting Swat, quarantined in fbf6f97) reads as scripted against its real
  // oracle text — CardDB.getByOracleId applies the live script store, so only the def's text and name are borrowed
  const swat = JSON.parse(fs.readFileSync(path.join('test', 'fixtures', 'scripts', 'deflecting-swat.verified-with-problems.json'), 'utf8')) as CardScript;
  const real = CardDB.shared().getByOracleId(swat.oracleId);
  if (real) {
    const src2 = fixture();
    put(src2, swat);
    const st2 = stateOf(swat.oracleId, { ...src2, def: { oracleId: swat.oracleId, name: real.name, oracleText: real.oracleText, fullyParsed: false } });
    assert.equal(st2.state, 'scripted', st2.why);
    assert.match(st2.why, /unclaimed: If you control a commander/);
  }
});
