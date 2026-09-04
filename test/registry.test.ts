// The proof that the 8a-1 extensibility contract is wired end to end: a probe family that uses EVERY hook kind is
// registered at runtime, driven through a real Game built from real cards, and each hook is asserted to have fired.
// If a core refactor drops a hook site, this file goes red instead of the mechanic families silently going quiet.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { allPermanents, battlefieldOf, canAttack, canBlock, conditionHolds, defOf, evalAmount, findObject, isPhasedOut, power, toughness } from '../src/engine/characteristics.js';
import { cloneState } from '../src/engine/clone.js';
import { costAdjust, nonManaCostPayable, spellManaCost } from '../src/engine/cost.js';
import { citation, LOGGED, renderEvent, type GameEventBody } from '../src/engine/events.js';
import { Game } from '../src/engine/game.js';
import { legalActions, targetOptionsFor } from '../src/engine/legal.js';
import { collectDefs, deserializeState, serializeState } from '../src/engine/serialize.js';
import { redact } from '../src/engine/view.js';
import { defaultAnswer } from '../src/engine/agents/defaults.js';
import { EVENT_META, RENDERERS, TOKEN_ABILITIES, MODULES, registerFamily, registryHash, unregisterFamily, tokenAbilityOf } from '../src/engine/ops/_registry.js';
import { extBump, extDel, extGet, extGetOr, extSet, isJsonPlain, plainCopy } from '../src/engine/ops/ext.js';
import { chars } from '../src/engine/ops/chars.js';
import type { FamilyModule } from '../src/engine/ops/types.js';
import { makeObject, type Ability, type Agent, type Decision, type GameObject, type GameState, type PlayerId, type TargetSpec } from '../src/engine/state.js';
import type { AbilityCost, Effect } from '../src/cards/types.js';
import { C, setup, find, Script } from './helpers.js';

// ------------------------------------------------------------------ the probe family
/** Every hook the probe fired, by name. The assertions below are "did this hook site actually call us?". */
const seen = new Set<string>();
const hit = (k: string) => { seen.add(k); return true; };
/** Which permanents the trigger matcher was offered (proves triggerSources widened the scan). */
const triggerScan = new Set<number>();
/** The emblem `triggerSources` contributes: a command-zone object with a probe trigger, never on the battlefield. */
let emblem: GameObject | null = null;

