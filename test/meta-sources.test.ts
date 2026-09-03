// Source adapters against recorded-shape fixtures: TopDeck mapping + fetch, Goldfish parsing/robots/fetch, 17lands parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openUserDb } from '../src/user/db.js';
import { HttpClient } from '../src/meta/http.js';
import { fetchTopdeck, mapTournaments, standingCards, TOPDECK_API } from '../src/meta/topdeck.js';
import { fetchGoldfishMetagame, GOLDFISH_ORIGIN, parseGoldfishArchetypePage, parseGoldfishMetagame, parseRobots, robotsAllows } from '../src/meta/goldfish.js';
import { fetchCardRatings, parseCardRatings, ratingsUrl } from '../src/meta/seventeenlands.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'meta');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const topdeckRaw = JSON.parse(read('topdeck-modern.json'));

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-meta-'));
  const db = openUserDb(path.join(dir, 'user.db'));
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const noSleep = async () => {};

test('topdeck: mapTournaments maps standings, skips url-only/empty rows, parses text decklists', () => {
  const r = mapTournaments(topdeckRaw, 'Modern');
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].sourceId, 'fixture-modern-1'); assert.equal(r.events[0].date, '2026-08-10'); assert.equal(r.events[0].players, 12);
  assert.equal(r.events[0].url, 'https://topdeck.gg/event/fixture-modern-1');
  assert.equal(r.decklists.length, 26); assert.equal(r.skippedUrlOnly, 1); assert.equal(r.skippedEmpty, 1);
  const first = r.decklists[0];
  assert.equal(first.sourceId, 'fixture-modern-1:p1'); assert.equal(first.eventSourceId, 'fixture-modern-1'); assert.equal(first.player, 'Alice');
  assert.equal(first.placement, 1); assert.equal(first.wins, 6); assert.equal(first.losses, 0); assert.equal(first.deckSize, 60);
  assert.equal(first.cards.filter(c => c.board === 'side').reduce((a, c) => a + c.count, 0), 15);
  assert.ok(first.cards.some(c => c.name === 'Murktide Regent' && c.count === 4 && c.board === 'main'));
  const text = r.decklists.find(d => d.player === 'Sam')!;
  assert.ok(text.cards.some(c => c.name === 'Thoughtseize' && c.count === 4 && c.board === 'main'), 'set codes stripped');
  assert.ok(text.cards.some(c => c.name === 'Fury' && c.board === 'side'));
  assert.equal(text.deckSize, 60);
  assert.deepEqual(standingCards({ decklist: 'https://moxfield.com/decks/x' }).kind, 'url');
  assert.deepEqual(standingCards({ deckObj: { Mainboard: { 'Island': 20, 'Opt': { qty: 4 } } } }).cards, [{ name: 'Island', count: 20, board: 'main' }, { name: 'Opt', count: 4, board: 'main' }]);
  assert.deepEqual(mapTournaments(null, 'Modern').decklists, []);
  assert.deepEqual(mapTournaments([{ TID: 'x', standings: [{ deckObj: { Mainboard: { Island: 5 } } }] }], 'Modern').skippedEmpty, 1, 'tiny lists are skipped');
});

test('topdeck: fetchTopdeck sends the API key and body, caches the POST by body', async () => {
  const { db, cleanup } = tempDb();
  try {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify(topdeckRaw), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const http = new HttpClient({ db, fetchImpl, sleep: noSleep });
    const r = await fetchTopdeck('Modern', { http, apiKey: 'secret-key', days: 30 });
    assert.equal(r.tournaments, 2); assert.equal(r.decklists.length, 26); assert.equal(r.fromCache, false);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, TOPDECK_API); assert.equal(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'secret-key'); assert.ok(headers['User-Agent'].startsWith('mtg-master-sim/'));
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.game, 'Magic: The Gathering'); assert.equal(body.format, 'Modern'); assert.equal(body.last, 30);
    assert.deepEqual(body.columns, ['name', 'id', 'decklist', 'wins', 'losses', 'draws', 'winRate']);
    const again = await fetchTopdeck('Modern', { http, apiKey: 'secret-key', days: 30 });
    assert.equal(again.fromCache, true); assert.equal(calls.length, 1);
    await fetchTopdeck('Modern', { http, apiKey: 'secret-key', days: 7 });
    assert.equal(calls.length, 2, 'a different window is a different cache key');
    await assert.rejects(() => fetchTopdeck('Modern', { http, apiKey: '', days: 30 }), /TOPDECK_API_KEY/);
  } finally { cleanup(); }
});

test('goldfish: metagame and archetype pages parse through the isolated selectors', () => {
  const list = parseGoldfishMetagame(read('goldfish-metagame.html'));
  assert.equal(list.length, 5);
  assert.deepEqual(list[0], { name: 'Izzet Murktide', slug: 'modern-izzet-murktide-xyz12', url: `${GOLDFISH_ORIGIN}/archetype/modern-izzet-murktide-xyz12#paper`, share: 0.124, deckCount: 310 });
  assert.equal(list[4].name, 'Mono-White Humans'); assert.equal(list[4].share, 0.025);
  const sample = parseGoldfishArchetypePage(read('goldfish-archetype.html'));
  assert.equal(sample.filter(c => c.board === 'main').reduce((a, c) => a + c.count, 0), 60);
  assert.equal(sample.filter(c => c.board === 'side').reduce((a, c) => a + c.count, 0), 15);
  assert.ok(sample.some(c => c.name === 'Fire // Ice' && c.count === 2));
  assert.ok(sample.some(c => c.name === "Dragon's Rage Channeler" && c.count === 4), 'entities decoded');
  assert.ok(sample.some(c => c.name === 'Blood Moon' && c.board === 'side'));
  assert.deepEqual(parseGoldfishMetagame('<html><body>nothing here</body></html>'), []);
});

