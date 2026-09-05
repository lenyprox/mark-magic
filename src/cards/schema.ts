// Runtime (zod) mirror of the ability AST in `types.ts` plus the v2 card-script format.
//
// TOOLING ONLY. Nothing under src/engine, src/sim, src/ai or apps/web may import this file: zod is a devDependency
// and must never reach the game or the web bundle. `scripts:check`, `scripts:verify`, `scripts:schema` and the tests
// are the only consumers.
//
// The schemas are STRICT (`z.strictObject`): a typo'd field is a validation error, which is the whole point — an
// LLM-written script must not silently lose a clause to a misspelt key.
//
// `test/schema-types.test.ts` pins every union to its TypeScript counterpart with a compile-time `Equals<>`
// assertion, so a variant added to `types.ts` and forgotten here fails `npm run typecheck:all`.
//
// Shape for phase 8a-1 (registries + declaration merging): every union is exported both as a `*_VARIANTS` array and
// as the composed discriminated union, and every enum a registry will widen (Keyword, TargetSpec.kind,
// Amount.count, AltCost.id, AltCost.from) lives in exactly one named constant, so merging is a one-line edit.
import { z } from 'zod';
import type { Ability, Amount, Condition, Effect, Filter, StaticAbility, StaticEffect, TriggerEvent } from './types.js';
import { COVER_KINDS, coversValid, IGNORE_REASONS } from './scripts.js';

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
//     `ParsedStaticEffect` / `ParsedAbility` below — which `Extract` them from `StaticEffect` and add only the six
//     extra fields, so every field types.ts declares on them stays pinned. Those six NAMES are the whole hole.
//
// Everything else is pinned against types.ts exactly. 8a-1 does not touch this block.
// ---------------------------------------------------------------------------

/** Homomorphic field override: optional/readonly modifiers of `T` are preserved. */
type Replace<T, R> = { [K in keyof T]: K extends keyof R ? R[K] : T[K] };

/** Flattens an intersection back into one object type (homomorphic, so `?` modifiers survive) — `Equals<>` needs it. */
type Simplify<T> = { [K in keyof T]: T[K] };

/** One member of `StaticEffect`, selected by its discriminant, so types.ts stays its single declaration. */
type StaticVariant<K extends StaticEffect['kind']> = Extract<StaticEffect, { kind: K }>;

/**
 * The three static-effect variants parse.ts extends past types.ts. Each is `Extract`ed from `StaticEffect` and only
 * the extra FIELDS are added here, so every field types.ts declares on them stays pinned: retype or drop
 * `anthem.scope` or `self-keywords.cantBlock` in types.ts and `typecheck:all` fails, exactly as for a normal
 * variant. Everything else is `Exclude`d straight out of `StaticEffect`, so adding or removing a whole variant
 * breaks the assertion too. The six field names listed below are the entire hole.
 */
export type ParsedStaticEffect =
  | Simplify<StaticVariant<'anthem'> & { opponentsOnly?: boolean }>
  | Simplify<StaticVariant<'self-pt'> & { condition?: Condition }>
  | Simplify<StaticVariant<'self-keywords'> & { mustAttack?: boolean; doesntUntap?: boolean; blockOnlyFlying?: boolean; evasion?: Filter }>
  | Exclude<StaticEffect, { kind: 'anthem' | 'self-pt' | 'self-keywords' }>;

/** `Ability` with the widened static effect; the other three members are taken from types.ts unchanged. */
export type ParsedAbility =
  | Extract<Ability, { kind: 'triggered' }>
  | Extract<Ability, { kind: 'activated' }>
  | Replace<StaticAbility, { effect: ParsedStaticEffect }>
  | Extract<Ability, { kind: 'spell' }>;

// ---------------------------------------------------------------------------
// Enums a registry will widen (one named constant each — 8a-1 edits only these)
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

export const ALT_COST_IDS = ['pitch', 'life', 'evoke', 'warp', 'impending', 'flashback', 'escape', 'jump-start', 'from-graveyard', 'buyback', 'dash', 'morph'] as const;
/** 8a-1 widens this to the full `CastZone`. */
export const ALT_COST_FROM = ['hand', 'graveyard'] as const;

