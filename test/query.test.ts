// Query layer, image cache helpers, user DB and deck formats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardQueryDB, ftsExpression } from '../src/cards/query.js';
import { cachePath, scryfallUrl, getImage } from '../src/images/cache.js';
import { openUserDb, schemaVersion } from '../src/user/db.js';
import { DeckStore, GameStore } from '../src/user/decks.js';
import { parseDeckText, resolveDeck, toArenaText, toPlainText } from '../src/decks/format.js';
import { db } from './helpers.js';

const q = new CardQueryDB(db.db);
const hasIndex = q.hasWebIndex();

test('fts expression builder', () => {
  assert.equal(ftsExpression('lightning bolt'), '("lightning") AND ("bolt"*)');
  assert.equal(ftsExpression('o:"draw a card" t:creature'), 'oracle_text:("draw a card") AND type_line:("creature"*)');
  assert.equal(ftsExpression('   '), null);
});

test('search: name query finds Lightning Bolt first; filters and paging work', { skip: !hasIndex }, () => {
  const r = q.search({ q: 'lightning bolt', pageSize: 5 });
  assert.ok(r.total >= 1); assert.equal(r.items[0].name, 'Lightning Bolt'); assert.equal(r.items[0].colors[0], 'R');
  const red = q.search({ colors: ['R'], colorMode: 'exact', types: ['Instant'], mvMax: 1, format: 'modern', sort: 'edhrec', pageSize: 10 });
  assert.ok(red.items.every(c => c.colors.length === 1 && c.colors[0] === 'R' && c.manaValue <= 1));
  assert.ok(red.items.some(c => c.name === 'Lightning Bolt'));
  const p2 = q.search({ colors: ['R'], colorMode: 'exact', types: ['Instant'], mvMax: 1, format: 'modern', sort: 'edhrec', pageSize: 10, page: 2 });
  assert.equal(p2.page, 2); assert.equal(p2.total, red.total); assert.notEqual(p2.items[0]?.name, red.items[0].name);
});

test('search: printing mode by set sorted by collector number; sets list', { skip: !hasIndex }, () => {
  const r = q.search({ mode: 'printing', set: 'lea', sort: 'collector', pageSize: 5 });
  assert.ok(r.total > 250); assert.ok(r.items.every(c => c.setCode === 'lea'));
  const sets = q.sets(); assert.ok(sets.length > 900); assert.ok(sets.some(s => s.code === 'lea'));
});

test('detail + autocomplete + images', { skip: !hasIndex }, () => {
  const ac = q.autocomplete('light bol'); assert.ok(ac.length === 0 || ac.every(a => a.name));
  const ac2 = q.autocomplete('lightning bo'); assert.equal(ac2[0].name, 'Lightning Bolt');
  const d = q.detail(ac2[0].oracleId)!;
  assert.equal(d.name, 'Lightning Bolt'); assert.ok(d.printings.length > 20); assert.equal(d.legalities.modern, 'legal'); assert.ok(d.def.fullyParsed);
  assert.ok(d.printings.every(p => p.id && p.setCode));
  assert.ok(q.imageSource(d.representativePrintingId, 0)!.includes('cards.scryfall.io'));
  const delver = q.search({ q: 'n:"delver of secrets"', pageSize: 5 }).items.find(i => i.layout === 'transform')!;
  assert.equal(delver.hasBack, true);
  assert.ok(q.imageSource(delver.printingId, 1)!.includes('/back/'));
});

