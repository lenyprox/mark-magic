// The quick pass of the analysis panel: legal plays scored one ply deep on a single determinized world, with risks
// from race arithmetic and the "could they have" odds, plus race, could-have and draw-odds reports. Target: < 50 ms.
import type { CardDef } from '../cards/types.js';
import { autoAgent, concreteActions, describeAction, evaluate, simulateAction } from '../ai/search.js';
import { isCreature, isLand } from '../engine/characteristics.js';
import { Game } from '../engine/game.js';
import { legalActions } from '../engine/legal.js';
import { manaSources } from '../engine/mana.js';
import { opponentOf, type GameState, type LegalAction, type PlayerAction, type PlayerId } from '../engine/state.js';
import { isHidden, redact } from '../engine/view.js';
import { couldHaveReport } from './couldHave.js';
import { defByName, determinize, hashSeed, unknownPool } from './determinize.js';
import { drawAtLeastOneBy, hitLandDrop, nextId } from './hypergeom.js';
import { crackback, raceReport } from './raceMath.js';
import type { AnalysisReport, CouldHaveReport, Derivation, DrawOddsReport, Estimate, ListEntry, OpponentModel, PlayAnalysis, Risk } from './types.js';

export interface AnalyzeInput {
  state: GameState; viewer: PlayerId; model: OpponentModel; myList?: ListEntry[]; defs: Map<string, CardDef>;
  baseSeed: number; requestId: string;
  /** candidates kept besides pass (default 4) and simulation budget (default 60) */
  maxCandidates?: number; maxSims?: number;
}

function riskFromClass(ch: CouldHaveReport, cls: 'counterspell' | 'removal' | 'sweeper' | 'combat-trick' | 'burn' | 'discard', text: string): Risk | null {
  const c = ch.classes.find(x => x.cls === cls);
  if (!c || c.prob.value <= 0) return null;
  return { kind: cls, text, prob: c.prob, derivationId: c.derivationId };
}

/** Draw odds for the viewer: land on the next draw / within two draws, and outs per card name still in the library. */
export function drawOdds(s: GameState, viewer: PlayerId, myList: ListEntry[] | undefined, defs: Map<string, CardDef>): DrawOddsReport {
  const lib = s.players[viewer].library; const N = lib.length;
  const derivations: Derivation[] = []; const warnings: string[] = [];
  const knownTopObjs = lib.filter(o => !isHidden(o)); // the redaction leaves the viewer's known top cards visible
  const knownTop = knownTopObjs.map(o => o.def.name);
  if (!myList) { warnings.push('no deck list for you: draw odds need to know what is left in your library'); return { librarySize: N, knownTop, landNext: null, landByNextTurn: null, outs: [], derivations, warnings }; }
  const lookup = defByName(defs);
  const { pool, warnings: w } = unknownPool(s, viewer, myList, viewer); warnings.push(...w);
  const isLandName = (n: string) => lookup(n)?.types.includes('Land') ?? false;
  const K = pool.filter(isLandName).length;
  const kt = { total: knownTop.length, hits: knownTopObjs.filter(isLand).length };
  const Nfull = pool.length + knownTop.length; // the whole library: known top plus the unknown remainder
  if (Nfull !== N) warnings.push(`library has ${N} cards but the list leaves ${Nfull} unaccounted-for: check the list`);
  const est = (r: { p: number; derivation: Derivation }): Estimate => { derivations.push(r.derivation); return { value: r.p, method: r.derivation.method }; };
  const landNext = est(hitLandDrop(Nfull, K + kt.hits, 1, kt));
  const landByNextTurn = est(hitLandDrop(Nfull, K + kt.hits, 2, kt));
  const counts = new Map<string, number>(); for (const n of pool) counts.set(n, (counts.get(n) ?? 0) + 1);
  const outs = [...counts].map(([name, k]) => { const hits = knownTop.filter(n => n === name).length; const r = drawAtLeastOneBy(Nfull, k + hits, 2, { total: kt.total, hits }, name); derivations.push(r.derivation); return { name, prob: { value: r.p, method: r.derivation.method } as Estimate, draws: 2, derivationId: r.derivation.id }; })
    .sort((a, b) => b.prob.value - a.prob.value || a.name.localeCompare(b.name)).slice(0, 12);
  return { librarySize: N, knownTop, landNext, landByNextTurn, outs, derivations, warnings };
}

