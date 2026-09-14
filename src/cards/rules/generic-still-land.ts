// Parser rules for the generic-still-land family (Phase 9.1p; the "sentence: it's still a <obj>" construct of
// data/scripts/batches/parse-wave-1-pool.json — 66 paper-pool cards, 94 printings of the sentence).
//
// THE CONSTRUCT. A type-changing effect that ADDS a card type spells the addition out in its own sentence:
//
//     {2}{U}{B}: Until end of turn, this land becomes a 4/4 blue and black Shark creature with deathtouch.
//     It's still a land.
//
// That trailing sentence is CR 205.1b's retention clause. It grants nothing, targets nothing and changes no
// characteristic: it says that the type-changing effect of the SAME ability adds `Creature` rather than replacing
// `Land` with it. docs/vocabulary/layers.md says the same thing from the engine side — `types()` and `subtypes()`
// UNION `o.animated` with the printed values, so under this engine's additive layer model the land never stopped
// being one — and docs/vocabulary/layers.md's wording table already names the shape the clause deserves: "an empty
// `scoped`". This family emits exactly that, the composition core's do-nothing container, so the sentence is claimed
// as the no-op it is instead of being left `unknown` and dragging its whole line into `def.unparsed`.
//
// WHY IT IS A FAMILY OF ITS OWN AND NOT A LINE OF src/cards/rules/layers.ts. layers.ts already registers
// `^it's still an? (?:land|artifact|creature|enchantment)$` — and that rule has never fired once. parse.ts rewrites
// the leading pronoun of every sentence BEFORE any template sees it (parseEffectSentence: "this creature"/"this
// permanent"/"that creature"/"that permanent"/"it" -> `~`, or -> the `thatobj` marker when an earlier sentence of
// the paragraph named another object). "It's still a land." therefore arrives as "~'s still a land", which the
// layers regex cannot match; the `thatobj` branch never fires either, because it demands a SPACE and a verb after
// the pronoun ("it gains", "it becomes") and "It's" has neither. The rules below are written against the text the
// parser actually hands a rule. No core change is needed for THAT: the clause is a no-op whatever its antecedent
// turns out to be, so losing the antecedent to the rewrite costs this family nothing.
//
// WHAT THIS FAMILY CANNOT FINISH. On 69 pool cards the line the clause sits on stays in `def.unparsed` all the same,
// because its OTHER half — "… becomes a 4/4 blue and black Shark creature with deathtouch" — is a wording
// src/cards/rules/layers.ts deliberately declines: read as one sentence, setting a creature subtype would have to
// replace the printed subtypes (CR 205.1a), and this engine's layers only union. `becomeRule` says so in as many
// words ("… and so is the 'It's still a land' retention, but that clause is its own SENTENCE, which a sentence rule
// cannot see"). Nothing in the registry can join the two: parse.ts splits a paragraph into sentences before any rule
// runs, and its whole-LINE hook is never reached for these cards (a triggered, loyalty, spell or cost-parsing
// activated line is claimed by a built-in branch above it). Closing that gap is a parse.ts change — the wave report's
// `coreChangeNeeded` carries the patch — and it is deliberately not made here.
//
// CLAIMS (sentence stage, EffectRule; every one of them an empty `scoped`)
//   "It's still a land."             -> "~'s still a land"           Restless Reef, Celestial Colonnade, Mutavault,
//                                                                    Creeping Tar Pit, Vivify, Wrenn and Realmbreaker
//   "It's still an enchantment."     -> "~'s still an enchantment"    Cacophony Unleashed
//   "He's still a planeswalker."     -> "he's still a planeswalker"   Gideon, Champion of Justice (parse.ts rewrites
//                                                                    "it", never a gendered pronoun)
//   "They're still lands."           -> "they're still lands"         Natural Affinity, Sylvan Awakening, Kamahl's
//                                                                    Will, Nissa, Worldwaker, Life // Death
//   ... for the card types the engine's additive layers really do retain: land, artifact, creature, enchantment,
//   planeswalker (CR 205.1b; the engine side is `become` / `animate` / `earthbend`, all of which union).
//
// DECLINES (each one has a pin in test/parser-generic-still-land.test.ts)
//   "It's still a Cave land."        Cavernous Maw. The clause retains a SUBTYPE, and the ability's `become` never
//                                    set `Cave` in the first place; claiming it would assert a subtype layer that is
//                                    not there. (The card's line is unparsed for a second reason anyway: "Activate
//                                    only if the number of other Caves you control plus the number of Cave cards in
//                                    your graveyard is three or greater.")
//   "It's still a Shapeshifter."     Duplicant — a creature type, same reason, and its host sentence is a static
//                                    ability ("this creature has the power, toughness, and creature types of ...")
//                                    the engine has no shape for.
//   "It's still a card."             All-You-Can-Eat Buffet. "card" is not a card type; the clause is about the top
//                                    card of a library being a Food token AND still a card (CR 108.1), which is not
//                                    a layer at all.
//   "It's still a graveyard."        Animate Graveyard, and "It's still a library." (Animate Library). A ZONE is not
//                                    an object: nothing in `o.animated` can say a zone kept being a zone.
//   "... that's still a land"        The inline spelling inside a "becomes" sentence ("Target land becomes a 2/2
//                                    creature that's still a land", earthbend's reminder). That is one sentence, so
//                                    it belongs to `becomeRule` in src/cards/rules/layers.ts, not here; a rule that
//                                    matched the tail alone would leave the "becomes" half unclaimed.
//   "It's still an instant or sorcery spell." / "(She's still legendary.)" / "(It's still an artifact.)"
//                                    Reminder text (parse.ts strips parenthesised reminders before a rule runs) and
//                                    splice's rules gloss — not a type-changing effect's retention clause.
//
// Nothing here imports parse.ts at runtime: the shared sub-parsers arrive on the EffectCtx the parser hands a rule
// (this family needs none of them — the clause has no sub-parse).
import type { CardType, Effect } from '../types.js';
import type { EffectRule, RuleFamily } from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------