export const CardTypeSchema = z.enum(CARD_TYPES);
export const ColorSchema = z.enum(COLOR_LETTERS);
export const ManaSymbolSchema = z.enum(MANA_SYMBOLS);
export const KeywordSchema = z.enum(KEYWORDS);

const B = z.boolean();
const N = z.number();
const S = z.string();
/**
 * A slot types.ts declares `number` and parse.ts also writes the literal `'X'` into (`num(...) as number`).
 * Typed `number` so the AST types stay exactly pinned; validated leniently so the parser's own output passes.
 */
const NUMX = z.custom<number>(v => typeof v === 'number' || v === 'X', { message: 'expected a number (or the parser literal "X")' });

// ---------------------------------------------------------------------------
// Forward references. Each is annotated with the TypeScript type it stands for, so the recursive positions do not
// make TypeScript give up on inferring the composed unions — which is what keeps the Equals<> assertions honest.
// ---------------------------------------------------------------------------

const FilterRef: z.ZodType<Filter> = z.lazy(() => FilterSchema);
const AmountRef: z.ZodType<Amount> = z.lazy(() => AmountSchema);
const ConditionRef: z.ZodType<Condition> = z.lazy(() => ConditionSchema);
const EffectRef: z.ZodType<Effect> = z.lazy(() => EffectSchema);
const AbilityRef: z.ZodType<Ability> = z.lazy(() => AbilitySchema);
const TriggerEventRef: z.ZodType<TriggerEvent> = z.lazy(() => TriggerEventSchema);

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

export const ManaCostSchema = z.strictObject({
  generic: N, x: N, pips: z.array(ManaSymbolSchema), hybrid: z.array(z.array(ManaSymbolSchema)), phyrexian: z.array(ColorSchema), raw: S,
});

export const FilterSchema = z.strictObject({
  types: z.array(CardTypeSchema).optional(),
  notTypes: z.array(CardTypeSchema).optional(),
  subtypes: z.array(S).optional(),
  colors: z.array(ColorSchema).optional(),
  notColors: z.array(ColorSchema).optional(),
  colorless: B.optional(),
  powerLE: N.optional(), powerGE: N.optional(), toughnessLE: N.optional(),
  // `number | Amount` collapses to `Amount` (Amount already includes number)
  mvLE: AmountRef.optional(), mvGE: N.optional(), mvEQ: AmountRef.optional(),
  tapped: B.optional(), untapped: B.optional(), token: B.optional(), nontoken: B.optional(), attacking: B.optional(),
  blocking: B.optional(), flying: B.optional(), nonbasic: B.optional(), basic: B.optional(),
  other: B.optional(),
  withCounters: B.optional(), withCounter: S.optional(),
  toughnessGtPower: B.optional(),
  chosenType: B.optional(),
  withKeyword: KeywordSchema.optional(),
});

export const AmountSchema = z.union([
  N,
  z.literal('X'),
  z.strictObject({ count: z.enum(AMOUNT_COUNTS), filter: FilterRef.optional(), plus: N.optional(), times: N.optional(), counter: S.optional() }),
]);

export const TargetSpecSchema = z.strictObject({
  kind: z.enum(TARGET_KINDS),
  controller: z.enum(['you', 'opponent']).optional(),
  filter: FilterRef.optional(),
  optional: B.optional(),
  count: N.optional(),
  self: B.optional(),
});

/** `TargetSpec | <literal>` — the shape most effect `target` fields use. */
const targetOr = <const T extends readonly [string, ...string[]]>(extra: T) => z.union([TargetSpecSchema, z.enum(extra)]);

