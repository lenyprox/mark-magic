// The control family (Phase 9.1, docs/vocabulary/control.md): one scenario per op, per duration and per keyword
// parameter, each written so it FAILS if the op did nothing — the control expectation names the seat the permanent
// must have moved to (or come back to), never just "the stack is empty".
//
// The parser rules for these wordings landed with the family, but the printed cards that use them (Sower of
// Temptation, Threaten, Homeward Path, Shifting Loyalties, Guardian Beast) mostly need other vocabulary as well, so
// the ops are exercised here through the DSL's `scripts` field on plain cards, the way test/scenarios/composition.ts
// does. The cards, the lands and the opponents' creatures are real; the expectations are about what the op did.
import type { Effect, TargetSpec } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>" (the printed vanilla body stays). */
const bears = (effects: Effect[], text = 'control'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects, text }] } });
/** Grizzly Bears gains a free "<effects>" ability — usable while it is tapped, and twice in a turn. */
const bearsFree = (effects: Effect[], text = 'control'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** Lightning Bolt's spell becomes <effects> ({R}, instant). */
const bolt = (effects: Effect[], text = 'control'): Record<string, ScenarioScript> =>
  ({ 'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects, text }] } });

const oppCreature: TargetSpec = { kind: 'creature', controller: 'opponent' };

export const control: Scenario[] = [
  // ------------------------------------------------------------------ control-gain: durations
  {
    name: 'control-gain with no duration keeps the creature for good (CR 611.2)', cr: '611.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'control-gain', target: oppCreature }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 2 }],
    expect: [{ control: ['Hill Giant', 0] }, { log: 'gains control of Hill Giant' }, { unsimulated: 0 }],
  },
  {
    name: 'control-gain until end of turn hands the creature back in the cleanup step (CR 514.2)', cr: '514.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'control-gain', target: oppCreature, duration: 'eot' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 1 }],
    expect: [{ control: ['Hill Giant', 1] }, { log: 'gains control of Hill Giant' }, { log: 'Hill Giant returns to' }],
  },
  {
    name: 'control-gain until end of combat hands the creature back as the combat phase ends (CR 511.3)', cr: '511.3',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'control-gain', target: oppCreature, duration: 'end-of-combat' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { passUntil: 'main2' }],
    expect: [{ control: ['Hill Giant', 1] }, { log: 'gains control of Hill Giant' }, { log: 'until end of combat' }],
  },
  {
    name: 'control-gain until the end of your next turn survives this turn\'s cleanup', cr: '611.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'control-gain', target: oppCreature, duration: 'your-next-turn' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 1 }],
    expect: [{ control: ['Hill Giant', 0] }, { log: 'gains control of Hill Giant' }],
  },
  {
    name: 'control-gain until the end of your next turn ends at that turn\'s cleanup', cr: '611.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'control-gain', target: oppCreature, duration: 'your-next-turn' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 3 }],
    expect: [{ control: ['Hill Giant', 1] }, { log: 'until the end of your next turn' }],
  },

  // ------------------------------------------------------------------ control-gain: the "for as long as" durations
  {
    name: 'control-gain for as long as the source remains on the battlefield ends when the source dies (CR 611.2b)', cr: '611.2b',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'control-gain', target: oppCreature, duration: 'while-source-on-battlefield' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { control: ['Hill Giant', 1] }, { log: 'gains control of Hill Giant' }, { log: 'while-source-on-battlefield' }],
  },
  {
    name: 'control-gain for as long as you control the source ends when the source itself is stolen (CR 611.2b)', cr: '611.2b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'control-gain', target: oppCreature, duration: 'while-you-control-source' }], text: 'control' }] },
      'Runeclaw Bear': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'control-gain', target: oppCreature }], text: 'control' }] },
    },
    script: [
      { activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true },
      { activate: 'Runeclaw Bear', by: 1, targets: [['Grizzly Bears']] }, { resolve: true },
    ],
    expect: [{ control: ['Grizzly Bears', 1] }, { control: ['Hill Giant', 1] }, { log: 'while-you-control-source' }],
  },
  {
    name: 'control-gain for as long as the source remains tapped ends at the source\'s next untap step (CR 611.2b)', cr: '611.2b',
    seats: [{ bf: ['Grizzly Bears'], tapped: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bearsFree([{ op: 'control-gain', target: oppCreature, duration: 'while-source-tapped' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 2 }],
    expect: [{ control: ['Hill Giant', 1] }, { log: 'gains control of Hill Giant' }, { log: 'while-source-tapped' }],
  },
  {
    name: 'control-gain for as long as you control the source and it remains tapped ends when it untaps', cr: '611.2b',
    seats: [{ bf: ['Grizzly Bears'], tapped: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bearsFree([{ op: 'control-gain', target: oppCreature, duration: 'while-you-control-source-and-tapped' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 2 }],
    expect: [{ control: ['Hill Giant', 1] }, { log: 'while-you-control-source-and-tapped' }],
  },
  {
    name: 'control-gain for as long as it has a counter on it holds while the counter is there', cr: '611.2b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([
      { op: 'counters', target: oppCreature, counter: 'shield', amount: 1 },
      { op: 'control-gain', target: 'that', duration: 'while-counter', counter: 'shield' },
    ]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 2 }],
    expect: [{ control: ['Hill Giant', 0] }, { counters: ['Hill Giant', { shield: 1 }] }, { log: 'gains control of Hill Giant' }],
  },
  {
    name: 'a for-as-long-as control effect whose condition is already false never starts (CR 611.2b)', cr: '611.2b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    // no counter is ever put on it, so the duration has already expired as the effect would apply
    scripts: bears([{ op: 'control-gain', target: oppCreature, duration: 'while-counter', counter: 'shield' }, { op: 'gain-life', amount: 4, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 1] }, { life: [0, 24] }, { noLog: 'gains control of Hill Giant' }],
  },

  // ------------------------------------------------------------------ control-gain: untap / haste / all / who
  {
    name: 'control-gain with untap and haste is a Threaten: the stolen creature attacks the turn it changed hands', cr: '702.10b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'], tapped: ['Hill Giant'] }],
    scripts: bears([{ op: 'control-gain', target: oppCreature, duration: 'eot', untap: true, haste: true }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { attack: ['Hill Giant'] }],
    expect: [{ life: [1, 17] }, { control: ['Hill Giant', 0] }, { tapped: ['Hill Giant', true] }, { keywords: ['Hill Giant', ['haste']] }],
  },
  {
    name: 'control-gain over a group takes every permanent the filter matches, on every battlefield', cr: '609.2',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear', 'Forest'] }],
    scripts: bolt([{ op: 'control-gain', all: { all: { types: ['Creature'] } }, duration: 'eot' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { control: ['Runeclaw Bear', 0] }, { control: ['Forest', 1] }, { zoneCount: [0, 'battlefield', 4] }],
  },
  {
    name: 'control-gain by the player with the most life gives the permanent to that player, not to the controller', cr: '104.2',
    seats: [{ bf: ['Grizzly Bears'], life: 10 }, { bf: ['Hill Giant'], life: 20 }],
    scripts: bearsFree([{ op: 'control-gain', target: 'self', who: 'leader', leader: { of: 'life', extreme: 'most' } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 1] }, { log: 'gains control of Grizzly Bears' }],
  },
  {
    name: 'control-gain by the player with the most life does nothing while two players are tied', cr: '104.2',
    seats: [{ bf: ['Grizzly Bears'], life: 20 }, { bf: ['Hill Giant'], life: 20 }],
    scripts: bearsFree([{ op: 'control-gain', target: 'self', who: 'leader', leader: { of: 'life', extreme: 'most' } }, { op: 'gain-life', amount: 3, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 0] }, { life: [0, 23] }, { noLog: 'gains control of Grizzly Bears' }],
  },
  {
    name: 'a scoped target-opponent block makes the opponent gain control of the source (Jinxed Idol)', cr: '609.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bearsFree([{ op: 'scoped', who: 'target-opponent', do: [{ op: 'control-gain', target: 'self' }] }]),
    script: [{ activate: 'Grizzly Bears', targets: [['P1']] }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 1] }, { log: 'gains control of Grizzly Bears' }],
  },

  // ------------------------------------------------------------------ control-return
  {
    name: 'control-return gives every player back the permanents they own (Homeward Path)', cr: '609.2',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: {
      ...bears([{ op: 'control-gain', target: oppCreature }]),
      ...bolt([{ op: 'control-return' }]),
    },
    script: [
      { activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true },
      { cast: 'Lightning Bolt' }, { resolve: true },
    ],
    expect: [{ control: ['Hill Giant', 1] }, { control: ['Grizzly Bears', 0] }, { log: 'they own it' }],
  },
  {
    name: 'control-return with a filter only hands back the permanents the filter matches', cr: '609.2',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Forest'] }],
    scripts: {
      ...bears([{ op: 'control-gain', all: { all: {} , who: 'each-opponent' } }]),
      ...bolt([{ op: 'control-return', filter: { types: ['Land'] } }]),
    },
    script: [
      { activate: 'Grizzly Bears' }, { resolve: true },
      { cast: 'Lightning Bolt' }, { resolve: true },
    ],
    expect: [{ control: ['Forest', 1] }, { control: ['Hill Giant', 0] }],
  },

  // ------------------------------------------------------------------ control-exchange
  {
    name: 'control-exchange swaps two targeted permanents that share a card type (CR 701.12b)', cr: '701.12b',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'control-exchange', target: { kind: 'multi', specs: [{ kind: 'creature', controller: 'you' }, oppCreature] }, share: 'card-type' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears'], ['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 1] }, { control: ['Hill Giant', 0] }, { log: 'is exchanged' }],
  },
  {
    name: 'control-exchange does nothing when the two permanents share no card type (CR 701.12b)', cr: '701.12b',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Forest'] }],
    scripts: bolt([{ op: 'control-exchange', target: { kind: 'multi', specs: [{ kind: 'creature', controller: 'you' }, { kind: 'land', controller: 'opponent' }] }, share: 'card-type' }, { op: 'gain-life', amount: 6, who: 'you' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears'], ['Forest']] }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 0] }, { control: ['Forest', 1] }, { life: [0, 26] }, { noLog: 'is exchanged' }],
  },
  {
    name: 'control-exchange with self swaps the source for the one targeted permanent (Gilded Drake)', cr: '701.12b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bearsFree([{ op: 'control-exchange', target: oppCreature, self: true }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 1] }, { control: ['Hill Giant', 0] }, { log: 'is exchanged' }],
  },
  {
    name: 'control-exchange until end of turn puts both permanents back in the cleanup step', cr: '514.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bearsFree([{ op: 'control-exchange', target: oppCreature, self: true, duration: 'eot' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 1 }],
    expect: [{ control: ['Grizzly Bears', 0] }, { control: ['Hill Giant', 1] }, { log: 'is exchanged' }, { log: 'until end of turn' }],
  },

  // ------------------------------------------------------------------ the condition, the static, the trigger, the target kind
  {
    name: 'the control-leader condition is true only while one player is strictly ahead', cr: '104.2',
    seats: [{ bf: ['Grizzly Bears'], life: 20 }, { bf: ['Hill Giant'], life: 12 }],
    scripts: bearsFree([{ op: 'conditional', condition: { kind: 'control-leader', of: 'life', extreme: 'most' }, then: [{ op: 'control-gain', target: oppCreature }] }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { log: 'gains control of Hill Giant' }],
  },
  {
    name: 'the control-leader condition is false on a tie, so the guarded effect does not run', cr: '104.2',
    seats: [{ bf: ['Grizzly Bears'], life: 20 }, { bf: ['Hill Giant'], life: 20 }],
    scripts: bearsFree([{ op: 'conditional', condition: { kind: 'control-leader', of: 'life', extreme: 'most' }, then: [{ op: 'control-gain', target: oppCreature }], else: [{ op: 'gain-life', amount: 5, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 1] }, { life: [0, 25] }, { noLog: 'gains control of Hill Giant' }],
  },
  {
    name: 'a control-cant-change static keeps its permanent where it is while the rest of the group is taken', cr: '613.1c',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: {
      ...bolt([{ op: 'control-gain', all: { all: { types: ['Creature'] }, who: 'each-opponent' } }]),
      'Hill Giant': { abilities: [{ kind: 'static', effect: { kind: 'control-cant-change', scope: 'self' }, text: 'Players can\'t gain control of ~.' }] },
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 1] }, { control: ['Runeclaw Bear', 0] }, { noLog: 'gains control of Hill Giant' }],
  },
  {
    name: 'a control-gained trigger fires for the permanent whose controller changed', cr: '603.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: {
      ...bears([{ op: 'control-gain', target: oppCreature }]),
      'Hill Giant': { abilities: [{ kind: 'triggered', event: { on: 'control-gained', self: true }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'When a player gains control of ~, they gain 3 life.' }] },
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { life: [0, 23] }, { life: [1, 20] }],
  },
  {
    // Phase 9.1 review: `legal.ts` pushes a family target kind's answer straight into the option list without running
    // the `targetable()` predicate that guards every core kind, so the handler has to refuse an illegal target itself.
    // The requirement is carried by a TRIGGERED ability on purpose: the engine picks a trigger's targets itself out of
    // the option list this handler builds, so what the handler offers is exactly what the scenario observes.
    name: 'the permanent-you-own-not-control target kind never offers a permanent with shroud (CR 702.18b)', cr: '702.18b',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: ['shroud'] }, text: 'Shroud' }] },
      // the untargeted group form is how the shrouded Bears leaves its owner's side at all (shroud stops targeting, not theft)
      'Runeclaw Bear': { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'control-gain', all: { all: { subtypes: ['Bear'] }, who: 'each-opponent' } }], text: 'control' }] },
      'Hill Giant': { abilities: [{
        kind: 'triggered', event: { on: 'attacks', self: true },
        effects: [{ op: 'control-gain', target: { kind: 'permanent-you-own-not-control' } }, { op: 'gain-life', amount: 4, who: 'you' }],
        text: 'Whenever ~ attacks, gain control of target permanent you own but do not control. You gain 4 life.',
      }] },
    },
    script: [{ activate: 'Runeclaw Bear', by: 1 }, { resolve: true }, { attack: ['Hill Giant'] }, { resolve: true }],
    // the trigger resolved (the 4 life is the proof) and was offered nothing to take back: the only candidate has shroud
    expect: [{ control: ['Grizzly Bears', 1] }, { life: [0, 24] }],
  },
  {
    // Phase 9.1 review: `endControl` used to hand the permanent to `e.to` whatever had happened to that seat, so a
    // theft under a theft left the permanent parked on an eliminated player's battlefield forever.
    name: 'a control duration whose seat has left the game gives the permanent to its owner, not to the empty seat (CR 800.4a)', cr: '800.4a',
    seats: [
      { bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] },
      { bf: ['Runeclaw Bear'], life: 3 },
      { bf: ['Hill Giant'] },
    ],
    scripts: {
      ...bearsFree([{ op: 'control-gain', target: oppCreature, duration: 'eot' }]),
      'Runeclaw Bear': { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'control-gain', target: oppCreature }], text: 'control' }] },
    },
    script: [
      { activate: 'Runeclaw Bear', by: 1, targets: [['Hill Giant']] }, { resolve: true },   // P1 takes P2's Hill Giant for good
      { activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true },           // P0 takes it from P1 until end of turn
      { cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }, { sba: true },       // P1 leaves the game
      { turns: 1 },                                                                          // the cleanup hook fires
    ],
    expect: [{ control: ['Hill Giant', 2] }, { zoneCount: [1, 'battlefield', 0] }, { log: 'Hill Giant returns to' }],
  },
  {
    // Phase 9.1 review (Goblin Festival): the core's `thatPlayer` falls back to the controller of the last bound
    // object, so a control gain after a `damage` in the same ability would give the source away on every activation.
    name: 'a that-player control gain on an activated ability does nothing: "that player" needs a trigger (Goblin Festival)', cr: '608.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bearsFree([
      { op: 'damage', amount: 1, target: { kind: 'any' } },
      { op: 'control-gain', target: 'self', who: 'that-player' },
      { op: 'gain-life', amount: 5, who: 'you' },
    ]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 0] }, { life: [0, 25] }, { noLog: 'gains control of Grizzly Bears' }],
  },
  {
    name: 'a that-player control gain under a trigger goes to the player the trigger was about', cr: '603.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: {
      ...bearsFree([{ op: 'control-gain', target: oppCreature }]),
      'Runeclaw Bear': { abilities: [{
        kind: 'triggered', event: { on: 'control-gained', self: false },
        effects: [{ op: 'control-gain', target: 'self', who: 'that-player' }],
        text: 'Whenever a player gains control of a permanent, that player gains control of ~.',
      }] },
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { control: ['Runeclaw Bear', 0] }, { log: 'gains control of Runeclaw Bear' }],
  },
  {
    // Phase 9.1 review: `haste` was applied only to the targeted form, so the group Threaten package (Broadcast
    // Takeover, Insurrection, the Tibalt / Rowan / Dihada ultimates) handed the board over tapped and summoning-sick.
    name: 'a group control-gain with untap and haste is the Threaten package for a whole board (CR 702.10b)', cr: '702.10b',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'], tapped: ['Hill Giant'] }],
    scripts: bolt([{ op: 'control-gain', all: { all: { types: ['Creature'] }, who: 'each-opponent' }, duration: 'eot', untap: true, haste: true }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { attack: ['Hill Giant'] }],
    expect: [{ life: [1, 17] }, { control: ['Hill Giant', 0] }, { keywords: ['Hill Giant', ['haste']] }, { tapped: ['Hill Giant', true] }],
  },

  // ------------------------------------------------------------------ two live control effects on one permanent (CR 613.1c)
  {
    // Phase 9.1 re-review: `steal` used to keep only the FIRST live effect's `to`, so the newer duration handed the
    // permanent all the way home while the older effect was still in force. CR 613.1c / 611.2: control-change
    // effects apply in timestamp order and each one lasts until its OWN duration ends, so when the newer one ends
    // the older one is still applying — the permanent goes back to the older thief, not to its owner.
    name: 'a control duration ending over a still-live one gives the permanent to the older thief (CR 613.1c)', cr: '613.1c',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      ...bears([{ op: 'control-gain', target: oppCreature, duration: 'eot' }]),
      'Hill Giant': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'control-gain', target: oppCreature, duration: 'while-source-on-battlefield' }], text: 'control' }] },
    },
    script: [
      { activate: 'Hill Giant', by: 1, targets: [['Runeclaw Bear']] }, { resolve: true },   // P1 takes P2's Bear for as long as the Giant is there
      { activate: 'Grizzly Bears', targets: [['Runeclaw Bear']] }, { resolve: true },       // P0 takes it from P1 until end of turn
      { turns: 1 },                                                                         // the cleanup ends only the newer effect
    ],
    expect: [{ control: ['Runeclaw Bear', 1] }, { control: ['Hill Giant', 1] }, { log: 'returns to P1 .until end of turn.' }],
  },
  {
    // The other order: the OLDER effect ends first. It is underneath a live one, so nothing moves — the newer effect
    // still says who controls the permanent (CR 613.1c) — but the seat it will hand the permanent to is now the one
    // the older effect had recorded. The second theft is by the player who already controls the creature (Act of
    // Treason on the creature your own Sower of Temptation is holding), which is exactly the case that has no
    // controller change to hang a new entry on.
    name: 'a for-as-long-as control effect ending under a live one moves nothing (CR 613.1c)', cr: '613.1c',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Grizzly Bears'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      'Hill Giant': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'control-gain', target: oppCreature, duration: 'while-source-on-battlefield' }], text: 'control' }] },
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'control-gain', target: { kind: 'creature' }, duration: 'eot' }], text: 'control' }] },
    },
    script: [
      { activate: 'Hill Giant', by: 1, targets: [['Runeclaw Bear']] }, { resolve: true },   // P1 takes P2's Bear for as long as the Giant is there
      { activate: 'Grizzly Bears', by: 1, targets: [['Runeclaw Bear']] }, { resolve: true }, // P1 takes it again, until end of turn
      { cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true },              // the Giant dies: the older effect ends
    ],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { control: ['Runeclaw Bear', 1] }, { noLog: 'Runeclaw Bear returns to' }],
  },
  {
    // …and once the newer effect ends too, the permanent goes home to its owner: with the older effect gone, the
    // seat the end-of-turn effect found the permanent on is the owner's (CR 613.1c, 514.2).
    name: 'the newer control effect still ends on its own duration once the older one is gone (CR 514.2)', cr: '514.2',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Grizzly Bears'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      'Hill Giant': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'control-gain', target: oppCreature, duration: 'while-source-on-battlefield' }], text: 'control' }] },
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'control-gain', target: { kind: 'creature' }, duration: 'eot' }], text: 'control' }] },
    },
    script: [
      { activate: 'Hill Giant', by: 1, targets: [['Runeclaw Bear']] }, { resolve: true },
      { activate: 'Grizzly Bears', by: 1, targets: [['Runeclaw Bear']] }, { resolve: true },
      { cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true },
      { turns: 1 },
    ],
    expect: [{ control: ['Runeclaw Bear', 2] }, { log: 'Runeclaw Bear returns to P2 .until end of turn.' }],
  },
  {
    name: 'the permanent-you-own-not-control target kind offers exactly the permanents an opponent has taken from you', cr: '115.1',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Mountain'], hand: ['Lightning Bolt'] }],
    scripts: {
      ...bears([{ op: 'control-gain', target: oppCreature }]),
      ...bolt([{ op: 'control-gain', target: { kind: 'permanent-you-own-not-control' } }]),
    },
    script: [
      { activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true },
      { cast: 'Lightning Bolt', by: 1, targets: [['Hill Giant']] }, { resolve: true },
    ],
    expect: [{ control: ['Hill Giant', 1] }, { control: ['Grizzly Bears', 0] }],
  },
];
