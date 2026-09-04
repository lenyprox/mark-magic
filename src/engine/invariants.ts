// State invariants: cheap structural checks a GameState must satisfy between actions. The pool sandbox
// (src/verify/sandbox.ts) runs them after every resolved action so engine bugs surface as a named violation
// instead of a silent wrong board. Pure and node-free: the engine also runs inside a web worker.
import { allPermanents, findObject } from './characteristics.js';
import { alive } from './players.js';
import type { GameObject, GameState } from './state.js';

/** The per-player zone lists, in the order the checks walk them. */
const ZONE_LISTS = ['hand', 'library', 'graveyard', 'exile', 'battlefield', 'command'] as const;
type ZoneList = (typeof ZONE_LISTS)[number];

/** Every object currently in one of a player's zone lists, with the list it was found in. */
function* everyObject(s: GameState): Generator<{ o: GameObject; list: ZoneList; owner: string }> {
  for (const p of s.players) for (const list of ZONE_LISTS) for (const o of p[list]) yield { o, list, owner: p.name };
}

/**
 * Check a state against the structural invariants; returns the first violation as a human-readable string, or null.
 * The first six checks are the ones the pool sandbox has always run (kept verbatim so their wording does not move);
 * the rest were added in Phase 8e.
 */
export function assertInvariants(s: GameState): string | null {
  const ids = new Set<number>();
  for (const p of s.players) for (const z of [p.hand, p.library, p.graveyard, p.exile, p.battlefield, p.command]) for (const o of z) { if (ids.has(o.id)) return `object ${o.id} in two zones`; ids.add(o.id); }
  for (const p of s.players) for (const o of p.battlefield) if (o.zone !== 'battlefield') return `${o.def.name} on battlefield list with zone ${o.zone}`;
  for (const p of s.players) for (const o of p.hand) if (o.zone !== 'hand') return `${o.def.name} in hand list with zone ${o.zone}`;
  for (const o of allPermanents(s)) { if (o.attachedTo != null && !findObject(s, o.attachedTo)) return `${o.def.name} attached to a missing object`; for (const [k, v] of Object.entries(o.counters)) if (v < 0) return `${o.def.name} has ${v} ${k} counters`; }
  for (const p of s.players) if (!Number.isFinite(p.life)) return `${p.name} life is ${p.life}`;
  for (const it of s.stack) if (!it.source) return 'stack item without a source';

  // --- added in Phase 8e -------------------------------------------------------------------------------------
  // the zone field agrees with the list the object sits in (graveyard / exile / library / command too)
  for (const { o, list, owner } of everyObject(s)) if (o.zone !== list) return `${o.def.name} in ${owner}'s ${list} list with zone ${o.zone}`;
  // ids are unique across the zones *and* the stack; a spell on the stack is in no zone list
  const stackIds = new Set<number>();
  for (const it of s.stack) { if (stackIds.has(it.id)) return `stack item ${it.id} (${it.name}) is on the stack twice`; stackIds.add(it.id); }
  for (const it of s.stack) if (it.source.zone === 'stack' && ids.has(it.source.id)) return `${it.source.def.name} is on the stack and in a zone list`;
  // attachments live on the battlefield and so do their hosts (CR 303.4f / 301.5c)
  for (const { o, owner } of everyObject(s)) {
    if (o.attachedTo == null) continue;
    if (o.zone !== 'battlefield') return `${o.def.name} in ${owner}'s ${o.zone} is still attached to ${o.attachedTo}`;
    const host = findObject(s, o.attachedTo);
    if (!host) return `${o.def.name} attached to a missing object`;
    if (host.zone !== 'battlefield') return `${o.def.name} attached to ${host.def.name} in ${host.zone}`;
  }
  // blocking / blockedBy name each other, and only battlefield creatures
  const onBattlefield = new Map<number, GameObject>();
  for (const p of s.players) for (const o of p.battlefield) onBattlefield.set(o.id, o);
  for (const o of onBattlefield.values()) {
    for (const aid of o.blocking) {
      const a = onBattlefield.get(aid);
      if (!a) return `${o.def.name} blocks ${aid}, which is not on the battlefield`;
      if (!a.blockedBy.includes(o.id)) return `${o.def.name} blocks ${a.def.name} but is missing from its blockedBy`;
    }
    for (const bid of o.blockedBy) {
      const b = onBattlefield.get(bid);
      if (!b) return `${o.def.name} is blocked by ${bid}, which is not on the battlefield`;
      if (!b.blocking.includes(o.id)) return `${b.def.name} is in ${o.def.name}'s blockedBy but does not block it`;
    }
  }
  // only permanents are tapped (moveTo untaps; a leftover flag means a zone change skipped it)
  for (const { o, list, owner } of everyObject(s)) if (o.tapped && list !== 'battlefield') return `${o.def.name} is tapped in ${owner}'s ${list}`;
  // tokens cease to exist as a state-based action (CR 704.5d); only meaningful once the stack has drained
  if (!s.stack.length) for (const { o, list, owner } of everyObject(s)) if (o.token && list !== 'battlefield') return `token ${o.def.name} is still in ${owner}'s ${list}`;
  // the seats the engine is about to ask are still in the game; a finished game (a winner, or a draw with everyone
  // decked out at once) holds no priority, so only an ongoing game is checked
  const live = alive(s);
  if (s.winner === null && live.length > 1) {
    if (!live.includes(s.activePlayer)) return `active player ${s.players[s.activePlayer]?.name ?? s.activePlayer} is out of the game`;
    if (!live.includes(s.priority)) return `priority is with ${s.players[s.priority]?.name ?? s.priority}, who is out of the game`;
  }
  return null;
}
