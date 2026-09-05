// Parser rules for the dice-coin family (Phase 9.1; docs/vocabulary/dice-coin.md).
//
// The wordings that produce `roll-die` / `flip-coin` and the vocabulary that reads what came up:
//
//   sentence   "Roll a d20"  "Roll two d4 and choose one result"  "Roll two six-sided dice"
//              "Roll a d20 and add the number of cards in your hand"  "Roll two d20 and ignore the lower roll"
//              "Flip a coin"  "Flip five coins"  "Flip a coin until you lose a flip"
//   condition  "you win the flip"  "you lose the flip"  "it comes up heads"  "you win two or more flips"
//              "the result is 15 or more"                          (the built-in "If <condition>, <effects>" split
//                                                                   then makes the branch a core `conditional`)
//   trigger    "Whenever you roll one or more dice"  "Whenever you win a coin flip"  "Whenever a player flips a coin"
//   line       "1—9 | <effects>"  "20 | <effects>"  "15+ | <effects>" — a results-table striation (CR 706.3a),
//              appended to the ability the previous line built as one more `conditional` on the roll result
//
// Two disciplines, as in src/cards/rules/composition.ts:
//
//   * a rule never claims what it cannot express. Every sub-parse is checked for `unknown` before the rule returns,
//     and an amount phrase with no engine form makes the whole rule decline.
//   * a results-table striation is claimed only as a whole LINE. On an instant or sorcery the parser hands the
//     registry one *sentence* at a time (the spell-text branch runs above the line hooks), so a two-sentence
//     striation would arrive cut in half and its tail would run unconditionally — a silently wrong parse. Spells
//     therefore keep their table lines unparsed; see docs/vocabulary/dice-coin.md, "What is not parsed".
//
// Nothing here imports parse.ts at runtime: the shared sub-parsers arrive on the EffectCtx / LineCtx the parser hands
// each rule.
import type { Amount, Condition, Effect, TriggerEvent } from '../types.js';
import type { ConditionRule, EffectCtx, EffectRule, LineRule, RuleFamily, TriggerRule } from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// Small vocabularies
// ---------------------------------------------------------------------------------------------------------------

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** "a", "two", "5", "X" -> an Amount; null for a word with no number in it. */
function count(word: string | undefined): Amount | null {
  if (!word) return 1;
  const w = word.trim().toLowerCase();
  if (w === 'x') return 'X';
  if (/^\d+$/.test(w)) return Number(w);
  return NUM_WORDS[w] ?? null;
}

/** The face count of "d20" / "six-sided" / "twenty-sided"; null when the word is not a die. */
const SIDE_WORDS: Record<string, number> = { four: 4, six: 6, eight: 8, ten: 10, twelve: 12, twenty: 20, hundred: 100 };
function sidesOf(word: string): number | null {
  const w = word.trim().toLowerCase();
  const d = w.match(/^d(\d+)$/); if (d) return Number(d[1]);
  const s = w.match(/^(\w+)-sided$/); if (s) return SIDE_WORDS[s[1]] ?? (/^\d+$/.test(s[1]) ? Number(s[1]) : null);
  return null;
}

/** "die" / "dice" / "d20" / "six-sided dice" — the noun a roll instruction uses, as `{ sides, plural }`. */
function diceWords(text: string): { sides: number } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const m = t.match(/^(d\d+|[a-z0-9]+-sided)(?: (?:die|dice))?$/);
  if (!m) return null;
  const sides = sidesOf(m[1]);
  return sides === null || sides < 2 ? null : { sides };
}

/** The effects of a clause, or null when any of them is `unknown` (the rule then declines rather than faking it). */
function sub(ctx: EffectCtx, text: string): Effect[] | null {
  const effs = ctx.parseEffects(text);
  return effs.length && effs.every(e => e.op !== 'unknown') ? effs : null;
}

// ---------------------------------------------------------------------------------------------------------------
// "… equal to the result" / "…, where X is the result"
// ---------------------------------------------------------------------------------------------------------------