const probe: FamilyModule = {
  name: 'registry-probe',

  effects: {
    'probe-effect': (e: { op: 'probe-effect'; amount: number }, c) => {
      hit('effects');
      c.g.note(`probe effect ${c.amt(e.amount)} on ${c.src.def.name} (idx ${c.idx}, ${c.objs().length} objs, ${c.players().length} players, ${c.T.length} targets, seat ${c.p}, turn ${c.s.turn}, item ${c.item.id})`);
    },
    'probe-recurse': async (_e, c) => { hit('effects.apply'); await c.apply({ op: 'probe-effect', amount: 1 } as unknown as Effect); },
    // "after this phase, there is an additional combat phase", the way a family writes it (docs/vocabulary/README.md)
    'probe-extra-combat': (_e, c) => { hit('effects.extraCombat'); extBump(c.s, 'extraCombats', 1); },
  },
  conditions: { 'probe-cond': (_c, _s, src) => hit('conditions') && extGetOr<number>(src, 'probeN', 0) > 0 },
  amounts: { 'probe-amount': (_a, _s, _ctrl, _x, src) => { hit('amounts'); return src ? extGetOr<number>(src, 'probeN', 0) : 0; } },
  triggers: {
    // a registry trigger is offered every event, so it checks `event` itself (the documented pattern)
    'probe-trigger': (_ev, perm, ctx, _s, event) => { hit('triggers'); triggerScan.add(perm.id); return event === 'probe-trigger' && ctx.obj === perm; },
    // ... which is what lets a family trigger answer a CORE event with an extra condition (dethrone, afflict, exploit)
    'probe-attacks': (_ev, perm, ctx, _s, event) => { if (event !== 'attacks') return false; hit('triggers.core'); return ctx.obj === perm; },
  },
  statics: {
    'probe-static': (_e, src, o, _s, m) => { hit('statics'); if (src.id === o.id) { m.setPT = { power: 7, toughness: 7 }; m.flags.probeFlag = true; } },
  },
  costParts: {
    probeCost: {
      payable: (v, _s, _pl, self) => hit('costParts.payable') && extGetOr<number>(self, 'probeN', 0) >= (v as number),
      async pay(v, _g, _p, self) { hit('costParts.pay'); extSet(self, 'probeN', extGetOr<number>(self, 'probeN', 0) - (v as number)); return true; },
    },
  },
  asEnters: {
    'probe-enter': (_a, o, ctx) => { hit('asEnters'); extSet(o, 'probeEntered', true); ctx.entersTapped = true; },
  },
  replacements: {
    zoneMove: (_g, o, zone) => {
      hit('replacements.zoneMove');
      if (extGet<boolean>(o, 'probeCancelMove') === true) { hit('replacements.zoneMove.cancel'); return { cancel: true, emit: `${o.def.name} does not move (probe).` }; }
      return zone === 'graveyard' && extGet<boolean>(o, 'probeExileInstead') === true ? { zone: 'exile', emit: `${o.def.name} is exiled instead (probe).` } : null;
    },
    damage: (_g, _src, target, n) => { hit('replacements.damage'); return typeof target !== 'number' && extGet<boolean>(target, 'probeHalveDamage') === true ? Math.floor(n / 2) : n; },
    draw: (g, p) => { hit('replacements.draw'); return extGet<boolean>(g.state.players[p], 'probeNoDraw') === true; },
    counters: (_g, o, counter, delta) => {
      hit('replacements.counters');
      // the fold is unguarded, so a shield can answer for a removal, for loyalty and for an object outside the battlefield
      if (delta < 0 && extGet<boolean>(o, 'probeNoCounterLoss') === true) { hit('replacements.counters.removal'); return 0; }
      return delta > 0 && extGet<boolean>(o, 'probeDoubleCounters') === true && counter === '+1/+1' ? delta * 2 : delta;
    },
    lifeGain: (g, p, n) => { hit('replacements.lifeGain'); return extGet<boolean>(g.state.players[p], 'probeBonusLife') === true ? n + 1 : n; },
  },
  steps: {
    'turn-start': () => { hit('steps.turn-start'); },
    untap: () => { hit('steps.untap'); },
    upkeep: () => { hit('steps.upkeep'); },
    draw: () => { hit('steps.draw'); },
    main1: () => { hit('steps.main1'); },
    'combat-begin': () => { hit('steps.combat-begin'); },
    'declare-attackers': () => { hit('steps.declare-attackers'); },
    'declare-blockers': () => { hit('steps.declare-blockers'); },
    'combat-damage': () => { hit('steps.combat-damage'); },
    'combat-end': () => { hit('steps.combat-end'); },
    main2: (g, ap) => {
      hit('steps.main2');
      // an "additional combat phase" card untaps first; the probe does the same so the extra combat has attackers
      if (extGetOr<number>(g.state, 'extraCombats', 0) > 0) for (const o of g.state.players[ap].battlefield) if (o.tapped) g.setTapped(o, false, 'effect');
    },
    end: () => { hit('steps.end'); },
    cleanup: () => { hit('steps.cleanup'); },
    'cleanup-end': () => { hit('steps.cleanup-end'); },
  },
  sba: () => { hit('sba'); return false; },
  legalActions: (g, p, out) => {
    hit('legalActions');
    if (extGet<boolean>(g.state.players[p], 'probeAction') === true) out.push({ action: { type: 'probe-action' } as never, label: 'probe action' });
  },
  actions: { 'probe-action': async (g, p) => { hit('actions'); g.note(`probe action by ${g.pname(p)}`); return true; } },
  decisions: { 'probe-decision': () => { hit('decisions'); return 'probe-answer'; } },
  keywordHooks: {
    canAttack: (_s, o) => { hit('keywordHooks.canAttack'); return extGet<boolean>(o, 'probeCantAttack') === true ? false : undefined; },
    // a synchronous hook reading power through the sanctioned bundle: "can't be blocked by creatures with power 2 or less"
    canBlock: (s, b, a) => { hit('keywordHooks.canBlock'); if (extGet<boolean>(a, 'probeMenacing') === true && chars.power(s, b) <= 2) { hit('chars'); return false; } return extGet<boolean>(b, 'probeCantBlock') === true ? false : undefined; },
    blockCheck: (_s, _b, a) => { hit('keywordHooks.blockCheck'); return extGet<boolean>(a, 'probeUnblockable') !== true; },
    blockFixup: (_g, attackers) => { hit('keywordHooks.blockFixup'); for (const a of attackers) if (extGet<boolean>(a, 'probeDropBlocks') === true) { for (const id of a.blockedBy) { const b = findObject(_g.state, id); if (b) b.blocking = []; } a.blockedBy = []; } },
    combatDamage: (_g, assignments) => { hit('keywordHooks.combatDamage'); for (const a of assignments) if (extGet<boolean>(a.src, 'probeDoubleDamage') === true) a.n *= 2; },
  },
  triggerSources: () => { hit('triggerSources'); return emblem ? [emblem] : []; },
  events: { 'probe-event': { logged: true, cr: '999.1a', render: (ev) => `probe event ${(ev as { detail: string }).detail}` } },
  redact: (o, viewer) => { hit('redact'); if (o.owner !== viewer) extDel(o, 'probeSecret'); },
  redactPlayer: (pl, viewer) => { hit('redactPlayer'); if (pl.id !== viewer) extDel(pl, 'probeSecretPile'); },
  redactState: (_s, _viewer) => { hit('redactState'); extDel(_s, 'probeSecretVote'); },
  cleanupEot: (_g, o) => { hit('cleanupEot'); extDel(o, 'probeShield'); },
  targetKinds: {
    'probe-target': (g, controller) => { hit('targetKinds'); return g.state.players[controller].battlefield.filter(o => extGet<boolean>(o, 'probeTargetable') === true).map(o => ({ kind: 'object' as const, id: o.id })); },
  },
  tokenAbilities: {
    ProbeToken: {
      index: -9,
      legal: (_g, _p, o) => { hit('tokenAbilities.legal'); return { action: { type: 'activate', objectId: o.id, abilityIndex: -9 }, label: 'sacrifice Probe Token: gain 5 life' }; },
      async activate(g, p, o) { hit('tokenAbilities.activate'); g.gainLife(p, 5); g.moveTo(o, 'graveyard', 'top', 'sacrifice'); return true; },
    },
  },
  leave: (_g, o) => { hit('leave'); extDel(o, 'probeOnBattlefield'); },
  castFrom: (_g, _p, card, from) => { hit('castFrom'); return from === 'graveyard' && extGet<boolean>(card, 'probeCastable') === true ? true : undefined; },
  freeCast: (_g, _p, card, from) => { hit('freeCast'); return from === 'graveyard' && extGet<boolean>(card, 'probeCastable') === true ? true : undefined; },
  modeCost: (_def, modes) => { hit('modeCost'); return modes.length > 1 ? { generic: modes.length - 1, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '' } : null; },
  costMod: (_s, _p, card) => { hit('costMod'); return extGet<boolean>(card, 'probeCheaper') === true ? 2 : 0; },
  render: { 'probe-effect': (e: { op: 'probe-effect'; amount: number }) => `Probe ${e.amount}` },
};

registerFamily(probe);
after(() => unregisterFamily(probe.name));

// ------------------------------------------------------------------ helpers
/** An agent that attacks and blocks on command and otherwise takes the shipped defaults. */
class Combatant implements Agent {
  name: string;
  constructor(name: string, private atk: () => number[] = () => [], private blk: () => { blocker: number; attacker: number }[] = () => []) { this.name = name; }
  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (d.kind === 'attackers') return { attackers: this.atk().filter(id => d.candidates.includes(id)) };
    if (d.kind === 'blockers') return { blocks: this.blk() };
    return defaultAnswer(s, me, d);
  }
}
const triggerAbility: Ability = { kind: 'triggered', event: { on: 'probe-trigger', self: true } as never, effects: [{ op: 'probe-effect', amount: 1 } as unknown as Effect], text: 'probe trigger' };
const staticAbility: Ability = { kind: 'static', effect: { kind: 'probe-static' } as never, text: 'probe static' };
/** A family trigger whose `on` is not an event the core ever queues — it answers the core's 'attacks'. */
const coreTriggerAbility: Ability = { kind: 'triggered', event: { on: 'probe-attacks', self: true } as never, effects: [{ op: 'probe-effect', amount: 2 } as unknown as Effect], text: 'probe core trigger' };

