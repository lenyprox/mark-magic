// Parser rules for the keyword-action family (Phase 9.1; docs/vocabulary/keyword-action.md).
//
// The printed wordings of CR 701's keyword actions — "Investigate twice", "Bolster 3", "Support 2", "Adapt 4",
// "Monstrosity 4", "Manifest dread", "Cloak the top card of your library", "Populate", "Goad target creature",
// "Incubate 4", "~ connives", "Discover 4", "Forage", "Clash with an opponent. If you win, …", "Collect evidence 6",
// "~ endures 2", "Suspect target creature", "Behold a Dragon", "Exploit", "You may exert ~ as it attacks" — mapped
// onto the ops src/engine/ops/keyword-action.ts registers.
//
// Every rule is consulted only after every built-in stage of parse.ts declined the text (src/cards/rules/types.ts),
// so nothing a built-in already parsed can move — and each rule is anchored on the whole normalised sentence, cost
// phrase or line, never on a fragment, so a rule cannot claim text it was not aimed at. Two disciplines beyond that:
//
//   * a rule never claims what it cannot express: a target phrase goes through the built-in target parser and is
//     rejected unless it comes back as a creature-shaped spec, and a sub-parse that contains `unknown` declines;
//   * a keyword action that needs to know the CARD (the exploit keyword line, the exert attack option, the ∞ ability
//     of a harnessed Infinity Stone) is a LINE rule, which is handed the `CardDef` under construction; the rest are
//     sentence rules, which reach activated-ability bodies and trigger bodies through parse.ts's own sub-parsers.
import type { Ability, Amount, Condition, Effect, Filter, TargetSpec, TriggerEvent } from '../types.js';
import type { ConditionRule, CostRule, EffectCtx, EffectRule, LineRule, RuleFamily, TriggerRule } from './types.js';
import { subtypeWord } from '../subtypes.js';

/** "3" / "x" / "two" → 3 / 'X' / 2; null for a word the vocabulary does not turn into a number. */
function amount(w: string, ctx: EffectCtx): Amount | null {
  const t = w.trim().toLowerCase();
  if (t === 'x') return 'X';
  if (/^\d+$/.test(t)) return Number(t);
  const n = ctx.num(t);
  return typeof n === 'number' && WORD_NUMBERS.has(t) ? n : null;
}
const WORD_NUMBERS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']);
/** "twice" / "three times" / "four times" → 2 / 3 / 4; "N times" → N. */
function times(w: string | undefined, ctx: EffectCtx): Amount | null {
  if (w === undefined) return 1;
  const t = w.trim().toLowerCase();
  if (t === 'twice') return 2;
  const m = t.match(/^(\w+) times$/);
  return m ? amount(m[1], ctx) : null;
}

/**
 * A creature-shaped target phrase through the built-in target parser. Anything that comes back as another kind, or
 * that the built-in parser cannot read at all, makes the rule decline — a keyword action never targets a player.
 */
function creatureTarget(phrase: string, ctx: EffectCtx): TargetSpec | null {
  const spec = ctx.parseTarget(phrase.trim().replace(/,/g, ''));
  if (!spec || (spec.kind !== 'creature' && spec.kind !== 'attacking-creature' && spec.kind !== 'blocking-creature' && spec.kind !== 'tapped-creature')) return null;
  return spec;
}

