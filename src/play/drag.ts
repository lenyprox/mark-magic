// Pure drag-and-drop planning for the table: given what is being picked up and the interaction mode, list every
// drop zone that does something and what it does. Also the client-side "why can't I play this" heuristics that
// cite the Comprehensive Rules. No DOM, no React; the web layer maps pointer positions to DropZones.
import type { AttackDeclaration, AttackTarget, BlockDeclaration, LegalAction, PlayerId, TargetRef } from '../engine/state.js';
import type { ViewState, CardView, PermanentView } from './view.js';
import type { TargetingState } from './targeting.js';
import { actionsForCard, currentRequirement } from './targeting.js';
import { isManaSource } from './pay.js';

export type DragSource =
  | { kind: 'hand'; cardId: number }
  | { kind: 'permanent'; id: number }
  | { kind: 'stack'; id: number }
  /** A commander in the viewer's command zone (Commander games). */
  | { kind: 'command'; cardId: number };

export type DropZone =
  | { kind: 'battlefield'; player: PlayerId }
  | { kind: 'player'; id: PlayerId }
  | { kind: 'object'; id: number }
  | { kind: 'stack'; id: number }
  | { kind: 'void' };

export type DropEffect =
  | { kind: 'begin'; legal: LegalAction; /** pre-pick this target once the action's targeting starts */ pick?: TargetRef; /** the drop landed on one of the viewer's mana sources: start manual payment from it */ paySource?: number }
  | { kind: 'pick'; ref: TargetRef }
  | { kind: 'attack'; id: number; /** the defender the drop chose (a player, or a planeswalker by object id) */ target?: AttackTarget }
  | { kind: 'unattack'; id: number }
  | { kind: 'block'; blocker: number; attacker: number }
  | { kind: 'unblock'; blocker: number }
  | { kind: 'none'; reason: IllegalReason };

export type IllegalCode = 'land-drop-used' | 'sorcery-timing' | 'not-your-turn' | 'summoning-sick' | 'tapped' | 'cant-pay' | 'no-priority' | 'not-a-target' | 'not-legal' | 'stack-not-empty' | 'no-action';

export interface IllegalReason { code: IllegalCode; rule: string /* CR number e.g. '305.2' */; text: string }

/** A minimal, serialisable picture of the table's interaction mode. */
export interface DragMode {
  kind: 'idle' | 'targeting' | 'attackers' | 'blockers';
  legal: LegalAction[];
  targeting?: TargetingState;
  attackers?: { decl: AttackDeclaration; candidates: number[]; mustAttack: number[]; /** From the decision: players that can be attacked and planeswalkers (with their controller). */ defenders?: PlayerId[]; planeswalkers?: { id: number; controller: PlayerId }[] };
  blockers?: { decl: BlockDeclaration; selected: number | null; attackers: number[]; candidates: number[] };
}

export interface DragContext { mode: DragMode; view: ViewState; me: PlayerId }

export interface DragPlan {
  source: DragSource;
  zones: { zone: DropZone; effect: DropEffect }[];
  /** Why the card cannot be picked up at all (zones is then empty). */
  illegal?: IllegalReason;
  /** The drop starts a targeting flow that continues with a tether arrow. */
  tether?: boolean;
  /** More than one action applies: the drop should offer these instead of starting one. */
  choices?: LegalAction[];
}

// ---- helpers ------------------------------------------------------------------------------------
const cite = (code: IllegalCode, rule: string, text: string): IllegalReason => ({ code, rule, text: `${text} (CR ${rule})` });

export function sameZone(a: DropZone, b: DropZone): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'battlefield': return a.player === (b as { player: PlayerId }).player;
    case 'void': return true;
    default: return a.id === (b as { id: number }).id;
  }
}

const zoneForRef = (ref: TargetRef): DropZone => ref.kind === 'object' ? { kind: 'object', id: ref.id } : ref.kind === 'player' ? { kind: 'player', id: ref.id } : { kind: 'stack', id: ref.id };

function myPlayer(ctx: DragContext) { return ctx.view.players[ctx.me]; }
function handCard(ctx: DragContext, cardId: number): CardView | null { return myPlayer(ctx).hand?.find(c => c.id === cardId) ?? null; }
function commandCard(ctx: DragContext, cardId: number): CardView | null { return myPlayer(ctx).command?.find(c => c.id === cardId) ?? null; }
function permanent(ctx: DragContext, id: number): PermanentView | null {
  for (const p of ctx.view.players) { const o = p.battlefield.find(b => b.id === id); if (o) return o; }
  return null;
}
/** The object id a source refers to. */
export const sourceId = (s: DragSource): number => s.kind === 'hand' || s.kind === 'command' ? s.cardId : s.id;
const isInstantSpeed = (c: CardView) => c.types.includes('Instant') || (c.keywords as string[]).includes('flash');
const hasTapCost = (c: CardView) => /\{T\}/.test(c.text);
const targetingSourceId = (st: TargetingState): number | null => {
  const a = st.legal.action;
  return a.type === 'cast' || a.type === 'play-land' ? a.cardId : a.type === 'activate' ? a.objectId : null;
};

