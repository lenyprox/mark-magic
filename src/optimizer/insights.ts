// Turns the games of a run into the report: baseline vs best with a paired comparison, per-swap derivations,
// card contributions (with/without, labelled correlational), keep guidance from opening hands, winning patterns
// (commander by turn, card pairs) and the "check your bulk" list of unregistered cards the best list wants.
import type { Derivation, Estimate } from '../analysis/types.js';
import { wilson } from '../analysis/montecarlo.js';
import type { CardDef } from '../cards/types.js';
import type { FieldDeck } from './evaluator.js';
import type { OptimizerStore } from './store.js';
import type { BulkCheck, Candidate, CardContribution, KeepGuidance, OptimizerReport, OptimizerSpec, PairedComparison, StoredGame, SwapReport, WinningPattern } from './types.js';

const r4 = (x: number) => Math.round(x * 10000) / 10000;

function est(w: number, n: number, seed: number): Estimate { return { value: n ? r4(w / n) : 0, ci95: wilson(w, n).map(r4) as [number, number], method: 'montecarlo', n, seed }; }

function liftCi(w1: number, n1: number, w0: number, n0: number): { lift: number; ci95: [number, number] } {
  if (!n1 || !n0) return { lift: 0, ci95: [0, 0] };
  const p1 = w1 / n1, p0 = w0 / n0; const se = Math.sqrt(p1 * (1 - p1) / n1 + p0 * (1 - p0) / n0);
  return { lift: r4(p1 - p0), ci95: [r4(p1 - p0 - 1.96 * se), r4(p1 - p0 + 1.96 * se)] };
}

export function cardContributions(games: StoredGame[], seed: number, minGames = 8): { rows: CardContribution[]; derivations: Derivation[] } {
  const ok = games.filter(g => !g.error);
  const per = new Map<string, { n: number; w: number }>();
  for (const g of ok) for (const name of new Set([...g.seen[0], ...g.openingHand[0]])) { const e = per.get(name) ?? { n: 0, w: 0 }; e.n++; if (g.winner === 0) e.w++; per.set(name, e); }
  const totalW = ok.filter(g => g.winner === 0).length, totalN = ok.length;
  const rows: CardContribution[] = []; const derivations: Derivation[] = [];
  for (const [name, e] of per) {
    if (e.n < minGames || totalN - e.n < minGames) continue;
    const { lift, ci95 } = liftCi(e.w, e.n, totalW - e.w, totalN - e.n);
    const id = `contrib-${name}`;
    rows.push({ name, withGames: e.n, withWins: e.w, withoutGames: totalN - e.n, withoutWins: totalW - e.w, lift, ci95, derivationId: id });
    derivations.push({ id, method: 'montecarlo', title: `Contribution: ${name}`, formula: 'lift = P(win | card seen) − P(win | card not seen); Wald 95% interval on the difference of two proportions', inputs: [{ name: 'games with card seen', value: e.n }, { name: 'wins with card seen', value: e.w }, { name: 'games without', value: totalN - e.n }, { name: 'wins without', value: totalW - e.w }, { name: 'seed', value: seed }], steps: [{ text: `${e.w}/${e.n} = ${r4(e.w / e.n)} vs ${totalW - e.w}/${totalN - e.n} = ${r4((totalW - e.w) / (totalN - e.n))}` }, { text: `lift ${lift} [${ci95[0]}, ${ci95[1]}]`, value: lift }], result: lift, assumptions: ['correlational: a card is "seen" when it left the library (drawn, tutored, milled); games where it was drawn late count as seen', 'the same games back every card, so contributions are not independent'] });
  }
  rows.sort((a, b) => b.lift - a.lift);
  return { rows, derivations };
}

/** Keep guidance by opening-hand signature (lands in the seven, cheap spells). */
export function keepGuidance(games: StoredGame[], lookup: (name: string) => CardDef | undefined, seed: number): KeepGuidance[] {
  const ok = games.filter(g => !g.error && g.openingHand[0].length);
  const groups = new Map<string, { description: string; n: number; w: number }>();
  for (const g of ok) {
    const hand = g.openingHand[0];
    const lands = hand.filter(n => lookup(n)?.types.includes('Land')).length;
    const cheap = hand.filter(n => { const d = lookup(n); return d && !d.types.includes('Land') && d.manaValue <= 2; }).length;
    const key = `${Math.min(lands, 5)}L${cheap >= 2 ? '+' : cheap === 1 ? '1' : '0'}`;
    const description = `${lands === 5 ? '5+' : lands} land${lands === 1 ? '' : 's'}, ${cheap >= 2 ? 'two or more' : cheap === 1 ? 'one' : 'no'} spell${cheap === 1 ? '' : 's'} costing 2 or less`;
    const e = groups.get(key) ?? { description, n: 0, w: 0 }; e.n++; if (g.winner === 0) e.w++; groups.set(key, e);
  }
  return [...groups].filter(([, e]) => e.n >= 5).map(([signature, e]) => ({ signature, description: e.description, games: e.n, wins: e.w, winRate: est(e.w, e.n, seed) })).sort((a, b) => b.winRate.value - a.winRate.value);
}

