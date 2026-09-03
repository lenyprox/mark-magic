// End-to-end (in-process) version of what the game worker does: DeferredAgent + AnalysisPool + non-cheating AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDeckList } from '../src/cards/db.js';
import { buildDeckPayload, expandPayload } from '../src/play/payload.js';
import { Game } from '../src/engine/game.js';
import { AiAgent } from '../src/ai/ai.js';
import { DeferredAgent } from '../src/engine/agents/deferred.js';
import { redact } from '../src/engine/view.js';
import { defTable } from '../src/engine/serialize.js';
import { AnalysisPool, inlineWorker } from '../src/analysis/pool.js';
import type { AnalysisReport, ListEntry } from '../src/analysis/types.js';
import { db } from './helpers.js';

const listOf = (p: ReturnType<typeof buildDeckPayload>): ListEntry[] => {
  const m = new Map<string, number>();
  for (const e of [...p.main, ...p.commander]) { const d = p.defs[e.key]; if (d) m.set(d.name, (m.get(d.name) ?? 0) + e.count); }
  return [...m].map(([name, count]) => ({ name, count }));
};

test('worker pipeline: analysis reports arrive for the human decisions while a hidden-info AI plays', async () => {
  const burn = buildDeckPayload(db, parseDeckList(fs.readFileSync('decks/mono-red-burn.txt', 'utf8'), 'burn'));
  const stompy = buildDeckPayload(db, parseDeckList(fs.readFileSync('decks/mono-green-stompy.txt', 'utf8'), 'stompy'));
  const defs = defTable([...Object.values(burn.defs), ...Object.values(stompy.defs)]);
  const myList = listOf(burn), oppList = listOf(stompy);
  const pool = new AnalysisPool(() => inlineWorker(), 2);
  await pool.init(defs.values());
  let game!: Game;
  const reports: AnalysisReport[] = [];
  let decisions = 0;
  const human = new DeferredAgent({ name: 'H', ask: async ({ decision }) => {
    decisions++;
    if (decision.kind === 'priority' && decision.legal.some(l => l.action.type === 'cast') && reports.length < 2) {
      const state = redact(game.state, 0);
      const h = pool.analyze({ state, viewer: 0, model: { kind: 'exact', list: oppList }, myList, baseSeed: 4242 }, { trials: 10, chunk: 5, candidates: 2 });
      const quick = await h.quick;
      const done = await h.done;
      reports.push(done);
      assert.ok(quick.plays.length >= 1, 'quick pass lists candidate plays');
      assert.ok(done.plays.some(p => p.winProb && p.winProb.method === 'montecarlo' && p.winProb.n === 10), 'MC estimates with n=10');
      assert.ok(done.couldHave.cards.length > 0); assert.ok(done.draws.landNext);
      for (const p of done.plays) for (const d of p.derivations) { assert.ok(d.formula); assert.ok(d.steps.length > 0); }
      // the report must never leak hidden information: opponent hand cards are not named in the could-have "known" list unless public
      assert.equal(done.couldHave.known.length, 0);
    }
    switch (decision.kind) {
      case 'priority': { const land = decision.legal.find(l => l.action.type === 'play-land'); return land ? land.action : { type: 'pass' }; }
      case 'attackers': return { attackers: decision.candidates };
      case 'blockers': return { blocks: [] };
      case 'choose-cards': return decision.from.slice(0, decision.exact ? decision.count : 0);
      case 'yes-no': return false;
      case 'choose-mode': return [0];
      case 'choose-color': return 'R';
      case 'order-blockers': return decision.blockers;
    }
  } });
  const ai = new AiAgent({ name: 'AI', verbose: false, maxSims: 60, cheat: false, determinizations: 2, seed: 9, defs, myList: oppList, opponentModel: { kind: 'none' } });
  game = new Game([expandPayload(burn), expandPayload(stompy)], [human, ai], { seed: 21, quiet: true, maxTurns: 8, mulligans: false });
  ai.attach(game);
  await game.play();
  assert.ok(decisions > 3);
  assert.ok(reports.length >= 1, 'at least one analysis ran');
  assert.ok(ai.hidden, 'the AI is honest');
  pool.cancel();
});