/** Untapped lands plus floating mana: a cheap upper bound on what the viewer can pay right now. */
export function availableMana(ctx: DragContext): number {
  const p = myPlayer(ctx);
  return p.battlefield.filter(o => o.isLand && !o.tapped).length + p.manaPool.length;
}

/** Players a declared attacker can be sent at: the decision's defenders, else every living opponent. */
export function attackTargetsFor(ctx: DragContext): PlayerId[] {
  const d = ctx.mode.attackers?.defenders;
  if (d && d.length) return [...d];
  return ctx.view.players.filter(p => p.id !== ctx.me && !p.lost).map(p => p.id);
}

/** Planeswalkers a declared attacker can be sent at (from the decision; fallback: every opponent planeswalker). */
export function attackPlaneswalkersFor(ctx: DragContext): { id: number; controller: PlayerId }[] {
  const w = ctx.mode.attackers?.planeswalkers;
  if (w) return [...w];
  const out: { id: number; controller: PlayerId }[] = [];
  for (const pid of attackTargetsFor(ctx)) for (const o of ctx.view.players[pid].battlefield) if (o.types.includes('Planeswalker')) out.push({ id: o.id, controller: pid });
  return out;
}

/** The defender an attacker goes at when the declaration names none (the first defender / living opponent). */
export function defaultDefender(ctx: DragContext): PlayerId | null {
  return attackTargetsFor(ctx)[0] ?? null;
}

// ---- illegal reasons ----------------------------------------------------------------------------
/** Client-side heuristics for why a card has no legal action; null when nothing obvious explains it. */
export function whyNotPlayable(cardId: number, ctx: DragContext): IllegalReason | null {
  const { view, mode } = ctx;
  const me = myPlayer(ctx);
  if (mode.kind !== 'idle') return cite('not-legal', '117.3', 'Finish the current action first');
  if (!mode.legal.length || view.priority !== ctx.me) return cite('no-priority', '117.1', "You don't have priority right now");
  const inHand = handCard(ctx, cardId);
  const inCommand = inHand ? null : commandCard(ctx, cardId);
  const card = inHand ?? inCommand;
  if (card) {
    const myTurn = view.activePlayer === ctx.me;
    const main = view.step === 'main1' || view.step === 'main2';
    if (inHand && card.types.includes('Land')) {
      if (me.landsPlayedThisTurn >= 1 && myTurn && main) return cite('land-drop-used', '305.2', 'You already played a land this turn');
      if (!myTurn) return cite('not-your-turn', '305.1', 'Lands can only be played during your own turn');
      if (view.stack.length) return cite('stack-not-empty', '305.1', 'Lands can only be played while the stack is empty');
      if (!main) return cite('sorcery-timing', '305.1', 'Lands can only be played during a main phase');
      if (me.landsPlayedThisTurn >= 1) return cite('land-drop-used', '305.2', 'You already played a land this turn');
      return null;
    }
    if (!isInstantSpeed(card)) {
      const sorcery = card.types.includes('Sorcery');
      if (!myTurn) return cite('not-your-turn', '505.1a', `${sorcery ? 'Sorceries' : 'Spells without flash'} can only be cast during your own turn`);
      if (view.stack.length) return cite('stack-not-empty', '117.1a', `${sorcery ? 'Sorceries' : 'Spells without flash'} can only be cast while the stack is empty`);
      if (!main) return cite('sorcery-timing', sorcery ? '307.1' : '117.1a', `${sorcery ? 'Sorceries' : 'Spells without flash'} can only be cast during a main phase`);
    }
    const tax = inCommand ? 2 * (me.commanderCasts?.[cardId] ?? 0) : 0;
    if (card.manaValue + tax > availableMana(ctx)) return cite('cant-pay', inCommand ? '903.8' : '601.2g', inCommand ? `You can't pay ${card.manaCost ?? `{${card.manaValue}}`} plus the commander tax {${tax}} right now` : `You can't pay ${card.manaCost ?? `{${card.manaValue}}`} right now`);
    return null;
  }
  const perm = permanent(ctx, cardId);
  if (perm) {
    if (perm.controller !== ctx.me) return cite('not-legal', '602.2', "You don't control that permanent");
    const activated = /(^|\n)[^\n]*:/.test(perm.text);
    if (!activated) return cite('no-action', '602.1', `${perm.name} has no activated ability`);
    if (hasTapCost(perm) && perm.isCreature && perm.summoningSick) return cite('summoning-sick', '302.6', `${perm.name} is summoning sick, so its {T} ability can't be activated`);
    if (hasTapCost(perm) && perm.tapped) return cite('tapped', '602.5a', `${perm.name} is tapped, so its {T} ability can't be activated`);
    return cite('cant-pay', '602.2b', `None of ${perm.name}'s abilities can be paid for right now`);
  }
  return null;
}

