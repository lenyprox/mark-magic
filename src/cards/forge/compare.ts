// The comparator of the Forge cross-check (docs/plans/forge-oracle.md): align one card's shapes on both sides and
// emit findings by category. A finding is a CLAIM TO VERIFY against the printed text, never a verdict — Forge is
// sometimes wrong and its encoding is sometimes just different (two `T:` lines for "attacks or blocks", `Charm` for
// modes, `Effect` + `StaticAbilities$` for "until end of turn"); no confidence number is invented here. The
// calibration run (`npm run forge:diff -- --claimed`, data/master/forge-calibration.json) is the only source of
// per-category precision.
import type { AbilityShape, ShapeClass, TokenShape } from './shape.js';
import { KNOWN_KEYWORD_IDS } from './shape.js';

export const CATEGORIES = [
  'ability-count', 'trigger-kind', 'target-missing', 'target-extra', 'target-optionality', 'may-missing', 'may-extra',
  'token-shape', 'magnitude', 'mode-count', 'keyword-set', 'unless-cost', 'unmatched-forge-ability',
] as const;
export type Category = typeof CATEGORIES[number];

export interface Finding { category: Category; ours: string; forge: string; /** The aligned ability's text (Forge's description, else ours), or the class when neither has one. */ ability: string }

export interface Alignment {
  /** Index pairs into the two shape lists (keyword shapes are never aligned). */
  pairs: { ours: number; forge: number; by: 'text' | 'order'; score: number }[];
  unmatchedForge: number[];
  unmatchedOurs: number[];
}

export interface CompareResult { status: 'agree' | 'disagree'; findings: Finding[]; alignment: Alignment }

const tokensOf = (text: string) => new Set(text.split(' ').filter(Boolean));

