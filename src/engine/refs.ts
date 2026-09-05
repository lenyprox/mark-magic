// Reference resolution for the composition core (Phase 9.0, docs/vocabulary/composition.md): what "it", "that
// creature", "those cards", "the sacrificed creature", "target player" and "each opponent" mean while an item resolves.
//
// A resolving item carries one BINDING FRAME: `item.affected` (the objects the last effect touched, or what a
// `for-each` iteration / a delayed trigger bound), `item.targetsByEffect` (chosen targets), `item.triggeringId` /
// `item.triggeringPlayer` (what the trigger was about), `item.sacrificed` (cost payments) and `item.actor` (who
// "you" is inside a `scoped` block). Every composition op and the `prop` amount resolve through here, so a script
// author gets one set of rules for every Ref:
//
//   self         the source of the ability, wherever it now is
//   that         the first bound object; those = all of them (a `for-each` iteration binds exactly one)
//   triggering   the object that caused the trigger (the spell cast, the creature that died, ...)
//   target:<i>   the i-th target of the item in printed order, counting every target group (`multi` parts included)
//   enchanted    the permanent the source is attached to (equipped is the same lookup for Equipment)
//   sacrificed   the objects sacrificed to pay this item's cost (sacrifice ~ counts as the source itself)
//   exiled-with  the cards exiled with the source (imprint, delve, "exile until ~ leaves")
//
// CR 400.7: an object that changed zones is a new object. A binding records the zone the object was bound in
// (`affected[].lastKnown.zone`); `resolveRef` returns the object wherever it is now and hands the caller
// `boundZoneOf(item, o)` so each op decides (documented per op) whether the binding survived the move — a `move` of
// "that creature" after the same ability exiled it must find it in exile (CR 610.3), while `set-pt` on a creature that
// has since died must do nothing.
//
// Players: `resolveWho` answers the `ScopeWho` vocabulary. 'each-player' / 'each-opponent' are APNAP-ordered starting
// with the active player (CR 101.4, 608.2f); 'that-player' is the player the trigger was about, else the controller
// of 'that', else the first player target (the same fallbacks the older `draw`/`mill`/`poison` ops use).
//
// This module and characteristics.ts import each other (findObject here, resolveRef there for the `prop` amount);
// nothing is read at module scope, so the cycle is harmless under ESM.
import type { Ref, ScopeWho, ObjectSet } from '../cards/types.js';
import type { GameObject, GameState, PlayerId, StackItem, TargetRef, Zone } from './state.js';
import { findObject, matchesFilter, battlefieldOf } from './characteristics.js';
import { alive, apnapOrder } from './players.js';

const REF_NAMES: ReadonlySet<string> = new Set(['self', 'that', 'those', 'triggering', 'enchanted', 'equipped', 'sacrificed', 'exiled-with']);
/** Is this target word a Ref (as opposed to a group word such as 'all-creatures')? */
export function isRef(t: string): t is Ref { return REF_NAMES.has(t) || t.startsWith('target:'); }

/** Everything resolution needs: the state, the resolving item and who currently acts as "you". */
export interface RefCtx { s: GameState; item: StackItem; p: PlayerId; src: GameObject }

/** Every target of the item, flattened in effect order (nested container targets sit between their neighbours). */
export function itemTargets(item: StackItem): TargetRef[] {
  const keys = [...item.targetsByEffect.keys()].sort((a, b) => a - b);
  const out: TargetRef[] = [];
  for (const k of keys) out.push(...item.targetsByEffect.get(k)!);
  return out;
}

const objectsOf = (s: GameState, refs: TargetRef[]): GameObject[] => {
  const out: GameObject[] = [];
  for (const r of refs) if (r.kind === 'object') { const o = findObject(s, r.id); if (o) out.push(o); }
  return out;
};

/** The zone `o` was in when the item bound it, or undefined when it was never bound (or bound before zones were recorded). */
export function boundZoneOf(item: StackItem, o: GameObject): Zone | undefined {
  const a = item.affected?.find(x => x.id === o.id);
  return a?.lastKnown.zone;
}

