// Parser rules for the layers family (Phase 9.1; docs/vocabulary/layers.md).
//
// The wordings that change a permanent's types, subtypes or colours: "Target land becomes a Swamp until end of turn",
// "Each land is a Swamp in addition to its other land types", "Enchanted land is the chosen color", "~ is every
// creature type", "Until end of turn, target artifact becomes a 4/5 artifact creature". They map onto the ops the
// engine side of this family adds — `become`, `choose-type` — and onto its `type-change` static.
//
// Two disciplines, the same ones src/cards/rules/composition.ts works under:
//
//   * a rule never claims what it cannot express. The engine's layers are ADDITIVE (`types()` / `subtypes()` union
//     `o.animated` with the printed values), so any sentence that also *removes* a card type — "and loses all other
//     card types", "loses all creature types" — is declined outright rather than parsed into something that keeps
//     them. Every word of a type/colour phrase must be a known type word, a known colour word or a real subtype;
//     one unknown word makes the whole rule decline.
//   * SETTING A TYPE IS ITSELF A REMOVAL (CR 205.1a), which is the same discipline again and the one that is easy to
//     miss: a wording does not have to say "loses" to take something away. "…the new card type(s) replaces any
//     existing card types … when an effect sets one or more of an object's subtypes, the new subtype(s) replaces any
//     existing subtypes from the appropriate set". So "Target creature becomes a Frog" makes the Bear a Frog and
//     ONLY a Frog; under an additive layer it stays a Bear as well, and every Bear lord keeps pumping it. Only the
//     additive half CR 205.1b names is claimable — "in addition to its other types", and the rule's own carve-out
//     for "becomes an artifact creature" (no subtype named), which retains every prior card type and subtype —
//     plus the layers where nothing is replaced at all: colours (layer 5 replaces by rule, CR 613.1e, which is what
//     the engine does), base P/T, granted keywords, and changeling (CR 702.73a: every creature type is a superset of
//     whatever the permanent had). `replacesPrinted` below is that test.
//   * BASIC LAND TYPES are declined wholesale, whatever the wording (`typeChange` below is the single choke point).
//     A layer that grants one carries two rules this engine has no term for: CR 305.6, the intrinsic "{T}: Add {B}"
//     that comes with the type (parse.ts builds that ability from the PRINTED subtypes, once, at parse time), and CR
//     305.7, "the land loses its old land types" unless the sentence says "in addition". Claiming them would mark
//     Evil Presence, Spreading Seas, Sea's Claim, Urborg and Blanket of Night `fullyParsed` while every one of them
//     is a no-op except for switching landwalk on — the exact half-claim the first discipline forbids. `Words` still
//     RECOGNISES the type words, so the line is declined rather than misparsed, and the engine's `type-change` still
//     accepts a basic land type from a hand-written script (which is honest: the script author sees the limit).
//   * a rule returns one effect (or one static): where a sentence is really a sequence, the composition core's
//     `scoped` container carries the parts.
//
// WHY THE SAME WORDING IS REGISTERED TWICE. `parseStatic`'s built-in Aura branch matches "Enchanted <type> …" and
// `return null`s from *inside* that branch when none of its sub-templates fit — above the registry hook at the end of
// the function. So on an Aura card a static rule is never offered "Enchanted land is a Swamp." The same wordings are
// therefore also registered as a **line** rule, which parse.ts consults at its very last stop before `unknown(def,
// line)`; that hook is reached whichever way `parseStatic` declined. The static entries still matter: they are the
// documented home for the wording, and they are what fires on a non-Aura source such as Urborg.
import type { Ability, CardType, Color, Effect, Keyword, StaticEffect } from '../types.js';
import type { EffectCtx, EffectRule, LineRule, RuleFamily, StaticCard, StaticRule } from './types.js';
import { subtypeWord } from '../subtypes.js';

// ---------------------------------------------------------------------------------------------------------------
// Small vocabularies
// ---------------------------------------------------------------------------------------------------------------

