// scripts:queue at the OUTPUT level: the batch and blind files themselves, not just the helpers around them.
// `buildWave` is the whole tool (the CLI only writes what it returns), so everything a wave promises is gated here:
//
//   * a card the state table calls un-queueable (judged / reviewed / blocked) is never re-issued;
//   * the BLIND copy carries no AST — no parser draft, no examples, no vocabulary;
//   * a batch holds whole families and carries the core vocabulary exactly once;
//   * two runs on the same tree produce identical bytes.
//
// Every state is derived from a temp tree, so the test plants its own judged and blocked cards and never depends on
// what happens to be under data/scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { oracleHash, ScriptStore, scriptHash, shardOf, type CardScript, type Verification } from '../src/cards/scripts.js';
import { stateOf, type BlockedNote, type ReviewNote, type StateSources } from '../src/cards/scriptState.js';
import {
  BLIND_FORBIDDEN_KEYS, buildWave, packFamilies, parseSelection, unparsedLines, type BuiltWave,
} from '../scripts/scripts-queue.js';
import type { Family } from '../src/cards/taxonomy.js';
import type { CardDef } from '../src/cards/types.js';

const db = CardDB.shared();

/** Five real cards the parser does not finish, each in a family of its own (see test/taxonomy.test.ts). */
const NAMES = ["Teferi's Protection", 'Epiphany at the Drownyard', "Krark's Thumb", 'Clone', 'Chandra, Torch of Defiance'];
const ID = (name: string): string => {
  const d = db.get(name);
  assert.ok(d, `no such card in master.db: ${name}`);
  return d!.oracleId;
};

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-output-'));
  const dirs = {
    scriptsDir: path.join(root, 'scripts'),
    blockedDir: path.join(root, 'blocked'),
    scenarioDir: path.join(root, 'scenarios'),
    reviewedDir: path.join(root, 'reviewed'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const sources: Partial<StateSources> = {
    scripts: new ScriptStore(dirs.scriptsDir),
    blockedDir: dirs.blockedDir,
    scenarioDir: dirs.scenarioDir,
    reviewedDir: dirs.reviewedDir,
    judges: 1,
  };
  return { root, ...dirs, sources };
}

const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

/** A script that applies to the real card, plus the verification/scenario evidence that makes it `judged`. */
function plantJudged(t: ReturnType<typeof tree>, name: string): string {
  const oracleId = ID(name);
  const def = db.get(name)!;
  const script: CardScript = {
    oracleId, name, oracleHash: oracleHash(def.oracleText), source: 'llm', confidence: 0.9,
    abilities: [{ kind: 'spell', effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'Draw a card.' }],
  };
  const verification: Verification = {
    at: '2026-01-01T00:00:00.000Z', parserVersion: 2, registryHash: 'deadbeef',
    oracleHash: oracleHash(def.oracleText), scriptHash: scriptHash(script),
    schema: 'ok', lint: 'ok',
    sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true }] },
    roundTrip: { score: 0.9, lowest: [] },
    scenarios: { file: 'x', passed: 1, failed: 0, names: ['draws'] },
    judge: [{ model: 'opus', verdict: 'faithful', issues: [], at: '2026-01-01T00:00:00.000Z' }],
    status: 'judged', problems: [],
  };
  write(path.join(t.scriptsDir, shardOf(oracleId), `${oracleId}.json`), { ...script, verification });
  write(path.join(t.scenarioDir, shardOf(oracleId), `${oracleId}.json`), { oracleId, name, scenarios: [] });
  (t.sources.scripts as ScriptStore).reset();
  return oracleId;
}

/** A blocked note naming a family that does not exist, which is what keeps a card out of the queue. */
function plantBlocked(t: ReturnType<typeof tree>, name: string): string {
  const oracleId = ID(name);
  const note: BlockedNote = {
    oracleId, name, clause: 'Flip a coin.', wave: '10.0', attempts: 1,
    needs: [{ opFamily: 'no-such-family-9x', semantics: 'nothing implements this' }],
  };
  write(path.join(t.blockedDir, shardOf(oracleId), `${oracleId}.json`), note);
  return oracleId;
}

