// The round-trip renderer (src/cards/render.ts): template coverage, the scoring rules, and the CALIBRATION that
// makes the 0.55 gate meaningful — a seeded sample of 400 cards the PARSER alone finishes, rendered back from the
// parser's own ASTs. If the median of that sample dropped below the gate the gate would be rejecting good scripts,
// and if many cards scored 0 the number rule would be firing on wording rather than on wrong numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard } from '../src/cards/parse.js';
import {
  CORE_OPS, lemmas, numbersIn, printedKeywordLine, renderAbility, renderAmount, renderCondition, renderCost,
  renderEffect, renderFilter, renderStatic, renderTarget, renderTrigger, scoreCard, scoreClaimedLine, scoreRendering,
  vocabularyIn,
} from '../src/cards/render.js';
import { EFFECT_VARIANTS } from '../src/cards/schema.js';
import { discriminators } from '../src/cards/lint.js';
import type { Ability, CardDef } from '../src/cards/types.js';
import { db } from './helpers.js';

test('every core op has a template: CORE_OPS is exactly the schema union', () => {
  const schemaOps = discriminators(EFFECT_VARIANTS, 'op').sort();
  const mine = [...CORE_OPS].sort();
  assert.deepEqual(mine.filter(o => !schemaOps.includes(o)), [], 'CORE_OPS names ops the schema does not have');
  assert.deepEqual(schemaOps.filter(o => !CORE_OPS.has(o)), [], 'a core op has no renderer template — add one to renderEffect and to CORE_OPS');
});

test('effects render as the oracle prints them', () => {
  assert.equal(renderEffect({ op: 'damage', amount: 3, target: { kind: 'any' } }), '~ deals 3 damage to any target');
  assert.equal(renderEffect({ op: 'draw', amount: 1, who: 'you' }), 'you draw a card');
  assert.equal(renderEffect({ op: 'draw', amount: 2, who: 'each-player' }), 'each player draws 2 cards');
  assert.equal(renderEffect({ op: 'destroy', target: { kind: 'creature' }, noRegenerate: true }), "destroy target creature. it can't be regenerated");
  assert.equal(renderEffect({ op: 'counters', target: { kind: 'creature', controller: 'you' }, counter: '+1/+1', amount: 1 }), 'put a +1/+1 counter on target creature you control');
  assert.equal(renderEffect({ op: 'pump', target: 'self', power: 2, toughness: 2, keywords: ['trample'], duration: 'eot' }), '~ gets +2/+2 and gains trample until end of turn');
  assert.equal(renderEffect({ op: 'token', count: 2, power: 1, toughness: 1, colors: ['W'], types: ['Creature'], subtypes: ['Soldier'], keywords: [] }), 'create 2 1/1 white Soldier creature tokens');
  assert.equal(renderEffect({ op: 'sacrifice', who: 'each-opponent', what: { types: ['Creature'] }, amount: 1 }), 'each opponent sacrifices a creature');
});

test('the composition ops render, and `scoped` rebinds "you" for everything under it', () => {
  assert.equal(
    renderEffect({ op: 'for-each', over: { types: ['Creature'], who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] }),
    'for each creature you control, put a +1/+1 counter on that permanent');
  assert.equal(
    renderEffect({ op: 'scoped', who: 'each-opponent', do: [{ op: 'draw', amount: 1, who: 'you' }] }),
    'each opponent draws a card', 'the inner `who: you` is the scoped player, not the controller');
  assert.equal(renderEffect({ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }), 'you may draw a card', 'the subject is printed once, not twice');
  assert.equal(
    renderEffect({ op: 'unless-pays', who: 'target-player', cost: { payLife: 3 }, otherwise: [{ op: 'discard', amount: 1, who: 'you' }] }),
    'target player discards a card unless target player pays pay 3 life');
  assert.equal(renderEffect({ op: 'reflexive', when: 'you-do', effects: [{ op: 'draw', amount: 1, who: 'you' }] }), 'when you do, you draw a card');
  assert.equal(renderEffect({ op: 'bind', as: 'that', from: 'targets' }), '', 'a bind says nothing on the card');
  assert.equal(
    renderEffect({ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'graveyard', who: 'you', count: 1 }, to: 'battlefield', controller: 'you' }),
    'put a creature card from your graveyard onto the battlefield');
  assert.equal(renderEffect({ op: 'set-pt', target: 'that', power: 0, toughness: 1, base: true, duration: 'eot' }), 'that permanent has base power and toughness 0/1 until end of turn');
  assert.equal(renderEffect({ op: 'lose-abilities', target: 'all-creatures', duration: 'eot' }), 'all creatures loses all abilities until end of turn');
  assert.equal(renderEffect({ op: 'exchange', what: 'life', a: 'you', b: { kind: 'opponent' } }), 'you and target opponent exchange life totals');
});