const TYPE_WORD: Record<string, CardType> = {
  artifact: 'Artifact', creature: 'Creature', enchantment: 'Enchantment', land: 'Land',
  planeswalker: 'Planeswalker', battle: 'Battle', instant: 'Instant', sorcery: 'Sorcery',
};
const COLOR_WORD: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
/** Words that carry no layer of their own inside a "becomes …" phrase. */
const FILLER = new Set(['a', 'an', 'and', 'the']);
/** Wordings this family must not claim: they REMOVE a type or an ability, which the additive engine cannot do. */
const REMOVES = /\blose(?:s)? all (?:other )?(?:card|creature|land)? ?types\b|\bis no longer\b|\blose(?:s)? all abilities\b|\bloses? its other\b/i;

/** A type / colour / subtype phrase → the layer it names, or null when a word is not in the vocabulary. */
interface Words { types: CardType[]; subtypes: string[]; colors: Color[] }
function layerWords(desc: string): Words | null {
  const out: Words = { types: [], subtypes: [], colors: [] };
  const raw = desc.trim().replace(/,/g, ' ').split(/\s+/).filter(w => w.length > 0);
  if (raw.length === 0) return null;
  for (const w0 of raw) {
    const w = w0.replace(/\.$/, '');
    if (w.length === 0) continue;
    const lw = w.toLowerCase();
    if (FILLER.has(lw)) continue;
    const t = TYPE_WORD[lw]; if (t !== undefined) { if (!out.types.includes(t)) out.types.push(t); continue; }
    const c = COLOR_WORD[lw]; if (c !== undefined) { if (!out.colors.includes(c)) out.colors.push(c); continue; }
    const sub = /^[A-Z]/.test(w) ? subtypeWord(w) : null;
    if (sub !== null) { if (!out.subtypes.includes(sub)) out.subtypes.push(sub); continue; }
    return null;                                            // one unknown word and the rule declines
  }
  return out.types.length + out.subtypes.length + out.colors.length > 0 ? out : null;
}

/** The layer fields of a `become` / `type-change`, from a words bundle (empty lists are left off). */
function layerFields(w: Words): { types?: CardType[]; subtypes?: string[]; colors?: Color[] } {
  return { ...(w.types.length ? { types: w.types } : {}), ...(w.subtypes.length ? { subtypes: w.subtypes } : {}), ...(w.colors.length ? { colors: w.colors } : {}) };
}

/** A static line as the rules read it: trailing "." (and any space the reminder-text strip left before it) removed. */
const staticLine = (line: string): string => line.trim().replace(/\s*\.\s*$/, '').replace(/\s+/g, ' ');

/** "this land" / "this creature" / "~" — the source of the ability. parse.ts rewrites only some of these to `~`. */
const SELF = '(?:~|this (?:land|creature|permanent|artifact|enchantment|token|card))';
/**
 * "… in addition to its other types" is stripped in code rather than matched as an optional trailing group: every
 * regex here runs against every sentence and every line of the 34,513-card pool, and a lazy body followed by an
 * optional tail is exactly the shape that backtracks quadratically on the sentences that do NOT match.
 */
const ADDITION_RE = / in addition to (?:its|their) other (?:card |land |creature )?types$/i;
/** `[text without the "in addition" tail, whether it was there]`. */
const stripAddition = (l: string): [string, boolean] => { const out = l.replace(ADDITION_RE, ''); return [out, out.length !== l.length]; };

// ---------------------------------------------------------------------------------------------------------------
// Static wordings (shared by the `statics` entries and the `lines` fallback — see the header)
// ---------------------------------------------------------------------------------------------------------------

/** The five basic land types (CR 305.6). A layer that grants one is declined — see the second discipline above. */
const BASIC_LAND_TYPES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);
/** Does this layer's subtype field name a basic land type (literally, or through the `chosen-…` slot)? */
function grantsBasicLandType(subtypes: unknown): boolean {
  if (typeof subtypes === 'string') return subtypes === 'chosen-basic-land-type';
  return Array.isArray(subtypes) && subtypes.some(t => typeof t === 'string' && BASIC_LAND_TYPES.has(t));
}
/**
 * CR 205.1b's own carve-out: an effect that says an object "becomes an artifact creature" — those two card types and
 * no subtype — "allow[s] the object to retain all of its prior card types and subtypes". Naming a subtype as well
 * ("becomes a Shapeshifter artifact creature") keeps the card types but REPLACES the creature types, so that case is
 * caught by the subtype arm below, not here.
 */
const isArtifactCreature = (t: unknown): boolean =>
  Array.isArray(t) && t.length === 2 && t.includes('Artifact') && t.includes('Creature');

