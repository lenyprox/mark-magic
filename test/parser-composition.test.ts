// The composition rule family (src/cards/rules/composition.ts, Phase 9.0b): real oracle wordings and the exact AST
// the parser emits for them, the wordings the family must decline, the built-ins-first invariant, and the two parser
// debts paid in the same slice (the second face of split / adventure / flip cards is unparsed; the 0x08 bytes are gone).
//
// Sentences are written the way the parser sees them after parseCard's normalisation: the card's own name is `~`.
// Every claimed effect is also validated against the script schema, so a rule can never emit a shape a script could
// not carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCard, parseEffects, parseEffectSentence, withFrame, PARSER_VERSION, type OracleRow } from '../src/cards/parse.js';
import { EffectSchema } from '../src/cards/schema.js';
import { RULE_FAMILIES } from '../src/cards/rules/_registry.js';
import { secondFaceLines, ScriptStore, useScriptStore } from '../src/cards/scripts.js';
import { CardDB } from '../src/cards/db.js';
import { MASTER_DB, projectRoot } from '../src/config/paths.js';
import type { Effect } from '../src/cards/types.js';

const MANA2 = { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' };
const hasDb = fs.existsSync(MASTER_DB());

/** The effects of a wording (JSON-normalised: an explicit `undefined` member is no member), each checked against the script schema. */
function parsed(text: string): Effect[] {
  const effs = JSON.parse(JSON.stringify(parseEffects(text))) as Effect[];
  for (const e of effs) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return effs;
}
/**
 * The same for a sentence whose antecedent sits outside it (an earlier sentence of the card, a trigger about another
 * object): parsed with the binding frame already bound, the way parseCard parses it in place. On its own such a
 * sentence is unknown — see "a frame-reading sentence nothing can bind is unknown" below.
 */
const bound = (text: string): Effect[] => withFrame(true, [], () => parsed(text));

test('the composition family is registered from src/cards/rules/composition.ts', () => {
  assert.ok(RULE_FAMILIES.some(f => f.name === 'composition'));
});

// ---------------------------------------------------------------------------------------------------------------
// (a) for each / amounts over object sets
// ---------------------------------------------------------------------------------------------------------------
test('"<effect> for each <set>": the printed 1 becomes the count, a printed k becomes k × it', () => {
  // Howl of the Night Pack
  assert.deepEqual(parsed('Create a 2/2 green Wolf creature token for each Forest you control.'),
    [{ op: 'token', count: { count: 'permanents-you-control', filter: { subtypes: ['Forest'] } }, power: 2, toughness: 2, colors: ['G'], types: ['Creature'], subtypes: ['Wolf'], keywords: [], attacking: false }]);
  // Dragon's Desire: the object set of every opponent
  assert.deepEqual(parsed("Add {R} for each artifact your opponents control."),
    [{ op: 'add-mana', mana: ['R'], perEach: { count: 'objects', filter: { types: ['Artifact'] }, who: 'each-opponent' } }]);
  // Shepherd of Rot: "{T}: Each player loses 1 life for each Zombie on the battlefield."
  assert.deepEqual(parsed('Each player loses 1 life for each Zombie on the battlefield.'),
    [{ op: 'lose-life', amount: { count: 'permanents-on-battlefield', filter: { subtypes: ['Zombie'] } }, who: 'each-player' }]);
  // Timbermaw Larva (a self trigger's "it" is the source)
  assert.deepEqual(parsed('It gets +1/+1 until end of turn for each Forest you control.'),
    [{ op: 'pump', target: 'self', power: { count: 'permanents-you-control', filter: { subtypes: ['Forest'] } }, toughness: { count: 'permanents-you-control', filter: { subtypes: ['Forest'] } }, duration: 'eot' }]);
});

test('"For each <set>, <effect about it>" iterates the set with `that` bound (CR 608.2f)', () => {
  // Cadira, Caller of the Small
  assert.deepEqual(parsed('For each token you control, create a 1/1 white Rabbit creature token.'),
    [{ op: 'for-each', over: { token: true, who: 'you' }, do: [{ op: 'token', count: 1, power: 1, toughness: 1, colors: ['W'], types: ['Creature'], subtypes: ['Rabbit'], keywords: [], attacking: false }] }]);
  assert.deepEqual(parsed('For each creature you control, put a +1/+1 counter on it.'),
    [{ op: 'for-each', over: { types: ['Creature'], who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] }]);
  assert.deepEqual(parsed('For each creature you control, tap that creature.'),
    [{ op: 'for-each', over: { types: ['Creature'], who: 'you' }, do: [{ op: 'tap', target: 'that' }] }]);
  // Practiced Offense
  assert.deepEqual(parsed('Put a +1/+1 counter on each creature target player controls.'),
    [{ op: 'for-each', over: { types: ['Creature'], who: 'target-player' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] }]);
  // Quintorius, History Chaser -4: the pump / grant ops take no filter, so each Spirit is visited
  assert.deepEqual(parsed('Spirits you control gain double strike and vigilance until end of turn.'),
    [{ op: 'for-each', over: { subtypes: ['Spirit'], who: 'you' }, do: [{ op: 'grant-keyword', target: 'that', keywords: ['double strike', 'vigilance'], duration: 'eot' }] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (b) scoped: each opponent / each player / target player / that player / its controller
// ---------------------------------------------------------------------------------------------------------------
test('"<player> <does>" runs the clause as that player (APNAP for the each-* words, CR 101.4)', () => {
  // Field of Ruin
  assert.deepEqual(parsed('Each player searches their library for a basic land card, puts it onto the battlefield, then shuffles.'),
    [{ op: 'scoped', who: 'each-player', do: [{ op: 'search-land', toBattlefield: true, tapped: false, basic: true, count: 1 }] }]);
  // Returned Reveler
  assert.deepEqual(parsed('Each player mills three cards.'), [{ op: 'scoped', who: 'each-player', do: [{ op: 'mill', amount: 3, who: 'you' }] }]);
  // Words of Wisdom
  assert.deepEqual(parsed('You draw two cards, then each other player draws a card.'),
    [{ op: 'draw', amount: 2, who: 'you' }, { op: 'scoped', who: 'each-opponent', do: [{ op: 'draw', amount: 1, who: 'you' }] }]);
  // Wistful Thinking
  assert.deepEqual(parsed('Target player draws two cards, then discards four cards.'), [{ op: 'scoped', who: 'target-player', do: [{ op: 'loot', draw: 2, discard: 4 }] }]);
  // Varragoth, Bloodsky Sire
  assert.deepEqual(parsed('Target player searches their library for a card, then shuffles and puts that card on top.'),
    [{ op: 'scoped', who: 'target-player', do: [{ op: 'search', filter: {}, to: 'top', count: 1 }] }]);
  // Spreading Rot / An Offer You Can't Refuse: the controller of what the previous effect touched
  assert.deepEqual(parsed('Destroy target land. Its controller loses 2 life.'),
    [{ op: 'destroy', target: { kind: 'land' } }, { op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: 2, who: 'you' }] }]);
  assert.deepEqual(bound('Its controller creates two Treasure tokens.'),
    [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'token', count: 2, power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Treasure'], keywords: [], treasure: true, name: 'Treasure' }] }]);
  // Radioactive Man / Unstoppable Slasher
  assert.deepEqual(parsed('That player loses half their life, rounded up.'),
    [{ op: 'scoped', who: 'that-player', do: [{ op: 'lose-life', amount: { prop: 'life', of: 'you', half: 'up' }, who: 'you' }] }]);
  // Enslaved Horror: a "may" inside the block, a chosen graveyard card moved
  assert.deepEqual(parsed('Each other player may return a creature card from their graveyard to the battlefield.'),
    [{ op: 'scoped', who: 'each-opponent', do: [{ op: 'may', effects: [{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'graveyard', who: 'you', count: 1 }, to: 'battlefield', controller: 'you' }] }] }]);
  // Tainted Aether: "of their choice" carries no instruction (the sacrificing player chooses anyway)
  assert.deepEqual(bound('Its controller sacrifices a creature or land of their choice.'),
    [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature', 'Land'] }, amount: 1 }] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (c) "When you do" (reflexive, CR 603.12) vs "If you do" (optional-then, CR 608.2)
// ---------------------------------------------------------------------------------------------------------------
test('"you may X. When you do, Y" is a may followed by a reflexive trigger', () => {
  // Boilerbilges Ripper
  assert.deepEqual(parsed('You may sacrifice another creature or enchantment. When you do, ~ deals 2 damage to any target.'),
    [{ op: 'may', effects: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature', 'Enchantment'], other: true }, amount: 1 }] },
     { op: 'reflexive', when: 'you-do', effects: [{ op: 'damage', amount: 2, target: { kind: 'any' } }] }]);
  // Sutina, Speaker of the Tajuru: the "you may" of a built-in effect stays with the trigger's optional flag
  assert.deepEqual(parsed('When you do, put a +1/+1 counter on target creature.'),
    [{ op: 'reflexive', when: 'you-do', effects: [{ op: 'counters', target: { kind: 'creature' }, counter: '+1/+1', amount: 1 }] }]);
});

test('"you may X. If you do, Y" is the optional-then the built-ins already had, now with Y read to the end of its sentence', () => {
  // Wilhelt, the Rotcleaver
  assert.deepEqual(parsed('You may sacrifice a Zombie. If you do, draw a card.'),
    [{ op: 'optional-then', first: [{ op: 'sacrifice', who: 'you', what: { subtypes: ['Zombie'] }, amount: 1 }], then: [{ op: 'draw', amount: 1, who: 'you' }] }]);
  // Formidable Speaker (Y is a long built-in sentence)
  assert.deepEqual(parsed('You may discard a card. If you do, search your library for a creature card, reveal it, put it into your hand, then shuffle.'),
    [{ op: 'optional-then', first: [{ op: 'discard', amount: 1, who: 'you' }], then: [{ op: 'search', filter: { types: ['Creature'] }, to: 'hand', count: 1, reveal: true }] }]);
  // Containment Construct (X needs the family: a Ref moved out of the graveyard)
  assert.deepEqual(bound('You may exile that card from your graveyard. If you do, you may play that card this turn.'),
    [{ op: 'optional-then', first: [{ op: 'move', what: 'that', to: 'exile' }], then: [{ op: 'play-exiled', until: 'eot' }] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (d) unless-pays (CR 118.12)
// ---------------------------------------------------------------------------------------------------------------
test('"… unless <player> pays / sacrifices / discards …" is an unless-pays whose otherwise runs as the payer', () => {
  // Hasran Ogress
  assert.deepEqual(parsed('It deals 3 damage to you unless you pay {2}.'), [{ op: 'unless-pays', who: 'you', cost: { mana: MANA2 }, otherwise: [{ op: 'damage-you', amount: 3 }] }]);
  // Sacred Mesa / Bog Elemental
  assert.deepEqual(parsed('Sacrifice ~ unless you sacrifice a Pegasus.'), [{ op: 'unless-pays', who: 'you', cost: { sacrifice: { subtypes: ['Pegasus'] } }, otherwise: [{ op: 'sacrifice-self' }] }]);
  assert.deepEqual(parsed('Sacrifice ~ unless you discard a card.'), [{ op: 'unless-pays', who: 'you', cost: { discard: 1 }, otherwise: [{ op: 'sacrifice-self' }] }]);
  // Waterspout Djinn
  assert.deepEqual(parsed("Sacrifice ~ unless you return an untapped Island you control to its owner's hand."),
    [{ op: 'unless-pays', who: 'you', cost: { returnToHand: { untapped: true, subtypes: ['Island'] } }, otherwise: [{ op: 'sacrifice-self' }] }]);
  // each opponent decides for themselves
  assert.deepEqual(parsed('Each opponent discards a card unless they pay {2}.'), [{ op: 'unless-pays', who: 'each-opponent', cost: { mana: MANA2 }, otherwise: [{ op: 'discard', amount: 1, who: 'you' }] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (e) move
// ---------------------------------------------------------------------------------------------------------------
test('put / return a bound object or a chosen set onto the battlefield, a library, exile', () => {
  // Brought Back
  assert.deepEqual(bound('Return them to the battlefield tapped.'), [{ op: 'move', what: 'those', to: 'battlefield', controller: 'owner', tapped: true }]);
  // Ghostly Flicker
  assert.deepEqual(parsed('Exile two target artifacts, creatures, and/or lands you control, then return those cards to the battlefield under your control.'),
    [{ op: 'exile', target: { kind: 'permanent', count: 2, controller: 'you', filter: { types: ['Artifact', 'Creature', 'Land'] } } }, { op: 'move', what: 'those', to: 'battlefield', controller: 'you' }]);
  // Skyskipper Duo
  assert.deepEqual(bound("Return it to the battlefield under its owner's control at the beginning of the next end step."),
    [{ op: 'delayed-trigger', at: 'next-end-step', bind: 'that', effects: [{ op: 'move', what: 'that', to: 'battlefield', controller: 'owner' }] }]);
  // Lumra, Bellow of the Woods
  assert.deepEqual(parsed('Return all land cards from your graveyard to the battlefield tapped.'),
    [{ op: 'move', what: { filter: { types: ['Land'] }, zone: 'graveyard', who: 'you', count: 'all' }, to: 'battlefield', controller: 'you', tapped: true }]);
  // Dread Wanderer / Stitchwing Skaab
  assert.deepEqual(parsed('Return ~ from your graveyard to the battlefield tapped.'), [{ op: 'move', what: 'self', to: 'battlefield', controller: 'you', tapped: true }]);
  // Mistveil Plains
  assert.deepEqual(parsed('Put target card from your graveyard on the bottom of your library.'), [{ op: 'return-from-graveyard', what: {}, to: 'library-bottom', target: true }]);
  assert.deepEqual(bound("Put that card on top of its owner's library."), [{ op: 'move', what: 'that', to: 'library', pos: 'top' }]);
  assert.deepEqual(bound('Exile that creature until ~ leaves the battlefield.'), [{ op: 'move', what: 'that', to: 'exile', until: 'leaves' }]);
  // Relentless Dead: "with mana value X" is an equality filter, "another" an other flag
  assert.deepEqual(parsed('Return another target Zombie creature card with mana value X from your graveyard to the battlefield.'),
    [{ op: 'return-from-graveyard', what: { subtypes: ['Zombie'], types: ['Creature'], mvEQ: 'X', other: true }, to: 'battlefield', target: true }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (f) where X is / equal to
// ---------------------------------------------------------------------------------------------------------------
test('"…, where X is <amount>" and "… equal to <amount>" define the X of the sentence', () => {
  // Jaws of Defeat
  assert.deepEqual(bound("Target opponent loses life equal to the difference between that creature's power and its toughness."),
    [{ op: 'lose-life', amount: { diff: [{ count: 'power-of-that' }, { prop: 'toughness', of: 'that' }] }, who: 'target-player' }]);
  // Altar of Dementia
  assert.deepEqual(parsed("Target player mills cards equal to the sacrificed creature's power."), [{ op: 'mill', amount: { prop: 'power', of: 'sacrificed' }, who: 'target-player' }]);
  // Terror of the Peaks
  assert.deepEqual(bound("~ deals damage equal to that creature's power to any target."), [{ op: 'damage', amount: { count: 'power-of-that' }, target: { kind: 'any' } }]);
  // Warped Physique: the sign the built-in pump loses on "-X" is restored
  assert.deepEqual(parsed('Target creature gets +X/-X until end of turn, where X is the number of cards in your hand.'),
    [{ op: 'pump', target: { kind: 'creature' }, power: { count: 'cards-in-hand' }, toughness: { count: 'cards-in-hand', times: -1 }, duration: 'eot' }]);
  // Feral Animist: "its" is the source when the sentence is about ~
  assert.deepEqual(parsed('~ gets +X/+0 until end of turn, where X is its power.'), [{ op: 'pump', target: 'self', power: { count: 'power-of-source' }, toughness: 0, duration: 'eot' }]);
  // Harsh Sustenance: several effects under one X
  assert.deepEqual(parsed('~ deals X damage to any target and you gain X life, where X is the number of creatures you control.'),
    [{ op: 'scoped', who: 'you', do: [{ op: 'damage', amount: { count: 'permanents-you-control', filter: { types: ['Creature'] } }, target: { kind: 'any' } }, { op: 'gain-life', amount: { count: 'permanents-you-control', filter: { types: ['Creature'] } }, who: 'you' }] }]);
  // Slash of Light: a sum
  assert.deepEqual(parsed('~ deals damage equal to the number of creatures you control plus the number of Equipment you control to target creature.'),
    [{ op: 'damage', amount: { sum: [{ count: 'permanents-you-control', filter: { types: ['Creature'] } }, { count: 'permanents-you-control', filter: { subtypes: ['Equipment'] } }] }, target: { kind: 'creature' } }]);
  // Freyalise Supplicant: half, rounded down, of a Ref's power
  assert.deepEqual(parsed("~ deals damage to any target equal to half the sacrificed creature's power, rounded down."),
    [{ op: 'damage', amount: { prop: 'power', of: 'sacrificed', half: 'down' }, target: { kind: 'any' } }]);
  // Wan Shi Tong, Librarian
  assert.deepEqual(parsed('Draw half X cards, rounded down.'), [{ op: 'draw', amount: { sum: ['X'], half: 'down' }, who: 'you' }]);
  // Morbid Bloom: "the exiled card" after an exile in the same sentence is `that`
  assert.deepEqual(parsed("Exile target creature card from a graveyard, then create X 1/1 green Saproling creature tokens, where X is the exiled card's toughness."),
    [{ op: 'scoped', who: 'you', do: [{ op: 'exile', target: { kind: 'graveyard-card', filter: { types: ['Creature'] } } }, { op: 'token', count: { prop: 'toughness', of: 'that' }, power: 1, toughness: 1, colors: ['G'], types: ['Creature'], subtypes: ['Saproling'], keywords: [], attacking: false }] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (g) set-pt, (h) lose-abilities, (i) exchange
// ---------------------------------------------------------------------------------------------------------------
test('base power and toughness, lose all abilities, exchange', () => {
  // Quandrix Charm / Hostile Takeover
  assert.deepEqual(parsed('Target creature has base power and toughness 5/5 until end of turn.'), [{ op: 'set-pt', target: { kind: 'creature' }, power: 5, toughness: 5, base: true, duration: 'eot' }]);
  assert.deepEqual(parsed('Up to one other target creature has base power and toughness 4/4 until end of turn.'),
    [{ op: 'set-pt', target: { kind: 'creature', optional: true, count: 1, filter: { other: true } }, power: 4, toughness: 4, base: true, duration: 'eot' }]);
  // Frogify-likes: two effects of one sentence, the second on the same target
  assert.deepEqual(parsed('Until end of turn, target creature loses all abilities and has base power and toughness 1/1.'),
    [{ op: 'scoped', who: 'you', do: [{ op: 'lose-abilities', target: { kind: 'creature' }, keywords: 'all', duration: 'eot' }, { op: 'set-pt', target: 'target:0', power: 1, toughness: 1, base: true, duration: 'eot' }] }]);
  assert.deepEqual(parsed('Target creature loses all abilities until end of turn.'), [{ op: 'lose-abilities', target: { kind: 'creature' }, keywords: 'all', duration: 'eot' }]);
  assert.deepEqual(parsed('Target creature loses flying until end of turn.'), [{ op: 'lose-abilities', target: { kind: 'creature' }, keywords: ['flying'], duration: 'eot' }]);
  assert.deepEqual(parsed('Exchange life totals with target opponent.'), [{ op: 'exchange', what: 'life', a: 'you', b: { kind: 'opponent' } }]);
  assert.deepEqual(parsed("Exchange control of target artifact you control and target artifact or creature you don't control."),
    [{ op: 'exchange', what: 'control', a: { kind: 'artifact', controller: 'you' }, b: { kind: 'permanent', controller: 'opponent', filter: { types: ['Artifact', 'Creature'] } } }]);
  assert.deepEqual(parsed('Exchange control of two target creatures.'), [{ op: 'exchange', what: 'control', a: { kind: 'creature' }, b: { kind: 'creature' } }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (j) multi targets, (k) delayed triggers, (l) may
// ---------------------------------------------------------------------------------------------------------------
test('several instances of "target" on one effect, and the new delayed-trigger points', () => {
  assert.deepEqual(parsed('~ deals 2 damage to target creature and target player.'), [{ op: 'damage', amount: 2, target: { kind: 'multi', specs: [{ kind: 'creature' }, { kind: 'player' }] } }]);
  assert.deepEqual(parsed('Two target creatures each get -1/-1 until end of turn.'), [{ op: 'pump', target: { kind: 'creature', count: 2 }, power: -1, toughness: -1, duration: 'eot' }]);
  assert.deepEqual(parsed('Destroy any number of target creatures.'), [{ op: 'destroy', target: { kind: 'creature', count: 99, optional: true } }]);
  // Skyclave Apparition: a comma list with the controller phrase before the numeric tail
  assert.deepEqual(parsed("Exile up to one target nonland, nontoken permanent you don't control with mana value 4 or less."),
    [{ op: 'exile', target: { kind: 'nonland-permanent', optional: true, count: 1, controller: 'opponent', filter: { nontoken: true, mvLE: 4 } } }]);
  // Celestial Sword-style riders
  assert.deepEqual(bound('Sacrifice it at the beginning of the next end step.'), [{ op: 'delayed-trigger', at: 'next-end-step', bind: 'that', effects: [{ op: 'remove-those', how: 'sacrifice' }] }]);
  assert.deepEqual(bound('Exile them at the beginning of the next end step.'), [{ op: 'delayed-trigger', at: 'next-end-step', bind: 'those', effects: [{ op: 'remove-those', how: 'exile' }] }]);
  assert.deepEqual(bound('When that creature dies this turn, create a 1/1 white Spirit creature token with flying.'),
    [{ op: 'delayed-trigger', at: 'this-turn:dies', bind: 'that', effects: [{ op: 'token', count: 1, power: 1, toughness: 1, colors: ['W'], types: ['Creature'], subtypes: ['Spirit'], keywords: ['flying'], attacking: false }] }]);
  assert.deepEqual(bound('When it leaves the battlefield this turn, draw a card.'), [{ op: 'delayed-trigger', at: 'this-turn:ltb', bind: 'that', effects: [{ op: 'draw', amount: 1, who: 'you' }] }]);
  assert.deepEqual(parsed("At the beginning of the next turn's upkeep, you lose 2 life."), [{ op: 'delayed-trigger', at: 'next-turn:upkeep', effects: [{ op: 'lose-life', amount: 2, who: 'you' }] }]);
});

test('"you may <sentence the family claims>" is wrapped in a may; "you may A and B" is one choice over both', () => {
  assert.deepEqual(bound('You may exile that card from your graveyard.'), [{ op: 'may', effects: [{ op: 'move', what: 'that', to: 'exile' }] }]);
  // Will of the Jeskai's first mode: the "may" of a "<player> may …" clause is one choice over the whole clause
  assert.deepEqual(parsed('Each player may discard their hand and draw five cards.'),
    [{ op: 'scoped', who: 'each-player', do: [{ op: 'may', effects: [{ op: 'discard', amount: 'hand', who: 'you' }, { op: 'draw', amount: 5, who: 'you' }] }] }]);
  // Practiced Offense: a choice of keyword is a two-mode choice
  assert.deepEqual(parsed('Target creature gains your choice of double strike or lifelink until end of turn.'),
    [{ op: 'choose-mode', count: 1, modes: [[{ op: 'grant-keyword', target: { kind: 'creature' }, keywords: ['double strike'], duration: 'eot' }], [{ op: 'grant-keyword', target: { kind: 'creature' }, keywords: ['lifelink'], duration: 'eot' }]] }]);
});

// ---------------------------------------------------------------------------------------------------------------
// declines: what the family must NOT claim
// ---------------------------------------------------------------------------------------------------------------
test('the family declines what the engine cannot express or what it cannot read safely', () => {
  const unknown = (text: string, why: string) => assert.ok(parseEffects(text).some(e => e.op === 'unknown'), `${why}: ${text}`);
  unknown('You may draw a card unless that player pays {4}.', 'Mystic Remora: the otherwise would run as the payer, not you');
  unknown("Sacrifice ~ unless you return a non-Lair land you control to its owner's hand.", 'a filter word the built-in cost parser would drop');
  unknown('Target creature gets +X/+X until end of turn, where X is the greatest power among creatures you control.', 'no amount form for a maximum over objects');
  unknown('Each opponent loses X life and you scry X, where X is the number of Zombies you control.', 'scry takes a number only');
  unknown('Draw a card for each tapped creature target opponent controls.', 'an amount cannot introduce a player target');
  unknown('~ deals damage to each player equal to half that player\'s life total, rounded down.', 'a per-player amount under an each-player target');
  unknown('Exile target creature, Vehicle, or nonbasic land.', 'an or-list mixing a type, a subtype and an adjective');
  unknown("Whenever ~ becomes tapped, it and Zombies you control gain deathtouch until end of turn.", 'a compound subject');
  unknown('Tap it.', 'a bare "it" under a verb: too often the source itself');
  unknown('Exile up to X target cards from graveyards.', 'an X target count');
  unknown('Target player scries 2.', 'no scry with a player scope on a number-only op');
  unknown('It becomes a 0/0 Elemental creature with vigilance and haste that\'s still a land.', 'a type change is not a P/T change');
  unknown("The exiled card's owner creates a 3/3 blue Illusion creature token.", 'an owner is not a controller-of-that');
});

// ---------------------------------------------------------------------------------------------------------------
// built-ins first
// ---------------------------------------------------------------------------------------------------------------
test('a sentence the built-ins parse keeps its built-in shape with the family present', () => {
  assert.deepEqual(parseEffectSentence('Each opponent sacrifices a creature.'), { op: 'sacrifice', who: 'each-opponent', what: { types: ['Creature'] }, amount: 1 });
  assert.deepEqual(parseEffectSentence('Target player draws two cards.'), { op: 'draw', amount: 2, who: 'target-player' });
  assert.deepEqual(parseEffectSentence('Counter target spell unless its controller pays {2}.'), { op: 'counter', target: { kind: 'spell' }, unlessPay: 2 });
  assert.deepEqual(parseEffectSentence("Return that card to the battlefield under its owner's control."), { op: 'return-to-battlefield', target: 'that', underControlOf: 'owner' });
  assert.deepEqual(parseEffects('Draw a card and you gain 2 life.'), [{ op: 'draw', amount: 1, who: 'you' }, { op: 'gain-life', amount: 2, who: 'you' }]);
  // a "you may" sentence the built-ins claim is a choice too: the op is wrapped in the same `may` (9.0b review fix 5)
  assert.deepEqual(parseEffectSentence('You may draw a card.'), { op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] });
});

// ---------------------------------------------------------------------------------------------------------------
// 9.0b review fixes: restrictions the vocabulary cannot carry are declined, the subtype vocabulary, the scope of
// "you" and "may" inside a player clause, the antecedent of "it", targets by subtype
// ---------------------------------------------------------------------------------------------------------------
test('a printed restriction no filter field can carry makes the sentence unknown, never a wider filter (CR 115.1)', () => {
  const unknown = (text: string, why: string) => assert.ok(parseEffects(text).some(e => e.op === 'unknown'), `${why}: ${text}`);
  // Restoration Angel: an Angel that could target itself would blink itself forever (the verify:pool hang)
  unknown('You may exile target non-Angel creature you control, then return that card to the battlefield under your control.', 'non-Angel has no Filter field');
  unknown('Destroy target non-Aura enchantment.', 'non-Aura has no Filter field');
  unknown('Snow creatures you control gain trample until end of turn.', 'a supertype is not a subtype');
  unknown('Legendary creatures you control get +1/+1 until end of turn.', 'a supertype is not a subtype');
  unknown('Tap target creature without flying.', 'no negative keyword filter');
  // "target opponent" would be offered every player by the engine (ScopeWho has no opponent-only word)
  unknown('Target opponent draws a card.', 'target opponent as a scope');
  unknown('Target opponent draws a card and you draw three cards.', 'target opponent as a scope');
});

test('subtypes are spelt the way the pool prints them: plurals, invariants, and no capitalised English word', () => {
  // Cloudpost: "Locus" is its own singular
  assert.deepEqual(parsed('Add {C} for each Locus on the battlefield.'), [{ op: 'add-mana', mana: ['C'], perEach: { count: 'permanents-on-battlefield', filter: { subtypes: ['Locus'] } } }]);
  // In Oketra's Name / Captain America / Gather the White Lotus
  assert.deepEqual(parsed('Zombies you control get +2/+1 until end of turn.'), [{ op: 'for-each', over: { subtypes: ['Zombie'], who: 'you' }, do: [{ op: 'pump', target: 'that', power: 2, toughness: 1, duration: 'eot' }] }]);
  assert.deepEqual(parsed('Heroes you control get +1/+1 until end of turn.'), [{ op: 'for-each', over: { subtypes: ['Hero'], who: 'you' }, do: [{ op: 'pump', target: 'that', power: 1, toughness: 1, duration: 'eot' }] }]);
  assert.deepEqual(parsed('Create a 1/1 white Ally creature token for each Plains you control.'),
    [{ op: 'token', count: { count: 'permanents-you-control', filter: { subtypes: ['Plains'] } }, power: 1, toughness: 1, colors: ['W'], types: ['Creature'], subtypes: ['Ally'], keywords: [], attacking: false }]);
  // Ravenous Robots / Phalanx Tactics: adjectives are fields, not subtypes
  assert.deepEqual(parsed('Creature tokens you control gain haste until end of turn.'), [{ op: 'for-each', over: { types: ['Creature'], token: true, who: 'you' }, do: [{ op: 'grant-keyword', target: 'that', keywords: ['haste'], duration: 'eot' }] }]);
  assert.deepEqual(parsed('Each other creature you control gets +1/+1 until end of turn.'), [{ op: 'for-each', over: { other: true, types: ['Creature'], who: 'you' }, do: [{ op: 'pump', target: 'that', power: 1, toughness: 1, duration: 'eot' }] }]);
  // Bant Panorama / Harald: a comma list of subtypes is the same any-of list as an "or" list
  assert.deepEqual(parsed('Search your library for a basic Forest, Plains, or Island card, put it onto the battlefield tapped, then shuffle.'),
    [{ op: 'search', filter: { basic: true, subtypes: ['Forest', 'Plains', 'Island'] }, to: 'battlefield', tapped: true, count: 1, optional: false }]);
  // Puppet Conjurer: a template's `s?` took the real trailing s
  assert.deepEqual(parsed('Sacrifice a Homunculus.'), [{ op: 'sacrifice', who: 'you', what: { subtypes: ['Homunculus'] }, amount: 1 }]);
});

test('the controller\'s own half of a "<player> … and you …" sentence stays outside the block (CR 608.2)', () => {
  // Certain Death / Punish Ignorance: the opponent loses, you gain
  assert.deepEqual(parsed('Destroy target creature. Its controller loses 2 life and you gain 2 life.'),
    [{ op: 'destroy', target: { kind: 'creature' } }, { op: 'scoped', who: 'you', do: [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: 2, who: 'you' }] }, { op: 'gain-life', amount: 2, who: 'you' }] }]);
  // any other "you" inside the clause is ambiguous
  assert.ok(parseEffects('Each opponent sacrifices a creature you control.').some(e => e.op === 'unknown'));
});

test('"<player> may …" is a choice that player makes (CR 601.2 / 608.2), never a mandatory action', () => {
  // Fecundity / Vex
  assert.deepEqual(bound("That creature's controller may draw a card."), [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }] }]);
  // Old-Growth Dryads
  assert.deepEqual(parsed('Each opponent may search their library for a basic land card, put it onto the battlefield tapped, then shuffle.'),
    [{ op: 'scoped', who: 'each-opponent', do: [{ op: 'may', effects: [{ op: 'search-land', toBattlefield: true, tapped: true, basic: true, count: 1 }] }] }]);
  // Eager Construct
  assert.deepEqual(parsed('Each player may scry 1.'), [{ op: 'scoped', who: 'each-player', do: [{ op: 'may', effects: [{ op: 'scry', amount: 1 }] }] }]);
  // Summon Undead: the built-in sentence path is a choice too, and a permission is not an action
  assert.deepEqual(parsed('You may mill three cards.'), [{ op: 'may', effects: [{ op: 'mill', amount: 3, who: 'you' }] }]);
  assert.deepEqual(parsed('You may play that card this turn.'), [{ op: 'play-exiled', until: 'eot' }]);
  assert.deepEqual(bound('You may exile that card from your graveyard. If you do, you may play that card this turn.'),
    [{ op: 'optional-then', first: [{ op: 'move', what: 'that', to: 'exile' }], then: [{ op: 'play-exiled', until: 'eot' }] }]);
});

test('a leading "it" / "that creature" after a sentence that named another object is that object, not the source', () => {
  // Slave of Bolas: the stolen creature gains haste, not the sorcery — and since gain-control binds nothing itself, the
  // item's target is bound before it (one bind, however many sentences read it)
  assert.deepEqual(parsed('Gain control of target creature. Untap that creature. It gains haste until end of turn. Sacrifice it at the beginning of the next end step.'),
    [{ op: 'bind', as: 'that', from: 'targets' }, { op: 'gain-control', target: { kind: 'creature' }, duration: 'permanent' }, { op: 'untap', target: 'that' }, { op: 'grant-keyword', target: 'that', keywords: ['haste'], duration: 'eot' },
     { op: 'delayed-trigger', at: 'next-end-step', bind: 'that', effects: [{ op: 'remove-those', how: 'sacrifice' }] }]);
  // Elemental Appeal: the token, inside the kicked conditional
  assert.deepEqual(parsed('Create a 7/1 red Elemental creature token with trample and haste. Exile it at the beginning of the next end step. If this spell was kicked, that creature gets +7/+0 until end of turn.'),
    [{ op: 'token', count: 1, power: 7, toughness: 1, colors: ['R'], types: ['Creature'], subtypes: ['Elemental'], keywords: ['trample', 'haste'], attacking: false },
     { op: 'delayed-trigger', at: 'next-end-step', bind: 'that', effects: [{ op: 'remove-those', how: 'exile' }] },
     { op: 'conditional', condition: { kind: 'kicked' }, then: [{ op: 'pump', target: 'that', power: 7, toughness: 0, duration: 'eot' }] }]);
  // with no antecedent the pronoun is still the source
  assert.deepEqual(parsed('Untap ~. It gains haste until end of turn.'), [{ op: 'untap', target: 'self' }, { op: 'grant-keyword', target: 'self', keywords: ['haste'], duration: 'eot' }]);
});

test('a target named by a subtype is a target (CR 115.1), and "sacrifice another" keeps the source out of the cost (CR 601.2h)', () => {
  // Safewright Cavalry / Inside Source
  assert.deepEqual(parsed('Target Elf you control gets +2/+2 until end of turn.'), [{ op: 'pump', target: { kind: 'creature', controller: 'you', filter: { subtypes: ['Elf'] } }, power: 2, toughness: 2, duration: 'eot' }]);
  assert.deepEqual(parsed('Target Detective you control gets +2/+0 and gains vigilance until end of turn.'),
    [{ op: 'pump', target: { kind: 'creature', controller: 'you', filter: { subtypes: ['Detective'] } }, power: 2, toughness: 0, keywords: ['vigilance'], duration: 'eot' }]);
  // Apocalypse Demon
  assert.deepEqual(parsed('Tap ~ unless you sacrifice another creature.'), [{ op: 'unless-pays', who: 'you', cost: { sacrifice: { types: ['Creature'], other: true } }, otherwise: [{ op: 'tap', target: 'self' }] }]);
});

test('trigger heads that read "~ or another …" / "… you control with …" / "… of the chosen type" no longer mint subtypes', () => {
  const row = (name: string, oracle_text: string): OracleRow => ({
    name, oracle_id: `probe-${name.toLowerCase().replace(/\W+/g, '-')}`, mana_cost: '{1}{R}', mana_value: 2, colors: ['R'], color_identity: ['R'],
    types: ['Creature'], supertypes: [], subtypes: ['Elemental'], type_line: 'Creature — Elemental', oracle_text, power: '2', toughness: '2', loyalty: null, keywords: [], layout: 'normal',
  });
  // Hawkeye, Trick Shot / Kazandu Blademaster
  let def = parseCard(row('Probe Ally', 'Whenever Probe Ally or another Ally you control enters, put a +1/+1 counter on Probe Ally.'));
  assert.equal(def.fullyParsed, true);
  assert.deepEqual((def.abilities[0] as { event: unknown }).event, { on: 'or', events: [{ on: 'etb', self: true }, { on: 'etb', self: false, filter: { subtypes: ['Ally'], other: true }, controller: 'you' }] });
  // Blood Artist
  def = parseCard(row('Probe Artist', 'Whenever Probe Artist or another creature dies, you gain 1 life.'));
  assert.equal(def.fullyParsed, true);
  assert.deepEqual((def.abilities[0] as { event: unknown }).event, { on: 'or', events: [{ on: 'dies', self: true }, { on: 'dies', self: false, filter: { types: ['Creature'], other: true }, controller: 'any' }] });
  // Ezuri, Claw of Progress / Garruk's Uprising
  def = parseCard(row('Probe Bond', 'Whenever a creature you control with power 4 or greater enters, draw a card.'));
  assert.equal(def.fullyParsed, true);
  assert.deepEqual((def.abilities[0] as { event: unknown }).event, { on: 'etb', self: false, filter: { powerGE: 4, types: ['Creature'] }, controller: 'you' });
  // Thopter Assembly: the source is excepted
  def = parseCard(row('Probe Thopter', 'At the beginning of your upkeep, if you control no Thopters other than Probe Thopter, draw a card.'));
  assert.equal(def.fullyParsed, true);
  assert.deepEqual((def.abilities[0] as { intervening: unknown }).intervening, { kind: 'controls-le', who: 'you', filter: { subtypes: ['Thopter'], other: true }, atMost: 0 });
  // Magma Sliver: a static's plural is the vocabulary's singular
  def = parseCard(row('Probe Sliver', 'All Slivers have "{T}: Target Sliver creature gets +1/+0 until end of turn."'));
  assert.equal(def.fullyParsed, true);
  assert.deepEqual((def.abilities[0] as { effect: { filter: unknown } }).effect.filter, { subtypes: ['Sliver'] });
  // a garbage filter is no longer a silent no-op: the line is unparsed
  def = parseCard(row('Probe Kicked', 'Whenever you cast a kicked spell, draw a card.'));
  assert.equal(def.fullyParsed, false);
});

test('a trigger about another object binds it as `that` before a family-parsed body that reads it', () => {
  const row: OracleRow = {
    name: 'Probe Peak', oracle_id: 'probe-composition-0001', mana_cost: '{3}{R}{R}', mana_value: 5, colors: ['R'], color_identity: ['R'],
    types: ['Creature'], supertypes: [], subtypes: ['Dragon'], type_line: 'Creature — Dragon',
    oracle_text: "Whenever another creature enters, Probe Peak deals damage equal to that creature's power to any target.",
    power: '5', toughness: '4', loyalty: null, keywords: [], layout: 'normal',
  };
  const def = parseCard(row);
  assert.equal(def.fullyParsed, true);
  const ab = def.abilities[0];
  assert.ok(ab.kind === 'triggered');
  assert.deepEqual(ab.effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'damage', amount: { count: 'power-of-that' }, target: { kind: 'any' } }]);
});

// ---------------------------------------------------------------------------------------------------------------
// the binding frame (9.0b review): a sentence that reads `that` / `those` / its controller / its mana value is bound
// to its antecedent, or unknown — never a silent no-op on a card that counts as parsed
// ---------------------------------------------------------------------------------------------------------------
const BIND: Effect = { op: 'bind', as: 'that', from: 'targets' };
const CYC = { types: ['Creature'], who: 'you' } as const;
test('a frame-reading sentence after a targeted antecedent that binds nothing gets the item\'s targets bound before it (CR 608.2h, 400.7)', () => {
  // Snakeskin Veil: counters bind nothing, so `that` would have been empty and hexproof never granted
  assert.deepEqual(parsed('Put a +1/+1 counter on target creature you control. It gains hexproof until end of turn.'),
    [BIND, { op: 'counters', target: { kind: 'creature', controller: 'you' }, counter: '+1/+1', amount: 1 }, { op: 'grant-keyword', target: 'that', keywords: ['hexproof'], duration: 'eot' }]);
  // Spidery Grasp: untap binds nothing either
  assert.deepEqual(parsed('Untap target creature. It gets +2/+4 and gains reach until end of turn.'),
    [BIND, { op: 'untap', target: { kind: 'creature' } }, { op: 'pump', target: 'that', power: 2, toughness: 4, keywords: ['reach'], duration: 'eot' }]);
  // Dream Fracture / Undermine / Access Denied: `counter` binds nothing, so "its controller" and "that spell's mana value"
  // were nobody and 0 — and a spell target is a stack ref the engine's `bind` cannot take either, so the sentence is
  // unknown until `counter` binds what it countered (docs/HANDOFF.md item 23)
  assert.deepEqual(parsed('Counter target spell. Its controller draws a card.'),
    [{ op: 'counter', target: { kind: 'spell' } }, { op: 'unknown', text: 'Its controller draws a card.' }]);
  assert.deepEqual(parsed("Counter target spell. Create X 1/1 colorless Thopter artifact creature tokens with flying, where X is that spell's mana value.").map(e => e.op), ['counter', 'unknown']);
  // a binding antecedent is left alone (destroy binds what it destroyed)
  assert.deepEqual(parsed('Destroy target creature. Its controller draws a card.'),
    [{ op: 'destroy', target: { kind: 'creature' } }, { op: 'scoped', who: 'controller-of-that', do: [{ op: 'draw', amount: 1, who: 'you' }] }]);
  // the bind lands inside the container the antecedent sits in, so a failed condition binds nothing
  assert.deepEqual(parsed('If ~ was kicked, gain control of target creature. Untap that creature.'),
    [{ op: 'conditional', condition: { kind: 'kicked' }, then: [BIND, { op: 'gain-control', target: { kind: 'creature' }, duration: 'permanent' }] }, { op: 'untap', target: 'that' }]);
});

test('"those" after a group antecedent iterates the same set (CR 608.2f), inside a conditional too', () => {
  // Gleam of Resistance / Tenacity / War Flare: pump binds nothing, so "those creatures" untapped nothing
  assert.deepEqual(parsed('Creatures you control get +1/+2 until end of turn. Untap those creatures.'),
    [{ op: 'pump', target: 'creatures-you-control', power: 1, toughness: 2, duration: 'eot' }, { op: 'for-each', over: CYC, do: [{ op: 'untap', target: 'that' }] }]);
  // Dauntless Unity: the "instead" template folds the first sentence into the else branch, after the reference
  assert.deepEqual(parsed('Creatures you control get +1/+1 until end of turn. If ~ was kicked, those creatures get +2/+1 until end of turn instead.'),
    [{ op: 'conditional', condition: { kind: 'kicked' }, then: [{ op: 'for-each', over: CYC, do: [{ op: 'pump', target: 'that', power: 2, toughness: 1, duration: 'eot' }] }], else: [{ op: 'pump', target: 'creatures-you-control', power: 1, toughness: 1, duration: 'eot' }] }]);
  // Savage Offensive: a grant binds nothing either; "they" is the same set
  assert.deepEqual(parsed('Creatures you control gain first strike until end of turn. If ~ was kicked, they get +1/+1 until end of turn.'),
    [{ op: 'grant-keyword', target: 'creatures-you-control', keywords: ['first strike'], duration: 'eot' }, { op: 'conditional', condition: { kind: 'kicked' }, then: [{ op: 'for-each', over: CYC, do: [{ op: 'pump', target: 'that', power: 1, toughness: 1, duration: 'eot' }] }] }]);
});

test('a frame-reading sentence nothing can bind is unknown — not the source, not a no-op', () => {
  // Puresight Merrow: look-top binds nothing and names no target or set
  assert.deepEqual(parsed('Look at the top card of your library. You may exile that card.'), [{ op: 'look-top', who: 'you', amount: 1 }, { op: 'unknown', text: 'You may exile that card.' }]);
  // on its own (no antecedent at all) the same sentences the tests above parse through `bound` are unknown
  assert.deepEqual(parsed('Its controller creates two Treasure tokens.'), [{ op: 'unknown', text: 'Its controller creates two Treasure tokens.' }]);
  assert.deepEqual(parsed('Untap those creatures.'), [{ op: 'unknown', text: 'Untap those creatures.' }]);
  // a group antecedent cannot say whose controller "its controller" is
  assert.deepEqual(parsed('Creatures you control get +1/+1 until end of turn. Its controller draws a card.'),
    [{ op: 'pump', target: 'creatures-you-control', power: 1, toughness: 1, duration: 'eot' }, { op: 'unknown', text: 'Its controller draws a card.' }]);
  // an earlier object target: `bind` takes every target of the item, so "that creature" would be the artifact
  assert.deepEqual(parsed('Untap target artifact. Gain control of target creature. Untap that creature.').map(e => e.op), ['untap', 'gain-control', 'unknown']);
  // the frame a caller holds: a sacrifice cost binds what was sacrificed; a spell is one item, so the bind goes into the earlier paragraph
  const fling = parseCard({ name: 'Flung', oracle_id: 'f', mana_cost: '{1}{R}', mana_value: 2, colors: ['R'], color_identity: ['R'], types: ['Instant'], supertypes: [], subtypes: [], type_line: 'Instant', oracle_text: "As an additional cost to cast this spell, sacrifice a creature.\nFlung deals damage equal to the sacrificed creature's power to any target.", power: null, toughness: null, loyalty: null, keywords: [], layout: 'normal' });
  assert.equal(fling.fullyParsed, true, fling.unparsed.join(' | '));
  const stolen = parseCard({ name: 'Thief', oracle_id: 't', mana_cost: '{1}{R}', mana_value: 2, colors: ['R'], color_identity: ['R'], types: ['Sorcery'], supertypes: [], subtypes: [], type_line: 'Sorcery', oracle_text: 'Gain control of target creature until end of turn.\nUntap that creature. It gains haste until end of turn.', power: null, toughness: null, loyalty: null, keywords: [], layout: 'normal' });
  assert.equal(stolen.fullyParsed, true, stolen.unparsed.join(' | '));
  assert.deepEqual(stolen.abilities.find(a => a.kind === 'spell')!.effects.map(e => e.op), ['bind', 'gain-control', 'untap', 'grant-keyword']);
});

test('the anthem "… you control have <keywords>" templates take every filter word the vocabulary makes expressible (CR 613.1e)', () => {
  const st = (text: string, types: string[] = ['Creature']) => { const d = parseCard({ name: 'Anthem', oracle_id: 'a', mana_cost: '{2}', mana_value: 2, colors: [], color_identity: [], types, supertypes: [], subtypes: [], type_line: types.join(' '), oracle_text: text, power: '2', toughness: '2', loyalty: null, keywords: [], layout: 'normal' }); const a = d.abilities[0]; return { fullyParsed: d.fullyParsed, effect: a && a.kind === 'static' ? JSON.parse(JSON.stringify(a.effect)) : null }; };
  // Blade Historian / Berserkers' Onslaught
  assert.deepEqual(st('Attacking creatures you control have double strike.'), { fullyParsed: true, effect: { kind: 'anthem', power: 0, toughness: 0, filter: { attacking: true }, scope: 'you-control', keywords: ['double strike'] } });
  // Halimar Tidecaller: a `types` list is any-of, so the filter is the land type alone and the anthem's creature gate does the rest
  assert.deepEqual(st('Land creatures you control have flying.'), { fullyParsed: true, effect: { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Land'] }, scope: 'you-control', keywords: ['flying'] } });
  assert.deepEqual(st('Other nonblack creatures you control have menace.').effect, { kind: 'anthem', power: 0, toughness: 0, filter: { notColors: ['B'] }, scope: 'other-you-control', keywords: ['menace'] });
  // Padeem, Consul of Innovation / Leonin Abunas: every artifact, not only creatures
  assert.deepEqual(st('Artifacts you control have hexproof.'), { fullyParsed: true, effect: { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Artifact'] }, scope: 'you-control', keywords: ['hexproof'], anyPermanent: true } });
  assert.deepEqual(st('Other enchantments you control have indestructible.').effect, { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Enchantment'] }, scope: 'other-you-control', keywords: ['indestructible'], anyPermanent: true });
  // a word no filter field carries still declines
  assert.equal(st('Legendary creatures you control have hexproof.').fullyParsed, false);
  assert.equal(st('Flying creatures you control have vigilance.').fullyParsed, false);
});

// ---------------------------------------------------------------------------------------------------------------
// the two parser debts
// ---------------------------------------------------------------------------------------------------------------
test('PARSER_VERSION is 3 and parse.ts carries no 0x08 byte (debt 5)', () => {
  assert.equal(PARSER_VERSION, 3);
  const src = fs.readFileSync(path.join(projectRoot(), 'src', 'cards', 'parse.ts'), 'utf8');
  assert.equal(src.includes('\x08'), false, 'a literal backspace byte where a \\b regex boundary was meant');
  assert.match(src, /\\bthis creature\\b\|\\bthis permanent\\b/);
});

test('the second face of a split / adventure / flip card is unparsed, in the form the script accounting expects (debt 4)', { skip: !hasDb }, () => {
  useScriptStore(new ScriptStore(path.join(projectRoot(), 'data', 'master', '.no-scripts')));
  const db = new CardDB();
  try {
    for (const [name, expected] of [
      ['Fire // Ice', ['Tap target permanent.', 'Draw a card.']],
      ['Bonecrusher Giant', ["Damage can't be prevented this turn. ~ deals 2 damage to any target."]],
      ['Akki Lavarunner', ['Protection from red', 'If a red source would deal damage to a player, it deals that much damage plus 1 to that player instead.']],
    ] as [string, string[]][]) {
      const def = db.get(name)!;
      assert.equal(def.fullyParsed, false, `${name}: the second half cannot be played, so the card is not fully parsed`);
      assert.deepEqual(def.unparsed.slice(-expected.length), expected, `${name}: the second face's lines, as secondFaceLines names them`);
      assert.deepEqual(secondFaceLines(def), expected);
      assert.ok(!def.abilities.some(a => a.kind === 'static' && a.effect.kind === 'unknown' && expected.includes(a.effect.text)), `${name}: no unknown ability is added for the second face`);
    }
    // transform / modal_dfc keep their back face on def.backFace, with the "// " marker, exactly as before
    const huntmaster = db.get('Huntmaster of the Fells')!;
    assert.ok(huntmaster.backFace);
    assert.deepEqual(secondFaceLines(huntmaster), []);
    assert.ok(huntmaster.unparsed.every(l => !secondFaceLines(huntmaster).includes(l)));
  } finally { db.close(); }
});

test('a non-self trigger body that reads the frame binds the triggering object; "it" after a sentence on the source is the source (9.0b re-review 2)', { skip: !hasDb }, () => {
  useScriptStore(new ScriptStore(path.join(projectRoot(), 'data', 'master', '.no-scripts')));
  const db = new CardDB();
  try {
    const trig = (name: string) => db.get(name)!.abilities.find(a => a.kind === 'triggered')!;
    // "Whenever ~ blocks or becomes blocked by a creature, destroy that creature. …" — `that` is the blocker, bound from the trigger
    const slagwurm = trig('Engulfing Slagwurm');
    assert.deepEqual(slagwurm.effects.slice(0, 2), [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'destroy', target: 'that' }]);
    // "When enchanted creature dies, return that card to its owner's hand."
    const vigor = trig('Demonic Vigor');
    assert.equal(vigor.effects[0].op, 'bind'); assert.equal((vigor.effects[0] as { from?: string }).from, 'triggering');
    // "Whenever you cast an instant or sorcery spell, this creature gets +1/+1 until end of turn. Untap it." — "it" is this creature, not the spell
    const weird = trig('Blistercoil Weird');
    assert.deepEqual(weird.effects, [{ op: 'pump', target: 'self', power: 1, toughness: 1, duration: 'eot' }, { op: 'untap', target: 'self' }]);
    assert.equal(db.get('Blistercoil Weird')!.fullyParsed, true);
  } finally { db.close(); }
});
