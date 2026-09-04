// JSON-safe (de)serialisation of GameState for crossing worker/process boundaries and for saving snapshots.
// CardDefs are not embedded: objects carry a `defKey` and are re-linked from a def table on the other side.
import type { CardDef } from '../cards/types.js';
import { makeKnowledge, type GameObject, type GameState, type Player, type StackItem, type TargetRef } from './state.js';
import { HIDDEN_DEF, HIDDEN_DEF_NAME } from './view.js';

export { HIDDEN_DEF_NAME };

export function defKey(def: CardDef): string { return def.printingId ? `${def.name}@${def.printingId}` : def.name; }

export type SerializedObject = Omit<GameObject, 'def' | 'activatedThisTurn' | 'triggeredThisTurn'> & { defKey: string; activatedThisTurn: number[]; triggeredThisTurn?: string[] } & Record<string, unknown>;
export type SerializedStackItem = Omit<StackItem, 'source' | 'targetsByEffect'> & { source: SerializedObject; targetsByEffect: [number, TargetRef[]][] } & Record<string, unknown>;
export type SerializedPlayer = Omit<Player, 'library' | 'hand' | 'graveyard' | 'exile' | 'battlefield' | 'command'> & { library: SerializedObject[]; hand: SerializedObject[]; graveyard: SerializedObject[]; exile: SerializedObject[]; battlefield: SerializedObject[]; command?: SerializedObject[] };
export type SerializedState = Omit<GameState, 'players' | 'stack' | 'version'> & { version: 1; stateVersion?: number; players: SerializedPlayer[]; stack: SerializedStackItem[] } & Record<string, unknown>;

function serObject(o: GameObject): SerializedObject {
  const { def, activatedThisTurn, triggeredThisTurn, ...rest } = o as GameObject & Record<string, unknown>;
  return { ...(rest as Omit<GameObject, 'def' | 'activatedThisTurn' | 'triggeredThisTurn'>), defKey: defKey(def), activatedThisTurn: [...activatedThisTurn], ...(triggeredThisTurn ? { triggeredThisTurn: [...triggeredThisTurn] } : {}) };
}

export function serializeState(s: GameState): SerializedState {
  const players = s.players.map(p => ({ ...p, library: p.library.map(serObject), hand: p.hand.map(serObject), graveyard: p.graveyard.map(serObject), exile: p.exile.map(serObject), battlefield: p.battlefield.map(serObject), command: (p.command ?? []).map(serObject) }));
  const stack = s.stack.map(it => { const { source, targetsByEffect, ability, ...rest } = it as StackItem & Record<string, unknown>; void ability; return { ...(rest as Omit<StackItem, 'source' | 'targetsByEffect'>), source: serObject(source), targetsByEffect: [...targetsByEffect] } as SerializedStackItem; });
  const { players: _p, stack: _s, version: stateVersion, events: _e, ...rest } = s as GameState & Record<string, unknown>; void _p; void _s; void _e;
  return { ...(rest as Omit<GameState, 'players' | 'stack' | 'version'>), version: 1, stateVersion: stateVersion as number, players, stack, log: [...s.log] };
}

function deObject(o: SerializedObject, defs: Map<string, CardDef>): GameObject {
  const { defKey: key, activatedThisTurn, triggeredThisTurn, ...rest } = o;
  const def = defs.get(key) ?? (key === HIDDEN_DEF_NAME ? defs.get(HIDDEN_DEF_NAME) : undefined);
  if (!def) throw new Error(`deserializeState: unknown card def "${key}"`);
  return { ...(rest as Omit<GameObject, 'def' | 'activatedThisTurn' | 'triggeredThisTurn'>), def, activatedThisTurn: new Set(activatedThisTurn), ...(triggeredThisTurn ? { triggeredThisTurn: new Set(triggeredThisTurn) } : {}) } as GameObject;
}

export function deserializeState(ser: SerializedState, defs: Map<string, CardDef>): GameState {
  const byId = new Map<number, GameObject>();
  const de = (o: SerializedObject) => { const g = deObject(o, defs); byId.set(g.id, g); return g; };
  const players = ser.players.map(p => ({ ...p, library: p.library.map(de), hand: p.hand.map(de), graveyard: p.graveyard.map(de), exile: p.exile.map(de), battlefield: p.battlefield.map(de), command: (p.command ?? []).map(de), commanders: p.commanders ?? [], commanderCasts: p.commanderCasts ?? {}, commanderDamage: p.commanderDamage ?? {} })) as Player[];
  const stack = ser.stack.map(it => {
    const { source, targetsByEffect, ...rest } = it;
    // abilities/triggers point at a permanent that still exists in a zone: re-link to that instance; spells are only on the stack
    const src = byId.get(source.id) ?? de(source);
    const item = { ...(rest as Omit<StackItem, 'source' | 'targetsByEffect'>), source: src, targetsByEffect: new Map(targetsByEffect) } as StackItem;
    if (item.abilityIndex !== undefined) { const ab = src.def.abilities[item.abilityIndex]; if (ab) item.ability = ab; }
    return item;
  });
  const { players: _p, stack: _s, version, stateVersion, ...rest } = ser; void _p; void _s; void version;
  const out = { ...(rest as Omit<GameState, 'players' | 'stack' | 'version'>), players, stack, version: stateVersion ?? 0 } as GameState;
  if (!out.knowledge) out.knowledge = makeKnowledge(players.length);
  if (!out.turnOrder) out.turnOrder = players.map(p => p.id);
  return out;
}

/** Every distinct CardDef reachable from a state, keyed by defKey (the hidden sentinel is always included). */
export function collectDefs(s: GameState): Map<string, CardDef> {
  const m = new Map<string, CardDef>([[HIDDEN_DEF_NAME, HIDDEN_DEF]]);
  const add = (o: GameObject) => { const k = defKey(o.def); if (!m.has(k)) m.set(k, o.def); };
  for (const p of s.players) for (const z of [p.library, p.hand, p.graveyard, p.exile, p.battlefield, p.command ?? []]) z.forEach(add);
  for (const it of s.stack) add(it.source);
  return m;
}

/** Build a def table from a list of defs (e.g. a DeckPayload); the hidden sentinel is always included. */
export function defTable(defs: Iterable<CardDef>): Map<string, CardDef> {
  const m = new Map<string, CardDef>([[HIDDEN_DEF_NAME, HIDDEN_DEF]]);
  for (const d of defs) m.set(defKey(d), d);
  return m;
}
