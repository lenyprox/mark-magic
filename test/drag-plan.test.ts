import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginAction, pickTarget } from '../src/play/targeting.js';
import { attackPlaneswalkersFor, attackTargetsFor, canPickUp, defaultDefender, planDrag, resolveDrop, sameZone, type DropZone } from '../src/play/drag.js';
import { activate, bears, bolt, cast, ctx, land, pass, perm, playLand, player, view } from './drag-fixtures.js';

const BF_ME: DropZone = { kind: 'battlefield', player: 0 };
const BF_OPP: DropZone = { kind: 'battlefield', player: 1 };
const OPP: DropZone = { kind: 'player', id: 1 };

test('drag plan: idle hand land → my battlefield begins the play-land action; other zones refuse', () => {
  const m = land();
  const v = view({}, { hand: [m] });
  const c = ctx(v, { legal: [pass, playLand(m.id)] });
  const plan = planDrag({ kind: 'hand', cardId: m.id }, c);
  assert.equal(plan.illegal, undefined);
  assert.ok(!plan.tether);
  assert.equal(plan.zones.length, 1);
  assert.ok(sameZone(plan.zones[0].zone, BF_ME));
  const eff = resolveDrop(plan, BF_ME);
  assert.equal(eff.kind, 'begin'); if (eff.kind === 'begin') assert.deepEqual(eff.legal.action, { type: 'play-land', cardId: m.id });
  const miss = resolveDrop(plan, OPP);
  assert.equal(miss.kind, 'none'); if (miss.kind === 'none') assert.equal(miss.reason.code, 'not-legal');
  const gone = resolveDrop(plan, { kind: 'void' });
  assert.equal(gone.kind, 'none'); if (gone.kind === 'none') assert.equal(gone.reason.code, 'no-action');
  assert.deepEqual(canPickUp({ kind: 'hand', cardId: m.id }, c), { ok: true });
});

test('drag plan: targeted spell marks tether; targeting mode turns each option into a pick zone', () => {
  const b = bolt(); const theirs = perm(bears(), 1);
  const v = view({}, { hand: [b], battlefield: [perm(land(), 0)] }, { battlefield: [theirs] });
  const legal = cast(b.id, [{ spec: 'any target', options: [{ kind: 'object', id: theirs.id }, { kind: 'player', id: 1 }, { kind: 'player', id: 0 }], optional: false, count: 1 }]);
  const plan = planDrag({ kind: 'hand', cardId: b.id }, ctx(v, { legal: [pass, legal] }));
  assert.equal(plan.tether, true);
  assert.equal(resolveDrop(plan, BF_ME).kind, 'begin');
  // the drop begins the flow; the table then enters targeting mode with that state
  const flow = beginAction(legal); assert.equal(flow.kind, 'targeting'); if (flow.kind !== 'targeting') return;
  const tplan = planDrag({ kind: 'hand', cardId: b.id }, ctx(v, { kind: 'targeting', legal: [pass, legal], targeting: flow.state }));
  assert.equal(tplan.tether, true);
  assert.equal(tplan.zones.length, 3);
  const pick = resolveDrop(tplan, OPP);
  assert.equal(pick.kind, 'pick'); if (pick.kind === 'pick') assert.deepEqual(pick.ref, { kind: 'player', id: 1 });
  const onCreature = resolveDrop(tplan, { kind: 'object', id: theirs.id });
  assert.equal(onCreature.kind, 'pick');
  const wrong = resolveDrop(tplan, { kind: 'object', id: 4242 });
  assert.equal(wrong.kind, 'none'); if (wrong.kind === 'none') { assert.equal(wrong.reason.code, 'not-a-target'); assert.match(wrong.reason.text, /115\.1/); }
  // a different card cannot be dragged while targeting
  const other = planDrag({ kind: 'hand', cardId: 999 }, ctx(v, { kind: 'targeting', legal: [pass, legal], targeting: flow.state }));
  assert.equal(other.illegal?.code, 'not-legal');
  // and the pick completes the flow
  if (pick.kind === 'pick') { const done = pickTarget(flow.state, pick.ref); assert.equal(done.kind, 'done'); }
});

test('drag plan: multiple actions for one hand card surface as choices', () => {
  const b = bolt();
  const v = view({}, { hand: [b] });
  const a1 = cast(b.id); const a2: typeof a1 = { ...cast(b.id), label: 'Cast (alt)', action: { type: 'cast', cardId: b.id, alt: 'flashback' as never } };
  const plan = planDrag({ kind: 'hand', cardId: b.id }, ctx(v, { legal: [pass, a1, a2] }));
  assert.equal(plan.choices?.length, 2);
  assert.equal(resolveDrop(plan, BF_ME).kind, 'begin');
});

