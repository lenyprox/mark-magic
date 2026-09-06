// The round-trip renderer (src/cards/render.ts): template coverage, the scoring rules, and the CALIBRATION that
// makes the 0.55 gate meaningful — a seeded sample of 400 cards the PARSER alone finishes, rendered back from the
// parser's own ASTs. If the median of that sample dropped below the gate the gate would be rejecting good scripts,
// and if many cards scored 0 the number rule would be firing on wording rather than on wrong numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard } from '../src/cards/parse.js';
import {
  CORE_OPS, CORE_STATIC_KINDS, COUNT_EXPRESSION_RE, lemmas, numbersIn, printedKeywordLine, renderAbility, renderAmount, renderCondition, renderCost,
  declarationCovers, keywordExpansion, keywordProseVariants, renderEffect, renderFilter, renderGaps, renderStatic, renderTarget, renderTrigger,
  renderingsOf, scoreBullets, scoreCard, scoreClaimedLine, scoreRendering, vocabularyIn,
} from '../src/cards/render.js';
import { EFFECT_VARIANTS, STATIC_VARIANTS } from '../src/cards/schema.js';
import type { Amount } from '../src/cards/types.js';
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
  assert.deepEqual(numbersIn('Draw a card. (Reminder text with 7 in it.)'), ['1'], 'the count article is a 1; reminder text is dropped');
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
  assert.deepEqual(numbersIn('Whenever one or more creatures you control deal combat damage to a player, draw a card.'), ['1'], '"one or more" is a quantifier, "a card" is a count of 1');
});

test('"is put into a graveyard from the battlefield" is "dies" (CR 700.4), on both sides', () => {
  const a: Ability = { kind: 'triggered', event: { on: 'dies', self: true }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: '' };
  const old = scoreClaimedLine(a, 'When ~ is put into a graveyard from the battlefield, draw a card.');
  const now = scoreClaimedLine(a, 'When ~ dies, draw a card.');
  assert.equal(old.score, now.score, 'the two printed forms of one event must score the same');
  assert.ok(old.score >= 0.55, `expected the old wording to pass the gate, got ${old.score}`);
});

test('a printed keyword line is scored against what the keyword MEANS, not against the two words it prints', () => {
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
  // the MAGNITUDE is cross-checked: an ability that crews for 2 fails the line that prints 3
  const wrong = { ...crew, cost: { tapCreaturesTotalPower: { power: 2, other: false } } } as Ability;
  assert.equal(scoreClaimedLine(wrong, 'Crew 3').score, 0);
  // the line's parameter goes into the expansion, so the whole rules text is checked against the rendering
  assert.equal(keywordExpansion('Crew 2'), 'tap any number of creatures you control with total power 2 or greater: crew ~');
  assert.equal(keywordExpansion('Echo {2}{R}'), 'at the beginning of your upkeep, sacrifice ~ unless you pay {2}{R}');
  assert.equal(keywordExpansion('Flying'), '~ has flying', 'a simple keyword falls through to what `self-keywords` renders');
  assert.equal(keywordExpansion('Enchant creature'), 'enchant creature');
  assert.equal(keywordExpansion('Whateverwalk'), null, 'a keyword the renderer has no rules text for is a gap, not a pass');
});

/**
 * THE regression this test exists for. `scoreKeywordLine` used to return an unconditional 1.00 for any printed
 * keyword line carrying no digit, and to accept any rendering that merely printed the digit when it did carry one —
 * so an ability that did something else entirely came out `verified`. End to end, through the shipped CLI:
 * `Futurist Sentinel`, whose whole text is "Crew 3", scripted as a draw-three-on-ETB trigger, printed
 * "1 verified … round trip 1.00" and exited 0. The line is now scored against the keyword's RULES TEXT.
 */
test('a printed keyword line needs positive evidence: a wrong ability cannot claim one', () => {
  const draw3: Ability = { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'draw', amount: 3, who: 'you' }], text: 'Crew 3' };
  // the exact repro, magnitude included: "draw 3" prints the 3 that "Crew 3" prints, and used to pass on that alone
  const sentinel = scoreClaimedLine(draw3, 'Crew 3');
  assert.ok(sentinel.score < 0.55, `a draw-3 trigger must not verify "Crew 3", got ${sentinel.score}`);
  assert.match(sentinel.why ?? '', /crew/);
  // and every number-free keyword line the same trigger used to take for free
  for (const line of ['Persist', 'Undying', 'Extort', 'Living weapon', 'Rebound', 'Evolve', 'Myriad', 'Flying']) {
    const s = scoreClaimedLine({ ...draw3, text: line }, line);
    assert.ok(s.score < 0.55, `a draw-3 trigger must not verify "${line}", got ${s.score}`);
  }
  // the same card scored through the whole face, which is what `scripts:verify` gates on
  const card = scoreCard({ name: 'Futurist Sentinel', keywords: [], abilities: [draw3] } as never);
  assert.ok(card.score < 0.55, `the card must fail the 0.55 gate, got ${card.score}`);
  // an ability that really IS the keyword's expansion still passes — this is not a blanket zero
  const persist: Ability = {
    kind: 'triggered', event: { on: 'dies', self: true }, text: 'Persist',
    intervening: { kind: 'self-no-counters', counter: '-1/-1' },
    effects: [{ op: 'return-self-to-battlefield', counters: { counter: '-1/-1', amount: 1 } }],
  } as never;
  assert.ok(scoreClaimedLine(persist, 'Persist').score >= 0.55, 'the real Persist expansion must pass');
});

