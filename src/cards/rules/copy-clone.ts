// Parser rules for the copy / clone family (Phase 9.1; docs/vocabulary/copy-clone.md).
//
// The wordings CR 707 and CR 115.7 print, mapped onto the ops src/engine/ops/copy-clone.ts registers:
//
//   "Create a token that's a copy of target creature you control[, except it's a 4/4 black Zombie]"  copy-permanent
//   "Copy target instant or sorcery spell" / "copy that spell"                                        copy-stack
//   "Change the target of target spell or ability with a single target"                               change-targets
//   "You may choose new targets for target spell or ability"                                          change-targets
//   "You may have ~ enter as a copy of any creature on the battlefield"                                enter-as-copy
//   "~ can't be copied"                                                                               cant-be-copied
//
// Every rule here is consulted only after every built-in stage of parse.ts declined the text (the registry contract
// in ./types.ts), so the built-in `token-copy` / `copy-spell` templates keep the cards they already claim: this file
// is the *modified* forms they cannot express. Two disciplines, the same as the composition family's:
//
//   * a rule never claims what it cannot express. Every word of a target phrase and of an "except ..." clause is
//     checked against a known vocabulary (types, colours, the pool's subtype list) before the lossy built-in filter
//     parser sees it, and one unknown word declines the whole sentence rather than producing a copy with the wrong
//     characteristics — a wrong copy is far worse than an unparsed line, because it silently plays a different card;
//   * an exception that names a quoted ability ('except it has "When this token leaves the battlefield, ..."') is
//     declined: an effect rule is handed no trigger parser, so the ability could only be guessed at. The op carries
//     `except.abilities`, so a per-card script still expresses those cards.
import type { CardType, Color, Filter, Keyword, Ref, StaticEffect, TargetSpec } from '../types.js';
import type { CopyException } from '../../engine/ops/copy-clone.js';
import type { EffectCtx, EffectRule, LineRule, RuleFamily, StaticRule } from './types.js';
import { subtypeWord } from '../subtypes.js';

// ---------------------------------------------------------------------------------------------------------------
// Vocabularies and guards
// ---------------------------------------------------------------------------------------------------------------

const COLOR_WORD: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const TYPE_WORD: Record<string, CardType> = {
  artifact: 'Artifact', creature: 'Creature', enchantment: 'Enchantment', land: 'Land',
  planeswalker: 'Planeswalker', battle: 'Battle', instant: 'Instant', sorcery: 'Sorcery',
};

/** Every word the built-in target parser gives a meaning to in a "target ..." phrase this family may claim. */
const TARGET_WORDS = new Set<string>([
  'target', 'another', 'other', 'a', 'an', 'you', 'control', 'controls', 'opponent', 'an opponent',
  'permanent', 'creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'nonland', 'token', 'nontoken',
  'tapped', 'untapped', 'attacking', 'blocking', 'legendary', 'nonlegendary', 'white', 'blue', 'black', 'red', 'green',
]);
const isSubtype = (w: string): boolean => /^[A-Z]/.test(w) && subtypeWord(w) !== null;

/**
 * "it", "that creature", "those tokens", "~", "the exiled card" → the Ref the binding frame resolves. A bare "it" is
 * claimed here (unlike the composition family's removal verbs, where "it" is too often the source): "a copy of it"
 * always names the object the previous sentence bound, and parse.ts's `bindAntecedent` makes the sentence unknown
 * when nothing binds it, so a wrong reading cannot survive.
 */
function refWord(w: string): Ref | null {
  const t = w.trim().toLowerCase();
  if (t === '~') return 'self';
  if (/^(it|that (creature|card|permanent|token|artifact|enchantment|land|spell))$/.test(t)) return 'that';
  if (/^(them|those (cards|creatures|permanents|tokens|artifacts|lands)|each of them|each of those (creatures|cards|permanents))$/.test(t)) return 'those';
  if (/^the exiled cards?$/.test(t)) return 'that';        // the same ability exiled it a sentence ago (CR 400.7 aside, the frame holds it)
  return null;
}

