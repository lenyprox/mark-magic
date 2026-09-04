// Board evaluation and the one-ply action search shared by the AI agent and the analysis engine: score an action by
// applying it on a clone, letting the stack resolve with both players passing, and evaluating the resulting board.
import type { Keyword } from '../cards/types.js';
import { findObject, isCreature, isLand, isType, keywords, name, power, toughness } from '../engine/characteristics.js';
import { cloneState } from '../engine/clone.js';
import { Game } from '../engine/game.js';
import { type Agent, type AttackDeclaration, type BlockDeclaration, type Decision, type GameObject, type GameState, type LegalAction, type PlayerAction, type PlayerId, type Player, type TargetRef } from '../engine/state.js';
import { opponentsOf, primaryOpponent } from '../engine/players.js';
import { defaultAnswer } from '../engine/agents/defaults.js';

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
const KW_VALUE: Partial<Record<Keyword, number>> = { flying: 1.2, 'first strike': 0.8, 'double strike': 2, deathtouch: 1.2, lifelink: 0.8, trample: 0.6, haste: 0.4, vigilance: 0.5, reach: 0.3, menace: 0.7, hexproof: 0.8, indestructible: 1.5, unblockable: 1.5, defender: -1.2, 'cant block': -0.6, protection: 0.8, prowess: 0.4, shroud: 0.5, ward: 0.5, fear: 1, intimidate: 1, skulk: 0.5, 'cant attack': -1.5 };

export function creatureValue(s: GameState, o: GameObject): number {
  const p = Math.max(0, power(s, o)), t = Math.max(0, toughness(s, o));
  let v = p * 1.0 + t * 0.6 + 0.8;
  for (const k of keywords(s, o)) v += (KW_VALUE[k] ?? 0) * (0.5 + p * 0.25);
  if (o.def.abilities.some(a => a.kind === 'activated' || a.kind === 'triggered' || (a.kind === 'static' && a.effect.kind !== 'unknown'))) v += 0.6;
  if (o.attachedTo === null && o.def.subtypes.includes('Aura')) v -= 1;
  return v;
}

/** Value of a player's permanents (creatures by creatureValue, lands, planeswalkers, other permanents). */
export function boardValue(s: GameState, p: PlayerId): number {
  let b = 0;
  for (const o of s.players[p].battlefield) {
    if (isCreature(o)) b += creatureValue(s, o);
    else if (isLand(o)) b += 0.9;
    else if (isType(o, 'Planeswalker')) b += 2 + (o.counters.loyalty ?? 0) * 0.7;
    else b += 1 + Math.min(4, o.def.manaValue) * 0.4;
  }
  return b;
}

/**
 * Board evaluation from `me`'s seat: own standing minus the opponents'. With one opponent this is the classic
 * difference; with several it is own − mean(opponents) − ¼·(strongest − mean), so the biggest threat weighs extra.
 */
export function evaluate(s: GameState, me: PlayerId): number {
  const P = s.players[me];
  if (s.winner === me) return 10000;
  if (s.winner !== null && s.winner !== me) return -10000;
  const opps = s.players.filter(q => q.id !== me);
  if (opps.every(O => O.life <= 0 || O.lost)) return 10000; if (P.life <= 0 || P.lost) return -10000;
  const live = opps.filter(O => !(O.life <= 0 || O.lost));
  if (live.length === 1) { // the classic two-player difference, summed in the original order so seeded games replay bit for bit
    const O = live[0];
    let v = lifeTerm(P.life) - lifeTerm(O.life);
    v += boardValue(s, me) - boardValue(s, O.id);
    v += P.hand.length * 0.7 - O.hand.length * 0.7;
    v += Math.min(P.library.length, 10) * 0.05 - Math.min(O.library.length, 10) * 0.05;
    v -= P.poison * 1.5 - O.poison * 1.5;
    return v;
  }
  const mine = standing(s, P); const theirs = live.map(O => standing(s, O));
  const mean = theirs.reduce((a, b) => a + b, 0) / theirs.length;
  return mine - mean - 0.25 * (Math.max(...theirs) - mean);
}
const lifeTerm = (l: number) => (l <= 0 ? -100 : l < 6 ? l * 2.5 : 15 + (l - 6) * 0.9);
/** One player's standing: life, board, hand, library, poison. */
export function standing(s: GameState, P: Player): number {
  return lifeTerm(P.life) + boardValue(s, P.id) + P.hand.length * 0.7 + Math.min(P.library.length, 10) * 0.05 - P.poison * 1.5;
}
/** Agents for a simulated game: one inert AutoAgent per seat. */
export function autoAgents(s: GameState): Agent[] { const a = autoAgent(); return s.players.map(() => a); }

