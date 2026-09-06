// Parser rules for the planeswalker family (Phase 9.1; docs/vocabulary/planeswalker.md).
//
// The wordings that only planeswalkers print: the `Compleated` keyword line, "You get an emblem with '…'", the
// loyalty counters a walker hands to other walkers, "It becomes a 0/0 Elemental creature … that's still a land", and
// Vraska's poison shortfall. Everything else on these cards is ordinary vocabulary that other families own.
//
// Every rule here is offered a line only after every built-in stage of parse.ts declined it (src/cards/rules/types.ts),
// and each one keeps the discipline the composition family set: a rule never claims text it cannot express. Filter
// words are checked against a closed vocabulary before the (lossy) built-in filter parser sees them, a sub-parse that
// comes back `unknown` makes the whole rule decline, and a shape the ENGINE cannot carry out declines rather than
// dropping the clause. Two of those are load-bearing here: an emblem with a triggered or activated ability (the rule
// has no trigger or cost-line parser to read it with), and an emblem with a STATIC ability, which the core would
// build and then never apply — see `emblemAbilities` for why only Teferi's timing permission is claimed.
import type { Ability, CardType, Effect, Filter, ManaCost, StaticEffect, TargetSpec } from '../types.js';
import type { EffectCtx, EffectRule, LineRule, RuleFamily } from './types.js';
import { subtypeKind, subtypeWord } from '../subtypes.js';

// ---------------------------------------------------------------------------------------------------------------
// Guarded target parsing (the same discipline as src/cards/rules/composition.ts: a word the built-ins do not know
// makes the rule decline instead of producing a filter that silently means something else)
// ---------------------------------------------------------------------------------------------------------------

/** Every lower-case word these rules let through to the built-in target / filter parsers. */
const TARGET_WORDS = new Set<string>([
  'creature', 'creatures', 'land', 'lands', 'artifact', 'artifacts', 'enchantment', 'enchantments',
  'permanent', 'permanents', 'planeswalker', 'planeswalkers', 'player', 'opponent', 'token', 'tokens',
  'noncreature', 'nonland', 'nonartifact', 'nontoken', 'nonbasic', 'basic', 'legendary', 'tapped', 'untapped',
  'a', 'an', 'another', 'other', 'or', 'and', 'you', 'control', 'controls', "don't", 'up', 'to', 'one', 'two', 'three', 'target',
]);
const wordOk = (w: string): boolean => TARGET_WORDS.has(w.toLowerCase()) || subtypeWord(w) !== null;

/**
 * A target phrase → a `TargetSpec`, or null. The phrase must be one the built-in parser understands and one whose
 * every word is in the vocabulary above; a bare subtype ("target Gideon planeswalker", "up to one target Dinosaur you
 * control") has the subtype lifted onto the spec's filter, because the built-in parser only knows the type words.
 */
