// The zod slice for the `replacement` family (Phase 9.1) — TOOLING ONLY.
//
// `src/engine/ops/replacement.ts` declares the AST *types*; this file declares the same shapes as strict runtime
// schemas so `scripts:check` / `scripts:verify` / `scripts:schema` can validate a per-card script that uses them.
// The engine never imports this file (zod is a devDependency and must not reach the web worker), and
// `scripts/gen-registry.mjs` skips every `<name>.schema.ts` when it builds the ops barrel.
//
// SHAPE OF THE EXPORT. `schema` is the family's contribution to the six core unions in `src/cards/schema.ts`. Every
// list entry is a `z.strictObject` whose discriminator is a `z.literal` — `op` for effects, `kind` for conditions,
// statics and as-enters kinds, `on` for triggers — so the composer can fold them straight into
// `z.discriminatedUnion('op', [...EFFECT_VARIANTS, ...familyEffects])` and friends without re-deriving anything.
// `amounts` and `targetKinds` are plain string literals (those two unions are enums, not object unions).
//
// `FamilySchema` is declared here because `src/engine/ops/types.ts` does not have it yet; when the schema-composer
// slice lands it moves there unchanged and this file imports it instead. See `coreChangeNeeded` in the 9.1 report:
// until the composer exists, `Effect` / `StaticEffect` / `AsEnters` are wider than the hand-written unions in
// `src/cards/schema.ts`, so `test/schema-types.test.ts`'s `Equals<>` pins fail — the composer is what closes that.
import { z } from 'zod';
import { AmountSchema, FilterSchema, TargetSpecSchema } from '../../cards/schema.js';

/**
 * One family's runtime schema slice. Optional everywhere: a family declares only the unions it widens.
 *
 * It is declared HERE because `src/engine/ops/types.ts` does not carry it yet; the schema-composer slice moves this
 * exact interface there (with the zod types erased to `unknown`, so nothing under src/engine depends on zod) and
 * this file then imports it instead. See `coreChangeNeeded` in the Phase 9.1 report.
 */
export interface FamilySchema {
  effects?: readonly z.ZodType[];
  conditions?: readonly z.ZodType[];
  triggers?: readonly z.ZodType[];
  statics?: readonly z.ZodType[];
  amounts?: readonly string[];
  costParts?: Record<string, z.ZodType>;
  asEnters?: readonly z.ZodType[];
  targetKinds?: readonly string[];
}


// ---------------------------------------------------------------------------------------------------------------
// Shared sub-shapes (mirrors of the interfaces in replacement.ts)
// ---------------------------------------------------------------------------------------------------------------

// The core leaf schemas, behind `z.lazy`: `src/cards/schema.ts` imports the generated slice barrel, so a family
// slice that read `FilterSchema` while its own module body ran would be a module-evaluation cycle (the same rule the
// engine side of a family lives by). `z.lazy` defers the read to the first `parse`, which is long after both modules
// have finished evaluating.
const FilterRef = z.lazy(() => FilterSchema);
const AmountRef = z.lazy(() => AmountSchema);
const TargetSpecRef = z.lazy(() => TargetSpecSchema);

const B = z.boolean();
const N = z.number();
const S = z.string();
const WHO = z.enum(['you', 'opponent', 'any']);

/** `DamageSource` — which source of damage the effect answers for (CR 609.7). */
const DamageSourceSchema = z.strictObject({
  chosen: B.optional(),
  self: B.optional(),
  attached: B.optional(),
  filter: FilterRef.optional(),
  who: WHO.optional(),
  combat: z.enum(['combat', 'noncombat']).optional(),
});

/** `DamageRecipient` — what is being damaged; the player half and the object half are OR-ed (CR 615.1). */
const DamageRecipientSchema = z.strictObject({
  players: z.enum(['you', 'each-opponent', 'any']).optional(),
  self: B.optional(),
  attached: B.optional(),
  filter: FilterRef.optional(),
  who: WHO.optional(),
});

/** `PreventFollowUp` — "if damage is prevented this way, …". */
const PreventFollowUpSchema = z.union([
  z.strictObject({ mode: z.literal('gain-life') }),
  z.strictObject({ mode: z.literal('damage-source') }),
  z.strictObject({ mode: z.literal('damage-source-controller') }),
  z.strictObject({ mode: z.literal('damage-targets') }),
  z.strictObject({ mode: z.literal('counters'), counter: S }),
]);

