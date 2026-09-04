// Local search with successive-halving racing on paired seed blocks. Every iteration proposes single swaps of the
// incumbent, races them on the first games of the current block, plays the survivors on the whole block, and
// accepts the best one whose paired win-rate gain is significant (delta − 1.96·se > 0). Blocks rotate so the deck
// does not overfit one set of shuffles; the search checkpoints after every iteration and resumes from the store.
import type { CardDB } from '../cards/db.js';
import type { CardQueryDB } from '../cards/query.js';
import type { CardDef } from '../cards/types.js';
import type { ListEntry } from '../analysis/types.js';
import type { BatchPool } from '../sim/batchPool.js';
import { getSetting } from '../user/db.js';
import { buildPool, iterationRng, neighbours, seedCandidate, type PoolCard } from './candidates.js';
import { evaluateCandidate, pairedCompare, tally, type EvalContext, type FieldDeck } from './evaluator.js';
import { buildReport } from './insights.js';
import type { OptimizerStore } from './store.js';
import type { Candidate, OptimizerCheckpoint, OptimizerProgress, OptimizerReport, OptimizerSpec, StoredGame, SwapReport } from './types.js';

export interface SearchContext {
  store: OptimizerStore;
  runId: string;
  spec: OptimizerSpec;
  cards: CardDB;
  query?: CardQueryDB | null;
  owned: Map<string, number>;
  ownedNames: Set<string>;
  commander: CardDef | null;
  seedList: ListEntry[];
  field: FieldDeck[];
  pool?: BatchPool | null;
  log?: (msg: string) => void;
  /** Polled between steps: true when the run should stop at the next boundary. */
  shouldStop?: () => boolean;
  pid?: number | null;
  /** Called with every progress update (also persisted). */
  onProgress?: (p: OptimizerProgress) => void;
}

const now = () => new Date().toISOString();

function blockIndices(spec: OptimizerSpec, block: number): number[] {
  const n = spec.budget.blockSize; return Array.from({ length: n }, (_, k) => block * n + k);
}

function gameMap(games: StoredGame[]): Map<number, StoredGame> { const m = new Map<number, StoredGame>(); for (const g of games) m.set(g.index, g); return m; }

/** Card contributions from a candidate's games: win rate when the card was seen minus overall (0 when unseen). */
export function contributions(games: StoredGame[]): Map<string, number> {
  const ok = games.filter(g => !g.error); const out = new Map<string, number>();
  if (!ok.length) return out;
  const overall = ok.filter(g => g.winner === 0).length / ok.length;
  const seen = new Map<string, { n: number; w: number }>();
  for (const g of ok) for (const n of new Set([...g.seen[0], ...g.openingHand[0]])) { const e = seen.get(n) ?? { n: 0, w: 0 }; e.n++; if (g.winner === 0) e.w++; seen.set(n, e); }
  for (const [n, e] of seen) out.set(n, e.n >= 5 ? e.w / e.n - overall : 0);
  return out;
}

function wilsonUpper(w: number, n: number): number { if (!n) return 1; const p = w / n, z = 1.96, z2 = z * z; return ((p + z2 / (2 * n)) + z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n); }