/** The objects a Ref denotes right now (empty when nothing is bound or the objects have ceased to exist). */
export function resolveRef(ctx: RefCtx, ref: Ref): GameObject[] {
  const { s, item, src } = ctx;
  switch (ref) {
    case 'self': return [src];
    case 'that': { const a = item.affected?.[0]; const o = a ? findObject(s, a.id) : undefined; return o ? [o] : []; }
    case 'those': { const out: GameObject[] = []; for (const a of item.affected ?? []) { const o = findObject(s, a.id); if (o) out.push(o); } return out; }
    case 'triggering': { const o = item.triggeringId !== undefined ? findObject(s, item.triggeringId) : undefined; return o ? [o] : []; }
    case 'enchanted': case 'equipped': { const host = src.attachedTo !== null && src.attachedTo !== undefined ? findObject(s, src.attachedTo) : undefined; return host && host.zone === 'battlefield' ? [host] : []; }
    case 'sacrificed': return objectsOf(s, (item.sacrificed ?? []).map(id => ({ kind: 'object' as const, id })));
    case 'exiled-with': return objectsOf(s, (src.exiledWith ?? []).map(id => ({ kind: 'object' as const, id })));
    default: {
      if (ref.startsWith('target:')) { const i = Number(ref.slice(7)); const r = itemTargets(item)[i]; return r && r.kind === 'object' ? objectsOf(s, [r]) : []; }
      return [];
    }
  }
}

/** The player a Ref denotes when it names a player target ('target:<i>' on a player), else undefined. */
export function refPlayer(ctx: RefCtx, ref: string): PlayerId | undefined {
  if (!ref.startsWith('target:')) return undefined;
  const r = itemTargets(ctx.item)[Number(ref.slice(7))];
  return r && r.kind === 'player' ? r.id : undefined;
}

/** The first player among the item's targets (every group, in order), or undefined. */
export function firstTargetPlayer(item: StackItem, T?: TargetRef[]): PlayerId | undefined {
  for (const r of T ?? []) if (r.kind === 'player') return r.id;
  for (const r of itemTargets(item)) if (r.kind === 'player') return r.id;
  return undefined;
}

/** "That player": the player the trigger was about, else the controller of 'that', else the first player target. */
export function thatPlayer(ctx: RefCtx, T?: TargetRef[]): PlayerId | undefined {
  const { item } = ctx;
  if (item.triggeringPlayer !== undefined) return item.triggeringPlayer;
  const a = item.affected?.[0];
  if (a) return a.lastKnown.controller;
  return firstTargetPlayer(item, T);
}

/** The single player a `who` word names right now, or undefined when nothing is bound (each-* words answer their first player). */
export function resolveOnePlayer(ctx: RefCtx, who: ScopeWho | 'owner' | `target:${number}`, T?: TargetRef[]): PlayerId | undefined {
  switch (who) {
    case 'you': return ctx.p;
    case 'target-player': return firstTargetPlayer(ctx.item, T);
    case 'that-player': return thatPlayer(ctx, T);
    case 'controller-of-that': { const a = ctx.item.affected?.[0]; if (!a) return undefined; const o = findObject(ctx.s, a.id); return o && o.zone === 'battlefield' ? o.controller : a.lastKnown.controller; }
    case 'each-player': case 'each-opponent': return resolveWho(ctx, who, T)[0];
    case 'owner': return undefined;
    default: return refPlayer(ctx, who);
  }
}

/** Every player a `who` word names, APNAP-ordered for the each-* words (CR 101.4); eliminated players are skipped. */
export function resolveWho(ctx: RefCtx, who: ScopeWho, T?: TargetRef[]): PlayerId[] {
  const { s, p } = ctx;
  switch (who) {
    case 'you': return [p];
    case 'each-player': return apnapOrder(s).filter(q => !s.players[q].lost);
    case 'each-opponent': return apnapOrder(s).filter(q => q !== p && !s.players[q].lost);
    default: { const w = resolveOnePlayer(ctx, who, T); return w !== undefined && alive(s).includes(w) ? [w] : []; }
  }
}

/** The objects an ObjectSet describes: `filter` over `zone` (default battlefield) of `who` (default every player), in APNAP player order. */
export function objectsIn(ctx: RefCtx, set: ObjectSet, T?: TargetRef[]): GameObject[] {
  const { s, src } = ctx;
  const zone = set.zone ?? 'battlefield';
  const players = set.who ? resolveWho(ctx, set.who, T) : apnapOrder(s).filter(q => !s.players[q].lost);
  const out: GameObject[] = [];
  for (const q of players) {
    const list = zone === 'battlefield' ? battlefieldOf(s, q) : s.players[q][zone];
    for (const o of list) if (matchesFilter(s, o, set, src)) out.push(o);
  }
  return out;
}
