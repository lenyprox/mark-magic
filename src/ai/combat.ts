// Block enumeration and the simulate-every-assignment block search, shared by the AI agent, the rollout policy and
// the analysis engine's exact combat enumeration.
import { canBlock, findObject, hasKeyword, name } from '../engine/characteristics.js';
import type { Game } from '../engine/game.js';
import type { GameObject, GameState, PlayerId } from '../engine/state.js';
import { cloneGame, evaluate } from './search.js';

export type Block = { blocker: number; attacker: number };
export interface BlockCandidate { label: string; score: number; action: { blocks: Block[] } }

/** Every legal assignment blocker -> attacker-or-none (menace singles removed), capped at `limit` assignments. */
export function enumerateBlockAssignments(s: GameState, attackers: GameObject[], blockers: GameObject[], limit = 3000): { assignments: Block[][]; truncated: boolean } {
  const legalPairs = new Map<number, number[]>();
  for (const a of attackers) legalPairs.set(a.id, blockers.filter(b => canBlock(s, b, a)).map(b => b.id));
  const assignments: Block[][] = []; let truncated = false;
  const rec = (i: number, cur: Block[]) => {
    if (assignments.length >= limit) { truncated = true; return; }
    if (i === blockers.length) { assignments.push([...cur]); return; }
    rec(i + 1, cur);
    for (const a of attackers) if (legalPairs.get(a.id)!.includes(blockers[i].id)) { cur.push({ blocker: blockers[i].id, attacker: a.id }); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  const menace = attackers.filter(a => hasKeyword(s, a, 'menace')).map(a => a.id);
  const ok = menace.length ? assignments.filter(bl => !menace.some(id => bl.filter(b => b.attacker === id).length === 1)) : assignments;
  return { assignments: ok, truncated };
}

export function describeBlocks(s: GameState, blocks: Block[]): string {
  return blocks.length ? blocks.map(b => `${name(findObject(s, b.blocker)!)}#${b.blocker} → ${name(findObject(s, b.attacker)!)}#${b.attacker}`).join(', ') : 'no blocks';
}

/** Simulate every block assignment on clones of `game` and pick the one with the best board for `me`. */
export async function bestBlocksDetailed(s: GameState, me: PlayerId, attackerIds: number[], candidateIds: number[], game: Game, limit = 3000): Promise<{ blocks: Block[]; candidates: BlockCandidate[]; baseline: number; truncated: boolean }> {
  const candidates: BlockCandidate[] = []; let baseline = evaluate(s, me);
  const attackers = attackerIds.map(id => findObject(s, id)!).filter(o => o && o.zone === 'battlefield');
  const blockers = candidateIds.map(id => findObject(s, id)!).filter(o => o && o.zone === 'battlefield');
  if (!attackers.length || !blockers.length) return { blocks: [], candidates, baseline, truncated: false };
  const { assignments, truncated } = enumerateBlockAssignments(s, attackers, blockers, limit);
  let best: { blocks: Block[]; score: number } | null = null;
  for (const blocks of assignments) {
    const g = cloneGame(game);
    await g.simulateCombat(attackerIds, blocks);
    const score = evaluate(g.state, me);
    if (!blocks.length) baseline = score;
    candidates.push({ label: describeBlocks(s, blocks), score, action: { blocks } });
    if (!best || score > best.score) best = { blocks, score };
  }
  return { blocks: best?.blocks ?? [], candidates, baseline, truncated };
}

export async function bestBlocks(s: GameState, me: PlayerId, attackerIds: number[], candidateIds: number[], game: Game, limit = 3000): Promise<Block[]> {
  return (await bestBlocksDetailed(s, me, attackerIds, candidateIds, game, limit)).blocks;
}