/**
 * The card types whose retention this engine really does guarantee.
 *
 * The test is not "is this a card type" but "does `o.animated` ADD it": `characteristics.ts` unions the animated
 * types with the printed ones unless the overlay sets `replaceTypes`, and neither `animate` nor `become` nor
 * `earthbend` sets that from a parsed card. So for these five the retention clause is already true and an empty
 * container is the honest AST. Everything else — a subtype ("Cave land", "Shapeshifter"), a zone ("graveyard",
 * "library"), a non-type noun ("card") — is declined: see the DECLINES block in the header.
 */
const RETAINED: readonly CardType[] = ['Land', 'Artifact', 'Creature', 'Enchantment', 'Planeswalker'];
const SINGULAR = RETAINED.map(t => t.toLowerCase()).join('|');
const PLURAL = RETAINED.map(t => t.toLowerCase() + 's').join('|');

/**
 * The no-op the clause deserves: the composition core's `scoped` container with an empty body. `resolveWho` walks
 * "you", `applyList` is handed `[]`, nothing happens and nothing is left `unknown` — which is the whole point, since
 * one `unknown` sentence keeps the line it sits on out of `def.fullyParsed` and out of every simulation gate.
 */
const noop = (): Effect => ({ op: 'scoped', who: 'you', do: [] });

// ---------------------------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------------------------

const effects: EffectRule[] = [
  // "It's still a land." — `~` is what parse.ts leaves where the pronoun was (the source of the ability, or the
  // permanent an earlier sentence targeted; the clause is a no-op either way, so the rewrite costs nothing here).
  // "he"/"she" are in the alternation because parse.ts rewrites only the neuter pronouns: Gideon, Champion of
  // Justice really does read "He's still a planeswalker."
  { re: new RegExp(`^(?:~|he|she|it)'s still an? (?:${SINGULAR})$`, 'i'), make: noop },
  // "They're still lands." — the plural of the same clause, after "All lands become 2/2 creatures until end of turn"
  // and its kin. parse.ts rewrites no plural pronoun, so this one arrives verbatim.
  { re: new RegExp(`^they're still (?:${PLURAL})$`, 'i'), make: noop },
];

const family: RuleFamily = { name: 'generic-still-land', effects };
export default family;
