// Per-card scripts: replace/extend modes, stale detection by oracle hash, source precedence, the sharded store,
// back faces, ignored lines, covers '*', scriptHash stability and the CardDB hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import {
  applyScript, ignoreLineProblem, normalizeOracleLines, oracleHash, scriptableLines, scriptHash, shardOf, ScriptStore,
  useScriptStore, type CardScript, type ScriptSource, type Verification,
} from '../src/cards/scripts.js';
import { CardScriptChecked } from '../src/cards/schema.js';
import { db } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-'));

test('applyScript: replace mode overrides abilities and clears unparsed; extend mode appends and covers lines; stale hashes are skipped', () => {
  const bears = db.get('Grizzly Bears')!;
  const base = { ...bears, unparsed: ['~ has an unmodelled line.'], fullyParsed: false };
  const script: CardScript = { oracleId: bears.oracleId, name: bears.name, oracleHash: oracleHash(bears.oracleText), source: 'hand', keywords: ['flying'], abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: ['haste'] }, text: 'scripted' }] };
  const r = applyScript(base, script);
  assert.deepEqual(r.keywords, ['flying']); assert.equal(r.abilities.length, 1); assert.equal(r.fullyParsed, true); assert.deepEqual(r.unparsed, []);
  assert.deepEqual(r.script, { applied: true, stale: false, source: 'hand', confidence: undefined });
  assert.equal(base.abilities.length, bears.abilities.length, 'input def untouched');
  const ext = applyScript(base, { ...script, mode: 'extend', keywords: ['haste'], covers: ['~ has an unmodelled line.'] });
  assert.ok(ext.keywords.includes('haste')); assert.equal(ext.abilities.length, base.abilities.length + 1); assert.equal(ext.fullyParsed, true);
  const stale = applyScript(base, { ...script, oracleHash: 'deadbeef' });
  assert.equal(stale.fullyParsed, false); assert.deepEqual(stale.script, { applied: false, stale: true, source: 'hand', confidence: undefined });
});

test('applyScript: ignore drops a line and stops it blocking fullyParsed; covers ["*"] clears every remaining line', () => {
  const bears = db.get('Grizzly Bears')!;
  const hash = oracleHash(bears.oracleText);
  const base = { ...bears, unparsed: ['Draft ~ face up.', 'Remove ~ from your deck before playing if you are not playing for ante.'], fullyParsed: false };

  const ignored = applyScript(base, {
    oracleId: bears.oracleId, name: bears.name, oracleHash: hash, source: 'hand', mode: 'extend',
    ignore: [{ line: 'Draft ~ face up.', reason: 'draft-matters' }, { line: 'Remove ~ from your deck before playing if you are not playing for ante.', reason: 'ante' }],
  });
  assert.deepEqual(ignored.unparsed, []);
  assert.equal(ignored.fullyParsed, true, 'an ignored line no longer blocks full simulation');

  const partly = applyScript(base, {
    oracleId: bears.oracleId, name: bears.name, oracleHash: hash, source: 'hand', mode: 'extend',
    ignore: [{ line: 'Draft ~ face up.', reason: 'draft-matters' }],
  });
  assert.deepEqual(partly.unparsed, ['Remove ~ from your deck before playing if you are not playing for ante.']);
  assert.equal(partly.fullyParsed, false);

  const star = applyScript(base, { oracleId: bears.oracleId, name: bears.name, oracleHash: hash, source: 'hand', mode: 'extend', covers: ['*'], abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: ['haste'] }, text: 'x' }] });
  assert.deepEqual(star.unparsed, [], 'covers ["*"] means every remaining unparsed line');
  assert.equal(star.fullyParsed, true);
});

test('applyScript: backFace is applied to def.backFace and clears the front face\'s "// " lines', () => {
  const delver = db.get('Delver of Secrets')!;
  assert.ok(delver.backFace, 'Delver of Secrets must have a parsed back face');

  const hunt = db.get('Huntmaster of the Fells')!;
  assert.ok(hunt.backFace, 'Huntmaster of the Fells must have a parsed back face');
  assert.ok(hunt.unparsed.some(u => u.startsWith('// ')), 'the front face carries the back face\'s unparsed lines');
  assert.equal(hunt.fullyParsed, false);

  const scripted = applyScript(hunt, {
    oracleId: hunt.oracleId, name: hunt.name, oracleHash: oracleHash(hunt.oracleText), source: 'hand', mode: 'replace',
    abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'gain-life', amount: 2, who: 'you' }], text: 'front' }],
    backFace: {
      keywords: ['trample'],
      abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'damage', amount: 2, target: { kind: 'opponent' } }], text: 'back' }],
    },
  });
  assert.equal(scripted.fullyParsed, true);
  assert.deepEqual(scripted.unparsed, []);
  assert.equal(scripted.backFace!.abilities.length, 1);
  assert.equal(scripted.backFace!.abilities[0].text, 'back');
  assert.deepEqual(scripted.backFace!.keywords, ['trample']);
  assert.equal(scripted.backFace!.fullyParsed, true);
  assert.equal(hunt.backFace!.abilities[0].text !== 'back', true, 'the input def is untouched');
});

