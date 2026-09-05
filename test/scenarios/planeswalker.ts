// Planeswalkers and emblems (Phase 9.1; docs/vocabulary/planeswalker.md): one scenario per op, per scope word and
// per keyword parameter the family registers, each written so it FAILS if the op did nothing.
//
// Two cards carry the family as printed — Vraska, Betrayal's Sting for `compleated` and Elspeth, Sun's Champion for
// the instant-speed loyalty window — and the rest script a real card through the DSL's `scripts` field, the way
// test/scenarios/composition.ts does: the emblem an `emblem` op makes is not something any printed card can hand a
// scenario in one step, and the `loyalty` scope words need a planeswalker to be the SOURCE of the ability.
import type { Ability, Effect } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>" (the printed vanilla body stays). */
const bears = (effects: Effect[], text = 'planeswalker'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects, text }] } });

/** Elspeth becomes the source of one free ability, so "each OTHER planeswalker you control" has something to exclude. */
const elspeth = (effects: Effect[], text = 'planeswalker'): Record<string, ScenarioScript> =>
  ({ "Elspeth, Sun's Champion": { mode: 'replace', abilities: [{ kind: 'activated', cost: {}, effects, text }] } });

/** "Whenever you cast a spell, you gain 2 life." — a triggered ability an emblem can carry (CR 114.2). */
const CAST_TRIGGER: Ability = {
  kind: 'triggered', event: { on: 'cast', filter: {}, who: 'you' },
  effects: [{ op: 'gain-life', amount: 2, who: 'you' }], text: 'Whenever you cast a spell, you gain 2 life.',
};
/** Teferi, Temporal Archmage's emblem, as the parser writes it. */
const ANY_TIME: Ability = {
  kind: 'static', effect: { kind: 'loyalty-any-time' },
  text: 'You may activate loyalty abilities of planeswalkers you control on any player\'s turn any time you could cast an instant.',
};

/**
 * Elspeth with one plain loyalty ability instead of her printed three: the timing scenarios below are about WHEN a
 * loyalty ability may be activated, and her printed +1 makes tokens that copy her legendary name — three Soldiers
 * that the legend rule then eats, which would be a second, unrelated thing for those scenarios to be about.
 */
const PLUS_ONE_GAIN_3: Record<string, ScenarioScript> = {
  "Elspeth, Sun's Champion": {
    mode: 'replace',
    abilities: [{ kind: 'activated', cost: {}, loyalty: 1, oncePerTurn: true, sorcerySpeed: true, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: '+1: You gain 3 life.' }],
  },
};

