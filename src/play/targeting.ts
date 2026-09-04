// Pure state machine for turning UI clicks into engine answers: pick an action, collect its targets requirement by
// requirement, choose X, then produce the PlayerAction. Also attack/block declaration helpers. No DOM, no React.
import type { AttackDeclaration, BlockDeclaration, LegalAction, PlayerAction, PlayerId, TargetRef } from '../engine/state.js';

export interface Requirement { spec: string; options: TargetRef[]; optional: boolean; count: number }

export interface TargetingState {
  legal: LegalAction;
  reqs: Requirement[];
  step: number;                 // index of the requirement being filled
  picks: TargetRef[][];         // completed requirements
  current: TargetRef[];         // picks for the current requirement
  x: number | null;             // chosen X (null = not asked yet / not needed)
  maxX: number | null;
}

export type Flow = { kind: 'targeting'; state: TargetingState } | { kind: 'x'; state: TargetingState } | { kind: 'done'; action: PlayerAction };

const sameRef = (a: TargetRef, b: TargetRef) => a.kind === b.kind && a.id === b.id;

function needsX(l: LegalAction): number | null {
  const a = l.action;
  if (a.type === 'cast' && a.x !== undefined) return a.x;
  if (a.type === 'activate' && a.x !== undefined) return a.x;
  return null;
}

function finalize(st: TargetingState): Flow {
  const targets = st.picks;
  const base = st.legal.action;
  const action = { ...base, ...(st.reqs.length ? { targets } : {}), ...(st.x !== null ? { x: st.x } : {}) } as PlayerAction;
  return { kind: 'done', action };
}

function advance(st: TargetingState): Flow {
  const next: TargetingState = { ...st, picks: st.step >= 0 ? [...st.picks, st.current] : st.picks, current: [], step: st.step + 1 };
  if (next.step < next.reqs.length) {
    // requirements with no options at all are skipped (the engine tolerates empty picks for them)
    if (!next.reqs[next.step].options.length) return advance(next);
    return { kind: 'targeting', state: next };
  }
  if (next.maxX !== null && next.x === null) return { kind: 'x', state: next };
  return finalize(next);
}

/** Start executing a legal action. Returns a completed action when nothing needs choosing. */
export function beginAction(legal: LegalAction): Flow {
  const reqs = (legal.targetOptions ?? []).map(r => ({ spec: r.spec, options: r.options, optional: r.optional, count: r.count }));
  const maxX = needsX(legal);
  const st: TargetingState = { legal, reqs, step: -1, picks: [], current: [], x: null, maxX };
  return advance(st);
}

export function currentRequirement(st: TargetingState): Requirement | null { return st.reqs[st.step] ?? null; }

/** Toggle a target for the current requirement; auto-advances when the requirement is complete. */
export function pickTarget(st: TargetingState, ref: TargetRef): Flow {
  const req = currentRequirement(st); if (!req) return { kind: 'targeting', state: st };
  if (!req.options.some(o => sameRef(o, ref))) return { kind: 'targeting', state: st };
  const already = st.current.some(c => sameRef(c, ref));
  const current = already ? st.current.filter(c => !sameRef(c, ref)) : [...st.current, ref];
  const next = { ...st, current };
  if (!already && current.length >= req.count) return advance(next);
  return { kind: 'targeting', state: next };
}

/** Confirm the current requirement with what has been picked so far (fewer than `count`, or none if optional). */
export function confirmRequirement(st: TargetingState): Flow {
  const req = currentRequirement(st); if (!req) return { kind: 'targeting', state: st };
  if (!st.current.length && !req.optional) return { kind: 'targeting', state: st };
  return advance(st);
}

export function setX(st: TargetingState, x: number): Flow {
  const clamped = Math.max(0, Math.min(st.maxX ?? 0, Math.floor(x)));
  return finalize({ ...st, x: clamped });
}

export function canConfirm(st: TargetingState): boolean {
  const req = currentRequirement(st); if (!req) return false;
  return st.current.length > 0 || req.optional;
}

/** Ids that are legal to click right now. */
export function legalTargets(st: TargetingState): { objects: Set<number>; players: Set<PlayerId>; stack: Set<number> } {
  const out = { objects: new Set<number>(), players: new Set<PlayerId>(), stack: new Set<number>() };
  const req = currentRequirement(st); if (!req) return out;
  for (const o of req.options) { if (o.kind === 'object') out.objects.add(o.id); else if (o.kind === 'player') out.players.add(o.id); else out.stack.add(o.id); }
  return out;
}

/** The legal actions that involve a given card id (play it, cast it, activate it). */
export function actionsForCard(legal: LegalAction[], cardId: number): LegalAction[] {
  return legal.filter(l => (l.action.type === 'play-land' && l.action.cardId === cardId) || (l.action.type === 'cast' && l.action.cardId === cardId) || (l.action.type === 'activate' && l.action.objectId === cardId));
}

export function playableCardIds(legal: LegalAction[]): Set<number> {
  const s = new Set<number>();
  for (const l of legal) { if (l.action.type === 'play-land' || l.action.type === 'cast') s.add(l.action.cardId); else if (l.action.type === 'activate') s.add(l.action.objectId); }
  return s;
}

// ---- combat declarations ----------------------------------------------------------------------
export function toggleAttacker(decl: AttackDeclaration, id: number, mustAttack: number[]): AttackDeclaration {
  if (mustAttack.includes(id)) return decl;
  return { attackers: decl.attackers.includes(id) ? decl.attackers.filter(a => a !== id) : [...decl.attackers, id] };
}

/** Assign (or clear, when attacker is null) a blocker. A blocker blocks at most one attacker. */
export function assignBlock(decl: BlockDeclaration, blocker: number, attacker: number | null): BlockDeclaration {
  const rest = decl.blocks.filter(b => b.blocker !== blocker);
  return { blocks: attacker === null ? rest : [...rest, { blocker, attacker }] };
}

export function describeDecision(d: { kind: string; reason?: string; prompt?: string; count?: number; exact?: boolean }): string {
  switch (d.kind) {
    case 'priority': return 'You have priority';
    case 'attackers': return 'Declare attackers';
    case 'blockers': return 'Declare blockers';
    case 'choose-cards': return d.reason ?? `Choose ${d.exact ? 'exactly' : 'up to'} ${d.count ?? 1}`;
    case 'yes-no': return d.prompt ?? 'Yes or no?';
    case 'choose-mode': return 'Choose a mode';
    case 'choose-color': return `Choose a colour${d.reason ? ` for ${d.reason}` : ''}`;
    case 'choose-option': return d.reason ?? 'Choose an option';
    case 'order-blockers': return 'Order blockers';
    default: return d.kind;
  }
}

// ---- drag-and-drop planning (pure additions; see drag.ts) -------------------------------------
export { planDrag, resolveDrop, canPickUp, whyNotPlayable, attackTargetsFor, availableMana, sameZone } from './drag.js';
export type { DragSource, DropZone, DropEffect, IllegalReason, IllegalCode, DragContext, DragMode, DragPlan } from './drag.js';
