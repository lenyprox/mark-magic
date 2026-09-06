// layers-lite (Phase 9.1): the CR 613 layers printed cards actually use — layer 4 (types and subtypes), layer 5
// (colours), layer 7b (base power and toughness) — as both one-shot effects with a duration and static abilities.
// Layer 6 (losing abilities) and the base-P/T *op* are the composition core's (`lose-abilities`, `set-pt`); this
// family is the type / subtype / colour half plus "is every creature type" and the choices those layers read.
//
// ------------------------------------------------------------------ how a layer reaches the rules
//
// `characteristics.ts` computes `types` / `subtypes` / `colors` / base P/T from exactly one mutable slot on the
// object, `o.animated` (CR 613.1c-e), which the core's own `animate` and `earthbend` ops already write. `Mods` has
// no type or colour term, so a family *cannot* add one from `computeStaticMods`. This family therefore keeps its
// layers as data and **projects** them into that slot:
//
//   o.ext.layers       LayerEntry[]  the one-shot layers a `become` applied, oldest first (CR 613.7 timestamp order)
//   o.ext.layersBase   LayerEntry    a foreign `o.animated` (the core `animate` / `earthbend`) folded in as layer 0
//   o.ext.layersProj   string        the JSON of the overlay this family last wrote, so a foreign write is detectable
//   o.ext.chosenLandType string      the basic land type chosen for this permanent (`o.chosen` has no slot for one)
//   o.ext.layersTs     number        the source's CR 613.7 timestamp: when a `type-change` static's source entered
//   s.ext.layersClock  number        the game's timestamp counter, bumped by every layer this family creates
//   s.ext.layersActive true          some permanent carries a one-shot layer (the cheap gate for the projection pass)
//   s.ext.layersOn     true          some permanent currently CARRIES a projection — the gate that lets the pass take
//                                    one back when the last source has gone (CR 611.2, 613.6); without it a static's
//                                    overlay would be welded on forever once `layerSources` went empty
//
// The one-shot half is projected the instant the `become` op applies, so the effects after it in the same resolution
// already see the new types. The static half (`type-change`) is a *continuous* effect, recomputed by the projection
// pass, which runs at the two points its inputs can have changed since anything last looked:
//
//   * the `sba` hook — `checkSBA` runs after every resolution, every zone change and before every priority round
//     (CR 704.3), which is every moment a layer static's source, host or condition can have moved;
//   * the `canAttack` hook — the first question combat asks, so blockers are declared against an up-to-date
//     battlefield (landwalk reads the *defender's* land subtypes, before any family `canBlock` hook is consulted).
//
// Both are gated on "some permanent carries a one-shot layer" or "some permanent has a `type-change` static" (a scan
// cached per battlefield generation, and written so a cache hit allocates nothing), because both sit on paths the AI
// walks millions of times per benchmark run.
//
// Known approximations (docs/vocabulary/layers.md lists them with the cards they cost):
//   * REMOVAL. `types()` and `subtypes()` UNION `o.animated` with the printed values, so "loses all other card types"
//     and CR 305.7's "the land loses its old land types" are not expressible; a `become` only ever adds. Nor is CR
//     205.1a, where SETTING a type is itself a removal ("becomes a Frog" replaces the creature types): every printed
//     wording that would need it is declined by `replacesPrinted` in src/cards/rules/layers.ts, and a script that
//     writes one gets the additive reading. The core patch that would fix all three is in `coreChangeNeeded`.
//   * BASIC LAND TYPES. Neither CR 305.6 (the intrinsic mana ability that comes with the type) nor CR 305.7 (the
//     land loses its old land types) is expressible here, so the parser rules DECLINE every printed wording that
//     grants one (src/cards/rules/layers.ts:isBasicLandLayer). A script may still write one — the layer is real, it
//     just does not carry the mana ability — which is why the `chosen-basic-land-type` slot below still exists.
//   * Timestamps (CR 613.7) are a per-game counter: a static's source is stamped when the pass first sees it (which
//     is the sba right after it entered) and a one-shot when it is applied, so a one-shot resolving now is later than
//     a static already on the battlefield. Two statics whose sources entered in the same pass keep battlefield order.
import type { CardType, Color, Condition, Filter, Ref, StaticEffect } from '../../cards/types.js';
import type { Amount, FamilyModule, GameObject, GameState, Json, Keyword, OpCtx, PlayerId, TargetSpec } from './types.js';
import { extDel, extGet, extSet, type ExtHost } from './ext.js';
import { chars } from './chars.js';
import { SUBTYPE_KIND } from '../../cards/subtype-vocab.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/** Where a one-shot layer lands. `self` and the other `Ref`s are the composition core's words; the group words skip targeting. */
export type LayerTarget = TargetSpec | Ref | 'creatures-you-control' | 'lands-you-control' | 'permanents-you-control' | 'all-creatures' | 'all-lands';