// ------------------------------------------------------------------ registration
test('registerFamily / unregisterFamily rebuild the flat lookups and the registry hash', () => {
  assert.ok(MODULES.some(m => m.name === 'registry-probe'), 'the probe family is registered');
  assert.ok(RENDERERS['probe-effect'], 'render entries reach RENDERERS');
  assert.equal(RENDERERS['probe-effect']({ op: 'probe-effect', amount: 3 } as never), 'Probe 3');
  assert.ok(TOKEN_ABILITIES.ProbeToken, 'family token abilities reach TOKEN_ABILITIES');
  assert.ok(TOKEN_ABILITIES.Treasure && TOKEN_ABILITIES.Clue && TOKEN_ABILITIES.Food && TOKEN_ABILITIES.Spawn, 'the four built-in tokens are seeded');
  const withProbe = registryHash();
  assert.match(withProbe, /^[0-9a-f]{8}$/);
  unregisterFamily('registry-probe');
  assert.equal(MODULES.some(m => m.name === 'registry-probe'), false);
  assert.notEqual(registryHash(), withProbe, 'the hash follows the registered op names');
  assert.equal(RENDERERS['probe-effect'], undefined);
  assert.equal(TOKEN_ABILITIES.ProbeToken, undefined);
  assert.ok(TOKEN_ABILITIES.Treasure, 'the built-ins survive an unregister');
  registerFamily(probe);
  assert.throws(() => registerFamily({ name: 'registry-probe' }), /already registered/);
  assert.throws(() => registerFamily({ name: 'dup', effects: { 'probe-effect': () => {} } }), /duplicate effect "probe-effect".*registry-probe.*dup/s);
  unregisterFamily('dup');
});

// ------------------------------------------------------------------ the synchronous hook sites
test('effects, conditions, amounts, statics, cost parts, target kinds and decisions are consulted', async () => {
  const g = setup({ bf: ['Grizzly Bears', 'Mountain', 'Mountain'] }, { bf: ['Hill Giant'] });
  const s = g.state;
  const bears = find(g, 'Grizzly Bears', 0);
  extSet(bears, 'probeN', 4);

  // effect op (and OpCtx.apply recursion), through the real applyEffect default branch
  const item = g.makeStackItem('ability', bears, 0, [{ op: 'probe-recurse' } as unknown as Effect], 'probe', 0, undefined, 'probe');
  await g.applyEffect(item, { op: 'probe-recurse' } as unknown as Effect, 0, item.effects);
  assert.ok(seen.has('effects') && seen.has('effects.apply'), 'EFFECT_OPS ran and OpCtx.apply recursed');
  assert.match(g.state.log.join('\n'), /probe effect 1 on Grizzly Bears/);

  // an unregistered op falls through to the unsimulated event instead of vanishing
  const before = s.log.length;
  await g.applyEffect(item, { op: 'no-such-op' } as unknown as Effect, 0, item.effects);
  assert.match(s.log.slice(before).join('\n'), /unsimulated text: "op no-such-op"/);

  // condition + amount
  assert.equal(conditionHolds(s, bears, { kind: 'probe-cond' } as never), true);
  assert.equal(evalAmount(s, { count: 'probe-amount' } as never, 0, 0, bears), 4);
  assert.ok(seen.has('conditions') && seen.has('amounts'));

  // static: a flag and a base P/T set before the additive terms (layer 7b-lite)
  bears.grantedAbilities = [staticAbility];
  s.bfGen = (s.bfGen ?? 0) + 1; s.version++;
  assert.equal(power(s, bears), 7, 'Mods.setPT replaces the printed 2 power');
  assert.equal(toughness(s, bears), 7);
  g.addCounters(bears, '+1/+1', 1);
  assert.equal(power(s, bears), 8, 'counters still add on top of setPT');
  assert.ok(seen.has('statics'));
  delete bears.grantedAbilities; s.bfGen++; s.version++;

  // cost part (payable + pay), keyed off a non-core AbilityCost field
  const cost = { probeCost: 3 } as unknown as AbilityCost;
  assert.equal(nonManaCostPayable(s, s.players[0], cost, bears), true);
  assert.equal(await g.payCost(0, cost, bears, 'probe'), true);
  assert.equal(extGet<number>(bears, 'probeN'), 1, 'the cost part was actually paid');
  assert.equal(nonManaCostPayable(s, s.players[0], cost, bears), false, 'and is no longer payable');
  assert.ok(seen.has('costParts.payable') && seen.has('costParts.pay'));

  // target kind
  extSet(bears, 'probeTargetable', true);
  assert.deepEqual(targetOptionsFor(g, 0, { kind: 'probe-target' } as unknown as TargetSpec, bears), [{ kind: 'object', id: bears.id }]);
  assert.ok(seen.has('targetKinds'));

  // decision default
  assert.equal(defaultAnswer(s, 0, { kind: 'probe-decision' } as unknown as Decision), 'probe-answer');
  assert.ok(seen.has('decisions'));
});

