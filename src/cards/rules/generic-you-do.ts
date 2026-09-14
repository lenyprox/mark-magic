// Parser rules for the "you do" construct (Phase 9.1p; the parse:why item `generic-you-do`, 542 paper-pool cards,
// one single wording: `condition|you do`).
//
// The construct is the link in "**You may X. If you do, Y**" (CR 608.2). The fragment the recursive parser cannot
// claim is the condition "you do" of the sentence "If you do, Y", so parse:why files it under the `condition` stage —
// but a ConditionRule is exactly what it must NOT be. "You do" is not a fact about the game state a `Condition` could
// answer; it asks whether the effect immediately before it in the same resolution happened. The engine's only shape
// for that is `reflexive` (CR 603.12), and that is the *other* card: "When you do" is a triggered ability that uses
// the stack and chooses its targets when it is put on it, which is why Victimize's script explicitly rejected it.
//
// Where the rule lives instead. parse.ts already owns the construct: PARAGRAPH_RULES carries "You may pay {M}. If you
// do, Y" (`optional-pay`) and "You may X. If you do, Y" (`optional-then`), matched against the START of a paragraph
// and retried with the registry in their two slots when the built-ins alone cannot fill them (`parseParagraph`). So
// the registry's job here — the one docs/vocabulary/composition.md names in its wording table, "the built-in
// `optional-then`, whose X / Y slots now accept registry wordings" — is to teach the parser the HALVES. Every rule
// below is an effect rule for an X or a Y of a printed "You may X. If you do, Y"; when both halves are known the
// template claims the paragraph and the "you do" failure goes with it.
//
// CLAIMED (each exactly expressible in the engine's existing vocabulary, each an X or a Y of a printed card):
//
//   "return another <filter> you control to its owner's hand"   -> `return-own` with `other: true`   (Temur Sabertooth)
//   "exile a/an <filter> card from your graveyard"              -> `move` of a chosen graveyard set   (Masked Vandal)
//   "exile ~ from your graveyard"                               -> `move` of `self` to exile          (Kozilek's Return)
//   "return ~ to your hand"                                     -> `move` of `self` to hand           (Pyrewild Shaman)
//   "discard all the cards in your hand"                        -> `discard` of the whole hand        (Forgotten Creation)
//
// DECLINED — left `unknown` on purpose, never approximated (the report's openIssues carries the same list):
//
//   "If you do, <Y>" ON ITS OWN — every card whose "You may X." sentence is not the start of its paragraph
//        ("Gain control of target creature … You may discard a card. If you do, draw a card." — Vengeful Possession;
//        "Mill three cards. Then you may pay {1} and 3 life. If you do, …" — Ripples of Undeath). parse.ts splits a
//        paragraph into sentences BEFORE any rule is offered anything, so a sentence rule is handed "If you do, Y"
//        alone and cannot see X; there is no hook that sees the pair. Core change, not a rule (see coreChangeNeeded:
//        try PARAGRAPH_RULES at every sentence boundary, not only at the paragraph start).
//   "<mandatory action>. If you do, Y" — "Sacrifice a non-Demon creature. If you do, create a token that's a copy of
//        ~." (Dreadfeast Demon), "Sacrifice a Mountain. If you do, …" (The First Eruption). Even with both halves in
//        hand there is no effect op for "run Y only if the effect before it happened, in this same resolution".
//   "pay N life" — writing it as `lose-life` would let a player at 1 life pay 2, which CR 119.4 forbids; there is no
//        `pay-life` effect and `optional-pay` takes mana only (16 records, the largest single X half).
//   "blight N" — a keyword action with no engine op (keyword-action's business).
//   "sacrifice it" / "exile it" — a bare pronoun parse.ts left unresolved (its `it` -> `~` rewrite is suppressed as
//        soon as the body mentions a target or another object). composition.ts declines a bare "it" for the same
//        reason: in "Whenever another creature you control dies, you may exile it" it is the dying creature, in
//        "When ~ dies, you may exile it" it is the source. Core change (the rewrite), not a rule.
//   "put a card an opponent owns from exile into that player's graveyard" (the Eldrazi processors) — `ScopeWho` has
//        no single "an opponent"; `each-opponent` would take one card from EVERY opponent (CR 101.4).
//   "sacrifice a Blood token" — `Blood` is not in the generated subtype vocabulary (src/cards/subtype-vocab.ts is
//        built from the playable pool, and Blood exists only on token cards), so no filter can name it. The same for
//        "a Caribou token" and "a Prism token"; the built-ins already claim the Food form, so there is no rule here.
//   "~ assigns no combat damage this turn" (the Laccolith Y half, 12 records) — no effect op for it.
//
// Nothing here imports parse.ts at runtime: the shared sub-parsers arrive on the `EffectCtx` (./types.ts).
import type { Effect, Filter } from '../types.js';
import type { EffectCtx, EffectRule, RuleFamily } from './types.js';
import { subtypeWord } from '../subtypes.js';

