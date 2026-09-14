// The retention clause of a type-changing effect (Phase 9.1p, src/cards/rules/generic-still-land.ts):
// "It's still a land." / "They're still lands." / "He's still a planeswalker."
//
// HOW YOU TEST A CLAUSE THAT DOES NOTHING. CR 205.1b's retention clause grants no ability, targets nothing and
// changes no characteristic — it says the type-changing effect of the same ability ADDS a card type instead of
// replacing one, which is what this engine's layers do anyway. So there is no life total, no P/T and no zone that
// moves when the clause is claimed, and a scenario that asserted one would be asserting the wrong thing.
//
// What DOES move is the engine's "I skipped a clause" channel. An `unknown` effect makes game.ts emit an
// `unsimulated` event whose `clause` is the printed sentence, and the scenario DSL exposes both the count
// (`unsimulated`) and the log line (`(unsimulated text: "…")`). Each scenario below therefore pins three things at
// once:
//
//   * the sibling effect of the same ability really ran (a card drawn, two cards discarded) — so the scenario fails
//     if the ability did nothing at all;
//   * the permanent the clause is about is untouched: still on the battlefield, still untapped, still a land that
//     can be tapped for mana — the clause added no cost, no tap, no damage, nothing;
//   * `noLog` on the clause's own `unsimulated` line, and an exact `unsimulated` count. Both of those FAIL with
//     src/cards/rules/generic-still-land.ts reverted, which is what makes these real tests of the rule.
//
// The counts are 1, not 0, and that is the honest state of the pool: the "… becomes a 3/3 creature …" half of these
// same lines is a wording src/cards/rules/layers.ts DELIBERATELY declines (setting a creature subtype would replace
// the printed subtypes under an additive layer model — docs/vocabulary/layers.md, "What this model does not do").
// Nothing in this family may claim it, and weakening these to `unsimulated: 0` by pretending otherwise is exactly
// what test/scenarios/README.md convention 4 forbids.
import type { Scenario } from './dsl.js';

export const genericStillLand: Scenario[] = [
  {
    name: "Vivify's \"It's still a land.\" is a reminder: the animated land is untouched and the card is still drawn", cr: '205.1b',
    ruling: 'An effect that changes an object\'s card type adds it; the permanent keeps its other types. "It\'s still a land" says so and does nothing else.',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Mountain'], hand: ['Vivify'] }, {}],
    script: [{ cast: 'Vivify', targets: [['Mountain']] }, { resolve: true }],
    expect: [
      { zone: ['Vivify', 'graveyard'] },
      { handCount: [0, 1] },                       // the "Draw a card." line of the same spell still resolved
      { zone: ['Mountain', 'battlefield'] },       // the clause moved nothing …
      { tapped: ['Mountain', false] },             // … and cost nothing
      { noLog: 'unsimulated text: "It\'s still a land' },
      { unsimulated: 1 },                          // only the "Target land becomes a 3/3 creature …" half
    ],
  },
  {
    name: "Jolrael, Empress of Beasts: \"They're still lands.\" is the plural of the same reminder", cr: '205.1b',
    ruling: 'The lands keep the land type the animation did not replace; the clause itself has no effect on the game.',
    seats: [{ bf: ['Jolrael, Empress of Beasts', 'Forest', 'Forest', 'Forest'], hand: ['Grizzly Bears', 'Hill Giant'] }, {}],
    script: [{ activate: 'Jolrael, Empress of Beasts' }, { resolve: true }],
    expect: [
      { handCount: [0, 0] },                       // the "Discard two cards" half of the cost was really paid …
      { graveyardCount: [0, 2] },
      { tapped: ['Jolrael, Empress of Beasts', true] },
      { zone: ['Forest', 'battlefield'] },         // … and the lands the clause is about are untouched
      { noLog: 'unsimulated text: "They\'re still lands' },
      { unsimulated: 1 },                          // only the "All lands target player controls become 3/3 …" half
    ],
  },
];