test('as-enters, replacements, leave hooks, legal providers, actions, token abilities and events fire', async () => {
  const g = setup({ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] });
  const s = g.state;
  const bears = find(g, 'Grizzly Bears', 0);

  // as-enters: a non-core AsEnters kind that makes it enter tapped
  const def = { ...C('Hill Giant'), asEnters: [{ kind: 'probe-enter' } as never] };
  const giant = makeObject(s.nextId++, def, 0, 'hand', s.turn);
  s.players[0].hand.push(giant);
  await g.enterBattlefield(giant, { controller: 0, via: 'effect' });
  assert.ok(seen.has('asEnters'));
  assert.equal(extGet<boolean>(giant, 'probeEntered'), true);
  assert.equal(giant.tapped, true, 'EnterCtx.entersTapped reached the caller');

  // replacements.counters
  extSet(bears, 'probeDoubleCounters', true);
  g.addCounters(bears, '+1/+1', 1);
  assert.equal(bears.counters['+1/+1'], 2, 'the counter replacement doubled the delta');
  assert.ok(seen.has('replacements.counters'));

  // replacements.lifeGain
  extSet(s.players[0], 'probeBonusLife', true);
  const life = s.players[0].life; g.gainLife(0, 2);
  assert.equal(s.players[0].life, life + 3);
  assert.ok(seen.has('replacements.lifeGain'));

  // replacements.damage
  const hg = find(g, 'Hill Giant', 1);
  extSet(hg, 'probeHalveDamage', true);
  g.dealDamage(bears, hg, 4);
  assert.equal(hg.damage, 2, 'the damage replacement halved it');
  assert.ok(seen.has('replacements.damage'));

  // replacements.draw
  extSet(s.players[0], 'probeNoDraw', true);
  const hand = s.players[0].hand.length; await g.draw(0);
  assert.equal(s.players[0].hand.length, hand, 'the draw was replaced');
  extDel(s.players[0], 'probeNoDraw');
  assert.ok(seen.has('replacements.draw'));

  // replacements.zoneMove + leave hook
  extSet(bears, 'probeExileInstead', true); extSet(bears, 'probeOnBattlefield', true);
  g.moveTo(bears, 'graveyard', 'top', 'destroy');
  assert.equal(bears.zone, 'exile', 'the zone-move replacement redirected the graveyard move');
  assert.match(s.log.join('\n'), /Grizzly Bears is exiled instead \(probe\)/);
  assert.equal(extGet<boolean>(bears, 'probeOnBattlefield'), undefined, 'the leave hook ran');
  assert.ok(seen.has('replacements.zoneMove') && seen.has('leave'));

  // legal-action provider and its action
  extSet(s.players[0], 'probeAction', true);
  assert.ok(legalActions(g, 0).some(l => l.label === 'probe action'), 'LEGAL_PROVIDERS appended the action');
  assert.equal(await g.performAction(0, { type: 'probe-action' } as never), true, 'ACTIONS performed it');
  assert.ok(seen.has('legalActions') && seen.has('actions'));

  // token abilities: the family token (named through o.ext) and the built-in Treasure
  const tok = makeObject(s.nextId++, C('Grizzly Bears'), 0, 'battlefield', s.turn);
  tok.token = { name: 'Probe Token', power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Probe'], keywords: [] };
  extSet(tok, 'tokenAbility', 'ProbeToken');
  s.players[0].battlefield.push(tok); s.bfGen = (s.bfGen ?? 0) + 1;
  assert.equal(tokenAbilityOf(tok)?.index, -9);
  assert.ok(legalActions(g, 0).some(l => l.label === 'sacrifice Probe Token: gain 5 life'));
  const life2 = s.players[0].life;
  assert.equal(await g.performAction(0, { type: 'activate', objectId: tok.id, abilityIndex: -9 }), true);
  assert.equal(s.players[0].life, life2 + 6, 'the family token ability resolved (5 + 1 from the lifeGain replacement)');
  assert.ok(seen.has('tokenAbilities.legal') && seen.has('tokenAbilities.activate'));

  const treasure = makeObject(s.nextId++, C('Grizzly Bears'), 0, 'battlefield', s.turn);
  treasure.token = { name: 'Treasure', power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Treasure'], keywords: [], treasure: true };
  s.players[0].battlefield.push(treasure); s.bfGen = (s.bfGen ?? 0) + 1;
  assert.equal(tokenAbilityOf(treasure)?.index, -1, 'the built-in Treasure entry still matches on its TokenSpec flag');
  assert.ok(legalActions(g, 0).some(l => l.label === 'sacrifice Treasure for mana'));
  assert.equal(await g.performAction(0, { type: 'activate', objectId: treasure.id, abilityIndex: -1 }), true);
  assert.equal(treasure.zone, 'graveyard');
  assert.ok(s.players[0].manaPool.length > 0, 'the Treasure produced mana');

  // event metadata: LOGGED, citation and renderEvent all consult EVENT_META
  const body = { type: 'probe-event', detail: 'x' } as unknown as GameEventBody;
  assert.equal(EVENT_META['probe-event'].cr, '999.1a');
  assert.equal(LOGGED.has('probe-event' as never), true);
  assert.equal(citation(body), '999.1a');
  assert.equal(renderEvent(body, () => 'P'), 'probe event x');
  let captured: { cr?: string } | undefined;
  g.onEvent = (e) => { captured = e; };
  g.emit(body);
  assert.equal(captured?.cr, '999.1a', 'the CR citation from EVENT_META reached the event');
  assert.equal(s.log[s.log.length - 1], 'probe event x');
  delete g.onEvent;

  // castFrom + freeCast: a spell cast from the graveyard for free
  const bolt = makeObject(s.nextId++, C('Lightning Bolt'), 0, 'graveyard', s.turn);
  s.players[0].graveyard.push(bolt);
  extSet(bolt, 'probeCastable', true);
  const foe = s.players[1].life;
  assert.equal(await g.performAction(0, { type: 'cast', cardId: bolt.id, from: 'graveyard', targets: [[{ kind: 'player', id: 1 }]] }), true);
  await g.resolveStackFully();
  assert.equal(s.players[1].life, foe - 3, 'the free graveyard cast resolved');
  assert.ok(seen.has('castFrom') && seen.has('freeCast'));

  // redact scrubs family state the viewer must not see
  extSet(s.players[1].battlefield[0], 'probeSecret', true);
  const view = redact(s, 0);
  assert.equal(extGet<boolean>(view.players[1].battlefield[0], 'probeSecret'), undefined);
  assert.equal(extGet<boolean>(s.players[1].battlefield[0], 'probeSecret'), true, 'the real state is untouched');
  assert.ok(seen.has('redact'));
});

test('triggers, trigger sources, combat hooks, step hooks, SBA, EOT cleanup and extra combats fire in a real turn', async () => {
  const attackers: number[] = [];
  const blocks: { blocker: number; attacker: number }[] = [];
  // Hill Giant attacks into a Grizzly Bears block: the giant survives, so it can attack again in the extra combat.
  const g = setup(
    { bf: ['Hill Giant', 'Mountain', 'Mountain'] },
    { bf: ['Grizzly Bears'] },
    [new Combatant('P0', () => attackers), new Combatant('P1', () => [], () => blocks)],
  );
  const s = g.state;
  const giant = find(g, 'Hill Giant', 0);
  const bears = find(g, 'Grizzly Bears', 1);
  const land = s.players[0].battlefield.find(o => o.def.name === 'Mountain')!;
  attackers.push(giant.id); blocks.push({ blocker: bears.id, attacker: giant.id });

  // the emblem contributed by triggerSources is scanned even though NOTHING on the battlefield carries the kind
  emblem = makeObject(s.nextId++, C('Grizzly Bears'), 0, 'command', s.turn);
  emblem.grantedAbilities = [triggerAbility];
  assert.equal(allPermanents(s).some(o => o.grantedAbilities?.includes(triggerAbility)), false, 'no battlefield permanent has the probe trigger yet');
  g.queueTriggers('probe-trigger', { obj: emblem, player: 0 });
  assert.ok(seen.has('triggerSources'));
  assert.ok(triggerScan.has(emblem.id), 'triggerSources widened the queueTriggers scan beyond allPermanents');
  assert.ok(seen.has('triggers'), 'TRIGGERS matched a non-core trigger event');

  // a permanent whose triggers only the registry can match: one on its own event, one on the core 'attacks' event
  giant.grantedAbilities = [triggerAbility, coreTriggerAbility];
  extSet(land, 'probeShield', true);
  s.bfGen = (s.bfGen ?? 0) + 1;
  g.queueTriggers('probe-trigger', { obj: giant, player: 0 });
  assert.ok(triggerScan.has(giant.id));

  // canAttack / canBlock abstain by default and can forbid
  assert.equal(canAttack(s, giant), true);
  extSet(giant, 'probeCantAttack', true);
  assert.equal(canAttack(s, giant), false, 'CAN_ATTACK forbade the attack');
  extDel(giant, 'probeCantAttack');
  assert.equal(canBlock(s, bears, giant), true);
  extSet(bears, 'probeCantBlock', true);
  assert.equal(canBlock(s, bears, giant), false, 'CAN_BLOCK forbade the block');
  extDel(bears, 'probeCantBlock');
  assert.ok(seen.has('keywordHooks.canAttack') && seen.has('keywordHooks.canBlock'));

  // a synchronous hook reading a computed characteristic: "can't be blocked by creatures with power 2 or less"
  assert.equal(chars.power(s, bears), 2, 'the chars bundle is bound to the core helpers');
  extSet(giant, 'probeMenacing', true);
  assert.equal(canBlock(s, bears, giant), false, 'canBlock consulted chars.power from inside the hook');
  extDel(giant, 'probeMenacing');
  assert.equal(canBlock(s, bears, giant), true);
  assert.ok(seen.has('chars'));

  // combat damage doubling, and one extra combat phase after main 2
  extSet(giant, 'probeDoubleDamage', true);
  extSet(s, 'extraCombats', 1);
  const life = s.players[1].life;

  await g.resumeTurn();

  assert.ok(seen.has('keywordHooks.blockCheck'), 'BLOCK_CHECKS validated the declared block');
  assert.ok(seen.has('keywordHooks.blockFixup'), 'BLOCK_FIXUPS ran on the declared blocks');
  assert.ok(seen.has('keywordHooks.combatDamage'), 'COMBAT_DAMAGE_HOOKS saw the assignments');
  assert.ok(seen.has('sba'), 'SBA_HOOKS ran inside checkSBA');
  assert.ok(seen.has('cleanupEot'), 'EOT_CLEANUP ran in the end-of-turn wipe');
  assert.equal(extGet<boolean>(land, 'probeShield'), undefined, 'and actually cleaned up');
  assert.equal(bears.zone, 'graveyard', 'COMBAT_DAMAGE_HOOKS doubled the damage and the blocker died');
  // 'turn-start', 'untap', 'upkeep', 'draw' and 'main1' belong to the steps resumeTurn does not re-enter; next test.
  for (const st of ['combat-begin', 'declare-attackers', 'declare-blockers', 'combat-damage', 'combat-end', 'main2', 'end', 'cleanup', 'cleanup-end']) {
    assert.ok(seen.has(`steps.${st}`), `step hook ${st} ran`);
  }
  assert.equal(extGet<number>(s, 'extraCombats'), undefined, 'the extra combat was consumed and the counter cleared');
  assert.ok(seen.has('triggers.core'), 'a family trigger answered the core "attacks" event');
  assert.match(s.log.join('\n'), /probe effect 2 on Hill Giant/, 'and its effect actually resolved');
  assert.ok(s.players[1].life < life || s.players[1].lost, 'the extra combat actually happened');
  assert.equal(s.log.filter(l => l.includes('attacks with')).length >= 2, true, 'two combat phases declared attackers');
});

test('turn-start / untap / upkeep / draw step hooks run on a full turn', async () => {
  for (const st of ['turn-start', 'untap', 'upkeep', 'draw', 'main1']) seen.delete('steps.' + st);
  const g = setup({ bf: ['Mountain'] }, { bf: ['Mountain'] });
  await g.playTurns(1);
  for (const st of ['turn-start', 'untap', 'upkeep', 'draw', 'main1']) assert.ok(seen.has(`steps.${st}`), `step hook ${st} ran`);
});

// ------------------------------------------------------------------ ext bags: clone, serialize, phasing, copies
test('ext bags are JSON-plain and survive clone and serialize', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Mountain'] }, { bf: ['Hill Giant'] });
  const s = g.state;
  const bears = find(g, 'Grizzly Bears', 0);

  extSet(bears, 'probeList', [1, 2, { deep: true }]);
  extSet(s.players[0], 'probeSeat', 'yes');
  extSet(s, 'probeGame', { a: [1] });
  assert.ok(isJsonPlain(bears.ext) && isJsonPlain(s.players[0].ext) && isJsonPlain(s.ext));
  assert.equal(isJsonPlain({ bad: new Set([1]) }), false);
  assert.notEqual(plainCopy(bears.ext), bears.ext);

  const cl = cloneState(s);
  const clBears = cl.players[0].battlefield.find(o => o.id === bears.id)!;
  assert.deepEqual(clBears.ext, bears.ext);
  assert.notEqual(clBears.ext, bears.ext, 'the clone deep-copies the bag');
  (clBears.ext!.probeList as number[]).push(9);
  assert.equal((bears.ext!.probeList as unknown[]).length, 3, 'and the copies are independent');
  assert.deepEqual(cl.players[0].ext, s.players[0].ext);
  assert.deepEqual(cl.ext, s.ext);

  const round = deserializeState(JSON.parse(JSON.stringify(serializeState(s))), collectDefs(s));
  const roundBears = round.players[0].battlefield.find(o => o.id === bears.id)!;
  assert.deepEqual(roundBears.ext, bears.ext);
  assert.deepEqual(round.players[0].ext, s.players[0].ext);
  assert.deepEqual(round.ext, s.ext);

  // a non-JSON value in a bag is a contract violation, and plainCopy says so instead of aliasing it into every clone
  assert.throws(() => cloneState({ ...s, ext: { bad: new Set([1]) } as unknown as Record<string, unknown> } as GameState), /JSON-plain/);
});

