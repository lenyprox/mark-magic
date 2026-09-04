// CollectionStore on a temp user.db against the real master file: the six bundled Commander CSVs, merge semantics,
// coverage, manual upserts and deck registration. Skipped when master.db is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MASTER_DB } from '../src/config/paths.js';
import { openUserDb, schemaVersion } from '../src/user/db.js';
import { DeckStore } from '../src/user/decks.js';
import { CollectionStore } from '../src/collection/store.js';
import type { CardDB } from '../src/cards/db.js';

const hasMaster = fs.existsSync(MASTER_DB());
const DECKS = path.join(process.cwd(), 'decks');
const CSVS = fs.existsSync(DECKS) ? fs.readdirSync(DECKS).filter(f => f.endsWith('.csv')).sort() : [];
let cards: CardDB | null = null;
if (hasMaster) cards = (await import('../src/cards/db.js')).CardDB.shared();

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-collection-'));
  const db = openUserDb(path.join(dir, 'user.db'));
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('migration v2 creates the collection tables and view', () => {
  const { db, cleanup } = tempDb();
  try {
    assert.ok(schemaVersion(db) >= 2);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'collection_%'").all() as { name: string }[]).map(r => r.name).sort();
    assert.deepEqual(names, ['collection_cards', 'collection_owned', 'collection_sources']);
  } finally { cleanup(); }
});

test('import the six bundled CSVs: 486 rows, 599 copies, nothing unresolved; idempotent; sources sum', { skip: !hasMaster || CSVS.length !== 6 }, () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new CollectionStore(db, cards!);
    const v0 = store.version();
    let rows = 0, copies = 0, unresolved = 0;
    for (const f of CSVS) {
      const r = store.importText(fs.readFileSync(path.join(DECKS, f), 'utf8'), f);
      rows += r.source.rows; copies += r.copies; unresolved += r.unresolved.length;
      assert.equal(r.skipped, false); assert.equal(r.format, 'csv'); assert.deepEqual(r.errors, []);
    }
    assert.equal(rows, 486); assert.equal(copies, 599); assert.equal(unresolved, 0);
    assert.equal(store.version(), v0 + 6);
    const s = store.stats();
    assert.equal(s.sources, 6); assert.equal(s.copies, 599); assert.ok(s.distinct > 400 && s.distinct < 486, `distinct ${s.distinct}`);
    assert.ok(s.byType.some(t => t.type === 'Land') && s.byType.some(t => t.type === 'Creature'));
    // Arcane Signet is in several decks: owned count is the sum over sources
    const signet = cards!.get('Arcane Signet')!;
    const owned = store.owned(signet.oracleId)!;
    assert.ok(owned.count >= 3, `Arcane Signet x${owned.count}`); assert.equal(owned.sources, owned.count);
    // re-import: unchanged content is a no-op and the version does not move
    const v1 = store.version();
    const again = store.importText(fs.readFileSync(path.join(DECKS, CSVS[0]), 'utf8'), CSVS[0]);
    assert.equal(again.skipped, true); assert.equal(store.version(), v1); assert.equal(store.stats().copies, 599);
    // a changed file replaces its own rows only
    const changed = store.importText('1,Arcane Signet\n1,Sol Ring\n', CSVS[0]);
    assert.equal(changed.skipped, false); assert.equal(changed.copies, 2);
    assert.equal(store.stats().copies, 599 - 100 + 2);
    assert.equal(store.owned(signet.oracleId)!.count, owned.count);
    // removing a source drops its cards
    assert.ok(store.removeSource(changed.source.id));
    assert.equal(store.stats().sources, 5); assert.equal(store.owned(signet.oracleId)!.count, owned.count - 1);
    // export round trip
    const csv = store.exportText('csv');
    assert.match(csv, /^\d+,/m); assert.ok(csv.includes('Arcane Signet'));
  } finally { cleanup(); }
});

