// The generic-able rule family (src/cards/rules/generic-able.ts, Phase 9.1p): the one wording of the `condition|able`
// construct the engine's vocabulary expresses exactly, and — the larger half of the file — the neighbouring wordings
// it must leave unknown.
//
// Sentences are written the way the parser sees them after parseCard's normalisation: the card's own name is `~`, the
// trailing full stop is gone, a leading "You may " is stripped. Every claimed effect is also validated against the
// script schema, so a rule can never emit a shape a per-card script could not carry.
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
/** The requirement every claimed wording puts on one member of its set (CR 509.1c). */
const BLOCKS = { op: 'blocks-if-able', target: 'that', duration: 'eot' };

test('the generic-able family is registered from src/cards/rules/generic-able.ts', () => {
  assert.ok(RULE_FAMILIES.some(f => f.name === 'generic-able'));
});

test('the family registers no conditions: "able" is half a combat requirement, not a condition', () => {
  const fam = RULE_FAMILIES.find(f => f.name === 'generic-able')!;
  // parse:why keys this construct `condition|able` because the sentence ladder splits "<effects> if <condition>" and
  // asks parseCondition for "able". Answering that split would wrap every "… if able" sentence in the pool in a
  // `conditional`, which is an effect that does not happen when the condition is false — not a requirement obeyed as
  // far as the restrictions allow (CR 509.1c). The claim is made on the whole sentence instead.
  assert.equal(fam.conditions, undefined);
  assert.deepEqual(parsed('Each creature your opponents control blocks this turn if able.').map(e => e.op), ['for-each']);
});

// ---------------------------------------------------------------------------------------------------------------
// (a) claimed: the group-scoped blocking requirement (CR 509.1c)
// ---------------------------------------------------------------------------------------------------------------

test('"Each creature your opponents control blocks this turn if able" iterates that set (CR 509.1c, 608.2f)', () => {
  // Predatory Rampage
  assert.deepEqual(parsed('Each creature your opponents control blocks this turn if able.'),
    [{ op: 'for-each', over: { types: ['Creature'], who: 'each-opponent' }, do: [BLOCKS] }]);
});

test('"Each creature blocks this turn if able" reaches every player\'s creatures', () => {
  // You've Been Caught Stealing, first mode ("Threaten the Merchant")
  assert.deepEqual(parsed('Each creature blocks this turn if able.'),
    [{ op: 'for-each', over: { types: ['Creature'] }, do: [BLOCKS] }]);
});

test('"Each creature you control blocks this turn if able" is the caster\'s own set', () => {
  assert.deepEqual(parsed('Each creature you control blocks this turn if able.'),
    [{ op: 'for-each', over: { types: ['Creature'], who: 'you' }, do: [BLOCKS] }]);
});

test('"Each creature an opponent controls blocks this turn if able" is the same set as "your opponents control"', () => {
  assert.deepEqual(parsed('Each creature an opponent controls blocks this turn if able.'),
    [{ op: 'for-each', over: { types: ['Creature'], who: 'each-opponent' }, do: [BLOCKS] }]);
});

test('the claimed wording reaches a printed card: Predatory Rampage is fully parsed', { skip: !hasDb }, () => {
  const def = CardDB.shared().get('Predatory Rampage')!;
  assert.ok(def, 'Predatory Rampage is in master.db');
  assert.deepEqual(def.unparsed, []);
  assert.equal(def.fullyParsed, true);
  assert.deepEqual(def.abilities[0].effects?.[1],
    { op: 'for-each', over: { types: ['Creature'], who: 'each-opponent' }, do: [BLOCKS] });
});

// ---------------------------------------------------------------------------------------------------------------
// (b) declined: the wordings of the same construct the engine cannot express, which must stay unknown
// ---------------------------------------------------------------------------------------------------------------

const unknownEffect = (text: string): void => {
  assert.deepEqual(parsed(text), [{ op: 'unknown', text: text.trim() }], `"${text}" must stay unknown`);
};

test('DECLINE: an attack requirement has no op at all — the engine\'s only one is a printed self-static', () => {
  // src/engine/game.ts reads `mustAttack` off the permanent's OWN def.abilities: there is no one-shot form, no
  // duration, no filter scope and no "attacks that player" slot (CR 508.1d).
  unknownEffect('Each creature attacks this turn if able.');                       // Goblin Diplomats
  unknownEffect('Creatures your opponents control attack this turn if able.');     // Bident of Thassa
  unknownEffect('Target creature attacks this turn if able.');                     // Into the Fray
});

test('DECLINE: a block requirement that names the attacker — `blocks-if-able` carries no attacker', () => {
  // `blockFixup` pairs a marked blocker with the first attacker it can legally block; these cards name one.
  unknownEffect('Target creature blocks ~ this turn if able.');                    // Sisters of Stone Death
  unknownEffect('Target creature blocks target creature this turn if able.');      // Hunt Down
});

test('DECLINE: a one-shot "must be blocked" — `must-be-blocked` is a static with a scope, not an effect', () => {
  // `lure` is the ALL form (every creature able to block it does so) and is strictly stronger, so it may not stand in.
  unknownEffect('Target creature must be blocked this turn if able.');             // Irresistible Prey
  unknownEffect('~ must be blocked each combat this turn if able.');               // Anzrag, the Quake-Mole
});

test('DECLINE: a duration the one-shot marker is not — only "this turn" is claimed', () => {
  // `blocks-if-able` writes a marker keyed by turn number and cleared at cleanup; "each combat" and the spans that
  // run to a later turn are neither that nor `duration: 'eot'`.
  unknownEffect('Each creature your opponents control blocks each combat if able.');
  unknownEffect('Each creature blocks this combat if able.');
});

test('DECLINE: the subject stays inside a closed vocabulary — a filter phrase is not guessed at', () => {
  // A loose tail would claim these and silently drop the words that decide which creatures are meant.
  unknownEffect('Each creature with flying blocks this turn if able.');
  unknownEffect('Each non-Wall creature the active player controls blocks this turn if able.');
});