test('drag plan: permanent with an untargeted ability activates by dropping on itself; targeted ability offers its targets', () => {
  const src = perm(card('Prodigal Sorcerer', { types: ['Creature'], text: '{T}: Prodigal Sorcerer deals 1 damage to any target.' }), 0);
  const theirs = perm(bears(), 1);
  const v = view({}, { battlefield: [src] }, { battlefield: [theirs] });
  const untargeted = planDrag({ kind: 'permanent', id: src.id }, ctx(v, { legal: [pass, activate(src.id)] }));
  assert.equal(untargeted.zones.length, 1);
  assert.equal(resolveDrop(untargeted, { kind: 'object', id: src.id }).kind, 'begin');
  const legal = activate(src.id, 0, [{ spec: 'any target', options: [{ kind: 'object', id: theirs.id }, { kind: 'player', id: 1 }], optional: false, count: 1 }]);
  const targeted = planDrag({ kind: 'permanent', id: src.id }, ctx(v, { legal: [pass, legal] }));
  assert.equal(targeted.tether, false);
  const eff = resolveDrop(targeted, OPP);
  assert.equal(eff.kind, 'begin'); if (eff.kind === 'begin') { assert.deepEqual(eff.pick, { kind: 'player', id: 1 }); assert.equal(eff.legal, legal); }
  // dropping on itself still begins the ability without a pre-pick (the tether continues from there)
  const self = resolveDrop(targeted, { kind: 'object', id: src.id });
  assert.equal(self.kind, 'begin'); if (self.kind === 'begin') assert.equal(self.pick, undefined);
  // a stack item cannot be picked up
  assert.equal(planDrag({ kind: 'stack', id: 1 }, ctx(v, { legal: [pass] })).illegal?.code, 'no-action');
});

test('drag plan: attackers mode — opponent plate / battlefield attack, my battlefield withdraws, must-attack cannot withdraw', () => {
  const a = perm(bears(), 0); const b = perm(bears(), 0); const sick = perm(bears(), 0, { summoningSick: true });
  const v = view({ step: 'declare-attackers' }, { battlefield: [a, b, sick] });
  const c = ctx(v, { kind: 'attackers', attackers: { decl: { attackers: [b.id] }, candidates: [a.id, b.id], mustAttack: [b.id] } });
  assert.deepEqual(attackTargetsFor(c), [1]);
  const plan = planDrag({ kind: 'permanent', id: a.id }, c);
  assert.equal(resolveDrop(plan, OPP).kind, 'attack');
  assert.equal(resolveDrop(plan, BF_OPP).kind, 'attack');
  const back = resolveDrop(plan, BF_ME); assert.equal(back.kind, 'unattack'); if (back.kind === 'unattack') assert.equal(back.id, a.id);
  const must = planDrag({ kind: 'permanent', id: b.id }, c);
  assert.equal(resolveDrop(must, BF_ME).kind, 'none');
  const nope = planDrag({ kind: 'permanent', id: sick.id }, c);
  assert.equal(nope.illegal?.code, 'summoning-sick'); assert.match(nope.illegal!.text, /302\.6/);
  const wrong = resolveDrop(plan, { kind: 'object', id: b.id });
  assert.equal(wrong.kind, 'none'); if (wrong.kind === 'none') assert.equal(wrong.reason.code, 'not-legal');
});

test('drag plan: blockers mode — drop a blocker on an attacker, or back home to clear', () => {
  const mine = perm(bears(), 0); const tappedMine = perm(bears(), 0, { tapped: true }); const att = perm(bears(), 1, { attacking: 0 });
  const v = view({ step: 'declare-blockers', activePlayer: 1 }, { battlefield: [mine, tappedMine] }, { battlefield: [att] });
  const c = ctx(v, { kind: 'blockers', blockers: { decl: { blocks: [] }, selected: null, attackers: [att.id], candidates: [mine.id] } });
  const plan = planDrag({ kind: 'permanent', id: mine.id }, c);
  const eff = resolveDrop(plan, { kind: 'object', id: att.id });
  assert.equal(eff.kind, 'block'); if (eff.kind === 'block') assert.deepEqual(eff, { kind: 'block', blocker: mine.id, attacker: att.id });
  const clear = resolveDrop(plan, BF_ME); assert.equal(clear.kind, 'unblock');
  assert.equal(resolveDrop(plan, OPP).kind, 'none');
  const t = planDrag({ kind: 'permanent', id: tappedMine.id }, c);
  assert.equal(t.illegal?.code, 'tapped');
  const cp = canPickUp({ kind: 'permanent', id: tappedMine.id }, c);
  assert.equal(cp.ok, false); if (!cp.ok) assert.match(cp.reason.text, /509\.1a/);
});