/** `DamageInstead` — what a damage replacement does instead (CR 614.1a). */
const DamageInsteadSchema = z.union([
  z.strictObject({ mode: z.literal('plus'), amount: N }),
  z.strictObject({ mode: z.literal('times'), factor: N }),
  z.strictObject({ mode: z.literal('minus'), amount: N }),
  z.strictObject({ mode: z.literal('counters'), counter: S }),
  z.strictObject({ mode: z.literal('none') }),
]);

/** `CounterInstead` — what a counter replacement does instead (CR 614.1c). */
const CounterInsteadSchema = z.union([
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('plus'), amount: N }),
  z.strictObject({ mode: z.literal('minus'), amount: N }),
  z.strictObject({ mode: z.literal('times'), factor: N }),
]);

// ---------------------------------------------------------------------------------------------------------------
// The slice
// ---------------------------------------------------------------------------------------------------------------

export const schema: FamilySchema = {
  effects: [
    // CR 615.1 / 615.10 — a prevention shield until end of turn.
    z.strictObject({
      op: z.literal('prevent'),
      amount: z.union([AmountRef, z.literal('all'), z.literal('next')]),
      from: DamageSourceSchema.optional(),
      to: DamageRecipientSchema,
      duration: z.literal('eot'),
      rider: PreventFollowUpSchema.optional(),
    }),
    // CR 615.1 - the "if damage is prevented this way, ..." rider, printed as its own sentence.
    z.strictObject({
      op: z.literal('prevent-rider'),
      rider: PreventFollowUpSchema,
      target: TargetSpecRef.optional(),
    }),
    // CR 615.6 — "Damage can't be prevented this turn."
    z.strictObject({
      op: z.literal('damage-cant-be-prevented'),
      match: DamageSourceSchema.optional(),
      duration: z.literal('eot'),
    }),
  ],

  statics: [
    // A continuous prevention shield (CR 615.1).
    z.strictObject({ kind: z.literal('prevention-shield'), from: DamageSourceSchema.optional(), to: DamageRecipientSchema }),
    // CR 615.6 printed on a permanent.
    z.strictObject({ kind: z.literal('unpreventable-damage'), filter: FilterRef.optional(), who: WHO.optional(), combat: z.enum(['combat', 'noncombat']).optional() }),
    // CR 614.1a on damage.
    z.strictObject({ kind: z.literal('damage-replacement'), from: DamageSourceSchema.optional(), to: DamageRecipientSchema.optional(), instead: DamageInsteadSchema }),
    // CR 614.1a on a zone change.
    z.strictObject({
      kind: z.literal('zone-replacement'),
      would: z.strictObject({
        self: B.optional(), filter: FilterRef.optional(), who: WHO.optional(),
        to: z.enum(['graveyard', 'exile', 'hand', 'library']),
        from: z.enum(['battlefield', 'stack', 'any']).optional(),
      }),
      instead: z.strictObject({ zone: z.enum(['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command']), pos: z.enum(['top', 'bottom']).optional() }),
    }),
    // CR 614.1c on counters.
    z.strictObject({ kind: z.literal('counter-replacement'), counter: S.optional(), filter: FilterRef.optional(), who: WHO.optional(), instead: CounterInsteadSchema }),
    // CR 614.1b on life gain.
    z.strictObject({ kind: z.literal('cant-gain-life'), who: z.enum(['you', 'opponent', 'all']) }),
    // CR 121.6 / 614.1 on draws.
    z.strictObject({
      kind: z.literal('draw-replacement'), who: z.enum(['you', 'opponent', 'all']),
      instead: z.union([z.literal('skip'), N]), drawStepOnly: B.optional(), exceptFirstInDrawStep: B.optional(),
    }),
    // CR 614.12 the other way round.
    z.strictObject({ kind: z.literal('enters-untapped'), filter: FilterRef, who: z.enum(['you', 'all']) }),
  ],

  asEnters: [
    // CR 614.12 — "As ~ enters, choose a basic land type."
    z.strictObject({ kind: z.literal('choose-type'), what: z.literal('basic-land-type') }),
  ],
};

export default schema;
