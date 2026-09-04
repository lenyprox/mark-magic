// Paired evaluation of candidate lists. Game i of a run always uses seed hashSeed(spec.seed, i), the same seating
// rotation and the same opponent, whatever the candidate, so two candidates' results on the same indexes are a
// paired sample. A child that differs from its parent by one card inherits every parent game in which the swapped-
// out card was never seen (identical prefix of play), and only simulates the rest.
import type { ListEntry } from '../analysis/types.js';
import type { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import { commanderNames, deckArray, runMatches, type PreparedMatch } from '../sim/batch.js';
import type { BatchPool } from '../sim/batchPool.js';
import { buildDeckPayload, splitPayload } from '../play/payload.js';
import type { DeckPayload } from '../play/protocol.js';
import type { GameRecordLite, MatchSpec } from '../sim/types.js';
import type { Candidate, FieldEntry, OptimizerSpec, StoredGame } from './types.js';

export interface FieldDeck { entry: FieldEntry; payload: DeckPayload }

export interface EvalContext {
  cards: CardDB;
  spec: OptimizerSpec;
  runId: string;
  field: FieldDeck[];
  commander: CardDef | null;
  pool?: BatchPool | null;
  shouldStop?: () => boolean;
  onGames?: (simulated: number, reused: number) => void;
}

/** Weighted round-robin opponents: a cycle list with each field entry repeated by its weight. */
export function fieldCycle(field: FieldDeck[]): number[] {
  const cycle: number[] = [];
  const unit = Math.min(...field.map(f => Math.max(1, f.entry.weight)));
  field.forEach((f, i) => { const n = Math.max(1, Math.round(Math.max(1, f.entry.weight) / unit)); for (let k = 0; k < n; k++) cycle.push(i); });
  return cycle;
}

/** Opponent field indexes for game `index` (one for duels, players-1 for pods; distinct when the field allows). */
export function opponentsFor(spec: OptimizerSpec, field: FieldDeck[], index: number): number[] {
  const cycle = fieldCycle(field); const need = spec.players - 1;
  const out: number[] = [];
  for (let k = 0; k < need; k++) {
    const f = cycle[(index * need + k) % cycle.length];
    out.push(field.length > need && out.includes(f) ? cycle[(index * need + k + 1) % cycle.length] : f);
  }
  return out;
}

export function candidatePayload(cards: CardDB, spec: OptimizerSpec, c: Candidate, commander: CardDef | null): DeckPayload {
  const entries = c.list.map(e => ({ name: e.name, count: e.count, board: 'main' as const }));
  if (commander) entries.push({ name: commander.name, count: 1, board: 'commander' as unknown as 'main' });
  return buildDeckPayload(cards, { name: `${spec.name}:${c.id}`, cards: entries as { name: string; count: number; board: 'main' | 'commander' }[] }, { name: c.id });
}

function arrayFromOrder(order: string[], payload: DeckPayload): CardDef[] {
  const byName = new Map<string, CardDef>(); for (const d of Object.values(payload.defs)) byName.set(d.name, d);
  return order.map(n => byName.get(n)).filter((d): d is CardDef => !!d);
}

export function matchSpecFor(ctx: EvalContext, c: Candidate, opps: number[]): { spec: MatchSpec; prepared: PreparedMatch } {
  const cand = candidatePayload(ctx.cards, ctx.spec, c, ctx.commander);
  const decks = [cand, ...opps.map(i => ctx.field[i].payload)];
  const format = ctx.spec.format;
  const spec: MatchSpec = { id: `${ctx.runId}:${c.id}:${opps.join('+')}`, decks, games: 0, baseSeed: ctx.spec.seed, seating: 'rotate', agent: ctx.spec.agent, aiSims: 30, format, maxTurns: ctx.spec.maxTurns, mulligans: ctx.spec.mulligans, record: 'summary', orders: [c.order, ...opps.map(() => null)] };
  const arrays = decks.map((d, i) => i === 0 ? arrayFromOrder(c.order, d) : format === 'commander' ? splitPayload(d).library.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : deckArray(d));
  const prepared: PreparedMatch = { arrays, commanders: decks.map(commanderNames), commanderDefs: decks.map(d => format === 'commander' ? splitPayload(d).commanders : []), seats: decks.length };
  return { spec, prepared };
}

export interface EvalResult { games: StoredGame[]; simulated: number; reused: number }

/** Play (or inherit) the games at `indices` for a candidate. */
export async function evaluateCandidate(ctx: EvalContext, c: Candidate, indices: number[], parent?: { id: string; games: Map<number, StoredGame> }): Promise<EvalResult> {
  const out: StoredGame[] = []; let reused = 0;
  const toPlay: number[] = [];
  for (const i of indices) {
    const pg = parent?.games.get(i);
    if (pg && c.swapOut && !pg.error && !pg.seen[0].includes(c.swapOut) && !pg.openingHand[0].includes(c.swapOut)) { out.push({ ...pg, candidateId: c.id, reusedFrom: parent!.id }); reused++; }
    else toPlay.push(i);
  }
  // group the remaining games by opponent set (each set is one MatchSpec)
  const groups = new Map<string, { opps: number[]; indices: number[] }>();
  for (const i of toPlay) { const opps = opponentsFor(ctx.spec, ctx.field, i); const key = opps.join('+'); const g = groups.get(key) ?? { opps, indices: [] }; g.indices.push(i); groups.set(key, g); }
  let simulated = 0;
  for (const g of groups.values()) {
    if (ctx.shouldStop?.()) break;
    const { spec, prepared } = matchSpecFor(ctx, c, g.opps);
    const oppName = g.opps.map(i => ctx.field[i].payload.name).join(' + ');
    let records: GameRecordLite[];
    if (ctx.pool) records = (await ctx.pool.run({ ...spec, games: g.indices.length }, { indices: g.indices }).result).games;
    else records = (await runMatches(spec, { indices: g.indices, prepared, shouldStop: ctx.shouldStop, yieldEvery: 25 })).games;
    for (const r of records) out.push({ ...r, candidateId: c.id, opponent: oppName, reusedFrom: null });
    simulated += records.length;
    ctx.onGames?.(simulated, reused);
  }
  out.sort((a, b) => a.index - b.index);
  return { games: out, simulated, reused };
}

/** Win counts of deck 0 over a set of records. */
export function tally(games: { winner: number | null; error?: string }[]): { games: number; wins: number; draws: number } {
  const ok = games.filter(g => !g.error);
  return { games: ok.length, wins: ok.filter(g => g.winner === 0).length, draws: ok.filter(g => g.winner === null).length };
}

/** Paired comparison of a candidate against the incumbent on the games both have. */
export function pairedCompare(cand: Map<number, StoredGame>, inc: Map<number, StoredGame>, z = 1.96): { n: number; a: number; b: number; delta: number; se: number; ci95: [number, number]; accepted: boolean } {
  let n = 0, a = 0, b = 0;
  for (const [i, g] of cand) {
    const h = inc.get(i); if (!h || g.error || h.error) continue;
    n++;
    const cw = g.winner === 0, iw = h.winner === 0;
    if (cw && !iw) a++; else if (iw && !cw) b++;
  }
  if (!n) return { n: 0, a: 0, b: 0, delta: 0, se: 0, ci95: [0, 0], accepted: false };
  const delta = (a - b) / n;
  const se = Math.sqrt(Math.max(0, (a + b) - (a - b) * (a - b) / n)) / n;
  const lo = delta - z * se, hi = delta + z * se;
  return { n, a, b, delta: r4(delta), se: r4(se), ci95: [r4(lo), r4(hi)], accepted: lo > 0 };
}
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function entriesOf(list: ListEntry[]): ListEntry[] { return list.map(e => ({ name: e.name, count: e.count })); }
