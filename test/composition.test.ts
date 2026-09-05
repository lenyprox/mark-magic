// Composition core (Phase 9.0): the ref resolver, the amount forms and the round-trips of every new ext / item field
// through clone, serialize and the redacted view. Real cards from master.db; see test/scenarios/composition.ts for the
// behavioural side (one scenario per op / Ref / amount form / delayed-trigger point / who scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalAmount, findObject, keywords, abilitiesOf, power, toughness, hasKeyword } from '../src/engine/characteristics.js';
import { cloneState } from '../src/engine/clone.js';
import { collectDefs, deserializeState, serializeState } from '../src/engine/serialize.js';
import { redact } from '../src/engine/view.js';
import { boundZoneOf, isRef, itemTargets, objectsIn, resolveOnePlayer, resolveRef, resolveWho, type RefCtx } from '../src/engine/refs.js';
import { childIndex, LIST_LIMIT, NESTING_LIMIT, ownTargetSpecs, targetingEffects } from '../src/engine/legal.js';
import { defaultAnswer } from '../src/engine/agents/defaults.js';
import type { StackItem } from '../src/engine/state.js';
import type { Amount, Effect } from '../src/cards/types.js';
import { AmountSchema, EffectSchema, TargetSpecSchema } from '../src/cards/schema.js';
import { runScenario, type Scenario } from './scenarios/dsl.js';
import { find, setup } from './helpers.js';

/** A stack item over `src` with the given bindings, the way applyEffect sees one. */
function itemFor(g: ReturnType<typeof setup>, src: ReturnType<typeof find>, extra: Partial<StackItem> = {}): StackItem {
  const item = g.makeStackItem('ability', src, src.controller, [], 'test', 0, undefined, 'test');
  return Object.assign(item, extra);
}
const ctxOf = (g: ReturnType<typeof setup>, item: StackItem): RefCtx => ({ s: g.state, item, p: item.actor ?? item.controller, src: item.source });

test('resolveRef: self, that, those, triggering, target:<i>, sacrificed and exiled-with resolve against the binding frame', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Hill Giant', 'Mountain'] }, { bf: ['Runeclaw Bear'] });
  const bears = find(g, 'Grizzly Bears', 0), giant = find(g, 'Hill Giant', 0), theirs = find(g, 'Runeclaw Bear', 1);
  const item = itemFor(g, bears, { triggeringId: theirs.id, sacrificed: [giant.id] });
  item.affected = [giant, theirs].map(o => ({ id: o.id, lastKnown: { power: 0, toughness: 0, controller: o.controller, manaValue: 0, zone: o.zone } }));
  item.targetsByEffect.set(0, [{ kind: 'object', id: theirs.id }, { kind: 'player', id: 1 }]);
  bears.exiledWith = [giant.id];
  const rc = ctxOf(g, item);
  assert.deepEqual(resolveRef(rc, 'self').map(o => o.id), [bears.id]);
  assert.deepEqual(resolveRef(rc, 'that').map(o => o.id), [giant.id]);
  assert.deepEqual(resolveRef(rc, 'those').map(o => o.id), [giant.id, theirs.id]);
  assert.deepEqual(resolveRef(rc, 'triggering').map(o => o.id), [theirs.id]);
  assert.deepEqual(resolveRef(rc, 'target:0').map(o => o.id), [theirs.id]);
  assert.deepEqual(resolveRef(rc, 'target:1'), [], 'the second target is a player, not an object');
  assert.deepEqual(resolveRef(rc, 'target:7'), []);
  assert.deepEqual(resolveRef(rc, 'sacrificed').map(o => o.id), [giant.id]);
  assert.deepEqual(resolveRef(rc, 'exiled-with').map(o => o.id), [giant.id]);
  assert.deepEqual(resolveRef(rc, 'enchanted'), [], 'not attached to anything');
  assert.equal(boundZoneOf(item, giant), 'battlefield');
  assert.equal(boundZoneOf(item, bears), undefined);
  assert.deepEqual(itemTargets(item).length, 2);
  assert.ok(isRef('that') && isRef('target:3') && !isRef('all-creatures') && !isRef('creatures-you-control'));
});