/** The subtypes the text's capitalised words name, in the vocabulary's spelling — the only subtypes a sub-parse of it may carry (the composition.ts guard). */
function subtypeWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[A-Z][a-z]+/g) ?? []) { const sub = subtypeWord(w); if (sub) out.add(sub); }
  return out;
}
/** A filter whose subtypes are all named by the text it came from; null when the built-in parser declined or invented one. */
function filterOf(ctx: EffectCtx, words: string): Filter | null {
  const f = ctx.parseFilterWords(words);
  if (!f || !Object.keys(f).length) return null;
  const allowed = subtypeWords(words);
  if (f.subtypes?.some(t => !allowed.has(t))) return null;
  return f;
}

const effects: EffectRule[] = [
  // ---- X halves: the optional action of "You may X. If you do, Y" ------------------------------------------------
  // "{1}{G}: You may return another creature you control to its owner's hand. If you do, ~ gains indestructible
  // until end of turn." (Temur Sabertooth). The built-in table has the "a/an" form of this op only; "another" is the
  // same op with `other: true` on the filter (CR 109.5 — "another" excludes the source).
  {
    re: /^return another (.+?) you control to its owner's hand$/i,
    make: (m, ctx) => { const f = filterOf(ctx, m[1]); return f ? { op: 'return-own', filter: { ...f, other: true }, count: 1, to: 'hand' } : null; },
  },

  // "When ~ enters, you may exile a creature card from your graveyard. If you do, exile target artifact or
  // enchantment an opponent controls." (Masked Vandal, Master Skald, Aphemia). One card of your own graveyard,
  // chosen by you (CR 400.6): the `move` op's chosen-set form.
  {
    re: /^exile (?:a|an) (.+?) card from your graveyard$/i,
    make: (m, ctx) => { const f = filterOf(ctx, m[1]); return f ? { op: 'move', what: { filter: f, zone: 'graveyard', who: 'you', count: 1 }, to: 'exile' } : null; },
  },

  // "Whenever you cast an Eldrazi creature spell with mana value 7 or greater, you may exile ~ from your graveyard.
  // If you do, ~ deals 5 damage to each creature." (Kozilek's Return, Council's Deliberation, Ugin's Binding) — the
  // source itself, which is the zone the ability is working from.
  { re: /^exile ~ from your graveyard$/i, make: () => ({ op: 'move', what: 'self', to: 'exile' }) },

  // "At the beginning of your upkeep, you may discard all the cards in your hand. If you do, draw that many cards."
  // (Forgotten Creation, Book Devourer) — the op the built-ins already give the shorter "discard your hand"
  // (CR 701.8a); "that many" then reads the number discarded.
  { re: /^discard all the cards in your hand$/i, make: () => ({ op: 'discard', amount: 'hand', who: 'you' }) },

  // ---- Y halves: what "If you do" then does ----------------------------------------------------------------------
  // "Whenever one or more creatures you control deal combat damage to a player, if ~ is in your graveyard, you may
  // pay {3}. If you do, return ~ to your hand." (Pyrewild Shaman, Death Spark, Krovikan Horror) — the source, from
  // whatever zone it is in (CR 400.7).
  { re: /^return ~ to your hand$/i, make: (): Effect => ({ op: 'move', what: 'self', to: 'hand' }) },
];

const genericYouDo: RuleFamily = { name: 'generic-you-do', effects };
export default genericYouDo;