/** A human-reviewed card: a script plus the signed note `scripts:promote --human` writes. */
function plantReviewed(t: ReturnType<typeof tree>, name: string): string {
  const oracleId = ID(name);
  const def = db.get(name)!;
  const script: CardScript = {
    oracleId, name, oracleHash: oracleHash(def.oracleText), source: 'llm',
    abilities: [{ kind: 'spell', effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'Draw a card.' }],
  };
  const note: ReviewNote = {
    oracleId, name, by: 'Jared', at: '2026-02-01T00:00:00.000Z',
    scriptHash: scriptHash(script), oracleHash: oracleHash(def.oracleText),
  };
  write(path.join(t.scriptsDir, shardOf(oracleId), `${oracleId}.json`), script);
  write(path.join(t.reviewedDir, shardOf(oracleId), `${oracleId}.json`), note);
  (t.sources.scripts as ScriptStore).reset();
  return oracleId;
}

function wave(t: ReturnType<typeof tree>, over: Partial<Parameters<typeof buildWave>[0]> = {}): BuiltWave {
  return buildWave({
    wave: '10.0',
    selection: parseSelection('pool:all'),
    db,
    outDir: path.join(t.root, 'out'),
    createdAt: '2026-03-01T00:00:00.000Z',
    ids: NAMES.map(ID),
    sources: t.sources,
    ...over,
  });
}

const queuedIds = (w: BuiltWave): string[] => w.batches.flatMap(b => b.full.cards.map(c => c.oracleId)).sort();

// ---------------------------------------------------------------------------
// What the queue may and may not issue
// ---------------------------------------------------------------------------

test('the five fixture cards all start out queueable', () => {
  const t = tree();
  for (const name of NAMES) {
    const st = stateOf(ID(name), { ...t.sources });
    assert.equal(st.state, 'todo', `${name} is ${st.state} (${st.why}) — pick another fixture card`);
  }
  assert.deepEqual(queuedIds(wave(t)), NAMES.map(ID).sort());
});

test('a judged, a reviewed and a blocked card are never re-issued', () => {
  const t = tree();
  const judged = plantJudged(t, NAMES[0]);
  const reviewed = plantReviewed(t, NAMES[1]);
  const blocked = plantBlocked(t, NAMES[2]);
  // the states really are what the fixtures claim
  assert.equal(stateOf(judged, { ...t.sources }).state, 'judged');
  assert.equal(stateOf(reviewed, { ...t.sources }).state, 'reviewed');
  assert.equal(stateOf(blocked, { ...t.sources }).state, 'blocked');

  const w = wave(t);
  assert.deepEqual(queuedIds(w), [ID(NAMES[3]), ID(NAMES[4])].sort());
  const issued = new Set(w.batches.flatMap(b => [...b.full.cards, ...b.blind.cards]).map(c => c.oracleId));
  for (const gone of [judged, reviewed, blocked]) assert.ok(!issued.has(gone), `${gone} must not be issued to any author`);
  // the judged one is still allowed to appear as an EXAMPLE for the cards that were issued — that is its job
  const exampleIds = new Set(w.batches.flatMap(b => b.full.cards.flatMap(c => c.examples.map(e => e.oracleId))));
  assert.ok(exampleIds.has(judged), 'a judged script is the style guide the batch quotes');
  assert.ok(!JSON.stringify(w.batches.map(b => b.blind)).includes(judged), 'but never in the blind copy');
  const counts = w.manifest.counts as Record<string, number>;
  assert.equal(counts.considered, NAMES.length);
  assert.equal(counts.droppedByState, 3);
  assert.equal(counts.queued, 2);
  assert.deepEqual(w.states.judged, 1);
  assert.deepEqual(w.states.reviewed, 1);
  assert.deepEqual(w.states.blocked, 1);
});

