// Parser rules for the composition core (Phase 9.0b; docs/vocabulary/composition.md, "Parser wordings").
//
// The generic glue wordings — "for each X, …", "each opponent …", "when you do, …", "… unless that player pays …",
// "put it onto the battlefield tapped", "… where X is …", "has base power and toughness N/N", "loses all abilities",
// "exchange …", "two target creatures", "when that creature dies this turn, …" — mapped onto the ops the engine side
// of 9.0a added: `for-each`, `scoped`, `reflexive`, `may`, `unless-pays`, `move`, `set-pt`, `lose-abilities`,
// `exchange`, `delayed-trigger`'s new firing points, the `multi` target spec and the amount forms (`objects`, `diff`,
// `sum`, `half`, `prop`).
//
// Every rule here is consulted only after every built-in stage of parse.ts has declined the sentence (the registry
// contract in ./types.ts), so nothing a built-in already parsed can move. Two disciplines on top of that:
//
//   * a rule never claims what it cannot express — every sub-parse is checked for `unknown`, filter words are checked
//     against a known vocabulary before the (lossy) built-in filter parser sees them, and an amount phrase the engine
//     has no form for ("the greatest power among …") makes the whole rule decline;
//   * a rule returns ONE effect: when a sentence is really a sequence ("loses all abilities and has base power and
//     toughness 1/1"), the parts are wrapped in `{ op: 'scoped', who: 'you', do: [...] }` — the controller's own
//     block, semantically a no-op container (composition.md §4, `scoped`).
//
// The shared sub-parsers arrive on the `EffectCtx` parse.ts hands every effect rule; this file imports nothing from
// parse.ts at runtime.
import type { Amount, AmountExpr, CardType, Effect, Filter, Ref, ScopeWho, SetZone, TargetSpec } from '../types.js';
import type { EffectCtx, EffectRule, LineRule, RuleFamily } from './types.js';
import { subtypeKind, subtypeWord } from '../subtypes.js';

/** The card types a permanent card can have (CR 110.4c): "permanent card" in a graveyard / hand / library must not be an empty filter, which would offer instants and sorceries too. */
const PERMANENT_CARD_TYPES: CardType[] = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];
/** `f` for the words `words` of a "… card(s) from your graveyard" phrase: "permanent" / "nonland permanent" become the any-of list of permanent types (minus the excluded ones); every other filter is unchanged. */
function permanentCardFilter(words: string, f: Filter | null): Filter | null {
  if (!f || f.types || !/\bpermanents?\b/i.test(words)) return f;
  const types = PERMANENT_CARD_TYPES.filter(t => !f.notTypes?.includes(t));
  const { notTypes, ...rest } = f; void notTypes;
  return { ...rest, types };
}

// ---------------------------------------------------------------------------------------------------------------
// Small vocabularies
// ---------------------------------------------------------------------------------------------------------------

/** "it", "that card", "those creatures", "the exiled card", "the sacrificed creature" → the Ref the binding frame resolves. */
function refWord(w: string): Ref | null {
  const t = w.trim().toLowerCase();
  if (/^(it|that (creature|card|permanent|token|spell|land|artifact|enchantment|planeswalker))$/.test(t)) return 'that';
  if (/^(them|those (cards|creatures|permanents|tokens|lands|artifacts|enchantments|spells)|each of them|each of those (creatures|cards|permanents))$/.test(t)) return 'those';
  if (/^the exiled cards?$/.test(t)) return 'exiled-with';
  if (/^the sacrificed (creature|permanent|card)$/.test(t)) return 'sacrificed';
  return null;
}

/** A player word at the head of a clause → the ScopeWho it runs as. "they"/"their" only where the context says a player. */
function whoWord(w: string): ScopeWho | null {
  const t = w.trim().toLowerCase();
  if (t === 'each opponent' || t === 'each other player') return 'each-opponent';
  if (t === 'each player') return 'each-player';
  if (t === 'target player') return 'target-player';
  if (t === 'target opponent') return 'target-opponent';   // 9.0c: src/engine/legal.ts offers only opponents for it
  if (t === 'that player' || t === 'they' || t === 'the player' || t === 'that opponent') return 'that-player';
  if (/^(its|~'s|that (creature|permanent|card|spell|token|land)'s) controller$/.test(t)) return 'controller-of-that';
  if (/^(its|that (creature|permanent|card|spell|token|land)'s|the exiled card's) owner$/.test(t)) return 'owner-of-that';   // "the exiled card's owner creates …"
  if (t === 'you') return 'you';
  return null;
}

/**
 * Third person → second person, so a clause about another player can go through the built-in templates ("each
 * opponent sacrifices a creature, then discards a card" → "sacrifice a creature, then discard a card") and run as
 * that player inside a `scoped` / `unless-pays` block. Returns null for a clause no template will understand as
 * an instruction ("can't …", "controls …").
 */
