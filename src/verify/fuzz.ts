// The fuzz trial itself (Phase 8f): build a seeded table, drive it one turn at a time and check
// src/engine/invariants.ts after every turn. A thrown error or a violation is a failure; failures are bucketed by
// signature (message with the digits stripped, plus the top three stack frames) so a thousand games collapse into a
// handful of distinct bugs, and the first game of each bucket is shrunk with ddmin down to the cards that matter.
//
// Nothing here reads the clock or the filesystem: the coordinator passes `at` into the report so a run is
// reproducible and a worker's result never depends on when it ran.
import { hashSeed } from '../analysis/determinize.js';
import { RolloutAgent } from '../analysis/rolloutAgent.js';
import type { CardDB } from '../cards/db.js';
import type { PoolTier } from '../cards/tiers.js';
import type { CardDef } from '../cards/types.js';
import { assertInvariants } from '../engine/invariants.js';
import type { Game } from '../engine/game.js';
import { createGame } from '../sim/engineAdapter.js';
import { deckList, makeDeck, poolIndex, withNonland, type FuzzDeck, type FuzzFormat, type FuzzPool } from './fuzzDecks.js';

export type FuzzSeats = 2 | 4;

/** Everything a game index needs to be rebuilt: the fuzzer's whole configuration except how many games to play. */
export interface FuzzOptions {
  seed: number;
  seats: FuzzSeats;
  format: FuzzFormat;
  pool: FuzzPool;
  /** Pool tier the decks are drawn from (default 'paper': cards you can hold in your hand). */
  tier?: PoolTier;
  /** Default: 30 turns freeform, 40 in Commander. */
  maxTurns?: number;
}

export const maxTurnsOf = (o: FuzzOptions): number => o.maxTurns ?? (o.format === 'commander' ? 40 : 30);
/** Seed of seat `s` in game `i`: a pure function of the run seed, so every worker builds the same table. */
export const deckSeed = (seed: number, i: number, s: number): number => hashSeed(hashSeed(seed, i), s + 1);

/** A failing game: what went wrong, where, and which bucket it belongs to. */
export interface Failure {
  game: number;
  /** The seat that was taking its turn when it broke — the deck ddmin reduces. */
  seat: number;
  turn: number;
  kind: 'throw' | 'invariant';
  message: string;
  /** Top stack frames as `file.ts:function` (empty for an invariant violation, which has no throw site). */
  frames: string[];
  signature: string;
  bucket: string;
}

/** One frame of a V8 stack line as `file.ts:function`, or null for a frame with no usable location. */
function frameOf(line: string): string | null {
  const m = /^\s*at\s+(?:(.+?)\s+\()?([^()]+?):\d+:\d+\)?$/.exec(line);
  if (!m) return null;
  const loc = m[2];
  if (loc.startsWith('node:')) return null;                              // node internals say nothing about our bug
  const file = loc.split(/[\\/]/).pop() ?? loc;
  const fn = (m[1] ?? '').replace(/^(async|new)\s+/, '');
  return fn ? `${file}:${fn}` : file;
}

/** The top `n` frames of an error's stack, node internals dropped. */
export function topFrames(err: unknown, n = 3): string[] {
  const stack = (err as Error | undefined)?.stack;
  if (typeof stack !== 'string') return [];
  const out: string[] = [];
  for (const line of stack.split('\n')) { const f = frameOf(line); if (f) out.push(f); if (out.length >= n) break; }
  return out;
}

/** The bucket key: the message with every run of digits replaced by `#`, then the frames. Object ids and life totals move; the bug does not. */
export function signatureOf(message: string, frames: string[]): string {
  return [message.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160), ...frames].join(' | ');
}

