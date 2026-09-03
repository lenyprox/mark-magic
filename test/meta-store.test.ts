// MetaStore round trips on a temp user.db and MetaService end to end with injected fetch (TopDeck + Goldfish + 17lands fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MASTER_DB } from '../src/config/paths.js';
import { openUserDb } from '../src/user/db.js';
import { DeckStore } from '../src/user/decks.js';
import { MetaStore } from '../src/meta/store.js';
import { MetaService } from '../src/meta/service.js';
import { parseSources, runSync } from '../src/meta/sync.js';
import { mapTournaments, TOPDECK_API } from '../src/meta/topdeck.js';
import type { CardDB } from '../src/cards/db.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'meta');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const topdeckRaw = JSON.parse(read('topdeck-modern.json'));
const hasMaster = fs.existsSync(MASTER_DB());
const noSleep = async () => {};
let cards: CardDB | null = null;
if (hasMaster) cards = (await import('../src/cards/db.js')).CardDB.shared();

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-meta-store-'));
  const db = openUserDb(path.join(dir, 'user.db'));
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Serves every fixture from memory; records requests. */
function fakeFetch() {
  const hits: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url); hits.push(u);
    if (u === TOPDECK_API) return new Response(JSON.stringify(topdeckRaw), { status: 200, headers: { 'content-type': 'application/json' } });
    const p = new URL(u).pathname;
    if (p === '/robots.txt') return new Response('User-agent: *\nDisallow: /deck/download/\n', { status: 200 });
    if (p === '/metagame/modern/full') return new Response(read('goldfish-metagame.html'), { status: 200 });
    if (p === '/archetype/modern-izzet-murktide-xyz12') return new Response(read('goldfish-archetype.html'), { status: 200 });
    if (p === '/card_ratings/data') return new Response(read('seventeenlands-ratings.json'), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, hits };
}

test('MetaStore: events/decklists upsert idempotently, archetypes replace per format, sync log', () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new MetaStore(db);
    const mapped = mapTournaments(topdeckRaw, 'Modern');
    assert.equal(store.upsertEvents(mapped.events), 2);
    const first = store.upsertDecklists(mapped.decklists);
    assert.deepEqual(first, { inserted: 26, updated: 0 });
    const second = store.upsertDecklists(mapped.decklists);
    assert.deepEqual(second, { inserted: 0, updated: 26 });
    const lists = store.decklists('Modern');
    assert.equal(lists.length, 26); assert.equal(lists[0].date, '2026-08-17', 'newest first'); assert.equal(lists[0].eventName, 'Fixture Modern Open 2');
    const one = store.decklist('topdeck:fixture-modern-1:p1')!;
    assert.equal(one.player, 'Alice'); assert.equal(one.cards.length > 20, true); assert.equal(one.deckSize, 60);
    assert.equal(store.decklists('Modern', { sinceDays: 1 }).length, 0, 'window filter by event date');
    assert.equal(store.decklists('Legacy').length, 0);
    assert.ok(store.distinctCardNames('Modern').some(c => c.name === 'Murktide Regent'));
    // archetypes
    store.replaceArchetypes('Modern', [{ id: 'modern:test', name: 'Test', signature: ['A', 'B', 'C'], share: 1, deckCount: 2, wins: 5, losses: 1, winRate: 5 / 6, deckSize: 60, goldfishName: null, goldfishShare: null, url: null, isOther: false, memberIds: [lists[0].id, lists[1].id],
      cards: [{ name: 'A', oracleId: null, board: 'main', pIn: 1, expectedCount: 4, countDist: [0, 0, 0, 0, 1] }] }], new Map([[lists[0].id, 'modern:test'], [lists[1].id, 'modern:test']]), 30);
    assert.equal(store.archetypes('Modern').length, 1);
    assert.equal(store.archetype('modern:test')!.winRate, 5 / 6); assert.equal(store.archetype('modern:test')!.windowDays, 30);
    assert.deepEqual(store.archetypeCards('modern:test')[0].countDist, [0, 0, 0, 0, 1]);
    assert.equal(store.memberDecks('modern:test').length, 2);
    assert.equal(store.decklist(lists[0].id)!.archetype, 'Test');
    assert.deepEqual(store.previousSignatures('Modern'), [{ id: 'modern:test', signature: ['A', 'B', 'C'] }]);
    store.replaceArchetypes('Modern', [], new Map(), 30);
    assert.equal(store.archetypes('Modern').length, 0); assert.equal(store.archetypeCards('modern:test').length, 0, 'cards cascade');
    assert.equal(store.decklist(lists[0].id)!.archetypeId, null);
    // sync log
    assert.equal(store.lastSync('topdeck', 'Modern'), null);
    store.logSync({ source: 'topdeck', format: 'Modern', startedAt: 'a', finishedAt: 'b', ok: false, message: 'nope' });
    assert.equal(store.lastSync('topdeck', 'Modern'), null, 'only successful syncs by default');
    assert.equal(store.lastSync('topdeck', 'Modern', false)!.message, 'nope');
    store.logSync({ source: 'topdeck', format: 'Modern', startedAt: 'a', finishedAt: 'c', ok: true, message: 'yes' });
    assert.equal(store.lastSync('topdeck', 'Modern')!.finishedAt, 'c');
    assert.equal(store.syncLog().length, 2);
    // card stats
    assert.equal(store.upsertCardStats('17lands', 'PremierDraft', 'blb', [{ name: 'X', oracleId: null, gameCount: 1, everDrawnWinRate: 0.5, openingHandWinRate: null, drawnWinRate: null, gihWinRate: 0.5, avgSeen: null, avgPick: null, color: 'R', rarity: 'common' }]), 1);
    assert.equal(store.cardStats('17lands', 'PremierDraft', 'BLB').ratings[0].name, 'X');
  } finally { cleanup(); }
});

