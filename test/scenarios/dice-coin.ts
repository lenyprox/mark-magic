// Dice and coins (Phase 9.1, docs/vocabulary/dice-coin.md): one scenario per op, per keyword parameter, per
// condition, per amount count and per trigger the family registers.
//
// HOW A RANDOM OP IS PINNED DETERMINISTICALLY. The scenario harness runs every game on seed 1, so a roll or a flip is
// reproducible — but a scenario that hard-codes "the d20 came up 13" is pinned to the whole engine's consumption of
// that stream, not to the op. Two devices keep these expectations exact and stream-independent instead:
//
//   * a **d1** — `{ sides: 1 }` — has one equally likely outcome (CR 706.1a with N = 1), so its natural result is
//     always 1 and every arithmetic around it (`count` + `keep`, `plus`, the amount counts) is checkable to the
//     number. That is the standard way to test a random system: remove the randomness, keep the code path.
//   * **both branches asserted at once** — a coin flip whose "you win" and "you lose" branches each gain 1 life
//     leaves the life total at exactly +1 however the coin fell, and fails if the flip, the branch or the condition
//     did nothing.
//
// Two scenarios (marked "seeded stream") do pin the actual roll of a d6: nothing else can tell "the highest of two
// rolls" from "the lowest" or "the other result" from "the result" when every die shows the same face.
import type { Effect, TriggeredAbility } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** `name` gains a free activated ability "<effects>" (its printed text stays). */
const freeAbility = (name: string, effects: Effect[], text = 'dice-coin'): Record<string, ScenarioScript> =>
  ({ [name]: { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });

/** `name` gains the listed triggered abilities (its printed text stays). */
const triggers = (name: string, abilities: TriggeredAbility[]): Record<string, ScenarioScript> => ({ [name]: { abilities } });

/** A triggered ability that puts one `counter` counter on itself. */
const marks = (event: TriggeredAbility['event'], counter: string, text: string): TriggeredAbility =>
  ({ kind: 'triggered', event, effects: [{ op: 'counters', target: 'self', counter, amount: 1 }], text });

export const diceCoin: Scenario[] = [
  // ------------------------------------------------------------------ roll-die, results table (real cards)
  {
    // Every striation of Herald of Hadar's table drains each opponent for exactly 2, so the assertion holds whichever
    // way the d20 fell — and fails if the roll never happened, because then no striation applies at all.
    name: 'Herald of Hadar rolls a d20 and the striation that matches the result is the one that applies', cr: '706.3a',
    ruling: 'The results table is part of the same ability as the roll; each striation reads "if the result was in this range, [effect]".',
    seats: [{ bf: ['Herald of Hadar', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'] }, { bf: ['Grizzly Bears'] }],
    script: [{ activate: 'Herald of Hadar' }, { resolve: true }],
    expect: [{ life: [1, 18] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    // Mana Crypt's upkeep trigger flips a coin every turn; the damage half is the "if you lose the flip" branch.
    name: "Mana Crypt flips a coin at the beginning of its controller's upkeep", cr: '705.2',
    ruling: 'The flipping player calls the coin; only that player wins or loses the flip.',
    seats: [{ bf: ['Mana Crypt'] }, {}],
    script: [{ turns: 2 }],
    expect: [{ events: { type: 'coin-flip', min: 1 } }, { log: 'flips a coin for Mana Crypt: (heads|tails)' }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ roll-die parameters (d1: exact by construction)
  {
    name: 'a results-table striation applies only when the result is inside its range', cr: '706.3a',
    ruling: 'A striation with a range that the result is outside of does nothing at all.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [
      { op: 'roll-die', sides: 1 },
      { op: 'conditional', condition: { kind: 'roll-result', least: 2 }, then: [{ op: 'gain-life', amount: 100, who: 'you' }] },
      { op: 'conditional', condition: { kind: 'roll-result', least: 1, most: 1 }, then: [{ op: 'gain-life', amount: 1, who: 'you' }] },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 21] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'rolling three dice with no instruction about them adds the results up', cr: '706.2',
    ruling: 'The result of the roll is the natural result plus every applicable modifier.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [{ op: 'roll-die', sides: 1, count: 3, keep: 'sum' }, { op: 'gain-life', amount: { count: 'roll-result' }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'ignoring all but the highest roll keeps one die, not their total', cr: '706.6',
    ruling: 'An ignored roll is considered never to have happened.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [{ op: 'roll-die', sides: 1, count: 3, keep: 'highest' }, { op: 'gain-life', amount: { count: 'roll-result' }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 21] }, { unsimulated: 0 }],
  },
  {
    name: 'ignoring all but the lowest roll keeps one die, not their total', cr: '706.6',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [{ op: 'roll-die', sides: 1, count: 3, keep: 'lowest' }, { op: 'gain-life', amount: { count: 'roll-result' }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 21] }, { unsimulated: 0 }],
  },
  {
    name: 'a modifier printed with the roll is added to the natural result', cr: '706.2',
    ruling: 'After considering all applicable modifiers, the final number is the result of the die roll.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [{ op: 'roll-die', sides: 1, plus: 3 }, { op: 'gain-life', amount: { count: 'roll-result' }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { unsimulated: 0 }],
  },
  {
    name: 'rolling two dice and choosing one result leaves the other result readable too', cr: '706.4',
    ruling: 'The text of an ability with no results table says how the results of its dice are used.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [
      { op: 'roll-die', sides: 1, count: 2, keep: 'choose-one' },
      { op: 'gain-life', amount: { count: 'roll-result' }, who: 'you' },
      { op: 'gain-life', amount: { count: 'roll-other-result' }, who: 'you' },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 22] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    // seeded stream: with every die showing the same face nothing can tell "choose one result" from "the other
    // result", so this one pins the real d6 pair the seeded rng produces.
    name: 'the chosen result is the higher of two d6 and the other result is the lower (seeded stream)', cr: '706.4',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [
      { op: 'roll-die', sides: 6, count: 2, keep: 'choose-one' },
      { op: 'counters', target: 'self', counter: 'chosen', amount: { count: 'roll-result' } },
      { op: 'counters', target: 'self', counter: 'other', amount: { count: 'roll-other-result' } },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    // seed 1 rolls 1 and 2: the chosen result is the 2 the default agent takes, the other result is the 1 left over.
    expect: [{ counters: ['Grizzly Bears', { chosen: 2, other: 1 }] }, { log: 'rolls 2 d6 .*: 1, 2 \\(result 2\\)' }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ flip-coin and the coin-flip condition
  {
    name: 'a coin flip is won or lost, and exactly one of the two branches applies', cr: '705.2',
    ruling: 'The player who flips the coin calls it; if the call matches the result that player wins the flip, otherwise they lose it.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [
      { op: 'flip-coin' },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'won' }, then: [{ op: 'gain-life', amount: 1, who: 'you' }] },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'lost' }, then: [{ op: 'gain-life', amount: 1, who: 'you' }] },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 21] }, { events: { type: 'coin-flip', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'a coin comes up heads or tails, which is the same event as winning or losing the flip', cr: '705.2',
    ruling: 'Some effects care only whether the coin came up heads or tails; no player wins or loses those flips.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [
      { op: 'flip-coin' },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'heads' }, then: [{ op: 'damage-you', amount: 2 }] },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'tails' }, then: [{ op: 'damage-you', amount: 2 }] },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 18] }, { events: { type: 'damage', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'flipping six coins flips six coins, and "win N or more flips" cannot be met by fewer', cr: '705.1',
    ruling: 'Each coin is flipped separately; a branch that asks for more wins than there were flips never applies.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [
      { op: 'flip-coin', count: 6 },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'won', least: 7 }, then: [{ op: 'gain-life', amount: 50, who: 'you' }] },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'lost', least: 7 }, then: [{ op: 'gain-life', amount: 50, who: 'you' }] },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'won', least: 1 }, then: [{ op: 'gain-life', amount: 1, who: 'you' }] },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'lost', least: 1 }, then: [{ op: 'gain-life', amount: 1, who: 'you' }] },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 22] }, { events: { type: 'coin-flip', min: 6, max: 6 } }, { unsimulated: 0 }],
  },
  {
    // seeded stream: only the number of wins tells "for each flip you won" from a constant, and the number of wins is
    // what the rng decides. The invariants (the streak ends on a loss, at least one coin was flipped) hold regardless.
    name: 'flipping until you lose a flip ends on a loss and leaves the wins countable (seeded stream)', cr: '705.2',
    ruling: '"Flip a coin until you lose a flip" keeps flipping while the flips are won; the ones won are what a later "for each flip you won" counts.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [{ op: 'flip-coin', until: 'lose' }, { op: 'gain-life', amount: { count: 'flips-won' }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    // seed 1 flips five wins and then a loss: six flips, and the five wins are the life gained.
    expect: [{ life: [0, 25] }, { events: { type: 'coin-flip', min: 6, max: 6 } }, { log: 'loses the flip' }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ triggers
  {
    name: 'Brazen Dwarf triggers when its controller rolls dice', cr: '706.1',
    ruling: '"Whenever you roll one or more dice" triggers once for the roll instruction, however many dice it named.',
    seats: [{ bf: ['Brazen Dwarf', 'Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [{ op: 'roll-die', sides: 1, count: 3 }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [1, 19] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'a dice-rolled trigger that watches every player fires on an opponent\'s roll and one that watches you does not', cr: '706.1',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      ...triggers('Grizzly Bears', [marks({ on: 'dice-rolled', who: 'any' }, 'luck', 'Whenever a player rolls one or more dice, put a luck counter on this creature.')]),
      ...triggers('Hill Giant', [marks({ on: 'dice-rolled', who: 'you' }, 'luck', 'Whenever you roll one or more dice, put a luck counter on this creature.')]),
      ...freeAbility('Runeclaw Bear', [{ op: 'roll-die', sides: 1 }]),
    },
    script: [{ activate: 'Runeclaw Bear', by: 1 }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { luck: 1 }] }, { counters: ['Hill Giant', { luck: 0 }] }, { unsimulated: 0 }],
  },
  {
    name: 'coin-flip triggers split every flip between the "wins" and the "loses" halves', cr: '705.2',
    ruling: 'Each flip is won or lost by the flipping player, so four flips fire the two halves four times between them.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      ...triggers('Grizzly Bears', [
        marks({ on: 'coin-flipped', who: 'you', outcome: 'won' }, 'luck', 'Whenever you win a coin flip, put a luck counter on this creature.'),
        marks({ on: 'coin-flipped', who: 'you', outcome: 'lost' }, 'luck', 'Whenever you lose a coin flip, put a luck counter on this creature.'),
      ]),
      ...freeAbility('Hill Giant', [{ op: 'flip-coin', count: 4 }]),
    },
    script: [{ activate: 'Hill Giant' }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { luck: 4 }] }, { events: { type: 'coin-flip', min: 4, max: 4 } }, { unsimulated: 0 }],
  },
  {
    name: 'a coin-flip trigger that watches every player fires on an opponent\'s flips and one that watches you does not', cr: '705.2',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      ...triggers('Grizzly Bears', [marks({ on: 'coin-flipped', who: 'any' }, 'luck', 'Whenever a player flips a coin, put a luck counter on this creature.')]),
      ...triggers('Hill Giant', [marks({ on: 'coin-flipped', who: 'you' }, 'luck', 'Whenever you flip a coin, put a luck counter on this creature.')]),
      ...freeAbility('Runeclaw Bear', [{ op: 'flip-coin', count: 3 }]),
    },
    script: [{ activate: 'Runeclaw Bear', by: 1 }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { luck: 3 }] }, { counters: ['Hill Giant', { luck: 0 }] }, { unsimulated: 0 }],
  },
  {
    name: 'Tavern Scoundrel makes two Treasures for the coin flip its own ability wins (seeded stream)', cr: '705.2',
    ruling: 'Only the player who flips the coin wins or loses that flip, and the "whenever you win" trigger is put on the stack after the ability that flipped resolves.',
    seats: [{ bf: ['Tavern Scoundrel', 'Mountain', 'Grizzly Bears'] }, {}],
    script: [{ activate: 'Tavern Scoundrel' }, { resolve: true }],
    // seed 1 wins the flip, so the trigger fires; the flip itself happens either way.
    expect: [{ events: { type: 'coin-flip', min: 1, max: 1 } }, { log: 'creates 2 .*Treasure tokens' }, { unsimulated: 0 }],
  },
  // ------------------------------------------------------------------ CR 705.2 first sentence: a flip with no winner
  {
    // The whole ability reads "comes up heads / tails" and never "wins / loses the flip", which is CR 705.2's own test
    // for a flip nobody calls. Both heads and tails gain 1, so the life total is exact however the coin fell.
    name: 'a flip whose ability reads only heads or tails is won by nobody', cr: '705.2',
    ruling: 'Some effects that instruct a player to flip a coin care only about whether the coin comes up heads or tails. No player wins or loses a coin flip for this kind of effect.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Runeclaw Bear'] }, {}],
    scripts: {
      ...triggers('Grizzly Bears', [marks({ on: 'coin-flipped', who: 'you', outcome: 'won' }, 'win', 'Whenever you win a coin flip, put a win counter on this creature.')]),
      ...triggers('Hill Giant', [marks({ on: 'coin-flipped', who: 'you' }, 'flip', 'Whenever you flip a coin, put a flip counter on this creature.')]),
      ...freeAbility('Runeclaw Bear', [
        { op: 'flip-coin' },
        { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'heads' }, then: [{ op: 'gain-life', amount: 1, who: 'you' }] },
        { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'tails' }, then: [{ op: 'gain-life', amount: 1, who: 'you' }] },
      ]),
    },
    script: [{ activate: 'Runeclaw Bear' }, { resolve: true }],
    // the coin still comes up (life +1, one flip event, one "whenever you flip a coin"), but nobody won it
    expect: [{ life: [0, 21] }, { counters: ['Grizzly Bears', { win: 0 }] }, { counters: ['Hill Giant', { flip: 1 }] }, { log: 'no winner' }, { unsimulated: 0 }],
  },
  {
    // seeded stream: only the rng decides how many of three coins come up heads, and `coins-heads` is the count that
    // must still be readable when nobody won them. Seed 1 opens with three heads.
    name: 'a script may say outright that nobody wins the flips, and "heads" is still counted (seeded stream)', cr: '705.2',
    ruling: 'No player wins or loses a coin flip that cares only whether it came up heads or tails, but the coins still came up.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: freeAbility('Grizzly Bears', [
      { op: 'flip-coin', count: 3, winner: false },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'won' }, then: [{ op: 'gain-life', amount: 50, who: 'you' }] },
      { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'lost' }, then: [{ op: 'gain-life', amount: 50, who: 'you' }] },
      { op: 'gain-life', amount: { count: 'flips-won' }, who: 'you' },
      { op: 'counters', target: 'self', counter: 'heads', amount: { count: 'coins-heads' } },
    ]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 20] }, { counters: ['Grizzly Bears', { heads: 3 }] }, { events: { type: 'coin-flip', min: 3, max: 3 } }, { unsimulated: 0 }],
  },
  {
    name: 'a script may say outright that the flips ARE called, whatever the rest of the ability reads', cr: '705.2',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      ...triggers('Grizzly Bears', [
        marks({ on: 'coin-flipped', who: 'you', outcome: 'won' }, 'called', 'Whenever you win a coin flip, put a called counter on this creature.'),
        marks({ on: 'coin-flipped', who: 'you', outcome: 'lost' }, 'called', 'Whenever you lose a coin flip, put a called counter on this creature.'),
      ]),
      ...freeAbility('Hill Giant', [
        { op: 'flip-coin', count: 4, winner: true },
        { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'heads' }, then: [{ op: 'gain-life', amount: 0, who: 'you' }] },
      ]),
    },
    script: [{ activate: 'Hill Giant' }, { resolve: true }],
    // every one of the four flips was won or lost, so the two halves fire four times between them
    expect: [{ counters: ['Grizzly Bears', { called: 4 }] }, { noLog: 'no winner' }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ CR 706.1: "a die" is per die, "dice" per roll
  {
    name: '"whenever you roll a die" fires once per die and "one or more dice" once per roll', cr: '706.1',
    ruling: 'If you roll more than one die at a time, however, that does count as multiple die rolls.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Runeclaw Bear'] }, {}],
    scripts: {
      ...triggers('Grizzly Bears', [marks({ on: 'die-rolled', who: 'you' }, 'luck', 'Whenever you roll a die, put a luck counter on this creature.')]),
      ...triggers('Hill Giant', [marks({ on: 'dice-rolled', who: 'you' }, 'luck', 'Whenever you roll one or more dice, put a luck counter on this creature.')]),
      ...freeAbility('Runeclaw Bear', [{ op: 'roll-die', sides: 1, count: 3 }]),
    },
    script: [{ activate: 'Runeclaw Bear' }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { luck: 3 }] }, { counters: ['Hill Giant', { luck: 1 }] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'a per-die trigger that watches every player fires on an opponent\u2019s dice and one that watches you does not', cr: '706.1',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      ...triggers('Grizzly Bears', [marks({ on: 'die-rolled', who: 'any' }, 'luck', 'Whenever a player rolls a die, put a luck counter on this creature.')]),
      ...triggers('Hill Giant', [marks({ on: 'die-rolled', who: 'you' }, 'luck', 'Whenever you roll a die, put a luck counter on this creature.')]),
      ...freeAbility('Runeclaw Bear', [{ op: 'roll-die', sides: 1, count: 2 }]),
    },
    script: [{ activate: 'Runeclaw Bear', by: 1 }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { luck: 2 }] }, { counters: ['Hill Giant', { luck: 0 }] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ the record belongs to ONE resolving ability
  {
    // The roll is information the ability that rolled uses. A *second* ability of the same permanent, resolving later
    // in the same turn, rolled nothing — before this was pinned it read the first ability's result and gained 7 life.
    name: 'a second ability of the same permanent cannot read the first ability\u2019s roll', cr: '706.2',
    ruling: 'The result of a die roll is used by the ability that rolled it; an ability that never rolled has no result to read.',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: {
      'Grizzly Bears': {
        abilities: [
          { kind: 'activated', cost: {}, effects: [{ op: 'roll-die', sides: 1 }], text: 'dice-coin: roll' },
          { kind: 'activated', cost: {}, effects: [{ op: 'conditional', condition: { kind: 'roll-result', least: 1 }, then: [{ op: 'gain-life', amount: 7, who: 'you' }] }], text: 'dice-coin: read' },
        ],
      },
    },
    script: [{ activate: 'Grizzly Bears', ability: 0 }, { resolve: true }, { activate: 'Grizzly Bears', ability: 1 }, { resolve: true }],
    expect: [{ life: [0, 20] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ a branch may not read a sibling branch's target
  {
    // "Flip a coin. If you win the flip, target Orc creature gets +2/+0 until end of turn. If you lose the flip, it
    // gets -0/-2 until end of turn." — "it" is the TARGET, chosen on activation whichever way the coin falls (CR
    // 115.1), but the pronoun parses to the binding-frame Ref `that` and only the winning branch fills that frame.
    // The losing half is therefore recorded UNSIMULATED rather than claimed and silently dropped: the flip happens,
    // the winning branch still works, and the ability reports the one line the engine cannot run.
    name: "Orcish Captain's losing branch is reported unsimulated, not silently dropped", cr: '115.1',
    ruling: 'Targets are chosen as the ability is activated; a branch that did not resolve bound nothing for a later "it" to mean.',
    seats: [{ bf: ['Orcish Captain', 'Mountain'] }, {}],
    script: [{ activate: 'Orcish Captain', targets: [['Orcish Captain']] }, { resolve: true }],
    expect: [{ events: { type: 'coin-flip', min: 1, max: 1 } }, { unsimulated: 1 }],
  },

  // ------------------------------------------------------------------ a results-table striation actually applies
  {
    // Every striation of Nothic's table draws at least one card, so a draw is the proof that the row ran at all.
    // Before the row rule flattened (or refused) a nested `choose-mode`, all three rows were containers nothing ever
    // expanded — the whole ability did nothing while the card was claimed fully parsed.
    name: 'Nothic\u2019s results table draws a card whichever striation the d20 lands in', cr: '706.3a',
    ruling: 'A results table is part of the ability that rolled; the striation whose range contains the result is the one that applies.',
    seats: [{ bf: ['Nothic'] }, { bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Nothic']], by: 1 }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Nothic', 'graveyard'] }, { events: { type: 'die-roll', min: 1, max: 1 } }, { events: { type: 'draw', min: 1 } }, { unsimulated: 0 }],
  },
];
