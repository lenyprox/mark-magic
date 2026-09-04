// The pool sandbox and its worker pool: named cards keep their verdict at two and four seats, the invariants module
// catches a deliberately corrupted state, and the report is the same however many workers produced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardDB } from '../src/cards/db.js';
import { inTier, tierSql } from '../src/cards/tiers.js';
import { assertInvariants } from '../src/engine/invariants.js';
import type { GameObject, StackItem } from '../src/engine/state.js';
import { abilityReachability, byOracleId, inlinePoolWorker, runPool, type FromPoolWorker, type PoolWorkerLike } from '../src/verify/poolWorker.js';
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

test('assertInvariants: the stack checks catch a duplicated item and a spell left behind in a zone', () => {
  const s = setup({ bf: ['Grizzly Bears'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }).state;
  const bolt = s.players[0].hand[0];
  // the spell went on the stack but a copy of it stayed in hand (a zone change that cloned instead of moving)
  const onStack: GameObject = { ...bolt, zone: 'stack' };
  const item = { id: 9001, kind: 'spell', name: 'Lightning Bolt', source: onStack, controller: 0, effects: [], targets: [], targetsByEffect: new Map(), x: 0, text: '' } as unknown as StackItem;
  s.stack.push(item);
  assert.equal(assertInvariants(s), 'Lightning Bolt is on the stack and in a zone list');
  s.players[0].hand.pop();
  assert.equal(assertInvariants(s), null);
  // the same item on the stack twice
  s.stack.push(item);
  assert.equal(assertInvariants(s), 'stack item 9001 (Lightning Bolt) is on the stack twice');
});

test('assertInvariants: an attachment and its host both have to be on the battlefield', () => {
  const s = setup({ bf: ['Grizzly Bears', 'Pacifism'] }, { bf: ['Hill Giant'] }).state;
  const bf = s.players[0].battlefield;
  const bears = bf.find(o => o.def.name === 'Grizzly Bears')!;
  const aura = bf.find(o => o.def.name === 'Pacifism')!;
  aura.attachedTo = bears.id;
  assert.equal(assertInvariants(s), null);
  // the host left the battlefield but the aura stayed attached to it
  bf.splice(bf.indexOf(bears), 1); bears.zone = 'graveyard'; s.players[0].graveyard.push(bears);
  assert.equal(assertInvariants(s), 'Pacifism attached to Grizzly Bears in graveyard');
  // and the mirror image: the aura left the battlefield still attached to a host that is still there
  s.players[0].graveyard.pop(); bears.zone = 'battlefield'; bf.push(bears);
  bf.splice(bf.indexOf(aura), 1); aura.zone = 'graveyard'; s.players[0].graveyard.push(aura);
  assert.match(assertInvariants(s) ?? '', new RegExp(`^Pacifism in .*'s graveyard is still attached to ${bears.id}$`));
  aura.attachedTo = null;
  assert.equal(assertInvariants(s), null);
});

test('assertInvariants: a token may not survive outside the battlefield once the stack is empty', () => {
  const s = setup({ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }).state;
  const bears = s.players[0].battlefield.pop()!;
  bears.zone = 'graveyard'; s.players[0].graveyard.push(bears);
  assert.equal(assertInvariants(s), null);
  bears.token = { name: 'Bear', power: 2, toughness: 2, colors: [], types: ['Creature'], subtypes: ['Bear'], keywords: [] };
  assert.match(assertInvariants(s) ?? '', /^token Grizzly Bears is still in .*graveyard$/);
});

test('assertInvariants: an eliminated active player finishing its turn is legal (the engine carries it to cleanup)', () => {
  const s = setup({ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }).state;
  s.activePlayer = 0; s.priority = 1;
  s.players[0].lost = true; s.players[0].lossReason = 'drew from an empty library';
  assert.equal(assertInvariants(s), null, 'CR 800.4a leaves the turn structure alone; game.ts skips the lost seat instead');
});

test('trialCard records how many activated abilities the sandbox actually performed', async () => {
  const bolt = await trialCard(db, C('Lightning Bolt'), { seats: 2 });
  assert.deepEqual([bolt.abilities, bolt.reached], [0, 0], 'an instant has no activated abilities');
  const mill = await trialCard(db, C('Millstone'), { seats: 2 });
  assert.deepEqual([mill.abilities, mill.reached], [1, 1], 'the sandbox activates it the turn it lands');
  const tim = await trialCard(db, C('Prodigal Sorcerer'), { seats: 2 });
  assert.deepEqual([tim.abilities, tim.reached], [1, 0], 'summoning sick, so its tap ability stays unreached');
  const r = abilityReachability([{ ...bolt, seats: 2 }, { ...mill, seats: 2 }, { ...tim, seats: 2 }], 2);
  assert.deepEqual(r.buckets, { none: 1, some: 0, all: 1, no_abilities: 1 });
  assert.deepEqual([r.abilities, r.reached], [2, 1]);
  assert.deepEqual(r.worst, [{ name: 'Prodigal Sorcerer', oracleId: tim.oracleId, reached: 0, abilities: 1 }]);
});

test('CardDB.all: rowid windows partition the scan, and the paper tier is a subset of it', () => {
  const { min } = db.rowIdBounds();
  const ids = (from: number, to: number, tier?: 'all' | 'paper') => [...db.all({ from, to, tier })].map(d => d.oracleId);
  const whole = ids(min, min + 1999);
  assert.deepEqual([...ids(min, min + 999), ...ids(min + 1000, min + 1999)], whole, 'two windows in sequence are one scan');
  const paper = ids(min, min + 1999, 'paper');
  assert.ok(paper.length > 0 && paper.length < whole.length, `paper ${paper.length} of ${whole.length}`);
  assert.deepEqual(paper, whole.filter(id => paper.includes(id)), 'the tier only drops cards, it never reorders them');
  assert.equal(tierSql('all'), '');
  assert.equal(inTier(C('Contract from Below'), 'paper'), false, 'ante cards are their own tier');
  assert.equal(inTier(C('Lightning Bolt'), 'paper'), true);
});

/** A worker that answers `init` and then reports `failure` instead of ever finishing a chunk. */
function brokenWorker(failure: FromPoolWorker): PoolWorkerLike {
  const w: PoolWorkerLike = {
    onmessage: null,
    postMessage(msg) { setTimeout(() => w.onmessage?.(msg.type === 'init' ? { type: 'ready' } : failure), 0); },
    terminate() { w.onmessage = null; },
  };
  return w;
}

/** One broken worker in a pool of otherwise healthy ones: the healthy rows must not hide the failure. */
function mixedPool(failure: FromPoolWorker): () => PoolWorkerLike {
  let n = 0;
  return () => (n++ === 0 ? brokenWorker(failure) : inlinePoolWorker());
}

test('runPool fails the run when a chunk errors instead of quietly returning fewer cards', async () => {
  await assert.rejects(
    runPool(sampleIds(), { workers: 2, makeWorker: mixedPool({ type: 'error', chunkId: 0, message: 'out of memory' }) }),
    /chunk 0: out of memory/);
});

test('runPool fails the run when a worker dies without an error event (it used to hang forever)', async () => {
  await assert.rejects(
    runPool(sampleIds(), { workers: 2, makeWorker: mixedPool({ type: 'error', message: 'worker thread exited with code 1 before its chunk finished' }) }),
    /exited with code 1/);
});

test('a scan with a limit trials exactly the first N fully parsed cards in database order', async () => {
  const rows = await runPool({ scan: { limit: 5 } }, { workers: 2, inline: true });
  const expected: string[] = [];
  for (const d of db.all()) { if (!d.fullyParsed) continue; expected.push(d.oracleId); if (expected.length >= 5) break; }
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.oracleId), expected.slice().sort());
});
