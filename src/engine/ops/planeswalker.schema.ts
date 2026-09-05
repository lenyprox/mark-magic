// The zod half of the `planeswalker` family (docs/vocabulary/README.md, "Family schema"): the shapes a per-card
// script may write for the ops src/engine/ops/planeswalker.ts installs. The engine never imports this file — zod is a
// devDependency — and the composer folds these variants into `CardScriptChecked` so a script naming `emblem`,
// `loyalty`, `poison-to-total`, the `loyalty-any-time` static or the `compleated` as-enters passes stage 1 of
// `scripts:verify`. Every entry is a strict object whose discriminator is a literal, so a typo'd field in a script is
// a validation error and never a clause the engine silently drops.
import { z } from 'zod';
import type { ZodObject, ZodType } from 'zod';
import { AbilitySchema, AmountSchema, RefSchema, TargetSpecSchema } from '../../cards/schema.js';

/**
 * The contract every `src/engine/ops/<family>.schema.ts` exports (docs/vocabulary/README.md, "Family schema").
 * It is declared here rather than imported from `./types.js` because this tree's `FamilyModule` file does not carry
 * it yet: the schema-composer slice moves this interface into `src/engine/ops/types.ts` and folds the lists below
 * into `src/cards/_schemas.ts`, at which point this local copy becomes `import type { FamilySchema } from './types.js'`
 * and nothing else about this file changes.
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

/** The scope words `loyalty` takes besides a target spec or a Ref (CR 306.1: planeswalkers on the battlefield). */
const LoyaltyScope = z.enum(['each-planeswalker-you-control', 'each-other-planeswalker-you-control']);

export const schema: FamilySchema = {
  effects: [
    // CR 114.1: "You get an emblem with '<text>'." `text` is the printed quote (what the renderer prints back).
    z.strictObject({ op: z.literal('emblem'), abilities: z.array(AbilitySchema).min(1), text: z.string().min(1) }),
    // CR 121.1 / 121.3: loyalty counters put on (negative: removed from) planeswalkers.
    z.strictObject({ op: z.literal('loyalty'), target: z.union([TargetSpecSchema, RefSchema, LoyaltyScope]), amount: AmountSchema }),
    // CR 122.1: bring target player up to `total` poison counters (the difference, taken on resolution).
    z.strictObject({ op: z.literal('poison-to-total'), target: TargetSpecSchema, total: AmountSchema }),
  ],
  statics: [
    // CR 606.3 / 117.1a: loyalty abilities of planeswalkers this permanent's controller controls gain instant timing.
    z.strictObject({ kind: z.literal('loyalty-any-time') }),
  ],
  asEnters: [
    // CR 107.4f: `fewer` fewer loyalty counters when the Phyrexian pips were paid with life.
    z.strictObject({ kind: z.literal('compleated'), fewer: z.number().int().min(1) }),
  ],
};