// ---- planning -----------------------------------------------------------------------------------
/** The viewer's untapped mana sources: dropping a spell on one starts manual payment from it. */
function paySourceZones(ctx: DragContext, legal: LegalAction): DragPlan['zones'] {
  if (legal.action.type !== 'cast' || !legal.pay) return [];
  return myPlayer(ctx).battlefield.filter(o => !o.tapped && isManaSource(o)).map(o => ({ zone: { kind: 'object', id: o.id } as DropZone, effect: { kind: 'begin', legal, paySource: o.id } as DropEffect }));
}

function planIdle(source: DragSource, ctx: DragContext): DragPlan {
  const id = sourceId(source);
  if (source.kind === 'stack') return { source, zones: [], illegal: cite('no-action', '405.6', 'Objects on the stack cannot be moved') };
  const acts = actionsForCard(ctx.mode.legal, id).filter(l => source.kind === 'hand' ? (l.action.type === 'play-land' || (l.action.type === 'cast' && l.action.from !== 'command'))
    : source.kind === 'command' ? l.action.type === 'cast' && l.action.from === 'command'
    : l.action.type === 'activate');
  if (!acts.length) {
    const reason = whyNotPlayable(id, ctx) ?? cite('no-action', source.kind === 'command' ? '903.6' : '117.1', source.kind === 'hand' ? 'That card cannot be played right now' : source.kind === 'command' ? 'Your commander cannot be cast right now' : 'Nothing to activate right now');
    return { source, zones: [], illegal: reason };
  }
  if (source.kind === 'hand' || source.kind === 'command') {
    const zone: DropZone = { kind: 'battlefield', player: ctx.me };
    if (acts.length > 1) return { source, zones: [{ zone, effect: { kind: 'begin', legal: acts[0] } }], choices: acts };
    const legal = acts[0];
    const tether = !!legal.targetOptions?.some(r => r.options.length > 0);
    return { source, zones: [{ zone, effect: { kind: 'begin', legal } }, ...paySourceZones(ctx, legal)], tether };
  }
  // permanent: a single ability with targets offers each target as a zone; otherwise drop on self activates
  const self: DropZone = { kind: 'object', id };
  if (acts.length > 1) return { source, zones: [{ zone: self, effect: { kind: 'begin', legal: acts[0] } }], choices: acts };
  const legal = acts[0];
  const first = legal.targetOptions?.[0];
  if (first && first.options.length) {
    const zones = first.options.map(ref => ({ zone: zoneForRef(ref), effect: { kind: 'begin', legal, pick: ref } as DropEffect }));
    if (!zones.some(z => sameZone(z.zone, self))) zones.push({ zone: self, effect: { kind: 'begin', legal } });
    return { source, zones, tether: (legal.targetOptions?.length ?? 0) > 1 || first.count > 1 };
  }
  return { source, zones: [{ zone: self, effect: { kind: 'begin', legal } }] };
}

function planTargeting(source: DragSource, ctx: DragContext): DragPlan {
  const st = ctx.mode.targeting;
  if (!st) return { source, zones: [], illegal: cite('not-legal', '601.2c', 'Nothing is being targeted') };
  if (targetingSourceId(st) !== sourceId(source)) return { source, zones: [], illegal: cite('not-legal', '601.2c', 'Finish choosing targets first') };
  const req = currentRequirement(st);
  const zones = (req?.options ?? []).map(ref => ({ zone: zoneForRef(ref), effect: { kind: 'pick', ref } as DropEffect }));
  return { source, zones, tether: true };
}