test('MetaService.refresh: TopDeck + Goldfish fixtures -> named archetypes, 24 h skip, force re-runs with stable ids', async () => {
  const { db, cleanup } = tempDb();
  try {
    let clock = Date.parse('2026-09-03T12:00:00Z');
    const { fetchImpl, hits } = fakeFetch();
    const svc = new MetaService({ user: db, cards, fetchImpl, sleep: noSleep, env: { TOPDECK_API_KEY: 'k', META_GOLDFISH_ENABLED: '1' }, now: () => clock });
    assert.equal(svc.configured(), true); assert.equal(svc.goldfishEnabled(), true);
    const r = await svc.refresh('Modern', { windowDays: 30 });
    assert.equal(r.ok, true, JSON.stringify(r.reports));
    const td = r.reports.find(x => x.source === 'topdeck')!;
    assert.equal(td.counts.decklists, 26); assert.equal(td.counts.skippedUrlOnly, 1); assert.equal(td.counts.events, 2);
    const gf = r.reports.find(x => x.source === 'goldfish')!;
    assert.equal(gf.ok, true); assert.equal(gf.counts.goldfishArchetypes, 5);
    const cl = r.reports.find(x => x.source === 'cluster')!;
    assert.equal(cl.counts.archetypes, 3);
    const archetypes = svc.archetypes('Modern');
    assert.deepEqual(archetypes.filter(a => a.name !== 'Other').map(a => a.name).sort(), ['Amulet Titan', 'Hammer Time', 'Izzet Murktide']);
    assert.equal(archetypes[archetypes.length - 1].name, 'Other');
    assert.ok(Math.abs(archetypes.reduce((a, x) => a + x.share, 0) - 1) < 1e-9);
    const murk = archetypes.find(a => a.name === 'Izzet Murktide')!;
    assert.equal(murk.deckCount, 8); assert.equal(murk.goldfishShare, 0.124); assert.equal(murk.deckSize, 60);
    // profile shape
    const p = svc.profile(murk.id)!;
    assert.equal(p.id, murk.id); assert.equal(p.format, 'Modern'); assert.equal(p.deckSize, 60); assert.equal(p.metaShare, murk.share);
    assert.equal(p.sampleLists!.length, 8); assert.ok(p.sampleLists!.every(l => l.reduce((a, c) => a + c.count, 0) === 60));
    assert.ok(p.cards.some(c => c.name === 'Murktide Regent' && c.board === 'main' && c.pIn === 1 && c.expectedCount === 4));
    assert.ok(p.cards.some(c => c.board === 'side'));
    if (cards) assert.ok(svc.store.archetypeCards(murk.id).every(c => c.oracleId), 'every fixture card resolves to an oracle id');
    assert.equal(svc.memberDecks(murk.id).length, 8);
    assert.equal(svc.recentDecklists('Modern', 5).length, 5);
    assert.equal(svc.decklist('topdeck:fixture-modern-1:p1')!.archetype, 'Izzet Murktide');
    // 24 h skip
    const before = hits.length;
    const again = await svc.refresh('Modern');
    assert.equal(again.reports.find(x => x.source === 'topdeck')!.skipped, true);
    assert.equal(hits.length, before, 'no network on a skipped refresh');
    // force after the cache window: ids and names stable
    clock += 25 * 3600 * 1000;
    const forced = await svc.refresh('Modern', { force: true });
    assert.equal(forced.reports.find(x => x.source === 'topdeck')!.skipped, undefined);
    const after = svc.archetypes('Modern');
    assert.deepEqual(after.map(a => a.id).sort(), archetypes.map(a => a.id).sort());
    assert.equal(svc.lastRefresh('Modern')!.ok, true);
    // no API key -> failure report, not a throw
    const svc2 = new MetaService({ user: db, cards, fetchImpl, sleep: noSleep, env: {}, now: () => clock });
    const nokey = await svc2.refresh('Pioneer', { force: true });
    assert.equal(nokey.ok, false); assert.match(nokey.reports[0].message, /TOPDECK_API_KEY/);
    assert.equal(svc2.goldfishEnabled(), false);
    assert.equal(nokey.reports.find(x => x.source === 'goldfish')!.skipped, true);
  } finally { cleanup(); }
});

