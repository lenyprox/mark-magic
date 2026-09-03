// Determinization: turn a redacted state into a fully specified "world" by sampling every hidden card from what the
// owner's list could still contain. Sampling is seeded so a trial can be reproduced from (baseSeed, trial index).
import type { CardDef } from '../cards/types.js';
import { cloneState } from '../engine/clone.js';
import { Rng } from '../engine/game.js';
import { defKey } from '../engine/serialize.js';
import { opponentOf, type GameObject, type GameState, type PlayerId } from '../engine/state.js';
import { HIDDEN_DEF, isHidden } from '../engine/view.js';
import type { ArchetypeProfile, ListEntry, OpponentModel } from './types.js';

/** 32-bit integer mix (splitmix-style) of a base seed and an index; never returns 0 so Rng seeds stay valid. */
export function hashSeed(base: number, i: number): number {
  let h = (Math.imul(base | 0, 0x9E3779B1) ^ Math.imul((i | 0) + 0x7F4A7C15, 0x85EBCA77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h === 0 ? 1 : h;
}

function everyObject(s: GameState, owner: PlayerId): GameObject[] {
  const p = s.players[owner];
  return [...p.battlefield, ...p.hand, ...p.graveyard, ...p.exile, ...p.library, ...s.stack.filter(it => it.source.owner === owner && it.kind === 'spell').map(it => it.source)];
}

/** Names of every card `owner` is known to have, wherever it is (tokens and hidden cards excluded). */
export function seenCounts(s: GameState, owner: PlayerId): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of everyObject(s, owner)) if (!o.token && !isHidden(o)) m.set(o.def.name, (m.get(o.def.name) ?? 0) + 1);
  return m;
}

/** The multiset of names `owner`'s hidden cards can still be: list minus everything already seen. Clamps at zero and warns. */
export function unknownPool(s: GameState, owner: PlayerId, list: ListEntry[], _viewer?: PlayerId): { pool: string[]; warnings: string[] } {
  const seen = seenCounts(s, owner); const pool: string[] = []; const warnings: string[] = [];
  const inList = new Set<string>();
  for (const e of list) { inList.add(e.name); const left = e.count - (seen.get(e.name) ?? 0); if (left < 0) warnings.push(`${owner === 0 ? 'P0' : 'P1'} has ${seen.get(e.name)} × ${e.name} but the list has ${e.count}`); for (let i = 0; i < left; i++) pool.push(e.name); }
  for (const [n, c] of seen) if (!inList.has(n)) warnings.push(`${owner === 0 ? 'P0' : 'P1'} has ${c} × ${n} not in the list`);
  return { pool, warnings };
}

/** Sample a count for a card from its countDist (index = copies; weights need not be normalised). */
function sampleCount(dist: number[], rng: Rng): number {
  const total = dist.reduce((a, b) => a + b, 0); if (total <= 0) return 0;
  let r = rng.next() * total;
  for (let k = 0; k < dist.length; k++) { r -= dist[k]; if (r < 0) return k; }
  return dist.length - 1;
}

/** A concrete list for an archetype: a sample list when available, else a draw from the per-card count distributions; patched to contain every seen card. */
export function sampleArchetypeDeck(profile: ArchetypeProfile, seen: Map<string, number> | Record<string, number>, rng: Rng): ListEntry[] {
  const seenMap = seen instanceof Map ? seen : new Map(Object.entries(seen));
  const counts = new Map<string, number>();
  const main = profile.cards.filter(c => c.board === 'main');
  if (profile.sampleLists?.length) { for (const e of profile.sampleLists[rng.int(profile.sampleLists.length)]) counts.set(e.name, (counts.get(e.name) ?? 0) + e.count); }
  else for (const c of main) { const k = c.countDist.length ? sampleCount(c.countDist, rng) : (rng.next() < c.pIn ? Math.max(1, Math.round(c.expectedCount)) : 0); if (k > 0) counts.set(c.name, k); }
  // every card the opponent has shown must be in the list at least that often
  for (const [n, c] of seenMap) if ((counts.get(n) ?? 0) < c) counts.set(n, c);
  // trim to deck size, removing the least expected cards first (never below what was seen); pad with the most expected ones
  const size = profile.deckSize || 60;
  const expected = new Map(main.map(c => [c.name, c.expectedCount]));
  let total = [...counts.values()].reduce((a, b) => a + b, 0);
  const order = [...counts.keys()].sort((a, b) => (expected.get(a) ?? 0) - (expected.get(b) ?? 0));
  for (const n of order) { while (total > size && (counts.get(n) ?? 0) > (seenMap.get(n) ?? 0)) { counts.set(n, counts.get(n)! - 1); total--; } if (total <= size) break; }
  for (const c of [...main].sort((a, b) => b.expectedCount - a.expectedCount)) { while (total < size && (counts.get(c.name) ?? 0) < Math.max(4, Math.ceil(c.expectedCount))) { counts.set(c.name, (counts.get(c.name) ?? 0) + 1); total++; } if (total >= size) break; }
  return [...counts].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count }));
}

