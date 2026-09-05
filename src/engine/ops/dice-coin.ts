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
// CR 705.2 lets the flipping player call heads or tails; on a fair coin the call is immaterial, so a *called* flip
// always calls heads and "wins the flip" is then exactly "comes up heads".
//
// NOT EVERY FLIP HAS A WINNER. CR 705.2 first sentence: "Some effects that instruct a player to flip a coin care only
// about whether the coin comes up heads or tails. No player wins or loses a coin flip for this kind of effect." Such a
// flip must not fire "whenever you win a coin flip" (Tavern Scoundrel, Chance Encounter, Zndrsplt) and must read false
// for `{ kind: 'coin-flip', outcome: 'won' }`, while "whenever you flip a coin" still fires and `outcome: 'heads'`
// still reads. `flip-coin` therefore carries a `winner` flag. A script states it outright; when it is absent the op
// infers it from the resolving ability's own effect list, which is the CR test verbatim — an ability that reads only
// "comes up heads / tails" (`outcome: 'heads' | 'tails'`, `{ count: 'coins-heads' }`) and never "wins / loses the
// flip" (`outcome: 'won' | 'lost'`, `{ count: 'flips-won' }`) is exactly "an effect that cares only whether the coin
// comes up heads or tails". An ability that says neither (Tavern Scoundrel's own "Flip a coin.") is a called flip,
// which is CR 705.2's default. See docs/vocabulary/dice-coin.md for what the PARSER can and cannot see.
//
// WHERE THE RESULT LIVES. One JSON-plain record on the game's `ext` bag, `s.ext.diceCoin`, rewritten by each roll or
// flip and read by the conditions and the amount counts. It carries the id of the source that produced it, so a
// condition on one permanent can never read another card's roll, and the record is dropped as soon as the ability
// that made it has finished resolving (the `sba` hook below — `checkSBA` is never called part-way through an item, so
// that boundary is exactly "one resolving ability"). Nothing in it is hidden information (CR 705.1 flips and CR 706.1
// rolls happen in the open), so there is no redaction hook.
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

/**
 * "Flip a coin", "Flip five coins", "flip a coin until you lose a flip" (CR 705.1-705.2).
 *   winner  does a player win or lose these flips? Omitted = inferred from the resolving ability (see the header):
 *           `false` is CR 705.2's first sentence — the flip comes up heads or tails and nobody wins it.
 */
export interface FlipCoinEffect { op: 'flip-coin'; count?: Amount; until?: 'lose'; winner?: boolean }

/** "If you win the flip", "if it comes up tails", "If you win two or more flips" (`least`). */
export interface CoinFlipCondition { kind: 'coin-flip'; outcome: 'won' | 'lost' | 'heads' | 'tails'; least?: number }
/** "if the result is 15 or more" — the bounds a results table spells as a striation, for the cards that print prose. */
export interface RollResultCondition { kind: 'roll-result'; least?: number; most?: number }

/** "Whenever you roll one or more dice" / "Whenever a player rolls one or more dice" — once per roll instruction. */
export interface DiceRolledTrigger { on: 'dice-rolled'; who: 'you' | 'any' }
/**
 * "Whenever you roll a die" — once per DIE, not per instruction (CR 706.1). The printed ruling on The Space Family
 * Goblinson says it outright: "If you roll more than one die at a time, however, that does count as multiple die
 * rolls." Hammer Jammer and As Luck Would Have It carry the same wording.
 */
export interface DieRolledTrigger { on: 'die-rolled'; who: 'you' | 'any' }
/** "Whenever you win a coin flip" / "Whenever a player wins a coin flip" / "Whenever you lose a coin flip"; no `outcome` = any flip. */
export interface CoinFlippedTrigger { on: 'coin-flipped'; who: 'you' | 'any'; outcome?: 'won' | 'lost' }

