// The generic-you-do rule family (Phase 9.1p, src/cards/rules/generic-you-do.ts): the printed "You may X. If you do,
// Y" cards the family finishes, played out on the real board.
//
// Every scenario here is on a PRINTED card and fails with the rule file reverted — with the family gone the X (or Y)
// half is `unknown`, the built-in "You may X. If you do, Y" template declines, the line is recorded unparsed and the
// ability does nothing, so the `unsimulated: 0` and the zone / keyword expectations all break at once.
//
// The construct's own decline is deliberate and is pinned in test/parser-generic-you-do.test.ts, not here: a card
// whose "You may X." is not the first sentence of its paragraph still leaves the "If you do," link unparsed.
import type { Scenario } from './dsl.js';

export const genericYouDo: Scenario[] = [
  {
    // The X half is "return another creature you control to its owner's hand" (`return-own` with `other`).
    name: 'Temur Sabertooth returns another creature and, because it did, gains indestructible', cr: '608.2',
    ruling: '"If you do" is checked and its effect applied during the same resolution, not as a separate ability.',
    seats: [{ bf: ['Temur Sabertooth', 'Grizzly Bears', 'Forest', 'Forest'] }, {}],
    script: [{ activate: 'Temur Sabertooth' }, { answer: true }, { resolve: true }],
    expect: [
      { zone: ['Grizzly Bears', 'hand'] },
      { zone: ['Temur Sabertooth', 'battlefield'] },
      { keywords: ['Temur Sabertooth', ['indestructible']] },
      { unsimulated: 0 },
    ],
  },
  {
    // "another" must exclude the source: with no other creature there is nothing to return, so nothing happens.
    name: 'Temur Sabertooth cannot return itself, so with no other creature nothing is returned', cr: '109.5',
    ruling: '"Another" means a permanent other than the source of the ability.',
    seats: [{ bf: ['Temur Sabertooth', 'Forest', 'Forest'] }, {}],
    script: [{ activate: 'Temur Sabertooth' }, { answer: true }, { resolve: true }],
    expect: [
      { zone: ['Temur Sabertooth', 'battlefield'] },
      { handCount: [0, 0] },
      { unsimulated: 0 },
    ],
  },
  {
    // The X half is "exile a creature card from your graveyard" (a `move` of a chosen graveyard set); the Y half is
    // the printed target, chosen when the triggered ability goes on the stack.
    name: "Masked Vandal exiles a creature card from its controller's graveyard and then exiles an artifact", cr: '608.2',
    ruling: 'The optional exile from the graveyard is part of the resolution; the "if you do" exile follows it immediately.',
    seats: [{ bf: ['Forest', 'Forest', 'Forest'], hand: ['Masked Vandal'], graveyard: ['Grizzly Bears'] }, { bf: ['Ornithopter'] }],
    script: [{ cast: 'Masked Vandal' }, { answer: true }, { resolve: true }],
    expect: [
      { zone: ['Grizzly Bears', 'exile'] },
      { zone: ['Ornithopter', 'exile'] },
      { zone: ['Masked Vandal', 'battlefield'] },
      { unsimulated: 0 },
    ],
  },
  {
    // The X half is "discard all the cards in your hand"; "that many" then reads the number actually discarded.
    name: 'Forgotten Creation discards its controller\'s whole hand and draws that many cards', cr: '701.8a',
    ruling: 'Discarding "all the cards in your hand" discards every card at once; "that many" is the number discarded.',
    seats: [{ bf: ['Forgotten Creation', 'Island'], hand: ['Grizzly Bears', 'Hill Giant', 'Lightning Bolt'] }, {}],
    script: [{ turns: 1 }, { passUntil: 'upkeep' }, { answer: true }, { resolve: true }],
    expect: [
      { zone: ['Grizzly Bears', 'graveyard'] },
      { zone: ['Hill Giant', 'graveyard'] },
      { zone: ['Lightning Bolt', 'graveyard'] },
      { handCount: [0, 3] },
      { unsimulated: 0 },
    ],
  },
];