export const AbilityCostSchema = z.strictObject({
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
  removeCounters: z.strictObject({ counter: S, amount: NUMX }).optional(),
  exileFromGraveyard: NUMX.optional(),
  exileOtherFromGraveyard: z.strictObject({ count: z.union([N, z.literal('any')]), minCardTypes: N.optional() }).optional(),
  exileFromHand: z.strictObject({ filter: FilterRef, count: N }).optional(),
  returnToHand: FilterRef.optional(),
  tapUntappedCreature: FilterRef.optional(),
  tapCreaturesTotalPower: z.strictObject({ power: N, other: B.optional() }).optional(),
});

export const AltCostSchema = z.strictObject({
  id: z.enum(ALT_COST_IDS),
  label: S,
  cost: AbilityCostSchema,
  condition: ConditionRef.optional(),
  from: z.enum(ALT_COST_FROM),
  exileAfter: B.optional(),
  returnToHand: B.optional(),
  timeCounters: N.optional(),
});

export const COST_MODIFIER_VARIANTS = [
  z.strictObject({ kind: z.literal('delve') }),
  z.strictObject({ kind: z.literal('convoke') }),
  z.strictObject({ kind: z.literal('improvise') }),
  z.strictObject({ kind: z.literal('reduce'), amount: AmountRef }),
] as const;
export const CostModifierSchema = z.discriminatedUnion('kind', COST_MODIFIER_VARIANTS);

export const ASENTERS_VARIANTS = [
  z.strictObject({ kind: z.literal('tapped') }),
  z.strictObject({ kind: z.literal('tapped-unless'), condition: ConditionRef }),
  z.strictObject({ kind: z.literal('pay-life-or-tapped'), life: N }),
  z.strictObject({ kind: z.literal('counters'), counter: S, amount: AmountRef, condition: ConditionRef.optional() }),
  z.strictObject({ kind: z.literal('choose'), what: z.enum(['creature-type', 'color']) }),
  z.strictObject({ kind: z.literal('discard-or-graveyard'), filter: FilterRef }),
] as const;
export const AsEntersSchema = z.discriminatedUnion('kind', ASENTERS_VARIANTS);

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

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