test('resolveRef: enchanted / equipped follow the attachment, and a binding survives the object moving to a public zone', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Hill Giant', 'Short Sword'] }, {});
  const bears = find(g, 'Grizzly Bears', 0), giant = find(g, 'Hill Giant', 0), sword = find(g, 'Short Sword', 0);
  g.attach(sword, giant);
  assert.deepEqual(resolveRef(ctxOf(g, itemFor(g, sword)), 'equipped').map(o => o.id), [giant.id]);
  assert.deepEqual(resolveRef(ctxOf(g, itemFor(g, sword)), 'enchanted').map(o => o.id), [giant.id], 'the same lookup for an Aura');
  const item = itemFor(g, bears);
  item.affected = [{ id: giant.id, lastKnown: { power: 3, toughness: 3, controller: 0, manaValue: 4, zone: 'battlefield' } }];
  g.moveTo(giant, 'graveyard');
  assert.deepEqual(resolveRef(ctxOf(g, item), 'that').map(o => o.id), [giant.id], 'still found in the graveyard: each op decides whether the binding holds (CR 400.7)');
  assert.equal(boundZoneOf(item, giant), 'battlefield');
  assert.equal(findObject(g.state, giant.id)?.zone, 'graveyard');
});

test('resolveWho / resolveOnePlayer: APNAP order, opponents, target and that players, controller-of-that', () => {
  const g = setup({ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] });
  const bears = find(g, 'Grizzly Bears', 0), giant = find(g, 'Hill Giant', 1);
  const item = itemFor(g, bears);
  item.targetsByEffect.set(0, [{ kind: 'player', id: 1 }]);
  item.affected = [{ id: giant.id, lastKnown: { power: 3, toughness: 3, controller: 1, manaValue: 4, zone: 'battlefield' } }];
  const rc = ctxOf(g, item);
  assert.deepEqual(resolveWho(rc, 'you'), [0]);
  assert.deepEqual(resolveWho(rc, 'each-player'), [0, 1], 'active player first (CR 101.4)');
  assert.deepEqual(resolveWho(rc, 'each-opponent'), [1]);
  assert.deepEqual(resolveWho(rc, 'target-player'), [1]);
  assert.equal(resolveOnePlayer(rc, 'controller-of-that'), 1);
  assert.equal(resolveOnePlayer(rc, 'that-player'), 1, 'no triggering player: the controller of that');
  item.triggeringPlayer = 0;
  assert.equal(resolveOnePlayer(rc, 'that-player'), 0, 'the player the trigger was about wins');
  g.state.activePlayer = 1;
  assert.deepEqual(resolveWho(rc, 'each-player'), [1, 0], 'APNAP follows the active player');
  item.actor = 1;
  assert.deepEqual(resolveWho(ctxOf(g, item), 'each-opponent'), [0], "'you' inside a scoped block is the actor");
  g.state.players[1].lost = true;
  assert.deepEqual(resolveWho(rc, 'each-opponent'), [], 'eliminated players are skipped');
});

test('objectsIn: zone and who select the set; the battlefield is by controller, other zones by owner', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Mountain'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] });
  const bears = find(g, 'Grizzly Bears', 0);
  const rc = ctxOf(g, itemFor(g, bears));
  assert.deepEqual(objectsIn(rc, { types: ['Creature'] }).map(o => o.def.name), ['Grizzly Bears', 'Hill Giant', 'Runeclaw Bear'], 'every player, APNAP');
  assert.deepEqual(objectsIn(rc, { types: ['Creature'], who: 'you' }).map(o => o.def.name), ['Grizzly Bears']);
  assert.deepEqual(objectsIn(rc, { types: ['Creature'], who: 'each-opponent' }).length, 2);
  g.moveTo(find(g, 'Hill Giant', 1), 'graveyard');
  assert.deepEqual(objectsIn(rc, { zone: 'graveyard' }).map(o => o.def.name), ['Hill Giant']);
  assert.deepEqual(objectsIn(rc, { zone: 'graveyard', who: 'you' }), []);
  assert.deepEqual(objectsIn(rc, { zone: 'library', who: 'you' }).length, g.state.players[0].library.length);
});