/** "a Dragon" / "an Elf" / "a Goblin" → the subtype filter a behold cost names; null when the word is not a subtype. */
function beholdFilter(word: string): Filter | null {
  const sub = subtypeWord(word.trim());
  return sub ? { subtypes: [sub] } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sentence rules
// ---------------------------------------------------------------------------------------------------------------

const effects: EffectRule[] = [
  // ---- CR 701.20a. The bare "Investigate" is a built-in; only the repeated forms reach here.
  { re: /^investigate (twice|(?:\w+) times)$/i, make: (m, ctx) => { const n = times(m[1], ctx); return n === null ? null : { op: 'investigate', amount: n }; } },

  // ---- CR 701.34a / 701.33a / 701.42a / 701.31a: the plain "<verb> N" bodies of activated abilities and triggers.
  { re: /^bolster (\d+|x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'bolster', amount: n }; } },
  // "other" is written unconditionally: on a creature source it is CR 701.33a's own word, and on a noncreature source
  // it excludes nothing (the source is not a creature, so it was never a legal target of "target creature").
  { re: /^support (\d+|x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null || typeof n !== 'number' ? null : { op: 'support', amount: n, target: { kind: 'creature', count: n, optional: true, filter: { other: true } } }; } },
  // parse.ts owns `^adapt N$` with a built-in that spells CR 701.42a out as a `conditional` (it predates this family
  // and is faithful), so only the X form reaches here — the `adapt` op itself is what a per-card script writes.
  { re: /^adapt (x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'adapt', amount: n }; } },
  { re: /^monstrosity (\d+|x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'monstrosity', amount: n }; } },

  // ---- CR 701.36a / 701.59a / 701.58a: the face-down puts.
  { re: /^manifest dread$/i, make: () => ({ op: 'manifest-dread' }) },
  { re: /^manifest the top card of your library$/i, make: () => ({ op: 'manifest', amount: 1 }) },
  { re: /^manifest the top (\w+) cards of your library$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'manifest', amount: n }; } },
  { re: /^cloak the top card of your library$/i, make: () => ({ op: 'cloak' }) },

  // ---- CR 701.29a.
  { re: /^populate$/i, make: () => ({ op: 'populate' }) },

  // ---- CR 701.39a. "goad it" / "goad that creature" read the binding frame the sentence before them left.
  { re: /^goad (target [^.]+)$/i, make: (m, ctx) => { const t = creatureTarget(m[1], ctx); return t ? { op: 'goad', target: t } : null; } },
  { re: /^goad (it|that creature)$/i, make: () => ({ op: 'goad', target: 'that' }) },

  // ---- CR 701.54a.
  { re: /^incubate (\d+|x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'incubate', amount: n }; } },
  { re: /^incubate (\d+|x) (twice|(?:\w+) times)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); const k = times(m[2], ctx); return n === null || k === null ? null : { op: 'incubate', amount: n, count: k } } },

  // ---- CR 701.48a. A self trigger's "it" has already been rewritten to `~` by parse.ts.
  { re: /^~ connives$/i, make: () => ({ op: 'connive', amount: 1, target: 'self' }) },
  { re: /^(target [^.]+|up to one target [^.]+) connives$/i, make: (m, ctx) => { const t = creatureTarget(m[1], ctx); return t ? { op: 'connive', amount: 1, target: t } : null; } },

  // ---- CR 701.56a.
  { re: /^discover (\d+|x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'discover', amount: n }; } },

  // ---- CR 701.57a / 701.19a / 701.62a.
  { re: /^forage$/i, make: () => ({ op: 'forage' }) },
  { re: /^clash with an opponent$/i, make: () => ({ op: 'clash' }) },
  { re: /^collect evidence (\d+|x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'collect-evidence', amount: n }; } },

  // ---- CR 701.64a.
  { re: /^~ endures (\d+|x)$/i, make: (m, ctx) => { const n = amount(m[1], ctx); return n === null ? null : { op: 'endure', amount: n, target: 'self' }; } },
  { re: /^(target [^.]+|up to one target [^.]+) endures (\d+|x)$/i, make: (m, ctx) => { const t = creatureTarget(m[1], ctx); const n = amount(m[2], ctx); return t && n !== null ? { op: 'endure', amount: n, target: t } : null; } },

  // ---- CR 701.61a.
  { re: /^suspect (target [^.]+|up to one target [^.]+)$/i, make: (m, ctx) => { const t = creatureTarget(m[1], ctx); return t ? { op: 'suspect', target: t } : null; } },
  { re: /^suspect (it|that creature|enchanted creature)$/i, make: m => ({ op: 'suspect', target: /enchanted/i.test(m[1]) ? 'enchanted' : 'that' }) },
  { re: /^suspect ~$/i, make: () => ({ op: 'suspect', target: 'self' }) },

  // ---- CR 701.63a as an effect ("You may behold a Dragon. If you do, …" — parse.ts wraps the `may` around it).
  { re: /^behold (?:a|an) ([A-Z][a-z]+)$/, make: m => { const f = beholdFilter(m[1]); return f ? { op: 'behold', what: f } : null; } },

  // ---- Marvel Infinity Stones.
  { re: /^harness ~$/i, make: () => ({ op: 'harness', target: 'self' }) },
];

// ---------------------------------------------------------------------------------------------------------------
// Trigger heads, conditions and cost phrases
// ---------------------------------------------------------------------------------------------------------------

const triggers: TriggerRule[] = [
  { name: 'exploits-self', make: (head): TriggerEvent | null => /^when(ever)? ~ exploits a creature$/i.test(head.trim()) ? { on: 'exploits', self: true } : null },
  { name: 'exploits-yours', make: (head): TriggerEvent | null => /^whenever a creature you control exploits a creature$/i.test(head.trim()) ? { on: 'exploits', self: false } : null },
  { name: 'clash', make: (head): TriggerEvent | null => /^whenever you clash$/i.test(head.trim()) ? { on: 'clash' } : null },
  { name: 'connives', make: (head): TriggerEvent | null => /^whenever a creature you control connives$/i.test(head.trim()) ? { on: 'connives', self: false } : null },
  { name: 'exerts', make: (head): TriggerEvent | null => /^whenever you exert a creature$/i.test(head.trim()) ? { on: 'exerts' } : null },
  { name: 'discovers', make: (head): TriggerEvent | null => /^whenever you discover$/i.test(head.trim()) ? { on: 'discovers' } : null },
  { name: 'forages', make: (head): TriggerEvent | null => /^whenever you forage$/i.test(head.trim()) ? { on: 'forages' } : null },
  { name: 'becomes-monstrous', make: (head): TriggerEvent | null => /^when(ever)? ~ becomes monstrous$/i.test(head.trim()) ? { on: 'monstrous', self: true } : null },
];