/**
 * The other half of the evidence rule: a line no ability implements because a DECLARATION does. "Flashback {4}{G}",
 * "Kicker {R}", "Improvise" are `altCosts` / `kicker` / `costModifiers` fields, and the parser hangs them off the
 * spell ability whose text happens to contain them — scoring that ability against them would fail every such card.
 * `COVER_RULES` (scripts.ts) already knows both the line shape and the value the declaration must carry, so
 * `declarationCovers` asks it; without the declaration the line is a fault of the script, and scores 0.
 */
test('a declaration on the face covers its own printed keyword line, and only when it really is declared', () => {
  const flashback = { line: 'Flashback {4}{G}', cost: { mana: { generic: 4, x: 0, pips: ['G'], hybrid: [], phyrexian: [], raw: '{4}{G}' } } };
  const face = { keywords: [], altCosts: [{ id: 'flashback', label: 'flashback {4}{G}', cost: flashback.cost, from: 'graveyard', exileAfter: true }] };
  assert.equal(declarationCovers(face, flashback.line), true);
  assert.equal(declarationCovers({ keywords: [] }, flashback.line), false, 'no altCosts entry, no cover');
  assert.equal(declarationCovers(face, 'Flashback {1}{G}'), false, 'the declared cost has to be the printed one');
  // two substantive effects, so the ability is inside its line budget and really claims both of its lines
  const spell: Ability = {
    kind: 'spell', text: 'Draw a card.\nYou gain 2 life.\nFlashback {4}{G}',
    effects: [{ op: 'draw', amount: 1, who: 'you' }, { op: 'gain-life', amount: 2, who: 'you' }, { op: 'gain-life', amount: 3, who: 'you' }],
  };
  const covered = scoreCard({ name: 'Fb', ...face, abilities: [spell] } as never);
  assert.deepEqual(covered.lines.map(l => l.text), ['Draw a card.', 'You gain 2 life.'], 'the declared line is not the renderer’s business');
  const undeclared = scoreCard({ name: 'Fb', keywords: [], abilities: [spell] } as never);
  const line = undeclared.lines.find(l => l.text === 'Flashback {4}{G}');
  assert.equal(line?.score, 0, 'a face that declares no flashback fails the line it prints');
  assert.match(line?.why ?? '', /DECLARATION/);
  assert.deepEqual(undeclared.gaps, [], 'a missing declaration is a fault of the script, not a renderer gap');
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
  // `modes: [[]]` is the parser's fold marker for "It can't be regenerated." — it prints that sentence, never a bullet
  // with nothing in it (9.1: an empty rendering scored the printed line 0 on every "Destroy … It can't be regenerated.")
  assert.equal(renderEffect({ op: 'choose-mode', count: 1, modes: [[]] } as never), "it can't be regenerated");
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

test('the count article is a magnitude with multiplicity: "a card" / "a 1/1 token" / "a +1/+1 counter" cannot be inflated (8c re-review 2)', () => {
  assert.equal(scoreRendering('Target player draws a card.', 'target player draws 9 cards').score, 0);
  assert.equal(scoreRendering('When this creature dies, create a 1/1 white Spirit creature token with flying.', 'when ~ dies, create 9 1/1 white spirit creature tokens with flying').score, 0);
  assert.equal(scoreRendering('Put a +1/+1 counter on target creature.', 'put 9 +1/+1 counters on target creature').score, 0);
  assert.equal(scoreRendering('Each opponent loses a life.', 'each opponent loses 9 life').score, 0);
  assert.ok(scoreRendering('Target player draws a card.', 'target player draws a card').score > 0.55);
  assert.ok(scoreRendering('Create a 1/1 white Soldier creature token.', 'create a 1/1 white soldier creature token').score > 0.55);
  assert.deepEqual(numbersIn('Create a 1/1 white Soldier creature token.'), ['1', '1', '1']);
});

test("add-mana with a word in `options` renders instead of throwing (8c re-review 2)", () => {
  for (const options of ['chosen-color', 'exiled-with-colors', 'permanent-colors', ['R', 'W']]) {
    const e = { op: 'add-mana', mana: 'any-one', options } as unknown as Parameters<typeof renderEffect>[0];
    assert.doesNotThrow(() => renderEffect(e));
  }
});

test('the printed keyword lines the 10.0 authors hit have rules text: equip, backup, encore, escalate, fortify, compleated, gift', () => {
  for (const line of ['Equip {3}', 'Backup 1', 'Encore {6}{W}{W}', 'Escalate {G}', 'Fortify {3}', 'Compleated', 'Gift a Treasure']) {
    assert.ok(printedKeywordLine(line), `${line} is a printed keyword line`);
    assert.ok(keywordExpansion(line), `${line} has rules text`);
  }
  assert.match(keywordExpansion('Equip {3}')!, /\{3\}: attach ~ to target creature you control/);
  assert.match(keywordExpansion('Gift a Treasure')!, /a treasure/);
});

// ---------------------------------------------------------------------------
// 8c-1: the renderer slice (data/scripts/reports/10.0-run2.json and 10.1-g1-run1.json toolProblems)
// ---------------------------------------------------------------------------

test('A-1: every core static kind has a template, and a static nobody renders is a reported gap', () => {
  const schemaKinds = discriminators(STATIC_VARIANTS, 'kind').sort();
  const mine = [...CORE_STATIC_KINDS].sort();
  assert.deepEqual(mine.filter(k => !schemaKinds.includes(k)), [], 'CORE_STATIC_KINDS names kinds the schema does not have');
  assert.deepEqual(schemaKinds.filter(k => !CORE_STATIC_KINDS.has(k)), [], 'a core static has no renderer template — add one to renderStatic and to CORE_STATIC_KINDS');
  const probe = { kind: 'static', effect: { kind: 'not-a-real-static' }, text: 'x' };
  assert.deepEqual(renderGaps([probe]), ['static:not-a-real-static']);
  assert.deepEqual(renderGaps([{ kind: 'static', effect: { kind: 'anthem', power: 1, toughness: 1, filter: {}, scope: 'all' }, text: 'x' }]), []);
  // the layers family's `type-change` renders through the registry, so it is not a gap either
  assert.deepEqual(renderGaps([{ kind: 'static', effect: { kind: 'type-change', scope: 'self', subtypes: 'chosen-creature-type' }, text: 'x' }]), []);
  // a `kind` that is not a static (a condition, a target spec) is never read as one
  assert.deepEqual(renderGaps([{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'destroy', target: { kind: 'creature' } }], intervening: { kind: 'metalcraft' }, text: 'x' }]), []);
});