/** One roll instruction: every die that was rolled and the result the ability goes on to use. */
export interface DieRollEvent { type: 'die-roll'; player: PlayerId; source: string; sides: number; naturals: number[]; result: number }
/** One coin flip. `winner` is CR 705.2's "did anybody call it?"; `won` is that player's result (false when nobody did). */
export interface CoinFlipEvent { type: 'coin-flip'; player: PlayerId; source: string; outcome: 'heads' | 'tails'; won: boolean; winner: boolean }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { diceRoll: RollDieEffect; diceFlip: FlipCoinEffect }
  interface ConditionRegistry { diceCoinFlip: CoinFlipCondition; diceRollResult: RollResultCondition }
  interface TriggerRegistry { diceRolled: DiceRolledTrigger; diceDieRolled: DieRolledTrigger; diceCoinFlipped: CoinFlippedTrigger }
  interface AmountCountRegistry { 'roll-result': true; 'roll-other-result': true; 'flips-won': true; 'coins-heads': true }
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
  /** A roll's final result (CR 706.2), or the number of coins that came up heads. */ result: number;
  /** "the other result" of a "roll two and choose one" (0 when there is none). */ other: number;
  /** Coins: how many came up each way. */ heads: number; tails: number;
  /** Coins: did a player call these flips (CR 705.2)? `false` = nobody won or lost them. */ winner: boolean;
  /** Every natural die result of the instruction, in rolling order (CR 706.2). */ naturals: number[];
};
const KEY = 'diceCoin';

/**
 * CR 705.2 first sentence, applied to the ability that is flipping: does anybody win these coins? The effect that
 * instructs the flip IS this ability, so its own effect list is the whole test — "cares only about whether the coin
 * comes up heads or tails" is "reads `heads` / `tails` and never `won` / `lost`". An ability that reads neither
 * (Tavern Scoundrel's bare "Flip a coin.") keeps CR 705.2's default: the player calls it and wins or loses it.
 */
function abilityCallsTheFlip(effs: readonly Effect[]): boolean {
  let winLose = false; let headsTails = false;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (o.kind === 'coin-flip') { if (o.outcome === 'won' || o.outcome === 'lost') winLose = true; else headsTails = true; }
    if (o.count === 'flips-won') winLose = true;
    if (o.count === 'coins-heads') headsTails = true;
    for (const k of Object.keys(o)) if (k !== 'text' && k !== 'prompt') walk(o[k]);
  };
  walk(effs as unknown);
  return winLose || !headsTails;
}