function secondPerson(text: string): string | null {
  if (/\b(can't|cannot|controls?|has|have|is|are|may not)\b/i.test(text.split(/[,.]/)[0])) return null;
  let t = ' ' + text + ' ';
  t = t.replace(/\b(their|his or her)\b/gi, 'your').replace(/\bthemselves\b/gi, 'yourself').replace(/\bthey\b/gi, 'you');
  t = t.replace(/\b(loses|gains|gets|controls)\b/gi, m => 'you ' + m.slice(0, -1));
  t = t.replace(/\b(draws|discards|sacrifices|mills|creates|exiles|puts|returns|searches|shuffles|reveals|scries|surveils|taps|untaps|destroys|chooses|investigates|adds|pays|looks)\b/gi, m => (/(ch|sh)es$/i.test(m) ? m.slice(0, -2) : m.slice(0, -1)));
  t = t.replace(/\bscries\b/gi, 'scry');
  t = t.replace(/\byou you\b/gi, 'you').replace(/ of your choice\b/gi, '').replace(/\s+/g, ' ').trim();
  return t;
}

const TYPE_WORDS = ['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'instant', 'sorcery', 'battle'];
const COLOR_WORDS = ['white', 'blue', 'black', 'red', 'green'];
const KEYWORD_FILTER_WORDS = ['flying', 'deathtouch', 'lifelink', 'trample', 'haste', 'menace', 'reach', 'vigilance', 'first', 'strike', 'double', 'hexproof', 'indestructible'];
/** Every lower-case word the built-in filter / target parsers give a meaning to; anything else makes a rule decline. */
const FILTER_WORDS = new Set<string>([
  ...TYPE_WORDS, ...TYPE_WORDS.map(t => t + 's'), ...TYPE_WORDS.map(t => 'non' + t), ...TYPE_WORDS.map(t => 'non' + t + 's'),
  ...COLOR_WORDS, ...COLOR_WORDS.map(c => 'non' + c), 'colorless', 'tapped', 'untapped', 'token', 'tokens', 'nontoken', 'attacking', 'blocking',
  'basic', 'nonbasic', 'permanent', 'permanents', 'card', 'cards', 'spell', 'spells', 'a', 'an', 'or', 'other', 'another', 'each',
  'with', 'without', 'power', 'toughness', 'mana', 'value', 'less', 'greater', ...KEYWORD_FILTER_WORDS,
  // 9.0c filter fields: supertypes, the adjective flags, "dealt damage by ~ this turn"
  'legendary', 'nonlegendary', 'snow', 'nonsnow', 'historic', 'multicolored', 'monocolored', 'kicked', 'transformed', 'enchanted', 'equipped', 'modified', 'dealt', 'damage', 'by', '~', 'this', 'turn',
]);
/** A filter word the guards accept: a known word, a subtype, a number, "1/1", or "non-<Subtype>". */
const filterWordOk = (w: string): boolean => FILTER_WORDS.has(w.toLowerCase()) || isSubtype(w) || /^\d+$/.test(w) || /^\d+\/\d+$/.test(w) || (/^non-/i.test(w) && subtypeWord(w.slice(4)) !== null);

/** A filter description whose every word the built-in filter parser understands ("nonblack creature", "Goblin", "artifact creature with flying"). */
function safeFilter(desc: string, ctx: EffectCtx): Filter | null {
  const d = desc.trim().replace(/,/g, ' ');
  if (!d) return null;
  let mvX: Amount | undefined; let mvKey: 'mvLE' | 'mvEQ' = 'mvLE';
  let body = d;
  const mv = body.match(/^(.+?) with mana value (X|\d+)( or less)?$/i);
  if (mv) { body = mv[1]; mvX = mv[2].toUpperCase() === 'X' ? 'X' : Number(mv[2]); mvKey = mv[3] ? 'mvLE' : 'mvEQ'; }
  const other = /^(another|other) /i.test(body); if (other) body = body.replace(/^(another|other) /i, '');
  const pair = body.match(/^([A-Z][a-z]+s?) and ([A-Z][a-z]+s?)$/);   // "Treefolk and Forests": two subtypes, either
  if (pair) { const a = subtypeWord(pair[1]); const b = subtypeWord(pair[2]); if (!a || !b) return null; const f: Filter = { subtypes: [a, b] }; if (mvX !== undefined) f[mvKey] = mvX; if (other) f.other = true; return f; }
  for (const w of body.split(/\s+/)) {
    if (filterWordOk(w)) continue;
    return null;
  }
  const f = ctx.parseFilterWords(body);
  if (!f) return null;
  if (/\bor\b/i.test(body) && Object.keys(f).some(k => k !== 'types' && k !== 'colors')) return null;
  if (mvX !== undefined) f[mvKey] = mvX;
  if (other) f.other = true;
  return f;
}

/** A capitalised word that names a subtype of the pool, singular or plural ("Zombies", "Plains", "Elves"; never "Target", "Up", "Snow"). */
const isSubtype = (w: string): boolean => /^[A-Z]/.test(w) && subtypeWord(w) !== null;

/** "Zombies you control" → "Zombie you control": every capitalised subtype word in the vocabulary's own spelling; any other word is left for the guards to decline. */
function singularWords(desc: string): string {
  return desc.split(/\s+/).map(w => (/^[A-Z]/.test(w) ? subtypeWord(w) ?? w : w)).join(' ');
}

const TGT = "((?:up to (?:one|two|three|four|X) |two |three |any number of )?(?:another |other )?target [^.,]+?|any target)";

/** The built-in target parser, guarded: every filter word must be known, and "any number of target …" is understood. */
function target(phrase: string, ctx: EffectCtx): TargetSpec | null {
  let p = phrase.trim().replace(/,/g, '').replace(/\band\/or\b/gi, 'or');
  // plural type words ("two target artifacts, creatures, and/or lands"): the built-in parser strips one trailing s only
  p = p.replace(/\b(artifacts|creatures|lands|enchantments|permanents|planeswalkers)\b/gi, w => w.slice(0, -1));
  let anyNumber = false;
  if (/^any number of target /i.test(p)) { anyNumber = true; p = p.replace(/^any number of /i, ''); }
  // "target nonland permanent you don't control with mana value 4 or less": the built-in parser wants the controller last
  const mid = p.match(/^(.+?) (you control|an opponent controls|you don't control) (with .+)$/i);
  if (mid) p = `${mid[1]} ${mid[3]} ${mid[2]}`;
  // "with mana value X or less" / "with power 4 or greater": the built-in target parser's crude de-plural turns
  // "less" into "les", so the numeric tail is parsed here and merged into the spec's filter afterwards
  let mvX: Amount | undefined; let tailFilter: Filter | null = null;
  const mv = p.match(/^(.+?) with mana value X or less( you control| an opponent controls| you don't control)?$/i);
  if (mv) { p = mv[1] + (mv[2] ?? ''); mvX = 'X'; }
  const tail = p.match(/^(.+?) (with (?:mana value|power|toughness) \d+ or (?:less|greater))( you control| an opponent controls| you don't control)?$/i);
  if (tail) { p = tail[1] + (tail[3] ?? ''); tailFilter = ctx.parseFilterWords(`creature ${tail[2]}`); if (!tailFilter) return null; delete tailFilter.types; }
  const words = p.replace(/^(up to (?:one|two|three|four|X) |two |three |another |other )+/i, '').replace(/^target /i, '').replace(/ (you control|an opponent controls|you don't control)$/i, '');
  if (words !== 'any target') {
    for (const w of words.split(/\s+/)) {
      if (filterWordOk(w)) continue;
      if (/^(player|opponent|planeswalker|creature-or-player|any|target|activated|triggered|ability|from|in|graveyard)$/i.test(w)) continue;
      return null;
    }
  }
  let spec = ctx.parseTarget(p);
  if (!spec) {
    // "target Elf you control", "another target Aura", "target Forest": a bare subtype names the permanent type it
    // belongs to (src/cards/subtypes.ts) — the built-in target parser only knows the type words themselves
    const bare = p.match(/^((?:up to (?:one|two|three|four) |two |three )?)((?:another |other )?)target ([A-Z][a-z]+)( you control| an opponent controls| you don't control)?$/i);
    const sub = bare ? subtypeWord(bare[3]) : null; const kind = sub ? subtypeKind(sub) : null;
    if (!bare || !sub || !kind || kind === 'Spell' || kind === 'Battle') return null;
    spec = ctx.parseTarget(`${bare[1]}${bare[2]}target ${kind.toLowerCase()}${bare[4] ?? ''}`);
    if (!spec) return null;
    spec.filter = { ...(spec.filter ?? {}), subtypes: [sub] };
  }
  // "creature, Vehicle, or nonbasic land": the built-in filter is the AND of an any-of type list with the other
  // words, so an "or" list is only claimable when it names types (and colours) alone
  if (/\bor\b/i.test(words) && spec.filter && Object.keys(spec.filter).some(k => k !== 'types' && k !== 'colors' && k !== 'other')) return null;
  if (/\bor\b/i.test(words) && spec.filter?.types && spec.filter.types.length > 1 && ['creature', 'artifact', 'enchantment', 'land'].includes(spec.kind)) spec.kind = 'permanent';
  if (mvX !== undefined) spec.filter = { ...(spec.filter ?? {}), mvLE: mvX };
  if (tailFilter) spec.filter = { ...(spec.filter ?? {}), ...tailFilter };
  if (anyNumber) { spec.count = 99; spec.optional = true; }
  return spec;
}

const known = (effs: Effect[]): boolean => effs.length > 0 && effs.every(e => e.op !== 'unknown');

/** The subtypes the text's capitalised words name, in the vocabulary's spelling ("Zombies" -> Zombie, "Elves" -> Elf): the only subtypes a sub-parse of it may carry. */
function subtypeWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[A-Z][a-z]+/g) ?? []) { const sub = subtypeWord(w); if (sub) out.add(sub); }
  return out;
}
/**
 * The built-in filter parser declines every word outside the subtype vocabulary (src/cards/subtypes.ts), so a
 * garbage subtype can only come from a word of the text that *is* a subtype elsewhere ("Target" is not one, "Hero"
 * is): a sub-parse whose subtypes are not subtypes named by the text it came from is still declined, belt and braces.
 */
function garbageSubtypes(v: unknown, allowed: Set<string>): boolean {
  if (Array.isArray(v)) return v.some(x => garbageSubtypes(x, allowed));
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.subtypes) && o.subtypes.some(t => typeof t === 'string' && !allowed.has(t))) return true;
  return Object.values(o).some(x => garbageSubtypes(x, allowed));
}
/** A guarded sub-parse: the effects of `text`, or null when any is unknown or carries a garbage subtype. */
function sub(ctx: EffectCtx, text: string, source = text): Effect[] | null {
  const effs = ctx.parseEffects(text);
  return known(effs) && !garbageSubtypes(effs, subtypeWords(source)) ? effs : null;
}
/** One sentence, guarded the same way. */
function subOne(ctx: EffectCtx, text: string, source = text): Effect | null {
  const e = ctx.parseEffectSentence(text);
  return e.op !== 'unknown' && !garbageSubtypes([e], subtypeWords(source)) ? e : null;
}
/** One effect, or the controller's own block around several (composition.md §4 `scoped`: bindings are shared with the frame). */
const seq = (effs: Effect[]): Effect => (effs.length === 1 ? effs[0] : { op: 'scoped', who: 'you', do: effs });
/** A counter kind word: "+1/+1", "-1/-1", "charge". */
const COUNTER = '([+-]1/[+-]1|[a-z]+)';

// ---------------------------------------------------------------------------------------------------------------
// Amounts: the composition forms on top of the built-in count phrases
// ---------------------------------------------------------------------------------------------------------------

/** Apply `half` / `times` / `plus` to an amount, wrapping it in a `sum` when the amount already carries a modifier. */
function modify(a: Amount, mod: Partial<Pick<AmountExpr, 'half' | 'times' | 'plus'>>): Amount {
  const bare = typeof a === 'object' && a.half === undefined && a.times === undefined && a.plus === undefined && a.max === undefined;
  return bare ? { ...a, ...mod } : { sum: [a], ...mod };
}

/** "its power" / "that creature's toughness" / "the sacrificed creature's power" / "~'s toughness" → a `prop` amount. */
function propOf(t: string): Amount | null {
  const m = t.match(/^(its|that (?:creature|permanent|card|spell|token)'s|the sacrificed (?:creature|permanent)'s|the exiled card's|~'s|enchanted (?:creature|permanent)'s|equipped creature's) (power|toughness|mana value)$/);
  if (!m) return null;
  const of: Ref = /^the sacrificed/.test(m[1]) ? 'sacrificed' : /^the exiled/.test(m[1]) ? 'exiled-with' : m[1] === "~'s" ? 'self' : /^enchanted/.test(m[1]) ? 'enchanted' : /^equipped/.test(m[1]) ? 'equipped' : 'that';
  return { prop: m[2] === 'mana value' ? 'mv' : (m[2] as 'power' | 'toughness'), of };
}

/**
 * The amount an "equal to …" / "where X is …" / "for each …" clause names. Built-in count phrases first (so the
 * named counts the engine already had keep their shape), then the composition forms: `objects` over a zone and a
 * player scope, `prop` of a Ref or a player, `diff`, `sum`, `half`, `times`. Null for anything the engine has no
 * form for — "the greatest power among …", "the total power of …", "that many".
 */
function amountOf(text: string, ctx: EffectCtx): Amount | null {
  const t = text.trim().toLowerCase().replace(/\.$/, '');
  if (!t) return null;
  let m: RegExpMatchArray | null;
  if (t === 'x') return 'X';
  if (/^\d+$/.test(t)) return Number(t);
  // arithmetic first: the built-in "the number of (.+?) you control" is lazy and would swallow "… plus the number of …"
  if ((m = t.match(/^(.+?) plus (the number of .+)$/))) { const a = amountOf(m[1], ctx); const b = amountOf(m[2], ctx); return a === null || b === null ? null : { sum: [a, b] }; }
  if ((m = t.match(/^(.+?) plus (one|two|three|four|five|\d+)$/))) { const a = amountOf(m[1], ctx); const k = ctx.num(m[2]); return a === null || typeof k !== 'number' ? null : modify(a, { plus: k }); }
  if ((m = t.match(/^(.+?) minus (one|two|three|four|five|\d+)$/))) { const a = amountOf(m[1], ctx); const k = ctx.num(m[2]); return a === null || typeof k !== 'number' ? null : { diff: [a, k] }; }
  if ((m = t.match(/^half (.+?), rounded (up|down)$/))) { const a = amountOf(m[1], ctx); return a === null ? null : modify(a, { half: m[2] as 'up' | 'down' }); }
  if ((m = t.match(/^(twice|two times|three times|four times) (.+)$/))) { const a = amountOf(m[2], ctx); const k = /^(twice|two)/.test(m[1]) ? 2 : /^three/.test(m[1]) ? 3 : 4; return a === null ? null : modify(a, { times: k }); }
  const bi = ctx.parseAmountPhrase(t);
  if (bi !== null) return bi;
  const p = propOf(t); if (p) return p;
  if ((m = t.match(/^(?:the )?(?:difference between|difference of) (.+?) and (.+)$/))) {
    const a = amountOf(m[1], ctx); if (a === null) return null;
    // "between its power and toughness": the second half borrows the first half's subject
    const bText = /^(power|toughness|mana value)$/.test(m[2]) ? m[1].replace(/(power|toughness|mana value)$/, m[2]) : m[2];
    const b = amountOf(bText, ctx); if (b === null) return null;
    return { diff: [a, b] };
  }
  if (t === 'your life total') return { prop: 'life', of: 'you' };
  if (t === "that player's life total" || t === 'their life total') return { prop: 'life', of: 'that-player' };
  if (t === "target player's life total" || t === "target opponent's life total") return { prop: 'life', of: 'target-player' };
  if (t === 'the number of cards in your hand') return { prop: 'cards-in-hand', of: 'you' };
  if (t === "the number of cards in that player's hand" || t === 'the number of cards in their hand') return { prop: 'cards-in-hand', of: 'that-player' };
  if (t === 'the number of players') return { count: 'opponents', plus: 1 };
  if (t === 'that many' || t === 'that much') return { count: 'that-many' };   // the last amount the item evaluated, or the number the trigger was about
  // "the greatest power among creatures you control", "the total power of creatures you control", "the highest mana value among …"
  if ((m = t.match(/^the (greatest|highest|total|lowest|least) (power|toughness|mana value) (?:among|of) (.+)$/))) {
    const setM = m[3].match(/^(?:all )?(.+?) (your opponents control|an opponent controls|that player controls|in your hand|in exile|in all graveyards|in your graveyard|in their graveyard|in that player's graveyard|in your library|you control|on the battlefield)$/);
    if (!setM) return null;
    const set = objectSet(setM[1], setM[2], ctx) as AmountExpr | null; if (!set) return null;
    const over = { ...(set.filter ?? {}), ...(set.zone ? { zone: set.zone as SetZone } : {}), ...(set.who ? { who: set.who } : {}) };
    return { prop: m[2] === 'mana value' ? 'mv' : (m[2] as 'power' | 'toughness'), agg: m[1] === 'total' ? 'sum' : m[1] === 'greatest' || m[1] === 'highest' ? 'max' : 'min', over };
  }
  if ((m = t.match(/^the number of (.+?) (your opponents control|an opponent controls|target player controls|target opponent controls|that player controls|in your hand|in exile|in all graveyards|in your graveyard|in their graveyard|in that player's graveyard|in target player's graveyard|in your library|you control|on the battlefield)$/))) {
    const set = objectSet(m[1], m[2], ctx);
    return set;
  }
  if ((m = t.match(/^the number of ([+-]1\/[+-]1|[a-z]+) counters on (.+)$/))) {
    const r = refWord(m[2]); if (!r) return null;
    return null;   // a counter count on a bound object has no amount form yet (only counters-on-source)
  }
  return null;
}

/** "creature" + "your opponents control" → `{ count: 'objects', filter, zone?, who? }`, the set the phrase describes. */
function objectSet(desc: string, where: string, ctx: EffectCtx): Amount | null {
  const words = singularWords(desc.replace(/\bcards?$/i, '').trim());
  const f = words ? safeFilter(words, ctx) : {};
  if (!f) return null;
  const w = where.toLowerCase();
  const out: AmountExpr = { count: 'objects' };
  if (Object.keys(f).length) out.filter = f;
  if (w === 'you control') out.who = 'you';
  else if (w === 'your opponents control' || w === 'an opponent controls') out.who = 'each-opponent';
  else if (w === 'target player controls' || w === 'target opponent controls') return null;   // an amount cannot introduce a target: nothing would ask for the player on cast
  else if (w === 'that player controls') out.who = 'that-player';
  else if (w === 'on the battlefield') { /* every player's */ }
  else if (w === 'in your hand') { out.zone = 'hand'; out.who = 'you'; }
  else if (w === 'in your library') { out.zone = 'library'; out.who = 'you'; }
  else if (w === 'in exile') { out.zone = 'exile'; }
  else if (w === 'in all graveyards') { out.zone = 'graveyard'; }
  else if (w === 'in your graveyard') { out.zone = 'graveyard'; out.who = 'you'; }
  else if (w === 'in their graveyard' || w === "in that player's graveyard") { out.zone = 'graveyard'; out.who = 'that-player'; }
  else if (w === "in target player's graveyard") return null;
  else return null;
  return out;
}

/** The tail of a "for each …" clause: the built-in phrases first, then the composition object sets. */
function eachOf(text: string, ctx: EffectCtx): Amount | null {
  const t = text.trim().toLowerCase().replace(/\.$/, '');
  const bi = ctx.parseEachPhrase(t);
  if (bi !== null) return bi;
  let m: RegExpMatchArray | null;
  if (t === 'player') return { count: 'opponents', plus: 1 };
  if (t === "card you've drawn this turn" || t === 'card you’ve drawn this turn' || t === 'card you have drawn this turn') return { count: 'cards-drawn-this-turn' };
  if ((m = t.match(/^(.+?) (your opponents control|an opponent controls|target player controls|target opponent controls|that player controls|in your hand|in exile|in all graveyards|in your graveyard|in their graveyard|in that player's graveyard|in target player's graveyard|in your library)$/))) return objectSet(m[1].replace(/^(each|every) /, ''), m[2], ctx);
  return null;
}

/** The keys whose `'X'` value a "where X is …" / "equal to …" clause defines. */
const AMOUNT_KEYS = new Set(['amount', 'count', 'power', 'toughness', 'look', 'mvLE', 'mvEQ', 'perEach', 'dynamicPT']);

/**
 * Replace the `'X'` amounts of the effects that a clause defines; null when the clause defined nothing. The built-in
 * pump template reads "-X" as a bare `'X'` (the sign is lost), so a pump's power / toughness is negated here when
 * the text printed "-X" in that slot.
 */
function withX(effs: Effect[], amount: Amount, text: string): Effect[] | null {
  const copy = JSON.parse(JSON.stringify(effs)) as Effect[];
  const neg = (): Amount => (typeof amount === 'object' ? modify(amount, { times: -1 }) : { sum: [amount], times: -1 });
  /** The built-in `pm` reads "-X" as `{ sum: ['X'], times: -1 }` (PARSER_VERSION 4); with the X defined it is the amount negated. */
  const isNegX = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && (v as { times?: unknown }).times === -1 && Array.isArray((v as { sum?: unknown }).sum) && ((v as { sum: unknown[] }).sum).length === 1 && (v as { sum: unknown[] }).sum[0] === 'X';
  let n = 0;
  const walk = (v: unknown, inAmount: boolean): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => { if (x === 'X' && inAmount) { (v as unknown[])[i] = amount; n++; } else walk(x, inAmount); }); return; }
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const isAmount = AMOUNT_KEYS.has(k) || k === 'sum' || k === 'diff' || k === 'min' || (k === 'max' && Array.isArray(o[k]));
      if (o[k] === 'X' && isAmount) { o[k] = amount; n++; } else if (isAmount && isNegX(o[k])) { o[k] = neg(); n++; } else walk(o[k], isAmount);
    }
  };
  walk(copy, false);
  return n ? copy : null;
}

/** Give a scalar effect slot the amount "for each …" names: a printed 1 becomes the amount, a printed k becomes k × it. */
function scaleBy(e: Effect, a: Amount): Effect | null {
  const times = (k: number): Amount => (k === 1 ? a : typeof a === 'object' ? modify(a, { times: k }) : { sum: [a], times: k });
  const numeric = (v: unknown): v is number => typeof v === 'number' && v > 0;
  const o = e as unknown as Record<string, unknown>;
  switch (e.op) {
    case 'add-mana': return e.perEach === undefined && e.amount === undefined && Array.isArray(e.mana) && e.mana.length === 1 ? { ...e, perEach: a } : null;
    case 'token': case 'token-copy': return numeric(o.count) ? { ...e, count: times(o.count) } as Effect : null;
    case 'draw': case 'discard': case 'mill': case 'gain-life': case 'lose-life': case 'counters': case 'damage': case 'poison': case 'energy': case 'player-counter': case 'scry': case 'surveil':
      return numeric(o.amount) ? { ...e, amount: times(o.amount) } as Effect : null;
    case 'pump': {
      const sc = (v: unknown): Amount | null => (typeof v !== 'number' ? null : v === 0 ? 0 : v > 0 ? times(v) : typeof a === 'object' ? modify(a, { times: v }) : { sum: [a], times: v });
      const pw = sc(o.power), tg = sc(o.toughness);
      return pw === null || tg === null ? null : { ...e, power: pw, toughness: tg } as Effect;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------------------------

const COST_VERB = '(pays?|sacrifices?|discards?|returns?|exiles?|removes?)';
/** Words a cost phrase may contain besides filter words: "pay 2 life", "return a land you control to its owner's hand", "exile a card from your graveyard". */
const COST_WORDS = new Set(['life', 'you', 'control', 'to', 'its', "owner's", 'hand', 'from', 'your', 'graveyard', 'the', 'top', 'of', 'library', 'counter', 'counters', 'this', 'at', 'random', 'untapped', 'tapped', 'one', 'two', 'three', 'four', 'five', 'x']);
/** "pays {2}" / "sacrifices a creature" / "discards a card" / "pays 3 life" → the cost phrase in the second person. */
function costPhrase(verb: string, rest: string): string {
  const v = verb.toLowerCase().replace(/s$/, '');
  const r = rest.trim().replace(/\btheir\b/gi, 'your');
  if (v === 'pay' && /^\{/.test(r)) return r;
  return `${v} ${r}`;
}

/**
 * "<player> <clause>", run as that player: a leading "may" is one choice over the whole clause (the built-in
 * sentence parser would otherwise strip the words and make the action mandatory); a "may" anywhere else has no
 * expressible scope and declines. The clause is read in the second person through the built-in templates.
 */
function playerClause(clause: string, ctx: EffectCtx): Effect[] | null {
  let c = clause.trim(); let optional = false;
  if (/^may /i.test(c)) { optional = true; c = c.slice(4); }
  if (/\bmay\b/i.test(c)) return null;
  const body = secondPerson(c); if (body === null) return null;
  const effs = sub(ctx, body, c); if (!effs) return null;
  return optional ? [{ op: 'may', effects: effs }] : effs;
}
/**
 * The block a "<player> <clause>" sentence runs as `who`. "… and you <do>" / "…, then you <do>" is the controller's
 * own half and stays outside the block (a "you" rewritten into the block would act as the other player: "Its
 * controller loses 2 life and you gain 2 life"); any other "you" / "your" in the clause is ambiguous and declines.
 */
function playerBlock(who: ScopeWho, clause: string, ctx: EffectCtx): Effect | null {
  let c = clause.trim(); let yours: Effect[] = [];
  // A trailing ", where X is …" defines X for BOTH halves: only a whole-sentence "where X" rule may read it, and it
  // hands the head (without the clause) back here. Splitting first left the block's X bare while the tail's was
  // defined ("each opponent loses X life and you gain X life, where X is the other result" — Grave Endeavor, 9.1).
  const tail = c.match(/^(.+?)(?:,? and|,? then) you (.+)$/i);
  if (tail && /, where x is /i.test(c)) return null;
  if (tail && !/\b(you|your)\b/i.test(tail[1])) { c = tail[1]; const e = sub(ctx, `you ${tail[2]}`); if (!e) return null; yours = e; }
  if (/\b(you|your)\b/i.test(c)) return null;
  const effs = playerClause(c, ctx); if (!effs) return null;
  const block: Effect = { op: 'scoped', who, do: effs };
  return yours.length ? seq([block, ...yours]) : block;
}

const effects: EffectRule[] = [
  // ---- "When you do, …" (CR 603.12): a reflexive trigger, created only if the preceding effect happened
  { re: /^when you do, (.+)$/i, make: (m, ctx) => { const effs = sub(ctx, m[1]); return effs ? { op: 'reflexive', when: 'you-do', effects: effs } : null; } },

  // ---- "…, where X is <amount>": the sentence with a bare X, then the X defined
  { re: /^(.+?), where x is (.+)$/i, make: (m, ctx) => {
    const a = amountFor(m[2], m[1], ctx); if (a === null) return null;
    const effs = sub(ctx, m[1]); if (!effs) return null;
    const out = withX(effs, a, m[1]); return out ? seq(out) : null;
  } },

  // ---- "… equal to <amount>": rewritten to the "X" form of the same template, then the X defined
  { re: /^(.+?) deals damage equal to (.+?) to (.+)$/i, make: (m, ctx) => equalTo(`${m[1]} deals X damage to ${m[3]}`, m[2], ctx) },
  { re: /^(.+?) deals damage to (.+?) equal to (.+)$/i, make: (m, ctx) => equalTo(`${m[1]} deals X damage to ${m[2]}`, m[3], ctx) },
  { re: /^(.+?\b(?:lose|loses|gain|gains)) life equal to (.+)$/i, make: (m, ctx) => equalTo(`${m[1]} X life`, m[2], ctx) },
  { re: /^(.+?\b(?:draw|draws|discard|discards|mill|mills)) (?:a number of )?cards equal to (.+)$/i, make: (m, ctx) => equalTo(`${m[1]} X cards`, m[2], ctx) },
  { re: new RegExp(`^(.+?\\bput) a number of ${COUNTER} counters on (.+?) equal to (.+)$`, 'i'), make: (m, ctx) => equalTo(`${m[1]} X ${m[2]} counters on ${m[3]}`, m[4], ctx) },
  { re: /^(.+?\bcreate) a number of (.+?) tokens equal to (.+)$/i, make: (m, ctx) => equalTo(`${m[1]} X ${m[2]} tokens`, m[3], ctx) },

  // ---- "… that many cards / counters / tokens", "… that much damage / life": the sentence with X in the slot, X the last
  //      amount evaluated (or the number the trigger was about: the damage dealt, the life gained)
  { re: /^(.+?)\bthat (?:many|much)\b(.*)$/i, make: (m, ctx) => {
    if (/\bthat (?:many|much)\b/i.test(m[2])) return null;
    const rewritten = `${m[1]}X${m[2]}`;
    const effs = sub(ctx, rewritten); if (!effs) return null;
    const out = withX(effs, { count: 'that-many' }, rewritten); return out ? seq(out) : null;
  } },

  // ---- "<effect> for each <set>" (CR 608.2h: the set is counted as the effect applies)
  { re: /^(?!for each)(.+?) for each (.+)$/i, make: (m, ctx) => {
    if (/\bfor each\b/i.test(m[1])) return null;
    const a = eachOf(m[2], ctx); if (a === null || garbageSubtypes(a, subtypeWords(m[2]))) return null;
    const base = subOne(ctx, m[1]); if (!base) return null;
    return scaleBy(base, a);
  } },
  // ---- "For each <set>, <effect about it>" → for-each, and "For each opponent/player, …" → scoped
  { re: /^for each (opponent|player), (.+)$/i, make: (m, ctx) => {
    if (/\btarget\b/i.test(m[2])) return null;   // a target inside a player loop cannot be chosen per player
    if (/\b(you|your)\b/i.test(m[2])) return null;   // the controller inside a per-player block would act as that player
    const effs = playerClause(m[2].replace(/\bthat player\b/gi, 'you'), ctx); if (!effs) return null;
    return { op: 'scoped', who: m[1].toLowerCase() === 'opponent' ? 'each-opponent' : 'each-player', do: effs };
  } },
  { re: /^for each (.+?) (you control|your opponents control|an opponent controls|on the battlefield|in your graveyard|in all graveyards), (.+)$/i, make: (m, ctx) => {
    const set = objectSet(m[1], m[2], ctx) as AmountExpr | null; if (!set) return null;
    const over = { ...(set.filter ?? {}), ...(set.zone ? { zone: set.zone as SetZone } : {}), ...(set.who ? { who: set.who } : {}) };
    const body = m[3].replace(/\b(it|that (?:creature|permanent|card|land|artifact|enchantment|token))\b/gi, 'thatobj');
    const effs = sub(ctx, body, m[3]); if (!effs) return null;
    return { op: 'for-each', over, do: effs };
  } },

  // ---- Refs the built-ins have no target word for ("thatobj" is the for-each body's marker, see above)
  { re: /^(destroy|exile|tap|untap|sacrifice) (thatobj|them|that (?:creature|permanent|card|token|land|artifact|enchantment)|those (?:creatures|cards|permanents|tokens|lands)|each of them)(?: from your graveyard| from exile| from your hand)?$/i, make: m => {
    const r = /^thatobj$/i.test(m[2]) ? 'that' : refWord(m[2]); if (!r) return null;
    const v = m[1].toLowerCase();
    if (v === 'destroy') return { op: 'destroy', target: r };
    if (v === 'exile') return { op: 'move', what: r, to: 'exile' };
    if (v === 'tap') return { op: 'tap', target: r };
    if (v === 'untap') return { op: 'untap', target: r };
    return { op: 'remove-those', how: 'sacrifice' };
  } },
  { re: new RegExp(`^put (a|an|one|two|three|four|five|x|\\d+) ${COUNTER} counters? on (thatobj|it|them|that (?:creature|permanent|card|token|land|artifact)|those (?:creatures|permanents|tokens|lands)|each of them|each of those (?:creatures|permanents))$`, 'i'), make: (m, ctx) => {
    const r = /^thatobj$/i.test(m[3]) ? 'that' : refWord(m[3]); if (!r) return null;
    return { op: 'counters', target: r, counter: m[2].toLowerCase(), amount: ctx.num(m[1]) };
  } },
  { re: /^(thatobj|they|those (?:creatures|permanents|tokens)) (?:each )?gains? (.+?) until end of turn$/i, make: (m, ctx) => { const k = ctx.kwList(m[2]); return k ? { op: 'grant-keyword', target: /^thatobj$/i.test(m[1]) ? 'that' : 'those', keywords: k, duration: 'eot' } : null; } },
  { re: /^(thatobj|they|those (?:creatures|permanents|tokens)) (?:each )?gets? ([+-]\d+|[+-]X)\/([+-]\d+|[+-]X)(?: and gains? (.+?))? until end of turn$/i, make: (m, ctx) => {
    const k = m[4] ? ctx.kwList(m[4]) : []; if (!k) return null;
    const pm = (s: string): Amount => (s.toUpperCase().endsWith('X') ? (s.startsWith('-') ? { sum: ['X'], times: -1 } : 'X') : Number(s));
    return { op: 'pump', target: /^thatobj$/i.test(m[1]) ? 'that' : 'those', power: pm(m[2]), toughness: pm(m[3]), ...(k.length ? { keywords: k } : {}), duration: 'eot' };
  } },
  { re: /^(those (?:creatures|permanents|lands)|they) don't untap during their controllers?' next untap steps?$/i, make: () => ({ op: 'no-untap-that' }) },

  // ---- move: "put/return <ref or target> onto/to the battlefield …", libraries, exile-until
  { re: /^(put|return) (it|them|that card|those cards|the exiled cards?|thatobj) (?:onto|to) the battlefield( tapped)?(?: under (your|its owner's|their owner's|their owners') control)?( tapped)?(?: with (a|an|two|three|x) ([+-]1\/[+-]1|[a-z]+) counters? on (?:it|them|each of them))?$/i, make: (m, ctx) => {
    const r = /^thatobj$/i.test(m[2]) ? 'that' : refWord(m[2]); if (!r) return null;
    const ctl = m[4] ? (m[4].toLowerCase() === 'your' ? 'you' : 'owner') : (m[1].toLowerCase() === 'put' ? 'you' : 'owner');
    const e: Effect = { op: 'move', what: r, to: 'battlefield', controller: ctl };
    if (m[3] || m[5]) e.tapped = true;
    if (m[6]) e.withCounters = { counter: m[7].toLowerCase(), amount: ctx.num(m[6]) };
    return e;
  } },
  { re: /^put (it|them|that card|those cards|thatobj) (on top|on the bottom) of (?:its owner's|their owner's|their owners') librar(?:y|ies)(?: in any order| in a random order)?$/i, make: m => { const r = /^thatobj$/i.test(m[1]) ? 'that' : refWord(m[1]); return r ? { op: 'move', what: r, to: 'library', pos: m[2].toLowerCase() === 'on top' ? 'top' : 'bottom' } : null; } },
  { re: /^put (it|them|that card|those cards|thatobj) (on top|on the bottom) of your library(?: in any order| in a random order)?$/i, make: m => { const r = /^thatobj$/i.test(m[1]) ? 'that' : refWord(m[1]); return r ? { op: 'move', what: r, to: 'library', pos: m[2].toLowerCase() === 'on top' ? 'top' : 'bottom' } : null; } },
  { re: /^put (it|them|that card|those cards|thatobj) into (?:its|their) owners?' graveyards?$/i, make: m => { const r = /^thatobj$/i.test(m[1]) ? 'that' : refWord(m[1]); return r ? { op: 'move', what: r, to: 'graveyard' } : null; } },
  { re: /^return (it|them|that card|those cards|thatobj) to (?:its owner's|their owner's|their owners') hands?$/i, make: m => { const r = /^thatobj$/i.test(m[1]) ? 'that' : refWord(m[1]); return r ? { op: 'move', what: r, to: 'hand' } : null; } },
  { re: /^(?:put|return) (it|them|that card|those cards|thatobj) (?:into|to) your hand$/i, make: m => { const r = /^thatobj$/i.test(m[1]) ? 'that' : refWord(m[1]); return r ? { op: 'move', what: r, to: 'hand' } : null; } },
  { re: /^exile (it|them|that card|those cards|that creature|those creatures|that permanent|thatobj) until ~ leaves the battlefield$/i, make: m => { const r = /^thatobj$/i.test(m[1]) ? 'that' : refWord(m[1]); return r ? { op: 'move', what: r, to: 'exile', until: 'leaves' } : null; } },
  { re: new RegExp(`^exile ${TGT} until end of turn$`, 'i'), make: (m, ctx) => { const t = target(m[1], ctx); return t ? { op: 'move', what: t, to: 'exile', until: 'eot' } : null; } },
  { re: /^return (all|each) (.+?) cards? from your graveyard to (the battlefield|your hand)( tapped)?$/i, make: (m, ctx) => {
    const f = permanentCardFilter(m[2], safeFilter(singularWords(m[2]), ctx)); if (!f) return null;
    const e: Effect = { op: 'move', what: { filter: f, zone: 'graveyard', who: 'you', count: 'all' }, to: m[3].toLowerCase() === 'your hand' ? 'hand' : 'battlefield' };
    if (e.to === 'battlefield') e.controller = 'you';
    if (m[4]) e.tapped = true;
    return e;
  } },
  { re: /^put (?:up to )?(a|an|one|two|three|four|x|any number of) (.+?) cards? from your graveyard onto the battlefield( tapped)?$/i, make: (m, ctx) => {
    const f = permanentCardFilter(m[2], safeFilter(singularWords(m[2]), ctx)); if (!f) return null;
    const n = m[1].toLowerCase() === 'any number of' ? 'all' : ctx.num(m[1]);
    const e: Effect = { op: 'move', what: { filter: f, zone: 'graveyard', who: 'you', count: n }, to: 'battlefield', controller: 'you' };
    if (m[3]) e.tapped = true;
    return e;
  } },
  { re: /^return (?:up to )?(a|an|one|two|three|four|x) (.+?) cards? from your graveyard to the battlefield( tapped)?$/i, make: (m, ctx) => {
    const f = permanentCardFilter(m[2], safeFilter(singularWords(m[2]), ctx)); if (!f) return null;
    const e: Effect = { op: 'move', what: { filter: f, zone: 'graveyard', who: 'you', count: ctx.num(m[1]) }, to: 'battlefield', controller: 'you' };
    if (m[3]) e.tapped = true;
    return e;
  } },
  { re: /^return (?:up to (\w+) )?(another )?target (.+?) cards?((?: with .+?)?) from your graveyard to (the battlefield|your hand)( tapped)?$/i, make: (m, ctx) => {
    const f = permanentCardFilter(m[3], safeFilter(`${m[2] ?? ''}${singularWords(m[3])}${m[4]}`, ctx)); if (!f) return null;
    const n = m[1] ? ctx.num(m[1]) : 1; if (typeof n !== 'number') return null;
    const e: Effect = { op: 'return-from-graveyard', what: f, to: m[5].toLowerCase() === 'your hand' ? 'hand' : 'battlefield', target: true };
    if (m[1]) { e.optional = true; if (n !== 1) e.count = n; }   // "up to two target creature cards": up to `count`, fewer is fine
    if (m[6]) e.tapped = true;
    return e;
  } },
  { re: /^put target (.+?) card from a graveyard onto the battlefield under your control( tapped)?$/i, make: (m, ctx) => {
    const f = permanentCardFilter(m[1], safeFilter(m[1], ctx)); if (!f) return null;
    const e: Effect = { op: 'move', what: { kind: 'graveyard-card', filter: f }, to: 'battlefield', controller: 'you' };
    if (m[2]) e.tapped = true;
    return e;
  } },

  // ---- set-pt / lose-abilities (layers 7b and 6)
  { re: new RegExp(`^(?:until end of turn, )?${TGT} loses all abilities and has base power and toughness (\\d+)/(\\d+)( until end of turn)?$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); if (!t) return null;
    const duration = /^until end of turn, /i.test(m[0]) || m[4] ? 'eot' : 'permanent';
    return seq([{ op: 'lose-abilities', target: t, keywords: 'all', duration }, { op: 'set-pt', target: 'target:0', power: Number(m[2]), toughness: Number(m[3]), base: true, duration }]);
  } },
  { re: new RegExp(`^${TGT} has base power and toughness (\\d+)/(\\d+)( until end of turn)?$`, 'i'), make: (m, ctx) => { const t = target(m[1], ctx); return t ? { op: 'set-pt', target: t, power: Number(m[2]), toughness: Number(m[3]), base: true, duration: m[4] ? 'eot' : 'permanent' } : null; } },
  { re: /^~ has base power and toughness (\d+)\/(\d+)( until end of turn)?$/i, make: m => ({ op: 'set-pt', target: 'self', power: Number(m[1]), toughness: Number(m[2]), base: true, duration: m[3] ? 'eot' : 'permanent' }) },
  { re: /^(thatobj|those creatures|they) (?:each )?(?:has|have) base power and toughness (\d+)\/(\d+)( until end of turn)?$/i, make: m => ({ op: 'set-pt', target: /^thatobj$/i.test(m[1]) ? 'that' : 'those', power: Number(m[2]), toughness: Number(m[3]), base: true, duration: m[4] ? 'eot' : 'permanent' }) },
  { re: new RegExp(`^${TGT} loses all abilities( until end of turn)?$`, 'i'), make: (m, ctx) => { const t = target(m[1], ctx); return t ? { op: 'lose-abilities', target: t, keywords: 'all', duration: m[2] ? 'eot' : 'permanent' } : null; } },
  { re: /^~ loses all abilities( until end of turn)?$/i, make: m => ({ op: 'lose-abilities', target: 'self', keywords: 'all', duration: m[1] ? 'eot' : 'permanent' }) },
  { re: /^(thatobj|those creatures|they) (?:each )?loses? all abilities( until end of turn)?$/i, make: m => ({ op: 'lose-abilities', target: /^thatobj$/i.test(m[1]) ? 'that' : 'those', keywords: 'all', duration: m[2] ? 'eot' : 'permanent' }) },
  { re: new RegExp(`^${TGT} loses (.+?) until end of turn$`, 'i'), make: (m, ctx) => { const t = target(m[1], ctx); const k = ctx.kwList(m[2]); return t && k && k.length ? { op: 'lose-abilities', target: t, keywords: k, duration: 'eot' } : null; } },
  { re: /^all creatures lose all abilities until end of turn$/i, make: () => ({ op: 'lose-abilities', target: 'all-creatures', keywords: 'all', duration: 'eot' }) },

  // ---- exchange (CR 701.12)
  { re: /^exchange life totals with (target player|target opponent)$/i, make: m => ({ op: 'exchange', what: 'life', a: 'you', b: { kind: /opponent/i.test(m[1]) ? 'opponent' : 'player' } }) },
  { re: /^exchange control of two target (.+)$/i, make: (m, ctx) => { const t = target('target ' + m[1].replace(/s\b/, ''), ctx); return t ? { op: 'exchange', what: 'control', a: t, b: JSON.parse(JSON.stringify(t)) } : null; } },
  { re: /^exchange control of (target [^,]+?) and ((?:another )?target [^,]+)$/i, make: (m, ctx) => { const a = target(m[1], ctx); const b = target(m[2].replace(/^another /i, ''), ctx); return a && b ? { op: 'exchange', what: 'control', a, b } : null; } },
  { re: /^exchange control of ~ and (target .+)$/i, make: (m, ctx) => { const b = target(m[1], ctx); return b ? { op: 'exchange', what: 'control', a: 'self', b } : null; } },

  // ---- multi targets (CR 115.3): "target creature and target player", "any number of target creatures"
  // ("destroy / exile / tap / untap target A and target B" never reach the registry: the built-in TGT slot takes the
  //  whole phrase as one target — a pre-existing lossy parse, recorded in docs/HANDOFF.md)
  { re: /^~ deals (\w+) damage to (target [^,]+?) and (target [^,]+)$/i, make: (m, ctx) => { const a = target(m[2], ctx); const b = target(m[3], ctx); return a && b ? { op: 'damage', amount: ctx.num(m[1]), target: { kind: 'multi', specs: [a, b] } } : null; } },
  { re: /^(destroy|exile|tap|untap) (any number of target .+)$/i, make: (m, ctx) => {
    const t = target(m[2], ctx); if (!t) return null;
    const v = m[1].toLowerCase();
    return v === 'destroy' ? { op: 'destroy', target: t } : v === 'exile' ? { op: 'exile', target: t } : v === 'tap' ? { op: 'tap', target: t } : { op: 'untap', target: t };
  } },
  { re: /^(two|three|any number of|up to \w+) target (.+?) each get ([+-]\d+)\/([+-]\d+)(?: and gain (.+?))? until end of turn$/i, make: (m, ctx) => {
    const t = target(`${m[1]} target ${m[2]}`, ctx); if (!t) return null;
    const k = m[5] ? ctx.kwList(m[5]) : []; if (!k) return null;
    return { op: 'pump', target: t, power: Number(m[3]), toughness: Number(m[4]), ...(k.length ? { keywords: k } : {}), duration: 'eot' };
  } },
  { re: /^(two|three|any number of|up to \w+) target (.+?) each gain (.+?) until end of turn$/i, make: (m, ctx) => { const t = target(`${m[1]} target ${m[2]}`, ctx); const k = ctx.kwList(m[3]); return t && k ? { op: 'grant-keyword', target: t, keywords: k, duration: 'eot' } : null; } },

  // ---- delayed triggers at the new firing points (CR 603.7)
  { re: /^(exile|sacrifice) (it|them|that creature|those creatures|that token|those tokens|that card|those cards|that permanent|those permanents) at the beginning of the next end step$/i, make: m => delayedRemove(m[1], m[2], 'next-end-step') },
  { re: /^at the beginning of the next end step, (exile|sacrifice) (it|them|that creature|those creatures|that token|those tokens|that card|those cards|that permanent|those permanents)$/i, make: m => delayedRemove(m[1], m[2], 'next-end-step') },
  { re: /^(exile|sacrifice) (it|them|that creature|those creatures|that token|those tokens|that permanent|those permanents) at (?:the )?end of combat$/i, make: m => delayedRemove(m[1], m[2], 'end-of-combat') },
  { re: /^(exile|sacrifice) (it|them|that creature|those creatures|that token|those tokens|that card|those cards|that permanent|those permanents) at the beginning of your next end step$/i, make: m => delayedRemove(m[1], m[2], 'your-next-end-step') },
  { re: /^return (it|them|that card|those cards|that creature) to (?:its owner's|their owner's|their owners') hands? at the beginning of the next end step$/i, make: m => { const r = refWord(m[1]); return r ? { op: 'delayed-trigger', at: 'next-end-step', bind: r === 'those' ? 'those' : 'that', effects: [{ op: 'move', what: r, to: 'hand' }] } : null; } },
  { re: /^return (it|them|that card|those cards) to the battlefield( tapped)? under (your|its owner's|their owner's|their owners') control at the beginning of the next end step$/i, make: m => { const r = refWord(m[1]); return r ? { op: 'delayed-trigger', at: 'next-end-step', bind: r === 'those' ? 'those' : 'that', effects: [{ op: 'move', what: r, to: 'battlefield', controller: m[3].toLowerCase() === 'your' ? 'you' : 'owner', ...(m[2] ? { tapped: true } : {}) }] } : null; } },
  { re: /^when (that creature|it|that permanent|that token) dies this turn, (.+)$/i, make: (m, ctx) => { const effs = sub(ctx, m[2]); return effs ? { op: 'delayed-trigger', at: 'this-turn:dies', bind: 'that', effects: effs } : null; } },
  { re: /^when (that creature|it|that permanent|that token) leaves the battlefield this turn, (.+)$/i, make: (m, ctx) => { const effs = sub(ctx, m[2]); return effs ? { op: 'delayed-trigger', at: 'this-turn:ltb', bind: 'that', effects: effs } : null; } },
  { re: /^at the beginning of the next turn's upkeep, (.+)$/i, make: (m, ctx) => { const effs = sub(ctx, m[1]); return effs ? { op: 'delayed-trigger', at: 'next-turn:upkeep', ...(mentionsThat(effs) ? { bind: 'that' } : {}), effects: effs } : null; } },
  { re: /^at the beginning of the next end step, (.+)$/i, make: (m, ctx) => { const effs = sub(ctx, m[1]); return effs ? { op: 'delayed-trigger', at: 'next-end-step', ...(mentionsThat(effs) ? { bind: 'that' } : {}), effects: effs } : null; } },
  { re: /^at the beginning of your next end step, (.+)$/i, make: (m, ctx) => { const effs = sub(ctx, m[1]); return effs ? { op: 'delayed-trigger', at: 'your-next-end-step', ...(mentionsThat(effs) ? { bind: 'that' } : {}), effects: effs } : null; } },

  // ---- "… unless <player> <pays a cost>" (CR 118.12)
  { re: new RegExp(`^(.+?) unless (you|they|that player|its controller|that creature's controller|each opponent|each player|target player|target opponent) ${COST_VERB} (.+)$`, 'i'), make: (m, ctx) => {
    const payer = whoWord(m[2]); if (!payer) return null;
    for (const w of m[4].split(/\s+/)) if (!(FILTER_WORDS.has(w.toLowerCase()) || COST_WORDS.has(w.toLowerCase()) || /^[A-Z][a-z]+s?$/.test(w) || /^\d+$/.test(w) || /^\{[^}]+\}$/.test(w))) return null;
    const cost = ctx.parseCostPhrase(costPhrase(m[3], m[4])); if (!cost || !Object.keys(cost).length) return null;
    if (/\bunless\b/i.test(m[1])) return null;
    const main = m[1].trim();
    // whose clause is it? the payer's own ("each opponent discards a card unless they pay {1}") or the controller's
    // ("sacrifice ~ unless you pay 2 life"); a clause about you that another player pays for cannot be expressed
    // (the `otherwise` block runs as the payer — composition.md §4 `unless-pays`)
    const subj = main.match(/^(each opponent|each other player|each player|target player|target opponent|that player|its controller) (.+)$/i);
    if (subj) {
      const subjWho = whoWord(subj[1]); if (!subjWho) return null;
      const same = payer === subjWho || (payer === 'that-player' && subjWho !== 'you');   // "they" / "that player" = the subject
      if (!same) return null;
      if (/\b(you|your)\b/i.test(subj[2])) return null;
      const otherwise = playerClause(subj[2], ctx);
      return otherwise ? { op: 'unless-pays', who: subjWho, cost, otherwise } : null;
    }
    const otherwise = sub(ctx, main);
    if (!otherwise) return null;
    // "return another target creature to its owner's hand unless its controller pays {1}" (Withdraw): "its" is the
    // clause's own target, which the frame cannot name before the clause runs (a `bind` of the targets would name the
    // FIRST target's controller) — declined until the engine has a target-controller payer
    if ((payer === 'controller-of-that' || payer === 'owner-of-that') && /\btarget\b/i.test(main)) return null;
    // "you may draw a card unless that player pays {4}" (Rhystic Study): another player pays, the clause runs as you
    if (payer !== 'you') return /\byou\b|\byour\b/i.test(main) || !/^(each|target|that|its)\b/i.test(main) ? { op: 'unless-pays', who: payer, cost, otherwise, otherwiseAs: 'controller' } : null;
    return { op: 'unless-pays', who: 'you', cost, otherwise };
  } },

  // ---- "<player> <does something>" → scoped (CR 101.4 APNAP for the each-* words)
  { re: /^(each opponent|each other player|each player|target player|target opponent|that player|its controller|~'s controller|that (?:creature|permanent|card|spell|token|land)'s controller|its owner|that (?:creature|permanent|card|token)'s owner|the exiled card's owner) (.+)$/i, make: (m, ctx) => {
    const who = whoWord(m[1]); if (!who) return null;
    if (/\bunless\b/i.test(m[2])) return null;
    return playerBlock(who, m[2], ctx);
  } },
  { re: /^they (draw|discard|lose|gain|sacrifice|mill|create|exile|put|return|search|shuffle|scry|surveil|reveal|may|get) (.+)$/i, make: (m, ctx) => {
    if (/\bunless\b/i.test(m[2])) return null;
    return playerBlock('that-player', `${m[1]} ${m[2]}`, ctx);
  } },

  // ---- a few generic wordings the owner's decks need, on the ops the engine already had
  { re: /^put target (?:(.+?) )?cards? from your graveyard on the bottom of your library$/i, make: (m, ctx) => { const f = m[1] ? permanentCardFilter(m[1], safeFilter(singularWords(m[1]), ctx)) : {}; return f ? { op: 'return-from-graveyard', what: f, to: 'library-bottom', target: true } : null; } },
  { re: /^put target card from your graveyard on top of your library$/i, make: () => ({ op: 'return-from-graveyard', what: {}, to: 'library-top', target: true }) },
  { re: /^add (one|two|three|four|five|six|seven|eight|\d+) mana in any combination of colors$/i, make: (m, ctx) => { const n = ctx.num(m[1]); return typeof n === 'number' ? { op: 'add-mana', mana: 'any', amount: n } : null; } },
  { re: /^return ~ from your graveyard to the battlefield( tapped)?$/i, make: m => ({ op: 'move', what: 'self', to: 'battlefield', controller: 'you', ...(m[1] ? { tapped: true } : {}) }) },
  { re: /^discard your hand$/i, make: () => ({ op: 'discard', amount: 'hand', who: 'you' }) },
  { re: new RegExp(`^${TGT} gains your choice of (.+?) or (.+?) until end of turn$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); const a = ctx.kwList(m[2]); const b = ctx.kwList(m[3]); if (!t || !a || !b) return null;
    return { op: 'choose-mode', count: 1, modes: [[{ op: 'grant-keyword', target: t, keywords: a, duration: 'eot' }], [{ op: 'grant-keyword', target: JSON.parse(JSON.stringify(t)), keywords: b, duration: 'eot' }]] };
  } },
  { re: new RegExp(`^put (a|an|one|two|three|four|x|\\d+) ${COUNTER} counters? on (him|her)$`, 'i'), make: (m, ctx) => ({ op: 'counters', target: 'self', counter: m[2].toLowerCase(), amount: ctx.num(m[1]) }) },
  { re: /^draw half x cards, rounded (up|down)$/i, make: m => ({ op: 'draw', amount: { sum: ['X'], half: m[1].toLowerCase() as 'up' | 'down' }, who: 'you' }) },
  // the built-in TGT slot stops at a comma and wants the controller phrase last ("up to one target nonland, nontoken
  // permanent you don't control with mana value 4 or less"): the same four verbs through the guarded target parser
  { re: /^(destroy|exile|tap|untap) ((?:up to (?:one|two|three|four) |two |three )?(?:another |other )?target .+)$/i, make: (m, ctx) => {
    if (!/,| you control with | an opponent controls with | you don't control with |with mana value X/i.test(m[2])) return null;   // only the shapes the built-ins cannot take
    const t = target(m[2], ctx); if (!t) return null;
    const v = m[1].toLowerCase();
    return v === 'destroy' ? { op: 'destroy', target: t } : v === 'exile' ? { op: 'exile', target: t } : v === 'tap' ? { op: 'tap', target: t } : { op: 'untap', target: t };
  } },
  // "Counter target artifact, creature, or planeswalker spell": the built-in target slot stops at the comma
  { re: /^counter (target .+ spell)$/i, make: (m, ctx) => { if (!/,/.test(m[1])) return null; const t = target(m[1], ctx); return t && /spell/.test(t.kind) ? { op: 'counter', target: t } : null; } },
  { re: /^(destroy|exile|tap|untap) (target .+ with mana value X or less)$/i, make: (m, ctx) => {
    const t = target(m[2], ctx); if (!t) return null;
    const v = m[1].toLowerCase();
    return v === 'destroy' ? { op: 'destroy', target: t } : v === 'exile' ? { op: 'exile', target: t } : v === 'tap' ? { op: 'tap', target: t } : { op: 'untap', target: t };
  } },

  { re: new RegExp(`^double the power of ${TGT} until end of turn$`, 'i'), make: (m, ctx) => { const t = target(m[1], ctx); return t ? { op: 'double-power', target: t } : null; } },
  // ---- "<Spirits / Treefolk and Forests / nonblack creatures> you control gain <keywords> / get +N/+N until end of turn":
  //      the pump and grant ops take no filter, so each matching permanent is visited in turn (CR 608.2f snapshot)
  { re: /^(?!creatures? you control|other creatures? you control|permanents you control)(.+?) you control (?:each )?gains? (.+?) until end of turn$/i, make: (m, ctx) => {
    const f = safeFilter(singularWords(m[1]), ctx); const k = ctx.kwList(m[2]); if (!f || !k || !k.length) return null;
    return { op: 'for-each', over: { ...f, who: 'you' }, do: [{ op: 'grant-keyword', target: 'that', keywords: k, duration: 'eot' }] };
  } },
  { re: /^(?!creatures? you control|other creatures? you control|permanents you control)(.+?) you control (?:each )?gets? ([+-]\d+)\/([+-]\d+)(?: and gains? (.+?))? until end of turn$/i, make: (m, ctx) => {
    const f = safeFilter(singularWords(m[1]), ctx); const k = m[4] ? ctx.kwList(m[4]) : []; if (!f || !k) return null;
    return { op: 'for-each', over: { ...f, who: 'you' }, do: [{ op: 'pump', target: 'that', power: Number(m[2]), toughness: Number(m[3]), ...(k.length ? { keywords: k } : {}), duration: 'eot' }] };
  } },

  // ---- "Target Elf you control gets +2/+2 until end of turn" / "Target Aura gains …": a target the built-in target
  //      parser has no type word for (the subtype names its permanent type), through the guarded target parser
  { re: new RegExp(`^${TGT} gets ([+-]\\d+)\\/([+-]\\d+)(?: and gains? (.+?))? until end of turn$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); const k = m[4] ? ctx.kwList(m[4]) : []; if (!t || t.kind === 'any' || !k) return null;
    return { op: 'pump', target: t, power: Number(m[2]), toughness: Number(m[3]), ...(k.length ? { keywords: k } : {}), duration: 'eot' };
  } },
  { re: new RegExp(`^${TGT} gains (.+?) until end of turn$`, 'i'), make: (m, ctx) => { const t = target(m[1], ctx); const k = ctx.kwList(m[2]); return t && t.kind !== 'any' && k && k.length ? { op: 'grant-keyword', target: t, keywords: k, duration: 'eot' } : null; } },

  // ---- "you lose half your life, rounded up" (inside a scoped block: the player the block runs as)
  { re: /^you (lose|gain) half your life, rounded (up|down)$/i, make: m => ({ op: m[1].toLowerCase() === 'lose' ? 'lose-life' : 'gain-life', amount: { prop: 'life', of: 'you', half: m[2].toLowerCase() as 'up' | 'down' }, who: 'you' }) },
  // ---- "put a counter on each <filter> <player> controls" → for-each over that player's objects
  { re: new RegExp(`^put (a|an|one|two|three|x) ${COUNTER} counters? on each (.+?) (target player|target opponent|that player|your opponents|each opponent) controls?$`, 'i'), make: (m, ctx) => {
    const f = safeFilter(singularWords(m[3]), ctx); if (!f) return null;
    const w = m[4].toLowerCase(); const who: ScopeWho = w === 'that player' ? 'that-player' : w === 'target opponent' ? 'target-opponent' : w === 'target player' ? 'target-player' : 'each-opponent';
    return { op: 'for-each', over: { ...f, who }, do: [{ op: 'counters', target: 'that', counter: m[2].toLowerCase(), amount: ctx.num(m[1]) }] };
  } },

  // ---- sacrifice with a filter word the built-in number slot does not take ("sacrifice another creature")
  { re: /^sacrifice (another|an? other) (.+?)$/i, make: (m, ctx) => { const f = safeFilter(m[2], ctx); return f ? { op: 'sacrifice', who: 'you', what: { ...f, other: true }, amount: 1 } : null; } },

  // ---- LAST: "you may <A and B>" / "you may <A, then B>" is one choice over the whole sentence, so a sentence that
  //      began with "you may" and that only decomposes is parsed as a list under the one `may` parse.ts wraps around
  //      the result (the decomposition ladder would otherwise put the `may` on the first part alone)
  { re: /^(.+)$/, make: (m, ctx) => {
    if (!ctx.optional || !/ and |, then /i.test(m[1])) return null;
    const effs = sub(ctx, m[1]);
    return effs && effs.length > 1 ? seq(effs) : null;
  } },
];

// ---- one whole-line static the owner's decks use, on the statics the engine already had (a line rule, because a
//      static rule is handed no condition parser): "As long as <condition>, ~ gets +N/+N and can't block."
const lines: LineRule[] = [
  { name: 'self-pt-and-cant-block', match: (line, ctx) => {
    const m = line.trim().replace(/\.$/, '').match(/^as long as (.+?), ~ gets ([+-]\d+)\/([+-]\d+) and can't block$/i);
    if (!m || ctx.isSpell) return false;
    const c = ctx.parseCondition(m[1]); if (c.kind === 'unknown') return false;
    ctx.addAbility({ kind: 'static', effect: { kind: 'self-pt', power: Number(m[2]), toughness: Number(m[3]), ...({ condition: c } as object) }, text: line });
    ctx.addAbility({ kind: 'static', effect: { kind: 'self-keywords', keywords: [], condition: c, cantBlock: true }, text: line });
    return true;
  } },
];

/**
 * The amount a clause names, read against the sentence it modifies: "the exiled card" is `that` once the same
 * sentence exiled it (an `exiled-with` is the source's imprint); a "that player's …" amount under an "each player" /
 * "each opponent" subject would need a per-player evaluation the ops do not make, so it is declined.
 */
function amountFor(amountText: string, base: string, ctx: EffectCtx): Amount | null {
  let text = amountText.trim();
  // "its power" is the sentence's subject: the source when the sentence is about `~`, the first target when it is
  // about a target ("Target creature gets +X/+0 …, where X is its power"); with both in play the English is ambiguous
  if (/^its (power|toughness|mana value)$/i.test(text)) {
    // "Put X +1/+1 counters on ~, where X is its power" is about the source as much as "~ gets +X/+0 … its power"
    const aboutSelf = /(^|\s)~(?=[\s.,']|$)/.test(base) && !/\btarget\b|\bthat\b|\bthose\b|\beach\b|\ball\b/i.test(base);
    const aboutTarget = /^(?:up to \w+ |another |other )?target /i.test(base) && !/ target /i.test(base.replace(/^(?:up to \w+ |another |other )?target /i, ''));
    if (aboutSelf) text = text.replace(/^its/i, "~'s");
    else if (aboutTarget) { const p = propOf(text.toLowerCase()); return p && typeof p === 'object' ? { ...p, of: 'target:0' } : null; }
    else if (/\btarget\b/i.test(base)) return null;
  }
  let a = amountOf(text, ctx); if (a === null) return null;
  if (garbageSubtypes(a, subtypeWords(amountText))) return null;
  if (/\bthat player\b|\btheir\b/i.test(amountText) && /\beach (player|opponent)\b/i.test(base)) return null;
  if (/\bexile/i.test(base) && JSON.stringify(a).includes('"exiled-with"')) a = JSON.parse(JSON.stringify(a).replace(/"exiled-with"/g, '"that"')) as Amount;
  return a;
}

/** "… equal to <amount>": the same sentence with "X" in the slot, then the X defined. */
function equalTo(rewritten: string, amountText: string, ctx: EffectCtx): Effect | null {
  // "It deals damage equal to its power to each other creature" reaches this as "~ deals …": the built-ins have
  // already rewritten a leading "it" / "that creature" to the source, and a damage clause sourced from a bound
  // creature has a different source and a different "other" — not this template's to claim
  if (/^~ deals X damage to /i.test(rewritten) && /^its /i.test(amountText.trim())) return null;
  const a = amountFor(amountText, rewritten, ctx); if (a === null) return null;
  const e = subOne(ctx, rewritten); if (!e) return null;
  const out = withX([e], a, rewritten); return out ? out[0] : null;
}

function delayedRemove(verb: string, what: string, at: 'next-end-step' | 'end-of-combat' | 'your-next-end-step'): Effect | null {
  const r = refWord(what); if (!r || (r !== 'that' && r !== 'those')) return null;
  const how = verb.toLowerCase() === 'exile' ? 'exile' : 'sacrifice';
  return { op: 'delayed-trigger', at, bind: r, effects: [{ op: 'remove-those', how }] };
}

/** Does any effect (nested lists included) refer to the `that` binding? */
function mentionsThat(v: unknown): boolean {
  if (v === 'that' || v === 'those' || v === 'controller-of-that') return true;
  if (Array.isArray(v)) return v.some(mentionsThat);
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(mentionsThat);
  return false;
}

const composition: RuleFamily = { name: 'composition', effects, lines };
export default composition;