/** A "target ..." phrase whose every word the built-in target parser understands, or a Ref; null declines. */
function copySource(phrase: string, ctx: EffectCtx): TargetSpec | Ref | null {
  const t = phrase.trim().replace(/\.$/, '');
  const r = refWord(t); if (r) return r;
  if (!/^(?:another |other )?target /i.test(t)) return null;
  for (const w of t.split(/\s+/)) if (!TARGET_WORDS.has(w.toLowerCase()) && !isSubtype(w)) return null;
  return ctx.parseTarget(t);
}

/**
 * The stack object a copy / retarget effect names.
 *
 * Every wording goes to one of this family's OWN target kinds, never to the core `spell` / `ability` kinds, because
 * those two drop what these cards print (src/engine/legal.ts:targetOptionsFor):
 *
 *   * neither consults `spec.controller`, so "Copy target instant or sorcery spell **you control**" would have
 *     offered an opponent's spell — eight fully-parsed cards print exactly that (CR 115.4: "you control" is part of
 *     the targeting restriction, and a spell that cannot be targeted cannot be copied this way);
 *   * `ability` is every non-spell item on the stack, so "Copy target **triggered** ability you control" (Strionic
 *     Resonator) would have copied an activated one too, and vice versa (CR 113.3a-c).
 *
 * `stack-spell` / `stack-ability` / `stack-activated-ability` / `stack-triggered-ability` ask those questions
 * properly; a filter still narrows a spell by type the way the core kind did.
 */