/** `ctx.amount` of a `coin-flipped` event: 1 = the flip was won, 0 = it was lost, -1 = nobody won it (CR 705.2). */
const WON = 1; const LOST = 0; const NO_WINNER = -1;

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
      extSet<DiceRecord>(c.s, KEY, { kind: 'roll', srcId: c.src.id, result, other, heads: 0, tails: 0, winner: false, naturals });
      c.item.lastAmount = result;                                          // "… equal to that result" reads it as "that many"
      c.g.emit({ type: 'die-roll', player: c.p, source: chars.name(c.src), sides, naturals, result });
      // Two events, because the two printed wordings count differently (CR 706.1): "whenever you roll ONE OR MORE
      // dice" is once for the instruction however many dice it named, while "whenever you roll A DIE" is once per die
      // ("If you roll more than one die at a time, however, that does count as multiple die rolls" — The Space Family
      // Goblinson). `amount` is that die's natural result for the per-die event and the instruction's result for the
      // other one; an ignored die (CR 706.6) was still rolled, so every natural counts here.
      for (const n of naturals) c.g.queueTriggers('die-rolled', { obj: c.src, player: c.p, amount: n });
      c.g.queueTriggers('dice-rolled', { obj: c.src, player: c.p, amount: result });
    },

    /** CR 705: flip `count` coins (or flip until one is lost) and record how they came up. */
    'flip-coin': async (e: FlipCoinEffect, c) => {
      const want = Math.min(MAX_DICE, Math.max(0, e.count === undefined ? 1 : c.amt(e.count)));
      const flips = e.until === 'lose' ? MAX_FLIPS : want;
      // CR 705.2: is this a *called* flip? "until you lose a flip" says so in the instruction itself; otherwise the
      // script's own `winner` decides, and with nothing written the ability's text decides (see the header).
      const winner = e.until === 'lose' ? true : e.winner ?? abilityCallsTheFlip(c.item.effects);
      let heads = 0; let tails = 0;
      for (let i = 0; i < flips; i++) {
        // On a fair coin the call is immaterial, so a called flip always calls heads and "wins the flip" is exactly
        // "comes up heads". A flip nobody called still comes up heads or tails — it is just never won or lost.
        const up = c.g.rng.next() < 0.5;
        if (up) heads++; else tails++;
        c.g.emit({ type: 'coin-flip', player: c.p, source: chars.name(c.src), outcome: up ? 'heads' : 'tails', won: winner && up, winner });
        c.g.queueTriggers('coin-flipped', { obj: c.src, player: c.p, amount: !winner ? NO_WINNER : up ? WON : LOST });
        if (e.until === 'lose' && !up) break;
      }
      extSet<DiceRecord>(c.s, KEY, { kind: 'coin', srcId: c.src.id, result: heads, other: 0, heads, tails, winner, naturals: [] });
      c.item.lastAmount = heads;                                           // "draw two cards for each flip" reads it as "that many"
    },
  },

  conditions: {
    /** "If you win the flip" / "if it comes up tails" / "If you win one or more flips" (CR 705.2). */
    'coin-flip': (cond: CoinFlipCondition, s, src) => {
      const r = recordFor(s, src, 'coin');
      if (!r) return false;
      const won = cond.outcome === 'won' || cond.outcome === 'lost';
      if (won && !r.winner) return false;                 // CR 705.2: nobody won or lost a heads/tails-only flip
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
    /** "for each flip you won" (CR 705.2): zero when nobody won these flips. */
    'flips-won': (_a, s, _ctrl, _x, src) => { const r = recordFor(s, src, 'coin'); return r && r.winner ? r.heads : 0; },
    /** "the number of coins that came up heads" — the count CR 705.2's first sentence cares about, winner or not. */
    'coins-heads': (_a, s, _ctrl, _x, src) => recordFor(s, src, 'coin')?.heads ?? 0,
  },

  triggers: {
    /** "Whenever you roll one or more dice": once per roll instruction, however many dice it rolled (CR 706.1). */
    'dice-rolled': (ev: DiceRolledTrigger, perm, ctx, _s, event) =>
      event === 'dice-rolled' && (ev.who === 'any' || ctx.player === perm.controller),
    /** "Whenever you roll a die": once per die of the instruction (CR 706.1; The Space Family Goblinson's ruling). */
    'die-rolled': (ev: DieRolledTrigger, perm, ctx, _s, event) =>
      event === 'die-rolled' && (ev.who === 'any' || ctx.player === perm.controller),
    /**
     * "Whenever you win a coin flip" (CR 705.2). `ctx.amount` is WON / LOST / NO_WINNER; a trigger with no `outcome`
     * ("whenever you flip a coin") fires for every flip, and one that asks for a winner fires for none of a flip
     * nobody called — CR 705.2 first sentence, which is why NO_WINNER must not read as "lost".
     */
    'coin-flipped': (ev: CoinFlippedTrigger, perm, ctx, _s, event) =>
      event === 'coin-flipped' && (ev.who === 'any' || ctx.player === perm.controller)
      && (ev.outcome === undefined || ctx.amount === (ev.outcome === 'won' ? WON : LOST)),
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
        // CR 705.2: a flip nobody called is reported as what it is — a coin that came up heads or tails and no more.
        const call = e.winner === false ? 'no winner' : e.won ? 'wins the flip' : 'loses the flip';
        return `${pname(e.player)} flips a coin for ${e.source}: ${e.outcome} (${call}).`;
      },
    },
  },

  /**
   * The record is scoped to ONE RESOLVING ABILITY, and this is what makes that true rather than aspirational: an item
   * finishes resolving and `resolveTop` runs `checkSBA` (src/engine/game.ts), which is the only place SBAs are ever
   * checked — never part-way through an item — so dropping the record here means the next ability starts with none.
   * Without it the record was scoped to (source, turn) and a *second* ability of the same permanent read the first
   * one's roll. Returns false: nothing about the game changed, so the SBA loop must not run again for it.
   */
  sba: (g) => { extDel(g.state, KEY); return false; },
  // Belt and braces for anything that could roll outside a stack item (an as-enters roll): the record never outlives
  // the turn either.
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
    : count === 'roll-other-result' ? 'the other result'
    : count === 'flips-won' ? 'the number of flips you won'
    : count === 'coins-heads' ? 'the number of coins that came up heads'
    : count === 'that-many' ? 'that many'
    : 'X';
}

export default DICE_COIN;