/**
 * CR 205.1a: would this layer have to take a printed type or subtype AWAY? `retained` is "the wording said the object
 * keeps what it had" — "in addition to its other types" (CR 205.1b). Setting any subtype replaces the existing
 * subtypes of that set; setting card types replaces the existing card types. The engine unions, so a layer that
 * answers true is declined rather than half-claimed (see the second discipline in the header).
 */
function replacesPrinted(fields: Record<string, unknown>, retained: boolean): boolean {
  if (retained) return false;
  const subs = fields.subtypes;
  if (typeof subs === 'string' || (Array.isArray(subs) && subs.length > 0)) return true;   // CR 205.1a, 4th sentence
  return Array.isArray(fields.types) && fields.types.length > 0 && !isArtifactCreature(fields.types);
}

/**
 * Build a `type-change`, or decline the whole wording: a basic land type (CR 305.6 / 305.7) or a set that would have
 * to replace what is printed (CR 205.1a). The single choke point for both — every static wording below goes through it.
 */
const typeChange = (fields: Record<string, unknown>, retained: boolean): StaticEffect | null =>
  (grantsBasicLandType(fields.subtypes) || replacesPrinted(fields, retained) ? null : { kind: 'type-change', ...fields } as unknown as StaticEffect);

/** "each land" / "each creature you control" → the scope and filter of a `type-change`. */
function scopeOf(subject: string): { scope: 'all' | 'you-control'; filter?: { types: CardType[] } } | null {
  const s = subject.trim().toLowerCase();
  const m = s.match(/^(?:each|all|every) ([a-z]+?)s?(?: you control)?$/);
  if (m === null) return null;
  const t = TYPE_WORD[m[1]];
  if (t === undefined && m[1] !== 'permanent') return null;
  return { scope: / you control$/.test(s) ? 'you-control' : 'all', ...(t !== undefined ? { filter: { types: [t] } } : {}) };
}

/** "Each land is a Swamp in addition to its other land types." (Urborg) — "in addition" is required: without it the
 *  land would lose its other land types (CR 305.7), which this engine cannot express. */
function eachIsInAddition(l0: string): StaticEffect | null {
  const [l, addition] = stripAddition(l0);
  if (!addition) return null;
  const m = l.match(/^((?:each|all|every) [a-z]+(?: you control)?) is an? ([A-Za-z][A-Za-z ]*)$/i);
  if (m === null) return null;
  const sc = scopeOf(m[1]); if (sc === null) return null;
  const w = layerWords(m[2]); if (w === null) return null;
  return typeChange({ ...sc, ...layerFields(w) }, true);                // `addition` above is what got us here
}

/** "~ is the chosen type [in addition to its other types]." / "~ is the chosen color." */
function selfIsChosen(l0: string, card: StaticCard): StaticEffect | null {
  const [l, addition] = stripAddition(l0);
  const m = l.match(new RegExp(`^${SELF} is the chosen (type|color)$`, 'i'));
  if (m === null) return null;
  if (m[1].toLowerCase() === 'color') return typeChange({ scope: 'self', colors: 'chosen' }, true);   // layer 5 replaces anyway
  return typeChange({ scope: 'self', subtypes: card.types.includes('Land') ? 'chosen-basic-land-type' : 'chosen-creature-type' }, addition);
}

/**
 * "Enchanted land is the chosen color." / "Equipped creature is the chosen type."
 *
 * The NOUN decides which choice slot "the chosen type" reads, exactly as `selfIsChosen` reads `card.types`: an
 * "Enchanted land …" line pairs with "As ~ enters, choose a basic land type" (Convincing Mirage, Phantasmal Terrain)
 * and must not read `chosen.creatureType`, a slot nothing on those cards ever writes. Both of those cards are then
 * declined by `typeChange` (a basic land type, CR 305.6 / 305.7) — but silently reading an empty slot was the bug,
 * and the branch is what keeps "Equipped creature is the chosen type" pointed at the creature-type slot.
 */
function attachedIsChosen(l0: string): StaticEffect | null {
  const [l, addition] = stripAddition(l0);
  const m = l.match(/^(enchanted|equipped) ([a-z]+) is the chosen (type|color)$/i);
  if (m === null) return null;
  const scope = m[1].toLowerCase() === 'enchanted' ? 'enchanted' : 'equipped';
  if (m[3].toLowerCase() === 'color') return typeChange({ scope, colors: 'chosen' }, true);           // layer 5 replaces anyway
  return typeChange({ scope, subtypes: m[2].toLowerCase() === 'land' ? 'chosen-basic-land-type' : 'chosen-creature-type' }, addition);
}