test('A-2 / A-3: the `set-pt` static and the layers `type-change` static render as their cards print them', () => {
  assert.equal(
    renderStatic({ kind: 'set-pt', power: 9, toughness: 9, scope: 'enchanted', keywords: ['flying', 'first strike', 'trample', 'haste'] } as never),
    'enchanted creature has base power and toughness 9/9 and has flying, first strike, trample, and haste');
  assert.equal(renderStatic({ kind: 'set-pt', power: 1, toughness: 1, scope: 'you-control', filter: { types: ['Creature'] } } as never), 'creatures you control have base power and toughness 1/1');
  assert.equal(renderStatic({ kind: 'type-change', scope: 'all', filter: { types: ['Land'] }, subtypes: ['Swamp'] } as never), 'each land is a Swamp in addition to its other types');
  assert.equal(renderStatic({ kind: 'type-change', scope: 'self', subtypes: 'chosen-creature-type' } as never), '~ is the chosen type in addition to its other types');
  assert.equal(renderStatic({ kind: 'type-change', scope: 'self', subtypes: 'chosen-basic-land-type' } as never), '~ is the chosen type', 'a land of the chosen basic type is only that type (CR 305.7)');
  assert.equal(renderStatic({ kind: 'type-change', scope: 'you-control', filter: { types: ['Creature'] }, everyCreatureType: true } as never), 'creatures you control are every creature type');
});

