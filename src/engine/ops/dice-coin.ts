// Dice and coins (Phase 9.1; docs/vocabulary/dice-coin.md).
//
// Two random events on `g.rng` — flipping a coin (CR 705) and rolling a die (CR 706) — plus the vocabulary the rest
// of a card's text needs to talk about what came up: the "if you win the flip" / "1—9 |" branches, "the result",
// "the other result", "for each flip you won", and the "whenever you roll one or more dice" / "whenever you win a
// coin flip" triggers.
//
// The design principle is that this family owns *only* the randomness. Everything that happens because of it is
// composed out of the core and the composition vocabulary:
//
//   Flip a coin. If you win the flip, X.  ->  [{ op: 'flip-coin' }, { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'won' }, then: [X] }]
//   Roll a d20. 1—9 | X   10—19 | Y       ->  [{ op: 'roll-die', sides: 20 }, { op: 'conditional', condition: { kind: 'roll-result', least: 1, most: 9 }, then: [X] }, { op: 'conditional', condition: { kind: 'roll-result', least: 10, most: 19 }, then: [Y] }]
//   … equal to the result                 ->  { count: 'roll-result' }
//
// so a coin branch and a results-table striation are both an ordinary `conditional` — one effect list of the same
// ability, which is exactly what CR 706.3b says a roll, its printed modifiers, the instructions based on the result
// and its table are. That is not only less vocabulary: `conditional` is a container the core already descends when it
// works out which effects target (src/engine/legal.ts `sharedLists`), so a branch may target and its picks are keyed
// apart (CR 115.1) — which a list nested inside a family op could not be.
//
// WHAT THE RANDOMNESS IS. `g.rng` is the game's seeded mulberry32 stream — the same one that shuffles libraries — so
// a game replays identically from its seed and an AI rollout of a coin-flip card is as reproducible as any other.
// CR 705.2 lets the flipping player call heads or tails; on a fair coin the call is immaterial, so this family always
// calls heads: "wins the flip" and "comes up heads" are the same event here, which is what every printed card that
// uses both wordings assumes.
//
// WHERE THE RESULT LIVES. One JSON-plain record on the game's `ext` bag, `s.ext.diceCoin`, rewritten by each roll or
// flip and read by the conditions and the amount counts. It carries the id of the source that produced it, so a
// condition on one permanent can never read another card's roll, and a step hook drops it at end of turn. Nothing in
// it is hidden information (CR 705.1 flips and CR 706.1 rolls happen in the open), so there is no redaction hook.
import type { Amount, Effect, FamilyModule, GameObject, GameState, PlayerId } from './types.js';
import { extDel, extGet, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/**
 * "Roll a d20", "Roll two d4 and choose one result", "Roll a d20 and add the number of cards in your hand".
 *   sides  the N of "dN" (CR 706.1a: N equally likely outcomes, 1..N)
 *   count  how many dice (default 1); `keep` says what the *result* of several dice is
 *   plus   a modifier added to the natural result (CR 706.2)
 * A results table (CR 706.3a) is not a field here: each striation is a `conditional` on `{ kind: 'roll-result' }`
 * later in the same effect list — see the header and docs/vocabulary/dice-coin.md.
 */
export interface RollDieEffect { op: 'roll-die'; sides: number; count?: Amount; keep?: 'sum' | 'choose-one' | 'highest' | 'lowest'; plus?: Amount }

/** "Flip a coin", "Flip five coins", "flip a coin until you lose a flip" (CR 705.1-705.2). */
export interface FlipCoinEffect { op: 'flip-coin'; count?: Amount; until?: 'lose' }

/** "If you win the flip", "if it comes up tails", "If you win two or more flips" (`least`). */
export interface CoinFlipCondition { kind: 'coin-flip'; outcome: 'won' | 'lost' | 'heads' | 'tails'; least?: number }
/** "if the result is 15 or more" — the bounds a results table spells as a striation, for the cards that print prose. */
export interface RollResultCondition { kind: 'roll-result'; least?: number; most?: number }

/** "Whenever you roll one or more dice" / "Whenever a player rolls one or more dice" — once per roll instruction. */
export interface DiceRolledTrigger { on: 'dice-rolled'; who: 'you' | 'any' }
/** "Whenever you win a coin flip" / "Whenever a player wins a coin flip" / "Whenever you lose a coin flip"; no `outcome` = any flip. */
export interface CoinFlippedTrigger { on: 'coin-flipped'; who: 'you' | 'any'; outcome?: 'won' | 'lost' }

/** One roll instruction: every die that was rolled and the result the ability goes on to use. */
export interface DieRollEvent { type: 'die-roll'; player: PlayerId; source: string; sides: number; naturals: number[]; result: number }
/** One coin flip. `won` is CR 705.2's winner; a "comes up heads" card reads the same field. */
export interface CoinFlipEvent { type: 'coin-flip'; player: PlayerId; source: string; outcome: 'heads' | 'tails'; won: boolean }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { diceRoll: RollDieEffect; diceFlip: FlipCoinEffect }
  interface ConditionRegistry { diceCoinFlip: CoinFlipCondition; diceRollResult: RollResultCondition }
  interface TriggerRegistry { diceRolled: DiceRolledTrigger; diceCoinFlipped: CoinFlippedTrigger }
  interface AmountCountRegistry { 'roll-result': true; 'roll-other-result': true; 'flips-won': true }
}
declare module '../events.js' {
  interface EventRegistry { diceDieRoll: DieRollEvent; diceCoinFlip: CoinFlipEvent }
}

