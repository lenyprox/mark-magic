// One `AbilityShape` for both sides of the Forge cross-check (docs/plans/forge-oracle.md): the structural facts a
// judge rejects scripts for — the trigger event, whether an effect targets and how many, "up to", "you may",
// "unless … pays", which token, the literal magnitudes, how many modes — read off Forge's parameter maps
// (`forgeShapes`) and off this engine's `CardDef` (`ourShapes`). src/cards/forge/compare.ts aligns and diffs them.
//
// Every table here is DELIBERATELY INCOMPLETE in one direction: a Forge trigger mode or keyword spelling that is not
// in its table yields nothing on the Forge side (`kinds: []`, an unmapped keyword kept verbatim and never compared),
// so a gap in the table can only hide a disagreement, never invent one. A finding is a claim to verify, never a
// verdict (Forge is sometimes wrong and its encoding is sometimes just different).
import type { ForgeAbility, ForgeEffect, ForgeFace, ForgeToken } from './loader.js';
import { forgeColors, splitForgeTypes } from './loader.js';
import type { Ability, AltCost, AsEnters, CardDef, CostModifier, Effect, Keyword, ManaCost, TriggerEvent } from '../types.js';
import { KEYWORDS, TARGET_KINDS } from '../schema-core.js';
import { TARGET_KINDS as FAMILY_TARGET_KINDS } from '../../engine/ops/_registry.js';

export type ShapeClass = 'keyword' | 'activated' | 'spell' | 'triggered' | 'static' | 'replacement';

/** A token an effect creates: `pt` as printed (`1/1`, or the star form), colours as WUBRG letters; `name` is recorded, not compared. */
export interface TokenShape { name: string | null; pt: string | null; colors: string[]; types: string[]; subtypes: string[]; keywords: string[] }
/** One targeting effect: "up to" (`optional`) and the printed maximum (`null` = one, or not a literal). */
export interface TargetShape { optional: boolean; max: number | null }