test('A-4 / A-5 / A-6: every amount form takes the modifiers, prints what it counts, and matches COUNT_EXPRESSION_RE', () => {
  assert.equal(renderAmount({ sum: ['X'], times: 5 }), '5 times the total of X', 'Crackle with Power: the printed 5 reaches the gate');
  assert.equal(renderAmount({ diff: ['X', 2], plus: 1 }), 'the difference between X and 2 plus 1');
  assert.equal(renderAmount({ prop: 'power', of: 'that', half: 'up' }), "half that permanent's power, rounded up");
  assert.equal(renderAmount({ prop: 'life', of: 'you' }), 'your life total');
  assert.equal(renderAmount({ prop: 'power', agg: 'max', over: { types: ['Creature'], who: 'you' } }), 'the greatest power among creature you control');
  assert.equal(renderAmount({ prop: 'mv', agg: 'sum', over: { types: ['Artifact'], who: 'you' } }), 'the total mana value of artifact you control');
  assert.equal(renderAmount({ count: 'counters-on-permanents', filter: { types: ['Land'] }, counter: '+1/+1' }), 'the number of +1/+1 counters on lands you control', 'Toph');
  assert.equal(renderAmount({ count: 'counters-on-source', counter: 'charge' }), 'the number of charge counters on ~', 'Everflowing Chalice');
  assert.equal(renderAmount({ count: 'that-many' }), 'that many');
  // every shape renderAmount can emit is a computed magnitude the exemption must see
  const forms: Amount[] = [
    { count: 'creatures-you-control' }, { count: 'creatures-you-control', times: 2 }, { count: 'creatures-you-control', times: 3 },
    { count: 'cards-in-hand', half: 'down' }, { count: 'objects', filter: { types: ['Elf'] }, zone: 'graveyard' }, { count: 'that-many' },
    { prop: 'power', of: 'that' }, { prop: 'toughness', of: 'enchanted' }, { prop: 'mv', of: 'that' }, { prop: 'life', of: 'target-player' }, { prop: 'cards-in-hand', of: 'you' },
    { prop: 'power', agg: 'max', over: { types: ['Creature'] } }, { prop: 'toughness', agg: 'sum', over: { types: ['Creature'], who: 'you' } }, { prop: 'mv', agg: 'min', over: {} },
    { diff: ['X', 1] }, { sum: ['X', 2] }, { max: ['X', 3] }, { min: [1, 'X'] }, { sum: ['X'], times: 5 }, { diff: [{ prop: 'power', of: 'that' }, { prop: 'toughness', of: 'that' }] },
  ];
  for (const f of forms) assert.match(renderAmount(f), COUNT_EXPRESSION_RE, JSON.stringify(f));
  assert.doesNotMatch('~ deals 3 damage to any target', COUNT_EXPRESSION_RE);
  // Doran: a `prop` difference is a computed magnitude, so the X the line prints is exempt from the hard gate
  const doran = scoreRendering('It gets +X/+X until end of turn, where X is the difference between its power and toughness.',
    "that permanent gets +X/+X, where X is the difference between that permanent's power and that permanent's toughness until end of turn");
  assert.ok(doran.score >= 0.55, `expected the X to be exempt, got ${doran.score} (${doran.why})`);
  // a plain "5 times X" still hard-gates on the 5
  assert.equal(scoreRendering('~ deals five times X damage to any target.', '~ deals the total of X damage to any target').score, 0);
  assert.ok(scoreRendering('~ deals five times X damage to any target.', '~ deals 5 times the total of X damage to any target').score > 0.55);
});

test('the P/T bonus forms: "+1/+1 for each …" for the parser\'s count shape, "+X/+Y, where …" for anything else computed', () => {
  const each = { count: 'creatures-you-control', plus: 0 } as Amount;
  assert.equal(renderStatic({ kind: 'self-pt', power: each, toughness: each } as never), '~ gets +1/+1 for each creatures you control');
  assert.equal(renderStatic({ kind: 'self-pt', power: { count: 'lands-you-control', times: 2 }, toughness: { count: 'lands-you-control', times: 2 } } as never), '~ gets +2/+2 for each lands you control');
  assert.equal(renderStatic({ kind: 'self-pt', power: { count: 'creatures-you-control', filter: { subtypes: ['Goblin'] } }, toughness: 0 } as never), '~ gets +1/+0 for each Goblins you control');
  assert.equal(renderEffect({ op: 'pump', target: 'self', power: { diff: ['X', 1] }, toughness: { diff: ['X', 1] }, duration: 'eot' } as never), '~ gets +X/+X, where X is the difference between X and 1 until end of turn');
  assert.equal(renderEffect({ op: 'pump', target: 'self', power: 2, toughness: { count: 'cards-in-hand', plus: 1 }, duration: 'eot' } as never), '~ gets +2/+X, where X is the number of cards in your hand plus 1 until end of turn');
  // a parser "for each" card now scores its own line back at 1
  assert.equal(scoreClaimedLine({ kind: 'static', effect: { kind: 'self-pt', power: each, toughness: each }, text: '~ gets +1/+1 for each creature you control.' } as never, '~ gets +1/+1 for each creature you control.').score, 1);
});