test('--only-unlocked additionally drops a scripted card whose blocked note is still open', () => {
  const t = tree();
  const id = plantBlocked(t, NAMES[0]);          // blocked, so already dropped
  const t2 = tree();
  plantBlocked(t2, NAMES[0]);
  // give it a script: the state becomes `scripted` (queueable) but the open need remains
  const def = db.get(NAMES[0])!;
  const script: CardScript = { oracleId: id, name: NAMES[0], oracleHash: oracleHash(def.oracleText), source: 'llm', abilities: [] };
  write(path.join(t2.scriptsDir, shardOf(id), `${id}.json`), script);
  (t2.sources.scripts as ScriptStore).reset();
  assert.equal(stateOf(id, { ...t2.sources }).state, 'scripted');
  assert.ok(queuedIds(wave(t2)).includes(id));
  assert.ok(!queuedIds(wave(t2, { onlyUnlocked: true })).includes(id));
});

test('a script that claims a human source is queued anyway, and is named in the manifest', () => {
  const t = tree();
  const id = ID(NAMES[0]);
  const def = db.get(NAMES[0])!;
  write(path.join(t.scriptsDir, shardOf(id), `${id}.json`), {
    oracleId: id, name: NAMES[0], oracleHash: oracleHash(def.oracleText), source: 'hand', abilities: [],
  } satisfies CardScript);
  (t.sources.scripts as ScriptStore).reset();
  const w = wave(t);
  assert.ok(queuedIds(w).includes(id), 'an unearned "hand" must not remove the card from the wave');
  assert.deepEqual(w.unearnedHumanSource, [{ oracleId: id, name: NAMES[0] }]);
  assert.deepEqual(w.manifest.unearnedHumanSource, [{ oracleId: id, name: NAMES[0] }]);
});

// ---------------------------------------------------------------------------
// The blind copy
// ---------------------------------------------------------------------------

test('the blind copy carries the facts and the rulings, and no AST at all', () => {
  const t = tree();
  const w = wave(t);
  for (const b of w.batches) {
    assert.equal(b.blind.cards.length, b.full.cards.length);
    assert.ok(!('vocabulary' in b.blind), 'the blind batch has no vocabulary excerpt');
    const json = JSON.stringify(b.blind);
    for (const key of BLIND_FORBIDDEN_KEYS) {
      assert.ok(!json.includes(`"${key}"`), `the blind batch leaks "${key}"`);
    }
    for (const [i, c] of b.blind.cards.entries()) {
      assert.equal(c.oracleId, b.full.cards[i].oracleId);
      assert.ok(Array.isArray(c.rulings), 'a blind card carries the card rulings');
      assert.ok(c.oracleText.length > 0 && c.unparsedLines.length > 0);
      for (const key of BLIND_FORBIDDEN_KEYS) assert.ok(!(key in c), `blind card ${c.name} has ${key}`);
    }
    // the AUTHOR's copy does carry them
    for (const c of b.full.cards) {
      assert.equal(c.parserDraft.oracleId, c.oracleId);
      assert.ok(Array.isArray(c.examples));
    }
  }
});

// ---------------------------------------------------------------------------
// Grouping, vocabulary and determinism
// ---------------------------------------------------------------------------

test('packFamilies keeps a family whole, splits only what is bigger than a batch, and bounds the mixing', () => {
  const g = (family: string, n: number) => ({ family: family as Family, cards: Array.from({ length: n }, (_, i) => `${family}${i}`) });
  // three small families, one batch
  assert.deepEqual(packFamilies([g('a', 2), g('b', 2), g('c', 2)], 10, 8), [['a0', 'a1', 'b0', 'b1', 'c0', 'c1']]);
  // a family is never split across a boundary just to fill a batch
  assert.deepEqual(packFamilies([g('a', 2), g('b', 2)], 3, 8), [['a0', 'a1'], ['b0', 'b1']]);
  // a family bigger than `size` fills batches of its own
  assert.deepEqual(packFamilies([g('a', 5)], 2, 8), [['a0', 'a1'], ['a2', 'a3'], ['a4']]);
  // and `maxFamilies` stops a wave's tail of singletons from being swept into one batch
  assert.deepEqual(packFamilies([g('a', 1), g('b', 1), g('c', 1)], 30, 2), [['a0', 'b0'], ['c0']]);
  assert.deepEqual(packFamilies([], 30, 8), []);
  // every card is emitted exactly once, in order
  const many = Array.from({ length: 17 }, (_, i) => g(`f${i}`, (i % 4) + 1));
  const flat = packFamilies(many, 6, 3).flat();
  assert.deepEqual(flat, many.flatMap(x => x.cards));
});