export const planeswalker: Scenario[] = [
  // ------------------------------------------------------------------ emblem (CR 114)
  {
    name: 'an emblem is created in the command zone and its triggered ability fires from there', cr: '114.2',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: bears([{ op: 'emblem', abilities: [CAST_TRIGGER], text: 'Whenever you cast a spell, you gain 2 life.' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    // without the emblem the caster stays at 20: the emblem is the only source of the life
    expect: [{ life: [0, 22] }, { life: [1, 17] }, { zoneCount: [0, 'command', 1] }, { zoneCount: [0, 'battlefield', 3] }, { log: 'gets an emblem' }, { unsimulated: 0 }],
  },
  {
    name: 'an emblem is not a permanent: it survives the destruction of the planeswalker that made it', cr: '114.5',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, {}],
    scripts: bears([{ op: 'emblem', abilities: [CAST_TRIGGER], text: 'Whenever you cast a spell, you gain 2 life.' }]),
    script: [
      { activate: 'Grizzly Bears' }, { resolve: true },
      { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Shock', targets: [['P1']] }, { resolve: true },
    ],
    // both spells triggered the emblem (2 + 2), and the second one after its source had died
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { life: [0, 24] }, { life: [1, 18] }, { zoneCount: [0, 'command', 1] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ loyalty (CR 121.1, 306.5b)
  {
    name: 'loyalty counters are put on a target planeswalker', cr: '121.1',
    seats: [{ bf: ['Grizzly Bears', "Elspeth, Sun's Champion"] }, {}],
    scripts: bears([{ op: 'loyalty', target: { kind: 'planeswalker' }, amount: 2 }]),
    script: [{ activate: 'Grizzly Bears', targets: [["Elspeth, Sun's Champion"]] }, { resolve: true }],
    expect: [{ counters: ["Elspeth, Sun's Champion", { loyalty: 6 }] }, { unsimulated: 0 }],   // printed 4 + 2
  },
  {
    name: 'a loyalty counter on each other planeswalker you control skips the source and every opponent walker', cr: '121.1',
    seats: [{ bf: ["Elspeth, Sun's Champion", 'Karn, Scion of Urza'] }, { bf: ['Sarkhan, Fireblood'] }],
    scripts: elspeth([{ op: 'loyalty', target: 'each-other-planeswalker-you-control', amount: 1 }]),
    script: [{ activate: "Elspeth, Sun's Champion" }, { resolve: true }],
    expect: [
      { counters: ['Karn, Scion of Urza', { loyalty: 6 }] },                 // printed 5 + 1
      { counters: ["Elspeth, Sun's Champion", { loyalty: 4 }] },             // the source is "other" to nobody
      { counters: ['Sarkhan, Fireblood', { loyalty: 3 }] },                  // an opponent's walker is untouched
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a loyalty counter on each planeswalker you control includes the source itself', cr: '121.1',
    seats: [{ bf: ["Elspeth, Sun's Champion", 'Karn, Scion of Urza'] }, { bf: ['Sarkhan, Fireblood'] }],
    scripts: elspeth([{ op: 'loyalty', target: 'each-planeswalker-you-control', amount: 1 }]),
    script: [{ activate: "Elspeth, Sun's Champion" }, { resolve: true }],
    expect: [
      { counters: ["Elspeth, Sun's Champion", { loyalty: 5 }] },
      { counters: ['Karn, Scion of Urza', { loyalty: 6 }] },
      { counters: ['Sarkhan, Fireblood', { loyalty: 3 }] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a negative loyalty amount removes loyalty counters', cr: '121.3',
    seats: [{ bf: ['Grizzly Bears', "Elspeth, Sun's Champion"] }, {}],
    scripts: bears([{ op: 'loyalty', target: { kind: 'planeswalker' }, amount: -3 }]),
    script: [{ activate: 'Grizzly Bears', targets: [["Elspeth, Sun's Champion"]] }, { resolve: true }],
    expect: [{ counters: ["Elspeth, Sun's Champion", { loyalty: 1 }] }, { zone: ["Elspeth, Sun's Champion", 'battlefield'] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ poison-to-total (CR 122.1)
  {
    name: 'poison-to-total brings a player up to the named total and never past it', cr: '122.1',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    // the same ability twice over: to nine, then to five — the second one finds no shortfall (CR 107.1b)
    scripts: bears([
      { op: 'poison-to-total', target: { kind: 'player' }, total: 9 },
      { op: 'poison-to-total', target: { kind: 'player' }, total: 5 },
    ]),
    script: [{ activate: 'Grizzly Bears', targets: [['P1'], ['P1']] }, { resolve: true }],
    expect: [{ playerCounters: [1, { poison: 9 }] }, { playerCounters: [0, { poison: 0 }] }, { winner: null }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ compleated (CR 107.4f, 614.1c)
  {
    name: 'a compleated planeswalker cast for life enters with two fewer loyalty counters per Phyrexian pip', cr: '107.4f',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ["Vraska, Betrayal's Sting"] }, {}],
    script: [{ cast: "Vraska, Betrayal's Sting", alt: 'life' }, { resolve: true }],
    // {4}{B}{B/P} paid as {4}{B} plus 2 life for the one Phyrexian pip: 2 life, and 6 − 2 = 4 loyalty
    expect: [
      { zone: ["Vraska, Betrayal's Sting", 'battlefield'] },
      { counters: ["Vraska, Betrayal's Sting", { loyalty: 4 }] },
      { life: [0, 18] },
      { log: 'fewer loyalty counters' },
    ],
  },
  {
    name: 'a compleated planeswalker whose Phyrexian pips were paid with mana enters with its printed loyalty', cr: '107.4f',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ["Vraska, Betrayal's Sting"] }, {}],
    script: [{ cast: "Vraska, Betrayal's Sting" }, { resolve: true }],
    expect: [
      { zone: ["Vraska, Betrayal's Sting", 'battlefield'] },
      { counters: ["Vraska, Betrayal's Sting", { loyalty: 6 }] },
      { life: [0, 20] },
      { noLog: 'fewer loyalty counters' },
    ],
  },

  // ------------------------------------------------------------------ loyalty-any-time (CR 606.3 / 117.1a)
  {
    name: 'a static loyalty-any-time permission lets a loyalty ability be activated in the end step', cr: '606.3',
    seats: [{ bf: ["Elspeth, Sun's Champion", 'Grizzly Bears'] }, {}],
    scripts: { ...PLUS_ONE_GAIN_3, 'Grizzly Bears': { abilities: [ANY_TIME] } },
    // the end step is not sorcery timing, so without the permission `legalFor` finds no activation and this throws
    script: [{ passUntil: 'end' }, { activate: "Elspeth, Sun's Champion", ability: 0 }, { resolve: true }],
    expect: [{ counters: ["Elspeth, Sun's Champion", { loyalty: 5 }] }, { life: [0, 23] }, { unsimulated: 0 }],
  },
  {
    name: 'the same permission carried by an emblem in the command zone works too', cr: '606.3',
    seats: [{ bf: ["Elspeth, Sun's Champion", 'Grizzly Bears'] }, {}],
    scripts: { ...PLUS_ONE_GAIN_3, ...bears([{ op: 'emblem', abilities: [ANY_TIME], text: 'You may activate loyalty abilities of planeswalkers you control on any player\'s turn any time you could cast an instant.' }]) },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'end' }, { activate: "Elspeth, Sun's Champion", ability: 0 }, { resolve: true }],
    expect: [{ zoneCount: [0, 'command', 1] }, { counters: ["Elspeth, Sun's Champion", { loyalty: 5 }] }, { life: [0, 23] }],
  },
];
