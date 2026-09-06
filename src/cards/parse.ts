// Oracle-text parser: turns Scryfall oracle text into the ability AST in types.ts.
// Template based. Anything it does not understand becomes {op:'unknown'} and marks the card partially parsed,
// so the engine and AI always know exactly what they can and cannot simulate.
import type { Ability, ActivatedAbility, AbilityCost, Amount, CardDef, CardType, Color, Condition, Effect, Filter, Keyword, ManaCost, ManaSymbol, ObjectSet, StaticEffect, TargetSpec, TriggerEvent, TriggeredAbility } from './types.js';
// The parser rule registry (src/cards/rules/<family>.ts, folded by `npm run gen:registry`). Every dispatch point below
// tries its own built-in table FIRST and reaches the registry only where the built-ins have given up. That ordering is
// *per sub-parser*, which on its own is not enough: an `unknown`/`null` from a sub-parser is also the signal a LATER
// built-in stage uses to claim the line — the trigger head's greedy comma re-split, the static branch under a failed
// activated cost, the spell-text branch under a failed static, the " and " decomposition under a failed whole sentence.
// So every one of those ladders runs a complete **built-ins-only pass first** and only then a pass with the registry
// enabled; that is what the `useRegistry` parameter threaded through the sub-parsers below is for. Two consequences
// that are easy to get wrong, and that the tests in test/parser-registry.test.ts pin:
//
//   * *Which* registry a pass consults is not one array.* A ladder reaches several kinds at once — the activated
//     ladder reaches cost rules AND the condition rules behind "Activate only if ...", the sentence ladder reaches
//     effect rules AND the condition rules behind "... if <condition>", the granted-ability ladder reaches all of
//     those plus trigger rules. So every second pass is gated on the matching `ANY` flag from the registry barrel
//     (an OR over every array that pass can reach), never on one array's `.length`: gating on `COST_RULES.length`
//     alone silently drops a family that registers conditions and no costs.
//   * *The built-in tables never consult the registry, not even through a nested sub-parse.* A handful of built-in
//     templates parse their own slots (PARAGRAPH_RULES' "you may X. If you do, Y", the two "... instead if ..."
//     effect rules, parseCondition's "A or if B"); those nested calls pass `false`, because the table is the first
//     stage of *both* passes and a rule answering one of its slots would let it claim text a later built-in stage
//     owns (measured: a catch-all effect family used to move Shivan Fire, Burst Lightning and Roil Eruption, all
//     three of them cards that parsed fully without it).
//
// The one place the registry is deliberately consulted inside a built-in branch is the line loop's own condition
// slots (the intervening "if" of a trigger, "enters tapped unless ...", "enters with N counters ... if ...", "You may
// cast ~ from your graveyard as long as ..."): those branches have already fixed the line's shape by regex and only
// ask whether the condition is one we understand, and they sit above no registry retry of their own. What stays true
// is that a family only ever claims what every built-in stage declined — but the *shape* of the parse it then
// produces is its own, so always read `npm run parse:diff` (see docs/vocabulary/README.md).
import { ANY, CONDITION_RULES, COST_RULES, EFFECT_RULES as REGISTRY_EFFECT_RULES, LINE_RULES, STATIC_RULES, TRIGGER_RULES } from './rules/_registry.js';
import type { EffectCtx, LineCtx } from './rules/types.js';
import { ABILITY_WORD_RE, SECOND_FACE_LAYOUTS, secondFaceLinesOf } from './oracle-lines.js';
import { subtypeWord } from './subtypes.js';
import { SUBTYPE_KIND } from './subtype-vocab.js';

/**
 * Version of the *built-in* parser. Bump it whenever a built-in rule or the normalisation above a rule changes — that
 * is, anything that can move a card's parsed `CardDef` without a rule family being added. It is stamped into
 * data/master/parse-snapshot.json, so a mismatch tells `npm run parse:diff` that the diff it is about to print is an
 * expected re-baseline rather than an accident. Adding a family under src/cards/rules/ does **not** bump it: that
 * shows up as a different `rulesHash` instead.
 */
export const PARSER_VERSION = 5;

// ---------------------------------------------------------------------------
// Mana
// ---------------------------------------------------------------------------
/** `energyOf('{E}{E}')` -> 2. CR 118.12 / 122.1c: energy is paid from the player's own counters, so it is NOT part of a mana cost. */
export function energyOf(raw: string | null | undefined): number { return raw == null ? 0 : (raw.match(/\{E\}/g) ?? []).length; }
export function parseManaCost(raw: string | null | undefined): ManaCost | null {
  if (raw == null) return null;
  const cost: ManaCost = { generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw };
  const re = /\{([^}]+)\}/g; let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const p = m[1];
    if (/^\d+$/.test(p)) cost.generic += Number(p);
    else if (p === 'X') cost.x++;
    else if (/^[WUBRG]$/.test(p)) cost.pips.push(p as Color);
    else if (p === 'C') cost.pips.push('C');
    else if (/^[WUBRG]\/P$/.test(p)) cost.phyrexian.push(p[0] as Color);
    else if (/^[WUBRG]\/[WUBRG]\/P$/.test(p)) (cost.phyrexianHybrid ??= []).push([p[0] as Color, p[2] as Color]);   // {G/W/P}: either colour or 2 life (CR 107.4f; Ajani, Sleeper Agent) - dropped before PARSER_VERSION 5
    else if (/^[WUBRG]\/[WUBRG]$/.test(p)) cost.hybrid.push(p.split('/') as Color[]);
    else if (/^2\/[WUBRG]$/.test(p)) cost.hybrid.push([p[2] as Color, 'C']); // 'C' here stands in for "or 2 generic"; engine handles it
    else if (p === 'S') cost.generic += 1;
    // {HW} etc are ignored (Un-cards)
  }
  return cost;
}

export function manaValue(c: ManaCost | null, x = 0): number {
  if (!c) return 0;
  return c.generic + c.pips.length + c.hybrid.length + c.phyrexian.length + (c.phyrexianHybrid?.length ?? 0) + c.x * x;
}

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fifteen: 15, twenty: 20 };
/** "remove a / two / all <counter> counters from ~": `all` removes every one (the count removed is the ability's "that much", Relic Amulet). */
function removeCountersCost(counter: string, word: string): NonNullable<AbilityCost['removeCounters']> {
  return word.toLowerCase() === 'all' ? { counter, amount: 1, all: true } : { counter, amount: num(word) as number };
}
function num(s: string | undefined): Amount {
  if (s == null) return 1;
  s = s.trim().toLowerCase();
  if (s === 'x') return 'X';
  if (/^\d+$/.test(s)) return Number(s);
  if (s in NUM_WORDS) return NUM_WORDS[s];
  return 1;
}
const NUMRE = '(\\d+|X|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fifteen|twenty)';

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------
const SIMPLE_KEYWORDS: Record<string, Keyword> = {
  flying: 'flying', 'first strike': 'first strike', 'double strike': 'double strike', deathtouch: 'deathtouch', lifelink: 'lifelink',
  trample: 'trample', haste: 'haste', vigilance: 'vigilance', reach: 'reach', defender: 'defender', flash: 'flash', hexproof: 'hexproof',
  indestructible: 'indestructible', menace: 'menace', shroud: 'shroud', prowess: 'prowess', fear: 'fear', intimidate: 'intimidate', skulk: 'skulk',
  shadow: 'shadow', horsemanship: 'horsemanship', flanking: 'flanking', exalted: 'exalted', infect: 'infect', wither: 'wither',
};
const KEYWORD_RE = new RegExp(`^(${Object.keys(SIMPLE_KEYWORDS).join('|')})$`, 'i');

export function keywordFromText(s: string): Keyword | null {
  const t = s.trim().toLowerCase().replace(/\.$/, '').replace(/^~ /, '');
  if (KEYWORD_RE.test(t)) return SIMPLE_KEYWORDS[t];
  if (t === "can't be blocked" || t === 'unblockable') return 'unblockable';
  if (t === "can't block") return 'cant block';
  if (t === "can't attack") return 'cant attack';
  return null;
}

// ---------------------------------------------------------------------------
// Targets & filters
// ---------------------------------------------------------------------------
const TYPE_WORDS: Record<string, CardType> = { creature: 'Creature', artifact: 'Artifact', enchantment: 'Enchantment', land: 'Land', planeswalker: 'Planeswalker', instant: 'Instant', sorcery: 'Sorcery', battle: 'Battle' };
const COLOR_WORDS: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

function parseFilterWords(desc: string): Filter | null {
  // e.g. "nonblack creature", "artifact creature", "tapped creature", "creature with flying", "creature with power 4 or greater", "Goblin creature"
  const f: Filter = {};
  let d = desc.trim().toLowerCase().replace(/,/g, ' ');
  if (/ of the chosen type$/.test(d)) { f.chosenType = true; d = d.replace(/ of the chosen type$/, ''); }   // "creature of the chosen type"
  if (/ other than ~$/.test(d)) { f.other = true; d = d.replace(/ other than ~$/, ''); }                     // "creature other than ~"
  // "each other creature", "all other Zombies": every leading determiner goes, and "another" / "other" is the flag
  for (let m: RegExpMatchArray | null; (m = d.match(/^(an?|another|other|each|all|every)\s+/));) { if (/another|other/.test(m[1])) f.other = true; d = d.slice(m[0].length); }
  d = d.replace(/^((?:non[a-z]+,? )+)/, m => m.replace(/,/g, ''));
  if (/ dealt damage by ~ this turn$/.test(d)) { f.dealtDamageBySource = true; d = d.replace(/ dealt damage by ~ this turn$/, ''); }   // "creature dealt damage by ~ this turn"
  { const kwm = d.match(/^(.+?) with (deathtouch|lifelink|trample|haste|menace|reach|vigilance|first strike|double strike|hexproof|indestructible)$/); if (kwm) { f.withKeyword = kwm[2] as Keyword; d = kwm[1]; } }
  // "creature without flying": none of the listed keywords (Filter.notKeywords)
  { const wo = d.match(/^(.+?) without (.+)$/); if (wo) { const k = kwList(wo[2]); if (!k || !k.length) return null; f.notKeywords = k; d = wo[1]; } }
  const withM = d.match(/\s+with\s+(.+)$/);
  if (withM) {
    const w = withM[1];
    if (w === 'flying') f.flying = true;
    else if (/^power (\d+) or greater$/.test(w)) f.powerGE = Number(RegExp.$1);
    else if (/^power (\d+) or less$/.test(w)) f.powerLE = Number(RegExp.$1);
    else if (/^toughness (\d+) or less$/.test(w)) f.toughnessLE = Number(RegExp.$1);
    else if (/^toughness (\d+) or greater$/.test(w)) f.toughnessGE = Number(RegExp.$1);
    else if (/^mana value (\d+) or less$/.test(w)) f.mvLE = Number(RegExp.$1);
    else if (/^mana value (\d+) or greater$/.test(w)) f.mvGE = Number(RegExp.$1);
    else if (/^mana value (\d+)$/.test(w)) f.mvEQ = Number(RegExp.$1);
    else if (/^mana cost \{0\} or \{1\}$/.test(w)) f.mvLE = 1;
    else return null;
    d = d.slice(0, withM.index);
  }
  const words = d.split(/\s+/).filter(Boolean);
  // "artifact creature", "land creature": adjacent type words are every one of them (Filter.typesAll); "artifact or
  // creature", "artifacts and creatures" (a list with a conjunction anywhere in it) stays any-of
  const anyOf = words.some(w => w === 'or' || w === 'and' || w === 'and/or');
  for (let w of words) {
    if (w === 'or' || w === 'and' || w === 'and/or' || w === 'a' || w === 'an') continue;   // a type list is any-of
    if (w === 'basic') { f.basic = true; continue; }
    if (w === 'legendary' || w === 'snow') { (f.supertypes ??= []).push(w[0].toUpperCase() + w.slice(1)); continue; }
    if (w === 'nonlegendary' || w === 'nonsnow') { (f.notSupertypes ??= []).push(w[3].toUpperCase() + w.slice(4)); continue; }
    if (w === 'historic' || w === 'multicolored' || w === 'monocolored' || w === 'kicked' || w === 'transformed' || w === 'enchanted' || w === 'equipped' || w === 'modified') { (f as Record<string, unknown>)[w] = true; continue; }
    if (/^\d+\/\d+$/.test(w)) { const [pw, tg] = w.split('/'); f.powerEQ = Number(pw); f.toughnessEQ = Number(tg); continue; }   // "1/1 creature"
    if (/^non-/.test(w)) { const sub = subtypeWord(w.slice(4)); if (!sub) return null; (f.notSubtypes ??= []).push(sub); continue; }   // "non-Angel creature"
    if (w in TYPE_WORDS) (f.types ??= []).push(TYPE_WORDS[w]);
    else if (w.startsWith('non') && w.slice(3) in TYPE_WORDS) (f.notTypes ??= []).push(TYPE_WORDS[w.slice(3)]);
    else if (w in COLOR_WORDS) (f.colors ??= []).push(COLOR_WORDS[w]);
    else if (w.startsWith('non') && w.slice(3) in COLOR_WORDS) (f.notColors ??= []).push(COLOR_WORDS[w.slice(3)]);
    else if (w === 'colorless') f.colorless = true;
    else if (w === 'tapped') f.tapped = true;
    else if (w === 'untapped') f.untapped = true;
    else if (w === 'token' || w === 'tokens') f.token = true;
    else if (w === 'nontoken') f.nontoken = true;
    else if (w === 'attacking') f.attacking = true;
    else if (w === 'blocking') f.blocking = true;
    else if (w === 'nonbasic') f.nonbasic = true;
    else if (w === 'permanent' || w === 'permanents' || w === 'spell' || w === 'spells' || w === 'card' || w === 'cards' || w === 'basic') continue;
    else {
      // plural type words: creatures, artifacts...
      const sing = w.replace(/s$/, '');
      if (sing in TYPE_WORDS) (f.types ??= []).push(TYPE_WORDS[sing]);
      else if (sing.startsWith('non') && sing.slice(3) in TYPE_WORDS) (f.notTypes ??= []).push(TYPE_WORDS[sing.slice(3)]);
      else {
        // a subtype (Goblin, Elves, Plains, Heroes) — in the vocabulary's own spelling. Any other word ("you control",
        // "of their choice", "non-Angel", "legendary", "Target") is a restriction this parser has no field for, and a
        // filter that silently drops it matches the wrong objects: decline instead (src/cards/subtypes.ts).
        const sub = subtypeWord(w); if (!sub) return null;
        (f.subtypes ??= []).push(sub);
      }
    }
  }
  if (f.types && f.types.length > 1 && !anyOf) f.typesAll = true;
  return f;
}

