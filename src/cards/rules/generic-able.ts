// Parser rules for the `generic-able` wave item (Phase 9.1p; the `condition|able` construct of
// data/scripts/batches/parse-wave-1-pool.json).
//
// What the construct actually is. `parse:why` keys these 99 paper-pool lines as `condition|able` because the sentence
// ladder in src/cards/parse.ts splits "<effects> if <condition>" on the last " if " and then asks `parseCondition`
// for the word "able". That key names the *trace*, not the rule kind: "if able" is not a condition at all. CR 506.4 /
// 508.1d / 509.1c make it part of ONE combat requirement — "attacks this turn if able" is a requirement obeyed only as
// far as the restrictions allow, never an effect gated on a truth value evaluated once on resolution. A ConditionRule
// for "able" would therefore be doubly wrong: semantically (it would emit `conditional { if: <able>, then: … }`, an
// effect that simply does not happen when the condition is false, which is not what a requirement does) and in blast
// radius (every "… if able" sentence in the pool reaches that same split). So this family registers **no conditions**;
// the wordings it claims are claimed as whole SENTENCES, above the split, which is where the requirement lives.
//
// CLAIMED — one wording family, the group-scoped blocking requirement (CR 509.1c):
//
//   "Each creature blocks this turn if able."                              You've Been Caught Stealing
//   "Each creature your opponents control blocks this turn if able."       Predatory Rampage
//   "Each creature you control blocks this turn if able."                  (the third controller phrase; same shape)
//   "Each creature an opponent controls blocks this turn if able."
//
//   → `for-each` over that set with the engine's own one-shot requirement on each member:
//     { op: 'for-each', over: { types: ['Creature'], who? }, do: [{ op: 'blocks-if-able', target: 'that', duration: 'eot' }] }
//     `blocks-if-able` is exactly CR 509.1c's "this creature blocks if able" (src/engine/ops/combat-restr.ts, pass 3
//     of `blockFixup`), and CR 608.2f's per-object iteration is what `for-each` is; the ops take no filter of their
//     own, so the set is walked, precisely as src/cards/rules/composition.ts walks one for "<Spirits> you control
//     gain <keywords>".
//
// DECLINED — every other wording of the construct, because the engine's vocabulary cannot express it *exactly* and a
// rule that approximates one silently mis-plays hundreds of cards (the discipline of ./composition.ts and
// ./dice-coin.ts). Each has a decline pin in test/parser-generic-able.test.ts; the wave report lists them in
// `openIssues` with the op each would need.
//
//   1. ATTACK REQUIREMENTS — "Target creature attacks this turn if able", "Creatures your opponents control attack
//      this turn if able", "~ attacks that player this combat if able", "That token attacks this combat if able",
//      "Each creature attacks this turn if able" (~55 of the 99 lines). The engine has ONE attack requirement and it
//      is not an effect: the boolean `mustAttack` on a `self-keywords` static, read by src/engine/game.ts straight off
//      `o.def.abilities` — the permanent's own printed ability. There is no one-shot op, no duration, no filter scope
//      and no "attacks *that player*" slot (CR 508.1d's requirement to attack a particular player or planeswalker).
//      Needs an `attacks-if-able` effect.
//   2. A BLOCK REQUIREMENT THAT NAMES THE ATTACKER — "Target creature blocks ~ this turn if able", "up to one target
//      creature blocks it this combat if able", "Target creature blocks target creature this turn if able" (~20
//      lines). `blocks-if-able` marks the blocker and `blockFixup` then pairs it with the FIRST attacker it can
//      legally block; the printed cards require it to block one named attacker. Needs the mirror of
//      `cant-block-source`: an `attacker` slot on `blocks-if-able`.
//   3. A ONE-SHOT "MUST BE BLOCKED" — "Target creature must be blocked this turn if able", "~ must be blocked each
//      combat this turn if able", "Target creature gets +2/+2 until end of turn and must be blocked this turn if
//      able" (~15 lines). `must-be-blocked` is a STATIC with a `scope`, not an effect with a duration; there is no
//      op that puts the requirement on a target until end of turn. (`lure` is the ALL form — CR 509.1c "every
//      creature able to block it does so" — and is strictly stronger, so it may not stand in for "must be blocked".)
//   4. "each combat" / "each turn" DURATIONS — `blocks-if-able` carries `duration: 'eot'` and the engine's marker is
//      keyed by turn number; "this combat" inside a turn with two combat phases, and "each combat"/"until your next
//      turn" spans, are not that. Only "this turn" is claimed.
//
// Two more shapes of the construct are core work, not registry work, and are reported in `coreChangeNeeded`:
// "It must be blocked this turn if able." / "That creature blocks this turn if able." reach a rule as
// "~ must be blocked …" / "~ blocks …" because parse.ts rewrites a leading pronoun to the source before any template
// runs, and "They block this turn if able." is claimed by ./combat-restr.ts and then thrown away by the binding-frame
// check, since nothing in those cards' earlier sentences binds `those`.
//
// Nothing here imports parse.ts at runtime: the shared sub-parsers arrive on the `EffectCtx` the parser hands a rule.
import type { Effect, Filter, ScopeWho } from '../types.js';
import type { EffectRule, RuleFamily } from './types.js';

/** The `for-each` set a "Each creature <controller phrase>" subject describes; `who` absent = every player's. */
function creatureSet(controller: string | undefined): Filter & { who?: ScopeWho } {
  const set: Filter & { who?: ScopeWho } = { types: ['Creature'] };
  const w = (controller ?? '').trim().toLowerCase();
  if (w === 'you control') set.who = 'you';
  else if (w === 'your opponents control' || w === 'an opponent controls') set.who = 'each-opponent';
  return set;
}

const effects: EffectRule[] = [
  // "Each creature your opponents control blocks this turn if able." (Predatory Rampage)
  // "Each creature blocks this turn if able."                         (You've Been Caught Stealing, second mode)
  //
  // CR 509.1c: each named creature carries the requirement on its own, and the defending player's declaration has to
  // meet as many of them as it legally can. Anchored end to end and with a closed controller vocabulary: a loose tail
  // would happily swallow "Each creature with flying …" and drop the words that decide which creatures are meant.
  {
    re: /^each creature(?: (you control|your opponents control|an opponent controls))? blocks this turn if able$/i,
    make: (m): Effect => ({
      op: 'for-each',
      over: creatureSet(m[1]),
      do: [{ op: 'blocks-if-able', target: 'that', duration: 'eot' }],
    }),
  },
];

const genericAble: RuleFamily = { name: 'generic-able', effects };
export default genericAble;