/** "~ is every creature type." (Mistform Ultimus) / "Enchanted creature is every creature type." (CR 702.73a) */
function isEveryCreatureType(l: string): StaticEffect | null {
  // `retained` is true because nothing is lost: the new creature-type set is EVERY creature type, a superset of
  // whatever the permanent had, so CR 205.1a's replacement is a no-op here.
  if (new RegExp(`^${SELF} is every creature type$`, 'i').test(l)) return typeChange({ scope: 'self', everyCreatureType: true }, true);
  const m = l.match(/^(enchanted|equipped) [a-z]+ is every creature type$/i);
  if (m === null) return null;
  return typeChange({ scope: m[1].toLowerCase() === 'enchanted' ? 'enchanted' : 'equipped', everyCreatureType: true }, true);
}

/** "Enchanted land is a Swamp." / "Enchanted creature is a Demon in addition to its other types." */
function attachedIsType(l0: string): StaticEffect | null {
  if (REMOVES.test(l0)) return null;
  const [l, addition] = stripAddition(l0);
  const m = l.match(/^(enchanted|equipped) [a-z]+ is an? ([A-Za-z][A-Za-z ]*)$/i);
  if (m === null) return null;
  const w = layerWords(m[2]); if (w === null) return null;
  return typeChange({ scope: m[1].toLowerCase() === 'enchanted' ? 'enchanted' : 'equipped', ...layerFields(w) }, addition);
}

/** Every simple static wording of this family, in order. Returns null when none of them claims the line. */
function staticFor(line: string, card: StaticCard): StaticEffect | null {
  const l = staticLine(line);
  if (REMOVES.test(l)) return null;
  return eachIsInAddition(l) ?? selfIsChosen(l, card) ?? attachedIsChosen(l) ?? isEveryCreatureType(l) ?? attachedIsType(l);
}

const statics: StaticRule[] = [
  { name: 'layers:each-x-is-y-in-addition', make: line => eachIsInAddition(staticLine(line)) },
  { name: 'layers:self-is-chosen', make: (line, card) => selfIsChosen(staticLine(line), card) },
  { name: 'layers:attached-is-chosen', make: line => attachedIsChosen(staticLine(line)) },
  { name: 'layers:is-every-creature-type', make: line => isEveryCreatureType(staticLine(line)) },
  { name: 'layers:attached-is-type', make: line => (REMOVES.test(staticLine(line)) ? null : attachedIsType(staticLine(line))) },
];

// ---------------------------------------------------------------------------------------------------------------
// Line rules — the same static wordings on an Aura, plus the compound Aura line
// ---------------------------------------------------------------------------------------------------------------

const lines: LineRule[] = [
  {
    // "Enchanted creature gets +2/+2, has flying, and is a Demon in addition to its other types." — the built-in
    // Aura template understands the "gets"/"has" half only, so the whole line arrives here; both halves are built.
    name: 'layers:aura-gets-and-is',
    match: (line, ctx) => {
      if (ctx.isSpell) return false;
      const l = staticLine(line);
      if (REMOVES.test(l)) return false;
      const [body, addition] = stripAddition(l);
      const m = body.match(/^enchanted (creature|permanent|land|artifact) gets ([+-]\d+)\/([+-]\d+)(?:, has ([a-z][a-z, ]*))?,? and is an? ([A-Za-z][A-Za-z ]*)$/i);
      if (m === null) return false;
      const kws = m[4] === undefined ? [] : kwListOf(m[4]);
      if (kws === null) return false;
      const w = layerWords(m[5]); if (w === null) return false;
      // The type half is built FIRST: when it is declined (a basic land type, or a set that would have to replace
      // what is printed) the whole line is, so the card keeps the sentence in `unparsed` instead of quietly losing
      // its second clause.
      const tc = typeChange({ scope: 'enchanted', ...layerFields(w) }, addition); if (tc === null) return false;
      const enchant = m[1].toLowerCase() === 'creature' ? 'creature' : m[1].toLowerCase() === 'land' ? 'land' : 'permanent';
      ctx.addAbility({ kind: 'static', effect: { kind: 'aura', power: Number(m[2]), toughness: Number(m[3]), keywords: kws, enchant: { kind: enchant } } as unknown as StaticEffect, text: line });
      ctx.addAbility({ kind: 'static', effect: tc, text: line });
      return true;
    },
  },
  {
    // The simple static wordings again, for the lines `parseStatic` can never offer a static rule (see the header).
    name: 'layers:static-line',
    match: (line, ctx) => {
      if (ctx.isSpell) return false;
      const st = staticFor(line, { types: ctx.def.types, subtypes: ctx.def.subtypes });
      if (st === null) return false;
      addAuraSpec(line, ctx);
      ctx.addAbility({ kind: 'static', effect: st, text: line });
      return true;
    },
  },
];

