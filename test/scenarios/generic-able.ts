// generic-able (Phase 9.1p): the group-scoped blocking requirement the parser wave claims — "Each creature <set>
// blocks this turn if able" (src/cards/rules/generic-able.ts).
//
// Written from the printed cards and CR 509.1c: a requirement is not a choice. The defending player never wants to
// chump-block, so each scenario declares NO block at all and asserts the engine put one there anyway — a scenario
// whose rule did nothing shows up as damage on the defending seat's life total, and as a non-zero `unsimulated`
// (without the rule the sentence is an `unknown` clause the engine has to skip).
import { type Scenario } from './dsl.js';

export const genericAble: Scenario[] = [
  {
    name: 'Predatory Rampage forces the creature an opponent controls to block', cr: '509.1c',
    ruling: 'CR 509.1c: "Each creature your opponents control blocks this turn if able" is a requirement on each of those creatures, so the defending player must declare a block that satisfies it.',
    seats: [
      { bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Grizzly Bears'], hand: ['Predatory Rampage'] },
      { bf: ['Walking Corpse'] },
    ],
    script: [
      { cast: 'Predatory Rampage' }, { resolve: true },
      { attack: ['Grizzly Bears'] },                               // no blocks declared: the requirement adds one
    ],
    expect: [
      { pt: ['Grizzly Bears', 5, 5] },                             // the same sentence's "+3/+3" half still applies
      { life: [1, 20] },                                           // nothing got through: the block really happened
      { log: 'Walking Corpse blocks Grizzly Bears \\(blocks if able\\)' },
      { zone: ['Walking Corpse', 'graveyard'] },                   // 5 power against toughness 2
      { zone: ['Grizzly Bears', 'battlefield'] },                  // 2 power against toughness 5
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Predatory Rampage marks every creature its opponent controls, not just one', cr: '509.1c',
    ruling: 'The requirement is on each creature separately (CR 608.2f), so both blockers are forced onto the lone attacker rather than one of them standing by.',
    seats: [
      { bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Grizzly Bears'], hand: ['Predatory Rampage'] },
      { bf: ['Walking Corpse', 'Bog Rats'] },
    ],
    script: [
      { cast: 'Predatory Rampage' }, { resolve: true },
      { attack: ['Grizzly Bears'] },
    ],
    expect: [
      { life: [1, 20] },
      { log: 'Walking Corpse blocks Grizzly Bears \\(blocks if able\\)' },
      { log: 'Bog Rats blocks Grizzly Bears \\(blocks if able\\)' },
      { zone: ['Grizzly Bears', 'battlefield'] },                  // 2 + 1 damage against toughness 5
      { unsimulated: 0 },
    ],
  },
  {
    name: "You've Been Caught Stealing's first mode makes every creature block if able", cr: '509.1c',
    ruling: 'The mode names every creature, not only an opponent\'s; an attacking creature is simply not able to block (CR 509.1a), so only the defender\'s creature is pulled in.',
    seats: [
      { bf: ['Mountain', 'Mountain', 'Grizzly Bears'], hand: ["You've Been Caught Stealing"] },
      { bf: ['Walking Corpse'] },
    ],
    script: [
      { cast: "You've Been Caught Stealing", modes: [0] }, { resolve: true },
      { attack: ['Grizzly Bears'] },
    ],
    expect: [
      { life: [1, 20] },
      { log: 'Walking Corpse blocks Grizzly Bears \\(blocks if able\\)' },
      { zone: ['Walking Corpse', 'graveyard'] },                   // 2/2 into 2/2: both die
      { zone: ['Grizzly Bears', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
];
