// CardQueryDB with a collection attached: owned counts on searches/autocomplete/detail, the owned filter, and count-cache
// invalidation when the collection changes. Needs master.db with the web index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardQueryDB } from '../src/cards/query.js';
import { openUserDb } from '../src/user/db.js';
import { CollectionStore } from '../src/collection/store.js';
import { db } from './helpers.js';

const hasIndex = new CardQueryDB(db.db).hasWebIndex();

test('owned join: counts, filter, autocomplete, detail and cache invalidation', { skip: !hasIndex }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-owned-'));
  const userPath = path.join(dir, 'user.db');
  const user = openUserDb(userPath);
  // the query layer needs its own connection to master.db (attaching on the shared one would leak into other tests)
  const q = new CardQueryDB(new (db.db.constructor as new (p: string, o: object) => typeof db.db)(db.db.name, { readonly: true }));
  try {
    assert.equal(q.hasUser(), false);
    assert.equal(q.search({ q: 'lightning bolt', pageSize: 3 }).items[0].owned, null);
    assert.ok(q.attachUser(userPath));
    assert.equal(q.hasUser(), true);
    const store = new CollectionStore(user, db);
    const before = q.search({ q: 'lightning bolt', pageSize: 3 });
    assert.equal(before.items[0].owned, 0);
    assert.equal(q.search({ owned: true, pageSize: 5 }).total, 0);
    store.importText('3,Lightning Bolt\n1,Sol Ring\n', 'test.csv');
    const after = q.search({ q: 'lightning bolt', pageSize: 3 });
    assert.equal(after.items[0].name, 'Lightning Bolt'); assert.equal(after.items[0].owned, 3);
    const owned = q.search({ owned: true, pageSize: 5, sort: 'name' });
    assert.equal(owned.total, 2); assert.deepEqual(owned.items.map(c => [c.name, c.owned]), [['Lightning Bolt', 3], ['Sol Ring', 1]]);
    assert.equal(q.search({ owned: true, types: ['Artifact'], pageSize: 5 }).total, 1);
    const ac = q.autocomplete('lightning bo', 3);
    assert.equal(ac[0].name, 'Lightning Bolt'); assert.equal(ac[0].owned, 3);
    assert.equal(q.detail(ac[0].oracleId)!.owned, 3);
    // the count cache is keyed by the collection version: a change is visible at once
    store.upsert(ac[0].oracleId, -3);
    assert.equal(q.search({ owned: true, pageSize: 5 }).total, 1);
    assert.equal(q.ownedCount(ac[0].oracleId), 0);
  } finally {
    q.db.close(); user.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
