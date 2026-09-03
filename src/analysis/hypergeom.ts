// Exact hypergeometric probabilities with BigInt arithmetic, and derivations that list every binomial coefficient
// used so a reader can check the number by hand.
import type { Derivation } from './types.js';

const cache = new Map<string, bigint>();

/** C(n, k) exactly. Zero outside 0 <= k <= n. */
export function choose(n: number, k: number): bigint {
  if (k < 0 || k > n || n < 0) return 0n;
  k = Math.min(k, n - k);
  if (k === 0) return 1n;
  const key = `${n},${k}`; const hit = cache.get(key); if (hit !== undefined) return hit;
  let r = 1n;
  for (let i = 1; i <= k; i++) r = r * BigInt(n - k + i) / BigInt(i);
  if (cache.size < 20000) cache.set(key, r);
  return r;
}

/** Exact rational -> double with 15 significant decimals (avoids Number(bigint) overflow for huge counts). */
export function ratio(num: bigint, den: bigint): number { if (den === 0n) return 0; return Number(num * 10n ** 15n / den) / 1e15; }

/** P(X = k) drawing n from N with K successes. */
export function pmf(N: number, K: number, n: number, k: number): number {
  if (k < 0 || k > n || k > K || n - k > N - K) return 0;
  return ratio(choose(K, k) * choose(N - K, n - k), choose(N, n));
}
function sumPmf(N: number, K: number, n: number, lo: number, hi: number): { num: bigint; den: bigint } {
  let num = 0n; const den = choose(N, n);
  for (let k = Math.max(0, lo); k <= Math.min(hi, n, K); k++) num += choose(K, k) * choose(N - K, n - k);
  return { num, den };
}
export function atLeast(N: number, K: number, n: number, k: number): number { const r = sumPmf(N, K, n, k, n); return ratio(r.num, r.den); }
export function atMost(N: number, K: number, n: number, k: number): number { const r = sumPmf(N, K, n, 0, k); return ratio(r.num, r.den); }
export function between(N: number, K: number, n: number, lo: number, hi: number): number { const r = sumPmf(N, K, n, lo, hi); return ratio(r.num, r.den); }

