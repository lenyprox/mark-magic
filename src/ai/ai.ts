// Reactive AI opponent. It evaluates every legal action (and every way of targeting it) by simulating the
// action on a cloned game and scoring the resulting board. It reacts to the human's plays: when the human
// puts a spell on the stack the AI compares "let it resolve" against every instant-speed response it has.
// With `cheat: false` it only sees a redacted state and scores actions across K sampled worlds (determinizations).
import type { CardDef } from '../cards/types.js';
import { determinize, hashSeed } from '../analysis/determinize.js';
import type { ListEntry, OpponentModel } from '../analysis/types.js';
import { findObject, hasKeyword, isCreature, isLand, name, power } from '../engine/characteristics.js';
import { cloneState } from '../engine/clone.js';
import { Game } from '../engine/game.js';
import { opponentOf, type Agent, type AttackDeclaration, type BlockDeclaration, type Decision, type GameState, type LegalAction, type PlayerAction, type PlayerId } from '../engine/state.js';
import { redact } from '../engine/view.js';
import { bestBlocks, bestBlocksDetailed } from './combat.js';
import { autoAgent, chooseCardsHeuristic, cloneGame, concreteActions, defaultYesNo, describeAction, evaluate, scoreAction } from './search.js';

export { evaluate, creatureValue, cloneGame, chooseCardsHeuristic, AutoAgent } from './search.js';

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------
export interface AiOptions {
  name?: string; aggression?: number; verbose?: boolean; maxSims?: number;
  /** true (default): simulate on the real game, including hidden cards. false: play from a redacted view over sampled worlds. */
  cheat?: boolean;
  /** Worlds sampled per decision when not cheating (default 3). */
  determinizations?: number;
  opponentModel?: OpponentModel;
  /** The AI's own list (so its unknown library can be sampled). */
  myList?: ListEntry[];
  /** Card definitions the determinizer may sample from (keyed by defKey). */
  defs?: Map<string, CardDef>;
  seed?: number;
}

/** One option the AI considered, with its simulated score. */
export interface ReasoningCandidate { label: string; score: number; action?: PlayerAction | AttackDeclaration | BlockDeclaration }
/** Structured account of a decision (the narrated string in `lastReason` is derived from the same data). */
export interface Reasoning {
  kind: 'priority' | 'attackers' | 'blockers' | 'mulligan' | 'land';
  player: PlayerId; turn: number; step: string;
  summary: string;
  baseline: number;           // score of doing nothing (pass / no attack / no blocks)
  threshold?: number;         // how much better than baseline an action had to be
  chosen: ReasoningCandidate | null;
  candidates: ReasoningCandidate[]; // sorted best first, capped
  sims: number; ms: number;
  determinizations: number;   // worlds averaged (1 when cheating)
  seeds: number[];            // world seeds, for reproducibility
}

