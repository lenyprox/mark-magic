// A deterministic, simulation-free policy for Monte Carlo rollouts: cheap enough for a thousand trials, sensible
// enough that the rollouts resemble games (lands that fix colours, biggest castable spell, counters on real threats,
// attacks that win combat or are evasive unless the crack-back is lethal, blocks by the shared block search capped low).
import { bestBlocks } from '../ai/combat.js';
import { autoAgent, chooseCardsHeuristic, defaultYesNo, pickTargetsHeuristic } from '../ai/search.js';
import { canAttack, canBlock, findObject, hasKeyword, isCreature, power, toughness } from '../engine/characteristics.js';
import { Game } from '../engine/game.js';
import { type Agent, type Decision, type GameObject, type GameState, type LegalAction, type PlayerAction, type PlayerId, type TargetRef } from '../engine/state.js';
import { opponentsOf, primaryOpponent } from '../engine/players.js';
import { defaultAnswer } from '../engine/agents/defaults.js';
import { classify } from './classify.js';

export class RolloutAgent implements Agent {
  name: string;
  hidden = false;
  decisions = 0;
  /** Safety valve: after this many decisions in one game the agent only passes (guards against degenerate loops). */
  maxDecisions = 4000;
  constructor(name = 'rollout') { this.name = name; }

  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    const tired = ++this.decisions > this.maxDecisions;
    switch (d.kind) {
      case 'priority': return tired ? { type: 'pass' } : this.priority(s, me, d.legal);
      case 'attackers': return tired ? { attackers: d.mustAttack } : this.attackDeclaration(s, me, d.candidates, d.mustAttack, d.defenders);
      case 'blockers': return { blocks: tired ? [] : await this.blocks(s, me, d.attackers, d.candidates) };
      case 'choose-cards': return chooseCardsHeuristic(s, me, d.from, d.count, d.reason);
      case 'yes-no': return defaultYesNo(s, me, d);
      case 'choose-mode': return [0];
      case 'choose-color': return this.color(s, me);
      case 'choose-option': return d.options[0];
      case 'order-blockers': return d.blockers;
      default: return defaultAnswer(s, me, d);
    }
  }

  private color(s: GameState, me: PlayerId): string {
    const need: Record<string, number> = {};
    for (const c of s.players[me].hand) for (const p of c.def.manaCost?.pips ?? []) need[p] = (need[p] ?? 0) + 1;
    const best = Object.entries(need).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : (s.players[me].battlefield.flatMap(o => o.def.producesMana)[0] ?? 'G');
  }

  priority(s: GameState, me: PlayerId, legal: LegalAction[]): PlayerAction {
    const opps = opponentsOf(s, me); const pl = s.players[me];
    const top = s.stack[s.stack.length - 1];
    const myTurn = s.activePlayer === me;
    const card = (l: LegalAction) => l.action.type === 'cast' ? findObject(s, l.action.cardId) : undefined;
    if (top && opps.includes(top.controller)) {
      // counter the opponent's spell when it is worth a card (MV >= 2) and we hold a counter that can target it
      const worth = top.kind === 'spell' && (top.source.def.manaValue >= 2 || top.source.def.types.includes('Creature'));
      if (worth) for (const l of legal) {
        const c = card(l); if (!c || !classify(c.def).includes('counterspell')) continue;
        const slot = l.targetOptions?.find(t => t.options.some(o => o.kind === 'stack' && o.id === top.id)); if (!slot) continue;
        const targets: TargetRef[][] = (l.targetOptions ?? []).map(t => t === slot ? [{ kind: 'stack', id: top.id }] : t.optional ? [] : t.options.slice(0, 1));
        return { ...l.action, targets } as PlayerAction;
      }
      return { type: 'pass' };
    }
    if (top) return { type: 'pass' };
    const mainPhase = myTurn && (s.step === 'main1' || s.step === 'main2');
    if (mainPhase) {
      const lands = legal.filter(l => l.action.type === 'play-land');
      if (lands.length) {
        const have = new Map<string, number>(); for (const o of pl.battlefield) for (const m of o.def.producesMana) have.set(m, (have.get(m) ?? 0) + 1);
        const need = new Map<string, number>(); for (const c of pl.hand) for (const p of c.def.manaCost?.pips ?? []) need.set(p, (need.get(p) ?? 0) + 1);
        // A land drop is not always from hand: an effect that lets you play a card from exile or from a graveyard
        // (impulse draw, Quintorius, Goph) makes those legal play-land actions too, so look the card up in every
        // zone. A land the lookup cannot find scores below any real one rather than throwing mid-game.
        const score = (l: LegalAction) => { const c = findObject(s, (l.action as { cardId: number }).cardId); if (!c) return -1; let sc = c.def.entersTapped ? -0.5 : 0; for (const m of c.def.producesMana) sc += (need.get(m) ?? 0) / (1 + (have.get(m) ?? 0)); return sc; };
        return lands.sort((a, b) => score(b) - score(a))[0].action;
      }
      // biggest castable spell; hold counterspells and pure combat tricks; equip and loyalty abilities are fine too
      const casts = legal.filter(l => {
        if (l.action.type === 'activate') return l.action.abilityIndex === -3 || (findObject(s, l.action.objectId)?.def.types.includes('Planeswalker') ?? false);
        const c = card(l); if (!c) return false;
        const cls = classify(c.def);
        if (cls.includes('counterspell')) return false;
        if (c.def.types.includes('Instant') && cls.includes('combat-trick') && !cls.includes('removal')) return false;
        return true;
      }).sort((a, b) => (b.manaValue ?? 0) - (a.manaValue ?? 0));
      for (const l of casts) {
        const concrete = pickTargetsHeuristic(s, me, l);
        if (this.sensible(s, me, concrete, l)) return concrete;
      }
      return { type: 'pass' };
    }
    // opponent's end step: flash creatures, card draw, instant-speed removal
    if (!myTurn && s.step === 'end') {
      const casts = legal.filter(l => { const c = card(l); if (!c) return false; const cls = classify(c.def); return !cls.includes('counterspell') && (cls.includes('creature') || cls.includes('card-draw') || cls.includes('removal') || cls.includes('burn')); })
        .sort((a, b) => (b.manaValue ?? 0) - (a.manaValue ?? 0));
      for (const l of casts) { const concrete = pickTargetsHeuristic(s, me, l); if (this.sensible(s, me, concrete, l)) return concrete; }
    }
    return { type: 'pass' };
  }

  /** Reject actions whose targets are all on my side for a hostile spell (or that lack required targets). */
  private sensible(s: GameState, me: PlayerId, a: PlayerAction, l: LegalAction): boolean {
    const reqs = l.targetOptions ?? []; const t = (a as { targets?: TargetRef[][] }).targets ?? [];
    for (let i = 0; i < reqs.length; i++) if (!reqs[i].optional && !(t[i]?.length)) return false;
    const c = l.action.type === 'cast' ? findObject(s, l.action.cardId) : undefined;
    if (c) {
      const cls = classify(c.def);
      const hostile = cls.some(k => ['removal', 'burn', 'bounce', 'discard', 'sweeper'].includes(k)) && !cls.includes('combat-trick');
      if (hostile && t.flat().length) {
        const mine = t.flat().every(r => (r.kind === 'player' ? r.id : r.kind === 'object' ? findObject(s, r.id)?.controller : undefined) === me);
        if (mine) return false;
        // burn to the face only when it is lethal or nothing else is worth hitting
        if (cls.includes('burn') && !cls.includes('removal') && t.flat().some(r => r.kind === 'player' && r.id === me)) return false;
      }
      if (cls.includes('sweeper')) { const mine = s.players[me].battlefield.filter(isCreature).length, theirs = opponentsOf(s, me).reduce((a, q) => a + s.players[q].battlefield.filter(isCreature).length, 0); if (mine >= theirs) return false; }
    }
    return true;
  }

  /** Multiplayer: attack the opponent that can be killed this turn, else the one with the weakest defence; 2-player: the opponent. */
  attackDeclaration(s: GameState, me: PlayerId, candidates: number[], mustAttack: number[], defenders?: PlayerId[]): { attackers: number[]; targets?: Record<number, PlayerId | { planeswalker: number }> } {
    const opts = defenders && defenders.length > 1 ? defenders : null;
    if (!opts) {
      const attackers = this.attackers(s, me, candidates, mustAttack);
      const opp = primaryOpponent(s, me);
      const walkers = s.players[opp].battlefield.filter(o => o.def.types.includes('Planeswalker'));
      if (!walkers.length || !attackers.length) return { attackers };
      // point attackers at planeswalkers they can finish, unless the swing is lethal on the player
      const total = attackers.reduce((a, id) => a + power(s, findObject(s, id)!), 0);
      if (total >= s.players[opp].life) return { attackers };
      const targets: Record<number, PlayerId | { planeswalker: number }> = {};
      for (const id of attackers) { const o = findObject(s, id)!; const pw = walkers.find(w => (w.counters.loyalty ?? 0) <= power(s, o) && !Object.values(targets).some(t => typeof t === 'object' && t.planeswalker === w.id)); if (pw) targets[id] = { planeswalker: pw.id }; }
      return Object.keys(targets).length ? { attackers, targets } : { attackers };
    }
    const cands = candidates.map(id => findObject(s, id)!).filter(o => o && canAttack(s, o));
    const totalPower = cands.reduce((a, o) => a + power(s, o), 0);
    const defence = (q: PlayerId) => s.players[q].battlefield.filter(o => isCreature(o) && !o.tapped).reduce((a, o) => a + toughness(s, o), 0);
    const lethal = opts.filter(q => s.players[q].life <= totalPower - defence(q));
    const target = lethal.sort((a, b) => s.players[a].life - s.players[b].life)[0] ?? [...opts].sort((a, b) => (defence(a) - defence(b)) || (s.players[a].life - s.players[b].life))[0];
    const attackers = this.attackers(s, me, candidates, mustAttack, target);
    const targets: Record<number, PlayerId> = {}; for (const id of attackers) targets[id] = target;
    return { attackers, targets };
  }

  attackers(s: GameState, me: PlayerId, candidates: number[], mustAttack: number[], against?: PlayerId): number[] {
    const opp = against ?? primaryOpponent(s, me); const O = s.players[opp], P = s.players[me];
    const cands = candidates.map(id => findObject(s, id)!).filter(o => o && canAttack(s, o));
    const blockers = O.battlefield.filter(o => isCreature(o) && !o.tapped);
    const good = (a: GameObject) => {
      const able = blockers.filter(b => canBlock(s, b, a));
      if (!able.length) return true; // evasive or no blockers
      const maxT = Math.max(...able.map(b => toughness(s, b) - b.damage)), maxP = Math.max(...able.map(b => power(s, b)));
      return (power(s, a) >= maxT || hasKeyword(s, a, 'deathtouch')) && (toughness(s, a) > maxP || hasKeyword(s, a, 'first strike') || hasKeyword(s, a, 'indestructible'));
    };
    let set = cands.filter(good);
    // lethal check: everything attacks if unblockable damage would be lethal
    const allPower = cands.map(a => power(s, a)).sort((a, b) => b - a);
    const through = allPower.slice(blockers.length).reduce((x, y) => x + y, 0) + cands.filter(a => !blockers.some(b => canBlock(s, b, a))).map(a => power(s, a)).slice(0, blockers.length).reduce((x, y) => x + y, 0);
    if (through >= O.life) set = cands;
    else if (set.length) {
      // crack-back: would the opponent's swing back be lethal with my remaining untapped blockers?
      const remaining = P.battlefield.filter(o => isCreature(o) && !o.tapped && (!set.includes(o) || hasKeyword(s, o, 'vigilance')));
      const theirs = O.battlefield.filter(o => isCreature(o) && !hasKeyword(s, o, 'defender')).map(o => power(s, o)).sort((a, b) => b - a);
      const back = theirs.slice(remaining.length).reduce((x, y) => x + y, 0);
      if (back >= P.life) set = set.filter(o => hasKeyword(s, o, 'vigilance'));
    }
    return [...new Set([...set.map(o => o.id), ...mustAttack])];
  }

  async blocks(s: GameState, me: PlayerId, attackerIds: number[], candidateIds: number[]): Promise<{ blocker: number; attacker: number }[]> {
    const auto = autoAgent();
    const g = Game.fromState(s, [auto, auto], { quiet: true, seed: 7, fastMana: true, events: 'none' });
    return bestBlocks(s, me, attackerIds, candidateIds, g, 200);
  }
}

export function rolloutAgents(): [RolloutAgent, RolloutAgent] { return [new RolloutAgent('P0'), new RolloutAgent('P1')]; }