function target(phrase: string, ctx: EffectCtx): TargetSpec | null {
  const p = phrase.trim().replace(/,/g, '');
  for (const w of p.split(/\s+/)) if (!wordOk(w)) return null;
  // "target Gideon planeswalker" / "up to one target Dinosaur you control": a bare subtype names the permanent type
  // it belongs to (src/cards/subtypes.ts), which is the only word the built-in target parser knows — so the subtype
  // is taken out of the phrase, its type word put in when the phrase names none, and the subtype filtered back on.
  const sub = p.match(/^((?:up to (?:one|two|three) )?(?:another |other )?target )([A-Z][a-z]+)((?: .*)?)$/);
  const st = sub ? subtypeWord(sub[2]) : null;
  let plain = p;
  if (sub && st) {
    const tail = sub[3].trim();
    const typed = /^(creature|land|artifact|enchantment|permanent|planeswalker)\b/i.test(tail);
    const kind = subtypeKind(st);
    if (!typed && (kind === null || !(kind in KIND_WORD))) return null;
    plain = `${sub[1]}${typed ? tail : `${KIND_WORD[kind as keyof typeof KIND_WORD]} ${tail}`.trim()}`;
  } else if (sub && !st) return null;                       // a capitalised word that is not a subtype: not our shape
  const spec = ctx.parseTarget(plain);
  if (!spec) return null;
  if (st) spec.filter = { ...(spec.filter ?? {}), subtypes: [st] };
  // The built-in parser reads "noncreature land" / "noncreature artifacts" as a CREATURE target carrying a Land (or
  // Artifact) filter — a kind `targetOptionsFor` can never satisfy (CR 115.4). The type noun the phrase names decides
  // the kind, but ONLY when it names exactly one: "target artifact, creature, or land you control" is a union the
  // built-in already spelled as a broad kind plus an any-of `types` filter, and rewriting its kind to the LAST noun
  // would refuse the other two (CR 115.1 — Tawnos's Tinkering). The `s?` is the second half of the fix: a plural
  // ("noncreature artifacts") escaped the fixup entirely, while `\b` still keeps "noncreature" from counting.
  const nouns = new Set([...plain.matchAll(/\b(creature|land|artifact|enchantment|planeswalker|permanent)s?\b/gi)].map(x => x[1].toLowerCase()));
  if (nouns.size === 1) {
    if (spec.kind === 'creature' && !nouns.has('creature')) spec.kind = [...nouns][0] as TargetSpec['kind'];
  } else if (nouns.size > 1 && !nouns.has('permanent')) {
    // "target artifact, creature, or land you control": the built-in keeps the FIRST noun as the kind and puts the
    // union in an any-of `types` filter, so a creature target would refuse the artifact and the land (CR 115.1 —
    // Tawnos's Tinkering). The kind widens to `permanent`, but only when the filter really is that same union, so a
    // phrase whose filter says something else declines instead of being silently widened past what it said.
    const want = [...nouns].map(n => KIND_TYPE[n]);
    const have = spec.filter?.types ?? [];
    if (spec.filter?.typesAll || have.length !== want.length || !want.every(t => have.includes(t))) return null;
    spec.kind = 'permanent';
  }
  // Whatever is left must still be satisfiable: a kind whose own permanent type the filter excludes can never offer
  // anything, so the rule declines rather than shipping a target no player could ever choose (CR 115.4).
  const need = KIND_TYPE[spec.kind];
  if (need && spec.filter?.notTypes?.includes(need)) return null;
  return spec;
}
/** The permanent type a core `TargetSpec.kind` requires — what the "can this ever be satisfied?" guard above reads. */
const KIND_TYPE: Record<string, CardType> = { creature: 'Creature', land: 'Land', artifact: 'Artifact', enchantment: 'Enchantment', planeswalker: 'Planeswalker' };
/** The type word a subtype's `SubtypeKind` names in the built-in target parser's vocabulary. */
const KIND_WORD = { Creature: 'creature', Land: 'land', Artifact: 'artifact', Enchantment: 'enchantment', Planeswalker: 'planeswalker' } as const;

/** "a" / "one" / "two" / "X" / "3" as a plain count (a rule that needs a literal number declines on anything else). */
function count(word: string | undefined, ctx: EffectCtx): number | null {
  const n = ctx.num(word);
  return typeof n === 'number' ? n : null;
}

/** One effect, or the controller's own block around several (composition.md §4 `scoped`: a semantic no-op container). */
const seq = (effs: Effect[]): Effect => (effs.length === 1 ? effs[0] : { op: 'scoped', who: 'you', do: effs });