test('drag plan: a commander drags out of the command zone onto my battlefield (cast with from: command); hand and command sources do not mix', () => {
  const cmd = bears({ id: 900, manaCost: '{1}{G}', manaValue: 2 });
  const lands = [perm(land('Forest'), 0), perm(land('Forest'), 0), perm(land('Forest'), 0), perm(land('Forest'), 0)];
  const v = view({}, { hand: [], battlefield: lands, command: [cmd], commanders: [cmd.id], commanderCasts: { [cmd.id]: 1 } });
  const legal = { ...cast(cmd.id), action: { type: 'cast', cardId: cmd.id, from: 'command' }, label: 'Cast Grizzly Bears (from command zone, tax 2)', manaValue: 4 } as typeof pass;
  const c = ctx(v, { legal: [pass, legal] });
  const plan = planDrag({ kind: 'command', cardId: cmd.id }, c);
  assert.equal(plan.illegal, undefined);
  assert.ok(plan.zones.some(z => sameZone(z.zone, BF_ME)));
  const eff = resolveDrop(plan, BF_ME);
  assert.equal(eff.kind, 'begin'); if (eff.kind === 'begin') { assert.equal(eff.legal.action.type, 'cast'); assert.equal((eff.legal.action as { from?: string }).from, 'command'); }
  assert.deepEqual(canPickUp({ kind: 'command', cardId: cmd.id }, c), { ok: true });
  // the same card as a hand source does not see the command-zone action
  assert.equal(planDrag({ kind: 'hand', cardId: cmd.id }, c).illegal?.code, 'no-action');
  // short on mana: the reason cites the commander tax (CR 903.8)
  const poor = view({}, { hand: [], battlefield: [perm(land('Forest'), 0)], command: [cmd], commanders: [cmd.id], commanderCasts: { [cmd.id]: 2 } });
  const nope = planDrag({ kind: 'command', cardId: cmd.id }, ctx(poor, { legal: [pass] }));
  assert.equal(nope.illegal?.code, 'cant-pay'); assert.match(nope.illegal!.text, /903\.8/); assert.match(nope.illegal!.text, /\{4\}/);
});

test('drag plan: attackers with several defenders and a planeswalker — each drop chooses the attack target', () => {
  const a = perm(bears(), 0);
  const pw = perm(card('Jace Beleren', { types: ['Planeswalker'], loyalty: 3 }), 2, { counters: { loyalty: 3 } });
  const v = view({ step: 'declare-attackers' }, { battlefield: [a] });
  v.players.push(player(2, { battlefield: [pw] }));
  v.turnOrder = [0, 1, 2];
  const c = ctx(v, { kind: 'attackers', attackers: { decl: { attackers: [] }, candidates: [a.id], mustAttack: [], defenders: [1, 2], planeswalkers: [{ id: pw.id, controller: 2 }] } });
  assert.deepEqual(attackTargetsFor(c), [1, 2]);
  assert.deepEqual(attackPlaneswalkersFor(c), [{ id: pw.id, controller: 2 }]);
  const plan = planDrag({ kind: 'permanent', id: a.id }, c);
  const onP2 = resolveDrop(plan, { kind: 'player', id: 2 });
  assert.equal(onP2.kind, 'attack'); if (onP2.kind === 'attack') assert.deepEqual({ id: onP2.id, target: onP2.target }, { id: a.id, target: 2 });
  const onBf1 = resolveDrop(plan, { kind: 'battlefield', player: 1 });
  assert.equal(onBf1.kind, 'attack'); if (onBf1.kind === 'attack') assert.equal(onBf1.target, 1);
  const onPw = resolveDrop(plan, { kind: 'object', id: pw.id });
  assert.equal(onPw.kind, 'attack'); if (onPw.kind === 'attack') assert.deepEqual(onPw.target, { planeswalker: pw.id });
  assert.equal(resolveDrop(plan, BF_ME).kind, 'unattack');
  assert.equal(resolveDrop(plan, { kind: 'object', id: a.id }).kind, 'none');
  // without defenders in the decision: every living opponent, in seat order; the first is the default defender
  const v2 = view({ step: 'declare-attackers' }, { battlefield: [a] });
  v2.players.push(player(2, { lost: true }));
  const c2 = ctx(v2, { kind: 'attackers', attackers: { decl: { attackers: [] }, candidates: [a.id], mustAttack: [] } });
  assert.deepEqual(attackTargetsFor(c2), [1]);
  assert.equal(defaultDefender(c2), 1);
  const single = resolveDrop(planDrag({ kind: 'permanent', id: a.id }, c2), OPP);
  assert.equal(single.kind, 'attack'); if (single.kind === 'attack') assert.equal(single.target, 1);
});

test('drag plan: a castable spell with a payment suggestion can be dropped on an untapped land to pay from it', () => {
  const b = bolt();
  const mtn = perm(land(), 0); const tappedMtn = perm(land(), 0, { tapped: true });
  const v = view({}, { hand: [b], battlefield: [mtn, tappedMtn] });
  const legal = { ...cast(b.id), pay: { cost: '{R}', taps: [{ id: mtn.id, name: 'Mountain', mana: ['R'] }], pool: [] } } as typeof pass;
  const plan = planDrag({ kind: 'hand', cardId: b.id }, ctx(v, { legal: [pass, legal] }));
  const onLand = resolveDrop(plan, { kind: 'object', id: mtn.id });
  assert.equal(onLand.kind, 'begin'); if (onLand.kind === 'begin') assert.equal(onLand.paySource, mtn.id);
  assert.equal(resolveDrop(plan, { kind: 'object', id: tappedMtn.id }).kind, 'none');
  assert.equal(resolveDrop(plan, BF_ME).kind, 'begin');
});

function card(name: string, over: Parameters<typeof land>[1]) { return land(name, { ...over, types: over?.types ?? [] }); }
