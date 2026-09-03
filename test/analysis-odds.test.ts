// Verifiable odds: hypergeometric numbers, classification, could-have probabilities, race arithmetic, enumeration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard } from '../src/cards/parse.js';
import { atLeast, atMost, between, choose, derive, drawAtLeastOneBy, multivariateAtLeast, onPlayVsDraw, pmf, ratio } from '../src/analysis/hypergeom.js';
import { classify } from '../src/analysis/classify.js';
import { couldHaveReport } from '../src/analysis/couldHave.js';
import { crackback, raceReport } from '../src/analysis/raceMath.js';
import { enumerateBlocks, enumerateResponses } from '../src/analysis/enumeration.js';
import { defTable } from '../src/engine/serialize.js';
import { redact } from '../src/engine/view.js';
import { C, find, inHand, setup } from './helpers.js';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('hypergeom: pinned values', () => {
  assert.equal(choose(60, 7), 386206920n); assert.equal(choose(5, 0), 1n); assert.equal(choose(5, 6), 0n);
  // exact: 0.5879295 / 0.8573441 / 0.3994996 (the plan quotes these rounded to 6 places; its 0.399498 is off by 2e-6)
  close(atLeast(60, 24, 7, 3), 0.5879295, 1e-7);
  close(atLeast(60, 24, 7, 2), 0.8573441, 1e-7);
  close(atLeast(60, 4, 7, 1), 0.3994996, 1e-7);
  close(atLeast(99, 1, 7, 1), 7 / 99);
  close(pmf(60, 24, 7, 0) + between(60, 24, 7, 1, 7), 1);
  close(atMost(60, 24, 7, 2) + atLeast(60, 24, 7, 3), 1);
  close(ratio(1n, 3n), 1 / 3, 1e-15);
});

test('hypergeom: multivariate matches brute force; derivation lists every binomial', () => {
  // 3 classes in a 20-card pool, 6 draws: P(≥1 A, ≥2 B, ≥0 C)
  const N = 20, n = 6, classes = [{ K: 4, min: 1 }, { K: 5, min: 2 }, { K: 3, min: 0 }];
  let hits = 0n, total = 0n;
  const rest = N - 12;
  for (let a = 0; a <= 4; a++) for (let b = 0; b <= 5; b++) for (let c = 0; c <= 3; c++) { const r = n - a - b - c; if (r < 0 || r > rest) continue; const ways = choose(4, a) * choose(5, b) * choose(3, c) * choose(rest, r); total += ways; if (a >= 1 && b >= 2) hits += ways; }
  assert.equal(total, choose(N, n));
  close(multivariateAtLeast(N, classes, n), ratio(hits, total), 1e-12);
  const d = derive({ kind: 'atLeast', N: 60, K: 24, n: 7, k: 3, what: 'lands' });
  close(d.p, 0.5879295, 1e-7);
  assert.ok(d.derivation.steps.some(s => s.text.startsWith('k = 3: C(24, 3) · C(36, 4)')));
  assert.ok(d.derivation.steps.some(s => s.text === 'C(60, 7) = 386206920'));
  assert.equal(d.derivation.method, 'hypergeometric');
  const m = derive({ kind: 'multivariate', N, n, classes: classes.map((c, i) => ({ ...c, name: 'ABC'[i] })) });
  close(m.p, ratio(hits, total), 1e-12);
});

test('hypergeom helpers: known top cards are peeled off first; play vs draw', () => {
  assert.equal(drawAtLeastOneBy(40, 10, 2, { total: 1, hits: 1 }).p, 1);
  close(drawAtLeastOneBy(40, 10, 2, { total: 1, hits: 0 }).p, atLeast(39, 10, 1, 1));
  assert.equal(drawAtLeastOneBy(40, 10, 1, { total: 2, hits: 0 }).p, 0);
  const { play, draw } = onPlayVsDraw(60, 24, 3, 3);
  close(play.p, atLeast(60, 24, 9, 3)); close(draw.p, atLeast(60, 24, 10, 3)); assert.ok(draw.p > play.p);
});

test('classify: AST classes and the oracle-text fallback', () => {
  assert.ok(classify(C('Counterspell')).includes('counterspell'));
  const bolt = classify(C('Lightning Bolt')); assert.ok(bolt.includes('burn') && bolt.includes('removal'));
  assert.ok(classify(C('Doom Blade')).includes('removal'));
  assert.ok(classify(C('Giant Growth')).includes('combat-trick'));
  const wrath = parseCard({ name: 'Wrathlike', oracle_id: 'w', mana_cost: '{2}{W}{W}', mana_value: 4, colors: ['W'], color_identity: ['W'], types: ['Sorcery'], supertypes: [], subtypes: [], type_line: 'Sorcery', oracle_text: 'Destroy all creatures. They can\'t be regenerated.', power: null, toughness: null, loyalty: null, keywords: [], layout: 'normal' });
  wrath.abilities = []; wrath.fullyParsed = false; // force the regex path
  assert.ok(classify(wrath).includes('sweeper'));
  assert.ok(classify(C('Wrath of God')).includes('sweeper'));
  assert.ok(classify(C('Grizzly Bears')).includes('creature'));
  assert.ok(!classify(C('Grizzly Bears')).includes('removal'));
});

