// The generic-deals-damage rule family (src/cards/rules/generic-deals-damage.ts, Phase 9.1p): the exact AST the
// parser emits for "~ deals N damage to that player", the hosts on which it is allowed to say it, and the near
// wordings the family must leave `unknown`.
//
// Sentences are written the way the parser sees them after parseCard's normalisation: the card's own name is `~`.
// Every claimed effect is also validated against the script schema, so a rule can never emit a shape a script could
// not carry.
//
// Two helpers, because this family's claim is host-sensitive. `parsed()` is the plain sentence ladder (the copy from
// test/parser-composition.test.ts) — off a trigger, every one of these sentences must come back `unknown`. `body()`
// parses a whole synthetic card and hands back the effects of its triggered ability, which is the only host the
// engine gives an `item.triggeringPlayer` to and therefore the only host on which the family claims anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, parseEffects, type OracleRow } from '../src/cards/parse.js';
import { EffectSchema } from '../src/cards/schema.js';
import { RULE_FAMILIES } from '../src/cards/rules/_registry.js';
import type { Effect, TriggeredAbility } from '../src/cards/types.js';

/** The effects of a wording (JSON-normalised: an explicit `undefined` member is no member), each checked against the script schema. */
function parsed(text: string): Effect[] {
  const effs = JSON.parse(JSON.stringify(parseEffects(text))) as Effect[];
  for (const e of effs) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return effs;
}

const row = (name: string, oracle_text: string, extra: Partial<OracleRow> = {}): OracleRow => ({
  name, oracle_id: `probe-${name.toLowerCase().replace(/\W+/g, '-')}`, mana_cost: '{2}{R}', mana_value: 3, colors: ['R'], color_identity: ['R'],
  types: ['Enchantment'], supertypes: [], subtypes: [], type_line: 'Enchantment', oracle_text, power: null, toughness: null, loyalty: null,
  keywords: [], layout: 'normal', ...extra,
});

/**
 * The effects of `<head>, <sentence>` as a triggered ability of a real card — the host `EffectCtx.host.triggering`
 * reports. `head` is always one the built-ins already parse, so a failure here is about the body and nothing else.
 */
function body(head: string, sentence: string): Effect[] {
  const def = parseCard(row('Probe Dreams', `${head}, ${sentence}`));
  const ab = def.abilities[0] as TriggeredAbility | undefined;
  assert.equal(ab?.kind, 'triggered', `${head} did not build a triggered ability: ${JSON.stringify(def.abilities)}`);
  assert.notEqual(ab!.event.on, 'unknown', `the built-ins no longer parse the probe head "${head}"`);
  const effs = JSON.parse(JSON.stringify(ab!.effects)) as Effect[];
  for (const e of effs) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return effs;
}

/** The block the family emits: N damage from the ability's source to the player the trigger was about. */
const dealsTo = (amount: number): Effect => ({ op: 'scoped', who: 'that-player', do: [{ op: 'damage-you', amount }] });

test('the generic-deals-damage family is registered from src/cards/rules/generic-deals-damage.ts', () => {
  assert.ok(RULE_FAMILIES.some(f => f.name === 'generic-deals-damage'));
});

// ---------------------------------------------------------------------------------------------------------------
// (a) CLAIMED: "~ deals N damage to that player" in a triggered ability's body
// ---------------------------------------------------------------------------------------------------------------
test('"~ deals N damage to that player" is a `scoped that-player` block around `damage-you` (CR 120.3, 608.2)', () => {
  // Underworld Dreams / Fate Unraveler / Ob Nixilis, the Hate-Twisted
  assert.deepEqual(body('Whenever an opponent draws a card', '~ deals 1 damage to that player.'), [dealsTo(1)]);
  // Aether Sting, Mindsparker, Ishi-Ishi, Akki Crackshot
  assert.deepEqual(body('Whenever an opponent casts a creature spell', '~ deals 2 damage to that player.'), [dealsTo(2)]);
  // Ruric Thar, the Unbowed — any literal count, not just the small ones
  assert.deepEqual(body('Whenever an opponent casts a creature spell', '~ deals 6 damage to that player.'), [dealsTo(6)]);
  // Shriek, Treblemaker: the dies trigger names the dead creature's controller
  assert.deepEqual(body('Whenever a creature an opponent controls dies', '~ deals 1 damage to that player.'), [dealsTo(1)]);
  // Gibbering Fiend, Sulfuric Vortex, Barbed Wire: the turn-based heads name the player whose step it is
  assert.deepEqual(body("At the beginning of each opponent's upkeep", '~ deals 3 damage to that player.'), [dealsTo(3)]);
});