export const CONDITION_VARIANTS = [
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
export const ConditionSchema = z.discriminatedUnion('kind', CONDITION_VARIANTS);

// ---------------------------------------------------------------------------
// Effects (every op in types.ts, parser-internal marker ops included)
// ---------------------------------------------------------------------------

const DURATION = z.enum(['eot', 'permanent']);

export const EFFECT_VARIANTS = [
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
  z.strictObject({ op: z.literal('counter'), target: TargetSpecSchema, unlessPay: N.optional(), toExile: B.optional() }),
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
  z.strictObject({ op: z.literal('move-counters'), counter: S, target: TargetSpecSchema }),
  z.strictObject({ op: z.literal('renown'), amount: N }),
  z.strictObject({ op: z.literal('sacrifice-unless-pay'), mana: ManaCostSchema, once: z.literal('echo').optional(), perCounter: S.optional() }),
  z.strictObject({ op: z.literal('unearth') }),
  z.strictObject({ op: z.literal('cascade') }),
  z.strictObject({ op: z.literal('explore') }),
  z.strictObject({ op: z.literal('optional-pay'), mana: ManaCostSchema, then: z.array(EffectRef) }),
  z.strictObject({ op: z.literal('optional-then'), first: z.array(EffectRef), then: z.array(EffectRef) }),
  z.strictObject({ op: z.literal('impulse'), count: NUMX, until: z.enum(['eot', 'next-turn']) }),
  z.strictObject({ op: z.literal('return-own'), filter: FilterRef, count: N, to: z.literal('hand') }),
  z.strictObject({ op: z.literal('cant-block'), target: TargetSpecSchema, duration: z.literal('eot') }),
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
  z.strictObject({ op: z.literal('delayed-trigger'), at: z.enum(['next-upkeep', 'next-end-step', 'your-next-end-step', 'end-of-combat']), effects: z.array(EffectRef), bind: z.literal('that').optional() }),
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
    target: targetOr(['creatures-you-control', 'self', 'all-creatures', 'other-creatures-you-control', 'attacking-creatures', 'other-attacking-creatures', 'enchanted', 'all-opponent-creatures']),
    power: AmountRef, toughness: AmountRef, keywords: z.array(KeywordSchema).optional(), duration: DURATION,
  }),
  z.strictObject({ op: z.literal('grant-keyword'), target: targetOr(['self', 'creatures-you-control', 'permanents-you-control']), keywords: z.array(KeywordSchema), duration: DURATION }),
  z.strictObject({ op: z.literal('bounce'), target: targetOr(['all-creatures', 'all-nonland', 'self']), to: z.enum(['hand', 'library-top', 'library-bottom']) }),
  z.strictObject({
    op: z.literal('token'), count: AmountRef, power: N, toughness: N, colors: z.array(ColorSchema), types: z.array(CardTypeSchema),
    subtypes: z.array(S), keywords: z.array(KeywordSchema), tapped: B.optional(), attacking: B.optional(), name: S.optional(),
    text: S.optional(), treasure: B.optional(), clue: B.optional(), spawn: B.optional(), food: B.optional(), dynamicPT: AmountRef.optional(),
  }),
  z.strictObject({ op: z.literal('counters'), target: targetOr(['self', 'creatures-you-control', 'each-other-creature-you-control']), counter: S, amount: AmountRef, optional: B.optional(), filter: FilterRef.optional() }),
  z.strictObject({ op: z.literal('tap'), target: targetOr(['all-opponent-creatures', 'all-creatures', 'enchanted', 'self']), noUntap: B.optional() }),
  z.strictObject({ op: z.literal('untap'), target: targetOr(['self', 'all-you-control', 'lands-you-control', 'that', 'enchanted']) }),
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
  z.strictObject({ op: z.literal('scry'), amount: N }),
  z.strictObject({ op: z.literal('surveil'), amount: N }),
  z.strictObject({ op: z.literal('return-from-graveyard'), what: FilterRef, to: z.enum(['hand', 'battlefield', 'library-top', 'library-bottom']), target: B.optional(), anyGraveyard: B.optional(), tapped: B.optional() }),
  z.strictObject({ op: z.literal('fight'), target: TargetSpecSchema, self: B }),
  z.strictObject({ op: z.literal('bite'), target: TargetSpecSchema }),
  z.strictObject({ op: z.literal('set-life'), amount: N, who: z.enum(['you', 'each-player']) }),
  z.strictObject({ op: z.literal('gain-control'), target: TargetSpecSchema, duration: DURATION, untapHaste: B.optional() }),
  z.strictObject({ op: z.literal('copy-spell'), target: TargetSpecSchema, newTargets: B.optional() }),
  z.strictObject({
    op: z.literal('token-copy'), target: targetOr(['that', 'self']), count: AmountRef, extraTypes: z.array(CardTypeSchema).optional(),
    extraSubtypes: z.array(S).optional(), extraKeywords: z.array(KeywordSchema).optional(), tapped: B.optional(),
    attacking: z.union([z.literal('each-other-opponent'), B]).optional(),
  }),
  z.strictObject({ op: z.literal('remove-those'), how: z.enum(['exile', 'sacrifice']) }),
  z.strictObject({ op: z.literal('remove-from-combat'), target: TargetSpecSchema, untap: B.optional() }),
  z.strictObject({ op: z.literal('play-exiled'), until: z.enum(['eot', 'next-turn']), free: B.optional() }),
  z.strictObject({ op: z.literal('extra-land'), count: N }),
  z.strictObject({ op: z.literal('exile-if-dies'), who: z.enum(['that', 'affected', 'self', 'all-creatures', 'opponent-creatures']) }),
  z.strictObject({ op: z.literal('proliferate') }),
  z.strictObject({ op: z.literal('storm-copies') }),
  z.strictObject({ op: z.literal('player-counter'), counter: S, amount: AmountRef, who: z.enum(['you', 'target-player', 'each-opponent']) }),
  z.strictObject({ op: z.literal('fold-new-targets') }),
  z.strictObject({ op: z.literal('earthbend'), amount: AmountRef, target: TargetSpecSchema }),
  z.strictObject({
    op: z.literal('animate'), target: targetOr(['self']), power: N, toughness: N, colors: z.array(ColorSchema),
    types: z.array(CardTypeSchema), subtypes: z.array(S), keywords: z.array(KeywordSchema), duration: DURATION,
  }),
  z.strictObject({ op: z.literal('untap-all'), filter: FilterRef }),
  z.strictObject({ op: z.literal('untap-choose'), filter: FilterRef, count: NUMX }),
  z.strictObject({ op: z.literal('double-power'), target: TargetSpecSchema }),
  z.strictObject({ op: z.literal('shuffle-into-library'), target: TargetSpecSchema }),
  z.strictObject({ op: z.literal('each-self-damage') }),
  z.strictObject({ op: z.literal('multi-counters'), target: TargetSpecSchema, counters: z.array(S) }),
  z.strictObject({ op: z.literal('transform-self'), viaExile: B.optional() }),
  z.strictObject({ op: z.literal('choose-mode'), modes: z.array(z.array(EffectRef)), count: N }),
  z.strictObject({ op: z.literal('conditional'), condition: ConditionRef, then: z.array(EffectRef), else: z.array(EffectRef).optional() }),
  z.strictObject({ op: z.literal('attach-self'), target: TargetSpecSchema }),
  z.strictObject({ op: z.literal('regenerate'), target: targetOr(['self']) }),
  z.strictObject({ op: z.literal('prevent-damage'), target: targetOr(['self', 'you']), amount: z.union([AmountRef, z.literal('all')]), duration: z.literal('eot') }),
  z.strictObject({ op: z.literal('cant-attack-or-block'), target: TargetSpecSchema, duration: z.literal('eot') }),
  z.strictObject({ op: z.literal('extra-turn') }),
  z.strictObject({ op: z.literal('loot'), draw: NUMX, discard: NUMX, discardFirst: B.optional(), optional: B.optional() }),
  z.strictObject({ op: z.literal('unknown'), text: S }),
] as const;
export const EffectSchema = z.discriminatedUnion('op', EFFECT_VARIANTS);