/** Winning patterns: commander cast timing and the most win-correlated card pairs. */
export function winningPatterns(games: StoredGame[], spec: OptimizerSpec, maxPairs = 8): WinningPattern[] {
  const ok = games.filter(g => !g.error); const out: WinningPattern[] = [];
  if (!ok.length) return out;
  const totalW = ok.filter(g => g.winner === 0).length;
  const feature = (name: string, description: string, pred: (g: StoredGame) => boolean) => {
    const yes = ok.filter(pred); const w = yes.filter(g => g.winner === 0).length;
    if (yes.length < 5 || ok.length - yes.length < 5) return;
    const { lift, ci95 } = liftCi(w, yes.length, totalW - w, ok.length - yes.length);
    out.push({ feature: name, description, games: yes.length, wins: w, lift, ci95 });
  };
  if (spec.format === 'commander') {
    feature('commander-by-3', 'commander cast by turn 3', g => g.firstCommanderCastTurn[0] !== null && g.firstCommanderCastTurn[0]! <= 3);
    feature('commander-by-5', 'commander cast by turn 5', g => g.firstCommanderCastTurn[0] !== null && g.firstCommanderCastTurn[0]! <= 5);
    feature('commander-never', 'commander never cast', g => g.firstCommanderCastTurn[0] === null);
  }
  feature('no-mulligan', 'kept the first seven', g => g.mulligans[0] === 0);
  feature('on-the-play', 'went first', g => g.seatOrder[g.firstSeat] === 0);
  // card pairs seen together
  const pairs = new Map<string, { n: number; w: number }>();
  for (const g of ok) {
    const seen = [...new Set(g.seen[0])].sort();
    for (let i = 0; i < seen.length; i++) for (let j = i + 1; j < seen.length; j++) { const k = `${seen[i]} + ${seen[j]}`; const e = pairs.get(k) ?? { n: 0, w: 0 }; e.n++; if (g.winner === 0) e.w++; pairs.set(k, e); }
  }
  const scored = [...pairs].filter(([, e]) => e.n >= 8 && ok.length - e.n >= 8).map(([k, e]) => ({ k, e, ...liftCi(e.w, e.n, totalW - e.w, ok.length - e.n) })).filter(x => x.ci95[0] > 0).sort((a, b) => b.lift - a.lift).slice(0, maxPairs);
  for (const x of scored) out.push({ feature: `pair:${x.k}`, description: `both ${x.k} seen`, games: x.e.n, wins: x.e.w, lift: x.lift, ci95: x.ci95 });
  return out;
}

export interface ReportInput {
  spec: OptimizerSpec; store: OptimizerStore; runId: string; baseline: Candidate; best: Candidate; candidates: Candidate[]; swaps: SwapReport[]; paired: PairedComparison | null;
  ownedNames: Set<string>; lookup: (name: string) => CardDef | undefined; field: FieldDeck[]; seconds: number; gamesSimulated: number; gamesReused: number; iterations: number; blocks: number;
}

