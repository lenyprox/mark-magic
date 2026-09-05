// Parser rules for the combat-restr family (Phase 9.1; docs/vocabulary/combat-restr.md).
//
// The wordings of combat restrictions and requirements — "~ must be blocked if able", "All creatures able to block ~
// do so", "~ can't be blocked except by three or more creatures", "Creatures with power less than ~'s power can't
// block it", "~ can't attack or block alone", "Creatures without flying can't block this turn", "After this phase,
// there is an additional combat phase" — mapped onto the statics and ops the engine side of 9.1 added.
//
// Three disciplines, as in src/cards/rules/composition.ts:
//
//   * a rule never claims what it cannot express. Every filter phrase goes through the small, closed vocabulary in
//     `creatureFilter` below (this file's rules get no `EffectCtx`: a StaticRule is handed only the line and the
//     card), and an unknown word makes the rule decline rather than emit a filter that matches the wrong creatures;
//   * a rule is anchored end to end. These lines are short and formulaic, and a loose `(.+)` tail on "~ can't be
//     blocked except by …" would happily claim "… except by creatures you control" and silently drop the "you
//     control";
//   * the shapes that never reach `parseStatic`'s registry hook are LINE rules instead. parse.ts's Aura branch
//     matches `^enchanted <type> (.+)$` and returns null from inside itself when none of its own templates fit, so a
//     static rule is never offered "Enchanted creature can block only creatures with flying" — but the line hook
//     just above the final `unknown(def, line)` is.
//
// Every rule here is consulted only after every built-in stage of parse.ts has declined (the contract in ./types.ts),
// so nothing a built-in already parsed can move. `npm run parse:diff` is the check.
import type { CardType, Effect, Filter, Keyword, StaticEffect, TargetSpec } from '../types.js';
import type { EffectRule, LineRule, RuleFamily, StaticCard, StaticRule } from './types.js';
import { subtypeWord } from '../subtypes.js';

// ---------------------------------------------------------------------------------------------------------------
// A small closed filter vocabulary
// ---------------------------------------------------------------------------------------------------------------

const COLOR_OF: Record<string, 'W' | 'U' | 'B' | 'R' | 'G'> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
/** The keyword words a "with …" / "without …" phrase may name (every one the engine's `hasKeyword` really answers). */
const KEYWORD_OF: Record<string, Keyword> = {
  flying: 'flying', reach: 'reach', trample: 'trample', deathtouch: 'deathtouch', lifelink: 'lifelink',
  haste: 'haste', vigilance: 'vigilance', menace: 'menace', defender: 'defender', hexproof: 'hexproof',
  indestructible: 'indestructible', shadow: 'shadow', horsemanship: 'horsemanship',
  'first strike': 'first strike', 'double strike': 'double strike',
};
const EXTRA_TYPES: Record<string, CardType> = { artifact: 'Artifact', enchantment: 'Enchantment' };

/** The number words these lines use ("two or more creatures", "power 3 or greater"). */
const COUNT_OF: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const countWord = (w: string): number | null => (/^\d+$/.test(w) ? Number(w) : COUNT_OF[w.toLowerCase()] ?? null);

/**
 * A creature description these lines use → a `Filter`, or null for anything outside the closed vocabulary above.
 * Deliberately narrow: a static rule gets no `parseFilterWords`, and a lossy guess here would silently change which
 * creatures a restriction reaches on hundreds of cards.
 *
 *   "creatures" · "black creatures" · "nonblack creatures" · "artifact creatures" · "Warriors" · "Zombie creatures"
 *   "creatures with flying" · "creatures without flying" · "creatures with power 3 or greater"
 */
export function creatureFilter(desc: string): Filter | null {
  let body = desc.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (!body) return null;
  const f: Filter = {};

  // trailing "with <keyword>" / "without <keyword>" / "with power N or greater|less"
  let m = body.match(/^(.+?) with power (\d+) or (greater|less)$/i);
  if (m) { body = m[1]; if (m[3].toLowerCase() === 'greater') f.powerGE = Number(m[2]); else f.powerLE = Number(m[2]); }
  else if ((m = body.match(/^(.+?) with (.+)$/i))) { const k = KEYWORD_OF[m[2].toLowerCase()]; if (!k) return null; body = m[1]; f.withKeyword = k; }
  else if ((m = body.match(/^(.+?) without (.+)$/i))) { const k = KEYWORD_OF[m[2].toLowerCase()]; if (!k) return null; body = m[1]; f.notKeywords = [k]; }

  // leading colour word ("black creatures", "nonblack creatures")
  if ((m = body.match(/^(non)?(white|blue|black|red|green) (.+)$/i))) {
    const c = COLOR_OF[m[2].toLowerCase()];
    if (m[1]) f.notColors = [c]; else f.colors = [c];
    body = m[3];
  }
  // leading extra card type ("artifact creatures")
  if ((m = body.match(/^(artifact|enchantment) (.+)$/i))) { f.types = [EXTRA_TYPES[m[1].toLowerCase()], 'Creature']; f.typesAll = true; body = m[2]; }
  // "non-Wall creatures": a negated subtype, in the hyphenated spelling the oracle uses
  if ((m = body.match(/^non-([A-Z][A-Za-z-]+) (.+)$/))) { const t = subtypeWord(m[1]); if (!t) return null; f.notSubtypes = [t]; body = m[2]; }

  const head = body.trim();
  if (/^creatures?$/i.test(head)) { if (!f.types) f.types = ['Creature']; return f; }
  // "Warriors" / "Zombie creatures": a capitalised subtype in the vocabulary's own spelling
  const sub = head.match(/^([A-Z][A-Za-z-]+?)s?(?: creatures?)?$/);
  if (sub) { const t = subtypeWord(sub[1]); if (t) { f.subtypes = [t]; return f; } }
  return null;
}

