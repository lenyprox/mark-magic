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
// Vivify's count is 0 since 9.1px item 7: parse.ts folds the retention clause back into the "Target land becomes a
// 3/3 creature …" sentence it qualifies (CR 205.1b's own words, "in addition to its other types"), so layers.ts sees
// the retention and the animation runs — the Mountain is a 3/3 creature AND still a land that taps for mana.
// Weakening a count by pretending is what test/scenarios/README.md convention 4 forbids; the count is what the
// parser really claims.
import type { Scenario } from './dsl.js';

export const genericStillLand: Scenario[] = [
  {
    name: "Vivify's \"It's still a land.\" is a reminder: the animated land is a 3/3 creature that is still a land, and the card is still drawn", cr: '205.1b',
    ruling: 'An effect that changes an object\'s card type adds it; the permanent keeps its other types. "It\'s still a land" says so and does nothing else — the animation is what the sentence before it does.',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Mountain'], hand: ['Vivify'] }, {}],
    script: [{ cast: 'Vivify', targets: [['Mountain']] }, { resolve: true }],
    expect: [
      { zone: ['Vivify', 'graveyard'] },
      { handCount: [0, 1] },                       // the "Draw a card." line of the same spell still resolved
      { zone: ['Mountain', 'battlefield'] },       // the clause moved nothing …
      { tapped: ['Mountain', false] },             // … and cost nothing
      { pt: ['Mountain', 3, 3] },                  // … and the sentence it qualifies animated the land (9.1px item 7)
      { noLog: 'unsimulated text: "It\'s still a land' },
      { unsimulated: 0 },                          // the whole line parses: the fold lets layers.ts see the retention
    ],
  },
  // Jolrael, Empress of Beasts ("They're still lands.") used to sit here as the plural of the same reminder. Since
  // 9.1px item 7 the clause is folded into "All lands target player controls become 3/3 creatures …", which
  // src/cards/rules/layers.ts declines for its SUBJECT, so the whole ability is one unknown effect and the engine no
  // longer offers it at all (src/engine/legal.ts: an ability whose every effect is unknown is not an action) — the
  // honest state, pinned in test/parser-core-9-1px.test.ts rather than as a board that cannot activate it.
];
