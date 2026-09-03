// Reactive AI opponent. It evaluates every legal action (and every way of targeting it) by simulating the
// action on a cloned game and scoring the resulting board. It reacts to the human's plays: when the human
// puts a spell on the stack the AI compares "let it resolve" against every instant-speed response it has.
import type { Keyword } from '../cards/types.js';
import { allPermanents, canBlock, findObject, hasKeyword, isCreature, isLand, isType, keywords, name, power, toughness } from '../engine/characteristics.js';
import { Game } from '../engine/game.js';
import { opponentOf, type Agent, type AttackDeclaration, type BlockDeclaration, type Decision, type GameState, type LegalAction, type PlayerAction, type PlayerId, type TargetRef } from '../engine/state.js';

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
const KW_VALUE: Partial<Record<Keyword, number>> = { flying: 1.2, 'first strike': 0.8, 'double strike': 2, deathtouch: 1.2, lifelink: 0.8, trample: 0.6, haste: 0.4, vigilance: 0.5, reach: 0.3, menace: 0.7, hexproof: 0.8, indestructible: 1.5, unblockable: 1.5, defender: -1.2, 'cant block': -0.6, protection: 0.8, prowess: 0.4, shroud: 0.5, ward: 0.5, fear: 1, intimidate: 1, skulk: 0.5, 'cant attack': -1.5 };

export function creatureValue(s: GameState, o: import('../engine/state.js').GameObject): number {
  const p = Math.max(0, power(s, o)), t = Math.max(0, toughness(s, o));
  let v = p * 1.0 + t * 0.6 + 0.8;
  for (const k of keywords(s, o)) v += (KW_VALUE[k] ?? 0) * (0.5 + p * 0.25);
  if (o.def.abilities.some(a => a.kind === 'activated' || a.kind === 'triggered' || (a.kind === 'static' && a.effect.kind !== 'unknown'))) v += 0.6;
  if (o.attachedTo === null && o.def.subtypes.includes('Aura')) v -= 1;
  return v;
}

export function evaluate(s: GameState, me: PlayerId): number {
  const opp = opponentOf(me);
  const P = s.players[me], O = s.players[opp];
  if (s.winner === me) return 10000;
  if (s.winner === opp) return -10000;
  if (O.life <= 0 || O.lost) return 10000; if (P.life <= 0 || P.lost) return -10000;
  const lifeTerm = (l: number) => (l <= 0 ? -100 : l < 6 ? l * 2.5 : 15 + (l - 6) * 0.9);
  let v = lifeTerm(P.life) - lifeTerm(O.life);
  const board = (pl: typeof P) => {
    let b = 0;
    for (const o of pl.battlefield) {
      if (isCreature(o)) b += creatureValue(s, o);
      else if (isLand(o)) b += 0.9;
      else if (isType(o, 'Planeswalker')) b += 2 + (o.counters.loyalty ?? 0) * 0.7;
      else b += 1 + Math.min(4, o.def.manaValue) * 0.4;
    }
    return b;
  };
  v += board(P) - board(O);
  v += P.hand.length * 0.7 - O.hand.length * 0.7;
  v += Math.min(P.library.length, 10) * 0.05 - Math.min(O.library.length, 10) * 0.05;
  v -= P.poison * 1.5 - O.poison * 1.5;
  return v;
}

// ---------------------------------------------------------------------------
// Simulation helpers
// ---------------------------------------------------------------------------
/** An agent for simulated games: never casts anything, answers choices heuristically. */
class AutoAgent implements Agent {
  constructor(public name: string, private valuer: (s: GameState, me: PlayerId, ids: number[], n: number, reason: string) => number[]) {}
  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    switch (d.kind) {
      case 'priority': return { type: 'pass' } as PlayerAction;
      case 'attackers': return { attackers: d.mustAttack } as AttackDeclaration;
      case 'blockers': return { blocks: [] } as BlockDeclaration;
      case 'choose-cards': return this.valuer(s, me, d.from, d.count, d.reason);
      case 'yes-no': return true;
      case 'choose-mode': return [0];
      case 'choose-color': return 'G';
      case 'order-blockers': return d.blockers;
    }
  }
}