export interface AbilityShape {
  cls: ShapeClass;
  /** Normalised description / oracle line: lowercase, the card's name → ~, reminder text and punctuation stripped. Empty when the side has none. */
  text: string;
  /** Triggered only: this engine's `on` kinds (Forge's mode mapped through `forgeTriggerKinds`; empty = unmapped). */
  trigger?: { kinds: string[] };
  /** Effect names in chain order (Forge api names / this engine's ops) — recorded for the reader, not compared. */
  effects: string[];
  targets: TargetShape[];
  /** "You may": Forge `OptionalDecider$`, `UnlessSwitched$` or a costed sub-ability; ours a `may` / `optional-then` / `optional-pay` at the top (or directly inside a `reflexive` / `scoped`) or `TriggeredAbility.optional`. */
  optional: boolean;
  /** "unless … pays": Forge `UnlessCost$`; ours `unless-pays` / `counter.unlessPay` / `sacrifice-unless-pay`. */
  unless: boolean;
  tokens: TokenShape[];
  /** Literal integers of the magnitude parameters, as a set (see `FORGE_MAGNITUDE_KEYS` / `ourMagnitudes`). */
  magnitudes: number[];
  /** `Charm` choices / `choose-mode` modes, or null when the ability is not modal. */
  modes: number | null;
  /** Keyword shapes only: the keyword ids (this engine's, after `FORGE_KEYWORD_ALIASES`; an unmapped Forge spelling verbatim, lowercased). */
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Lowercase, the card's self-reference → ~ (Forge's CARDNAME / NICKNAME; Scryfall's "this spell" / "this creature" /
 * … in a spell's whole-face text, which the parser rewrites to ~ only in the abilities it cuts out), reminder text
 * `(…)` and punctuation stripped, whitespace collapsed: the alignment key.
 */
export function normalizeShapeText(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/\b(?:CARDNAME|NICKNAME)\b/g, '~').replace(/\([^)]*\)/g, ' ').toLowerCase()
    .replace(/\bthis (?:spell|creature|permanent|land|artifact|enchantment|aura|equipment|vehicle|planeswalker|saga|card|token)\b/g, '~')
    .replace(/[^a-z0-9~\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Forge → shapes
// ---------------------------------------------------------------------------

/**
 * Forge keyword spellings (the part before the first `:`, case-insensitive) → this engine's keyword ids, plus the
 * synthetic ids `ourShapes` renders for the fields that are keywords in print but not in `CardDef.keywords`
 * (`kicker`, `cycling`, the alt-cost ids, `as-enters` for every enters-the-battlefield replacement). Anything not
 * here is kept verbatim on the Forge side and never compared (`KNOWN_KEYWORD_IDS`).
 */
export const FORGE_KEYWORD_ALIASES: Record<string, string> = {
  'flying': 'flying', 'first strike': 'first strike', 'double strike': 'double strike', 'deathtouch': 'deathtouch', 'lifelink': 'lifelink', 'trample': 'trample',
  'haste': 'haste', 'vigilance': 'vigilance', 'reach': 'reach', 'defender': 'defender', 'flash': 'flash', 'hexproof': 'hexproof', 'indestructible': 'indestructible',
  'menace': 'menace', 'shroud': 'shroud', 'protection': 'protection', 'prowess': 'prowess', 'ward': 'ward', 'fear': 'fear', 'intimidate': 'intimidate', 'skulk': 'skulk',
  'shadow': 'shadow', 'horsemanship': 'horsemanship', 'flanking': 'flanking', 'exalted': 'exalted', 'infect': 'infect', 'wither': 'wither', 'toxic': 'toxic',
  'bushido': 'bushido', 'landwalk': 'landwalk', 'rampage': 'rampage', 'firebending': 'firebending',
  "cardname can't be blocked.": 'unblockable', "cardname can't block.": 'cant block', "cardname can't attack.": 'cant attack',
  // printed keywords this engine keeps outside `CardDef.keywords`
  'kicker': 'kicker', 'multikicker': 'kicker', 'cycling': 'cycling', 'typecycling': 'cycling', 'flashback': 'flashback', 'escape': 'escape', 'buyback': 'buyback',
  'dash': 'dash', 'evoke': 'evoke', 'morph': 'morph', 'megamorph': 'morph', 'disguise': 'morph', 'warp': 'warp', 'impending': 'impending', 'jump-start': 'jump-start',
  'storm': 'storm', 'cascade': 'cascade', 'rebound': 'rebound', 'dredge': 'dredge', 'delve': 'delve', 'convoke': 'convoke', 'improvise': 'improvise',
  'etbcounter': 'as-enters', 'etbreplacement': 'as-enters', 'cardname enters the battlefield tapped.': 'as-enters', 'cardname enters tapped.': 'as-enters',
  // printed keywords whose whole meaning on this side is an as-enters counter (the upkeep trigger of fading / vanishing is synthesised beside it)
  'bloodthirst': 'as-enters', 'vanishing': 'as-enters', 'fading': 'as-enters', 'modular': 'as-enters', 'unleash': 'as-enters', 'devour': 'as-enters', 'graft': 'as-enters', 'sunburst': 'as-enters',
  'daybound': 'as-enters', 'nightbound': 'as-enters',   // this side: a `day-night-enters` as-enters field beside the static
};

/** The ids `ourShapes` can emit: the keyword-set comparison is restricted to these on the Forge side. */
export const KNOWN_KEYWORD_IDS: ReadonlySet<string> = new Set<string>([...KEYWORDS, ...new Set(Object.values(FORGE_KEYWORD_ALIASES))]);

/** `K:Protection from red` → 'protection'; `K:Cycling:2` → 'cycling'; an unmapped spelling → itself, lowercased. */
export function forgeKeywordId(line: string): string {
  const head = line.split(':')[0].trim().toLowerCase();
  const hit = FORGE_KEYWORD_ALIASES[head] ?? FORGE_KEYWORD_ALIASES[line.trim().toLowerCase()];
  if (hit) return hit;
  if (head.startsWith('protection')) return 'protection';   // `Protection from red`, `Protection:Card.Red:red`
  if (head.startsWith('hexproof')) return 'hexproof';       // `Hexproof:Card.Red:red` (hexproof from)
  return head;
}

/**
 * Forge trigger mode + qualifiers → this engine's `on` kinds (`CoreTriggerEvent` plus the registered family kinds).
 * Seeded from the plan's mode histogram against the kinds actually registered; a mode not here yields `[]` and can
 * never produce a `trigger-kind` finding (Cycled, Explores, ChaosEnsues, … have no registered kind).
 */
export function forgeTriggerKinds(params: Record<string, string>): string[] {
  const mode = params.Mode ?? '';
  const valid = params.ValidCard ?? '';
  const origin = params.Origin ?? '';
  const dest = params.Destination ?? '';
  const target = params.ValidTarget ?? '';
  switch (mode) {
    case 'ChangesZone':
      if (origin === 'Battlefield' && dest === 'Graveyard') return ['dies'];
      if (origin === 'Battlefield' && dest === 'Any') return ['ltb'];
      if (origin === 'Battlefield' && /^Graveyard,|,Graveyard/.test(dest)) return ['dies', 'ltb'];
      if (origin === 'Graveyard' && dest === 'Any') return ['leaves-graveyard'];
      if (dest === 'Battlefield' && /^Land\b/.test(valid)) return ['landfall'];
      if (dest === 'Battlefield') return ['etb'];
      return [];
    case 'Phase': {
      const phase = params.Phase ?? '';
      if (phase === 'Upkeep') return ['upkeep'];
      if (/^End ?[Oo]f ?Turn$/.test(phase) || phase === 'EndOfTurn') return ['end-step'];
      if (phase === 'Draw') return ['draw-step'];
      if (phase === 'BeginCombat') return ['combat-begin'];
      if (phase === 'Main1') return ['first-main-phase'];
      return [];
    }
    case 'Attacks': return ['attacks'];
    case 'AttackersDeclared': return ['you-attack'];
    case 'Blocks': return ['blocks'];
    case 'AttackerBlocked': case 'AttackerBlockedByCreature': return ['becomes-blocked'];
    case 'DamageDone': case 'DamageDoneOnce':
      if (/\b(Player|Opponent|You)\b/.test(target)) return params.CombatDamage === 'True' ? ['combat-damage-player'] : ['deals-damage'];
      // `ValidTarget$ Card.Self` is "~ is dealt damage" — a different event, unmapped
      if (/Card\.Self/.test(target) || !params.ValidSource) return [];
      return ['deals-damage'];
    case 'SpellCast': return params.TargetsValid !== undefined ? ['cast', 'targeted'] : ['cast'];   // heroic: whenever you cast a spell that targets ~
    case 'LandPlayed': return ['landfall'];
    case 'Drawn': return ['draw'];
    case 'TurnFaceUp': return ['turned-face-up'];
    case 'Sacrificed': return ['sacrifice'];
    case 'Taps': return ['tapped'];
    case 'BecomesTarget': return ['targeted'];
    case 'Discarded': return ['discard'];
    case 'LifeGained': return ['life-gain'];
    case 'LifeLost': return /Opponent/.test(params.ValidPlayer ?? '') ? ['life-loss-opponent'] : [];
    case 'Transformed': return ['transforms'];
    case 'RolledDie': return ['die-rolled'];
    case 'RolledDieOnce': return ['dice-rolled'];
    case 'FlippedCoin': return ['coin-flipped'];
    case 'Exploited': return ['exploits'];
    case 'BecomeMonstrous': return ['monstrous'];
    case 'ChangesController': return ['control-gained'];
    case 'Clashed': return ['clash'];
    case 'Exerted': return ['exerts'];
    case 'DayTimeChanges': return ['day-night'];
    case 'CounterAdded': case 'CounterAddedOnce': return params.CounterType === 'LORE' ? ['lore-counter-put'] : [];
    default: return [];
  }
}

/** The Forge parameters whose literal integer value is a magnitude this engine also states (`ourMagnitudes`). */
export const FORGE_MAGNITUDE_KEYS = ['NumCards', 'NumDmg', 'NumCounters', 'CounterNum', 'TokenAmount', 'LifeAmount', 'Amount', 'NumAtt', 'NumDef', 'ScryNum', 'DigNum', 'ChangeNum', 'Num', 'Adapt', 'Support'] as const;

/** The chain flattened: every effect, the modes of a `Charm` included. */
function allForgeEffects(chain: ForgeEffect[]): ForgeEffect[] {
  const out: ForgeEffect[] = [];
  const walk = (list: ForgeEffect[]) => { for (const e of list) { out.push(e); for (const m of e.modes ?? []) walk(m); } };
  walk(chain);
  return out;
}

const literalInt = (v: string | undefined): number | null => v !== undefined && /^[+-]?\d+$/.test(v.trim()) ? Number(v.trim()) : null;

function tokenShapeOf(t: ForgeToken): TokenShape {
  return { name: t.name, pt: t.pt, colors: [...t.colors].sort(), types: [...t.types].sort(), subtypes: [...t.subtypes].sort(), keywords: t.keywords.map(forgeKeywordId).sort() };
}

/** Which mode texts `ABILITY` stands for: the `SpellDescription$` of each `Charm` choice, so a modal line aligns with ours. */
function modeTexts(chain: ForgeEffect[]): string[] {
  const out: string[] = [];
  for (const e of allForgeEffects(chain)) for (const m of e.modes ?? []) { const d = m.find(x => x.params.SpellDescription)?.params.SpellDescription; if (d) out.push(d); }
  return out;
}

function forgeAbilityShape(a: ForgeAbility): AbilityShape {
  const effects = allForgeEffects(a.chain);
  const targets: TargetShape[] = [];
  const magnitudes = new Set<number>();
  const tokens: TokenShape[] = [];
  // `UnlessCost$ X | UnlessSwitched$ True` is Forge's "you may pay X. If you do, …" — an optional payment, not an unless clause
  const switched = (p: Record<string, string>) => p.UnlessCost !== undefined && p.UnlessSwitched === 'True';
  let unless = a.params.UnlessCost !== undefined && !switched(a.params);
  let optional = a.params.OptionalDecider !== undefined || switched(a.params);
  let modes: number | null = null;
  effects.forEach((e, i) => {
    if (e.params.ValidTgts !== undefined) targets.push({ optional: e.params.TargetMin === '0', max: normMax(literalInt(e.params.TargetMax)) });
    if (e.params.UnlessCost !== undefined && !switched(e.params)) unless = true;
    if (e.params.OptionalDecider !== undefined || switched(e.params)) optional = true;
    // a costed sub-ability inside a chain (`SVar:X:AB$ Draw | Cost$ Discard<1/Card>`) is "you may [pay]. If you do, …";
    // an A line's own `Cost$` is the ability's cost (or a spell's additional cost). `Optional$ True` on an effect is
    // effect-internal ("you may put one of them into your hand"), like this side's `dig.optional`: neither counts
    if (e.params.Cost !== undefined && (i > 0 || a.cls === 'triggered')) optional = true;
    if (e.api !== 'Mana') for (const k of FORGE_MAGNITUDE_KEYS) { const n = literalInt(e.params[k]); if (n !== null && !IMPLICIT.has(n)) magnitudes.add(n); }
    if (e.modes && modes === null) modes = normModes(e.modes.length);
    for (const t of e.tokens ?? []) tokens.push(tokenShapeOf(t));
    if (e.api === 'Investigate') tokens.push({ name: 'Clue', pt: null, colors: [], types: ['Artifact'], subtypes: ['Clue'], keywords: [] });   // a Clue without a TokenScript$
  });
  const description = a.description === null ? '' : a.description.replace(/\bABILITY\b/, modeTexts(a.chain).join(' '));
  const shape: AbilityShape = { cls: a.cls, text: normalizeShapeText(description), effects: effects.map(e => e.api), targets, optional, unless, tokens, magnitudes: [...magnitudes].sort((x, y) => x - y), modes, keywords: [] };
  if (a.cls === 'triggered') shape.trigger = { kinds: forgeTriggerKinds(a.params) };
  return shape;
}

/** A printed maximum of one is the default on both sides ("target creature" = `max: null`). */
const normMax = (n: number | null): number | null => (n === null || n <= 1 ? null : n);
/** A one-mode "choice" is not modal on either side (the parser folds some sentences into a one-mode `choose-mode`). */
const normModes = (n: number | null): number | null => (n === null || n <= 1 ? null : n);
/** `0` and `1` are the implicit defaults Forge leaves out (`NumCards$` absent = one card, `NumAtt$` absent = +0): never a magnitude. */
const IMPLICIT = new Set([0, 1]);

/**
 * The shapes of one Forge face: a keyword shape per `K:` line, then its abilities. A `T:` marked `Secondary$ True`
 * (Forge's second line of one printed "attacks or blocks" trigger) and any ability with the same class and text as
 * an earlier one merge into it (trigger kinds unioned) — one printed line is one ability on this side.
 */
export function forgeShapes(face: ForgeFace): AbilityShape[] {
  const out: AbilityShape[] = face.keywords.map(k => keywordShape(forgeKeywordId(k)));
  let last: AbilityShape | null = null;
  for (const a of face.abilities) {
    const kw = printedKeywordOf(a);
    if (kw) { out.push(keywordShape(kw)); continue; }
    const s = forgeAbilityShape(a);
    const twin = a.params.Secondary === 'True' && last && last.cls === 'triggered' ? last
      : s.text ? out.find(o => o.cls === s.cls && o.text === s.text) ?? null : null;
    if (twin) { mergeInto(twin, s); continue; }
    out.push(s); last = s;
  }
  return out;
}

/**
 * A Forge `S:` / `R:` line that is a keyword (or a keyword-like field) in print and on this side: `CantBlock` on
 * self = "~ can't block", `CantBlockBy` on self with no other qualifier = "~ can't be blocked", and an `R:Event$
 * Moved` onto the battlefield of the card itself = an as-enters replacement ("enters tapped", "enters with …").
 */
const PLAIN_KEYS = new Set(['Mode', 'ValidCard', 'ValidAttacker', 'ValidBlocker', 'Description', 'EffectZone', 'AffectedZone', 'Event', 'Destination', 'ReplaceWith', 'ActiveZones', 'Origin', 'Secondary']);
function printedKeywordOf(a: ForgeAbility): string | null {
  const p = a.params;
  const self = (v: string | undefined) => /^(Card|Creature)\.Self$/.test(v ?? '');
  // no qualifier beyond the mode, the card and the text ("can't attack unless defending player controls an Island" is not the bare keyword)
  const plain = Object.keys(p).every(k => PLAIN_KEYS.has(k));
  if (a.cls === 'static' && p.Mode === 'CantBlock' && self(p.ValidCard) && plain) return 'cant block';
  if (a.cls === 'static' && p.Mode === 'CantAttack' && self(p.ValidCard) && plain) return 'cant attack';
  if (a.cls === 'static' && p.Mode === 'CantBlockBy' && self(p.ValidAttacker) && (!p.ValidBlocker || p.ValidBlocker === 'Creature') && plain) return 'unblockable';
  if (a.cls === 'replacement' && p.Event === 'Moved' && p.Destination === 'Battlefield' && self(p.ValidCard)) return 'as-enters';
  return null;
}

function mergeInto(into: AbilityShape, from: AbilityShape): void {
  if (into.trigger && from.trigger) for (const k of from.trigger.kinds) if (!into.trigger.kinds.includes(k)) into.trigger.kinds.push(k);
  if (!into.targets.length) into.targets = from.targets;
  into.optional = into.optional || from.optional; into.unless = into.unless || from.unless;
  if (!into.tokens.length) into.tokens = from.tokens;
  if (!into.magnitudes.length) into.magnitudes = from.magnitudes;
  if (into.modes === null) into.modes = from.modes;
  if (!into.effects.length) into.effects = from.effects;
}

// ---------------------------------------------------------------------------
// CardDef → shapes
// ---------------------------------------------------------------------------

/** The face fields the shape reads — a `CardDef`, its `backFace`, or a script's `secondFace` (`ScriptFace`) all satisfy it. */
export interface ShapeFace {
  keywords?: Keyword[]; abilities?: Ability[]; altCosts?: AltCost[]; asEnters?: AsEnters[]; costModifiers?: CostModifier[]; subtypes?: string[];
  /** The face's oracle text: the modal bullets a `choose-mode` ability's `text` lacks, and the sentences `altCosts` / `costModifiers` claim. */
  oracleText?: string;
  kicker?: ManaCost; cycling?: ManaCost; entersTapped?: unknown; morph?: unknown; cascade?: boolean; storm?: boolean; rebound?: boolean; dredge?: number;
  graveyardReplacement?: 'exile' | 'shuffle';
}

const TARGET_KIND_SET: ReadonlySet<string> = new Set<string>([...TARGET_KINDS, 'multi']);
const isTargetKind = (k: string) => TARGET_KIND_SET.has(k) || k in FAMILY_TARGET_KINDS;
const MAY_OPS = new Set(['may', 'optional-then', 'optional-pay']);
/** Ops whose numbers are compared elsewhere (a token's P/T: token-shape) or that Forge states differently (`Mana` has `Amount$` for pips; `set-pt` / `animate` have `Power$`). */
const NO_MAGNITUDE_OPS = new Set(['add-mana', 'set-pt', 'set-life']);
const NO_PT_MAGNITUDE_OPS = new Set(['token', 'token-copy', 'animate']);
/** The string forms of a player target this engine uses instead of a `TargetSpec` (`who: 'target-player'`, `of: 'target-opponent'`). */
const STRING_TARGETS = new Set(['target-player', 'target-opponent']);
/** Alt-cost ids that are sentences in print ("you may pay 2 life rather than …"), not keywords Forge would write as `K:`. */
export const SENTENCE_ALT_COSTS: ReadonlySet<string> = new Set(['pitch', 'life', 'from-graveyard']);

/** Every object with an `op` at any depth of `v`, in document order. */
function effectsAtAnyDepth(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) { for (const x of v) effectsAtAnyDepth(x, out); return out; }
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if (typeof o.op === 'string') out.push(o);
  for (const x of Object.values(o)) effectsAtAnyDepth(x, out);
  return out;
}

/** Every `TargetSpec` at any depth (a `multi` spec counts once per member), `self: true` specs excluded; a string player target (`who: 'target-player'`) once per ability. */
function targetsAtAnyDepth(v: unknown, out: TargetShape[] = [], seen = { player: false }): TargetShape[] {
  if (Array.isArray(v)) { for (const x of v) targetsAtAnyDepth(x, out, seen); return out; }
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  for (const x of Object.values(o)) if (typeof x === 'string' && STRING_TARGETS.has(x) && !seen.player) { seen.player = true; out.push({ optional: false, max: null }); }
  if (typeof o.kind === 'string' && o.op === undefined && o.on === undefined && isTargetKind(o.kind)) {
    if (o.kind === 'multi') { for (const s of (o.specs as unknown[]) ?? []) targetsAtAnyDepth(s, out, seen); return out; }
    if (!o.self) out.push({ optional: o.optional === true, max: normMax(typeof o.count === 'number' ? o.count : null) });
    return out;
  }
  // "return target creature card from your graveyard": a targeted effect with no TargetSpec of its own
  if (o.op === 'return-from-graveyard' && o.target === true) out.push({ optional: o.optional === true, max: normMax(typeof o.count === 'number' ? o.count : null) });
  for (const x of Object.values(o)) targetsAtAnyDepth(x, out, seen);
  return out;
}

const numOr = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) ? v : null;

