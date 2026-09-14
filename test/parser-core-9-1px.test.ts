// Phase 9.1px — the core parser changes the 9.1p parser-rule families declared they needed but were forbidden to
// make (data/scripts/batches/parse-wave-1-core.json). One block per item; every pin FAILS on the tree before its
// change. Sentences are written the way the parser sees them after parseCard's normalisation (the card's own name is
// `~`); every claimed effect is schema-validated so a change can never emit a shape a script could not carry. Where a
// change is observable only through a registry rule that no merged family carries yet (items 4, 16, 18), a probe
// family stands in for it, exactly as test/parser-registry.test.ts does.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCard, parseEffects, withFrame, type OracleRow } from '../src/cards/parse.js';
import { EffectSchema } from '../src/cards/schema.js';
import { registerRules, unregisterRules } from '../src/cards/rules/_registry.js';
import type { RuleFamily } from '../src/cards/rules/types.js';
import { renderEffect } from '../src/cards/render.js';
import { ABILITY_WORD_RE, FLAVOUR_PREFIX_RE, normalizeOracleLine } from '../src/cards/oracle-lines.js';
import { ScriptStore, useScriptStore } from '../src/cards/scripts.js';
import { CardDB } from '../src/cards/db.js';
import { MASTER_DB, projectRoot } from '../src/config/paths.js';
import { legalActions } from '../src/engine/legal.js';
import { runScenario } from '../src/verify/scenarioDsl.js';
import type { Effect, TriggeredAbility } from '../src/cards/types.js';

const hasDb = fs.existsSync(MASTER_DB());
const skip = !hasDb;

/** The effects of a wording (JSON-normalised: an explicit `undefined` member is no member), each checked against the script schema. */
function parsed(text: string): Effect[] {
  const effs = JSON.parse(JSON.stringify(parseEffects(text))) as Effect[];
  for (const e of effs) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return effs;
}
/** The same for a sentence whose antecedent sits outside it (a trigger about another object): parsed with the frame already bound. */
const bound = (text: string): Effect[] => withFrame(true, [], () => parsed(text));
/** A synthetic printing with the given oracle text, parsed by the built-in parser alone (plus whatever families are registered). */
function card(oracleText: string, o: Partial<OracleRow> = {}): ReturnType<typeof parseCard> {
  const row: OracleRow = {
    name: 'Probe Card', oracle_id: 'probe-9-1px-0001', mana_cost: '{2}{G}', mana_value: 3, colors: ['G'], color_identity: ['G'],
    types: ['Creature'], supertypes: [], subtypes: ['Golem'], type_line: 'Creature — Golem', oracle_text: oracleText,
    power: '2', toughness: '3', loyalty: null, keywords: [], layout: 'normal', ...o,
  };
  return parseCard(row);
}
const trig = (def: ReturnType<typeof parseCard>, i = 0): TriggeredAbility => { const t = def.abilities.filter(a => a.kind === 'triggered')[i]; assert.ok(t, `triggered ability ${i}`); return JSON.parse(JSON.stringify(t)) as TriggeredAbility; };
/** The parser-alone card, the way scripts/parse-snapshot.ts sees it (no per-card script applied). */
let bare: CardDB | null = null;
function printed(name: string) {
  if (!bare) { useScriptStore(new ScriptStore(path.join(projectRoot(), 'data', 'master', '.no-scripts'))); bare = CardDB.shared(); }
  const def = bare.get(name); assert.ok(def, `${name} is in the master database`); return def!;
}
const MANA = (raw: string, o: Partial<{ generic: number; pips: string[] }> = {}) => ({ generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw, ...o });