// ------------------------------------------------------------------ 3. the record on s.ext

/**
 * What the last roll or flip of the resolving ability produced. JSON-plain (clone.ts deep-copies it, serialize.ts
 * round-trips it). `srcId` is the object that rolled: a condition or an amount evaluated for a *different* source is
 * about a roll it never made and reads as nothing, rather than as somebody else's dice.
 */
type DiceRecord = {
  kind: 'roll' | 'coin';
  srcId: number;
  /** A roll's final result (CR 706.2), or the number of flips won. */ result: number;
  /** "the other result" of a "roll two and choose one" (0 when there is none). */ other: number;
  /** Coins: how many came up each way. */ heads: number; tails: number;
  /** Every natural die result of the instruction, in rolling order (CR 706.2). */ naturals: number[];
};
const KEY = 'diceCoin';

/** The record, when it belongs to `src` (or when the caller has no source to check it against). */
function recordFor(s: GameState, src: GameObject | undefined, kind: 'roll' | 'coin'): DiceRecord | undefined {
  const r = extGet<DiceRecord>(s, KEY);
  if (!r || r.kind !== kind) return undefined;
  return src === undefined || r.srcId === src.id ? r : undefined;
}

/** Dice and flips are bounded so a runaway `count` (or a long "until you lose" streak) can never hang a rollout. */
const MAX_DICE = 64;
const MAX_FLIPS = 64;

// ------------------------------------------------------------------ 4. the module