/** "~" / "enchanted creature" / "equipped creature" → the scope a combat static carries, or null. */
function selfScope(word: string): 'self' | 'enchanted' | 'equipped' | null {
  const w = word.trim().toLowerCase();
  return w === '~' ? 'self' : w === 'enchanted creature' ? 'enchanted' : w === 'equipped creature' ? 'equipped' : null;
}

/** The subject of a whole-battlefield restriction ("Creatures your opponents control …") → filter + side. */
function subjectFilter(desc: string): { filter: Filter; whose: 'all' | 'you' | 'opponents' } | null {
  // the controller phrase can sit in the middle ("each creature you control with menace"), so it is cut out of the
  // description rather than only stripped off the end
  const m = desc.trim().match(/^(.+?) (you control|your opponents control|an opponent controls)\b(.*)$/i);
  const filter = creatureFilter(m ? `${m[1]}${m[3]}` : desc);
  if (!filter) return null;
  const w = (m?.[2] ?? '').toLowerCase();
  return { filter, whose: w === 'you control' ? 'you' : w ? 'opponents' : 'all' };
}

// ---------------------------------------------------------------------------------------------------------------
// Static lines
// ---------------------------------------------------------------------------------------------------------------

const statics: StaticRule[] = [
  // ---- requirements (CR 509.1c)
  { name: 'must-be-blocked', make: line => {
    const t = norm(line);
    let m = t.match(/^(~|enchanted creature|equipped creature) must be blocked if able$/i);
    if (m) { const scope = selfScope(m[1])!; return { kind: 'must-be-blocked', scope }; }
    m = t.match(/^all creatures able to block (~|enchanted creature|equipped creature) do so$/i);
    if (m) { const scope = selfScope(m[1])!; return { kind: 'must-be-blocked', scope, all: true }; }
    return null;
  } },

  // ---- "can't be blocked except by N or more creatures" (menace N, CR 509.1b) — on the card itself or on a set
  { name: 'cant-be-blocked-except-by-count', make: line => {
    const t = norm(line);
    let m = t.match(/^(~|enchanted creature|equipped creature) can't be blocked except by (\w+) or more creatures$/i);
    if (m) { const n = countWord(m[2]); const scope = selfScope(m[1]); return n && scope ? { kind: 'cant-be-blocked-except-by', scope, least: n } : null; }
    m = t.match(/^each (.+?) can't be blocked except by (\w+) or more creatures$/i);
    if (m) {
      const n = countWord(m[2]); const subj = subjectFilter(m[1]);
      return n && subj ? { kind: 'cant-be-blocked-except-by', scope: 'filter', filter: subj.filter, side: subj.whose, least: n } : null;
    }
    return null;
  } },

  // ---- "can't be blocked except by <creatures>" (CR 509.1b)
  { name: 'cant-be-blocked-except-by-filter', make: line => {
    const m = norm(line).match(/^(~|enchanted creature|equipped creature) can't be blocked except by (.+)$/i);
    if (!m) return null;
    const scope = selfScope(m[1]); const f = creatureFilter(m[2]);
    return scope && f ? { kind: 'cant-be-blocked-except-by', scope, by: f } : null;
  } },

  // ---- "~ can't be blocked by Walls" — the complementary restriction (CR 509.1b)
  { name: 'cant-be-blocked-by', make: line => {
    const m = norm(line).match(/^(~|enchanted creature|equipped creature) can't be blocked by (.+)$/i);
    if (!m) return null;
    const scope = selfScope(m[1]); const f = creatureFilter(m[2]);
    return scope && f ? { kind: 'cant-be-blocked-by', scope, by: f } : null;
  } },

  // ---- "Creatures with power less than ~'s power can't block it" — the comparison is with the attacker (CR 509.1b)
  { name: 'cant-be-blocked-by-weaker', make: line => {
    const m = norm(line).match(/^creatures with power less than (~|enchanted creature|equipped creature)'s power can't block it$/i);
    if (!m) return null;
    const scope = selfScope(m[1]);
    return scope ? { kind: 'cant-be-blocked-except-by', scope, power: 'ge-source' } : null;
  } },

  // ---- "~ can't block creatures with power greater than ~'s power" — the comparison is with the blocker
  { name: 'cant-block-stronger', make: line => {
    const m = norm(line).match(/^(~|enchanted creature|equipped creature) can't block creatures with power greater than \1's power$/i);
    if (!m) return null;
    const scope = selfScope(m[1]);
    return scope ? { kind: 'cant-block-creatures', scope, power: 'gt-self' } : null;
  } },

  // ---- "~ can't block <creatures>" / "<Cowards> can't block <Warriors>" (CR 509.1b)
  { name: 'cant-block-filter', make: line => {
    const t = norm(line);
    let m = t.match(/^(~|enchanted creature|equipped creature) can't block (.+)$/i);
    if (m) { const scope = selfScope(m[1]); const f = creatureFilter(m[2]); return scope && f ? { kind: 'cant-block-creatures', scope, what: f } : null; }
    m = t.match(/^(.+?) can't block (.+)$/i);
    if (m) {
      const subj = subjectFilter(m[1]); const f = creatureFilter(m[2]);
      if (!subj || !f) return null;
      return { kind: 'cant-block-creatures', scope: 'filter', filter: subj.filter, side: subj.whose === 'all' ? 'all' : subj.whose, what: f };
    }
    return null;
  } },

  // ---- "~ can block only <creatures>" (CR 509.1b; the `~ … only creatures with flying` shape is a built-in)
  { name: 'can-block-only', make: line => {
    const m = norm(line).match(/^(~|enchanted creature|equipped creature) can block only (.+)$/i);
    if (!m) return null;
    const scope = selfScope(m[1]); const f = creatureFilter(m[2]);
    return scope && f ? { kind: 'cant-block-creatures', scope, only: f } : null;
  } },

  // ---- "~ can't attack or block alone" (CR 506.4 / 509.1b)
  { name: 'cant-act-alone', make: line => {
    const m = norm(line).match(/^(~|enchanted creature|equipped creature) can't (attack or block|attack|block) alone$/i);
    if (!m) return null;
    const scope = selfScope(m[1]); if (!scope) return null;
    const what = m[2].toLowerCase();
    return { kind: 'cant-act-alone', scope, attack: what !== 'block', block: what !== 'attack' };
  } },

  // ---- "You may have ~ assign its combat damage as though it weren't blocked" (CR 510.1a)
  { name: 'damage-as-though-unblocked', make: line => {
    const m = norm(line).match(/^you may have (~|enchanted creature|equipped creature) assign its combat damage as though it weren't blocked$/i);
    if (!m) return null;
    const scope = selfScope(m[1]);
    return scope ? { kind: 'damage-as-though-unblocked', scope } : null;
  } },

  // ---- "~ can't block and can't be blocked": two CORE statics, no family op needed (CR 509.1b, 702.x unblockable)
  { name: 'cant-block-and-cant-be-blocked', make: line => {
    if (!/^~ can't block and can't be blocked$/i.test(norm(line))) return null;
    return [{ kind: 'self-keywords', keywords: ['unblockable'], ...({ cantBlock: true } as object) } as StaticEffect];
  } },
];

// ---------------------------------------------------------------------------------------------------------------
// Whole lines the built-in Aura / Equipment branch swallows before the static registry hook is reached
// ---------------------------------------------------------------------------------------------------------------

/** The static shapes an Aura's or an Equipment's "Enchanted/Equipped creature …" line can carry. */
function attachedStatic(body: string, scope: 'enchanted' | 'equipped'): StaticEffect | null {
  const t = body.trim().replace(/\.$/, '');
  let m: RegExpMatchArray | null;
  if (/^must be blocked if able$/i.test(t)) return { kind: 'must-be-blocked', scope };
  if ((m = t.match(/^can't be blocked except by (\w+) or more creatures$/i))) { const n = countWord(m[1]); return n ? { kind: 'cant-be-blocked-except-by', scope, least: n } : null; }
  if ((m = t.match(/^can't be blocked except by (.+)$/i))) { const f = creatureFilter(m[1]); return f ? { kind: 'cant-be-blocked-except-by', scope, by: f } : null; }
  if ((m = t.match(/^can't be blocked by (.+)$/i))) { const f = creatureFilter(m[1]); return f ? { kind: 'cant-be-blocked-by', scope, by: f } : null; }
  if ((m = t.match(/^can block only (.+)$/i))) { const f = creatureFilter(m[1]); return f ? { kind: 'cant-block-creatures', scope, only: f } : null; }
  if ((m = t.match(/^can't block creatures with power (\d+) or (greater|less)$/i))) {
    const f: Filter = { types: ['Creature'] }; if (m[2].toLowerCase() === 'greater') f.powerGE = Number(m[1]); else f.powerLE = Number(m[1]);
    return { kind: 'cant-block-creatures', scope, what: f };
  }
  if ((m = t.match(/^can't (attack or block|attack|block) alone$/i))) { const w = m[1].toLowerCase(); return { kind: 'cant-act-alone', scope, attack: w !== 'block', block: w !== 'attack' }; }
  return null;
}

const lines: LineRule[] = [
  // "Enchanted creature can block only creatures with flying." — parse.ts's Aura branch matches the whole
  // "enchanted <type> …" shape and returns null from inside itself, so parseStatic's registry hook never sees these.
  { name: 'attached-combat-restriction', match: (line, ctx) => {
    if (ctx.isSpell) return false;
    const m = norm(line).match(/^(enchanted|equipped) creature (.+)$/i);
    if (!m) return false;
    const scope = m[1].toLowerCase() === 'enchanted' ? 'enchanted' : 'equipped';
    const st = attachedStatic(m[2], scope);
    if (!st) return false;
    ctx.addAbility({ kind: 'static', effect: st, text: line });
    return true;
  } },
];

// ---------------------------------------------------------------------------------------------------------------
// Sentence templates (one-shot effects)
// ---------------------------------------------------------------------------------------------------------------

/** "target creature" / "target creature an opponent controls" → the TargetSpec, or null. */
function creatureTarget(phrase: string): TargetSpec | null {
  const p = phrase.trim().toLowerCase();
  if (p === 'target creature') return { kind: 'creature' };
  if (p === 'target creature you control') return { kind: 'creature', controller: 'you' };
  if (p === 'target creature an opponent controls') return { kind: 'creature', controller: 'opponent' };
  return null;
}

const effects: EffectRule[] = [
  // "Target creature can't block ~ this turn." (Shrewd Hatchling) — the restriction names ONE attacker, which the
  // core's `cant-block` (a blanket "can't block") cannot express.
  { re: /^(target creature(?: (?:you control|an opponent controls))?) can't block ~ this turn$/i, make: m => {
    const t = creatureTarget(m[1]);
    return t ? { op: 'cant-block-source', target: t, duration: 'eot' } : null;
  } },

  // "All creatures able to block target creature this turn do so." (CR 509.1c, lure as a one-shot)
  { re: /^all creatures able to block (target creature(?: (?:you control|an opponent controls))?) this turn do so$/i, make: m => {
    const t = creatureTarget(m[1]);
    return t ? { op: 'lure', target: t, duration: 'eot' } : null;
  } },

  // "Target creature blocks this turn if able." / "They block this turn if able."
  { re: /^(target creature(?: (?:you control|an opponent controls))?) blocks this turn if able$/i, make: m => {
    const t = creatureTarget(m[1]);
    return t ? { op: 'blocks-if-able', target: t, duration: 'eot' } : null;
  } },
  { re: /^(?:they|those creatures) block this turn if able$/i, make: (): Effect => ({ op: 'blocks-if-able', target: 'those', duration: 'eot' }) },

  // "Creatures without flying can't block this turn." / "Creatures your opponents control can't block this turn."
  { re: /^(creatures?(?: [^.]*?)?) can't block this turn$/i, make: m => {
    if (/^target /i.test(m[1])) return null;                       // the built-in `cant-block` owns the target shape
    const subj = subjectFilter(m[1]);
    if (!subj) return null;
    return { op: 'restrict-blocking', whose: subj.whose, filter: subj.filter, duration: 'eot' };
  } },

  // "After this phase, there is an additional combat phase." (CR 505.1 / 506.1)
  // Every spelling of the same thing: the engine's extra combat is always followed by an extra main phase
  // (game.ts:runTurnFrom), which is what "followed by an additional main phase" and "after the second main phase"
  // both describe, so all of them are the one op.
  { re: /^after (?:this phase|this main phase|the second main phase this turn), there(?:'s| is) an additional combat phase(?: followed by an additional main phase)?$/i, make: (): Effect => ({ op: 'extra-combat' }) },
  { re: /^untap all creatures that blocked or were blocked this turn$/i, make: () => null },   // declined: no such op
];

/** The line as parseStatic's built-ins see it: trimmed, whitespace collapsed, no trailing full stop. */
function norm(line: string): string { return line.trim().replace(/\s+/g, ' ').replace(/\.$/, ''); }

/** `StaticCard` is unused by every rule here (the shapes are decided by the wording alone) — named for the contract. */
export type { StaticCard };

const combatRestr: RuleFamily = { name: 'combat-restr', statics, lines, effects };
export default combatRestr;