// ---------------------------------------------------------------------------------------------------------------
// Emblems (CR 114): the abilities the quoted text gives the emblem
// ---------------------------------------------------------------------------------------------------------------
/**
 * The abilities the emblem's quoted text grants, or null when this file cannot express them.
 *
 * Exactly ONE emblem wording is claimed, and the reason is engine-shaped rather than parser-shaped. An emblem sits in
 * the command zone, and `characteristics.ts:computeStaticMods` collects its sources from `staticSources(s)`, which
 * filters `allPermanents(s)` and has no registry fold beside it — so an emblem's STATIC abilities never apply.
 * "You get an emblem with 'Creatures you control get +2/+2 and have flying.'" would therefore resolve, log, spend the
 * loyalty and change nothing: an invisible wrong outcome in place of a visible gap. Those nine lines (Elspeth,
 * Gideon, Sorin, Ajani Resolute, Vivien, Garruk, Domri, Nissa Who Shakes the World) stay unparsed until the core
 * gains the fold — the patch is in this wave's `coreChangeNeeded` and in the family doc.
 *
 * Teferi, Temporal Archmage's emblem is the exception because a TIMING PERMISSION is not a characteristic of any
 * object: nothing has to fold it into `Mods`, and the family answers it from its own `legalActions` (CR 606.3),
 * which reads the command zone directly. TRIGGERED emblems do work (`triggerSources` widens `queueTriggers`), but
 * `EffectCtx` hands an effect rule no trigger parser, so those wordings decline here too.
 */
