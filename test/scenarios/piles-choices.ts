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
    // review fix 1: with `weights: [0, 2]` the loop used to spend nothing per pick, `repeat` kept the mode legal and
    // the shipped agents never take the trailing "(no more modes)" option, so this scenario hung forever.
    name: 'choose-modes with a zero pawprint weight terminates (a mode costs at least {P})', cr: '700.2i',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'choose-modes', count: 5, repeat: true, weights: [0, 2], labels: ['gain 1 life', 'gain 2 life'], modes: [[gain(1)], [gain(2)]] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    // the zero weight reads as 1: five picks of the first mode spend the whole 5-{P} budget and the loop stops
    expect: [{ life: [0, 25] }, { unsimulated: 0 }],
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

  // ------------------------------------------------------------------ reveal (CR 701.20a)
  {
    // review fix 5: "Reveal the top N cards" used to be `look-top` alone — a LOOK (CR 701.20e), which shows the cards
    // to their owner only. Nothing recorded them as public, so `redact` handed a hidden-information agent
    // `__hidden__` for every one of them and the opponent Fact or Fiction asks to split the pile split it blind.
    name: 'reveal-cards shows the top cards to every player and binds those for the sentence after it', cr: '701.20a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], libraryTop: ['Grizzly Bears', 'Hill Giant', 'Shock'] }, {}],
    scripts: bolt([
      { op: 'reveal-cards', what: { zone: 'library', who: 'you', top: 3 } },
      { op: 'separate-piles', from: 'those', piles: 2, separator: 'an-opponent' },
      { op: 'choose-pile', chooser: 'you' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'graveyard' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      // the reveal is the core `library` event (the same one `dig` and `explore` emit), which is what carries the
      // public-knowledge record; a bare log line would not have made the cards visible to anybody
      { events: { type: 'library', min: 1 } }, { log: 'P0 reveals Grizzly Bears, Hill Giant, Shock' },
      { zone: ['Grizzly Bears', 'hand'] }, { zone: ['Hill Giant', 'graveyard'] }, { zone: ['Shock', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    // the same fix on the other route into a pile: the pool a separator is handed is public knowledge, so the
    // `reveal` word announces a real reveal rather than writing a log line nothing else can see.
    name: 'separate-piles with reveal makes the pool public, not just a log line', cr: '701.20a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], libraryTop: ['Grizzly Bears', 'Hill Giant', 'Shock', 'Divination'] }, {}],
    scripts: bolt([
      { op: 'separate-piles', from: { zone: 'library', who: 'you', top: 4 }, piles: 2, separator: 'an-opponent', reveal: true },
      { op: 'choose-pile', chooser: 'you' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { events: { type: 'library', min: 1 } }, { log: 'P0 reveals Grizzly Bears, Hill Giant, Shock, Divination' },
      { zone: ['Grizzly Bears', 'hand'] }, { zone: ['Shock', 'library'] }, { unsimulated: 0 },
    ],
  },
  {
    // the printed card, parsed: "Reveal the top five cards of your library." now emits the built-in `look-top` (the
    // binding op the next sentence's "those" needs) AND `reveal-cards`, so the opponent who separates the piles has
    // seen the five cards. Two `library` events — the look and the reveal — where there used to be one.
    name: 'Fact or Fiction reveals the top five cards before an opponent separates them', cr: '701.20a',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Island'], hand: ['Fact or Fiction'], libraryTop: ['Grizzly Bears', 'Hill Giant', 'Shock', 'Divination', 'Mountain'] }, {}],
    script: [{ cast: 'Fact or Fiction' }, { resolve: true }],
    expect: [
      { log: 'P0 reveals Grizzly Bears, Hill Giant, Shock, Divination, Mountain' }, { events: { type: 'library', min: 2 } },
      { zone: ['Grizzly Bears', 'hand'] }, { zone: ['Hill Giant', 'hand'] }, { zone: ['Shock', 'graveyard'] },
      { unsimulated: 0 },
    ],
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

  {
    // review fix 2: CR 700.3a lets the separator choose the pile SIZES, not just the contents — Fact or Fiction is
    // the card it is because 5/0 and 4/1 are legal. The even split is only the FIRST option offered.
    name: 'separate-piles lets the separator choose the pile sizes, not just an even split', cr: '700.3a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], libraryTop: ['Grizzly Bears', 'Hill Giant', 'Shock', 'Divination'] }, {}],
    scripts: bolt([
      { op: 'separate-piles', from: { zone: 'library', who: 'you', top: 4 }, piles: 2, separator: 'you', reveal: true },
      { op: 'choose-pile', chooser: 'you' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'graveyard' } },
    ]),
    // a 4/0 split: unreachable while the sizes were fixed to floor(4 / 2) = 2
    script: [{ answer: '4 cards' }, { cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { log: 'pile 2 \\(empty\\)' },
      { zone: ['Grizzly Bears', 'hand'] }, { zone: ['Hill Giant', 'hand'] },
      { zone: ['Shock', 'hand'] }, { zone: ['Divination', 'hand'] }, { unsimulated: 0 },
    ],
  },
  {
    // review fix 3: the empty-pool early returns used to leave the PREVIOUS resolution's record in place, so a second
    // trigger / activation with nothing to separate re-applied the first one's split (CR 400.7 — and the Island has
    // been played since, so the stale `chosen-fate` dragged it off the battlefield).
    name: 'a second separate-piles with an empty pool forgets the first one, it does not re-apply it', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], graveyard: ['Island', 'Hill Giant'] }, {}],
    scripts: bears([
      { op: 'separate-piles', from: { zone: 'graveyard', who: 'you' }, piles: 2, separator: 'you' },
      { op: 'choose-pile', chooser: 'you' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'exile' } },
    ]),
    script: [
      { activate: 'Grizzly Bears' }, { resolve: true },   // Island -> hand, Hill Giant -> exile; the graveyard is now empty
      { playLand: 'Island' },
      { activate: 'Grizzly Bears' }, { resolve: true },   // nothing to separate: the record is dropped, not replayed
    ],
    expect: [{ zone: ['Island', 'battlefield'] }, { zone: ['Hill Giant', 'exile'] }, { unsimulated: 0 }],
  },
  {
    // review fix 4: 15 real cards (Bringer of the Last Gift, Gifts Ungiven, Epiphany at the Drownyard, ...) parse a
    // `chosen-fate` / `choose-pile` whose antecedent sentence is still `unknown`, because a parser rule sees one
    // sentence at a time. The claimed line must stay visible to the fidelity metric, not resolve as a silent no-op.
    name: 'chosen-fate with no earlier choice reports unsimulated text instead of doing nothing', cr: '608.2f',
    seats: [{ bf: ['Mountain', 'Grizzly Bears', 'Hill Giant'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([{ op: 'chosen-fate', other: { how: 'sacrifice' }, among: { types: ['Creature'] } }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Hill Giant', 'battlefield'] },
      { unsimulated: 1 }, { log: 'unsimulated text' },
    ],
  },
  {
    name: 'choose-pile with no earlier separate-piles reports unsimulated text', cr: '700.3',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([{ op: 'choose-pile', chooser: 'an-opponent' }, { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' } }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    // both sentences are inert without the pile-making one, and both say so
    expect: [{ unsimulated: 2 }, { log: 'chooses one of those piles' }],
  },
  {
    name: 'a separate-piles that finds nothing makes choose-pile and chosen-fate real no-ops, not unsimulated text', cr: '700.3',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([
      { op: 'separate-piles', from: { zone: 'graveyard', who: 'you' }, piles: 2, separator: 'you' },
      { op: 'choose-pile', chooser: 'you' },
      { op: 'chosen-fate', chosen: { how: 'move', to: 'hand' }, other: { how: 'move', to: 'exile' } },
    ]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ unsimulated: 0 }, { handCount: [0, 0] }],
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
