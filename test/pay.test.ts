// Manual-mana helpers: which permanents produce what, when the pay tray should ask, and how a chosen land seeds the
// source list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costPips, initialSources, isAmbiguousPayment, isManaSource, manaColorsOf, shouldAskToPay, untappedManaSources, type PaySuggestion } from '../src/play/pay.js';
import { card, land, perm, player } from './drag-fixtures.js';

const forest = () => land('Forest', { typeLine: 'Basic Land — Forest' });

test('manaColorsOf reads basic land types and "Add" text', () => {
  assert.deepEqual(manaColorsOf(land('Mountain')), ['R']);
  assert.deepEqual(manaColorsOf(land('Stomping Ground', { typeLine: 'Land — Mountain Forest' })).sort(), ['G', 'R']);
  assert.deepEqual(manaColorsOf(card('Sol Ring', { types: ['Artifact'], text: '{T}: Add {C}{C}.' })), ['C']);
  assert.deepEqual(manaColorsOf(card('Birds of Paradise', { types: ['Creature'], text: 'Flying\n{T}: Add one mana of any color.' })).sort(), ['B', 'G', 'R', 'U', 'W']);
  assert.deepEqual(manaColorsOf(card('Grizzly Bears', { types: ['Creature'], text: '' })), []);
  assert.ok(isManaSource(land('Forest')) && !isManaSource(card('Grizzly Bears', { types: ['Creature'] })));
  assert.deepEqual(costPips('{1}{G}{G}'), ['1', 'G', 'G']);
  assert.deepEqual(costPips(''), []);
});

test('the tray asks when the choice of sources matters, per setting', () => {
  const m1 = perm(land('Mountain'), 0); const m2 = perm(land('Mountain'), 0); const f = perm(forest(), 0); const tapped = perm(forest(), 0, { tapped: true });
  const p = player(0, { battlefield: [m1, m2, f, tapped] });
  assert.deepEqual(untappedManaSources(p).map(o => o.id), [m1.id, m2.id, f.id]);
  const pay: PaySuggestion = { cost: '{R}', taps: [{ id: m1.id, name: 'Mountain', mana: ['R'] }], pool: [] };
  assert.equal(isAmbiguousPayment(pay, p), true, 'a Forest and a Mountain are left over: leaving different colours up is possible');
  assert.equal(shouldAskToPay('when-ambiguous', pay, p), true);
  assert.equal(shouldAskToPay('never', pay, p), false);
  assert.equal(shouldAskToPay('always', pay, p), true);
  assert.equal(shouldAskToPay('always', undefined, p), false, 'no suggestion: nothing to override');
  // only Mountains untapped: which one taps makes no difference
  const mono = player(0, { battlefield: [m1, m2] });
  assert.equal(isAmbiguousPayment(pay, mono), false);
  assert.equal(shouldAskToPay('when-ambiguous', pay, mono), false);
  // everything taps: nothing is left to choose
  const all: PaySuggestion = { cost: '{R}{R}{G}', taps: [{ id: m1.id, name: 'Mountain', mana: ['R'] }, { id: m2.id, name: 'Mountain', mana: ['R'] }, { id: f.id, name: 'Forest', mana: ['G'] }], pool: [] };
  assert.equal(isAmbiguousPayment(all, p), false);
});

test('initialSources starts from the suggestion and swaps in the land the card was dropped on', () => {
  const m1 = perm(land('Mountain'), 0); const m2 = perm(land('Mountain'), 0); const f = perm(forest(), 0);
  const p = player(0, { battlefield: [m1, m2, f] });
  const pay: PaySuggestion = { cost: '{1}{R}', taps: [{ id: m1.id, name: 'Mountain', mana: ['R'] }, { id: f.id, name: 'Forest', mana: ['G'] }], pool: [] };
  assert.deepEqual(initialSources(pay, p), [m1.id, f.id]);
  assert.deepEqual(initialSources(pay, p, m1.id), [m1.id, f.id], 'already suggested');
  assert.deepEqual(initialSources(pay, p, m2.id), [m2.id, f.id], 'the other Mountain replaces the suggested one');
  const sol = perm(card('Sol Ring', { types: ['Artifact'], text: '{T}: Add {C}{C}.' }), 0);
  const p2 = player(0, { battlefield: [m1, f, sol] });
  assert.deepEqual(initialSources(pay, p2, sol.id), [m1.id, f.id, sol.id], 'nothing overlaps: added');
});
