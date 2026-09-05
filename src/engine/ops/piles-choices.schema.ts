// zod mirror of the piles-choices family AST (docs/vocabulary/piles-choices.md). TOOLING ONLY: zod is a
// devDependency and the engine never imports this file — `src/engine/ops/piles-choices.ts` is the runtime half.
//
// The schema composer folds `schema.effects` / `.conditions` / `.triggers` / `.statics` into `EffectSchema`,
// `ConditionSchema`, `TriggerEventSchema` and `StaticEffectSchema` (and therefore into `CardScriptChecked`), so a
// per-card script may use this family's ops. Every list entry is a STRICT object whose discriminator is a
// `z.literal`, which is what `z.discriminatedUnion` needs to keep narrowing.
//
// `EffectRef` below is a lazy reference to the core `EffectSchema`, typed as the WIDENED `Effect` (the family's own
// variants included through declaration merging). Until the composer lands, a nested effect is validated against the
// core union alone; afterwards the same reference resolves to the composed union with no edit here.
import { z } from 'zod';
import { AmountSchema, EffectSchema, FilterSchema } from '../../cards/schema.js';
import type { Amount, Effect, Filter } from '../../cards/types.js';

/** One variant of a discriminated union: a strict object keyed by a `z.literal` discriminator. */
type Variant = z.ZodObject<z.core.$ZodLooseShape>;

/**
 * What a mechanic family contributes to the script schema. Declared here because `src/engine/ops/types.ts` does not
 * export it yet; the schema-composer slice is expected to adopt this exact shape (`op` discriminates effects, `kind`
 * conditions / statics / as-enters, `on` triggers; `amounts` and `targetKinds` are plain string literals).
 */
export interface FamilySchema {
  effects?: Variant[];
  conditions?: Variant[];
  triggers?: Variant[];
  statics?: Variant[];
  amounts?: string[];
  costParts?: Record<string, z.ZodType>;
  asEnters?: Variant[];
  targetKinds?: string[];
}

// Every core schema is reached through `z.lazy`, never read while this module evaluates: that is what lets the schema
// composer import this file FROM src/cards/schema.ts (a cycle ESM resolves only because nothing is touched at eval).
const EffectRef: z.ZodType<Effect> = z.lazy(() => EffectSchema);
const FilterRef: z.ZodType<Filter> = z.lazy(() => FilterSchema);
const AmountRef: z.ZodType<Amount> = z.lazy(() => AmountSchema);
const B = z.boolean();
const N = z.number();
const S = z.string();

/** `ChoiceWho`: the core `ScopeWho` words plus `an-opponent` ("an opponent", chosen by the acting player — CR 700.2e). */
export const CHOICE_WHO = ['you', 'an-opponent', 'target-player', 'target-opponent', 'that-player', 'each-player', 'each-opponent', 'controller-of-that', 'owner-of-that'] as const;
export const ChoiceWhoSchema = z.enum(CHOICE_WHO);
export const SET_ZONES = ['battlefield', 'graveyard', 'hand', 'exile', 'library'] as const;
export const MOVE_ZONES = ['battlefield', 'graveyard', 'exile', 'hand', 'library', 'command'] as const;

/** A set of objects: the current binding, or a filter in a zone of some player(s) (`top` = the first N of a library). */
export const ChoiceSetSchema = z.strictObject({
  filter: FilterRef.optional(), zone: z.enum(SET_ZONES).optional(), who: ChoiceWhoSchema.optional(), top: AmountRef.optional(),
});
const FromSchema = z.union([z.literal('those'), ChoiceSetSchema]);

/** What happens to a chosen (or unchosen) set. */
export const PileFateSchema = z.strictObject({
  how: z.enum(['move', 'sacrifice', 'destroy']),
  to: z.enum(MOVE_ZONES).optional(), pos: z.enum(['top', 'bottom']).optional(), tapped: B.optional(), controller: z.enum(['you', 'owner']).optional(),
}).refine(f => f.how === 'move' || (f.to === undefined && f.pos === undefined && f.tapped === undefined && f.controller === undefined),
  { message: 'to / pos / tapped / controller belong to a `move` fate' });