// ------------------------------------------------------------------ item 1: the paragraph template seeds the antecedent
test('item 1: a pronoun sentence after an `optional-then` / `optional-pay` template refers to what the template named (CR 608.2h / 110.5)', () => {
  // "You may sacrifice a creature. If you do, create a token that's a copy of target creature. It gains haste until
  // end of turn." — the trailing "It" used to fall back to the source because parseParagraph sliced the template's
  // match out of the paragraph before the sentence loop that sets `antecedent` ever ran.
  const behind = parsed("You may sacrifice a creature. If you do, create a token that's a copy of target creature. It gains haste until end of turn.");
  assert.deepEqual(behind, [
    { op: 'optional-then', first: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature'] }, amount: 1 }], then: [{ op: 'bind', as: 'that', from: 'targets' }, { op: 'copy-permanent', target: { kind: 'creature' } }] },
    { op: 'grant-keyword', target: 'that', keywords: ['haste'], duration: 'eot' },
  ]);
  // a template that names no object seeds nothing: the pronoun is still the source (the loot template here — the
  // `optional-pay` template's Y slot runs to the end of the paragraph, so a trailing sentence is nested inside it)
  assert.deepEqual(parsed('You may discard a card. If you do, draw a card. It gains flying until end of turn.')[1], { op: 'grant-keyword', target: 'self', keywords: ['flying'], duration: 'eot' });
});

test('item 1: the seeded antecedent never leaks out of its paragraph', () => {
  // the flag is module state: the first cut of this change set it after the template and captured the "saved" value
  // AFTER that, so every later paragraph of every later card inherited it ("When ~ enters, it deals 3 damage to any
  // target" then read `~` as the token of a card parsed minutes earlier and 49 printed cards lost a line)
  parsed("You may sacrifice a creature. If you do, create a token that's a copy of target creature. It gains haste until end of turn.");
  assert.deepEqual(parsed('It deals 3 damage to any target.'), [{ op: 'damage', amount: 3, target: { kind: 'any' } }]);
  assert.deepEqual(parsed('It gains flying until end of turn.'), [{ op: 'grant-keyword', target: 'self', keywords: ['flying'], duration: 'eot' }]);
});

// ------------------------------------------------------------------ item 2: "the number of cards in that player's hand" is a player property
test('item 2: "the number of cards in that player\'s / their / target player\'s hand" is the `{ prop, of }` form, not the controller\'s hand count (CR 603.2 / 608.2h)', () => {
  // the `count: 'cards-in-hand'` marker read `item.actor ?? item.controller`'s hand and ignored its `filter.other`
  assert.deepEqual(parsed("Target player mills X cards, where X is the number of cards in their hand."), [{ op: 'mill', amount: { prop: 'cards-in-hand', of: 'that-player' }, who: 'target-player' }]);
  assert.deepEqual(parsed("You gain life equal to the number of cards in target player's hand."), [{ op: 'gain-life', amount: { prop: 'cards-in-hand', of: 'target-player' }, who: 'you' }]);
  // parseParagraph's own rewrite: a "that player" after a "target player" IS the target player
  assert.deepEqual(parsed("Target player reveals their hand. You gain life equal to the number of cards in that player's hand."),
    [{ op: 'reveal-hand', who: 'target-player' }, { op: 'gain-life', amount: { prop: 'cards-in-hand', of: 'target-player' }, who: 'you' }]);
  assert.deepEqual(parsed("~ deals damage to target player equal to the number of cards in that player's hand."), [{ op: 'damage', target: { kind: 'player' }, amount: { prop: 'cards-in-hand', of: 'target-player' } }]);
  // the caster's own hand is unchanged
  assert.deepEqual(parsed('You gain life equal to the number of cards in your hand.'), [{ op: 'gain-life', amount: { count: 'cards-in-hand' }, who: 'you' }]);
});

test('item 2: a per-player hand count under an each-* subject is declined — neither form can say "each opponent\'s own hand" (CR 608.2f)', () => {
  // Stormbreath Dragon used to deal the CONTROLLER's hand size to each opponent; composition.ts's amountFor declines
  // the same pair, so the built-in does too rather than moving from one wrong answer to another
  assert.deepEqual(parsed("~ deals damage to each opponent equal to the number of cards in that player's hand."), [{ op: 'unknown', text: "~ deals damage to each opponent equal to the number of cards in that player's hand." }]);
  // the player-subject spelling is the registry's: composition.ts runs the clause AS each opponent, whose own hand
  // the plain count then reads — the built-in template declines it so that rule can answer
  assert.deepEqual(parsed('Each opponent loses life equal to the number of cards in their hand.'), [{ op: 'scoped', who: 'each-opponent', do: [{ op: 'lose-life', amount: { count: 'cards-in-hand' }, who: 'you' }] }]);
  // the same template with an amount that is not per player still parses
  assert.deepEqual(parsed('~ deals damage to each opponent equal to the number of creatures you control.'), [{ op: 'damage', target: 'each-opponent', amount: { count: 'permanents-you-control', filter: { types: ['Creature'] } } }]);
});

test('item 2: printed — Search Warrant and Sudden Impact read the target player\'s hand; Stormbreath Dragon is honestly unparsed', { skip }, () => {
  assert.deepEqual(printed('Search Warrant').abilities[0].effects, [{ op: 'reveal-hand', who: 'target-player' }, { op: 'gain-life', amount: { prop: 'cards-in-hand', of: 'target-player' }, who: 'you' }]);
  assert.deepEqual(printed('Sudden Impact').abilities[0].effects, [{ op: 'damage', target: { kind: 'player' }, amount: { prop: 'cards-in-hand', of: 'target-player' } }]);
  const dragon = printed('Stormbreath Dragon');
  assert.equal(dragon.fullyParsed, false);
  assert.ok(dragon.unparsed.some(l => /becomes monstrous/.test(l)), 'the monstrosity trigger is the unparsed line');
});

// ------------------------------------------------------------------ item 3: a scoped trigger body may not carry a printed target
test('item 3: "that player may put a +1/+1 counter on target creature of their choice" under a trigger is declined — the target would be chosen by the wrong player (CR 603.3d / 601.2c)', () => {
  // outside a trigger body the block is still claimed (a spell's controller chooses its targets: the right player)
  assert.deepEqual(parsed('Target player may put a +1/+1 counter on target creature of their choice.').map(e => e.op), ['scoped']);
  // inside a trigger about another player the same clause declines: `scoped` moves the ACTOR at resolution, but a
  // trigger's targets are chosen by `item.controller` when it goes on the stack
  const def = card('When ~ enters, that player may put a +1/+1 counter on target creature of their choice.');
  assert.deepEqual(trig(def).effects, [{ op: 'unknown', text: 'that player may put a +1/+1 counter on target creature of their choice.' }]);
  // a scoped block WITHOUT a target keeps working under a trigger
  assert.deepEqual(trig(card('When ~ enters, target opponent creates a 1/1 white Soldier creature token.')).effects.map(e => e.op), ['scoped']);
});

test('item 3: printed — Ley Line\'s body is unknown, not a counter placed by the Ley Line\'s controller', { skip }, () => {
  const ley = printed('Ley Line');
  assert.deepEqual(ley.abilities[0].effects, [{ op: 'unknown', text: 'that player may put a +1/+1 counter on target creature of their choice.' }]);
});

// ------------------------------------------------------------------ item 4: combat verbs reach the `thatobj` marker
{
  const PROBE: RuleFamily = {
    name: 'probe-9-1px-able',
    effects: [
      { re: /^thatobj blocks this turn if able$/i, make: () => ({ op: 'blocks-if-able', target: 'that', duration: 'eot' } as unknown as Effect) },
      { re: /^thatobj must be blocked this turn if able$/i, make: () => ({ op: 'lure', target: 'that', duration: 'eot' } as unknown as Effect) },
    ],
  };
  test('item 4: "It blocks this turn if able" / "It must be blocked …" after an antecedent is offered to the registry as the `thatobj` marker (CR 509.1c)', () => {
    // before: the leading pronoun in front of a combat verb was rewritten to `~` — the source — so a rule could only
    // ever have put the requirement on the sorcery; nothing claims the marker on main, so the wording stays unknown
    assert.deepEqual(parsed('Target creature gets -1/-0 until end of turn. It blocks this turn if able.')[1], { op: 'unknown', text: 'It blocks this turn if able.' });
    registerRules(PROBE);
    try {
      const effs = parsed('Target creature gets -1/-0 until end of turn. It blocks this turn if able.');
      // (`pump` records what it touched, so `that` needs no `bind` before it)
      assert.deepEqual(effs, [{ op: 'pump', target: { kind: 'creature' }, power: -1, toughness: 0, duration: 'eot' }, { op: 'blocks-if-able', target: 'that', duration: 'eot' }]);
      assert.deepEqual(parsed('Target creature gets +7/+7 and gains trample until end of turn. It must be blocked this turn if able.')[1], { op: 'lure', target: 'that', duration: 'eot' });
      // with no antecedent the pronoun is still the source, and `~ blocks …` is not the marker: honestly unknown
      assert.deepEqual(parsed('It blocks this turn if able.'), [{ op: 'unknown', text: 'It blocks this turn if able.' }]);
    } finally { unregisterRules(PROBE.name); }
  });
}

// ------------------------------------------------------------------ items 5 / 15: the two sentences after "You may pay {m}."
test('item 15: "You may pay {2}{R}. When you do, X" is the payment beside a `reflexive` (CR 603.12)', () => {
  assert.deepEqual(parsed('You may pay {2}{R}. When you do, ~ deals 3 damage to any target.'), [
    { op: 'optional-pay', mana: MANA('{2}{R}', { generic: 2, pips: ['R'] }), then: [] },
    { op: 'reflexive', when: 'you-do', effects: [{ op: 'damage', amount: 3, target: { kind: 'any' } }] },
  ]);
  // a rider after the reflexive belongs to it (`$` is load-bearing), so an unreadable rider declines the pair
  const rider = parsed('You may pay {2}{R}. When you do, ~ deals 3 damage to any target. Probe the rider.');
  assert.ok(rider.every(e => e.op === 'unknown' || e.op === 'reflexive'), JSON.stringify(rider));
  assert.ok(!rider.some(e => e.op === 'optional-pay'), 'the payment is not claimed without its consequence');
  // {X} and energy payments decline: `optional-pay` cannot choose X and {E} is not mana (CR 118.12)
  assert.ok(!parsed('You may pay {X}. When you do, draw a card.').some(e => e.op === 'optional-pay'));
  assert.ok(!parsed('You may pay {E}{E}. When you do, draw a card.').some(e => e.op === 'optional-pay'));
});

test('item 5: "You may pay {U}. If you don\'t, Y" is one `unless-pays` (CR 118.12)', () => {
  assert.deepEqual(parsed("You may pay {U}. If you don't, destroy target creature."), [{ op: 'unless-pays', who: 'you', cost: { mana: MANA('{U}', { pips: ['U'] }) }, otherwise: [{ op: 'destroy', target: { kind: 'creature' } }] }]);
  // Knight of the Mists' Y half ("destroy target Knight and it can't be regenerated") is not claimable, so the
  // payment is not claimed alone either — claiming it alone would invert the card
  const knight = parsed("You may pay {U}. If you don't, destroy target Knight and it can't be regenerated.");
  assert.ok(!knight.some(e => e.op === 'unless-pays') && knight.some(e => e.op === 'unknown'), JSON.stringify(knight));
});

test('items 5 / 15: printed — Sparktongue Dragon and Thousand Moons Crackshot parse whole; Knight of the Mists stays unparsed', { skip }, () => {
  const dragon = printed('Sparktongue Dragon');
  assert.equal(dragon.fullyParsed, true, dragon.unparsed.join(' | '));
  assert.deepEqual(trig(dragon).effects, [
    { op: 'optional-pay', mana: MANA('{2}{R}', { generic: 2, pips: ['R'] }), then: [] },
    { op: 'reflexive', when: 'you-do', effects: [{ op: 'damage', amount: 3, target: { kind: 'any' } }] },
  ]);
  assert.equal(printed('Thousand Moons Crackshot').fullyParsed, true);
  assert.equal(printed('Knight of the Mists').fullyParsed, false);
});

// ------------------------------------------------------------------ items 6 / 17: the renderer prints an empty `then` as the bare payment
test('items 6 / 17: an `optional-pay` with an empty `then` renders without a dangling "if you do,"', () => {
  assert.equal(renderEffect({ op: 'optional-pay', mana: MANA('{2}{R}', { generic: 2, pips: ['R'] }), then: [] }), 'you may pay {2}{R}');
  assert.equal(renderEffect({ op: 'optional-pay', mana: MANA('{2}', { generic: 2 }), then: [{ op: 'draw', amount: 1, who: 'you' }] }), 'you may pay {2}. if you do, you draw a card');
});

// ------------------------------------------------------------------ item 7: the CR 205.1b retention clause is folded into its sentence
test('item 7: "… becomes a 4/4 Shark creature. It\'s still a land." parses as one additive `become` (CR 205.1b)', () => {
  assert.deepEqual(parsed("Until end of turn, ~ becomes a 4/4 blue and black Shark creature with deathtouch. It's still a land."),
    [{ op: 'become', target: 'self', types: ['Creature'], subtypes: ['Shark'], colors: ['U', 'B'], power: 4, toughness: 4, keywords: ['deathtouch'], duration: 'eot' }]);
  assert.deepEqual(parsed("~ becomes a 2/2 Assembly-Worker artifact creature until end of turn. It's still a land."),
    [{ op: 'become', target: 'self', types: ['Artifact', 'Creature'], subtypes: ['Assembly-Worker'], power: 2, toughness: 2, duration: 'eot' }]);
  assert.deepEqual(parsed("Target land becomes a 3/3 creature until end of turn. It's still a land."),
    [{ op: 'become', target: { kind: 'land' }, types: ['Creature'], power: 3, toughness: 3, duration: 'eot' }]);
  // a sentence after the clause keeps its own reading (the land is the source of "It can't be blocked")
  assert.deepEqual(parsed("Until end of turn, ~ becomes a 3/2 blue and black Elemental creature. It's still a land. It can't be blocked this turn.")[1], { op: 'grant-keyword', target: 'self', keywords: ['unblockable'], duration: 'eot' });
  // "until your next turn" is deliberately not a `become` duration: still declined
  assert.ok(parsed("~ becomes a 3/3 Elemental creature until your next turn. It's still a land.").every(e => e.op === 'unknown'));
  // a subtype retention is not folded (it is not CR 205.1b's clause) and stays with the generic-still-land family's declines
  assert.ok(parsed("~ becomes a 2/2 Elemental creature until end of turn. It's still a Cave land.").some(e => e.op === 'unknown' && e.text === "It's still a Cave land."));
});

test('item 7: printed — the man-lands parse whole', { skip }, () => {
  for (const name of ['Restless Reef', "Mishra's Factory", 'Creeping Tar Pit', 'Celestial Colonnade', 'Vivify']) {
    const def = printed(name);
    assert.equal(def.fullyParsed, true, `${name}: ${def.unparsed.join(' | ')}`);
  }
  const reef = printed('Restless Reef').abilities.find(a => a.kind === 'activated' && /Shark/.test(a.text));
  assert.ok(reef && reef.kind === 'activated');
  assert.deepEqual(reef.effects, [{ op: 'become', target: 'self', types: ['Creature'], subtypes: ['Shark'], colors: ['U', 'B'], power: 4, toughness: 4, keywords: ['deathtouch'], duration: 'eot' }]);
  // Mutavault's "with all creature types" is still declined (no wording for it in layers.ts): honestly unparsed
  assert.equal(printed('Mutavault').fullyParsed, false);
});
test('item 7: printed — Jolrael\'s folded plural clause leaves one wholly unknown ability, which the engine no longer offers', { skip }, async () => {
  // "All lands target player controls become 3/3 creatures until end of turn. They're still lands." — the subject is
  // one layers.ts declines, so the fold turns [unknown, empty scoped] into [unknown]: nothing simulable is left and
  // src/engine/legal.ts does not offer the activation (before, the inert `scoped` made a do-nothing ability an action)
  const run = await runScenario({ name: 'board', cr: '205.1b', seats: [{ bf: ['Jolrael, Empress of Beasts', 'Forest', 'Forest', 'Forest'], hand: ['Grizzly Bears', 'Hill Giant'] }, {}], script: [{ sba: true }], expect: [{ stack: 0 }] });
  assert.deepEqual(run.failures, []);
  assert.equal(legalActions(run.game, 0).some(l => /Jolrael/.test(l.label)), false, 'the all-unknown ability is not an action');
  assert.deepEqual(printed('Jolrael, Empress of Beasts').abilities[0].effects.map(e => e.op), ['unknown']);
});

// ------------------------------------------------------------------ item 8: a trigger body's leading pronoun is the triggering object
test('item 8: "Whenever another creature you control enters, that creature gets +3/+3" pumps the creature that entered, not the source (CR 603.2 / 608.2h)', () => {
  const def = card('Whenever another creature you control enters, that creature gets +3/+3 until end of turn.');
  assert.deepEqual(trig(def).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'pump', target: 'that', power: 3, toughness: 3, duration: 'eot' }]);
  assert.deepEqual(trig(card('Whenever another creature you control attacks, it gains trample and indestructible until end of turn.')).effects,
    [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'grant-keyword', target: 'that', keywords: ['trample', 'indestructible'], duration: 'eot' }]);
  // a SELF trigger's "it" is still the source — an `or` head wholly about the source too ("Whenever ~ enters or
  // attacks"), and an UNKNOWN head that names the source ("Whenever ~ attacks alone") is read the way it will be the
  // day a family lands it as a self head
  assert.deepEqual(trig(card('Whenever ~ attacks, it gets +1/+0 until end of turn.')).effects, [{ op: 'pump', target: 'self', power: 1, toughness: 0, duration: 'eot' }]);
  assert.deepEqual(trig(card('Whenever ~ enters or attacks, it deals 2 damage to any target.')).effects, [{ op: 'damage', amount: 2, target: { kind: 'any' } }]);
  const alone = card('Whenever ~ attacks alone, it gets +2/+0 until end of turn.');
  assert.equal(trig(alone).event.on, 'unknown');
  assert.deepEqual(trig(alone).effects, [{ op: 'pump', target: 'self', power: 2, toughness: 0, duration: 'eot' }]);
  // … while a mixed `or` head ("~ or another Kavu") IS about the creature that entered, whichever it was
  assert.deepEqual(trig(card('Whenever ~ or another Kavu you control enters, it gets +1/+1 until end of turn.')).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'pump', target: 'that', power: 1, toughness: 1, duration: 'eot' }]);
  // an UNKNOWN head about ANOTHER object is that object's too (CR 608.2f / 702.6a): the line stays unparsed until
  // the equipped-attacks head lands, but its body no longer says the EQUIPMENT gains the deathtouch — the reading a
  // family landing the head would inherit, and the one parse:why's histogram sees (rerun 1 of the 9.1px review)
  const equipped = card('Whenever equipped creature attacks, it gains deathtouch until end of turn.', { types: ['Artifact'], subtypes: ['Equipment'], type_line: 'Artifact — Equipment', power: null, toughness: null });
  assert.equal(trig(equipped).event.on, 'unknown');
  assert.equal(equipped.fullyParsed, false);
  assert.deepEqual(trig(equipped).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'grant-keyword', target: 'that', keywords: ['deathtouch'], duration: 'eot' }]);
  // … a mixed unknown head ("~ or equipped creature") is whichever attacked — the triggering object either way
  assert.deepEqual(trig(card('Whenever ~ or equipped creature attacks, it gets +2/+0 until end of turn.')).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'pump', target: 'that', power: 2, toughness: 0, duration: 'eot' }]);
  // … and an unknown CAST head keeps the reading the known `cast` heads have (its object is a spell), so landing it moves nothing
  assert.deepEqual(trig(card('Whenever you cast a Dragon spell with mana value 5 or greater, it gains haste until end of turn.')).effects, [{ op: 'grant-keyword', target: 'self', keywords: ['haste'], duration: 'eot' }]);
  // hunk (b): a split-mode bullet under a trigger about another object is parsed under that trigger's frame
  const modal = card('Whenever another creature you control attacks, choose one —\n• It gains double strike until end of turn.\n• Draw a card.');
  assert.deepEqual(trig(modal).effects, [{ op: 'choose-mode', modes: [[{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'grant-keyword', target: 'that', keywords: ['double strike'], duration: 'eot' }], [{ op: 'draw', amount: 1, who: 'you' }]], count: 1 }]);
  // … and a SELF trigger's bullet keeps the source
  const own = card('Whenever ~ attacks, choose one —\n• It gains double strike until end of turn.\n• Draw a card.');
  assert.deepEqual(trig(own).effects, [{ op: 'choose-mode', modes: [[{ op: 'grant-keyword', target: 'self', keywords: ['double strike'], duration: 'eot' }], [{ op: 'draw', amount: 1, who: 'you' }]], count: 1 }]);
  // … while The Spear of Leonidas' shape — the bullets of an UNKNOWN head about another object — binds that object
  const spear = card('Whenever equipped creature attacks, choose one —\n• It gains double strike until end of turn.\n• Draw a card.', { types: ['Artifact'], subtypes: ['Equipment'], type_line: 'Artifact — Equipment', power: null, toughness: null });
  assert.equal(trig(spear).event.on, 'unknown');
  assert.deepEqual(trig(spear).effects, [{ op: 'choose-mode', modes: [[{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'grant-keyword', target: 'that', keywords: ['double strike'], duration: 'eot' }], [{ op: 'draw', amount: 1, who: 'you' }]], count: 1 }]);
});