/** The amount phrases a die roll or a set of coin flips leaves behind (CR 706.2, 705.2). */
const RES = '(the result|that result|the other result|the total of those results|the number of coins that came up heads|the number of flips you won)';
function resultAmount(word: string): Amount | null {
  const w = word.trim().toLowerCase();
  if (w === 'the other result') return { count: 'roll-other-result' };
  if (w === 'the result' || w === 'that result' || w === 'the total of those results') return { count: 'roll-result' };
  if (w === 'the number of coins that came up heads' || w === 'the number of flips you won') return { count: 'flips-won' };
  return null;
}

/** The effect slots a "where X is …" clause defines (the same keys src/cards/rules/composition.ts's `withX` fills). */
const AMOUNT_KEYS = new Set(['amount', 'count', 'power', 'toughness', 'look', 'mvLE', 'mvEQ', 'dynamicPT', 'perEach']);

/** Replace every `'X'` amount of `e` with `amount`; null when the clause defined no X (the rule then declines). */
function withX(e: Effect, amount: Amount): Effect | null {
  const copy = JSON.parse(JSON.stringify(e)) as Effect;
  let n = 0;
  const walk = (v: unknown, inAmount: boolean): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => { if (x === 'X' && inAmount) { (v as unknown[])[i] = amount; n++; } else walk(x, inAmount); }); return; }
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const isAmount = AMOUNT_KEYS.has(k) || k === 'sum' || k === 'diff' || k === 'min' || (k === 'max' && Array.isArray(o[k]));
      if (o[k] === 'X' && isAmount) { o[k] = amount; n++; } else walk(o[k], isAmount);
    }
  };
  walk(copy, false);
  return n ? copy : null;
}

/** Parse `rewritten` (the sentence with an `X` where the roll's result goes) and define that X as `word`'s amount. */
function withResult(ctx: EffectCtx, rewritten: string, word: string): Effect | null {
  const a = resultAmount(word); if (!a) return null;
  const e = ctx.parseEffectSentence(rewritten);
  return e.op === 'unknown' ? null : withX(e, a);
}

/** Every `'X'` amount inside a results-table striation is the result of the roll (CR 706.3a, 706.2). */
function xIsTheResult(v: unknown): unknown {
  if (v === 'X') return { count: 'roll-result' };
  if (Array.isArray(v)) return v.map(xIsTheResult);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === 'text' || k === 'prompt' ? x : xIsTheResult(x)]));
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Sentence rules
// ---------------------------------------------------------------------------------------------------------------

