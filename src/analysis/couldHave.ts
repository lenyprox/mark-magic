// "What could they have": hypergeometric odds that the opponent's hidden hand holds a given card or class of card,
// from their list (exact) or an archetype profile (mixture over per-card count distributions). This never looks at
// any determinized sample; it only uses public information and the model.
import type { CardDef } from '../cards/types.js';
import { opponentOf, type GameState, type PlayerId } from '../engine/state.js';
import { isHidden, viewInfo } from '../engine/view.js';
import { classify } from './classify.js';
import { defByName, seenCounts, unknownPool } from './determinize.js';
import { atLeast, choose, derive, nextId, ratio } from './hypergeom.js';
import type { CouldHaveReport, Derivation, Estimate, InteractionClass, OpponentModel } from './types.js';

const RISK_CLASSES: InteractionClass[] = ['counterspell', 'removal', 'sweeper', 'combat-trick', 'burn', 'discard', 'bounce'];

export function couldHaveReport(redacted: GameState, viewer: PlayerId, model: OpponentModel, defs: Map<string, CardDef>): CouldHaveReport {
  const opp = opponentOf(viewer);
  const info = viewInfo(redacted, viewer); const h = info.hiddenHand;
  const known = redacted.players[opp].hand.filter(o => !isHidden(o)).map(o => ({ id: o.id, name: o.def.name }));
  const lookup = defByName(defs);
  const derivations: Derivation[] = []; const warnings: string[] = [];
  const empty = (kind: CouldHaveReport['model'], U: number): CouldHaveReport => ({ model: kind, hiddenHand: h, unknownPool: U, cards: [], classes: [], known, derivations, warnings });
  if (model.kind === 'none') { warnings.push('no opponent model: choose their deck or an archetype to see what they could hold'); return empty('none', 0); }

  // per card: remaining copies (exact) or a distribution of remaining copies (archetype)
  type Entry = { name: string; dist: { k: number; w: number }[]; expected: number; classes: InteractionClass[] };
  let U: number; const entries: Entry[] = [];
  const seen = seenCounts(redacted, opp);
  if (model.kind === 'exact') {
    const { pool, warnings: w } = unknownPool(redacted, opp, model.list, viewer); warnings.push(...w); U = pool.length;
    const counts = new Map<string, number>(); for (const n of pool) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const [name, k] of counts) { const d = lookup(name); entries.push({ name, dist: [{ k, w: 1 }], expected: k, classes: d ? classify(d) : [] }); if (!d) warnings.push(`no card definition for ${name}`); }
  } else {
    const prof = model.profile; const seenTotal = [...seen.values()].reduce((a, b) => a + b, 0);
    U = Math.max(h, (prof.deckSize || 60) - seenTotal);
    for (const c of prof.cards) {
      if (c.board !== 'main') continue;
      const sc = seen.get(c.name) ?? 0;
      const raw = c.countDist.length ? c.countDist.map((w, k) => ({ k: Math.max(0, k - sc), w })) : [{ k: 0, w: 1 - c.pIn }, { k: Math.max(0, Math.round(c.expectedCount) - sc), w: c.pIn }];
      const total = raw.reduce((a, d) => a + d.w, 0); if (total <= 0) continue;
      const dist = raw.filter(d => d.w > 0).map(d => ({ k: d.k, w: d.w / total }));
      const expected = dist.reduce((a, d) => a + d.k * d.w, 0);
      if (expected <= 0) continue;
      const d = lookup(c.name);
      entries.push({ name: c.name, dist, expected, classes: d ? classify(d) : [] });
    }
  }
  if (h === 0) { warnings.push('the opponent has no hidden cards in hand'); return empty(model.kind, U); }

  const pHold = (K: number) => (K <= 0 ? 0 : atLeast(U, Math.min(K, U), h, 1));
  const cardEstimate = (e: Entry): { prob: Estimate; derivation: Derivation } => {
    if (e.dist.length === 1) {
      const r = derive({ kind: 'atLeast', N: U, K: Math.min(e.dist[0].k, U), n: h, k: 1, what: e.name, title: `P(they hold ≥1 ${e.name})` });
      r.derivation.formula = `P = 1 − C(U − K, h) / C(U, h)`;
      r.derivation.steps.unshift({ text: `C(${U - Math.min(e.dist[0].k, U)}, ${h}) / C(${U}, ${h}) = ${ratio(choose(U - Math.min(e.dist[0].k, U), h), choose(U, h)).toFixed(6)} chance of none` });
      return { prob: { value: r.p, method: 'hypergeometric' }, derivation: r.derivation };
    }
    let p = 0; const steps: Derivation['steps'] = [];
    for (const d of e.dist) { const pk = pHold(d.k); p += d.w * pk; steps.push({ text: `${d.k} cop${d.k === 1 ? 'y' : 'ies'} unseen with weight ${d.w.toFixed(3)}: P(≥1 in ${h} of ${U}) = ${pk.toFixed(4)}`, value: pk }); }
    steps.push({ text: `weighted sum = ${p.toFixed(6)}`, value: p });
    const derivation: Derivation = { id: nextId('ch'), method: 'hypergeometric', title: `P(they hold ≥1 ${e.name})`, formula: 'P = Σ_k w_k · (1 − C(U − k, h) / C(U, h))', inputs: [{ name: 'U', value: U, note: 'unknown cards (deck size − cards seen)' }, { name: 'h', value: h, note: 'hidden cards in hand' }, { name: 'E[copies unseen]', value: Math.round(e.expected * 100) / 100 }], steps, result: p, assumptions: ['the copy count follows the archetype distribution, minus copies already seen', 'every unknown card is equally likely to be in any hidden position'] };
    return { prob: { value: p, method: 'hypergeometric' }, derivation };
  };

  const cards = entries.map(e => { const { prob, derivation } = cardEstimate(e); derivations.push(derivation); return { name: e.name, prob, copiesUnseen: Math.round(e.expected * 100) / 100, classes: e.classes, derivationId: derivation.id }; })
    .sort((a, b) => b.prob.value - a.prob.value || a.name.localeCompare(b.name));

  const classes = RISK_CLASSES.map(cls => {
    const members = entries.filter(e => e.classes.includes(cls));
    if (!members.length) return null;
    const K = members.reduce((a, e) => a + e.expected, 0);
    const Kint = Math.min(U, Math.round(K));
    const r = derive({ kind: 'atLeast', N: U, K: Kint, n: h, k: 1, what: cls, title: `P(they hold a ${cls})`, assumptions: [`${cls} cards unseen: ${members.map(m => `${m.name} ×${Math.round(m.expected * 100) / 100}`).join(', ')}`, model.kind === 'archetype' ? 'expected copies are rounded to a whole number' : 'every unknown card is equally likely to be in any hidden position'] });
    r.derivation.formula = 'P = 1 − C(U − K, h) / C(U, h), K = copies of the class still unseen';
    derivations.push(r.derivation);
    return { cls, prob: { value: r.p, method: 'hypergeometric' } as Estimate, copiesUnseen: Math.round(K * 100) / 100, derivationId: r.derivation.id };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  return { model: model.kind, hiddenHand: h, unknownPool: U, cards: cards.slice(0, 8), classes, known, derivations, warnings: [...new Set(warnings)] };
}
