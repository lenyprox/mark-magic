// Exact enumeration where the space is small: every block assignment against a set of attackers, and every
// instant-speed response an assumed opponent hand could make to an action.
import type { CardDef } from '../cards/types.js';
import { bestBlocksDetailed, describeBlocks, type Block } from '../ai/combat.js';
import { autoAgent, evaluate, pickTargetsHeuristic, simulateAction } from '../ai/search.js';
import { isCreature } from '../engine/characteristics.js';
import { cloneState } from '../engine/clone.js';
import { Game } from '../engine/game.js';
import { legalActions } from '../engine/legal.js';
import { opponentOf, type GameState, type PlayerAction, type PlayerId } from '../engine/state.js';
import { isHidden } from '../engine/view.js';
import { nextId } from './hypergeom.js';
import type { Derivation, Method } from './types.js';

export interface BlockEnumeration {
  attackerIds: number[]; defender: PlayerId;
  assignments: number; truncated: boolean; method: Method;
  /** the defender's best reply, scored from the viewer's side */
  best: { blocks: Block[]; label: string; evalForViewer: number } | null;
  noBlocks: { evalForViewer: number } | null;
  derivation: Derivation;
}

/** Enumerate every block assignment the defender could make and report their best reply from the viewer's side. */
export async function enumerateBlocks(state: GameState, attackerIds: number[], viewer: PlayerId, limit = 3000): Promise<BlockEnumeration> {
  const s = cloneState(state);
  const attacker = s.activePlayer; const defender = opponentOf(attacker);
  const auto = autoAgent();
  const g = Game.fromState(s, [auto, auto], { quiet: true, seed: 7, fastMana: true });
  const candidates = s.players[defender].battlefield.filter(o => isCreature(o) && !o.tapped).map(o => o.id);
  const { blocks, candidates: scored, truncated } = await bestBlocksDetailed(s, defender, attackerIds, candidates, g, limit);
  const sign = viewer === defender ? 1 : -1; // evaluate is antisymmetric
  const bestScore = scored.find(c => c.action.blocks === blocks)?.score;
  const none = scored.find(c => c.action.blocks.length === 0);
  const method: Method = truncated ? 'heuristic' : 'exact';
  const id = nextId('blk');
  const derivation: Derivation = {
    id, method, title: `Best blocks against ${attackerIds.length} attacker${attackerIds.length === 1 ? '' : 's'}`,
    formula: 'every assignment blocker → attacker/none is simulated; the defender picks the assignment with the best board for them',
    inputs: [{ name: 'attackers', value: attackerIds.length }, { name: 'potential blockers', value: candidates.length }, { name: 'assignments simulated', value: scored.length, note: truncated ? `capped at ${limit}: not exhaustive` : 'exhaustive' }],
    steps: scored.slice().sort((a, b) => b.score - a.score).slice(0, 8).map(c => ({ text: `${c.label}: defender eval ${c.score.toFixed(2)}`, value: Math.round(c.score * 100) / 100 })),
    result: bestScore === undefined ? 0 : sign * bestScore,
    assumptions: ['the defender has no combat tricks', 'damage assignment follows the engine (lethal in order, trample excess to the player)'],
  };
  return {
    attackerIds, defender, assignments: scored.length, truncated, method,
    best: bestScore === undefined ? null : { blocks, label: describeBlocks(s, blocks), evalForViewer: sign * bestScore },
    noBlocks: none ? { evalForViewer: sign * none.score } : null, derivation,
  };
}

export interface ResponseOption { card: string; label: string; evalForViewer: number; evalForOpponent: number; delta: number }
export interface ResponseEnumeration { assumedHand: string[]; baselineForViewer: number; responses: ResponseOption[]; derivation: Derivation }

/**
 * With the opponent assumed to hold `assumedHand` (filling their hidden slots in order), what can they do at instant
 * speed right after `action` resolves onto the stack, and how much does each response cost the viewer (1-ply)?
 */
export async function enumerateResponses(state: GameState, viewer: PlayerId, action: PlayerAction, assumedHand: CardDef[]): Promise<ResponseEnumeration> {
  const s = cloneState(state); const opp = opponentOf(viewer);
  const hidden = s.players[opp].hand.filter(isHidden);
  hidden.forEach((o, i) => { if (assumedHand[i]) o.def = assumedHand[i]; });
  const auto = autoAgent();
  const g = Game.fromState(s, [auto, auto], { quiet: true, seed: 7, fastMana: true });
  if (action.type !== 'pass') await g.performAction(viewer, action);
  const baselineForOpp = await (async () => { const r = await simulateAction(g, opp, { type: 'pass' }); return r ? r.score : evaluate(g.state, opp); })();
  const responses: ResponseOption[] = [];
  for (const l of legalActions(g, opp)) {
    if (l.action.type === 'pass' || l.action.type === 'play-land') continue;
    const concrete = pickTargetsHeuristic(g.state, opp, l);
    const r = await simulateAction(g, opp, concrete, l); if (!r) continue;
    const card = l.action.type === 'cast' ? (s.players[opp].hand.find(o => o.id === (l.action as { cardId: number }).cardId)?.def.name ?? '?') : l.label;
    responses.push({ card, label: l.label, evalForOpponent: r.score, evalForViewer: -r.score, delta: r.score - baselineForOpp });
  }
  responses.sort((a, b) => b.delta - a.delta);
  const id = nextId('rsp');
  const derivation: Derivation = {
    id, method: 'exact', title: 'Instant-speed responses with the assumed hand',
    formula: 'each legal response is applied on a clone and the board is re-evaluated (one ply)',
    inputs: [{ name: 'assumed hand', value: assumedHand.map(d => d.name).join(', ') || '(none)' }, { name: 'responses', value: responses.length }],
    steps: responses.slice(0, 8).map(r => ({ text: `${r.label}: opponent eval ${r.evalForOpponent.toFixed(2)} (Δ ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)})`, value: Math.round(r.delta * 100) / 100 })),
    result: responses[0]?.delta ?? 0,
    assumptions: ['the opponent holds exactly the assumed cards in their hidden hand slots', 'targets are chosen heuristically (hostile effects at the viewer’s best objects)'],
  };
  return { assumedHand: assumedHand.map(d => d.name), baselineForViewer: -baselineForOpp, responses, derivation };
}