test('a NEGATIVE bonus keeps its sign: "-1/-1 for each …", "-X/-X" (8c-1 review: these printed "+-1/+-1" and "+X/+X")', () => {
  const swamps = (times: number) => ({ count: 'permanents-you-control', filter: { subtypes: ['Swamp'] }, times });
  assert.equal(renderEffect({ op: 'pump', target: 'all-creatures', power: swamps(-1), toughness: swamps(-1), duration: 'eot' } as never), 'all creatures gets -1/-1 for each Swamps you control until end of turn', 'Mutilate');
  assert.equal(renderStatic({ kind: 'self-pt', power: { count: 'cards-in-hand', times: -4 }, toughness: { count: 'cards-in-hand', times: -4 } } as never), '~ gets -4/-4 for each cards in your hand', 'Dread Slag');
  assert.equal(renderEffect({ op: 'pump', target: { kind: 'creature' }, power: swamps(-1), toughness: 0, duration: 'eot' } as never), 'target creature gets -1/+0 for each Swamps you control until end of turn');
  // the parser's negated X (`pm`: `{ sum: ['X'], times: -1 }`) is the printed "-X"
  const negX = { sum: ['X'], times: -1 };
  assert.equal(renderEffect({ op: 'pump', target: { kind: 'creature' }, power: negX, toughness: negX, duration: 'eot' } as never), 'target creature gets -X/-X until end of turn', 'Death Wind');
  assert.equal(renderEffect({ op: 'pump', target: { kind: 'creature' }, power: negX, toughness: 0, duration: 'eot' } as never), 'target creature gets -X/+0 until end of turn');
  assert.equal(renderEffect({ op: 'pump', target: { kind: 'creature' }, power: 'X', toughness: negX, duration: 'eot' } as never), 'target creature gets +X/-X until end of turn');
  for (const r of [renderStatic({ kind: 'self-pt', power: swamps(-1), toughness: swamps(-1) } as never), renderEffect({ op: 'pump', target: 'self', power: negX, toughness: { count: 'cards-in-hand', times: -1 }, duration: 'eot' } as never)]) {
    assert.doesNotMatch(r, /\+-|undefined|\[object/, r);
  }
});

test('a ±1 "for each" bonus is read both ways — "+1/+1 for each Elf" and "+X/+X, where X is the number of Elves" share one AST', () => {
  const elves = { count: 'permanents-on-battlefield', filter: { subtypes: ['Elves'] } };
  const pump = { kind: 'spell', effects: [{ op: 'pump', target: { kind: 'creature' }, power: elves, toughness: elves, duration: 'eot' }], text: '' } as never;
  const both = renderingsOf(pump);
  assert.ok(both.includes('target creature gets +1/+1 for each Elvess on the battlefield until end of turn'), both.join(' | '));
  assert.ok(both.includes('target creature gets +X/+X, where X is the number of Elvess on the battlefield until end of turn'), both.join(' | '));
  // Wirewood Pride (0.58 → 0.47 in the first 8c-1 cut) and a "+1/+1 for each" line both pass through the same AST
  assert.ok(scoreClaimedLine(pump, 'Target creature gets +X/+X until end of turn, where X is the number of Elves on the battlefield.').score >= 0.8);
  assert.ok(scoreClaimedLine(pump, 'Target creature gets +1/+1 until end of turn for each Elf on the battlefield.').score >= 0.8);
  // the second reading is confined to that shape: a ±4 bonus and a plain pump render once
  assert.equal(renderingsOf({ kind: 'spell', effects: [{ op: 'pump', target: 'self', power: { ...elves, times: 4 }, toughness: { ...elves, times: 4 }, duration: 'eot' }], text: '' } as never).length, 2);
  assert.equal(renderEffect({ op: 'pump', target: 'self', power: 2, toughness: 2, duration: 'eot' } as never), '~ gets +2/+2 until end of turn');
  // and a negative one: Silvergill Douser's "-X/-0 … where X is the number of Merfolk and/or Faeries you control"
  const merfolk = { count: 'permanents-you-control', filter: { subtypes: ['Merfolk', 'Faerie'] }, times: -1 };
  assert.ok(renderingsOf({ kind: 'spell', effects: [{ op: 'pump', target: { kind: 'creature' }, power: merfolk, toughness: 0, duration: 'eot' }], text: '' } as never)
    .includes('target creature gets -X/+0, where X is the number of Merfolk Faeries you control until end of turn'));
});

test("computed magnitudes never print as an object: scry / surveil X, \"up to X target lands, where X is …\", a keyword action's X", () => {
  const verse = { count: 'counters-on-source', counter: 'verse' };
  assert.equal(renderEffect({ op: 'surveil', amount: { count: 'permanents-you-control', filter: { tapped: true, subtypes: ['Assassin'] } } } as never), 'surveil the number of tapped Assassins you control', 'Lydia Frye');
  assert.equal(renderEffect({ op: 'scry', amount: 2 } as never), 'scry 2');
  assert.equal(renderTarget({ kind: 'land', count: verse, optional: true } as never), 'up to X target lands, where X is the number of verse counters on ~', 'Rumbling Crescendo');
  assert.equal(renderTarget({ kind: 'creature', count: 2, optional: true } as never), 'up to 2 target creatures');
  // keyword actions print a computed amount as "X, where X is …": the line prints the X and the words, so does the rendering
  const gremlin = { kind: 'triggered', event: { on: 'dies', self: true }, effects: [{ op: 'incubate', amount: { count: 'power-of-source' } }], text: '' } as never;
  assert.equal(renderAbility(gremlin), "when ~ dies, Incubate X, where X is ~'s power");
  assert.ok(scoreClaimedLine(gremlin, 'When ~ dies, incubate X, where X is its power.').score >= 0.55, 'Furnace Gremlin / Bloated Processor');
  assert.equal(renderEffect({ op: 'bolster', amount: 2 } as never), 'Bolster 2');
  assert.equal(renderEffect({ op: 'adapt', amount: 'X' } as never), 'Adapt X');
});

test('A-7 / A-8: return-from-graveyard prints count and optional; move discriminates a TargetSpec first and never prints undefined', () => {
  const plain = { op: 'return-from-graveyard', what: { types: ['Creature'] }, to: 'battlefield', target: true, tapped: true };
  assert.equal(renderEffect(plain as never), 'return target creature card from your graveyard to the battlefield tapped');
  assert.equal(renderEffect({ ...plain, count: 2 } as never), 'return 2 target creature cards from your graveyard to the battlefield tapped', 'Victimize');
  assert.equal(renderEffect({ ...plain, what: { notTypes: ['Instant', 'Sorcery'] }, count: 2, optional: true } as never), 'return up to 2 target permanent cards from your graveyard to the battlefield tapped', 'Brought Back');
  assert.equal(renderEffect({ ...plain, count: 1, optional: true, to: 'hand' } as never), 'return up to one target creature card from your graveyard to your hand');
  const excava = { op: 'move', to: 'battlefield', controller: 'you', withCounters: { counter: 'finality', amount: 1 }, what: { kind: 'graveyard-card', who: 'you', optional: true, count: 1, filter: { types: ['Artifact', 'Creature', 'Enchantment'], notSubtypes: ['Aura'], mvLE: 3 } } };
  const r = renderEffect(excava as never);
  assert.equal(r, 'return up to one target non-Aura artifact, creature, or enchantment card with mana value 3 or less from your graveyard onto the battlefield with a finality counter on it');
  assert.doesNotMatch(r, /undefined/);
  // the chosen-set form is byte-identical to what it always rendered
  assert.equal(renderEffect({ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'graveyard', who: 'you', count: 1 }, to: 'battlefield', controller: 'you' }), 'put a creature card from your graveyard onto the battlefield');
  assert.equal(renderTarget({ kind: 'graveyard-card', who: 'you', count: 99, optional: true }), 'up to 99 target cards from your graveyard');
});