/** Token Jaccard of two normalised texts (0 when either is empty). */
export function textJaccard(a: string, b: string): number {
  const ta = tokensOf(a), tb = tokensOf(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const CLASS_ORDER: ShapeClass[] = ['triggered', 'activated', 'spell', 'static', 'replacement'];

/**
 * Greedy best-match by text Jaccard (≥ 0.5; same class preferred at equal score), then class + printed order for
 * what is left. Forge shapes with no partner are `unmatchedForge`.
 */
export function alignShapes(ours: AbilityShape[], forge: AbilityShape[]): Alignment {
  const O = ours.map((s, i) => i).filter(i => ours[i].cls !== 'keyword');
  const F = forge.map((s, i) => i).filter(i => forge[i].cls !== 'keyword');
  const cands: { o: number; f: number; score: number; same: number }[] = [];
  for (const o of O) for (const f of F) {
    const score = textJaccard(ours[o].text, forge[f].text);
    if (score >= 0.5) cands.push({ o, f, score, same: ours[o].cls === forge[f].cls ? 1 : 0 });
  }
  cands.sort((a, b) => b.score - a.score || b.same - a.same || a.o - b.o || a.f - b.f);
  const usedO = new Set<number>(), usedF = new Set<number>();
  const pairs: Alignment['pairs'] = [];
  for (const c of cands) { if (usedO.has(c.o) || usedF.has(c.f)) continue; usedO.add(c.o); usedF.add(c.f); pairs.push({ ours: c.o, forge: c.f, by: 'text', score: c.score }); }
  for (const cls of CLASS_ORDER) {
    const ro = O.filter(i => !usedO.has(i) && ours[i].cls === cls), rf = F.filter(i => !usedF.has(i) && forge[i].cls === cls);
    for (let k = 0; k < Math.min(ro.length, rf.length); k++) { usedO.add(ro[k]); usedF.add(rf[k]); pairs.push({ ours: ro[k], forge: rf[k], by: 'order', score: 0 }); }
  }
  pairs.sort((a, b) => a.forge - b.forge);
  return { pairs, unmatchedForge: F.filter(i => !usedF.has(i)), unmatchedOurs: O.filter(i => !usedO.has(i)) };
}

const fmtTargets = (t: AbilityShape['targets']) => t.length ? t.map(x => `${x.optional ? 'up to ' : ''}${x.max ?? 1} target${(x.max ?? 1) === 1 ? '' : 's'}`).join(', ') : 'no target';
const fmtToken = (t: TokenShape) => `${t.pt ?? '-'} ${t.colors.join('') || 'colorless'} ${[...t.types, ...t.subtypes].join(' ') || '(no type)'}${t.keywords.length ? ' ' + t.keywords.join(', ') : ''}`;
const fmtList = (xs: readonly (string | number)[]) => xs.length ? xs.join(', ') : 'none';
const sameList = (a: readonly (string | number)[], b: readonly (string | number)[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const byToken = (a: TokenShape, b: TokenShape) => (fmtToken(a) < fmtToken(b) ? -1 : fmtToken(a) > fmtToken(b) ? 1 : 0);
const sameToken = (a: TokenShape, b: TokenShape) => a.pt === b.pt && sameList(a.colors, b.colors) && sameList(a.types, b.types) && sameList(a.subtypes, b.subtypes) && sameList(a.keywords, b.keywords);

/**
 * Compare one card. `fullyParsed` (default true) says our side claims the whole card: only then are the count-based
 * categories emitted (`ability-count`, `unmatched-forge-ability`) — on a partly parsed card a missing ability is the
 * parser's known gap, not a disagreement. `--scripted` passes true for every scripted card.
 */
export function compareCard(ours: AbilityShape[], forge: AbilityShape[], opts: { fullyParsed?: boolean } = {}): CompareResult {
  const fullyParsed = opts.fullyParsed ?? true;
  const alignment = alignShapes(ours, forge);
  const findings: Finding[] = [];
  const label = (o: AbilityShape | null, f: AbilityShape | null) => (f?.text || o?.text || `${(f ?? o)?.cls ?? 'ability'} (no text)`).slice(0, 120);
  for (const p of alignment.pairs) {
    const o = ours[p.ours], f = forge[p.forge];
    const ability = label(o, f);
    if (o.trigger && f.trigger && o.trigger.kinds.length && f.trigger.kinds.length && !o.trigger.kinds.some(k => f.trigger!.kinds.includes(k))) {
      findings.push({ category: 'trigger-kind', ours: fmtList(o.trigger.kinds), forge: fmtList(f.trigger.kinds), ability });
    }
    if (f.targets.length && !o.targets.length) findings.push({ category: 'target-missing', ours: fmtTargets(o.targets), forge: fmtTargets(f.targets), ability });
    else if (o.targets.length && !f.targets.length) findings.push({ category: 'target-extra', ours: fmtTargets(o.targets), forge: fmtTargets(f.targets), ability });
    else if (o.targets.length && f.targets.length) {
      const n = Math.min(o.targets.length, f.targets.length);
      for (let i = 0; i < n; i++) if (o.targets[i].optional !== f.targets[i].optional || o.targets[i].max !== f.targets[i].max) { findings.push({ category: 'target-optionality', ours: fmtTargets(o.targets), forge: fmtTargets(f.targets), ability }); break; }
    }
    if (f.optional && !o.optional) findings.push({ category: 'may-missing', ours: 'mandatory', forge: 'you may', ability });
    else if (o.optional && !f.optional) findings.push({ category: 'may-extra', ours: 'you may', forge: 'mandatory', ability });
    if (o.unless !== f.unless) findings.push({ category: 'unless-cost', ours: o.unless ? 'unless … pays' : 'no unless clause', forge: f.unless ? 'unless … pays' : 'no unless clause', ability });
    if (o.tokens.length && f.tokens.length) {
      // as multisets: a Charm's Choices$ order is not the printed order
      const ot = [...o.tokens].sort(byToken), ft = [...f.tokens].sort(byToken);
      const n = Math.min(ot.length, ft.length);
      for (let i = 0; i < n; i++) if (!sameToken(ot[i], ft[i])) { findings.push({ category: 'token-shape', ours: ot.map(fmtToken).join(' | '), forge: ft.map(fmtToken).join(' | '), ability }); break; }
    }
    if (!sameList(o.magnitudes, f.magnitudes)) findings.push({ category: 'magnitude', ours: fmtList(o.magnitudes), forge: fmtList(f.magnitudes), ability });
    if (o.modes !== f.modes && (o.modes !== null || f.modes !== null)) findings.push({ category: 'mode-count', ours: o.modes === null ? 'not modal' : `${o.modes} modes`, forge: f.modes === null ? 'not modal' : `${f.modes} modes`, ability });
  }
  // card-level: keyword sets over the ids both sides can express
  const ok = [...new Set(ours.filter(s => s.cls === 'keyword').flatMap(s => s.keywords))].sort();
  const fk = [...new Set(forge.filter(s => s.cls === 'keyword').flatMap(s => s.keywords).filter(k => KNOWN_KEYWORD_IDS.has(k)))].sort();
  if (!sameList(ok, fk)) findings.push({ category: 'keyword-set', ours: fmtList(ok), forge: fmtList(fk), ability: 'keywords' });
  if (fullyParsed) {
    // an ability this side synthesises from a printed keyword line Forge keeps as a `K:` line (Renown 2, Echo, Evoke, Modular, …) is that keyword, not an extra ability
    const forgeKw = new Set(forge.filter(s => s.cls === 'keyword').flatMap(s => s.keywords));
    const fromKeyword = (s: AbilityShape) => { const w = s.text.split(' '); return s.cls !== 'spell' && w.length <= 4 && (forgeKw.has(w[0]) || forgeKw.has(w.slice(0, 2).join(' '))); };
    for (const cls of ['triggered', 'activated', 'spell', 'static'] as const) {
      const no = ours.filter(s => s.cls === cls && !fromKeyword(s)).length, nf = forge.filter(s => s.cls === cls).length;
      if (no !== nf) findings.push({ category: 'ability-count', ours: `${no} ${cls}`, forge: `${nf} ${cls}`, ability: cls });
    }
    // only an ability with a description can be read against the printed text; a textless Forge line is implementation detail
    for (const i of alignment.unmatchedForge) if (forge[i].text) findings.push({ category: 'unmatched-forge-ability', ours: 'no partner', forge: `${forge[i].cls}: ${forge[i].effects.join(' > ') || '(no chain)'}`, ability: label(null, forge[i]) });
  }
  return { status: findings.length ? 'disagree' : 'agree', findings, alignment };
}
