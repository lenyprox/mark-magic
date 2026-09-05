// Parser rules for the control family (Phase 9.1; docs/vocabulary/control.md).
//
// The wordings the built-in table cannot reach. `src/cards/parse.ts` already knows three shapes exactly — "gain
// control of <target>", "… until end of turn", and the one Threaten package "gain control of <target> until end of
// turn. Untap that creature. It gains haste until end of turn." — and nothing else. Everything below is what the
// pool actually prints around those three:
//
//   durations   "for as long as you control ~", "… ~ remains on the battlefield", "… ~ remains tapped",
//               "… you control ~ and ~ remains tapped", "until the end of your next turn", "until end of combat"
//   the package "Untap target creature and gain control of it until end of turn. That creature gains haste …" (the
//               other printed order), the plural forms ("Untap those creatures. They gain haste …")
//   a gainer    "Target opponent gains control of ~", "Target player gains control of target permanent you control",
//               "the player with the most life gains control of ~"
//   groups      "gain control of all Dragons", "gain control of all artifacts your opponents control"
//   giving back "Each player gains control of all creatures they own"
//   exchanges   "Exchange control of two target permanents that share a card type"
//
// Every rule is consulted only after every built-in stage of parse.ts has declined the text (the registry contract in
// ./types.ts), and every one of them is anchored on the words "control" / "exchange control", so the family can only
// claim sentences about control. The two disciplines the composition family set are kept: a rule never claims what it
// cannot express (an unknown sub-parse, a filter word outside the shared vocabulary, or a subtype the text does not
// name makes the whole rule decline), and a rule returns ONE effect — several parts are wrapped in the composition
// core's `{ op: 'scoped', who: 'you', do: [...] }`, the controller's own block.
import type { Condition, Effect, Filter, TargetSpec, TriggerEvent } from '../types.js';
import type { ConditionRule, EffectCtx, EffectRule, RuleFamily, TriggerRule } from './types.js';
import { subtypeKind, subtypeWord } from '../subtypes.js';

// ---------------------------------------------------------------------------------------------------------------
// Shared vocabulary guards (the same discipline as src/cards/rules/composition.ts, which cannot export them)
// ---------------------------------------------------------------------------------------------------------------

const TYPE_WORDS = ['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'permanent', 'battle'];
const COLOR_WORDS = ['white', 'blue', 'black', 'red', 'green'];
/** Every lower-case word the built-in filter / target parsers give a meaning to; anything else makes a rule decline. */
const FILTER_WORDS = new Set<string>([
  ...TYPE_WORDS, ...TYPE_WORDS.map(t => t + 's'), ...TYPE_WORDS.map(t => 'non' + t), ...TYPE_WORDS.map(t => 'non' + t + 's'),
  ...COLOR_WORDS, ...COLOR_WORDS.map(c => 'non' + c), 'colorless', 'tapped', 'untapped', 'token', 'tokens', 'nontoken',
  'attacking', 'blocking', 'basic', 'nonbasic', 'card', 'cards', 'a', 'an', 'or', 'other', 'another', 'each',
  'with', 'without', 'power', 'toughness', 'mana', 'value', 'less', 'greater', 'legendary', 'nonlegendary', 'snow',
  'flying', 'deathtouch', 'lifelink', 'trample', 'haste', 'menace', 'reach', 'vigilance', 'first', 'strike', 'double',
  'hexproof', 'indestructible', 'historic', 'multicolored', 'monocolored', 'kicked', 'transformed', 'enchanted', 'equipped', 'modified',
]);
/** A capitalised word that names a subtype of the pool ("Dragons", "Wizards", "Aura"); never "Target" or "Up". */
const isSubtype = (w: string): boolean => /^[A-Z]/.test(w) && subtypeWord(w) !== null;
const filterWordOk = (w: string): boolean =>
  FILTER_WORDS.has(w.toLowerCase()) || isSubtype(w) || /^\d+$/.test(w) || /^\d+\/\d+$/.test(w) || (/^non-/i.test(w) && subtypeWord(w.slice(4)) !== null);

/** The subtypes the text's capitalised words name, in the vocabulary's spelling — the only ones a sub-parse of it may carry. */
function subtypeWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[A-Z][a-z]+/g) ?? []) { const sub = subtypeWord(w); if (sub) out.add(sub); }
  return out;
}
/** A sub-parse that minted a subtype the text does not name is declined, belt and braces (composition.md §8). */
function garbageSubtypes(v: unknown, allowed: Set<string>): boolean {
  if (Array.isArray(v)) return v.some(x => garbageSubtypes(x, allowed));
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.subtypes) && o.subtypes.some(t => typeof t === 'string' && !allowed.has(t))) return true;
  return Object.values(o).some(x => garbageSubtypes(x, allowed));
}