test('A-9: add-mana prints its restriction, its sticky rider and a bare "for each" count; fold-restriction prints its sentence', () => {
  assert.equal(renderEffect({ op: 'add-mana', mana: 'any', amount: 1, restriction: 'instant-sorcery' } as never), 'add one mana of any color. spend this mana only to cast an instant or sorcery spell', 'Great Hall of the Biblioplex');
  assert.equal(renderEffect({ op: 'add-mana', mana: ['R'], sticky: true } as never), "add {R}. until end of turn, you don't lose this mana as steps and phases end", 'Birgi');
  assert.equal(renderEffect({ op: 'add-mana', mana: ['U'], perEach: { count: 'cards-drawn-this-turn' } } as never), 'add {U} for each cards you have drawn this turn', 'Immortus');
  assert.equal(renderEffect({ op: 'fold-restriction', restriction: 'creature-spell', text: '' } as never), 'spend this mana only to cast a creature spell');
});

test('A-10: exploit / embalm / eternalize / fuse / ward have rules text; "Equip Wizard {1}" and "Craft with artifact {2}" are keyword lines with synthesised text', () => {
  for (const line of ['Exploit', 'Embalm {3}{U}{U}', 'Eternalize {5}{B}{B}', 'Fuse', 'Ward {2}', 'Equip Wizard {1}', 'Craft with artifact {2}{G}', 'Plainscycling {2}']) {
    assert.ok(printedKeywordLine(line), `${line} is a printed keyword line`);
    assert.ok(keywordExpansion(line), `${line} has rules text`);
  }
  assert.equal(keywordExpansion('Equip Wizard {1}'), '{1}: attach ~ to target Wizard creature you control. activate only as a sorcery');
  assert.match(keywordExpansion('Embalm {3}{U}{U}')!, /^\{3\}\{U\}\{U\}, exile ~ from your graveyard: create a token that is a copy of ~, except it is a white Zombie/);
  assert.match(keywordExpansion('Craft with artifact {2}{G}')!, /exile artifact you control and\/or artifact cards from your graveyard: return ~ transformed/);
  assert.equal(printedKeywordLine('Destroy Target Creature'), false, 'two capitalised continuations are prose');
  // Overcharged Amalgam: the family's exploit op now prints the rules text the keyword line is scored against
  const amalgam = { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'exploit' }], text: 'Exploit' } as never;
  assert.ok(scoreClaimedLine(amalgam, 'Exploit').score >= 0.55, `got ${scoreClaimedLine(amalgam, 'Exploit').score}`);
  assert.equal(renderTrigger({ on: 'exploits', self: true } as never), 'when ~ exploits a creature', 'a family trigger renders through its `trigger:<on>` entry');
});