test('copies ride on the object: defOf needs no state and two live states never cross', () => {
  const gA = setup({ bf: ['Grizzly Bears', 'Mountain'] }, { bf: ['Hill Giant'] });
  const gB = setup({ bf: ['Grizzly Bears', 'Mountain'] }, { bf: ['Hill Giant'] });
  const sA = gA.state;
  const bears = find(gA, 'Grizzly Bears', 0);

  gA.setCopyDef(bears, C('Hill Giant'));
  assert.equal(defOf(bears).name, 'Hill Giant');
  assert.equal(power(sA, bears), 3, 'the copy uses the copied printed power');

  // touching another game (an AI clone, a redact view, the optimiser) cannot change what this object is
  allPermanents(gB.state); power(gB.state, find(gB, 'Grizzly Bears', 0));
  assert.equal(defOf(bears).name, 'Hill Giant', 'defOf answers for the object, not for whichever state was touched last');

  const cl = cloneState(sA);
  const clBears = cl.players[0].battlefield.find(o => o.id === bears.id)!;
  assert.equal(defOf(clBears).name, 'Hill Giant', 'copies survive clone');
  assert.equal(clBears.copyDef, bears.copyDef, 'and the CardDef is shared, not deep-copied');

  const round = deserializeState(JSON.parse(JSON.stringify(serializeState(sA))), collectDefs(sA));
  assert.equal(defOf(round.players[0].battlefield.find(o => o.id === bears.id)!).name, 'Hill Giant', 'copies survive serialize');

  gA.setCopyDef(bears, null);
  assert.equal(defOf(bears).name, 'Grizzly Bears');
});