test('evalAmount: objects, diff (clamped), sum, max, min, prop, half, cap, times and plus — recursively', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Hill Giant'], life: 13 }, { bf: ['Runeclaw Bear', 'Wind Drake', 'Mountain'] });
  const s = g.state; const bears = find(g, 'Grizzly Bears', 0), giant = find(g, 'Hill Giant', 0);
  const item = itemFor(g, bears);
  item.affected = [{ id: giant.id, lastKnown: { power: 3, toughness: 3, controller: 0, manaValue: 4, zone: 'battlefield' } }];
  item.targetsByEffect.set(0, [{ kind: 'player', id: 1 }]);
  const rc = ctxOf(g, item);
  const ev = (a: Amount) => evalAmount(s, a, 0, 2, bears, { refs: rc, T: [] });
  assert.equal(ev({ count: 'objects', filter: { types: ['Creature'] } }), 4);
  assert.equal(ev({ count: 'objects', filter: { types: ['Creature'] }, who: 'you' }), 2);
  assert.equal(ev({ count: 'objects', who: 'each-opponent' }), 3, 'no filter: every permanent of theirs');
  assert.equal(ev({ diff: [{ count: 'objects', who: 'each-opponent' }, { count: 'creatures-you-control' }] }), 1);
  assert.equal(ev({ diff: [1, 5] }), 0, 'CR 107.1b: never negative');
  assert.equal(ev({ sum: [1, 'X', { count: 'creatures-you-control' }] }), 5);
  assert.equal(ev({ max: [1, 'X', { count: 'creatures-you-control' }] }), 2);
  assert.equal(ev({ min: [7, 'X', { count: 'creatures-you-control' }] }), 2);
  assert.equal(ev({ max: [] }), 0); assert.equal(ev({ min: [] }), 0);
  assert.equal(ev({ prop: 'power', of: 'that' }), 3); assert.equal(ev({ prop: 'toughness', of: 'self' }), 2); assert.equal(ev({ prop: 'mv', of: 'that' }), 4);
  assert.equal(ev({ prop: 'life', of: 'you' }), 13); assert.equal(ev({ prop: 'life', of: 'target-player' }), 20);
  assert.equal(ev({ prop: 'cards-in-hand', of: 'that-player' }), 0);
  assert.equal(ev({ count: 'objects', filter: { types: ['Creature'] }, half: 'up' }), 2);
  assert.equal(ev({ count: 'objects', filter: { types: ['Creature'] }, plus: 1, half: 'down' }), 2);
  assert.equal(ev({ count: 'objects', filter: { types: ['Creature'] }, times: 3, plus: 1, max: 10 }), 10, 'the cap applies last');
  assert.equal(ev({ sum: [{ diff: [{ prop: 'life', of: 'you' }, 'X'] }, { min: [1, 2] }] }), 12, 'forms nest');
  // no binding frame: the legacy `that` snapshot answers power / mv, and a player prop of 'you' is the controller
  assert.equal(evalAmount(s, { prop: 'power', of: 'that' }, 0, 0, bears, { that: { power: 9, manaValue: 1 } }), 9);
  assert.equal(evalAmount(s, { prop: 'life', of: 'you' }, 1), 20);
  // an object that left the battlefield answers with its last known values (CR 608.2h)
  g.moveTo(giant, 'graveyard');
  assert.equal(ev({ prop: 'power', of: 'that' }), 3);
});