const conditions: ConditionRule[] = [
  // "Clash with an opponent. If you win, …" (CR 701.19b): the flag the clash that ran just before left on the source.
  { name: 'clash-won', make: (text): Condition | null => /^you win$/i.test(text.trim()) ? { kind: 'clash-won' } : null },
  { name: 'monstrous', make: (text): Condition | null => /^(~ is|it's) monstrous$/i.test(text.trim()) ? { kind: 'monstrous' } : null },
  { name: 'suspected', make: (text): Condition | null => /^(~ is|it's) suspected$/i.test(text.trim()) ? { kind: 'suspected' } : null },
  { name: 'harnessed', make: (text): Condition | null => /^(~ is|it's) harnessed$/i.test(text.trim()) ? { kind: 'harnessed' } : null },
];

const costs: CostRule[] = [
  { name: 'collect-evidence', make: phrase => { const m = phrase.trim().match(/^collect evidence (\d+)$/i); return m ? { collectEvidence: Number(m[1]) } : null; } },
  { name: 'forage', make: phrase => /^forage$/i.test(phrase.trim()) ? { forage: true } : null },
  { name: 'behold', make: phrase => { const m = phrase.trim().match(/^behold (?:a|an) ([A-Z][a-z]+)$/); const f = m ? beholdFilter(m[1]) : null; return f ? { beholdWhat: f } : null; } },
  { name: 'exert-self', make: phrase => /^exert (~|this creature)$/i.test(phrase.trim()) ? { exertSelf: true } : null },
];

// ---------------------------------------------------------------------------------------------------------------
// Whole lines: the shapes that need the card itself
// ---------------------------------------------------------------------------------------------------------------

/** A sub-parse that came back complete, or null. */
function known(effs: Effect[]): Effect[] | null { return effs.length && effs.every(e => e.op !== 'unknown') ? effs : null; }

const lines: LineRule[] = [
  // ---- CR 702.110a. "Exploit" is a keyword whose whole substance is a keyword action: an ETB trigger that may
  //      sacrifice a creature. The printed line names a keyword parse.ts knows of but does not implement, so it is
  //      offered here inside the keyword bail-out.
  {
    name: 'exploit-keyword',
    match: (line, ctx) => {
      if (!/^exploit$/i.test(line.trim().replace(/\.$/, '')) || ctx.isSpell) return false;
      // No `addKeyword('exploit')`: `KeywordRegistry` is types-only (src/verify/opCoverage.ts reads the keyword
      // vocabulary off `CoreKeyword`), and the whole substance of the keyword is the ETB trigger below.
      ctx.addAbility({ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'exploit' }], text: line });
      return true;
    },
  },

  // ---- CR 701.38a. "You may exert ~ as it attacks." — an optional attack trigger; "When you do, …" is its
  //      reflexive half (CR 603.12), which parse.ts's own sentence ladder parses for us.
  {
    name: 'may-exert-as-it-attacks',
    match: (line, ctx) => {
      const body = line.trim().replace(/\s+/g, ' ');
      const m = body.match(/^you may exert ~ as it attacks\.(?: when you do, (.+?)\.?)?$/i);
      if (!m || ctx.isSpell) return false;
      const effects: Effect[] = [{ op: 'exert', target: 'self' }];
      if (m[1]) {
        const rest = known(ctx.parseEffects(m[1].replace(/\bit\b/gi, '~')));
        if (!rest) return false;
        effects.push({ op: 'reflexive', when: 'you-do', effects: rest });
      }
      ctx.addAbility({ kind: 'triggered', event: { on: 'attacks', self: true }, optional: true, effects, text: line });
      return true;
    },
  },

  // ---- Marvel Infinity Stones: "∞ — <triggered ability>" is active only once the permanent has been harnessed.
  //      The built-in trigger branch never sees it (the "∞ — " prefix is not an ability word), so it lands here.
  {
    name: 'infinity-ability',
    match: (line, ctx) => {
      const m = line.trim().match(/^∞ — (When|Whenever|At) (.+?), (.+)$/);
      if (!m || ctx.isSpell) return false;
      const ev: TriggerEvent = ctx.parseTrigger(`${m[1]} ${m[2]}`);
      if (ev.on === 'unknown') return false;
      const effs = known(ctx.parseEffects(m[3]));
      if (!effs) return false;
      const ab: Ability = { kind: 'triggered', event: ev, effects: effs, intervening: { kind: 'harnessed' }, text: line };
      ctx.addAbility(ab);
      return true;
    },
  },
];

const keywordAction: RuleFamily = { name: 'keyword-action', effects, lines, triggers, conditions, costs };
export default keywordAction;