test('normalizeOracleLines: whole lines, back-face lines as "// …", no duplicate entries anywhere in the pool', () => {
  for (const name of ['Delver of Secrets', 'Huntmaster of the Fells', 'Thing in the Ice']) {
    const d = db.get(name)!;
    const lines = new Set(normalizeOracleLines(d));
    for (const u of d.unparsed) assert.ok(lines.has(u.trim()), `${name}: unparsed line not produced by normalizeOracleLines: ${u}`);
    assert.ok(normalizeOracleLines(d).some(l => l.startsWith('// ')), `${name}: the back face's lines must be listed as "// …"`);
  }
  // a modal bullet used to be emitted twice (pushed as a line, then re-pushed by the bullet split)
  const all = new CardDB();
  let cards = 0, entries = 0;
  try {
    for (const d of all.all()) {
      if (cards++ % 7) continue;
      const lines = normalizeOracleLines(d);
      entries += lines.length;
      assert.equal(new Set(lines).size, lines.length, `${d.name}: normalizeOracleLines emitted a duplicate: ${JSON.stringify(lines)}`);
    }
  } finally { all.close(); }
  assert.ok(entries > 5000, `expected thousands of normalised lines, got ${entries}`);
});

test('scriptableLines names every entry the parser reports as unparsed — which normalizeOracleLines alone does not', () => {
  // parse.ts reports some clauses as sentence FRAGMENTS (parse.ts:1357 / :1401), so covers/ignore are validated
  // against scriptableLines = normalised lines ∪ def.unparsed ∪ the back face's own unparsed as "// …".
  const veil = db.get('Veil of Summer')!;
  const fragment = veil.unparsed.find(u => !normalizeOracleLines(veil).includes(u.trim()));
  assert.ok(fragment, 'Veil of Summer must still show the fragment normalizeOracleLines cannot reproduce');
  assert.ok(scriptableLines(veil).includes(fragment!.trim()), 'scriptableLines must name it');

  const all = new CardDB();
  let cards = 0, missing = 0, checked = 0;
  try {
    for (const d of all.all()) {
      if (cards++ % 7) continue;
      const lines = new Set(scriptableLines(d));
      for (const u of d.unparsed) { checked++; if (!lines.has(u.trim())) missing++; }
      for (const u of d.backFace?.unparsed ?? []) { checked++; if (!lines.has('// ' + u.trim())) missing++; }
    }
  } finally { all.close(); }
  assert.ok(checked > 2000, `expected thousands of unparsed entries, got ${checked}`);
  assert.equal(missing, 0, `${missing} of ${checked} unparsed entries are unnameable by a script`);
});

test('applyScript: a replace script that says nothing about the back face does not finish a double-faced card', () => {
  const hunt = db.get('Huntmaster of the Fells')!;
  assert.ok(hunt.backFace && !hunt.backFace.fullyParsed, 'Huntmaster\'s back face must start unfinished');
  const frontOnly = applyScript(hunt, {
    oracleId: hunt.oracleId, name: hunt.name, oracleHash: oracleHash(hunt.oracleText), source: 'hand', mode: 'replace',
    abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'gain-life', amount: 2, who: 'you' }], text: 'front' }],
  });
  assert.equal(frontOnly.fullyParsed, false, 'a card is fully simulated only when BOTH faces are');
  assert.equal(frontOnly.backFace!.fullyParsed, false);
  assert.ok(frontOnly.backFace!.unparsed.length > 0, 'the back face keeps its own unparsed lines');
});

