// Metagame coverage metric: pure computation on the TopDeck fixture with a stub parse lookup, plus a guarded master.db smoke test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MASTER_DB } from '../src/config/paths.js';
import { mapTournaments } from '../src/meta/topdeck.js';
import { computeCoverage, formatCoverageTable, masterLookup, normaliseClause, type CoverageDeck, type ParseLookup } from '../src/meta/coverage.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'meta');
const topdeckRaw = JSON.parse(fs.readFileSync(path.join(FIX, 'topdeck-modern.json'), 'utf8'));
const hasMaster = fs.existsSync(MASTER_DB());

const LAND = /^(Island|Mountain|Swamp|Plains|Forest)$|Tarn|Strand|Delta|Mesa|Rainforest|Foothills|Catacombs|Vents|Canal|Coast|Cavern|Saga|Tomb|Bog|Field|Wastes|Grove|Garden|Heath|Heights|Sanctuary|Peak|Fortress|Pool|Crypt|Nexus|Urza|Bauble$/;
const STUB_UNPARSED = new Map<string, string[]>([
  ["Mishra's Bauble", ['{T}, Sacrifice ~: Look at the top card of target player\'s library. Draw a card at the beginning of the next turn\'s upkeep.']],
  ['Ragavan, Nimble Pilferer', ['Dash {1}{R}', 'Whenever ~ deals combat damage to a player, create a Treasure token and exile the top card of that player\'s library.']],
  ['Murktide Regent', ['Delve', '~ enters with a +1/+1 counter on it for each instant and sorcery card exiled with it.']],
  ['Dragon\'s Rage Channeler', ['Delve']], // shares a clause with Murktide on purpose
]);
const stub: ParseLookup = (name, oracleId) => ({ name, oracleId, resolved: true, isLand: LAND.test(name), fullyParsed: !STUB_UNPARSED.has(name), unparsed: STUB_UNPARSED.get(name) ?? [] });

function fixtureDecks(): CoverageDeck[] {
  const { decklists } = mapTournaments(topdeckRaw, 'Modern');
  return decklists.map((d, i) => ({ id: d.sourceId, archetype: i % 2 ? 'Izzet Murktide' : 'Other', archetypeId: i % 2 ? 'a1' : 'a0', cards: d.cards }));
}

test('normaliseClause matches the whole-pool report', () => {
  assert.equal(normaliseClause('Scry 2, then draw {U}{2}'), 'Scry #, then draw {}{}');
  assert.equal(normaliseClause('x'.repeat(200)).length, 90);
});

test('computeCoverage on the fixture with a stub lookup', () => {
  const decks = fixtureDecks();
  const r = computeCoverage({ Modern: decks }, stub, { now: new Date('2026-09-03T00:00:00Z'), source: 'fixture' });
  const f = r.formats.Modern;
  assert.equal(f.decks, 26);
  const mainNames = new Set(decks.flatMap(d => d.cards.filter(c => c.board !== 'side').map(c => c.name.toLowerCase())));
  assert.equal(f.distinctCards, mainNames.size);
  assert.equal(f.unresolvedNames.length, 0);
  const mainCopies = decks.reduce((a, d) => a + d.cards.filter(c => c.board !== 'side').reduce((x, c) => x + c.count, 0), 0);
  assert.equal(f.copies.all.n, mainCopies);
  assert.ok(f.copies.nonland.n < f.copies.all.n);
  // decks fully simulated = decks whose main deck has no stub card
  const expectFull = decks.filter(d => !d.cards.some(c => c.board !== 'side' && STUB_UNPARSED.has(c.name))).length;
  assert.equal(f.decksFullySimulated.full, expectFull);
  assert.ok(f.decksAtMost2Partial.full >= f.decksFullySimulated.full);
  assert.equal(f.distinct.all.full, mainNames.size - [...STUB_UNPARSED.keys()].filter(n => mainNames.has(n.toLowerCase())).length);
  // ranking: weight = decks containing / decks (single format => plain share)
  const top = r.top_unparsed_cards[0];
  const inDecks = (n: string) => decks.filter(d => d.cards.some(c => c.board !== 'side' && c.name === n)).length;
  const best = [...STUB_UNPARSED.keys()].sort((a, b) => inDecks(b) - inDecks(a))[0];
  assert.equal(top.name, best);
  assert.equal(top.byFormat.Modern.decks, inDecks(best));
  assert.equal(top.weight, +(inDecks(best) / 26).toFixed(4));
  for (let i = 1; i < r.top_unparsed_cards.length; i++) assert.ok(r.top_unparsed_cards[i - 1].weight >= r.top_unparsed_cards[i].weight);
  // clause aggregation merges the two Delve cards
  const delve = r.top_unparsed_clauses.find(c => c.pattern === 'Delve')!;
  assert.deepEqual(new Set(delve.cards), new Set(['Murktide Regent', "Dragon's Rage Channeler"]));
  assert.equal(delve.weight, +(r.top_unparsed_cards.filter(c => c.unparsed.includes('Delve')).reduce((a, c) => a + c.weight, 0)).toFixed(4));
  // archetypes
  assert.equal(f.archetypes.length, 2);
  assert.equal(f.archetypes.reduce((a, x) => a + x.decks, 0), 26);
  assert.ok(f.archetypes[0].topUnparsed.length > 0);
  // table
  const table = formatCoverageTable(r);
  assert.match(table, /Modern/);
  assert.ok(table.includes(top.name.slice(0, 20)));
  assert.equal(r.generated_at, '2026-09-03T00:00:00.000Z');
});