test('a phased-out permanent cannot be scanned, untapped, activated, attack or block', async () => {
  const g = setup({ bf: ['Grizzly Bears', 'Mountain'] }, { bf: ['Hill Giant'] });
  const s = g.state;
  const bears = find(g, 'Grizzly Bears', 0);
  const mountain = s.players[0].battlefield.find(o => o.def.name === 'Mountain')!;
  const giant = find(g, 'Hill Giant', 1);
  const before = allPermanents(s).length;

  // no s.version++ anywhere: the gate is read from the state itself, not from a memo keyed on a version nobody bumps
  extSet(s, 'phasing', true); extSet(mountain, 'phasedOut', true); extSet(bears, 'phasedOut', true);
  assert.equal(isPhasedOut(bears), true);
  assert.equal(allPermanents(s).length, before - 2, 'the phased-out permanents are gone from the battlefield scan');
  assert.equal(battlefieldOf(s, 0).length, 0, 'and from the per-seat scan the engine untaps and activates through');
  assert.ok(findObject(s, bears.id), 'but they still exist');
  assert.equal(canAttack(s, bears), false, 'a phased-out creature cannot attack');
  assert.equal(canBlock(s, bears, giant), false, 'nor block');
  assert.equal(legalActions(g, 0).some(l => l.action.type === 'activate' && l.action.objectId === mountain.id), false, 'nor be activated');
  assert.equal(evalAmount(s, { count: 'creatures-you-control' } as never, 0), 0, 'nor be counted by an amount');
  assert.equal(evalAmount(s, { count: 'lands-you-control' } as never, 0), 0);
  assert.equal(conditionHolds(s, giant, { kind: 'controls', who: 'opponent', atLeast: 1 } as never), false, 'nor by a condition');

  // the untap step leaves it alone (CR 702.26e)
  g.setTapped(bears, true, 'effect');
  s.step = 'end'; await g.resumeTurn();
  assert.equal(bears.tapped, true, 'the untap step skipped the phased-out permanent');

  extDel(bears, 'phasedOut'); extDel(mountain, 'phasedOut'); extDel(s, 'phasing');
  assert.equal(allPermanents(s).length, before);
});

test('a cancelled zone move leaves the object exactly where it was', () => {
  const g = setup({ bf: ['Grizzly Bears', 'Mountain'] }, { bf: ['Hill Giant'] });
  const s = g.state;
  for (const n of ['Hill Giant', 'Mountain', 'Mountain']) s.players[0].library.push(makeObject(s.nextId++, C(n), 0, 'library', s.turn));
  const lib = s.players[0].library;
  const top = lib[0];
  const libLen = lib.length;

  extSet(top, 'probeCancelMove', true);
  g.moveTo(top, 'graveyard', 'top', 'mill');
  assert.ok(seen.has('replacements.zoneMove.cancel'));
  assert.equal(top.zone, 'library');
  assert.equal(s.players[0].library.length, libLen, 'the library is unchanged in size');
  assert.equal(s.players[0].library.indexOf(top), 0, 'and the top card is still on top (draw order is observable)');
  extDel(top, 'probeCancelMove');

  // a cancelled destroy must not strip the battlefield state moveTo would have wiped
  const bears = find(g, 'Grizzly Bears', 0);
  bears.faceDown = true;
  bears.animated = { power: 4, toughness: 4, colors: [], types: ['Creature'], subtypes: [], keywords: [] };
  bears.earthbent = true;
  const idx = s.players[0].battlefield.indexOf(bears);
  extSet(bears, 'probeCancelMove', true);
  g.moveTo(bears, 'graveyard', 'top', 'destroy');
  assert.equal(bears.zone, 'battlefield');
  assert.equal(s.players[0].battlefield.indexOf(bears), idx, 'it did not move to the end of the battlefield');
  assert.equal(bears.faceDown, true, 'face-down state survived the cancelled move');
  assert.ok(bears.animated, 'animation survived it');
  assert.equal(bears.earthbent, true, 'and so did earthbend');
  extDel(bears, 'probeCancelMove');
  delete bears.faceDown; delete bears.animated; delete bears.earthbent;
});

test('an unspent extra combat does not leak into the next turn', async () => {
  const g = setup({ bf: ['Mountain'] }, { bf: ['Mountain'] });
  const s = g.state;
  extSet(s, 'extraCombats', 1);
  s.step = 'end';
  await g.resumeTurn();                                    // resumes past main 2, so nothing spends it
  assert.equal(extGet<number>(s, 'extraCombats'), undefined, 'the cleanup step cleared the unspent extra combat');
});

test('redaction reaches the player and game ext bags, not just objects', () => {
  const g = setup({ bf: ['Mountain'] }, { bf: ['Mountain'] });
  const s = g.state;
  extSet(s.players[1], 'probeSecretPile', [7, 8, 9]);
  extSet(s, 'probeSecretVote', { p1: 'yes' });
  const view = redact(s, 0);
  assert.equal(extGet(view.players[1], 'probeSecretPile'), undefined, 'the opponent seat state is hidden');
  assert.equal(extGet(view, 'probeSecretVote'), undefined, 'and so is the hidden game state');
  assert.deepEqual(extGet<number[]>(s.players[1], 'probeSecretPile'), [7, 8, 9], 'the real state is untouched');
  assert.ok(seen.has('redactPlayer') && seen.has('redactState'));
});

test('mode costs and cost alteration have registry hooks', () => {
  const g = setup({ bf: ['Mountain'] }, { bf: ['Mountain'] });
  const s = g.state;
  const bolt = makeObject(s.nextId++, C('Lightning Bolt'), 0, 'hand', s.turn);
  s.players[0].hand.push(bolt);

  const base = spellManaCost(bolt.def).generic;
  assert.equal(spellManaCost(bolt.def, undefined, false, [0, 1]).generic, base + 1, 'MODE_COSTS added what the chosen modes cost');
  assert.equal(spellManaCost(bolt.def, undefined, false, [0]).generic, base, 'and abstained for a single mode');
  assert.ok(seen.has('modeCost'));

  const before = costAdjust(s, 0, bolt);
  extSet(bolt, 'probeCheaper', true);
  assert.equal(costAdjust(s, 0, bolt), before + 2, 'COST_MODS altered the cost');
  extDel(bolt, 'probeCheaper');
  assert.ok(seen.has('costMod'));
});