export interface DeterminizeOptions { viewer: PlayerId; myList?: ListEntry[]; opponent: OpponentModel; defs: Map<string, CardDef>; seed: number }
export interface Determinization { state: GameState; seed: number; warnings: string[]; sampled: { id: number; name: string }[]; opponentList: ListEntry[] | null }

/** Def lookup tolerant of `name@printing` keys. */
export function defByName(defs: Map<string, CardDef>): (name: string) => CardDef | undefined {
  const byName = new Map<string, CardDef>();
  for (const d of defs.values()) if (!byName.has(d.name)) byName.set(d.name, d);
  return n => defs.get(n) ?? byName.get(n);
}

/**
 * Assign a sampled def to every hidden slot of `redacted` (viewer's library, opponent's hand, opponent's library, in
 * that fixed order) keeping object ids. Without a list for a side, its pool is the cards that side has shown so far
 * (a crude proxy); slots left over stay hidden and are reported in `warnings`.
 */
export function determinize(redacted: GameState, opts: DeterminizeOptions): Determinization {
  const s = cloneState(redacted); const rng = new Rng(opts.seed); const warnings: string[] = []; const sampled: { id: number; name: string }[] = [];
  const lookup = defByName(opts.defs);
  const me = opts.viewer, opp = opponentOf(me);
  let opponentList: ListEntry[] | null = null;
  if (opts.opponent.kind === 'exact') opponentList = opts.opponent.list;
  else if (opts.opponent.kind === 'archetype') opponentList = sampleArchetypeDeck(opts.opponent.profile, seenCounts(s, opp), rng);
  const poolFor = (owner: PlayerId, list: ListEntry[] | null | undefined): string[] => {
    if (list) { const u = unknownPool(s, owner, list); warnings.push(...u.warnings); return u.pool; }
    const seen = seenCounts(s, owner); const pool: string[] = [];
    for (const [n, c] of seen) for (let i = 0; i < c; i++) pool.push(n);
    if (!pool.length) warnings.push(`no list for ${s.players[owner].name}: hidden cards stay blank`);
    return pool;
  };
  const fill = (owner: PlayerId, slots: GameObject[], list: ListEntry[] | null | undefined, sampleWithReplacement: boolean) => {
    const hidden = slots.filter(isHidden); if (!hidden.length) return;
    const pool = rng.shuffle(poolFor(owner, list));
    if (!pool.length) return;
    hidden.forEach((o, i) => {
      const nm = sampleWithReplacement ? pool[rng.int(pool.length)] : pool[i];
      if (nm === undefined) { warnings.push(`${s.players[owner].name}'s list has too few cards for its hidden zones`); return; }
      const def = lookup(nm);
      if (!def) { warnings.push(`no card definition for ${nm}`); return; }
      o.def = def; sampled.push({ id: o.id, name: nm });
    });
  };
  // fixed order so (seed -> world) is stable regardless of which zones happen to be hidden
  const noList = (owner: PlayerId) => (owner === me ? !opts.myList : !opponentList);
  fill(me, s.players[me].library, opts.myList, noList(me));
  fill(opp, [...s.players[opp].hand, ...s.players[opp].library], opponentList, noList(opp));
  return { state: s, seed: opts.seed, warnings: [...new Set(warnings)], sampled, opponentList };
}

/** Whether any slot of a state is still hidden (a determinization could not fill it). */
export function hiddenCount(s: GameState): number {
  let n = 0;
  for (const p of s.players) for (const z of [p.hand, p.library]) for (const o of z) if (o.def === HIDDEN_DEF || isHidden(o)) n++;
  return n;
}

export { defKey };