test('couldHave: exact list gives 1 − C(U−K,h)/C(U,h); classes sum copies; never reads a sample', () => {
  const g = setup({ bf: ['Mountain'] }, { bf: ['Island', 'Island'], hand: ['Counterspell', 'Island', 'Island'] });
  const view = redact(g.state, 0);
  const list = [{ name: 'Island', count: 10 }, { name: 'Counterspell', count: 4 }, { name: 'Mountain', count: 26 }];
  const defs = defTable([C('Island'), C('Counterspell'), C('Mountain')]);
  const r = couldHaveReport(view, 0, { kind: 'exact', list }, defs);
  assert.equal(r.hiddenHand, 3);
  // seen: 2 Islands on the battlefield (the library is 27 Mountains + hidden; only public zones count)
  assert.equal(r.unknownPool, 40 - 2);
  const cs = r.cards.find(c => c.name === 'Counterspell')!;
  close(cs.prob.value, 1 - ratio(choose(34, 3), choose(38, 3)));
  assert.equal(cs.copiesUnseen, 4);
  const cls = r.classes.find(c => c.cls === 'counterspell')!;
  close(cls.prob.value, cs.prob.value);
  assert.ok(r.derivations.some(d => d.id === cs.derivationId && d.formula.includes('1 − C(U − K, h) / C(U, h)')));
  assert.equal(r.cards.length <= 8, true);
  // no model → empty with a warning; hidden hand of zero → nothing to hold
  assert.equal(couldHaveReport(view, 0, { kind: 'none' }, defs).cards.length, 0);
  const g2 = setup({}, { bf: ['Island'] });
  assert.equal(couldHaveReport(redact(g2.state, 0), 0, { kind: 'exact', list }, defs).hiddenHand, 0);
});

test('couldHave: archetype model mixes over the count distribution', () => {
  const g = setup({}, { bf: ['Island', 'Island'], hand: ['Counterspell', 'Island', 'Island'] });
  const view = redact(g.state, 0);
  const defs = defTable([C('Island'), C('Counterspell'), C('Mountain')]);
  const profile = { id: 'a', format: 'x', name: 'Control', signature: [], metaShare: 0.1, winRate: 0.5, deckCount: 5, deckSize: 40, cards: [
    { name: 'Counterspell', pIn: 0.5, expectedCount: 2, countDist: [0.5, 0, 0, 0, 0.5], board: 'main' as const },
    { name: 'Island', pIn: 1, expectedCount: 12, countDist: [], board: 'main' as const }] };
  const r = couldHaveReport(view, 0, { kind: 'archetype', profile }, defs);
  const U = 40 - 2;
  const cs = r.cards.find(c => c.name === 'Counterspell')!;
  close(cs.prob.value, 0.5 * 0 + 0.5 * atLeast(U, 4, 3, 1));
  assert.equal(r.model, 'archetype');
});

test('race math: clocks and crack-back', () => {
  const g = setup({ bf: ['Leatherback Baloth', 'Kalonian Tusker'], life: 20 }, { bf: ['Grizzly Bears'], life: 10 });
  const r = raceReport(g.state, 0);
  assert.equal(r.mine.unopposed.damagePerTurn, 7); assert.equal(r.mine.unopposed.turns, 2);
  assert.equal(r.mine.blocked.damagePerTurn, 3); assert.equal(r.mine.blocked.turns, 4);
  assert.equal(r.theirs.unopposed.damagePerTurn, 2); assert.equal(r.theirs.unopposed.turns, 10);
  assert.equal(r.theirs.blocked.turns, null);
  assert.equal(r.crackback.lethal, false); assert.equal(r.method, 'exact');
  assert.equal(r.derivation.id, r.derivationId);
  const g2 = setup({ bf: ['Grizzly Bears'], life: 3 }, { bf: ['Leatherback Baloth', 'Kalonian Tusker'] });
  find(g2, 'Grizzly Bears', 0).tapped = true;
  const cb = crackback(g2.state, 0); assert.equal(cb.lethal, true); assert.equal(cb.damageThrough, 7);
});

test('enumeration: every block assignment is simulated; responses from an assumed hand', async () => {
  const g = setup({ bf: ['Leatherback Baloth', 'Kalonian Tusker'] }, { bf: ['Grizzly Bears'], life: 6 });
  const baloth = find(g, 'Leatherback Baloth'), tusker = find(g, 'Kalonian Tusker'), bears = find(g, 'Grizzly Bears');
  g.state.step = 'declare-attackers';
  const e = await enumerateBlocks(g.state, [baloth.id, tusker.id], 0);
  assert.equal(e.assignments, 3); assert.equal(e.truncated, false); assert.equal(e.method, 'exact');
  assert.deepEqual(e.best!.blocks, [{ blocker: bears.id, attacker: baloth.id }]);
  assert.ok(e.best!.evalForViewer < e.noBlocks!.evalForViewer, 'the chump block is worse for the attacker than no block (which is lethal)');
  assert.equal(e.derivation.method, 'exact');
  const g2 = setup({ bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }, { bf: ['Island', 'Island'], hand: ['Serra Angel'] });
  const view = redact(g2.state, 0);
  const r = await enumerateResponses(view, 0, { type: 'cast', cardId: inHand(g2, 'Grizzly Bears', 0).id }, [C('Counterspell')]);
  assert.deepEqual(r.assumedHand, ['Counterspell']);
  const cs = r.responses.find(x => x.card === 'Counterspell')!;
  assert.ok(cs && cs.delta > 0, 'countering the bear is good for the opponent');
  assert.ok(cs.evalForViewer < r.baselineForViewer);
});
