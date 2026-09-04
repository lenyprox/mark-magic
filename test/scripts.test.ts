// Per-card scripts: replace/extend modes, stale detection by oracle hash, precedence (generated never overwrites
// reviewed), and the CardDB hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { applyScript, oracleHash, ScriptStore, useScriptStore, type CardScript } from '../src/cards/scripts.js';
import { db } from './helpers.js';

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

test('ScriptStore: index, put precedence and the CardDB hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-'));
  const store = new ScriptStore(dir);
  assert.equal(store.size(), 0);
  const bears = db.get('Grizzly Bears')!;
  const gen: CardScript = { oracleId: bears.oracleId, name: bears.name, oracleHash: oracleHash(bears.oracleText), source: 'generated', confidence: 0.5, keywords: ['trample'] };
  assert.ok(store.put(gen)); assert.equal(store.size(), 1);
  const hand: CardScript = { ...gen, source: 'hand', keywords: ['flying'] };
  assert.ok(store.put(hand)); assert.deepEqual(store.get(bears.oracleId)!.keywords, ['flying']);
  assert.ok(!store.put(gen), 'a generated script never overwrites a hand one');
  assert.ok(store.put(gen, { force: true }));
  // CardDB applies the shared store
  useScriptStore(store);
  const fresh = new CardDB();
  try {
    const d = fresh.get('Grizzly Bears')!;
    assert.deepEqual(d.keywords, ['trample']); assert.ok(d.script?.applied);
    assert.equal(fresh.getByOracleId(bears.oracleId)!.keywords[0], 'trample');
  } finally { useScriptStore(null); fresh.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