/** One-shot layer change with a duration (CR 613.1c-e, 613.4b). Every field adds except `colors` (layer 5 replaces). */
export interface BecomeEffect {
  op: 'become'; target: LayerTarget;
  /** Card types gained, always IN ADDITION to the printed ones (CR 205.1b; CR 205.1a's replacement is limit 1). */ types?: CardType[];
  /** Subtypes gained, in addition to the printed ones (CR 205.3; the replacement half is limit 1). */ subtypes?: string[];
  /** The permanent's new colours (CR 105.2, 613.1e); an empty list says nothing. */ colors?: Color[];
  /** Base power / toughness (layer 7b, CR 613.4b); both or neither. */ power?: Amount; toughness?: Amount;
  /** Keywords the layer grants (layer 6, CR 613.1f). */ keywords?: Keyword[];
  /** Changeling: it is every creature type (CR 702.73a). */ everyCreatureType?: true;
  duration: 'eot' | 'permanent';
}
/** "Choose a creature type." as a resolution-time choice (CR 700.4); recorded on the source of the effect. */
export interface ChooseTypeEffect { op: 'choose-type'; what: 'creature-type' | 'color' | 'basic-land-type' }
/** CR 701.12 + 613.4b: Tree of Perdition — a player's life total and a permanent's *base* toughness swap. */
export interface ExchangeLifeToughnessEffect { op: 'exchange-life-toughness'; target: TargetSpec; permanent?: Ref }

/** A static type / subtype / colour change (CR 613.1d layer 4, 613.1e layer 5). */
export interface TypeChangeStatic {
  kind: 'type-change';
  scope: 'self' | 'enchanted' | 'equipped' | 'you-control' | 'all';
  filter?: Filter;
  types?: CardType[];
  /** A literal list, or the type its controller chose as it entered (CR 205.1b). */ subtypes?: string[] | 'chosen-creature-type' | 'chosen-basic-land-type';
  /** A literal list, or the colour chosen as it entered. */ colors?: Color[] | 'chosen';
  everyCreatureType?: true;
  /** "As long as …" (CR 611.2c). */ condition?: Condition;
}
/** "As long as enchanted land is a basic Mountain, …" — does the host (or the source itself) match the filter? */
export interface AttachedIsCondition { kind: 'attached-is'; of?: 'attached' | 'self'; filter: Filter }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { layersBecome: BecomeEffect; layersChooseType: ChooseTypeEffect; layersExchangeLifeToughness: ExchangeLifeToughnessEffect }
  interface StaticRegistry { layersTypeChange: TypeChangeStatic }
  interface ConditionRegistry { layersAttachedIs: AttachedIsCondition }
}

// ------------------------------------------------------------------ 3. the layer data

/** One layer as it is stored: plain JSON, so `clone` deep-copies it and `serialize` round-trips it. */
export type LayerEntry = {
  types?: CardType[]; subtypes?: string[]; colors?: Color[];
  power?: number; toughness?: number; keywords?: Keyword[];
  /** Changeling. Materialised into `subtypes` only at projection time. */ every?: true;
  /** CR 613.7 timestamp: when this layer was created (a one-shot) or when its source entered (a static). */ ts?: number;
  /** The turn an `eot` layer ends with (CR 514.2); absent for an indefinite one. */ untilTurn?: number;
};
type Overlay = NonNullable<GameObject['animated']>;
const NO_ENTRIES: LayerEntry[] = [];