test('A-11: trigger-twice prints its filter / equipped flag / event; extra-mana-on-tap prints the controller form for a filter', () => {
  assert.equal(renderStatic({ kind: 'trigger-twice', equipped: true } as never), 'if a triggered ability of equipped creature triggers, that ability triggers an additional time');
  assert.equal(renderStatic({ kind: 'trigger-twice', filter: { types: ['Creature'], chosenType: true } } as never), 'if a triggered ability of of the chosen type creature you control triggers, that ability triggers an additional time');
  assert.equal(renderStatic({ kind: 'trigger-twice', event: 'land-etb' } as never), 'if a land entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time');
  assert.equal(renderStatic({ kind: 'extra-mana-on-tap', filter: { subtypes: ['Forest'] }, mana: ['G'] } as never), 'whenever you tap Forest for mana, add an additional {G}');
  assert.equal(renderStatic({ kind: 'extra-mana-on-tap', enchanted: true, mana: 'chosen-color' } as never), 'whenever enchanted permanent is tapped for mana, its controller adds an additional one mana of the chosen color');
  // Nissa: the parser's own AST for the line it parses today clears the gate
  const nissa = { kind: 'static', effect: { kind: 'extra-mana-on-tap', filter: { subtypes: ['Forest'] }, mana: ['G'] }, text: 'Whenever you tap a Forest for mana, add an additional {G}.' } as never;
  assert.ok(scoreClaimedLine(nissa, 'Whenever you tap a Forest for mana, add an additional {G}.').score >= 0.55);
});