test('goldfish: robots.txt groups, wildcards and longest-match precedence', () => {
  const txt = `# fixture\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /deck/download/\nDisallow: /metagame/*/full$\nAllow: /metagame/\nDisallow: /price/\n`;
  const rules = parseRobots(txt);
  assert.deepEqual(rules.disallow, ['/deck/download/', '/metagame/*/full$', '/price/']);
  assert.equal(robotsAllows(rules, '/metagame/modern'), true);
  assert.equal(robotsAllows(rules, '/metagame/modern/full'), false, 'longer disallow with $ anchor wins');
  assert.equal(robotsAllows(rules, '/metagame/modern/full/x'), true, '$ anchor does not match a longer path');
  assert.equal(robotsAllows(rules, '/deck/download/123'), false);
  assert.equal(robotsAllows(rules, '/archetype/modern-x'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: mtg-master-sim\nDisallow: /\n'), '/metagame/modern'), false, 'a group naming our product token applies');
  assert.equal(robotsAllows(parseRobots(''), '/anything'), true);
});

test('goldfish: fetch is opt-in, honours robots, attaches sample lists and degrades to unavailable', async () => {
  const { db, cleanup } = tempDb();
  try {
    let robots = 'User-agent: *\nDisallow: /deck/download/\n';
    const hits: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const u = new URL(String(url)); hits.push(u.pathname);
      if (u.pathname === '/robots.txt') return new Response(robots, { status: 200 });
      if (u.pathname === '/metagame/modern/full') return new Response(read('goldfish-metagame.html'), { status: 200, headers: { 'content-type': 'text/html' } });
      if (u.pathname === '/archetype/modern-izzet-murktide-xyz12') return new Response(read('goldfish-archetype.html'), { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    };
    const http = new HttpClient({ db, fetchImpl, sleep: noSleep });
    const off = await fetchGoldfishMetagame('Modern', { http, enabled: false });
    assert.equal(off.available, false); assert.equal(hits.length, 0); assert.match(off.reason!, /META_GOLDFISH_ENABLED/);
    const on = await fetchGoldfishMetagame('Modern', { http, enabled: true, maxSamples: 3 });
    assert.equal(on.available, true); assert.equal(on.archetypes.length, 5);
    assert.ok(on.archetypes[0].sampleList && on.archetypes[0].sampleList.length > 10);
    assert.equal(on.archetypes[1].sampleList, undefined, '404 archetype page leaves the entry without a sample');
    assert.equal(hits.filter(h => h.startsWith('/archetype/')).length, 3, 'maxSamples respected');
    assert.ok(!hits.some(h => h.startsWith('/deck/download')));
    // robots disallow -> unavailable, no page fetch
    robots = 'User-agent: *\nDisallow: /metagame/\n';
    const http2 = new HttpClient({ db, fetchImpl, sleep: noSleep });
    const blocked = await fetchGoldfishMetagame('Pioneer', { http: http2, enabled: true, force: true });
    assert.equal(blocked.available, false); assert.match(blocked.reason!, /robots/);
    // network failure -> unavailable, never throws
    const http3 = new HttpClient({ db, fetchImpl: async () => { throw new Error('ECONNRESET'); }, sleep: noSleep });
    const down = await fetchGoldfishMetagame('Legacy', { http: http3, enabled: true, force: true });
    assert.equal(down.available, false); assert.match(down.reason!, /ECONNRESET/);
  } finally { cleanup(); }
});

test('17lands: ratings parse, blank names dropped, nulls preserved; fetch is cached 24 h', async () => {
  const ratings = parseCardRatings(JSON.parse(read('seventeenlands-ratings.json')));
  assert.equal(ratings.length, 3);
  assert.equal(ratings[0].name, 'Lightning Bolt'); assert.equal(ratings[0].gihWinRate, 0.633); assert.equal(ratings[0].openingHandWinRate, 0.641); assert.equal(ratings[0].avgPick, 2.12); assert.equal(ratings[0].gameCount, 88210);
  assert.equal(ratings[2].name, 'Island'); assert.equal(ratings[2].everDrawnWinRate, null); assert.equal(ratings[2].rarity, 'basic');
  assert.equal(ratingsUrl('blb'), 'https://www.17lands.com/card_ratings/data?expansion=BLB&format=PremierDraft');
  assert.deepEqual(parseCardRatings({ nope: 1 }), []);
  const { db, cleanup } = tempDb();
  try {
    let n = 0;
    const http = new HttpClient({ db, fetchImpl: async () => { n++; return new Response(read('seventeenlands-ratings.json'), { status: 200 }); }, sleep: noSleep });
    const a = await fetchCardRatings('BLB', { http }); const b = await fetchCardRatings('BLB', { http });
    assert.equal(a.ratings.length, 3); assert.equal(a.fromCache, false); assert.equal(b.fromCache, true); assert.equal(n, 1);
  } finally { cleanup(); }
});