// ------------------------------------------------------------------ the 8a-1 review fixes
/** A three-seat freeform game in seat 0's precombat main phase. */
function threeSeatGame(): Game {
  const deck = () => Array(20).fill(C('Mountain'));
  const g = new Game([deck(), deck(), deck()], [new Script('P0'), new Script('P1'), new Script('P2')], { seed: 1, quiet: true, mulligans: false });
  const s = g.state; s.turn = 5; s.activePlayer = 0; s.step = 'main1'; s.priority = 0;
  return g;
}

test("an extra combat granted to a seat never reaches another seat's turn", async () => {
  const g = threeSeatGame(); const s = g.state;
  const bears = makeObject(s.nextId++, C('Grizzly Bears'), 0, 'battlefield', 1);
  bears.enteredTurn = 1; s.players[0].battlefield.push(bears);

  // a probe effect op grants the active seat an extra combat phase, exactly as a family mechanic would
  const item = g.makeStackItem('ability', bears, 0, [{ op: 'probe-extra-combat' } as unknown as Effect], 'probe', 0, undefined, 'probe');
  await g.applyEffect(item, { op: 'probe-extra-combat' } as unknown as Effect, 0, item.effects);
  assert.equal(extGet<number>(s, 'extraCombats'), 1, 'the probe op queued an extra combat for seat 0');

  // seat 0 is eliminated in its own main phase: that turn ends without ever reaching its cleanup step
  g.eliminate(0, 'conceded', 'P0 concedes.');
  assert.equal(s.players[0].lost, true);
  assert.equal(s.winner, null, 'two seats are still in the game');
  assert.equal(extGet<number>(s, 'extraCombats'), undefined, 'the eliminated active player took the extra combat with them');

  // and a counter that survives any other early exit is dropped when the next seat's turn begins
  extSet(s, 'extraCombats', 1);
  let combats = 0;
  g.onEvent = ev => { if (ev.type === 'step' && ev.to === 'combat-begin') combats++; };
  await g.playTurns(1);
  assert.equal(s.activePlayer, 1, 'seat 1 took the next turn');
  assert.equal(extGet<number>(s, 'extraCombats'), undefined, 'the turn started from zero extra combats');
  assert.equal(combats, 1, 'seat 1 got exactly one combat phase');
});

test('resumeTurn does not re-fire the step hook of the step it resumes into', async () => {
  let main2 = 0;
  registerFamily({ name: 'main2-probe', steps: { main2: () => { main2++; } } });
  try {
    const a = setup({ bf: ['Mountain'] }, { bf: ['Mountain'] });
    a.state.step = 'main2';
    await a.resumeTurn();
    assert.equal(main2, 0, 'main 2 had already been entered, so its hook must not run again');

    const b = setup({ bf: ['Mountain'] }, { bf: ['Mountain'] });
    b.state.step = 'end';
    await b.resumeTurn();
    assert.equal(main2, 0, 'and a resume past main 2 never enters it at all');

    const c = setup({ bf: ['Mountain'] }, { bf: ['Mountain'] });
    c.state.step = 'main1';
    await c.resumeTurn();
    assert.equal(main2, 1, 'a resume that really does enter main 2 still fires it exactly once');
  } finally { unregisterFamily('main2-probe'); }
});

test('a registry mode cost is part of the payment plan of every legal cast', async () => {
  // Cryptic Command is {1}{U}{U}{U}, "choose two"; the probe's modeCost adds {1} for the second mode.
  const isl = ['Island', 'Island', 'Island', 'Island', 'Island'];
  const g = setup({ bf: isl, hand: ['Cryptic Command'] }, { bf: ['Mountain'] });
  const s = g.state;
  const cc = s.players[0].hand.find(o => o.def.name === 'Cryptic Command')!;
  // modes 3+4 ("tap all creatures your opponents control" + "draw a card") take no targets, so they are always offered
  const label = 'cast Cryptic Command [mode 3+4]';
  const act = legalActions(g, 0).find(l => l.label === label);
  assert.ok(act, `the two-mode cast is legal with five lands (${label})`);
  assert.equal(act.manaValue, 5, 'the printed {1}{U}{U}{U} plus the registry mode surcharge');
  assert.equal(act.pay?.taps.length, 5, 'and the payment plan taps five lands, not four');
  assert.ok(seen.has('modeCost'));

  // it really is the surcharge: with one land fewer the same cast is not offered at all
  const four = setup({ bf: isl.slice(1), hand: ['Cryptic Command'] }, { bf: ['Mountain'] });
  assert.equal(legalActions(four, 0).some(l => l.label === label), false, 'four lands cannot pay the mode surcharge');

  // and the cast that plan describes goes through, spending exactly that mana
  assert.equal(await g.performAction(0, act.action), true);
  assert.equal(s.players[0].battlefield.filter(o => !o.tapped).length, 0, 'all five lands paid for it');
  assert.deepEqual(s.players[0].manaPool, [], 'with nothing left floating');
  assert.equal(s.stack.some(it => it.source.id === cc.id), true, 'Cryptic Command is on the stack');
});

test('the counters replacement fold sees removals, loyalty and objects outside the battlefield', () => {
  const g = setup({ bf: ['Grizzly Bears'] }, { bf: ['Mountain'] });
  const s = g.state;
  const bears = find(g, 'Grizzly Bears', 0);

  // a removal: the early return used to hide every negative delta from the fold
  g.addCounters(bears, '+1/+1', 3);
  extSet(bears, 'probeNoCounterLoss', true);
  g.addCounters(bears, '+1/+1', -2);
  assert.equal(bears.counters['+1/+1'], 3, 'the family replacement prevented the counter loss');
  assert.ok(seen.has('replacements.counters.removal'));

  // loyalty, which the core doubling statics must still never touch
  bears.counters.loyalty = 3;
  g.addCounters(bears, 'loyalty', -1);
  assert.equal(bears.counters.loyalty, 3, 'a loyalty removal reached the fold too');
  g.addCounters(bears, 'loyalty', 1);
  assert.equal(bears.counters.loyalty, 4, 'and an addition is still not doubled by the core statics');
  delete bears.counters.loyalty;
  extDel(bears, 'probeNoCounterLoss');

  // an object outside the battlefield (a suspended card in exile)
  const exiled = makeObject(s.nextId++, C('Hill Giant'), 0, 'exile', s.turn);
  s.players[0].exile.push(exiled);
  exiled.counters.time = 2;
  extSet(exiled, 'probeNoCounterLoss', true);
  g.addCounters(exiled, 'time', -1);
  assert.equal(exiled.counters.time, 2, 'the fold answered for a card in exile');
  extDel(exiled, 'probeNoCounterLoss');
  g.addCounters(exiled, 'time', -1);
  assert.equal(exiled.counters.time, 1, 'and abstaining still removes it');
});