export async function analyzeQuick(input: AnalyzeInput): Promise<AnalysisReport> {
  const t0 = Date.now();
  const me = input.viewer, opp = opponentOf(me);
  const view = redact(input.state, me);
  const warnings: string[] = [];
  const partialInPlay = [...new Set([...view.players.flatMap(p => [...p.battlefield, ...p.hand]), ...view.stack.map(i => i.source)].filter(o => o && !isHidden(o) && !o.def.fullyParsed).map(o => o.def.name))];
  if (partialInPlay.length) warnings.push(`partially simulated cards in play (their unparsed text is inert): ${partialInPlay.join(', ')}`);
  const auto = autoAgent();
  const legal = legalActions(Game.fromState(view, [auto, auto], { quiet: true }), me);
  const det = determinize(view, { viewer: me, myList: input.myList, opponent: input.model, defs: input.defs, seed: hashSeed(input.baseSeed, 0) });
  warnings.push(...det.warnings);
  const world = Game.fromState(det.state, [auto, auto], { quiet: true, seed: 7, fastMana: true });
  const couldHave = couldHaveReport(view, me, input.model, input.defs);
  const race = raceReport(view, me);
  const draws = drawOdds(view, me, input.myList, input.defs);

  const base = await simulateAction(world, me, { type: 'pass' });
  const baselineScore = base?.score ?? evaluate(det.state, me);
  const heuristicDerivation = (label: string, score: number): Derivation => ({
    id: nextId('h'), method: 'heuristic', title: `One-ply board score: ${label}`,
    formula: 'score = evaluate(board after the action resolves with both players passing) − evaluate(board after passing)',
    inputs: [{ name: 'pass baseline', value: Math.round(baselineScore * 100) / 100 }, { name: 'after action', value: Math.round(score * 100) / 100 }, { name: 'world seed', value: det.seed, note: 'hidden cards sampled once for this pass' }],
    steps: [{ text: `Δ = ${(score - baselineScore).toFixed(2)}`, value: Math.round((score - baselineScore) * 100) / 100 }],
    result: score - baselineScore,
    assumptions: ['a heuristic board evaluation, not a probability', 'the opponent does not respond within this ply'],
  });
  const mkPlay = (l: LegalAction, concrete: PlayerAction, label: string, score: number, after: GameState | null): PlayAnalysis => {
    const risks: Risk[] = []; const derivations: Derivation[] = [heuristicDerivation(label, score)];
    if (after) {
      const cb = crackback(after, me);
      if (cb.lethal) { const d: Derivation = { id: nextId('cb'), method: 'exact', title: 'Lethal crack-back', formula: 'damage through my untapped blockers ≥ my life', inputs: [{ name: 'damage through', value: cb.damageThrough }, { name: 'my life', value: cb.life }], steps: [{ text: cb.text, value: 1 }], result: 1, assumptions: race.assumptions }; derivations.push(d); risks.push({ kind: 'lethal-crackback', text: `after this, ${cb.text}`, prob: { value: 1, method: 'exact' }, derivationId: d.id }); }
      const oppOpenMana = manaSources(view, view.players[opp]).length;
      const castDef = concrete.type === 'cast' ? view.players[me].hand.find(o => o.id === concrete.cardId)?.def : undefined;
      if (castDef && oppOpenMana >= 1) { const r = riskFromClass(couldHave, 'counterspell', `they could counter ${castDef.name} (${oppOpenMana} untapped mana source${oppOpenMana === 1 ? '' : 's'})`); if (r) risks.push(r); }
      if (castDef?.types.includes('Creature')) { const r = riskFromClass(couldHave, 'removal', `${castDef.name} could be removed`); if (r) risks.push(r); }
      if (after.players[me].battlefield.filter(isCreature).length >= 2) { const r = riskFromClass(couldHave, 'sweeper', 'a sweeper would take my board'); if (r) risks.push(r); }
      if (after.players[me].life <= 5) { const r = riskFromClass(couldHave, 'burn', `at ${after.players[me].life} life burn is a threat`); if (r) risks.push(r); }
      if (['declare-attackers', 'declare-blockers'].includes(view.step)) { const r = riskFromClass(couldHave, 'combat-trick', 'a combat trick could swing this combat'); if (r) risks.push(r); }
      if (after.players[me].library.length <= 3) risks.push({ kind: 'decking', text: `${after.players[me].library.length} card(s) left in my library`, prob: { value: 1, method: 'exact' }, derivationId: derivations[0].id });
    }
    return { id: nextId('play'), action: l, concrete, label, evalDelta: Math.round((score - baselineScore) * 100) / 100, risks, derivations, status: 'quick' };
  };

  const passLegal = legal.find(l => l.action.type === 'pass') ?? { action: { type: 'pass' } as PlayerAction, label: 'pass' };
  const baseline = mkPlay(passLegal, { type: 'pass' }, view.stack.length ? `let ${view.stack[view.stack.length - 1].name} resolve` : 'pass', baselineScore, base?.state ?? null);
  const plays: PlayAnalysis[] = [];
  let sims = 0; const cap = input.maxSims ?? 60;
  outer: for (const l of legal) {
    if (l.action.type === 'pass') continue;
    for (const concrete of concreteActions(view, me, l, 4, 30)) {
      if (sims++ >= cap) { warnings.push(`simulation budget reached (${cap}): not every action/target combination was scored`); break outer; }
      const r = await simulateAction(world, me, concrete, l);
      if (!r) continue;
      plays.push(mkPlay(l, concrete, describeAction(view, concrete, l), r.score, r.state));
    }
  }
  plays.sort((a, b) => b.evalDelta - a.evalDelta);
  const seenLabels = new Set<string>();
  const kept = plays.filter(p => !seenLabels.has(p.label) && seenLabels.add(p.label)).slice(0, input.maxCandidates ?? 4); // two copies of a card are one play
  warnings.push(...couldHave.warnings, ...draws.warnings);
  return { requestId: input.requestId, viewer: me, baseSeed: input.baseSeed, generatedAt: new Date().toISOString(), baseline, plays: kept, race, couldHave, draws, quickMs: Date.now() - t0, warnings: [...new Set(warnings)] };
}