const effects: EffectRule[] = [
  // ---- "Roll a d20" / "Roll two six-sided dice" / "Roll X six-sided dice", with the modifiers printed in the same
  //      sentence (CR 706.1, 706.2). "and choose one result" / "and ignore the lower roll" say what several dice mean.
  {
    re: /^rolls? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+) (d\d+|[a-z0-9]+-sided(?: dice| die)?|dice|die)(?: (.+))?$/i,
    make: (m, ctx) => {
      const n = count(m[1]); if (n === null) return null;
      const dice = diceWords(m[2]); if (!dice) return null;
      const tail = (m[3] ?? '').trim().toLowerCase();
      const one = n === 1;
      let keep: 'sum' | 'choose-one' | 'highest' | 'lowest' | undefined;
      let plus: Amount | undefined;
      if (tail) {
        if (/^and choose one result$/.test(tail)) keep = 'choose-one';
        else if (/^and ignore (?:the (?:lower|lowest) roll|all but the highest roll)$/.test(tail)) keep = 'highest';
        else if (/^and ignore (?:the (?:higher|highest) roll|all but the lowest roll)$/.test(tail)) keep = 'lowest';
        else if (/^and add /.test(tail)) {
          // CR 706.2: a modifier printed with the instruction is added to the natural result.
          const a = ctx.parseAmountPhrase(tail.replace(/^and add /, '')); if (!a) return null;
          plus = a;
        } else return null;                                 // "for each player being attacked", "onto the battlefield", …
      }
      if (keep !== undefined && one) return null;           // "choose one result" of one die is not a wording that exists
      return { op: 'roll-die', sides: dice.sides, ...(one ? {} : { count: n }), ...(keep ? { keep } : {}), ...(plus !== undefined ? { plus } : {}) };
    },
  },

  // ---- "Flip a coin" (CR 705.1) and its two counted forms.
  { re: /^flips? a coin$/i, make: () => ({ op: 'flip-coin' }) },
  {
    re: /^flips? (two|three|four|five|six|seven|eight|nine|ten|x|\d+) coins$/i,
    make: m => { const n = count(m[1]); return n === null ? null : { op: 'flip-coin', count: n }; },
  },
  // "Flip a coin until you lose a flip" (CR 705.2): the streak of wins is what the rest of the ability counts.
  { re: /^flips? a coin until you lose a flip$/i, make: () => ({ op: 'flip-coin', until: 'lose' }) },

  // ---- "… equal to the result" / "…, where X is the result" (CR 706.2). src/cards/rules/composition.ts carries the
  //      same six sentence shapes for the amounts IT knows; those rules are consulted first (file-name order) and
  //      decline on a dice phrase, so these only ever see a sentence whose amount is a roll's or a flip streak's.
  { re: new RegExp(`^(.+?),? where x is ${RES}$`, 'i'), make: (m, ctx) => withResult(ctx, m[1], m[2]) },
  { re: new RegExp(`^(.+?) deals damage to (.+?) equal to ${RES}$`, 'i'), make: (m, ctx) => withResult(ctx, `${m[1]} deals X damage to ${m[2]}`, m[3]) },
  { re: new RegExp(`^(.+?) deals damage equal to ${RES} to (.+)$`, 'i'), make: (m, ctx) => withResult(ctx, `${m[1]} deals X damage to ${m[3]}`, m[2]) },
  { re: new RegExp(`^(.+?\\bput) a number of ([\\w+/-]+) counters on (.+?) equal to ${RES}$`, 'i'), make: (m, ctx) => withResult(ctx, `${m[1]} X ${m[2]} counters on ${m[3]}`, m[4]) },
  { re: new RegExp(`^(.+?\\bcreates?) a number of (.+?) tokens equal to ${RES}$`, 'i'), make: (m, ctx) => withResult(ctx, `${m[1]} X ${m[2]} tokens`, m[3]) },
  { re: new RegExp(`^(.+?\\b(?:draw|draws|mill|mills)) (?:a number of )?cards equal to ${RES}$`, 'i'), make: (m, ctx) => withResult(ctx, `${m[1]} X cards`, m[2]) },
  { re: new RegExp(`^(.+?\\b(?:gain|gains|lose|loses)) life equal to ${RES}$`, 'i'), make: (m, ctx) => withResult(ctx, `${m[1]} X life`, m[2]) },
];

// ---------------------------------------------------------------------------------------------------------------
// Condition rules — "if you win the flip, …" becomes a core `conditional` through parse.ts's own "If <c>, <e>" split
// ---------------------------------------------------------------------------------------------------------------

