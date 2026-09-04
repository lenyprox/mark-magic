// The pure part of the animation queue: durations per event kind and speed, reduced motion, batching of silent
// events, the decision-latency rule, involvement sets, rule chips and the plain-words descriptions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameEvent } from '../src/engine/events.js';
import { BASE_MS, batchEvents, chipFor, classify, clampSpeed, describeEvent, durationFor, involvedInEvent, isExplainable, RUSH_THRESHOLD_MS, shouldRush, totalDuration } from '../src/play/anim.js';
import { ruleFor } from '../src/rules/cite.js';
import { CITED, compareRuleNumbers, isRuleNumber } from '../src/rules/cited.js';
import excerpts from '../apps/web/lib/rules/cr-excerpts.json' with { type: 'json' };

const ev = (body: Omit<GameEvent, 'seq' | 'turn' | 'step' | 'text'>, text = ''): GameEvent => ({ seq: 1, turn: 1, step: 'main1', text, ...body } as GameEvent);
const pname = (p: number) => (p === 0 ? 'You' : 'AI');

test('durationFor follows the mapping table, scales with speed and zeroes under reduced motion', () => {
  const draw = ev({ type: 'draw', player: 0, id: 1, name: 'x', public: false, stepDraw: true });
  assert.equal(durationFor(draw), 280);
  assert.equal(durationFor(draw, 2), 140);
  assert.equal(durationFor(draw, 4), 70);
  assert.equal(durationFor(draw, 0.5), 560);
  assert.equal(durationFor(draw, 1, true), 0);
  assert.equal(durationFor(draw, 1, false, true), 560, 'explain halves the speed');
  assert.equal(durationFor(draw, 99), 70, 'speed is clamped to 4');
  assert.equal(clampSpeed(NaN), 1);
  const land = ev({ type: 'zone-change', id: 2, name: 'Mountain', owner: 0, controller: 0, from: 'hand', to: 'battlefield', reason: 'play', token: false, public: true, tapped: false });
  assert.equal(durationFor(land), 320);
  assert.equal(durationFor(ev({ type: 'cast', itemId: 9, id: 3, name: 'Bolt', player: 0, targets: [], how: [] })), 380);
  assert.equal(durationFor(ev({ type: 'tap', id: 2, name: 'Mountain', tapped: true, reason: 'mana' })), 40);
  assert.equal(durationFor(ev({ type: 'trigger', itemId: 10, id: 3, name: 'x', player: 0, ability: 'a', targets: [] })), 240);
  assert.equal(durationFor(ev({ type: 'resolve', itemId: 9, name: 'Bolt', kind: 'spell' })), 360);
  assert.equal(durationFor(ev({ type: 'countered', itemId: 9, name: 'Bolt' })), 320);
  assert.equal(durationFor(ev({ type: 'countered', itemId: 9, name: 'Bolt', unlessPaid: true })), 0);
  assert.equal(durationFor(ev({ type: 'damage', sourceId: 3, source: 'Bolt', player: 1, amount: 3, combat: false, total: 17 })), 320);
  assert.equal(durationFor(ev({ type: 'counter', id: 4, name: 'Bears', counter: '+1/+1', delta: 1, total: 1 })), 220);
  assert.equal(durationFor(ev({ type: 'zone-change', id: 5, name: 'Soldier', owner: 0, controller: 0, from: 'none', to: 'battlefield', reason: 'token', token: true, public: true })), 280);
  assert.equal(durationFor(ev({ type: 'sba', kind: 'lethal-damage', id: 4, name: 'Bears' })), 420);
  assert.equal(durationFor(ev({ type: 'attack', player: 0, target: 1, attackers: [{ id: 4, name: 'Bears' }] })), 260);
  assert.equal(durationFor(ev({ type: 'attack', player: 0, target: 1, attackers: [] })), 0);
  assert.equal(durationFor(ev({ type: 'step', player: 0, to: 'upkeep' })), 160);
  assert.equal(durationFor(ev({ type: 'turn', player: 0, number: 2 })), 500);
  assert.equal(durationFor(ev({ type: 'mana', player: 0, added: ['R'] })), 0);
  assert.equal(classify(ev({ type: 'zone-change', id: 3, name: 'Bolt', owner: 0, controller: 0, from: 'hand', to: 'stack', reason: 'cast', token: false, public: true })), 'silent');
  for (const [k, ms] of Object.entries(BASE_MS)) assert.ok(ms >= 0 && ms <= 600, `${k} ${ms}`);
});