/** A short stable id for a signature (FNV-1a, like `deckHash` in src/sim/batch.ts). */
export function bucketId(signature: string): string {
  let h = 0x811c9dc5;
  for (const ch of signature) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Replace one seat's library wholesale (a shrink candidate or a `--repro` deck list). */
export interface DeckOverride { seat: number; cards: CardDef[] }

/** Build the table for game `i` — one deck per seat, each from its own seed. */
export function buildDecks(cards: CardDB, opts: FuzzOptions, i: number): FuzzDeck[] {
  const idx = poolIndex(cards, opts.tier ?? 'paper');
  return Array.from({ length: opts.seats }, (_, s) => makeDeck(cards, idx, deckSeed(opts.seed, i, s), { format: opts.format, pool: opts.pool }));
}

export interface GameOutcome { failure: Failure | null; turns: number; winner: number | null; log?: string[] }

/**
 * Play game `i` of the run, one turn at a time, checking the invariants after the opening hands and after every turn.
 * The opening is the same as `Game.play`'s with mulligans off — a random first seat off the game rng, seven cards
 * each — after which `resumeTurn` takes turn 1 and `playTurns(1)` takes the rest, so the fuzzer sees the state
 * between turns without the engine needing a hook.
 */
export async function runDecks(decks: FuzzDeck[], opts: FuzzOptions, i: number, extra: { record?: 'counts' | 'full' } = {}): Promise<GameOutcome> {
  const maxTurns = maxTurnsOf(opts);
  const agents = decks.map((_, s) => new RolloutAgent(`seat ${s + 1}`));
  const g: Game = createGame(decks.map(d => d.cards), agents, {
    seed: hashSeed(opts.seed, i), quiet: true, mulligans: false, events: extra.record ?? 'counts', maxTurns,
    startingLife: opts.format === 'commander' ? 40 : 20, fastMana: true, format: opts.format,
    commanders: decks.map(d => (d.commander ? [d.commander] : [])),
  });
  const s = g.state;
  let where = 'the opening hands';
  const fail = (kind: Failure['kind'], message: string, frames: string[]): GameOutcome => {
    const signature = signatureOf(message, frames);
    return { failure: { game: i, seat: s.activePlayer, turn: s.turn, kind, message, frames, signature, bucket: bucketId(signature) }, turns: s.turn, winner: s.winner, log: extra.record === 'full' ? s.log.slice() : undefined };
  };
  try {
    s.activePlayer = s.turnOrder[g.rng.int(s.turnOrder.length)];
    for (const p of s.players) for (let k = 0; k < 7; k++) await g.draw(p.id, true);
    g.emit({ type: 'game-start', first: s.activePlayer, players: s.players.map(p => p.name) });
    let v = assertInvariants(s); if (v) return fail('invariant', `after ${where}: ${v}`, []);
    where = 'turn 1';
    await g.resumeTurn();
    v = assertInvariants(s); if (v) return fail('invariant', `after turn: ${v}`, []);
    while (s.winner === null && s.turn < maxTurns) {
      where = `turn ${s.turn + 1}`;
      await g.playTurns(1);
      v = assertInvariants(s); if (v) return fail('invariant', `after turn: ${v}`, []);
    }
  } catch (e) {
    return fail('throw', `${(e as Error)?.message ?? String(e)} (during ${where.replace(/\d+/g, 'N')})`, topFrames(e));
  }
  return { failure: null, turns: s.turn, winner: s.winner, log: extra.record === 'full' ? s.log.slice() : undefined };
}

/** Play game `i` of the run from scratch, optionally with one seat's library replaced. */
export async function runGame(cards: CardDB, opts: FuzzOptions, i: number, extra: { record?: 'counts' | 'full'; override?: DeckOverride } = {}): Promise<GameOutcome> {
  let decks: FuzzDeck[];
  try { decks = buildDecks(cards, opts, i); }
  catch (e) { const message = `deck generation failed: ${(e as Error).message}`; const frames = topFrames(e); const signature = signatureOf(message, frames); return { failure: { game: i, seat: 0, turn: 0, kind: 'throw', message, frames, signature, bucket: bucketId(signature) }, turns: 0, winner: null }; }
  if (extra.override) decks[extra.override.seat] = { ...decks[extra.override.seat], cards: extra.override.cards };
  return runDecks(decks, opts, i, { record: extra.record });
}

/**
 * Classic delta debugging (Zeller & Hildebrandt, ddmin): the 1-minimal sublist of `items` for which `fails` still
 * holds. Halves first, then quarters, then complements, then finer — `maxRuns` caps the predicate calls and the
 * best subset found so far is returned when the cap is hit.
 */
export async function ddmin<T>(items: T[], fails: (subset: T[]) => Promise<boolean>, maxRuns = 200): Promise<{ minimal: T[]; runs: number; capped: boolean }> {
  // positions, not values: a deck holds four copies of the same (cached, hence identical) CardDef object, so a
  // value-based complement would drop all four at once and never reach a 1-minimal multiset
  let c = items.map((_, i) => i); let n = 2; let runs = 0; let capped = false;
  const test = async (sub: number[]): Promise<boolean> => { if (runs >= maxRuns) { capped = true; return false; } runs++; return fails(sub.map(i => items[i])); };
  while (c.length >= 2 && !capped) {
    const size = c.length / n;
    const chunks = Array.from({ length: n }, (_, k) => c.slice(Math.round(k * size), Math.round((k + 1) * size))).filter(x => x.length);
    let reduced = false;
    for (const chunk of chunks) if (await test(chunk)) { c = chunk; n = 2; reduced = true; break; }   // "reduce to subset"
    if (reduced) continue;
    if (capped) break;
    for (const chunk of chunks) {                                                                     // "reduce to complement"
      const drop = new Set(chunk);
      const rest = c.filter(i => !drop.has(i));
      if (rest.length && rest.length < c.length && await test(rest)) { c = rest; n = Math.max(n - 1, 2); reduced = true; break; }
    }
    if (reduced) continue;
    if (capped || n >= c.length) break;
    n = Math.min(n * 2, c.length);
  }
  return { minimal: c.map(i => items[i]), runs, capped };
}

export interface ShrinkResult { minimalDeck: string[]; commander?: string; runs: number; capped: boolean }

/**
 * Reduce the failing seat's nonland cards for one bucket. Every candidate deck keeps the seat's basics (plus one
 * extra basic per removed card, so the library keeps its size and the game still plays out) and the other seats'
 * decks untouched; a candidate counts as a reproduction only when it lands in the *same* bucket.
 */
export async function shrinkBucket(cards: CardDB, opts: FuzzOptions, first: { game: number; seat: number }, bucket: string, maxRuns = 200): Promise<ShrinkResult> {
  const decks = buildDecks(cards, opts, first.game);
  const deck = decks[first.seat] ?? decks[0];
  const seat = decks[first.seat] ? first.seat : 0;
  const reproduces = async (subset: CardDef[]): Promise<boolean> => {
    const candidate = withNonland(cards, deck, subset);
    const out = await runGame(cards, opts, first.game, { override: { seat, cards: candidate.cards } });
    return out.failure?.bucket === bucket;
  };
  const { minimal, runs, capped } = await ddmin(deck.nonland, reproduces, maxRuns);
  const final = withNonland(cards, deck, minimal);
  return { minimalDeck: deckList(final.cards), ...(final.commander ? { commander: final.commander.name } : {}), runs, capped };
}
