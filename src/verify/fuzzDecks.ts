// Seeded deck generation for the game fuzzer (Phase 8f). Deck s of game i is a pure function of
// (baseSeed, i, s): the same flags always build the same table, so a failure found on one machine replays on
// another and a shrink run can rebuild the exact deck it is reducing.
//
// The pool is indexed once per process (a full parse of the paper tier costs ~6 s), bucketed by colour identity,
// so a deck is sampled by picking a colour identity first and then drawing from the cards that fit inside it —
// mono or two colours, which is what makes the games actually cast spells instead of stalling on colour screw.
// Spells and *nonbasic* lands are indexed separately and drawn into their own slots: only the basics are fixed, so
// mana abilities, ETB-tapped lands, sacrifice lands, creature-lands and MDFC backs are inside the fuzzer's reach.
import type { CardDB } from '../cards/db.js';
import type { PoolTier } from '../cards/tiers.js';
import type { CardDef, Color } from '../cards/types.js';
import { Rng } from '../engine/game.js';
import { defKey } from '../engine/serialize.js';

export type FuzzFormat = 'freeform' | 'commander';
/** 'parsed': only cards the parser understood completely; 'all' also draws the partially parsed ones (unsimulated text). */
export type FuzzPool = 'parsed' | 'all';

/** The five colours in WUBRG order; a colour identity is a bitmask over these indexes. */
export const WUBRG: Color[] = ['W', 'U', 'B', 'R', 'G'];
const BASIC_OF: Record<string, string> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

/** One pool card, flattened to what deck building needs (the CardDef itself is re-fetched from the DB cache). */
export interface PoolEntry { name: string; oracleId: string; mask: number; parsed: boolean }

/** Which slice of the pool a draw comes from. */
export type PoolKind = 'spell' | 'land' | 'legend';

/** The pool, bucketed by colour-identity mask so `candidates` can concatenate the buckets that fit a deck. */
export interface PoolIndex {
  tier: PoolTier;
  /** Nonland cards by colour-identity mask (index 0 = colourless). */
  byMask: PoolEntry[][];
  /** Nonbasic lands by colour-identity mask: mana abilities, ETB-tapped, sac lands, creature-lands, MDFC backs. */
  landsByMask: PoolEntry[][];
  /** Legendary creatures with at least one colour, by colour-identity mask: the commander candidates. */
  legendsByMask: PoolEntry[][];
  cards: number;
  lands: number;
}

export const maskOf = (ci: Color[]): number => ci.reduce((m, c) => m | (1 << WUBRG.indexOf(c)), 0);
export const colorsOf = (mask: number): Color[] => WUBRG.filter((_, i) => mask & (1 << i));

const indexes = new Map<PoolTier, PoolIndex>();

/**
 * Build (once per process and tier) the fuzzer's card index. `CardDB.all` yields in database order, so the index —
 * and therefore every deck drawn from it — is the same in every worker and on every run.
 */
export function poolIndex(cards: CardDB, tier: PoolTier = 'paper'): PoolIndex {
  const hit = indexes.get(tier); if (hit) return hit;
  const idx: PoolIndex = { tier, byMask: Array.from({ length: 32 }, () => []), landsByMask: Array.from({ length: 32 }, () => []), legendsByMask: Array.from({ length: 32 }, () => []), cards: 0, lands: 0 };
  for (const def of cards.all({ tier })) {
    const mask = maskOf(def.colorIdentity);
    const e: PoolEntry = { name: def.name, oracleId: def.oracleId, mask, parsed: def.fullyParsed };
    if (def.types.includes('Land')) {
      // basics are the deck's mana base and come from `basicsFor`; every *nonbasic* land is a first-class fuzz
      // target (mana abilities, ETB-tapped, sacrifice lands, creature-lands, MDFC backs)
      if (def.supertypes.includes('Basic')) continue;
      idx.landsByMask[mask].push(e); idx.lands++;
      continue;
    }
    idx.byMask[mask].push(e); idx.cards++;
    if (mask && def.supertypes.includes('Legendary') && def.types.includes('Creature')) idx.legendsByMask[mask].push(e);
  }
  indexes.set(tier, idx);
  return idx;
}

const candidateCache = new Map<string, PoolEntry[]>();

/** Every pool card of `kind` whose colour identity fits inside `mask` (submasks only — CR 903.4 for the commander case). */
export function candidates(idx: PoolIndex, mask: number, pool: FuzzPool, kind: PoolKind = 'spell'): PoolEntry[] {
  const key = `${idx.tier}:${kind}:${mask}:${pool}`;
  const hit = candidateCache.get(key); if (hit) return hit;
  const src = kind === 'legend' ? idx.legendsByMask : kind === 'land' ? idx.landsByMask : idx.byMask;
  const out: PoolEntry[] = [];
  for (let m = 0; m < 32; m++) if ((m & ~mask) === 0) for (const e of src[m]) if (pool === 'all' || e.parsed) out.push(e);
  candidateCache.set(key, out);
  return out;
}

/** A generated deck: the library the engine gets, plus the parts a shrink run needs to rebuild it. */
export interface FuzzDeck {
  /** The library, one CardDef per copy, in canonical (defKey) order so a multiset always shuffles the same way. */
  cards: CardDef[];
  /** Everything drawn from the pool — spells *and* nonbasic lands, one per copy. The multiset ddmin reduces. */
  picks: CardDef[];
  /** The basic lands, one per copy. Removing a pick pays for it with one more of these, so the library keeps its size. */
  basics: CardDef[];
  /** Colours the deck's basics cover, in WUBRG order. */
  colors: Color[];
  commander?: CardDef;
}