test('triggers, statics, conditions, amounts, targets and costs render', () => {
  assert.equal(renderTrigger({ on: 'etb', self: true }), 'when ~ enters');
  assert.equal(renderTrigger({ on: 'attacks', self: true }), 'whenever ~ attacks');
  assert.equal(renderTrigger({ on: 'upkeep', whose: 'your' }), 'at the beginning of your upkeep');
  assert.equal(renderStatic({ kind: 'anthem', power: 1, toughness: 1, filter: { types: ['Creature'] }, scope: 'you-control' }), 'creature you control get +1/+1');
  assert.equal(renderStatic({ kind: 'self-keywords', keywords: ['flying'] }), '~ has flying');
  assert.equal(renderCondition({ kind: 'metalcraft' }), 'you control three or more artifacts');
  assert.equal(renderCondition({ kind: 'controls', who: 'you', filter: { types: ['Creature'] }, atLeast: 2 }), 'you control 2 or more creatures');
  assert.equal(renderAmount({ count: 'creatures-you-control' }), 'the number of creatures you control');
  assert.equal(renderAmount({ count: 'creatures-you-control', times: 2 }), 'twice the number of creatures you control');
  assert.equal(renderAmount('X'), 'X');
  assert.equal(renderTarget({ kind: 'creature', controller: 'you', optional: true }), 'up to one target creature you control');
  assert.equal(renderTarget({ kind: 'land', count: 2 }), '2 target lands');
  assert.equal(renderFilter({ types: ['Creature'], subtypes: ['Goblin'], other: true, colors: ['R'] }), 'another red Goblin creature');
  assert.equal(renderCost({ mana: { generic: 2, x: 0, pips: ['R'], hybrid: [], phyrexian: [], raw: '{2}{R}' }, tap: true }), '{2}{R}, {T}');
  assert.equal(renderAbility({ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'gain-life', amount: 2, who: 'you' }], text: '' }), 'when ~ enters, you gain 2 life');
});

test('the score: numbers are a hard gate, missing vocabulary halves, otherwise Jaccard', () => {
  assert.equal(scoreRendering('~ deals 3 damage to any target.', '~ deals 3 damage to any target').score, 1);
  const wrongNumber = scoreRendering('~ deals 3 damage to any target.', '~ deals 2 damage to any target');
  assert.equal(wrongNumber.score, 0);
  assert.match(wrongNumber.why ?? '', /does not print 3/);
  const missingKeyword = scoreRendering('Target creature gains flying until end of turn.', 'target creature gains vigilance until end of turn');
  assert.ok(missingKeyword.score > 0 && missingKeyword.score < 0.6, `expected a halved score, got ${missingKeyword.score}`);
  assert.match(missingKeyword.why ?? '', /does not name flying/);
  // a count expression prints as "1 … for each …" or as "X, where X is …": neither number is gated
  assert.ok(scoreRendering('You gain 1 life for each creature you control.', 'you gain the number of creatures you control life').score > 0);
  assert.deepEqual(numbersIn('~ deals 3 damage to any target.'), ['3']);
  assert.deepEqual(numbersIn('~ gets +X/+X until end of turn.'), ['x']);
  assert.deepEqual(numbersIn('Draw a card. (Reminder text with 7 in it.)'), []);
  assert.deepEqual(vocabularyIn('Return target creature card from your graveyard to your hand.').sort(), ['graveyard', 'hand']);
  assert.deepEqual(lemmas('Destroy the creatures, and an artifact.'), ['destroy', 'creature', 'and', 'artifact']);
  // "enters the battlefield" and "enters" are the same event (CR 603.6a templating change), on both sides
  assert.equal(scoreRendering('When ~ enters the battlefield, draw a card.', 'when ~ enters, you draw a card').score, scoreRendering('When ~ enters, draw a card.', 'when ~ enters, you draw a card').score);
});

// ---------------------------------------------------------------------------
// The classes of FALSE FAIL a review found in the 0.55 gate (review fixes 1)
// ---------------------------------------------------------------------------