// ---------------------------------------------------------------------------
// Simulation helpers
// ---------------------------------------------------------------------------
/** An agent for simulated games: never casts anything, answers choices heuristically. */
export class AutoAgent implements Agent {
  constructor(public name: string, private valuer: (s: GameState, me: PlayerId, ids: number[], n: number, reason: string) => number[]) {}
  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    switch (d.kind) {
      case 'priority': return { type: 'pass' } as PlayerAction;
      case 'attackers': return { attackers: d.mustAttack } as AttackDeclaration;
      case 'blockers': return { blocks: [] } as BlockDeclaration;
      case 'choose-cards': return this.valuer(s, me, d.from, d.count, d.reason);
      case 'yes-no': return defaultYesNo(s, me, d);
      case 'choose-mode': return [0];
      case 'choose-color': return 'G';
      case 'choose-option': return d.options[0];
      case 'order-blockers': return d.blockers;
      default: return defaultAnswer(s, me, d);
    }
  }
}

/**
 * Shared answer for tagged yes/no prompts: never dredge or shuffle away a stacked library in simulations, pay for a
 * shockland only when the untapped mana is usable this turn and life allows, pay "unless" taxes, take optional effects.
 */
export function defaultYesNo(s: GameState, me: PlayerId, d: Extract<Decision, { kind: 'yes-no' }>): boolean {
  switch (d.tag) {
    case 'mulligan': return false;
    case 'dredge': return false;
    case 'shock': return shouldPayShockLife(s, me);
    case 'optional': return !/^shuffle/i.test(d.prompt);
    default: return !d.prompt.startsWith('Mulligan');
  }
}

/** Pay 2 life for an untapped shockland when life is comfortable and something in hand could use the mana this turn (or it is the early game). */
export function shouldPayShockLife(s: GameState, me: PlayerId): boolean {
  const pl = s.players[me];
  if (pl.life < 8) return false;
  if ((pl.turnsTaken ?? s.turn) <= 2) return true;
  const untapped = pl.battlefield.filter(o => isLand(o) && !o.tapped).length + 1;
  return pl.hand.some(c => !isLand(c) && c.def.manaValue > 0 && c.def.manaValue <= untapped);
}

export function autoAgent(): AutoAgent { return new AutoAgent('sim', chooseCardsHeuristic); }

export function cloneGame(g: Game): Game {
  const state = cloneState(g.state);
  return Game.fromState(state, autoAgents(state), { quiet: true, seed: 7, fastMana: g.opts.fastMana });
}

