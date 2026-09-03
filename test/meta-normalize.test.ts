// Card-name and archetype-name normalisation for the metagame layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MASTER_DB } from '../src/config/paths.js';
import { archetypeKey, canonicalArchetypeName, cleanCardName, isLandDef, isLandTypeLine, NameResolver, normalizeBoard, normalizeCards, resolveCardName, slugify } from '../src/meta/normalize.js';
import { canonicalFormat } from '../src/meta/types.js';

const hasMaster = fs.existsSync(MASTER_DB());

test('cleanCardName strips Arena decorations, foil markers and the Alchemy prefix', () => {
  assert.equal(cleanCardName('4 Lightning Bolt (M10) 146'), 'Lightning Bolt');
  assert.equal(cleanCardName('Lightning Bolt (2X2) 117 *F*'), 'Lightning Bolt');
  assert.equal(cleanCardName('A-Alrund’s Epiphany'), "Alrund's Epiphany");
  assert.equal(cleanCardName('Fire /// Ice'), 'Fire // Ice');
  assert.equal(cleanCardName('Fire//Ice'), 'Fire // Ice');
  assert.equal(cleanCardName('  Ragavan,   Nimble Pilferer  '), 'Ragavan, Nimble Pilferer');
  assert.equal(cleanCardName('1x Boseiju, Who Endures (NEO) 266'), 'Boseiju, Who Endures');
  assert.equal(cleanCardName('Abrade'), 'Abrade'); // "A-" only strips when followed by a capital after the hyphen
});

test('archetype names canonicalise and key consistently', () => {
  assert.equal(canonicalArchetypeName('Izzet Murktide decks'), 'Izzet Murktide');
  assert.equal(canonicalArchetypeName('  U/R  Delver (Paper) '), 'UR Delver');
  assert.equal(archetypeKey('Mono White Humans'), archetypeKey('mono-white humans'));
  assert.equal(archetypeKey("Hammer Time"), 'hammer time');
  assert.equal(slugify('Ragavan, Nimble Pilferer / Murktide Regent'), 'ragavan-nimble-pilferer-murktide-regent');
  assert.equal(canonicalFormat('commander'), 'EDH'); assert.equal(canonicalFormat('modern'), 'Modern'); assert.equal(canonicalFormat('draft'), null);
  assert.equal(normalizeBoard('Sideboard'), 'side'); assert.equal(normalizeBoard('Commanders'), 'commander'); assert.equal(normalizeBoard(undefined), 'main');
});

test('normalizeCards merges duplicates per board without a card DB', () => {
  const cards = normalizeCards(null, [{ name: '2 Lightning Bolt (M10) 146', count: 2 }, { name: 'Lightning Bolt', count: 2 }, { name: 'Lightning Bolt', count: 1, board: 'side' }, { name: 'Nothing', count: 0 }]);
  assert.deepEqual(cards, [{ name: 'Lightning Bolt', oracleId: null, count: 4, board: 'main' }, { name: 'Lightning Bolt', oracleId: null, count: 1, board: 'side' }]);
});

test('resolveCardName maps decorated and front-face names to oracle ids (master.db)', { skip: !hasMaster }, async () => {
  const { CardDB } = await import('../src/cards/db.js');
  const db = CardDB.shared();
  const bolt = resolveCardName(db, '4 Lightning Bolt (M10) 146');
  assert.equal(bolt.name, 'Lightning Bolt'); assert.ok(bolt.oracleId);
  const fire = resolveCardName(db, 'Fire');
  assert.equal(fire.name, 'Fire // Ice'); assert.equal(fire.oracleId, resolveCardName(db, 'Fire // Ice').oracleId);
  const delver = resolveCardName(db, 'Delver of Secrets');
  assert.ok(delver.oracleId); assert.ok(delver.name.startsWith('Delver of Secrets'));
  assert.equal(resolveCardName(db, 'Not A Real Card Name 123').oracleId, null);
  assert.equal(isLandDef(db.get('Steam Vents')), true);
  assert.equal(isLandDef(db.get('Lightning Bolt')), false);
  assert.equal(isLandDef(db.get('Dryad Arbor')), false); // land creatures count as spells for clustering
  const merged = normalizeCards(db, [{ name: 'Fire', count: 1 }, { name: 'Fire // Ice', count: 1 }]);
  assert.equal(merged.length, 1); assert.equal(merged[0].count, 2); assert.equal(merged[0].name, 'Fire // Ice');
});

test('NameResolver: indexed exact/front-face lookups agree with CardDB.get and are fast (master.db)', { skip: !hasMaster }, async () => {
  const { CardDB } = await import('../src/cards/db.js');
  const db = CardDB.shared();
  const r = new NameResolver(db);
  assert.equal(r.resolve('4 Lightning Bolt (M10) 146').oracleId, db.get('Lightning Bolt')!.oracleId);
  assert.equal(r.resolve('Fire').name, 'Fire // Ice');
  assert.equal(r.resolve('Fire').oracleId, db.get('Fire // Ice')!.oracleId);
  assert.equal(r.resolve('lightning bolt').oracleId, db.get('Lightning Bolt')!.oracleId, 'case variants fall back to CardDB.get');
  assert.equal(r.resolve('Delver of Secrets').name, db.get('Delver of Secrets')!.name);
  assert.equal(r.isLand('Steam Vents'), true); assert.equal(r.isLand('Urza\'s Saga'), true); assert.equal(r.isLand('Dryad Arbor'), false); assert.equal(r.isLand('Lightning Bolt'), false);
  assert.equal(r.resolve('No Such Card Zzz').oracleId, null);
  assert.equal(isLandTypeLine('Sorcery // Land'), false); assert.equal(isLandTypeLine('Land — Island'), true); assert.equal(isLandTypeLine(null), false);
  const names = ['Ragavan, Nimble Pilferer', 'Murktide Regent', 'Counterspell', 'Consider', 'Steam Vents', 'Scalding Tarn', 'Colossus Hammer', 'Amulet of Vigor', 'Primeval Titan', 'Tolaria West', 'Boseiju, Who Endures', 'Wear // Tear', 'Wear', 'Plains', 'Island', 'Urza\'s Saga', 'Expressive Iteration', 'Unholy Heat', 'Esper Sentinel', 'Sigarda\'s Aid'];
  const t0 = Date.now();
  for (const n of names) assert.ok(r.resolve(n).oracleId, n);
  assert.ok(Date.now() - t0 < 2000, `20 indexed lookups took ${Date.now() - t0} ms`);
  const cards = r.normalize([{ name: 'Fire', count: 2 }, { name: 'Fire // Ice', count: 1, board: 'main' }, { name: 'Wear', count: 1, board: 'Sideboard' }]);
  assert.deepEqual(cards.map(c => [c.name, c.count, c.board]), [['Fire // Ice', 3, 'main'], ['Wear // Tear', 1, 'side']]);
});