test('item 8: printed — Primal Forcemage and Stonehoof Chieftain pump / grant the triggering creature', { skip }, () => {
  assert.deepEqual(trig(printed('Primal Forcemage')).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'pump', target: 'that', power: 3, toughness: 3, duration: 'eot' }]);
  assert.deepEqual(trig(printed('Stonehoof Chieftain')).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'grant-keyword', target: 'that', keywords: ['trample', 'indestructible'], duration: 'eot' }]);
  // "it deals damage equal to its power" is the entering creature's damage, which no rule claims: honestly unknown
  // rather than the source dealing its own power (Be'lakor, Warstorm Surge)
  assert.equal(printed('Warstorm Surge').fullyParsed, false);
});

test('item 8: printed — the "Whenever equipped creature attacks" bodies are the equipped creature\'s, never the Equipment\'s (CR 608.2f / 702.6a), while the head stays the family\'s', { skip }, () => {
  const BIND = { op: 'bind', as: 'that', from: 'triggering' };
  for (const name of ["Reaper's Talisman", 'Spiked Ripsaw', 'Strength-Testing Hammer', 'The Spear of Leonidas', 'Chainflail Centipede', 'Rafiq of the Many', 'Bestial Fury']) {
    const def = printed(name);
    assert.equal(def.fullyParsed, false, `${name} is unparsed until the head lands`);
    assert.ok(!JSON.stringify(def.abilities).includes('"target":"self"'), `${name} no longer targets the source anywhere`);
  }
  assert.deepEqual(trig(printed("Reaper's Talisman")).effects, [BIND, { op: 'grant-keyword', target: 'that', keywords: ['deathtouch'], duration: 'eot' }]);
  assert.deepEqual(trig(printed('Spiked Ripsaw')).effects, [BIND, { op: 'optional-then', first: [{ op: 'sacrifice', who: 'you', what: { subtypes: ['Forest'] }, amount: 1 }], then: [{ op: 'grant-keyword', target: 'that', keywords: ['trample'], duration: 'eot' }] }]);
  // the Hammer's third sentence is unknown, so the body carries no bind yet — but its pump is the attacker's
  assert.deepEqual(trig(printed('Strength-Testing Hammer')).effects.slice(0, 2), [{ op: 'roll-die', sides: 6 }, { op: 'pump', target: 'that', power: { count: 'roll-result' }, toughness: 0, duration: 'eot' }]);
  const spear = trig(printed('The Spear of Leonidas')).effects[0] as { op: string; modes: Effect[][] };
  assert.equal(spear.op, 'choose-mode');
  assert.deepEqual(spear.modes[0], [BIND, { op: 'grant-keyword', target: 'that', keywords: ['double strike'], duration: 'eot' }]);
  assert.deepEqual(trig(printed('Chainflail Centipede')).effects, [BIND, { op: 'pump', target: 'that', power: 2, toughness: 0, duration: 'eot' }]);
  // an unknown head that names the source alone keeps the source (Rogue Kavu's "Whenever ~ attacks alone", Knighted Myr's "… counters are put on ~")
  assert.deepEqual(trig(printed('Rogue Kavu')).effects, [{ op: 'pump', target: 'self', power: 2, toughness: 0, duration: 'eot' }]);
  assert.deepEqual(trig(printed('Knighted Myr')).effects, [{ op: 'grant-keyword', target: 'self', keywords: ['double strike'], duration: 'eot' }]);
});

