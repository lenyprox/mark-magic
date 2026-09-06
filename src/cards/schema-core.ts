// The runtime (zod) mirror of the ability AST in `types.ts` plus the v2 card-script format — the CORE vocabulary and
// the composer that folds every mechanic family's `<family>.schema.ts` into it.
//
// IMPORT `./schema.js`, NOT THIS FILE. `src/cards/schema.ts` is the public module: it installs the generated family
// list (`./_schemas.ts`) into the composition below and re-exports everything here. This file exists apart from it
// for one reason — module-evaluation order. A family's `.schema.ts` may import the leaf schemas it builds on
// (`FilterSchema`, `AmountSchema`, `TargetSpecSchema`, `EffectSchema`, …) from `schema.ts` at module scope, and
// `schema.ts` imports `_schemas.ts`, which imports every family file: that is a cycle, and the only way a family
// evaluating in the middle of it can read an initialised binding is for the binding to live in a module that has
// ALREADY finished evaluating — this one, which imports no family and no generated file. `schema.ts` re-exports it
// (an indirect binding resolves straight to this module's environment), so `import { FilterSchema } from
// '../../cards/schema.js'` works from inside the cycle. Only what `schema.ts` defines itself would be in its temporal
// dead zone there, which is why it defines nothing but the install call. Importing this file directly gives a
// composition that THROWS on first use ("the family schemas were never installed") rather than one that silently
// knows no family.
//
// TOOLING ONLY. Nothing under src/engine, src/sim, src/ai or apps/web may import this file: zod is a devDependency
// and must never reach the game or the web bundle. `scripts:check`, `scripts:verify`, `scripts:schema`, the lint,
// `vocab:doc` and the tests are the only consumers.
//
// The schemas are STRICT (`z.strictObject`): a typo'd field is a validation error, which is the whole point — an
// LLM-written script must not silently lose a clause to a misspelt key.
//
// HOW THE COMPOSITION WORKS (plan 1.5, "validation without the TS compiler API"). Every union a family may widen has
// two faces:
//   * a CORE face, built eagerly from the hand-written variant lists (`EFFECT_VARIANTS` → `CoreEffectSchema`, …) and
//     pinned to the `Core*` types of types.ts at compile time by test/schema-types.test.ts;
//   * a COMPOSED face (`EffectSchema`, `ConditionSchema`, `TriggerEventSchema`, `StaticEffectSchema`,
//     `AsEntersSchema`, `AbilityCostSchema`, and the `Amount.count` / `TargetSpec.kind` enums), a `z.lazy` that
//     resolves ON FIRST PARSE to `z.discriminatedUnion(key, [...core, ...every family's variants])`, the enum widened
//     with the families' literals, the cost object extended with their cost parts. Every recursive position in the
//     core variants (`then: z.array(EffectRef)`, `target: TargetSpecRef`, `cost: AbilityCostSchema`, …) goes through
//     the composed face, so a family op nested inside `conditional` / `for-each` / `may`, a family amount count inside
//     a filter's `mvLE`, or a family target kind inside a core `damage` validates the same as at the top level.
// The composed faces are TYPED with the widened aliases of types.ts (`z.ZodType<Effect>`, `z.ZodType<TargetSpec['kind']>`,
// `z.ZodType<Keyword>` …), which is what keeps the compile-time pins honest once families are merged: a family widens
// `Effect` by declaration merging and the composed face's static type widens with it, while the core face stays
// exactly `CoreEffect`. The pin cannot see a family's variants (they are runtime values in a generated list); the
// runtime half of test/schema-types.test.ts covers them with `composeSchemas`.
//
// Everything that depends on the composition lives in `buildSchemas()`, so a test can build a complete second
// instance around an in-memory family (`composeSchemas([...])`) without touching the one the tools use — a zod
// `z.lazy` caches what it resolved to, so a live instance cannot be re-composed after its first parse.
import { z } from 'zod';
import type { ZodObject, ZodType } from 'zod';
import type {
  Ability, AbilityCost, AbilityCostExt, AltCostId, Amount, AmountCount, AsEnters, Condition, CoreStaticEffect, Effect, Filter, Keyword,
  StaticAbility, StaticRegistry, TargetSpec, TriggerEvent,
} from './types.js';
import type { FamilySchema } from '../engine/ops/types.js';
import { COVER_KINDS, coverProblems, coversValid, IGNORE_REASONS } from './scripts.js';
import { LIST_LIMIT, NESTING_LIMIT, ownTargetSpecs, sharedLists } from '../engine/legal.js';

// ---------------------------------------------------------------------------
// What the parser really emits
//
// `parse.ts` deliberately writes a few things past the type system with casts, and the engine reads them back:
//
//   * `num()` returns an `Amount` and is cast with `as number` into eight slots types.ts declares `number`:
//     `loot.draw`, `loot.discard` (parse.ts:216-217), `sacrifice.amount`, `impulse.count`, `search.count`,
//     `untap-choose.count`, `AbilityCost.discard`, `.exileFromGraveyard` and `.removeCounters.amount`. Over the whole
//     34,513-card pool the only non-number that ever lands there is the literal `'X'`. Those slots use `NUMX` below:
//     it validates leniently but is TYPED `number`, so the AST types stay exactly pinned.
//   * six static-effect fields are spread in with `as object` (parse.ts:1059-1078) and read back by the engine:
//     `anthem.opponentsOnly` (characteristics.ts:175), `self-keywords.mustAttack` (game.ts:1754),
//     `.doesntUntap` (characteristics.ts:184), `.evasion` / `.blockOnlyFlying` (characteristics.ts:344-346) and
//     `self-pt.condition`. Extra keys cannot be typed away, so those three variants are pinned against
//     `ParsedCoreStaticEffect` / `ParsedAbility` below — which `Extract` them from `CoreStaticEffect` and add only the
//     six extra fields, so every field types.ts declares on them stays pinned. Those six NAMES are the whole hole.
//
// Everything else is pinned against types.ts exactly.
// ---------------------------------------------------------------------------

/** Homomorphic field override: optional/readonly modifiers of `T` are preserved. */
type Replace<T, R> = { [K in keyof T]: K extends keyof R ? R[K] : T[K] };

/** Flattens an intersection back into one object type (homomorphic, so `?` modifiers survive) — `Equals<>` needs it. */
type Simplify<T> = { [K in keyof T]: T[K] };

/** One member of `CoreStaticEffect`, selected by its discriminant, so types.ts stays its single declaration. */
type StaticVariant<K extends CoreStaticEffect['kind']> = Extract<CoreStaticEffect, { kind: K }>;

/**
 * The three static-effect variants parse.ts extends past types.ts. Each is `Extract`ed from `CoreStaticEffect` and
 * only the extra FIELDS are added here, so every field types.ts declares on them stays pinned: retype or drop
 * `anthem.scope` or `self-keywords.cantBlock` in types.ts and `typecheck:all` fails, exactly as for a normal
 * variant. Everything else is `Exclude`d straight out of `CoreStaticEffect`, so adding or removing a whole core
 * variant breaks the assertion too. The six field names listed below are the entire hole.
 */
export type ParsedCoreStaticEffect =
  | Simplify<StaticVariant<'anthem'> & { opponentsOnly?: boolean }>
  | Simplify<StaticVariant<'self-pt'> & { condition?: Condition }>
  | Simplify<StaticVariant<'self-keywords'> & { mustAttack?: boolean; doesntUntap?: boolean; blockOnlyFlying?: boolean; evasion?: Filter }>
  | Exclude<CoreStaticEffect, { kind: 'anthem' | 'self-pt' | 'self-keywords' }>;

/** `ParsedCoreStaticEffect` plus every family static (`StaticRegistry`) — what the composed `StaticEffectSchema` is typed as. */
export type ParsedStaticEffect = ParsedCoreStaticEffect | StaticRegistry[keyof StaticRegistry];

/** `Ability` with the widened static effect; the other three members are taken from types.ts unchanged. */
export type ParsedAbility =
  | Extract<Ability, { kind: 'triggered' }>
  | Extract<Ability, { kind: 'activated' }>
  | Replace<StaticAbility, { effect: ParsedStaticEffect }>
  | Extract<Ability, { kind: 'spell' }>;

/** `AbilityCost` without the family cost parts (`AbilityCostExt`) — what the core cost object is pinned to. */
export type CoreAbilityCost = Omit<AbilityCost, keyof AbilityCostExt>;

// ---------------------------------------------------------------------------
// Enums. The ones a family widens through the schema contract (`Amount.count`, `TargetSpec.kind`) are composed in
// buildSchemas(); the ones a family can only widen by declaration merging (`Keyword`, `AltCost.id`) have no runtime
// source outside this file, so their schemas below are TYPED with the widened alias and validate the core list.
// ---------------------------------------------------------------------------

export const CARD_TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle', 'Kindred', 'Tribal'] as const;
export const COLOR_LETTERS = ['W', 'U', 'B', 'R', 'G'] as const;
export const MANA_SYMBOLS = ['W', 'U', 'B', 'R', 'G', 'C'] as const;

export const KEYWORDS = [
  'flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'haste', 'vigilance',
  'reach', 'defender', 'flash', 'hexproof', 'indestructible', 'menace', 'unblockable', 'cant block',
  'shroud', 'protection', 'prowess', 'ward', 'fear', 'intimidate', 'skulk', 'cant attack',
  'shadow', 'horsemanship', 'flanking', 'exalted', 'infect', 'wither', 'toxic', 'bushido', 'landwalk', 'rampage', 'firebending',
] as const;

export const TARGET_KINDS = [
  'creature', 'player', 'any', 'permanent', 'spell', 'creature-or-player', 'creature-or-planeswalker', 'planeswalker',
  'opponent', 'artifact', 'enchantment', 'land', 'nonland-permanent', 'artifact-or-enchantment', 'creature-spell',
  'noncreature-spell', 'attacking-creature', 'blocking-creature', 'tapped-creature', 'ability',
  'artifact-enchantment-or-nonbasic-land', 'spell-or-nonland-permanent', 'graveyard-card',
] as const;

export const AMOUNT_COUNTS = [
  'creatures-you-control', 'cards-in-hand', 'lands-you-control', 'power-of-source', 'creatures-attacking',
  'opponent-creatures', 'life-lost-this-turn', 'permanents-you-control', 'domain', 'exiled-with', 'cards-in-graveyard',
  'power-of-that', 'mv-of-that', 'colors-spent', 'card-types-in-graveyard', 'card-types-in-all-graveyards',
  'counters-on-source', 'counters-on-permanents', 'that-many', 'commander-casts', 'opponents', 'player-counters',
  'cards-drawn-this-turn', 'permanents-on-battlefield', 'creatures-died-this-turn', 'attached-to-source',
  'blocking-source', 'cards-in-all-hands', 'spells-cast-this-turn',
] as const;

