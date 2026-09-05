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
/** "Creatures you control get +2/+2." — the emblem ability the engine cannot apply yet (see the family doc). */
const ANTHEM: Ability = {
  kind: 'static', effect: { kind: 'anthem', power: 2, toughness: 2, filter: { types: ['Creature'] }, scope: 'you-control' },
  text: 'Creatures you control get +2/+2.',
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
  // ------------------------------------------------------------------ the guarded target parser (CR 115)
  {
    // The rule used to overwrite the kind with the LAST type noun in the phrase, so this card could only ever target
    // a land: the artifact and the creature it names were refused at announcement.
    name: 'a three-way "artifact, creature, or land" target really offers the creature', cr: '115.1',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Grizzly Bears', 'Sol Ring'], hand: ["Tawnos's Tinkering"] }, {}],
    script: [{ cast: "Tawnos's Tinkering", targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 2 }] }, { pt: ['Grizzly Bears', 4, 4] }],
  },
  {
    name: 'the same target offers the artifact', cr: '115.1',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Grizzly Bears', 'Sol Ring'], hand: ["Tawnos's Tinkering"] }, {}],
    script: [{ cast: "Tawnos's Tinkering", targets: [['Sol Ring']] }, { resolve: true }],
    expect: [{ counters: ['Sol Ring', { '+1/+1': 2 }] }, { counters: ['Grizzly Bears', {}] }],
  },
  {
    // "up to three target noncreature artifacts" — the plural escaped the noun fixup, leaving a CREATURE target that
    // had to be a noncreature: a kind `targetOptionsFor` could never satisfy, so the trigger resolved doing nothing.
    name: 'a plural "noncreature artifacts" target is an artifact target, not an unsatisfiable creature one', cr: '115.4',
    seats: [{ bf: ['Katsumasa, the Animator', 'Sol Ring', 'Grizzly Bears'] }, {}],
    step: 'untap',
    script: [{ passUntil: 'draw' }],
    expect: [{ counters: ['Sol Ring', { '+1/+1': 1 }] }, { counters: ['Grizzly Bears', {}] }],
  },

  // ------------------------------------------------------------------ Refs on the loyalty op (CR 400.7)
  {
    // `loyalty` read `item.affected` by hand, which answers only `that` / `those`: every other Ref the zod schema
    // accepts — `triggering` here — silently bound nothing and the op was a no-op.
    name: 'loyalty resolves the triggering Ref through the core resolver', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain'], hand: ['Tibalt, Rakish Instigator'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'etb', self: false, filter: {}, controller: 'you' }, effects: [{ op: 'loyalty', target: 'triggering', amount: 2 }], text: 'Whenever another permanent enters under your control, put two loyalty counters on it.' }] } },
    script: [{ cast: 'Tibalt, Rakish Instigator' }, { resolve: true }, { resolve: true }],
    expect: [{ counters: ['Tibalt, Rakish Instigator', { loyalty: 7 }] }, { unsimulated: 0 }],   // printed 5 + 2
  },

  // ------------------------------------------------------------------ what an emblem cannot do yet (CR 114.3)
  {
    // The parser refuses every anthem emblem for this reason; a hand-written script can still write one, and when it
    // does the log has to say the ability is not applied rather than leaving a silent no-op.
    name: 'an emblem with a static ability says so in the log instead of silently doing nothing', cr: '114.3',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'emblem', abilities: [ANTHEM], text: 'Creatures you control get +2/+2.' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zoneCount: [0, 'command', 1] }, { pt: ['Grizzly Bears', 2, 2] }, { log: 'does not apply yet' }],
  },
];