// ------------------------------------------------------------------ item 9: a "land creature token" is a land
test('item 9: "land" in a token description is the card type Land, never a subtype (CR 305.6 / 111.4)', () => {
  assert.deepEqual(parsed('Create a 1/1 green Forest Dryad land creature token.'), [{ op: 'token', count: 1, power: 1, toughness: 1, colors: ['G'], types: ['Land', 'Creature'], subtypes: ['Forest', 'Dryad'], keywords: [], attacking: false }]);
});
test('item 9: printed — Awaken the Woods creates land creature tokens', { skip }, () => {
  const woods = printed('Awaken the Woods').abilities[0].effects[0] as { types?: string[]; subtypes?: string[] };
  assert.deepEqual(woods.types, ['Land', 'Creature']); assert.deepEqual(woods.subtypes, ['Forest', 'Dryad']);
});

// ------------------------------------------------------------------ item 10: "Max speed —" is a gate, not an ability word
test('item 10: "Max speed — <ability>" is neither stripped as an ability word nor as a flavour head (CR 702.179)', () => {
  assert.equal(ABILITY_WORD_RE.test('Max speed — {T}: Add {C}{C}.'), false);
  assert.equal(FLAVOUR_PREFIX_RE.test('Max speed — {T}: Add {C}{C}.'), false);
  assert.equal(normalizeOracleLine('Max speed — {T}: Add {C}{C}.'), 'Max speed — {T}: Add {C}{C}.');
  // the real ability words and flavour heads are still stripped
  assert.equal(normalizeOracleLine('Landfall — Whenever a land you control enters, draw a card.'), 'Whenever a land you control enters, draw a card.');
  assert.equal(normalizeOracleLine('Cure Wounds — You gain 2 life.'), 'You gain 2 life.');
  // and the line stays unparsed instead of parsing into an always-on ability
  const def = card('{T}: Add {C}.\nMax speed — {T}: Add {C}{C}.', { types: ['Land'], subtypes: [], type_line: 'Land', mana_cost: null, mana_value: 0, colors: [], power: null, toughness: null });
  assert.deepEqual(def.unparsed, ['Max speed — {T}: Add {C}{C}.']);
  assert.equal(def.abilities.filter(a => a.kind === 'activated').length, 1, 'only the printed unconditional mana ability');
});
test('item 10: printed — Muraganda Raceway, Vnwxt and Racers\' Scoreboard keep their max-speed line unparsed instead of always on', { skip }, () => {
  const raceway = printed('Muraganda Raceway');
  assert.ok(raceway.unparsed.includes('Max speed — {T}: Add {C}{C}.'));
  assert.deepEqual(raceway.abilities.filter(a => a.kind === 'activated').map(a => a.text), ['{T}: Add {C}.'], 'only the printed unconditional mana ability');
  assert.ok(!printed('Vnwxt, Verbose Host').abilities.some(a => a.kind === 'static' && a.effect.kind === 'draw-replacement'), 'no unconditional draw replacement');
  assert.ok(!printed("Racers' Scoreboard").abilities.some(a => a.kind === 'static' && a.effect.kind === 'cost-adjust'), 'no unconditional cost reduction');
});

