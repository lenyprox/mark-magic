// The candidate space: the owned pool inside the commander's colour identity, the seed list, and single-card
// neighbours (out ~ softmin of the card's contribution, in ~ a pool card of a similar role). Explicit library order
// is kept so a swap only touches one slot of the shuffle permutation (the evaluator reuses unaffected games).
import { classify } from '../analysis/classify.js';
import type { InteractionClass, ListEntry } from '../analysis/types.js';
import { hashSeed } from '../analysis/determinize.js';
import type { CardDB } from '../cards/db.js';
import type { CardQueryDB } from '../cards/query.js';
import type { CardDef, Color } from '../cards/types.js';
import { colorIdentityOf } from '../decks/validate.js';
import { Rng } from '../engine/game.js';
import type { Candidate, OptimizerConstraints, OptimizerSpec } from './types.js';

export type Role = 'land' | 'ramp' | 'draw' | 'removal' | 'sweeper' | 'counter' | 'creature' | 'threat' | 'other';

export interface PoolCard { name: string; oracleId: string; def: CardDef; owned: number; role: Role; mv: number; identity: Color[]; fullyParsed: boolean; bulk: boolean }

export function roleOf(def: CardDef): Role {
  const cls = classify(def) as InteractionClass[];
  if (def.types.includes('Land')) return 'land';
  if (cls.includes('ramp')) return 'ramp';
  if (cls.includes('sweeper')) return 'sweeper';
  if (cls.includes('counterspell')) return 'counter';
  if (cls.includes('removal') || cls.includes('burn') || cls.includes('bounce') || cls.includes('discard')) return 'removal';
  if (cls.includes('card-draw')) return 'draw';
  if (def.types.includes('Creature')) return def.manaValue >= 5 ? 'threat' : 'creature';
  if (def.types.includes('Planeswalker')) return 'threat';
  return 'other';
}

function inIdentity(def: CardDef, identity: Set<Color>): boolean { return (def.colorIdentity ?? def.colors).every(c => identity.has(c)); }
/** Format legality lives in the query layer (card_index); owned cards are taken as legal, bulk candidates are filtered by the query. */
function commanderLegal(_def: CardDef): boolean { return true; }

export interface PoolOptions { commander: CardDef | null; owned: Map<string, number>; constraints: OptimizerConstraints; format: OptimizerSpec['format']; bulk?: { query: CardQueryDB; max: number } }

/** Owned cards the deck may use: inside the colour identity, commander-legal, not banned; plus popular unowned cards when asked. */
export function buildPool(cards: CardDB, opts: PoolOptions): PoolCard[] {
  const identity = new Set<Color>(opts.commander ? colorIdentityOf([opts.commander]) : (['W', 'U', 'B', 'R', 'G'] as Color[]));
  const banned = new Set(opts.constraints.ban);
  const out: PoolCard[] = []; const seen = new Set<string>();
  for (const [oracleId, count] of opts.owned) {
    if (count <= 0) continue;
    const def = cards.getByOracleId(oracleId); if (!def) continue;
    if (banned.has(def.name) || seen.has(def.name)) continue;
    if (opts.format === 'commander' && (!inIdentity(def, identity) || !commanderLegal(def))) continue;
    if (opts.commander && def.name === opts.commander.name) continue;
    if (opts.constraints.onlyFullyParsedSwapIns && !def.fullyParsed) continue;
    seen.add(def.name);
    out.push({ name: def.name, oracleId, def, owned: count, role: roleOf(def), mv: def.manaValue, identity: def.colorIdentity ?? def.colors, fullyParsed: def.fullyParsed, bulk: false });
  }
  if (opts.bulk && opts.bulk.max > 0) {
    const colors = [...identity];
    const page = opts.bulk.query.search({ colors: colors.length ? colors : undefined, colorMode: colors.length ? 'identity' : undefined, colorless: colors.length ? undefined : true, format: opts.format === 'commander' ? 'commander' : undefined, sort: 'edhrec', dir: 'asc', pageSize: Math.min(500, opts.bulk.max * 3), playable: true });
    let added = 0;
    for (const c of page.items) {
      if (added >= opts.bulk.max) break;
      if (seen.has(c.name) || banned.has(c.name)) continue;
      const def = cards.getByOracleId(c.oracleId); if (!def) continue;
      if (def.types.includes('Land') && def.supertypes.includes('Basic')) continue;
      if (opts.constraints.onlyFullyParsedSwapIns && !def.fullyParsed) continue;
      if (opts.commander && def.name === opts.commander.name) continue;
      seen.add(def.name); added++;
      out.push({ name: def.name, oracleId: c.oracleId, def, owned: 0, role: roleOf(def), mv: def.manaValue, identity: def.colorIdentity ?? def.colors, fullyParsed: def.fullyParsed, bulk: true });
    }
  }
  return out;
}