export function buildReport(inp: ReportInput): OptimizerReport {
  const { spec, store, runId, baseline, best } = inp;
  const bestGames = store.games(runId, best.id); const baseGames = store.games(runId, baseline.id);
  const okBest = bestGames.filter(g => !g.error), okBase = baseGames.filter(g => !g.error);
  const wins = (gs: StoredGame[]) => gs.filter(g => g.winner === 0).length;
  const derivations: Derivation[] = [];
  const winDeriv = (id: string, title: string, gs: StoredGame[], c: Candidate): Derivation => ({ id, method: 'montecarlo', title, formula: `P(win) ≈ wins / games (a game at the turn limit is not a win), Wilson 95%; game i uses seed hashSeed(${spec.seed}, i) and the Latin seat rotation`, inputs: [{ name: 'games', value: gs.length }, { name: 'seed', value: spec.seed }, { name: 'candidate', value: c.id }, { name: 'agent', value: spec.agent }, { name: 'field', value: inp.field.map(f => f.payload.name).join(', ') }], steps: [{ text: `wins ${gs.filter(g => g.winner === 0).length}, draws ${gs.filter(g => g.winner === null).length}, losses ${gs.filter(g => g.winner !== null && g.winner !== 0).length}` }, { text: `reused from the parent list: ${gs.filter(g => g.reusedFrom).length} game(s) whose play never touched the swapped card` }], result: gs.length ? r4(wins(gs) / gs.length) : 0, assumptions: ['both seats follow the batch policy', `a game past turn ${spec.maxTurns} is a draw`, 'unparsed card text is inert'] });
  derivations.push(winDeriv(`win-${baseline.id}`, 'Baseline win rate', okBase, baseline));
  if (best.id !== baseline.id) derivations.push(winDeriv(`win-${best.id}`, 'Best list win rate', okBest, best));
  for (const s of inp.swaps) {
    derivations.push({ id: s.derivationId, method: 'montecarlo', title: `Swap ${s.out} → ${s.in}`, formula: 'paired games: a = candidate wins where the incumbent lost, b = the reverse; delta = (a − b)/n, se = sqrt(a + b − (a − b)²/n)/n; accept when delta − 1.96·se > 0', inputs: [{ name: 'n (paired games)', value: s.comparison.n }, { name: 'a', value: s.comparison.a }, { name: 'b', value: s.comparison.b }, { name: 'reused', value: s.reused, note: 'games inherited from the incumbent' }, { name: 'simulated', value: s.simulated }, { name: 'block', value: s.block }], steps: [{ text: `delta = (${s.comparison.a} − ${s.comparison.b}) / ${s.comparison.n} = ${s.comparison.delta}`, value: s.comparison.delta }, { text: `se = ${s.comparison.se}; 95% [${s.comparison.ci95[0]}, ${s.comparison.ci95[1]}]` }, { text: s.comparison.accepted ? 'accepted (interval above zero)' : 'not accepted' }], result: s.comparison.delta, assumptions: ['a reused game is identical up to the swapped slot because the shuffle permutation is fixed by the seed and the card was never seen', 'the same seeds are played by both lists, so most variance cancels'] });
  }
  const contrib = cardContributions(okBest, spec.seed);
  derivations.push(...contrib.derivations);
  // changes between baseline and best
  const count = (l: { name: string; count: number }[]) => { const m = new Map<string, number>(); for (const e of l) m.set(e.name, (m.get(e.name) ?? 0) + e.count); return m; };
  const b0 = count(baseline.list), b1 = count(best.list);
  const outs: string[] = [], ins: string[] = [];
  for (const [n, c] of b0) { const d = c - (b1.get(n) ?? 0); for (let i = 0; i < d; i++) outs.push(n); }
  for (const [n, c] of b1) { const d = c - (b0.get(n) ?? 0); for (let i = 0; i < d; i++) ins.push(n); }
  const changes = ins.map((inName, i) => ({ out: outs[i] ?? '', in: inName, bulk: !inp.ownedNames.has(inName) }));
  const bulk: BulkCheck[] = [];
  for (const c of changes) if (c.bulk) bulk.push({ name: c.in, reason: 'swap-in', owned: 0 });
  for (const e of best.list) if (!inp.ownedNames.has(e.name) && !bulk.some(b => b.name === e.name)) bulk.push({ name: e.name, reason: 'seed-deck-unowned', owned: 0 });
  const caveats = best.list.map(e => inp.lookup(e.name)).filter((d): d is CardDef => !!d && !d.fullyParsed).map(d => ({ name: d.name, unparsed: d.unparsed.slice(0, 3) }));
  const fieldStats = inp.field.map(f => { const gs = okBest.filter(g => g.opponent.includes(f.payload.name)); return { name: f.payload.name, games: gs.length, wins: gs.filter(g => g.winner === 0).length }; });
  return {
    baseline: { candidateId: baseline.id, list: baseline.list, winRate: est(wins(okBase), okBase.length, spec.seed), games: okBase.length, draws: okBase.filter(g => g.winner === null).length },
    best: { candidateId: best.id, list: best.list, winRate: est(wins(okBest), okBest.length, spec.seed), games: okBest.length, draws: okBest.filter(g => g.winner === null).length, changes, paired: inp.paired },
    swaps: inp.swaps,
    cardContributions: contrib.rows,
    keepGuidance: keepGuidance(okBest, inp.lookup, spec.seed),
    winningPatterns: winningPatterns(okBest, spec),
    bulkCheck: bulk,
    coverageCaveats: caveats,
    budget: { gamesSimulated: inp.gamesSimulated, gamesReused: inp.gamesReused, seconds: Math.round(inp.seconds), iterations: inp.iterations, blocks: inp.blocks },
    derivations,
    field: fieldStats,
  };
}