// ------------------------------------------------------------------ items 11 / 13: "Whenever you attack" is once per combat
test('items 11 / 13: "Whenever you attack" is the `you-attack` event (once per combat, CR 508.1), not one `attacks` per attacker', () => {
  assert.deepEqual(trig(card('Whenever you attack, draw a card.')).event, { on: 'you-attack' });
  assert.deepEqual(trig(card('Whenever you attack with one or more creatures, draw a card.')).event, { on: 'you-attack' });
  // the per-attacker head is untouched
  assert.deepEqual(trig(card('Whenever a creature you control attacks, draw a card.')).event, { on: 'attacks', self: false, filter: { types: ['Creature'] } });
});
test('items 11 / 13: printed — Battlesong Berserker, Razorkin Hordecaller', { skip }, () => {
  assert.deepEqual(trig(printed('Battlesong Berserker')).event, { on: 'you-attack' });
  assert.deepEqual(trig(printed('Razorkin Hordecaller')).event, { on: 'you-attack' });
});

// ------------------------------------------------------------------ item 12: an objectless trigger binds nothing
test('item 12: a body that reads `that` / `those` under an OBJECTLESS trigger is unknown, not bound to the empty set (CR 603.2)', () => {
  // `you-attack`, `upkeep`, `combat-begin` … carry no object (game.ts sets triggeringId only from triggerCtx.obj)
  assert.deepEqual(trig(card('Whenever you attack, they gain indestructible until end of turn.')).effects, [{ op: 'unknown', text: 'they gain indestructible until end of turn.' }]);
  assert.deepEqual(trig(card('At the beginning of your upkeep, return it to your hand.')).effects.map(e => e.op), ['unknown']);
  // a body that binds its own antecedent is fine, and no longer carries a `bind … from triggering` that bound nothing
  assert.deepEqual(trig(card('At the beginning of your upkeep, exile target creature. Return that card to the battlefield under its owner\'s control.')).effects.map(e => e.op), ['exile', 'return-to-battlefield']);
  assert.deepEqual(trig(card('At the beginning of combat on your turn, other Spiders you control gain flying until end of turn.')).effects.map(e => e.op), ['for-each']);
  // an object event still binds the frame — including an `or` head one of whose events carries the object
  assert.deepEqual(trig(card("Whenever ~ or another creature you control enters, you gain life equal to that creature's toughness.")).effects,
    [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'gain-life', amount: { prop: 'toughness', of: 'that' }, who: 'you' }]);
});
test('item 12: printed — Cosmic Spider-Man and Aku Djinn lose the inert bind; Verdant Sun\'s Avatar keeps its frame', { skip }, () => {
  assert.deepEqual(trig(printed('Cosmic Spider-Man')).effects.map(e => e.op), ['for-each']);
  assert.deepEqual(trig(printed('Aku Djinn')).effects.map(e => e.op), ['for-each']);
  assert.equal(printed("Verdant Sun's Avatar").fullyParsed, true);
  // Inti's "It gains trample" named the +1/+1 counter's target — an object in the REFLEXIVE's own item: unknown now
  assert.ok(printed('Inti, Seneschal of the Sun').unparsed.some(l => /^Whenever you attack/.test(l)));
});

