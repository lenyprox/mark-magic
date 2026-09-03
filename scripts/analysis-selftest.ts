// Self-test of the odds engine against pinned values. Exit 1 on any mismatch.  Run: npm run analysis:selftest
import fs from 'node:fs';
import { CardDB, loadDeck, parseDeckList } from '../src/cards/db.js';
import { atLeast, choose, multivariateAtLeast, ratio } from '../src/analysis/hypergeom.js';
import { hashSeed } from '../src/analysis/determinize.js';
import { aggregate, runTrials, wilson } from '../src/analysis/montecarlo.js';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import { Game } from '../src/engine/game.js';
import { defTable } from '../src/engine/serialize.js';
import { redact } from '../src/engine/view.js';

let failures = 0;
function check(name: string, ok: boolean, detail = '') { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; }
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

// ---- exact hypergeometric
check('choose(60,7) = 386206920', choose(60, 7) === 386206920n, choose(60, 7).toString());
// exact rationals to 7 places (the plan quotes 0.587930 / 0.857344 / 0.399498; the last is a 2e-6 rounding slip)
check('P(≥3 lands in 7 | 24/60) = 0.5879295', near(atLeast(60, 24, 7, 3), 0.5879295, 1e-7), atLeast(60, 24, 7, 3).toFixed(7));
check('P(≥2 lands in 7 | 24/60) = 0.8573441', near(atLeast(60, 24, 7, 2), 0.8573441, 1e-7), atLeast(60, 24, 7, 2).toFixed(7));
check('P(≥1 of a 4-of in 7 | 60) = 0.3994996', near(atLeast(60, 4, 7, 1), 0.3994996, 1e-7), atLeast(60, 4, 7, 1).toFixed(7));
check('Commander 1-of in 7 from 99 = 7/99', near(atLeast(99, 1, 7, 1), 7 / 99, 1e-12), atLeast(99, 1, 7, 1).toFixed(9));
{
  // multivariate vs brute force: 40 cards, draw 7, classes A=8 (≥2), B=6 (≥1), C=4 (≥1)
  const N = 40, n = 7, A = 8, B = 6, Cc = 4, rest = N - A - B - Cc;
  let hits = 0n;
  for (let a = 2; a <= A; a++) for (let b = 1; b <= B; b++) for (let c = 1; c <= Cc; c++) { const r = n - a - b - c; if (r < 0 || r > rest) continue; hits += choose(A, a) * choose(B, b) * choose(Cc, c) * choose(rest, r); }
  const brute = ratio(hits, choose(N, n));
  const mv = multivariateAtLeast(N, [{ K: A, min: 2 }, { K: B, min: 1 }, { K: Cc, min: 1 }], n);
  check('multivariate = brute force', near(mv, brute, 1e-12), `${mv.toFixed(9)} vs ${brute.toFixed(9)}`);
}
{
  const [lo, hi] = wilson(50, 100);
  check('wilson(50,100) ≈ [0.4038, 0.5962]', near(lo, 0.4038, 5e-4) && near(hi, 0.5962, 5e-4), `[${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
}
// ---- seeds
const PINNED = [hashSeed(12345, 0), hashSeed(12345, 1), hashSeed(12345, 2), hashSeed(12345, 3), hashSeed(12345, 4)];
const EXPECTED = [2371257410, 3770927570, 945481368, 1882883026, 2105598466];
check('hashSeed(12345, 0..4) pinned', PINNED.every((v, i) => v === EXPECTED[i]), PINNED.join(', '));
check('hashSeed never 0', Array.from({ length: 5000 }, (_, i) => hashSeed(i * 7, i)).every(v => v !== 0));

// ---- Monte Carlo reproducibility (needs master.db)
async function mc() {
  if (!fs.existsSync('data/master/master.db')) { console.log('skip Monte Carlo (data/master/master.db missing)'); return; }
  const db = CardDB.shared();
  const lists = ['mono-red-burn', 'mono-green-stompy'].map(f => parseDeckList(fs.readFileSync(`decks/${f}.txt`, 'utf8')));
  const [red, green] = lists.map(l => loadDeck(db, l).cards);
  const entries = lists.map(l => l.cards.filter(c => c.board === 'main').map(c => ({ name: c.name, count: c.count })));
  const g = new Game([red, green], [new RolloutAgent('P0'), new RolloutAgent('P1')], { seed: 3, quiet: true, mulligans: false });
  for (let i = 0; i < 7; i++) { g.draw(0, true); g.draw(1, true); }
  const s = g.state; s.turn = 4; s.activePlayer = 0; s.step = 'main1'; s.priority = 0;
  for (const [p, names] of [[0, ['Mountain', 'Mountain', 'Mountain']], [1, ['Forest', 'Forest', 'Forest']]] as const) for (const n of names) { const c = s.players[p].library.find(o => o.def.name === n) ?? s.players[p].library[0]; g.moveTo(c, 'battlefield'); c.enteredTurn = 1; }
  const view = redact(s, 0);
  const ctx = { snapshot: view, viewer: 0 as const, model: { kind: 'exact' as const, list: entries[1] }, myList: entries[0], defs: defTable([...red, ...green]) };
  const req = { candidateId: 'pass', concrete: { type: 'pass' as const }, trialStart: 0, trialCount: 50, baseSeed: 12345, horizon: 2, policy: 'rollout' as const };
  const t0 = Date.now(); const a = await runTrials(ctx, req); const ms = Date.now() - t0;
  const b = await runTrials(ctx, req);
  check('Monte Carlo: 50 trials, baseSeed 12345, run twice → identical JSON', JSON.stringify(a) === JSON.stringify(b), `${ms} ms for 50 rollouts`);
  const agg = aggregate(a, 12345);
  check('aggregate: n = 50 and Wilson bounds contain the estimate', agg.n === 50 && agg.win.ci95![0] <= agg.win.value && agg.win.value <= agg.win.ci95![1], `win ${agg.win.value} [${agg.win.ci95!.join(', ')}]`);
}

mc().then(() => { console.log(failures ? `${failures} check(s) failed` : 'all checks passed'); process.exit(failures ? 1 : 0); }, e => { console.error(e); process.exit(1); });
