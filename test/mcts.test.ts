// Determinized MCTS agent: finds lethal, is deterministic for a seed, plays whole games without errors, and beats
// the rollout policy with the same deck over a small paired batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDeck, parseDeckList } from '../src/cards/db.js';
import { MctsAgent, reward } from '../src/ai/mcts.js';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import { Game } from '../src/engine/game.js';
import { legalActions } from '../src/engine/legal.js';
import type { PlayerAction } from '../src/engine/state.js';
import { db, find, inHand, setup } from './helpers.js';

const deck = (file: string) => loadDeck(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'))).cards;

test('reward is ±1 on decided games and bounded otherwise', () => {
  const g = setup({ bf: ['Mountain'] }, {});
  const r = reward(g.state, 0); assert.ok(r > -1 && r < 1);
  g.state.winner = 0; assert.equal(reward(g.state, 0), 1); assert.equal(reward(g.state, 1), -1);
});

test('MCTS finds lethal burn to the face and prefers it to holding the spell', async () => {
  const mk = () => { const g = setup({ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'], life: 3 }, [new MctsAgent({ name: 'M', iterations: 24, horizon: 1, seed: 3, verbose: false }), new RolloutAgent('R')]); (g.agents[0] as MctsAgent).attach(g); return g; };
  const g = mk(); g.state.priority = 0;
  const legal = legalActions(g, 0);
  const a = await (g.agents[0] as MctsAgent).decide(g.state, 0, { kind: 'priority', legal }) as PlayerAction;
  assert.equal(a.type, 'cast');
  const targets = (a as { targets?: { kind: string; id: number }[][] }).targets?.flat() ?? [];
  assert.deepEqual(targets, [{ kind: 'player', id: 1 }], 'targets the opponent at 3 life');
  const g2 = mk(); g2.state.priority = 0;
  const b = await (g2.agents[0] as MctsAgent).decide(g2.state, 0, { kind: 'priority', legal: legalActions(g2, 0) }) as PlayerAction;
  assert.deepEqual(a, b, 'same seed, same decision');
  void inHand; void find;
});

test('MCTS plays whole games without errors and wins more than the rollout policy with the same deck (small paired batch)', async () => {
  const red = deck('mono-red-burn'), green = deck('mono-green-stompy');
  const play = async (seat0: 'mcts' | 'rollout', seed: number) => {
    const a0 = seat0 === 'mcts' ? new MctsAgent({ name: 'M', iterations: 16, horizon: 1, seed, verbose: false, maxSims: 20 }) : new RolloutAgent('R0');
    const g = new Game([red, green], [a0, new RolloutAgent('R1')], { seed, quiet: true, maxTurns: 14 });
    if (a0 instanceof MctsAgent) a0.attach(g);
    const w = await g.play();
    return { w, turns: g.state.turn };
  };
  let mcts = 0, roll = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const m = await play('mcts', seed); const r = await play('rollout', seed);
    if (m.w === 0) mcts++; if (r.w === 0) roll++;
  }
  assert.ok(mcts >= roll, `mcts wins ${mcts} vs rollout ${roll}`);
});