/**
 * An Aura's "Enchant <type>" line is *not* what tells the engine what it enchants: `legal.ts` reads the `enchant`
 * spec off the card's `aura` static, and defaults to "creature" when there is none. The built-in template writes that
 * static as a side effect of parsing "Enchanted creature gets +1/+1"; a card whose only Aura line is one of this
 * family's ("Enchanted land is a Swamp") would otherwise end up an Aura that can only be cast on a creature. So the
 * 0/0 carrier static is added here, from the noun the line itself names, unless the card already has one.
 */
function addAuraSpec(line: string, ctx: { def: { subtypes: string[]; abilities: { kind: string; effect?: { kind: string } }[] }; addAbility: (a: Ability) => void }): void {
  if (!ctx.def.subtypes.includes('Aura')) return;
  if (ctx.def.abilities.some(a => a.kind === 'static' && a.effect?.kind === 'aura')) return;
  const m = staticLine(line).match(/^enchanted (creature|permanent|land|artifact|player)\b/i);
  if (m === null) return;
  const w = m[1].toLowerCase();
  const kind = w === 'creature' ? 'creature' : w === 'player' ? 'player' : w === 'land' ? 'land' : w === 'artifact' ? 'artifact' : 'permanent';
  ctx.addAbility({ kind: 'static', effect: { kind: 'aura', power: 0, toughness: 0, keywords: [], enchant: { kind } } as unknown as StaticEffect, text: line });
}

