// The pool sandbox and its worker pool: named cards keep their verdict at two and four seats, the invariants module
// catches a deliberately corrupted state, and the report is the same however many workers produced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardDB } from '../src/cards/db.js';
import { assertInvariants } from '../src/engine/invariants.js';
import { byOracleId, runPool } from '../src/verify/poolWorker.js';
import { trialCard, type Verdict } from '../src/verify/sandbox.js';
import { C, db, setup } from './helpers.js';

/**
 * Cards whose sandbox verdict is pinned. `unreachable` here means "the sandbox never got a legal action out of it":
 * Counterspell/Force of Will/Disenchant have nothing legal to target on an empty stack (Force of Will's alternative
 * cost cannot help), and Bone Splinters/Fling/Goblin Grenade carry an additional cost — sacrifice a creature — that
 * seat 0, which controls nothing but lands, cannot pay.
 */
const EXPECTED: [string, Verdict][] = [
  ['Lightning Bolt', 'sandbox-ok'], ['Grizzly Bears', 'sandbox-ok'], ['Llanowar Elves', 'sandbox-ok'],
  ['Serra Angel', 'sandbox-ok'], ['Shivan Dragon', 'sandbox-ok'], ['Wrath of God', 'sandbox-ok'],
  ['Dark Ritual', 'sandbox-ok'], ['Giant Growth', 'sandbox-ok'], ['Sol Ring', 'sandbox-ok'],
  ['Forest', 'sandbox-ok'], ['Birds of Paradise', 'sandbox-ok'], ['Prodigal Sorcerer', 'sandbox-ok'],
  ['Air Elemental', 'sandbox-ok'], ['Hill Giant', 'sandbox-ok'], ['Doom Blade', 'sandbox-ok'],
  ['Pacifism', 'sandbox-ok'], ['Millstone', 'sandbox-ok'], ['Ornithopter', 'sandbox-ok'],
  ['Craw Wurm', 'sandbox-ok'], ['Sengir Vampire', 'sandbox-ok'], ['Royal Assassin', 'sandbox-ok'],
  ["Nevinyrral's Disk", 'sandbox-ok'], ['Bonesplitter', 'sandbox-ok'], ['Swords to Plowshares', 'sandbox-ok'],
  ['Rampant Growth', 'sandbox-ok'], ['Mind Stone', 'sandbox-ok'], ['Cultivate', 'sandbox-ok'],
  ['Counterspell', 'unreachable'], ['Disenchant', 'unreachable'], ['Force of Will', 'unreachable'],
  ['Bone Splinters', 'unreachable'], ['Fling', 'unreachable'], ['Goblin Grenade', 'unreachable'],
];

test('trialCard: named cards keep their verdict in a two-player sandbox', async () => {
  const got: [string, Verdict][] = [];
  for (const [name] of EXPECTED) got.push([name, (await trialCard(db, C(name), { seats: 2 })).verdict]);
  assert.deepEqual(got, EXPECTED);
});

test('trialCard: a four-seat pod reaches the same verdicts (three opponents, same board)', async () => {
  const got: [string, Verdict][] = [];
  for (const [name] of EXPECTED) got.push([name, (await trialCard(db, C(name), { seats: 4 })).verdict]);
  assert.deepEqual(got, EXPECTED);
});

test('trialCard: the four-seat sandbox really is a pod (a Grizzly Bears / Hill Giant board per opponent)', async () => {
  // count how often the trial asks the database for an opponent's board: once per opponent seat
  let giants = 0;
  const spy = new Proxy(db, {
    get(t, p) {
      if (p === 'get') return (n: string) => { if (n === 'Hill Giant') giants++; return t.get(n); };
      const v = Reflect.get(t, p); return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as CardDB;
  giants = 0; assert.equal((await trialCard(spy, C('Grizzly Bears'), { seats: 2 })).verdict, 'sandbox-ok');
  assert.equal(giants, 1, 'two seats: one opponent');
  giants = 0; assert.equal((await trialCard(spy, C('Grizzly Bears'), { seats: 4 })).verdict, 'sandbox-ok');
  assert.equal(giants, 3, 'four seats: three opponents');
});

test('assertInvariants: a clean state passes and a corrupted one is named', () => {
  const s = setup({ bf: ['Grizzly Bears', 'Forest'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }).state;
  assert.equal(assertInvariants(s), null);
  // the same object in two zones (its hand copy is also on the battlefield)
  const bolt = s.players[0].hand[0];
  s.players[0].battlefield.push(bolt);
  assert.equal(assertInvariants(s), `object ${bolt.id} in two zones`);
  s.players[0].battlefield.pop();
  assert.equal(assertInvariants(s), null);
  // a zone field that disagrees with the list the object is in
  const gy = s.players[0].hand.pop()!; gy.zone = 'graveyard'; s.players[0].graveyard.push(gy);
  assert.equal(assertInvariants(s), null);
  gy.zone = 'exile';
  assert.match(assertInvariants(s) ?? '', /graveyard list with zone exile/);
  gy.zone = 'graveyard';
  // a tapped card outside the battlefield, and a stale attachment
  gy.tapped = true;
  assert.match(assertInvariants(s) ?? '', /is tapped in .*graveyard/);
  gy.tapped = false;
  const bears = s.players[0].battlefield.find(o => o.def.name === 'Grizzly Bears')!;
  bears.attachedTo = 999999;
  assert.equal(assertInvariants(s), 'Grizzly Bears attached to a missing object');
  bears.attachedTo = null;
  // one-sided blocking
  const giant = s.players[1].battlefield[0];
  bears.blocking = [giant.id];
  assert.match(assertInvariants(s) ?? '', /blocks Hill Giant but is missing from its blockedBy/);
  bears.blocking = [];
  assert.equal(assertInvariants(s), null);
});

/** 40 oracle ids for the pool tests (the names are irrelevant; only the verdicts have to agree). */
function sampleIds(): string[] {
  const names = [...EXPECTED.map(([n]) => n), 'Plains', 'Island', 'Swamp', 'Mountain', 'Shock', 'Divination', 'Elvish Mystic'];
  const ids = [...new Set(names.map(n => C(n).oracleId))];
  assert.ok(ids.length >= 40, `sample has ${ids.length} ids`);
  return ids.slice(0, 40);
}

test('the pool gives the same per-card verdicts with 1 worker and with 3', async () => {
  const ids = sampleIds();
  const one = await runPool(ids, { workers: 1 });
  const three = await runPool(ids, { workers: 3 });
  assert.equal(one.length, ids.length);
  assert.deepEqual(byOracleId(three, 2), byOracleId(one, 2));
  assert.deepEqual(three, one, 'rows are sorted by oracle id, so the whole result matches');
});

test('the pool trials both seat counts when asked, and by_oracle_id carries the seats-4 verdict', async () => {
  const ids = sampleIds().slice(0, 6);
  const rows = await runPool(ids, { workers: 2, seats: [2, 4] });
  assert.equal(rows.length, ids.length * 2);
  const map = byOracleId(rows, 2);
  for (const id of ids) { assert.ok(map[id], id); assert.ok(map[id].v4, `${id} has no seats-4 verdict`); }
  assert.deepEqual(new Set(rows.map(r => r.seats)), new Set([2, 4]));
});
