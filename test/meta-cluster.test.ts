// Archetype clustering on the synthetic TopDeck fixture (3 archetypes + outliers), Goldfish name attachment, stable ids, sampling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agglomerate, cardStats, clusterDecks, mulberry32, sampleDeckFromProfile, type ClusterDeck } from '../src/meta/cluster.js';
import { parseGoldfishArchetypePage, parseGoldfishMetagame } from '../src/meta/goldfish.js';
import { mapTournaments } from '../src/meta/topdeck.js';
import type { ArchetypeProfile } from '../src/meta/types.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'meta');
const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'topdeck-modern.json'), 'utf8'));
const LANDS = new Set(['Steam Vents', 'Scalding Tarn', 'Island', 'Mountain', 'Spirebluff Canal', 'Flooded Strand', 'Misty Rainforest', 'Plains', 'Inkmoth Nexus', "Urza's Saga", 'Silent Clearing', 'Seachrome Coast',
  'Simic Growth Chamber', 'Gruul Turf', 'Boros Garrison', 'Forest', 'Tolaria West', 'Valakut, the Molten Pinnacle', 'Boseiju, Who Endures', "Slayers' Stronghold", 'Vesuva', 'Castle Garenbrig', 'Sacred Foundry', 'Arid Mesa',
  'Inspiring Vantage', 'Bloodstained Mire', 'Blood Crypt', 'Marsh Flats', 'Swamp', 'Verdant Catacombs', 'Bojuka Bog', 'Cavern of Souls']);
const isLand = (n: string) => LANDS.has(n);
// The intended key cards of each fixture archetype (signatures must be drawn from these).
const MURKTIDE_CORE = new Set(['Ragavan, Nimble Pilferer', 'Murktide Regent', "Dragon's Rage Channeler", 'Lightning Bolt', 'Counterspell', 'Expressive Iteration', 'Unholy Heat', 'Consider', "Mishra's Bauble"]);
const HAMMER_CORE = new Set(['Colossus Hammer', "Sigarda's Aid", 'Puresteel Paladin', 'Stoneforge Mystic', 'Esper Sentinel', 'Giver of Runes', 'Ornithopter', 'Memnite', 'Springleaf Drum']);
const AMULET_CORE = new Set(['Amulet of Vigor', 'Primeval Titan', 'Dryad of the Ilysian Grove', 'Azusa, Lost but Seeking', "Summoner's Pact", 'Arboreal Grazer', 'Explore', 'Cultivator Colossus']);
const hasCard = (a: { cards: { name: string; board: string; pIn: number }[] }, name: string) => a.cards.some(c => c.board === 'main' && c.name === name && c.pIn === 1);

function decks(): ClusterDeck[] {
  const { decklists } = mapTournaments(raw, 'Modern');
  return decklists.map(d => ({ id: d.sourceId, cards: d.cards, wins: d.wins, losses: d.losses, draws: d.draws, deckSize: d.deckSize }));
}
const goldfish = () => {
  const list = parseGoldfishMetagame(fs.readFileSync(path.join(FIX, 'goldfish-metagame.html'), 'utf8'));
  list[0].sampleList = parseGoldfishArchetypePage(fs.readFileSync(path.join(FIX, 'goldfish-archetype.html'), 'utf8'));
  return list;
};

test('agglomerate: average linkage merges above the threshold only', () => {
  const pts = [[1, 0], [0.98, 0.2], [0, 1], [0.1, 0.99], [0.7, 0.7]];
  const sim = (i: number, j: number) => { const [a, b] = [pts[i], pts[j]]; const d = a[0] * b[0] + a[1] * b[1]; return d / (Math.hypot(...a) * Math.hypot(...b)); };
  const r = agglomerate(5, sim, 0.95);
  assert.equal(r.clusters.length, 3);
  assert.deepEqual(r.clusters.map(c => c.slice().sort()).sort((a, b) => a[0] - b[0]), [[0, 1], [2, 3], [4]]);
  assert.equal(agglomerate(0, () => 0, 0.5).clusters.length, 0);
});