const byKey = (a: CardDef, b: CardDef) => (defKey(a) < defKey(b) ? -1 : defKey(a) > defKey(b) ? 1 : 0);
const sorted = (defs: CardDef[]) => [...defs].sort(byKey);

/** `n` basic lands spread round-robin over `colors` (so a two-colour deck gets an even split). */
export function basicsFor(cards: CardDB, colors: Color[], n: number): CardDef[] {
  const defs = colors.map(c => cards.get(BASIC_OF[c]) ?? null).filter((d): d is CardDef => !!d);
  if (!defs.length) throw new Error(`no basic land for colours ${colors.join('')}`);
  return Array.from({ length: Math.max(0, n) }, (_, i) => defs[i % defs.length]);
}

/** Draw `n` copies from `pool`, at most `max` of any one card; the CardDef comes back through the DB's parse cache. */
function draw(cards: CardDB, pool: PoolEntry[], rng: Rng, n: number, max: number, label: string): CardDef[] {
  if (pool.length < Math.ceil(n / max)) throw new Error(`${label}: only ${pool.length} cards to pick ${n} from`);
  const counts = new Map<string, number>(); const out: CardDef[] = [];
  // rejection sampling on the copy limit; with thousands of candidates a redraw is rare, and the cap stops a
  // pathologically small pool (a narrow colour identity in --pool parsed) from spinning forever
  for (let tries = 0; out.length < n && tries < n * 200; tries++) {
    const e = pool[rng.int(pool.length)];
    if ((counts.get(e.oracleId) ?? 0) >= max) continue;
    const def = cards.getByOracleId(e.oracleId); if (!def) continue;
    counts.set(e.oracleId, (counts.get(e.oracleId) ?? 0) + 1); out.push(def);
  }
  if (out.length < n) throw new Error(`${label}: drew ${out.length} of ${n} from ${pool.length} candidates`);
  return out;
}

export interface DeckOptions { format: FuzzFormat; pool: FuzzPool }

/** How a deck is put together, per format: spells + nonbasic lands + basics is always the whole library. */
export const DECK_SHAPE = {
  freeform: { spells: 36, copies: 4, lands: 4, basics: 20 },
  commander: { spells: 63, copies: 1, lands: 6, basics: 30 },
} as const;

/**
 * The deck for one seat, from one 32-bit seed.
 *   freeform  36 spells (up to 4 copies) + 4 nonbasic lands + 20 basics, mono colour half the time, else two.
 *   commander a legendary creature, then 63 singleton spells and 6 nonbasic lands inside its colour identity + 30 basics.
 * A colour identity with too few nonbasic lands to fill its slots (a narrow mask in `--pool parsed`) takes basics
 * instead, so the library is always the same size and deck generation never fails over the land slots.
 */
export function makeDeck(cards: CardDB, idx: PoolIndex, seed: number, opts: DeckOptions): FuzzDeck {
  const rng = new Rng(seed);
  const commanderFormat = opts.format === 'commander';
  const shape = commanderFormat ? DECK_SHAPE.commander : DECK_SHAPE.freeform;
  let commander: CardDef | undefined;
  let mask: number;
  let colors: Color[];
  if (commanderFormat) {
    const legends = candidates(idx, 31, opts.pool, 'legend');
    if (!legends.length) throw new Error(`no legendary creature in the ${opts.pool} pool`);
    const pick = legends[rng.int(legends.length)];
    commander = cards.getByOracleId(pick.oracleId)!;
    mask = maskOf(commander.colorIdentity);
    colors = colorsOf(mask);
  } else {
    const shuffled = rng.shuffle([...WUBRG]);
    colors = shuffled.slice(0, rng.next() < 0.5 ? 1 : 2).sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b));
    mask = maskOf(colors);
  }
  const label = commander ? `commander deck ${commander.name}` : `freeform deck ${colors.join('')}`;
  const spells = draw(cards, candidates(idx, mask, opts.pool), rng, shape.spells, shape.copies, label);
  const landPool = candidates(idx, mask, opts.pool, 'land');
  const wantLands = Math.min(shape.lands, landPool.length * shape.copies);
  const lands = wantLands ? draw(cards, landPool, rng, wantLands, shape.copies, `${label} lands`) : [];
  const picks = [...spells, ...lands];
  const basics = basicsFor(cards, colors, shape.basics + (shape.lands - lands.length));
  return { cards: sorted([...picks, ...basics]), picks, basics, colors, ...(commander ? { commander } : {}) };
}

/** The same deck with its pool multiset replaced; the removed slots become extra basics so the library keeps its size. */
export function withPicks(cards: CardDB, deck: FuzzDeck, picks: CardDef[]): FuzzDeck {
  const basics = [...deck.basics, ...basicsFor(cards, deck.colors, deck.picks.length - picks.length)];
  return { ...deck, cards: sorted([...picks, ...basics]), picks, basics };
}

/** A deck as "<count>x <name>" lines, sorted by name: what the report stores and `--repro` reads back. */
export function deckList(defs: CardDef[]): string[] {
  const counts = new Map<string, number>();
  for (const d of defs) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  return [...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, n]) => `${n}x ${name}`);
}

/** Expand a `deckList` back into CardDefs (names resolve through CardDB.get). Throws on a line the DB cannot resolve. */
export function parseDeckList(cards: CardDB, list: string[]): CardDef[] {
  const out: CardDef[] = [];
  for (const line of list) {
    const m = /^(\d+)x\s+(.+)$/.exec(line.trim());
    if (!m) throw new Error(`deck list line is not "<n>x <name>": ${line}`);
    const def = cards.get(m[2]); if (!def) throw new Error(`no card called ${m[2]}`);
    for (let i = 0; i < Number(m[1]); i++) out.push(def);
  }
  return sorted(out);
}