test('runSync + parseSources + 17lands ratings through the service', async () => {
  const { db, cleanup } = tempDb();
  try {
    assert.deepEqual(parseSources('topdeck, 17lands,goldfish'), ['topdeck', '17lands', 'goldfish']);
    assert.throws(() => parseSources('moxfield'), /unknown source/);
    const { fetchImpl, hits } = fakeFetch();
    const logs: string[] = [];
    const r = await runSync({ user: db, cards, format: 'modern', sources: ['topdeck', '17lands'], days: 30, set: 'blb', env: { TOPDECK_API_KEY: 'k' }, fetchImpl, sleep: noSleep, log: m => logs.push(m) });
    assert.equal(r.format, 'Modern'); assert.equal(r.ok, true, JSON.stringify(r.reports));
    assert.equal(r.reports.find(x => x.source === '17lands')!.counts.cardRatings, 3);
    assert.ok(logs.some(l => l.startsWith('topdeck Modern:')) && logs.some(l => l.startsWith('17lands BLB:')));
    const svc = new MetaService({ user: db, cards, fetchImpl, sleep: noSleep, env: {} });
    const cached = await svc.cardRatings('BLB');
    assert.equal(cached.fromCache, true); assert.equal(cached.ratings.length, 3);
    if (cards) assert.ok(cached.ratings.find(x => x.name === 'Lightning Bolt')!.oracleId);
    assert.equal(hits.filter(h => h.includes('card_ratings')).length, 1);
    const missingSet = await runSync({ user: db, cards, format: 'Modern', sources: ['17lands'], env: {}, fetchImpl, sleep: noSleep });
    assert.equal(missingSet.ok, false);
    await assert.rejects(() => runSync({ user: db, cards, format: 'draft', env: {}, fetchImpl, sleep: noSleep }), /unknown format/);
  } finally { cleanup(); }
});

test('importDecklistAsDeck and sampleArchetypeAsDeck save opponent decks (master.db)', { skip: !hasMaster }, async () => {
  const { db, cleanup } = tempDb();
  try {
    const { fetchImpl } = fakeFetch();
    const svc = new MetaService({ user: db, cards, fetchImpl, sleep: noSleep, env: { TOPDECK_API_KEY: 'k' } });
    await svc.refresh('Modern');
    const decks = new DeckStore(db);
    const imp = svc.importDecklistAsDeck('topdeck:fixture-modern-1:p1', decks)!;
    assert.deepEqual(imp.missing, []);
    assert.equal(imp.deck.role, 'opponent'); assert.equal(imp.deck.source, 'meta:topdeck'); assert.equal(imp.deck.format, 'modern'); assert.equal(imp.deck.sourceRef, 'topdeck:fixture-modern-1:p1');
    assert.equal(imp.deck.cards.filter(c => c.board === 'main').reduce((a, c) => a + c.count, 0), 60);
    assert.equal(imp.deck.cards.filter(c => c.board === 'side').reduce((a, c) => a + c.count, 0), 15);
    assert.ok(imp.deck.cards.every(c => c.oracleId));
    assert.ok(imp.deck.name.includes('Alice'));
    const list = decks.toDeckList(imp.deck.id)!;
    assert.ok(list.cards.some(c => c.name === 'Murktide Regent' && c.count === 4));
    assert.equal(svc.importDecklistAsDeck('nope', decks), null);
    const murk = svc.archetypes('Modern').find(a => svc.store.archetypeCards(a.id).some(c => c.board === 'main' && c.name === 'Murktide Regent' && c.pIn === 1))!;
    const s1 = svc.sampleArchetypeAsDeck(murk.id, 12345, decks)!;
    const s2 = svc.sampleArchetypeAsDeck(murk.id, 12345, decks)!;
    assert.equal(s1.sourceDecklistId, s2.sourceDecklistId, 'same seed picks the same member');
    assert.ok(murk.id && svc.memberDecks(murk.id).some(m => m.id === s1.sourceDecklistId));
    assert.equal(s1.deck.role, 'opponent'); assert.equal(s1.deck.source, 'meta:sample'); assert.equal(s1.deck.archetype, murk.name);
    assert.equal(s1.deck.cards.filter(c => c.board === 'main').reduce((a, c) => a + c.count, 0), 60);
    const picks = new Set(Array.from({ length: 30 }, (_, i) => svc.sampleArchetypeAsDeck(murk.id, i, decks)!.sourceDecklistId));
    assert.ok(picks.size > 1, 'different seeds reach different member lists');
    assert.equal(svc.sampleArchetypeAsDeck('modern:missing', 1, decks), null);
  } finally { cleanup(); }
});