/** "flying" / "flying and first strike" → keywords, or null when a word is not one. A tiny local `kwList`. */
const KEYWORDS = new Set<string>(['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'haste', 'vigilance', 'reach', 'defender', 'flash', 'hexproof', 'indestructible', 'menace', 'shroud', 'prowess', 'fear', 'intimidate', 'skulk', 'shadow', 'horsemanship', 'flanking', 'exalted', 'infect', 'wither', 'toxic']);
function kwListOf(s: string): Keyword[] | null {
  const parts = s.split(/,| and /i).map(x => x.trim().toLowerCase()).filter(x => x.length > 0);
  const out: Keyword[] = [];
  for (const p of parts) { if (!KEYWORDS.has(p)) return null; out.push(p as Keyword); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Effect rules — "… becomes …", "Choose a creature type"
// ---------------------------------------------------------------------------------------------------------------

/** "target land", "~", "target noncreature artifact you control" → the `become` target, or null. */
function becomeTarget(phrase: string, ctx: EffectCtx): unknown | null {
  const p = phrase.trim();
  if (/^~$/.test(p)) return 'self';
  if (/^(?:it|thatobj|that (?:creature|permanent|land|artifact|token))$/i.test(p)) return 'that';   // `thatobj`: parse.ts's bound-pronoun marker (9.1)
  if (!/^(?:up to (?:one|two|three) |two |three |another |other )?target /i.test(p)) return null;
  // "Target spell or permanent becomes green" (Lifelace): `become` only touches permanents, and the built-in target
  // parser silently narrows "spell or permanent" to "permanent" — so claiming it would mark the card fully parsed
  // while half of what it can target quietly does nothing. Declined instead.
  if (/\bspells?\b/i.test(p)) return null;
  return ctx.parseTarget(p);
}

/**
 * "<subject> becomes <body> [until end of turn]", after the leading "Until end of turn," (which parse.ts does not
 * strip) has been folded into the duration.
 */
function becomeRule(subject: string, body0: string, eotPrefix: boolean, ctx: EffectCtx): Effect | null {
  if (REMOVES.test(body0) || REMOVES.test(subject)) return null;
  let rest = body0.trim().replace(/\.$/, '');
  const eotSuffix = / until end of turn$/i.test(rest);
  if (eotSuffix) rest = rest.replace(/ until end of turn$/i, '');
  const [body, addition] = stripAddition(rest); rest = body.trim();
  const tgt = becomeTarget(subject, ctx); if (tgt === null) return null;
  let keywords: Keyword[] | null = null;
  let power: number | undefined; let toughness: number | undefined;
  const basePT = rest.match(/ with base power and toughness (\d+)\/(\d+)$/i);
  if (basePT !== null) { rest = rest.slice(0, rest.length - basePT[0].length).trim(); power = Number(basePT[1]); toughness = Number(basePT[2]); }
  else {
    const withTail = rest.match(/ with ([a-z][a-z, ]*)$/i);
    if (withTail !== null) { keywords = kwListOf(withTail[1]); if (keywords === null) return null; rest = rest.slice(0, rest.length - withTail[0].length).trim(); }
  }
  const leadPT = rest.match(/^(\d+)\/(\d+) (.+)$/);
  if (leadPT !== null) { power = Number(leadPT[1]); toughness = Number(leadPT[2]); rest = leadPT[3].trim(); }
  const every = /^every creature type$/i.test(rest);
  const w = every ? { types: [], subtypes: [], colors: [] } : layerWords(rest);
  if (w === null) return null;
  const fields = layerFields(w);
  if (grantsBasicLandType(w.subtypes)) return null;      // CR 305.6 / 305.7 — see the second discipline in the header
  // CR 205.1a, the same discipline: "becomes a Frog" / "becomes a Shapeshifter artifact creature" / "becomes an
  // enchantment" REPLACE what is printed, and an additive layer would leave the old types on. `everyCreatureType`
  // is exempt (`w` is empty for it — a superset, CR 702.73a) and so is the "It's still a land" retention, but that
  // clause is its own SENTENCE, which a sentence rule cannot see, so it declines here too (limit 1 in the family doc).
  if (replacesPrinted(fields, addition)) return null;
  const eot = eotPrefix || eotSuffix;
  return {
    op: 'become', target: tgt, ...fields,
    ...(every ? { everyCreatureType: true } : {}),
    ...(power !== undefined && toughness !== undefined ? { power, toughness } : {}),
    ...(keywords !== null && keywords.length ? { keywords } : {}),
    duration: eot ? 'eot' : 'permanent',
  } as unknown as Effect;
}

const effects: EffectRule[] = [
  // One template for the whole "… becomes …" family: the optional "Until end of turn," head is a capture (parse.ts
  // does not strip it) and the "… until end of turn" tail is taken off in code, so neither is a trailing optional
  // group after a lazy body — the shape that backtracks on every sentence in the pool that does not match.
  // "Target land becomes a Swamp until end of turn", "~ becomes an artifact creature", "Until end of turn, target
  // artifact or creature becomes an artifact creature with base power and toughness 4/5".
  { re: /^(until end of turn, )?(.+?) becomes? (.+)$/i, make: (m, ctx) => becomeRule(m[2], m[3], m[1] !== undefined, ctx) },
  // "It's still a land." — under an additive layer model the land never stopped being one, so the clause really is a
  // no-op; it is claimed as the composition core's empty `scoped` container rather than left unparsed.
  { re: /^it's still an? (?:land|artifact|creature|enchantment)$/i, make: () => ({ op: 'scoped', who: 'you', do: [] }) },
  // "Exchange target opponent's life total with ~'s toughness." (Tree of Perdition, CR 701.12 + 613.4b)
  { re: /^exchange target opponent's life total with ~'s toughness$/i, make: () => ({ op: 'exchange-life-toughness', target: { kind: 'opponent' } } as unknown as Effect) },
  // "Choose a creature type." / "Choose a color." / "Choose a basic land type."
  { re: /^choose a (creature type|color|basic land type)$/i, make: m => ({ op: 'choose-type', what: m[1].toLowerCase() === 'color' ? 'color' : m[1].toLowerCase() === 'creature type' ? 'creature-type' : 'basic-land-type' } as unknown as Effect) },
];

const layers: RuleFamily = { name: 'layers', effects, lines, statics };
export default layers;