export const schema: FamilySchema = {
  effects: [
    // CR 700.2 / 700.2d / 700.2e / 700.2i — modal choices the core `choose-mode` cannot express
    z.strictObject({
      op: z.literal('choose-modes'),
      modes: z.array(z.array(EffectRef)).min(1),
      count: AmountRef,
      labels: z.array(S).optional(),
      upTo: B.optional(),
      repeat: B.optional(),
      notChosen: z.enum(['this-turn', 'ever']).optional(),
      chooser: ChoiceWhoSchema.optional(),
      weights: z.array(N).optional(),
    }).superRefine((e, ctx) => {
      if (e.labels && e.labels.length !== e.modes.length) ctx.addIssue({ code: 'custom', message: 'labels lists one label per mode' });
      if (e.weights && e.weights.length !== e.modes.length) ctx.addIssue({ code: 'custom', message: 'weights lists one pawprint cost per mode (CR 700.2i)' });
    }) as unknown as Variant,
    // CR 701.38 — vote
    z.strictObject({
      op: z.literal('vote'),
      options: z.array(z.strictObject({ label: S, effects: z.array(EffectRef) })).min(2),
      resolve: z.enum(['majority', 'per-vote']),
      tie: z.enum(['all', 'first']).optional(),
    }) as unknown as Variant,
    // CR 700.3 — piles
    z.strictObject({
      op: z.literal('separate-piles'),
      from: FromSchema,
      piles: N.int().min(2).max(5),
      separator: ChoiceWhoSchema.optional(),
      reveal: B.optional(),
    }) as unknown as Variant,
    z.strictObject({ op: z.literal('choose-pile'), chooser: ChoiceWhoSchema }) as unknown as Variant,
    // "An opponent chooses two of those cards", "Target opponent chooses a creature they control"
    z.strictObject({
      op: z.literal('choose-objects'),
      chooser: ChoiceWhoSchema,
      from: FromSchema,
      count: AmountRef,
      upTo: B.optional(),
    }) as unknown as Variant,
    // "For each player, you choose …" (CR 608.2f, 101.4)
    z.strictObject({
      op: z.literal('choose-for-each-player'),
      chooser: ChoiceWhoSchema,
      picks: z.array(FilterRef).min(1),
      from: FilterRef.optional(),
    }) as unknown as Variant,
    // what happens to the chosen and the unchosen
    z.strictObject({
      op: z.literal('chosen-fate'),
      chosen: PileFateSchema.optional(),
      other: PileFateSchema.optional(),
      among: FilterRef.optional(),
      excludeSharing: z.literal('creature-type').optional(),
    }).superRefine((e, ctx) => {
      if (!e.chosen && !e.other) ctx.addIssue({ code: 'custom', message: 'chosen-fate names a fate for the chosen set, the rest, or both' });
    }) as unknown as Variant,
    // CR 716.2a — Class levels
    z.strictObject({ op: z.literal('set-level'), to: N.int().min(1).max(9), anyLevel: B.optional() }) as unknown as Variant,
  ],
  conditions: [
    // CR 716.2a / 716.2d
    z.strictObject({ kind: z.literal('self-level'), atLeast: N.int().optional(), exactly: N.int().optional() })
      .superRefine((c, ctx) => { if (c.atLeast === undefined && c.exactly === undefined) ctx.addIssue({ code: 'custom', message: 'self-level names atLeast, exactly, or both' }); }) as unknown as Variant,
  ],
  triggers: [
    // CR 716.2a
    z.strictObject({ on: z.literal('became-level'), level: N.int().min(2).max(9) }) as unknown as Variant,
  ],
  statics: [
    // CR 701.38d
    z.strictObject({ kind: z.literal('extra-votes'), amount: N.int().min(1).max(4) }) as unknown as Variant,
  ],
};

export default schema;
