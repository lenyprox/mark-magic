// Saga family (Phase 9.1, docs/vocabulary/saga.md): one scenario per op, per trigger, per condition, per as-enters
// kind, per target kind and per keyword parameter of each.
//
// Written from the printed cards and CR 714. Most of them use real Sagas — History of Benalia is the reference
// chapter track (I, II create a Knight; III pumps Knights; sacrificed after III) — and the handful that pin an op
// parameter no printed card spells out on its own (`each-saga-you-control`, `remove`, `who: 'any'`,
// `when: 'resolves'`) script a real card through the DSL's `scripts` field, the way test/scenarios/composition.ts
// does.
import type { Effect } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>" (the printed vanilla body stays). */
const bears = (effects: Effect[], text = 'saga'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects, text }] } });

export const saga: Scenario[] = [
  // ---------------------------------------------------------------- saga-lore (the op) + the `saga` target kind
  {
    name: 'Keldon Warcaller puts a lore counter on target Saga, and the chapter it reaches triggers', cr: '714.2b',
    ruling: 'A chapter ability triggers when the number of lore counters becomes greater than or equal to its number.',
    seats: [{ bf: ['Keldon Warcaller', 'History of Benalia'], counters: { 'History of Benalia': { lore: 1 } } }, {}],
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { counters: ['History of Benalia', { lore: 2 }] },
      // chapter II made a Knight; nothing else on seat 0's battlefield changed
      { zoneCount: [0, 'battlefield', 3] },
      { log: 'History of Benalia gets 1 lore counter' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a Saga an opponent controls is not a legal target for "target Saga you control"', cr: '115.4',
    ruling: 'A spell or ability can only choose targets that match its target specification.',
    seats: [{ bf: ['Keldon Warcaller'] }, { bf: ['History of Benalia'], counters: { 'History of Benalia': { lore: 1 } } }],
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { counters: ['History of Benalia', { lore: 1 }] },
      { zoneCount: [1, 'battlefield', 1] },
      { noLog: 'gets 1 lore counter' },
    ],
  },
  {
    name: 'two lore counters at once trigger both chapters they cross', cr: '714.2b',
    ruling: 'Putting two lore counters on a Saga with none triggers chapter I and chapter II.',
    seats: [{ bf: ['Grizzly Bears', 'History of Benalia'] }, {}],
    scripts: bears([{ op: 'saga-lore', target: { kind: 'saga', controller: 'you' }, amount: 2 }]),
    script: [{ activate: 'Grizzly Bears', targets: [['History of Benalia']] }, { resolve: true }],
    expect: [
      { counters: ['History of Benalia', { lore: 2 }] },
      // Grizzly Bears + History of Benalia + the two Knights chapters I and II each made
      { zoneCount: [0, 'battlefield', 4] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'removing a lore counter does not trigger a chapter ability', cr: '714.2b',
    ruling: 'Chapter abilities trigger only when lore counters are put on the Saga, never when they are removed.',
    seats: [{ bf: ['Grizzly Bears', 'History of Benalia'], counters: { 'History of Benalia': { lore: 2 } } }, {}],
    scripts: bears([{ op: 'saga-lore', target: { kind: 'saga', controller: 'you' }, amount: 1, remove: true }]),
    script: [{ activate: 'Grizzly Bears', targets: [['History of Benalia']] }, { resolve: true }],
    expect: [
      { counters: ['History of Benalia', { lore: 1 }] },
      // no Knight was made: the board is still Grizzly Bears and the Saga
      { zoneCount: [0, 'battlefield', 2] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a lore counter on each Saga you control leaves the opponent\'s Sagas alone', cr: '714.2b',
    seats: [
      { bf: ['Grizzly Bears', 'History of Benalia', 'The Antiquities War'] },
      { bf: ['History of Benalia'], counters: { 'History of Benalia': { lore: 2 } } },
    ],
    scripts: bears([{ op: 'saga-lore', target: 'each-saga-you-control', amount: 1 }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [
      { counters: ['History of Benalia', { lore: 1 }] },        // seat 0's copy (search order: seat 0 first)
      { counters: ['The Antiquities War', { lore: 1 }] },
      { zoneCount: [1, 'battlefield', 1] },                     // seat 1's Saga gained nothing, so no chapter III
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- read ahead (as-enters + counter replacement)
  {
    name: 'read ahead starts The Cruelty of Gix on the chosen chapter and skips the ones below it', cr: '714.4b',
    ruling: 'As the Saga enters, choose a chapter and start with that many lore counters. Skipped chapters do not trigger.',
    seats: [
      { bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['The Cruelty of Gix'] },
      { graveyard: ['Grizzly Bears'] },
    ],
    script: [{ answer: 3 }, { cast: 'The Cruelty of Gix' }, { resolve: true }],
    expect: [
      { log: 'read ahead' },
      { control: ['Grizzly Bears', 0] },                         // chapter III resolved
      { zone: ['Grizzly Bears', 'battlefield'] },
      { life: [0, 20] },                                         // chapter II ("You lose 3 life") was skipped
      { zone: ['The Cruelty of Gix', 'graveyard'] },             // CR 714.4: sacrificed once the final chapter resolved
      { unsimulated: 0 },
    ],
  },
  {
    name: 'read ahead with chapter I chosen runs the Saga from the top', cr: '714.4b',
    ruling: 'Chapter I is always a legal choice; the Saga then behaves exactly as one without read ahead.',
    seats: [
      { bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['The Cruelty of Gix'] },
      { hand: ['Grizzly Bears'] },
    ],
    script: [{ answer: 1 }, { cast: 'The Cruelty of Gix' }, { resolve: true }],
    expect: [
      { counters: ['The Cruelty of Gix', { lore: 1 }] },
      { handCount: [1, 0] },                                     // chapter I made seat 1 discard its only creature
      { zone: ['Grizzly Bears', 'graveyard'] },
      { life: [0, 20] },
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- lore-counter-put
  {
    name: 'Sigurd sees the lore counter Keldon Warcaller puts on a Saga you control', cr: '714.2b',
    ruling: 'Sigurd\'s trigger sees the counter the Warcaller\'s attack trigger put on the Saga, and puts a +1/+1 counter on the only other creature it can choose.',
    seats: [{ bf: ['Sigurd, Jarl of Ravensthorpe', 'Keldon Warcaller', 'History of Benalia'], counters: { 'History of Benalia': { lore: 1 } } }, {}],
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { counters: ['History of Benalia', { lore: 2 }] },
      { counters: ['Keldon Warcaller', { '+1/+1': 1 }] },
      { pt: ['Keldon Warcaller', 3, 3] },
      { life: [1, 17] },                                         // the 3/3 Warcaller connected
    ],
  },
  {
    name: 'a "whenever a lore counter is put on a Saga" trigger sees an opponent\'s Saga too', cr: '714.2b',
    seats: [
      { bf: ['Grizzly Bears'] },
      { bf: ['History of Benalia'], counters: { 'History of Benalia': { lore: 1 } } },
    ],
    scripts: {
      'Grizzly Bears': { abilities: [
        { kind: 'activated', cost: { tap: true }, effects: [{ op: 'saga-lore', target: { kind: 'saga', controller: 'opponent' }, amount: 1 }], text: 'saga' },
        { kind: 'triggered', event: { on: 'lore-counter-put', who: 'any' }, effects: [{ op: 'gain-life', amount: 4, who: 'you' }], text: 'saga' },
      ] },
    },
    script: [{ activate: 'Grizzly Bears', targets: [['History of Benalia']] }, { resolve: true }],
    expect: [
      { counters: ['History of Benalia', { lore: 2 }] },
      { life: [0, 24] },
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- saga-final-chapter
  {
    name: "Historian's Boon sees the final chapter of a Saga you control trigger", cr: '714.2b',
    ruling: 'The final chapter ability triggers when the lore total reaches the highest chapter number.',
    seats: [{ bf: ["Historian's Boon", 'Keldon Warcaller', 'History of Benalia'], counters: { 'History of Benalia': { lore: 2 } } }, {}],
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { log: 'Angel' },
      // Historian's Boon + Keldon Warcaller + the 4/4 Angel (the Saga was sacrificed after chapter III resolved)
      { zoneCount: [0, 'battlefield', 3] },
      { zone: ['History of Benalia', 'graveyard'] },
    ],
  },
  {
    name: 'a non-final chapter does not fire a "final chapter ability triggers" trigger', cr: '714.2b',
    seats: [{ bf: ["Historian's Boon", 'Keldon Warcaller', 'History of Benalia'], counters: { 'History of Benalia': { lore: 1 } } }, {}],
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { counters: ['History of Benalia', { lore: 2 }] },
      { noLog: 'Angel' },
      { zone: ['History of Benalia', 'battlefield'] },
    ],
  },
  {
    name: 'the final chapter ability resolving is what sacrifices the Saga, and what a "resolves" trigger sees', cr: '714.4',
    ruling: 'The Saga is sacrificed as a state-based action once the final chapter ability has left the stack.',
    seats: [{ bf: ['Grizzly Bears', 'Keldon Warcaller', 'History of Benalia'], counters: { 'History of Benalia': { lore: 2 } } }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'saga-final-chapter', who: 'you', when: 'resolves' }, effects: [{ op: 'draw', amount: 2, who: 'you' }], text: 'saga' }] } },
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { zone: ['History of Benalia', 'graveyard'] },
      { handCount: [0, 2] },
      { libraryCount: [0, 18] },
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- saga-lore-ge (the condition)
  {
    name: 'Tom Bombadil has hexproof and indestructible with four lore counters among your Sagas', cr: '613.4',
    seats: [
      { bf: ['Tom Bombadil', 'History of Benalia', 'The Antiquities War'], counters: { 'History of Benalia': { lore: 2 }, 'The Antiquities War': { lore: 2 } } },
      {},
    ],
    script: [{ sba: true }],
    expect: [{ keywords: ['Tom Bombadil', ['hexproof', 'indestructible']] }],
  },
  {
    name: 'Tom Bombadil is a legal Lightning Bolt target with only three lore counters among your Sagas', cr: '613.4',
    ruling: 'The static ability applies only while the condition is true; at three counters he has neither keyword.',
    seats: [
      { bf: ['Tom Bombadil', 'History of Benalia'], counters: { 'History of Benalia': { lore: 3 } } },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['Tom Bombadil']] }, { resolve: true }],
    expect: [
      { events: { type: 'damage', min: 1, max: 1 } },
      { log: 'deals 3 damage' },
      { zone: ['Tom Bombadil', 'battlefield'] },                 // 4/4: three damage is not lethal
    ],
  },

  // ---------------------------------------------------------------- the chapter lines the family's parser rules rebuilt
  {
    name: 'a multi-chapter line runs on each of its chapters (Summon: Anima I, II, III)', cr: '714.2c',
    ruling: 'A chapter ability with several numbers triggers once for each of them.',
    seats: [{ bf: ['Grizzly Bears', 'Keldon Warcaller', 'Summon: Anima'], counters: { 'Summon: Anima': { lore: 1 } } }, {}],
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { counters: ['Summon: Anima', { lore: 2 }] },
      { handCount: [0, 1] },                                     // chapter II drew a card
      { life: [0, 19] },                                         // …and cost 1 life
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a named final chapter still ends the Saga (Summon: Anima IV — Oblivion)', cr: '714.4',
    ruling: 'The chapter name is flavour; the chapter number is what the ability triggers on.',
    seats: [{ bf: ['Keldon Warcaller', 'Summon: Anima'], counters: { 'Summon: Anima': { lore: 3 } } }, { bf: ['Grizzly Bears'], life: 20 }],
    script: [{ attack: ['Keldon Warcaller'] }],
    expect: [
      { zone: ['Grizzly Bears', 'graveyard'] },                  // "Each opponent sacrifices a creature of their choice"
      { life: [1, 15] },                                         // "…and loses 3 life", on top of the Warcaller's 2 combat damage
      { zone: ['Summon: Anima', 'graveyard'] },                  // CR 714.4
      { unsimulated: 0 },
    ],
  },
];