// ------------------------------------------------------------------ item 16: the registry hook's `may` wrapper honours the built-in guard
{
  const PROBE: RuleFamily = {
    name: 'probe-9-1px-may',
    effects: [
      { re: /^probe pay$/i, make: () => ({ op: 'optional-pay', mana: MANA('{2}', { generic: 2 }), then: [{ op: 'draw', amount: 1, who: 'you' }] } as Effect) },
      { re: /^probe optional search$/i, make: () => ({ op: 'search', filter: {}, to: 'hand', count: 1, optional: true } as Effect) },
      { re: /^probe draw$/i, make: () => ({ op: 'draw', amount: 1, who: 'you' } as Effect) },
    ],
  };
  test('item 16: a registry claim of a "you may …" sentence is not wrapped in a `may` when the op asks its own question or carries `optional`', () => {
    registerRules(PROBE);
    try {
      assert.deepEqual(parsed('You may probe pay.').map(e => e.op), ['optional-pay']);            // its own yes/no ask (PERMISSION_OPS)
      assert.deepEqual(parsed('You may probe optional search.').map(e => e.op), ['search']);       // its own `optional` form
      assert.deepEqual(parsed('You may probe draw.'), [{ op: 'may', effects: [{ op: 'draw', amount: 1, who: 'you' }] }]);   // the control: a plain op is still wrapped
    } finally { unregisterRules(PROBE.name); }
  });
}