test('evalAmount: times / plus / half / max apply to every form, and a frameless objects count honours who', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear', 'Wind Drake', 'Hill Giant'] });
  const s = g.state; const bears = find(g, 'Grizzly Bears', 0);
  const ev = (a: Amount) => evalAmount(s, a, 0, 0, bears);   // no ctx: the slots dynamicPT / self-pt / reduce / perEach / mvLE evaluate in
  assert.equal(ev({ prop: 'power', of: 'self', times: 2 }), 4);
  assert.equal(ev({ prop: 'power', of: 'self', plus: 5 }), 7);
  assert.equal(ev({ prop: 'toughness', of: 'self', half: 'down' }), 1);
  assert.equal(ev({ prop: 'toughness', of: 'self', half: 'up' }), 1);
  assert.equal(ev({ prop: 'power', of: 'self', times: 3, plus: 1, max: 5 }), 5, 'the same order as a count: × times, + plus, half, cap');
  assert.equal(ev({ diff: [5, 2], plus: 10 }), 13);
  assert.equal(ev({ diff: [5, 2], max: 1 }), 1);
  assert.equal(ev({ sum: [1, 2], times: 3 }), 9);
  assert.equal(ev({ min: [4, 9], half: 'up' }), 2);
  assert.equal(ev({ max: [1, 4], times: 2, plus: 1, half: 'down' }), 4, 'a max LIST is the form; the cap is the numeric max only');
  const creatures = { types: ['Creature'] as const };
  assert.equal(ev({ count: 'objects', filter: { ...creatures } }), 5, 'no who: every player, as before');
  assert.equal(ev({ count: 'objects', filter: { ...creatures }, who: 'each-player' }), 5);
  assert.equal(ev({ count: 'objects', filter: { ...creatures }, who: 'you' }), 2);
  assert.equal(ev({ count: 'objects', filter: { ...creatures }, who: 'each-opponent' }), 3);
  for (const who of ['target-player', 'that-player', 'controller-of-that'] as const) assert.equal(ev({ count: 'objects', filter: { ...creatures }, who }), 0, `${who} names nobody without a binding frame`);
  assert.equal(ev({ count: 'objects', zone: 'library', who: 'you' }), s.players[0].library.length);
  assert.equal(ev({ count: 'objects', zone: 'library', who: 'each-opponent' }), s.players[1].library.length);
});

test('childIndex: six levels of 63 children stay distinct and ordered; the seventh level and the 64th child throw', () => {
  const keys = new Set<number>(); let parent = 0, sibling = 1;
  for (let d = 1; d <= NESTING_LIMIT; d++) {
    for (let k = 0; k < LIST_LIMIT; k++) keys.add(childIndex(parent, k));
    assert.ok(childIndex(parent, 0) > parent && childIndex(parent, LIST_LIMIT - 1) < sibling, `level ${d}: the children lie strictly between their container and its next sibling`);
    sibling = childIndex(parent, 2); parent = childIndex(parent, 1);
  }
  assert.equal(keys.size, NESTING_LIMIT * LIST_LIMIT, 'no two keys collide across six levels');
  const l1 = childIndex(0, 0), l2 = childIndex(l1, 0), l3 = childIndex(l2, 0);
  assert.notEqual(childIndex(l3, 0), childIndex(l2, 1), 'a fourth-level child is not its parent\'s next sibling');
  assert.throws(() => childIndex(parent, 0), /nest at most 6 deep/, 'the seventh level');
  assert.throws(() => childIndex(0, LIST_LIMIT), /at most 63 effects/, 'the 64th child would be the next top-level effect');
});

