// Manual mana (D5 engine contract): legal cast actions carry the engine's payment plan, and a cast may name the
// permanents to tap; an insufficient choice falls back to automatic payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalActions } from '../src/engine/legal.js';
import { find, inHand, setup } from './helpers.js';

test('legal cast actions expose the auto-payment plan; pay.sources taps the chosen lands', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain', 'Forest', 'Forest'], hand: ['Lightning Bolt', 'Grizzly Bears'] }, {});
  g.state.priority = 0;
  const bolt = inHand(g, 'Lightning Bolt', 0);
  const l = legalActions(g, 0).find(x => x.action.type === 'cast' && x.action.cardId === bolt.id)!;
  assert.ok(l.pay, 'a payment plan is attached'); assert.equal(l.pay!.cost, '{R}'); assert.equal(l.pay!.taps.length, 1); assert.equal(l.pay!.taps[0].name, 'Mountain'); assert.deepEqual(l.pay!.taps[0].mana, ['R']);
  const mountains = g.state.players[0].battlefield.filter(o => o.def.name === 'Mountain');
  // pay with the second Mountain explicitly
  const ok = await g.performAction(0, { ...l.action, targets: [[{ kind: 'player', id: 1 }]], pay: { sources: [mountains[1].id] } });
  assert.ok(ok); assert.ok(mountains[1].tapped && !mountains[0].tapped, 'the named land was tapped');
  await g.resolveStackFully();
  // Bears: name a single Forest (insufficient for {1}{G}) → falls back to an automatic payment that still uses it
  const bears = inHand(g, 'Grizzly Bears', 0);
  const forests = g.state.players[0].battlefield.filter(o => o.def.name === 'Forest');
  const lb = legalActions(g, 0).find(x => x.action.type === 'cast' && x.action.cardId === bears.id)!;
  assert.equal(lb.pay!.taps.length, 2);
  const ok2 = await g.performAction(0, { ...lb.action, pay: { sources: [forests[0].id] } });
  assert.ok(ok2); assert.ok(forests[0].tapped, 'the preferred land was used'); assert.equal(g.state.players[0].battlefield.filter(o => o.tapped).length, 3);
  void find;
});