test('applyScript: an empty authored script never marks a card fully simulated', () => {
  const bears = db.get('Grizzly Bears')!;
  const base = { ...bears, unparsed: ['~ has an unmodelled line.'], fullyParsed: false };
  for (const source of ['hand', 'reviewed', 'llm'] as ScriptSource[]) {
    for (const mode of ['replace', 'extend'] as const) {
      const empty = applyScript(base, { oracleId: bears.oracleId, name: bears.name, oracleHash: oracleHash(bears.oracleText), source, mode, notes: 'empty script' });
      assert.equal(empty.fullyParsed, false, `${source}/${mode}: an empty script declares nothing and must not finish the card`);
      assert.deepEqual(empty.unparsed, ['~ has an unmodelled line.']);
    }
  }
  // …but an ignore-only script still works, in either mode: the line stops blocking without anything being claimed
  const ante = { ...bears, unparsed: ['Remove ~ from your deck before playing if you are not playing for ante.'], fullyParsed: false };
  for (const mode of ['replace', 'extend'] as const) {
    const only = applyScript(ante, {
      oracleId: bears.oracleId, name: bears.name, oracleHash: oracleHash(bears.oracleText), source: 'hand', mode,
      ignore: [{ line: 'Remove ~ from your deck before playing if you are not playing for ante.', reason: 'ante' }],
    });
    assert.equal(only.fullyParsed, true, `${mode}: an ignore-only script finishes a card whose only gap is ignorable`);
  }
});

test("covers ['*'] is honoured in the mode the schema allows it in", () => {
  const bears = db.get('Grizzly Bears')!;
  const base: CardScript = { oracleId: bears.oracleId, name: bears.name, oracleHash: oracleHash(bears.oracleText), source: 'hand', covers: ['*'], abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: ['haste'] }, text: 'x' }] };
  assert.ok(CardScriptChecked.safeParse({ ...base, mode: 'extend' }).success, "mode 'extend' is where applyScript reads covers");
  assert.ok(!CardScriptChecked.safeParse({ ...base, mode: 'replace' }).success, "mode 'replace' clears every line anyway");
  assert.ok(!CardScriptChecked.safeParse(base).success, 'the default mode is replace, so bare "*" is rejected too');
  assert.ok(!CardScriptChecked.safeParse({ ...base, mode: 'replace', backFace: { covers: ['*'] } }).success);
  assert.ok(CardScriptChecked.safeParse({ ...base, mode: 'extend', backFace: { covers: ['*'] } }).success);
});

test('ignoreLineProblem: a simulable verb blocks a line unless the line proves its own reason', () => {
  // the ante and draft-matters reasons exist for lines that read exactly like this
  assert.equal(ignoreLineProblem('Discard your hand, ante the top card of your library, then draw seven cards.', 'ante'), null);
  assert.equal(ignoreLineProblem('As you draft a card, you may draft an additional card from that booster pack. If you do, put ~ into that booster pack.', 'draft-matters'), null);
  assert.equal(ignoreLineProblem('You may exile ~ from your hand. If you do, search for a card you own from outside the game.', 'outside-the-game'), null);
  assert.equal(ignoreLineProblem('A deck can have any number of cards named ~.', 'deck-construction'), null);
  assert.equal(ignoreLineProblem('Conjure a card into your hand.', 'digital-only'), null);
  assert.equal(ignoreLineProblem('Assemble a Contraption.', 'un-physical'), null);
  // …but the reason may not be used as a blanket excuse
  assert.ok(ignoreLineProblem('Destroy target creature.', 'draft-matters')?.includes('simulable verb'));
  assert.ok(ignoreLineProblem('Draw a card.', 'ante')?.includes('simulable verb'));
  assert.ok(ignoreLineProblem('You gain 3 life.', 'reminder-only')?.includes('simulable verb'), 'reminder-only has no marker exemption');
  // a line with no simulable verb at all is always fine
  assert.equal(ignoreLineProblem('Draft ~ face up.', 'draft-matters'), null);
  assert.equal(ignoreLineProblem('~ is every creature type.', 'reminder-only'), null);
});

