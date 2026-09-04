// Determinized Monte Carlo tree search for priority decisions (B11). The one-ply AiAgent scores each action by the
// board right after it resolves; this agent instead plays each candidate out with the rollout policy for a few
// turns on K sampled worlds (or the live game when cheating), selects candidates with UCB1 and returns the most
// visited one. Randomness derives from the agent seed and the decision index, so a seeded game replays exactly.
import { hashSeed, determinize } from '../analysis/determinize.js';
import { RolloutAgent } from '../analysis/rolloutAgent.js';
import { Game } from '../engine/game.js';
import { cloneState } from '../engine/clone.js';
import type { Decision, GameState, LegalAction, PlayerAction, PlayerId } from '../engine/state.js';
import { AiAgent, type AiOptions, type ReasoningCandidate } from './ai.js';
import { concreteActions, describeAction, evaluate } from './search.js';

export interface MctsOptions extends AiOptions {
  /** Playouts per decision (default 120). */
  iterations?: number;
  /** Turns played after the current one in each playout (default 2). */
  horizon?: number;
  /** UCB1 exploration constant (default 1.1). */
  explore?: number;
  /** Candidate cap: targets per action and total concrete actions (defaults 4 / 24). */
  maxTargets?: number; maxActions?: number;
}

interface Node { action: PlayerAction; label: string; visits: number; total: number; legal?: LegalAction }

/** Reward in [-1, 1] from `me`'s evaluation of a finished or horizon state. */
export function reward(s: GameState, me: PlayerId): number {
  if (s.winner === me) return 1;
  if (s.winner !== null && s.winner !== me) return -1;
  if (s.players[me].lost) return -1;
  const ev = evaluate(s, me);
  if (ev >= 10000) return 1; if (ev <= -10000) return -1;
  return Math.tanh(ev / 20);
}

export class MctsAgent extends AiAgent {
  private iterations: number; private horizon: number; private explore: number; private maxTargets: number; private maxActions: number;
  private mctsSeed: number; private mctsDecisions = 0; private cheats: boolean; private worldsK: number;
  lastSearch: { candidates: ReasoningCandidate[]; iterations: number; ms: number } | null = null;

  constructor(opts: MctsOptions = {}) {
    super({ ...opts, name: opts.name ?? 'MCTS' });
    this.iterations = Math.max(4, opts.iterations ?? 120); this.horizon = Math.max(0, opts.horizon ?? 2); this.explore = opts.explore ?? 1.1;
    this.maxTargets = opts.maxTargets ?? 4; this.maxActions = opts.maxActions ?? 24;
    this.mctsSeed = opts.seed ?? 12345; this.cheats = opts.cheat ?? true; this.worldsK = Math.max(1, opts.determinizations ?? 3);
    this.mctsOpts = opts;
  }
  private mctsOpts: MctsOptions;