test('an earthbent commander keeps its replacement note even though it goes to the command zone', () => {
  const deck = () => Array(20).fill(C('Mountain'));
  const g = new Game([deck(), deck()], [new Script('P0'), new Script('P1')],
    { seed: 1, quiet: true, mulligans: false, format: 'commander', commanders: [[C('Isamaru, Hound of Konda')], [C('Grizzly Bears')]] });
  const s = g.state; s.turn = 5; s.activePlayer = 0; s.step = 'main1';
  const cmd = s.players[0].command[0];
  g.moveTo(cmd, 'battlefield');
  assert.equal(cmd.zone, 'battlefield');
  cmd.earthbent = true;

  const before = s.log.length;
  g.moveTo(cmd, 'graveyard', 'top', 'destroy');
  assert.equal(cmd.zone, 'command', 'CR 903.9a still redirects it to the command zone');
  assert.match(s.log.slice(before).join('\n'), /Isamaru, Hound of Konda would die and returns to its owner's hand instead\./,
    'the earthbend replacement note survives the commander redirect');
});

test('a token ability only replaces the generic activated-ability scan when it covers the token', () => {
  // Bonesplitter is an Equipment, so the generic scan offers "equip" for it. Dressing it up as each predefined token
  // pins which of them speak for the object (Clue, Food, an untapped Treasure) and which fall through to that scan
  // (a tapped Treasure, every Eldrazi Spawn) - the labels legalActions produced before 8a-1 moved them into a registry.
  const g = setup({ bf: ['Bonesplitter', 'Mountain', 'Mountain', 'Grizzly Bears'] }, { bf: ['Hill Giant'] });
  const o = find(g, 'Bonesplitter', 0);
  const equip = `equip Bonesplitter#${o.id}`;
  const mine = () => legalActions(g, 0).map(l => l.label).filter(l => l === equip || l.startsWith('sacrifice'));
  // a token's own def is only its creator's card, so the equipment ability rides along as a granted one
  const asToken = (spec: Record<string, unknown>) => {
    o.grantedAbilities = [...C('Bonesplitter').abilities];
    o.token = { name: 'Bonesplitter', power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: [], keywords: [], ...spec } as GameObject['token'];
    g.state.bfGen = (g.state.bfGen ?? 0) + 1; g.state.version++;
  };

  assert.deepEqual(mine(), [equip], 'the plain Equipment offers equip');

  asToken({ treasure: true });
  assert.deepEqual(mine(), ['sacrifice Treasure for mana'], 'an untapped Treasure speaks for the object: no equip');
  o.tapped = true;
  assert.deepEqual(mine(), [equip], 'a tapped Treasure offers nothing and falls through to the generic scan');
  o.tapped = false;

  asToken({ spawn: true });
  assert.deepEqual(mine(), [equip], 'Eldrazi Spawn is spent by the mana solver and always falls through');

  asToken({ clue: true });
  assert.deepEqual(mine(), ['sacrifice Clue: draw a card'], 'a Clue speaks for the object');

  asToken({ food: true });
  assert.deepEqual(mine(), ['sacrifice Food: gain 3 life'], 'and so does a Food');
  o.tapped = true;
  assert.deepEqual(mine(), [], 'a tapped Food still covers the object even though it can offer nothing');

  o.tapped = false; o.token = null; delete o.grantedAbilities;
});

/** A Script that records the blocker candidates it was offered. */
class Blocker extends Script {
  asked: number[][] = [];
  override async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (d.kind === 'blockers') this.asked.push([...d.candidates]);
    return super.decide(s, me, d);
  }
}

test('a phased-out permanent does not trigger the legend rule and is not offered as a blocker', async () => {
  // legend rule (CR 704.5j): a phased-out permanent does not exist, so nothing is put into the graveyard
  const g = setup({ bf: ['Isamaru, Hound of Konda', 'Isamaru, Hound of Konda'] }, { bf: ['Mountain'] });
  const s = g.state;
  const [first, second] = s.players[0].battlefield.filter(o => o.def.name === 'Isamaru, Hound of Konda');
  extSet(s, 'phasing', true); extSet(second, 'phasedOut', true);
  g.checkSBA();
  assert.equal(first.zone, 'battlefield');
  assert.equal(second.zone, 'battlefield', 'the legend rule never saw the phased-out copy');
  extDel(second, 'phasedOut');
  g.checkSBA();
  assert.equal(first.zone, 'graveyard', 'and applies the moment it phases back in');
  extDel(s, 'phasing');

  // declare blockers: the candidate list the defender is asked about
  let attacker = 0;
  const run = async (phaseOut: boolean) => {
    const def = new Blocker('P1');
    const h = setup({ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }, [new Combatant('P0', () => [attacker]), def]);
    attacker = find(h, 'Grizzly Bears', 0).id;
    if (phaseOut) { extSet(h.state, 'phasing', true); extSet(find(h, 'Hill Giant', 1), 'phasedOut', true); }
    await h.resumeTurn();
    return { h, asked: def.asked };
  };
  const on = await run(false);
  assert.deepEqual(on.asked, [[find(on.h, 'Hill Giant', 1).id]], 'the untapped defender was offered as a blocker');
  const off = await run(true);
  assert.deepEqual(off.asked, [], 'a phased-out creature is never offered as a blocker');
});

// ------------------------------------------------------------------ the final tally
test('every hook kind of the FamilyModule contract was observed', () => {
  const required = [
    'effects', 'effects.apply', 'conditions', 'amounts', 'triggers', 'statics', 'costParts.payable', 'costParts.pay',
    'asEnters', 'replacements.zoneMove', 'replacements.damage', 'replacements.draw', 'replacements.counters', 'replacements.lifeGain',
    'steps.turn-start', 'steps.untap', 'steps.upkeep', 'steps.draw', 'steps.main1', 'steps.combat-begin', 'steps.declare-attackers',
    'steps.declare-blockers', 'steps.combat-damage', 'steps.combat-end', 'steps.main2', 'steps.end', 'steps.cleanup', 'steps.cleanup-end',
    'sba', 'legalActions', 'actions', 'decisions', 'keywordHooks.canAttack', 'keywordHooks.canBlock', 'keywordHooks.blockCheck',
    'keywordHooks.blockFixup', 'keywordHooks.combatDamage', 'triggerSources', 'redact', 'redactPlayer', 'redactState',
    'cleanupEot', 'targetKinds', 'tokenAbilities.legal', 'tokenAbilities.activate', 'leave', 'castFrom', 'freeCast',
    'triggers.core', 'replacements.zoneMove.cancel', 'chars', 'modeCost', 'costMod',
    'effects.extraCombat', 'replacements.counters.removal',
  ];
  assert.deepEqual(required.filter(k => !seen.has(k)), [], 'these hook sites never called the probe family');
});
