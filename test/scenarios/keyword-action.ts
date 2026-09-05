// Keyword actions (Phase 9.1, docs/vocabulary/keyword-action.md): one scenario per op, per condition, per trigger,
// per amount form and per cost part — every one of them written so it FAILS if the op did nothing.
//
// Where a real card's printed text already produces the op (the parser rules landed with the family), the scenario
// plays the card: that proves the wording, the AST and the engine at once. The ops no printed wording reaches yet —
// `cloak`, `learn`, `behold`, `villainous-choice`, and the conditions read in isolation — are exercised by scripting
// a real card through the DSL's `scripts` field, exactly as the composition suite does.
import type { Effect } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>" (the printed vanilla body stays). */
const bears = (effects: Effect[], text = 'keyword-action'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects, text }] } });
/** Grizzly Bears gains a free "<effects>" ability (no tap, so it can be activated twice in one turn). */
const bearsFree = (effects: Effect[], text = 'keyword-action'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** Lightning Bolt's spell becomes <effects> ({R}, instant). */
const bolt = (effects: Effect[], text = 'keyword-action'): Record<string, ScenarioScript> =>
  ({ 'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects, text }] } });
/** Grizzly Bears gains two free abilities, so one activation can be answered by another in the same turn. */
const bearsTwo = (a: Effect[], b: Effect[], ta = 'keyword-action', tb = 'bounce'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [
    { kind: 'activated', cost: {}, effects: a, text: ta },
    { kind: 'activated', cost: {}, effects: b, text: tb },
  ] } });
/** "Return it to its owner's hand" as a free ability body, for the CR 400.7 scenarios. */
const bounceSelf: Effect[] = [{ op: 'bounce', target: 'self', to: 'hand' }];

/** A watcher: Hill Giant gains a triggered ability that gains 4 life, so a family trigger firing is a life total. */
const watcher = (event: object, text: string): Record<string, ScenarioScript> =>
  ({ 'Hill Giant': { abilities: [{ kind: 'triggered', event: event as never, effects: [{ op: 'gain-life', amount: 4, who: 'you' }], text }] } });
/** Both halves of a condition in one activation: false before the action, true after it (life 20 → 25). */
const polarity = (action: Effect, kind: string): Effect[] => [
  { op: 'conditional', condition: { kind } as never, then: [{ op: 'gain-life', amount: 5, who: 'you' }] },
  action,
  { op: 'conditional', condition: { kind } as never, then: [{ op: 'gain-life', amount: 5, who: 'you' }] },
];

export const keywordAction: Scenario[] = [
  // ---------------------------------------------------------------- investigate (CR 701.20a)
  {
    name: 'Armed with Proof investigates twice: two Clue tokens enter', cr: '701.20a',
    seats: [{ bf: ['Plains', 'Plains', 'Plains'], hand: ['Armed with Proof'] }, {}],
    script: [{ cast: 'Armed with Proof' }, { resolve: true }],
    // 3 lands + the enchantment + 2 Clues; one Clue (or none) fails the count
    expect: [{ zoneCount: [0, 'battlefield', 6] }, { events: { type: 'create-token', min: 1 } }, { log: 'creates 2' }],
  },

  // ---------------------------------------------------------------- bolster (CR 701.34a)
  {
    name: 'Sandcrafter Mage bolsters 1: the counter goes on the least-toughness creature, not the first one', cr: '701.34a',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Hill Giant'], hand: ['Sandcrafter Mage'] }, {}],
    script: [{ cast: 'Sandcrafter Mage' }, { resolve: true }],
    // Hill Giant (3/3) is the first creature on the battlefield; the Mage (2/2) has the least toughness
    expect: [{ pt: ['Sandcrafter Mage', 3, 3] }, { pt: ['Hill Giant', 3, 3] }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- support (CR 701.33a)
  {
    name: 'Relief Captain supports 3: a counter on each chosen other creature and none on itself', cr: '701.33a',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Grizzly Bears', 'Hill Giant'], hand: ['Relief Captain'] }, {}],
    script: [{ cast: 'Relief Captain', targets: [['Grizzly Bears', 'Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 3, 3] }, { pt: ['Hill Giant', 4, 4] }, { pt: ['Relief Captain', 3, 2] }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- adapt (CR 701.42a)
  {
    name: 'adapt 2 twice only adds counters once: a creature that already has a +1/+1 counter does not adapt', cr: '701.42a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bearsFree([{ op: 'adapt', amount: 2 }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 4] }, { counters: ['Grizzly Bears', { '+1/+1': 2 }] }, { log: 'does not adapt' }],
  },

  // ---------------------------------------------------------------- monstrosity (CR 701.31a) + the monstrous trigger
  {
    name: 'Ill-Tempered Cyclops becomes monstrous: three +1/+1 counters, and only the first activation does it', cr: '701.31a',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Ill-Tempered Cyclops'] }, {}],
    script: [{ activate: 'Ill-Tempered Cyclops' }, { resolve: true }],
    expect: [{ pt: ['Ill-Tempered Cyclops', 6, 6] }, { ext: ['Ill-Tempered Cyclops', 'monstrous', true] }, { unsimulated: 0 }],
  },
  {
    name: 'monstrosity a second time does nothing (CR 701.31b: it is already monstrous)', cr: '701.31b',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bearsFree([{ op: 'monstrosity', amount: 2 }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 4] }, { ext: ['Grizzly Bears', 'monstrous', true] }, { log: 'is already monstrous' }],
  },
  {
    name: 'Keepsake Gorgon: becoming monstrous triggers its own "when this becomes monstrous" ability', cr: '701.31a',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Keepsake Gorgon'] }, { bf: ['Grizzly Bears'] }],
    script: [{ activate: 'Keepsake Gorgon' }, { resolve: true }],
    expect: [{ ext: ['Keepsake Gorgon', 'monstrous', true] }, { zone: ['Grizzly Bears', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: 'the monstrous condition is false before monstrosity and true after it', cr: '701.31b',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bearsFree(polarity({ op: 'monstrosity', amount: 1 }, 'monstrous')),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 25] }, { pt: ['Grizzly Bears', 3, 3] }],
  },

  // ---------------------------------------------------------------- manifest / manifest dread / cloak (CR 701.36a, 701.59a, 701.58a)
  {
    name: 'Sultai Emissary manifests the top card of its library as a face-down 2/2', cr: '701.36a',
    seats: [{ bf: ['Mountain', 'Sultai Emissary'], hand: ['Lightning Bolt'], libraryTop: ['Hill Giant'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['Sultai Emissary']] }, { resolve: true }],
    expect: [{ zone: ['Sultai Emissary', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }, { faceDown: ['Hill Giant', true] }, { pt: ['Hill Giant', 2, 2] }, { unsimulated: 0 }],
  },
  {
    name: 'Innocuous Rat manifests dread: one of the top two is a face-down 2/2, the other goes to the graveyard', cr: '701.59a',
    seats: [{ bf: ['Mountain', 'Innocuous Rat'], hand: ['Lightning Bolt'], libraryTop: ['Hill Giant', 'Runeclaw Bear'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['Innocuous Rat']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { faceDown: ['Hill Giant', true] }, { zone: ['Runeclaw Bear', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: 'cloak puts the top card onto the battlefield face down as a 2/2 and marks it cloaked', cr: '701.58a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], libraryTop: ['Hill Giant'] }, {}],
    scripts: bears([{ op: 'cloak' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { faceDown: ['Hill Giant', true] }, { pt: ['Hill Giant', 2, 2] }, { ext: ['Hill Giant', 'cloaked', true] }],
  },

  // ---------------------------------------------------------------- populate (CR 701.29a)
  {
    name: "Coursers' Accord populates: the Centaur token it just made is copied", cr: '701.29a',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Plains', 'Plains', 'Plains'], hand: ["Coursers' Accord"] }, {}],
    script: [{ cast: "Coursers' Accord" }, { resolve: true }],
    // 6 lands + 2 Centaur tokens; without populate there would be 7 permanents
    expect: [{ zoneCount: [0, 'battlefield', 8] }, { events: { type: 'create-token', min: 2 } }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- goad (CR 701.39a)
  {
    name: "Taunting Kobold goads an opponent's creature when it attacks", cr: '701.39a',
    seats: [{ bf: ['Taunting Kobold'] }, { bf: ['Hill Giant'] }],
    script: [{ attack: ['Taunting Kobold'] }],
    expect: [{ ext: ['Hill Giant', 'goadedBy', 0] }, { log: 'is goaded by' }, { unsimulated: 0 }],
  },
  {
    name: 'goad wears off at the start of the goading player\'s next turn (CR 701.39a: "until your next turn")', cr: '701.39a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'goad', target: { kind: 'creature', controller: 'opponent' } }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 2 }],
    expect: [{ log: 'is no longer goaded' }],
  },

  // ---------------------------------------------------------------- incubate (CR 701.54a)
  {
    name: 'incubate 2 creates one Incubator token with two +1/+1 counters on it', cr: '701.54a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bears([{ op: 'incubate', amount: 2 }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ log: 'incubates 2' }, { events: { type: 'create-token', min: 1, max: 1 } }, { events: { type: 'counter', min: 1, max: 1 } }, { zoneCount: [0, 'battlefield', 3] }],
  },
  {
    name: 'an Incubator token transforms for {2} into a Phyrexian artifact creature', cr: '701.54a',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Island', 'Island'], hand: ['Eyes of Gitaxias'] }, {}],
    script: [{ cast: 'Eyes of Gitaxias' }, { resolve: true }, { activate: 'Eyes of Gitaxias' }, { resolve: true }],
    expect: [{ log: 'transforms an Incubator' }, { mana: [0, ''] }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- connive (CR 701.48a)
  {
    name: "Raffine's Silencer connives: draw, discard a nonland card, and take a +1/+1 counter for it", cr: '701.48a',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp'], hand: ["Raffine's Silencer", 'Hill Giant'], libraryTop: ['Runeclaw Bear'] }, {}],
    script: [{ cast: "Raffine's Silencer" }, { resolve: true }],
    expect: [{ pt: ["Raffine's Silencer", 2, 2] }, { zone: ['Hill Giant', 'graveyard'] }, { zone: ['Runeclaw Bear', 'hand'] }, { handCount: [0, 1] }],
  },
  {
    name: 'a "whenever a creature you control connives" trigger fires when one connives', cr: '701.48a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'], hand: ['Lightning Bolt'] }, {}],
    scripts: { ...bears([{ op: 'connive', amount: 1, target: 'self' }]), ...watcher({ on: 'connives', self: false }, 'connive watcher') },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { log: 'connives 1' }],
  },

  // ---------------------------------------------------------------- learn (CR 701.50a)
  {
    name: 'learn: you may discard a card to draw a card', cr: '701.50a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], hand: ['Hill Giant'], libraryTop: ['Runeclaw Bear'] }, {}],
    scripts: bears([{ op: 'learn' }]),
    script: [{ answer: true }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zone: ['Runeclaw Bear', 'hand'] }, { handCount: [0, 1] }],
  },

  // ---------------------------------------------------------------- discover (CR 701.56a)
  {
    name: 'Long-Range Sensor discovers 4: cards are exiled from the top until a cheap nonland card', cr: '701.56a',
    seats: [{ bf: ['Mountain', 'Mountain', 'Long-Range Sensor'], counters: { 'Long-Range Sensor': { charge: 2 } }, libraryTop: ['Lightning Bolt'] }, {}],
    script: [{ activate: 'Long-Range Sensor' }, { resolve: true }],
    expect: [{ zone: ['Lightning Bolt', 'exile'] }, { log: 'discovers 4' }, { counters: ['Long-Range Sensor', { charge: 0 }] }],
  },
  {
    name: 'a "whenever you discover" trigger fires on a discover', cr: '701.56a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'], libraryTop: ['Lightning Bolt'] }, {}],
    scripts: { ...bears([{ op: 'discover', amount: 1 }]), ...watcher({ on: 'discovers' }, 'discover watcher') },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { zone: ['Lightning Bolt', 'exile'] }],
  },

  // ---------------------------------------------------------------- forage (CR 701.57a)
  {
    name: 'Curious Forager forages: three cards leave the graveyard and its reflexive trigger returns a card', cr: '701.57a',
    seats: [{ bf: ['Forest', 'Forest', 'Forest'], hand: ['Curious Forager'], graveyard: ['Grizzly Bears', 'Hill Giant', 'Runeclaw Bear', 'Shock'] }, {}],
    script: [{ cast: 'Curious Forager' }, { resolve: true }],
    expect: [{ zoneCount: [0, 'exile', 3] }, { zone: ['Shock', 'hand'] }, { graveyardCount: [0, 0] }, { log: 'forages' }],
  },
  {
    name: 'a "whenever you forage" trigger fires on a forage', cr: '701.57a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'], graveyard: ['Shock', 'Shock', 'Shock'] }, {}],
    scripts: { ...bears([{ op: 'forage' }]), ...watcher({ on: 'forages' }, 'forage watcher') },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { zoneCount: [0, 'exile', 3] }, { graveyardCount: [0, 0] }],
  },

  // ---------------------------------------------------------------- clash (CR 701.19a) + "if you win"
  {
    name: 'Oaken Brawler clashes and wins: the greater mana value on top takes the +1/+1 counter', cr: '701.19a',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Oaken Brawler'], libraryTop: ['Hill Giant'] }, { libraryTop: ['Mountain'] }],
    script: [{ cast: 'Oaken Brawler' }, { resolve: true }],
    expect: [{ pt: ['Oaken Brawler', 3, 5] }, { log: 'clashes with' }, { unsimulated: 0 }],
  },
  {
    name: 'Oaken Brawler clashes and does not win: no counter (CR 701.19b, the "if you win" clause)', cr: '701.19b',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Oaken Brawler'], libraryTop: ['Plains'] }, { libraryTop: ['Hill Giant'] }],
    script: [{ cast: 'Oaken Brawler' }, { resolve: true }],
    expect: [{ pt: ['Oaken Brawler', 2, 4] }, { counters: ['Oaken Brawler', { '+1/+1': 0 }] }, { log: 'clashes with' }],
  },
  {
    name: 'a "whenever you clash" trigger fires on a clash', cr: '701.19a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'] }, {}],
    scripts: { ...bears([{ op: 'clash' }]), ...watcher({ on: 'clash' }, 'clash watcher') },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { log: 'clashes with' }],
  },

  // ---------------------------------------------------------------- exert (CR 701.38a)
  {
    name: 'an exerted creature does not untap during its controller\'s next untap step', cr: '701.38a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bears([{ op: 'exert', target: 'self' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { turns: 2 }],
    expect: [{ tapped: ['Grizzly Bears', true] }, { log: 'exerts' }],
  },
  {
    name: 'a "whenever you exert a creature" trigger fires when one is exerted', cr: '701.38a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'] }, {}],
    scripts: { ...bears([{ op: 'exert', target: 'self' }]), ...watcher({ on: 'exerts' }, 'exert watcher') },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }],
  },
  {
    name: 'Hope Tender pays "Exert this creature" as a cost and stays tapped through its next untap step', cr: '701.38b',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Hope Tender'], tapped: ['Forest', 'Forest'] }, {}],
    script: [{ activate: 'Hope Tender', ability: 1, targets: [['Forest', 'Forest']] }, { resolve: true }, { turns: 2 }],
    expect: [{ tapped: ['Hope Tender', true] }, { log: 'exerts Hope Tender' }],
  },

  // ---------------------------------------------------------------- collect evidence (CR 701.62a)
  {
    name: 'collect evidence 5 exiles cards from your graveyard with total mana value 5 or greater', cr: '701.62a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], graveyard: ['Hill Giant', 'Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'collect-evidence', amount: 5 }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ graveyardCount: [0, 0] }, { zoneCount: [0, 'exile', 2] }, { log: 'collects evidence 5' }],
  },
  {
    name: 'Forensic Researcher pays "Collect evidence 3" as a cost of its tap ability', cr: '701.62a',
    seats: [{ bf: ['Forensic Researcher'], graveyard: ['Hill Giant', 'Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    script: [{ activate: 'Forensic Researcher', ability: 1, targets: [['Grizzly Bears']] }, { resolve: true }],
    // Hill Giant alone is mana value 4, so exactly one card leaves the graveyard
    expect: [{ tapped: ['Grizzly Bears', true] }, { zoneCount: [0, 'exile', 1] }, { graveyardCount: [0, 1] }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- endure (CR 701.64a)
  {
    name: 'Dusyut Earthcarver endures 3 and takes the counters', cr: '701.64a',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Dusyut Earthcarver'] }, {}],
    script: [{ cast: 'Dusyut Earthcarver' }, { resolve: true }],
    expect: [{ pt: ['Dusyut Earthcarver', 7, 7] }, { counters: ['Dusyut Earthcarver', { '+1/+1': 3 }] }, { unsimulated: 0 }],
  },
  {
    name: 'endure 2 taking the other mode creates a 2/2 white Spirit token instead of the counters', cr: '701.64a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bears([{ op: 'endure', amount: 2, target: 'self' }]),
    script: [{ answer: 'create a 2/2 white Spirit creature token' }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 2, 2] }, { counters: ['Grizzly Bears', { '+1/+1': 0 }] }, { zoneCount: [0, 'battlefield', 3] }, { events: { type: 'create-token', min: 1 } }],
  },
  {
    name: 'the counters-on-source-any amount counts every counter kind on the source', cr: '701.64a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], counters: { 'Grizzly Bears': { '+1/+1': 1, charge: 2 } } }, {}],
    scripts: bears([{ op: 'endure', amount: { count: 'counters-on-source-any' }, target: 'self' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    // 1 + 1/+1 and 2 charge = 3, so three more +1/+1 counters land: 2/2 base + 4 counters
    expect: [{ pt: ['Grizzly Bears', 6, 6] }, { counters: ['Grizzly Bears', { '+1/+1': 4, charge: 2 }] }],
  },

  // ---------------------------------------------------------------- suspect (CR 701.61a)
  {
    name: "Convenient Target suspects the enchanted creature, which then can't block", cr: '701.61a',
    seats: [{ bf: ['Mountain', 'Grizzly Bears'], hand: ['Convenient Target'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Convenient Target', targets: [['Hill Giant']] }, { resolve: true }, { attack: ['Grizzly Bears'], refused: [['Hill Giant', 'Grizzly Bears']] }],
    expect: [{ life: [1, 18] }, { log: 'becomes suspected' }, { ext: ['Hill Giant', 'suspected', true] }],
  },
  {
    name: 'a suspected attacker has menace: one blocker alone is not enough', cr: '701.61a',
    seats: [{ bf: ['Mountain', 'Grizzly Bears'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'suspect', target: { kind: 'creature' } }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }, { attack: ['Grizzly Bears'], refused: [['Hill Giant', 'Grizzly Bears']] }],
    expect: [{ life: [1, 18] }, { log: "can't block Grizzly Bears alone" }],
  },
  {
    name: 'the suspected condition is false before suspecting and true after it', cr: '701.61a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bearsFree(polarity({ op: 'suspect', target: 'self' }, 'suspected')),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 25] }, { ext: ['Grizzly Bears', 'suspected', true] }],
  },

  // ---------------------------------------------------------------- behold (CR 701.63a)
  {
    name: 'behold a Dragon with a Dragon in hand: the reflexive "when you do" half runs', cr: '701.63a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], hand: ['Shivan Dragon'] }, {}],
    scripts: bears([{ op: 'behold', what: { subtypes: ['Dragon'] } }, { op: 'reflexive', when: 'you-do', effects: [{ op: 'gain-life', amount: 3, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { log: 'beholds' }],
  },
  {
    name: 'behold a Dragon with no Dragon anywhere: nothing happens and the reflexive half does not run', cr: '701.63a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], hand: ['Hill Giant'] }, {}],
    scripts: bears([{ op: 'behold', what: { subtypes: ['Dragon'] } }, { op: 'reflexive', when: 'you-do', effects: [{ op: 'gain-life', amount: 3, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 20] }, { noLog: 'beholds' }],
  },
  {
    name: 'behold as a cost: the ability is payable with a Dragon in hand', cr: '701.63a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], hand: ['Shivan Dragon'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { beholdWhat: { subtypes: ['Dragon'] } }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'behold cost' }] } },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { log: 'beholds' }, { handCount: [0, 1] }],
  },

  // ---------------------------------------------------------------- forage as a cost (CR 701.57a)
  {
    name: 'Forage as a cost: the three cards leave the graveyard before the ability resolves', cr: '701.57a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], graveyard: ['Shock', 'Shock', 'Shock'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true, forage: true }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'forage cost' }] } },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ graveyardCount: [0, 0] }, { zoneCount: [0, 'exile', 3] }, { life: [0, 23] }, { log: 'forages' }],
  },

  // ---------------------------------------------------------------- exploit (CR 702.110a)
  {
    name: 'Rakshasa Gravecaller exploits a creature and its exploit trigger makes two Zombies', cr: '702.110a',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Grizzly Bears'], hand: ['Rakshasa Gravecaller'] }, {}],
    script: [{ cast: 'Rakshasa Gravecaller' }, { resolve: true }],
    // 5 lands + Gravecaller + 2 Zombies; the Bears it exploited are in the graveyard
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zoneCount: [0, 'battlefield', 8] }, { log: 'exploits' }, { unsimulated: 0 }],
  },
  {
    name: 'a "whenever a creature you control exploits a creature" trigger fires for another creature\'s exploit', cr: '702.110b',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'] }, {}],
    scripts: { ...bears([{ op: 'exploit' }]), ...watcher({ on: 'exploits', self: false }, 'exploit watcher') },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { zone: ['Grizzly Bears', 'graveyard'] }],
  },

  // ---------------------------------------------------------------- villainous choice (CR 701.52a)
  {
    name: 'each opponent faces a villainous choice and takes the first option', cr: '701.52a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([{ op: 'villainous-choice', who: 'each-opponent', modes: [[{ op: 'scoped', who: 'that-player', do: [{ op: 'lose-life', amount: 3, who: 'you' }] }], [{ op: 'draw', amount: 1, who: 'you' }]] }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ life: [1, 17] }, { life: [0, 20] }, { log: 'faces a villainous choice' }],
  },

  // ---------------------------------------------------------------- harness (Marvel Infinity Stones)
  {
    name: 'The Mind Stone is harnessed by its own activated ability', cr: '701.63a',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'The Mind Stone'] }, {}],
    script: [{ activate: 'The Mind Stone', ability: 1 }, { resolve: true }],
    expect: [{ ext: ['The Mind Stone', 'harnessed', true] }, { log: 'is harnessed' }],
  },
  {
    name: 'the harnessed condition is false before harnessing and true after it', cr: '701.63a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bearsFree(polarity({ op: 'harness', target: 'self' }, 'harnessed')),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 25] }, { ext: ['Grizzly Bears', 'harnessed', true] }],
  },

  // ---------------------------------------------------------------- CR 400.7: family state does not survive a zone change
  // Every marker this family writes on a permanent (`monstrous`, `suspected`, `harnessed`, `goadedBy`, `manifested`,
  // `cloaked`, `clashWon`) belongs to the OBJECT, and a permanent that leaves the battlefield and comes back is a new
  // object that remembers none of it. These three pin the family's `leave` hook; without it the second monstrosity is
  // refused forever, the recast creature can never block again, and the ∞ ability of a recast Infinity Stone stays on.
  {
    name: 'a bounced and recast creature is a new object: it can become monstrous a second time', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears', 'Forest', 'Forest'] }, {}],
    scripts: bearsTwo([{ op: 'monstrosity', amount: 2 }], bounceSelf, 'monstrosity 2'),
    script: [
      { activate: 'Grizzly Bears', ability: 0 }, { resolve: true },
      { activate: 'Grizzly Bears', ability: 1 }, { resolve: true },
      { cast: 'Grizzly Bears' }, { resolve: true },
      { activate: 'Grizzly Bears', ability: 0 }, { resolve: true },
    ],
    // CR 701.31b: the new object is not monstrous, so monstrosity 2 works again — 2/2 + two counters, not a refusal
    expect: [{ pt: ['Grizzly Bears', 4, 4] }, { counters: ['Grizzly Bears', { '+1/+1': 2 }] }, { noLog: 'is already monstrous' }],
  },
  {
    name: 'a bounced and recast creature is no longer suspected or harnessed, and can block again', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears', 'Forest', 'Forest'] }, { bf: ['Hill Giant'] }],
    scripts: bearsTwo([{ op: 'suspect', target: 'self' }, { op: 'harness', target: 'self' }], bounceSelf, 'suspect and harness'),
    script: [
      { activate: 'Grizzly Bears', ability: 0 }, { resolve: true },
      { activate: 'Grizzly Bears', ability: 1 }, { resolve: true },
      { cast: 'Grizzly Bears' }, { resolve: true },
      { passUntil: 'end' }, { passUntil: 'declare-attackers' },
      // the block is really offered to the engine: while `suspected` survived the bounce, CR 701.61a refused it
      { attack: ['Hill Giant'], blocks: [['Grizzly Bears', 'Hill Giant']] },
    ],
    expect: [{ ext: ['Grizzly Bears', 'suspected', undefined] }, { ext: ['Grizzly Bears', 'harnessed', undefined] }, { life: [0, 20] }],
  },
  {
    name: 'a goaded creature that leaves the battlefield is no longer goaded', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, { bf: ['Hill Giant'] }],
    scripts: bearsTwo(
      [{ op: 'goad', target: { kind: 'creature', controller: 'opponent' } }],
      [{ op: 'bounce', target: { kind: 'creature', controller: 'opponent' }, to: 'hand' }], 'goad', 'bounce theirs'),
    script: [
      { activate: 'Grizzly Bears', ability: 0, targets: [['Hill Giant']] }, { resolve: true },
      { activate: 'Grizzly Bears', ability: 1, targets: [['Hill Giant']] }, { resolve: true },
    ],
    expect: [{ zone: ['Hill Giant', 'hand'] }, { ext: ['Hill Giant', 'goadedBy', undefined] }, { ext: ['Hill Giant', 'goadedTurn', undefined] }],
  },

  // ---------------------------------------------------------------- discover: the card is never stranded (CR 701.56a/b)
  {
    name: 'discover: the card may be put into your hand instead of cast', cr: '701.56a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], libraryTop: ['Hill Giant'] }, {}],
    scripts: bearsFree([{ op: 'discover', amount: 4 }], 'discover 4'),
    script: [{ answer: 'put Hill Giant into your hand' }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'hand'] }, { log: 'puts Hill Giant into their hand' }],
  },
  {
    name: 'discover: a free-cast window nobody used hands the card over rather than stranding it in exile', cr: '701.56a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], libraryTop: ['Hill Giant'] }, {}],
    scripts: bearsFree([{ op: 'discover', amount: 4 }], 'discover 4'),
    // the default choice is the free cast; the turn then ends without it being taken
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { turns: 1 }],
    expect: [{ zone: ['Hill Giant', 'hand'] }, { log: 'discovered and not cast' }],
  },
  {
    name: 'discover: the cards that were not taken go to the bottom in a random order', cr: '701.56b',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], libraryTop: ['Hill Giant', 'Runeclaw Bear', 'Shivan Dragon', 'Serra Angel', 'Shock'] }, {}],
    // discover 1 exiles all five (Shock is the first nonland with mana value ≤ 1) and bottoms the other four; milling
    // the twenty filler cards brings that pile back to the top, so `look-top` names whichever card the shuffle put
    // first. The scenario rng is seeded (seed 1), so the permutation is fixed: Runeclaw Bear, NOT the Hill Giant that
    // an unshuffled `rest` would leave first — the bottom of the library must not become known and ordered.
    scripts: bearsFree([{ op: 'discover', amount: 1 }, { op: 'mill', amount: 20, who: 'you' }, { op: 'look-top', who: 'you', amount: 1 }], 'discover 1'),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ libraryCount: [0, 4] }, { log: /looks at the top card of P0's library \(Runeclaw Bear\)/ }, { noLog: /looks at the top card of P0's library \(Hill Giant\)/ }],
  },

  // ---------------------------------------------------------------- the action outlives the permanent
  {
    name: 'connive still draws and discards when the permanent has left the battlefield', cr: '701.48a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], hand: ['Hill Giant'], libraryTop: ['Runeclaw Bear'] }, {}],
    scripts: bearsFree([{ op: 'bounce', target: 'self', to: 'hand' }, { op: 'connive', amount: 1, target: 'self' }], 'bounce then connive'),
    // only the +1/+1 counters are lost with the permanent; the controller still draws one and discards one
    expect: [{ zone: ['Runeclaw Bear', 'hand'] }, { graveyardCount: [0, 1] }, { log: 'connives 1' }],
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
  },
  {
    name: 'endure still offers the Spirit when the creature has left the battlefield', cr: '701.64a',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bearsFree([{ op: 'bounce', target: 'self', to: 'hand' }, { op: 'endure', amount: 2, target: 'self' }], 'bounce then endure'),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ events: { type: 'create-token', min: 1, max: 1 } }, { log: 'only the Spirit mode is left' }],
  },
  {
    name: 'exploit still sacrifices a creature when the exploiting creature has left the battlefield', cr: '702.110a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'] }, {}],
    scripts: bearsFree([{ op: 'bounce', target: 'self', to: 'hand' }, { op: 'exploit' }], 'bounce then exploit'),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { log: 'exploits Hill Giant' }],
  },
];
