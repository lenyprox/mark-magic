// The generic-you-do rule family (src/cards/rules/generic-you-do.ts, Phase 9.1p): the halves of the printed
// "You may X. If you do, Y" (CR 608.2) this family teaches parse.ts, the exact AST each one emits, and the wordings
// it must leave `unknown`.
//
// The construct itself — the "If you do," link — is NOT claimed here and must not be: parse.ts splits a paragraph
// into sentences before any rule is offered anything, so a sentence rule never sees X and Y together, and the engine
// has no effect op for "run Y only if the effect before it happened in this same resolution" (`reflexive` is the
// CR 603.12 *trigger*, "When you do", which uses the stack). The decline pins below hold that line.
//
// Sentences are written the way the parser sees them after parseCard's normalisation: the card's own name is `~`.
// Every claimed effect is also validated against the script schema, so a rule can never emit a shape a script could
// not carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseEffects } from '../src/cards/parse.js';
import { EffectSchema } from '../src/cards/schema.js';
import { RULE_FAMILIES } from '../src/cards/rules/_registry.js';
import { CardDB } from '../src/cards/db.js';
import { MASTER_DB } from '../src/config/paths.js';
import type { Effect } from '../src/cards/types.js';

const hasDb = fs.existsSync(MASTER_DB());

/** The effects of a wording (JSON-normalised: an explicit `undefined` member is no member), each checked against the script schema. */
function parsed(text: string): Effect[] {
  const effs = JSON.parse(JSON.stringify(parseEffects(text))) as Effect[];
  for (const e of effs) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return effs;
}
/** Every effect of the wording is `unknown` — the family declined it and nothing else claimed it. */
const declined = (text: string): boolean => parsed(text).every(e => e.op === 'unknown');

test('the generic-you-do family is registered from src/cards/rules/generic-you-do.ts', () => {
  assert.ok(RULE_FAMILIES.some(f => f.name === 'generic-you-do'));
});

// ---------------------------------------------------------------------------------------------------------------
// (a) the X halves — the optional action of "You may X. If you do, Y"
// ---------------------------------------------------------------------------------------------------------------
test('"return another <filter> you control to its owner\'s hand" is `return-own` with `other` (CR 109.5)', () => {
  // Temur Sabertooth. The built-in table has the "a/an" form; "another" excludes the source.
  assert.deepEqual(parsed("Return another creature you control to its owner's hand."),
    [{ op: 'return-own', filter: { types: ['Creature'], other: true }, count: 1, to: 'hand' }]);
  // Soratami Seer's cost is a different dispatch point; the effect wording generalises over the filter
  assert.deepEqual(parsed("Return another land you control to its owner's hand."),
    [{ op: 'return-own', filter: { types: ['Land'], other: true }, count: 1, to: 'hand' }]);
});

test('"exile ~ from your graveyard" is a `move` of the source (Kozilek\'s Return)', () => {
  assert.deepEqual(parsed('Exile ~ from your graveyard.'), [{ op: 'move', what: 'self', to: 'exile' }]);
});

