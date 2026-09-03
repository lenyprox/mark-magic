// Player views of a game state. `redact` replaces every card the viewer cannot know with the HIDDEN_DEF sentinel
// while keeping object ids and zone sizes, so `evaluate`, `legalActions` and `findObject` keep working on the view.
import type { CardDef } from '../cards/types.js';
import { cloneState } from './clone.js';
import { opponentOf, type GameObject, type GameState, type PlayerId } from './state.js';

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
  const hide = (o: GameObject) => { if (!vis.has(o.id)) o.def = HIDDEN_DEF; };
  for (const p of v.players) { p.library.forEach(hide); if (p.id !== viewer) p.hand.forEach(hide); }
  // the opponent's private scry knowledge is not ours
  v.knowledge.knownTop[opponentOf(viewer)] = v.knowledge.knownTop[opponentOf(viewer)].filter(id => v.knowledge.revealed.includes(id));
  return v;
}

export interface ViewInfo {
  viewer: PlayerId;
  hiddenHand: number;                 // opponent hand cards the viewer cannot identify
  hiddenLibrary: [number, number];    // per player: library cards the viewer cannot identify
  knownTop: number[];                 // viewer's own known top cards, in order
  knownInHand: number[];              // opponent hand cards whose identity is public
  revealed: number[];
}

/** Counts of what is hidden from `viewer` (works on redacted and raw states alike). */
export function viewInfo(s: GameState, viewer: PlayerId): ViewInfo {
  const vis = visibleHiddenIds(s, viewer); const opp = opponentOf(viewer);
  const unknown = (zone: GameObject[]) => zone.filter(o => !vis.has(o.id)).length;
  return {
    viewer, hiddenHand: unknown(s.players[opp].hand), hiddenLibrary: [unknown(s.players[0].library), unknown(s.players[1].library)],
    knownTop: [...s.knowledge.knownTop[viewer]], knownInHand: s.knowledge.knownInHand.filter(id => s.players[opp].hand.some(o => o.id === id)), revealed: [...s.knowledge.revealed],
  };
}
