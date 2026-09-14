// The generic-still-land rule family (src/cards/rules/generic-still-land.ts, Phase 9.1p): real oracle wordings of
// CR 205.1b's retention clause and the exact AST the parser emits for them, the wordings the family must decline,
// and the printed cards the claim moves.
//
// Sentences are written the way the parser sees them **before** its own normalisation, i.e. exactly as they are
// printed: `parsed()` runs the whole sentence ladder, so the leading-pronoun rewrite parse.ts does inside
// parseEffectSentence ("It's still a land." -> "~'s still a land") happens here too and the pins are honest about
// what a card really says. Every claimed effect is also validated against the script schema, so a rule can never
// emit a shape a script could not carry.
//
// WHY THE CLAIMED EFFECT IS EMPTY. The clause grants nothing and changes no characteristic: it says that the
// type-changing effect of the same ability ADDS a card type rather than replacing one (CR 205.1b), which is what
// this engine's layers do unconditionally — `characteristics.ts` unions `o.animated` with the printed types. So the
// honest AST is the composition core's do-nothing container, and the test below pins that it really is inert: the
// scenarios in test/scenarios/generic-still-land.ts run the clause on printed cards and assert that nothing moved
// except the `unsimulated` count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseEffects } from '../src/cards/parse.js';
import { EffectSchema } from '../src/cards/schema.js';
import { RULE_FAMILIES } from '../src/cards/rules/_registry.js';
import { ScriptStore, useScriptStore } from '../src/cards/scripts.js';
import { CardDB } from '../src/cards/db.js';
import { MASTER_DB, projectRoot } from '../src/config/paths.js';
import type { Effect } from '../src/cards/types.js';

const hasDb = fs.existsSync(MASTER_DB());

/** The effects of a wording (JSON-normalised: an explicit `undefined` member is no member), each checked against the script schema. */
function parsed(text: string): Effect[] {
  const effs = JSON.parse(JSON.stringify(parseEffects(text))) as Effect[];
  for (const e of effs) if (e.op !== 'unknown') assert.doesNotThrow(() => EffectSchema.parse(e), `schema rejects ${JSON.stringify(e)}`);
  return effs;
}
/** The one effect the family emits: the composition core's empty container. */
const NOOP: Effect[] = [{ op: 'scoped', who: 'you', do: [] } as Effect];

test('the generic-still-land family is registered from src/cards/rules/generic-still-land.ts', () => {
  assert.ok(RULE_FAMILIES.some(f => f.name === 'generic-still-land'));
});

// ---------------------------------------------------------------------------------------------------------------
// CLAIMED — one pin per wording (CR 205.1b: a type-changing effect that adds a card type leaves the others on)
// ---------------------------------------------------------------------------------------------------------------

test('"It\'s still a land." is the retention clause of an animated land — an inert claim', () => {
  // Restless Reef, Celestial Colonnade, Creeping Tar Pit, Mutavault, Vivify, Wrenn and Realmbreaker, ... (94 printings)
  assert.deepEqual(parsed("It's still a land."), NOOP);
});

test('"It\'s still an artifact." / "It\'s still a creature." take the same shape', () => {
  // The other card types the engine's additive layers retain; the wordings src/cards/rules/layers.ts already listed.
  assert.deepEqual(parsed("It's still an artifact."), NOOP);
  assert.deepEqual(parsed("It's still a creature."), NOOP);
});

test('"It\'s still an enchantment." — Cacophony Unleashed', () => {
  assert.deepEqual(parsed("It's still an enchantment."), NOOP);
});

test('"He\'s still a planeswalker." — parse.ts rewrites "it", never a gendered pronoun', () => {
  // Gideon, Champion of Justice: "0: ... Gideon becomes a Human Soldier creature ... He's still a planeswalker."
  assert.deepEqual(parsed("He's still a planeswalker."), NOOP);
  assert.deepEqual(parsed("She's still a planeswalker."), NOOP);
});

test('"They\'re still lands." — the plural clause, after "All lands become 2/2 creatures until end of turn"', () => {
  // Natural Affinity, Sylvan Awakening, Life // Death, Kamahl's Will, Jolrael, Empress of Beasts, Nissa, Worldwaker
  assert.deepEqual(parsed("They're still lands."), NOOP);
  assert.deepEqual(parsed("They're still creatures."), NOOP);
  assert.deepEqual(parsed("They're still artifacts."), NOOP);
});