function emblemAbilities(text: string): Ability[] | null {
  const t = text.trim().replace(/\.$/, '');
  // "You may activate loyalty abilities of planeswalkers you control on any player's turn any time you could cast an
  // instant." (Teferi, Temporal Archmage's emblem) — CR 606.3 read against 117.1a
  if (/^you may activate loyalty abilities of planeswalkers you control on any player's turn any time you could cast an instant$/i.test(t)) {
    return [{ kind: 'static', effect: { kind: 'loyalty-any-time' } as StaticEffect, text: t }];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------------------------

const COUNTER = '([+-]1/[+-]1|[a-z]+)';
const N = '(a|an|one|two|three|four|five|x|\\d+)';
/** "any number of" as a `search` count: more cards than any library holds, capped by the engine at what is there. */
const ANY_NUMBER = 99;

/** The card types and colours a "… any number of <words> cards" filter may name besides a subtype. */
const CARD_WORDS = new Set(['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'instant', 'sorcery', 'basic', 'legendary', 'white', 'blue', 'black', 'red', 'green', 'colorless']);
/** "Dragon creature" / "Forest" / "basic land" → a `Filter`, or null when a word is outside that vocabulary. */
function cardFilter(words: string, ctx: EffectCtx): Filter | null {
  const parts = words.trim().split(/\s+/);
  const out: string[] = [];
  for (const w of parts) {
    if (CARD_WORDS.has(w.toLowerCase())) { out.push(w.toLowerCase()); continue; }
    const st = subtypeWord(w);
    if (!st || !/^[A-Z]/.test(w)) return null;
    out.push(st);
  }
  const f = ctx.parseFilterWords(out.join(' '));
  return f && Object.keys(f).length ? f : null;
}

const effects: EffectRule[] = [
  // ---- CR 114.1: "You get an emblem with '<text>'." The paragraph splitter cuts on ". " and on a period followed by
  //      a capital, and neither fires after the closing quote, so the sentence can carry the rest of the ability with
  //      it (Nissa's "… emblem …" Search your library …"): the tail is sub-parsed and kept beside the emblem.
  { re: /^you get an emblem with "(.+?)\.?"(?:\s+(.+))?$/i, make: (m, ctx) => {
    const abilities = emblemAbilities(m[1]);
    if (!abilities) return null;
    const emblem: Effect = { op: 'emblem', abilities, text: m[1].trim().replace(/\.$/, '') };
    if (!m[2]) return emblem;
    const tail = ctx.parseEffects(m[2]);
    if (!tail.length || tail.some(e => e.op === 'unknown')) return null;
    return seq([emblem, ...tail]);
  } },

  // ---- CR 121.1: loyalty counters a planeswalker hands out. "Put a loyalty counter on target Gideon planeswalker."
  { re: new RegExp(`^put ${N} loyalty counters? on ((?:up to one )?(?:another )?target .+)$`, 'i'), make: (m, ctx) => {
    const n = count(m[1], ctx); const t = target(m[2], ctx);
    return n === null || !t || t.kind !== 'planeswalker' ? null : { op: 'loyalty', target: t, amount: n };
  } },
  // "Put a loyalty counter on each other planeswalker you control."
  { re: new RegExp(`^put ${N} loyalty counters? on each (other )?planeswalker you control$`, 'i'), make: (m, ctx) => {
    const n = count(m[1], ctx);
    return n === null ? null : { op: 'loyalty', target: m[2] ? 'each-other-planeswalker-you-control' : 'each-planeswalker-you-control', amount: n };
  } },
  // "Put a +1/+1 counter on each creature you control and a loyalty counter on each other planeswalker you control."
  // (the " and " decomposition would leave the second half without a verb, so the whole sentence is claimed here)
  { re: new RegExp(`^put ${N} ${COUNTER} counters? on each creature you control and ${N} loyalty counters? on each (other )?planeswalker you control$`, 'i'), make: (m, ctx) => {
    const a = count(m[1], ctx); const b = count(m[3], ctx);
    if (a === null || b === null) return null;
    return seq([
      { op: 'counters', target: 'creatures-you-control', counter: m[2].toLowerCase(), amount: a },
      { op: 'loyalty', target: m[4] ? 'each-other-planeswalker-you-control' : 'each-planeswalker-you-control', amount: b },
    ]);
  } },

  // ---- CR 122.1: "If target player has fewer than nine poison counters, they get a number of poison counters equal
  //      to the difference." (Vraska, Betrayal's Sting). The shortfall is measured on resolution (CR 608.2h).
  { re: /^if target player has fewer than (\w+) poison counters, they get a number of poison counters equal to the difference$/i, make: (m, ctx) => {
    const n = count(m[1], ctx);
    return n === null ? null : { op: 'poison-to-total', target: { kind: 'player' }, total: n };
  } },

  // ---- "Search your library for any number of Forest cards, put them onto the battlefield tapped, then shuffle."
  //      The ultimate that pairs with an emblem on half the walkers that make one. CR 701.19: "any number" is a free
  //      choice from zero upwards, which is `count` capped at the library and `optional` (the picker may take fewer).
  { re: /^search your library for any number of (.+?) cards?, put (?:them|those cards) onto the battlefield( tapped)?, then shuffle$/i, make: (m, ctx) => {
    const filter = cardFilter(m[1], ctx);
    return filter ? { op: 'search', filter, to: 'battlefield', count: ANY_NUMBER, optional: true, ...(m[2] ? { tapped: true } : {}) } : null;
  } },

  // ---- "Untap it." — the pronoun the composition family's ref rule does not list (its alternation takes "them" and
  //      "that <noun>", never a bare "it"); the Nissa-shaped loyalty ability reads counters → untap → animate, all
  //      about the same land, and only the middle sentence was missing.
  { re: /^untap it$/i, make: () => ({ op: 'untap', target: 'that' }) },

  // ---- Loyalty abilities that animate a land (CR 613.1b layer 4: `animate` ADDS types, which is exactly what
  //      "that's still a land" says). parse.ts rewrites a leading "It" to `~`, so the subject word cannot be trusted;
  //      the "that's still a <type>" tail is what proves the subject is the land the previous sentence bound (a
  //      planeswalker is not a land), and `parseParagraph` refuses the paragraph when nothing bound one.
  { re: /^(~|thatobj|that land|that permanent) becomes an? (\d+)\/(\d+) ([a-z ]*?)creature(?: with (.+?))? that's still an? \w+$/i, make: (m, ctx) => {
    const kw = m[5] ? ctx.kwList(m[5]) : [];
    if (!kw) return null;
    const words = (m[4] ?? '').trim();
    const subtypes: string[] = [];
    for (const w of words ? words.split(/\s+/) : []) {
      if (w.toLowerCase() === 'and') continue;
      const st = subtypeWord(w[0].toUpperCase() + w.slice(1));
      if (!st) return null;                                    // a colour word or anything else: not this rule's shape
      subtypes.push(st);
    }
    return { op: 'animate', target: 'that', power: Number(m[2]), toughness: Number(m[3]), colors: [], types: ['Creature'], subtypes, keywords: kw, duration: 'permanent' };
  } },

  // ---- "+1: Put three +1/+1 counters on up to one target noncreature land you control." /
  //      "+2: Put a +1/+1 counter on each of up to two target creatures." — the built-in counters template does not
  //      take an "up to" target slot, so the guarded target parser is used here.
  { re: new RegExp(`^put ${N} ${COUNTER} counters? on (?:each of )?((?:up to (?:one|two|three) )?target .+)$`, 'i'), make: (m, ctx) => {
    const n = count(m[1], ctx); const t = target(m[3], ctx);
    if (n === null || !t || t.kind === 'player' || t.kind === 'opponent') return null;
    return { op: 'counters', target: t, counter: m[2].toLowerCase(), amount: n };
  } },
];

// ---------------------------------------------------------------------------------------------------------------
// Compleated (CR 107.4f)
// ---------------------------------------------------------------------------------------------------------------

/**
 * "Compleated ({B/P} can be paid with {B} or 2 life. If life was paid, this planeswalker enters with two fewer
 * loyalty counters.)" — a keyword line the built-ins record as unparsed inside their keyword bail-out.
 *
 * The engine already pays 2 life for a Phyrexian pip it cannot produce (game.ts, after `payMana`), but it records
 * nothing about having done so, so nothing downstream could know to shrink the loyalty. The line is therefore written
 * as the card's `life` ALTERNATIVE COST — the printed cost with its Phyrexian pips removed plus 2 life for each —
 * which is a choice the AI enumerates and which `castWith.alt` records, plus the family's `compleated` as-enters that
 * takes two loyalty counters off per pip (CR 107.4f, and the Vraska rulings: two fewer for each pip paid with life).
 */
const lines: LineRule[] = [
  { name: 'compleated', match: (line, ctx) => {
    if (!/^compleated$/i.test(line.trim().replace(/\.$/, ''))) return false;
    const mc = ctx.def.manaCost;
    if (!mc || !ctx.def.types.includes('Planeswalker')) return false;
    // Counted off the printed symbols, not off `manaCost.phyrexian`: the mono-coloured `{B/P}` lands there, while the
    // hybrid `{G/U/P}` Tamiyo prints is a symbol `parseManaCost` knows no case for and drops (a built-in gap recorded
    // in the family doc). Either way each printed `/P` symbol is one pip whose life route costs 2 life and two loyalty.
    const pips = mc.raw.match(/\{[^}]*\/P\}/g) ?? [];
    // Each printed `/P` symbol must be one the core's cost parser actually carries. `parseManaCost` has a case for the
    // mono-coloured `{B/P}` (it lands in `manaCost.phyrexian`, so the alt cost below really is 2 mana cheaper) and no
    // case at all for the hybrid `{G/W/P}`, which it DROPS: for Tamiyo, Compleated Sage / Ajani, Sleeper Agent /
    // Lukka, Bound to Ruin / Nahiri, the Unforgiving the parsed cost has nothing to remove, so the life route would be
    // the same mana PLUS 2 life and 2 loyalty — a strictly dominated cast the AI is right never to take, and one more
    // legal action for it to enumerate. Those four lines stay unparsed until the core parses the symbol; the gap is in
    // this wave's `coreChangeNeeded` and in the family doc.
    if (!pips.length || mc.phyrexian.length !== pips.length) return false;
    const life = 2 * pips.length;
    const mana: ManaCost = { ...mc, phyrexian: [], hybrid: mc.hybrid.map(h => [...h]), pips: [...mc.pips], raw: mc.raw.replace(/\{[^}]*\/P\}/g, '') };
    ctx.addAltCost({ id: 'life', label: `compleated (${life} life)`, cost: { mana, payLife: life }, from: 'hand' });
    ctx.addAsEnters({ kind: 'compleated', fewer: 2 * pips.length });
    return true;
  } },
];

const planeswalker: RuleFamily = { name: 'planeswalker', effects, lines };
export default planeswalker;
