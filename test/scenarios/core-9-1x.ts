// Phase 9.1x — the core changes the twelve Phase 9.1 vocabulary families declared they needed (`coreChangeNeeded`),
// one scenario per item that a board can show. Every expectation FAILS on the tree before its fix: the item number
// in each name is the entry of the orchestrator's item list, the `ruling` says what the old tree did.
//
// The shapes no printed card parses into yet go through the DSL's `scripts` field on plain cards, the way the
// family suites do (a scripted become-copy, a scripted anthem emblem, a scripted transform watcher); everything the
// parser claims — Samite Healer, Furnace of Rath, Mogg Flunkies, Act of Treason, Static Prison, Electrozoa, Aether
// Hub, Kessig Prowler — is played as printed.
import type { Ability, Effect } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** A card gains a free "<effects>" ability (the printed body stays). */
const gains = (name: string, effects: Effect[], text = '9.1x'): Record<string, ScenarioScript> =>
  ({ [name]: { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** A card gains a triggered ability. */
const watches = (name: string, ability: Ability): Record<string, ScenarioScript> => ({ [name]: { abilities: [ability] } });

const PROWLER = 'Kessig Prowler // Sinuous Predator';
const RUFFIAN = 'Tavern Ruffian // Tavern Smasher';
const BECOME_COPY: Effect[] = [{ op: 'become-copy', target: { kind: 'creature' }, duration: 'permanent' } as unknown as Effect];
/** "Creatures you control get +2/+2." on an emblem (the planeswalker suite carries the same ability). */
const ANTHEM: Ability = { kind: 'static', effect: { kind: 'anthem', power: 2, toughness: 2, filter: { types: ['Creature'] }, scope: 'you-control' }, text: 'Creatures you control get +2/+2.' };
/** "Whenever a permanent you control transforms, you gain 5 life." — the transform family's own trigger event. */
const TRANSFORM_WATCHER: Ability = { kind: 'triggered', event: { on: 'transforms', self: false, controller: 'you' } as never, effects: [{ op: 'gain-life', amount: 5, who: 'you' }], text: 'Whenever a permanent you control transforms, you gain 5 life.' };

export const core91x: Scenario[] = [
  // ------------------------------------------------------------------ item 4: CR 704.5j on copied supertypes
  {
    name: '9.1x item 4: two printed legends that became copies of the same nonlegendary creature are not legends', cr: '704.5j',
    ruling: 'CR 707.2: a copy has the copied object\'s supertypes, and Grizzly Bears has none — so neither Isamaru nor Sram is legendary any more and CR 704.5j has nothing to apply to. The core legend pass read the PRINTED supertypes and put one of them into the graveyard.',
    seats: [{ bf: ['Isamaru, Hound of Konda', 'Sram, Senior Edificer', 'Grizzly Bears'] }, {}],
    scripts: { ...gains('Isamaru, Hound of Konda', BECOME_COPY, 'copy'), ...gains('Sram, Senior Edificer', BECOME_COPY, 'copy') },
    script: [{ activate: 'Isamaru, Hound of Konda', targets: [['Grizzly Bears']] }, { resolve: true }, { activate: 'Sram, Senior Edificer', targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }],
    expect: [{ zoneCount: [0, 'battlefield', 3] }, { graveyardCount: [0, 0] }, { noLog: 'Legend rule' }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 5: the core's own shield beside the family fold (CR 616.1)
  {
    name: '9.1x item 5: a core prevention shield is applied before a damage doubler — the order the affected creature\'s controller would choose', cr: '616.1e',
    ruling: 'CR 616.1 / 616.1e: Samite Healer\'s 1-point shield (CR 615) and Furnace of Rath\'s doubling (CR 614.1a) both apply to Shock\'s damage, so Hill Giant\'s controller chooses the order and either is legal. The engine cannot ask, so the core applies its own shield first — the order that deals the affected creature the least: (2 − 1) × 2 = 2 and the 3/3 lives. This item first shipped the other order and pinned it as a CR requirement (2 × 2 − 1 = 3, Hill Giant destroyed); no such rule exists.',
    seats: [{ bf: ['Furnace of Rath', 'Samite Healer', 'Mountain'], hand: ['Shock'] }, { bf: ['Hill Giant'] }],
    script: [{ activate: 'Samite Healer', targets: [['Hill Giant']] }, { resolve: true }, { cast: 'Shock', targets: [['Hill Giant']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { log: 'deals 2 damage to Hill Giant' }, { events: { type: 'prevented', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: '9.1x item 5: a Fog is applied before a one-shot family shield, which is not spent on damage the Fog prevents whole', cr: '616.1e',
    ruling: 'CR 616.1e: Fog (the core flag) and a 3-point "prevent the next 3 damage that would be dealt to you" shield (this family\'s `prevent`) both apply to Hill Giant\'s combat damage, and the affected player chooses. The core applies its Fog first on their behalf, so the family shield keeps its 3 points and still absorbs the Shock cast in the second main phase: P1 stays at 20. Folding the family first spent the shield on the combat damage and the Shock then dealt 2.',
    seats: [{ bf: ['Hill Giant', 'Mountain'], hand: ['Shock'] }, { bf: ['Grizzly Bears', 'Forest'], hand: ['Fog'] }],
    scripts: gains('Grizzly Bears', [{ op: 'prevent', amount: 3, to: { players: 'you' }, duration: 'eot' } as unknown as Effect], 'salve'),
    script: [{ activate: 'Grizzly Bears', by: 1 }, { resolve: true }, { cast: 'Fog', by: 1 }, { resolve: true }, { attack: ['Hill Giant'] }, { passUntil: 'main2' }, { cast: 'Shock', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 20] }, { events: { type: 'prevented', min: 2 } }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 9: an emblem's static ability
  {
    name: '9.1x item 9: an anthem emblem pumps the creatures its controller controls from the command zone', cr: '114.2',
    ruling: 'CR 114.2: an emblem functions in the command zone, and CR 611.3 makes its static ability a continuous effect from there. `staticSources` scanned the battlefield alone, so the +2/+2 never applied.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    scripts: gains('Hill Giant', [{ op: 'emblem', abilities: [ANTHEM], text: 'Creatures you control get +2/+2.' } as unknown as Effect], 'emblem'),
    script: [{ activate: 'Hill Giant' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 4] }, { pt: ['Hill Giant', 5, 5] }, { zoneCount: [0, 'command', 1] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 12: CR 506.4 over a finished declaration
  {
    name: '9.1x item 12: Mogg Flunkies is dropped from an attack it would otherwise make alone', cr: '506.4',
    ruling: 'CR 506.4: a creature that can\'t attack alone may attack only in a declaration that has another attacker in it; the Hill Giant could have come along and did not, so the declaration of Flunkies alone is not made (CR 508.1) and nothing is tapped. Before the seat existed the lone Flunkies dealt 3.',
    seats: [{ bf: ['Mogg Flunkies', 'Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    script: [{ attack: ['Mogg Flunkies'] }],
    expect: [{ life: [1, 20] }, { log: "Mogg Flunkies can't attack alone" }, { tapped: ['Mogg Flunkies', false] }, { unsimulated: 0 }],
  },
  {
    name: '9.1x item 12: Mogg Flunkies attacks when another creature attacks with it', cr: '506.4',
    seats: [{ bf: ['Mogg Flunkies', 'Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    script: [{ attack: ['Mogg Flunkies', 'Hill Giant'] }],
    expect: [{ life: [1, 14] }, { noLog: "can't attack alone" }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 13: CR 613.7 across the core and family control effects
  {
    name: '9.1x item 13: an Act of Treason over a live "for as long as" theft ends in the right order when the older theft ends first', cr: '613.7',
    ruling: 'P1 takes P0\'s Bears for as long as the Giant is on the battlefield; P0 casts Act of Treason on them (until end of turn), then kills the Giant. CR 613.7: the newer effect (Act of Treason) still applies when the older one ends, so the Bears stay with P0 for the turn and go home to P0 at cleanup — P1\'s claim has ended. The core\'s one-slot `controlUntilEot` remembered P1 and handed the Bears to P1 at cleanup.',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Act of Treason', 'Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: gains('Hill Giant', [{ op: 'control-gain', target: { kind: 'creature', controller: 'opponent' }, duration: 'while-source-on-battlefield' } as unknown as Effect], 'steal'),
    script: [{ activate: 'Hill Giant', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }, { cast: 'Act of Treason', targets: [['Grizzly Bears']] }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { sba: true }, { passUntil: 'cleanup' }],
    expect: [{ control: ['Grizzly Bears', 0] }, { zone: ['Hill Giant', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: '9.1x item 13: an Act of Treason over a live "for as long as" theft hands the creature back to the older thief at cleanup', cr: '613.7',
    ruling: 'The same board with the Giant alive: at cleanup Act of Treason ends (CR 514.2) and the older, still-live family effect says P1 controls the Bears (CR 613.7).',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain'], hand: ['Act of Treason'] }, { bf: ['Hill Giant'] }],
    scripts: gains('Hill Giant', [{ op: 'control-gain', target: { kind: 'creature', controller: 'opponent' }, duration: 'while-source-on-battlefield' } as unknown as Effect], 'steal'),
    script: [{ activate: 'Hill Giant', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }, { cast: 'Act of Treason', targets: [['Grizzly Bears']] }, { resolve: true }, { passUntil: 'cleanup' }],
    expect: [{ control: ['Grizzly Bears', 1] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 14: add-mana perEach in applyEffect
  {
    name: '9.1x item 14: "add {B} for each charge counter" on a resolving ability adds one {B} per counter', cr: '605.1a',
    ruling: 'The mana-ability path (mana.ts) already multiplied by `perEach`; the resolution path (`applyEffect` add-mana) read only `e.mana` and added a single {B}. Black Market\'s printed trigger is pinned in the transform suite.',
    seats: [{ bf: ['Grizzly Bears'], counters: { 'Grizzly Bears': { charge: 3 } } }, {}],
    scripts: gains('Grizzly Bears', [{ op: 'add-mana', mana: ['B'], perEach: { count: 'counters-on-source', counter: 'charge' } }], 'market'),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ mana: [0, 'BBB'] }, { unsimulated: 0 }],
  },
  {
    name: '9.1x item 14: "add {B} for each charge counter" with no counters adds nothing', cr: '605.1a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: gains('Grizzly Bears', [{ op: 'add-mana', mana: ['B'], perEach: { count: 'counters-on-source', counter: 'charge' } }], 'market'),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ mana: [0, ''] }, { events: { type: 'mana', min: 0, max: 0 } }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 15: {E} is an energy cost
  {
    name: '9.1x item 15: Static Prison is sacrificed when its controller has no energy to pay {E}', cr: '118.12',
    ruling: 'CR 118.12 / 122.1c: "{E}" is paid with an energy counter from the player\'s own pool, never with mana. The mana-cost parser dropped the symbol and the engine auto-paid a cost of nothing, so Static Prison was never sacrificed.',
    seats: [{ bf: ['Static Prison'] }, {}],
    script: [{ passUntil: 'main1' }, { passUntil: 'main1' }, { resolve: true }],
    expect: [{ zone: ['Static Prison', 'graveyard'] }, { noLog: 'pays \\{E\\}' }, { unsimulated: 0 }],
  },
  {
    name: '9.1x item 15: Static Prison is kept by paying {E} and the energy is spent', cr: '118.12',
    seats: [{ bf: ['Static Prison'], hand: ['Aether Hub'] }, {}],
    script: [{ playLand: 'Aether Hub' }, { resolve: true }, { passUntil: 'main1' }, { passUntil: 'main1' }, { answer: true }, { resolve: true }],
    expect: [{ zone: ['Static Prison', 'battlefield'] }, { playerCounters: [0, { energy: 0 }] }, { log: 'pays 1 energy' }, { unsimulated: 0 }],
  },
  {
    name: '9.1x item 15: Electrozoa is tapped when its controller has no energy to pay {E}', cr: '118.12',
    ruling: 'The same symbol through the composition family\'s `unless-pays`: the cost phrase "{E}" is `energy: 1`, not an empty mana cost, so a player with no energy cannot pay it and the Jellyfish is tapped.',
    seats: [{ bf: ['Electrozoa'] }, {}],
    script: [{ passUntil: 'main1' }, { passUntil: 'main1' }, { resolve: true }],
    expect: [{ tapped: ['Electrozoa', true] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 16: transform-self on a daybound permanent
  {
    name: '9.1x item 16: a plain transform effect cannot transform a daybound permanent while it is neither day nor night', cr: '702.145b',
    ruling: 'CR 702.145b: a permanent with daybound can\'t transform except due to its daybound ability. The core `transform-self` op flipped it, and with no day/night in force nothing put the face back.',
    seats: [{ bf: [RUFFIAN] }, {}],
    scripts: gains(RUFFIAN, [{ op: 'transform-self' }], 'illegal flip'),
    script: [{ activate: RUFFIAN }, { resolve: true }],
    expect: [{ pt: [RUFFIAN, 2, 5] }, { noLog: 'transforms into' }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 19: a lethal transform-self still raises `transforms`
  {
    name: '9.1x item 19: a transform that kills the permanent is still seen by "whenever a permanent you control transforms"', cr: '603.2',
    ruling: 'CR 603.2: the ability triggers when the event happens, and nothing requires the object to survive it. Sinuous Predator (4/4) with 2 damage marked transforms back into Kessig Prowler (2/1) and dies at once; the watcher must still fire (the first, surviving flip fires it too: 5 + 5). The old core flip raised no event and the family\'s state-based watcher only saw survivors.',
    seats: [{ bf: [PROWLER, 'Grizzly Bears', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Mountain'], hand: ['Shock'] }, {}],
    scripts: { [PROWLER]: { backFace: { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'transform-self' }], text: 'flip back' }] } } as unknown as ScenarioScript, ...watches('Grizzly Bears', TRANSFORM_WATCHER) },
    script: [{ activate: PROWLER }, { resolve: true }, { resolve: true }, { cast: 'Shock', targets: [[PROWLER]] }, { resolve: true }, { activate: PROWLER }, { resolve: true }, { sba: true }, { resolve: true }],
    expect: [{ zone: [PROWLER, 'graveyard'] }, { life: [0, 30] }, { unsimulated: 0 }],
  },
];