test('batching folds silent events into the next timed one; rush rule; totals', () => {
  const evs: GameEvent[] = [
    ev({ type: 'tap', id: 2, name: 'Mountain', tapped: true, reason: 'mana' }),
    ev({ type: 'mana', player: 0, added: ['R'] }),
    ev({ type: 'zone-change', id: 3, name: 'Bolt', owner: 0, controller: 0, from: 'hand', to: 'stack', reason: 'cast', token: false, public: true }),
    ev({ type: 'cast', itemId: 9, id: 3, name: 'Bolt', player: 0, targets: [], how: [] }),
    ev({ type: 'note', text: 'x' }),
  ];
  const b = batchEvents(evs);
  assert.deepEqual(b.map(x => [x.events.length, x.duration]), [[1, 40], [3, 380], [1, 0]]);
  assert.equal(totalDuration(evs), 420);
  assert.equal(totalDuration(evs, 1, true), 0);
  assert.equal(shouldRush(RUSH_THRESHOLD_MS), false);
  assert.equal(shouldRush(RUSH_THRESHOLD_MS + 1), true);
});

test('involvement, chips and words', () => {
  const dmg = ev({ type: 'damage', sourceId: 3, source: 'Lightning Bolt', targetId: 4, target: 'Grizzly Bears', amount: 3, combat: false, total: 3 });
  assert.deepEqual(involvedInEvent(dmg), { objects: [3, 4], players: [] });
  assert.equal(chipFor(dmg), '120.3');
  assert.equal(describeEvent(dmg, pname), 'Lightning Bolt deals 3 damage to Grizzly Bears (3 marked).');
  const block = ev({ type: 'block', player: 1, blocks: [{ blocker: 7, blockerName: 'Wall', attacker: 4, attackerName: 'Bears' }] });
  assert.deepEqual(involvedInEvent(block).objects, [7, 4]);
  assert.equal(describeEvent(block, pname), 'AI blocks: Bears with Wall.');
  const draw = ev({ type: 'draw', player: 1, id: 1, name: '', public: false, stepDraw: true });
  assert.equal(describeEvent(draw, pname), 'AI draws for the turn.');
  const sba = ev({ type: 'sba', kind: 'lethal-damage', id: 4, name: 'Bears', cr: '704.5g' } as unknown as Omit<GameEvent, 'seq' | 'turn' | 'step' | 'text'>);
  assert.equal(chipFor(sba), '704.5g');
  assert.match(describeEvent(sba, pname), /lethal damage/);
  // renumbered keyword actions are corrected for display
  assert.equal(ruleFor(ev({ type: 'zone-change', id: 4, name: 'Bears', owner: 1, controller: 1, from: 'battlefield', to: 'graveyard', reason: 'destroy', token: false, public: true })), '701.8a');
  assert.equal(ruleFor(ev({ type: 'tap', id: 2, name: 'Mountain', tapped: true, reason: 'mana' })), '701.26a');
  assert.equal(ruleFor(ev({ type: 'countered', itemId: 9, name: 'Bolt' })), '701.6a');
  assert.equal(ruleFor(ev({ type: 'cast', itemId: 9, id: 3, name: 'Bolt', player: 0, targets: [], how: [] })), '601.2');
  assert.equal(isExplainable(ev({ type: 'mana', player: 0, added: ['R'] })), false);
  assert.equal(isExplainable(dmg), true);
});

test('the bundled CR excerpt covers the cited numbers (with the one known gap) and stays under budget', () => {
  const rules = (excerpts as { version: string; rules: Record<string, string> }).rules;
  assert.ok(CITED.length >= 100);
  assert.ok(CITED.every(isRuleNumber));
  assert.deepEqual([...CITED].sort(compareRuleNumbers), CITED);
  const missing = CITED.filter(n => !rules[n]);
  assert.deepEqual(missing, ['701.21b'], 'only the engine\'s stale untap citation is absent from the current CR');
  for (const n of ['601.2', '704.5g', '121.1', '305.2', '701.26a', '701.8a', '117.1a']) assert.ok(rules[n]?.length > 20, n);
  assert.ok(Buffer.byteLength(JSON.stringify(excerpts)) <= 40 * 1024);
});
