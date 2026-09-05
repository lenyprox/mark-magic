// zod mirror of the "control" family's AST (Phase 9.1; docs/vocabulary/control.md).
//
// TOOLING ONLY — the engine never imports a `<family>.schema.ts` (`scripts/gen-registry.mjs` skips them when it
// builds the barrel), because zod is a devDependency and must never reach the game or the web bundle. The schema
// composer folds `schema` into `CardScriptChecked`, so a per-card script may emit `control-gain`, `control-return`
// and `control-exchange` and have a typo'd field rejected rather than silently dropped.
//
// Every entry is a STRICT object whose discriminator is a `z.literal` (`op` for effects, `kind` for conditions and
// statics, `on` for triggers), so each list can be spliced straight into the core's `z.discriminatedUnion`.
// The shared leaves (`FilterSchema`, `TargetSpecSchema`, `RefSchema`, `ConditionSchema`) come from the core mirror,
// so a filter or a target spec means exactly one thing across the whole vocabulary.
import { z } from 'zod';
import { ConditionSchema, FilterSchema, RefSchema, TargetSpecSchema } from '../../cards/schema.js';

/**
 * What a family's `<family>.schema.ts` exports. `src/engine/ops/types.ts` carries no such type yet (families are the
 * first users), so it is declared here in the shape the schema composer reads: one list of strict variants per
 * discriminated union, and plain string literals for the two registries that widen an enum instead of a union.
 */
export interface FamilySchema {
  effects?: z.ZodObject[];
  conditions?: z.ZodObject[];
  triggers?: z.ZodObject[];
  statics?: z.ZodObject[];
  amounts?: string[];
  costParts?: Record<string, z.ZodType>;
  asEnters?: z.ZodObject[];
  targetKinds?: string[];
}

/** CR 611.2 / 611.2b: no duration = indefinitely; the `while-*` forms end the moment their condition stops holding. */
const Duration = z.enum([
  'permanent', 'eot', 'end-of-combat', 'your-next-turn',
  'while-source-on-battlefield', 'while-you-control-source', 'while-source-tapped',
  'while-you-control-source-and-tapped', 'while-counter',
]);

/**
 * The single player who gains control. No `target-player` / `target-opponent`: `legal.ts` emits a player requirement
 * only for the ops it knows by name, so "target opponent gains control of ~" is a `scoped` around the op instead.
 */
const Who = z.enum(['you', 'that-player', 'controller-of-that', 'owner-of-that', 'leader']);

/** "the player with the most life / the most cards in hand / the most creatures". */
const Leader = z.strictObject({
  of: z.enum(['life', 'cards-in-hand', 'permanents']),
  filter: FilterSchema.optional(),
  extreme: z.enum(['most', 'least']),
});

/** "all creatures", "all lands target player controls" — every matching permanent the named players control. */
const ControlSet = z.strictObject({
  all: FilterSchema,
  who: z.enum(['you', 'each-player', 'each-opponent', 'that-player']).optional(),
});

export const schema: FamilySchema = {
  effects: [
    z.strictObject({
      op: z.literal('control-gain'),
      // exactly one of `target` / `all` (a `z.refine` would stop this being a plain object the composer can splice
      // into the core's discriminated union, so the rule is documented and the op no-ops on a script that breaks it)
      target: z.union([TargetSpecSchema, RefSchema]).optional(),
      all: ControlSet.optional(),
      who: Who.optional(),
      duration: Duration.optional(),
      counter: z.string().optional(),
      leader: Leader.optional(),
      untap: z.boolean().optional(),
      haste: z.boolean().optional(),
    }),
    z.strictObject({
      op: z.literal('control-return'),
      who: z.enum(['each-player', 'each-opponent', 'you', 'that-player']).optional(),
      filter: FilterSchema.optional(),
    }),
    z.strictObject({
      op: z.literal('control-exchange'),
      target: TargetSpecSchema,
      self: z.boolean().optional(),
      share: z.literal('card-type').optional(),
      duration: Duration.optional(),
    }),
  ],
  conditions: [
    z.strictObject({
      kind: z.literal('control-leader'),
      of: z.enum(['life', 'cards-in-hand', 'permanents']),
      filter: FilterSchema.optional(),
      extreme: z.enum(['most', 'least']),
    }),
  ],
  statics: [
    z.strictObject({
      kind: z.literal('control-cant-change'),
      scope: z.enum(['self', 'you-control', 'all']),
      filter: FilterSchema.optional(),
      condition: ConditionSchema.optional(),
    }),
  ],
  triggers: [
    z.strictObject({
      on: z.literal('control-gained'),
      self: z.boolean().optional(),
      who: z.enum(['you', 'any']).optional(),
    }),
  ],
  targetKinds: ['permanent-you-own-not-control'],
};

export default schema;