test('a spelled-out number is a number: on both sides of the comparison AND in the hard gate', () => {
  // the repro: a minimal, behaviourally exact, hand-written script for Divination used to score 0.40 and fail
  const divination: Ability = { kind: 'spell', effects: [{ op: 'draw', amount: 2, who: 'you' }], text: 'Draw two cards.' };
  const good = scoreClaimedLine(divination, 'Draw two cards.');
  assert.ok(good.score >= 0.55, `a correct script for Divination must pass the gate, got ${good.score}`);
  // and the gate now FIRES on the same line, which it could not before: no digit meant no number to miss
  assert.deepEqual(numbersIn('Draw two cards.'), ['2']);
  const wrong: Ability = { kind: 'spell', effects: [{ op: 'draw', amount: 5, who: 'you' }], text: 'Draw two cards.' };
  assert.equal(scoreClaimedLine(wrong, 'Draw two cards.').score, 0, 'draw 5 for "Draw two cards." is a hard zero');
  // "twice the number of" carries the 2 a "+2/+2 for each" line prints
  assert.deepEqual(numbersIn('twice the number of creatures blocking it'), ['2']);
  // "one or more" is an idiom for "any", not a magnitude, and does not gate
  assert.deepEqual(numbersIn('Whenever one or more creatures you control deal combat damage to a player, draw a card.'), []);
});

test('"is put into a graveyard from the battlefield" is "dies" (CR 700.4), on both sides', () => {
  const a: Ability = { kind: 'triggered', event: { on: 'dies', self: true }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: '' };
  const old = scoreClaimedLine(a, 'When ~ is put into a graveyard from the battlefield, draw a card.');
  const now = scoreClaimedLine(a, 'When ~ dies, draw a card.');
  assert.equal(old.score, now.score, 'the two printed forms of one event must score the same');
  assert.ok(old.score >= 0.55, `expected the old wording to pass the gate, got ${old.score}`);
});

test('a printed keyword line is scored on its magnitude, not on word overlap', () => {
  assert.ok(printedKeywordLine('Persist'));
  assert.ok(printedKeywordLine('Crew 3'));
  assert.ok(printedKeywordLine('Cumulative upkeep {U}'));
  assert.ok(printedKeywordLine('Enchant creature'));
  assert.equal(printedKeywordLine('Destroy all creatures.'), false);
  assert.equal(printedKeywordLine('When ~ enters, choose one —'), false, 'a comma makes it a sentence');
  assert.equal(printedKeywordLine('All Slivers have "{2}, Sacrifice ~: Draw a card."'), false);
  // the expansion the parser writes for "Crew 3" shares almost no words with the line, and used to score 0.13
  const crew: Ability = { kind: 'activated', cost: { tapCreaturesTotalPower: { power: 3, other: false } }, effects: [{ op: 'crew-self' }], text: 'Crew 3' } as never;
  assert.equal(scoreClaimedLine(crew, 'Crew 3').score, 1);
  // but the MAGNITUDE is still cross-checked: an ability that crews for 2 fails the line that prints 3
  const wrong = { ...crew, cost: { tapCreaturesTotalPower: { power: 2, other: false } } } as Ability;
  assert.equal(scoreClaimedLine(wrong, 'Crew 3').score, 0);
});

test('a loyalty ability prints no activation boilerplate (CR 606.3), and a subject is printed once', () => {
  const karn: Ability = { kind: 'activated', cost: {}, loyalty: -3, sorcerySpeed: true, oncePerTurn: true, effects: [{ op: 'exile', target: { kind: 'permanent' } }], text: '-3: Exile target permanent.' } as never;
  assert.equal(renderAbility(karn), '-3: exile target permanent');
  assert.equal(scoreClaimedLine(karn, '-3: Exile target permanent.').score, 1);
  const optional: Ability = { kind: 'triggered', optional: true, event: { on: 'etb', self: true }, effects: [{ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }], text: '' };
  assert.equal(renderAbility(optional), 'when ~ enters, you may draw a card');
});