test('targetingEffects: multi parts, container children under childIndex, move / exchange / who target-player', () => {
  const effects: Effect[] = [
    { op: 'damage', amount: 1, target: { kind: 'multi', specs: [{ kind: 'creature' }, { kind: 'player' }] } },
    { op: 'for-each', over: { types: ['Creature'] }, do: [{ op: 'tap', target: { kind: 'creature' } }, { op: 'scoped', who: 'target-player', do: [{ op: 'draw', amount: 1, who: 'you' }] }] },
    { op: 'exchange', what: 'control', a: { kind: 'creature', controller: 'you' }, b: { kind: 'creature', controller: 'opponent' } },
    { op: 'move', what: { kind: 'artifact' }, to: 'exile', controller: 'target-player' },
    { op: 'unless-pays', who: 'target-player', cost: { mana: { generic: 1, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{1}' } }, otherwise: [] },
  ];
  const reqs = targetingEffects(effects);
  assert.deepEqual(reqs.map(r => [r.index, r.spec.kind, r.part]), [
    [0, 'creature', 0], [0, 'player', 1],
    [childIndex(1, 0), 'creature', undefined], [childIndex(1, 1), 'player', undefined],
    [2, 'creature', 0], [2, 'creature', 1],
    [3, 'artifact', undefined], [3, 'player', 1],
    [4, 'player', undefined],
  ]);
  assert.ok(childIndex(1, 0) > 1 && childIndex(1, 0) < 2 && childIndex(1, 1) > childIndex(1, 0));
  assert.equal(childIndex(childIndex(1, 1), 0) - childIndex(1, 1), 1 / 4096, 'one more base-64 digit per level');
  assert.deepEqual(ownTargetSpecs(effects[0]).map(t => t.kind), ['multi']);
  assert.deepEqual(ownTargetSpecs({ op: 'fight', target: { kind: 'creature' }, self: false }).map(t => t.controller), ['you', undefined], "fight's own creature first");
  assert.deepEqual(targetingEffects([{ op: 'draw', amount: 1, who: 'target-player' }]), [{ index: 0, spec: { kind: 'player' } }], 'legacy shapes are unchanged');
  // the older containers hand their children their own index, so what is nested in them is keyed with it — a composition
  // container inside still keys ITS children apart; a delayed / reflexive trigger chooses its targets when it fires
  const shared: Effect[] = [
    { op: 'conditional', condition: { kind: 'opponents-ge', value: 1 }, then: [{ op: 'for-each', over: { types: ['Creature'] }, do: [{ op: 'damage', amount: 3, target: { kind: 'creature' } }] }], else: [{ op: 'optional-pay', mana: { generic: 1, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{1}' }, then: [{ op: 'tap', target: { kind: 'artifact' } }] }] },
    { op: 'optional-then', first: [{ op: 'gain-life', amount: 1, who: 'you' }], then: [{ op: 'destroy', target: { kind: 'creature' } }] },
    { op: 'delayed-trigger', at: 'next-upkeep', effects: [{ op: 'destroy', target: { kind: 'creature' } }] },
    { op: 'reflexive', when: 'you-do', effects: [{ op: 'destroy', target: { kind: 'creature' } }] },
  ];
  assert.deepEqual(targetingEffects(shared).map(r => [r.index, r.spec.kind]), [[childIndex(0, 0), 'creature'], [0, 'artifact'], [1, 'creature']], 'older containers pass their own index through');
});

test('new ext and item fields round-trip through clone, serialize and the redacted view', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Hill Giant'], hand: ['Lightning Bolt'] }, { bf: ['Runeclaw Bear'] });
  const s = g.state; const bears = find(g, 'Grizzly Bears', 0), giant = find(g, 'Hill Giant', 0);
  (bears.ext ??= {}).setPT = { power: 5, toughness: 6, base: true, untilTurn: 5 };
  (giant.ext ??= {}).lost = { all: true, untilTurn: 5 };
  s.delayed = [{ id: 7, at: 'this-turn:dies', controller: 0, sourceId: bears.id, sourceName: 'Grizzly Bears', effects: [{ op: 'draw', amount: 1, who: 'you' }], affected: [{ id: giant.id, lastKnown: { power: 3, toughness: 3, controller: 0, manaValue: 4, zone: 'battlefield' } }], bind: 'those', createdTurn: 5 }];
  const item = g.makeStackItem('ability', bears, 0, [{ op: 'may', effects: [] }], 'x', 0, undefined, 'x');
  item.actor = 1; item.sacrificed = [giant.id]; item.targetParts = { 0: [1, 2] };
  item.affected = [{ id: giant.id, lastKnown: { power: 3, toughness: 3, controller: 0, manaValue: 4, zone: 'battlefield' } }];
  s.stack.push(item);
  assert.equal(power(s, bears), 5); assert.equal(toughness(s, bears), 6);
  assert.deepEqual(abilitiesOf(giant), []); assert.deepEqual(keywords(s, giant), []);
  const check = (c: typeof s, label: string) => {
    const b = findObject(c, bears.id)!, h = findObject(c, giant.id)!;
    assert.deepEqual(b.ext?.setPT, { power: 5, toughness: 6, base: true, untilTurn: 5 }, `${label}: setPT`);
    assert.deepEqual(h.ext?.lost, { all: true, untilTurn: 5 }, `${label}: lost`);
    assert.equal(power(c, b), 5, `${label}: setPT is honoured on the copy`);
    assert.deepEqual(abilitiesOf(h), [], `${label}: lost is honoured on the copy`);
    assert.deepEqual(c.delayed, s.delayed, `${label}: delayed triggers with bind and zone`);
    assert.equal(c.stack[0].actor, 1, `${label}: actor`); assert.deepEqual(c.stack[0].sacrificed, [giant.id], `${label}: sacrificed`);
    assert.equal(c.stack[0].affected?.[0].lastKnown.zone, 'battlefield', `${label}: affected zone`);
    assert.deepEqual(c.stack[0].targetParts, { 0: [1, 2] }, `${label}: targetParts`);
  };
  const c = cloneState(s); check(c, 'clone');
  assert.notEqual(c.delayed![0].affected, s.delayed![0].affected, 'clone copies, it does not alias');
  assert.notEqual(c.stack[0].targetParts![0], s.stack[0].targetParts![0], 'targetParts is copied, not aliased');
  c.delayed![0].affected![0].lastKnown.power = 99; assert.equal(s.delayed![0].affected![0].lastKnown.power, 3);
  const back = deserializeState(JSON.parse(JSON.stringify(serializeState(s))), collectDefs(s)); check(back, 'serialize');
  check(redact(s, 1), 'redacted view');
});

test('the lost / setPT entries end when the object leaves the battlefield or when the turn is cleaned up', async () => {
  const g = setup({ bf: ['Grizzly Bears'] }, {});
  const s = g.state; const bears = find(g, 'Grizzly Bears', 0);
  (bears.ext ??= {}).setPT = { power: 7, toughness: 7 }; bears.ext.lost = { keywords: ['flying'] };
  g.moveTo(bears, 'hand');
  assert.equal(bears.ext.setPT, undefined); assert.equal(bears.ext.lost, undefined);
  const sc: Scenario = {
    name: 'eot wipe', cr: '514.2',
    seats: [{ bf: ['Grizzly Bears', 'Wind Drake'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'set-pt', target: 'self', power: 7, toughness: 7, duration: 'eot' }, { op: 'lose-abilities', target: 'all-creatures', keywords: ['flying'], duration: 'eot' }, { op: 'lose-abilities', target: 'self', duration: 'permanent' }], text: 'x' }] } },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 7, 7] }, { ext: ['Grizzly Bears', 'lost', { all: true }] }, { ext: ['Wind Drake', 'lost', { keywords: ['flying'], untilTurn: 5 }] }],
  };
  const run = await runScenario(sc);
  assert.deepEqual(run.failures, []);
  const g2 = run.game; const drake = find(g2, 'Wind Drake', 0), b2 = find(g2, 'Grizzly Bears', 0);
  assert.equal(hasKeyword(g2.state, drake, 'flying'), false);
  await g2.resumeTurn();                                                           // through this turn's cleanup
  assert.equal(drake.ext?.lost, undefined, 'the until-end-of-turn loss is gone'); assert.equal(hasKeyword(g2.state, drake, 'flying'), true);
  assert.equal(b2.ext?.setPT, undefined, 'the eot set-pt is gone'); assert.equal(power(g2.state, b2), 2);
  assert.deepEqual(b2.ext?.lost, { all: true }, 'a permanent loss survives the wipe (and an eot loss never shortens it)');
});