test('ScriptStore: sharded layout, flat fallback, pathFor and the CardDB hook', () => {
  const dir = tmp();
  const store = new ScriptStore(dir);
  assert.equal(store.size(), 0);
  const bears = db.get('Grizzly Bears')!;
  const id = bears.oracleId;
  assert.equal(store.pathFor(id), path.join(dir, shardOf(id), `${id}.json`));
  assert.equal(shardOf(id), id.slice(0, 2).toLowerCase());

  const gen: CardScript = { oracleId: id, name: bears.name, oracleHash: oracleHash(bears.oracleText), source: 'generated', confidence: 0.5, keywords: ['trample'] };
  assert.ok(store.put(gen));
  assert.ok(fs.existsSync(store.pathFor(id)), 'put() writes into the shard');
  assert.equal(store.size(), 1);
  assert.deepEqual(store.ids(), [id]);

  // a flat file is still indexed
  const other = '9f3c0000-0000-0000-0000-000000000001';
  fs.writeFileSync(path.join(dir, `${other}.json`), JSON.stringify({ ...gen, oracleId: other, name: 'Flat Card' }, null, 2) + '\n');
  const reread = new ScriptStore(dir);
  assert.equal(reread.size(), 2);
  assert.equal(reread.get(other)!.name, 'Flat Card');
  assert.equal(reread.fileOf(other), path.join(dir, `${other}.json`));
  // …and put() migrates it into the shard
  assert.ok(reread.put({ ...gen, oracleId: other, name: 'Flat Card', source: 'hand' }));
  assert.ok(!fs.existsSync(path.join(dir, `${other}.json`)), 'the flat copy is removed');
  assert.equal(reread.fileOf(other), reread.pathFor(other));

  // CardDB applies the shared store
  useScriptStore(store);
  const fresh = new CardDB();
  try {
    const d = fresh.get('Grizzly Bears')!;
    assert.deepEqual(d.keywords, ['trample']); assert.ok(d.script?.applied);
    assert.equal(fresh.getByOracleId(id)!.keywords[0], 'trample');
  } finally { useScriptStore(null); fresh.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ScriptStore.put: precedence matrix hand > reviewed > llm > generated', () => {
  const dir = tmp();
  const store = new ScriptStore(dir);
  const id = '11110000-0000-0000-0000-000000000001';
  const of = (source: ScriptSource, verified = false): CardScript => ({
    oracleId: id, name: source, oracleHash: 'deadbeef', source,
    ...(verified ? { verification: verifiedBlock() } : {}),
  });
  const SOURCES: ScriptSource[] = ['generated', 'llm', 'reviewed', 'hand'];
  const rank = (s: ScriptSource) => SOURCES.indexOf(s);

  for (const existing of SOURCES) for (const next of SOURCES) for (const verified of [false, true]) {
    fs.rmSync(dir, { recursive: true, force: true });
    const s = new ScriptStore(dir);
    assert.ok(s.put(of(existing, verified)), 'the first write always lands');
    const expected = rank(next) > rank(existing) ? true
      : rank(next) < rank(existing) ? false
      : next !== 'llm' ? true
      : !verified;
    assert.equal(s.put(of(next)), expected, `${next} over ${existing}${verified ? ' (verified)' : ''}`);
    assert.equal(s.get(id)!.source, expected ? next : existing);
    assert.ok(s.put(of(next), { force: true }), 'force always wins');
  }

  // an llm script may overwrite an unverified llm script but not a verified one
  fs.rmSync(dir, { recursive: true, force: true });
  const s2 = new ScriptStore(dir);
  assert.ok(s2.put({ ...of('llm'), name: 'first' }));
  assert.ok(s2.put({ ...of('llm'), name: 'second' }));
  assert.equal(s2.get(id)!.name, 'second');
  assert.ok(s2.put({ ...of('llm', true), name: 'verified', verification: verifiedBlock() }, { force: true }));
  assert.ok(!s2.put({ ...of('llm'), name: 'third' }), 'a verified llm script is not overwritten by another llm script');
  assert.equal(s2.get(id)!.name, 'verified');
  store.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function verifiedBlock(status: Verification['status'] = 'verified'): Verification {
  return {
    at: '2026-09-04T00:00:00.000Z', parserVersion: 1, registryHash: 'r', oracleHash: 'deadbeef', scriptHash: 'h',
    schema: 'ok', lint: 'ok',
    sandbox: { seats2: 'ok', seats4: 'ok', abilities: [{ index: 0, reached: true }] },
    roundTrip: { score: 0.9, lowest: [] },
    scenarios: { file: 'x.json', passed: 1, failed: 0, names: ['x'] },
    status, problems: [],
  };
}

test('scriptHash: stable across key order, and unchanged by the verification block', () => {
  const a: CardScript = { oracleId: 'a', name: 'A', oracleHash: 'h', source: 'llm', mode: 'extend', covers: ['one', 'two'], keywords: ['flying'] };
  const reordered = JSON.parse(JSON.stringify({ keywords: a.keywords, covers: a.covers, mode: a.mode, source: a.source, oracleHash: a.oracleHash, name: a.name, oracleId: a.oracleId })) as CardScript;
  assert.equal(scriptHash(reordered), scriptHash(a), 'key order must not change the hash');

  assert.equal(scriptHash({ ...a, verification: verifiedBlock() }), scriptHash(a), 'the verification block is excluded');
  assert.equal(scriptHash({ ...a, verification: verifiedBlock('judged') }), scriptHash(a));

  assert.notEqual(scriptHash({ ...a, covers: ['one'] }), scriptHash(a), 'a real change moves the hash');
  assert.notEqual(scriptHash({ ...a, notes: 'x' }), scriptHash(a));
  assert.equal(scriptHash({ ...a, confidence: undefined }), scriptHash(a), 'explicit undefined is not a change');
});