function stackSource(phrase: string, single = false): TargetSpec | Ref | null {
  let t = phrase.trim().replace(/\.$/, '').toLowerCase();
  const mine = / you control$/.test(t); if (mine) t = t.replace(/ you control$/, '');
  const ctl = mine ? { controller: 'you' as const } : {};
  const ref = refWord(t) ?? (/^that spell$/.test(t) ? 'that' : null);
  if (ref) return ref;
  if (!t.startsWith('target ')) return null;
  const body = t.slice('target '.length);
  const kind = single ? 'single-target-spell-or-ability' : 'spell-or-ability';
  if (/^(activated or triggered ability|ability)$/.test(body)) return single ? null : { kind: 'stack-ability', ...ctl };
  if (/^activated ability$/.test(body)) return single ? null : { kind: 'stack-activated-ability', ...ctl };
  if (/^triggered ability$/.test(body)) return single ? null : { kind: 'stack-triggered-ability', ...ctl };
  if (body === 'spell or ability') return { kind, ...ctl };
  // "instant spell, sorcery spell, activated ability, or triggered ability" (Return the Favor, Gogo)
  if (/^instant spell, sorcery spell, activated ability, or triggered ability$/.test(body)) return { kind, filter: { types: ['Instant', 'Sorcery'] }, ...ctl };
  if (single) return /^spell$/.test(body) ? { kind: 'single-target-spell', ...ctl } : null;
  if (/^instant or sorcery spell$/.test(body)) return { kind: 'stack-spell', filter: { types: ['Instant', 'Sorcery'] }, ...ctl };
  if (/^instant spell$/.test(body)) return { kind: 'stack-spell', filter: { types: ['Instant'] }, ...ctl };
  if (/^sorcery spell$/.test(body)) return { kind: 'stack-spell', filter: { types: ['Sorcery'] }, ...ctl };
  if (/^creature spell$/.test(body)) return { kind: 'stack-spell', filter: { types: ['Creature'] }, ...ctl };
  if (/^noncreature spell$/.test(body)) return { kind: 'stack-spell', filter: { notTypes: ['Creature'] }, ...ctl };
  if (/^spell$/.test(body)) return { kind: 'stack-spell', ...ctl };
  if (/^permanent spell$/.test(body)) return { kind: 'stack-spell', filter: { notTypes: ['Instant', 'Sorcery'] }, ...ctl };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The "except ..." clause (CR 707.9a)
// ---------------------------------------------------------------------------------------------------------------

/** One "it's ..." / "it has ..." / "it isn't legendary" clause folded into `ex`; false declines the whole sentence. */
function exceptClause(clause: string, ex: CopyException): boolean {
  const t = clause.trim().replace(/^and /i, '').replace(/\.$/, '').trim();
  if (/^it isn't legendary$/i.test(t)) { ex.notLegendary = true; return true; }
  if (/^it has no abilities$/i.test(t)) { ex.loseAbilities = true; return true; }
  const has = t.match(/^(?:it )?has (.+)$/i);
  if (has) {
    if (/"/.test(has[1])) return false;                      // a quoted ability: no trigger parser here (see the header)
    const kws: Keyword[] = [];
    for (const part of has[1].split(/\s*(?:,| and )\s*/i)) {
      const w = part.trim().toLowerCase(); if (!w) continue;
      const toxic = w.match(/^toxic (\d+)$/);
      if (toxic) { kws.push('toxic'); ex.toxic = Number(toxic[1]); continue; }
      if (!KEYWORD_WORDS.has(w)) return false;
      kws.push(w as Keyword);
    }
    if (!kws.length) return false;
    ex.keywords = [...(ex.keywords ?? []), ...kws];
    return true;
  }
  const is = t.match(/^it's (.+?)( in addition to its other types)?$/i);
  if (!is) return false;
  const addition = !!is[2];
  const words = is[1].replace(/^(?:a|an) /i, '').split(/\s+/).filter(w => w.toLowerCase() !== 'and');
  const colors: Color[] = []; const types: CardType[] = []; const subtypes: string[] = [];
  for (const raw of words) {
    const w = raw.toLowerCase();
    const pt = w.match(/^(\d+)\/(\d+)$/);
    if (pt) { if (addition) return false; ex.power = Number(pt[1]); ex.toughness = Number(pt[2]); continue; }
    if (COLOR_WORD[w]) { if (addition) return false; colors.push(COLOR_WORD[w]); continue; }
    if (TYPE_WORD[w]) { types.push(TYPE_WORD[w]); continue; }
    const st = isSubtype(raw) ? subtypeWord(raw) : null;
    if (st) { subtypes.push(st); continue; }
    return false;                                            // an unknown word: decline rather than guess
  }
  if (!colors.length && !types.length && !subtypes.length && ex.power === undefined) return false;
  if (colors.length) ex.colors = colors;
  if (types.length) { if (addition) ex.addTypes = types; else ex.types = types; }
  if (subtypes.length) { if (addition) ex.addSubtypes = subtypes; else ex.subtypes = subtypes; }
  return true;
}
/** The keyword words an "except it has ..." clause may name (the parameterless ones the engine implements). */
const KEYWORD_WORDS = new Set<string>([
  'flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'haste', 'vigilance', 'reach',
  'defender', 'flash', 'hexproof', 'indestructible', 'menace', 'shroud', 'prowess', 'infect', 'wither',
]);

/** "except it's a 4/4 black Zombie" → the CopyException, or null when any part of it is not expressible. */
function parseExcept(text: string): CopyException | null {
  const ex: CopyException = {};
  // "it's 1/1 and has toxic 1" is two clauses; "it's a 1/1 black and green Insect" is one (the "and" joins colours)
  const clauses = text.split(/\s+and\s+(?=it\b)/i).flatMap(c => c.split(/\s+and\s+(?=has\b)/i));
  for (const c of clauses) if (!exceptClause(c, ex)) return null;
  return Object.keys(ex).length ? ex : null;
}

/** Split "…copy of <source>[, except <clause>]" into its two halves (the comma before "except" is always printed). */
function splitExcept(tail: string): { source: string; except: CopyException | null; ok: boolean } {
  const m = tail.match(/^(.*?), except (.+)$/i);
  if (!m) return { source: tail, except: null, ok: true };
  const ex = parseExcept(m[2]);
  return { source: m[1], except: ex, ok: ex !== null };
}

// ---------------------------------------------------------------------------------------------------------------
// Effect rules
// ---------------------------------------------------------------------------------------------------------------

const NUM = '(a|an|one|two|three|four|five|x|\\d+)';

const effects: EffectRule[] = [
  // ---- "Create a token that's a copy of target creature you control[, except it's a 4/4 black Zombie]" (CR 707.2)
  { re: new RegExp(`^create ${NUM} (tapped )?tokens? that(?:'s| are) (?:a )?cop(?:y|ies) of (.+)$`, 'i'), make: (m, ctx) => {
    const { source, except, ok } = splitExcept(m[3]);
    if (!ok) return null;
    const t = copySource(source, ctx); if (!t) return null;
    const count = ctx.num(m[1]);
    return {
      op: 'copy-permanent', target: t,
      ...(count === 1 ? {} : { count }),
      ...(m[2] ? { tapped: true } : {}),
      ...(except ? { except } : {}),
    };
  } },

  // ---- "Copy target instant or sorcery spell." / "Copy target activated or triggered ability." (CR 707.10)
  { re: /^copy (.+)$/i, make: (m) => {
    const t = stackSource(m[1]); if (!t) return null;
    return { op: 'copy-stack', target: t };
  } },

  // ---- "Change the target of target spell or ability with a single target." (CR 115.7)
  { re: /^change the targets? of (.+?) with a single target$/i, make: (m) => {
    const t = stackSource(m[1], true); if (!t || typeof t !== 'object') return null;
    return { op: 'change-targets', target: t, how: 'change-one' };
  } },

  // ---- "You may choose new targets for target spell or ability." — parse.ts strips the leading "You may " and wraps
  //      whatever comes back in a `may`, so the rule sees the bare imperative and returns the unconditional op.
  { re: /^choose new targets for (.+)$/i, make: (m) => {
    // "... for the copy": the copies the `copy-stack` earlier in this same ability just put on the stack (CR 707.10c).
    // The built-in marker rule for this sentence is unreachable (parse.ts strips the leading "You may " before the
    // table sees it), so the clause was `unknown` on every one of the ~90 cards that print it.
    if (/^(the cop(?:y|ies)|that copy)$/i.test(m[1].trim())) return { op: 'change-targets', target: 'the-copies', how: 'choose-new' };
    const t = stackSource(m[1]); if (!t || typeof t !== 'object') return null;
    return { op: 'change-targets', target: t, how: 'choose-new' };
  } },
];

// ---------------------------------------------------------------------------------------------------------------
// Static and line rules
// ---------------------------------------------------------------------------------------------------------------

const statics: StaticRule[] = [
  // "~ can't be copied." (only reached on a permanent: an instant's lines go to the spell-text branch above it)
  { name: 'cant-be-copied', make: (line) => {
    const t = line.trim().replace(/\.$/, '');
    if (!/^~ can't be copied$/i.test(t)) return null;
    return { kind: 'cant-be-copied', scope: 'self' } as StaticEffect;
  } },
];

/** "any creature on the battlefield", "a creature you control", "any artifact or creature on the battlefield". */
function enterCopyScope(phrase: string): { filter: Filter; who?: 'you' } | null {
  let t = phrase.trim().replace(/\.$/, '').toLowerCase();
  let who: 'you' | undefined;
  if (/ on the battlefield$/.test(t)) t = t.replace(/ on the battlefield$/, '');
  else if (/ you control$/.test(t)) { who = 'you'; t = t.replace(/ you control$/, ''); }
  else return null;
  t = t.replace(/^(any|a|an) /, '');
  const types: CardType[] = [];
  for (const w of t.split(/\s+(?:or\s+)?/)) { const k = TYPE_WORD[w.replace(/,$/, '')]; if (!k) return null; types.push(k); }
  if (!types.length) return null;
  return { filter: { types }, ...(who ? { who } : {}) };
}

const lines: LineRule[] = [
  // "You may have ~ enter as a copy of any creature on the battlefield[, except it's a Shapeshifter Rogue in
  // addition to its other types]." — a copy REPLACEMENT effect (CR 706.9), so it becomes an as-enters, not an
  // ability. Only a permanent card reaches this hook (an instant or sorcery never gets past the spell-text branch).
  { name: 'enter-as-copy', match: (line, ctx) => {
    if (ctx.isSpell) return false;
    const m = line.trim().replace(/\.$/, '').match(/^(you may have )?~ enters? (?:the battlefield )?as a copy of (.+)$/i);
    if (!m) return false;
    const { source, except, ok } = splitExcept(m[2]);
    if (!ok) return false;
    const scope = enterCopyScope(source); if (!scope) return false;
    ctx.addAsEnters({ kind: 'enter-as-copy', filter: scope.filter, ...(scope.who ? { who: scope.who } : {}), ...(m[1] ? { optional: true } : {}), ...(except ? { except } : {}) });
    return true;
  } },
];

const copyClone: RuleFamily = { name: 'copy-clone', effects, statics, lines };
export default copyClone;