export function listHash(list: ListEntry[]): string {
  const parts = list.map(e => `${e.name}x${e.count}`).sort();
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Explicit library order for a list: sorted by name, one entry per copy (the canonical order the batch runner uses). */
export function orderOf(list: ListEntry[]): string[] {
  const out: string[] = [];
  for (const e of [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) for (let i = 0; i < e.count; i++) out.push(e.name);
  return out;
}

export function seedCandidate(list: ListEntry[], iteration = 0): Candidate {
  return { id: 'seed', list, listHash: listHash(list), parentId: null, swapOut: null, swapIn: null, order: orderOf(list), block: 0, iteration, status: 'seed', games: 0, wins: 0, draws: 0, bulk: false };
}

/** The candidate that replaces one copy of `out` with `in`, keeping every other card's slot. */
export function swapCandidate(parent: Candidate, out: string, inName: string, bulk: boolean, iteration: number, block: number): Candidate {
  const list: ListEntry[] = [];
  let removed = false;
  for (const e of parent.list) {
    if (!removed && e.name === out) { removed = true; if (e.count > 1) list.push({ name: e.name, count: e.count - 1 }); continue; }
    list.push({ ...e });
  }
  const existing = list.find(e => e.name === inName);
  if (existing) existing.count++; else list.push({ name: inName, count: 1 });
  const order = [...parent.order]; const idx = order.indexOf(out); if (idx >= 0) order[idx] = inName; else order.push(inName);
  const id = `${iteration}-${listHash(list)}`;
  return { id, list, listHash: listHash(list), parentId: parent.id, swapOut: out, swapIn: inName, order, block, iteration, status: 'pending', games: 0, wins: 0, draws: 0, bulk };
}

function softmin(weights: number[], rng: Rng, temperature = 0.08): number {
  const min = Math.min(...weights); const w = weights.map(x => Math.exp(-(x - min) / temperature)); const total = w.reduce((a, b) => a + b, 0);
  let r = rng.next() * total; for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return w.length - 1;
}

export interface NeighbourOptions { count: number; contributions: Map<string, number>; landTarget: number | null; tried: Set<string>; rng: Rng; pool: PoolCard[]; constraints: OptimizerConstraints; lookup: (name: string) => CardDef | undefined }

/** Propose `count` single swaps of the incumbent: weak cards out (softmin of contribution), same-role pool cards in. */
export function neighbours(incumbent: Candidate, iteration: number, block: number, o: NeighbourOptions): Candidate[] {
  const locked = new Set(o.constraints.lockIn);
  const inList = new Set(incumbent.list.map(e => e.name));
  const lands = incumbent.list.filter(e => o.lookup(e.name)?.types.includes('Land')).reduce((a, e) => a + e.count, 0);
  const landTarget = o.landTarget ?? lands;
  const outs = incumbent.list.filter(e => !locked.has(e.name)).filter(e => { const d = o.lookup(e.name); if (!d) return false; const basic = d.supertypes.includes('Basic'); return !basic || lands > landTarget; });
  if (!outs.length) return [];
  const byName = new Map(o.pool.map(p => [p.name, p]));
  const out: Candidate[] = []; const seenIds = new Set<string>();
  let guard = 0;
  while (out.length < o.count && guard++ < o.count * 20) {
    const oi = softmin(outs.map(e => o.contributions.get(e.name) ?? 0), o.rng);
    const outName = outs[oi].name; const outDef = o.lookup(outName)!;
    const outRole = roleOf(outDef);
    // candidate ins: same role first (70%), else anything; never a card already in the list (singleton) unless basic land
    const sameRole = o.pool.filter(p => !inList.has(p.name) && p.role === outRole);
    const anyRole = o.pool.filter(p => !inList.has(p.name) && p.role !== 'land');
    let src = sameRole.length && o.rng.next() < 0.7 ? sameRole : anyRole;
    if (outDef.types.includes('Land') && lands <= landTarget) src = o.pool.filter(p => p.role === 'land' && !inList.has(p.name));
    if (!src.length) continue;
    const pick = src[o.rng.int(src.length)];
    const key = `${outName}→${pick.name}`;
    if (o.tried.has(key)) continue;
    const cand = swapCandidate(incumbent, outName, pick.name, pick.bulk, iteration, block);
    if (seenIds.has(cand.id)) continue;
    seenIds.add(cand.id); o.tried.add(key);
    out.push(cand);
    void byName;
  }
  return out;
}

/** Deterministic rng for iteration i of a run. */
export function iterationRng(seed: number, iteration: number): Rng { return new Rng(hashSeed(seed ^ 0x5bd1e995, iteration)); }