test('"discard all the cards in your hand" is the whole-hand `discard` (CR 701.8a)', () => {
  // Forgotten Creation, Book Devourer — "that many" then reads the number discarded
  assert.deepEqual(parsed('Discard all the cards in your hand.'), [{ op: 'discard', amount: 'hand', who: 'you' }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (b) the Y half — what "If you do" then does
// ---------------------------------------------------------------------------------------------------------------
test('"return ~ to your hand" is a `move` of the source to hand (CR 400.7)', () => {
  // Pyrewild Shaman, Death Spark, Gigapede: the source is in the graveyard when the ability resolves
  assert.deepEqual(parsed('Return ~ to your hand.'), [{ op: 'move', what: 'self', to: 'hand' }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (c) the halves in place: the built-in optional-then / optional-pay template now fills both slots
// ---------------------------------------------------------------------------------------------------------------
test('"You may X. If you do, Y" becomes the built-in `optional-then` once both halves are known (CR 608.2)', () => {
  // Temur Sabertooth's whole activated body
  assert.deepEqual(parsed("You may return another creature you control to its owner's hand. If you do, ~ gains indestructible until end of turn."),
    [{ op: 'optional-then',
      first: [{ op: 'return-own', filter: { types: ['Creature'], other: true }, count: 1, to: 'hand' }],
      then: [{ op: 'grant-keyword', target: 'self', keywords: ['indestructible'], duration: 'eot' }] }]);
  // Forgotten Creation
  assert.deepEqual(parsed('You may discard all the cards in your hand. If you do, draw that many cards.'),
    [{ op: 'optional-then', first: [{ op: 'discard', amount: 'hand', who: 'you' }], then: [{ op: 'draw', amount: { count: 'that-many' }, who: 'you' }] }]);
  // Pyrewild Shaman: the mana form of the same template (`optional-pay`) with the family's Y half
  assert.deepEqual(parsed('You may pay {3}. If you do, return ~ to your hand.'),
    [{ op: 'optional-pay', mana: { generic: 3, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{3}' }, then: [{ op: 'move', what: 'self', to: 'hand' }] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (d) DECLINE pins — the wordings next to the construct that must stay unknown
// ---------------------------------------------------------------------------------------------------------------
test('a bare "If you do, …" is declined: the sentence rule cannot see the action it refers to', () => {
  // Vengeful Possession, Pursue the Past, Fire Prophecy — the "You may X." sentence is not the paragraph's first,
  // so the built-in optional-then template never matches and this sentence arrives on its own. There is no
  // `Condition` for "you do" and no effect op for "only if the effect before it happened", so it stays unknown.
  assert.ok(declined('If you do, draw a card.'));
  assert.ok(declined('If you do, draw two cards.'));
  assert.ok(declined('If you do, put a +1/+1 counter on ~.'));
  // …and the whole paragraph keeps the link unparsed rather than running Y unconditionally
  const effs = parsed('You gain 2 life. You may discard a card. If you do, draw two cards.');
  assert.deepEqual(effs.filter(e => e.op === 'unknown'), [{ op: 'unknown', text: 'If you do, draw two cards.' }]);
});

test('a MANDATORY "X. If you do, Y" is declined: `reflexive` is the CR 603.12 trigger, not this', () => {
  // Dreadfeast Demon, The First Eruption, Victimize. Reading these as `may` would invent a choice the card does not
  // offer; reading them as `reflexive` would put Y on the stack as its own ability (Victimize's script says so).
  const demon = parsed("Sacrifice a non-Demon creature. If you do, create a token that's a copy of ~.");
  assert.deepEqual(demon[0], { op: 'sacrifice', who: 'you', what: { notSubtypes: ['Demon'], types: ['Creature'] }, amount: 1 });
  assert.deepEqual(demon[1], { op: 'unknown', text: "If you do, create a token that's a copy of ~." });
  assert.ok(declined('If you do, ~ deals 3 damage to each creature.'));
});

test('"pay N life" is declined: `lose-life` would ignore CR 119.4 (a player may not pay life they do not have)', () => {
  assert.ok(declined('Pay 2 life.'));
  const spy = parsed('You may pay 2 life. If you do, draw a card.');
  assert.ok(spy.some(e => e.op === 'unknown'), `expected an unknown, got ${JSON.stringify(spy)}`);
});

// The 9.1p review's two findings, both on God-Pharaoh's Gift, both pinned as declines. The wording
// "exile a/an <filter> card from your graveyard" was CLAIMED in the first cut of this family and is withdrawn:
// filling the built-in `optional-then` X slot with it made that one card `fullyParsed` carrying a wrong AST.
test('"exile a <filter> card from your graveyard" is declined: filling the optional-then X slot with it breaks God-Pharaoh\'s Gift', () => {
  // The sentence on its own, with nothing else claiming it.
  assert.ok(declined('Exile a creature card from your graveyard.'));
  assert.ok(declined('Exile an enchantment card from your graveyard.'));
  assert.ok(declined('Exile an instant or sorcery card from your graveyard.'));
  // …so the printed paragraph keeps the whole "You may X. If you do, Y" unparsed rather than parsing it wrongly.
  const gpg = parsed("You may exile a creature card from your graveyard. If you do, create a token that's a copy of that card, except it's a 4/4 black Zombie. It gains haste until end of turn.");
  assert.ok(gpg.some(e => e.op === 'unknown'), `expected an unknown, got ${JSON.stringify(gpg)}`);
  // (a) CR 608.2 / 110.5: the haste belongs to the token the sentence before it created, never to the source. The
  // `optional-then` template slices its own match out of the paragraph before the sentence loop runs, so the trailing
  // pronoun sentence is parsed with no antecedent and falls back to `self` — a noncreature Artifact here.
  assert.ok(!gpg.some(e => e.op === 'grant-keyword' && (e as { target?: unknown }).target === 'self'),
    `the trailing "It gains haste" must not become the source: ${JSON.stringify(gpg)}`);
  // (b) CR 707.2: the printed override is "a 4/4 black Zombie". The built-in token-copy template keeps only the
  // subtype (parse.ts drops the size and colour words because `token-copy` has no fields for them), so a claimed
  // parse of this paragraph would silently make a copy of the exiled creature's own power, toughness and colour.
  const y = parsed("Create a token that's a copy of that card, except it's a 4/4 black Zombie.");
  assert.ok(y.every(e => e.op === 'unknown'), `the 4/4 black override must not be approximated away: ${JSON.stringify(y)}`);
});

test('a sentence trailing an `optional-then` keeps its antecedent (9.1px item 1 — the defect was parse.ts\'s, not the wording\'s)', () => {
  // Evidence for the decline above, written with BUILT-INS ONLY so it holds whatever this family does. The same
  // trailing pronoun sentence, the same preceding token:
  //   * in the plain sentence loop the paragraph's antecedent is set and "It" becomes the token (`that`) —
  const flat = parsed("Create a token that's a copy of target creature. It gains haste until end of turn.");
  assert.deepEqual(flat.find(e => e.op === 'grant-keyword'), { op: 'grant-keyword', target: 'that', keywords: ['haste'], duration: 'eot' });
  //   * behind an `optional-then` it used to become the SOURCE: parseParagraph slices the template's match out of
  //     `rest` before the sentence loop, and `antecedent` was only ever set inside that loop, so the pronoun was parsed
  //     as if the paragraph had started with it. This is what would have given God-Pharaoh's Gift — a noncreature
  //     Artifact — the haste its 4/4 Zombie token is printed to get. Since 9.1px item 1 parseParagraph seeds the
  //     antecedent from the template's own match text (CR 608.2h / 110.5), so the pronoun is the token here too
  //     (test/parser-core-9-1px.test.ts pins the full shape); "exile a/an <filter> card from your graveyard" still
  //     waits on (b), the token-copy power / toughness / colour fields, before it may be claimed.
  const behind = parsed("You may sacrifice a creature. If you do, create a token that's a copy of target creature. It gains haste until end of turn.");
  assert.deepEqual(behind.find(e => e.op === 'grant-keyword'), { op: 'grant-keyword', target: 'that', keywords: ['haste'], duration: 'eot' });
});

test('a bare pronoun ("sacrifice it" / "exile it") is declined: the referent is not the family\'s to guess', () => {
  // "When ~ dies, you may exile it" is the source; "Whenever another creature you control dies, you may exile it"
  // is the dying creature. parse.ts suppresses its own `it` -> `~` rewrite as soon as the body names a target.
  assert.ok(declined('Sacrifice it.'));
  assert.ok(declined('Exile it.'));
});

// ---------------------------------------------------------------------------------------------------------------
// (e) the printed cards the family finishes
// ---------------------------------------------------------------------------------------------------------------
test('the printed cards the halves finish are fully parsed', { skip: !hasDb }, () => {
  const db = CardDB.shared();
  for (const name of ['Temur Sabertooth', 'Forgotten Creation', 'Book Devourer', 'Biblioplex Kraken', 'Gigapede', 'Loyal Gryff']) {
    const def = db.get(name);
    assert.ok(def, `${name} is not in the card database`);
    assert.deepEqual(def.unparsed, [], `${name} still has unparsed lines`);
  }
});

test("God-Pharaoh's Gift stays honestly unparsed rather than fully parsed with the wrong AST", { skip: !hasDb }, () => {
  // The card-level form of the decline above: the line is recorded unparsed, and nowhere in the parsed card does the
  // artifact itself gain haste. Masked Vandal, Master Skald, Aphemia and Forgotten Harvest are unparsed for the same
  // reason and come back together with the core change (see the family header).
  const def = CardDB.shared().get("God-Pharaoh's Gift");
  assert.ok(def, "God-Pharaoh's Gift is not in the card database");
  assert.equal(def.fullyParsed, false);
  assert.ok(def.unparsed.some(l => /gains haste/i.test(l)), `expected the combat trigger unparsed, got ${JSON.stringify(def.unparsed)}`);
  const json = JSON.stringify(def.abilities);
  assert.ok(!/"op":"grant-keyword","target":"self","keywords":\["haste"\]/.test(json), `the Gift must not grant itself haste: ${json}`);
});