test('coverageOf, upsert (bulk), and registering a CSV as a Commander deck', { skip: !hasMaster || CSVS.length !== 6 }, () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new CollectionStore(db, cards!);
    const varina = CSVS.find(f => f.startsWith('varina'))!;
    const r = store.importText(fs.readFileSync(path.join(DECKS, varina), 'utf8'), varina, { asDeck: { format: 'commander', role: 'mine' } });
    assert.ok(r.deck); assert.equal(r.deck!.name, 'Varina, Lich Queen'); assert.equal(r.deck!.format, 'commander'); assert.equal(r.deck!.source, 'import:csv');
    assert.equal(r.commander?.confidence, 'high'); assert.equal(r.commander?.pick?.name, 'Varina, Lich Queen');
    const cmd = r.deck!.cards.filter(c => c.board === 'commander');
    assert.equal(cmd.length, 1); assert.equal(cmd[0].name, 'Varina, Lich Queen');
    assert.equal(r.deck!.cards.reduce((a, c) => a + c.count, 0), 99);
    assert.equal(store.source(r.source.id)!.deckId, r.deck!.id);
    // the deck is fully covered by its own source
    const cov = store.coverageOf(r.deck!.cards);
    assert.equal(cov.pct, 100); assert.equal(cov.missing.length, 0); assert.equal(cov.total, 99);
    // a list needing two Sol Rings and a card we do not own reports the gap
    const solRing = cards!.get('Sol Ring')!; const bolt = cards!.get('Lightning Bolt')!;
    const cov2 = store.coverageOf([{ oracleId: solRing.oracleId, name: solRing.name, count: 2 }, { oracleId: bolt.oracleId, name: bolt.name, count: 4 }]);
    assert.equal(cov2.total, 6); assert.ok(cov2.owned <= 1);
    assert.ok(cov2.missing.some(m => m.name === 'Lightning Bolt' && m.need === 4 && m.have === 0));
    // found one in the bulk
    const before = store.isOwned(bolt.oracleId);
    const up = store.upsert(bolt.oracleId, 2)!;
    assert.equal(up.count, before + 2); assert.equal(store.isOwned(bolt.oracleId), before + 2);
    assert.equal(store.ownedDetail(bolt.oracleId)!.sources.some(s => s.id === 'manual'), true);
    store.upsert(bolt.oracleId, -2); assert.equal(store.isOwned(bolt.oracleId), before);
    // re-import with the same file keeps the deck id and the chosen commander
    const again = store.importText(fs.readFileSync(path.join(DECKS, varina), 'utf8').replace('1,Arcane Signet\n', '1,Arcane Signet\n1,Sol Ring\n'), varina);
    assert.equal(again.deck!.id, r.deck!.id);
    assert.equal(again.deck!.cards.find(c => c.board === 'commander')?.name, 'Varina, Lich Queen');
    assert.ok(again.deck!.cards.some(c => c.name === 'Sol Ring'));
    // ambiguous commander leaves the deck without one and says so in the notes
    const q = CSVS.find(f => f.startsWith('quintorius'))!;
    const rq = store.importText(fs.readFileSync(path.join(DECKS, q), 'utf8'), q, { asDeck: { format: 'commander', role: 'mine' } });
    assert.equal(rq.commander?.confidence, 'ambiguous'); assert.equal(rq.deck!.cards.filter(c => c.board === 'commander').length, 0); assert.match(rq.deck!.notes ?? '', /Commander not identified/);
    // an explicit commander wins
    const qc = rq.commander!.candidates.find(c => c.name === 'Quintorius, Loremaster')!;
    const rq2 = store.importText(fs.readFileSync(path.join(DECKS, q), 'utf8') + '1,Sol Ring\n', q, { asDeck: { format: 'commander', role: 'mine', commander: qc.oracleId } });
    assert.equal(rq2.deck!.cards.find(c => c.board === 'commander')?.name, 'Quintorius, Loremaster');
    assert.equal(new DeckStore(db).list('mine').length, 2);
    // deleting the source together with its deck
    assert.ok(store.removeSource(rq2.source.id, { deleteDeck: true }));
    assert.equal(new DeckStore(db).list('mine').length, 1);
  } finally { cleanup(); }
});
