// Player views of a game state. `redact` replaces every card the viewer cannot know with the HIDDEN_DEF sentinel
// while keeping object ids and zone sizes, so `evaluate`, `legalActions` and `findObject` keep working on the view.
import type { CardDef } from '../cards/types.js';
import { cloneState } from './clone.js';
import { REDACT_HOOKS, REDACT_PLAYER_HOOKS, REDACT_STATE_HOOKS } from './ops/_registry.js';
import type { GameObject, GameState, PlayerId } from './state.js';

export const HIDDEN_DEF_NAME = '__hidden__';

/** A blank card: no types, no cost, no abilities. Anything with this def is a face-down unknown. */
export const HIDDEN_DEF: CardDef = Object.freeze({
  name: HIDDEN_DEF_NAME, oracleId: '', manaCost: null, manaValue: 0, colors: [], colorIdentity: [], types: [], supertypes: [], subtypes: [],
  typeLine: 'Hidden', oracleText: '', power: null, toughness: null, loyalty: null, keywords: [], abilities: [], fullyParsed: true, unparsed: [],
  layout: 'hidden', producesMana: [],
}) as CardDef;

export function isHidden(o: GameObject | CardDef): boolean { const d = 'def' in o ? o.def : o; return d === HIDDEN_DEF || d.name === HIDDEN_DEF_NAME; }

/** Ids whose identity `viewer` may see even though they sit in a hidden zone. */
export function visibleHiddenIds(s: GameState, viewer: PlayerId): Set<number> {
  const k = s.knowledge;
  return new Set([...k.knownTop[viewer], ...k.knownInHand, ...k.revealed]);
}

/** A structural clone where the opponent's unknown hand cards and both libraries' unknown cards carry HIDDEN_DEF. */
export function redact(s: GameState, viewer: PlayerId): GameState {
  const v = cloneState(s);
  const vis = visibleHiddenIds(s, viewer);
  const hide = (o: GameObject) => { if (!vis.has(o.id)) { o.def = HIDDEN_DEF; if (o.copyDef) delete o.copyDef; } };
  for (const p of v.players) { p.library.forEach(hide); if (p.id !== viewer) p.hand.forEach(hide); }
  // other players' private scry knowledge is not ours
  for (const p of v.players) if (p.id !== viewer) v.knowledge.knownTop[p.id] = v.knowledge.knownTop[p.id].filter(id => v.knowledge.revealed.includes(id));
  // family state hidden from this viewer (suspended face-down cards, secret piles, votes, ...): objects, then the
  // per-seat bags, then the game's own bag — every place `ext` state can live
  if (REDACT_HOOKS.length) for (const p of v.players) for (const z of [p.library, p.hand, p.graveyard, p.exile, p.battlefield, p.command ?? []]) for (const o of z) for (const h of REDACT_HOOKS) h(o, viewer);
  if (REDACT_PLAYER_HOOKS.length) for (const p of v.players) for (const h of REDACT_PLAYER_HOOKS) h(p, viewer);
  if (REDACT_STATE_HOOKS.length) for (const h of REDACT_STATE_HOOKS) h(v, viewer);
  return v;
}

export interface ViewInfo {
  viewer: PlayerId;
  hiddenHand: number;                 // opponents' hand cards the viewer cannot identify (all opponents)
  hiddenLibrary: number[];            // per player: library cards the viewer cannot identify
  knownTop: number[];                 // viewer's own known top cards, in order
  knownInHand: number[];              // opponent hand cards whose identity is public
  revealed: number[];
}

/** Counts of what is hidden from `viewer` (works on redacted and raw states alike). */
export function viewInfo(s: GameState, viewer: PlayerId): ViewInfo {
  const vis = visibleHiddenIds(s, viewer);
  const unknown = (zone: GameObject[]) => zone.filter(o => !vis.has(o.id)).length;
  const others = s.players.filter(p => p.id !== viewer);
  return {
    viewer, hiddenHand: others.reduce((a, p) => a + unknown(p.hand), 0), hiddenLibrary: s.players.map(p => unknown(p.library)),
    knownTop: [...s.knowledge.knownTop[viewer]], knownInHand: s.knowledge.knownInHand.filter(id => others.some(p => p.hand.some(o => o.id === id))), revealed: [...s.knowledge.revealed],
  };
}
