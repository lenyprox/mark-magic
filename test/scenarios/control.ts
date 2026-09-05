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