export class AiAgent implements Agent {
  name: string;
  game!: Game; // set by attach()
  hidden: boolean;
  private aggression: number;
  private verbose: boolean;
  private maxSims: number;
  private cheat: boolean;
  private determinizations: number;
  private opponentModel: OpponentModel;
  private myList?: ListEntry[];
  private defs: Map<string, CardDef>;
  private seed: number;
  private decisions = 0;
  onLog?: (line: string) => void;
  lastReason = '';
  lastReasoning: Reasoning | null = null;
  onReasoning?: (r: Reasoning) => void;
  constructor(opts: AiOptions = {}) {
    this.name = opts.name ?? 'AI'; this.aggression = opts.aggression ?? 1; this.verbose = opts.verbose ?? true; this.maxSims = opts.maxSims ?? 400;
    this.cheat = opts.cheat ?? true; this.hidden = !this.cheat; this.determinizations = Math.max(1, opts.determinizations ?? 3);
    this.opponentModel = opts.opponentModel ?? { kind: 'none' }; this.myList = opts.myList; this.defs = opts.defs ?? new Map(); this.seed = opts.seed ?? 12345;
  }
  attach(game: Game) { this.game = game; }
  private say(msg: string) { this.lastReason = msg; if (this.verbose) this.game.log(`  [${this.name} thinks] ${msg}`); }
  private reason(r: Omit<Reasoning, 'turn' | 'step' | 'determinizations' | 'seeds'> & Partial<Pick<Reasoning, 'determinizations' | 'seeds'>>, s: GameState) {
    const full: Reasoning = { determinizations: 1, seeds: [], ...r, turn: s.turn, step: s.step, candidates: [...r.candidates].sort((a, b) => b.score - a.score).slice(0, 25) };
    this.lastReasoning = full; this.onReasoning?.(full);
  }

  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (!this.cheat) s = redact(s, me); // never trust the caller: an honest agent redacts what it is handed
    this.decisions++;
    switch (d.kind) {
      case 'priority': return this.priority(s, me, d.legal);
      case 'attackers': return this.attackers(s, me, d.candidates, d.mustAttack);
      case 'blockers': return this.blockers(s, me, d.attackers, d.candidates);
      case 'choose-cards': return chooseCardsHeuristic(s, me, d.from, d.count, d.reason);
      case 'yes-no': {
        if (d.tag === 'mulligan' || d.prompt.startsWith('Mulligan')) {
          const hand = s.players[me].hand; const lands = hand.filter(isLand).length;
          const mull = hand.length >= 6 && (lands <= 1 || lands >= 6);
          if (mull) this.say(`mulligans a ${lands}-land hand.`); else this.say(`keeps ${hand.length} cards (${lands} lands).`);
          return mull;
        }
        return defaultYesNo(s, me, d);
      }
      case 'choose-mode': return [0];
      case 'choose-color': return this.chooseColor(s, me);
      case 'choose-option': return d.options[0];
      case 'order-blockers': return d.blockers;
    }
  }

  private chooseColor(s: GameState, me: PlayerId): string {
    const need: Record<string, number> = {};
    for (const c of s.players[me].hand) for (const p of c.def.manaCost?.pips ?? []) need[p] = (need[p] ?? 0) + 1;
    const pool = s.players[me].manaPool; for (const m of pool) if (need[m]) need[m]--;
    const best = Object.entries(need).sort((a, b) => b[1] - a[1])[0];
    return best && best[1] > 0 ? best[0] : (s.players[me].battlefield.flatMap(o => o.def.producesMana)[0] ?? 'G');
  }

  // ---- worlds -------------------------------------------------------------
  /** The games actions are scored on: the live game when cheating, else K sampled completions of the redacted view. */
  private worlds(s: GameState, me: PlayerId): { games: Game[]; seeds: number[] } {
    if (this.cheat) return { games: [this.game], seeds: [] };
    const games: Game[] = []; const seeds: number[] = [];
    for (let i = 0; i < this.determinizations; i++) {
      const seed = hashSeed(this.seed ^ (this.decisions * 7919), i);
      const det = determinize(s, { viewer: me, myList: this.myList, opponent: this.opponentModel, defs: this.defs, seed });
      const auto = autoAgent();
      games.push(Game.fromState(det.state, [auto, auto], { quiet: true, seed, fastMana: true })); seeds.push(seed);
    }
    return { games, seeds };
  }
  /** Combat decisions do not depend on hidden cards (nothing gets cast): one inert world of the view suffices. */
  private combatWorld(s: GameState): Game {
    if (this.cheat) return this.game;
    const auto = autoAgent();
    return Game.fromState(cloneState(s), [auto, auto], { quiet: true, seed: 7, fastMana: true });
  }

  // ---- priority ---------------------------------------------------------
  private async priority(s: GameState, me: PlayerId, legal: LegalAction[]): Promise<PlayerAction> {
    const opp = opponentOf(me);
    const stackTop = s.stack[s.stack.length - 1];
    const responding = !!stackTop && stackTop.controller === opp;
    const myTurn = s.activePlayer === me;
    const mainPhase = myTurn && (s.step === 'main1' || s.step === 'main2') && s.stack.length === 0;
    // Timing policy: act in my main phases; respond to opponent's spells; use instants at the opponent's
    // end step, after attackers are declared, or after blockers (combat tricks). Otherwise pass.
    const windowOpen = mainPhase || responding || (!myTurn && ['end', 'declare-attackers', 'declare-blockers'].includes(s.step)) || (myTurn && ['declare-blockers'].includes(s.step)) || (s.stack.length > 0 && stackTop.controller === me && false);
    if (!windowOpen) return { type: 'pass' };

    // Land drop first: pick the land that best fixes colours.
    const landPlays = legal.filter(l => l.action.type === 'play-land');
    if (landPlays.length) {
      const pl = s.players[me];
      const have = new Map<string, number>(); for (const o of pl.battlefield) for (const m of o.def.producesMana) have.set(m, (have.get(m) ?? 0) + 1);
      const need = new Map<string, number>(); for (const c of pl.hand) for (const p of c.def.manaCost?.pips ?? []) need.set(p, (need.get(p) ?? 0) + 1);
      const score = (l: LegalAction) => { const card = pl.hand.find(c => c.id === (l.action as { cardId: number }).cardId)!; let sc = card.def.entersTapped ? -0.5 : 0; for (const m of card.def.producesMana) sc += (need.get(m) ?? 0) / (1 + (have.get(m) ?? 0)); return sc; };
      const best = landPlays.sort((a, b) => score(b) - score(a))[0];
      this.say(`plays a land (${best.label.replace('play land ', '')}).`);
      this.reason({ kind: 'land', player: me, summary: this.lastReason, baseline: 0, chosen: { label: best.label, score: score(best), action: best.action }, candidates: landPlays.map(l => ({ label: l.label, score: score(l), action: l.action })), sims: 0, ms: 0 }, s);
      return best.action;
    }

    const t0 = Date.now();
    const { games, seeds } = this.worlds(s, me);
    const K = games.length;
    const score = async (a: PlayerAction, l?: LegalAction) => { let sum = 0; for (const g of games) sum += await scoreAction(g, me, a, l); return sum / K; };
    const baseline = await score({ type: 'pass' });
    let best: { action: PlayerAction; score: number; label: string } | null = null;
    const candidates: ReasoningCandidate[] = [{ label: responding ? `let ${stackTop.name} resolve` : 'pass', score: baseline, action: { type: 'pass' } }];
    let sims = 0; const cap = Math.max(8, Math.floor(this.maxSims / K));
    outer: for (const l of legal) {
      if (l.action.type === 'pass' || l.action.type === 'play-land') continue;
      for (const concrete of this.cheat ? concreteActions(s, me, l) : concreteActions(s, me, l, 4, 30)) {
        if (sims++ > cap) break outer;
        const sc = await score(concrete, l);
        const label = describeAction(s, concrete, l);
        candidates.push({ label, score: sc, action: concrete });
        if (!best || sc > best.score) best = { action: concrete, score: sc, label };
      }
    }
    const threshold = responding ? 0.4 : 0.15;
    const ms = Date.now() - t0;
    if (best && best.score > baseline + threshold) {
      if (responding) this.say(`responds to ${stackTop.name} with ${best.label} (eval ${fmt(best.score)} vs ${fmt(baseline)} if it resolves).`);
      else this.say(`${best.label} (eval ${fmt(best.score)} vs ${fmt(baseline)}).`);
      this.reason({ kind: 'priority', player: me, summary: this.lastReason, baseline, threshold, chosen: { label: best.label, score: best.score, action: best.action }, candidates, sims: sims * K, ms, determinizations: K, seeds }, s);
      return best.action;
    }
    if (responding && this.verbose) this.say(`lets ${stackTop.name} resolve${best ? ` (best response ${best.label} only ${fmt(best.score)} vs ${fmt(baseline)})` : ' (no useful response)'}.`);
    if (sims > 0 || responding) this.reason({ kind: 'priority', player: me, summary: responding ? this.lastReason : 'passes', baseline, threshold, chosen: candidates[0], candidates, sims: sims * K, ms, determinizations: K, seeds }, s);
    return { type: 'pass' };
  }

  // ---- combat -----------------------------------------------------------
  private async attackers(s: GameState, me: PlayerId, candidates: number[], mustAttack: number[]): Promise<AttackDeclaration> {
    const opp = opponentOf(me);
    const cands = candidates.map(id => findObject(s, id)!).filter(Boolean);
    // rank by "attack quality" and search subsets (full enumeration up to 7 attackers, otherwise greedy prefix sets)
    const subsets: number[][] = [];
    if (cands.length <= 7) { for (let m = 0; m < (1 << cands.length); m++) subsets.push(cands.filter((_, i) => m & (1 << i)).map(o => o.id)); }
    else { const sorted = [...cands].sort((a, b) => power(s, b) - power(s, a)); for (let k = 0; k <= sorted.length; k++) subsets.push(sorted.slice(0, k).map(o => o.id)); }
    let best: { ids: number[]; score: number } | null = null;
    const baseline = evaluate(s, me);
    const t0 = Date.now(); const options: ReasoningCandidate[] = [];
    const world = this.combatWorld(s);
    for (const ids of subsets) {
      const set = [...new Set([...ids, ...mustAttack])];
      const g = cloneGame(world);
      // opponent chooses its best blocks against this attack, using the same block logic
      const blocks = await bestBlocks(g.state, opp, set, g.state.players[opp].battlefield.filter(o => isCreature(o) && !o.tapped).map(o => o.id), g);
      await g.simulateCombat(set, blocks);
      let score = evaluate(g.state, me);
      // account for the crack-back: creatures that attacked are tapped next opponent turn (unless vigilance)
      const tappedPower = set.map(id => findObject(s, id)!).filter(o => !hasKeyword(s, o, 'vigilance')).reduce((a, o) => a + power(s, o), 0);
      const oppPower = s.players[opp].battlefield.filter(isCreature).reduce((a, o) => a + power(s, o), 0);
      const myLifeAfter = g.state.players[me].life;
      if (oppPower >= myLifeAfter) score -= 4; // dangerous to tap out
      score -= tappedPower * 0.05 * (2 - this.aggression);
      options.push({ label: set.length ? `attack with ${set.map(id => `${name(findObject(s, id)!)}#${id}`).join(', ')}` : 'no attack', score, action: { attackers: set } });
      if (!best || score > best.score) best = { ids: set, score };
    }
    const ids = best?.ids ?? mustAttack;
    if (ids.length) this.say(`attacks with ${ids.map(id => `${name(findObject(s, id)!)}#${id}`).join(', ')} (eval ${fmt(best!.score)} vs ${fmt(baseline)} holding back).`);
    else this.say('holds back its creatures.');
    this.reason({ kind: 'attackers', player: me, summary: this.lastReason, baseline, chosen: best ? { label: ids.length ? 'attack' : 'no attack', score: best.score, action: { attackers: ids } } : null, candidates: options, sims: subsets.length, ms: Date.now() - t0 }, s);
    return { attackers: ids };
  }

  private async blockers(s: GameState, me: PlayerId, attackerIds: number[], candidateIds: number[]): Promise<BlockDeclaration> {
    const t0 = Date.now();
    const { blocks, candidates, baseline } = await bestBlocksDetailed(s, me, attackerIds, candidateIds, this.combatWorld(s));
    if (blocks.length) this.say(`blocks: ${blocks.map(b => `${name(findObject(s, b.blocker)!)}#${b.blocker} → ${name(findObject(s, b.attacker)!)}#${b.attacker}`).join(', ')}.`);
    else this.say('takes the hit, no blocks.');
    const chosen = candidates.find(c => c.action && (c.action as BlockDeclaration).blocks === blocks) ?? null;
    this.reason({ kind: 'blockers', player: me, summary: this.lastReason, baseline, chosen, candidates, sims: candidates.length, ms: Date.now() - t0 }, s);
    return { blocks };
  }
}

function fmt(n: number) { return n.toFixed(1); }