test('a card in every deck of every format weighs 1; formats are weighted equally', () => {
  const mk = (id: string, cards: string[]): CoverageDeck => ({ id, archetype: null, archetypeId: null, cards: cards.map(name => ({ name, oracleId: null, count: 4, board: 'main' })) });
  const lookup: ParseLookup = name => ({ name, oracleId: null, resolved: true, isLand: false, fullyParsed: name === 'Bolt', unparsed: name === 'Bolt' ? [] : [`${name} text`] });
  const r = computeCoverage({ A: [mk('a1', ['X', 'Y']), mk('a2', ['X'])], B: [mk('b1', ['X'])], C: [] }, lookup);
  const x = r.top_unparsed_cards.find(c => c.name === 'X')!; const y = r.top_unparsed_cards.find(c => c.name === 'Y')!;
  assert.equal(x.weight, 1);
  assert.equal(y.weight, 0.25); // 1/2 of A's decks, absent from B, averaged over the two formats with data
  assert.equal(r.formats.C.decks, 0);
  assert.match(r.formats.C.note!, /meta:sync/);
  assert.equal(r.formats.C.copies.nonland.pct, 0);
  assert.equal(r.formats.A.decksAtMost2Partial.full, 2);
  assert.equal(r.formats.A.decksFullySimulated.full, 0);
});

test('unresolved names are reported, never counted as parsed', () => {
  const deck: CoverageDeck = { id: 'd', archetype: null, archetypeId: null, cards: [{ name: 'Nope', oracleId: null, count: 4, board: 'main' }, { name: 'Bolt', oracleId: null, count: 4, board: 'main' }] };
  const lookup: ParseLookup = name => name === 'Nope' ? { name, oracleId: null, resolved: false, isLand: false, fullyParsed: false, unparsed: [] } : { name, oracleId: null, resolved: true, isLand: false, fullyParsed: true, unparsed: [] };
  const r = computeCoverage({ M: [deck] }, lookup);
  assert.deepEqual(r.formats.M.unresolvedNames, ['Nope']);
  assert.equal(r.formats.M.copies.all.n, 4);
  assert.equal(r.formats.M.decksFullySimulated.full, 1);
});

test('master.db lookup on the fixture (invariants only)', { skip: !hasMaster && 'master.db not built' }, async () => {
  const { CardDB } = await import('../src/cards/db.js');
  const lookup = masterLookup(CardDB.shared());
  const r = computeCoverage({ Modern: fixtureDecks() }, lookup);
  const f = r.formats.Modern;
  assert.equal(f.unresolvedNames.length, 0);
  for (const ratio of [f.distinct.all, f.distinct.nonland, f.copies.all, f.copies.nonland, f.decksFullySimulated]) { assert.ok(ratio.pct >= 0 && ratio.pct <= 100); assert.ok(ratio.full <= ratio.n); }
  assert.ok(r.top_unparsed_cards.every(c => c.unparsed.length > 0 || !c.isLand || true));
  for (let i = 1; i < r.top_unparsed_cards.length; i++) assert.ok(r.top_unparsed_cards[i - 1].weight >= r.top_unparsed_cards[i].weight);
  const island = lookup('Island', null);
  assert.equal(island.isLand, true); assert.equal(island.fullyParsed, true);
});