  override async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (d.kind !== 'priority') return super.decide(s, me, d);
    return this.search(s, me, d.legal);
  }

  /** Candidate concrete actions (pass first). Land drops are taken by the one-ply logic since they need no look-ahead. */
  private candidates(s: GameState, me: PlayerId, legal: LegalAction[]): Node[] {
    const nodes: Node[] = [{ action: { type: 'pass' }, label: 'pass', visits: 0, total: 0 }];
    let n = 0;
    for (const l of legal) {
      if (l.action.type === 'pass' || l.action.type === 'play-land') continue;
      for (const a of concreteActions(s, me, l, this.maxTargets, this.maxActions)) { if (n++ >= this.maxActions) break; nodes.push({ action: a, label: describeAction(s, a, l), visits: 0, total: 0, legal: l }); }
    }
    return nodes;
  }

  /** The worlds playouts run on: clones of the live state when cheating, else K determinizations of the redacted view. */
  private mctsWorlds(s: GameState, me: PlayerId): { states: GameState[]; seeds: number[] } {
    if (this.cheats) return { states: [s], seeds: [] };
    const states: GameState[] = []; const seeds: number[] = [];
    for (let i = 0; i < this.worldsK; i++) {
      const seed = hashSeed(this.mctsSeed ^ (this.mctsDecisions * 7919), i);
      const det = determinize(s, { viewer: me, myList: this.mctsOpts.myList, opponent: this.mctsOpts.opponentModel ?? { kind: 'none' }, defs: this.mctsOpts.defs ?? new Map(), seed });
      states.push(det.state); seeds.push(seed);
    }
    return { states, seeds };
  }

  /** One playout: apply the action on a clone of the world, finish the turn and `horizon` more with the rollout policy. */
  private async playout(world: GameState, me: PlayerId, node: Node, seed: number): Promise<number> {
    const state = cloneState(world);
    const agents = state.players.map((_, i) => new RolloutAgent(`R${i}`));
    const g = Game.fromState(state, agents, { quiet: true, seed, fastMana: true, events: 'none', maxTurns: state.turn + this.horizon + 1 });
    try {
      if (node.action.type !== 'pass') { const ok = await g.performAction(me, node.action); if (!ok) return -1; state.passesInRow = 0; }
      await g.resumeTurn();
      if (state.winner === null && this.horizon > 0) await g.playTurns(this.horizon);
    } catch { return -0.5; }
    return reward(state, me);
  }

  private async search(s: GameState, me: PlayerId, legal: LegalAction[]): Promise<PlayerAction> {
    const t0 = Date.now(); this.mctsDecisions++;
    // land drops first, exactly as the one-ply agent does (they need no look-ahead)
    const land = legal.find(l => l.action.type === 'play-land');
    if (land && s.stack.length === 0) return (await super.decide(s, me, { kind: 'priority', legal })) as PlayerAction;
    const nodes = this.candidates(s, me, legal);
    if (nodes.length === 1) return nodes[0].action;
    // only pass is worth searching when nothing is on the stack and it is not our main phase (the one-ply timing policy)
    const myTurn = s.activePlayer === me; const main = myTurn && (s.step === 'main1' || s.step === 'main2') && s.stack.length === 0;
    const top = s.stack[s.stack.length - 1];
    const responding = !!top && top.controller !== me;
    if (!main && !responding && !(!myTurn && ['end', 'declare-attackers', 'declare-blockers'].includes(s.step)) && !(myTurn && s.step === 'declare-blockers')) return { type: 'pass' };
    const { states, seeds } = this.mctsWorlds(s, me);
    const K = states.length;
    let total = 0;
    for (let i = 0; i < this.iterations; i++) {
      // UCB1 over root children; every child gets one visit first
      let pick = nodes.find(n => n.visits === 0);
      if (!pick) { let best = -Infinity; for (const n of nodes) { const u = n.total / n.visits + this.explore * Math.sqrt(Math.log(total + 1) / n.visits); if (u > best) { best = u; pick = n; } } }
      const w = i % K;
      const r = await this.playout(states[w], me, pick!, hashSeed(this.mctsSeed ^ (this.mctsDecisions * 104729), i));
      pick!.visits++; pick!.total += r; total++;
    }
    const ranked = [...nodes].sort((a, b) => b.visits - a.visits || b.total / Math.max(1, b.visits) - a.total / Math.max(1, a.visits));
    const best = ranked[0];
    const candidates: ReasoningCandidate[] = ranked.map(n => ({ label: `${n.label} (${n.visits} playouts)`, score: n.visits ? Math.round(n.total / n.visits * 1000) / 1000 : 0, action: n.action }));
    const ms = Date.now() - t0;
    this.lastSearch = { candidates, iterations: this.iterations, ms };
    const passNode = nodes[0];
    const passValue = passNode.visits ? passNode.total / passNode.visits : 0;
    const bestValue = best.visits ? best.total / best.visits : 0;
    // require a margin over passing so the agent does not fire spells into noise
    const chosen = best === passNode || bestValue - passValue < 0.02 ? passNode : best;
    this.lastReason = chosen === passNode ? `passes (best alternative ${best.label} ${bestValue.toFixed(2)} vs pass ${passValue.toFixed(2)})` : `${chosen.label} (${chosen.visits} playouts, value ${bestValue.toFixed(2)} vs pass ${passValue.toFixed(2)})`;
    this.onReasoning?.({ kind: 'priority', player: me, turn: s.turn, step: s.step, summary: this.lastReason, baseline: passValue, threshold: 0.02, chosen: { label: chosen.label, score: chosen.visits ? chosen.total / chosen.visits : 0, action: chosen.action }, candidates, sims: this.iterations, ms, determinizations: K, seeds });
    return chosen.action;
  }
}