test('the claim rides the built-in decompositions the sentence ladder hands the registry', () => {
  // Oath of Kaya's " and ": the damage half is the family's, the life half stays the built-in's
  assert.deepEqual(body('Whenever an opponent casts a creature spell', '~ deals 2 damage to that player and you gain 2 life.'),
    [dealsTo(2), { op: 'gain-life', amount: 2, who: 'you' }]);
  // Collapsing Borders' ", then" (written here with the head the built-ins parse)
  assert.deepEqual(body('Whenever an opponent draws a card', 'You gain 1 life, then ~ deals 3 damage to that player.'),
    [{ op: 'gain-life', amount: 1, who: 'you' }, dealsTo(3)]);
  // Soul Barrier: the built-in "unless they pay {N}" template wraps the claim, `who` already `that-player`
  assert.deepEqual(body('Whenever an opponent casts a creature spell', '~ deals 2 damage to that player unless they pay {2}.'),
    [{ op: 'unless-pays', who: 'that-player', cost: { mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, otherwise: [dealsTo(2)], otherwiseAs: 'controller' }]);
});

test('a claimed body makes the whole card fully parsed', () => {
  assert.equal(parseCard(row('Probe Dreams', 'Whenever an opponent draws a card, ~ deals 1 damage to that player.')).fullyParsed, true);
  assert.equal(parseCard(row('Probe Sting', 'Whenever an opponent casts a creature spell, ~ deals 1 damage to that player.')).fullyParsed, true);
});

// ---------------------------------------------------------------------------------------------------------------
// (b) DECLINED — the near wordings the family must leave `unknown`
// ---------------------------------------------------------------------------------------------------------------
test('off a triggered ability "that player" has no referent, so the sentence is declined', () => {
  // Keeper of the Flame prints it in an ACTIVATED ability. `that-player` would fall through to "the controller of
  // whatever the last op touched" and then to "the first player target" (src/engine/refs.ts `thatPlayer`) — somebody
  // else's seat. The rule declines rather than guess; the card stays unparsed.
  assert.deepEqual(parsed('~ deals 2 damage to that player.'), [{ op: 'unknown', text: '~ deals 2 damage to that player.' }]);
  const keeper = parseCard(row('Probe Keeper', '{R}, {T}: Choose target opponent who has more life than you do as you activate this ability. ~ deals 2 damage to that player.'));
  assert.ok(keeper.unparsed.length > 0, 'an activated "that player" must stay unparsed');
});

test('the wordings near the construct that the family leaves unknown', () => {
  const unknown = (s: string): Effect[] => [{ op: 'unknown', text: s }];
  // "X damage": no trigger head in the item defines X, and an undefined X evaluates 0 while the card counts as parsed
  assert.deepEqual(body('Whenever an opponent draws a card', '~ deals X damage to that player.'), unknown('~ deals X damage to that player.'));
  // Truth or Consequences / Blood Oath / Mob Verdict: the multiplier has no Amount form
  assert.deepEqual(body('Whenever an opponent draws a card', '~ deals 3 damage to that player for each consequences vote.'),
    unknown('~ deals 3 damage to that player for each consequences vote.'));
  // Curse of the Pierced Heart: a choice between a player and one of their planeswalkers — the `damage` op has no such target
  assert.deepEqual(body("At the beginning of each opponent's upkeep", '~ deals 1 damage to that player or a planeswalker that player controls.'),
    unknown('~ deals 1 damage to that player or a planeswalker that player controls.'));
  // Mob Verdict / The Fall of Kroog: no group word for "each creature that player controls"
  assert.deepEqual(body('Whenever an opponent draws a card', '~ deals 2 damage to that player and each creature that player controls.'),
    unknown('~ deals 2 damage to that player and each creature that player controls.'));
  // Barbflare Gremlin: the source is not ~
  assert.deepEqual(body('Whenever an opponent draws a card', 'That land deals 1 damage to that player.'),
    unknown('That land deals 1 damage to that player.'));
  // Searing Blaze: a "player or planeswalker" referent the engine does not bind
  assert.deepEqual(body('Whenever an opponent draws a card', '~ deals 3 damage to that player or planeswalker.'),
    unknown('~ deals 3 damage to that player or planeswalker.'));
});

test('the family claims nothing outside its own sentence: neighbouring damage wordings are untouched', () => {
  // the built-ins own these, and still do (a rule only ever sees what every built-in stage declined)
  assert.deepEqual(parsed('~ deals 2 damage to each opponent.'), [{ op: 'damage', amount: 2, target: 'each-opponent' }]);
  assert.deepEqual(parsed('~ deals 1 damage to you.'), [{ op: 'damage-you', amount: 1 }]);
  assert.deepEqual(body('Whenever an opponent draws a card', '~ deals 2 damage to each player.'), [{ op: 'damage', amount: 2, target: 'each-player' }]);
});