/** P(every class i has at least min_i among n draws), for up to 4 disjoint classes within a population of N. */
export function multivariateAtLeast(N: number, classes: { K: number; min: number }[], n: number): number {
  if (classes.length > 4) throw new Error('multivariateAtLeast supports at most 4 classes');
  const rest = N - classes.reduce((a, c) => a + c.K, 0);
  if (rest < 0) throw new Error('class sizes exceed the population');
  let num = 0n;
  const rec = (i: number, drawn: number, acc: bigint) => {
    if (i === classes.length) { if (n - drawn >= 0 && n - drawn <= rest) num += acc * choose(rest, n - drawn); return; }
    const c = classes[i];
    for (let k = c.min; k <= Math.min(c.K, n - drawn); k++) rec(i + 1, drawn + k, acc * choose(c.K, k));
  };
  rec(0, 0, 1n);
  return ratio(num, choose(N, n));
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------
export type HyperQuery =
  | { kind: 'atLeast' | 'atMost' | 'exact'; N: number; K: number; n: number; k: number; id?: string; title?: string; what?: string; assumptions?: string[] }
  | { kind: 'between'; N: number; K: number; n: number; lo: number; hi: number; id?: string; title?: string; what?: string; assumptions?: string[] }
  | { kind: 'multivariate'; N: number; n: number; classes: { K: number; min: number; name: string }[]; id?: string; title?: string; assumptions?: string[] };

let counter = 0;
export function nextId(prefix = 'd'): string { return `${prefix}${++counter}`; }

/** Probability plus a step-by-step derivation listing every C(a, b). */
export function derive(q: HyperQuery): { p: number; derivation: Derivation } {
  const id = q.id ?? nextId('hg');
  const den = choose(q.N, q.n);
  const steps: Derivation['steps'] = [];
  const inputs: Derivation['inputs'] = [{ name: 'N', value: q.N, note: 'cards in the hidden pool' }, { name: 'n', value: q.n, note: 'cards drawn' }];
  let num = 0n; let formula: string; let title = q.title ?? '';
  if (q.kind === 'multivariate') {
    const rest = q.N - q.classes.reduce((a, c) => a + c.K, 0);
    q.classes.forEach((c, i) => inputs.push({ name: `K${i + 1}`, value: c.K, note: `${c.name} (need ≥ ${c.min})` }));
    formula = `P = Σ ${q.classes.map((c, i) => `C(K${i + 1}, k${i + 1})`).join(' · ')} · C(N − ΣK, n − Σk) / C(N, n) over k${q.classes.length > 1 ? 'ᵢ ≥ minᵢ' : '₁ ≥ min'}`;
    const rec = (i: number, drawn: number, acc: bigint, desc: string[]) => {
      if (i === q.classes.length) { const r = n(q) - drawn; if (r < 0 || r > rest) return; const term = acc * choose(rest, r); num += term; steps.push({ text: `${desc.join(' · ')} · C(${rest}, ${r}) = ${term}`, value: term.toString() }); return; }
      const c = q.classes[i];
      for (let k = c.min; k <= Math.min(c.K, n(q) - drawn); k++) rec(i + 1, drawn + k, acc * choose(c.K, k), [...desc, `C(${c.K}, ${k})`]);
    };
    rec(0, 0, 1n, []);
    title ||= `P(${q.classes.map(c => `≥${c.min} ${c.name}`).join(' and ')} in ${q.n} draws)`;
  } else {
    inputs.push({ name: 'K', value: q.K, note: q.what ? `${q.what} in the pool` : 'successes in the pool' });
    let lo: number, hi: number, label: string;
    if (q.kind === 'between') { lo = q.lo; hi = q.hi; label = `${q.lo}..${q.hi}`; }
    else if (q.kind === 'atLeast') { lo = q.k; hi = q.n; label = `≥ ${q.k}`; }
    else if (q.kind === 'atMost') { lo = 0; hi = q.k; label = `≤ ${q.k}`; }
    else { lo = hi = q.k; label = `= ${q.k}`; }
    formula = `P(X ${label}) = Σ C(K, k) · C(N − K, n − k) / C(N, n)`;
    for (let k = Math.max(0, lo); k <= Math.min(hi, q.n, q.K); k++) {
      if (q.n - k > q.N - q.K) continue;
      const term = choose(q.K, k) * choose(q.N - q.K, q.n - k); num += term;
      steps.push({ text: `k = ${k}: C(${q.K}, ${k}) · C(${q.N - q.K}, ${q.n - k}) = ${term}`, value: term.toString() });
    }
    title ||= `P(${label} ${q.what ?? 'successes'} in ${q.n} draws)`;
  }
  steps.push({ text: `C(${q.N}, ${q.n}) = ${den}`, value: den.toString() });
  const p = ratio(num, den);
  steps.push({ text: `P = ${num} / ${den} = ${p.toFixed(6)}`, value: p });
  return { p, derivation: { id, method: 'hypergeometric', title, formula, inputs, steps, result: p, assumptions: q.assumptions ?? ['every unknown card is equally likely to be in any hidden position'] } };
}
function n(q: HyperQuery) { return q.n; }

// ---------------------------------------------------------------------------
// Helpers for common questions
// ---------------------------------------------------------------------------
/**
 * P(draw at least one of K outs within `draws` draws) when the top `knownTop.total` cards are known and
 * `knownTop.hits` of them are outs: known cards are peeled off as deterministic draws first.
 */
export function drawAtLeastOneBy(N: number, K: number, draws: number, knownTop: { total: number; hits: number } = { total: 0, hits: 0 }, what = 'outs'): { p: number; derivation: Derivation } {
  const seen = Math.min(knownTop.total, draws);
  const hitsSeen = Math.min(knownTop.hits, seen);
  if (hitsSeen > 0) {
    const d: Derivation = { id: nextId('hg'), method: 'exact', title: `P(≥1 ${what} within ${draws} draws)`, formula: 'a known top card is an out', inputs: [{ name: 'known top cards', value: seen }, { name: 'outs among them', value: hitsSeen }], steps: [{ text: `${hitsSeen} of the next ${seen} draws are known ${what}: certain`, value: 1 }], result: 1, assumptions: ['the known top cards are drawn before any unknown card'] };
    return { p: 1, derivation: d };
  }
  const Nu = N - knownTop.total, Ku = K - knownTop.hits, nu = draws - seen;
  if (nu <= 0) { const d: Derivation = { id: nextId('hg'), method: 'exact', title: `P(≥1 ${what} within ${draws} draws)`, formula: 'all draws are known non-outs', inputs: [], steps: [{ text: `the next ${seen} cards are known and none is an ${what.replace(/s$/, '')}`, value: 0 }], result: 0, assumptions: [] }; return { p: 0, derivation: d }; }
  const r = derive({ kind: 'atLeast', N: Nu, K: Ku, n: nu, k: 1, what, title: `P(≥1 ${what} within ${draws} draws)`, assumptions: seen ? [`the top ${seen} card(s) are known and contain no ${what}; the remaining ${nu} draw(s) come from ${Nu} unknown cards`] : undefined });
  return r;
}

/** P(hit a land drop within `draws` draws) — an alias with land wording. */
export function hitLandDrop(N: number, lands: number, draws: number, knownTop: { total: number; hits: number } = { total: 0, hits: 0 }) { return drawAtLeastOneBy(N, lands, draws, knownTop, 'lands'); }

/** P(≥ k of K in the opening 7 plus draws up to turn T) on the play (T − 1 draws) versus on the draw (T draws). */
export function onPlayVsDraw(N: number, K: number, k: number, turn: number, what = 'lands'): { play: { p: number; derivation: Derivation }; draw: { p: number; derivation: Derivation } } {
  const play = derive({ kind: 'atLeast', N, K, n: 7 + Math.max(0, turn - 1), k, what, title: `P(≥${k} ${what} by turn ${turn} on the play)` });
  const draw = derive({ kind: 'atLeast', N, K, n: 7 + Math.max(0, turn), k, what, title: `P(≥${k} ${what} by turn ${turn} on the draw)` });
  return { play, draw };
}