test('the schema accepts the documented shapes and rejects the malformed ones', () => {
  const ok = (v: unknown, schema: { safeParse(v: unknown): { success: boolean } } = EffectSchema) => assert.ok(schema.safeParse(v).success, JSON.stringify(v));
  const bad = (v: unknown, schema: { safeParse(v: unknown): { success: boolean } } = EffectSchema) => assert.ok(!schema.safeParse(v).success, `accepted: ${JSON.stringify(v)}`);
  ok({ op: 'for-each', over: { types: ['Creature'], who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] });
  ok({ op: 'move', what: 'target:0', to: 'exile', until: 'eot' });
  ok({ op: 'move', what: { filter: {}, zone: 'graveyard', who: 'you', count: 'all', choose: 'random' }, to: 'battlefield', controller: 'you', tapped: true, withCounters: { counter: '+1/+1', amount: { prop: 'mv', of: 'that' } } });
  ok({ op: 'exchange', what: 'life', a: 'you', b: 'target-player' });
  ok({ op: 'unless-pays', who: 'each-opponent', cost: { sacrifice: { types: ['Creature'] } }, otherwise: [{ op: 'lose-life', amount: 2, who: 'you' }] });
  ok({ op: 'set-pt', target: 'creatures-you-control', power: 0, toughness: { sum: [1, 'X'] }, base: true, duration: 'eot' });
  ok({ op: 'lose-abilities', target: { kind: 'creature' }, duration: 'permanent' });
  ok({ op: 'damage', amount: 1, target: { kind: 'multi', specs: [{ kind: 'creature' }, { kind: 'player' }] } });
  ok({ op: 'delayed-trigger', at: 'this-turn:dies', bind: 'those', effects: [] });
  bad({ op: 'move', what: 'nowhere', to: 'exile' });
  bad({ op: 'move', what: 'that', to: 'stack' });
  bad({ op: 'set-pt', target: 'self', power: 1, duration: 'eot' }, EffectSchema);
  bad({ op: 'bind', as: 'those', from: 'targets' });
  bad({ op: 'reflexive', when: 'you-dont', effects: [] });
  bad({ op: 'exchange', what: 'mana', a: 'you', b: 'you' });
  ok({ count: 'objects', filter: { types: ['Land'] }, zone: 'graveyard', who: 'each-player', half: 'up', max: 3 }, AmountSchema);
  ok({ diff: [{ count: 'opponents' }, 1] }, AmountSchema); ok({ max: [1, 2] }, AmountSchema); ok({ prop: 'power', of: 'sacrificed' }, AmountSchema);
  bad({ count: 'opponents', diff: [1, 2] }, AmountSchema); bad({ diff: [1, 2], sum: [1] }, AmountSchema); bad({ prop: 'power' }, AmountSchema); bad({ filter: {} }, AmountSchema); bad({}, AmountSchema);
  ok({ kind: 'multi', specs: [{ kind: 'creature' }, { kind: 'artifact' }] }, TargetSpecSchema);
  bad({ kind: 'multi', specs: [{ kind: 'creature' }] }, TargetSpecSchema); bad({ kind: 'creature', specs: [] }, TargetSpecSchema);
});

test('the default answers for the new decisions take the optional action and pay', () => {
  const g = setup({}, {});
  assert.equal(defaultAnswer(g.state, 0, { kind: 'may', prompt: 'x', source: 'y' }), true);
  assert.equal(defaultAnswer(g.state, 0, { kind: 'unless-pays', prompt: 'x', cost: '{2}', source: 'y' }), true);
});