/** Run (or resume) the search; returns the final report. Throws when cancelled before the baseline exists. */
export async function optimize(ctx: SearchContext): Promise<OptimizerReport> {
  const { store, runId, spec } = ctx;
  const log = ctx.log ?? (() => undefined);
  const stop = () => !!ctx.shouldStop?.();
  const startedAt = Date.now();
  const lookup = (name: string) => ctx.cards.get(name) ?? undefined;
  const pool: PoolCard[] = buildPool(ctx.cards, { commander: ctx.commander, owned: ctx.owned, constraints: spec.constraints, format: spec.format, bulk: spec.pool === 'owned+bulk' && ctx.query ? { query: ctx.query, max: Math.max(0, spec.maxUnowned * 25) } : undefined });
  log(`pool: ${pool.length} cards (${pool.filter(p => p.bulk).length} unregistered)`);
  const evalCtx: EvalContext = { cards: ctx.cards, spec, runId, field: ctx.field, commander: ctx.commander, pool: ctx.pool, shouldStop: stop };

  // ---- state (fresh or resumed)
  const run = store.get(runId)!;
  let cp: OptimizerCheckpoint | null = run.checkpoint;
  const candidates = new Map<string, Candidate>(); for (const c of store.candidates(runId)) candidates.set(c.id, c);
  const gamesOf = (id: string) => gameMap(store.games(runId, id));
  let best: Candidate; let baseline: Candidate;
  let gamesSimulated = cp?.gamesSimulated ?? 0, gamesReused = cp?.gamesReused ?? 0;
  const swaps: SwapReport[] = cp?.swaps ?? [];
  const tried = new Set<string>(cp?.tried ?? []);
  let iteration = cp?.iteration ?? 0; let block = cp?.block ?? 0;
  const secondsBefore = cp?.seconds ?? 0;
  const gps = getSetting<number>(store.db, 'bench_games_per_s', 40);
  const progress = (message: string, status: OptimizerProgress['status'] = 'running') => {
    const bw = best ? tally(store.games(runId, best.id)) : null;
    const bl = baseline ? tally(store.games(runId, baseline.id)) : null;
    const remaining = Math.max(0, spec.budget.games - gamesSimulated);
    const p: OptimizerProgress = { status, iteration, maxIterations: spec.budget.maxIterations, gamesSimulated, gamesReused, gamesBudget: spec.budget.games, bestWinRate: bw && bw.games ? bw.wins / bw.games : null, baselineWinRate: bl && bl.games ? bl.wins / bl.games : null, accepted: swaps.filter(s => s.comparison.accepted).length, message, heartbeat: now(), pid: ctx.pid ?? null, startedAt: run.progress.startedAt ?? now(), etaSeconds: Math.round(remaining / Math.max(1, gps * Math.max(1, ctx.pool?.size ?? 1))) };
    store.saveProgress(runId, p); ctx.onProgress?.(p);
  };
  const checkpoint = () => { cp = { bestId: best.id, baselineId: baseline.id, iteration, block, gamesSimulated, gamesReused, swaps, rngState: 0, tried: [...tried], seconds: secondsBefore + (Date.now() - startedAt) / 1000 }; store.saveCheckpoint(runId, cp); };
  const record = async (c: Candidate, indices: number[], parent?: Candidate) => {
    const parentGames = parent ? { id: parent.id, games: gamesOf(parent.id) } : undefined;
    const r = await evaluateCandidate(evalCtx, c, indices, parentGames);
    store.saveGames(runId, c.id, r.games);
    gamesSimulated += r.simulated; gamesReused += r.reused;
    const t = tally(store.games(runId, c.id)); c.games = t.games; c.wins = t.wins; c.draws = t.draws;
    store.saveCandidate(runId, c);
    return r;
  };

  if (cp) {
    best = candidates.get(cp.bestId)!; baseline = candidates.get(cp.baselineId)!;
    log(`resuming at iteration ${iteration}, block ${block}, best ${best.id}`);
  } else {
    baseline = seedCandidate(ctx.seedList); best = baseline;
    store.saveCandidate(runId, baseline);
    progress('evaluating the seed deck on block 0');
    await record(baseline, blockIndices(spec, 0));
    baseline.status = 'best'; store.saveCandidate(runId, baseline);
    if (stop()) throw new Error('cancelled');
    checkpoint();
  }
  progress(`baseline ${(best.wins / Math.max(1, best.games) * 100).toFixed(1)}% over ${best.games} games`);

  // ---- iterations
  while (iteration < spec.budget.maxIterations && gamesSimulated < spec.budget.games && !stop()) {
    const wantBlock = Math.floor(iteration / spec.budget.rotateBlockEvery);
    if (wantBlock !== block) {
      block = wantBlock;
      progress(`iteration ${iteration + 1}: fresh seed block ${block}, re-evaluating the incumbent`);
      // the incumbent needs games on the new block so comparisons stay paired
      const have = gamesOf(best.id); const need = blockIndices(spec, block).filter(i => !have.has(i));
      if (need.length) { const parent = best.parentId ? candidates.get(best.parentId) : undefined; const parentHas = parent && blockIndices(spec, block).every(i => gamesOf(parent.id).has(i)); await record(best, need, parentHas ? parent : undefined); }
      if (stop()) break;
    }
    const idx = blockIndices(spec, block);
    const rng = iterationRng(spec.seed, iteration);
    const contrib = contributions(store.games(runId, best.id));
    const props = neighbours(best, iteration, block, { count: spec.budget.swapsPerIteration, contributions: contrib, landTarget: spec.constraints.lands, tried, rng, pool, constraints: spec.constraints, lookup });
    if (!props.length) { log('no neighbours left to try'); break; }
    for (const c of props) { candidates.set(c.id, c); store.saveCandidate(runId, c); }
    const incGames = gamesOf(best.id);
    // stage 1: race on the first games of the block
    const stage1 = idx.slice(0, Math.min(spec.budget.race.stage1, idx.length));
    progress(`iteration ${iteration + 1}: racing ${props.length} swaps on ${stage1.length} games`);
    const raced: { c: Candidate; upper: number }[] = [];
    for (const c of props) {
      if (stop()) break;
      await record(c, stage1, best);
      const cmp = pairedCompare(gamesOf(c.id), incGames);
      raced.push({ c, upper: cmp.delta + 1.96 * cmp.se });
      c.status = 'raced-out'; store.saveCandidate(runId, c);
    }
    if (stop()) break;
    raced.sort((a, b) => b.upper - a.upper);
    const survivors = raced.slice(0, spec.budget.race.keep).filter(r => r.upper >= 0);
    // stage 2: survivors finish the block
    let winner: { c: Candidate; cmp: ReturnType<typeof pairedCompare>; simulated: number; reused: number } | null = null;
    for (const { c } of survivors) {
      if (stop()) break;
      progress(`iteration ${iteration + 1}: full block for ${c.swapOut} → ${c.swapIn}`);
      const rest = idx.filter(i => !gamesOf(c.id).has(i));
      const r = await record(c, rest, best);
      const cmp = pairedCompare(gamesOf(c.id), incGames);
      c.status = cmp.accepted ? 'accepted' : 'evaluated'; store.saveCandidate(runId, c);
      const rep: SwapReport = { iteration, block, out: c.swapOut!, in: c.swapIn!, bulk: c.bulk, candidateId: c.id, incumbentId: best.id, comparison: cmp, reused: r.reused, simulated: r.simulated, derivationId: `swap-${c.id}` };
      swaps.push(rep);
      if (cmp.accepted && (!winner || cmp.delta > winner.cmp.delta)) winner = { c, cmp, simulated: r.simulated, reused: r.reused };
    }
    for (const { c } of raced) if (!survivors.some(s => s.c.id === c.id)) { c.status = 'rejected'; store.saveCandidate(runId, c); }
    if (winner) {
      best.status = 'evaluated'; store.saveCandidate(runId, best);
      best = winner.c; best.status = 'best'; store.saveCandidate(runId, best);
      log(`iteration ${iteration + 1}: accepted ${best.swapOut} → ${best.swapIn} (+${(winner.cmp.delta * 100).toFixed(1)} pts, n=${winner.cmp.n})`);
    } else log(`iteration ${iteration + 1}: no significant improvement (${survivors.length} survivors)`);
    iteration++;
    checkpoint();
    progress(winner ? `accepted ${winner.c.swapOut} → ${winner.c.swapIn}` : 'no significant swap this iteration');
  }

  // ---- final paired comparison of best vs baseline on the best's block (fully simulated for the baseline if needed)
  const finalIdx = blockIndices(spec, block);
  const baseHave = gamesOf(baseline.id); const baseNeed = finalIdx.filter(i => !baseHave.has(i));
  if (baseNeed.length && !stop()) { progress('final comparison: baseline on the last block'); await record(baseline, baseNeed); }
  const paired = best.id === baseline.id ? null : pairedCompare(gamesOf(best.id), gamesOf(baseline.id));
  const report = buildReport({ spec, store, runId, baseline, best, candidates: [...candidates.values()], swaps, paired, ownedNames: ctx.ownedNames, lookup, field: ctx.field, seconds: secondsBefore + (Date.now() - startedAt) / 1000, gamesSimulated, gamesReused, iterations: iteration, blocks: block + 1 });
  checkpoint();
  return report;
}