const getLayers = (o: ExtHost): LayerEntry[] => (extGet<Json[]>(o, 'layers') as LayerEntry[] | undefined) ?? NO_ENTRIES;
const putLayers = (o: ExtHost, list: LayerEntry[]): void => { extSet(o, 'layers', list as unknown as Json[]); };
const getBase = (o: ExtHost): LayerEntry | undefined => extGet<Json>(o, 'layersBase') as LayerEntry | undefined;

// ---- CR 613.7 timestamps. One counter per game (`s.ext.layersClock`), so a clone keeps its own monotone sequence and
// `serialize` round-trips it. A one-shot is stamped when it is applied; a static's source is stamped the first time
// the projection pass sees it — the sba that runs immediately after it entered the battlefield, and therefore before
// any later `become` can be applied. That makes "the effect that happened last wins layer 5" true in both directions,
// where the old `[...own, ...stat]` concatenation made a static win unconditionally.
function nextTs(s: GameState): number { const n = (extGet<number>(s, 'layersClock') ?? 0) + 1; extSet(s, 'layersClock', n); return n; }
function srcTs(s: GameState, src: GameObject): number { const t = extGet<number>(src, 'layersTs'); if (t !== undefined) return t; const n = nextTs(s); extSet(src, 'layersTs', n); return n; }
/** Merge one permanent's own layers with the statics that reach it, oldest timestamp first (a stable sort). */
function merge(own: LayerEntry[], stat: LayerEntry[]): LayerEntry[] {
  if (own.length === 0) return stat;
  if (stat.length === 0) return own;
  return [...own, ...stat].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

/** Every creature type the pool prints (CR 702.73a). Built once, on the first changeling the engine ever sees. */
let EVERY_CREATURE_TYPE: string[] | null = null;
function everyCreatureType(): string[] {
  if (EVERY_CREATURE_TYPE === null) EVERY_CREATURE_TYPE = Object.keys(SUBTYPE_KIND).filter(k => SUBTYPE_KIND[k] === 'Creature').sort();
  return EVERY_CREATURE_TYPE;
}

const numOr0 = (v: string | null): number => { if (v == null) return 0; const n = Number(v); return Number.isFinite(n) ? n : 0; };
/**
 * The printed base P/T a layer that sets no P/T must preserve — exactly what `baseP` / `baseT` in characteristics.ts
 * return when `o.animated` is absent.
 *
 * A star/star TOKEN is the trap: its base P/T is `token.power/toughness` PLUS `dynamicPT` evaluated now (Urza's Saga's
 * Construct is `0/0 + artifacts you control`), and `baseP` adds that term only on the branch where `o.animated` is
 * absent. So writing the printed 0/0 into the overlay — which a colour-only or type-only layer would otherwise do —
 * makes the Construct a 0/0 and CR 704.5f puts it in the graveyard. The dynamic term is therefore re-evaluated on
 * every projection; the pass runs at every sba and every battlefield generation, which is every moment the count it
 * reads can have moved.
 */
function printedPT(s: GameState, o: GameObject): { power: number; toughness: number } {
  if (o.faceDown) return { power: 2, toughness: 2 };                              // CR 708.2
  if (o.token) {
    const dyn = o.token.dynamicPT === undefined ? 0 : chars.evalAmount(s, o.token.dynamicPT, o.controller, 0, o);
    return { power: o.token.power + dyn, toughness: o.token.toughness + dyn };
  }
  const d = chars.defOf(o); return { power: numOr0(d.power), toughness: numOr0(d.toughness) };
}

/** Fold the layers into one overlay in timestamp order, or null when they say nothing. */
function fold(s: GameState, o: GameObject, entries: LayerEntry[]): Overlay | null {
  if (entries.length === 0) return null;
  const types: CardType[] = []; const subs: string[] = []; const kws: Keyword[] = [];
  let colors: Color[] = []; let pt: { power: number; toughness: number } | null = null;
  let until: number | undefined; let every = false; let said = false;
  for (const e of entries) {
    if (e.types) { for (const t of e.types) if (!types.includes(t)) types.push(t); said = true; }
    if (e.subtypes) { for (const t of e.subtypes) if (!subs.includes(t)) subs.push(t); said = true; }
    if (e.keywords) { for (const k of e.keywords) if (!kws.includes(k)) kws.push(k); said = true; }
    if (e.colors && e.colors.length) { colors = [...e.colors]; said = true; }        // layer 5 replaces (CR 613.1e)
    if (e.power !== undefined && e.toughness !== undefined) { pt = { power: e.power, toughness: e.toughness }; said = true; }
    if (e.every) { every = true; said = true; }
    if (e.untilTurn !== undefined) until = e.untilTurn;                              // the latest end time wins
  }
  if (!said) return null;
  if (every) for (const t of everyCreatureType()) if (!subs.includes(t)) subs.push(t);
  const base = pt ?? printedPT(s, o);
  return { power: base.power, toughness: base.toughness, colors, types, subtypes: subs, keywords: kws, ...(until !== undefined ? { untilTurn: until } : {}) };
}

/**
 * Write the folded overlay into `o.animated` and report whether anything moved.
 *
 * The slot is shared with the core's `animate` / `earthbend`, so a value this family did not write (its JSON does not
 * match the fingerprint) is captured as `layersBase` and folded in as the earliest layer instead of being clobbered.
 */
function projectOne(s: GameState, o: GameObject, entries: LayerEntry[]): boolean {
  const proj = extGet<string>(o, 'layersProj');
  const cur = o.animated;
  if (cur !== undefined && JSON.stringify(cur) !== proj) extSet(o, 'layersBase', cur as unknown as Json);
  const b = getBase(o);
  const next = fold(s, o, b === undefined ? entries : [b, ...entries]);
  const nextStr = next === null ? '' : JSON.stringify(next);
  if (nextStr === (proj ?? '') && (next === null) === (o.animated === undefined)) return false;
  if (next === null) { delete o.animated; extDel(o, 'layersProj'); } else { o.animated = next; extSet(o, 'layersProj', nextStr); }
  return true;
}

// ------------------------------------------------------------------ 4. the static half

/**
 * Permanents carrying a `type-change` static, cached per battlefield generation (as `staticSources` is).
 *
 * The cache key is counted with a plain loop rather than `chars.allPermanents(s)`: this runs on the AI's hot path and
 * `allPermanents` allocates a joined array on every call. On a hit nothing is allocated at all.
 */
let srcCache: { s: unknown; gen: number; n: number; list: GameObject[] } | null = null;
const NO_SOURCES: GameObject[] = [];
/**
 * Does this ability list contain a `type-change` static? Memoised on the *array*, which for every permanent that is
 * not a token and has been granted nothing is `defOf(o).abilities` — one immutable array per printed card, shared by
 * every copy in every simulated state. A cache miss on a clone therefore costs one WeakMap lookup per permanent
 * instead of an ability scan, which is what keeps this off the AI's critical path.
 */
const HAS_TYPE_CHANGE = new WeakMap<object, boolean>();
function abilitiesHaveTypeChange(abs: readonly { kind: string; effect?: { kind?: string } }[]): boolean {
  const hit = HAS_TYPE_CHANGE.get(abs);
  if (hit !== undefined) return hit;
  let has = false;
  for (let i = 0; i < abs.length; i++) { const ab = abs[i]; if (ab.kind === 'static' && ab.effect?.kind === 'type-change') { has = true; break; } }
  HAS_TYPE_CHANGE.set(abs, has);
  return has;
}
function layerSources(s: GameState): GameObject[] {
  const gen = s.bfGen ?? 0;
  let n = 0; for (const pl of s.players) n += pl.battlefield.length;
  if (srcCache !== null && srcCache.s === s && srcCache.gen === gen && srcCache.n === n) return srcCache.list;
  let list: GameObject[] = NO_SOURCES;
  for (const pl of s.players) for (const o of pl.battlefield) {
    if (!abilitiesHaveTypeChange(chars.abilitiesOf(o))) continue;
    if (list === NO_SOURCES) list = [];
    list.push(o);
  }
  srcCache = { s, gen, n, list };
  return list;
}

/** The basic land type its controller chose as it entered (the core's `o.chosen` has no slot for one). */
const chosenLandType = (o: GameObject): string | undefined => extGet<string>(o, 'chosenLandType');

/** Does this static reach `o`? (scope, filter and the "as long as" condition, CR 611.2c.) */
function applies(s: GameState, e: TypeChangeStatic, src: GameObject, o: GameObject): boolean {
  if (e.scope === 'self') { if (src.id !== o.id) return false; }
  else if (e.scope === 'enchanted' || e.scope === 'equipped') { if (src.attachedTo !== o.id) return false; }
  else {
    if (e.scope === 'you-control' && src.controller !== o.controller) return false;
    if (!chars.matchesFilter(s, o, e.filter, src)) return false;
  }
  return e.condition === undefined || chars.conditionHolds(s, src, e.condition);
}

/** The layer one `type-change` static contributes, with its `chosen-…` slots resolved against the source. */
function staticEntry(s: GameState, e: TypeChangeStatic, src: GameObject): LayerEntry | null {
  const out: LayerEntry = { ts: srcTs(s, src) };
  if (e.types && e.types.length) out.types = e.types;
  if (e.subtypes === 'chosen-creature-type') { const t = src.chosen?.creatureType; if (t !== undefined) out.subtypes = [t]; }
  else if (e.subtypes === 'chosen-basic-land-type') { const t = chosenLandType(src); if (t !== undefined) out.subtypes = [t]; }
  else if (e.subtypes && e.subtypes.length) out.subtypes = e.subtypes;
  if (e.colors === 'chosen') { const c = src.chosen?.color; if (c !== undefined) out.colors = [c]; }
  else if (e.colors && e.colors.length) out.colors = e.colors;
  if (e.everyCreatureType) out.every = true;
  return out.types !== undefined || out.subtypes !== undefined || out.colors !== undefined || out.every !== undefined ? out : null;
}

function staticEntriesFor(s: GameState, o: GameObject, srcs: GameObject[]): LayerEntry[] {
  let out: LayerEntry[] = NO_ENTRIES;
  for (const src of srcs) for (const ab of chars.abilitiesOf(src)) {
    if (ab.kind !== 'static') continue;
    const e = ab.effect as StaticEffect & { kind: string };
    if (e.kind !== 'type-change') continue;
    const tc = e as unknown as TypeChangeStatic;
    if (!applies(s, tc, src, o)) continue;
    const entry = staticEntry(s, tc, src);
    if (entry !== null) { if (out === NO_ENTRIES) out = []; out.push(entry); }
  }
  return out;
}

/** All the layers on one permanent in CR 613.7 timestamp order: its one-shots and the statics that reach it, merged. */
const layersOf = (s: GameState, o: GameObject, srcs: GameObject[]): LayerEntry[] =>
  merge(getLayers(o), srcs.length === 0 ? NO_ENTRIES : staticEntriesFor(s, o, srcs));

/**
 * The last state this pass ran clean on. `pass` bumps `s.version` whenever it moves anything, so the same state at
 * the same version and battlefield generation is provably already projected — which collapses the repeat calls
 * `checkSBA`'s own loop makes, the ones that dominate the cost on the AI's rollout path.
 */
let settled: { s: unknown; gen: number; version: number } | null = null;

/**
 * The continuous-effects pass: reproject every permanent a layer touches. True when something moved.
 *
 * THE THIRD GATE. A `type-change` static's continuous effect exists only while its source is on the battlefield (CR
 * 611.2b, 613.6): when the last source leaves, the overlay it wrote has to be TAKEN BACK, and this loop is the only
 * code that can do it. Gating the loop on "a live source or a one-shot exists" therefore skipped exactly the pass
 * that mattered — Sea's Claim in the graveyard left the Forest an Island for the rest of the game. So the gate also
 * asks whether anything is currently projected (`s.ext.layersOn`, maintained by this loop): when it is, the pass runs
 * even with no sources at all, clears what it finds and drops the flag, after which the cheap short-circuit is back.
 */
function pass(s: GameState): boolean {
  const gen = s.bfGen ?? 0;
  if (settled !== null && settled.s === s && settled.gen === gen && settled.version === s.version) return false;
  const srcs = layerSources(s);
  if (srcs.length === 0 && extGet<boolean>(s, 'layersActive') === undefined && extGet<boolean>(s, 'layersOn') === undefined) { settled = { s, gen, version: s.version }; return false; }
  let changed = false; let anyOneShot = false; let anyProj = false;
  for (const o of chars.allPermanents(s)) {
    const own = getLayers(o); if (own.length !== 0) anyOneShot = true;
    const stat = srcs.length === 0 ? NO_ENTRIES : staticEntriesFor(s, o, srcs);
    if (own.length === 0 && stat.length === 0 && o.animated === undefined && extGet<string>(o, 'layersProj') === undefined && getBase(o) === undefined) continue;
    if (projectOne(s, o, merge(own, stat))) changed = true;
    if (extGet<string>(o, 'layersProj') !== undefined) anyProj = true;
  }
  if (!anyOneShot) extDel(s, 'layersActive');
  if (anyProj) extSet(s, 'layersOn', true); else extDel(s, 'layersOn');
  if (changed) s.version++;
  settled = { s, gen: s.bfGen ?? 0, version: s.version };
  return changed;
}

// ------------------------------------------------------------------ 5. helpers the ops share

/** The permanents a `LayerTarget` names. A `Ref` goes through the core resolver, imported lazily (rule 2). */
async function targetsOf(t: LayerTarget, c: OpCtx): Promise<GameObject[]> {
  if (typeof t !== 'string') return c.objs();
  const s = c.s;
  switch (t) {
    case 'creatures-you-control': return chars.battlefieldOf(s, c.p).filter(o => chars.isCreature(o));
    case 'lands-you-control': return chars.battlefieldOf(s, c.p).filter(o => chars.isLand(o));
    case 'permanents-you-control': return [...chars.battlefieldOf(s, c.p)];
    case 'all-creatures': return chars.allPermanents(s).filter(o => chars.isCreature(o));
    case 'all-lands': return chars.allPermanents(s).filter(o => chars.isLand(o));
    default: {
      const { resolveRef } = await import('../refs.js');
      return resolveRef({ s, item: c.item, p: c.p, src: c.src }, t as Ref);
    }
  }
}

const BASIC_LAND_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
const COLOR_NAME: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/** English for a layer: the log line and the round-trip renderer read the same words. */
function describe(e: BecomeEffect | TypeChangeStatic): string {
  const bits: string[] = [];
  if ('power' in e && e.power !== undefined && e.toughness !== undefined) bits.push(`${String(e.power)}/${String(e.toughness)}`);
  if (e.colors === 'chosen') bits.push('the chosen color');
  else if (e.colors && e.colors.length) bits.push(...e.colors.map(c => COLOR_NAME[c] ?? c));
  if (e.everyCreatureType) bits.push('every creature type');
  if (e.subtypes === 'chosen-creature-type' || e.subtypes === 'chosen-basic-land-type') bits.push('the chosen type');
  else if (e.subtypes) bits.push(...e.subtypes);
  if (e.types) bits.push(...e.types.map(t => t.toLowerCase()));
  if ('keywords' in e && e.keywords && e.keywords.length) bits.push(`with ${e.keywords.join(', ')}`);
  return bits.length ? bits.join(' ') : 'unchanged';
}

/** English for a `LayerTarget`, for the renderer. */
function targetWords(t: LayerTarget): string {
  if (typeof t !== 'string') return `target ${t.kind}`;
  switch (t) {
    case 'self': return '~';
    case 'creatures-you-control': return 'creatures you control';
    case 'lands-you-control': return 'lands you control';
    case 'permanents-you-control': return 'permanents you control';
    case 'all-creatures': return 'each creature';
    case 'all-lands': return 'each land';
    case 'enchanted': return 'enchanted permanent';
    case 'equipped': return 'equipped creature';
    default: return 'it';
  }
}

/** The creature types worth offering, most frequent first (the shape `game.ts` uses for the core `choose`). */
function creatureTypeOptions(s: GameState, p: PlayerId): string[] {
  const pl = s.players[p]; const freq: Record<string, number> = {};
  for (const c of [...pl.hand, ...pl.battlefield, ...pl.graveyard]) if (c.def.types.includes('Creature')) for (const st of c.def.subtypes) freq[st] = (freq[st] ?? 0) + 1;
  const out = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  return out.length ? out : ['Human'];
}

// ------------------------------------------------------------------ 6. the module

const LAYERS: FamilyModule = {
  name: 'layers',

  effects: {
    // "Until end of turn, target land becomes a 3/3 Elemental creature with haste. It's still a land." (CR 613.1c-e)
    become: async (e: BecomeEffect, c) => {
      const list = (await targetsOf(e.target, c)).filter(o => o.zone === 'battlefield');
      if (list.length === 0) return;
      const entry: LayerEntry = {};
      if (e.types && e.types.length) entry.types = e.types;
      if (e.subtypes && e.subtypes.length) entry.subtypes = e.subtypes;
      if (e.colors && e.colors.length) entry.colors = e.colors;
      if (e.keywords && e.keywords.length) entry.keywords = e.keywords;
      if (e.everyCreatureType) entry.every = true;
      if (e.power !== undefined && e.toughness !== undefined) { entry.power = c.amt(e.power); entry.toughness = c.amt(e.toughness); }
      if (entry.types === undefined && entry.subtypes === undefined && entry.colors === undefined && entry.keywords === undefined && entry.every === undefined && entry.power === undefined) return;
      if (e.duration === 'eot') entry.untilTurn = c.s.turn;
      entry.ts = nextTs(c.s);                                                       // CR 613.7: it happens now, so it is the latest timestamp
      const srcs = layerSources(c.s);
      for (const o of list) { putLayers(o, [...getLayers(o), entry]); projectOne(c.s, o, layersOf(c.s, o, srcs)); }
      extSet(c.s, 'layersActive', true);
      extSet(c.s, 'layersOn', true);
      c.s.version++;
      const what = describe(e);
      c.g.note(`${list.map(o => chars.name(o)).join(', ')} become${list.length === 1 ? 's' : ''} ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}${e.duration === 'eot' ? ' until end of turn' : ''}.`);
    },

    // "Choose a creature type." — recorded on the source, so `Filter.chosenType` and a `chosen-…` static read it.
    'choose-type': async (e: ChooseTypeEffect, c) => {
      const src = c.src;
      if (e.what === 'color') {
        const picked = await c.g.ask(c.p, { kind: 'choose-color', reason: c.item.name }) as Color;
        const col = COLORS.includes(picked) ? picked : 'W';
        src.chosen = { ...src.chosen, color: col };
        c.g.note(`${c.g.pname(c.p)} chooses ${COLOR_NAME[col]}.`);
      } else {
        const options = e.what === 'basic-land-type' ? BASIC_LAND_TYPES : creatureTypeOptions(c.s, c.p);
        const picked = await c.g.ask(c.p, { kind: 'choose-option', options, reason: `${c.item.name}: choose a ${e.what.replace(/-/g, ' ')}` }) as string;
        const t = options.includes(picked) ? picked : options[0];
        if (e.what === 'basic-land-type') extSet(src, 'chosenLandType', t); else src.chosen = { ...src.chosen, creatureType: t };
        c.g.note(`${c.g.pname(c.p)} chooses ${t}.`);
      }
      c.s.version++;
    },

    // Tree of Perdition (CR 701.12, 613.4b): the exchange sets a *base* toughness, so counters still apply on top.
    'exchange-life-toughness': async (e: ExchangeLifeToughnessEffect, c) => {
      const who = c.players()[0]; if (who === undefined) return;
      const list = e.permanent === undefined ? [c.src] : await targetsOf(e.permanent, c);
      const o = list.find(x => x.zone === 'battlefield'); if (o === undefined) return;
      const life = c.s.players[who].life; const tough = chars.toughness(c.s, o);
      const setPT = extGet<Json>(o, 'setPT') as { power: number; toughness: number } | undefined;
      extSet(o, 'setPT', { power: setPT?.power ?? printedPT(c.s, o).power, toughness: life, base: true } as unknown as Json);
      if (tough > life) c.g.gainLife(who, tough - life); else if (life > tough) c.g.loseLife(who, life - tough, 'effect');
      c.s.version++;
      c.g.note(`${c.g.pname(who)}'s life total and ${chars.name(o)}'s toughness are exchanged (${life} / ${tough}).`);
    },
  },

  conditions: {
    // "As long as enchanted land is a basic Mountain, …" / "As long as ~ is a Vehicle, …"
    'attached-is': (cond: AttachedIsCondition, s, src) => {
      if ((cond.of ?? 'attached') === 'self') return chars.matchesFilter(s, src, cond.filter, src);
      const host = src.attachedTo === null ? undefined : chars.findObject(s, src.attachedTo);
      return host !== undefined && host.zone === 'battlefield' && chars.matchesFilter(s, host, cond.filter, src);
    },
  },

  // Registered so the vocabulary knows the kind; the layer itself is applied by the projection pass above, which is
  // the only place a family can reach `types()` / `subtypes()` / `colors()` — `Mods` has no term for any of them.
  // The hook still runs for every permanent the static reaches, and flags changelings for anything reading `flags`.
  statics: {
    'type-change': (e: TypeChangeStatic, src, o, s, m) => { if (e.everyCreatureType && applies(s, e, src, o)) m.flags.everyCreatureType = true; },
  },

  // "As ~ enters, choose a basic land type" is the replacement family's `choose-type` as-enters (it writes the same
  // `ext.chosenLandType` this family's `type-change` reads); the layers copy was dropped at the 9.1 merge.

  // The continuous-effects pass (see the file header for why it lives on these two hooks and nowhere else).
  sba: (g) => pass(g.state),
  keywordHooks: { canAttack: (s) => { pass(s); return undefined; } },

  // CR 514.2: an `eot` layer ends. The core has already dropped `o.animated` when it carried `untilTurn`, so the
  // fingerprint goes with it and the pass that runs straight after the wipe rebuilds whatever is left.
  cleanupEot: (_g, o) => {
    if (o.ext === undefined) return;
    const own = getLayers(o);
    if (own.length !== 0) {
      const keep = own.filter(l => l.untilTurn === undefined);
      if (keep.length !== own.length) { if (keep.length === 0) extDel(o, 'layers'); else putLayers(o, keep); extDel(o, 'layersProj'); }
    }
    const b = getBase(o);
    if (b !== undefined && b.untilTurn !== undefined) { extDel(o, 'layersBase'); extDel(o, 'layersProj'); }
    if (o.animated === undefined) extDel(o, 'layersProj');
  },

  // CR 400.7: a permanent that leaves is a new object — every layer on it ends (`moveTo` already dropped `animated`).
  leave: (_g, o) => { extDel(o, 'layers'); extDel(o, 'layersProj'); extDel(o, 'layersBase'); extDel(o, 'chosenLandType'); extDel(o, 'layersTs'); },

  render: {
    become: (e: BecomeEffect) => {
      const what = describe(e);
      return `${targetWords(e.target)} becomes ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}${e.duration === 'eot' ? ' until end of turn' : ''}`;
    },
    'choose-type': (e: ChooseTypeEffect) => `Choose a ${e.what.replace(/-/g, ' ')}`,
    'exchange-life-toughness': (_e: ExchangeLifeToughnessEffect) => "Exchange target opponent's life total with ~'s toughness",
  },
};

export default LAYERS;