test('the clause does not swallow the sentence after it', () => {
  // Creeping Tar Pit's third sentence has to keep parsing on its own — a rule that matched greedily would eat it.
  assert.deepEqual(parsed("It's still a land. It can't be blocked this turn."), [
    NOOP[0],
    { op: 'grant-keyword', target: 'self', keywords: ['unblockable'], duration: 'eot' } as Effect,
  ]);
});

// ---------------------------------------------------------------------------------------------------------------
// DECLINED — the wordings that look like the construct and are not it
// ---------------------------------------------------------------------------------------------------------------

test('a retention clause that names a SUBTYPE is declined', () => {
  // Cavernous Maw ("It's still a Cave land.") and Duplicant ("It's still a Shapeshifter."). The clause retains a
  // subtype the ability's own type-changing effect never set, so claiming it would assert a layer that is not there.
  assert.deepEqual(parsed("It's still a Cave land."), [{ op: 'unknown', text: "It's still a Cave land." }]);
  assert.deepEqual(parsed("It's still a Shapeshifter."), [{ op: 'unknown', text: "It's still a Shapeshifter." }]);
});

test('a retention clause about something that is not a card type is declined', () => {
  // "card" is not a card type (All-You-Can-Eat Buffet, CR 108.1); a ZONE is not an object at all (Animate Graveyard,
  // Animate Library) and nothing in the engine's `animated` overlay can say a zone kept being a zone.
  assert.deepEqual(parsed("It's still a card."), [{ op: 'unknown', text: "It's still a card." }]);
  assert.deepEqual(parsed("It's still a graveyard."), [{ op: 'unknown', text: "It's still a graveyard." }]);
  assert.deepEqual(parsed("It's still a library."), [{ op: 'unknown', text: "It's still a library." }]);
  // Splice's rules gloss, not a type-changing effect's retention clause (Lifening Elemental).
  assert.deepEqual(parsed("It's still an instant or sorcery spell."), [{ op: 'unknown', text: "It's still an instant or sorcery spell." }]);
});

test('the INLINE "… that\'s still a land" spelling stays with src/cards/rules/layers.ts', () => {
  // One sentence, so the "becomes" half is in it: a rule that matched the tail alone would claim the sentence while
  // leaving the type change unexpressed. It is declined here and stays `becomeRule`'s business.
  assert.deepEqual(parsed("Target land becomes a 2/2 creature that's still a land."), [{ op: 'unknown', text: "Target land becomes a 2/2 creature that's still a land." }]);
});

// ---------------------------------------------------------------------------------------------------------------
// Printed cards — the claim in place on the real oracle text
// ---------------------------------------------------------------------------------------------------------------

test('printed cards: the retention clause is no longer an unknown effect', { skip: !hasDb }, () => {
  useScriptStore(new ScriptStore(path.join(projectRoot(), 'data', 'master', '.no-scripts')));
  const db = CardDB.shared();
  // Since 9.1px item 7 parse.ts folds a retention clause that FOLLOWS a type-changing sentence back into that
  // sentence ("… becomes a 3/3 creature in addition to its other types until end of turn", CR 205.1b's own words), so
  // on these two cards the clause never reaches this family as a sentence of its own: Vivify's animation now parses
  // whole (`become`, test/parser-core-9-1px.test.ts), and Jolrael's "All lands target player controls become …" is
  // declined by src/cards/rules/layers.ts for its subject, not for the retention. The family's own claim — a clause
  // with nothing before it to fold into — is pinned by the sentence tests above.
  for (const [name, clause, whole] of [['Vivify', "It's still a land.", true], ['Jolrael, Empress of Beasts', "They're still lands.", false]] as const) {
    const def = db.get(name);
    assert.ok(def, `${name} is in the master database`);
    const effs = def!.abilities.flatMap(a => a.kind === 'spell' || a.kind === 'activated' || a.kind === 'triggered' ? a.effects : []);
    assert.ok(!effs.some(e => e.op === 'unknown' && e.text === clause), `${name}: "${clause}" is not unknown any more`);
    assert.equal(def!.fullyParsed, whole, `${name}: fullyParsed`);
  }
});
