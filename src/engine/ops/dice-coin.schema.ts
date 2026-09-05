// The zod half of the dice-coin family (docs/vocabulary/README.md, "Family schema"): what a per-card script is
// allowed to write for the ops, conditions, triggers and amount counts src/engine/ops/dice-coin.ts implements.
//
// TOOLING ONLY — the engine never imports this file (zod is a devDependency and must not reach the web worker); the
// engine's own types come from the `declare module` merges in dice-coin.ts. The schema composer (`gen:registry`
// listing every `<family>.schema.ts` into src/cards/_schemas.ts, src/cards/schema.ts folding the lists into
// `EffectSchema = z.discriminatedUnion('op', [...core, ...families])`) is a separate orchestrator slice; until it
// lands this file is inert data with the exact shape that slice reads, and `npm run typecheck:schema` compiles it.
// `FamilySchema` is defined here because src/engine/ops/types.ts does not export it yet — when it does, delete the
// local declaration and `import type { FamilySchema } from './types.js'` instead; the value below does not change.
//
// Every variant is a STRICT object with a `z.literal` discriminator, so a misspelled field in a script is a
// validation error rather than a silently dropped clause. There is no results-table shape to declare: a striation is
// a core `conditional` on `{ kind: 'roll-result' }` (CR 706.3a), which the core schema already validates.
import { z } from 'zod';
import type { ZodObject, ZodType } from 'zod';
import { AmountSchema } from '../../cards/schema.js';

/**
 * The contract every `src/engine/ops/<family>.schema.ts` exports as `export const schema: FamilySchema`: lists of
 * strict `z.object` variants whose discriminator is a `z.literal` (`op` for effects, `kind` for conditions / statics /
 * asEnters, `on` for triggers), with `amounts` / `targetKinds` as string literals and `costParts` keyed by the
 * `AbilityCost` field the family pays (each value the schema of that field's value).
 */
export interface FamilySchema {
  /** `Effect` variants, discriminated by `op`. */
  effects?: readonly ZodObject[];
  /** `Condition` variants, discriminated by `kind`. */
  conditions?: readonly ZodObject[];
  /** `TriggerEvent` variants, discriminated by `on`. */
  triggers?: readonly ZodObject[];
  /** `StaticEffect` variants, discriminated by `kind`. */
  statics?: readonly ZodObject[];
  /** `Amount.count` literals the family's `amounts` hook evaluates. */
  amounts?: readonly string[];
  /** Non-core `AbilityCost` fields the family's `costParts` hook pays, each with the schema of its value. */
  costParts?: Readonly<Record<string, ZodType>>;
  /** `AsEnters` variants, discriminated by `kind`. */
  asEnters?: readonly ZodObject[];
  /** `TargetSpec.kind` literals the family's `targetKinds` hook enumerates. */
  targetKinds?: readonly string[];
}

export const schema: FamilySchema = {
  effects: [
    z.strictObject({
      op: z.literal('roll-die'),
      sides: z.number().int().min(1),
      count: AmountSchema.optional(),
      keep: z.enum(['sum', 'choose-one', 'highest', 'lowest']).optional(),
      plus: AmountSchema.optional(),
    }),
    z.strictObject({
      op: z.literal('flip-coin'),
      count: AmountSchema.optional(),
      until: z.literal('lose').optional(),
    }),
  ],
  conditions: [
    z.strictObject({
      kind: z.literal('coin-flip'),
      outcome: z.enum(['won', 'lost', 'heads', 'tails']),
      least: z.number().int().min(1).optional(),
    }),
    z.strictObject({
      kind: z.literal('roll-result'),
      least: z.number().int().optional(),
      most: z.number().int().optional(),
    }),
  ],
  triggers: [
    z.strictObject({ on: z.literal('dice-rolled'), who: z.enum(['you', 'any']) }),
    z.strictObject({ on: z.literal('coin-flipped'), who: z.enum(['you', 'any']), outcome: z.enum(['won', 'lost']).optional() }),
  ],
  amounts: ['roll-result', 'roll-other-result', 'flips-won'],
};