const conditions: ConditionRule[] = [
  {
    name: 'coin-flip-outcome',
    make: (text): Condition | null => {
      const t = text.trim().toLowerCase().replace(/\.$/, '');
      // "you win the flip" / "you won the flip" / "you win one or more flips" / "you win two or more flips"
      let m = t.match(/^you (win|won|lose|lost) (?:the flip|a flip|(a|one|two|three|four|five|\d+) or more flips)$/);
      if (m) {
        const outcome = m[1] === 'win' || m[1] === 'won' ? 'won' : 'lost';
        const least = m[2] === undefined ? 1 : count(m[2]);
        return typeof least === 'number' ? { kind: 'coin-flip', outcome, ...(least > 1 ? { least } : {}) } : null;
      }
      // "it comes up heads" / "the coin comes up heads" / "it's heads"
      m = t.match(/^(?:it|the coin|that coin) (?:comes up|came up) (heads|tails)$/) ?? t.match(/^it's (heads|tails)$/);
      if (m) return { kind: 'coin-flip', outcome: m[1] as 'heads' | 'tails' };
      return null;
    },
  },
  {
    name: 'roll-result',
    make: (text): Condition | null => {
      const t = text.trim().toLowerCase().replace(/\.$/, '');
      let m = t.match(/^the result is (\d+) or (more|greater|higher)$/);
      if (m) return { kind: 'roll-result', least: Number(m[1]) };
      m = t.match(/^the result is (\d+) or (less|lower|fewer)$/);
      if (m) return { kind: 'roll-result', most: Number(m[1]) };
      m = t.match(/^the result is (\d+)$/);
      if (m) return { kind: 'roll-result', least: Number(m[1]), most: Number(m[1]) };
      return null;
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Trigger rules
// ---------------------------------------------------------------------------------------------------------------

const triggers: TriggerRule[] = [
  {
    name: 'dice-rolled',
    make: (head): TriggerEvent | null => {
      const t = head.trim().toLowerCase().replace(/,$/, '');
      // CR 706.1: the ability triggers once for the roll instruction, whatever number of dice it named.
      const m = t.match(/^whenever (you|a player|another player|each player) rolls? (?:one or more dice|a die|dice)$/);
      if (!m) return null;
      return { on: 'dice-rolled', who: m[1] === 'you' ? 'you' : 'any' };
    },
  },
  {
    name: 'coin-flipped',
    make: (head): TriggerEvent | null => {
      const t = head.trim().toLowerCase().replace(/,$/, '');
      // "Whenever you win a coin flip" / "Whenever a player wins a coin flip" / "Whenever you flip a coin"
      let m = t.match(/^whenever (you|a player|another player) (wins?|loses?) a coin flip$/);
      if (m) return { on: 'coin-flipped', who: m[1] === 'you' ? 'you' : 'any', outcome: /^win/.test(m[2]) ? 'won' : 'lost' };
      m = t.match(/^whenever (you|a player|another player) flips? a coin$/);
      if (m) return { on: 'coin-flipped', who: m[1] === 'you' ? 'you' : 'any' };
      return null;
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Line rules — the results table
// ---------------------------------------------------------------------------------------------------------------

/** "1—9 | …", "20 | …", "15+ | …" (CR 706.3a). The em dash, en dash, minus sign and hyphen all appear in print. */
const ROW_RE = /^(\d+)\s*(?:[—–−-]\s*(\d+)|(\+))?\s*\|\s*(.+)$/;

/** Does this effect list end in a roll whose striations are still being read? (a `roll-die`, or a striation of one). */
function rollTail(effs: Effect[]): boolean {
  for (let i = effs.length - 1; i >= 0; i--) {
    const e = effs[i] as { op: string; condition?: { kind?: string } };
    if (e.op === 'roll-die') return true;
    if (e.op === 'conditional' && e.condition?.kind === 'roll-result') return true;
    return false;
  }
  return false;
}

const lines: LineRule[] = [
  {
    name: 'results-table-row',
    match: (line, ctx) => {
      const m = line.trim().replace(/\s+/g, ' ').match(ROW_RE);
      if (!m) return false;
      // The striation belongs to the ability the previous line built (CR 706.3b: the roll and its table are one
      // ability). Only the ability last added counts — a table never skips a line.
      const host = ctx.def.abilities[ctx.def.abilities.length - 1];
      if (!host || host.kind === 'static' || !rollTail(host.effects)) return false;
      const effs = ctx.parseEffects(m[4]);
      if (!effs.length || effs.some(e => e.op === 'unknown')) { ctx.markUnparsed(); return true; }
      const least = Number(m[1]);
      const most = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? undefined : least;   // "N+" is open-ended
      host.effects.push({
        op: 'conditional',
        condition: { kind: 'roll-result', least, ...(most === undefined ? {} : { most }) },
        then: xIsTheResult(effs) as Effect[],
      });
      return true;
    },
  },
];

const diceCoin: RuleFamily = { name: 'dice-coin', effects, conditions, triggers, lines };
export default diceCoin;