/** "Dragons you control" → "Dragon you control": the vocabulary's own spelling for every capitalised subtype word. */
const singularWords = (desc: string): string => desc.split(/\s+/).map(w => (/^[A-Z]/.test(w) ? subtypeWord(w) ?? w : w)).join(' ');

/** A filter description whose every word the built-in filter parser understands ("nonlegendary creature", "Dragon"). */
function safeFilter(desc: string, ctx: EffectCtx): Filter | null {
  const body = singularWords(desc.trim().replace(/,/g, ' ').replace(/\bcards?$/i, '').trim());
  if (!body) return {};
  for (const w of body.split(/\s+/)) if (!filterWordOk(w)) return null;
  const f = ctx.parseFilterWords(body);
  if (!f || garbageSubtypes(f, subtypeWords(desc))) return null;
  // the built-in filter is the AND of an any-of type list with the other words, so an "or" list is only claimable
  // when it names types (and colours) alone — "creature, Vehicle, or nonbasic land" is not this family's to read
  if (/\bor\b/i.test(body) && Object.keys(f).some(k => k !== 'types' && k !== 'colors')) return null;
  return f;
}

/** The target phrase shape the rules below splice in ("target creature", "up to two target creatures you control"). */
const TGT = "((?:up to (?:one|two|three|four|X) |two |three |any number of )?(?:another |other )?target [^.,]+?)";

/**
 * The built-in target parser, guarded: every word must be one the shared vocabulary knows, "any number of target …"
 * is understood, and a bare subtype ("target Aura") names the permanent type it belongs to.
 */