/** The literal integers of `amount` / `count` / `power` / `toughness` / `look` / `draw` / `discard` over every effect at any depth, 0 and 1 (the implicit defaults) left out (`NO_MAGNITUDE_OPS` excepted; a removed counter counts by its size). */
export function ourMagnitudes(effects: readonly Effect[] | undefined): number[] {
  const out = new Set<number>();
  for (const e of effectsAtAnyDepth(effects)) {
    const op = e.op as string;
    if (NO_MAGNITUDE_OPS.has(op)) continue;
    for (const k of ['amount', 'count', 'power', 'toughness', 'look', 'draw', 'discard'] as const) {
      if (NO_PT_MAGNITUDE_OPS.has(op) && (k === 'power' || k === 'toughness')) continue;
      const n = numOr(e[k]); if (n === null || IMPLICIT.has(n)) continue;
      out.add(op === 'counters' ? Math.abs(n) : n);
    }
  }
  return [...out].sort((x, y) => x - y);
}

function ourTokenShape(e: Record<string, unknown>): TokenShape {
  if (e.op === 'token-copy') return { name: null, pt: null, colors: [], types: [], subtypes: [], keywords: [] };
  const types = [...((e.types as string[]) ?? [])], subtypes = [...((e.subtypes as string[]) ?? [])];
  for (const [flag, sub] of [['treasure', 'Treasure'], ['clue', 'Clue'], ['food', 'Food']] as const) if (e[flag] && !subtypes.includes(sub)) { subtypes.push(sub); if (!types.includes('Artifact')) types.push('Artifact'); }
  // `spawn` is the "Sacrifice this token: Add {C}" ability; the printed subtypes (Eldrazi Spawn / Eldrazi Scion) are already on the op
  if (e.spawn && !types.includes('Creature')) types.push('Creature');
  // a noncreature token (Treasure, Clue, Food) has no P/T in print; the op's 0/0 is a placeholder
  const pt = types.includes('Creature') && typeof e.power === 'number' && typeof e.toughness === 'number' ? `${e.power}/${e.toughness}` : null;
  return { name: typeof e.name === 'string' ? e.name : null, pt, colors: [...((e.colors as string[]) ?? [])].sort(), types: types.sort(), subtypes: subtypes.sort(), keywords: [...((e.keywords as string[]) ?? [])].map(String).sort() };
}

