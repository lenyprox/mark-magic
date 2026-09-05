// zod schemas for the layers family (Phase 9.1). TOOLING ONLY — the engine never imports this file (zod is a
// devDependency and must not reach the game or the web bundle); `scripts:check` / `scripts:verify` / `scripts:schema`
// are the consumers, through the schema composer that folds every `<family>.schema.ts` into `CardScriptChecked`.
//
// Every entry is a STRICT object whose discriminator is a `z.literal`, so the composer can add it straight to
// `EFFECT_VARIANTS` / `STATIC_VARIANTS` / `CONDITION_VARIANTS` / `AS_ENTERS_VARIANTS` in src/cards/schema.ts and keep
// them discriminated unions. A typo'd field is a validation error, which is the point: an LLM-written script must not
// lose a clause to a misspelt key.
import { z } from 'zod';
import { AmountSchema, CardTypeSchema, ColorSchema, ConditionSchema, FilterSchema, KeywordSchema, RefSchema, TargetSpecSchema } from '../../cards/schema.js';

/**
 * The shape a family's schema module exports. `src/engine/ops/types.ts` has no `FamilySchema` yet, so it is declared
 * here and the orchestrator's schema-composer slice adopts it (this is the contract that slice reads):
 * every list entry is a strict `z.object` whose discriminator is a `z.literal` — `op` for effects, `kind` for
 * conditions / statics / asEnters, `on` for triggers — and `amounts` / `targetKinds` are plain string literals.
 */
export interface FamilySchema {
  effects?: z.ZodType[];
  conditions?: z.ZodType[];
  triggers?: z.ZodType[];
  statics?: z.ZodType[];
  asEnters?: z.ZodType[];
  amounts?: readonly string[];
  targetKinds?: readonly string[];
  costParts?: Record<string, z.ZodType>;
}

/** Where a one-shot layer lands: a target spec, a composition-core `Ref`, or one of the group words. */
const LayerTargetSchema = z.union([TargetSpecSchema, RefSchema, z.enum(['creatures-you-control', 'lands-you-control', 'permanents-you-control', 'all-creatures', 'all-lands'])]);
const DurationSchema = z.enum(['eot', 'permanent']);

/** `{ op: 'become', … }` — the one-shot type / subtype / colour / base-P-T layer (CR 613.1c-e, 613.4b). */
export const BecomeSchema = z.strictObject({
  op: z.literal('become'),
  target: LayerTargetSchema,
  types: z.array(CardTypeSchema).optional(),
  subtypes: z.array(z.string()).optional(),
  colors: z.array(ColorSchema).optional(),
  power: AmountSchema.optional(),
  toughness: AmountSchema.optional(),
  keywords: z.array(KeywordSchema).optional(),
  everyCreatureType: z.literal(true).optional(),
  duration: DurationSchema,
});

/** `{ op: 'choose-type', … }` — "Choose a creature type." at resolution (CR 700.4). */
export const ChooseTypeEffectSchema = z.strictObject({
  op: z.literal('choose-type'),
  what: z.enum(['creature-type', 'color', 'basic-land-type']),
});

/** `{ op: 'exchange-life-toughness', … }` — Tree of Perdition (CR 701.12 + 613.4b). */
export const ExchangeLifeToughnessSchema = z.strictObject({
  op: z.literal('exchange-life-toughness'),
  target: TargetSpecSchema,
  permanent: RefSchema.optional(),
});

/** `{ kind: 'attached-is', … }` — "As long as enchanted land is a basic Mountain, …" (CR 611.2c). */
export const AttachedIsConditionSchema = z.strictObject({
  kind: z.literal('attached-is'),
  of: z.enum(['attached', 'self']).optional(),
  filter: FilterSchema,
});

/**
 * `{ kind: 'type-change', … }` — the static layer (CR 613.1d layer 4, 613.1e layer 5).
 *
 * `condition` accepts this family's own condition as well as a core one: until the composer folds
 * `AttachedIsConditionSchema` into `CONDITION_VARIANTS`, the core `ConditionSchema` is a discriminated union that has
 * never heard of `attached-is`, and a script using the pair would be rejected by its own family's schema.
 */
export const TypeChangeStaticSchema = z.strictObject({
  kind: z.literal('type-change'),
  scope: z.enum(['self', 'enchanted', 'equipped', 'you-control', 'all']),
  filter: FilterSchema.optional(),
  types: z.array(CardTypeSchema).optional(),
  subtypes: z.union([z.array(z.string()), z.literal('chosen-creature-type'), z.literal('chosen-basic-land-type')]).optional(),
  colors: z.union([z.array(ColorSchema), z.literal('chosen')]).optional(),
  everyCreatureType: z.literal(true).optional(),
  condition: z.union([ConditionSchema, AttachedIsConditionSchema]).optional(),
});

/** `{ kind: 'choose-type', … }` — "As ~ enters, choose a basic land type." */
export const ChooseTypeAsEntersSchema = z.strictObject({
  kind: z.literal('choose-type'),
  what: z.literal('basic-land-type'),
});

export const schema: FamilySchema = {
  effects: [BecomeSchema, ChooseTypeEffectSchema, ExchangeLifeToughnessSchema],
  conditions: [AttachedIsConditionSchema],
  statics: [TypeChangeStaticSchema],
  asEnters: [ChooseTypeAsEntersSchema],
};

export default schema;