// ------------------------------------------------------------------ item 18: "its power" is never a player's
{
  const PROBE: RuleFamily = { name: 'probe-9-1px-enchanted-dies', triggers: [{ make: head => /^when enchanted creature dies$/i.test(head) ? { on: 'dies', self: false, filter: { attachedToSource: true }, controller: 'any' } : null }] };
  test('item 18: "target player loses X life …, where X is its power" / "that creature\'s controller loses life equal to its toughness" read the object, not the player (CR 208.1 / 608.2h)', () => {
    // Dying Wish: X was the target PLAYER's power (always 0); Banewasp Affliction: the Aura's toughness (null)
    assert.deepEqual(bound('target player loses X life and you gain X life, where X is its power.'),
      [{ op: 'choose-mode', modes: [[{ op: 'lose-life', amount: { count: 'power-of-that' }, who: 'target-player' }, { op: 'gain-life', amount: { count: 'power-of-that' }, who: 'you' }]], count: 1 }]);
    assert.deepEqual(bound("that creature's controller loses life equal to its toughness."), [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: { prop: 'toughness', of: 'that' }, who: 'you' }] }]);
    // Death Watch already read both right; unchanged
    assert.deepEqual(bound('its controller loses life equal to its power and you gain life equal to its toughness.'),
      [{ op: 'scoped', who: 'you', do: [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: { count: 'power-of-that' }, who: 'you' }] }, { op: 'gain-life', amount: { prop: 'toughness', of: 'that' }, who: 'you' }] }]);
    // an OBJECT subject keeps its own reading
    assert.deepEqual(parsed('Target creature gets +X/+0 until end of turn, where X is its power.'), [{ op: 'pump', target: { kind: 'creature' }, power: { prop: 'power', of: 'target:0' }, toughness: 0, duration: 'eot' }]);
  });
  test('item 18: printed — with the head a family will land, Dying Wish and Banewasp Affliction bind the dead creature', { skip }, () => {
    registerRules(PROBE);
    try {
      const wish = trig(printed('Dying Wish'));
      assert.deepEqual(wish.event, { on: 'dies', self: false, filter: { attachedToSource: true }, controller: 'any' });
      assert.deepEqual(wish.effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'choose-mode', modes: [[{ op: 'lose-life', amount: { count: 'power-of-that' }, who: 'target-player' }, { op: 'gain-life', amount: { count: 'power-of-that' }, who: 'you' }]], count: 1 }]);
      assert.deepEqual(trig(printed('Banewasp Affliction')).effects, [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: { prop: 'toughness', of: 'that' }, who: 'you' }] }]);
    } finally { unregisterRules(PROBE.name); }
  });
}

after(() => { /* the bare-parse store stays: every db read in this file is parser-alone */ });
