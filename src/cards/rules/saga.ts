// Parser rules for the saga family (Phase 9.1; docs/vocabulary/saga.md).
//
// The wordings that produce the ops in `src/engine/ops/saga.ts`, plus the two *chapter line* shapes parse.ts's own
// saga branch cannot reach:
//
//   1. **A multi-chapter line.** The built-in chapter branch matches `^(I|II|…)(, (I|II|…))* — (.+)$` — but the line
//      it is handed has already been through the ability-word / "Name — " strip above it, whose guard is only
//      `(?![IVX]+ — )`. "I, II, III — Pain — You draw a card …" is not `[IVX]+ — ` (the commas), so the strip eats
//      the chapter numbers and the branch never sees them: the card ends up with a *static* ability and no chapter
//      at all (Summon: Anima, Tales of Master Seshiro, Battle at the Helvault, …). Line rules are handed the
//      untouched `rawLine`, so the numbers are still there to read, and the rule rebuilds the chapter ability the
//      branch would have made — including `def.finalChapter`, without which CR 714.4 never sacrifices the Saga.
//   2. **A named chapter.** Final Fantasy's Summons print "I — Gungnir — Destroy target creature an opponent
//      controls."; the chapter branch claims the line and hands "Gungnir — Destroy target creature an opponent
//      controls." to `parseEffects`, where every built-in template declines it. A sentence rule strips the name and
//      re-parses the rest — and, because a rule only ever sees a sentence every built-in stage gave up on, it can
//      only ever turn an `unknown` into something.
//
// Both are guarded the composition way: the rule claims nothing it cannot express, and a body that still holds an
// `unknown` is recorded as unparsed rather than silently dropped.
import type { Condition, Effect, TargetSpec, TriggerEvent } from '../types.js';
import type { ConditionRule, EffectCtx, EffectRule, LineRule, RuleFamily, TriggerRule } from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// Small vocabularies
// ---------------------------------------------------------------------------------------------------------------

/** Chapter numerals, in the spelling the cards use (CR 714.2a). Sagas have never gone past VI. */
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
/** The numerals of a chapter head ("I, II, III"), or null when a word is not one. */
function chapterNumbers(head: string): number[] | null {
  const out: number[] = [];
  for (const part of head.split(',')) {
    const n = ROMAN[part.trim().toLowerCase()];
    if (n === undefined) return null;
    out.push(n);
  }
  return out.length ? out : null;
}

/** Counting words a lore-counter clause uses; anything else makes the rule decline. */
const COUNT: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const count = (w: string): number | 'X' | null => {
  const t = w.trim().toLowerCase();
  if (t === 'x') return 'X';
  if (/^\d+$/.test(t)) return Number(t);
  return COUNT[t] ?? null;
};

/**
 * "target Saga you control", "up to one target Saga", "any number of target Sagas you control" → the family's own
 * target kind. Only the shapes the cards print; anything else declines, so a phrase this does not understand can
 * never be claimed with the wrong spec.
 */