const DICE_COIN: FamilyModule = {
  name: 'dice-coin',

  effects: {
    /** CR 706: roll `count` dice of `sides` faces, apply the modifiers and record the result the rest of the ability reads. */
    'roll-die': async (e: RollDieEffect, c) => {
      const sides = Math.max(1, Math.floor(e.sides));
      const n = Math.min(MAX_DICE, Math.max(0, e.count === undefined ? 1 : c.amt(e.count)));
      // "Roll a die for each …" with nothing to count rolls nothing: the record is dropped rather than left behind, so
      // every striation of this ability reads "no roll happened" instead of an earlier roll's result.
      if (n === 0) { extDel(c.s, KEY); return; }
      const naturals: number[] = [];
      for (let i = 0; i < n; i++) naturals.push(c.g.rng.int(sides) + 1);
      // CR 706.2: the natural result(s) first, then the modifiers. With several dice the ability says what to do with
      // them — add them up, keep the highest / lowest (CR 706.6: an ignored roll never happened), or let the roller
      // choose one, which is the "roll two dN and choose one result" shape.
      const keep = e.keep ?? 'sum';
      let kept = 0; let other = 0;
      if (naturals.length === 1) kept = naturals[0];
      else if (keep === 'sum') { for (const v of naturals) kept += v; }
      else if (keep === 'highest') { kept = Math.max(...naturals); other = Math.min(...naturals); }
      else if (keep === 'lowest') { kept = Math.min(...naturals); other = Math.max(...naturals); }
      else {
        const options = [...naturals].sort((a, b) => b - a).map(v => String(v));
        const pick = await c.g.ask(c.p, { kind: 'choose-option', options, reason: `${c.item.name}: choose one result` });
        kept = typeof pick === 'string' && options.includes(pick) ? Number(pick) : Number(options[0]);
        const rest = [...naturals]; rest.splice(rest.indexOf(kept), 1);
        other = rest.length ? Math.max(...rest) : 0;
      }
      const result = kept + (e.plus === undefined ? 0 : c.amt(e.plus));
      extSet<DiceRecord>(c.s, KEY, { kind: 'roll', srcId: c.src.id, result, other, heads: 0, tails: 0, naturals });
      c.item.lastAmount = result;                                          // "… equal to that result" reads it as "that many"
      c.g.emit({ type: 'die-roll', player: c.p, source: chars.name(c.src), sides, naturals, result });
      c.g.queueTriggers('dice-rolled', { obj: c.src, player: c.p, amount: result });
    },

    /** CR 705: flip `count` coins (or flip until one is lost) and record how they came up. */
    'flip-coin': async (e: FlipCoinEffect, c) => {
      const want = Math.min(MAX_DICE, Math.max(0, e.count === undefined ? 1 : c.amt(e.count)));
      const flips = e.until === 'lose' ? MAX_FLIPS : want;
      let heads = 0; let tails = 0;
      for (let i = 0; i < flips; i++) {
        // CR 705.2: the flipping player calls heads or tails; on a fair coin the call is immaterial, so this family
        // always calls heads and "wins the flip" is exactly "comes up heads".
        const won = c.g.rng.next() < 0.5;
        if (won) heads++; else tails++;
        c.g.emit({ type: 'coin-flip', player: c.p, source: chars.name(c.src), outcome: won ? 'heads' : 'tails', won });
        c.g.queueTriggers('coin-flipped', { obj: c.src, player: c.p, amount: won ? 1 : 0 });
        if (e.until === 'lose' && !won) break;
      }
      extSet<DiceRecord>(c.s, KEY, { kind: 'coin', srcId: c.src.id, result: heads, other: 0, heads, tails, naturals: [] });
      c.item.lastAmount = heads;                                           // "draw two cards for each flip" reads it as "that many"
    },
  },

  conditions: {
    /** "If you win the flip" / "if it comes up tails" / "If you win one or more flips" (CR 705.2). */
    'coin-flip': (cond: CoinFlipCondition, s, src) => {
      const r = recordFor(s, src, 'coin');
      if (!r) return false;
      const n = cond.outcome === 'won' || cond.outcome === 'heads' ? r.heads : r.tails;
      return n >= (cond.least ?? 1);
    },
    /** "if the result is N or more / N or less" (CR 706.2: the result is what the modifiers left). */
    'roll-result': (cond: RollResultCondition, s, src) => {
      const r = recordFor(s, src, 'roll');
      if (!r) return false;
      return (cond.least === undefined || r.result >= cond.least) && (cond.most === undefined || r.result <= cond.most);
    },
  },

  amounts: {
    /** "where X is the result" / "equal to the result" (CR 706.2). */
    'roll-result': (_a, s, _ctrl, _x, src) => recordFor(s, src, 'roll')?.result ?? 0,
    /** "the other result" of a "roll two dice and choose one result". */
    'roll-other-result': (_a, s, _ctrl, _x, src) => recordFor(s, src, 'roll')?.other ?? 0,
    /** "for each flip you won" / "the number of coins that came up heads" (CR 705.2). */
    'flips-won': (_a, s, _ctrl, _x, src) => recordFor(s, src, 'coin')?.heads ?? 0,
  },

  triggers: {
    /** "Whenever you roll one or more dice": once per roll instruction, however many dice it rolled (CR 706.1). */
    'dice-rolled': (ev: DiceRolledTrigger, perm, ctx, _s, event) =>
      event === 'dice-rolled' && (ev.who === 'any' || ctx.player === perm.controller),
    /** "Whenever you win a coin flip" (CR 705.2): `ctx.amount` is 1 for a flip that was won and 0 for one that was lost. */
    'coin-flipped': (ev: CoinFlippedTrigger, perm, ctx, _s, event) =>
      event === 'coin-flipped' && (ev.who === 'any' || ctx.player === perm.controller)
      && (ev.outcome === undefined || (ev.outcome === 'won') === (ctx.amount === 1)),
  },

  events: {
    'die-roll': {
      logged: true, cr: '706.1',
      render: (ev, pname) => {
        const e = ev as DieRollEvent;
        const dice = e.naturals.length === 1 ? `a d${e.sides}` : `${e.naturals.length} d${e.sides}`;
        const total = e.naturals.length === 1 && e.result === e.naturals[0] ? '' : ` (result ${e.result})`;
        return `${pname(e.player)} rolls ${dice} for ${e.source}: ${e.naturals.join(', ')}${total}.`;
      },
    },
    'coin-flip': {
      logged: true, cr: '705.2',
      render: (ev, pname) => {
        const e = ev as CoinFlipEvent;
        return `${pname(e.player)} flips a coin for ${e.source}: ${e.outcome} (${e.won ? 'wins' : 'loses'} the flip).`;
      },
    },
  },

  // The record is scoped to one resolving ability; nothing should read it a turn later, so it goes with the turn.
  steps: { 'cleanup-end': (g) => extDel(g.state, KEY) },

  // Round-trip English (src/cards/render.ts). The results-table striations render themselves: they are `conditional`s
  // the core renderer already prints.
  render: {
    'roll-die': (e: RollDieEffect) => {
      const n = e.count === undefined ? 1 : e.count;
      const dice = typeof n === 'number' && n === 1 ? `a d${e.sides}` : `${amountWord(n)} d${e.sides}`;
      const how = e.keep === 'choose-one' ? ' and choose one result' : e.keep === 'highest' ? ' and ignore all but the highest roll' : e.keep === 'lowest' ? ' and ignore all but the lowest roll' : '';
      const plus = e.plus === undefined ? '' : ` and add ${amountWord(e.plus)}`;
      return `Roll ${dice}${how}${plus}`;
    },
    'flip-coin': (e: FlipCoinEffect) => {
      if (e.until === 'lose') return 'Flip a coin until you lose a flip';
      const n = e.count === undefined ? 1 : e.count;
      return typeof n === 'number' && n === 1 ? 'Flip a coin' : `Flip ${amountWord(n)} coins`;
    },
  },
};

/** The little of an `Amount` a family renderer can print on its own (src/cards/render.ts is tooling-only and cannot be imported here). */
function amountWord(a: Amount): string {
  if (typeof a === 'number') return String(a);
  if (a === 'X') return 'X';
  const count = (a as { count?: string }).count;
  return count === 'cards-in-hand' ? 'the number of cards in your hand'
    : count === 'roll-result' ? 'the result'
    : count === 'flips-won' ? 'the number of flips you won'
    : count === 'that-many' ? 'that many'
    : 'X';
}

export default DICE_COIN;