test('a batch carries the core vocabulary ONCE plus a section per family it spans', () => {
  const t = tree();
  const w = wave(t);
  assert.equal(w.batches.length, 1, 'five cards fit in one batch');
  const b = w.batches[0];
  assert.ok(b.families.length >= 4, `expected several families, got ${b.families.join(', ')}`);
  assert.match(b.family, /^mixed \(/);
  const v = b.full.vocabulary;
  assert.equal(v.split('## Core vocabulary').length - 1, 1, 'the ~13 KB core section must appear exactly once');
  assert.ok(v.startsWith('## Core vocabulary'));
  assert.ok(v.includes('| `draw` |'), 'the core effect table reaches every batch');
  for (const f of b.families) {
    const heading = f.startsWith('named-keyword:') ? '## Family — other' : `## Family — ${f}`;
    assert.ok(v.includes(heading), `${f} has no section in the excerpt`);
  }
});

test('--max-families cuts a mixed batch into single-family ones', () => {
  const t = tree();
  const w = wave(t, { maxFamilies: 1 });
  assert.ok(w.batches.length >= 4, `expected one batch per family, got ${w.batches.length}`);
  for (const b of w.batches) {
    assert.equal(b.families.length, 1);
    assert.equal(b.family, b.families[0]);
    assert.equal(b.full.vocabulary.split('## Core vocabulary').length - 1, 1);
  }
  assert.deepEqual(queuedIds(w), NAMES.map(ID).sort());
  // batch ids are contiguous and padded
  assert.deepEqual(w.batches.map(b => b.batch), w.batches.map((_, i) => String(i + 1).padStart(3, '0')));
});

test('two runs on the same tree produce identical bytes', () => {
  const t = tree();
  plantJudged(t, NAMES[0]);
  const a = JSON.stringify(wave(t), null, 2);
  const b = JSON.stringify(wave(t), null, 2);
  assert.equal(a, b);
  // the clock is the only thing that can differ, and it is an input
  const later = JSON.stringify(wave(t, { createdAt: '2027-01-01T00:00:00.000Z' }), null, 2);
  assert.notEqual(a, later);
  assert.equal(a.split('2026-03-01T00:00:00.000Z').join('2027-01-01T00:00:00.000Z'), later);
});

// ---------------------------------------------------------------------------
// unparsedLines
// ---------------------------------------------------------------------------

test('a back-face line is listed once, not twice', () => {
  // parse.ts already appends the back face's lines to def.unparsed with the "// " marker
  assert.deepEqual(unparsedLines({ unparsed: ['front', '// back'], backFace: { unparsed: ['back'] } as unknown as CardDef }), ['front', '// back']);
  // a back face the front never absorbed is still added
  assert.deepEqual(unparsedLines({ unparsed: ['front'], backFace: { unparsed: ['back'] } as unknown as CardDef }), ['front', '// back']);
  assert.deepEqual(unparsedLines({ unparsed: ['front'], backFace: undefined }), ['front']);
});

test('no real double-faced card in a wave repeats a line', () => {
  const dfc = db.db.prepare("SELECT oracle_id AS id FROM oracle_cards WHERE layout IN ('modal_dfc','transform') LIMIT 400").all() as { id: string }[];
  const t = tree();
  const w = wave(t, { ids: dfc.map(r => r.id), size: 400, maxFamilies: 999 });
  let withBackFace = 0;
  for (const b of w.batches) {
    for (const c of [...b.full.cards, ...b.blind.cards]) {
      if (c.unparsedLines.some(l => l.startsWith('// '))) withBackFace++;
      assert.deepEqual(c.unparsedLines, [...new Set(c.unparsedLines)], `${c.name} repeats a line`);
    }
  }
  assert.ok(withBackFace > 10, `expected back-face lines in the sample, saw ${withBackFace}`);
});
