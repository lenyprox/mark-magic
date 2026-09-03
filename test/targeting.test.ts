import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../src/engine/legal.js';
import { actionsForCard, assignBlock, beginAction, canConfirm, confirmRequirement, legalTargets, pickTarget, playableCardIds, setX, toggleAttacker } from '../src/play/targeting.js';
import { find, inHand, setup } from './helpers.js';
import type { LegalAction } from '../src/engine/state.js';

test('targeting: untargeted spell completes immediately; targeted spell walks requirements', async () => {
  const g = setup({ bf: ['Mountain', 'Forest', 'Forest'], hand: ['Lightning Bolt', 'Grizzly Bears'] }, { bf: ['Grizzly Bears'] });
  const legal = legalActions(g, 0);
  const bears = inHand(g, 'Grizzly Bears', 0), bolt = inHand(g, 'Lightning Bolt', 0), theirs = find(g, 'Grizzly Bears', 1);
  assert.deepEqual([...playableCardIds(legal)].sort(), [bears.id, bolt.id].sort());
  const castBears = actionsForCard(legal, bears.id)[0];
  const f0 = beginAction(castBears); assert.equal(f0.kind, 'done'); if (f0.kind === 'done') assert.equal(f0.action.type, 'cast');
  const castBolt = actionsForCard(legal, bolt.id)[0];
  let f = beginAction(castBolt); assert.equal(f.kind, 'targeting');
  if (f.kind !== 'targeting') return;
  const lt = legalTargets(f.state);
  assert.ok(lt.objects.has(theirs.id)); assert.ok(lt.players.has(1)); assert.equal(canConfirm(f.state), false);
  f = pickTarget(f.state, { kind: 'object', id: 999 }); assert.equal(f.kind, 'targeting'); // illegal click ignored
  f = pickTarget(f.state, { kind: 'object', id: theirs.id });
  assert.equal(f.kind, 'done'); if (f.kind === 'done') assert.deepEqual((f.action as { targets: unknown }).targets, [[{ kind: 'object', id: theirs.id }]]);
  assert.ok(await g.performAction(0, (f as { action: import('../src/engine/state.js').PlayerAction }).action));
});

test('targeting: optional requirement can be confirmed empty; X spells ask for X', () => {
  const fake: LegalAction = { action: { type: 'cast', cardId: 1, x: 4 }, label: 'cast X', targetOptions: [{ spec: 'up to one target creature', options: [{ kind: 'object', id: 7 }], optional: true, count: 1 }] };
  let f = beginAction(fake); assert.equal(f.kind, 'targeting');
  if (f.kind !== 'targeting') return;
  assert.equal(canConfirm(f.state), true);
  f = confirmRequirement(f.state); assert.equal(f.kind, 'x');
  if (f.kind !== 'x') return;
  const done = setX(f.state, 9); assert.equal(done.kind, 'done');
  if (done.kind === 'done') assert.deepEqual(done.action, { type: 'cast', cardId: 1, x: 4, targets: [[]] });
});

test('combat declaration helpers', () => {
  let a = toggleAttacker({ attackers: [1] }, 2, [1]); assert.deepEqual(a.attackers, [1, 2]);
  a = toggleAttacker(a, 1, [1]); assert.deepEqual(a.attackers, [1, 2], 'must-attack cannot be removed');
  a = toggleAttacker(a, 2, [1]); assert.deepEqual(a.attackers, [1]);
  let b = assignBlock({ blocks: [] }, 5, 1); b = assignBlock(b, 5, 2); assert.deepEqual(b.blocks, [{ blocker: 5, attacker: 2 }]);
  b = assignBlock(b, 5, null); assert.deepEqual(b.blocks, []);
});