// ---------------------------------------------------------------------------
// Trigger events
// ---------------------------------------------------------------------------

export const TRIGGER_VARIANTS = [
  z.strictObject({ on: z.literal('etb'), self: B, filter: FilterRef.optional(), controller: z.enum(['you', 'any']).optional() }),
  z.strictObject({ on: z.literal('dies'), self: B, filter: FilterRef.optional(), controller: z.enum(['you', 'any']).optional() }),
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
  z.strictObject({ on: z.literal('unknown'), text: S }),
] as const;
export const TriggerEventSchema = z.discriminatedUnion('on', TRIGGER_VARIANTS);

// ---------------------------------------------------------------------------
// Static effects
// ---------------------------------------------------------------------------

export const STATIC_VARIANTS = [
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
    cantAttack: B.optional(), cantBlock: B.optional(), doesntUntap: B.optional(), enchant: TargetSpecSchema,
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
export const StaticEffectSchema = z.discriminatedUnion('kind', STATIC_VARIANTS);

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

export const TriggeredAbilitySchema = z.strictObject({
  kind: z.literal('triggered'), event: TriggerEventRef, effects: z.array(EffectRef), condition: ConditionRef.optional(),
  optional: B.optional(), text: S, intervening: ConditionRef.optional(), oncePerTurn: B.optional(),
});
export const ActivatedAbilitySchema = z.strictObject({
  kind: z.literal('activated'), cost: AbilityCostSchema, effects: z.array(EffectRef), text: S, sorcerySpeed: B.optional(),
  loyalty: N.optional(), oncePerTurn: B.optional(), manaAbility: B.optional(), activateOnlyIf: ConditionRef.optional(),
  instantSpeed: B.optional(), fromGraveyard: B.optional(),
});
export const StaticAbilitySchema = z.strictObject({ kind: z.literal('static'), effect: StaticEffectSchema, text: S });
export const SpellAbilitySchema = z.strictObject({ kind: z.literal('spell'), effects: z.array(EffectRef), text: S });

export const ABILITY_VARIANTS = [TriggeredAbilitySchema, ActivatedAbilitySchema, StaticAbilitySchema, SpellAbilitySchema] as const;
export const AbilitySchema = z.discriminatedUnion('kind', ABILITY_VARIANTS);

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
export const SCRIPT_ABILITY_VARIANTS = [
  TriggeredAbilitySchema.extend({ effects: z.array(EffectRef).min(1, NEEDS_EFFECT) }),
  ActivatedAbilitySchema.extend({ effects: z.array(EffectRef).min(1, NEEDS_EFFECT) }),
  StaticAbilitySchema,
  SpellAbilitySchema.extend({ effects: z.array(EffectRef).min(1, NEEDS_EFFECT) }),
] as const;
export const ScriptAbilitySchema = z.discriminatedUnion('kind', SCRIPT_ABILITY_VARIANTS);
const ScriptAbilityRef: z.ZodType<Ability> = z.lazy(() => ScriptAbilitySchema);

// ---------------------------------------------------------------------------
// Card script v2
// ---------------------------------------------------------------------------

export const SCRIPT_SOURCES = ['generated', 'llm', 'reviewed', 'hand'] as const;
export const ScriptSourceSchema = z.enum(SCRIPT_SOURCES);
export const IgnoreReasonSchema = z.enum(IGNORE_REASONS);

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
export const CoverKindSchema = z.enum(COVER_KINDS);
export const CoverEntrySchema = z.strictObject({ line: CLAIMED_LINE, by: CoverKindSchema });

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

export const ScriptFaceSchema = z.strictObject(faceShape);

export const IgnoredLineSchema = z.strictObject({ line: CLAIMED_LINE, reason: IgnoreReasonSchema });

export const VerificationSchema = z.strictObject({
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
  scenarios: z.strictObject({ file: S, passed: N, failed: N, names: z.array(S) }),
  judge: z.array(z.strictObject({ model: S, verdict: z.enum(['faithful', 'unfaithful', 'uncertain']), issues: z.array(S), at: S })).optional(),
  status: z.enum(['scripted', 'verified', 'tested', 'judged']),
  problems: z.array(S),
});

export const CardScriptSchema = z.strictObject({
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

/**
 * `CardScriptSchema` plus the cross-field rules JSON Schema cannot state: every `covers` entry must be VALID — the
 * declaration it names (`by`) is really on that face, and the line has the shape that declaration produces. Both are
 * checks across two fields of the same object, which JSON Schema cannot express; `coverProblem` in scripts.ts owns
 * the policy and `scripts:check` prints its reason.
 *
 * Two further rules need the CARD and so live in `scripts:check`, not here: every `covers` / `ignore` line must be
 * one `scriptableLines(def)` names (and belong to the face that claims it), and an `ignore` reason must match its
 * whitelist entry for the card's pool tier (`ignoreLineProblem`).
 *
 * Use this in tooling; `CardScriptSchema` is the plain object schema used for type pinning.
 */
const COVERS_INVALID = 'a covers entry names a declaration this face does not have, or a line that declaration does not produce';
export const CardScriptChecked = CardScriptSchema.refine(
  s => coversValid(s),
  { message: COVERS_INVALID, path: ['covers'] },
).refine(
  s => coversValid(s.backFace),
  { message: `backFace: ${COVERS_INVALID}`, path: ['backFace', 'covers'] },
).refine(
  s => coversValid(s.secondFace),
  { message: `secondFace: ${COVERS_INVALID}`, path: ['secondFace', 'covers'] },
);

// Convenience aliases for the tooling (test/schema-types.test.ts pins each of these to its types.ts counterpart).
export type SchemaEffect = z.infer<typeof EffectSchema>;
export type SchemaAbility = z.infer<typeof AbilitySchema>;
export type SchemaCardScript = z.infer<typeof CardScriptSchema>;