test('image cache helpers and a stubbed fetch', async () => {
  assert.equal(scryfallUrl('https://cards.scryfall.io/normal/front/0/2/abc.jpg?123', 'large'), 'https://cards.scryfall.io/large/front/0/2/abc.jpg?123');
  assert.equal(scryfallUrl('https://cards.scryfall.io/normal/front/0/2/abc.jpg?123', 'png'), 'https://cards.scryfall.io/png/front/0/2/abc.png?123');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  assert.ok(cachePath('abcdef', 0, 'normal', dir).endsWith(path.join('normal', 'ab', 'abcdef-0.jpg')));
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); }) as unknown as typeof fetch;
  const r1 = await getImage('abcdef', 0, 'normal', () => 'https://cards.scryfall.io/normal/front/a/b/abcdef.jpg', { dir, fetchImpl });
  const r2 = await getImage('abcdef', 0, 'normal', () => 'https://cards.scryfall.io/normal/front/a/b/abcdef.jpg', { dir, fetchImpl });
  assert.equal(calls, 1); assert.equal(r1!.cached, false); assert.equal(r2!.cached, true);
  assert.equal(fs.readFileSync(r1!.path).length, 3);
  assert.equal(await getImage('nope', 0, 'normal', () => null, { dir, fetchImpl }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('user db: migrations, deck CRUD, games', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'udb-')), 'user.db');
  const u = openUserDb(file);
  assert.equal(schemaVersion(u), 1);
  const decks = new DeckStore(u);
  const d = decks.create({ name: 'Burn', format: 'modern', cards: [{ board: 'main', oracleId: 'o1', name: 'Lightning Bolt', printingId: null, count: 4, position: 0 }, { board: 'side', oracleId: 'o2', name: 'Pyroblast', printingId: null, count: 2, position: 0 }] });
  assert.equal(decks.list('mine').length, 1); assert.equal(decks.list('mine')[0].mainCount, 4); assert.equal(decks.list('mine')[0].sideCount, 2);
  const d2 = decks.update(d.id, { name: 'Burn v2', cards: [{ board: 'main', oracleId: 'o1', name: 'Lightning Bolt', printingId: 'p', count: 3, position: 0 }] })!;
  assert.equal(d2.name, 'Burn v2'); assert.equal(d2.cards.length, 1); assert.equal(d2.cards[0].printingId, 'p');
  const dup = decks.duplicate(d.id, { role: 'opponent' })!; assert.equal(dup.role, 'opponent'); assert.equal(decks.list().length, 2);
  assert.deepEqual(decks.toDeckList(d.id)!.cards, [{ name: 'Lightning Bolt', count: 3, board: 'main' }]);
  const games = new GameStore(u);
  const gid = games.save({ seed: 7, myDeckId: d.id, myDeckSnapshot: decks.toDeckList(d.id)!, oppDeckSnapshot: { name: 'x', cards: [] }, options: {}, log: ['a', 'b'] });
  games.save({ id: gid, seed: 7, myDeckSnapshot: { name: 'x', cards: [] }, oppDeckSnapshot: { name: 'x', cards: [] }, options: {}, winner: 0, turns: 9, finishedAt: 'now' });
  assert.equal(games.get(gid)!.winner, 0); assert.equal(games.list().length, 1);
  assert.ok(decks.remove(d.id)); assert.equal(games.get(gid)!.myDeckId, null, 'ON DELETE SET NULL');
  u.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('deck text: parse/export and resolution', { skip: !hasIndex }, () => {
  const p = parseDeckText('// Test\nDeck\n4 Lightning Bolt (M10) 146\n2 Fire // Ice\nSideboard\n1 Pyroblast\nthis is junk');
  assert.equal(p.name, 'Test'); assert.deepEqual(p.unknownLines, ['this is junk']);
  const r = resolveDeck(db, q, p);
  assert.deepEqual(r.missing, ['this is junk'], 'unparseable lines surface as unresolved names'); assert.equal(r.cards.length, 3);
  assert.ok(r.cards[0].printingId, 'set+number resolved to a printing id');
  const arena = toArenaText(r.cards.map(c => ({ ...c, set: c === r.cards[0] ? 'm10' : undefined, number: c === r.cards[0] ? '146' : undefined })));
  assert.match(arena, /^Deck\n4 Lightning Bolt \(M10\) 146\n2 Fire \/\/ Ice\n\nSideboard\n1 Pyroblast\n$/);
  assert.match(toPlainText(r.cards, 'Test'), /^\/\/ Test\n4 Lightning Bolt/);
});