function triggerKinds(ev: TriggerEvent): string[] {
  if (ev.on === 'or') return (ev.events as TriggerEvent[]).flatMap(triggerKinds);
  return [ev.on];
}

function ourAbilityShape(a: Ability, bullets: string[] = []): AbilityShape {
  const effects: Effect[] = a.kind === 'static' ? [] : a.effects ?? [];
  const all = effectsAtAnyDepth(effects);
  const tokens = all.filter(e => e.op === 'token' || e.op === 'token-copy').map(ourTokenShape);
  // an effect's own `optional` flag is "up to" / "fewer may be chosen", not "you may": it stays out of this
  // … or directly inside a reflexive ("When you do, you may …"), the one nesting Forge states on the ImmediateTrigger itself,
  // or directly inside a scoped ("Target opponent may draw a card", "that creature's controller may …": the parser rebinds
  // the player around the choice, CR 117.11; Forge states the same choice as `OptionalDecider$ <player>` on the effect)
  const isMay = (x: { op: string }) => MAY_OPS.has(x.op);
  const optional = (a.kind === 'triggered' && a.optional === true) || effects.some(e => isMay(e) || (e.op === 'reflexive' && e.effects.some(isMay)) || (e.op === 'scoped' && e.do.some(isMay)));
  const unless = all.some(e => e.op === 'unless-pays' || e.op === 'sacrifice-unless-pay' || (e.op === 'counter' && e.unlessPay !== undefined));
  const modal = all.find(e => e.op === 'choose-mode' || e.op === 'choose-modes');   // the core op, or piles-choices' repeated-modes op
  // a modal line's `text` is the head ("choose one —"); its bullets are separate oracle lines — appended so Forge's ABILITY expansion aligns
  const text = modal && !a.text.includes('•') && bullets.length ? `${a.text} ${bullets.join(' ')}` : a.text;
  const shape: AbilityShape = {
    // a static never targets: an aura's `enchant` spec is the Enchant keyword, a granted ability's target is the granted ability's
    cls: a.kind, text: normalizeShapeText(text), effects: effects.map(e => (e as { op: string }).op), targets: a.kind === 'static' ? [] : targetsAtAnyDepth(effects),
    optional, unless, tokens, magnitudes: ourMagnitudes(effects), modes: modal ? normModes(((modal.modes as unknown[]) ?? []).length) : null, keywords: [],
  };
  if (a.kind === 'triggered') shape.trigger = { kinds: [...new Set(triggerKinds(a.event))] };
  return shape;
}