test('clusterDecks finds the three fixture archetypes, names them by signature, shares sum to 1', () => {
  const r = clusterDecks(decks(), { format: 'Modern', isLand });
  const named = r.archetypes.filter(a => !a.isOther);
  assert.equal(named.length, 3, JSON.stringify(r.archetypes.map(a => [a.name, a.deckCount])));
  assert.ok(named.every(a => a.deckCount === 8));
  const sigs = named.map(a => a.signature);
  const cores = [MURKTIDE_CORE, HAMMER_CORE, AMULET_CORE];
  for (const core of cores) assert.ok(sigs.some(s => s.every(c => core.has(c))), `a signature drawn from ${[...core].slice(0, 2)}...`);
  assert.ok(sigs.every(s => s.length === 3 && s.every(c => !isLand(c))));
  const other = r.archetypes.find(a => a.isOther)!;
  assert.equal(other.deckCount, 2); assert.equal(other.name, 'Other');
  const total = r.archetypes.reduce((a, x) => a + x.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(r.assignment.size, 26);
  for (const a of named) { assert.ok(a.winRate! > 0 && a.winRate! < 1); assert.equal(a.deckSize, 60); assert.equal(a.name, a.signature.join(' / ')); }
  // per-card distributions
  const murk = named.find(a => hasCard(a, 'Murktide Regent'))!;
  const regent = murk.cards.find(c => c.board === 'main' && c.name === 'Murktide Regent')!;
  assert.equal(regent.pIn, 1); assert.equal(regent.expectedCount, 4); assert.deepEqual(regent.countDist, [0, 0, 0, 0, 1]);
  const moon = murk.cards.find(c => c.board === 'side' && c.name === 'Blood Moon')!;
  assert.ok(moon.pIn > 0.9);
  for (const c of murk.cards) assert.ok(Math.abs(c.countDist.reduce((a, b) => a + b, 0) - 1) < 1e-4);
});

test('Goldfish names attach one-to-one (sample-list similarity and name tokens) and ids stay stable across runs', () => {
  const gf = goldfish();
  const r1 = clusterDecks(decks(), { format: 'Modern', isLand, goldfish: gf });
  const names = r1.archetypes.filter(a => !a.isOther).map(a => a.name).sort();
  assert.deepEqual(names, ['Amulet Titan', 'Hammer Time', 'Izzet Murktide']);
  const murk = r1.archetypes.find(a => a.name === 'Izzet Murktide')!;
  assert.equal(murk.goldfishShare, 0.124); assert.ok(murk.url!.includes('/archetype/modern-izzet-murktide'));
  assert.ok(r1.archetypes.every(a => a.id.startsWith('modern:')));
  // A re-run with the previous archetypes keeps the ids even without Goldfish names; a shuffled input order too.
  const prev = r1.archetypes.map(a => ({ id: a.id, signature: a.signature }));
  const shuffled = decks().reverse();
  const r2 = clusterDecks(shuffled, { format: 'Modern', isLand, previous: prev });
  const ids1 = r1.archetypes.filter(a => !a.isOther).map(a => a.id).sort();
  const ids2 = r2.archetypes.filter(a => !a.isOther).map(a => a.id).sort();
  assert.deepEqual(ids2, ids1);
  const byId = new Map(r1.archetypes.map(a => [a.id, a]));
  for (const a of r2.archetypes) assert.deepEqual(a.memberIds.slice().sort(), byId.get(a.id)!.memberIds.slice().sort());
});

test('sampleDeckFromProfile honours seen cards and the deck size, with and without sample lists', () => {
  const r = clusterDecks(decks(), { format: 'Modern', isLand });
  const murk = r.archetypes.find(a => hasCard(a, 'Murktide Regent'))!;
  const ds = decks().filter(d => murk.memberIds.includes(d.id));
  const profile: ArchetypeProfile = {
    id: murk.id, format: 'Modern', name: murk.name, signature: murk.signature, metaShare: murk.share, winRate: murk.winRate, deckCount: murk.deckCount, deckSize: 60,
    cards: murk.cards.map(c => ({ name: c.name, pIn: c.pIn, expectedCount: c.expectedCount, countDist: c.countDist, board: c.board })),
    sampleLists: ds.map(d => d.cards.filter(c => c.board === 'main').map(c => ({ name: c.name, count: c.count }))),
  };
  const seen = { 'Murktide Regent': 4, 'Brazen Borrower': 3, 'Subtlety': 2 };
  const a = sampleDeckFromProfile(profile, seen, mulberry32(7), ds.map(d => (d.wins ?? 0) + 1));
  const b = sampleDeckFromProfile(profile, seen, mulberry32(7), ds.map(d => (d.wins ?? 0) + 1));
  assert.deepEqual(a, b, 'same seed, same list');
  const count = (l: { name: string; count: number }[], n: string) => l.find(c => c.name === n)?.count ?? 0;
  assert.equal(a.reduce((s, c) => s + c.count, 0), 60);
  assert.ok(count(a, 'Murktide Regent') >= 4 && count(a, 'Brazen Borrower') >= 3 && count(a, 'Subtlety') >= 2);
  const noLists = sampleDeckFromProfile({ ...profile, sampleLists: undefined }, { 'Ragavan, Nimble Pilferer': 4 }, mulberry32(3));
  assert.equal(noLists.reduce((s, c) => s + c.count, 0), 60);
  assert.ok(count(noLists, 'Ragavan, Nimble Pilferer') >= 4);
  assert.ok(noLists.every(c => profile.cards.some(p => p.board === 'main' && p.name === c.name)));
  // cardStats on an empty member set is safe
  assert.deepEqual(cardStats([]), []);
});
