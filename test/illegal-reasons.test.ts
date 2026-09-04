import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableMana, canPickUp, planDrag, whyNotPlayable } from '../src/play/drag.js';
import { bears, bolt, card, ctx, land, pass, perm, sorcery, view } from './drag-fixtures.js';

test('illegal: land already played this turn cites 305.2', () => {
  const m = land();
  const v = view({}, { hand: [m], landsPlayedThisTurn: 1 });
  const r = whyNotPlayable(m.id, ctx(v, { legal: [pass] }));
  assert.equal(r?.code, 'land-drop-used'); assert.equal(r?.rule, '305.2'); assert.match(r!.text, /already played a land.*305\.2/);
  const plan = planDrag({ kind: 'hand', cardId: m.id }, ctx(v, { legal: [pass] }));
  assert.equal(plan.illegal?.code, 'land-drop-used'); assert.equal(plan.zones.length, 0);
  const cp = canPickUp({ kind: 'hand', cardId: m.id }, ctx(v, { legal: [pass] }));
  assert.equal(cp.ok, false); if (!cp.ok) assert.equal(cp.reason.code, 'land-drop-used');
});

test('illegal: land timing — not your turn, stack not empty, not a main phase', () => {
  const m = land();
  assert.equal(whyNotPlayable(m.id, ctx(view({ activePlayer: 1 }, { hand: [m] }), { legal: [pass] }))?.code, 'not-your-turn');
  const stacked = view({ stack: [{ id: 1, kind: 'spell', name: 'X', controller: 1, text: '', sourceId: 5, source: bolt(), targets: [], targetLabels: [], countered: false }] }, { hand: [m] });
  assert.equal(whyNotPlayable(m.id, ctx(stacked, { legal: [pass] }))?.code, 'stack-not-empty');
  const r = whyNotPlayable(m.id, ctx(view({ step: 'combat-begin' }, { hand: [m] }), { legal: [pass] }));
  assert.equal(r?.code, 'sorcery-timing'); assert.equal(r?.rule, '305.1');
});

test('illegal: sorcery timing cites 307.1, instants are exempt, flash is exempt', () => {
  const s = sorcery(); const b = bolt(); const fl = bears({ keywords: ['flash' as never] });
  const combat = view({ step: 'declare-attackers' }, { hand: [s, b, fl], battlefield: [perm(land(), 0), perm(land(), 0)] });
  const c = ctx(combat, { legal: [pass] });
  const r = whyNotPlayable(s.id, c); assert.equal(r?.code, 'sorcery-timing'); assert.equal(r?.rule, '307.1'); assert.match(r!.text, /307\.1/);
  assert.equal(whyNotPlayable(b.id, c), null, 'instant at combat is fine: no explanation');
  assert.equal(whyNotPlayable(fl.id, c), null, 'flash creature is fine');
  const opp = view({ activePlayer: 1, step: 'main1' }, { hand: [s] , battlefield: [perm(land(), 0)] });
  const r2 = whyNotPlayable(s.id, ctx(opp, { legal: [pass] })); assert.equal(r2?.code, 'not-your-turn'); assert.equal(r2?.rule, '505.1a');
  const stacked = view({ stack: [{ id: 1, kind: 'spell', name: 'X', controller: 1, text: '', sourceId: 5, source: bolt(), targets: [], targetLabels: [], countered: false }] }, { hand: [s], battlefield: [perm(land(), 0)] });
  const r3 = whyNotPlayable(s.id, ctx(stacked, { legal: [pass] })); assert.equal(r3?.code, 'stack-not-empty'); assert.equal(r3?.rule, '117.1a');
});

test('illegal: cannot pay compares mana value with untapped lands plus pool (601.2g)', () => {
  const g = bears();
  const v = view({}, { hand: [g], battlefield: [perm(land('Forest'), 0), perm(land('Forest'), 0, { tapped: true })] });
  assert.equal(availableMana(ctx(v)), 1);
  const r = whyNotPlayable(g.id, ctx(v, { legal: [pass] }));
  assert.equal(r?.code, 'cant-pay'); assert.equal(r?.rule, '601.2g'); assert.match(r!.text, /\{1\}\{G\}/);
  const pooled = view({}, { hand: [g], battlefield: [perm(land('Forest'), 0)], manaPool: ['G'] });
  assert.equal(whyNotPlayable(g.id, ctx(pooled, { legal: [pass] })), null);
});

test('illegal: no priority (117.1) and mid-action', () => {
  const m = land();
  const r = whyNotPlayable(m.id, ctx(view({ priority: 1 }, { hand: [m] }), { legal: [] }));
  assert.equal(r?.code, 'no-priority'); assert.equal(r?.rule, '117.1');
  const r2 = whyNotPlayable(m.id, ctx(view({}, { hand: [m] }), { kind: 'attackers', legal: [] }));
  assert.equal(r2?.code, 'not-legal');
});

test('illegal: permanents — summoning sick (302.6), tapped, no activated ability', () => {
  const sick = perm(card('Llanowar Elves', { types: ['Creature'], text: '{T}: Add {G}.' }), 0, { summoningSick: true });
  const tapped = perm(card('Llanowar Elves', { types: ['Creature'], text: '{T}: Add {G}.' }), 0, { tapped: true });
  const vanilla = perm(bears(), 0);
  const theirs = perm(card('Llanowar Elves', { types: ['Creature'], text: '{T}: Add {G}.' }), 1);
  const v = view({}, { battlefield: [sick, tapped, vanilla] }, { battlefield: [theirs] });
  const c = ctx(v, { legal: [pass] });
  const r = whyNotPlayable(sick.id, c); assert.equal(r?.code, 'summoning-sick'); assert.equal(r?.rule, '302.6'); assert.match(r!.text, /302\.6/);
  assert.equal(whyNotPlayable(tapped.id, c)?.code, 'tapped');
  assert.equal(whyNotPlayable(vanilla.id, c)?.code, 'no-action');
  assert.equal(whyNotPlayable(theirs.id, c)?.code, 'not-legal');
  assert.equal(whyNotPlayable(424242, c), null, 'unknown ids get no explanation');
  const plan = planDrag({ kind: 'permanent', id: vanilla.id }, c);
  assert.equal(plan.illegal?.code, 'no-action');
});