const BASIC_LAND_TYPES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);
/** "~ can't block and can't be blocked." parses to an unconditional `self-keywords` static: keyword lines in print (and `K:` lines on Forge's side) — added to `ids`, and the static dropped. */
function unconditionalSelfKeywords(a: Ability, ids: Set<string>): boolean {
  if (a.kind !== 'static' || a.effect.kind !== 'self-keywords') return false;
  const e = a.effect as unknown as { keywords: string[]; cantBlock?: boolean };
  // nothing but the keyword list and the can't-block flag: a `mustAttack` / `blockOnlyFlying` / condition is a static of its own
  if (!Object.keys(e).every(k => k === 'kind' || k === 'keywords' || k === 'cantBlock') || (!e.keywords.length && !e.cantBlock)) return false;
  for (const k of e.keywords) ids.add(k);
  if (e.cantBlock) ids.add('cant block');
  return true;
}
const isIntrinsicMana = (a: Ability) => a.kind === 'activated' && a.manaAbility === true && a.cost.tap === true && Object.keys(a.cost).length === 1 && a.effects.length === 1 && a.effects[0].op === 'add-mana';

function keywordShape(id: string): AbilityShape { return { cls: 'keyword', text: '', effects: [], targets: [], optional: false, unless: false, tokens: [], magnitudes: [], modes: null, keywords: [id] }; }

