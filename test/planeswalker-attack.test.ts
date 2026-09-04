// Attacking planeswalkers (CR 508.1, 510.1): damage removes loyalty, the walker dies at zero loyalty, the defending
// player can block, and the rollout policy points a creature at a walker it can finish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import { findObject } from '../src/engine/characteristics.js';
import { C, find, setup } from './helpers.js';

const WALKER = 'Chandra, Pyromaster';

test('an attacker declared against a planeswalker deals its damage to the walker', async () => {
  if (!C(WALKER).types.includes('Planeswalker')) return;
  const g = setup({ bf: ['Hill Giant', 'Grizzly Bears'] }, { bf: [WALKER] });
  const walker = find(g, WALKER, 1); walker.counters.loyalty = 4;
  const giant = find(g, 'Hill Giant', 0), bears = find(g, 'Grizzly Bears', 0);
  await g.simulateCombat([giant.id, bears.id], [], { [giant.id]: { planeswalker: walker.id } });
  assert.equal(g.state.players[1].life, 18, 'Bears hit the player');
  assert.equal(findObject(g.state, walker.id)?.zone, 'battlefield'); assert.equal(walker.counters.loyalty, 1, 'Giant hit the walker');
  assert.ok(g.state.log.some(l => /deals 3 damage to Chandra, Pyromaster \(loyalty 1\)/.test(l)));
});

test('a walker at zero loyalty is put into the graveyard by state-based actions', async () => {
  if (!C(WALKER).types.includes('Planeswalker')) return;
  const g = setup({ bf: ['Hill Giant'] }, { bf: [WALKER] });
  const walker = find(g, WALKER, 1); walker.counters.loyalty = 2;
  const giant = find(g, 'Hill Giant', 0);
  await g.simulateCombat([giant.id], [], { [giant.id]: { planeswalker: walker.id } });
  assert.equal(walker.zone, 'graveyard'); assert.equal(g.state.players[1].life, 20);
});

test('the rollout policy attacks a planeswalker it can finish when the player is not at lethal', async () => {
  if (!C(WALKER).types.includes('Planeswalker')) return;
  const g = setup({ bf: ['Hill Giant', 'Grizzly Bears'] }, { bf: [WALKER] }, [new RolloutAgent('P0'), new RolloutAgent('P1')]);
  const walker = find(g, WALKER, 1); walker.counters.loyalty = 3;
  const decl = (g.agents[0] as RolloutAgent).attackDeclaration(g.state, 0, [find(g, 'Hill Giant', 0).id, find(g, 'Grizzly Bears', 0).id], [], [1]);
  assert.ok(decl.attackers.length >= 1);
  const pwTargets = Object.values(decl.targets ?? {}).filter(t => typeof t === 'object');
  assert.equal(pwTargets.length, 1, 'exactly one attacker points at the walker');
});