// ---- composition core (Phase 9.0, docs/vocabulary/composition.md): the enums its ops share ----------------------
/** `Ref` minus the `target:<i>` template form (which `RefSchema` adds). */
export const REFS = ['self', 'that', 'those', 'triggering', 'enchanted', 'equipped', 'sacrificed', 'exiled-with'] as const;
export const SCOPE_WHO = ['you', 'each-player', 'each-opponent', 'target-player', 'target-opponent', 'that-player', 'controller-of-that', 'owner-of-that'] as const;
export const SET_ZONES = ['battlefield', 'graveyard', 'hand', 'exile', 'library'] as const;
export const MOVE_ZONES = ['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command'] as const;
export const DELAYED_AT = ['next-upkeep', 'next-end-step', 'your-next-end-step', 'end-of-combat', 'this-turn:dies', 'this-turn:ltb', 'next-turn:upkeep', 'until-eot:end'] as const;
export const AMOUNT_PROPS = ['power', 'toughness', 'mv', 'life', 'cards-in-hand'] as const;

export const ALT_COST_IDS = ['pitch', 'life', 'evoke', 'warp', 'impending', 'flashback', 'escape', 'jump-start', 'from-graveyard', 'buyback', 'dash', 'morph'] as const;
/** 8a-1 widens this to the full `CastZone`. */
export const ALT_COST_FROM = ['hand', 'graveyard', 'exile', 'command'] as const;   // = CastZone in types.ts (8a-1 widened it for foretell/plot-style casts)

export const CardTypeSchema = z.enum(CARD_TYPES);
export const ColorSchema = z.enum(COLOR_LETTERS);
export const ManaSymbolSchema = z.enum(MANA_SYMBOLS);
/** Typed `Keyword` (the alias a family widens by declaration merging), validated against the core list: no field of the family schema contract names a keyword. */
export const KeywordSchema: z.ZodType<Keyword> = z.enum(KEYWORDS);
/** Typed `AltCostId` for the same reason. */
export const AltCostIdSchema: z.ZodType<AltCostId> = z.enum(ALT_COST_IDS);

const B = z.boolean();
const N = z.number();
const S = z.string();
/**
 * A slot types.ts declares `number` and parse.ts also writes the literal `'X'` into (`num(...) as number`).
 * Typed `number` so the AST types stay exactly pinned; validated leniently so the parser's own output passes.
 */
const NUMX = z.custom<number>(v => typeof v === 'number' || v === 'X', { message: 'expected a number (or the parser literal "X")' });

export const ManaCostSchema = z.strictObject({
  generic: N, x: N, pips: z.array(ManaSymbolSchema), hybrid: z.array(z.array(ManaSymbolSchema)), phyrexian: z.array(ColorSchema), phyrexianHybrid: z.array(z.array(ColorSchema)).optional(), raw: S,
});
/** A `Ref`: one of the named references, or `target:<i>` (the i-th target of the item). */
export const RefSchema = z.union([z.enum(REFS), z.templateLiteral(['target:', z.number()])]);
export const ScopeWhoSchema = z.enum(SCOPE_WHO);
export const SetZoneSchema = z.enum(SET_ZONES);

const ONE_FORM = 'an amount carries exactly one of count, diff, sum, max (as a list), min or prop';
/** The cross-field rules of an `AmountExpr` (shared by every instance of the schema). */
function amountRules(a: { count?: unknown; diff?: unknown; sum?: unknown; max?: unknown; min?: unknown; prop?: unknown; of?: unknown; over?: unknown; agg?: unknown; filter?: unknown; zone?: unknown; who?: unknown; counter?: unknown }, ctx: z.RefinementCtx): void {
  const forms = [a.count !== undefined, a.diff !== undefined, a.sum !== undefined, Array.isArray(a.max), a.min !== undefined, a.prop !== undefined].filter(Boolean).length;
  if (forms !== 1) ctx.addIssue({ code: 'custom', message: ONE_FORM });
  if (a.prop !== undefined && a.of === undefined && a.over === undefined) ctx.addIssue({ code: 'custom', message: 'a prop amount names what it is a property of (`of`, or `agg` + `over`)' });
  if ((a.agg !== undefined) !== (a.over !== undefined)) ctx.addIssue({ code: 'custom', message: 'an aggregate amount carries both `agg` and `over`' });
  if (a.over !== undefined && (a.prop === undefined || a.prop === 'life' || a.prop === 'cards-in-hand' || a.of !== undefined)) ctx.addIssue({ code: 'custom', message: 'an aggregate amount is a power / toughness / mv prop over an object set, with no `of`' });
  if (a.count === undefined && (a.filter !== undefined || a.zone !== undefined || a.who !== undefined || a.counter !== undefined)) ctx.addIssue({ code: 'custom', message: 'filter / zone / who / counter belong to a count amount' });
}
/** The cross-field rules of a `TargetSpec`. */
function targetSpecRules(t: { kind: string; who?: unknown; specs?: unknown[] }, ctx: z.RefinementCtx): void {
  if (t.who !== undefined && t.kind !== 'graveyard-card') ctx.addIssue({ code: 'custom', message: "only a 'graveyard-card' target spec carries `who` (whose graveyard)" });
  if (t.kind === 'multi' && !(t.specs && t.specs.length >= 2)) ctx.addIssue({ code: 'custom', message: "a 'multi' target spec lists at least two specs" });
  if (t.kind !== 'multi' && t.specs !== undefined) ctx.addIssue({ code: 'custom', message: "only a 'multi' target spec carries specs" });
}

// ---------------------------------------------------------------------------
// Family schemas: the contract (`FamilySchema` in src/engine/ops/types.ts), one entry per `<family>.schema.ts`, and
// the merge that folds them into flat lists with duplicate detection.
// ---------------------------------------------------------------------------

/** One family's schema with the file it came from — what the generated `_schemas.ts` lists. */
export interface FamilySchemaEntry { family: string; file: string; schema: FamilySchema }

/** The family lists folded together, every literal unique across the families and the core. */
export interface MergedFamilySchemas {
  effects: ZodObject[]; conditions: ZodObject[]; triggers: ZodObject[]; statics: ZodObject[]; asEnters: ZodObject[];
  amounts: string[]; targetKinds: string[]; costParts: Record<string, ZodType>;
}

/** The literals the core already owns, per slot — what a family may not redeclare. */
export interface CoreVocabulary {
  effects: readonly string[]; conditions: readonly string[]; triggers: readonly string[]; statics: readonly string[];
  asEnters: readonly string[]; amounts: readonly string[]; targetKinds: readonly string[]; costParts: readonly string[];
}

const FAMILY_SCHEMA_KEYS = ['effects', 'conditions', 'triggers', 'statics', 'amounts', 'costParts', 'asEnters', 'targetKinds'] as const;
const CORE_FILE = 'src/cards/schema-core.ts (the core vocabulary)';

/** zod internals this file reads: the def of any schema, and the shape / catch-all of an object. */
interface ZodLike { _zod?: { def?: { type?: string; shape?: Record<string, ZodLike & { value?: unknown }>; catchall?: ZodLike } } }
const defOf = (v: unknown) => (v as ZodLike | undefined)?._zod?.def;

/**
 * The discriminator literal of one zod variant (`z.strictObject({ op: z.literal('draw'), … })` → `'draw'`), or null.
 * `def.shape` and `z.literal.value` are the only internals touched.
 */
export function literalOf(variant: unknown, key: string): string | null {
  const v = defOf(variant)?.shape?.[key]?.value;
  return typeof v === 'string' ? v : null;
}

/** The discriminator literals of a whole variant list; THROWS when one cannot be read (a zod upgrade must fail loudly, not widen the vocabulary to "anything"). */
export function literalsOf(variants: readonly unknown[], key: string): string[] {
  const out: string[] = [];
  for (const v of variants) { const l = literalOf(v, key); if (l !== null) out.push(l); }
  if (out.length !== variants.length) throw new Error(`schema — could not read the '${key}' discriminator of ${out.length}/${variants.length} zod variants; re-anchor src/cards/schema-core.ts on the zod version in use`);
  return out;
}

/**
 * Fold the families' schemas into flat lists, checking the contract as it goes: every list entry is a STRICT zod
 * object whose discriminator is a string literal, every amount / target kind a string, every cost part a zod schema,
 * no key outside the eight of `FamilySchema` — and every literal is declared ONCE, across the families and against
 * the core (`core`: the literals the core owns, `CORE_VOCABULARY` for the instance the tools use). A violation is an Error naming the
 * file (and, for a duplicate, both files), because the generated barrel evaluates this at import time and a vague
 * message there would be the only thing the author ever saw.
 */