export function cloneGame(g: Game): Game {
  const state = structuredClone(g.state);
  state.log = [];
  const auto = new AutoAgent('sim', chooseCardsHeuristic);
  return Game.fromState(state, [auto, auto], { quiet: true, seed: 7 });
}

/** Choose N cards from ids: when discarding/sacrificing pick the least valuable; when searching/keeping pick the most useful. */
export function chooseCardsHeuristic(s: GameState, me: PlayerId, ids: number[], n: number, reason: string): number[] {
  const objs = ids.map(id => findObject(s, id)!).filter(Boolean);
  const pl = s.players[me];
  const lands = pl.battlefield.filter(isLand).length;
  const cardValue = (o: import('../engine/state.js').GameObject) => {
    if (o.zone === 'battlefield') return isCreature(o) ? creatureValue(s, o) : isLand(o) ? 5 : 2 + o.def.manaValue;
    if (isLand(o)) return lands < 4 ? 4 - lands * 0.5 : 0.5;
    return 1 + o.def.manaValue * (lands >= o.def.manaValue ? 1 : 0.6) + (o.def.fullyParsed ? 0.5 : -0.5);
  };
  const r = reason.toLowerCase();
  const keepBest = /search|return|keep|scry|surveil|top/.test(r);
  const sorted = [...objs].sort((a, b) => keepBest ? cardValue(b) - cardValue(a) : cardValue(a) - cardValue(b));
  if (/scry|surveil/.test(r)) return sorted.filter(o => cardValue(o) >= 1.5 || (isLand(o) && lands < 4)).map(o => o.id);
  if (/search/.test(r)) {
    // prefer a land producing a colour we lack
    const have = new Set(pl.battlefield.flatMap(o => o.def.producesMana));
    const need = new Set(pl.hand.flatMap(c => c.def.manaCost?.pips ?? []));
    const pick = sorted.find(o => o.def.producesMana.some(m => need.has(m as never) && !have.has(m))) ?? sorted[0];
    return pick ? [pick.id] : [];
  }
  return sorted.slice(0, n).map(o => o.id);
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------
export interface AiOptions { name?: string; aggression?: number; verbose?: boolean; maxSims?: number }

export class AiAgent implements Agent {
  name: string;
  game!: Game; // set by attach()
  private aggression: number;
  private verbose: boolean;
  private maxSims: number;
  onLog?: (line: string) => void;
  lastReason = '';
  constructor(opts: AiOptions = {}) { this.name = opts.name ?? 'AI'; this.aggression = opts.aggression ?? 1; this.verbose = opts.verbose ?? true; this.maxSims = opts.maxSims ?? 400; }
  attach(game: Game) { this.game = game; }
  private say(msg: string) { this.lastReason = msg; if (this.verbose) this.game.log(`  [${this.name} thinks] ${msg}`); }

  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    switch (d.kind) {
      case 'priority': return this.priority(s, me, d.legal);
      case 'attackers': return this.attackers(s, me, d.candidates, d.mustAttack);
      case 'blockers': return this.blockers(s, me, d.attackers, d.candidates);
      case 'choose-cards': return chooseCardsHeuristic(s, me, d.from, d.count, d.reason);
      case 'yes-no': {
        if (d.prompt.startsWith('Mulligan')) {
          const hand = s.players[me].hand; const lands = hand.filter(isLand).length;
          const mull = hand.length >= 6 && (lands <= 1 || lands >= 6);
          if (mull) this.say(`mulligans a ${lands}-land hand.`); else this.say(`keeps ${hand.length} cards (${lands} lands).`);
          return mull;
        }
        return true;
      }
      case 'choose-mode': return [0];
      case 'choose-color': return this.chooseColor(s, me);
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
      return best.action;
    }

    const baseline = await this.simulate(me, { type: 'pass' }, undefined);
    let best: { action: PlayerAction; score: number; label: string } | null = null;
    let sims = 0;
    for (const l of legal) {
      if (l.action.type === 'pass' || l.action.type === 'play-land') continue;
      if (responding) {
        // Only instant-speed actions are legal anyway; skip the mana ability noise
      }
      for (const concrete of this.concreteActions(s, me, l)) {
        if (sims++ > this.maxSims) break;
        const score = await this.simulate(me, concrete, l);
        if (!best || score > best.score) best = { action: concrete, score, label: this.describe(s, concrete, l) };
      }
    }
    const threshold = responding ? 0.4 : 0.15;
    if (best && best.score > baseline + threshold) {
      if (responding) this.say(`responds to ${stackTop.name} with ${best.label} (eval ${fmt(best.score)} vs ${fmt(baseline)} if it resolves).`);
      else this.say(`${best.label} (eval ${fmt(best.score)} vs ${fmt(baseline)}).`);
      return best.action;
    }
    if (responding && this.verbose) this.say(`lets ${stackTop.name} resolve${best ? ` (best response ${best.label} only ${fmt(best.score)} vs ${fmt(baseline)})` : ' (no useful response)'}.`);
    return { type: 'pass' };
  }

  private describe(s: GameState, a: PlayerAction, l: LegalAction): string {
    const t = (a as { targets?: TargetRef[][] }).targets?.flat() ?? [];
    const names = t.map(r => r.kind === 'player' ? s.players[r.id].name : r.kind === 'stack' ? (s.stack.find(i => i.id === r.id)?.name ?? '?') : `${name(findObject(s, r.id)!)}#${r.id}`);
    return `${l.label}${names.length ? ' → ' + names.join(', ') : ''}`;
  }

  /** Expand a legal action into concrete actions with every sensible target combination. */
  private concreteActions(s: GameState, me: PlayerId, l: LegalAction): PlayerAction[] {
    const reqs = l.targetOptions ?? [];
    if (!reqs.length) return [l.action];
    const lists: TargetRef[][][] = reqs.map(r => {
      // rank options and keep the top few to bound the search
      const ranked = [...r.options].sort((a, b) => this.targetPriority(s, me, b) - this.targetPriority(s, me, a)).slice(0, 6);
      const combos: TargetRef[][] = [];
      if (r.count <= 1) { for (const o of ranked) combos.push([o]); }
      else { for (let i = 0; i < ranked.length; i++) for (let j = i + 1; j < ranked.length; j++) combos.push([ranked[i], ranked[j]]); for (const o of ranked) combos.push([o]); }
      if (r.optional) combos.push([]);
      return combos;
    });
    let acc: TargetRef[][][] = [[]];
    for (const lst of lists) { const next: TargetRef[][][] = []; for (const a of acc) for (const c of lst) next.push([...a, c]); acc = next.slice(0, 60); }
    return acc.map(t => ({ ...l.action, targets: t } as PlayerAction));
  }
  private targetPriority(s: GameState, me: PlayerId, r: TargetRef): number {
    if (r.kind === 'player') return 3;
    if (r.kind === 'stack') { const it = s.stack.find(i => i.id === r.id); return it ? 5 + (it.source.def.manaValue) : 0; }
    const o = findObject(s, r.id); if (!o) return 0;
    return isCreature(o) ? creatureValue(s, o) : 2 + o.def.manaValue;
  }

  /** Apply `action` for `me` on a clone, let everything resolve with both players passing, and score it. */
  private async simulate(me: PlayerId, action: PlayerAction, l: LegalAction | undefined): Promise<number> {
    const g = cloneGame(this.game);
    try {
      const ok = await g.performAction(me, action);
      if (ok === false) return -Infinity;
      await g.resolveStackFully();
      g.checkSBA();
      const inCombat = ['declare-attackers', 'declare-blockers', 'first-strike-damage'].includes(g.state.step);
      if (inCombat) await g.simulateRemainingCombat();
      else for (const p of g.state.players) for (const o of p.battlefield) { o.eotPower = 0; o.eotToughness = 0; o.eotKeywords = []; } // until-end-of-turn effects are worthless outside combat
      // Opportunity cost: being tapped out on my own main phase is fine; when responding we already spent it.
      let score = evaluate(g.state, me);
      if (l?.action.type === 'cast') {
        const card = findObject(this.game.state, l.action.cardId);
        // prefer developing bigger threats first; mild tempo bonus for using mana
        score += (l.manaValue ?? 0) * 0.05;
        if (card && !card.def.fullyParsed) score -= 0.3;
      }
      return score;
    } catch { return -Infinity; }
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
    for (const ids of subsets) {
      const set = [...new Set([...ids, ...mustAttack])];
      const g = cloneGame(this.game);
      // opponent chooses its best blocks against this attack, using the same block logic
      const blocks = await this.bestBlocks(g.state, opp, set, g.state.players[opp].battlefield.filter(o => isCreature(o) && !o.tapped).map(o => o.id), g);
      await g.simulateCombat(set, blocks);
      let score = evaluate(g.state, me);
      // account for the crack-back: creatures that attacked are tapped next opponent turn (unless vigilance)
      const tappedPower = set.map(id => findObject(s, id)!).filter(o => !hasKeyword(s, o, 'vigilance')).reduce((a, o) => a + power(s, o), 0);
      const oppPower = s.players[opp].battlefield.filter(isCreature).reduce((a, o) => a + power(s, o), 0);
      const myLifeAfter = g.state.players[me].life;
      if (oppPower >= myLifeAfter) score -= 4; // dangerous to tap out
      score -= tappedPower * 0.05 * (2 - this.aggression);
      if (!best || score > best.score) best = { ids: set, score };
    }
    const ids = best?.ids ?? mustAttack;
    if (ids.length) this.say(`attacks with ${ids.map(id => `${name(findObject(s, id)!)}#${id}`).join(', ')} (eval ${fmt(best!.score)} vs ${fmt(baseline)} holding back).`);
    else this.say('holds back its creatures.');
    return { attackers: ids };
  }

  private async blockers(s: GameState, me: PlayerId, attackerIds: number[], candidateIds: number[]): Promise<BlockDeclaration> {
    const blocks = await this.bestBlocks(s, me, attackerIds, candidateIds, this.game);
    if (blocks.length) this.say(`blocks: ${blocks.map(b => `${name(findObject(s, b.blocker)!)}#${b.blocker} → ${name(findObject(s, b.attacker)!)}#${b.attacker}`).join(', ')}.`);
    else this.say('takes the hit, no blocks.');
    return { blocks };
  }

  /** Candidate-generation + simulation search for blocks. */
  private async bestBlocks(s: GameState, me: PlayerId, attackerIds: number[], candidateIds: number[], game: Game): Promise<{ blocker: number; attacker: number }[]> {
    const attackers = attackerIds.map(id => findObject(s, id)!).filter(o => o && o.zone === 'battlefield');
    const blockers = candidateIds.map(id => findObject(s, id)!).filter(o => o && o.zone === 'battlefield');
    if (!attackers.length || !blockers.length) return [];
    const legalPairs = new Map<number, number[]>();
    for (const a of attackers) legalPairs.set(a.id, blockers.filter(b => canBlock(s, b, a)).map(b => b.id));
    // Enumerate assignments: each blocker -> attacker or none. Bound the search.
    const assignments: { blocker: number; attacker: number }[][] = [];
    const rec = (i: number, cur: { blocker: number; attacker: number }[]) => {
      if (assignments.length > 3000) return;
      if (i === blockers.length) { assignments.push([...cur]); return; }
      rec(i + 1, cur);
      for (const a of attackers) if (legalPairs.get(a.id)!.includes(blockers[i].id)) { cur.push({ blocker: blockers[i].id, attacker: a.id }); rec(i + 1, cur); cur.pop(); }
    };
    rec(0, []);
    let best: { blocks: { blocker: number; attacker: number }[]; score: number } | null = null;
    for (const blocks of assignments) {
      // menace: single blocks on menace attackers are illegal; skip
      const counts = new Map<number, number>(); for (const b of blocks) counts.set(b.attacker, (counts.get(b.attacker) ?? 0) + 1);
      if (attackers.some(a => hasKeyword(s, a, 'menace') && counts.get(a.id) === 1)) continue;
      const g = cloneGame(game);
      await g.simulateCombat(attackerIds, blocks);
      const score = evaluate(g.state, me);
      if (!best || score > best.score) best = { blocks, score };
    }
    return best?.blocks ?? [];
  }
}

function fmt(n: number) { return n.toFixed(1); }