function target(phrase: string, ctx: EffectCtx): TargetSpec | null {
  let p = phrase.trim().replace(/,/g, '').replace(/\band\/or\b/gi, 'or');
  p = p.replace(/\b(artifacts|creatures|lands|enchantments|permanents|planeswalkers)\b/gi, w => w.slice(0, -1));
  let anyNumber = false;
  if (/^any number of target /i.test(p)) { anyNumber = true; p = p.replace(/^any number of /i, ''); }
  // "target nonland permanent you don't control with mana value 4 or less": the built-in parser wants the controller last
  const mid = p.match(/^(.+?) (you control|an opponent controls|you don't control) (with .+)$/i);
  if (mid) p = `${mid[1]} ${mid[3]} ${mid[2]}`;
  // the built-in target parser's crude de-plural turns "less" into "les", so a numeric tail is parsed apart and merged
  let mvX: 'X' | undefined; let tailFilter: Filter | null = null;
  const mv = p.match(/^(.+?) with mana value X or less( you control| an opponent controls| you don't control)?$/i);
  if (mv) { p = mv[1] + (mv[2] ?? ''); mvX = 'X'; }
  const tail = p.match(/^(.+?) (with (?:mana value|power|toughness) \d+ or (?:less|greater))( you control| an opponent controls| you don't control)?$/i);
  if (tail) { p = tail[1] + (tail[3] ?? ''); tailFilter = ctx.parseFilterWords(`creature ${tail[2]}`); if (!tailFilter) return null; delete tailFilter.types; }
  const words = p.replace(/^(up to (?:one|two|three|four|X) |two |three |another |other )+/i, '').replace(/^target /i, '')
    .replace(/ (you control|an opponent controls|you don't control)$/i, '');
  for (const w of words.split(/\s+/)) {
    if (filterWordOk(w)) continue;
    if (/^(player|opponent|planeswalker|any|target|from|in|graveyard)$/i.test(w)) continue;
    return null;
  }
  let spec = ctx.parseTarget(p);
  if (!spec) {
    // "target Aura", "another target Dragon": a bare subtype names the permanent type it belongs to
    const bare = p.match(/^((?:up to (?:one|two|three|four) |two |three )?)((?:another |other )?)target ([A-Z][a-z]+)( you control| an opponent controls| you don't control)?$/);
    const sub = bare ? subtypeWord(bare[3]) : null; const kind = sub ? subtypeKind(sub) : null;
    if (!bare || !sub || !kind || kind === 'Spell' || kind === 'Battle') return null;
    spec = ctx.parseTarget(`${bare[1]}${bare[2]}target ${kind.toLowerCase()}${bare[4] ?? ''}`);
    if (!spec) return null;
    spec.filter = { ...(spec.filter ?? {}), subtypes: [sub] };
  }
  if (/\bor\b/i.test(words) && spec.filter && Object.keys(spec.filter).some(k => k !== 'types' && k !== 'colors' && k !== 'other')) return null;
  if (/\bor\b/i.test(words) && spec.filter?.types && spec.filter.types.length > 1 && ['creature', 'artifact', 'enchantment', 'land'].includes(spec.kind)) spec.kind = 'permanent';
  if (mvX !== undefined) spec.filter = { ...(spec.filter ?? {}), mvLE: mvX };
  if (tailFilter) spec.filter = { ...(spec.filter ?? {}), ...tailFilter };
  if (anyNumber) { spec.count = 99; spec.optional = true; }
  if (garbageSubtypes(spec, subtypeWords(phrase))) return null;
  // "target noncreature artifact": the built-in target parser reads the kind off the first type word it sees, so it
  // answers `kind: 'creature'` with `notTypes: ['Creature']` — a spec nothing can ever satisfy. Decline it rather
  // than hand the engine a requirement with no legal options.
  const kindType = spec.kind.charAt(0).toUpperCase() + spec.kind.slice(1);
  if (spec.filter?.notTypes?.some(t => t === kindType)) return null;
  return spec;
}

// ---------------------------------------------------------------------------------------------------------------
// Durations and metrics
// ---------------------------------------------------------------------------------------------------------------

type Duration = 'permanent' | 'eot' | 'end-of-combat' | 'your-next-turn'
  | 'while-source-on-battlefield' | 'while-you-control-source' | 'while-source-tapped' | 'while-you-control-source-and-tapped' | 'while-counter';

/** The tail of a "for as long as …" clause → the duration the engine has for it, or null (the rule then declines). */
function forAsLongAs(tail: string): Duration | null {
  const t = tail.trim().toLowerCase().replace(/\.$/, '');
  if (t === 'you control ~') return 'while-you-control-source';
  if (t === '~ remains on the battlefield') return 'while-source-on-battlefield';
  if (t === '~ remains tapped') return 'while-source-tapped';
  if (t === 'you control ~ and ~ remains tapped' || t === '~ remains tapped and you control ~') return 'while-you-control-source-and-tapped';
  return null;
}

/** The metric a "the most / lowest <X>" or "more <X> than each other player" phrase names. */
function leaderMetric(phrase: string, ctx: EffectCtx): { of: 'life' | 'cards-in-hand' | 'permanents'; filter?: Filter } | null {
  const t = phrase.trim().replace(/\.$/, '');
  if (/^life( total)?$/i.test(t)) return { of: 'life' };
  if (/^cards in( their)? hand$/i.test(t)) return { of: 'cards-in-hand' };
  const f = safeFilter(t, ctx);
  if (!f || !Object.keys(f).length) return null;
  return { of: 'permanents', filter: f };
}

// ---------------------------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------------------------

/** "gain control of <target> …" with a duration, plus the optional Threaten tail. */
const gain = (spec: TargetSpec, duration: Duration, extra: { untap?: boolean; haste?: boolean } = {}): Effect =>
  ({ op: 'control-gain', target: spec, ...(duration === 'permanent' ? {} : { duration }), ...extra });

const effects: EffectRule[] = [
  // ---- durations -------------------------------------------------------------------------------------------
  // "Gain control of target creature for as long as ~ remains on the battlefield." (Sower of Temptation, Mind Flayer,
  // Master Thief, Aladdin, Dragonlord Silumgar, Helm of Possession, Willbreaker, Roil Elemental, Infernal Denizen)
  { re: new RegExp(`^gain control of ${TGT} for as long as (.+)$`, 'i'), make: (m, ctx) => {
    const d = forAsLongAs(m[2]); const t = d && target(m[1], ctx);
    return d && t ? gain(t, d) : null;
  } },
  // "Gain control of target artifact until the end of your next turn." (Treasure Nabber, Stilt-Man)
  { re: new RegExp(`^gain control of ${TGT} until the end of your next turn$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); return t ? gain(t, 'your-next-turn') : null;
  } },
  // "…until end of combat" (Tahngarth, First Mate)
  { re: new RegExp(`^gain control of ${TGT} until end of combat$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); return t ? gain(t, 'end-of-combat') : null;
  } },
  // "Gain control of enchanted land until end of turn." (Wellspring, Frenzied Fugue) — the Aura's own host, no target
  { re: /^gain control of (enchanted (?:creature|permanent|land|artifact|enchantment|planeswalker))( until end of turn| for as long as .+)?$/i, make: (m) => {
    const tail = (m[2] ?? '').trim();
    const d: Duration | null = tail === '' ? 'permanent' : /^until end of turn$/i.test(tail) ? 'eot' : forAsLongAs(tail.replace(/^for as long as /i, ''));
    return d ? { op: 'control-gain', target: 'enchanted', ...(d === 'permanent' ? {} : { duration: d }) } : null;
  } },

  // ---- the Threaten package --------------------------------------------------------------------------------
  // "Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn."
  // The built-in table knows exactly one spelling of this ("untap that creature|it", singular "it gains haste"); the
  // pool also prints "Untap it", "Untap them", "Untap those creatures", "They gain haste" and richer target phrases.
  { re: new RegExp(`^gain control of ${TGT} until end of turn\\. untap (?:it|them|that creature|that permanent|those creatures|those permanents)(?:\\. (?:it|they|that creature|those creatures) gains? haste until end of turn)?$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); if (!t) return null;
    return gain(t, 'eot', { untap: true, ...(/haste/i.test(m[0]) ? { haste: true } : {}) });
  } },
  // "Untap target creature and gain control of it until end of turn. That creature gains haste until end of turn."
  // (Threaten, Blind with Anger, Overtaker, Goatnapper, Temporary Insanity, Flash Conscription)
  { re: new RegExp(`^untap ${TGT} and gain control of it until end of turn(?:\\. (?:it|that creature) gains haste until end of turn)?$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); if (!t) return null;
    return gain(t, 'eot', { untap: true, ...(/haste/i.test(m[0]) ? { haste: true } : {}) });
  } },

  // ---- a gainer who is not the item's controller ------------------------------------------------------------
  // "Target opponent gains control of ~." (Jinxed Idol, Sleeper Agent, Witch Engine, Humble Defector, Measure of
  // Wickedness, Treacherous Pit-Dweller, Goblin Cadets). The composition core's `scoped` is what asks for the
  // opponent on cast — `legal.ts` emits a player requirement only for the ops it knows by name (control.md §"who").
  { re: /^target (opponent|player) gains control of ~( until end of turn)?$/i, make: (m) => ({
    op: 'scoped', who: m[1].toLowerCase() === 'opponent' ? 'target-opponent' : 'target-player',
    do: [{ op: 'control-gain', target: 'self', ...(m[2] ? { duration: 'eot' as const } : {}) }],
  }) },
  // "Target player gains control of target permanent you control." (Donate, Bazaar Trader, Discerning Financier)
  { re: new RegExp(`^target (opponent|player) gains control of ${TGT}( until end of turn)?$`, 'i'), make: (m, ctx) => {
    const t = target(m[2], ctx); if (!t) return null;
    return { op: 'scoped', who: m[1].toLowerCase() === 'opponent' ? 'target-opponent' : 'target-player', do: [gain(t, m[3] ? 'eot' : 'permanent')] };
  } },
  // "That player gains control of ~." (Risky Move, Crag Saurian, Emberwilde Djinn, Drooling Ogre, Kain)
  { re: /^that player gains control of ~$/i, make: () => ({ op: 'control-gain', target: 'self', who: 'that-player' }) },
  // "…the player with the most life gains control of ~." (Wild Dogs, Ghazbán Ogre, Wild Mammoth, Sokenzan Renegade,
  // Thoughtbound Primoc, Loxodon Peacekeeper). A tie means nobody: CR 104.2 knows no such player.
  { re: /^the player (?:with|who has|who controls) the (most|highest|lowest|fewest|least) (.+?) gains control of ~$/i, make: (m, ctx) => {
    const met = leaderMetric(m[2], ctx); if (!met) return null;
    return { op: 'control-gain', target: 'self', who: 'leader', leader: { ...met, extreme: /^(most|highest)$/i.test(m[1]) ? 'most' : 'least' } };
  } },

  // ---- groups ----------------------------------------------------------------------------------------------
  // "Gain control of all Dragons" (Karrthus), "Gain control of all artifacts your opponents control until end of
  // turn" (Broadcast Takeover). A scope that names a TARGET player is declined: the group form takes no targets.
  { re: /^gain control of all ([^.]+?)( you control| your opponents control| an opponent controls)?( until end of turn| until the end of your next turn| for as long as .+)?$/i, make: (m, ctx) => {
    const f = safeFilter(m[1], ctx); if (!f || !Object.keys(f).length) return null;
    const scope = (m[2] ?? '').trim().toLowerCase();
    const who = scope === '' ? undefined : scope === 'you control' ? 'you' as const : 'each-opponent' as const;
    const tail = (m[3] ?? '').trim();
    const d: Duration | null = tail === '' ? 'permanent' : /^until end of turn$/i.test(tail) ? 'eot'
      : /^until the end of your next turn$/i.test(tail) ? 'your-next-turn' : forAsLongAs(tail.replace(/^for as long as /i, ''));
    if (!d) return null;
    return { op: 'control-gain', all: { all: f, ...(who ? { who } : {}) }, ...(d === 'permanent' ? {} : { duration: d }) };
  } },

  // ---- giving everything back --------------------------------------------------------------------------------
  // "Each player gains control of all creatures they own." (Homeward Path, Trostani Discordant, Alicia Masters,
  // Brooding Saurian's "all nontoken permanents they own", The Fall of Lord Konda)
  { re: /^each player gains control of all (.+?) they own$/i, make: (m, ctx) => {
    const f = safeFilter(m[1], ctx); if (!f) return null;
    return { op: 'control-return', ...(Object.keys(f).length ? { filter: f } : {}) };
  } },

  // ---- exchanges ---------------------------------------------------------------------------------------------
  // "Exchange control of two target permanents that share a card type." (Shifting Loyalties, Role Reversal, Bilbo,
  // The Trickster-God's Heist, Djinn of Infinite Deceits). The "share a card type" restriction is a targeting
  // restriction the engine cannot enforce as targets are chosen, so it is checked as the effect resolves — see the doc.
  { re: /^exchange control of two target ([^.]+?)(?: that share an? (?:card|permanent) type)?$/i, make: (m, ctx) => {
    const t = target(`two target ${m[1]}`, ctx); if (!t) return null;
    t.count = 2;
    return { op: 'control-exchange', target: t, ...(/share an? (?:card|permanent) type/i.test(m[0]) ? { share: 'card-type' as const } : {}) };
  } },
  // "Exchange control of ~ and target creature an opponent controls." (Gilded Drake, Conjured Currency)
  { re: new RegExp(`^exchange control of ~ and ${TGT}$`, 'i'), make: (m, ctx) => {
    const t = target(m[1], ctx); return t ? { op: 'control-exchange', target: t, self: true } : null;
  } },
];

const conditions: ConditionRule[] = [
  // "if a player has more life than each other player" / "if a player controls more creatures than each other player"
  // — the intervening-if of Wild Dogs, Ghazbán Ogre, Wild Mammoth, Sokenzan Renegade and Thoughtbound Primoc.
  { name: 'control-leader', make: (text): Condition | null => {
    const m = text.trim().replace(/\.$/, '').match(/^(?:if )?a player (?:has|controls) more (.+?) than each other player$/i);
    if (!m) return null;
    const met = leaderMetric(m[1], NO_CTX); if (!met) return null;
    return { kind: 'control-leader', ...met, extreme: 'most' };
  } },
];

const triggers: TriggerRule[] = [
  // "When you gain control of ~ from another player, …" (Risky Move) — raised by this family's own control changes.
  { name: 'control-gained', make: (head): TriggerEvent | null =>
    /^when(?:ever)? (?:you|a player) gains? control of ~(?: from another player)?$/i.test(head.trim().replace(/[,.]$/, ''))
      ? { on: 'control-gained', self: true, who: /^when(?:ever)? you\b/i.test(head.trim()) ? 'you' : 'any' }
      : null },
];

/**
 * A condition rule is handed only the text — no `EffectCtx` — so `leaderMetric`'s filter parsing gets this minimal
 * stand-in: the metric phrases a condition can name ("life", "cards in hand", "creatures", "Wizards") are all either
 * one of the two player metrics or a single type / subtype word, which is exactly what this covers.
 */
const NO_CTX = {
  parseFilterWords: (desc: string): Filter | null => {
    const w = desc.trim();
    const type = TYPE_WORDS.find(t => t === w.toLowerCase() || t + 's' === w.toLowerCase());
    if (type) return { types: [(type[0].toUpperCase() + type.slice(1)) as Filter['types'] extends (infer T)[] | undefined ? T : never] };
    const sub = subtypeWord(w);
    return sub ? { subtypes: [sub] } : null;
  },
} as unknown as EffectCtx;

const control: RuleFamily = { name: 'control', effects, conditions, triggers };
export default control;