// Parse a "target ..." phrase. Returns spec and the remaining text with the phrase removed.
function parseTarget(phrase: string): TargetSpec | null {
  let p = phrase.trim().toLowerCase().replace(/[.,]$/, '');
  const spec: TargetSpec = { kind: 'creature' };
  let m: RegExpMatchArray | null;
  // "target creature and target land" (CR 115.3: two instances of "target"): one `multi` spec per instance, in printed order
  { const both = p.match(/^(.+?) and ((?:another |other )?target .+)$/); if (both && /^(?:up to \w+ |two |three |another |other )*target /.test(both[1])) { const a = parseTarget(both[1]); const b = parseTarget(both[2]); return a && b ? { kind: 'multi', specs: [a, b] } : null; } }
  const upto = p.match(/^up to (one|two|three|four|x|\d+) /);
  if (upto) { spec.optional = true; spec.count = num(upto[1]) as number | 'X'; p = p.slice(upto[0].length); }
  const twoM = p.match(/^(two|three) /);
  if (twoM) { spec.count = num(twoM[1]) as number; p = p.slice(twoM[0].length); }
  if (p === 'any target') return { ...spec, kind: 'any' };
  const otherM = p.match(/^(?:another|other) /);
  if (otherM) { spec.filter = { ...spec.filter, other: true }; p = p.slice(otherM[0].length); }
  if (!p.startsWith('target ')) return null;
  p = p.slice(7);
  let controller: TargetSpec['controller'] | undefined;
  const ctl = p.match(/ (you control|an opponent controls|you don't control)$/);
  if (ctl) { controller = ctl[1] === 'you control' ? 'you' : 'opponent'; p = p.slice(0, ctl.index); }
  p = p.replace(/s\b/, (m, off) => (off > 0 ? '' : m)); // crude de-plural for "target creatures"
  if (p === 'spell or nonland permanent') return { ...spec, kind: 'spell-or-nonland-permanent', ...(controller ? { controller } : {}) };
  const mvSpell = p.match(/^(spell|creature spell|noncreature spell|instant or sorcery spell) with mana value (\d+)( or less| or greater)?$/);
  if (mvSpell) { const kind = mvSpell[1] === 'spell' ? 'spell' : mvSpell[1] === 'creature spell' ? 'creature-spell' : 'noncreature-spell'; const n = Number(mvSpell[2]); return { ...spec, kind, filter: { ...spec.filter, ...(mvSpell[3] === ' or less' ? { mvLE: n } : mvSpell[3] === ' or greater' ? { mvGE: n } : { mvEQ: n }) } }; }
  if (p === 'activated or triggered ability') return { ...spec, kind: 'ability' };
  if (p === 'card from a graveyard' || p === 'card in a graveyard') return { ...spec, kind: 'graveyard-card' };
  if ((m = p.match(/^(.+?) card from a graveyard$/))) { const f = parseFilterWords(m[1]); if (f) return { ...spec, kind: 'graveyard-card', filter: { ...spec.filter, ...f } }; }
  if (p === 'artifact, enchantment, or nonbasic land') return { ...spec, kind: 'artifact-enchantment-or-nonbasic-land', ...(controller ? { controller } : {}) };
  const map: Record<string, TargetSpec['kind']> = {
    'creature': 'creature', 'player': 'player', 'opponent': 'opponent', 'permanent': 'permanent', 'spell': 'spell',
    'creature or player': 'creature-or-player', 'creature or planeswalker': 'creature-or-planeswalker', 'planeswalker': 'planeswalker',
    'artifact': 'artifact', 'enchantment': 'enchantment', 'land': 'land', 'nonland permanent': 'nonland-permanent',
    'artifact or enchantment': 'artifact-or-enchantment', 'creature spell': 'creature-spell', 'noncreature spell': 'noncreature-spell',
    'attacking creature': 'attacking-creature', 'blocking creature': 'blocking-creature', 'attacking or blocking creature': 'attacking-creature', 'tapped creature': 'tapped-creature',
    'instant or sorcery spell': 'noncreature-spell', 'instant spell': 'noncreature-spell', 'sorcery spell': 'noncreature-spell', 'player or planeswalker': 'player', 'creature, player, or planeswalker': 'any', 'creature or player or planeswalker': 'any', 'creature an opponent controls': 'creature', 'creature you control': 'creature',
  };
  if (p in map) return { ...spec, kind: map[p], ...(controller ? { controller } : {}) };
  // "target artifact, creature, or planeswalker spell", "target legendary spell": a spell with a filter (the plain kinds are in the map above)
  if ((m = p.match(/^(.+?) spell$/)) && !/\bspell\b/.test(m[1])) { const f = parseFilterWords(m[1]); if (f) return { ...spec, kind: 'spell', filter: { ...spec.filter, ...f } }; }
  // filtered creature / permanent: "nonblack creature", "creature with flying", "Goblin creature", "artifact creature"
  if (/creature$|creature with|creature without|creature dealt damage by ~ this turn$|permanent$|permanent with|creature or player$|land$|artifact$|enchantment$/.test(p) || /^[a-z]+ (creature|permanent)/.test(p)) {
    // whole words only: "noncreature land you control" is a LAND (the substring test read `creature` inside `noncreature`
    // and built the unsatisfiable creature-that-is-not-a-creature spec; Nissa, Who Shakes the World - PARSER_VERSION 5)
    const has = (w: string) => new RegExp(`(^|[^a-z])${w}s?($|[^a-z])`).test(p);
    const f = parseFilterWords(p);
    if (!f) return null;
    // "target Island" / "target Plains or Island" name a land by its land type alone (the old substring test found `land` inside `Island`)
    const landTypes = !!f.subtypes?.length && f.subtypes.every(t => SUBTYPE_KIND[t] === 'Land');
    const base = has('permanent') ? 'permanent' : has('creature') ? 'creature' : has('land') || landTypes ? 'land' : has('artifact') && has('enchantment') ? 'artifact-or-enchantment' : has('artifact') ? 'artifact' : 'enchantment';
    if (base === 'permanent' && f.notTypes?.includes('Land') && !f.types) { delete f.notTypes; return { ...spec, kind: 'nonland-permanent', ...(controller ? { controller } : {}), filter: { ...spec.filter, ...f } }; }
    return { ...spec, kind: base as TargetSpec['kind'], ...(controller ? { controller } : {}), filter: { ...spec.filter, ...f } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Effects (one sentence -> Effect)
// ---------------------------------------------------------------------------
const TGT = '((?:up to (?:one|two|three|four|X) )?(?:two |three )?(?:(?:another |other )?target [^.,]+?|any target))';

interface Rule { re: RegExp; make: (m: RegExpMatchArray) => Effect | null }
/** A lore counter on a Saga raises a `chapter` event the plain `counters` op cannot: the saga family's `saga-lore`
 *  owns every "put … lore counter(s) on …" wording (9.1), so the built-in counter templates decline it. */
const isLore = (word: string): boolean => word.toLowerCase() === 'lore';
const EFFECT_RULES: Rule[] = [
  // damage
  { re: new RegExp(`^~ deals ${NUMRE} damage to ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'damage', amount: num(m[1]), target: t }; } },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each opponent$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-opponent' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each player$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-player' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each creature$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-creature' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each other creature$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-other-creature' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each creature and each player$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-creature-and-player' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each creature and each planeswalker$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-creature' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each creature with flying$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-flying-creature' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each creature without flying$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-nonflying-creature' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each creature you don't control$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-creature-you-dont-control' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to each creature an opponent controls$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: 'each-opponent-creature' }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to ${TGT} and ${NUMRE} damage to (?:you|its controller|that creature's controller|that player)$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'damage', amount: num(m[1]), target: t }; } },
  { re: new RegExp(`^~ deals ${NUMRE} damage divided as you choose among (?:one|one, two, or three|any number of) targets?$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: { kind: 'any', count: 3, optional: true }, divided: true }) },
  { re: new RegExp(`^~ deals damage equal to its power to ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'damage', amount: { count: 'power-of-source' }, target: t }; } },
  { re: new RegExp(`^~ deals damage to ${TGT} equal to the number of creatures you control$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'damage', amount: { count: 'creatures-you-control' }, target: t }; } },
  { re: new RegExp(`^~ deals damage equal to the number of creatures you control to ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'damage', amount: { count: 'creatures-you-control' }, target: t }; } },
  { re: new RegExp(`^(?:it|that creature|that permanent) deals damage equal to its power to ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'bite', target: t }; } },
  { re: new RegExp(`^${TGT} deals damage equal to its power to (?:another )?${TGT}$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'bite', target: t }; } },
  { re: new RegExp(`^${TGT} fights (?:another )?${TGT}$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'fight', target: t, self: false }; } },
  { re: new RegExp(`^~ fights ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'fight', target: t, self: true }; } },
  // destroy / exile
  { re: new RegExp(`^destroy ${TGT}(?:\\. it can't be regenerated)?$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'destroy', target: t }; } },
  { re: /^destroy all creatures$/i, make: () => ({ op: 'destroy', target: 'all-creatures' }) },
  { re: /^destroy all (?:other )?creatures\. they can't be regenerated$/i, make: () => ({ op: 'destroy', target: 'all-creatures', noRegenerate: true }) },
  { re: /^destroy all artifacts$/i, make: () => ({ op: 'destroy', target: 'all-artifacts' }) },
  { re: /^destroy all enchantments$/i, make: () => ({ op: 'destroy', target: 'all-enchantments' }) },
  { re: /^destroy all lands$/i, make: () => ({ op: 'destroy', target: 'all-lands' }) },
  { re: /^destroy all nonland permanents$/i, make: () => ({ op: 'destroy', target: 'all-nonland' }) },
  { re: /^destroy all artifacts, creatures, and enchantments$/i, make: () => ({ op: 'destroy', target: 'all-nonland' }) },
  { re: /^destroy all creatures you don't control$/i, make: () => ({ op: 'destroy', target: 'all-opponent-creatures' }) },
  { re: /^destroy all tapped creatures$/i, make: () => ({ op: 'destroy', target: 'all-tapped-creatures' }) },
  { re: /^destroy all (.+?) creatures$/i, make: m => { const f = parseFilterWords(m[1] + ' creature'); return f && { op: 'destroy', target: 'all-creatures', filter: f }; } },
  { re: new RegExp(`^exile ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'exile', target: t }; } },
  { re: /^exile all creatures$/i, make: () => ({ op: 'exile', target: 'all-creatures' }) },
  { re: new RegExp(`^exile ${TGT} until ~ leaves the battlefield$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'exile', target: t, until: 'leaves' }; } },
  { re: new RegExp(`^exile ${TGT} from (?:a|target player's) graveyard$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'exile', target: t, from: 'graveyard' }; } },
  // counterspells
  { re: new RegExp(`^counter ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'counter', target: t }; } },
  { re: new RegExp(`^counter ${TGT} unless its controller pays \\{(\\d+)\\}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'counter', target: t, unlessPay: Number(m[2]) }; } },
  // cards
  { re: new RegExp(`^draw ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'draw', amount: num(m[1]), who: 'you' }) },
  { re: new RegExp(`^you draw ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'draw', amount: num(m[1]), who: 'you' }) },
  { re: new RegExp(`^target player draws ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'draw', amount: num(m[1]), who: 'target-player' }) },
  { re: new RegExp(`^each player draws ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'draw', amount: num(m[1]), who: 'each-player' }) },
  { re: new RegExp(`^draw ${NUMRE} cards?, then discard ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'loot', draw: num(m[1]) as number, discard: num(m[2]) as number }) },
  { re: new RegExp(`^discard ${NUMRE} cards?, then draw ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'loot', draw: num(m[2]) as number, discard: num(m[1]) as number }) },
  { re: new RegExp(`^draw ${NUMRE} cards? and (?:you )?lose ${NUMRE} life$`, 'i'), make: m => ({ op: 'choose-mode', modes: [[{ op: 'draw', amount: num(m[1]), who: 'you' }, { op: 'lose-life', amount: num(m[2]), who: 'you' }]], count: 1 }) },
  { re: new RegExp(`^you draw ${NUMRE} cards? and (?:you )?lose ${NUMRE} life$`, 'i'), make: m => ({ op: 'choose-mode', modes: [[{ op: 'draw', amount: num(m[1]), who: 'you' }, { op: 'lose-life', amount: num(m[2]), who: 'you' }]], count: 1 }) },
  { re: new RegExp(`^target player discards ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'discard', amount: num(m[1]), who: 'target-player' }) },
  { re: new RegExp(`^target player discards ${NUMRE} cards? at random$`, 'i'), make: m => ({ op: 'discard', amount: num(m[1]), who: 'target-player', random: true }) },
  { re: new RegExp(`^target opponent discards ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'discard', amount: num(m[1]), who: 'target-player' }) },
  { re: new RegExp(`^each opponent discards ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'discard', amount: num(m[1]), who: 'each-opponent' }) },
  { re: new RegExp(`^each player discards ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'discard', amount: num(m[1]), who: 'each-player' }) },
  { re: /^target player discards their hand$/i, make: () => ({ op: 'discard', amount: 'hand', who: 'target-player' }) },
  { re: new RegExp(`^discard ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'discard', amount: num(m[1]), who: 'you' }) },
  { re: new RegExp(`^target player mills ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'mill', amount: num(m[1]), who: 'target-player' }) },
  { re: new RegExp(`^mill ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'mill', amount: num(m[1]), who: 'you' }) },
  { re: new RegExp(`^each opponent mills ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'mill', amount: num(m[1]), who: 'each-opponent' }) },
  { re: /^scry (\d+)$/i, make: m => ({ op: 'scry', amount: Number(m[1]) }) },
  { re: /^surveil (\d+)$/i, make: m => ({ op: 'surveil', amount: Number(m[1]) }) },
  { re: /^(?:you )?scry x$/i, make: () => ({ op: 'scry', amount: 'X' }) },
  { re: /^(?:you )?surveil x$/i, make: () => ({ op: 'surveil', amount: 'X' }) },
  // life
  { re: new RegExp(`^you gain ${NUMRE} life$`, 'i'), make: m => ({ op: 'gain-life', amount: num(m[1]), who: 'you' }) },
  { re: new RegExp(`^target player gains ${NUMRE} life$`, 'i'), make: m => ({ op: 'gain-life', amount: num(m[1]), who: 'target-player' }) },
  // the frame's object (Abattoir Ghoul's dead creature, a sacrificed creature): a self trigger's "its" has become "~'s" before this (parseCard), so "its" here is never the source
  { re: new RegExp(`^you gain life equal to (?:its|that creature's) (power|toughness)$`, 'i'), make: m => ({ op: 'gain-life', amount: { prop: m[1].toLowerCase() as 'power' | 'toughness', of: 'that' }, who: 'you' }) },
  { re: new RegExp(`^you gain life equal to the number of creatures you control$`, 'i'), make: () => ({ op: 'gain-life', amount: { count: 'creatures-you-control' }, who: 'you' }) },
  { re: new RegExp(`^you lose ${NUMRE} life$`, 'i'), make: m => ({ op: 'lose-life', amount: num(m[1]), who: 'you' }) },
  { re: new RegExp(`^target player loses ${NUMRE} life$`, 'i'), make: m => ({ op: 'lose-life', amount: num(m[1]), who: 'target-player' }) },
  { re: new RegExp(`^target opponent loses ${NUMRE} life$`, 'i'), make: m => ({ op: 'lose-life', amount: num(m[1]), who: 'target-player' }) },
  { re: new RegExp(`^each opponent loses ${NUMRE} life$`, 'i'), make: m => ({ op: 'lose-life', amount: num(m[1]), who: 'each-opponent' }) },
  { re: new RegExp(`^each player loses ${NUMRE} life$`, 'i'), make: m => ({ op: 'lose-life', amount: num(m[1]), who: 'each-player' }) },
  { re: new RegExp(`^target player loses ${NUMRE} life and you gain ${NUMRE} life$`, 'i'), make: m => ({ op: 'choose-mode', modes: [[{ op: 'lose-life', amount: num(m[1]), who: 'target-player' }, { op: 'gain-life', amount: num(m[2]), who: 'you' }]], count: 1 }) },
  { re: new RegExp(`^each opponent loses ${NUMRE} life and you gain ${NUMRE} life$`, 'i'), make: m => ({ op: 'choose-mode', modes: [[{ op: 'lose-life', amount: num(m[1]), who: 'each-opponent' }, { op: 'gain-life', amount: num(m[2]), who: 'you' }]], count: 1 }) },
  { re: new RegExp(`^${TGT} loses ${NUMRE} life and you gain ${NUMRE} life$`, 'i'), make: m => ({ op: 'choose-mode', modes: [[{ op: 'lose-life', amount: num(m[2]), who: 'target-player' }, { op: 'gain-life', amount: num(m[3]), who: 'you' }]], count: 1 }) },
  { re: /^your life total becomes (\d+)$/i, make: m => ({ op: 'set-life', amount: Number(m[1]), who: 'you' }) },
  // pump
  { re: new RegExp(`^${TGT} gets ([+-]\\d+|[+-]X)/([+-]\\d+|[+-]X) until end of turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'pump', target: t, power: pm(m[2]), toughness: pm(m[3]), duration: 'eot' }; } },
  { re: new RegExp(`^${TGT} gets ([+-]\\d+)/([+-]\\d+) and gains (.+?) until end of turn$`, 'i'), make: m => { const t = parseTarget(m[1]); const k = kwList(m[4]); return t && k && { op: 'pump', target: t, power: pm(m[2]), toughness: pm(m[3]), keywords: k, duration: 'eot' }; } },
  { re: new RegExp(`^${TGT} gains (.+?) until end of turn$`, 'i'), make: m => { const t = parseTarget(m[1]); const k = kwList(m[2]); return t && k && { op: 'grant-keyword', target: t, keywords: k, duration: 'eot' }; } },
  { re: /^~ gets ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X) until end of turn$/i, make: m => ({ op: 'pump', target: 'self', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  { re: /^(up to \w+ target .+?) each get ([+-]\d+)\/([+-]\d+)(?: and gain (.+?))? until end of turn$/i, make: m => { const t = parseTarget(m[1]); if (!t) return null; const kw = m[4] ? kwList(m[4]) : []; return kw ? { op: 'pump', target: t, power: Number(m[2]), toughness: Number(m[3]), keywords: kw, duration: 'eot' } : null; } },
  { re: /^~ gets ([+-]\d+)\/([+-]\d+) and gains (.+?) until end of turn$/i, make: m => { const k = kwList(m[3]); return k && { op: 'pump', target: 'self', power: pm(m[1]), toughness: pm(m[2]), keywords: k, duration: 'eot' }; } },
  { re: /^~ gains (.+?) until end of turn$/i, make: m => { const k = kwList(m[1]); return k && { op: 'grant-keyword', target: 'self', keywords: k, duration: 'eot' }; } },
  { re: /^creatures you control get ([+-]\d+)\/([+-]\d+) until end of turn$/i, make: m => ({ op: 'pump', target: 'creatures-you-control', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  { re: /^creatures you control get ([+-]\d+)\/([+-]\d+) and gain (.+?) until end of turn$/i, make: m => { const k = kwList(m[3]); return k && { op: 'pump', target: 'creatures-you-control', power: pm(m[1]), toughness: pm(m[2]), keywords: k, duration: 'eot' }; } },
  { re: /^creatures you control gain (.+?) until end of turn$/i, make: m => { const k = kwList(m[1]); return k && { op: 'grant-keyword', target: 'creatures-you-control', keywords: k, duration: 'eot' }; } },
  { re: /^other creatures you control get ([+-]\d+)\/([+-]\d+) until end of turn$/i, make: m => ({ op: 'pump', target: 'other-creatures-you-control', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  { re: /^attacking creatures (?:you control )?get ([+-]\d+)\/([+-]\d+) until end of turn$/i, make: m => ({ op: 'pump', target: 'attacking-creatures', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  { re: /^all creatures get ([+-]\d+)\/([+-]\d+) until end of turn$/i, make: m => ({ op: 'pump', target: 'all-creatures', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  // bounce
  { re: new RegExp(`^return ${TGT} to (?:its|their) owner's hand$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'bounce', target: t, to: 'hand' }; } },
  { re: new RegExp(`^return ${TGT} to (?:its|their) owner's hands?$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'bounce', target: t, to: 'hand' }; } },
  { re: new RegExp(`^put ${TGT} on top of its owner's library$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'bounce', target: t, to: 'library-top' }; } },
  { re: new RegExp(`^put ${TGT} on the bottom of its owner's library$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'bounce', target: t, to: 'library-bottom' }; } },
  { re: /^return all creatures to their owners' hands$/i, make: () => ({ op: 'bounce', target: 'all-creatures', to: 'hand' }) },
  { re: /^return ~ to its owner's hand$/i, make: () => ({ op: 'bounce', target: 'self', to: 'hand' }) },
  { re: new RegExp(`^return ${TGT} from your graveyard to your hand$`, 'i'), make: m => { const f = parseFilterWords(m[1].replace(/^target /, '').replace(/ card$/, '')); return f && { op: 'return-from-graveyard', what: f, to: 'hand', target: true }; } },
  { re: new RegExp(`^return ${TGT} from your graveyard to the battlefield$`, 'i'), make: m => { const f = parseFilterWords(m[1].replace(/^target /, '').replace(/ card$/, '')); return f && { op: 'return-from-graveyard', what: f, to: 'battlefield', target: true }; } },
  // tokens
  { re: new RegExp(`^create ${NUMRE} (\\d+)/(\\d+) ([a-z ]+?) creature tokens?(?: with (.+?))?(?: that's tapped and attacking)?$`, 'i'), make: m => tokenEffect(m) },
  { re: new RegExp(`^create ${NUMRE} tapped (\\d+)/(\\d+) ([a-z ]+?) creature tokens?(?: with (.+?))?$`, 'i'), make: m => { const t = tokenEffect(m); return t && t.op === 'token' ? { ...t, tapped: true } : t; } },
  { re: new RegExp(`^create ${NUMRE} (\\d+)/(\\d+) ([a-z ]+?) (?:artifact|enchantment) creature tokens?(?: with (.+?))?$`, 'i'), make: m => { const t = tokenEffect(m); if (!t || t.op !== 'token') return t; const kind = /enchantment creature/i.test(m[0]) ? 'Enchantment' : 'Artifact'; return { ...t, types: [kind, 'Creature'] }; } },
  { re: new RegExp(`^create ${NUMRE} legendary (\\d+)/(\\d+) ([a-z ]+?) creature tokens? named ([^.]+?)(?: with (.+?))?$`, 'i'), make: m => tokenEffect(m, 5) },
  { re: new RegExp(`^create ${NUMRE} (\\d+)/(\\d+) ([a-z ]+?) creature tokens? named ([^.]+?)(?: with (.+?))?$`, 'i'), make: m => tokenEffect(m, 5) },
  { re: new RegExp(`^create ${NUMRE} (?:tapped )?treasure tokens?$`, 'i'), make: m => ({ op: 'token', count: num(m[1]), power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Treasure'], keywords: [], treasure: true, name: 'Treasure' }) },
  { re: new RegExp(`^create ${NUMRE} (\\d+)/(\\d+) ([a-z ]+?) creature tokens? with (.+?)$`, 'i'), make: m => tokenEffect(m) },
  // counters
  { re: new RegExp(`^put ${NUMRE} \\+1/\\+1 counters? on ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'counters', target: t, counter: '+1/+1', amount: num(m[1]) }; } },
  { re: new RegExp(`^put ${NUMRE} ([a-z]+|[+-]1/[+-]1) counters? on ${TGT}$`, 'i'), make: m => { if (isLore(m[2])) return null; const t = parseTarget(m[3]); return t && { op: 'counters', target: t, counter: m[2].toLowerCase(), amount: num(m[1]) }; } },
  { re: new RegExp(`^put ${NUMRE} ([a-z]+|[+-]1/[+-]1) counters? on each creature you control$`, 'i'), make: m => isLore(m[2]) ? null : ({ op: 'counters', target: 'creatures-you-control', counter: m[2].toLowerCase(), amount: num(m[1]) }) },
  { re: new RegExp(`^put ${NUMRE} \\+1/\\+1 counters? on ~$`, 'i'), make: m => ({ op: 'counters', target: 'self', counter: '+1/+1', amount: num(m[1]) }) },
  { re: new RegExp(`^put ${NUMRE} \\+1/\\+1 counters? on each creature you control$`, 'i'), make: m => ({ op: 'counters', target: 'creatures-you-control', counter: '+1/+1', amount: num(m[1]) }) },
  { re: new RegExp(`^put ${NUMRE} \\+1/\\+1 counters? on each other creature you control$`, 'i'), make: m => ({ op: 'counters', target: 'each-other-creature-you-control', counter: '+1/+1', amount: num(m[1]) }) },
  { re: new RegExp(`^put ${NUMRE} -1/-1 counters? on ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'counters', target: t, counter: '-1/-1', amount: num(m[1]) }; } },
  { re: new RegExp(`^~ enters (?:the battlefield )?with ${NUMRE} \\+1/\\+1 counters? on it$`, 'i'), make: m => ({ op: 'counters', target: 'self', counter: '+1/+1', amount: num(m[1]) }) },
  // tap / untap
  { re: new RegExp(`^tap ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'tap', target: t }; } },
  { re: new RegExp(`^tap ${TGT}\\. it doesn't untap during its controller's next untap step$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'tap', target: t, noUntap: true }; } },
  { re: /^tap all creatures your opponents control$/i, make: () => ({ op: 'tap', target: 'all-opponent-creatures' }) },
  { re: /^tap all creatures$/i, make: () => ({ op: 'tap', target: 'all-creatures' }) },
  { re: new RegExp(`^untap ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'untap', target: t }; } },
  { re: /^untap ~$/i, make: () => ({ op: 'untap', target: 'self' }) },
  { re: /^untap all creatures you control$/i, make: () => ({ op: 'untap', target: 'creatures-you-control' }) },
  { re: /^untap all lands you control$/i, make: () => ({ op: 'untap', target: 'lands-you-control' }) },
  // sacrifice
  { re: /^sacrifice ~$/i, make: () => ({ op: 'sacrifice-self' }) },
  { re: new RegExp(`^each opponent sacrifices ${NUMRE} (.+?)s? of their choice$`, 'i'), make: m => { const f = parseFilterWords(m[2]); return f && { op: 'sacrifice', who: 'each-opponent', what: f, amount: num(m[1]) as number }; } },
  { re: new RegExp(`^each opponent sacrifices ${NUMRE} (.+?)s?$`, 'i'), make: m => { const f = parseFilterWords(m[2]); return f && { op: 'sacrifice', who: 'each-opponent', what: f, amount: num(m[1]) as number }; } },
  { re: new RegExp(`^target player sacrifices ${NUMRE} (.+?)s?( of their choice)?$`, 'i'), make: m => { const f = parseFilterWords(m[2]); return f && { op: 'sacrifice', who: 'target-player', what: f, amount: num(m[1]) as number }; } },
  { re: new RegExp(`^target opponent sacrifices ${NUMRE} (.+?)s?( of their choice)?$`, 'i'), make: m => { const f = parseFilterWords(m[2]); return f && { op: 'sacrifice', who: 'target-player', what: f, amount: num(m[1]) as number }; } },
  { re: new RegExp(`^each player sacrifices ${NUMRE} (.+?)s?( of their choice)?$`, 'i'), make: m => { const f = parseFilterWords(m[2]); return f && { op: 'sacrifice', who: 'each-player', what: f, amount: num(m[1]) as number }; } },
  { re: new RegExp(`^sacrifice ${NUMRE} (.+?)s?$`, 'i'), make: m => { const f = parseFilterWords(m[2]); return f && { op: 'sacrifice', who: 'you', what: f, amount: num(m[1]) as number }; } },
  // ramp
  { re: /^search your library for a basic land card, put it onto the battlefield tapped, then shuffle$/i, make: () => ({ op: 'search-land', toBattlefield: true, tapped: true, basic: true, count: 1 }) },
  { re: /^search your library for a basic land card, put that card onto the battlefield tapped, then shuffle$/i, make: () => ({ op: 'search-land', toBattlefield: true, tapped: true, basic: true, count: 1 }) },
  { re: /^search your library for a basic land card, put it onto the battlefield, then shuffle$/i, make: () => ({ op: 'search-land', toBattlefield: true, tapped: false, basic: true, count: 1 }) },
  { re: /^search your library for a basic land card, reveal it, put it into your hand, then shuffle$/i, make: () => ({ op: 'search-land', toBattlefield: false, tapped: false, basic: true, count: 1 }) },
  { re: /^search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle$/i, make: () => ({ op: 'search-land', toBattlefield: true, tapped: true, basic: true, count: 2 }) },
  { re: /^search your library for a basic (\w+) or (\w+) card, put it onto the battlefield tapped, then shuffle$/i, make: m => ({ op: 'search-land', toBattlefield: true, tapped: true, basic: true, count: 1, subtypes: [m[1], m[2]] }) },
  { re: /^search your library for a basic (\w+) card, put it onto the battlefield tapped, then shuffle$/i, make: m => ({ op: 'search-land', toBattlefield: true, tapped: true, basic: true, count: 1, subtypes: [m[1]] }) },
  { re: /^search your library for a (\w+) card, put it onto the battlefield tapped, then shuffle$/i, make: m => ({ op: 'search-land', toBattlefield: true, tapped: true, basic: false, count: 1, subtypes: [m[1]] }) },
  { re: /^search your library for a basic land card, put it onto the battlefield tapped, then shuffle$/i, make: () => ({ op: 'search-land', toBattlefield: true, tapped: true, basic: true, count: 1 }) },
  // mana
  { re: /^add \{([WUBRGC])\}$/i, make: m => ({ op: 'add-mana', mana: [m[1].toUpperCase() as ManaSymbol] }) },
  { re: /^add \{([WUBRGC])\}\{([WUBRGC])\}$/i, make: m => ({ op: 'add-mana', mana: [m[1].toUpperCase() as ManaSymbol, m[2].toUpperCase() as ManaSymbol] }) },
  { re: /^add \{([WUBRGC])\}\{([WUBRGC])\}\{([WUBRGC])\}$/i, make: m => ({ op: 'add-mana', mana: [m[1], m[2], m[3]].map(x => x.toUpperCase() as ManaSymbol) }) },
  { re: /^add \{([WUBRG])\} or \{([WUBRG])\}$/i, make: m => ({ op: 'add-mana', mana: 'any-one', amount: 1, ...({ options: [m[1], m[2]] } as object) }) },
  { re: /^add \{([WUBRG])\}, \{([WUBRG])\}, or \{([WUBRG])\}$/i, make: m => ({ op: 'add-mana', mana: 'any-one', amount: 1, ...({ options: [m[1], m[2], m[3]] } as object) }) },
  { re: /^add one mana of any color in your commander's color identity$/i, make: () => ({ op: 'add-mana', mana: 'commander-identity' }) },
  { re: /^add one mana of any color that a land an opponent controls could produce$/i, make: () => ({ op: 'add-mana', mana: 'opponent-lands' }) },
  { re: /^add (\{[^}]+\}) for each (.+?) you control$/i, make: m => { const f = parseFilterWords(m[2]); const mana = parseManaCost(m[1]); if (!f || !mana) return null; return { op: 'add-mana', mana: manaSymbolsOf(mana), perEach: { count: 'permanents-you-control', filter: f } }; } },
  { re: /^add an amount of (\{[^}]+\}) equal to ~'s power$/i, make: m => { const mana = parseManaCost(m[1]); return mana && { op: 'add-mana', mana: manaSymbolsOf(mana), perEach: { count: 'power-of-source' } }; } },
  { re: /^add x mana of any one color, where x is ~'s power$/i, make: () => ({ op: 'add-mana', mana: 'any-one', perEach: { count: 'power-of-source' } }) },
  { re: /^add (\w+) mana of any one color$/i, make: m => { const n = num(m[1]); return typeof n === 'number' ? { op: 'add-mana', mana: 'any-one', amount: n } : null; } },
  { re: /^add one mana of any color$/i, make: () => ({ op: 'add-mana', mana: 'any', amount: 1 }) },
  { re: /^add two mana of any one color$/i, make: () => ({ op: 'add-mana', mana: 'any-one', amount: 2 }) },
  { re: /^add two mana in any combination of colors$/i, make: () => ({ op: 'add-mana', mana: 'any', amount: 2 }) },
  { re: /^add three mana of any one color$/i, make: () => ({ op: 'add-mana', mana: 'any-one', amount: 3 }) },
  { re: /^add \{C\}\{C\}$/i, make: () => ({ op: 'add-mana', mana: ['C', 'C'] }) },
  { re: /^add \{R\}\{R\}\{R\}$/i, make: () => ({ op: 'add-mana', mana: ['R', 'R', 'R'] }) },
  // control / misc
  { re: new RegExp(`^gain control of ${TGT} until end of turn\\. untap (?:that creature|it)\\. it gains haste until end of turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'gain-control', target: t, duration: 'eot', untapHaste: true }; } },
  { re: new RegExp(`^gain control of ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'gain-control', target: t, duration: 'permanent' }; } },
  { re: new RegExp(`^gain control of ${TGT} until end of turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'gain-control', target: t, duration: 'eot' }; } },
  { re: /^untap (?:that creature|that permanent|that land|it|them)$/i, make: () => ({ op: 'untap', target: 'that' }) },
  { re: /^(?:then )?(?:that player|they) shuffles?$/i, make: () => ({ op: 'shuffle', who: 'that-player' }) },
  { re: /^target player shuffles$/i, make: () => ({ op: 'shuffle', who: 'target-player' }) },
  { re: /^target (player|opponent) reveals their hand$/i, make: m => ({ op: 'reveal-hand', who: m[1].toLowerCase() === 'opponent' ? 'target-opponent' : 'target-player' }) },
  { re: /^tap enchanted (?:creature|permanent|land)$/i, make: () => ({ op: 'tap', target: 'enchanted' }) },
  { re: /^untap enchanted (?:creature|permanent|land)$/i, make: () => ({ op: 'untap', target: 'enchanted' }) },
  { re: /^destroy enchanted (?:creature|permanent|land|artifact)$/i, make: () => ({ op: 'destroy', target: 'enchanted' }) },
  { re: /^enchanted creature gets ([+-]\d+)\/([+-]\d+) until end of turn$/i, make: m => ({ op: 'pump', target: 'enchanted', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  { re: new RegExp(`^attach (?:it|~) to ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'attach-self', target: t }; } },
  { re: /^you become the monarch$/i, make: () => ({ op: 'become-monarch' }) },
  { re: /^tap ~$/i, make: () => ({ op: 'tap', target: 'self' }) },
  { re: new RegExp(`^${TGT} can't be blocked this turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'grant-keyword', target: t, keywords: ['unblockable'], duration: 'eot' }; } },
  { re: /^learn$/i, make: () => ({ op: 'loot', draw: 1, discard: 1, discardFirst: true, optional: true }) },
  { re: /^(?:it|~) explores$/i, make: () => ({ op: 'explore' }) },
  { re: /^return (?:a|an) (.+?) you control to its owner's hand$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'return-own', filter: f, count: 1, to: 'hand' }; } },
  { re: new RegExp(`^${TGT} can't block this turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'cant-block', target: t, duration: 'eot' }; } },
  { re: /^~ doesn't untap during your next untap step$/i, make: () => ({ op: 'no-untap-self' }) },
  { re: /^(?:that creature|that permanent|it) doesn't untap during its controller's next untap step$/i, make: () => ({ op: 'no-untap-that' }) },
  { re: /^return ~ from your graveyard to your hand$/i, make: () => ({ op: 'bounce', target: 'self', to: 'hand' }) },
  { re: /^creatures your opponents control get ([+-]\d+)\/([+-]\d+) until end of turn$/i, make: m => ({ op: 'pump', target: 'all-opponent-creatures', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  { re: /^~ can't be blocked this turn$/i, make: () => ({ op: 'grant-keyword', target: 'self', keywords: ['unblockable'], duration: 'eot' }) },
  { re: /^return the exiled cards? to the battlefield under (?:its|their) owner's control$/i, make: () => ({ op: 'choose-mode', modes: [[]], count: 1 }) },
  { re: /^if you search your library this way, shuffle$/i, make: () => ({ op: 'shuffle' }) },
  { re: /^put the rest on the bottom of your library in a random order$/i, make: () => ({ op: 'choose-mode', modes: [[]], count: 1 }) },
  { re: /^sacrifice ~ unless you pay (\{[^ ]+\})$/i, make: m => ({ op: 'sacrifice-unless-pay', mana: parseManaCost(m[1])!, ...(energyOf(m[1]) ? { energy: energyOf(m[1]) } : {}) }) },   // "{E}" is energy beside the mana (CR 118.12; Static Prison, Lathnu Hellion)
  { re: new RegExp(`^create ${NUMRE} food tokens?$`, 'i'), make: m => ({ op: 'token', count: num(m[1]), power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Food'], keywords: [], name: 'Food', food: true }) },
  { re: /^exile ~, then return it to the battlefield transformed under your control$/i, make: () => ({ op: 'transform-self', viaExile: true }) },
  { re: /^add one mana of the chosen color$/i, make: () => ({ op: 'add-mana', mana: 'any-one', amount: 1, options: 'chosen-color' }) },
  { re: /^you get ((?:\{e\}\s*)+)$/i, make: m => ({ op: 'energy', amount: (m[1].match(/\{e\}/gi) ?? []).length }) },
  { re: new RegExp(`^target (?:player|opponent) gets ${NUMRE} poison counters?$`, 'i'), make: m => ({ op: 'poison', amount: num(m[1]), who: 'target-player' }) },
  { re: new RegExp(`^each opponent gets ${NUMRE} poison counters?$`, 'i'), make: m => ({ op: 'poison', amount: num(m[1]), who: 'each-opponent' }) },
  { re: new RegExp(`^copy ${TGT}\\. you may choose new targets for the copy$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'copy-spell', target: t }; } },
  { re: new RegExp(`^regenerate ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'regenerate', target: t }; } },
  { re: /^regenerate ~$/i, make: () => ({ op: 'regenerate', target: 'self' }) },
  { re: new RegExp(`^prevent all damage that would be dealt to ${TGT} this turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'prevent-damage', target: t, amount: 'all', duration: 'eot' }; } },
  { re: /^prevent all combat damage that would be dealt this turn$/i, make: () => ({ op: 'prevent-damage', target: 'you', amount: 'all', duration: 'eot' }) },
  { re: new RegExp(`^prevent the next ${NUMRE} damage that would be dealt to ${TGT} this turn$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'prevent-damage', target: t, amount: num(m[1]), duration: 'eot' }; } },
  { re: new RegExp(`^${TGT} can't attack or block this turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'cant-attack-or-block', target: t, duration: 'eot' }; } },
  { re: /^take an extra turn after this one$/i, make: () => ({ op: 'extra-turn' }) },
  { re: /^transform ~$/i, make: () => ({ op: 'transform-self' }) },
  { re: /^exile ~$/i, make: () => ({ op: 'exile', target: { kind: 'creature', self: true } }) },
  // "It" continuation sentences that we can safely fold
  { re: /^(?:it|that creature|that player|they) can't be regenerated$/i, make: () => ({ op: 'choose-mode', modes: [[]], count: 1 }) },
  { re: /^~ can't be regenerated(?: this turn)?$/i, make: () => ({ op: 'choose-mode', modes: [[]], count: 1 }) },
  { re: /^shuffle$/i, make: () => ({ op: 'shuffle' }) },
  { re: /^then shuffle$/i, make: () => ({ op: 'shuffle' }) },
  { re: /^shuffle your library$/i, make: () => ({ op: 'shuffle' }) },
  { re: /^shuffle ~ into its owner's library$/i, make: () => ({ op: 'shuffle-self-into-library' }) },
  // --- staples: library manipulation, hand attack, removal riders, searches, mana side effects
  { re: new RegExp(`^put ${NUMRE} cards? from your hand on top of your library(?: in any order)?$`, 'i'), make: m => ({ op: 'put-from-hand', amount: num(m[1]), to: 'library-top' }) },
  { re: new RegExp(`^put ${NUMRE} cards? from your hand on the bottom of your library(?: in any order)?$`, 'i'), make: m => ({ op: 'put-from-hand', amount: num(m[1]), to: 'library-bottom' }) },
  { re: /^put an? (.+?) card from your hand onto the battlefield$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'put-from-hand', amount: 1, to: 'battlefield', filter: f, optional: true }; } },
  { re: /^each player may put an? (.+?) card from their hand onto the battlefield$/i, make: m => { const f = parseFilterWords(m[1].replace(/,/g, ' ')); return f && { op: 'put-from-hand', amount: 1, to: 'battlefield', filter: f, optional: true, who: 'each-player' }; } },
  { re: /^look at the top card of target player's library$/i, make: () => ({ op: 'look-top', who: 'target-player', amount: 1 }) },
  { re: /^look at the top card of your library$/i, make: () => ({ op: 'look-top', who: 'you', amount: 1 }) },
  { re: /^draw a card at the beginning of the next turn's upkeep$/i, make: () => ({ op: 'delayed-trigger', at: 'next-upkeep', effects: [{ op: 'draw', amount: 1, who: 'you' }] }) },
  { re: /^at the beginning of the next end step, return (?:that card|it|them) to the battlefield under (?:its|their) owner's control$/i, make: () => ({ op: 'delayed-trigger', at: 'next-end-step', bind: 'that', effects: [{ op: 'return-to-battlefield', target: 'that', underControlOf: 'owner' }] }) },
  { re: /^at the beginning of the next end step, return (?:that card|it|them) to the battlefield under your control$/i, make: () => ({ op: 'delayed-trigger', at: 'next-end-step', bind: 'that', effects: [{ op: 'return-to-battlefield', target: 'that', underControlOf: 'you' }] }) },
  { re: /^return (?:that card|it) to the battlefield under its owner's control$/i, make: () => ({ op: 'return-to-battlefield', target: 'that', underControlOf: 'owner' }) },
  { re: /^if it entered under your control, put a \+1\/\+1 counter on (it|~)$/i, make: m => ({ op: 'fold-counter-if-yours', on: m[1] === '~' ? 'self' : 'that' }) },
  { re: /^sacrifice (?:it|~) unless (?:it|~) escaped$/i, make: () => ({ op: 'conditional', condition: { kind: 'escaped' }, then: [], else: [{ op: 'sacrifice-self' }] }) },
  { re: new RegExp(`^${TGT} gets ([+-]\\d+)/([+-]\\d+) until end of turn and can't be blocked this turn$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'pump', target: t, power: pm(m[2]), toughness: pm(m[3]), keywords: ['unblockable'], duration: 'eot' }; } },
  { re: new RegExp(`^~ deals ${NUMRE} damage divided as you choose among any number of target creatures and/or planeswalkers$`, 'i'), make: m => ({ op: 'damage', amount: num(m[1]), target: { kind: 'creature-or-planeswalker', count: 3, optional: true }, divided: true }) },
  { re: new RegExp(`^~ deals damage equal to the sacrificed creature's power to ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'damage', amount: { count: 'power-of-that' }, target: t }; } },
  { re: /^exile an? (.+?) card from your hand$/i, make: m => { const f = parseFilterWords(m[1].replace(/,/g, ' ')); return f && { op: 'exile-from-hand', filter: f, imprint: true }; } },
  { re: /^add one mana of any of the exiled card's colors$/i, make: () => ({ op: 'add-mana', mana: 'any-one', amount: 1, options: 'exiled-with-colors' }) },
  { re: /^return an? (.+?) card from your graveyard to your hand$/i, make: m => { const f = parseFilterWords(m[1].replace(/ or an? /g, ' or ')); return f && { op: 'return-from-graveyard', what: f, to: 'hand' }; } },
  { re: /^attach ~ to it$/i, make: () => ({ op: 'attach-to-that' }) },
  { re: new RegExp(`^you gain ${NUMRE} life, draw ${NUMRE} cards?$`, 'i'), make: m => ({ op: 'choose-mode', modes: [[{ op: 'gain-life', amount: num(m[1]), who: 'you' }, { op: 'draw', amount: num(m[2]), who: 'you' }]], count: 1 }) },
  { re: /^adapt (\d+)$/i, make: m => ({ op: 'conditional', condition: { kind: 'self-no-counters', counter: '+1/+1' }, then: [{ op: 'counters', target: 'self', counter: '+1/+1', amount: Number(m[1]) }] }) },
  { re: /^exile target player's graveyard$/i, make: () => ({ op: 'exile-graveyard', who: 'target-player' }) },
  { re: /^exile each opponent's graveyard$/i, make: () => ({ op: 'exile-graveyard', who: 'each-opponent' }) },
  { re: /^exile all cards from all graveyards$/i, make: () => ({ op: 'exile-graveyard', who: 'each-player' }) },
  { re: /^(?:its|~'s|that creature's|that land's) controller may search their library for a basic land card, put (?:it|that card) onto the battlefield( tapped)?, then shuffle$/i, make: m => ({ op: 'search', filter: { types: ['Land'], basic: true }, to: 'battlefield', tapped: !!m[1], count: 1, optional: true, who: 'that-controller' }) },
  { re: new RegExp(`^put ${NUMRE} ([a-z]+) counters? on ~$`, 'i'), make: m => isLore(m[2]) ? null : ({ op: 'counters', target: 'self', counter: m[2].toLowerCase(), amount: num(m[1]) }) },
  { re: /^put an? (.+?) card with mana value equal to the number of (\w+) counters on ~ from your hand onto the battlefield$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'put-from-hand', amount: 1, to: 'battlefield', filter: { ...f, mvEQ: { count: 'counters-on-source', counter: m[2].toLowerCase() } }, optional: true }; } },
  { re: /^counter that spell$/i, make: () => ({ op: 'counter-triggering' }) },
  { re: /^if you control an? (.+?) and an? (.+?), add ((?:\{[WUBRGC]\})+) instead$/i, make: m => { const a = parseFilterWords(m[1]), b = parseFilterWords(m[2]); const mana = [...m[3].matchAll(/\{([WUBRGC])\}/g)].map(x => x[1] as ManaSymbol); return a && b ? { op: 'fold-alt-mana', condition: { kind: 'controls-each', filters: [a, b] }, mana, text: m[0] } : null; } },
  { re: /^exile ~, then return (?:it|her|him) to the battlefield transformed under (?:its|her|his) owner's control$/i, make: () => ({ op: 'transform-self', viaExile: true }) },
  { re: new RegExp(`^create ${NUMRE} (\\d+)/(\\d+) ([a-z ]+?) creature tokens? with "sacrifice this token: add \\{c\\}\\."$`, 'i'), make: m => { const t = tokenEffect(m); if (!t || t.op !== 'token') return null; return { ...t, keywords: [], spawn: true }; } },
  { re: /^(?:its|~'s|that creature's|that permanent's) controller gains life equal to its power$/i, make: () => ({ op: 'gain-life', amount: { count: 'power-of-that' }, who: 'that-controller' }) },
  { re: /^(?:its|~'s|that creature's) controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle$/i, make: () => ({ op: 'search', filter: { types: ['Land'], basic: true }, to: 'battlefield', tapped: true, count: 1, optional: true, who: 'that-controller' }) },
  { re: /^you lose life equal to (?:that card's|its) mana value$/i, make: () => ({ op: 'lose-life', amount: { count: 'mv-of-that' }, who: 'you' }) },
  { re: /^you gain life equal to (?:that card's|its) mana value$/i, make: () => ({ op: 'gain-life', amount: { count: 'mv-of-that' }, who: 'you' }) },
  { re: /^put target creature card from a graveyard onto the battlefield under your control$/i, make: () => ({ op: 'return-from-graveyard', what: { types: ['Creature'] }, to: 'battlefield', anyGraveyard: true }) },
  { re: /^return target creature card from your graveyard to the battlefield$/i, make: () => ({ op: 'return-from-graveyard', what: { types: ['Creature'] }, to: 'battlefield' }) },
  { re: new RegExp(`^destroy ${TGT} if it has mana value (\\d+) or less$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'destroy', target: t, ifTarget: { mvLE: Number(m[2]) } }; } },
  // The two rules below parse a slot of their own. `false`: the built-in table is the first stage of both passes, so
  // a registry condition answering the slot would let the template claim a sentence a later built-in stage owns.
  { re: /^destroy that creature if it has mana value (\d+) or less instead if (.+)$/i, make: m => { const c = parseCondition(m[2], false); return c.kind === 'unknown' ? null : { op: 'alt-if-target', condition: c, filter: { mvLE: Number(m[1]) } }; } },
  { re: new RegExp(`^exile ${TGT} if its mana value is less than or equal to the number of colors of mana spent to cast ~$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'exile', target: t, ifTarget: { mvLE: { count: 'colors-spent' } } }; } },
  { re: /^if (.+?), instead put (\w+) of them into your hand and the rest on the bottom of your library in (?:any|a random) order$/i, make: m => { const c = parseCondition(m[1], false); return c.kind === 'unknown' ? null : { op: 'alt-take', condition: c, take: num(m[2]) as number }; } },
  { re: new RegExp(`^amass (\\w+?)s? ${NUMRE}$`, 'i'), make: m => ({ op: 'amass', subtype: m[1][0].toUpperCase() + m[1].slice(1), amount: num(m[2]) }) },
  { re: new RegExp(`^~ deals ${NUMRE} damage to you$`, 'i'), make: m => ({ op: 'damage-you', amount: num(m[1]) }) },
  { re: new RegExp(`^if ~ was kicked, it deals ${NUMRE} damage instead$`, 'i'), make: m => ({ op: 'alt-kicked-amount', amount: num(m[1]), text: m[0] }) },
  { re: /^spend this mana only to cast (?:a |an )?(creature spell of the chosen type|creature spell|instant or sorcery spell|colorless eldrazi spells or activate abilities of colorless eldrazi)(?:, and that spell can't be countered)?$/i, make: m => { const w = m[1].toLowerCase(); return { op: 'fold-restriction', restriction: w === 'creature spell' ? 'creature-spell' : w === 'instant or sorcery spell' ? 'instant-sorcery' : w.startsWith('colorless eldrazi') ? 'colorless-eldrazi' : 'chosen-type-creature', text: m[0] }; } },
  { re: /^investigate$/i, make: () => ({ op: 'token', count: 1, power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Clue'], keywords: [], name: 'Clue', clue: true }) },
  { re: /^~ gains "(.+)"$/i, make: m => { const ab = parseActivatedLine(m[1].replace(/\.$/, '')); return ab && { op: 'gain-ability', ability: ab }; } },
  { re: new RegExp(`^create ${NUMRE} (\\d+)/(\\d+) ([a-z ]+?) creature tokens? with '(?:this creature|this token|it) gets \\+1/\\+1 for each (.+?) you control\\.?'$`, 'i'), make: m => { const f = parseFilterWords(m[5]); if (!f) return null; const t = tokenEffect([m[0], m[1], m[2], m[3], m[4]] as unknown as RegExpMatchArray); if (!t || t.op !== 'token') return null; return { ...t, dynamicPT: { count: 'permanents-you-control', filter: f } }; } },
  { re: new RegExp(`^target player scries ${NUMRE}, then draws a card$`, 'i'), make: m => ({ op: 'choose-mode', modes: [[{ op: 'scry', amount: typeof num(m[1]) === 'number' ? num(m[1]) as number : 1 }, { op: 'draw', amount: 1, who: 'target-player' }]], count: 1 }) },
  // generic searches ("Search your library for an Island or Swamp card, put it onto the battlefield" — fetchlands; GSZ; Stoneforge)
  { re: /^search your library for (?:an?|up to (\w+)) (.+?) cards?( with mana value \w+ or less| with mana cost \{0\} or \{1\})?, put (?:it|that card|them) onto the battlefield( tapped)?(?:, then shuffle)?$/i, make: m => { const f = parseFilterWords(m[2]); if (!f) return null; const mvm = m[3]?.match(/value (\w+)/i); const mv = m[3] ? (mvm ? num(mvm[1]) : 1) : undefined; return { op: 'search', filter: f, to: 'battlefield', tapped: !!m[4], count: m[1] ? num(m[1]) as number : 1, optional: !!m[1], ...(mv !== undefined ? { mvLE: mv } : {}) }; } },
  { re: /^that player may search their library for an? (.+?) card, put it onto the battlefield( tapped)?(?:, then shuffle)?$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'search', filter: f, to: 'battlefield', tapped: !!m[2], count: 1, optional: true, who: 'that-controller' }; } },
  { re: /^return that card to the battlefield under its owner's control at the beginning of the next end step$/i, make: () => ({ op: 'delayed-trigger', at: 'next-end-step', bind: 'that', effects: [{ op: 'return-to-battlefield', target: 'that', underControlOf: 'owner' }] }) },
  { re: /^permanents you control gain (.+?) until end of turn$/i, make: m => { const k = kwList(m[1]); return k && { op: 'grant-keyword', target: 'permanents-you-control', keywords: k, duration: 'eot' }; } },
  { re: /^search your library for an? (.+?) card(?: with mana value (\w+) or less)?, reveal (?:it|that card), put it into your hand(?:, then shuffle)?$/i, make: m => { const f = parseFilterWords(m[1]); if (!f) return null; const mv = m[2] ? num(m[2]) : undefined; return { op: 'search', filter: f, to: 'hand', count: 1, reveal: true, ...(mv !== undefined ? { mvLE: mv } : {}) }; } },
  { re: /^untap all (.+?) you control$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'untap-all', filter: f }; } },
  { re: /^proliferate$/i, make: () => ({ op: 'proliferate' }) },
  { re: /^(?:until end of turn, )?(?:you may )?play (?:that card|those cards|it|them|the exiled cards?)(?: this turn)?$/i, make: () => ({ op: 'play-exiled', until: 'eot' }) },
  { re: /^until the end of your next turn, (?:you may )?play (?:that card|those cards|it|them|the exiled cards?)$/i, make: () => ({ op: 'play-exiled', until: 'next-turn' }) },
  { re: /^(?:you may )?play (?:that card|those cards|the exiled cards?) until the end of your next turn$/i, make: () => ({ op: 'play-exiled', until: 'next-turn' }) },
  { re: /^(?:until end of turn, )?(?:you may )?cast (?:that card|those cards|it|them)(?: this turn)?(?: without paying its mana cost)?$/i, make: m => ({ op: 'play-exiled', until: 'eot', free: /without paying/i.test(m[0]) }) },
  { re: /^(?:you may )?play an additional land this turn$/i, make: () => ({ op: 'extra-land', count: 1 }) },
  { re: /^(?:you may )?play (\w+) additional lands this turn$/i, make: m => { const n = num(m[1]); return typeof n === 'number' ? { op: 'extra-land', count: n } : null; } },
  { re: new RegExp(`^~ deals damage to ${TGT} equal to (.+)$`, 'i'), make: m => { const t = parseTarget(m[1]); const a = parseAmountPhrase(m[2]); return t && a !== null ? { op: 'damage', target: t, amount: a } : null; } },
  { re: /^~ deals damage to each opponent equal to (.+)$/i, make: m => { const a = parseAmountPhrase(m[1]); return a !== null ? { op: 'damage', target: 'each-opponent', amount: a } : null; } },
  { re: /^~ deals damage to each creature equal to (.+)$/i, make: m => { const a = parseAmountPhrase(m[1]); return a !== null ? { op: 'damage', target: 'each-creature', amount: a } : null; } },
  { re: /^draw cards equal to (.+)$/i, make: m => { const a = parseAmountPhrase(m[1]); return a !== null ? { op: 'draw', amount: a, who: 'you' } : null; } },
  { re: /^you gain life equal to (.+)$/i, make: m => { const a = parseAmountPhrase(m[1]); return a !== null ? { op: 'gain-life', amount: a, who: 'you' } : null; } },
  { re: /^you lose life equal to (.+)$/i, make: m => { const a = parseAmountPhrase(m[1]); return a !== null ? { op: 'lose-life', amount: a, who: 'you' } : null; } },
  { re: /^target (player|opponent) loses life equal to (.+)$/i, make: m => { const a = parseAmountPhrase(m[2]); return a !== null ? { op: 'lose-life', amount: a, who: m[1].toLowerCase() === 'opponent' ? 'each-opponent' : 'target-player' } : null; } },
  { re: /^that player gets (\w+) poison counters?$/i, make: m => ({ op: 'poison', amount: num(m[1]), who: 'that-player' }) },
  { re: /^that player gets an additional poison counter$/i, make: () => ({ op: 'poison', amount: 1, who: 'that-player' }) },
  { re: /^that player draws (\w+) cards?$/i, make: m => ({ op: 'draw', amount: num(m[1]), who: 'that-player' }) },
  { re: /^that player discards (\w+) cards?$/i, make: m => ({ op: 'discard', amount: num(m[1]), who: 'that-player' }) },
  { re: /^that player mills (\w+) cards?$/i, make: m => ({ op: 'mill', amount: num(m[1]), who: 'that-player' }) },
  { re: /^that player loses (\w+) life$/i, make: m => ({ op: 'lose-life', amount: num(m[1]), who: 'that-player' }) },
  { re: /^each opponent loses life equal to (.+)$/i, make: m => { const a = parseAmountPhrase(m[1]); return a !== null ? { op: 'lose-life', amount: a, who: 'each-opponent' } : null; } },
  { re: new RegExp(`^${TGT} deals damage to itself equal to its power$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'bite', target: t }; } },
  { re: /^if (?:that|the) (?:creature|permanent)(?: or planeswalker)? would die this turn, exile it instead$/i, make: () => ({ op: 'exile-if-dies', who: 'that' }) },
  { re: /^if a creature dealt damage (?:this way|by ~ this turn) would die(?: this turn)?, exile it instead$/i, make: () => ({ op: 'exile-if-dies', who: 'affected' }) },
  { re: /^if a creature would die this turn, exile it instead$/i, make: () => ({ op: 'exile-if-dies', who: 'all-creatures' }) },
  { re: /^if a creature an opponent controls would die(?: this turn)?, exile it instead$/i, make: () => ({ op: 'exile-if-dies', who: 'opponent-creatures' }) },
  { re: /^if ~ would die, exile it instead$/i, make: () => ({ op: 'exile-if-dies', who: 'self' }) },
  { re: new RegExp(`^put ${NUMRE} ([a-z]+|[+-]1/[+-]1) counters? on each (.+?) you control$`, 'i'), make: m => { if (isLore(m[2])) return null; const f = parseFilterWords(m[3]) ?? subtypeFilter(m[3]); return f ? { op: 'counters', target: 'creatures-you-control', counter: m[2].toLowerCase(), amount: num(m[1]), filter: singularSubtypes(f) } : null; } },
  { re: new RegExp(`^put ${TGT} from your graveyard on top of your library$`, 'i'), make: m => { const t = parseTarget(m[1].replace(/^target /, 'target ')); const f = parseFilterWords(m[1].replace(/^target /, '').replace(/ card$/, '')) ?? subtypeFilter(m[1].replace(/^target /, '').replace(/ card$/, '')); return f ? { op: 'return-from-graveyard', what: singularSubtypes(f), to: 'library-top', target: true } : (t ? null : null); } },
  { re: /^each creature gets ([+-]x)\/([+-]x) until end of turn$/i, make: m => ({ op: 'pump', target: 'all-creatures', power: pm(m[1]), toughness: pm(m[2]), duration: 'eot' }) },
  { re: new RegExp(`^remove ${TGT} from combat(?: and untap it)?$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'remove-from-combat', target: t, untap: /untap/i.test(m[0]) }; } },
  { re: /^target player gains (\w+) life for each (.+)$/i, make: m => { const a = parseEachPhrase(m[2]); const k = num(m[1]); return a !== null && typeof k === 'number' ? { op: 'gain-life', amount: scaleAmount(a, k, '+'), who: 'target-player' } : null; } },
  { re: /^each player gains (\w+) life for each (.+)$/i, make: m => { const a = parseEachPhrase(m[2]); const k = num(m[1]); return a !== null && typeof k === 'number' ? { op: 'gain-life', amount: scaleAmount(a, k, '+'), who: 'each-player' } : null; } },
  { re: /^you gain (\w+) life for each (.+)$/i, make: m => { const a = parseEachPhrase(m[2]); const k = num(m[1]); return a && typeof k === 'number' ? { op: 'gain-life', amount: k === 1 ? a : { ...(a as object), times: k } as Amount, who: 'you' } : null; } },
  { re: /^you lose (\w+) life for each (.+)$/i, make: m => { const a = parseEachPhrase(m[2]); const k = num(m[1]); return a && typeof k === 'number' ? { op: 'lose-life', amount: k === 1 ? a : { ...(a as object), times: k } as Amount, who: 'you' } : null; } },
  { re: /^each opponent loses (\w+) life for each (.+)$/i, make: m => { const a = parseEachPhrase(m[2]); const k = num(m[1]); return a && typeof k === 'number' ? { op: 'lose-life', amount: k === 1 ? a : { ...(a as object), times: k } as Amount, who: 'each-opponent' } : null; } },
  { re: /^draw a card for each (.+)$/i, make: m => { const a = parseEachPhrase(m[1]); return a !== null ? { op: 'draw', amount: a, who: 'you' } : null; } },
  { re: /^~ gets ([+-])(\d+)\/([+-])(\d+) for each (.+)$/i, make: m => { const a = parseEachPhrase(m[5]); if (!a) return null; return { op: 'pump', target: 'self', power: scaleAmount(a, Number(m[2]), m[1]), toughness: scaleAmount(a, Number(m[4]), m[3]), duration: 'eot' }; } },
  { re: /^earthbend (\w+)$/i, make: m => { const n = num(m[1]); const t = parseTarget('target land you control'); return t && typeof n === 'number' ? { op: 'earthbend', amount: n, target: t } : null; } },
  { re: /^untap that land$/i, make: () => ({ op: 'untap', target: 'that' }) },
  { re: /^you get an experience counter$/i, make: () => ({ op: 'player-counter', counter: 'experience', amount: 1, who: 'you' }) },
  { re: /^you get (\w+) experience counters$/i, make: m => ({ op: 'player-counter', counter: 'experience', amount: num(m[1]), who: 'you' }) },
  { re: /^you may choose new targets for the copy$/i, make: () => ({ op: 'fold-new-targets' }) },
  { re: /^you may choose new targets for (?:that copy|the copies)$/i, make: () => ({ op: 'fold-new-targets' }) },
  { re: /^destroy all (nonland permanents|permanents|creatures|artifacts|enchantments|lands) with mana value (\d+) or less$/i, make: m => { const w = m[1].toLowerCase(); const target = w === 'nonland permanents' ? 'all-nonland' : w === 'creatures' ? 'all-creatures' : w === 'artifacts' ? 'all-artifacts' : w === 'enchantments' ? 'all-enchantments' : w === 'lands' ? 'all-lands' : 'all-nonland'; return { op: 'destroy', target: target as 'all-nonland', filter: { mvLE: Number(m[2]) } }; } },
  { re: new RegExp(`^create ${NUMRE} tokens? that(?:'s| are) copies of ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[2]); return t && { op: 'token-copy', target: t, count: num(m[1]) }; } },
  { re: /^create a token that's a copy of ~$/i, make: () => ({ op: 'token-copy', target: 'self', count: 1 }) },
  { re: /^create a token that's a copy of that (?:creature|permanent|token|card)$/i, make: () => ({ op: 'token-copy', target: 'that', count: 1 }) },
  { re: /^create a tapped token that's a copy of that (?:creature|permanent|card)$/i, make: () => ({ op: 'token-copy', target: 'that', count: 1, tapped: true }) },
  { re: /^create a (tapped )?token that's a copy of that (?:creature|permanent|card), except it's an? (.+)$/i, make: m => { const words = m[2].toLowerCase().replace(/ in addition to its other types$/, '').split(/\s+/).filter(w => w !== 'and'); const extraSubtypes: string[] = []; for (const w of words) { if (/^\d+\/\d+$/.test(w) || w in COLOR_WORDS) continue; extraSubtypes.push(w[0].toUpperCase() + w.slice(1)); } return { op: 'token-copy', target: 'that', count: 1, ...(m[1] ? { tapped: true } : {}), extraSubtypes }; } },
  { re: /^add ((?:\{[^}]+\})+), ((?:\{[^}]+\})+), or ((?:\{[^}]+\})+)$/i, make: m => { const cs = [m[1], m[2], m[3]].map(x => parseManaCost(x)); if (cs.some(c => !c)) return null; return { op: 'add-mana', mana: [], choices: cs.map(c => manaSymbolsOf(c!)) }; } },
  { re: /^put an? (.+?) card from your hand onto the battlefield tapped$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'put-from-hand', amount: 1, to: 'battlefield', filter: f, optional: true, tapped: true }; } },
  { re: new RegExp(`^return ${TGT} from your graveyard to the battlefield tapped$`, 'i'), make: m => { const f = parseFilterWords(m[1].replace(/^target /, '').replace(/ card$/, '')); return f && { op: 'return-from-graveyard', what: f, to: 'battlefield', target: true, tapped: true }; } },
  { re: /^search your library for up to (\w+) (.+?) cards?, reveal them, put them into your hand(?:, then shuffle)?$/i, make: m => { const f = parseFilterWords(m[2]); return f && { op: 'search', filter: f, to: 'hand', count: num(m[1]) as number, optional: true, reveal: true }; } },
  { re: /^creatures you control gain (.+?) and get \+x\/\+x until end of turn, where x is (.+)$/i, make: m => { const kw = kwList(m[1]); const a = parseAmountPhrase(m[2]); return kw && a !== null ? { op: 'pump', target: 'creatures-you-control', power: a, toughness: a, keywords: kw, duration: 'eot' } : null; } },
  { re: /^choose a color of a permanent you control\. add one mana of that color$/i, make: () => ({ op: 'add-mana', mana: 'any-one', options: 'permanent-colors' }) },
  { re: /^untap up to (\w+) (.+?)$/i, make: m => { const f = parseFilterWords(m[2].replace(/ you control$/, '')); return f && { op: 'untap-choose', filter: f, count: num(m[1]) as number }; } },
  { re: new RegExp(`^double the power of ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'double-power', target: t }; } },
  { re: new RegExp(`^the owner of ${TGT} shuffles it into their library$`, 'i'), make: m => { const t = parseTarget(m[1]); return t && { op: 'shuffle-into-library', target: t }; } },
  { re: /^each creature deals damage to itself equal to its power$/i, make: () => ({ op: 'each-self-damage' }) },
  { re: new RegExp(`^${TGT} becomes an? (\\d+)/(\\d+) ([a-z ]+?) creature(?: with (.+?))?\\. it's still a land$`, 'i'), make: m => { const t = parseTarget(m[1]); if (!t) return null; const desc = m[4].split(/\s+/).filter(w => w !== 'and'); const colors = desc.filter(w => w in COLOR_WORDS).map(w => COLOR_WORDS[w]); const subs = desc.filter(w => !(w in COLOR_WORDS)).map(w => w[0].toUpperCase() + w.slice(1)); const kw = m[5] ? kwList(m[5]) : []; if (!kw) return null; return { op: 'animate', target: t, power: Number(m[2]), toughness: Number(m[3]), colors, types: ['Creature'], subtypes: subs, keywords: kw, duration: 'permanent' }; } },
  { re: new RegExp(`^put an? ([a-z]+) counter, an? ([a-z]+) counter, and an? ([a-z]+) counter on ${TGT}$`, 'i'), make: m => { const t = parseTarget(m[4]); return t && { op: 'multi-counters', target: t, counters: [m[1], m[2], m[3]].map(x => x.toLowerCase()) }; } },
  { re: /^defending player loses (\w+) life$/i, make: m => ({ op: 'lose-life', amount: num(m[1]), who: 'defending-player' }) },
  { re: /^search your library for a card, then shuffle and put that card on top$/i, make: () => ({ op: 'search', filter: {}, to: 'top', count: 1 }) },
  { re: /^search your library for an? (.+?) card, (?:reveal (?:it|that card), )?then shuffle and put that card on top$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'search', filter: f, to: 'top', count: 1 }; } },
  { re: /^search your library for a card, put (?:it|that card) into your hand(?:, then shuffle)?$/i, make: () => ({ op: 'search', filter: {}, to: 'hand', count: 1 }) },
  { re: /^search your library for up to (\w+) (.+?) cards?, put them into your graveyard(?:, then shuffle)?$/i, make: m => { const f = parseFilterWords(m[2]); return f && { op: 'search', filter: f, to: 'graveyard', count: num(m[1]) as number, optional: true }; } },
  { re: /^search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand(?:, then shuffle)?$/i, make: () => ({ op: 'search', filter: { types: ['Land'], basic: true }, to: 'battlefield', tapped: true, count: 2, optional: true, split: 'one-battlefield-rest-hand' }) },
  { re: /^search your library for (\w+) basic land cards, put them onto the battlefield tapped(?:, then shuffle)?$/i, make: m => ({ op: 'search', filter: { types: ['Land'], basic: true }, to: 'battlefield', tapped: true, count: num(m[1]) as number }) },
  { re: /^search your library for an? (.+?) card, (?:reveal (?:it|that card), )?put it into your hand or graveyard(?:, then shuffle)?$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'search', filter: f, to: 'hand', count: 1 }; } },
  { re: /^search your library for an? (.+?) card(?: with mana value (\w+) or less)?, put it into your hand(?:, then shuffle)?$/i, make: m => { const f = parseFilterWords(m[1]); if (!f) return null; const mv = m[2] ? num(m[2]) : undefined; return { op: 'search', filter: f, to: 'hand', count: 1, ...(mv !== undefined ? { mvLE: mv } : {}) }; } },
  { re: /^search your library for an? (.+?) card, put it onto the battlefield( tapped)?$/i, make: m => { const f = parseFilterWords(m[1]); return f && { op: 'search', filter: f, to: 'battlefield', tapped: !!m[2], count: 1 }; } },
];

/** Multi-sentence templates matched against the start of a paragraph before it is split into sentences. */
/**
 * `useRegistry` is `false` on the first attempt at every template (the built-ins-only pass the header describes) and
 * `true` on the retry parseEffects makes only when that attempt declined and a rule family is registered: the same
 * template, with the registry allowed into its effect slots. A template that ignores the flag behaves as before.
 */
const PARAGRAPH_RULES: { re: RegExp; make: (m: RegExpMatchArray, useRegistry: boolean) => Effect[] | null }[] = [
  { re: /^target (player|opponent) reveals their hand\. you choose an? (.+?) card from it(?: with mana value (\d+) or less)?\. that player discards that card\.?/i, make: m => { const f = parseFilterWords(m[2].replace(/,/g, ' ')); if (!f) return null; if (m[3]) f.mvLE = Number(m[3]); return [{ op: 'reveal-hand-discard', who: m[1].toLowerCase() === 'opponent' ? 'target-opponent' : 'target-player', filter: f, count: 1 }]; } },
  { re: /^choose a nonland card name\. target player reveals their hand and discards all cards with that name\.?/i, make: () => [{ op: 'reveal-hand-discard', who: 'target-player', filter: { notTypes: ['Land'] }, count: 'all-named' }] },
  { re: /^look at the top (\w+) cards? of your library\. put (\w+) of them into your hand and the rest on the bottom of your library in (any|a random) order\.?/i, make: m => [{ op: 'dig', look: num(m[1]), take: num(m[2]) as number, rest: 'bottom', order: m[3].toLowerCase() === 'any' ? 'any' : 'random' }] },
  { re: /^look at the top (\w+) cards? of your library, then put them back in any order\.?/i, make: m => [{ op: 'dig', look: num(m[1]), take: 0, rest: 'top', order: 'any' }] },
  { re: /^look at the top (\w+) cards? of your library\. you may reveal an? (.+?) card from among them and put it into your hand\. (?:then )?put the rest on the bottom of your library in a random order\.?/i, make: m => { const f = parseFilterWords(m[2]); return f && [{ op: 'dig', look: num(m[1]), take: 1, rest: 'bottom', order: 'random', filter: f, optional: true, reveal: true }]; } },
  { re: /^look at the top (\w+) cards? of your library\. you may reveal an? (.+?) card from among them and put it into your hand\. (?:then )?put the rest on the bottom of your library in any order\.?/i, make: m => { const f = parseFilterWords(m[2]); return f && [{ op: 'dig', look: num(m[1]), take: 1, rest: 'bottom', order: 'any', filter: f, optional: true, reveal: true }]; } },
  { re: /^reveal the top (\w+) cards? of your library\. you may put an? (.+?) card from among them into your hand\. put the rest into your graveyard\.?/i, make: m => { const f = parseFilterWords(m[2]); return f && [{ op: 'dig', look: num(m[1]), take: 1, rest: 'graveyard', order: 'any', filter: f, optional: true, reveal: true }]; } },
  { re: new RegExp(`^counter ${TGT}\\. if that spell is countered this way, exile it instead of putting it into its owner's graveyard\\.?`, 'i'), make: m => { const t = parseTarget(m[1]); return t && [{ op: 'counter', target: t, toExile: true }]; } },
  { re: /^earthbend (\w+|x), where x is (.+?)\.?$/i, make: m => { const target = parseTarget('target land you control'); const a = parseAmountPhrase(m[2]); return target && a !== null ? [{ op: 'earthbend', amount: a, target }] : null; } },
  { re: /^~ becomes an? (\d+)\/(\d+) ([a-z ]+?) creature(?: with (.+?))? until end of turn\. it's still a land\.?/i, make: m => { const desc = m[3].split(/\s+/).filter(w => w !== 'and'); const colors = desc.filter(w => w in COLOR_WORDS).map(w => COLOR_WORDS[w]); const subs = desc.filter(w => !(w in COLOR_WORDS)).map(w => w[0].toUpperCase() + w.slice(1)); const kw = m[4] ? kwList(m[4]) : []; if (!kw) return null; return [{ op: 'animate', target: 'self', power: Number(m[1]), toughness: Number(m[2]), colors, types: ['Creature'], subtypes: subs, keywords: kw, duration: 'eot' }]; } },
  { re: new RegExp(`^choose ${TGT}\\. its owner shuffles it into their library\\.?`, 'i'), make: m => { const t = parseTarget(m[1]); return t && [{ op: 'shuffle-into-library', target: t }]; } },
  { re: /^choose a color of a permanent you control\. add one mana of that color\.?/i, make: () => [{ op: 'add-mana', mana: 'any-one', options: 'permanent-colors' }] },
  { re: /^([^.]+?)\. if ~ was kicked, ([^.]+?) instead\.?/i, make: (m, useRegistry) => { const weak = parseEffects(m[1], useRegistry); const strong = parseEffects(m[2].replace(/^that creature /i, '~ ').replace(/^that player /i, 'target player '), useRegistry); if (weak.some(e => e.op === 'unknown') || strong.some(e => e.op === 'unknown')) return null; return [{ op: 'conditional', condition: { kind: 'kicked' }, then: strong, else: weak }]; } },
  { re: /^you may draw a card\. if you do, discard a card\.?/i, make: () => [{ op: 'loot', draw: 1, discard: 1 }] },
  { re: /^you may discard a card\. if you do, draw a card\.?/i, make: () => [{ op: 'loot', draw: 1, discard: 1, discardFirst: true, optional: true }] },
  { re: /^you may pay (\{[^ ]+\})\. if you do, (.+?)\.?$/i, make: (m, useRegistry) => { const then = parseEffects(m[2], useRegistry); if (then.some(e => e.op === 'unknown')) return null; return [{ op: 'optional-pay', mana: parseManaCost(m[1])!, then }]; } },
  { re: /^discard a card\. if you do, draw a card\.?/i, make: () => [{ op: 'loot', draw: 1, discard: 1, discardFirst: true }] },
  // Y is captured greedily up to the next period: under /i the old lazy `([^.]+?)\.?(?=$| [A-Z~])` stopped at the
  // first space ("draw" of "draw two cards"), so the template declined on nearly every real card (PARSER_VERSION 2).
  { re: /^you may ([^.]+?)\. if you do, ([^.]+)\.?(?=$| [A-Z~])/i, make: (m, useRegistry) => { const first = parseEffects(m[1], useRegistry); const then = parseEffects(m[2], useRegistry); if (first.some(e => e.op === 'unknown') || then.some(e => e.op === 'unknown')) return null; return [{ op: 'optional-then', first, then }]; } },
  { re: /^exile the top card of your library\. (?:you may play (?:it|that card) (this turn|until end of turn|until the end of your next turn)|until (?:end of turn|the end of your next turn), you may play (?:it|that card))\.?/i, make: m => [{ op: 'impulse', count: 1, until: /next turn/i.test(m[1] ?? m[0]) ? 'next-turn' : 'eot' }] },
  { re: /^exile the top (\w+) cards of your library\. (?:you may play (?:them|those cards) (this turn|until end of turn|until the end of your next turn)|until (?:end of turn|the end of your next turn), you may play (?:them|those cards))\.?/i, make: m => [{ op: 'impulse', count: num(m[1]) as number, until: /next turn/i.test(m[0]) ? 'next-turn' : 'eot' }] },
];

/** Fold parser-internal marker effects into the effect they modify; with `strict`, leftover markers become unknown text. */
export function foldMarkers(list: Effect[], strict = false): Effect[] {
  const out: Effect[] = [];
  const leftover = (e: Effect, why: string) => { if (strict) out.push({ op: 'unknown', text: (e as { text?: string }).text ?? why }); else out.push(e); };
  for (const e of list) {
    const prev = out[out.length - 1];
    if (e.op === 'alt-if-target') { if (prev && (prev.op === 'destroy' || prev.op === 'exile')) { prev.ifTargetAlt = { condition: e.condition, filter: e.filter }; continue; } leftover(e, 'a removal rider without a removal effect'); continue; }
    if (e.op === 'alt-take') { if (prev && prev.op === 'dig') { prev.altTake = { condition: e.condition, take: e.take }; continue; } leftover(e, 'an "instead" rider without a preceding look'); continue; }
    if (e.op === 'fold-counter-if-yours') { const d = prev && prev.op === 'delayed-trigger' ? prev.effects.find(x => x.op === 'return-to-battlefield') : prev && prev.op === 'return-to-battlefield' ? prev : undefined; if (d && d.op === 'return-to-battlefield') { d.counterIfYours = e.on; continue; } leftover(e, 'a counter rider without a return'); continue; }
    if (e.op === 'fold-alt-mana') { if (prev && prev.op === 'add-mana') { prev.altIf = { condition: e.condition, mana: e.mana }; continue; } leftover(e, 'a conditional mana rider without a mana effect'); continue; }
    if (e.op === 'alt-kicked-amount') { if (prev && prev.op === 'damage') { prev.kickedAmount = e.amount; continue; } leftover(e, 'a kicker rider without a damage effect'); continue; }
    if (e.op === 'fold-restriction') { if (prev && prev.op === 'add-mana') { prev.restriction = e.restriction; continue; } leftover(e, 'a mana restriction without a mana effect'); continue; }
    out.push(e);
  }
  return out;
}

/** A printed "+N" / "-N" / "+X" / "-X" P/T term; "-X" is X negated (the sum form: `{ sum: ['X'], times: -1 }`), which PARSER_VERSION 3 read as +X (Death Wind). */
function pm(s: string): Amount { return s.toUpperCase().endsWith('X') ? (s.startsWith('-') ? { sum: ['X'], times: -1 } : 'X') : Number(s); }
/** Flatten a parsed mana cost into symbols for an add-mana effect ("{G}{G}" → ['G','G']). */
/** Sum two mana costs (buyback: the printed cost plus the buyback cost). */
function addManaCost(a: ManaCost, b: ManaCost): ManaCost {
  return { generic: a.generic + b.generic, x: a.x + b.x, pips: [...a.pips, ...b.pips], hybrid: [...a.hybrid, ...b.hybrid], phyrexian: [...a.phyrexian, ...b.phyrexian], raw: `${a.raw}${b.raw}` };
}
function manaSymbolsOf(cost: ManaCost): ManaSymbol[] {
  const out: ManaSymbol[] = [];
  out.push(...cost.pips);
  for (let i = 0; i < cost.generic; i++) out.push('C');
  return out;
}
/** "Forests" / "Zombies" → a subtype filter (parseFilterWords only knows types and adjectives). */
function singularSubtypes(f: Filter): Filter { return f.subtypes ? { ...f, subtypes: f.subtypes.map(t => singular(t)) } : f; }
/** Multiply an amount by a printed number, keeping 0 as a plain 0 ("gets +2/+0 for each ..."). */
function scaleAmount(a: Amount, k: number, sign: string): Amount {
  if (k === 0) return 0;
  const mult = (sign === '-' ? -1 : 1) * k;
  return mult === 1 ? a : { ...(a as object), times: mult } as Amount;
}
const NOT_SUBTYPES = new Set(['and', 'or', 'the', 'a', 'an', 'card', 'cards', 'permanent', 'permanents', 'other', 'each', 'all']);
function subtypeFilter(words: string): Filter | null {
  const w = words.trim();
  if (!/^[A-Za-z]+s?$/.test(w) || NOT_SUBTYPES.has(w.toLowerCase())) return null;
  const one = subtypeWord(w);
  return one ? { subtypes: [one] } : null;
}
/** "each creature you control" / "each +1/+1 counter on it" → Amount (the tail of a "for each ..." clause). */
function parseEachPhrase(p: string): Amount | null {
  let m: RegExpMatchArray | null;
  const t = p.trim().toLowerCase().replace(/^(each|every) /, '').replace(/ that you control$/, ' you control');
  if (/ among |^basic land type|^color of mana spent to cast it that|^time /.test(t)) return null;   // domain, kicker and friends have their own rules
  if (/^(creature|other creature) you control$/.test(t)) return { count: 'creatures-you-control', ...(t.startsWith('other') ? { filter: { other: true } } : {}) };
  if (t === 'creature on the battlefield') return { count: 'permanents-on-battlefield', filter: { types: ['Creature'] } };
  if (t === 'card in your hand') return { count: 'cards-in-hand' };
  if (t === 'card in your graveyard') return { count: 'cards-in-graveyard' };
  if (t === 'opponent' || t === 'opponent you have') return { count: 'opponents' };
  if (t === 'land you control') return { count: 'lands-you-control' };
  if (t === 'creature that died this turn') return { count: 'creatures-died-this-turn' };
  if (t === 'color of mana spent to cast it' || t === 'color of mana spent to cast this spell') return { count: 'colors-spent' };
  if (t === 'creature blocking it' || t === 'creature blocking ~') return { count: 'blocking-source' };
  if (t === 'spell you’ve cast this turn' || t === "spell you've cast this turn") return { count: 'spells-cast-this-turn' };
  if ((m = t.match(/^([+-]1\/[+-]1|[a-z]+) counter on (?:it|~|this creature)$/))) return { count: 'counters-on-source', counter: m[1] };
  if ((m = t.match(/^(.+?) (?:card )?in your graveyard$/))) { const f = parseFilterWords(m[1]) ?? subtypeFilter(m[1]); if (f) return { count: 'cards-in-graveyard', filter: singularSubtypes(f) }; }
  if ((m = t.match(/^(aura|equipment|aura and equipment)s? attached to (?:it|~)$/))) { const f: Filter = m[1] === 'equipment' ? { subtypes: ['Equipment'] } : m[1] === 'aura' ? { subtypes: ['Aura'] } : {}; return { count: 'attached-to-source', filter: f }; }
  if ((m = t.match(/^(.+?) you control$/))) { const f = parseFilterWords(m[1]) ?? subtypeFilter(m[1]); if (f) return { count: 'permanents-you-control', filter: singularSubtypes(f) }; }
  if ((m = t.match(/^(.+?) on the battlefield$/))) { const f = parseFilterWords(m[1]) ?? subtypeFilter(m[1]); if (f) return { count: 'permanents-on-battlefield', filter: singularSubtypes(f) }; }
  return null;
}
/** "the number of Forests you control" / "the number of experience counters you have" → Amount. */
function parseAmountPhrase(p: string): Amount | null {
  let m: RegExpMatchArray | null; const t = p.trim().toLowerCase();
  if (/^(each|every) /.test(t)) return parseEachPhrase(t);
  if ((m = t.match(/^the number of (.+?) you control$/))) { const f = parseFilterWords(m[1]) ?? subtypeFilter(m[1]); return f && { count: 'permanents-you-control', filter: singularSubtypes(f) }; }
  if ((m = t.match(/^the number of (.+?) cards? in your graveyard$/))) { const f = parseFilterWords(m[1].replace(/ and /g, ' or ')); return f && { count: 'cards-in-graveyard', filter: singularSubtypes(f) }; }
  if (t === 'the number of cards in your graveyard') return { count: 'cards-in-graveyard' };
  if (t === 'the number of cards in your hand') return { count: 'cards-in-hand' };
  if (t === 'the number of lands you control') return { count: 'lands-you-control' };
  if (t === 'the number of creatures you control') return { count: 'creatures-you-control' };
  if (t === 'the number of opponents you have') return { count: 'opponents' };
  if ((m = t.match(/^the number of ([a-z]+) counters you have$/))) return { count: 'player-counters', counter: m[1] };
  if (t === 'the number of cards you have drawn this turn' || t === "the number of cards you've drawn this turn") return { count: 'cards-drawn-this-turn' };
  if (t === "~'s power") return { count: 'power-of-source' };
  if (t === 'its power' || t === "that creature's power" || t === "that card's power") return { count: 'power-of-that' };
  if (t === 'its mana value' || t === "that card's mana value" || t === "that spell's mana value") return { count: 'mv-of-that' };
  if (t === "the number of cards in that player's hand" || t === "the number of cards in target player's hand" || t === "the number of cards in their hand") return { count: 'cards-in-hand', filter: { other: true } };
  if (t === 'the number of cards in all hands') return { count: 'cards-in-all-hands' };
  if (t === 'the number of creatures on the battlefield') return { count: 'permanents-on-battlefield', filter: { types: ['Creature'] } };
  if (t === 'the number of permanents you control') return { count: 'permanents-you-control' };
  if (t === 'the number of creatures that died this turn') return { count: 'creatures-died-this-turn' };
  if (t === 'the number of spells you’ve cast this turn' || t === "the number of spells you've cast this turn") return { count: 'spells-cast-this-turn' };
  if ((m = t.match(/^the number of (.+?) cards? in all graveyards$/))) { const f = parseFilterWords(m[1]) ?? subtypeFilter(m[1]); return f && { count: 'card-types-in-all-graveyards' }; }
  if ((m = t.match(/^the number of (.+?) on the battlefield$/))) { const f = parseFilterWords(m[1]) ?? subtypeFilter(m[1]); return f && { count: 'permanents-on-battlefield', filter: singularSubtypes(f) }; }
  if ((m = t.match(/^the number of ([+-]1\/[+-]1|[a-z]+) counters on (?:it|~|this creature)$/))) return { count: 'counters-on-source', counter: m[1] };
  return null;
}
function kwList(s: string): Keyword[] | null {
  const parts = s.replace(/ and /g, ', ').split(/,\s*/).map(x => x.trim()).filter(Boolean);
  const out: Keyword[] = [];
  for (const p of parts) { const k = /^ward \{\d+\}$/i.test(p) ? 'ward' : keywordFromText(p); if (!k) return null; out.push(k); }
  return out;
}
function tokenEffect(m: RegExpMatchArray, nameIdx?: number): Effect | null {
  const count = num(m[1]); const power = Number(m[2]); const toughness = Number(m[3]);
  const desc = m[4].trim().toLowerCase().split(/\s+/);
  const colors: Color[] = []; const subtypes: string[] = []; const types: CardType[] = ['Creature'];
  for (const w of desc) {
    if (w in COLOR_WORDS) colors.push(COLOR_WORDS[w]);
    else if (w === 'and' || w === 'colorless' || w === 'legendary' || w === 'tapped') continue;
    else if (w === 'artifact') types.unshift('Artifact');
    else if (w === 'enchantment') types.unshift('Enchantment');
    else subtypes.push(w[0].toUpperCase() + w.slice(1));
  }
  const kwText = nameIdx ? m[nameIdx + 1] : m[5];
  let keywords: Keyword[] = [];
  if (kwText) { const k = kwList(kwText); if (!k) return null; keywords = k; }
  return { op: 'token', count, power, toughness, colors, types, subtypes, keywords, name: nameIdx ? m[nameIdx] : undefined, attacking: /tapped and attacking/i.test(m[0]) };
}

/**
 * The shared vocabulary a registry effect rule may call (src/cards/rules/types.ts `EffectCtx`). Every function runs
 * with the registry enabled: a rule is only ever consulted on the second (registry) pass of the sentence ladder, so
 * anything it sub-parses is on that pass too — the built-ins-only pass has already declined the whole sentence.
 */
const EFFECT_CTX: EffectCtx = {
  optional: false,
  // live reads of the two parser-state flags: `triggering` inside a triggered ability's body (the only stack item the
  // engine gives a `triggeringId`), `bound` when a cost or an earlier effect already bound `item.affected`
  host: { get triggering() { return inTriggerBody; }, get bound() { return frameBound; } },
  parseEffects: text => parseEffects(text, true),
  parseEffectSentence: text => parseEffectSentence(text, true),
  parseTarget, parseFilterWords, parseEachPhrase, parseAmountPhrase, parseManaCost, num, kwList,
  parseCondition: text => parseCondition(text, true),
  parseCostPhrase: phrase => parseCostPhrase(phrase, true),
};
const EFFECT_CTX_OPTIONAL: EffectCtx = { ...EFFECT_CTX, optional: true };

/**
 * Normalised sentences no built-in effect template claims. The table is static and its templates are pure functions
 * of the sentence, so a miss is a fact about the text: the registry pass and every nested sub-parse a rule makes
 * skip the template scan the built-ins-only pass already ran on that sentence. Hits are never cached (effects are
 * mutated by foldMarkers and the callers). Bounded by the pool's vocabulary; ~40k strings at most.
 */
const BUILTIN_MISSES = new Set<string>();
/** Ops whose template already reads "you may …" as a permission rather than an action (never wrapped in a `may`). */
const PERMISSION_OPS = new Set<string>(['play-exiled', 'extra-land', 'fold-new-targets', 'impulse']);
/** True while an earlier sentence of the paragraph being parsed named an object a later "it" can refer to (parseEffects sets it). */
let antecedent = false;
/** How many times a registry effect template (or a paragraph template's registry retry) claimed something — a cheap "did the registry contribute?" probe for triggerBody. */
let registryClaims = 0;

// ---------------------------------------------------------------------------
// Failure trace (scripts/parse-why.ts). Off by default and observable nowhere in the parse: every site is one
// `if (parseTrace)` null test, the records go into this module-level array (NOT onto the CardDef — the parse snapshot
// hashes every CardDef key, so a new field would move every hash), and the one trace-only probe (the effect half of a
// conditional whose condition failed) runs only under the flag and discards its own records. The innermost fragment
// the recursive parser could not claim is what the histogram ranks: a decomposition site records each part it had to
// throw away, `partial` saying whether a sibling part parsed (then the fragment is the whole reason the sentence is
// unparsed), and the ladder's give-up records the whole sentence once at depth 0.
// ---------------------------------------------------------------------------
export interface ParseTraceRecord {
  oracleId: string;
  face: 'front' | 'back';
  /** The parseCard line (after its normalisation) the failure sits in. */
  line: string;
  /** The outermost sentence of that line being parsed (sentence-stage records only). */
  sentence: string | null;
  /** The text the parser could not claim. */
  fragment: string;
  stage: 'sentence' | 'condition' | 'trigger-head' | 'intervening' | 'cost' | 'static' | 'keyword';
  /** Which ladder pass recorded it; the registry pass tries strictly more, so a reader prefers it. */
  pass: 'builtin' | 'registry';
  /** Sentence-ladder depth (0 = the whole sentence). */
  depth: number;
  /** How many registry / granted-ability sub-parses deep (0 = the line's own text). */
  nested: number;
  /** A sibling of the fragment parsed, so the fragment alone is what stops the enclosing text. */
  partial: boolean;
}
let parseTrace: ParseTraceRecord[] | null = null;
const traceCtx: { oracleId: string; face: 'front' | 'back'; line: string; sentence: string | null } = { oracleId: '', face: 'front', line: '', sentence: null };
/** Start recording (the array is emptied). */
export function beginParseTrace(): void { parseTrace = []; }
/** The records so far (emptied); `[]` when tracing is off. */
export function drainParseTrace(): ParseTraceRecord[] { const out = parseTrace ?? []; if (parseTrace) parseTrace = []; return out; }
/** Stop recording. */
export function endParseTrace(): void { parseTrace = null; }
/** Push one record; callers guard with `if (parseTrace)` so the untraced path costs one null test. */
function trace(stage: ParseTraceRecord['stage'], fragment: string, useRegistry: boolean, o: { depth?: number; partial?: boolean; sentence?: boolean } = {}): void {
  parseTrace!.push({ oracleId: traceCtx.oracleId, face: traceCtx.face, line: traceCtx.line, sentence: o.sentence ? traceCtx.sentence : null, fragment: fragment.trim(), stage, pass: useRegistry ? 'registry' : 'builtin', depth: o.depth ?? 0, nested: Math.max(0, effectsDepth - (o.sentence ? 1 : 0)), partial: !!o.partial });
}
const known = (effs: Effect[]): boolean => effs.every(x => x.op !== 'unknown');
/** A decomposition the ladder is about to discard: record every part that failed, `partial` when another part parsed. */
function traceParts(parts: string[], subs: Effect[][], depth: number, useRegistry: boolean, siblingParsed = false): void {
  const partial = siblingParsed || subs.some(known);
  for (let i = 0; i < parts.length; i++) if (!known(subs[i])) trace('sentence', parts[i], useRegistry, { depth, partial, sentence: true });
}

/** Parse a sentence into an Effect; returns unknown op on failure. */
export function parseEffectSentence(sentence: string, useRegistry = true): Effect {
  let s = sentence.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (/rather than pay|as an additional cost|additional cost to cast/i.test(s)) return { op: 'unknown', text: sentence.trim() };
  const optional = /^you may /i.test(s);
  s = s.replace(/^you may /i, '').replace(/^then /i, '');
  // A leading "it" / "that creature" is the source ("~") — unless an earlier sentence of the same paragraph named
  // another object (a target, a token, a bound "that creature"): "Gain control of target creature. Untap that
  // creature. It gains haste until end of turn." is about the stolen creature, and a `self` there would give the
  // haste to the sorcery. Such a pronoun becomes the registry's `thatobj` marker (src/cards/rules/composition.ts
  // reads it as the `that` binding) for the sentence shapes the composition rules take; the built-ins never match
  // the marker, so a shape nobody claims is honestly unknown rather than silently the source.
  if (antecedent && /^(?:it|that creature|that permanent) (?:gains?|gets?|has base power|loses?|becomes?|deals?) /i.test(s)) s = s.replace(/^(?:it|that creature|that permanent)\b/i, 'thatobj');   // 9.1: becomes / deals too (layers, Wolf Strike)
  else s = s.replace(/^(?:it|that creature|that permanent|this creature|this permanent)\b/i, '~');
  // "put a counter on it" → the source — except under a "for each …" head, where "it" is the iterated object and no
  // built-in template ever starts with "for each" (the registry's for-each rule reads the pronoun itself, 9.0b)
  if (!/^for each /i.test(s)) s = s.replace(/\bon it$/i, 'on ~');
  s = s.replace(/^each other player /i, 'each opponent ');
  if (!BUILTIN_MISSES.has(s)) {
    for (const r of EFFECT_RULES) {
      const m = s.match(r.re);
      if (m) {
        const e = r.make(m);
        if (e) {
          if (optional && (e.op === 'search' || e.op === 'dig' || e.op === 'shuffle' || e.op === 'counters' || e.op === 'put-from-hand')) e.optional = true;
          // "you may draw a card" is a choice, not a draw: an op with no optional form of its own is wrapped in a `may`
          // (the op the composition core added); a permission ("you may play that card this turn") is not an action
          return optional && !(e as { optional?: boolean }).optional && !PERMISSION_OPS.has(e.op) ? { op: 'may', effects: [e] } : e;
        }
      }
    }
    BUILTIN_MISSES.add(s);
  }
  // Registry hook: family sentence templates, tried only once the built-in table above has declined the sentence —
  // and, from parseSentenceRecursive, only on its second pass, so a family template can never answer a sentence the
  // built-ins were about to decompose on " and " / ", then". A rule is handed the shared sub-parsers on an EffectCtx
  // (it cannot import them: parse.ts imports the registry). The "you may " the built-ins strip above is handed back
  // as a `may` wrapper here — the registry never sees those two words, so it cannot express them itself (9.0b).
  if (useRegistry) for (const r of REGISTRY_EFFECT_RULES) {
    const m = s.match(r.re);
    if (m) { const e = r.make(m, optional ? EFFECT_CTX_OPTIONAL : EFFECT_CTX); if (e) { registryClaims++; return optional ? { op: 'may', effects: [e] } : e; } }
  }
  // "Choose one —" modal spells handled at line level.
  return { op: 'unknown', text: sentence.trim() };
}

/**
 * Split a paragraph into effect sentences, honouring "A, then B" and "A and B" only when both halves parse.
 * `useRegistry` is threaded down to every sentence: it is `false` where the caller is itself a built-ins-only pass
 * whose *claim* depends on these effects coming back known (a PARAGRAPH_RULE slot, parseStatic, parseGrantedAbility).
 */
export function parseEffects(text: string, useRegistry = true): Effect[] {
  effectsDepth++;
  try { return parseParagraph(text, useRegistry); } finally { effectsDepth--; }
}

// ---------------------------------------------------------------------------
// The binding frame (CR 608.2h; docs/vocabulary/composition.md "Refs"): what a later "it" / "that creature" / "those
// creatures" / "its controller" / "that spell's mana value" can refer to. The engine fills `item.affected` only after
// the ops in BINDING_OPS (src/engine/game.ts noteAffected, opMove, opForEach), a sacrifice cost, or a trigger about
// another object. A sentence that read the frame after anything else acted on nothing while the card counted as
// parsed (the 9.0b review's Slave of Bolas / Snakeskin Veil / Gleam of Resistance / Dream Fracture), so a paragraph is
// checked as it is assembled: a frame-reading sentence whose antecedent binds nothing is repaired where the engine has
// the words for it, and is otherwise unknown —
//   * a targeted antecedent ("Gain control of target creature. Untap that creature.", "Counter target spell. Its
//     controller draws a card.") gets a `bind` of the item's targets put before it, so `that` / `those` /
//     `controller-of-that` / `mv-of-that` are the antecedent's targets (their last known information taken then);
//   * a group antecedent ("Creatures you control get +1/+2 until end of turn. Untap those creatures.") has every
//     "those" of the sentence iterate the same set as a `for-each` (CR 608.2f: the set as the effect applies).
// Only the outermost parseEffects of an item judges (a rule's sub-parse lands in a container the outer list sees);
// the callers that already hold a frame say so through `withFrame` (a sacrifice cost binds what was sacrificed, a
// trigger about another object binds it, a spell's earlier paragraphs are the same item).
// ---------------------------------------------------------------------------
/** Ops after which `item.affected` holds what they touched (the engine's noteAffected / opMove / opForEach sites). */
const BINDING_OPS = new Set<string>(['destroy', 'exile', 'search', 'bounce', 'token', 'tap', 'return-from-graveyard', 'earthbend', 'animate', 'token-copy', 'bind', 'move', 'for-each',
  // 9.0c: these record what they touched too (the countered spell with its stack-time controller and mana value, the sacrificed creature's values, the looked-at card, the untapped / pumped / stolen set)
  'pump', 'grant-keyword', 'counters', 'untap', 'untap-all', 'gain-control', 'sacrifice', 'look-top', 'counter']);
/** Values that read the frame: the Refs, the frame-bound player words and the older frame-bound counts. */
const FRAME_WORDS = new Set<string>(['that', 'those', 'controller-of-that', 'that-controller', 'power-of-that', 'mv-of-that']);
/** Ops that read the frame without naming it in a value. */
const FRAME_OPS = new Set<string>(['remove-those', 'no-untap-that', 'attach-to-that']);
/** The child lists an effect can hold, in document order. */
const CHILD_KEYS = ['first', 'then', 'else', 'effects', 'do', 'otherwise', 'modes'] as const;
/** The group words the built-in pump / grant / counters templates use, as the object set a `for-each` iterates. */
const GROUP_SETS: Record<string, ObjectSet> = {
  'creatures-you-control': { types: ['Creature'], who: 'you' },
  'other-creatures-you-control': { types: ['Creature'], who: 'you', other: true },
  'permanents-you-control': { who: 'you' },
  'attacking-creatures': { types: ['Creature'], who: 'you', attacking: true },
  'all-creatures': { types: ['Creature'] },
  'each-creature': { types: ['Creature'] },
  'all-opponent-creatures': { types: ['Creature'], who: 'each-opponent' },
};
/** How deep in nested parseEffects calls we are (1 = the outermost call of an item's text). */
let effectsDepth = 0;
/** Set by the callers through withFrame: the frame is already bound when the paragraph starts / the item's earlier effects. */
let frameBound = false;
/** True while a TRIGGERED ability's body is being parsed (`triggerBody`, the granted triggered shape): what `EffectCtx.host.triggering` reports. */
let inTriggerBody = false;
/** Run `fn` with `inTriggerBody` set (a registry rule may then emit an op that reads `item.triggeringId`). */
function asTriggerBody<T>(fn: () => T): T { const was = inTriggerBody; inTriggerBody = true; try { return fn(); } finally { inTriggerBody = was; } }
let priorEffects: Effect[] = [];
/** The `bind` that re-establishes the caller's frame after an op moved it (a trigger's `bind … from 'triggering'`); null when nothing can. */
let frameRebind: Effect | null = null;
/** Run `fn` with the frame the caller holds: `bound` when a cost or the trigger already bound something, `prior` the item's earlier effects (a spell's previous paragraphs, mutated in place when a `bind` is put before an antecedent there). */
export function withFrame<T>(bound: boolean, prior: Effect[], fn: () => T, rebind: Effect | null = null): T {
  const b = frameBound, p = priorEffects, r = frameRebind; frameBound = bound; priorEffects = prior; frameRebind = rebind;
  try { return fn(); } finally { frameBound = b; priorEffects = p; frameRebind = r; }
}

const isEffectList = (v: unknown): v is Effect[] => Array.isArray(v) && v.every(x => x && typeof x === 'object' && typeof (x as { op?: unknown }).op === 'string');
/** Does any value (nested lists included) read the frame? A `for-each` body's `that` is the iteration's, so only its `over` counts; a `bind` writes the frame. */
function readsFrame(v: unknown): boolean {
  if (typeof v === 'string') return FRAME_WORDS.has(v);
  if (Array.isArray(v)) return v.some(readsFrame);
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.op === 'bind') return false;
  if (typeof o.op === 'string' && FRAME_OPS.has(o.op)) return true;
  if (o.op === 'for-each') return o.over === 'those' || readsFrame(o.over);
  return Object.keys(o).some(k => k !== 'op' && k !== 'text' && k !== 'prompt' && readsFrame(o[k]));
}
/** Does the effect itself (its own slots, not its child lists) read the frame? A delayed trigger / reflexive snapshots the frame when it runs, so its whole body counts. */
function leafReadsFrame(e: Effect): boolean {
  const o = e as unknown as Record<string, unknown>;
  if (o.op === 'delayed-trigger' || o.op === 'reflexive' || o.op === 'for-each') return readsFrame(o);
  return readsFrame({ ...o, first: undefined, then: undefined, else: undefined, effects: undefined, do: undefined, otherwise: undefined, modes: undefined });
}
const playerOnly = (t: unknown): boolean => t === 'each-opponent' || t === 'each-player' || (!!t && typeof t === 'object' && ((t as TargetSpec).kind === 'player' || (t as TargetSpec).kind === 'opponent'));
/** Does the effect bind the frame when it resolves (a `damage` only when it can hit an object)? */
function opBinds(e: Effect): boolean {
  const o = e as unknown as Record<string, unknown>;
  if (o.op === 'damage') return !playerOnly(o.target);
  return typeof o.op === 'string' && BINDING_OPS.has(o.op);
}
/** Does any effect of the list (containers entered; a delayed trigger's / reflexive's body is another item's) bind the frame? */
function bindsFrame(list: Effect[]): boolean {
  for (const e of list) {
    if (opBinds(e)) return true;
    const o = e as unknown as Record<string, unknown>;
    if (o.op === 'delayed-trigger' || o.op === 'reflexive') continue;
    for (const k of CHILD_KEYS) { const c = o[k]; if (k === 'modes' ? Array.isArray(c) && (c as Effect[][]).some(bindsFrame) : isEffectList(c) && bindsFrame(c)) return true; }
  }
  return false;
}
/**
 * The object target an effect chooses (its target / what / exchange sides), or null when it targets nothing, only
 * players, or several independent things. A spell target counts: a `bind` of the item's targets reads a `stack` ref as
 * the spell's card (src/engine/game.ts objs with `spells`), so "Copy target spell. …that spell…" binds it too.
 */
function objectTarget(e: Effect): TargetSpec | null {
  const o = e as unknown as Record<string, unknown>;
  for (const k of ['target', 'what', 'a', 'b']) {
    const v = o[k];
    if (v && typeof v === 'object' && typeof (v as TargetSpec).kind === 'string' && !(v as TargetSpec).self && !playerOnly(v) && (v as TargetSpec).kind !== 'multi') return v as TargetSpec;
  }
  return null;
}
/** The set a group-word antecedent names (the built-in pump / grant / counters shapes), or null. */
function groupSet(e: Effect): ObjectSet | null {
  const o = e as unknown as Record<string, unknown>;
  const set = typeof o.target === 'string' ? GROUP_SETS[o.target] : undefined;
  if (!set) return null;
  return o.filter && typeof o.filter === 'object' ? { ...(o.filter as Filter), ...set } : { ...set };
}
interface Slot { list: Effect[]; index: number }
/** Every effect of a list in document order with the list it sits in — containers before their children; a delayed trigger's / reflexive's body and a for-each's body (another item, another binding) are not entered. */
function* walkEffects(list: Effect[]): Generator<Slot> {
  for (let i = 0; i < list.length; i++) {
    yield { list, index: i };
    const o = list[i] as unknown as Record<string, unknown>;
    if (o.op === 'delayed-trigger' || o.op === 'reflexive' || o.op === 'for-each') continue;
    for (const k of CHILD_KEYS) { const c = o[k]; if (k === 'modes') { if (Array.isArray(c)) for (const md of c as Effect[][]) yield* walkEffects(md); } else if (isEffectList(c)) yield* walkEffects(c); }
  }
}
/** Wrap every frame-reading leaf of `list` whose target / what is `that` / `those` in a `for-each` over `set` (its other frame reads become the iteration's). */
function iterateGroup(list: Effect[], set: ObjectSet): void {
  for (let i = 0; i < list.length; i++) {
    const o = list[i] as unknown as Record<string, unknown>;
    if (o.op === 'delayed-trigger' || o.op === 'reflexive' || o.op === 'for-each' || o.op === 'bind') continue;
    const key = o.target === 'that' || o.target === 'those' ? 'target' : o.what === 'that' || o.what === 'those' ? 'what' : null;
    if (key) { list[i] = { op: 'for-each', over: JSON.parse(JSON.stringify(set)) as ObjectSet, do: [{ ...(o as object), [key]: 'that' } as Effect] }; continue; }
    for (const k of CHILD_KEYS) { const c = o[k]; if (k === 'modes') { if (Array.isArray(c)) for (const md of c as Effect[][]) iterateGroup(md, set); } else if (isEffectList(c)) iterateGroup(c, set); }
  }
}
/**
 * The frame-reading sentence `effs` after the item's earlier effects (`prior`, then the paragraph's `out`): `effs`
 * repaired (a `bind` put before a targeted antecedent, `those` made a `for-each` over a group antecedent), `effs`
 * itself when the nearest antecedent already binds (or the caller's frame does), or null when nothing can bind it.
 */
function bindAntecedent(prior: Effect[], out: Effect[], effs: Effect[], bound: boolean, sentence = ''): Effect[] | null {
  // the effects before the first frame-reading leaf, in document order, and what each names
  type Namer = { slot: Slot; kind: 'binding' | 'target' | 'group' | 'self'; set?: ObjectSet };
  const before: Namer[] = []; const after: Namer[] = [];
  let reading = false; let objectTargets = 0;
  for (const list of [prior, out, effs]) for (const slot of walkEffects(list)) {
    const e = slot.list[slot.index];
    const spec = objectTarget(e); if (spec) objectTargets++;
    // an effect on the source itself ("this creature gets +1/+1 until end of turn") is the antecedent of a following
    // "it" ("Untap it."), not the trigger's or the item's frame
    const onSelf = (e as unknown as { target?: unknown }).target === 'self';
    // "Put X +1/+1 counters on target creature, where X is that creature's power": with no frame to read, the reading
    // effect is its own antecedent (a `bind` of its target goes before it — its own binding comes too late); with a frame
    // ("~ deals damage equal to that creature's power to any target" under a trigger) `that` is the frame's object
    const own = !bound && list === effs && !reading && !!spec && leafReadsFrame(e);
    const set = groupSet(e);
    // an effect whose own target is the frame ("those creatures get +2/+1") reads the frame; it names nothing for the next one
    const readsOnly = !spec && !set && !onSelf && leafReadsFrame(e);
    const n: Namer | null = readsOnly ? null : own ? { slot, kind: 'target' } : onSelf ? { slot, kind: 'self' } : opBinds(e) ? { slot, kind: 'binding', ...(set ? { set } : {}) } : spec ? { slot, kind: 'target' } : set ? { slot, kind: 'group', set } : null;
    if (list === effs && !reading && leafReadsFrame(e)) reading = true;
    if (n) (reading && !own ? after : before).push(n);
  }
  // "create a tapped 2/2 black Zombie creature token and exile that card" (Wight): a token is not a card (CR 111.1), so a
  // `token` between the reference and its antecedent does not name it — the antecedent is bound again right before the
  // reading effect (the caller's frame when it can be re-established, the item's single target otherwise), or the
  // sentence is unknown
  if (/\bthat card\b/i.test(sentence) && !/\bthat token\b/i.test(sentence)) {
    const isToken = (n: Namer): boolean => { const op = (n.slot.list[n.slot.index] as { op: string }).op; return op === 'token' || op === 'token-copy'; };
    let skipped = false;
    while (before.length && before[before.length - 1].kind === 'binding' && isToken(before[before.length - 1])) { before.pop(); skipped = true; }
    if (skipped) {
      let first: Slot | undefined; for (const slot of walkEffects(effs)) if (leafReadsFrame(slot.list[slot.index])) { first = slot; break; }
      if (!first) return null;
      const last = before[before.length - 1];
      const rebind: Effect | null = last === undefined ? (bound ? frameRebind : null)
        : last.kind === 'binding' && (last.slot.list[last.slot.index] as { op: string }).op === 'bind' ? { ...(last.slot.list[last.slot.index] as Effect) }
        : last.kind === 'target' && objectTargets === 1 ? { op: 'bind', as: 'that', from: 'targets' } : null;
      if (!rebind) return null;
      first.list.splice(first.index, 0, rebind);
      return effs;
    }
  }
  // "Creatures you control get +1/+1 until end of turn. If ~ was kicked, those creatures get +2/+1 instead." folds the
  // first sentence into the else branch, after the reference in document order: the only namer there still names the set
  // (a group-word op that binds what it touched binds too late for a reference that runs before it: iterate the set)
  const nearest = before[before.length - 1] ?? (after.length === 1 && after[0].set ? { ...after[0], kind: 'group' as const } : undefined);
  if (!nearest) return bound ? effs : null;
  if (nearest.kind === 'binding') return effs;
  if (nearest.kind === 'self') {
    // only a plain `that` can stand for the source; `those` / the player and count words keep their frame reading
    const onlyThat = (v: unknown): boolean => typeof v === 'string' ? !FRAME_WORDS.has(v) || v === 'that' : Array.isArray(v) ? v.every(onlyThat) : !v || typeof v !== 'object' ? true : (v as { op?: unknown }).op === 'bind' || (!FRAME_OPS.has(String((v as { op?: unknown }).op)) && Object.entries(v as Record<string, unknown>).every(([k, x]) => k === 'op' || k === 'text' || onlyThat(x)));
    if (!onlyThat(effs)) return bound ? effs : null;
    const rewrite = (v: unknown): unknown => v === 'that' ? 'self' : Array.isArray(v) ? v.map(rewrite) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === 'op' || k === 'text' ? x : rewrite(x)])) : v;
    const rewritten = rewrite(effs) as Effect[];
    effs.splice(0, effs.length, ...rewritten);
    return effs;
  }
  if (nearest.kind === 'group') {
    iterateGroup(effs, nearest.set!);
    return readsFrame(effs) ? null : effs;
  }
  // a targeted antecedent: `bind` takes every target of the item, so `that` is its first — the antecedent must be the
  // item's only object target (a second one would be bound with it, or before it)
  if (objectTargets !== 1) return bound ? effs : null;
  const { list, index } = nearest.slot;
  if (index > 0 && list[index - 1].op === 'bind') return effs;   // an earlier sentence of the paragraph already bound it
  list.splice(index, 0, { op: 'bind', as: 'that', from: 'targets' });
  return effs;
}

/** The body of parseEffects; `effectsDepth` is 1 on the outermost call of an item's text, where the frame is judged. */
function parseParagraph(text: string, useRegistry: boolean): Effect[] {
  const out: Effect[] = [];
  const outer = effectsDepth === 1;
  let bound = outer && (frameBound || bindsFrame(priorEffects));
  /** One chunk of the paragraph (a paragraph template's effects, a sentence's): admitted, repaired, or unknown when it reads a frame nothing binds. */
  const admit = (effs: Effect[], sentence: string): Effect[] => {
    if (!outer) return effs;
    let kept: Effect[] | null = effs;
    if (readsFrame(effs)) kept = bindAntecedent(priorEffects, out, effs, bound, sentence);
    if (!kept) return [{ op: 'unknown', text: sentence.trim() }];
    if (bindsFrame(kept) || bindsFrame(out)) bound = true;
    return kept;
  };
  let rest = text.trim();
  // multi-sentence templates first
  let matched = true;
  while (matched && rest) {
    matched = false;
    for (const r of PARAGRAPH_RULES) {
      const m = rest.match(r.re); if (!m) continue;
      // built-ins first: the template's slots are filled by the built-in sub-parsers alone, and only when that declines
      // (and only on a registry-enabled call) is the same template retried with the registry in its slots
      let effs = r.make(m, false);
      if (!effs && useRegistry && ANY.sentence) { effs = r.make(m, true); if (effs) registryClaims++; }
      if (!effs) continue;
      out.push(...admit(effs, m[0])); rest = rest.slice(m[0].length).trim(); matched = true; break;
    }
  }
  if (/\btarget (player|opponent)\b/i.test(rest)) rest = rest.replace(/\bthat player\b/gi, 'target player');
  const sentences = rest.split(/(?<=\.)\s+(?=[A-Z~])/).map(s => s.trim()).filter(Boolean);
  // the paragraph's antecedent for a later "it" / "that creature" (see parseEffectSentence); a nested parse inherits
  // the paragraph it is part of, and a paragraph never leaks into the next one
  const savedAntecedent = antecedent;
  for (const sent of sentences) {
    if (parseTrace && outer) traceCtx.sentence = sent;
    out.push(...admit(parseSentenceRecursive(sent, 0, useRegistry), sent));
    if (/\btarget\b|\btokens?\b|\bthat (?:creature|permanent|card|token)\b|\bthatobj\b/i.test(sent)) antecedent = true;
  }
  antecedent = savedAntecedent;
  return foldMarkers(out, false);
}

/**
 * One sentence: whole first, then ", then" / " and " splits whose every part parses (recursively, so "A and B, then C"
 * works). Two passes: the built-ins alone (the whole sentence *and* every decomposition of it), and only if that still
 * leaves an `unknown` is the same ladder re-run with the registry effect rules enabled. Without the second pass a
 * family template matching a whole sentence would answer it before the built-in decomposition was ever tried, which is
 * exactly the kind of already-working parse a family must not move.
 */
function parseSentenceRecursive(sent: string, depth: number, useRegistry = true): Effect[] {
  const builtIn = sentenceEffects(sent, depth, false);
  // ANY.sentence, not REGISTRY_EFFECT_RULES.length: the second pass also carries the registry into parseCondition for
  // the "if <condition>, ..." splits below, so a family with conditions and no effects still needs it to run.
  if (!useRegistry || !ANY.sentence || builtIn.every(x => x.op !== 'unknown')) return builtIn;
  const withRules = sentenceEffects(sent, depth, true);
  return withRules.every(x => x.op !== 'unknown') ? withRules : builtIn;
}

/** One pass of the sentence ladder; `useRegistry` is threaded into every sub-parse so a pass is all-or-nothing. */
function sentenceEffects(sent: string, depth: number, useRegistry: boolean): Effect[] {
  const e = parseEffectSentence(sent, useRegistry);
  if (e.op !== 'unknown' || depth > 3) return [e];
  const body = sent.replace(/\.$/, '');
  // "If <condition>, <effects>" / "<effects> if <condition>" / "<effects> instead if <condition>" → conditional
  let cm = body.replace(/^then /i, '').match(/^if (.+?), (.+)$/i);
  if (cm) { const c = parseCondition(cm[1], useRegistry); const eff = /~/.test(cm[1]) ? cm[2].replace(/^it\b/i, '~') : cm[2]; /* "If ~ was kicked, it deals …": the condition names the source, so its "it" is ~ (9.1) */ if (c.kind !== 'unknown') { const sub = sentenceEffects(eff, depth + 1, useRegistry); if (known(sub)) return [{ op: 'conditional', condition: c, then: sub }]; if (parseTrace) traceParts([eff], [sub], depth + 1, useRegistry, true); } else if (parseTrace) traceCondition(cm[1], eff, depth, useRegistry); }
  cm = body.match(/^(.+?) if (.+)$/i);
  if (cm && !/\bunless\b/i.test(body)) { const c = parseCondition(cm[2], useRegistry); if (c.kind !== 'unknown') { const sub = sentenceEffects(cm[1], depth + 1, useRegistry); if (known(sub)) return [{ op: 'conditional', condition: c, then: sub }]; if (parseTrace) traceParts([cm[1]], [sub], depth + 1, useRegistry, true); } else if (parseTrace) traceCondition(cm[2], cm[1], depth, useRegistry); }
  const parts = body.split(/,? then |\. /i);
  if (parts.length > 1) {
    const subs = parts.map(p => sentenceEffects(p, depth + 1, useRegistry)); const sub = subs.flat();
    if (known(sub)) return sub;
    if (parseTrace) traceParts(parts, subs, depth + 1, useRegistry);
  }
  // "Target player draws two cards and loses 2 life" → two sentences that repeat the subject
  const subj = body.match(/^(target player|target opponent|each player|each opponent|you|~)\s+(.+)$/i);
  if (subj) {
    const parts = subj[2].split(/ and (?=[a-z])/i);
    if (parts.length > 1) {
      const full = parts.map(x => `${subj[1]} ${x}`);
      const subs = full.map(x => sentenceEffects(x, depth + 1, useRegistry)); const sub = subs.flat();
      if (known(sub)) return sub;
      if (parseTrace) traceParts(full, subs, depth + 1, useRegistry);
    }
  }
  const andParts = body.split(/ and (?=you |target |each |draw |destroy |~ |put |create |exile |return )/i);
  // 9.1: a trailing ", where X is …" defines X for BOTH conjuncts — only a whole-sentence rule may claim it
  if (andParts.length > 1 && !/, where x is /i.test(body)) {
    const subs = andParts.map(p => sentenceEffects(p, depth + 1, useRegistry)); const sub = subs.flat();
    if (known(sub)) return sub;
    if (parseTrace) traceParts(andParts, subs, depth + 1, useRegistry);
  }
  // give-up: every part is on record above; the whole sentence is recorded once, at the top of the ladder
  if (parseTrace && depth === 0) trace('sentence', sent, useRegistry, { depth: 0, sentence: true });
  return [e];
}

/** Trace-only: a conditional whose condition failed. Whether the effect half would parse is probed and the probe's own records are discarded — the condition is the innermost failure when the rest of the sentence is fine. */
function traceCondition(cond: string, eff: string, depth: number, useRegistry: boolean): void {
  const mark = parseTrace!.length;
  const probe = known(sentenceEffects(eff, depth + 1, useRegistry));
  parseTrace!.length = mark;
  trace('condition', cond, useRegistry, { depth, partial: probe, sentence: true });
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------
function parseCondition(s: string, useRegistry = true): Condition {
  const t = s.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^you have (\d+) or less life$/))) return { kind: 'life-le', who: 'you', value: Number(m[1]) };
  if ((m = t.match(/^an opponent has (\d+) or less life$/))) return { kind: 'life-le', who: 'opponent', value: Number(m[1]) };
  if ((m = t.match(/^a player has (\d+) or less life$/))) return { kind: 'life-le', who: 'any', value: Number(m[1]) };
  if ((m = t.match(/^you have (\w+) or more opponents$/))) return { kind: 'opponents-ge', value: num(m[1]) as number };
  if (t === 'there are seven or more cards in your graveyard') return { kind: 'threshold' };
  if ((m = t.match(/^you control (\w+) or (fewer|more) other lands$/))) return { kind: m[2] === 'fewer' ? 'lands-le' : 'lands-ge', value: num(m[1]) as number, other: true };
  if ((m = t.match(/^you control (?:a|an|another) (.+)$/))) { const f = parseFilterWords(m[1].replace(/\b(a|an) /g, '')); if (f) return { kind: 'controls', who: 'you', filter: f, atLeast: 1 }; }
  if ((m = t.match(/^you control (\w+) or more (.+?)s$/))) { const f = parseFilterWords(m[2]); if (f) return { kind: 'controls', who: 'you', filter: f, atLeast: num(m[1]) as number }; }
  if (t === "it's not your turn") return { kind: 'not-your-turn' };
  if (t === "it's your turn") return { kind: 'your-turn' };
  if (t === "it's your first, second, or third turn of the game") return { kind: 'turn-le', value: 3 };
  if (t === 'a permanent left the battlefield under your control this turn') return { kind: 'revolt' };
  if (t === 'there are four or more card types among cards in your graveyard') return { kind: 'delirium' };
  if (t === 'you gained life this turn') return { kind: 'life-gained-this-turn' };
  if ((m = t.match(/^there is an? (\w+) card and an? (\w+) card in your graveyard$/))) { const a = parseFilterWords(m[1]), b = parseFilterWords(m[2]); if (a && b) return { kind: 'graveyard-has-each', filters: [a, b] }; }
  if ((m = t.match(/^you control an? (.+?) and an? (.+?)$/))) { const a = parseFilterWords(m[1]), b = parseFilterWords(m[2]); if (a && b) return { kind: 'controls-each', filters: [a, b] }; }
  if (t === 'you cast it from your hand' || t === 'it was cast from your hand') return { kind: 'cast-from-hand' };
  if (t === 'it escaped' || t === 'its escape cost was paid' || t === '~ escaped') return { kind: 'escaped' };
  if (t === 'it was evoked' || t === "its evoke cost was paid") return { kind: 'evoked' };
  if ((m = t.match(/^you have (\w+) or more cards in hand$/))) return { kind: 'cards-in-hand-ge', who: 'you', value: num(m[1]) as number };
  if (t === 'seven or more cards are in your graveyard') return { kind: 'threshold' };
  if (t === 'you control three or more artifacts') return { kind: 'metalcraft' };
  if (t === 'you have no cards in hand') return { kind: 'hellbent' };
  if (t === 'you control a creature with power 4 or greater') return { kind: 'ferocious' };
  if (t === 'it was kicked' || t === "this spell was kicked" || t === '~ was kicked') return { kind: 'kicked' };   // "~ was kicked": the sentence ladder's "if …, …" split (9.1)
  if (t === 'you attacked this turn' || t === 'you attacked with a creature this turn') return { kind: 'raid' };
  if (t === 'a creature died this turn') return { kind: 'morbid' };
  if ((m = t.match(/^there are (\w+) or more (?:basic )?land types among lands you control$/))) return { kind: 'domain-ge', value: num(m[1]) as number };
  if ((m = t.match(/^you control (\w+) or fewer (.+?)s?$/))) { const f = parseFilterWords(m[2]); if (f) return { kind: 'controls-le', who: 'you', filter: f, atMost: num(m[1]) as number }; }
  if ((m = t.match(/^an opponent controls (?:a|an) (.+)$/))) { const f = parseFilterWords(m[1]); if (f) return { kind: 'controls', who: 'opponent', filter: f, atLeast: 1 }; }
  if ((m = t.match(/^an opponent controls (\w+) or more (.+?)s?$/))) { const f = parseFilterWords(m[2]); if (f) return { kind: 'controls', who: 'opponent', filter: f, atLeast: num(m[1]) as number }; }
  if ((m = t.match(/^you have (\d+) or more life$/))) return { kind: 'life-ge', who: 'you', value: Number(m[1]) };
  if ((m = t.match(/^an opponent has (\d+) or more life$/))) return { kind: 'life-ge', who: 'opponent', value: Number(m[1]) };
  if (t === 'you have more life than an opponent' || t === "your life total is greater than an opponent's") return { kind: 'more-life-than-opponent' };
  if (t === 'an opponent has more life than you' || t === "an opponent's life total is greater than yours") return { kind: 'opponent-more-life' };
  if ((m = t.match(/^you attacked with (\w+) or more creatures this turn$/))) return { kind: 'attacked-with-ge', value: num(m[1]) as number };
  if (t === 'you lost life this turn') return { kind: 'you-lost-life-this-turn' };
  if (t === 'an opponent lost life this turn') return { kind: 'opponent-lost-life-this-turn' };
  if (t === "you've cast another spell this turn" || t === 'you cast another spell this turn' || t === "you've cast a spell this turn") return { kind: 'spells-cast-this-turn-ge', value: 2 };
  if ((m = t.match(/^you've cast (\w+) or more (?:other )?spells this turn$/))) return { kind: 'spells-cast-this-turn-ge', value: num(m[1]) as number };
  if ((m = t.match(/^you have (\w+) or fewer cards in (?:your )?hand$/))) return { kind: 'cards-in-hand-le', who: 'you', value: num(m[1]) as number };
  if ((m = t.match(/^you have (\w+) or more cards in (?:your )?hand$/))) return { kind: 'cards-in-hand-ge', who: 'you', value: num(m[1]) as number };
  if ((m = t.match(/^an opponent has (\w+) or more cards in hand$/))) return { kind: 'cards-in-hand-ge', who: 'opponent', value: num(m[1]) as number };
  if (t === 'an opponent has no cards in hand') return { kind: 'opponent-hellbent' };
  if ((m = t.match(/^there are (\w+) or more (.+?) cards? in your graveyard$/))) { const f = parseFilterWords(m[2]); if (f) return { kind: 'graveyard-ge', value: num(m[1]) as number, filter: f }; }
  if ((m = t.match(/^there are (\w+) or more cards in your graveyard$/))) return { kind: 'graveyard-ge', value: num(m[1]) as number };
  if ((m = t.match(/^you have (\w+) or more cards in your graveyard$/))) return { kind: 'graveyard-ge', value: num(m[1]) as number };
  if (t === 'you control your commander' || t === 'you control a commander') return { kind: 'controls-commander' };
  if (t === '~ is tapped') return { kind: 'self-tapped' };
  if (t === '~ is untapped') return { kind: 'self-untapped' };
  if (t === '~ is attacking') return { kind: 'self-attacking' };
  if ((m = t.match(/^~ has (?:a|an|one or more) ([+-]1\/[+-]1|[a-z]+) counters? on it$/))) return { kind: 'self-has-counters', counter: m[1] };
  if ((m = t.match(/^you've drawn (\w+) or more cards this turn$/))) return { kind: 'cards-drawn-ge', value: num(m[1]) as number };
  if ((m = t.match(/^you control (\w+) or more lands$/))) return { kind: 'lands-ge', value: num(m[1]) as number };
  if (t === 'you control no creatures') return { kind: 'controls-le', who: 'you', filter: { types: ['Creature'] }, atMost: 0 };
  if (t === 'no spells were cast last turn') return { kind: 'spells-cast-last-turn', who: 'none' };
  if ((m = t.match(/^a player cast (\w+) or more spells last turn$/))) return { kind: 'spells-cast-last-turn', who: 'any-player-ge', value: num(m[1]) as number };
  if (t === 'you cast it' || t === 'you cast ~' || t === 'it was cast' || t === '~ was cast') return { kind: 'self-was-cast' };
  if ((m = t.match(/^(?:~|it) (?:is|was) an? (artifact|creature|enchantment|land|planeswalker|instant|sorcery|battle)$/))) return { kind: 'self-is-type', type: (m[1][0].toUpperCase() + m[1].slice(1)) as CardType };
  if (t === '~ is in your graveyard' || t === 'it is in your graveyard') return { kind: 'self-in-graveyard' };
  if ((m = t.match(/^(?:it|~) had (?:a |an |one or more )?([+-]1\/[+-]1|[a-z]+) counters? on it$/))) return { kind: 'self-had-counters', counter: m[1] };
  if (t === 'it had counters on it' || t === '~ had counters on it') return { kind: 'self-had-counters', counter: '+1/+1' };
  if ((m = t.match(/^you gained (\w+) or more life this turn$/))) return { kind: 'life-gained-ge', value: num(m[1]) as number };
  if (t === 'a creature died this turn') return { kind: 'morbid' };
  if (t === 'you attacked this turn' || t === 'you attacked with a creature this turn') return { kind: 'raid' };
  if (t === 'it was kicked' || t === '~ was kicked') return { kind: 'kicked' };
  if (t === 'there are four or more card types among cards in your graveyard') return { kind: 'delirium' };
  if (t === 'you descended this turn') return { kind: 'descended-this-turn' };
  if ((m = t.match(/^you have (\w+) or more unspent mana$/))) return { kind: 'unspent-mana-ge', value: num(m[1]) as number };
  if ((m = t.match(/^you control no (.+?)( other than ~)?$/))) { const f = parseFilterWords(singular(m[1])); if (f) return { kind: 'controls-le', who: 'you', filter: m[2] ? { ...f, other: true } : f, atMost: 0 }; }
  if (t === 'an opponent controls more lands than you') return { kind: 'opponent-more-lands' };
  if ((m = t.match(/^(.+?) or if (.+)$/))) { const a = parseCondition(m[1], useRegistry); const b = parseCondition(m[2], useRegistry); if (a.kind !== 'unknown' && b.kind !== 'unknown') return { kind: 'or', conditions: [a, b] }; }
  if (t === '~ entered this turn' || t === '~ entered the battlefield this turn') return { kind: 'self-entered-this-turn' };
  if ((m = t.match(/^creatures you control have total toughness (\d+) or greater$/))) return { kind: 'total-toughness-ge', value: Number(m[1]) };
  if ((m = t.match(/^your opponents control (\w+) or more lands$/))) return { kind: 'opponents-lands-ge', value: num(m[1]) as number };
  if ((m = t.match(/^you control (?:a|an) (.+)$/))) { const f = parseFilterWords(m[1]); if (f) return { kind: 'controls', who: 'you', filter: f, atLeast: 1 }; }
  // Registry hook: family condition clauses, after every built-in clause above has declined. Callers that use a
  // known condition to decide *which* shape claims a line (parseActivatedLine, parseSentenceRecursive) run their
  // built-ins-only pass first, so a condition rule never picks that branch for them.
  if (useRegistry) for (const r of CONDITION_RULES) { const c = r.make(s); if (c) return c; }
  return { kind: 'unknown', text: s };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
function parseTrigger(head: string, useRegistry = true): TriggerEvent {
  head = head.replace(/^whenever you cast or copy /i, 'whenever you cast ');
  const t = head.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if (/^(when|whenever) ~ enters(?: the battlefield)?$/.test(t)) return { on: 'etb', self: true };
  if ((m = t.match(/^when(?:ever)? ~ enters(?: the battlefield)? (?:and|or) whenever (.+)$/))) { const other = parseTrigger('whenever ' + m[1], useRegistry); return other.on === 'unknown' ? other : { on: 'or', events: [{ on: 'etb', self: true }, other] }; }
  if (/^whenever ~ enters or attacks$/.test(t)) return { on: 'or', events: [{ on: 'etb', self: true }, { on: 'attacks', self: true }] };
  if ((m = t.match(/^when(?:ever)? you play (another|a) land$/))) return { on: 'landfall', played: true, other: m[1] === 'another' };
  if (/^whenever a land you control enters(?: the battlefield)?$/.test(t)) return { on: 'landfall' };
  if (/^whenever an opponent draws a card except the first one they draw in each of their draw steps$/.test(t)) return { on: 'draw', who: 'opponent', exceptFirstInDrawStep: true };
  if (/^whenever an opponent draws a card$/.test(t)) return { on: 'draw', who: 'opponent' };
  if (/^whenever one or more cards leave your graveyard$/.test(t)) return { on: 'leaves-graveyard' };
  if ((m = t.match(/^whenever one or more (.+?) cards leave your graveyard$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'leaves-graveyard', filter: f }; }
  if ((m = t.match(/^whenever you discard an? (.+?) card$/))) { const f = parseFilterWords(m[1].replace(/, /g, ' ')); if (f) return { on: 'discard', filter: f }; }
  if ((m = t.match(/^whenever an? (.+?) you control(?: with ([a-z ]+))? deals combat damage to a player(?: or battle| or planeswalker)?$/))) { const f = parseFilterWords(m[1]); if (f) { if (m[2]) { const k = keywordFromText(m[2].trim()); if (!k) return { on: 'unknown', text: t }; f.withKeyword = k; } return { on: 'combat-damage-player', self: false, filter: f }; } }
  if ((m = t.match(/^whenever an? (.+?) you control becomes the target of a spell$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'targeted', self: false, filter: f }; }
  if (/^whenever a creature you control of the chosen type enters or attacks$/.test(t)) return { on: 'or', events: [{ on: 'etb', self: false, filter: { types: ['Creature'], chosenType: true }, controller: 'you' }, { on: 'attacks', self: false, filter: { types: ['Creature'], chosenType: true } }] };
  if ((m = t.match(/^whenever an? (.+?) card leaves your graveyard$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'leaves-graveyard', filter: f }; }
  if (/^whenever you draw a card$/.test(t)) return { on: 'draw', who: 'you' };
  if ((m = t.match(/^when(?:ever)? you draw your (second|third|fourth|fifth) card (?:in a turn|each turn)$/))) return { on: 'draw', who: 'you', nth: ({ second: 2, third: 3, fourth: 4, fifth: 5 })[m[1]] };
  if ((m = t.match(/^whenever you cast your (second|third|fourth) spell each turn$/))) return { on: 'cast', filter: {}, who: 'you', nth: ({ second: 2, third: 3, fourth: 4 })[m[1]] };
  if ((m = t.match(/^whenever a player casts a spell with mana value equal to the number of (\w+) counters on ~$/))) return { on: 'cast', filter: {}, who: 'any', mvEqualsCounter: m[1] };
  // "Whenever ~ or another Ally you control enters": the source's own entry or another's (CR 603.2, one trigger event)
  if ((m = t.match(/^whenever ~ or another (.+?) you control enters(?: the battlefield)?$/))) {
    const f = parseFilterWords(m[1]); if (f) return { on: 'or', events: [{ on: 'etb', self: true }, { on: 'etb', self: false, filter: { ...f, other: true }, controller: 'you' }] };
  }
  // "Whenever a creature you control with power 3 or greater enters": the controller phrase sits inside the filter
  if ((m = t.match(/^whenever (?:another |an? )?(.+?) you control (with .+?) enters(?: the battlefield)?$/))) {
    const f = parseFilterWords(`${m[1]} ${m[2]}`); if (f) return { on: 'etb', self: false, filter: f, controller: 'you' };
  }
  // the "you control" template before the generic one (PARSER_VERSION 4): the generic template used to read "creature you
  // control" as the filter words You / Control (docs/HANDOFF.md item 22; the subtype vocabulary then declined them)
  if ((m = t.match(/^whenever (?:another |an? )?(.+?) you control enters(?: the battlefield)?$/))) {
    const f = parseFilterWords(m[1]); if (f) return { on: 'etb', self: false, filter: f, controller: 'you' };
  }
  if ((m = t.match(/^whenever (?:another |an? )?(.+?) enters(?: the battlefield)? under an opponent's control$/))) {
    const f = parseFilterWords(m[1]); if (f) return { on: 'etb', self: false, filter: f, controller: 'opponent' };
  }
  if ((m = t.match(/^whenever (?:another |an? )?(.+?) enters(?: the battlefield)?(?: under your control)?$/))) {
    const f = parseFilterWords(m[1]); if (f) return { on: 'etb', self: false, filter: f, controller: /under your control|you control/.test(t) ? 'you' : 'any' };
  }
  if (/^(when|whenever) ~ dies$/.test(t)) return { on: 'dies', self: true };
  if (/^(when|whenever) ~ is put into a graveyard from the battlefield$/.test(t)) return { on: 'dies', self: true };
  if (/^(when|whenever) ~ leaves the battlefield$/.test(t)) return { on: 'ltb', self: true };
  if ((m = t.match(/^whenever ~ or another (.+?)( you control)? dies$/))) {
    const f = parseFilterWords(m[1]); if (f) return { on: 'or', events: [{ on: 'dies', self: true }, { on: 'dies', self: false, filter: { ...f, other: true }, controller: m[2] ? 'you' : 'any' }] };
  }
  // no article: the permanent this Equipment / Aura is attached to (CR 702.6a, 303.4) — "an equipped creature" (any creature carrying Equipment) is the filter flag below
  if ((m = t.match(/^whenever (equipped|enchanted) (?:creature|permanent) dies$/))) return { on: 'dies', self: false, filter: { attachedToSource: true }, controller: 'any' };
  if ((m = t.match(/^whenever (?:another |an? )?(.+?) you control dies$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'dies', self: false, filter: f, controller: 'you' }; }
  if ((m = t.match(/^whenever (?:another |an? )?(.+?) (?:an opponent controls|you don't control) dies$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'dies', self: false, filter: f, controller: 'opponent' }; }
  if ((m = t.match(/^whenever (?:another |an? )?(.+?) dies$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'dies', self: false, filter: f, controller: 'any' }; }
  if (/^whenever ~ attacks$/.test(t)) return { on: 'attacks', self: true };
  if (/^whenever ~ attacks or blocks$/.test(t)) return { on: 'attacks', self: true };
  if (/^whenever ~ blocks$/.test(t)) return { on: 'blocks', self: true };
  if (/^whenever ~ becomes blocked$/.test(t)) return { on: 'becomes-blocked', self: true };
  if ((m = t.match(/^whenever (?:a|an|another) (.+?) you control attacks$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'attacks', self: false, filter: f }; }
  if (/^whenever you attack$/.test(t)) return { on: 'attacks', self: false };
  if (/^whenever ~ deals combat damage to a player$/.test(t)) return { on: 'combat-damage-player', self: true };
  if (/^whenever ~ deals combat damage to a player or planeswalker$/.test(t)) return { on: 'combat-damage-player', self: true };
  if (/^whenever ~ deals damage to an opponent$/.test(t)) return { on: 'combat-damage-player', self: true };
  if (/^whenever ~ deals damage$/.test(t) || /^whenever ~ deals combat damage$/.test(t)) return { on: 'deals-damage', self: true };
  if (/^at the beginning of your upkeep$/.test(t)) return { on: 'upkeep', whose: 'your' };
  if (/^at the beginning of each upkeep$/.test(t)) return { on: 'upkeep', whose: 'each' };
  if (/^at the beginning of each opponent's upkeep$/.test(t)) return { on: 'upkeep', whose: 'opponent' };
  if (/^at the beginning of your end step$/.test(t)) return { on: 'end-step', whose: 'your' };
  if (/^at the beginning of each end step$/.test(t)) return { on: 'end-step', whose: 'each' };
  if (/^at the beginning of the end step$/.test(t)) return { on: 'end-step', whose: 'each' };
  if (/^(when|whenever) ~ becomes the target of a spell or ability$/.test(t)) return { on: 'targeted', self: true };
  if (/^whenever you cast a spell that targets ~$/.test(t)) return { on: 'targeted', self: true, bySpellYouCast: true };
  if (/^at the beginning of your draw step$/.test(t)) return { on: 'draw-step', whose: 'your' };
  if (/^at the beginning of combat on your turn$/.test(t)) return { on: 'combat-begin', whose: 'your' };
  if (/^at the beginning of your precombat main phase$/.test(t)) return { on: 'draw-step', whose: 'your' };
  if (/^when(?:ever)? ~ is turned face up$/.test(t)) return { on: 'turned-face-up', self: true };
  if (/^whenever you attack(?: a player)?$/.test(t)) return { on: 'you-attack' };
  if (/^whenever you attack with one or more creatures$/.test(t)) return { on: 'you-attack' };
  if (/^whenever you cast a noncreature spell$/.test(t)) return { on: 'cast', filter: { notTypes: ['Creature'] }, who: 'you' };
  if (/^whenever you cast a creature spell$/.test(t)) return { on: 'cast', filter: { types: ['Creature'] }, who: 'you' };
  if (/^whenever you cast an instant or sorcery spell$/.test(t)) return { on: 'cast', filter: { types: ['Instant', 'Sorcery'] }, who: 'you' };
  if (/^whenever you cast a spell$/.test(t)) return { on: 'cast', filter: {}, who: 'you' };
  if ((m = t.match(/^whenever you cast an? (.+?) spell$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'cast', filter: f, who: 'you' }; }
  if (/^whenever an opponent casts a spell$/.test(t)) return { on: 'cast', filter: {}, who: 'opponent' };
  if (/^whenever an opponent casts a noncreature spell$/.test(t)) return { on: 'cast', filter: { notTypes: ['Creature'] }, who: 'opponent' };   // Mystic Remora
  if ((m = t.match(/^whenever an opponent casts an? (.+?) spell$/))) { const f = parseFilterWords(m[1]); if (f) return { on: 'cast', filter: f, who: 'opponent' }; }
  if (/^whenever a land enters(?: the battlefield)? under your control$/.test(t) || t === 'landfall — whenever a land enters under your control') return { on: 'landfall' };
  if (/^whenever you gain life$/.test(t)) return { on: 'life-gain' };
  if (/^whenever an opponent loses life$/.test(t)) return { on: 'life-loss-opponent' };
  if (/^whenever you sacrifice a creature$/.test(t)) return { on: 'sacrifice', filter: { types: ['Creature'] } };
  if (/^whenever you sacrifice a permanent$/.test(t)) return { on: 'sacrifice' };
  if (/^whenever ~ becomes tapped$/.test(t)) return { on: 'tapped', self: true };
  if (/^whenever you discard a card$/.test(t)) return { on: 'discard' };
  // Registry hook: family trigger heads, after every built-in head above has declined — and, in the parseCard line
  // loop, only once the built-in greedy comma re-split of the line has declined too (a trigger rule that answers the
  // narrow first-comma head would otherwise steal a line the re-split parses).
  if (useRegistry) for (const r of TRIGGER_RULES) { const ev = r.make(head); if (ev) return ev; }
  return { on: 'unknown', text: head };
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------
/** One cost phrase ("{T}", "Pay 1 life", "Exile a blue card from your hand", "Sacrifice a creature"). */
function parseCostPhrase(p: string, useRegistry = true): AbilityCost | null {
  const cost: AbilityCost = {};
  const raw = p.trim().replace(/\.$/, ''); const pl = raw.toLowerCase();
  let m: RegExpMatchArray | null;
  if (/^(\{[^}]+\})+$/.test(raw)) {
    // "{E}" is energy, not mana (CR 118.12): "unless you pay {E}" (Electrozoa) reaches here as a bare symbol string
    const energy = energyOf(raw); const symbols = energy ? raw.replace(/\{E\}/g, '') : raw;
    if (energy) cost.energy = energy;
    if (symbols === '{T}') cost.tap = true;
    else if (symbols === '{Q}') cost.untap = true;
    else if (symbols.includes('{T}')) { cost.tap = true; cost.mana = parseManaCost(symbols.replace('{T}', ''))!; }
    else if (symbols) cost.mana = parseManaCost(symbols)!;
  }
  else if (pl === 'sacrifice ~' || /^sacrifice this (creature|artifact|permanent|enchantment|land)$/.test(pl)) cost.sacrificeSelf = true;
  else if ((m = pl.match(/^sacrifice (a|an|another) (.+)$/))) { const f = parseFilterWords(m[2]); if (!f) return null; if (m[1] === 'another') f.other = true; cost.sacrifice = f; }   // "another": not the source itself (CR 601.2h)
  else if ((m = pl.match(/^discard (a|\w+) cards?$/))) cost.discard = num(m[1]) as number;
  else if (pl === 'discard this card' || pl === 'discard ~') cost.discardSelf = true;
  else if (pl === 'discard your hand') cost.discardHand = true;
  else if ((m = pl.match(/^pay (\d+) life$/))) cost.payLife = Number(m[1]);
  else if ((m = pl.match(/^pay ((?:\{e\}\s*)+)$/))) cost.energy = (m[1].match(/\{e\}/g) ?? []).length;
  else if ((m = pl.match(/^remove (a|\w+) \+1\/\+1 counters? from ~$/))) cost.removeCounters = removeCountersCost('+1/+1', m[1]);
  else if ((m = pl.match(/^remove (a|\w+) (\w+) counters? from ~$/))) cost.removeCounters = removeCountersCost(m[2], m[1]);
  else if ((m = pl.match(/^remove (a|\w+) counters? from ~$/))) cost.removeCounters = removeCountersCost('any', m[1]);
  else if ((m = pl.match(/^exile (a|\w+) cards? from your graveyard$/))) cost.exileFromGraveyard = num(m[1]) as number;
  else if ((m = pl.match(/^exile (\w+|any number of) other cards? from your graveyard(?: with (\w+) or more card types among them)?$/))) cost.exileOtherFromGraveyard = { count: m[1] === 'any number of' ? 'any' : num(m[1]) as number, minCardTypes: m[2] ? num(m[2]) as number : undefined };
  else if ((m = pl.match(/^exile (?:a|an) (.+?) card from your hand$/))) { const f = parseFilterWords(m[1]); if (!f) return null; cost.exileFromHand = { filter: f, count: 1 }; }
  else if ((m = pl.match(/^return (?:a|an) (.+?) you control to its owner's hand$/))) { const f = parseFilterWords(m[1]); if (!f) return null; cost.returnToHand = f; }
  else if ((m = pl.match(/^tap an untapped (.+?) you control$/))) { const f = parseFilterWords(m[1]); if (!f) return null; cost.tapUntappedCreature = f; }
  else if ((m = pl.match(/^tap any number of (other )?(?:untapped )?creatures you control with total power (\d+) or (?:more|greater)$/))) cost.tapCreaturesTotalPower = { power: Number(m[2]), other: !!m[1] };
  // Registry hook: family cost phrases, after every built-in phrase above has declined. A cost rule makes
  // parseActivatedLine claim a line the built-ins could not, which would pre-empt the static branch *below* it in the
  // line loop — so the line loop enables this only on its second pass (see parseCard).
  else { if (useRegistry) for (const r of COST_RULES) { const c = r.make(raw); if (c) return c; } return null; }
  return cost;
}

function parseCost(costText: string, useRegistry = true): AbilityCost | null {
  const cost: AbilityCost = {};
  const parts = costText.split(/,\s*/).map(p => p.trim()).filter(Boolean);
  for (const p of parts) {
    const c = parseCostPhrase(p, useRegistry);
    // the failing comma-part is the fragment; `partial` when any other part of the cost is a cost phrase we know
    if (!c) { if (parseTrace) trace('cost', p, useRegistry, { partial: parts.some(q => q !== p && parseCostPhrase(q, useRegistry) !== null) }); return null; }
    Object.assign(cost, c);
  }
  return cost;
}

function describeCost(c: AbilityCost): string {
  const parts: string[] = [];
  if (c.mana) parts.push(c.mana.raw);
  if (c.payLife) parts.push(`pay ${c.payLife} life`);
  if (c.exileFromHand) parts.push(`exile a ${c.exileFromHand.filter.colors?.map(x => ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' })[x]).join('/') ?? ''} card from hand`.replace('  ', ' '));
  if (c.returnToHand) parts.push(`return ${c.returnToHand.subtypes?.join('/') ?? 'a permanent'} to hand`);
  if (c.sacrifice) parts.push('sacrifice a permanent');
  if (c.discard) parts.push(`discard ${c.discard}`);
  if (c.exileOtherFromGraveyard) parts.push('exile cards from graveyard');
  return parts.join(', ') || 'free';
}

// ---------------------------------------------------------------------------
// Static abilities
// ---------------------------------------------------------------------------
/** Singular creature type from a plural (Elves → Elf, Dwarves → Dwarf, Goblins → Goblin). */
/** "Zombies" → "Zombie", "Elves" → "Elf", "Plains" → "Plains", "Heroes" → "Hero": the vocabulary's spelling when the word is a subtype, the plain English rule otherwise. */
function singular(w: string): string { const sub = subtypeWord(w); if (sub) return sub; if (/ves$/.test(w)) return w.slice(0, -3) + 'f'; if (/ies$/.test(w)) return w.slice(0, -3) + 'y'; return w.replace(/s$/, ''); }

function spellTypeFilter(word: string): Filter {
  const w = word.toLowerCase();
  if (w === 'instant and sorcery') return { types: ['Instant', 'Sorcery'] };
  if (w.startsWith('non') && w.slice(3) in TYPE_WORDS) return { notTypes: [TYPE_WORDS[w.slice(3)]] };
  return w in TYPE_WORDS ? { types: [TYPE_WORDS[w]] } : { subtypes: [word] };
}

/** Parse the text inside quotes on a granting static ('Creatures you control have "When this creature dies, draw a card."'). */
/** Modes often carry a flavour name ("Cure Wounds — You gain 2 life."); the name is not rules text. */
function stripModeName(mode: string): string { return mode.replace(/^[A-Z][^—.]{0,34} — (?=[A-Z~])/, '').trim(); }
/**
 * Two passes over the same two shapes, like every other ladder here: the built-ins alone, then — only if both shapes
 * declined — the whole ladder again with the registry enabled. Everything that second pass can reach is folded into
 * ANY.granted: the cost phrases and "Activate only if ..." conditions behind the activated shape, the trigger rules
 * behind the triggered one, and the effect rules both bodies go through, because here (unlike the line loop) an
 * `unknown` effect makes the shape decline and hand the line back to the caller. Doing it as one ladder twice also
 * fixes an earlier hole: a "When ..., ..." text whose head the built-ins declined used to `return null` above the
 * registry retry, so a trigger (or cost) rule never saw it at all.
 */
function parseGrantedAbility(text: string, useRegistry = true): Ability | null {
  return grantedShape(text, false) ?? (useRegistry && ANY.granted ? grantedShape(text, true) : null);
}
function grantedShape(text: string, useRegistry: boolean): Ability | null {
  const body = text.trim().replace(/\.$/, '');
  const act = parseActivatedLine(body + '.', useRegistry, useRegistry);
  if (act && act.effects.every(e => e.op !== 'unknown')) return act;
  const tm = body.match(/^(When|Whenever|At) (.+?), (.+)$/i);
  if (tm) {
    const ev = parseTrigger(`${tm[1]} ${tm[2]}`, useRegistry);
    if (ev.on === 'unknown') return null;
    let inner = tm[3]; const optional = /^you may /i.test(inner);
    if (optional) inner = inner.replace(/^you may /i, '');
    inner = inner.replace(/\bthis creature\b|\bthis permanent\b/gi, '~');
    const selfEv = 'self' in ev && ev.self === true;
    let effs = withFrame(!selfEv, [], () => asTriggerBody(() => parseEffects(inner, useRegistry)), selfEv ? null : { op: 'bind', as: 'that', from: 'triggering' });
    if (effs.some(e => e.op === 'unknown')) return null;
    if (!selfEv && mentionsThat(effs)) effs = [{ op: 'bind', as: 'that', from: 'triggering' }, ...effs];   // same reason as triggerBody
    return { kind: 'triggered', event: ev, effects: effs, text, ...(optional ? { optional: true } : {}) };
  }
  return null;
}
/**
 * `useRegistry` gates the static rules at the bottom *and* every sub-parse a built-in template here uses to decide
 * whether it claims the line (its "as long as <condition>" slots, the quoted ability of a grant, the effects of a
 * granted mana ability). They have to move together: parseStatic's built-ins-only pass runs above the spell-text
 * branch of the line loop, so a rule answering one of those slots could take a line off an instant or sorcery.
 */
/**
 * Every `subtypes` entry of a parse in the vocabulary's spelling ("Slivers" → "Sliver", "Golems" → "Golem"), or null
 * when a word is no subtype at all: the static templates below capture any capitalised word ("All Slivers have …",
 * "Other Golems get +1/+1"), and a filter spelt the way the text pluralised it matches no permanent.
 */
function withVocabularySubtypes<T extends object>(v: T): T | null {
  let ok = true;
  const walk = (x: unknown): void => {
    if (!ok || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    if (Array.isArray(o.subtypes) && o.subtypes.every(t => typeof t === 'string')) {
      const fixed = (o.subtypes as string[]).map(t => subtypeWord(t));
      if (fixed.some(t => t === null)) { ok = false; return; }
      o.subtypes = fixed;
    }
    for (const k of Object.keys(o)) if (k !== 'subtypes') walk(o[k]);
  };
  walk(v);
  return ok ? v : null;
}

function parseStatic(line: string, card: { types: CardType[]; subtypes: string[] }, useRegistry = true): StaticEffect | StaticEffect[] | null {
  const st = parseStaticRaw(line, card, useRegistry);
  return st === null ? null : withVocabularySubtypes(st);
}

function parseStaticRaw(line: string, card: { types: CardType[]; subtypes: string[] }, useRegistry = true): StaticEffect | StaticEffect[] | null {
  const t = line.trim().replace(/\.$/, '');
  let m: RegExpMatchArray | null;
  // anthems
  if ((m = t.match(/^(other )?(?:creatures|zombies|creature) ?(?:you control )?have (plains|island|swamp|mountain|forest|desert)walk$/i))) return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'] }, scope: m[1] ? 'other-you-control' : 'you-control', keywords: ['landwalk'], landwalk: [m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()] };
  if ((m = t.match(/^([Oo]ther )?([A-Z][a-z]+) creatures have (plains|island|swamp|mountain|forest|desert)walk$/))) return { kind: 'anthem', power: 0, toughness: 0, filter: { subtypes: [m[2]], ...(m[1] ? { other: true } : {}) }, scope: 'all', keywords: ['landwalk'], landwalk: [m[3][0].toUpperCase() + m[3].slice(1).toLowerCase()] };
  if ((m = t.match(/^as long as ~ is in your graveyard and you control an? (\w+), creatures you control have (plains|island|swamp|mountain|forest|desert)walk$/i))) { const f = parseFilterWords(m[1]); if (f) return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'] }, scope: 'you-control', keywords: ['landwalk'], landwalk: [m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()], whileInGraveyard: true, condition: { kind: 'controls', who: 'you', filter: f, atLeast: 1 } }; }
  if ((m = t.match(/^([Oo]ther )?([A-Z][a-z]+) (?:creatures )?get ([+-]\d+)\/([+-]\d+) and have (plains|island|swamp|mountain|forest|desert)walk$/))) return { kind: 'anthem', power: Number(m[3]), toughness: Number(m[4]), filter: { subtypes: [m[2]], ...(m[1] ? { other: true } : {}) }, scope: 'all', keywords: ['landwalk'], landwalk: [m[5][0].toUpperCase() + m[5].slice(1).toLowerCase()] };
  if ((m = t.match(/^(other )?creatures you control get ([+-]\d+)\/([+-]\d+)(?: and have (.+))?$/i))) {
    const kw = m[4] ? kwList(m[4]) : []; if (kw === null) return null;
    return { kind: 'anthem', power: Number(m[2]), toughness: Number(m[3]), filter: { types: ['Creature'] }, scope: m[1] ? 'other-you-control' : 'you-control', keywords: kw };
  }
  if ((m = t.match(/^other (tapped|untapped) creatures you control have (.+)$/i))) { const kw = kwList(m[2]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'], ...(m[1].toLowerCase() === 'tapped' ? { tapped: true } : { untapped: true }) }, scope: 'other-you-control', keywords: kw }; }
  if ((m = t.match(/^during your turn, (?:other )?creatures you control have (.+)$/i))) { const kw = kwList(m[1]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'] }, scope: /^during your turn, other/i.test(t) ? 'other-you-control' : 'you-control', keywords: kw, condition: { kind: 'your-turn' } }; }
  if ((m = t.match(/^other permanents you control have (.+)$/i))) { const kw = kwList(m[1]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: {}, scope: 'other-you-control', keywords: kw, anyPermanent: true }; }
  if ((m = t.match(/^(?:each )?creatures? you control with (?:a |one or more )?\+1\/\+1 counters? on (?:it|them) (?:have|has) (.+)$/i))) { const kw = kwList(m[1]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'], withCounter: '+1/+1' }, scope: 'you-control', keywords: kw }; }
  if ((m = t.match(/^(?:each )?creatures? you control with (?:a |one or more )?counters? on (?:it|them) (?:have|has) (.+)$/i))) { const kw = kwList(m[1]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'], withCounters: true }, scope: 'you-control', keywords: kw }; }
  if ((m = t.match(/^permanents you control with counters on them have (.+)$/i))) { const kw = kwList(m[1]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { withCounters: true }, scope: 'you-control', keywords: kw, anyPermanent: true }; }
  if ((m = t.match(/^[Oo]ther ([A-Z][a-z]+) creatures get ([+-]\d+)\/([+-]\d+)$/))) return { kind: 'anthem', power: Number(m[2]), toughness: Number(m[3]), filter: { subtypes: [m[1]] }, scope: 'all', keywords: [] };
  if ((m = t.match(/^[Oo]ther ([A-Z][a-z]+) creatures have (.+)$/))) { const kw = kwList(m[2]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { subtypes: [m[1]] }, scope: 'all', keywords: kw }; }
  if ((m = t.match(/^([A-Z][a-z]+)s you control and other ([A-Z][a-z]+)s you control get ([+-]\d+)\/([+-]\d+)(?: and have (.+))?$/))) { const kw = m[5] ? kwList(m[5]) : []; if (!kw) return null; return [{ kind: 'anthem', power: Number(m[3]), toughness: Number(m[4]), filter: { subtypes: [m[1]] }, scope: 'you-control', keywords: kw }, { kind: 'anthem', power: Number(m[3]), toughness: Number(m[4]), filter: { subtypes: [m[2]] }, scope: 'other-you-control', keywords: kw }]; }
  if ((m = t.match(/^as long as ~ is in your graveyard and you control an? (\w+), creatures you control have (.+)$/i))) { const kw = kwList(m[2]); const f = parseFilterWords(m[1]); if (!kw || !f) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'] }, scope: 'you-control', keywords: kw, whileInGraveyard: true, condition: { kind: 'controls', who: 'you', filter: f, atLeast: 1 } }; }
  if ((m = t.match(/^creatures you control of the chosen type get ([+-]\d+)\/([+-]\d+)$/i))) return { kind: 'anthem', power: Number(m[1]), toughness: Number(m[2]), filter: { types: ['Creature'], chosenType: true }, scope: 'you-control' };
  if (/^~ assigns combat damage equal to its toughness rather than its power$/i.test(t)) return { kind: 'damage-by-toughness', scope: 'self' };
  if (/^each creature you control with toughness greater than its power assigns combat damage equal to its toughness rather than its power$/i.test(t)) return { kind: 'damage-by-toughness', scope: 'you-control', onlyWhenGreater: true };
  if ((m = line.match(/^(?:Each |All )?(.+?) you control (?:has|have) "\{T\}: (Add [^"]+?)\.(?: Spend this mana only to cast (instant and sorcery|creature|noncreature) spells\.)?"$/i))) {
    const f = parseFilterWords(m[1].replace(/ and /g, ' or ')) ?? subtypeFilter(m[1]);
    const eff = parseEffects(m[2], useRegistry);
    if (f && eff.length === 1 && eff[0].op === 'add-mana') { const e0 = { ...eff[0] }; if (m[3]) e0.restriction = m[3].toLowerCase() === 'instant and sorcery' ? 'instant-sorcery' : m[3].toLowerCase() === 'creature' ? 'creature-spell' : undefined; return { kind: 'grant-mana-ability', filter: singularSubtypes(f), effect: e0 }; }
  }
  if ((m = line.match(/^(?:Each |All )?(.+?) you control (?:has|have) "(.+)"$/i)) && !/^\{T\}: Add /i.test(m[2])) {
    const f = parseFilterWords(m[1].replace(/ and /g, ' or ')) ?? subtypeFilter(m[1]);
    const inner = f ? parseGrantedAbility(m[2], useRegistry) : null;
    if (f && inner) return { kind: 'grant-ability', filter: singularSubtypes(f), scope: 'you-control', ability: inner };
  }
  if ((m = line.match(/^All (creatures|permanents) have "(.+)"$/)) && !/^\{T\}: Add /i.test(m[2])) {   // "All creatures have …": every creature, not a subtype named All
    const inner = parseGrantedAbility(m[2], useRegistry);
    if (inner) return { kind: 'grant-ability', filter: m[1] === 'creatures' ? { types: ['Creature'] } : {}, scope: 'all', ability: inner };
  }
  if ((m = line.match(/^(?:Each |All )?(Other )?([A-Z][a-z]+)s?(?: creatures| permanents)? have "(.+)"$/)) && !/^\{T\}: Add /i.test(m[3])) {
    const inner = parseGrantedAbility(m[3], useRegistry);
    if (inner) return { kind: 'grant-ability', filter: { subtypes: [m[2]], ...(m[1] ? { other: true } : {}) }, scope: 'all', ability: inner };
  }
  if ((m = line.match(/^Enchanted (?:land|creature|permanent) has "(.+)"$/i)) && !/^\{T\}: Add /i.test(m[1])) {
    const inner = parseGrantedAbility(m[1], useRegistry);
    if (inner) return { kind: 'grant-ability', enchanted: true, scope: 'you-control', ability: inner };
  }
  if ((m = line.match(/^Enchanted (?:land|creature|permanent) has "\{T\}: (Add [^"]+?)\."$/i))) {
    const eff = parseEffects(m[1], useRegistry);
    if (eff.length === 1 && eff[0].op === 'add-mana') return { kind: 'grant-mana-ability', enchanted: true, effect: eff[0] };
  }
  if (/^you may cast spells as though they had flash$/i.test(t)) return { kind: 'flash-for', filter: {} };
  if (/^if you would lose unspent mana, that mana becomes red instead$/i.test(t)) return { kind: 'unspent-mana-becomes-red' };
  if (/^you may play lands from your graveyard$/i.test(t)) return { kind: 'play-lands-from', zone: 'graveyard' };
  if (/^you may play lands from the top of your library$/i.test(t)) return { kind: 'play-lands-from', zone: 'library-top' };
  if (/^play with the top card of your library revealed$/i.test(t)) return { kind: 'look-top-anytime' };
  if ((m = t.match(/^each creature spell you cast with toughness greater than its power costs (\{\d+\}) less to cast$/i))) return { kind: 'cost-adjust', filter: { types: ['Creature'], toughnessGtPower: true }, amount: -Number(m[1].slice(1, -1)), who: 'you' };
  if ((m = t.match(/^you may cast (.+?) spells(?: and (.+?) spells)? as though they had flash$/i))) { const a = parseFilterWords(m[1]); const b = m[2] ? parseFilterWords(m[2]) : null; if (!a || (m[2] && !b)) return null; return { kind: 'flash-for', filter: b ? { ...a, ...b, types: [...(a.types ?? []), ...(b.types ?? [])] } : a }; }
  if (/^if a triggered ability of equipped creature triggers, that ability triggers an additional time$/i.test(t)) return { kind: 'trigger-twice', equipped: true };
  if (/^if a land entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/i.test(t)) return { kind: 'trigger-twice', event: 'land-etb' };
  if (/^if a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/i.test(t)) return { kind: 'trigger-twice', event: 'dies' };
  if (/^if you casting or copying an instant or sorcery spell causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/i.test(t)) return { kind: 'trigger-twice', event: 'cast', filter: { types: ['Instant', 'Sorcery'] } };
  if (/^if an effect would create one or more tokens under your control, it creates twice that many of those tokens instead$/i.test(t) || /^if one or more tokens would be created under your control, twice that many of those tokens are created instead$/i.test(t)) return { kind: 'tokens-replacement', mode: 'double' };
  if (/^if an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead$/i.test(t)) return { kind: 'counters-replacement', mode: 'double' };
  if ((m = t.match(/^if one or more \+1\/\+1 counters would be put on (a permanent|an artifact or creature|a creature) you control, that many plus one \+1\/\+1 counters are put on (?:it|that permanent) instead$/i))) return { kind: 'counters-replacement', mode: 'plus-one', counter: '+1/+1', ...(m[1] === 'a creature' ? { filter: { types: ['Creature'] } } : m[1].startsWith('an artifact') ? { filter: { types: ['Artifact', 'Creature'] } } : {}) };
  if ((m = t.match(/^whenever you tap an? (\w+) for mana, add an additional (\{[^}]+\})$/i))) { const f = parseFilterWords(m[1]); const mana = parseManaCost(m[2]); if (!f || !mana) return null; return { kind: 'extra-mana-on-tap', filter: f, mana: manaSymbolsOf(mana) }; }
  if ((m = t.match(/^whenever you tap a creature for mana, add an additional (\{[^}]+\})$/i))) { const mana = parseManaCost(m[1]); if (!mana) return null; return { kind: 'extra-mana-on-tap', filter: { types: ['Creature'] }, mana: manaSymbolsOf(mana) }; }
  if (/^whenever enchanted (?:land|forest) is tapped for mana, its controller adds an additional one mana of the chosen color$/i.test(t)) return { kind: 'extra-mana-on-tap', enchanted: true, mana: 'chosen-color' };
  if (/^during your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments$/i.test(t) || /^your opponents can't cast spells during your turn$/i.test(t)) return { kind: 'opponents-cant-cast', during: 'your-turn' };
  // "Enchanted creature has base power and toughness 9/9 [and has flying, …]" (Super State): layer 7b as a static (CR 613.4b)
  if ((m = t.match(/^(enchanted|equipped) (?:creature|permanent) has base power and toughness (\d+)\/(\d+)(?: and (?:has|gains) (.+))?$/i))) { const kw = m[4] ? kwList(m[4]) : []; if (!kw) return null; return { kind: 'set-pt', power: Number(m[2]), toughness: Number(m[3]), scope: m[1].toLowerCase() as 'enchanted' | 'equipped', ...(kw.length ? { keywords: kw } : {}) }; }
  if ((m = t.match(/^(other )?creatures you control have (.+)$/i))) { const kw = kwList(m[2]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { types: ['Creature'] }, scope: m[1] ? 'other-you-control' : 'you-control', keywords: kw }; }
  if ((m = t.match(/^(other )?([A-Z][a-z]+)s? (?:creatures )?you control get ([+-]\d+)\/([+-]\d+)(?: and have (.+))?$/)) && subtypeWord(m[2])) {
    const kw = m[5] ? kwList(m[5]) : []; if (kw === null) return null;
    return { kind: 'anthem', power: Number(m[3]), toughness: Number(m[4]), filter: { subtypes: [singular(m[2])] }, scope: m[1] ? 'other-you-control' : 'you-control', keywords: kw };
  }
  if ((m = t.match(/^(other )?([A-Z][a-z]+ves) (?:creatures )?you control get ([+-]\d+)\/([+-]\d+)(?: and have (.+))?$/)) && subtypeWord(m[2])) {
    const kw = m[5] ? kwList(m[5]) : []; if (kw === null) return null;
    return { kind: 'anthem', power: Number(m[3]), toughness: Number(m[4]), filter: { subtypes: [singular(m[2])] }, scope: m[1] ? 'other-you-control' : 'you-control', keywords: kw };
  }
  if ((m = t.match(/^([Oo]ther )?([A-Z][a-z]+)s? (?:creatures )?you control have (.+)$/)) && subtypeWord(m[2])) { const kw = kwList(m[3]); if (!kw) return null; return { kind: 'anthem', power: 0, toughness: 0, filter: { subtypes: [m[2]] }, scope: m[1] ? 'other-you-control' : 'you-control', keywords: kw }; }
  // "Attacking creatures you control have double strike", "Land creatures you control have flying", "Nonblack creatures
  // you control have …": the filter word alone (a `types` list is any-of, so "land creature" would name every land and
  // every creature), the anthem's own creature gate does the rest
  if ((m = t.match(/^(other )?(\w+) creatures you control have (.+)$/i)) && !/^(other|creatures?|permanents?)$/i.test(m[2])) {
    const f = parseFilterWords(m[2]); const kw = kwList(m[3]); if (!f || !kw || !kw.length || f.subtypes) return null;
    return { kind: 'anthem', power: 0, toughness: 0, filter: f, scope: m[1] ? 'other-you-control' : 'you-control', keywords: kw };
  }
  // "Artifacts you control have hexproof", "Other enchantments you control have indestructible": every permanent of the type
  if ((m = t.match(/^(other )?(artifacts|enchantments|lands|planeswalkers|(?:\w+ )?permanents) you control have (.+)$/i))) {
    const f = parseFilterWords(m[2].replace(/s$/, '')); const kw = kwList(m[3]); if (!f || !kw || !kw.length || f.subtypes) return null;
    return { kind: 'anthem', power: 0, toughness: 0, filter: f, scope: m[1] ? 'other-you-control' : 'you-control', keywords: kw, anyPermanent: true };
  }
  if ((m = t.match(/^(?:all )?(other )?creatures get ([+-]\d+)\/([+-]\d+)$/i))) return { kind: 'anthem', power: Number(m[2]), toughness: Number(m[3]), filter: { types: ['Creature'] }, scope: 'all' };
  if ((m = t.match(/^(other )?(\w+) creatures you control get ([+-]\d+)\/([+-]\d+)$/i))) { const f = parseFilterWords(m[2] + ' creature'); if (!f) return null; return { kind: 'anthem', power: Number(m[3]), toughness: Number(m[4]), filter: f, scope: m[1] ? 'other-you-control' : 'you-control' }; }
  if ((m = t.match(/^creatures your opponents control get ([+-]\d+)\/([+-]\d+)$/i))) return { kind: 'anthem', power: Number(m[1]), toughness: Number(m[2]), filter: { types: ['Creature'] }, scope: 'all', keywords: [] , ...({ opponentsOnly: true } as object) };
  // self P/T
  // "for each other snow permanent you control": the count is over PERMANENTS when the words say so, and "other" excludes the source (9.0c re-review 2)
  if ((m = t.match(/^~ gets \+1\/\+1 for each (other )?(.+?) you control$/i))) { const f = parseFilterWords(m[2]); if (!f) return null; const c = eachYouControl(m[2], m[1], f); return { kind: 'self-pt', power: { ...c, plus: 0 }, toughness: { ...c, plus: 0 } }; }
  if ((m = t.match(/^~ gets \+1\/\+0 for each (other )?(.+?) you control$/i))) { const f = parseFilterWords(m[2]); if (!f) return null; return { kind: 'self-pt', power: eachYouControl(m[2], m[1], f), toughness: 0 }; }
  if (/^~'s power and toughness are each equal to the number of creatures you control$/i.test(t)) return { kind: 'self-pt', power: { count: 'creatures-you-control' }, toughness: { count: 'creatures-you-control' } };
  if (/^~'s power and toughness are each equal to the number of cards in your hand$/i.test(t)) return { kind: 'self-pt', power: { count: 'cards-in-hand' }, toughness: { count: 'cards-in-hand' } };
  if (/^~'s power and toughness are each equal to the number of lands you control$/i.test(t)) return { kind: 'self-pt', power: { count: 'lands-you-control' }, toughness: { count: 'lands-you-control' } };
  if (/^~'s power is equal to the number of card types among cards in your graveyard and its toughness is equal to that number plus 1$/i.test(t)) return { kind: 'self-pt', power: { count: 'card-types-in-graveyard' }, toughness: { count: 'card-types-in-graveyard', plus: 1 } };
  if (/^~'s power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1$/i.test(t)) return { kind: 'self-pt', power: { count: 'card-types-in-all-graveyards' }, toughness: { count: 'card-types-in-all-graveyards', plus: 1 } };
  if (/^~'s power and toughness are each equal to the number of card types among cards in all graveyards$/i.test(t)) return { kind: 'self-pt', power: { count: 'card-types-in-all-graveyards' }, toughness: { count: 'card-types-in-all-graveyards' } };
  if (/^~'s power and toughness are each equal to the number of card types among cards in your graveyard$/i.test(t)) return { kind: 'self-pt', power: { count: 'card-types-in-graveyard' }, toughness: { count: 'card-types-in-graveyard' } };
  if ((m = t.match(/^~ gets ([+-]\d+)\/([+-]\d+) as long as (.+)$/i))) { const c = parseCondition(m[3], useRegistry); if (c.kind === 'unknown') return null; return { kind: 'self-pt', power: Number(m[1]), toughness: Number(m[2]), ...({ condition: c } as object) }; }
  if ((m = t.match(/^~ has (.+) as long as (.+)$/i))) { const kw = kwList(m[1]); const c = parseCondition(m[2], useRegistry); if (!kw || c.kind === 'unknown') return null; return { kind: 'self-keywords', keywords: kw, condition: c }; }
  if ((m = t.match(/^as long as (.+), ~ has (.+)$/i))) { const kw = kwList(m[2]); const c = parseCondition(m[1], useRegistry); if (!kw || c.kind === 'unknown') return null; return { kind: 'self-keywords', keywords: kw, condition: c }; }
  if ((m = t.match(/^as long as (.+), ~ gets ([+-]\d+)\/([+-]\d+)$/i))) { const c = parseCondition(m[1], useRegistry); if (c.kind === 'unknown') return null; return { kind: 'self-pt', power: Number(m[2]), toughness: Number(m[3]), ...({ condition: c } as object) }; }
  if ((m = t.match(/^~ can't be blocked by creatures with power (\d+) or (greater|less)$/i))) return { kind: 'self-keywords', keywords: [] , ...({ evasion: { powerLE: m[2] === 'greater' ? Number(m[1]) - 1 : undefined, powerGE: m[2] === 'less' ? Number(m[1]) + 1 : undefined } } as object) };
  if (/^~ can't be blocked except by creatures with flying or reach$/i.test(t)) return { kind: 'self-keywords', keywords: ['flying'] };
  if (/^~ can't be blocked except by two or more creatures$/i.test(t)) return { kind: 'self-keywords', keywords: ['menace'] };
  if (/^~ can block only creatures with flying$/i.test(t)) return { kind: 'self-keywords', keywords: [], ...({ blockOnlyFlying: true } as object) };
  if (/^~ can't be blocked by (black|blue|green|red|white) creatures$/i.test(t)) return { kind: 'self-keywords', keywords: [], ...({ evasion: { notColors: [COLOR_WORDS[RegExp.$1.toLowerCase()]] } } as object) };
  if (/^~ attacks each combat if able$/i.test(t)) return { kind: 'self-keywords', keywords: [], ...({ mustAttack: true } as object) };
  if (/^~ doesn't untap during your untap step$/i.test(t)) return { kind: 'self-keywords', keywords: [], ...({ doesntUntap: true } as object) };
  if (/^~ enters (?:the battlefield )?tapped$/i.test(t)) return { kind: 'self-keywords', keywords: [], ...({ entersTapped: true } as object) };
  if (/^~ can't be countered$/i.test(t) || /^this spell can't be countered$/i.test(t)) return { kind: 'cant-be-countered' };
  if (/^creatures your opponents control enter (?:the battlefield )?tapped$/i.test(t)) return { kind: 'opponent-creatures-etb-tapped' };
  if ((m = t.match(/^(creature|instant and sorcery|artifact|noncreature|enchantment|instant|sorcery|planeswalker) spells( you cast| your opponents cast)? cost \{(\d+)\} (less|more) to cast$/i))) {
    const f = spellTypeFilter(m[1]); const sign = m[4].toLowerCase() === 'less' ? 1 : -1;
    return { kind: 'cost-adjust', filter: f, amount: sign * Number(m[3]), who: m[2] === ' you cast' ? 'you' : m[2] === ' your opponents cast' ? 'opponent' : 'any' };
  }
  if ((m = t.match(/^spells( you cast| your opponents cast)? cost \{(\d+)\} (less|more) to cast$/i))) return { kind: 'cost-adjust', filter: {}, amount: (m[3].toLowerCase() === 'less' ? 1 : -1) * Number(m[2]), who: m[1] === ' you cast' ? 'you' : m[1] === ' your opponents cast' ? 'opponent' : 'any' };
  if ((m = t.match(/^spells you cast from anywhere other than your hand cost \{(\d+)\} less to cast$/i))) return { kind: 'cost-adjust', filter: {}, amount: Number(m[1]), who: 'you', from: 'non-hand' };
  if ((m = t.match(/^(\w+) spells you cast cost \{(\d+)\} less to cast$/i))) { const f = parseFilterWords(m[1]); return f && { kind: 'cost-adjust', filter: f, amount: Number(m[2]), who: 'you' }; }   // "Green spells" (Emerald Medallion), "Goblin spells\"
  if ((m = t.match(/^as long as (.+?), ~ gets ([+-]\d+)\/([+-]\d+), has (.+?)(?:, and attacks each combat if able)?$/i))) {
    const c = parseCondition(m[1], useRegistry); const kw = kwList(m[4]); if (c.kind === 'unknown' || !kw) return null;
    return [{ kind: 'self-pt', power: Number(m[2]), toughness: Number(m[3]), ...({ condition: c } as object) }, { kind: 'self-keywords', keywords: kw, condition: c, ...(/attacks each combat if able/i.test(t) ? { mustAttack: true } : {}) } as StaticEffect];
  }
  if (/^if you would gain life, you gain twice that much life instead$/i.test(t)) return { kind: 'lifegain-multiplier' };
  if ((m = t.match(/^if you would gain life, you gain that much life plus (\d+) instead$/i))) return { kind: 'lifegain-multiplier', plus: Number(m[1]) };
  if (/^~ can be your commander$/i.test(t)) return { kind: 'can-be-commander' };
  if (/^you have no maximum hand size$/i.test(t)) return { kind: 'no-max-hand-size' };
  if (/^~ can block an additional creature each combat$/i.test(t)) return { kind: 'extra-blocks', amount: 1 };
  if (/^~ can block any number of creatures$/i.test(t)) return { kind: 'extra-blocks', amount: 99 };
  if (/^~ can't be blocked by more than one creature$/i.test(t)) return { kind: 'cant-be-blocked-by-more-than-one' };
  if ((m = t.match(/^during your turn, ~ has (.+)$/i))) { const kw = kwList(m[1]); if (kw) return { kind: 'self-keywords', keywords: kw, condition: { kind: 'your-turn' } }; }
  if ((m = t.match(/^all (\w+) creatures get ([+-]\d+)\/([+-]\d+)$/i))) return { kind: 'anthem', power: Number(m[2]), toughness: Number(m[3]), filter: { subtypes: [m[1][0].toUpperCase() + m[1].slice(1)] }, scope: 'all' };
  if ((m = t.match(/^(other )?creatures you control with flying get ([+-]\d+)\/([+-]\d+)$/i))) return { kind: 'anthem', power: Number(m[2]), toughness: Number(m[3]), filter: { types: ['Creature'], flying: true }, scope: m[1] ? 'other-you-control' : 'you-control' };
  if ((m = t.match(/^~ gets ([+-])(\d+)\/([+-])(\d+) for each (.+)$/i))) { const a = parseEachPhrase(m[5]); if (!a) return null; const mk = (k: number, sign: string): Amount => k === 0 ? 0 : ({ ...(a as object), times: (sign === '-' ? -1 : 1) * k } as Amount); return { kind: 'self-pt', power: mk(Number(m[2]), m[1]), toughness: mk(Number(m[4]), m[3]) }; }
  if ((m = t.match(/^~'s power and toughness are each equal to (.+)$/i))) { const a = parseAmountPhrase(m[1]); if (a !== null) return { kind: 'self-pt', power: a, toughness: a }; }
  if ((m = t.match(/^~'s power is equal to (.+?) and its toughness is equal to that number plus (\d+)$/i))) { const a = parseAmountPhrase(m[1]); if (a !== null && typeof a === 'object') return { kind: 'self-pt', power: a, toughness: { ...a, plus: (a.plus ?? 0) + Number(m[2]) } }; }
  if ((m = t.match(/^~'s power is equal to (.+)$/i))) { const a = parseAmountPhrase(m[1]); if (a !== null) return { kind: 'self-pt', power: a, toughness: 0 }; }
  if ((m = t.match(/^~'s toughness is equal to (.+)$/i))) { const a = parseAmountPhrase(m[1]); if (a !== null) return { kind: 'self-pt', power: 0, toughness: a }; }
  if ((m = t.match(/^~'s power is equal to the number of creatures you control$/i))) return { kind: 'self-pt', power: { count: 'creatures-you-control' }, toughness: 0 };
  if ((m = t.match(/^~'s power is equal to the number of (.+?) you control$/i))) { const f = parseFilterWords(m[1]); if (!f) return null; return { kind: 'self-pt', power: { count: 'permanents-you-control', filter: f }, toughness: 0 }; }
  if ((m = t.match(/^~'s power is equal to the number of (.+?) cards? in your graveyard$/i))) { const f = parseFilterWords(m[1].replace(/ and /g, ' or ')); if (!f) return null; return { kind: 'self-pt', power: { count: 'cards-in-graveyard', filter: f }, toughness: 0 }; }
  if ((m = t.match(/^~'s power is equal to the number of \+1\/\+1 counters on (.+?) you control$/i))) { const f = parseFilterWords(m[1]); if (!f) return null; return { kind: 'self-pt', power: { count: 'counters-on-permanents', filter: f, counter: '+1/+1' }, toughness: 0 }; }
  if ((m = t.match(/^~ gets \+1\/\+1 for each (.+?) card in your graveyard$/i))) { const f = parseFilterWords(m[1]); if (!f) return null; return { kind: 'self-pt', power: { count: 'cards-in-graveyard', filter: f }, toughness: { count: 'cards-in-graveyard', filter: f } }; }
  if ((m = t.match(/^~'s power and toughness are each equal to the number of (.+?) you control$/i))) { const f = parseFilterWords(m[1]); if (!f) return null; return { kind: 'self-pt', power: { count: 'permanents-you-control', filter: f }, toughness: { count: 'permanents-you-control', filter: f } }; }
  if ((m = t.match(/^~ has (.+) as long as it's attacking$/i))) { const kw = kwList(m[1]); if (kw) return { kind: 'self-keywords', keywords: kw, condition: { kind: 'self-attacking' } }; }
  if (/^you may look at the top card of your library any time$/i.test(t)) return { kind: 'look-top-anytime' };
  if (/^you may choose not to untap ~ during your untap step$/i.test(t)) return { kind: 'may-not-untap' };
  if ((m = t.match(/^~ can't attack unless defending player controls (?:a|an) (.+)$/i))) { const f = parseFilterWords(m[1]); if (f) return { kind: 'cant-attack-unless-defender-controls', filter: f }; }
  if (/^you may play an additional land on each of your turns$/i.test(t)) return { kind: 'extra-land', amount: 1 };
  // auras
  if (card.types.includes('Enchantment') && card.subtypes.includes('Aura')) {
    if ((m = t.match(/^enchanted (creature|permanent|land|artifact|player) (.+)$/i))) {
      const body = m[2]; const aura: StaticEffect = { kind: 'aura', power: 0, toughness: 0, keywords: [], enchant: { kind: m[1] === 'creature' ? 'creature' : m[1] === 'player' ? 'player' : m[1] === 'land' ? 'land' : 'permanent' } };
      let mm: RegExpMatchArray | null;
      if ((mm = body.match(/^gets ([+-]\d+)\/([+-]\d+)(?: and has (.+))?$/i))) { aura.power = Number(mm[1]); aura.toughness = Number(mm[2]); if (mm[3]) { const kw = kwList(mm[3]); if (!kw) return null; aura.keywords = kw; } return aura; }
      if ((mm = body.match(/^has (.+)$/i))) { const kw = kwList(mm[1]); if (!kw) return null; aura.keywords = kw; return aura; }
      if (/^can't attack or block$/i.test(body)) { aura.cantAttackOrBlock = true; return aura; }
      if (/^can't attack or block, and its activated abilities can't be activated$/i.test(body)) { aura.cantAttackOrBlock = true; return aura; }
      if (/^can't attack$/i.test(body)) { aura.cantAttack = true; return aura; }
      if (/^can't block$/i.test(body)) { aura.cantBlock = true; return aura; }
      if (/^doesn't untap during its controller's untap step$/i.test(body)) { aura.doesntUntap = true; return aura; }
      if ((mm = body.match(/^gets ([+-]\d+)\/([+-]\d+) and can't block$/i))) { aura.power = Number(mm[1]); aura.toughness = Number(mm[2]); aura.cantBlock = true; return aura; }
      return null;
    }
    if (/^you control enchanted creature$/i.test(t)) return { kind: 'aura', power: 0, toughness: 0, enchant: { kind: 'creature' }, controlEnchanted: true };
  }
  // equipment
  if (card.subtypes.includes('Equipment')) {
    if ((m = t.match(/^equipped creature gets ([+-]\d+)\/([+-]\d+)(?: and has (.+))?$/i))) { const kw = m[3] ? kwList(m[3]) : []; if (kw === null) return null; return { kind: 'equipment', power: Number(m[1]), toughness: Number(m[2]), keywords: kw, equipCost: parseManaCost('{0}')! }; }
    if ((m = t.match(/^equipped creature has (.+)$/i))) { const kw = kwList(m[1]); if (!kw) return null; return { kind: 'equipment', power: 0, toughness: 0, keywords: kw, equipCost: parseManaCost('{0}')! }; }
  }
  // Registry hook: family static lines, after every built-in static template above has declined. The line loop
  // enables this only on its second pass: the static branch sits *above* the spell-text branch, so a static rule that
  // ran on the first pass would silently steal whole lines from instants and sorceries.
  if (useRegistry) for (const r of STATIC_RULES) { const st = r.make(line, card); if (st) return st; }
  return null;
}

// ---------------------------------------------------------------------------
// Whole card
// ---------------------------------------------------------------------------
export interface OracleRow {
  name: string; oracle_id: string; mana_cost: string | null; mana_value: number; colors: Color[] | null; color_identity: Color[];
  types: string[]; supertypes: string[]; subtypes: string[]; type_line: string; oracle_text: string | null; power: string | null; toughness: string | null; loyalty: string | null;
  keywords: string[]; layout: string; produced_mana?: string[] | null; image?: string | null; representative_id?: string | null;
  faces?: { name: string; type_line: string | null; oracle_text: string | null; power: string | null; toughness: string | null; mana_cost: string | null; image?: string | null }[];
}

const BASIC_LAND_MANA: Record<string, ManaSymbol> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

/**
 * Registry hook for whole lines: build the `LineCtx` (the built-in sub-parsers plus the mutators a rule needs) and
 * offer the line to each registered `LineRule` in family order. Returns true when one claimed it. `ANY.line` is
 * checked by the callers, so a card parsed with no rule families registered never builds this object.
 */
function tryLineRules(def: CardDef, line: string, rawLine: string, row: OracleRow, isSpell: boolean): boolean {
  const ctx: LineCtx = {
    def, line, rawLine, row, keywords: row.keywords ?? [], isSpell,
    parseEffects, parseCost, parseCostPhrase, parseCondition, parseManaCost, parseTrigger,
    addAbility: a => { def.abilities.push(a); },
    addAltCost: a => { (def.altCosts ??= []).push(a); },
    addKeyword: k => { def.keywords.push(k); },
    addAsEnters: a => { (def.asEnters ??= []).push(a); },
    addCostModifier: c => { (def.costModifiers ??= []).push(c); },
    markUnparsed: (l = line) => { def.fullyParsed = false; def.unparsed.push(l); },
  };
  for (const r of LINE_RULES) if (r.match(line, ctx)) return true;
  return false;
}

/** Record a parsed activated ability on the def — shared by the built-in pass and the registry retry below it. */
function addActivated(def: CardDef, line: string, act: ActivatedAbility): void {
  // "Return ~ from your graveyard to your hand / the battlefield": the ability is activated while the card is in the
  // graveyard. The registry's `move` of `self` is recognised here because an effect rule cannot set the flag itself.
  if (/from your graveyard/i.test(line) && act.effects.some(e => (e.op === 'bounce' && e.target === 'self') || (e.op === 'move' && e.what === 'self'))) act.fromGraveyard = true;
  if (act.effects.some(e => e.op === 'unknown')) { def.fullyParsed = false; def.unparsed.push(line); }
  if (act.manaAbility) for (const e of act.effects) if (e.op === 'add-mana' && Array.isArray(e.mana)) def.producesMana.push(...e.mana); else if (e.op === 'add-mana') def.producesMana.push('W', 'U', 'B', 'R', 'G');
  def.abilities.push(act);
}

/** Record one (or several) parsed static effects on the def — likewise shared by both passes. */
function addStatic(def: CardDef, line: string, st: StaticEffect | StaticEffect[]): void {
  for (const e of Array.isArray(st) ? st : [st]) { if (e.kind === 'anthem' && e.whileInGraveyard) def.graveyardStatic = true; def.abilities.push({ kind: 'static', effect: e, text: line }); }
}

/**
 * The effects of a triggered ability's body. Built-ins first, as everywhere: the built-ins-only parse is kept whenever
 * it is complete. When only the registry pass completes it and the trigger is about another object ("Whenever another
 * creature enters, ~ deals damage equal to that creature's power ..."), the body's `that` is the triggering object, so
 * a `bind` from `triggering` is put at the head of the list — the registry cannot do that itself: a sentence rule
 * never sees the trigger head. A self trigger's "it" was already rewritten to `~` above.
 */
function triggerBody(body: string, selfEv: boolean): Effect[] {
  const before = registryClaims;
  // a trigger about another object holds it as the frame from the start (the `bind` below, or the engine's trigger context)
  const effs = foldMarkers(withFrame(!selfEv, [], () => asTriggerBody(() => parseEffects(body)), selfEv ? null : { op: 'bind', as: 'that', from: 'triggering' }), true);
  // the engine records only `triggeringId` for a plain trigger (game.ts, the trigger → stack site), never
  // `item.affected`, so EVERY complete non-self body that reads the frame — a built-in parse's `that` as much as a
  // registry claim's — gets the bind that makes `that` the triggering object (9.0b re-review 2)
  void before;
  if (!selfEv && effs.every(e => e.op !== 'unknown') && mentionsThat(effs)) return [{ op: 'bind', as: 'that', from: 'triggering' }, ...effs];
  return effs;
}
/** Does any effect (nested lists included) read the `that` binding — a Ref, a `prop ... of: 'that'`, a `controller-of-that`, the older `power-of-that` / `mv-of-that` counts and `that-controller`? */
function mentionsThat(v: unknown): boolean {
  if (v === 'that' || v === 'those' || v === 'controller-of-that' || v === 'power-of-that' || v === 'mv-of-that' || v === 'that-controller') return true;
  if (Array.isArray(v)) return v.some(mentionsThat);
  if (v && typeof v === 'object') return FRAME_OPS.has(String((v as { op?: unknown }).op)) || Object.values(v as Record<string, unknown>).some(mentionsThat);
  return false;
}

// ---------------------------------------------------------------------------
// "that many" / "that much" (`{ count: 'that-many' }`) reads `item.lastAmount`: the last amount the resolving item
// evaluated, or the number a trigger's event was about. A reading nothing fed evaluates 0 while the card counted as
// parsed (the 9.0c review), so every ability is checked in document order once it is assembled.
// ---------------------------------------------------------------------------
/** Ops after which `item.lastAmount` holds a number: they evaluate an amount through the engine's `amt` (src/engine/game.ts applyEffect), or count what they did (a whole-hand `discard`, the cards a `return-from-graveyard` returned). */
const AMOUNT_OPS = new Set<string>(['draw', 'discard', 'mill', 'damage', 'damage-you', 'gain-life', 'lose-life', 'counters', 'pump', 'scry', 'surveil', 'token', 'token-copy', 'poison', 'energy', 'player-counter', 'amass', 'dig', 'earthbend', 'prevent-damage', 'put-from-hand', 'set-pt', 'return-from-graveyard']);
/** The trigger events whose context carries the number the event was about (`TriggerCtx.amount` → `item.lastAmount`: the damage dealt, the life gained or lost). */
const AMOUNT_EVENTS = new Set<string>(['deals-damage', 'combat-damage-player', 'life-gain', 'life-loss-opponent']);
/** Does the effect's own slots (not its child lists, not a granted ability) hold a `that-many` amount? */
function readsThatMany(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(readsThatMany);
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.count === 'that-many') return true;
  return Object.keys(o).some(k => !(CHILD_KEYS as readonly string[]).includes(k) && k !== 'ability' && readsThatMany(o[k]));
}
/**
 * Walk `list` in document order with `fed` = whether `item.lastAmount` holds a number when the effect runs; a delayed
 * trigger's / reflexive's body is another item (unfed, and it feeds nothing here). The first unfed reading effect is
 * replaced by `unknown` (its text is `line`) and null comes back; otherwise the fed state after the list.
 */
function feedThatMany(list: Effect[], fed: boolean, line: string): boolean | null {
  for (let i = 0; i < list.length; i++) {
    const e = list[i]; const o = e as unknown as Record<string, unknown>;
    if (!fed && readsThatMany(o)) { list[i] = { op: 'unknown', text: line }; return null; }
    if (AMOUNT_OPS.has(e.op)) fed = true;
    const other = o.op === 'delayed-trigger' || o.op === 'reflexive';
    for (const k of CHILD_KEYS) {
      const c = o[k];
      const lists = k === 'modes' ? (Array.isArray(c) ? (c as Effect[][]) : []) : isEffectList(c) ? [c] : [];
      for (const l of lists) { const r = feedThatMany(l, other ? false : fed, line); if (r === null) return null; if (!other && r) fed = true; }
    }
    if (o.op === 'gain-ability' && o.ability && unfedThatMany(o.ability as Ability, line)) return null;
  }
  return fed;
}
/** Is a "that many" of the ability unfed? A trigger about an amount and an ability that removed counters as a cost start fed; a granted ability is checked as its own kind. */
function unfedThatMany(ab: Ability, line: string): boolean {
  if (ab.kind === 'triggered') return feedThatMany(ab.effects, ab.event.on === 'or' ? ab.event.events.every(ev => AMOUNT_EVENTS.has(ev.on)) : AMOUNT_EVENTS.has(ab.event.on), line) === null;
  if (ab.kind === 'activated') return feedThatMany(ab.effects, !!ab.cost.removeCounters, line) === null;
  if (ab.kind === 'spell') return feedThatMany(ab.effects, false, line) === null;
  return ab.effect.kind === 'grant-ability' ? unfedThatMany(ab.effect.ability, line) : false;
}

export function parseCard(row: OracleRow): CardDef {
  const shortName = row.name.split(' // ')[0];
  const nick = shortName.includes(',') ? shortName.split(',')[0] : null;
  const text = (row.faces && row.faces.length > 1 && ['adventure', 'split', 'transform', 'modal_dfc', 'flip'].includes(row.layout))
    ? (row.faces[0].oracle_text ?? '')
    : (row.oracle_text ?? '');
  const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let norm = text.replace(new RegExp(escaped, 'g'), '~');
  if (nick) norm = norm.replace(new RegExp(nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g'), '~');
  norm = norm.replace(/\bthis (creature|permanent|artifact|enchantment|land|spell|planeswalker|saga|vehicle|aura|equipment|card)\b/gi, '~').replace(/\(([^)]*)\)/g, '').replace(/−/g, '-');
  { const cut = norm.split('\n'); const back = cut.findIndex(l => l.trim().startsWith('//')); if (back >= 0) norm = cut.slice(0, back).join('\n'); } // the other face's text is not this face's

  const types = row.types.filter(t => t.toLowerCase() in TYPE_WORDS || t === 'Kindred' || t === 'Tribal').map(t => t === 'Kindred' || t === 'Tribal' ? t : TYPE_WORDS[t.toLowerCase()]) as CardType[];
  const def: CardDef = {
    name: row.name, oracleId: row.oracle_id, manaCost: parseManaCost(row.mana_cost), manaValue: row.mana_value,
    colors: row.colors ?? [], colorIdentity: row.color_identity, types, supertypes: row.supertypes, subtypes: row.subtypes, typeLine: row.type_line,
    oracleText: row.oracle_text ?? '', power: row.power, toughness: row.toughness, loyalty: row.loyalty != null && /^\d+$/.test(row.loyalty) ? Number(row.loyalty) : null,
    keywords: [], abilities: [], fullyParsed: true, unparsed: [], layout: row.layout, producesMana: [], imageUri: row.image ?? row.faces?.[0]?.image ?? null,
    faces: row.faces?.map(f => ({ name: f.name, typeLine: f.type_line ?? '', oracleText: f.oracle_text ?? '', power: f.power, toughness: f.toughness, manaCost: parseManaCost(f.mana_cost) })),
    faceImageUris: row.faces?.some(f => f.image) ? row.faces.map(f => f.image ?? null) : undefined,
    representativePrintingId: row.representative_id ?? null,
  };
  if (row.supertypes.includes('Basic') || types.includes('Land')) {
    // CR 305.6: a land with a basic land type intrinsically has "{T}: Add {C}" for that type.
    for (const st of row.subtypes) if (st in BASIC_LAND_MANA) {
      const sym = BASIC_LAND_MANA[st];
      def.producesMana.push(sym);
      def.abilities.push({ kind: 'activated', cost: { tap: true }, effects: [{ op: 'add-mana', mana: [sym] }], text: `{T}: Add {${sym}}.`, manaAbility: true });
    }
    if (def.producesMana.length) def.isBasicLandType = row.subtypes.find(s => s in BASIC_LAND_MANA);
  }

  const lines = norm.split('\n').map(l => l.trim()).filter(Boolean);
  const isSpell = types.includes('Instant') || types.includes('Sorcery');
  const spellEffects: Effect[] = [];
  const isSaga = row.subtypes.includes('Saga');

  for (const rawLine of lines) {
    const line = rawLine.replace(ABILITY_WORD_RE, '').replace(/^(?![IVX]+ — )[A-Z0-9][^—.]{0,30} — (?=When\b|Whenever\b|At |\{|[A-Z])/, '');
    if (parseTrace) { traceCtx.oracleId = def.oracleId; traceCtx.line = line; traceCtx.sentence = null; }
    let m: RegExpMatchArray | null;
    // --- Saga chapters: "I — ...", "II, III — ..."
    if (isSaga && (m = line.match(/^((?:I|II|III|IV|V)(?:, (?:I|II|III|IV|V))*) — (.+)$/))) {
      const chapters = m[1].split(', ').map(r => ROMAN[r]);
      const effs = parseEffects(m[2]);
      def.abilities.push({ kind: 'triggered', event: { on: 'chapter', chapters }, effects: effs, text: line });
      if (effs.some(e => e.op === 'unknown')) { def.fullyParsed = false; def.unparsed.push(line); }
      def.finalChapter = Math.max(def.finalChapter ?? 0, ...chapters);
      continue;
    }
    // --- Modal "Choose one —" blocks
    if (/^choose (one|two|one or both|one or more|any number)( —|\.)/i.test(line)) {
      const cnt = /choose two/i.test(line) ? 2 : 1;
      const modes = line.split(/\n?• /).slice(1).map(m => foldMarkers(parseEffects(stripModeName(m)), true));
      const eff: Effect = { op: 'choose-mode', modes, count: cnt };
      for (const md of modes) noteUnknownMode(def, md);
      if (isSpell) spellEffects.push(eff); else def.abilities.push({ kind: 'spell', effects: [eff], text: line });
      continue;
    }
    if (line.startsWith('• ')) { // modes split across lines by Scryfall
      const last = isSpell ? spellEffects[spellEffects.length - 1] : undefined;
      const mode = foldMarkers(parseEffects(stripModeName(line.slice(2))), true);
      if (last && last.op === 'choose-mode') { last.modes.push(mode); noteUnknownMode(def, mode); continue; }
      const lastAb = def.abilities[def.abilities.length - 1];
      const lastEff = lastAb && lastAb.kind !== 'static' ? lastAb.effects[lastAb.effects.length - 1] : undefined;
      if (lastEff && lastEff.op === 'choose-mode') { lastEff.modes.push(mode); noteUnknownMode(def, mode); continue; }
      unknown(def, line); continue;
    }

    // --- keyword lines: "Flying", "Flying, vigilance", "Trample, haste"
    const kwParts = line.replace(/\.$/, '').split(/,\s*/);
    const kws = kwParts.map(part => {
      const pm = part.match(/^protection from (.+)$/i); if (pm) { def.protectionFrom = [...(def.protectionFrom ?? []), ...pm[1].toLowerCase().split(/ and from | and | or /)]; return 'protection' as Keyword; }
      let km: RegExpMatchArray | null;
      if ((km = part.match(/^ward \{(\d+)\}$/i))) { def.wardCost = Number(km[1]); return 'ward' as Keyword; }
      if ((km = part.match(/^toxic (\d+)$/i))) { def.toxic = (def.toxic ?? 0) + Number(km[1]); return 'toxic' as Keyword; }
      if ((km = part.match(/^firebending (\d+)$/i))) { const n = Number(km[1]); def.firebending = (def.firebending ?? 0) + n; def.abilities.push({ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'add-mana', mana: Array(n).fill('R') as ManaSymbol[], sticky: true }], text: `Firebending ${n}` }); return 'firebending' as Keyword; }
      if ((km = part.match(/^bushido (\d+)$/i))) { def.bushido = (def.bushido ?? 0) + Number(km[1]); return 'bushido' as Keyword; }
      if ((km = part.match(/^rampage (\d+)$/i))) { def.rampage = (def.rampage ?? 0) + Number(km[1]); return 'rampage' as Keyword; }
      if ((km = part.match(/^(plains|island|swamp|mountain|forest|desert)walk$/i))) { (def.landwalk ??= []).push(km[1][0].toUpperCase() + km[1].slice(1).toLowerCase()); return 'landwalk' as Keyword; }
      return keywordFromText(part);
    });
    if (kws.length && kws.every(Boolean)) { def.keywords.push(...(kws as Keyword[])); continue; }
    // protection / ward / kicker / cycling / equip / enchant / flashback
    if ((m = line.match(/^protection from (.+?)\.?$/i))) { def.keywords.push('protection'); def.protectionFrom = m[1].toLowerCase().split(/ and | or /); continue; }
    if ((m = line.match(/^ward \{(\d+)\}$/i)) || (m = line.match(/^ward \{(\d+)\}\s*$/i))) { def.keywords.push('ward'); def.wardCost = Number(m[1]); continue; }
    if ((m = line.match(/^kicker (\{[^ ]+\})$/i))) { def.kicker = parseManaCost(m[1])!; continue; }
    if ((m = line.match(/^cycling (\{[^ ]+\})$/i))) { def.cycling = parseManaCost(m[1])!; continue; }
    if ((m = line.match(/^equip ([A-Z][a-z]+) (\{[^ ]+\})$/))) { const eqt = def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'equipment') as { effect: Extract<StaticEffect, { kind: 'equipment' }> } | undefined; const c = parseManaCost(m[2]); const sub = subtypeWord(m[1]); if (eqt && c && sub) { eqt.effect.equipCost = c; eqt.effect.equipFilter = { subtypes: [sub] }; continue; } }
    if ((m = line.match(/^equip (\{[^ ]+\})$/i))) { const eq = def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'equipment') as { effect: Extract<StaticEffect, { kind: 'equipment' }> } | undefined; if (eq) eq.effect.equipCost = parseManaCost(m[1])!; else def.abilities.push({ kind: 'static', effect: { kind: 'equipment', power: 0, toughness: 0, keywords: [], equipCost: parseManaCost(m[1])! }, text: line }); continue; }
    if (/^enchant [a-z ,]+$/i.test(line) && row.subtypes.includes('Aura')) continue; // recorded in aura static
    if (/^~ enters (?:the battlefield )?tapped\.?$/i.test(line)) { def.entersTapped = true; continue; }
    if ((m = line.match(/^You may cast ~ from your graveyard(?: as long as (.+?))?\.?$/i)) && def.manaCost) { const c = m[1] ? parseCondition(m[1]) : undefined; if (!c || c.kind !== 'unknown') { (def.altCosts ??= []).push({ id: 'from-graveyard', label: 'from graveyard', cost: { mana: def.manaCost }, from: 'graveyard', ...(c ? { condition: c } : {}) }); continue; } }
    if ((m = line.match(/^~ enters (?:the battlefield )?tapped unless (.+?)\.?$/i))) { const c = parseCondition(m[1]); if (c.kind !== 'unknown') { def.entersTapped = { unless: c }; continue; } }
    if ((m = line.match(/^As ~ enters, you may reveal an? (.+?) card from your hand\. If you don't, ~ enters tapped\.?$/i))) { const words = m[1].split(/ or /); const subs = words.map(w => w.trim()).filter(w => /^[A-Z]/.test(w)); const f: Filter | null = subs.length === words.length ? { subtypes: subs } : parseFilterWords(m[1]); if (f) { def.entersTapped = { unless: { kind: 'hand-has', filter: f } }; continue; } }
    if (/^devoid$/i.test(line)) { def.colors = []; continue; }
    if (/^(partner|partner with .+|companion — .+|changeling|split second)$/i.test(line.replace(/\.$/, ''))) continue;
    // --- alternative costs: "You may pay 1 life and exile a blue card from your hand rather than pay ~'s mana cost."
    if ((m = line.match(/^(?:if (.+?), )?you may (.+?) rather than pay ~'s mana cost\.?$/i))) {
      const cost: AbilityCost = {}; let ok = true;
      for (const part of m[2].split(/ and /i)) { const c = parseCostPhrase(part); if (!c) { ok = false; break; } Object.assign(cost, c); }
      const cond = m[1] ? parseCondition(m[1]) : undefined;
      if (ok && (!cond || cond.kind !== 'unknown')) { const id = cost.payLife && Object.keys(cost).length === 1 ? 'life' : 'pitch'; (def.altCosts ??= []).push({ id, label: describeCost(cost), cost, condition: cond, from: 'hand' }); continue; }
      unknown(def, line); continue;
    }
    if ((m = line.match(/^evoke[—-]\s*(.+?)\.?$/i))) { const c = parseCost(m[1]); if (c) { (def.altCosts ??= []).push({ id: 'evoke', label: `evoke ${describeCost(c)}`, cost: c, from: 'hand' }); continue; } unknown(def, line); continue; }
    if ((m = line.match(/^warp (\{[^ ]+\})$/i))) { (def.altCosts ??= []).push({ id: 'warp', label: `warp ${m[1]}`, cost: { mana: parseManaCost(m[1])! }, from: 'hand' }); continue; }
    if ((m = line.match(/^impending (\d+)[—-]\s*(\{[^ ]+\})$/i))) { (def.altCosts ??= []).push({ id: 'impending', label: `impending ${m[2]}`, cost: { mana: parseManaCost(m[2])! }, from: 'hand', timeCounters: Number(m[1]) }); continue; }
    if ((m = line.match(/^flashback(?:[—-]\s*| )(.+?)\.?$/i))) { const c = parseCost(m[1]); if (c) { (def.altCosts ??= []).push({ id: 'flashback', label: `flashback ${describeCost(c)}`, cost: c, from: 'graveyard', exileAfter: true }); continue; } unknown(def, line); continue; }
    if ((m = line.match(/^escape[—-]\s*(\{[^ ]+\}), (exile .+?)\.?$/i))) { const c = parseCost(`${m[1]}, ${m[2]}`); if (c) { (def.altCosts ??= []).push({ id: 'escape', label: `escape ${m[1]}`, cost: c, from: 'graveyard' }); continue; } unknown(def, line); continue; }
    if (/^cascade$/i.test(line)) { def.cascade = true; continue; }
    if (/^if ~ would be put into a graveyard from anywhere, exile it instead\.?$/i.test(line)) { def.graveyardReplacement = 'exile'; continue; }
    if (/^if ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner's library instead\.?$/i.test(line) || /^if ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead\.?$/i.test(line)) { def.graveyardReplacement = 'shuffle'; continue; }
    if (/^persist$/i.test(line)) { def.abilities.push({ kind: 'triggered', event: { on: 'dies', self: true }, effects: [{ op: 'return-self-to-battlefield', counters: { counter: '-1/-1', amount: 1 } }], intervening: { kind: 'self-no-counters', counter: '-1/-1' }, text: line }); continue; }
    if (/^undying$/i.test(line)) { def.abilities.push({ kind: 'triggered', event: { on: 'dies', self: true }, effects: [{ op: 'return-self-to-battlefield', counters: { counter: '+1/+1', amount: 1 } }], intervening: { kind: 'self-no-counters', counter: '+1/+1' }, text: line }); continue; }
    if (/^storm$/i.test(line)) { def.storm = true; continue; }
    if ((m = line.match(/^(morph|megamorph|disguise) (\{[^ ]+\}(?:\{[^ ]+\})*)$/i))) { const c = parseManaCost(m[2]); if (c) { const kind = m[1].toLowerCase(); def.morph = { cost: c, ...(kind === 'megamorph' ? { megamorph: true } : {}), ...(kind === 'disguise' ? { disguise: true } : {}) }; (def.altCosts ??= []).push({ id: 'morph', label: 'face down for {3}', cost: { mana: { generic: 3, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{3}' } }, from: 'hand' }); continue; } }
    if ((m = line.match(/^cumulative upkeep (\{[^ ]+\})$/i))) { const c = parseManaCost(m[1]); if (c) { def.abilities.push({ kind: 'triggered', event: { on: 'upkeep', whose: 'your' }, effects: [{ op: 'counters', target: 'self', counter: 'age', amount: 1 }, { op: 'sacrifice-unless-pay', mana: c, perCounter: 'age' }], text: line }); continue; } }
    if ((m = line.match(/^buyback (\{[^ ]+\})$/i)) && def.manaCost) { const extra = parseManaCost(m[1]); if (extra) { (def.altCosts ??= []).push({ id: 'buyback', label: `buyback ${m[1]}`, cost: { mana: addManaCost(def.manaCost, extra) }, from: 'hand', returnToHand: true }); continue; } }
    if ((m = line.match(/^dash (\{[^ ]+\})$/i))) { const c = parseManaCost(m[1]); if (c) { (def.altCosts ??= []).push({ id: 'dash', label: `dash ${m[1]}`, cost: { mana: c }, from: 'hand' }); continue; } }
    if (/^myriad$/i.test(line)) { def.abilities.push({ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'token-copy', target: 'self', count: { count: 'opponents', plus: -1 }, attacking: 'each-other-opponent' }, { op: 'delayed-trigger', at: 'end-of-combat', bind: 'that', effects: [{ op: 'remove-those', how: 'exile' }] }], text: line }); continue; }
    if ((m = line.match(/^mobilize (\d+)$/i))) { def.abilities.push({ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'token', count: Number(m[1]), power: 1, toughness: 1, colors: ['R'], types: ['Creature'], subtypes: ['Warrior'], keywords: [], attacking: true }, { op: 'delayed-trigger', at: 'end-of-combat', bind: 'that', effects: [{ op: 'remove-those', how: 'sacrifice' }] }], text: line }); continue; }
    if ((m = line.match(/^soulshift (\d+)$/i))) { def.abilities.push({ kind: 'triggered', event: { on: 'dies', self: true }, optional: true, effects: [{ op: 'return-from-graveyard', what: { types: ['Creature'], subtypes: ['Spirit'], mvLE: Number(m[1]) }, to: 'hand', target: true }], text: line }); continue; }
    if ((m = line.match(/^fabricate (\d+)$/i))) { const n = Number(m[1]); def.abilities.push({ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'choose-mode', count: 1, modes: [[{ op: 'counters', target: 'self', counter: '+1/+1', amount: n }], [{ op: 'token', count: n, power: 1, toughness: 1, colors: [], types: ['Artifact', 'Creature'], subtypes: ['Servo'], keywords: [] }]] }], text: line }); continue; }
    if (/^living weapon$/i.test(line)) { def.abilities.push({ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'token', count: 1, power: 0, toughness: 0, colors: ['B'], types: ['Creature'], subtypes: ['Phyrexian', 'Germ'], keywords: [], name: 'Germ' }, { op: 'attach-to-that' }], text: line }); continue; }
    if (/^extort$/i.test(line)) { def.abilities.push({ kind: 'triggered', event: { on: 'cast', filter: {}, who: 'you' }, effects: [{ op: 'optional-pay', mana: parseManaCost('{W/B}')!, then: [{ op: 'lose-life', amount: 1, who: 'each-opponent' }, { op: 'gain-life', amount: { count: 'opponents' }, who: 'you' }] }], text: line }); continue; }
    if ((m = line.match(/^(?:fading|vanishing) (\d+)$/i))) { const k = /^fading/i.test(line) ? 'fade' : 'time'; (def.asEnters ??= []).push({ kind: 'counters', counter: k, amount: Number(m[1]) }); def.abilities.push({ kind: 'triggered', event: { on: 'upkeep', whose: 'your' }, effects: [{ op: 'conditional', condition: { kind: 'self-has-counters', counter: k }, then: [{ op: 'counters', target: 'self', counter: k, amount: -1 }], else: [{ op: 'sacrifice-self' }] }], text: line }); continue; }
    if ((m = line.match(/^afflict (\d+)$/i))) { def.abilities.push({ kind: 'triggered', event: { on: 'becomes-blocked', self: true }, effects: [{ op: 'lose-life', amount: Number(m[1]), who: 'defending-player' }], text: line }); continue; }
    if (/^battle cry$/i.test(line)) { def.abilities.push({ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'pump', target: 'other-attacking-creatures', power: 1, toughness: 0, duration: 'eot' }], text: line }); continue; }
    if (/^unleash$/i.test(line)) { (def.asEnters ??= []).push({ kind: 'counters', counter: '+1/+1', amount: 1 }); def.abilities.push({ kind: 'static', effect: { kind: 'self-keywords', keywords: [], condition: { kind: 'self-has-counters', counter: '+1/+1' }, cantBlock: true }, text: line }); continue; }
    if ((m = line.match(/^evoke (\{[^ ]+\})$/i))) { (def.altCosts ??= []).push({ id: 'evoke', label: `evoke ${m[1]}`, cost: { mana: parseManaCost(m[1])! }, from: 'hand' }); def.abilities.push({ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'sacrifice-self' }], condition: { kind: 'evoked' }, text: 'Evoke sacrifice' }); continue; }
    if (/^evolve$/i.test(line)) { def.abilities.push({ kind: 'triggered', event: { on: 'etb', self: false, filter: { types: ['Creature'] }, controller: 'you' }, effects: [{ op: 'evolve' }], text: line }); continue; }
    if ((m = line.match(/^modular (\d+)$/i))) { (def.asEnters ??= []).push({ kind: 'counters', counter: '+1/+1', amount: Number(m[1]) }); def.abilities.push({ kind: 'triggered', event: { on: 'dies', self: true }, effects: [{ op: 'move-counters', counter: '+1/+1', target: { kind: 'creature', filter: { types: ['Artifact'] }, optional: true } }], optional: true, text: line }); continue; }
    if ((m = line.match(/^renown (\d+)$/i))) { def.abilities.push({ kind: 'triggered', event: { on: 'combat-damage-player', self: true }, effects: [{ op: 'renown', amount: Number(m[1]) }], intervening: { kind: 'self-not-renowned' }, text: line }); continue; }
    if ((m = line.match(/^bloodthirst (\d+)$/i))) { (def.asEnters ??= []).push({ kind: 'counters', counter: '+1/+1', amount: Number(m[1]), condition: { kind: 'opponent-lost-life-this-turn' } }); continue; }
    if ((m = line.match(/^echo (\{[^ ]+\})$/i))) { def.abilities.push({ kind: 'triggered', event: { on: 'upkeep', whose: 'your' }, effects: [{ op: 'sacrifice-unless-pay', mana: parseManaCost(m[1])!, once: 'echo' }], text: line }); continue; }
    if ((m = line.match(/^unearth (\{[^ ]+\})$/i))) { def.abilities.push({ kind: 'activated', cost: { mana: parseManaCost(m[1])! }, effects: [{ op: 'unearth' }], text: line, sorcerySpeed: true, fromGraveyard: true }); continue; }
    if (/^you may choose the same mode more than once\.?$/i.test(line)) continue;
    if (/^jump-start$/i.test(line)) { (def.altCosts ??= []).push({ id: 'jump-start', label: 'jump-start', cost: { mana: def.manaCost ?? undefined, discard: 1 }, from: 'graveyard', exileAfter: true }); continue; }
    if (/^rebound$/i.test(line)) { def.rebound = true; continue; }
    if ((m = line.match(/^dredge (\d+)$/i))) { def.dredge = Number(m[1]); continue; }
    if ((m = line.match(/^(delve|convoke|improvise)$/i))) { (def.costModifiers ??= []).push({ kind: m[1].toLowerCase() as 'delve' }); continue; }
    if ((m = line.match(/^~ costs (\{\d+\}) less to cast for each (.+?)\.?$/i))) { const a = parseEachPhrase(m[2]); const k = Number(m[1].slice(1, -1)); if (a && k) { (def.costModifiers ??= []).push({ kind: 'reduce', amount: scaleAmount(a, k, '+') }); continue; } }
    if ((m = line.match(/^affinity for (\w+?)s?$/i))) { const f = parseFilterWords(m[1]); if (f) { (def.costModifiers ??= []).push({ kind: 'reduce', amount: { count: 'permanents-you-control', filter: f } }); continue; } }
    if ((m = line.match(/^~ costs \{(\d+)\} less to cast for each basic land type among lands you control\.?$/i))) { (def.costModifiers ??= []).push({ kind: 'reduce', amount: { count: 'domain', times: Number(m[1]) } }); continue; }
    if ((m = line.match(/^~ costs \{(\d+)\} less to cast for each card type among cards in your graveyard\.?$/i))) { (def.costModifiers ??= []).push({ kind: 'reduce', amount: { count: 'card-types-in-graveyard', times: Number(m[1]) } }); continue; }
    if ((m = line.match(/^(basic land|\w+)cycling (\{[^ ]+\})$/i))) { def.cycling = parseManaCost(m[2])!; def.cyclingSearch = m[1].toLowerCase() === 'basic land' ? { types: ['Land'], basic: true } : { subtypes: [subtypeWord(m[1]) ?? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()] }; continue; }
    if ((m = line.match(/^~ costs \{(\d+)\} less to cast for each (.+?) you control\.?$/i))) { const f = parseFilterWords(m[2]); if (f) { (def.costModifiers ??= []).push({ kind: 'reduce', amount: { count: 'permanents-you-control', filter: f, times: Number(m[1]) } }); continue; } }
    if ((m = line.match(/^as an additional cost to cast ~, (.+?)\.?$/i)) && !/^you may/i.test(m[1])) { const c = parseCost(m[1]); if (c) { (def.additionalCosts ??= []).push(c); continue; } unknown(def, line); continue; }
    if ((m = line.match(/^(crew|saddle) (\d+)$/i))) { const saddle = m[1].toLowerCase() === 'saddle'; def.abilities.push({ kind: 'activated', cost: { tapCreaturesTotalPower: { power: Number(m[2]), other: saddle } }, effects: [{ op: saddle ? 'saddle-self' : 'crew-self' }], text: line, instantSpeed: true }); continue; }
    // --- as-enters replacement effects
    if ((m = line.match(/^as ~ enters, you may pay (\d+) life\. if you don't, it enters tapped\.?$/i))) { (def.asEnters ??= []).push({ kind: 'pay-life-or-tapped', life: Number(m[1]) }); continue; }
    if ((m = line.match(/^~ enters tapped unless (.+?)\.?$/i))) { const c = parseCondition(m[1]); if (c.kind !== 'unknown') { (def.asEnters ??= []).push({ kind: 'tapped-unless', condition: c }); continue; } unknown(def, line); continue; }
    if ((m = line.match(/^~ enters with (\w+|x) ([+-]1\/[+-]1|[a-z]+) counters? on it\.?$/i))) { (def.asEnters ??= []).push({ kind: 'counters', counter: m[2].toLowerCase(), amount: num(m[1]) }); continue; }
    if ((m = line.match(/^~ enters with (\w+|x) ([+-]1\/[+-]1|[a-z]+) counters? on it if (.+?)\.?$/i))) { const c = parseCondition(m[3]); if (c.kind !== 'unknown') { (def.asEnters ??= []).push({ kind: 'counters', counter: m[2].toLowerCase(), amount: num(m[1]), condition: c }); continue; } }
    if ((m = line.match(/^if ~ was kicked, it enters with (\w+) ([+-]1\/[+-]1|[a-z]+) counters? on it\.?$/i))) { (def.asEnters ??= []).push({ kind: 'counters', counter: m[2].toLowerCase(), amount: num(m[1]), condition: { kind: 'kicked' } }); continue; }
    if ((m = line.match(/^~ enters with (?:a|an) ([+-]1\/[+-]1|[a-z]+) counter on it for each (.+?) card exiled with it\.?$/i))) { const f = parseFilterWords(m[2].replace(/ and /g, ' or ')); if (f) { (def.asEnters ??= []).push({ kind: 'counters', counter: m[1].toLowerCase(), amount: { count: 'exiled-with', filter: f } }); continue; } }
    if ((m = line.match(/^~ enters with (?:a|an) ([+-]1\/[+-]1|[a-z]+) counter on it for each (.+?) card in your graveyard\.?$/i))) { const f = parseFilterWords(m[2].replace(/ and /g, ' or ')); if (f) { (def.asEnters ??= []).push({ kind: 'counters', counter: m[1].toLowerCase(), amount: { count: 'cards-in-graveyard', filter: f } }); continue; } }
    if ((m = line.match(/^as ~ enters, choose a (creature type|color)\.?$/i))) { (def.asEnters ??= []).push({ kind: 'choose', what: m[1].toLowerCase() === 'color' ? 'color' : 'creature-type' }); continue; }
    if ((m = line.match(/^if ~ would enter, you may discard (?:a|an) (.+?) card instead\. if you do, put ~ onto the battlefield\. if you don't, put it into its owner's graveyard\.?$/i))) { const f = parseFilterWords(m[1]); if (f) { (def.asEnters ??= []).push({ kind: 'discard-or-graveyard', filter: f }); continue; } }
    // Registry hook (1 of 2) is INSIDE the next line's `if`, not before it: that line is the keyword bail-out, where a
    // line naming a keyword the built-ins know *of* but do not implement ("Bestow {3}{W}", "Suspend 4—{1}{U}") is
    // recorded as unparsed and never reaches the trigger / activated / static ladder below. A family's keyword lines
    // therefore have to be offered there — after the built-ins have given up on the line, and never before them.
    if (/^(flashback|escape|adventure|mutate|cascade|storm|convoke|delve|affinity|riot|adapt|amass|exploit|embalm|eternalize|afflict|afterlife|mentor|companion|crew|foretell|boast|daybound|nightbound|disturb|decayed|cleave|training|reconfigure|blitz|casualty|connive|backup|bargain|craft|discover|offspring|gift|impending|exhaust|harmonize|max speed|start your engines!|mobilize|renew|endure|station|void|warp|devoid|emerge|escalate|surge|awaken|ingest|rebound|miracle|overload|scavenge|unleash|detain|populate|evolve|extort|cipher|bloodrush|battalion|heroic|monstrosity|outlast|dash|exploit|megamorph|morph|manifest|renown|ninjutsu|split second|suspend|vanishing|fading|buyback|madness|flanking|shadow|horsemanship|banding|rampage|cumulative upkeep|echo|phasing|multikicker|entwine|splice|bushido|soulshift|offering|ninjutsu|epic|sunburst|modular|graft|forecast|transmute|dredge|haunt|replicate|recover|ripple|bloodthirst|vanishing|frenzy|level up|totem armor|infect|battle cry|living weapon|undying|miracle|soulbond|unleash|bestow|tribute|inspired|constellation|outlast|dash|exploit|awaken|rally|support|meld|crew|fabricate|improvise|aftermath|exert|eternalize|ascend|assist|jump-start|undergrowth|spectacle|riot|proliferate|escape|companion|mutate|foretell|learn|magecraft|coven|daybound|disturb|training|cleave|blood|reconfigure|hideaway|channel|compleated|casualty|blitz|read ahead|enlist|squad|prototype|unearth|toxic|for mirrodin!|convoke|backup|the ring tempts you|bargain|celebration|role|adventure|craft|descend|explore|discover|map|outlaw|plot|spree|saddle|forage|gift|offspring|impending|manifest dread|eerie|survival|start your engines!|exhaust|mobilize|harmonize|renew|endure|behold|job select|station|warp|void|umbra armor|constellation|addendum|parley|alliance|pack tactics|will of the council|council's dilemma|secret council|fateful hour|spell mastery|lieutenant|chroma|grandeur|sweep|radiance|kinship|imprint|join forces|tempting offer|bloodrush|strive|adamant|eminence|enrage|hero's reward|undaunted|legacy|fathomless descent|corrupted|paradox|coven|magecraft|max speed|flurry|heist|mayhem|rally|devour|exalted|persist|wither|changeling|ravenous|vanishing|dethrone|melee|partner|assist|myriad|evoke|prowl|retrace|conspire|frenzy|cascade|annihilator|hideaway|desertwalk|forestwalk|islandwalk|mountainwalk|plainswalk|swampwalk|landwalk|absorb|provoke|renown|amplify|double team|encore|goad|monarch|initiative|day|night)\b/i.test(line)) { if (ANY.line && tryLineRules(def, line, rawLine, row, isSpell)) continue; unknown(def, line, 'keyword'); continue; }

    // --- planeswalker loyalty abilities
    if ((m = line.match(/^([+-]\d+|0): (.+)$/))) {
      const effs = parseEffects(m[2]);
      const ab: ActivatedAbility = { kind: 'activated', cost: {}, effects: effs, text: line, sorcerySpeed: true, loyalty: Number(m[1].replace('+', '')), oncePerTurn: true };
      if (effs.some(e => e.op === 'unknown')) { def.fullyParsed = false; def.unparsed.push(line); }
      def.abilities.push(ab); continue;
    }

    if (/^whenever (?:you tap|enchanted \w+ is tapped)/i.test(line) && /for mana/i.test(line)) { const st = parseStatic(line.replace(/\.$/, ''), def, false); if (st) { for (const e of Array.isArray(st) ? st : [st]) def.abilities.push({ kind: 'static', effect: e, text: line }); continue; } }
    // --- triggered
    if ((m = line.match(/^(When|Whenever|At) (.+?), (.+)$/))) {
      // "Whenever X, if Y, Z" intervening-if
      let head = `${m[1]} ${m[2]}`; let body = m[3]; let intervening: Condition | undefined;
      const ifm = body.match(/^if (.+?), (.+)$/i);
      if (ifm) { intervening = parseCondition(ifm[1]); body = ifm[2]; }
      // Trigger heads sometimes contain a comma ("Whenever a creature you control attacks, ...") that split wrong: retry greedily
      // Both built-in splits first: the greedy re-split is itself a built-in stage, so a registry trigger rule that
      // answers the narrow head must not run ahead of it.
      let ev = parseTrigger(head, false);
      const alt = ev.on === 'unknown' ? line.match(/^(When|Whenever|At) (.+), ([^,]+)$/) : null;
      if (alt) { const ev2 = parseTrigger(`${alt[1]} ${alt[2]}`, false); if (ev2.on !== 'unknown') { ev = ev2; body = alt[3]; } }
      if (ev.on === 'unknown' && ANY.trigger) {
        const ev3 = parseTrigger(head);
        if (ev3.on !== 'unknown') ev = ev3;
        else if (alt) { const ev4 = parseTrigger(`${alt[1]} ${alt[2]}`); if (ev4.on !== 'unknown') { ev = ev4; body = alt[3]; } }
      }
      const optional = /^you may /i.test(body);
      const selfEv = 'self' in ev && ev.self === true;
      // "it" in a self-referential trigger body is the source, unless the body introduces another referent
      if (selfEv && !/\btarget\b|\bthat (creature|card|player|permanent|land|spell)\b|\banother\b|\bcards?\b|\btokens?\b|\bcopy\b/i.test(body)) body = body.replace(/\b(it|this creature|this permanent)\b(?!s)/gi, '~');
      // "When ~ dies, draw cards equal to its power": "its" is the source too (the frame-bound `power-of-that` would read
      // nothing on a self trigger); "cards" / "tokens" are not referents for "its", another object or a target is
      if (selfEv && !/\btarget (?!(?:player|opponent)\b)|\bthat (creature|card|permanent|land|spell|token)\b|\banother\b|\bcopy\b|\benchanted\b|\bequipped\b/i.test(body)) body = body.replace(/\bits (power|toughness|mana value)\b/gi, "~'s $1");
      // "Whenever a creature you control deals combat damage to a player, put that many +1/+1 counters on it": "it" in a
      // trigger about another permanent is that permanent — the frame word, which triggerBody binds (parseEffectSentence
      // would otherwise read a bare "on it" as the source)
      if (!selfEv && 'filter' in ev && ev.on !== 'cast') body = body.replace(/\bon it\b/gi, 'on that permanent');
      const once = /\. this ability triggers only once each turn\.?$/i.test(body); if (once) body = body.replace(/\.? this ability triggers only once each turn\.?$/i, '');
      const effs = /^choose (one|two)( —|\.)?$/i.test(body.trim()) ? [{ op: 'choose-mode', modes: [], count: /two/i.test(body) ? 2 : 1 } as Effect] : triggerBody(body, selfEv);
      const ab: TriggeredAbility = { kind: 'triggered', event: ev, effects: effs, text: line, optional, intervening, ...(once ? { oncePerTurn: true } : {}) };
      if (parseTrace) {
        // the head and the intervening clause are the two fragments this branch alone knows; the body's are on record
        const bodyOk = known(effs);
        if (ev.on === 'unknown') trace('trigger-head', head, ANY.trigger, { partial: bodyOk && (!intervening || intervening.kind !== 'unknown') });
        if (intervening && intervening.kind === 'unknown' && ifm) trace('intervening', ifm[1], true, { partial: bodyOk && ev.on !== 'unknown' });
      }
      if (ev.on === 'unknown' || effs.some(e => e.op === 'unknown') || (intervening && intervening.kind === 'unknown')) { def.fullyParsed = false; def.unparsed.push(line); }
      def.abilities.push(ab); continue;
    }

    // --- activated "cost: effect" (built-in cost phrases only — a registry cost phrase would claim the line ahead of
    //     the static and spell-text branches below, so its retry lives past both of them)
    const act = parseActivatedLine(line, false);
    if (act) { addActivated(def, line, act); continue; }

    // --- static (built-in templates only, for the same reason: this branch sits above the spell-text branch)
    const st = parseStatic(line, { types, subtypes: row.subtypes }, false);
    if (st) { addStatic(def, line, st); continue; }

    // --- spell text / ETB-less effect text on permanents (e.g. "Destroy target creature." on a sorcery)
    if (isSpell) {
      // one item: an earlier paragraph's binding (or an additional sacrifice cost) is this paragraph's frame too
      const effs = withFrame(!!def.additionalCosts?.some(c => c.sacrifice), spellEffects, () => parseEffects(line));
      const unfed = feedThatMany(effs, spellEffects.some(e => AMOUNT_OPS.has(e.op)), line) === null;   // an unfed "that many" (the reading is `unknown` now, wherever it sits)
      spellEffects.push(...effs);
      if (unfed || effs.some(e => e.op === 'unknown')) { def.fullyParsed = false; def.unparsed.push(line); }
      continue;
    }
    // ---- registry pass. Every built-in stage above has declined this line (and an instant or sorcery never reaches
    // here at all), so what a rule claims below could only have been `unknown`. The order mirrors the built-in ladder.
    // ANY.activated / ANY.static, not COST_RULES.length / STATIC_RULES.length: each retry re-runs a whole ladder, and
    // those ladders reach the condition, trigger and effect rules through their sub-parsers as well as the array they
    // are named after. Gating on the one array drops the rest silently — no error, just a family that never fires.
    if (ANY.activated) { const act2 = parseActivatedLine(line, true); if (act2) { addActivated(def, line, act2); continue; } }
    if (ANY.static) { const st2 = parseStatic(line, { types, subtypes: row.subtypes }, true); if (st2) { addStatic(def, line, st2); continue; } }
    // Registry hook (2 of 2): the last chance before the line is recorded as unparsed.
    if (ANY.line && tryLineRules(def, line, rawLine, row, isSpell)) continue;
    unknown(def, line);
  }
  if (isSpell) {
    const folded = foldMarkers(spellEffects, true); // riders may sit on a later line (Fatal Push's revolt clause)
    for (const e of folded) if (e.op === 'unknown' && !def.unparsed.includes(e.text)) { def.fullyParsed = false; def.unparsed.push(e.text); }
    def.abilities.push({ kind: 'spell', effects: folded, text: text });
  }
  // an unfed "that many" (no amount before it, no trigger about one) is honestly unparsed rather than a silent 0
  for (const ab of def.abilities) if (ab.kind !== 'spell' && unfedThatMany(ab, ab.text)) { def.fullyParsed = false; if (!def.unparsed.includes(ab.text)) def.unparsed.push(ab.text); }
  def.keywords = [...new Set(def.keywords)];
  // --- second face of a split / adventure / flip card: the engine cannot cast that half, so its lines are recorded as
  //     unparsed — the same list scripts.ts's `secondFaceLines` / `secondFaceUnclaimed` accounts for (src/cards/oracle-lines.ts)
  if (row.faces && row.faces.length > 1 && SECOND_FACE_LAYOUTS.includes(row.layout)) {
    const second = secondFaceLinesOf(row.layout, { name: row.faces[1].name, oracleText: row.faces[1].oracle_text });
    if (second.length) { def.fullyParsed = false; for (const l of second) if (!def.unparsed.includes(l)) def.unparsed.push(l); }
  }
  // --- back face of a modal / transforming double-faced card
  if (row.faces && row.faces.length > 1 && (row.layout === 'modal_dfc' || row.layout === 'transform') && row.faces[1].type_line) {
    const f = row.faces[1]; const tl = parseTypeLine(f.type_line ?? '');
    const savedCtx = parseTrace ? { ...traceCtx } : null; if (parseTrace) traceCtx.face = 'back';   // the back face's records say so; the front's context is restored below
    const back = parseCard({ ...row, name: f.name, mana_cost: f.mana_cost, mana_value: manaValue(parseManaCost(f.mana_cost)), oracle_text: f.oracle_text, type_line: f.type_line ?? '', types: tl.types, supertypes: tl.supertypes, subtypes: tl.subtypes, power: f.power, toughness: f.toughness, loyalty: null, layout: 'face', faces: undefined, colors: tl.types.includes('Land') ? [] : row.colors, image: f.image ?? null, keywords: [], representative_id: row.representative_id });
    if (savedCtx) Object.assign(traceCtx, savedCtx);
    def.backFace = back;
    if (!back.fullyParsed) { def.fullyParsed = false; def.unparsed.push(...back.unparsed.map(u => `// ${u}`)); }
  }
  return def;
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };

/** The count for "for each [other] <words> you control": permanents when the words name permanents, creatures otherwise; "other" excludes the source. */
function eachYouControl(words: string, other: string | undefined, f: Filter): Extract<Amount, object> {
  const filter: Filter = other ? { ...f, other: true } : f;
  return { count: /\bpermanents?\b/i.test(words) ? 'permanents-you-control' : 'creatures-you-control', filter };
}
function parseTypeLine(tl: string): { types: string[]; supertypes: string[]; subtypes: string[] } {
  const [left, right] = tl.split(' — ');
  const SUPER = new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing', 'Host']);
  const words = (left ?? '').split(/\s+/).filter(Boolean);
  return { supertypes: words.filter(w => SUPER.has(w)), types: words.filter(w => !SUPER.has(w)), subtypes: (right ?? '').split(/\s+/).filter(Boolean) };
}

/** "cost: effect" line -> activated ability, with the "Activate only ..." riders. */
/**
 * `useRegistry` gates the two sub-parses that decide whether this line *is* an activated ability — the cost and the
 * "activate only if" condition — and is therefore what ANY.activated has to cover (costs OR conditions: a family with
 * one and not the other still needs this retry to run).
 *
 * `bodyRegistry` is separate because the body's effects usually cannot make the line be claimed: in the line loop a
 * claimed activated line with an `unknown` body is still claimed (and recorded as unparsed), so a family effect rule
 * there only ever fills in an `unknown` and the built-ins-only pass may leave it on. parseGrantedAbility is the
 * exception — an `unknown` body makes the whole shape decline there — so it passes both flags together.
 */
function parseActivatedLine(line: string, useRegistry = true, bodyRegistry = true): ActivatedAbility | null {
  const m = line.match(/^((?:\{[^}]+\})+(?:, [^:]+)?|[^:]+?): (.+)$/);
  if (!m || /^(choose|enchant)/i.test(line)) return null;
  const cost = parseCost(m[1], useRegistry); if (!cost) return null;
  let body = m[2]; let sorcerySpeed = false, oncePerTurn = false, instantSpeed = false; let activateOnlyIf: Condition | undefined;
  if (/ activate only as a sorcery and only if /i.test(body)) { sorcerySpeed = true; body = body.replace(/ activate only as a sorcery and only if /i, ' activate only if '); }
  if (/ activate only as a sorcery\.?$/i.test(body)) { sorcerySpeed = true; body = body.replace(/ activate only as a sorcery\.?$/i, ''); }
  if (/ activate only as an instant\.?$/i.test(body)) { instantSpeed = true; body = body.replace(/ activate only as an instant\.?$/i, ''); }
  if (/ activate only once each turn\.?$/i.test(body)) { oncePerTurn = true; body = body.replace(/ activate only once each turn\.?$/i, ''); }
  const only = body.match(/ activate only if (.+?)\.?$/i);
  if (only) { const c = parseCondition(only[1], useRegistry); if (c.kind === 'unknown') { if (parseTrace) trace('condition', only[1], useRegistry, { partial: true }); return null; } activateOnlyIf = c; body = body.slice(0, only.index); }   // partial: the cost parsed
  // "{T}, Sacrifice ~: You gain life equal to its power" (Syr Ginger): with the source itself sacrificed and no other
  // referent introduced, "its" is the source — read as "~'s" (last known information once it has left, CR 608.2h)
  if (cost.sacrificeSelf && !cost.sacrifice && !/\btarget (?!(?:player|opponent)\b)|\bthat (creature|card|permanent|land|spell|token)\b|\banother\b|\bcopy\b/i.test(body)) body = body.replace(/\bits (power|toughness|mana value)\b/gi, "~'s $1");
  // a sacrifice cost binds what was sacrificed before the effects run (src/engine/game.ts payCost)
  const effs = foldMarkers(withFrame(!!cost.sacrifice, [], () => parseEffects(body, bodyRegistry)), true);
  const manaAbility = effs.some(e => e.op === 'add-mana') && effs.every(e => e.op === 'add-mana' || e.op === 'damage-you' || ((e.op === 'lose-life' || e.op === 'gain-life') && e.who === 'you'));
  return { kind: 'activated', cost, effects: effs, text: line, sorcerySpeed, oncePerTurn, manaAbility, activateOnlyIf, instantSpeed };
}

/** A mode with unknown effects makes the card partial; record the mode text so coverage reports can see it. */
function noteUnknownMode(def: CardDef, mode: Effect[]) {
  for (const e of mode) if (e.op === 'unknown') { def.fullyParsed = false; def.unparsed.push(`• ${e.text}`); }
}

/** Record a whole line nothing claimed. Under the trace it is a `static` record (accounting: the line's inner fragments, if any, are already on record) or the keyword bail-out's `keyword`. */
function unknown(def: CardDef, line: string, stage: 'static' | 'keyword' = 'static') {
  if (parseTrace) trace(stage, line, true);
  def.fullyParsed = false; def.unparsed.push(line);
  def.abilities.push({ kind: 'static', effect: { kind: 'unknown', text: line }, text: line });
}