test('no zeroes the oracle does not print: a keyword-only Aura, a noncreature token, an empty fold marker', () => {
  assert.equal(renderStatic({ kind: 'aura', power: 0, toughness: 0, keywords: ['flying'], enchant: { kind: 'creature' } } as never),
    'enchant creature. enchanted creature has flying');
  assert.equal(renderStatic({ kind: 'anthem', power: 0, toughness: 0, keywords: ['hexproof'], filter: { types: ['Permanent'] }, scope: 'you-control' } as never),
    'permanent you control have hexproof');
  assert.equal(renderEffect({ op: 'token', count: 1, power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Clue'], keywords: [], clue: true } as never),
    'create a Clue artifact token');
  // `modes: [[]]` is the parser's fold marker for "It can't be regenerated." — a bullet with nothing in it
  assert.equal(renderEffect({ op: 'choose-mode', count: 1, modes: [[]] } as never), '');
});

test('renderer gaps are reported rather than silently scored down', () => {
  const score = scoreCard({
    name: 'Probe', keywords: [],
    abilities: [{ kind: 'spell', effects: [{ op: 'not-a-real-op' } as never], text: 'Do something strange.' }],
  } as never);
  assert.deepEqual(score.gaps, ['not-a-real-op']);
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** A deterministic xorshift32, so the sample is the same on every machine and every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

/** `n` cards the parser alone finishes, drawn from a fixed shuffle of the whole oracle table. */
function sample(n: number): CardDef[] {
  const rows = db.db.prepare('SELECT json FROM oracle_cards ORDER BY oracle_id').all() as { json: string }[];
  const idx = rows.map((_, i) => i);
  const rnd = seeded(20260905);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const out: CardDef[] = [];
  for (const i of idx) {
    if (out.length >= n) break;
    const raw = JSON.parse(rows[i].json) as Record<string, unknown>;
    const def = parseCard({ ...raw, representative_id: raw.representative_id ?? raw.id ?? null } as never);
    if (def.fullyParsed && def.abilities.length) out.push(def);
  }
  return out;
}

test('calibration: 400 parser-finished cards render back at a median of at least 0.55', () => {
  const scored = sample(400)
    .map(def => ({ def, score: scoreCard(def) }))
    .filter(x => x.score.lines.length);
  assert.ok(scored.length >= 350, `only ${scored.length} of the sample had an ability-claimed line`);
  const sorted = scored.map(x => x.score.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const zeros = sorted.filter(s => s === 0).length;
  const worst = [...scored].sort((a, b) => a.score.score - b.score.score).slice(0, 8).map(x => {
    const l = x.score.lines.reduce((m, y) => (y.score < m.score ? y : m), x.score.lines[0]);
    return `\n    ${x.score.score.toFixed(2)} ${x.def.name}\n      line: ${l.text}\n      rend: ${l.rendered}${l.why ? `\n      why : ${l.why}` : ''}`;
  }).join('');
  assert.ok(median >= 0.55, `median round-trip score ${median.toFixed(3)} over ${sorted.length} cards is below the 0.55 gate. Worst:${worst}`);
  assert.ok(zeros / sorted.length < 0.05, `${zeros}/${sorted.length} (${(100 * zeros / sorted.length).toFixed(1)}%) of the sample scored 0, which must stay under 5%. Worst:${worst}`);
});

/**
 * The FALSE-FAIL RATE, which the median cannot see. A review measured 17.7% of the parser-finished pool below the
 * 0.55 gate while the median sat at 0.864 and this file was green — every one of those cards is a script the agent
 * would be told to fix three times and could not, because the AST was already right and the RENDERER was wrong
 * (spelled-out numbers, the pre-2010 "put into a graveyard from the battlefield" wording, planeswalker activation
 * boilerplate, "+0/+0" on a keyword-only Aura, a 0/0 Clue token, the reminder-text expansion of a printed keyword
 * line, a doubled "you may", `self-pt` printed as a set rather than the bonus the engine applies).
 *
 * With those fixed the rate is 7.1% over the same seeded shuffle, and what is left is the gate doing its job: an AST
 * that really has dropped what the line says (Psionic Blast's second damage clause, Mutant's Prey's fight target,
 * "up to one" printed as "target"). The bound is deliberately close to the measurement — a renderer change that
 * pushes a whole class back under the gate has to be seen here, not discovered by an agent burning its fix budget.
 */
test('calibration: the false-fail rate — cards BELOW the gate — stays under 10% of 1500 parser-finished cards', () => {
  const scored = sample(1500).map(def => scoreCard(def)).filter(s => s.lines.length);
  assert.ok(scored.length >= 1200, `only ${scored.length} of the sample had an ability-claimed line`);
  const below = scored.filter(s => s.score < 0.55);
  const worst = [...below].sort((a, b) => a.score - b.score).slice(0, 10).map(s => {
    const l = s.lines.reduce((m, y) => (y.score < m.score ? y : m), s.lines[0]);
    return `
    ${s.score.toFixed(2)} ${JSON.stringify(l.text)}
      -> ${JSON.stringify(l.rendered)}${l.why ? `
      why: ${l.why}` : ''}`;
  }).join('');
  const rate = below.length / scored.length;
  assert.ok(rate < 0.10, `${below.length}/${scored.length} (${(100 * rate).toFixed(1)}%) of parser-finished cards fall below the 0.55 gate, which must stay under 10%. Worst:${worst}`);
});