/** The shapes of one face: keyword shapes (keywords + the parameter-bearing fields, as `FORGE_KEYWORD_ALIASES` names them), then the abilities. */
export function faceShapes(face: ShapeFace): AbilityShape[] {
  const ids = new Set<string>(face.keywords ?? []);
  if (face.kicker) ids.add('kicker');
  if (face.cycling) ids.add('cycling');
  for (const c of face.altCosts ?? []) if (!SENTENCE_ALT_COSTS.has(c.id)) ids.add(c.id);
  if (face.morph) ids.add('morph');
  if (face.storm) ids.add('storm'); if (face.cascade) ids.add('cascade'); if (face.rebound) ids.add('rebound'); if (face.dredge) ids.add('dredge');
  for (const m of face.costModifiers ?? []) if (m.kind !== 'reduce') ids.add(m.kind);
  if ((face.asEnters ?? []).length || face.entersTapped) ids.add('as-enters');
  const lines = (face.oracleText ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const bullets = lines.filter(l => l.startsWith('•'));
  // the sentences the parser folds into `altCosts` ("you may … rather than pay this spell's mana cost", "you may cast ~ from your
  // graveyard …") and `costModifiers` ("this spell costs {1} less …") are statics on Forge's side: render them as static shapes so they align
  const sentences: string[] = [];
  if ((face.altCosts ?? []).some(c => SENTENCE_ALT_COSTS.has(c.id))) sentences.push(...lines.filter(l => /rather than pay|you may cast (?:this card|~) from your graveyard/i.test(l)));
  if ((face.costModifiers ?? []).some(m => m.kind === 'reduce')) sentences.push(...lines.filter(l => /costs? \{[^}]+\} less/i.test(l)));
  // a basic land type's intrinsic mana ability (CR 305.6) is not printed and Forge does not write it
  const basic = (face.subtypes ?? []).some(s => BASIC_LAND_TYPES.has(s));
  const abilities = (face.abilities ?? []).filter(a => !(basic && isIntrinsicMana(a)) && !unconditionalSelfKeywords(a, ids));
  const out = [...ids].sort().map(keywordShape);
  // a spell's `text` is the whole face: the lines other abilities and the sentences above already claim are theirs, not the spell's
  const claimed = [...abilities.filter(a => a.kind !== 'spell').map(a => normalizeShapeText(a.text)), ...sentences.map(normalizeShapeText)].filter(Boolean);
  for (const a of abilities) {
    const s = ourAbilityShape(a, bullets);
    if (a.kind === 'spell') for (const c of claimed) s.text = s.text.replace(c, ' ').replace(/\s+/g, ' ').trim();
    out.push(s);
  }
  for (const line of sentences) out.push({ cls: 'static', text: normalizeShapeText(line), effects: [], targets: [], optional: false, unless: false, tokens: [], magnitudes: [], modes: null, keywords: [] });
  // the one printed replacement the parser folds into a field: render it as a replacement shape so Forge's `R:` line can align
  if (face.graveyardReplacement) out.push({ cls: 'replacement', text: normalizeShapeText(`if ~ would be put into a graveyard from anywhere, ${face.graveyardReplacement === 'exile' ? 'exile it' : "shuffle it into its owner's library"} instead`), effects: [face.graveyardReplacement], targets: [], optional: false, unless: false, tokens: [], magnitudes: [], modes: null, keywords: [] });
  return out;
}

/**
 * The shapes of a whole card: the front face, `backFace` (a transforming / modal DFC), and the second face of a
 * split / adventure / flip card ONLY when `secondFace` (the script's) is given — the parser never parses that face.
 */
export function ourShapes(def: CardDef, secondFace?: ShapeFace | null): AbilityShape[] {
  const out = faceShapes(def);
  if (def.backFace) out.push(...faceShapes(def.backFace));
  if (secondFace) out.push(...faceShapes(secondFace));
  return out;
}

/** Forge's `Types:` of a face as this engine's token vocabulary would spell it — exported for the token tests. */
export function forgeTokenShape(t: ForgeToken): TokenShape { return tokenShapeOf(t); }
export { forgeColors, splitForgeTypes };
