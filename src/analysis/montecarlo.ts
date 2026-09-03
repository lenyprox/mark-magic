// Seeded Monte Carlo over determinized worlds. Trial i of every candidate uses seed hashSeed(baseSeed, i), so the
// candidates are compared on the same sampled worlds (common random numbers) and any trial can be reproduced.
import type { CardDef } from '../cards/types.js';
import { AiAgent } from '../ai/ai.js';
import { evaluate } from '../ai/search.js';
import { Game } from '../engine/game.js';
import { opponentOf, type Agent, type GameState, type PlayerId } from '../engine/state.js';
import { determinize, hashSeed } from './determinize.js';
import { rolloutAgents } from './rolloutAgent.js';
import type { Derivation, Estimate, ListEntry, McAggregate, McRequest, OpponentModel, TrialResult } from './types.js';

export interface McContext { snapshot: GameState; viewer: PlayerId; model: OpponentModel; myList?: ListEntry[]; defs: Map<string, CardDef> }

/** Score at the horizon beyond which an unfinished game counts as won/lost. */
export const DECIDED_EVAL = 8;

/** Wilson score interval for a proportion (successes may be fractional when draws count half). */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function makeAgents(policy: McRequest['policy']): [Agent, Agent] {
  if (policy === 'ai30') return [new AiAgent({ name: 'P0', verbose: false, maxSims: 30 }), new AiAgent({ name: 'P1', verbose: false, maxSims: 30 })];
  return rolloutAgents();
}

/** One trial: determinize with the trial's seed, force the candidate action, finish the turn, play to the horizon. */
export async function runTrial(ctx: McContext, req: McRequest, i: number): Promise<TrialResult> {
  const seed = hashSeed(req.baseSeed, i);
  const det = determinize(ctx.snapshot, { viewer: ctx.viewer, myList: ctx.myList, opponent: ctx.model, defs: ctx.defs, seed });
  const me = ctx.viewer, opp = opponentOf(me);
  const agents = makeAgents(req.policy);
  const game = Game.fromState(det.state, agents, { quiet: true, seed, fastMana: true });
  for (const a of agents) if (a instanceof AiAgent) a.attach(game);
  const s = game.state;
  const lifeStart = s.players[me].life - s.players[opp].life, evalStart = evaluate(s, me), turnStart = s.turn;
  let note: string | undefined;
  try {
    if (req.concrete.type !== 'pass') { const ok = await game.performAction(me, req.concrete); if (!ok) note = 'action was not legal in this world'; s.passesInRow = 0; }
    await game.resumeTurn();
    if (s.winner === null) await game.playTurns(req.horizon);
  } catch (e) { note = `engine error: ${(e as Error).message}`; }
  const ev = evaluate(s, me);
  const outcome: TrialResult['outcome'] = s.winner === me ? 'win' : s.winner === opp ? 'loss' : s.players[opp].lost ? 'win' : s.players[me].lost ? 'loss' : ev > DECIDED_EVAL ? 'win' : ev < -DECIDED_EVAL ? 'loss' : 'draw';
  const unsimulated = s.log.filter(l => l.includes('unsimulated text')).length;
  const r: TrialResult = { trial: i, seed, outcome, lifeDelta: (s.players[me].life - s.players[opp].life) - lifeStart, boardDelta: round(ev - evalStart), evalEnd: round(ev), turnsPlayed: s.turn - turnStart, unsimulated };
  if (note) r.note = note;
  return r;
}

/** Run the trials of a request in order; `onBatch` receives results as they complete (every `batch` trials). */
export async function runTrials(ctx: McContext, req: McRequest, onBatch?: (results: TrialResult[]) => void | Promise<void>, batch = 5, shouldStop?: () => boolean): Promise<TrialResult[]> {
  const all: TrialResult[] = []; let pending: TrialResult[] = [];
  for (let i = req.trialStart; i < req.trialStart + req.trialCount; i++) {
    if (shouldStop?.()) break;
    const r = await runTrial(ctx, req, i); all.push(r); pending.push(r);
    if (pending.length >= batch) { await onBatch?.(pending); pending = []; }
  }
  if (pending.length) await onBatch?.(pending);
  return all;
}

function round(x: number) { return Math.round(x * 1000) / 1000; }
function meanCi(xs: number[]): Estimate {
  const n = xs.length; if (!n) return { value: 0, method: 'montecarlo', n: 0 };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1)) : 0;
  const h = 1.96 * sd / Math.sqrt(n);
  return { value: round(m), ci95: [round(m - h), round(m + h)], method: 'montecarlo', n };
}

/** Win/life/board estimates with 95% intervals; draws count half a win. */
export function aggregate(results: TrialResult[], seed?: number): McAggregate {
  const n = results.length;
  const wins = results.filter(r => r.outcome === 'win').length, losses = results.filter(r => r.outcome === 'loss').length, draws = n - wins - losses;
  const succ = wins + draws / 2;
  const win: Estimate = { value: n ? round(succ / n) : 0, ci95: wilson(succ, n).map(round) as [number, number], method: 'montecarlo', n, seed };
  return { n, wins, losses, draws, win, life: { ...meanCi(results.map(r => r.lifeDelta)), seed }, board: { ...meanCi(results.map(r => r.boardDelta)), seed }, unsimulated: results.reduce((a, r) => a + r.unsimulated, 0) };
}

/** A derivation for a Monte Carlo estimate, carrying the request needed to reproduce it exactly. */
export function mcDerivation(id: string, title: string, req: McRequest, agg: McAggregate, extraAssumptions: string[] = []): Derivation {
  const successes = agg.wins + agg.draws / 2;
  return {
    id, method: 'montecarlo', title,
    formula: 'P(win) ≈ (wins + draws/2) / n, Wilson 95% interval; trial i uses seed = hashSeed(baseSeed, i)',
    inputs: [{ name: 'n', value: agg.n }, { name: 'baseSeed', value: req.baseSeed }, { name: 'horizon', value: req.horizon, note: 'turns after the current one' }, { name: 'policy', value: req.policy }],
    steps: [{ text: `wins ${agg.wins}, losses ${agg.losses}, draws ${agg.draws}` }, { text: `(${agg.wins} + ${agg.draws}/2) / ${agg.n} = ${agg.win.value}`, value: agg.win.value }, { text: `Wilson 95%: [${agg.win.ci95?.[0]}, ${agg.win.ci95?.[1]}]` }, { text: `unsimulated card text encountered in these rollouts: ${agg.unsimulated}`, value: agg.unsimulated }],
    result: agg.win.value,
    assumptions: ['hidden cards are sampled from the opponent model and my list', `a game unfinished at the horizon counts as a win when the board evaluation exceeds ${DECIDED_EVAL}, a loss below −${DECIDED_EVAL}, otherwise a draw (half a win)`, req.policy === 'rollout' ? 'both players follow the deterministic rollout policy' : 'both players use the simulation AI with 30 sims per decision', ...extraAssumptions],
    mc: { n: agg.n, seed: req.baseSeed, successes, ci95: agg.win.ci95 ?? [0, 1], rerun: { ...req, trialStart: req.trialStart, trialCount: agg.n } },
  };
}