test('A-12: family cost parts print through their templates, and an unknown part still prints every number it carries', () => {
  assert.equal(renderCost({ mana: { generic: 3, x: 0, pips: ['B'], hybrid: [], phyrexian: [], raw: '{3}{B}' }, tap: true, sacrificeMany: { filter: { types: ['Creature'] }, count: 2 } } as never), '{3}{B}, {T}, sacrifice 2 creatures', "Grim Reaper's Scythe");
  assert.equal(renderCost({ mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' }, exileSelf: true } as never), '{2}, exile ~', 'Perpetual Timepiece');
  assert.equal(renderCost({ exileSelfFromGraveyard: true } as never), 'exile ~ from your graveyard');
  assert.equal(renderCost({ exileFromGraveyardMatching: { count: 3, filter: { types: ['Creature'] } } } as never), 'exile 3 creature cards from your graveyard');
  assert.equal(renderCost({ collectEvidence: 6 } as never), 'collect evidence 6');
  assert.equal(renderCost({ somethingNew: { nested: { count: 4 }, list: [7] } } as never), 'somethingNew 4 7');
});

test('A-13 / A-14 / A-15: existential articles, non-mana ward, supertypes, another/other, and family helpers', () => {
  assert.deepEqual(numbersIn('At the beginning of each end step, if a card left your graveyard this turn, create a Treasure token.'), ['1'], 'the article after "if" is existential');
  assert.deepEqual(numbersIn('Whenever a Treasure token enters, draw a card.'), ['1']);
  assert.deepEqual(numbersIn('If you do, draw a card.'), ['1'], 'an article not adjacent to the conjunction is still a count');
  assert.deepEqual(vocabularyIn('Ward—Get five poison counters.'), ['poison counter'], 'a non-mana ward line does not demand the word ward');
  assert.deepEqual(vocabularyIn('Ward {2}'), ['ward']);
  assert.equal(renderFilter({ supertypes: ['Legendary'], types: ['Creature'] }), 'legendary creature');
  assert.equal(renderFilter({ types: ['Artifact', 'Creature'] }), 'artifact or creature');
  // a COUNTED filter lists its types with "and" (Toil to Renown), a type listed twice is one noun (Perilous Predicament)
  assert.equal(renderAmount({ count: 'permanents-you-control', filter: { tapped: true, types: ['Artifact', 'Creature', 'Land'] } }), 'the number of tapped artifact, creature, and lands you control');
  assert.equal(renderFilter({ types: ['Artifact', 'Creature', 'Creature'], notTypes: ['Artifact'] }), 'nonartifact artifact or creature');
  assert.deepEqual(lemmas("another creature you've drawn"), ['other', 'creature', 'you', 'have', 'drawn']);
  // keyword-action's endure prints the amount in the renderer's words, lower-cased mid-sentence
  const warden = { kind: 'triggered', event: { on: 'etb', self: false, filter: { types: ['Creature'], other: true, nontoken: true }, controller: 'you' }, effects: [{ op: 'endure', target: 'that', amount: { count: 'counters-on-source' } }], text: '' } as never;
  const r = renderAbility(warden);
  assert.match(r, /that creature endures X, where X is the number of counters on ~$/);
  assert.doesNotMatch(r, /That creature/);
});

test('a prose line granting a named keyword is also read with the keyword written out, and the better reading wins', () => {
  assert.deepEqual(keywordProseVariants('Artifact creatures you control have afflict 3.'), ['Artifact creatures you control have whenever ~ becomes blocked, defending player loses 3 life.']);
  assert.deepEqual(keywordProseVariants('Afflict 3'), [], 'a printed keyword line is not prose');
  assert.deepEqual(keywordProseVariants('Destroy target creature.'), []);
  const patrol = { kind: 'static', effect: { kind: 'grant-ability', scope: 'you-control', filter: { types: ['Artifact', 'Creature'], typesAll: true }, ability: { kind: 'triggered', event: { on: 'becomes-blocked', self: true }, effects: [{ op: 'lose-life', amount: 3, who: 'defending-player' }], text: 'Afflict 3' } }, text: 'Artifact creatures you control have afflict 3.' } as never;
  const s = scoreClaimedLine(patrol, 'Artifact creatures you control have afflict 3.');
  assert.ok(s.score >= 0.55, `Cyberman Patrol: expected the expansion reading to pass, got ${s.score}`);
  assert.equal(s.text, 'Artifact creatures you control have afflict 3.', 'the line reported is the printed one');
  // and the magnitude is still gated through the expansion
  const wrong = { ...patrol, effect: { ...patrol.effect, ability: { ...patrol.effect.ability, effects: [{ op: 'lose-life', amount: 2, who: 'defending-player' }] } } } as never;
  assert.ok(scoreClaimedLine(wrong, 'Artifact creatures you control have afflict 3.').score < 0.55);
});

test('M-1: modal bullets are scored one by one against the mode at that position, reported, and never in the card score', () => {
  const lines = ['When ~ enters, choose one —', '• Draw a card.', '• You gain 3 life.', 'Flying'];
  const modal = { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'choose-mode', count: 1, modes: [[{ op: 'draw', amount: 1, who: 'you' }], [{ op: 'gain-life', amount: 9, who: 'you' }]] }], text: 'When ~ enters, choose one —' } as never;
  const bullets = scoreBullets({ keywords: [], abilities: [modal] }, lines, 'Probe');
  assert.deepEqual(bullets.map(b => b.text), ['• Draw a card.', '• You gain 3 life.']);
  assert.ok(bullets[0].score >= 0.55, `"draw a card" against "you draw a card", got ${bullets[0].score}`);
  assert.equal(bullets[1].score, 0, 'gain 9 for a bullet that prints 3 is a hard zero');
  // a bullet with no mode at its position says so
  const short = scoreBullets({ keywords: [], abilities: [{ ...modal, effects: [{ op: 'choose-mode', count: 1, modes: [[{ op: 'draw', amount: 1, who: 'you' }]] }] } as never] }, lines, 'Probe');
  assert.match(short[1].why ?? '', /none at position 2/);
  // through scoreCard: measured, not gated
  const card = scoreCard({ name: 'Probe', keywords: [], abilities: [modal], oracleText: 'When Probe enters, choose one —\n• Draw a card.\n• You gain 3 life.\nFlying', layout: 'normal' } as never);
  assert.equal(card.bullets.length, 2);
  assert.equal(card.bullets[1].score, 0);
  assert.equal(card.score, 1, 'the whole-ability line still scores on the modal head alone');
});

test('calibration (log only): the three gates and the modal-bullet rate over the seeded samples', () => {
  const s400 = sample(400).map(def => scoreCard(def)).filter(s => s.lines.length);
  const sorted = s400.map(s => s.score).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const zeros = sorted.filter(s => s === 0).length;
  const s1500 = sample(1500).map(def => scoreCard(def)).filter(s => s.lines.length);
  const below = s1500.filter(s => s.score < 0.55).length;
  const withBullets = s1500.filter(s => s.bullets.length);
  const bullets = s1500.flatMap(s => s.bullets);
  const bulletsBelow = bullets.filter(b => b.score < 0.55).length;
  console.log(`calibration: median(400)=${median.toFixed(3)} zeros=${zeros}/${sorted.length} below-gate(1500)=${below}/${s1500.length} (${(100 * below / s1500.length).toFixed(1)}%) `
    + `modal bullets: ${withBullets.length} cards, ${bullets.length} bullets, ${bulletsBelow} below 0.55 (${bullets.length ? (100 * bulletsBelow / bullets.length).toFixed(1) : '0.0'}%)`);
});