/** Choose N cards from ids: when discarding/sacrificing pick the least valuable; when searching/keeping pick the most useful. */
export function chooseCardsHeuristic(s: GameState, me: PlayerId, ids: number[], n: number, reason: string): number[] {
  const objs = ids.map(id => findObject(s, id)!).filter(Boolean);
  const pl = s.players[me];
  const lands = pl.battlefield.filter(isLand).length;
  const cardValue = (o: GameObject) => {
    if (o.zone === 'battlefield') return isCreature(o) ? creatureValue(s, o) : isLand(o) ? 5 : 2 + o.def.manaValue;
    if (isLand(o)) return lands < 4 ? 4 - lands * 0.5 : 0.5;
    return 1 + o.def.manaValue * (lands >= o.def.manaValue ? 1 : 0.6) + (o.def.fullyParsed ? 0.5 : -0.5);
  };
  const r = reason.toLowerCase();
  const theirs = objs.length > 0 && objs.every(o => o.owner !== me && o.zone === 'hand');
  const keepBest = theirs || (/search|return|keep|scry|surveil|top|onto the battlefield|choose a creature type/.test(r) && !/bottom|put back/.test(r));
  const sorted = [...objs].sort((a, b) => keepBest ? cardValue(b) - cardValue(a) : cardValue(a) - cardValue(b));
  if (/order on top/.test(r)) return sorted.map(o => o.id); // best first = best on top
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
// Targets and concrete actions
// ---------------------------------------------------------------------------
/** How attractive a target is in general (used to bound the search; the simulation decides the real value). */
export function targetPriority(s: GameState, me: PlayerId, r: TargetRef): number {
  if (r.kind === 'player') return 3;
  if (r.kind === 'stack') { const it = s.stack.find(i => i.id === r.id); return it ? 5 + (it.source.def.manaValue) : 0; }
  const o = findObject(s, r.id); if (!o) return 0;
  return isCreature(o) ? creatureValue(s, o) : 2 + o.def.manaValue;
}

/** Expand a legal action into concrete actions with every sensible target combination (top `topTargets` per slot, at most `maxCombos`). */
export function concreteActions(s: GameState, me: PlayerId, l: LegalAction, topTargets = 6, maxCombos = 60): PlayerAction[] {
  const reqs = l.targetOptions ?? [];
  if (!reqs.length) return [l.action];
  const lists: TargetRef[][][] = reqs.map(r => {
    const ranked = [...r.options].sort((a, b) => targetPriority(s, me, b) - targetPriority(s, me, a)).slice(0, topTargets);
    const combos: TargetRef[][] = [];
    if (r.count <= 1) { for (const o of ranked) combos.push([o]); }
    else { for (let i = 0; i < ranked.length; i++) for (let j = i + 1; j < ranked.length; j++) combos.push([ranked[i], ranked[j]]); for (const o of ranked) combos.push([o]); }
    if (r.optional) combos.push([]);
    return combos;
  });
  let acc: TargetRef[][][] = [[]];
  for (const lst of lists) { const next: TargetRef[][][] = []; for (const a of acc) for (const c of lst) next.push([...a, c]); acc = next.slice(0, maxCombos); }
  return acc.map(t => ({ ...l.action, targets: t } as PlayerAction));
}

/** One concrete action with heuristic targets: hostile effects at the opponent's best objects, helpful ones at mine. */
export function pickTargetsHeuristic(s: GameState, me: PlayerId, l: LegalAction): PlayerAction {
  const reqs = l.targetOptions ?? [];
  if (!reqs.length) return l.action;
  const opps = opponentsOf(s, me);
  const src = l.action.type === 'cast' ? findObject(s, l.action.cardId) : l.action.type === 'activate' ? findObject(s, l.action.objectId) : undefined;
  const hostile = isHostile(src?.def.abilities.flatMap(a => 'effects' in a ? a.effects : []) ?? []);
  const targets = reqs.map(r => {
    const side = (t: TargetRef) => t.kind === 'stack' ? 1 : opps.includes((t.kind === 'player' ? t.id : findObject(s, t.id)?.controller) as number) ? 1 : -1;
    const sign = hostile ? 1 : -1;
    const ranked = [...r.options].sort((a, b) => (side(b) * sign * 100 + targetPriority(s, me, b)) - (side(a) * sign * 100 + targetPriority(s, me, a)));
    const pick = ranked.slice(0, r.count);
    return r.optional && (!pick.length || side(pick[0]) * sign < 0) ? [] : pick;
  });
  return { ...l.action, targets } as PlayerAction;
}

/** Whether a list of effects is mostly harmful to whatever it targets. */
export function isHostile(effects: import('../cards/types.js').Effect[]): boolean {
  let h = 0, f = 0;
  const walk = (list: import('../cards/types.js').Effect[]) => {
    for (const e of list) {
      if (e.op === 'choose-mode') { for (const m of e.modes) walk(m); continue; }
      if (e.op === 'conditional') { walk(e.then); if (e.else) walk(e.else); continue; }
      if (['damage', 'destroy', 'exile', 'bounce', 'tap', 'lose-life', 'discard', 'mill', 'counter', 'cant-attack-or-block', 'fight', 'bite', 'sacrifice', 'gain-control'].includes(e.op)) h++;
      else if (e.op === 'pump') { if (typeof e.power === 'number' && e.power < 0) h++; else f++; }
      else if (e.op === 'counters') { if (e.counter === '-1/-1') h++; else f++; }
      else if (['grant-keyword', 'draw', 'gain-life', 'untap', 'regenerate', 'prevent-damage', 'attach-self'].includes(e.op)) f++;
    }
  };
  walk(effects);
  return h >= f;
}

export function describeAction(s: GameState, a: PlayerAction, l: LegalAction): string {
  const t = (a as { targets?: TargetRef[][] }).targets?.flat() ?? [];
  const names = t.map(r => r.kind === 'player' ? s.players[r.id].name : r.kind === 'stack' ? (s.stack.find(i => i.id === r.id)?.name ?? '?') : `${name(findObject(s, r.id)!)}#${r.id}`);
  return `${l.label}${names.length ? ' → ' + names.join(', ') : ''}`;
}

// ---------------------------------------------------------------------------
// One-ply scoring
// ---------------------------------------------------------------------------
/** Apply `action` for `me` on a clone of `g`, let everything resolve with both players passing, and score it. */
export async function simulateAction(g: Game, me: PlayerId, action: PlayerAction, l?: LegalAction): Promise<{ score: number; state: GameState } | null> {
  const sim = cloneGame(g);
  try {
    const ok = await sim.performAction(me, action);
    if (ok === false) return null;
    await sim.resolveStackFully();
    sim.checkSBA();
    const inCombat = ['declare-attackers', 'declare-blockers', 'first-strike-damage'].includes(sim.state.step);
    if (inCombat) await sim.simulateRemainingCombat();
    else for (const p of sim.state.players) for (const o of p.battlefield) { o.eotPower = 0; o.eotToughness = 0; o.eotKeywords = []; } // until-end-of-turn effects are worthless outside combat
    let score = evaluate(sim.state, me);
    if (l?.action.type === 'cast') {
      const card = findObject(g.state, l.action.cardId);
      // prefer developing bigger threats first; mild tempo bonus for using mana
      score += (l.manaValue ?? 0) * 0.05;
      if (card && !card.def.fullyParsed) score -= 0.3;
    }
    return { score, state: sim.state };
  } catch { return null; }
}

export async function scoreAction(g: Game, me: PlayerId, action: PlayerAction, l?: LegalAction): Promise<number> {
  return (await simulateAction(g, me, action, l))?.score ?? -Infinity;
}
