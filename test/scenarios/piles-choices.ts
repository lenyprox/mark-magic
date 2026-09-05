// piles-choices (Phase 9.1, docs/vocabulary/piles-choices.md): one scenario per op, per condition, per trigger, per
// static and per keyword parameter the family adds.
//
// No printed card parses into most of these ops yet (the parser reaches only the shapes listed in the vocabulary
// doc's "Parser wordings"), so every scenario scripts a real card through the DSL's `scripts` field: an activated
// ability added to Grizzly Bears, or Lightning Bolt's spell text replaced. The board, the lands and the opponents are
// real cards; the expectations are about what the op did, and each one fails if the op did nothing.
import type { Effect } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains a free "<effects>" ability (no tap, so it can be activated more than once in a turn). */
const bears = (effects: Effect[], text = 'piles-choices'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** Lightning Bolt's spell becomes <effects> ({R}, instant). */
const bolt = (effects: Effect[], text = 'piles-choices'): Record<string, ScenarioScript> =>
  ({ 'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects, text }] } });

const gain = (n: number): Effect => ({ op: 'gain-life', amount: n, who: 'you' });
const draw1: Effect = { op: 'draw', amount: 1, who: 'you' };

export const pilesChoices: Scenario[] = [
  // ------------------------------------------------------------------ choose-modes (CR 700.2)
  {
    name: 'choose-modes with count 1 runs exactly the chosen mode', cr: '700.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 1, labels: ['gain 3 life', 'draw a card'], modes: [[gain(3)], [draw1]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { handCount: [0, 0] }, { log: 'P0 chooses gain 3 life' }, { unsimulated: 0 }],
  },
  {
    name: 'choose-modes with repeat takes the same mode twice (You may choose the same mode more than once)', cr: '700.2d',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 2, repeat: true, labels: ['gain 3 life', 'draw a card'], modes: [[gain(3)], [draw1]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    // without `repeat` the second pick would have to be the draw: 23 life and one card
    expect: [{ life: [0, 26] }, { handCount: [0, 0] }, { unsimulated: 0 }],
  },
  {
    name: 'choose-modes without repeat cannot take the same mode twice', cr: '700.2d',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 2, labels: ['gain 3 life', 'draw a card'], modes: [[gain(3)], [draw1]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { handCount: [0, 1] }, { unsimulated: 0 }],
  },
  {
    name: "choose-modes notChosen this-turn bars a mode already chosen this turn", cr: '700.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 1, notChosen: 'this-turn', labels: ['gain 3 life', 'draw a card'], modes: [[gain(3)], [draw1]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { activate: 'Grizzly Bears' }, { resolve: true }],
    // the second activation may not take the life mode again: 23 life and one card, not 26 life
    expect: [{ life: [0, 23] }, { handCount: [0, 1] }, { unsimulated: 0 }],
  },
  {
    name: 'choose-modes notChosen this-turn forgets the record at cleanup', cr: '514.2',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 1, notChosen: 'this-turn', labels: ['gain 3 life', 'draw a card'], modes: [[gain(3)], [draw1]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { turns: 2 }, { activate: 'Grizzly Bears', by: 0 }, { resolve: true }],
    expect: [{ life: [0, 26] }, { unsimulated: 0 }],
  },
  {
    name: "choose-modes notChosen ever keeps the record across turns", cr: '700.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 1, notChosen: 'ever', labels: ['gain 3 life', 'draw a card'], modes: [[gain(3)], [draw1]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { turns: 2 }, { activate: 'Grizzly Bears', by: 0 }, { resolve: true }],
    // the life mode is gone for good: the second activation draws instead
    expect: [{ life: [0, 23] }, { unsimulated: 0 }],
  },
  {
    name: 'choose-modes with an opponent as the chooser asks that opponent (An opponent chooses one)', cr: '700.2e',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 1, chooser: 'an-opponent', labels: ['gain 3 life', 'draw a card'], modes: [[gain(3)], [draw1]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ log: 'P1 chooses gain 3 life' }, { noLog: 'P0 chooses gain 3 life' }, { life: [0, 23] }, { unsimulated: 0 }],
  },
  {
    name: 'choose-modes with pawprint weights spends a budget, not a number of modes', cr: '700.2i',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 5, weights: [1, 2, 3], labels: ['gain 1 life', 'gain 2 life', 'gain 4 life'], modes: [[gain(1)], [gain(2)], [gain(4)]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    // {P} + {P}{P} = 3 of the 5 fits; the third mode would take the total to 6, so it cannot be chosen
    expect: [{ life: [0, 23] }, { unsimulated: 0 }],
  },
  {
    name: 'choose-modes with upTo lets the chooser stop early', cr: '700.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 3, upTo: true, labels: ['gain 3 life', 'draw a card', 'gain 5 life'], modes: [[gain(3)], [draw1], [gain(5)]] }]),
    script: [{ answer: 'draw a card' }, { answer: '(no more modes)' }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ handCount: [0, 1] }, { life: [0, 20] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ vote (CR 701.38)
  {
    name: 'vote resolved by majority runs the winning option once (will of the council)', cr: '701.38a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'vote', resolve: 'majority', options: [{ label: 'growth', effects: [gain(3)] }, { label: 'chaos', effects: [draw1] }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { handCount: [0, 0] }, { log: 'P0 votes for growth' }, { log: 'P1 votes for growth' }, { unsimulated: 0 }],
  },
  {
    name: 'vote resolved per vote runs the option once for every vote it got (council’s dilemma)', cr: '701.38a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'vote', resolve: 'per-vote', options: [{ label: 'growth', effects: [gain(3)] }, { label: 'chaos', effects: [draw1] }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 26] }, { unsimulated: 0 }],
  },
  {
    name: 'a tied vote with tie all runs every tied option', cr: '701.38a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'vote', resolve: 'majority', tie: 'all', options: [{ label: 'growth', effects: [gain(3)] }, { label: 'chaos', effects: [draw1] }] }]),
    // the controller votes first (CR 701.38a): chaos from P0, growth from P1 by default — one vote each
    script: [{ answer: 'chaos' }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { handCount: [0, 1] }, { unsimulated: 0 }],
  },
  {
    name: 'a tied vote with tie first runs only the earliest-listed tied option', cr: '701.38a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'vote', resolve: 'majority', tie: 'first', options: [{ label: 'growth', effects: [gain(3)] }, { label: 'chaos', effects: [draw1] }] }]),
    script: [{ answer: 'chaos' }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { handCount: [0, 0] }, { unsimulated: 0 }],
  },
  {
    name: 'extra-votes gives its controller an additional vote while voting', cr: '701.38d',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      ...bears([{ op: 'vote', resolve: 'per-vote', options: [{ label: 'growth', effects: [gain(3)] }, { label: 'chaos', effects: [draw1] }] }]),
      'Hill Giant': { abilities: [{ kind: 'static', effect: { kind: 'extra-votes', amount: 1 }, text: 'While voting, you may vote an additional time.' }] },
    },
    // P0 votes twice, P1 once: three votes for growth instead of two
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 29] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ piles (CR 700.3)
  {
    name: 'separate-piles, choose-pile and chosen-fate: the opponent picks a pile and the two piles go to different zones', cr: '700.3',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], libraryTop: ['Grizzly Bears', 'Hill Giant', 'Shock', 'Divination'] }, {}],
    scripts: bolt([
      { op: 'separate-piles', from: { zone: 'library', who: 'you', top: 4 }, piles: 2, separator: 'you', reveal: true },
      { op: 'choose-pile', chooser: 'an-opponent' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'graveyard' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { zone: ['Grizzly Bears', 'hand'] }, { zone: ['Hill Giant', 'hand'] },
      { zone: ['Shock', 'graveyard'] }, { zone: ['Divination', 'graveyard'] },
      { log: 'P1 chooses pile 1' }, { unsimulated: 0 },
    ],
  },
  {
    name: 'separate-piles lets an opponent do the separating', cr: '700.3a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], libraryTop: ['Grizzly Bears', 'Hill Giant', 'Shock', 'Divination'] }, {}],
    scripts: bolt([
      { op: 'separate-piles', from: { zone: 'library', who: 'you', top: 4 }, piles: 2, separator: 'an-opponent' },
      { op: 'choose-pile', chooser: 'you' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { log: 'P1 separates 4 cards into pile 1' }, { log: 'P0 chooses pile 1' },
      { zone: ['Grizzly Bears', 'hand'] }, { zone: ['Shock', 'library'] }, { unsimulated: 0 },
    ],
  },

  {
    name: 'chosen-fate puts the chosen pile onto the battlefield tapped under your control', cr: '610.3c',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], graveyard: ['Grizzly Bears', 'Hill Giant', 'Runeclaw Bear', 'Alpine Grizzly'] }, {}],
    scripts: bolt([
      { op: 'separate-piles', from: { zone: 'graveyard', who: 'you' }, piles: 2, separator: 'you' },
      { op: 'choose-pile', chooser: 'you' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'battlefield', controller: 'you', tapped: true }, other: { how: 'move', to: 'exile' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { zone: ['Grizzly Bears', 'battlefield'] }, { tapped: ['Grizzly Bears', true] }, { control: ['Hill Giant', 0] },
      { zone: ['Runeclaw Bear', 'exile'] }, { zone: ['Alpine Grizzly', 'exile'] }, { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ choose-objects
  {
    name: "choose-objects reads the current binding with from 'those'", cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], libraryTop: ['Grizzly Bears', 'Hill Giant', 'Shock'] }, {}],
    scripts: bolt([
      { op: 'look-top', who: 'you', amount: 3 },
      { op: 'choose-objects', chooser: 'an-opponent', from: 'those', count: 1 },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'graveyard' }, other: { how: 'move', to: 'hand' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Hill Giant', 'hand'] }, { zone: ['Shock', 'hand'] }, { unsimulated: 0 }],
  },
  {
    name: 'choose-objects: the chosen creature is destroyed and the rest are left alone', cr: '608.2f',
    seats: [{ bf: ['Mountain', 'Grizzly Bears', 'Hill Giant'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([
      { op: 'choose-objects', chooser: 'an-opponent', from: { filter: { types: ['Creature'] }, who: 'you' }, count: 1 },
      { op: 'chosen-fate', chosen: { how: 'destroy' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    name: 'choose-objects with upTo: choosing none leaves every object unchosen', cr: '608.2f',
    seats: [{ bf: ['Mountain', 'Grizzly Bears', 'Hill Giant', 'Runeclaw Bear'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([
      { op: 'choose-objects', chooser: 'you', from: { filter: { types: ['Creature'] }, who: 'you' }, count: 2, upTo: true },
      { op: 'chosen-fate', other: { how: 'sacrifice' } },
    ]),
    script: [{ answer: [] }, { cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Hill Giant', 'graveyard'] }, { zone: ['Runeclaw Bear', 'graveyard'] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ choose-for-each-player (CR 608.2f, 101.4)
  {
    name: 'choose-for-each-player keeps one permanent of each named kind per player and sacrifices the rest (Tragic Arrogance)', cr: '608.2f',
    seats: [
      { bf: ['Mountain', 'Grizzly Bears', 'Hill Giant', "Sol Ring", 'Mind Stone'], hand: ['Lightning Bolt'] },
      { bf: ['Runeclaw Bear', 'Alpine Grizzly', 'Sol Ring'] },
    ],
    scripts: bolt([
      { op: 'choose-for-each-player', chooser: 'you', picks: [{ types: ['Creature'] }, { types: ['Artifact'] }] },
      { op: 'chosen-fate', other: { how: 'sacrifice' }, among: { notTypes: ['Land'] } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Hill Giant', 'graveyard'] },
      { zone: ['Mind Stone', 'graveyard'] },
      { zone: ['Runeclaw Bear', 'battlefield'] }, { zone: ['Alpine Grizzly', 'graveyard'] },
      { zone: ['Mountain', 'battlefield'] },                       // `among` keeps lands out of the sacrifice
      { unsimulated: 0 },
    ],
  },
  {
    name: 'choose-for-each-player with excludeSharing spares creatures that share a type with the chosen one (Winnowing)', cr: '608.2f',
    seats: [{ bf: ['Mountain', 'Grizzly Bears', 'Runeclaw Bear', 'Hill Giant'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([
      { op: 'choose-for-each-player', chooser: 'you', picks: [{ types: ['Creature'] }], from: { types: ['Creature'] } },
      { op: 'chosen-fate', other: { how: 'sacrifice' }, excludeSharing: 'creature-type' },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    // Grizzly Bears (Bear) is chosen; Runeclaw Bear is a Bear too and is spared; Hill Giant (Giant) is not
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Runeclaw Bear', 'battlefield'] }, { zone: ['Hill Giant', 'graveyard'] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ Class levels (CR 716.2)
  {
    name: 'set-level raises the level by one and the became-level trigger fires', cr: '716.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: {
      'Grizzly Bears': {
        abilities: [
          { kind: 'activated', cost: {}, effects: [{ op: 'set-level', to: 2 }], text: 'Level 2', sorcerySpeed: true },
          { kind: 'triggered', event: { on: 'became-level', level: 2 }, effects: [gain(5)], text: 'When this becomes level 2, you gain 5 life.' },
        ],
      },
    },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ ext: ['Grizzly Bears', 'pcLevel', 2] }, { life: [0, 25] }, { log: 'becomes level 2' }, { unsimulated: 0 }],
  },
  {
    name: 'set-level does nothing when the permanent is not one level below the target', cr: '716.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'set-level', to: 3 }, { op: 'conditional', condition: { kind: 'self-level', exactly: 1 }, then: [gain(7)] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 27] }, { noLog: 'becomes level 3' }, { unsimulated: 0 }],
  },
  {
    name: 'set-level with anyLevel jumps straight to the named level', cr: '716.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'set-level', to: 3, anyLevel: true }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ ext: ['Grizzly Bears', 'pcLevel', 3] }, { log: 'becomes level 3' }, { unsimulated: 0 }],
  },
  {
    name: 'the self-level condition reads the level a permanent has reached', cr: '716.2a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([
      { op: 'set-level', to: 2 },
      { op: 'conditional', condition: { kind: 'self-level', atLeast: 2 }, then: [gain(7)], else: [gain(1)] },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 27] }, { unsimulated: 0 }],
  },
  {
    name: 'a permanent with no level reads as level 1', cr: '716.2d',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'conditional', condition: { kind: 'self-level', exactly: 1 }, then: [gain(4)], else: [gain(9)] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { unsimulated: 0 }],
  },
];
