// Cheap state cloning for simulations. `structuredClone` would deep-copy every CardDef AST reachable from every
// object (the dominant cost of the AI's search); this clone shares CardDefs (they are immutable) and copies only
// the mutable game data, recreating Sets/Maps and preserving the aliasing between StackItem.source and zone objects.
import { makeKnowledge, type GameObject, type GameState, type Player, type StackItem } from './state.js';

export function cloneObject(o: GameObject): GameObject {
  // Spread copies every own enumerable property, including the ad-hoc flags the engine bolts on
  // (controlUntilEot, exiledUntilLeaves, deathtouched, wasBlocked, kicked, ...).
  const c = { ...o } as GameObject & Record<string, unknown>;
  c.counters = { ...o.counters };
  c.eotKeywords = [...o.eotKeywords];
  c.eotFlags = { ...o.eotFlags };
  c.blocking = [...o.blocking];
  c.blockedBy = [...o.blockedBy];
  c.activatedThisTurn = new Set(o.activatedThisTurn);
  c.token = o.token ? { ...o.token, colors: [...o.token.colors], types: [...o.token.types], subtypes: [...o.token.subtypes], keywords: [...o.token.keywords] } : null;
  if (o.lastKnown) c.lastKnown = { ...o.lastKnown };
  const ex = (o as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves;
  if (Array.isArray(ex)) (c as { exiledUntilLeaves?: number[] }).exiledUntilLeaves = [...ex];
  if (o.castWith) c.castWith = { ...o.castWith };
  if (o.exiledWith) c.exiledWith = [...o.exiledWith];
  if (o.chosen) c.chosen = { ...o.chosen };
  if (o.castableFromExile) c.castableFromExile = { ...o.castableFromExile };
  if (o.grantedAbilities) c.grantedAbilities = [...o.grantedAbilities];
  return c as GameObject;
}

function clonePlayer(p: Player, cl: (o: GameObject) => GameObject): Player {
  return { ...p, library: p.library.map(cl), hand: p.hand.map(cl), graveyard: p.graveyard.map(cl), exile: p.exile.map(cl), battlefield: p.battlefield.map(cl), manaPool: [...p.manaPool] };
}

function cloneStackItem(it: StackItem, cl: (o: GameObject) => GameObject): StackItem {
  const c = { ...it } as StackItem & Record<string, unknown>;
  c.source = cl(it.source);
  c.targets = [...it.targets];
  c.targetsByEffect = new Map([...it.targetsByEffect].map(([k, v]) => [k, v.map(r => ({ ...r }))]));
  if (it.modes) c.modes = [...it.modes];
  if (it.affected) c.affected = it.affected.map(a => ({ id: a.id, lastKnown: { ...a.lastKnown } }));
  return c as StackItem;
}

/** Deep-copies the mutable parts of a game state while sharing every CardDef. */
export function cloneState(s: GameState): GameState {
  const seen = new Map<number, GameObject>();
  const cl = (o: GameObject): GameObject => { let c = seen.get(o.id); if (!c || c === o) { c = cloneObject(o); seen.set(o.id, c); } return c; };
  const players = s.players.map(p => clonePlayer(p, cl));
  const stack = s.stack.map(it => cloneStackItem(it, cl));
  const out = { ...s, players, stack, log: [], attackers: [...s.attackers], extraTurns: [...s.extraTurns], turnOrder: [...(s.turnOrder ?? s.players.map(p => p.id))], version: s.version ?? 0 } as GameState & Record<string, unknown>;
  if (s.events) out.events = []; if (s.eventCounts) out.eventCounts = { ...s.eventCounts };
  const k = s.knowledge;
  out.knowledge = k ? { knownTop: k.knownTop.map(a => [...a]), knownInHand: [...k.knownInHand], revealed: [...k.revealed] } : makeKnowledge(players.length);
  if (s.delayed) out.delayed = s.delayed.map(d => ({ ...d, affected: d.affected?.map(a => ({ id: a.id, lastKnown: { ...a.lastKnown } })) }));
  return out as GameState;
}