function sagaTarget(phrase: string): TargetSpec | null {
  const m = phrase.trim().replace(/\.$/, '').match(/^(?:(up to (?:one|two|three)|any number of|two|three) )?target Sagas?( you control| an opponent controls| you don't control)?$/i);
  if (!m) return null;
  const spec: TargetSpec = { kind: 'saga' };
  const ctl = (m[2] ?? '').trim().toLowerCase();
  if (ctl === 'you control') spec.controller = 'you';
  else if (ctl === 'an opponent controls' || ctl === "you don't control") spec.controller = 'opponent';
  const q = (m[1] ?? '').toLowerCase();
  if (q === 'any number of') { spec.count = 99; spec.optional = true; }
  else if (q.startsWith('up to ')) { spec.count = COUNT[q.slice(6)] ?? 1; spec.optional = true; }
  else if (q === 'two' || q === 'three') spec.count = COUNT[q];
  return spec;
}

/** A sub-parse that produced nothing unknown. */
const known = (effs: Effect[]): boolean => effs.length > 0 && effs.every(e => e.op !== 'unknown');

/** A back-reference to the thing an earlier sentence of the same chapter already named ("... on it", "... to them"). */
const DANGLING = /\b(?:on|to) (?:it|them)\b/i;
/** An object TargetSpec (the only antecedent `target:0` can name), as opposed to a Ref or a group word. */
const isSpec = (t: unknown): t is TargetSpec => !!t && typeof t === 'object' && typeof (t as { kind?: unknown }).kind === 'string';

/**
 * Re-bind a chapter body's dangling pronoun, or refuse the body.
 *
 * "Tap target creature an opponent controls. Put a stun counter on it." (Summon: Shiva) parses to
 * `[{tap, target: <spec>}, {counters, target: 'self'}]`: parse.ts's antecedent machinery only runs on the ladder it
 * walked itself, and a chapter body handed back through `ctx.parseEffects` arrives without that frame, so the trailing
 * "it" falls through to the source. On a Saga that reading is never right - a Saga naming itself prints "~", never
 * "it" - and the counter would land on the Saga instead of on the creature the chapter just tapped (CR 122.1d: a
 * counter is put on the object the effect names). `known()` cannot see this: every op is known, the parse is simply
 * about the wrong permanent.
 *
 * So the reference is re-bound to the body's single target (`target:0`, resolved by engine/refs.ts from the item's
 * targets), and when it cannot be re-bound *unambiguously* - no antecedent, more than one, one that comes after the
 * reference, or one that takes several objects - the body is refused, so the family claims nothing it cannot express.
 * Returns the effects (rewritten in place of the copies) or null to refuse.
 */
function bindDangling(body: string, effs: Effect[]): Effect[] | null {
  const self = (e: Effect): boolean => (e as { target?: unknown }).target === 'self';
  if (!effs.some(self)) return effs;                                       // nothing bound to the source: nothing to do
  if (!DANGLING.test(body) || /~/.test(body)) return effs;                 // ... and it did not come from a pronoun
  const specs = effs.map((e, i) => ({ e, i })).filter(({ e }) => isSpec((e as { target?: unknown }).target));
  if (specs.length !== 1 || specs[0].i > effs.findIndex(self)) return null;
  const spec = (specs[0].e as { target: TargetSpec }).target;
  if (spec.count !== undefined && spec.count !== 1) return null;           // "two target creatures": which one is "it"?
  if (effs.some(e => (e as { target?: unknown }).target === true)) return null;   // a second, un-spec'd targeting clause
  return effs.map(e => (self(e) ? { ...e, target: 'target:0' } as Effect : e));
}

// ---------------------------------------------------------------------------------------------------------------
// Effect rules
// ---------------------------------------------------------------------------------------------------------------

/** "target Saga you control" and the sets a lore clause can name, as one alternation for the templates below. */
const SAGAS = "((?:up to (?:one|two|three) |any number of |two |three )?target Sagas?(?: you control| an opponent controls| you don't control)?|each Saga you control|each of any number of target Sagas you control)";

/** The Sagas a lore clause names → the `saga-lore` op's `target`, or null. */
function loreTarget(phrase: string): SagaTarget | null {
  const p = phrase.trim().replace(/\.$/, '');
  if (/^each Saga you control$/i.test(p)) return 'each-saga-you-control';
  // "on each of any number of target Sagas you control" is the same set as "any number of target Sagas you control"
  const each = p.match(/^each of (any number of target Sagas(?: you control)?)$/i);
  return sagaTarget(each ? each[1] : p);
}
type SagaTarget = TargetSpec | 'each-saga-you-control';

const effects: EffectRule[] = [
  // ---- "Put a lore counter on target Saga you control." / "Put two lore counters on each Saga you control."
  { re: new RegExp(`^put (a|an|one|two|three|four|five|X|\\d+) lore counters? on ${SAGAS}$`, 'i'), make: m => {
    const n = count(m[1]); const t = loreTarget(m[2]);
    return n === null || t === null ? null : ({ op: 'saga-lore', target: t, amount: n } satisfies Effect);
  } },
  // ---- "Remove a lore counter from target Saga you control."
  { re: new RegExp(`^remove (a|an|one|two|three|X|\\d+) lore counters? from ${SAGAS}$`, 'i'), make: m => {
    const n = count(m[1]); const t = loreTarget(m[2]);
    return n === null || t === null ? null : ({ op: 'saga-lore', target: t, amount: n, remove: true } satisfies Effect);
  } },

  // ---- A named chapter: "Gungnir — Destroy target creature an opponent controls."
  //      The name is flavour (CR 714.2a: a chapter ability's number is what matters), so it is stripped and the rest
  //      re-parsed. Deliberately narrow: the name is one short capitalised phrase with no sentence punctuation and
  //      no second em dash, and the rule declines unless the remainder parses into exactly one known effect — so
  //      the only sentences it can move are ones that were `unknown` and now are not.
  { re: /^([A-Z][^—.:;!?]{0,38}?)!? — ([^—]+)$/, make: (m, ctx) => chapterName(m[1], m[2], ctx) },
];

/** The tail of a named chapter, or null: the name must look like a name and the body must parse completely. */
function chapterName(name: string, body: string, ctx: EffectCtx): Effect | null {
  if (!/^[A-Z][A-Za-z'’ !,-]*$/.test(name.trim())) return null;   // "Judgment Bolt", "Hall of Sorrow", "Pain"
  const effs = bindDangling(body, ctx.parseEffects(body));
  if (!effs || !known(effs)) return null;
  return effs.length === 1 ? effs[0] : { op: 'scoped', who: 'you', do: effs };
}

// ---------------------------------------------------------------------------------------------------------------
// Trigger rules
// ---------------------------------------------------------------------------------------------------------------

const triggers: TriggerRule[] = [
  // "Whenever you put a lore counter on a Saga you control, …" (Sigurd, Jarl of Ravensthorpe)
  { name: 'lore-counter-put', make: head => {
    const m = head.trim().replace(/,$/, '').match(/^whenever (you put a lore counter on a Saga you control|a lore counter is put on a Saga(?: you control)?|a lore counter is put on ~)$/i);
    if (!m) return null;
    const who = /you control|on ~/i.test(m[1]) ? 'you' : 'any';
    return { on: 'lore-counter-put', who } satisfies TriggerEvent;
  } },
  // "Whenever the final chapter ability of a Saga you control resolves / triggers, …" (Narci / Historian's Boon)
  { name: 'saga-final-chapter', make: head => {
    const m = head.trim().replace(/,$/, '').match(/^whenever the final chapter ability of a Saga( you control)? (resolves|triggers)$/i);
    if (!m) return null;
    return { on: 'saga-final-chapter', who: m[1] ? 'you' : 'any', when: m[2].toLowerCase() as 'resolves' | 'triggers' } satisfies TriggerEvent;
  } },
];

// ---------------------------------------------------------------------------------------------------------------
// Condition rules
// ---------------------------------------------------------------------------------------------------------------

const conditions: ConditionRule[] = [
  // "there are four or more lore counters among Sagas you control" (Tom Bombadil)
  { name: 'saga-lore-ge', make: text => {
    const m = text.trim().replace(/\.$/, '').match(/^there are (a|an|one|two|three|four|five|six|seven|\d+) or more lore counters among Sagas (you control|your opponents control)$/i);
    if (!m) return null;
    const n = count(m[1]);
    if (n === null || n === 'X') return null;
    return { kind: 'saga-lore-ge', who: /^you/i.test(m[2]) ? 'you' : 'opponent', value: n } satisfies Condition;
  } },
];

// ---------------------------------------------------------------------------------------------------------------
// Line rules
// ---------------------------------------------------------------------------------------------------------------

const lines: LineRule[] = [
  // ---- "Read ahead" (CR 714.4b). Offered at line hook 1: "read ahead" is one of the keywords parse.ts knows *of*,
  //      so the line is recorded as unparsed inside the keyword bail-out and never reaches the ladder below it.
  { name: 'read-ahead', match: (line, ctx) => {
    if (!/^read ahead\.?$/i.test(line.trim()) || !ctx.row.subtypes.includes('Saga')) return false;
    ctx.addAsEnters({ kind: 'read-ahead' });
    return true;
  } },

  // ---- A chapter line the built-in branch lost to the "Name — " strip above it (see the header). `rawLine` is the
  //      line before that strip, so the numerals are still readable.
  { name: 'saga-chapter', match: (_line, ctx) => {
    if (ctx.isSpell || !ctx.row.subtypes.includes('Saga')) return false;
    const m = ctx.rawLine.match(/^((?:[IVX]+)(?:,\s*[IVX]+)*) — (.+)$/);
    if (!m) return false;
    const chapters = chapterNumbers(m[1]);
    if (!chapters) return false;
    // a named chapter ("I, II, III — Pain — You draw a card …"): the name is flavour, the effects are the tail
    const named = m[2].match(/^([A-Z][A-Za-z'’ !,-]{0,38}?)!? — ([^—]+)$/);
    const body = named ? named[2] : m[2];
    const raw = ctx.parseEffects(body);
    // a dangling "... on it" the sub-parse bound to the Saga is re-bound, or the line is claimed as UNPARSED: the
    // ability still has to exist (chapter numbers and `finalChapter` are what CR 714.4 runs on) but the coverage
    // number must not count a body whose target is wrong. See bindDangling().
    const bound = bindDangling(body, raw);
    const effs = bound ?? raw;
    ctx.addAbility({ kind: 'triggered', event: { on: 'chapter', chapters }, effects: effs, text: ctx.rawLine });
    ctx.def.finalChapter = Math.max(ctx.def.finalChapter ?? 0, ...chapters);
    if (!bound || !known(effs)) ctx.markUnparsed(ctx.rawLine);
    return true;
  } },
];

const saga: RuleFamily = { name: 'saga', effects, triggers, conditions, lines };
export default saga;