export function mergeFamilySchemas(entries: readonly FamilySchemaEntry[], core: CoreVocabulary): MergedFamilySchemas {
  const out: MergedFamilySchemas = { effects: [], conditions: [], triggers: [], statics: [], asEnters: [], amounts: [], targetKinds: [], costParts: {} };
  const owners: Record<keyof CoreVocabulary, Map<string, string>> = {
    effects: new Map(), conditions: new Map(), triggers: new Map(), statics: new Map(), asEnters: new Map(), amounts: new Map(), targetKinds: new Map(), costParts: new Map(),
  };
  const WHAT: Record<keyof CoreVocabulary, string> = { effects: 'effect op', conditions: 'condition kind', triggers: 'trigger event', statics: 'static kind', asEnters: 'as-enters kind', amounts: 'amount count', targetKinds: 'target kind', costParts: 'cost part' };
  for (const slot of Object.keys(owners) as (keyof CoreVocabulary)[]) for (const lit of core[slot]) owners[slot].set(lit, CORE_FILE);
  const claim = (slot: keyof CoreVocabulary, lit: string, file: string) => {
    const prev = owners[slot].get(lit);
    if (prev !== undefined) throw new Error(`family schema — duplicate ${WHAT[slot]} "${lit}" declared by both ${prev} and ${file}`);
    owners[slot].set(lit, file);
  };
  const seenFamilies = new Map<string, string>();
  for (const { family, file, schema } of entries) {
    const prevFamily = seenFamilies.get(family);
    if (prevFamily !== undefined) throw new Error(`family schema — two schemas named "${family}": ${prevFamily} and ${file}`);
    seenFamilies.set(family, file);
    if (!schema || typeof schema !== 'object') throw new Error(`family schema — ${file} must export \`schema: FamilySchema\` (got ${typeof schema})`);
    for (const k of Object.keys(schema)) if (!(FAMILY_SCHEMA_KEYS as readonly string[]).includes(k)) throw new Error(`family schema — ${file} declares "${k}", which is not part of the FamilySchema contract (${FAMILY_SCHEMA_KEYS.join(', ')})`);
    const variants = (slot: 'effects' | 'conditions' | 'triggers' | 'statics' | 'asEnters', key: string) => {
      const list = schema[slot];
      if (list === undefined) return;
      if (!Array.isArray(list)) throw new Error(`family schema — ${file}: ${slot} must be a list of strict zod objects`);
      list.forEach((v, i) => {
        const def = defOf(v);
        if (def?.type !== 'object') throw new Error(`family schema — ${file}: ${slot}[${i}] is not a zod object (z.strictObject({ ${key}: z.literal('…'), … }))`);
        if (defOf(def.catchall)?.type !== 'never') throw new Error(`family schema — ${file}: ${slot}[${i}] must be STRICT (z.strictObject): a typo'd field in a script must be a validation error`);
        const lit = literalOf(v, key);
        if (lit === null) throw new Error(`family schema — ${file}: ${slot}[${i}] has no string-literal '${key}' discriminator (z.literal('…'))`);
        claim(slot, lit, file);
        out[slot].push(v as ZodObject);
      });
    };
    variants('effects', 'op'); variants('conditions', 'kind'); variants('triggers', 'on'); variants('statics', 'kind'); variants('asEnters', 'kind');
    for (const slot of ['amounts', 'targetKinds'] as const) {
      const list = schema[slot];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some(s => typeof s !== 'string' || !s)) throw new Error(`family schema — ${file}: ${slot} must be a list of string literals`);
      for (const s of list) { claim(slot, s, file); out[slot].push(s); }
    }
    if (schema.costParts !== undefined) {
      if (!schema.costParts || typeof schema.costParts !== 'object' || Array.isArray(schema.costParts)) throw new Error(`family schema — ${file}: costParts must be a record of zod schemas keyed by AbilityCost field`);
      for (const [k, v] of Object.entries(schema.costParts)) {
        if (!defOf(v)) throw new Error(`family schema — ${file}: costParts.${k} is not a zod schema`);
        claim('costParts', k, file);
        out.costParts[k] = v;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Everything that depends on the composition — one instance per family list
// ---------------------------------------------------------------------------

/** The composed faces of one instance, resolved on first parse (see `buildSchemas`). */
interface Composed {
  effect: z.ZodType<Effect>; condition: z.ZodType<Condition>; trigger: z.ZodType<TriggerEvent>; static: z.ZodType<ParsedStaticEffect>;
  asEnters: z.ZodType<AsEnters>; abilityCost: z.ZodType<AbilityCost>; amountCount: z.ZodType<AmountCount | 'objects'>; targetKind: z.ZodType<TargetSpec['kind']>;
  vocabulary: SchemaVocabulary;
}

/** The composed vocabulary of an instance: the core lists plus every family's, as the lint and `vocab:doc` read them. */
export interface SchemaVocabulary {
  /** Effect variants (`op`), core first then the families in generated order. */ effectVariants: readonly ZodObject[];
  conditionVariants: readonly ZodObject[]; triggerVariants: readonly ZodObject[]; staticVariants: readonly ZodObject[]; asEntersVariants: readonly ZodObject[];
  /** Every `Amount.count`, `objects` and the families' included. */ amountCounts: readonly string[];
  /** Every `TargetSpec.kind`, `multi` and the families' included. */ targetKinds: readonly string[];
  /** Every `AbilityCost` key, the families' cost parts included. */ costKeys: readonly string[];
  /** What the families contributed, on their own. */ families: MergedFamilySchemas;
}

/**
 * Build one complete set of schemas around `familiesOf()` — read once, on the first parse of a composed face, never
 * at construction (so the instance the tools use can be built before the generated family list has evaluated; see
 * the header). The return value is the whole public surface of this module; `composeSchemas` builds a second one
 * for tests.
 */
export function buildSchemas(familiesOf: () => readonly FamilySchemaEntry[]) {
  let cache: Composed | undefined;
  const composed = (): Composed => (cache ??= compose());

  // ---- the composed faces: one `z.lazy` each, TYPED with the widened alias of types.ts ---------------------------
  const EffectSchema: z.ZodType<Effect> = z.lazy(() => composed().effect);
  const ConditionSchema: z.ZodType<Condition> = z.lazy(() => composed().condition);
  const TriggerEventSchema: z.ZodType<TriggerEvent> = z.lazy(() => composed().trigger);
  const StaticEffectSchema: z.ZodType<ParsedStaticEffect> = z.lazy(() => composed().static);
  const AsEntersSchema: z.ZodType<AsEnters> = z.lazy(() => composed().asEnters);
  const AbilityCostSchema: z.ZodType<AbilityCost> = z.lazy(() => composed().abilityCost);
  const AmountCountSchema: z.ZodType<AmountCount | 'objects'> = z.lazy(() => composed().amountCount);
  const TargetKindSchema: z.ZodType<TargetSpec['kind']> = z.lazy(() => composed().targetKind);

  // ---- forward references, each annotated with the type it stands for so the recursive positions do not make
  // TypeScript give up on inferring the core unions — which is what keeps the Equals<> assertions honest ----------
  const FilterRef: z.ZodType<Filter> = z.lazy(() => FilterSchema);
  const TargetSpecRef: z.ZodType<TargetSpec> = z.lazy(() => TargetSpecSchema);
  const AmountRef: z.ZodType<Amount> = z.lazy(() => AmountSchema);
  const AbilityRef: z.ZodType<Ability> = z.lazy(() => AbilitySchema);
  const ConditionRef = ConditionSchema;
  const EffectRef = EffectSchema;
  const TriggerEventRef = TriggerEventSchema;

  // ---- leaves -----------------------------------------------------------------------------------------------------
  const FilterSchema = z.strictObject({
    types: z.array(CardTypeSchema).optional(),
    notTypes: z.array(CardTypeSchema).optional(),
    typesAll: z.literal(true).optional(),
    subtypes: z.array(S).optional(),
    notSubtypes: z.array(S).optional(),
    supertypes: z.array(S).optional(),
    notSupertypes: z.array(S).optional(),
    colors: z.array(ColorSchema).optional(),
    notColors: z.array(ColorSchema).optional(),
    colorless: B.optional(),
    powerLE: N.optional(), powerGE: N.optional(), toughnessLE: N.optional(),
    // `number | Amount` collapses to `Amount` (Amount already includes number)
    mvLE: AmountRef.optional(), mvGE: N.optional(), mvEQ: AmountRef.optional(),
    powerEQ: N.optional(), toughnessEQ: N.optional(), toughnessGE: N.optional(),
    tapped: B.optional(), untapped: B.optional(), token: B.optional(), nontoken: B.optional(), attacking: B.optional(),
    blocking: B.optional(), flying: B.optional(), nonbasic: B.optional(), basic: B.optional(),
    kicked: B.optional(), transformed: B.optional(), historic: B.optional(), multicolored: B.optional(), monocolored: B.optional(),
    enchanted: B.optional(), equipped: B.optional(), modified: B.optional(),
    dealtDamageBySource: B.optional(),
    attachedToSource: B.optional(),
    other: B.optional(),
    withCounters: B.optional(), withCounter: S.optional(),
    toughnessGtPower: B.optional(),
    chosenType: B.optional(),
    withKeyword: KeywordSchema.optional(),
    notKeywords: z.array(KeywordSchema).optional(),
  });

  /** A filter plus where to look and whose (`ObjectSet` in types.ts). */
  const ObjectSetSchema = FilterSchema.extend({ zone: SetZoneSchema.optional(), who: ScopeWhoSchema.optional() });

  /**
   * The object form of an `Amount` (`AmountExpr`): every field optional at the type level (the parser and the engine
   * read `a.count` / `a.plus` on one object type), exactly one FORM required at validation time — `count`, `diff`,
   * `sum`, `max` as a list, `min` or `prop`. `max` as a number is a cap on a `count` expression.
   */
  const AmountExprSchema = z.strictObject({
    count: AmountCountSchema.optional(), filter: FilterRef.optional(), zone: SetZoneSchema.optional(), who: ScopeWhoSchema.optional(),
    plus: N.optional(), times: N.optional(), counter: S.optional(), half: z.enum(['up', 'down']).optional(),
    max: z.union([N, z.array(AmountRef)]).optional(),
    diff: z.tuple([AmountRef, AmountRef]).optional(), sum: z.array(AmountRef).optional(), min: z.array(AmountRef).optional(),
    prop: z.enum(AMOUNT_PROPS).optional(), of: z.union([RefSchema, z.enum(['you', 'that-player', 'target-player'])]).optional(),
    agg: z.enum(['max', 'sum', 'min']).optional(), over: ObjectSetSchema.optional(),
  });
  const AmountSchema = z.union([
    N,
    z.literal('X'),
    AmountExprSchema.superRefine(amountRules),
  ]);

  const TargetSpecSchema = z.strictObject({
    kind: TargetKindSchema,
    controller: z.enum(['you', 'opponent']).optional(),
    filter: FilterRef.optional(),
    optional: B.optional(),
    count: z.union([N, z.literal('X')]).optional(),
    self: B.optional(),
    who: z.enum(['you', 'opponent']).optional(),
    specs: z.array(TargetSpecRef).optional(),
  }).superRefine(targetSpecRules);

  /** `TargetSpec | Ref | <literal>` — the shape most effect `target` fields use (a Ref names a bound object; composition core). */
  const targetOr = <const T extends readonly [string, ...string[]]>(extra: T) => z.union([TargetSpecRef, RefSchema, z.enum(extra)]);
  /** `TargetSpec | Ref` — an effect whose target may also be a bound object. */
  const TargetOrRef = z.union([TargetSpecRef, RefSchema]);

  /** The core `AbilityCost` fields; a family's cost parts are spread in after them by the composition. */
  const COST_SHAPE = {
    mana: ManaCostSchema.optional(),
    tap: B.optional(),
    untap: B.optional(),
    sacrificeSelf: B.optional(),
    sacrifice: FilterRef.optional(),
    discard: NUMX.optional(),
    discardSelf: B.optional(),
    energy: N.optional(),
    discardHand: B.optional(),
    payLife: N.optional(),
    removeCounters: z.strictObject({ counter: S, amount: NUMX, all: B.optional() }).optional(),
    exileFromGraveyard: NUMX.optional(),
    exileOtherFromGraveyard: z.strictObject({ count: z.union([N, z.literal('any')]), minCardTypes: N.optional() }).optional(),
    exileFromHand: z.strictObject({ filter: FilterRef, count: N }).optional(),
    returnToHand: FilterRef.optional(),
    tapUntappedCreature: FilterRef.optional(),
    tapCreaturesTotalPower: z.strictObject({ power: N, other: B.optional() }).optional(),
  };
  /** The core cost object (pinned to `CoreAbilityCost`); `AbilityCostSchema` above is the composed one, extended with every family's cost parts. */
  const CoreAbilityCostSchema = z.strictObject(COST_SHAPE);

  const AltCostSchema = z.strictObject({
    id: AltCostIdSchema,
    label: S,
    cost: AbilityCostSchema,
    condition: ConditionRef.optional(),
    from: z.enum(ALT_COST_FROM),
    exileAfter: B.optional(),
    returnToHand: B.optional(),
    timeCounters: N.optional(),
  });

  const COST_MODIFIER_VARIANTS = [
    z.strictObject({ kind: z.literal('delve') }),
    z.strictObject({ kind: z.literal('convoke') }),
    z.strictObject({ kind: z.literal('improvise') }),
    z.strictObject({ kind: z.literal('reduce'), amount: AmountRef }),
  ] as const;
  const CostModifierSchema = z.discriminatedUnion('kind', COST_MODIFIER_VARIANTS);

  const ASENTERS_VARIANTS = [
    z.strictObject({ kind: z.literal('tapped') }),
    z.strictObject({ kind: z.literal('tapped-unless'), condition: ConditionRef }),
    z.strictObject({ kind: z.literal('pay-life-or-tapped'), life: N }),
    z.strictObject({ kind: z.literal('counters'), counter: S, amount: AmountRef, condition: ConditionRef.optional() }),
    z.strictObject({ kind: z.literal('choose'), what: z.enum(['creature-type', 'color']) }),
    z.strictObject({ kind: z.literal('discard-or-graveyard'), filter: FilterRef }),
  ] as const;
  const CoreAsEntersSchema = z.discriminatedUnion('kind', ASENTERS_VARIANTS);

  // ---- conditions ----------------------------------------------------------------------------------------------------
  /** Conditions that carry no payload beyond their `kind`. */
  const NULLARY_CONDITIONS = [
    'self-entered-this-turn', 'opponent-more-lands', 'self-was-cast', 'self-in-graveyard', 'descended-this-turn',
    'threshold', 'metalcraft', 'delirium', 'kicked', 'raid', 'morbid', 'revolt', 'spell-mastery', 'ferocious',
    'formidable', 'hellbent', 'landfall-this-turn', 'not-your-turn', 'your-turn', 'escaped', 'evoked', 'cast-from-hand',
    'self-not-renowned', 'self-attacking', 'self-tapped', 'self-untapped', 'more-life-than-opponent',
    'opponent-more-life', 'you-lost-life-this-turn', 'opponent-hellbent', 'controls-commander',
    'opponent-lost-life-this-turn', 'life-gained-this-turn',
  ] as const;

  const WHO_YOU_OPP = z.enum(['you', 'opponent']);
  const WHO_YOU_OPP_ANY = z.enum(['you', 'opponent', 'any']);

  const CONDITION_VARIANTS = [
    z.strictObject({ kind: z.literal('or'), conditions: z.array(ConditionRef) }),
    z.strictObject({ kind: z.literal('self-entered-this-turn') }),
    z.strictObject({ kind: z.literal('total-toughness-ge'), value: N }),
    z.strictObject({ kind: z.literal('hand-has'), filter: FilterRef }),
    z.strictObject({ kind: z.literal('opponents-lands-ge'), value: N }),
    z.strictObject({ kind: z.literal('opponent-more-lands') }),
    z.strictObject({ kind: z.literal('spells-cast-last-turn'), who: z.enum(['none', 'any-player-ge']), value: N.optional() }),
    z.strictObject({ kind: z.literal('self-was-cast') }),
    z.strictObject({ kind: z.literal('self-is-type'), type: CardTypeSchema }),
    z.strictObject({ kind: z.literal('self-in-graveyard') }),
    z.strictObject({ kind: z.literal('self-had-counters'), counter: S }),
    z.strictObject({ kind: z.literal('life-gained-ge'), value: N }),
    z.strictObject({ kind: z.literal('descended-this-turn') }),
    z.strictObject({ kind: z.literal('unspent-mana-ge'), value: N }),
    z.strictObject({ kind: z.literal('life-le'), who: WHO_YOU_OPP_ANY, value: N }),
    z.strictObject({ kind: z.literal('opponents-ge'), value: N }),
    z.strictObject({ kind: z.literal('controls'), who: WHO_YOU_OPP, filter: FilterRef, atLeast: N }),
    z.strictObject({ kind: z.literal('cards-in-hand-ge'), who: WHO_YOU_OPP, value: N }),
    z.strictObject({ kind: z.literal('threshold') }),
    z.strictObject({ kind: z.literal('metalcraft') }),
    z.strictObject({ kind: z.literal('delirium') }),
    z.strictObject({ kind: z.literal('kicked') }),
    z.strictObject({ kind: z.literal('raid') }),
    z.strictObject({ kind: z.literal('morbid') }),
    z.strictObject({ kind: z.literal('revolt') }),
    z.strictObject({ kind: z.literal('spell-mastery') }),
    z.strictObject({ kind: z.literal('ferocious') }),
    z.strictObject({ kind: z.literal('formidable') }),
    z.strictObject({ kind: z.literal('hellbent') }),
    z.strictObject({ kind: z.literal('landfall-this-turn') }),
    z.strictObject({ kind: z.literal('domain-ge'), value: N }),
    z.strictObject({ kind: z.literal('not-your-turn') }),
    z.strictObject({ kind: z.literal('your-turn') }),
    z.strictObject({ kind: z.literal('lands-le'), value: N, other: B.optional() }),
    z.strictObject({ kind: z.literal('lands-ge'), value: N, other: B.optional() }),
    z.strictObject({ kind: z.literal('turn-le'), value: N }),
    z.strictObject({ kind: z.literal('escaped') }),
    z.strictObject({ kind: z.literal('evoked') }),
    z.strictObject({ kind: z.literal('cast-from-hand') }),
    z.strictObject({ kind: z.literal('graveyard-has-each'), filters: z.array(FilterRef) }),
    z.strictObject({ kind: z.literal('controls-each'), filters: z.array(FilterRef) }),
    z.strictObject({ kind: z.literal('self-no-counters'), counter: S }),
    z.strictObject({ kind: z.literal('self-not-renowned') }),
    z.strictObject({ kind: z.literal('self-attacking') }),
    z.strictObject({ kind: z.literal('self-tapped') }),
    z.strictObject({ kind: z.literal('self-untapped') }),
    z.strictObject({ kind: z.literal('self-has-counters'), counter: S }),
    z.strictObject({ kind: z.literal('controls-le'), who: WHO_YOU_OPP, filter: FilterRef, atMost: N }),
    z.strictObject({ kind: z.literal('life-ge'), who: WHO_YOU_OPP_ANY, value: N }),
    z.strictObject({ kind: z.literal('more-life-than-opponent') }),
    z.strictObject({ kind: z.literal('opponent-more-life') }),
    z.strictObject({ kind: z.literal('attacked-with-ge'), value: N }),
    z.strictObject({ kind: z.literal('you-lost-life-this-turn') }),
    z.strictObject({ kind: z.literal('spells-cast-this-turn-ge'), value: N }),
    z.strictObject({ kind: z.literal('cards-in-hand-le'), who: WHO_YOU_OPP, value: N }),
    z.strictObject({ kind: z.literal('opponent-hellbent') }),
    z.strictObject({ kind: z.literal('graveyard-ge'), value: N, filter: FilterRef.optional() }),
    z.strictObject({ kind: z.literal('controls-commander') }),
    z.strictObject({ kind: z.literal('cards-drawn-ge'), value: N }),
    z.strictObject({ kind: z.literal('opponent-lost-life-this-turn') }),
    z.strictObject({ kind: z.literal('life-gained-this-turn') }),
    z.strictObject({ kind: z.literal('unknown'), text: S }),
  ] as const;
  const CoreConditionSchema = z.discriminatedUnion('kind', CONDITION_VARIANTS);

  // ---- effects (every op in types.ts, parser-internal marker ops included) -------------------------------------------
  const DURATION = z.enum(['eot', 'permanent']);
  /** One side of an `exchange`: a permanent (life: a player) — `ExchangeSide` in types.ts. */
  const ExchangeSideSchema = z.union([TargetSpecRef, RefSchema, z.enum(['you', 'target-player', 'that-player', 'controller-of-that'])]);

  const EFFECT_VARIANTS = [
    z.strictObject({
      op: z.literal('damage'), amount: AmountRef,
      target: targetOr(['each-opponent', 'each-player', 'each-creature', 'each-other-creature', 'each-opponent-creature', 'each-creature-and-player', 'each-flying-creature', 'each-nonflying-creature', 'each-creature-you-dont-control']),
      divided: B.optional(), kickedAmount: AmountRef.optional(),
    }),
    z.strictObject({
      op: z.literal('destroy'),
      target: targetOr(['all-creatures', 'all-artifacts', 'all-enchantments', 'all-lands', 'all-nonland', 'all-opponent-creatures', 'all-tapped-creatures', 'enchanted']),
      noRegenerate: B.optional(), filter: FilterRef.optional(), ifTarget: FilterRef.optional(),
      ifTargetAlt: z.strictObject({ condition: ConditionRef, filter: FilterRef }).optional(),
    }),
    z.strictObject({
      op: z.literal('exile'), target: targetOr(['all-creatures']),
      from: z.enum(['graveyard', 'battlefield']).optional(), until: z.literal('leaves').optional(),
      ifTarget: FilterRef.optional(), ifTargetAlt: z.strictObject({ condition: ConditionRef, filter: FilterRef }).optional(),
    }),
    z.strictObject({ op: z.literal('counter'), target: TargetSpecRef, unlessPay: N.optional(), toExile: B.optional() }),
    z.strictObject({ op: z.literal('draw'), amount: AmountRef, who: z.enum(['you', 'target-player', 'each-player', 'opponent', 'controller', 'that-player']) }),
    z.strictObject({ op: z.literal('discard'), amount: z.union([AmountRef, z.literal('hand')]), who: z.enum(['you', 'target-player', 'each-opponent', 'each-player', 'that-player']), random: B.optional() }),
    z.strictObject({ op: z.literal('gain-life'), amount: AmountRef, who: z.enum(['you', 'target-player', 'each-player', 'that-controller', 'that-player']) }),
    z.strictObject({ op: z.literal('lose-life'), amount: AmountRef, who: z.enum(['you', 'target-player', 'each-opponent', 'each-player', 'opponent', 'that-controller', 'defending-player', 'that-player']) }),
    z.strictObject({
      op: z.literal('dig'), look: AmountRef, take: N, rest: z.enum(['bottom', 'top', 'graveyard']), order: z.enum(['any', 'random']),
      reveal: B.optional(), filter: FilterRef.optional(), optional: B.optional(),
      altTake: z.strictObject({ condition: ConditionRef, take: N }).optional(),
    }),
    z.strictObject({ op: z.literal('put-from-hand'), amount: AmountRef, to: z.enum(['library-top', 'library-bottom', 'battlefield']), filter: FilterRef.optional(), optional: B.optional(), who: z.enum(['you', 'each-player']).optional(), tapped: B.optional() }),
    z.strictObject({ op: z.literal('shuffle'), optional: B.optional(), who: z.enum(['that-player', 'target-player']).optional() }),
    z.strictObject({ op: z.literal('reveal-hand'), who: z.enum(['target-player', 'target-opponent']) }),
    z.strictObject({ op: z.literal('become-monarch') }),
    z.strictObject({ op: z.literal('return-self-to-battlefield'), counters: z.strictObject({ counter: S, amount: N }).optional() }),
    z.strictObject({ op: z.literal('evolve') }),
    z.strictObject({ op: z.literal('move-counters'), counter: S, target: TargetSpecRef }),
    z.strictObject({ op: z.literal('renown'), amount: N }),
    z.strictObject({ op: z.literal('sacrifice-unless-pay'), mana: ManaCostSchema, energy: N.optional(), once: z.literal('echo').optional(), perCounter: S.optional() }),
    z.strictObject({ op: z.literal('unearth') }),
    z.strictObject({ op: z.literal('cascade') }),
    z.strictObject({ op: z.literal('explore') }),
    z.strictObject({ op: z.literal('optional-pay'), mana: ManaCostSchema, then: z.array(EffectRef) }),
    z.strictObject({ op: z.literal('optional-then'), first: z.array(EffectRef), then: z.array(EffectRef) }),
    z.strictObject({ op: z.literal('impulse'), count: NUMX, until: z.enum(['eot', 'next-turn']) }),
    z.strictObject({ op: z.literal('return-own'), filter: FilterRef, count: N, to: z.literal('hand') }),
    z.strictObject({ op: z.literal('cant-block'), target: TargetOrRef, duration: z.literal('eot') }),
    z.strictObject({ op: z.literal('no-untap-self') }),
    z.strictObject({ op: z.literal('no-untap-that') }),
    z.strictObject({ op: z.literal('energy'), amount: AmountRef }),
    z.strictObject({ op: z.literal('poison'), amount: AmountRef, who: z.enum(['target-player', 'each-opponent', 'that-player']) }),
    z.strictObject({ op: z.literal('shuffle-self-into-library') }),
    z.strictObject({ op: z.literal('reveal-hand-discard'), who: z.enum(['target-player', 'target-opponent']), filter: FilterRef, count: z.union([z.literal(1), z.literal('all-named')]) }),
    z.strictObject({ op: z.literal('look-top'), who: z.enum(['target-player', 'you']), amount: N }),
    z.strictObject({
      op: z.literal('search'), filter: FilterRef, to: z.enum(['hand', 'battlefield', 'graveyard', 'top']), tapped: B.optional(),
      count: NUMX, optional: B.optional(), who: z.enum(['you', 'that-controller']).optional(), reveal: B.optional(),
      mvLE: AmountRef.optional(), split: z.literal('one-battlefield-rest-hand').optional(),
    }),
    z.strictObject({ op: z.literal('delayed-trigger'), at: z.enum(DELAYED_AT), effects: z.array(EffectRef), bind: z.enum(['that', 'those']).optional() }),
    z.strictObject({ op: z.literal('return-to-battlefield'), target: z.literal('that'), underControlOf: z.enum(['owner', 'you']), counterIfYours: z.enum(['that', 'self']).optional() }),
    z.strictObject({ op: z.literal('amass'), subtype: S, amount: AmountRef }),
    z.strictObject({ op: z.literal('gain-ability'), ability: AbilityRef }),
    z.strictObject({ op: z.literal('crew-self') }),
    z.strictObject({ op: z.literal('saddle-self') }),
    z.strictObject({ op: z.literal('damage-you'), amount: AmountRef }),
    // parser-internal markers folded into the previous effect (never reach the engine)
    z.strictObject({ op: z.literal('alt-if-target'), condition: ConditionRef, filter: FilterRef }),
    z.strictObject({ op: z.literal('alt-take'), condition: ConditionRef, take: N }),
    z.strictObject({ op: z.literal('fold-counter-if-yours'), on: z.enum(['that', 'self']) }),
    z.strictObject({ op: z.literal('alt-kicked-amount'), amount: AmountRef, text: S }),
    z.strictObject({ op: z.literal('fold-restriction'), restriction: z.enum(['creature-spell', 'instant-sorcery', 'chosen-type-creature', 'colorless-eldrazi']), text: S }),
    z.strictObject({ op: z.literal('fold-alt-mana'), condition: ConditionRef, mana: z.array(ManaSymbolSchema), text: S }),
    z.strictObject({ op: z.literal('exile-from-hand'), filter: FilterRef, imprint: B.optional() }),
    z.strictObject({ op: z.literal('exile-graveyard'), who: z.enum(['target-player', 'each-opponent', 'each-player']) }),
    z.strictObject({ op: z.literal('attach-to-that') }),
    z.strictObject({ op: z.literal('counter-triggering') }),
    z.strictObject({
      op: z.literal('pump'),
      target: targetOr(['creatures-you-control', 'all-creatures', 'other-creatures-you-control', 'attacking-creatures', 'other-attacking-creatures', 'all-opponent-creatures']),
      power: AmountRef, toughness: AmountRef, keywords: z.array(KeywordSchema).optional(), duration: DURATION,
    }),
    z.strictObject({ op: z.literal('grant-keyword'), target: targetOr(['creatures-you-control', 'permanents-you-control']), keywords: z.array(KeywordSchema), duration: DURATION }),
    z.strictObject({ op: z.literal('bounce'), target: targetOr(['all-creatures', 'all-nonland']), to: z.enum(['hand', 'library-top', 'library-bottom']) }),
    z.strictObject({
      op: z.literal('token'), count: AmountRef, power: N, toughness: N, colors: z.array(ColorSchema), types: z.array(CardTypeSchema),
      subtypes: z.array(S), keywords: z.array(KeywordSchema), tapped: B.optional(), attacking: B.optional(), name: S.optional(),
      text: S.optional(), treasure: B.optional(), clue: B.optional(), spawn: B.optional(), food: B.optional(), dynamicPT: AmountRef.optional(),
    }),
    z.strictObject({ op: z.literal('counters'), target: targetOr(['creatures-you-control', 'each-other-creature-you-control']), counter: S, amount: AmountRef, optional: B.optional(), filter: FilterRef.optional() }),
    z.strictObject({ op: z.literal('tap'), target: targetOr(['all-opponent-creatures', 'all-creatures']), noUntap: B.optional() }),
    z.strictObject({ op: z.literal('untap'), target: targetOr(['all-you-control', 'lands-you-control', 'creatures-you-control']) }),
    z.strictObject({ op: z.literal('sacrifice'), who: z.enum(['you', 'target-player', 'each-opponent', 'each-player']), what: FilterRef, amount: NUMX }),
    z.strictObject({ op: z.literal('sacrifice-self') }),
    z.strictObject({ op: z.literal('mill'), amount: AmountRef, who: z.enum(['you', 'target-player', 'each-opponent', 'that-player']) }),
    z.strictObject({ op: z.literal('search-land'), toBattlefield: B, tapped: B, basic: B, count: N, subtypes: z.array(S).optional() }),
    z.strictObject({
      op: z.literal('add-mana'),
      mana: z.union([z.array(ManaSymbolSchema), z.enum(['any', 'any-one', 'commander-identity', 'opponent-lands'])]),
      choices: z.array(z.array(ManaSymbolSchema)).optional(), amount: N.optional(), perEach: AmountRef.optional(), sticky: B.optional(),
      options: z.union([z.array(ManaSymbolSchema), z.enum(['exiled-with-colors', 'chosen-color', 'permanent-colors'])]).optional(),
      restriction: z.enum(['creature-spell', 'instant-sorcery', 'chosen-type-creature', 'colorless-eldrazi']).optional(),
      altIf: z.strictObject({ condition: ConditionRef, mana: z.array(ManaSymbolSchema) }).optional(),
    }),
    z.strictObject({ op: z.literal('scry'), amount: AmountRef }),
    z.strictObject({ op: z.literal('surveil'), amount: AmountRef }),
    z.strictObject({ op: z.literal('return-from-graveyard'), what: FilterRef, to: z.enum(['hand', 'battlefield', 'library-top', 'library-bottom']), target: B.optional(), anyGraveyard: B.optional(), tapped: B.optional(), count: N.optional(), optional: B.optional() }),
    z.strictObject({ op: z.literal('fight'), target: TargetSpecRef, self: B }),
    z.strictObject({ op: z.literal('bite'), target: TargetSpecRef }),
    z.strictObject({ op: z.literal('set-life'), amount: N, who: z.enum(['you', 'each-player']) }),
    z.strictObject({ op: z.literal('gain-control'), target: TargetOrRef, duration: DURATION, untapHaste: B.optional() }),
    z.strictObject({ op: z.literal('copy-spell'), target: TargetSpecRef, newTargets: B.optional() }),
    z.strictObject({
      op: z.literal('token-copy'), target: z.union([TargetSpecRef, z.enum(['that', 'self'])]), count: AmountRef, extraTypes: z.array(CardTypeSchema).optional(),
      extraSubtypes: z.array(S).optional(), extraKeywords: z.array(KeywordSchema).optional(), tapped: B.optional(),
      attacking: z.union([z.literal('each-other-opponent'), B]).optional(),
    }),
    z.strictObject({ op: z.literal('remove-those'), how: z.enum(['exile', 'sacrifice']) }),
    z.strictObject({ op: z.literal('remove-from-combat'), target: TargetOrRef, untap: B.optional() }),
    z.strictObject({ op: z.literal('play-exiled'), until: z.enum(['eot', 'next-turn']), free: B.optional() }),
    z.strictObject({ op: z.literal('extra-land'), count: N }),
    z.strictObject({ op: z.literal('exile-if-dies'), who: z.enum(['that', 'affected', 'self', 'all-creatures', 'opponent-creatures']) }),
    z.strictObject({ op: z.literal('proliferate') }),
    z.strictObject({ op: z.literal('storm-copies') }),
    z.strictObject({ op: z.literal('player-counter'), counter: S, amount: AmountRef, who: z.enum(['you', 'target-player', 'each-opponent']) }),
    z.strictObject({ op: z.literal('fold-new-targets') }),
    z.strictObject({ op: z.literal('earthbend'), amount: AmountRef, target: TargetSpecRef }),
    z.strictObject({
      op: z.literal('animate'), target: TargetOrRef, power: N, toughness: N, colors: z.array(ColorSchema),
      types: z.array(CardTypeSchema), subtypes: z.array(S), keywords: z.array(KeywordSchema), duration: DURATION,
    }),
    z.strictObject({ op: z.literal('untap-all'), filter: FilterRef }),
    z.strictObject({ op: z.literal('untap-choose'), filter: FilterRef, count: NUMX }),
    z.strictObject({ op: z.literal('double-power'), target: TargetOrRef }),
    z.strictObject({ op: z.literal('shuffle-into-library'), target: TargetOrRef }),
    z.strictObject({ op: z.literal('each-self-damage') }),
    z.strictObject({ op: z.literal('multi-counters'), target: TargetOrRef, counters: z.array(S) }),
    z.strictObject({ op: z.literal('transform-self'), viaExile: B.optional() }),
    z.strictObject({ op: z.literal('choose-mode'), modes: z.array(z.array(EffectRef)), count: N }),
    z.strictObject({ op: z.literal('conditional'), condition: ConditionRef, then: z.array(EffectRef), else: z.array(EffectRef).optional() }),
    z.strictObject({ op: z.literal('attach-self'), target: TargetSpecRef }),
    z.strictObject({ op: z.literal('regenerate'), target: TargetOrRef }),
    z.strictObject({ op: z.literal('prevent-damage'), target: targetOr(['you']), amount: z.union([AmountRef, z.literal('all')]), duration: z.literal('eot') }),
    z.strictObject({ op: z.literal('cant-attack-or-block'), target: TargetOrRef, duration: z.literal('eot') }),
    z.strictObject({ op: z.literal('extra-turn') }),
    z.strictObject({ op: z.literal('loot'), draw: NUMX, discard: NUMX, discardFirst: B.optional(), optional: B.optional() }),
    // composition core (Phase 9.0): see docs/vocabulary/composition.md
    z.strictObject({ op: z.literal('for-each'), over: z.union([ObjectSetSchema, z.enum(['those', 'targets'])]), do: z.array(EffectRef) }),
    z.strictObject({ op: z.literal('bind'), as: z.literal('that'), from: z.enum(['targets', 'affected', 'triggering']) }),
    z.strictObject({ op: z.literal('reflexive'), when: z.literal('you-do'), effects: z.array(EffectRef) }),
    z.strictObject({ op: z.literal('scoped'), who: ScopeWhoSchema, do: z.array(EffectRef) }),
    z.strictObject({ op: z.literal('may'), effects: z.array(EffectRef), prompt: S.optional() }),
    z.strictObject({ op: z.literal('unless-pays'), who: ScopeWhoSchema, cost: AbilityCostSchema, otherwise: z.array(EffectRef), otherwiseAs: z.literal('controller').optional() }),
    z.strictObject({
      op: z.literal('move'),
      what: z.union([TargetSpecRef, RefSchema, z.strictObject({ filter: FilterRef, zone: SetZoneSchema, who: ScopeWhoSchema, count: z.union([AmountRef, z.literal('all')]), choose: z.enum(['you', 'owner', 'random']).optional() })]),
      to: z.enum(MOVE_ZONES), pos: z.enum(['top', 'bottom']).optional(), controller: z.enum(['you', 'owner', 'that-player', 'target-player']).optional(),
      tapped: B.optional(), faceDown: B.optional(), withCounters: z.strictObject({ counter: S, amount: AmountRef }).optional(), until: z.enum(['leaves', 'eot', 'your-next-end-step']).optional(),
    }),
    z.strictObject({ op: z.literal('set-pt'), target: z.union([TargetSpecRef, RefSchema, z.enum(['creatures-you-control', 'all-creatures'])]), power: AmountRef, toughness: AmountRef, base: z.literal(true).optional(), duration: DURATION }),
    z.strictObject({ op: z.literal('lose-abilities'), target: z.union([TargetSpecRef, RefSchema, z.enum(['creatures-you-control', 'all-creatures'])]), keywords: z.union([z.array(KeywordSchema), z.literal('all')]).optional(), duration: DURATION }),
    z.strictObject({ op: z.literal('exchange'), what: z.enum(['life', 'control']), a: ExchangeSideSchema, b: ExchangeSideSchema }),
    z.strictObject({ op: z.literal('unknown'), text: S }),
  ] as const;
  const CoreEffectSchema = z.discriminatedUnion('op', EFFECT_VARIANTS);

  // ---- trigger events ------------------------------------------------------------------------------------------------
  const TRIGGER_VARIANTS = [
    z.strictObject({ on: z.literal('etb'), self: B, filter: FilterRef.optional(), controller: z.enum(['you', 'any', 'opponent']).optional() }),
    z.strictObject({ on: z.literal('dies'), self: B, filter: FilterRef.optional(), controller: z.enum(['you', 'any', 'opponent']).optional() }),
    z.strictObject({ on: z.literal('ltb'), self: B }),
    z.strictObject({ on: z.literal('attacks'), self: B, filter: FilterRef.optional() }),
    z.strictObject({ on: z.literal('you-attack') }),
    z.strictObject({ on: z.literal('turned-face-up'), self: B }),
    z.strictObject({ on: z.literal('blocks'), self: B }),
    z.strictObject({ on: z.literal('becomes-blocked'), self: B }),
    z.strictObject({ on: z.literal('combat-damage-player'), self: B, filter: FilterRef.optional() }),
    z.strictObject({ on: z.literal('deals-damage'), self: B }),
    z.strictObject({ on: z.literal('upkeep'), whose: z.enum(['your', 'each', 'opponent']) }),
    z.strictObject({ on: z.literal('end-step'), whose: z.enum(['your', 'each']) }),
    z.strictObject({ on: z.literal('draw-step'), whose: z.literal('your') }),
    z.strictObject({ on: z.literal('combat-begin'), whose: z.literal('your') }),
    z.strictObject({ on: z.literal('cast'), filter: FilterRef, who: z.enum(['you', 'opponent', 'any']), nth: N.optional(), mvEqualsCounter: S.optional() }),
    z.strictObject({ on: z.literal('landfall'), played: B.optional(), other: B.optional() }),
    z.strictObject({ on: z.literal('draw'), who: WHO_YOU_OPP, exceptFirstInDrawStep: B.optional(), nth: N.optional() }),
    z.strictObject({ on: z.literal('chapter'), chapters: z.array(N) }),
    z.strictObject({ on: z.literal('leaves-graveyard'), filter: FilterRef.optional() }),
    z.strictObject({ on: z.literal('or'), events: z.array(TriggerEventRef) }),
    z.strictObject({ on: z.literal('life-gain') }),
    z.strictObject({ on: z.literal('life-loss-opponent') }),
    z.strictObject({ on: z.literal('sacrifice'), filter: FilterRef.optional() }),
    z.strictObject({ on: z.literal('tapped'), self: B }),
    z.strictObject({ on: z.literal('targeted'), self: B, bySpellYouCast: B.optional(), filter: FilterRef.optional() }),
    z.strictObject({ on: z.literal('discard'), filter: FilterRef.optional() }),
    z.strictObject({ on: z.literal('end-of-turn') }),
    z.strictObject({ on: z.literal('reflexive') }),
    z.strictObject({ on: z.literal('unknown'), text: S }),
  ] as const;
  const CoreTriggerEventSchema = z.discriminatedUnion('on', TRIGGER_VARIANTS);

  // ---- static effects ------------------------------------------------------------------------------------------------
  const STATIC_VARIANTS = [
    z.strictObject({
      kind: z.literal('anthem'), power: N, toughness: N, filter: FilterRef, scope: z.enum(['you-control', 'all', 'other-you-control']),
      keywords: z.array(KeywordSchema).optional(), condition: ConditionRef.optional(), anyPermanent: B.optional(),
      whileInGraveyard: B.optional(), landwalk: z.array(S).optional(),
      opponentsOnly: B.optional(),   // parser extension (characteristics.ts:175)
    }),
    z.strictObject({ kind: z.literal('damage-by-toughness'), scope: z.enum(['self', 'you-control']), onlyWhenGreater: B.optional() }),
    z.strictObject({ kind: z.literal('flash-for'), filter: FilterRef }),
    z.strictObject({ kind: z.literal('trigger-twice'), equipped: B.optional(), event: z.enum(['etb', 'dies', 'land-etb', 'cast']).optional(), filter: FilterRef.optional() }),
    z.strictObject({ kind: z.literal('counters-replacement'), mode: z.enum(['double', 'plus-one']), filter: FilterRef.optional(), counter: S.optional() }),
    z.strictObject({ kind: z.literal('tokens-replacement'), mode: z.literal('double') }),
    z.strictObject({ kind: z.literal('extra-mana-on-tap'), filter: FilterRef.optional(), enchanted: B.optional(), mana: z.union([z.array(ManaSymbolSchema), z.literal('chosen-color')]) }),
    z.strictObject({ kind: z.literal('grant-mana-ability'), filter: FilterRef.optional(), enchanted: B.optional(), effect: EffectRef }),
    z.strictObject({ kind: z.literal('grant-ability'), filter: FilterRef.optional(), enchanted: B.optional(), scope: z.enum(['you-control', 'all']), ability: AbilityRef }),
    z.strictObject({ kind: z.literal('opponents-cant-cast'), during: z.literal('your-turn'), filter: FilterRef.optional() }),
    z.strictObject({ kind: z.literal('play-lands-from'), zone: z.enum(['graveyard', 'library-top']) }),
    z.strictObject({ kind: z.literal('unspent-mana-becomes-red') }),
    z.strictObject({ kind: z.literal('self-pt'), power: AmountRef, toughness: AmountRef, condition: ConditionRef.optional() }),
    z.strictObject({ kind: z.literal('set-pt'), power: N, toughness: N, scope: z.enum(['enchanted', 'equipped', 'self', 'you-control', 'all']), filter: FilterRef.optional(), keywords: z.array(KeywordSchema).optional() }),
    z.strictObject({
      kind: z.literal('self-keywords'), keywords: z.array(KeywordSchema), condition: ConditionRef.optional(), cantBlock: B.optional(),
      // parser extensions (characteristics.ts:184/344-346, game.ts:1754)
      mustAttack: B.optional(), doesntUntap: B.optional(), blockOnlyFlying: B.optional(), evasion: FilterRef.optional(),
    }),
    z.strictObject({ kind: z.literal('can-be-commander') }),
    z.strictObject({ kind: z.literal('look-top-anytime') }),
    z.strictObject({ kind: z.literal('may-not-untap') }),
    z.strictObject({ kind: z.literal('no-max-hand-size') }),
    z.strictObject({ kind: z.literal('cant-attack-unless-defender-controls'), filter: FilterRef }),
    z.strictObject({ kind: z.literal('extra-blocks'), amount: N }),
    z.strictObject({ kind: z.literal('cant-be-blocked-by-more-than-one') }),
    z.strictObject({
      kind: z.literal('aura'), power: N, toughness: N, keywords: z.array(KeywordSchema).optional(), cantAttackOrBlock: B.optional(),
      cantAttack: B.optional(), cantBlock: B.optional(), doesntUntap: B.optional(), enchant: TargetSpecRef,
      controlEnchanted: B.optional(), text: S.optional(),
    }),
    z.strictObject({ kind: z.literal('equipment'), power: N, toughness: N, keywords: z.array(KeywordSchema).optional(), equipCost: ManaCostSchema, equipFilter: FilterRef.optional() }),
    z.strictObject({ kind: z.literal('cost-adjust'), filter: FilterRef, amount: N, who: z.enum(['you', 'opponent', 'any']), from: z.literal('non-hand').optional() }),
    z.strictObject({ kind: z.literal('opponent-creatures-etb-tapped') }),
    z.strictObject({ kind: z.literal('extra-land'), amount: N }),
    z.strictObject({ kind: z.literal('cant-be-countered') }),
    z.strictObject({ kind: z.literal('lifegain-multiplier'), plus: N.optional() }),
    z.strictObject({ kind: z.literal('unknown'), text: S }),
  ] as const;
  const CoreStaticEffectSchema = z.discriminatedUnion('kind', STATIC_VARIANTS);

  // ---- abilities -----------------------------------------------------------------------------------------------------
  const TriggeredAbilitySchema = z.strictObject({
    kind: z.literal('triggered'), event: TriggerEventRef, effects: z.array(EffectRef), condition: ConditionRef.optional(),
    optional: B.optional(), text: S, intervening: ConditionRef.optional(), oncePerTurn: B.optional(),
  });
  const ActivatedAbilitySchema = z.strictObject({
    kind: z.literal('activated'), cost: AbilityCostSchema, effects: z.array(EffectRef), text: S, sorcerySpeed: B.optional(),
    loyalty: N.optional(), oncePerTurn: B.optional(), manaAbility: B.optional(), activateOnlyIf: ConditionRef.optional(),
    instantSpeed: B.optional(), fromGraveyard: B.optional(),
  });
  const StaticAbilitySchema = z.strictObject({ kind: z.literal('static'), effect: StaticEffectSchema, text: S });
  const SpellAbilitySchema = z.strictObject({ kind: z.literal('spell'), effects: z.array(EffectRef), text: S });

  const ABILITY_VARIANTS = [TriggeredAbilitySchema, ActivatedAbilitySchema, StaticAbilitySchema, SpellAbilitySchema] as const;
  const AbilitySchema = z.discriminatedUnion('kind', ABILITY_VARIANTS);

  /**
   * The ability schema a SCRIPT is held to: identical to `AbilitySchema` except that a `spell` / `triggered` /
   * `activated` ability must declare at least one effect. An ability with an empty `effects` array claims no oracle
   * line (`abilityIsSubstantive` in scripts.ts), so a file full of them would otherwise be a card with the right texts
   * and no behaviour at all.
   *
   * `AbilitySchema` itself stays LENIENT because it also validates the PARSER's output, and the parser emits 56
   * empty-effect abilities over the 34,513-card pool (Populate, Manifest dread, Amass, "The Ring tempts you", …).
   * `.min(1)` does not change the inferred type, so both schemas stay pinned to `ParsedAbility` / `Ability`.
   */
  const NEEDS_EFFECT = 'ability declares no effect';
  const SCRIPT_ABILITY_VARIANTS = [
    TriggeredAbilitySchema.extend({ effects: z.array(EffectRef).min(1, NEEDS_EFFECT) }),
    ActivatedAbilitySchema.extend({ effects: z.array(EffectRef).min(1, NEEDS_EFFECT) }),
    StaticAbilitySchema,
    SpellAbilitySchema.extend({ effects: z.array(EffectRef).min(1, NEEDS_EFFECT) }),
  ] as const;
  const ScriptAbilitySchema = z.discriminatedUnion('kind', SCRIPT_ABILITY_VARIANTS);
  const ScriptAbilityRef: z.ZodType<Ability> = z.lazy(() => ScriptAbilitySchema);

  // ---- card script v2 ------------------------------------------------------------------------------------------------
  const SCRIPT_SOURCES = ['generated', 'llm', 'reviewed', 'hand'] as const;
  const ScriptSourceSchema = z.enum(SCRIPT_SOURCES);
  const IgnoreReasonSchema = z.enum(IGNORE_REASONS);

  /**
   * A claimed oracle line. Format v2 has no wildcard: `'*'` is rejected here (as a `pattern`, so it survives into
   * `schema.json` and an editor rejects it too) and every claimed line is written out in full.
   */
  const CLAIMED_LINE = z.string().min(1).regex(/^(?!\*$)/, "'*' is not a line: list the oracle lines this face claims");

  /**
   * A `covers` entry: the line, plus the NAME of the declaration on this face that accounts for it. There is no
   * anonymous budget — `coverProblem` (scripts.ts) checks that the named declaration is really on the face and that the
   * line has the shape that declaration produces, so N throwaway keywords buy nothing.
   */
  const CoverKindSchema = z.enum(COVER_KINDS);
  const CoverEntrySchema = z.strictObject({ line: CLAIMED_LINE, by: CoverKindSchema });

  /**
   * The shared shape of the front face, `backFace` and `secondFace`. It carries every non-ability declaration
   * `CardDef` does (kicker, cycling, morph, cascade, …), so the script format can express everything the parser can
   * and every `covers` kind has a field to name.
   */
  const faceShape = {
    keywords: z.array(KeywordSchema).optional(),
    abilities: z.array(ScriptAbilityRef).optional(),
    altCosts: z.array(AltCostSchema).optional(),
    asEnters: z.array(AsEntersSchema).optional(),
    costModifiers: z.array(CostModifierSchema).optional(),
    additionalCosts: z.array(AbilityCostSchema).optional(),
    kicker: ManaCostSchema.optional(),
    cycling: ManaCostSchema.optional(),
    cyclingSearch: FilterRef.optional(),
    entersTapped: z.union([B, z.strictObject({ unless: ConditionRef })]).optional(),
    morph: z.strictObject({ cost: ManaCostSchema, megamorph: B.optional(), disguise: B.optional() }).optional(),
    cascade: B.optional(),
    storm: B.optional(),
    rebound: B.optional(),
    dredge: N.optional(),
    graveyardReplacement: z.enum(['exile', 'shuffle']).optional(),
    protectionFrom: z.array(S).optional(),
    wardCost: N.optional(),
    toxic: N.optional(),
    bushido: N.optional(),
    rampage: N.optional(),
    landwalk: z.array(S).optional(),
    firebending: N.optional(),
    covers: z.array(CoverEntrySchema).optional(),
  };

  const ScriptFaceSchema = z.strictObject(faceShape);

  const IgnoredLineSchema = z.strictObject({ line: CLAIMED_LINE, reason: IgnoreReasonSchema });

  const VerificationSchema = z.strictObject({
    at: S,
    parserVersion: N,
    registryHash: S,
    oracleHash: S,
    scriptHash: S,
    schema: z.enum(['ok', 'fail']),
    lint: z.enum(['ok', 'warn', 'fail']),
    sandbox: z.strictObject({
      seats2: z.enum(['ok', 'throws', 'invariant', 'unreachable']),
      seats4: z.enum(['ok', 'throws', 'invariant', 'unreachable']),
      abilities: z.array(z.strictObject({ index: N, reached: B, how: S.optional() })),
    }),
    roundTrip: z.strictObject({ score: N, lowest: z.array(z.strictObject({ text: S, rendered: S, score: N })) }),
    // `sampled: false` = the wave drew no blind scenario for this card (absent = sampled; `true` is never written)
    scenarios: z.strictObject({ file: S, passed: N, failed: N, names: z.array(S), sampled: z.literal(false).optional() }),
    judge: z.array(z.strictObject({ model: S, verdict: z.enum(['faithful', 'unfaithful', 'uncertain']), issues: z.array(S), at: S })).optional(),
    status: z.enum(['scripted', 'verified', 'tested', 'judged']),
    problems: z.array(S),
  });

  const CardScriptSchema = z.strictObject({
    ...faceShape,
    oracleId: S,
    name: S,
    oracleHash: S,
    source: ScriptSourceSchema,
    confidence: N.optional(),
    mode: z.enum(['replace', 'extend']).optional(),
    backFace: ScriptFaceSchema.optional(),
    secondFace: ScriptFaceSchema.optional(),
    ignore: z.array(IgnoredLineSchema).optional(),
    scenarios: z.array(S).optional(),
    aiHints: z.strictObject({ role: S.optional(), value: N.optional(), timing: z.enum(['main', 'instant', 'end-step', 'response']).optional() }).optional(),
    notes: S.optional(),
    verification: VerificationSchema.optional(),
  });

  const CardScriptChecked = CardScriptSchema.superRefine((s, ctx) => {
    const faces = [['covers', s as { covers?: unknown[] }], ['backFace', s.backFace], ['secondFace', s.secondFace]] as const;
    for (const [where, face] of faces) {
      if (coversValid(face as never)) continue;
      const path = where === 'covers' ? ['covers'] : [where, 'covers'];
      for (const why of coverProblems(face as never)) ctx.addIssue({ code: 'custom', message: `a covers entry ${why}`, path });
    }
    for (const [where, face] of faces) {
      const abilities = (face as { abilities?: unknown[] } | undefined)?.abilities;
      if (!Array.isArray(abilities)) continue;
      abilities.forEach((ab, i) => {
        const effects = (ab as { effects?: unknown } | null)?.effects;
        if (!Array.isArray(effects)) return;
        const problems: NestingProblem[] = [];
        nestingProblems(effects, 0, [...(where === 'covers' ? [] : [where]), 'abilities', i, 'effects'], problems);
        for (const p of problems) ctx.addIssue({ code: 'custom', message: p.message, path: p.path });
      });
    }
  });

  // ---- the composition ---------------------------------------------------------------------------------------------
  /** The literals the core owns — what `mergeFamilySchemas` refuses to let a family redeclare. */
  const CORE_VOCABULARY: CoreVocabulary = {
    effects: literalsOf(EFFECT_VARIANTS, 'op'), conditions: literalsOf(CONDITION_VARIANTS, 'kind'), triggers: literalsOf(TRIGGER_VARIANTS, 'on'),
    statics: literalsOf(STATIC_VARIANTS, 'kind'), asEnters: literalsOf(ASENTERS_VARIANTS, 'kind'),
    amounts: [...AMOUNT_COUNTS, 'objects'], targetKinds: [...TARGET_KINDS, 'multi'], costParts: Object.keys(COST_SHAPE),
  };
  /** `z.discriminatedUnion(key, [...core, ...family])`, typed as the widened alias (the family half has no static type here). */
  const union = <T>(key: string, core: readonly ZodObject[], family: readonly ZodObject[]): z.ZodType<T> =>
    z.discriminatedUnion(key, [...core, ...family] as unknown as [ZodObject, ...ZodObject[]]) as unknown as z.ZodType<T>;
  function compose(): Composed {
    const families = mergeFamilySchemas(familiesOf(), CORE_VOCABULARY);
    const amountCounts = [...CORE_VOCABULARY.amounts, ...families.amounts];
    const targetKinds = [...CORE_VOCABULARY.targetKinds, ...families.targetKinds];
    // a cost carries only the parts it uses (`AbilityCostExt` declares every family part `?:`), so each family part is optional here whatever the family wrote
    const costShape = { ...COST_SHAPE, ...Object.fromEntries(Object.entries(families.costParts).map(([k, v]) => [k, v.optional()])) };
    return {
      effect: union<Effect>('op', EFFECT_VARIANTS, families.effects),
      condition: union<Condition>('kind', CONDITION_VARIANTS, families.conditions),
      trigger: union<TriggerEvent>('on', TRIGGER_VARIANTS, families.triggers),
      static: union<ParsedStaticEffect>('kind', STATIC_VARIANTS, families.statics),
      asEnters: union<AsEnters>('kind', ASENTERS_VARIANTS, families.asEnters),
      abilityCost: z.strictObject(costShape) as unknown as z.ZodType<AbilityCost>,
      amountCount: z.enum(amountCounts) as unknown as z.ZodType<AmountCount | 'objects'>,
      targetKind: z.enum(targetKinds) as unknown as z.ZodType<TargetSpec['kind']>,
      vocabulary: {
        effectVariants: [...EFFECT_VARIANTS, ...families.effects], conditionVariants: [...CONDITION_VARIANTS, ...families.conditions],
        triggerVariants: [...TRIGGER_VARIANTS, ...families.triggers], staticVariants: [...STATIC_VARIANTS, ...families.statics],
        asEntersVariants: [...ASENTERS_VARIANTS, ...families.asEnters], amountCounts, targetKinds, costKeys: Object.keys(costShape), families,
      },
    };
  }
  /** The composed vocabulary (forces the composition). */
  const vocabulary = (): SchemaVocabulary => composed().vocabulary;

  return {
    // leaves
    FilterSchema, ObjectSetSchema, AmountExprSchema, AmountSchema, TargetSpecSchema,
    CoreAbilityCostSchema, AbilityCostSchema, AltCostSchema, COST_MODIFIER_VARIANTS, CostModifierSchema,
    // unions: the core face (eager, pinned) and the composed face (lazy, what the scripts are validated against)
    ASENTERS_VARIANTS, CoreAsEntersSchema, AsEntersSchema,
    CONDITION_VARIANTS, CoreConditionSchema, ConditionSchema,
    EFFECT_VARIANTS, CoreEffectSchema, EffectSchema,
    TRIGGER_VARIANTS, CoreTriggerEventSchema, TriggerEventSchema,
    STATIC_VARIANTS, CoreStaticEffectSchema, StaticEffectSchema,
    // abilities
    TriggeredAbilitySchema, ActivatedAbilitySchema, StaticAbilitySchema, SpellAbilitySchema, ABILITY_VARIANTS, AbilitySchema,
    SCRIPT_ABILITY_VARIANTS, ScriptAbilitySchema,
    // card script v2
    SCRIPT_SOURCES, ScriptSourceSchema, IgnoreReasonSchema, CoverKindSchema, CoverEntrySchema, ScriptFaceSchema, IgnoredLineSchema,
    VerificationSchema, CardScriptSchema, CardScriptChecked,
    // the composition itself
    CORE_VOCABULARY, vocabulary,
  };
}

/** Everything `buildSchemas` returns — the shape of `composeSchemas(...)` and of this module's exports. */
export type Schemas = ReturnType<typeof buildSchemas>;

// ---------------------------------------------------------------------------
// The instance the tools use. Its family list is INSTALLED by src/cards/schema.ts (the public module) from the
// generated ./_schemas.ts; until then a parse throws, so importing this file directly cannot silently validate
// against a family-less vocabulary.
// ---------------------------------------------------------------------------

let installed: (() => readonly FamilySchemaEntry[]) | undefined;
/** Called once by src/cards/schema.ts with the generated family list (a thunk: it is read on the first parse, not now). */
export function installFamilySchemas(familiesOf: () => readonly FamilySchemaEntry[]): void { installed = familiesOf; }

const MAIN = buildSchemas(() => {
  if (!installed) throw new Error('src/cards/schema-core.ts — the family schemas were never installed: import src/cards/schema.js, not schema-core.js');
  return installed();
});

/**
 * A complete second set of schemas composed around `families` — an in-memory `FamilySchema` in a test, or the
 * generated list plus one. Independent of the instance the tools use (a `z.lazy` cannot be re-composed once it has
 * resolved, so registering into the live instance is not offered).
 */
export function composeSchemas(families: readonly FamilySchemaEntry[]): Schemas { return buildSchemas(() => families); }

/** The composed vocabulary the tools validate against: the core lists plus every generated family's. */
export const schemaVocabulary = MAIN.vocabulary;
/** The literals the core owns (per slot) — what the generated barrel hands `mergeFamilySchemas`. */
export const CORE_VOCABULARY = MAIN.CORE_VOCABULARY;

export const {
  FilterSchema, ObjectSetSchema, AmountExprSchema, AmountSchema, TargetSpecSchema,
  CoreAbilityCostSchema, AbilityCostSchema, AltCostSchema, COST_MODIFIER_VARIANTS, CostModifierSchema,
  ASENTERS_VARIANTS, CoreAsEntersSchema, AsEntersSchema,
  CONDITION_VARIANTS, CoreConditionSchema, ConditionSchema,
  EFFECT_VARIANTS, CoreEffectSchema, EffectSchema,
  TRIGGER_VARIANTS, CoreTriggerEventSchema, TriggerEventSchema,
  STATIC_VARIANTS, CoreStaticEffectSchema, StaticEffectSchema,
  TriggeredAbilitySchema, ActivatedAbilitySchema, StaticAbilitySchema, SpellAbilitySchema, ABILITY_VARIANTS, AbilitySchema,
  SCRIPT_ABILITY_VARIANTS, ScriptAbilitySchema,
  SCRIPT_SOURCES, ScriptSourceSchema, IgnoreReasonSchema, CoverKindSchema, CoverEntrySchema, ScriptFaceSchema, IgnoredLineSchema,
  VerificationSchema, CardScriptSchema, CardScriptChecked,
} = MAIN;

/**
 * The composition containers key the targets of their nested effects by `childIndex` (src/engine/legal.ts): past
 * `NESTING_LIMIT` levels or `LIST_LIMIT` effects in one of their lists two effects would share one target list, so
 * the script is rejected here with the offending list's path. Every nested effect list is walked — the older
 * containers (`conditional`, `optional-then`, …) and a `gain-ability` do not spend a level, but what is inside them may.
 */
const COMPOSITION_LISTS: Record<string, string> = { 'for-each': 'do', scoped: 'do', may: 'effects', 'unless-pays': 'otherwise' };
interface NestingProblem { path: (string | number)[]; message: string }
const isOpObject = (x: unknown): boolean => !!x && typeof x === 'object' && !Array.isArray(x) && 'op' in (x as object);
/** How many targeting effects an older container's lists hold, through further older containers — they all run under the container's index and share ONE target list (a composition container inside keys its own children apart, so its subtree is not counted). */
const sharedTargeting = (e: Effect): number => sharedLists(e).flat().filter(isOpObject).reduce((n, c) => n + (ownTargetSpecs(c).length ? 1 : 0) + sharedTargeting(c), 0);
function nestingProblems(list: unknown[], depth: number, path: (string | number)[], out: NestingProblem[]): void {
  list.forEach((e, i) => {
    if (!isOpObject(e)) return;
    const op = String((e as { op: unknown }).op); const keyed = COMPOSITION_LISTS[op];
    const shared = sharedTargeting(e as Effect);   // a second targeting child would overwrite the first's picks (CR 115.1)
    if (shared > 1) out.push({ path: [...path, i], message: `the children of ${op} share one target list and ${shared} of them target: key them apart with a composition container or split the effect` });
    const walk = (v: unknown, p: (string | number)[], level: number): void => {
      if (Array.isArray(v)) {
        if (v.length && v.every(isOpObject)) {
          if (level > depth) {
            if (v.length > LIST_LIMIT) out.push({ path: p, message: `a ${op} list holds at most ${LIST_LIMIT} effects (composition containers key nested targets by position)` });
            if (level > NESTING_LIMIT) { out.push({ path: p, message: `composition containers nest at most ${NESTING_LIMIT} deep` }); return; }
          }
          nestingProblems(v, level, p, out); return;
        }
        v.forEach((x, j) => walk(x, [...p, j], level)); return;
      }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...p, k], level);
    };
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) walk(v, [...path, i, k], keyed === k ? depth + 1 : depth);
  });
}

// Convenience aliases for the tooling (test/schema-types.test.ts pins each of these to its types.ts counterpart).
export type SchemaEffect = z.infer<typeof EffectSchema>;
export type SchemaAbility = z.infer<typeof AbilitySchema>;
export type SchemaCardScript = z.infer<typeof CardScriptSchema>;