function planAttackers(source: DragSource, ctx: DragContext): DragPlan {
  const at = ctx.mode.attackers;
  if (!at || source.kind !== 'permanent') return { source, zones: [], illegal: cite('not-legal', '508.1', 'Only your untapped creatures can attack') };
  if (!at.candidates.includes(source.id)) {
    const perm = permanent(ctx, source.id);
    const reason = perm && perm.controller === ctx.me && perm.isCreature && perm.summoningSick ? cite('summoning-sick', '302.6', `${perm.name} came under your control this turn and can't attack`)
      : perm && perm.controller === ctx.me && perm.isCreature && perm.tapped ? cite('tapped', '508.1c', `${perm.name} is tapped and can't attack`)
      : cite('not-legal', '508.1', `${perm?.name ?? 'That'} can't attack`);
    return { source, zones: [], illegal: reason };
  }
  const zones: DragPlan['zones'] = [];
  const defenders = attackTargetsFor(ctx);
  // planeswalkers first: an object zone sits inside its controller's battlefield zone, so the innermost wins
  for (const pw of attackPlaneswalkersFor(ctx)) zones.push({ zone: { kind: 'object', id: pw.id }, effect: { kind: 'attack', id: source.id, target: { planeswalker: pw.id } } });
  for (const pid of defenders) {
    zones.push({ zone: { kind: 'player', id: pid }, effect: { kind: 'attack', id: source.id, target: pid } });
    zones.push({ zone: { kind: 'battlefield', player: pid }, effect: { kind: 'attack', id: source.id, target: pid } });
  }
  if (!at.mustAttack.includes(source.id)) zones.push({ zone: { kind: 'battlefield', player: ctx.me }, effect: { kind: 'unattack', id: source.id } });
  return { source, zones };
}

function planBlockers(source: DragSource, ctx: DragContext): DragPlan {
  const bl = ctx.mode.blockers;
  if (!bl || source.kind !== 'permanent') return { source, zones: [], illegal: cite('not-legal', '509.1a', 'Only your untapped creatures can block') };
  if (!bl.candidates.includes(source.id)) {
    const perm = permanent(ctx, source.id);
    const reason = perm && perm.controller === ctx.me && perm.isCreature && perm.tapped ? cite('tapped', '509.1a', `${perm.name} is tapped and can't block`)
      : cite('not-legal', '509.1a', `${perm?.name ?? 'That'} can't block`);
    return { source, zones: [], illegal: reason };
  }
  const zones: DragPlan['zones'] = bl.attackers.map(attacker => ({ zone: { kind: 'object', id: attacker } as DropZone, effect: { kind: 'block', blocker: source.id, attacker } as DropEffect }));
  zones.push({ zone: { kind: 'battlefield', player: ctx.me }, effect: { kind: 'unblock', blocker: source.id } });
  return { source, zones };
}

/** Every drop zone that does something for this source in this mode. */
export function planDrag(source: DragSource, ctx: DragContext): DragPlan {
  switch (ctx.mode.kind) {
    case 'idle': return planIdle(source, ctx);
    case 'targeting': return planTargeting(source, ctx);
    case 'attackers': return planAttackers(source, ctx);
    case 'blockers': return planBlockers(source, ctx);
    default: return { source, zones: [], illegal: cite('not-legal', '117.1', 'Nothing can be dragged right now') };
  }
}

/** What dropping on `zone` does under `plan` (exact zone match); `none` with a reason otherwise. */
export function resolveDrop(plan: DragPlan, zone: DropZone): DropEffect {
  if (plan.illegal) return { kind: 'none', reason: plan.illegal };
  const hit = plan.zones.find(z => sameZone(z.zone, zone));
  if (hit) return hit.effect;
  if (zone.kind === 'void') return { kind: 'none', reason: { code: 'no-action', rule: '', text: 'Dropped outside the table' } };
  const anyPick = plan.zones.some(z => z.effect.kind === 'pick' || (z.effect.kind === 'begin' && z.effect.pick));
  if (anyPick) return { kind: 'none', reason: cite('not-a-target', '115.1', "That isn't a legal target") };
  const first = plan.zones[0]?.effect;
  if (first?.kind === 'attack' || first?.kind === 'unattack') return { kind: 'none', reason: cite('not-legal', '508.1', 'Drop a creature on an opponent (or their planeswalker) to attack, or back on your battlefield to withdraw it') };
  if (first?.kind === 'block' || first?.kind === 'unblock') return { kind: 'none', reason: cite('not-legal', '509.1a', 'Drop a blocker on an attacking creature, or back on your battlefield to clear it') };
  if (first?.kind === 'begin') return { kind: 'none', reason: cite('not-legal', '117.1', plan.source.kind === 'hand' || plan.source.kind === 'command' ? 'Drop the card on your battlefield to play it' : 'Drop it on itself or a target to activate it') };
  return { kind: 'none', reason: cite('no-action', '117.1', 'Nothing happens there') };
}

/** Whether a drag can start at all; the reason otherwise (also used for the "why not" toast on a failed pick-up). */
export function canPickUp(source: DragSource, ctx: DragContext): { ok: true } | { ok: false; reason: IllegalReason } {
  const plan = planDrag(source, ctx);
  if (plan.illegal) return { ok: false, reason: plan.illegal };
  if (!plan.zones.length) return { ok: false, reason: cite('no-action', '117.1', 'Nothing to drop it on right now') };
  return { ok: true };
}
