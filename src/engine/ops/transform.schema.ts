// zod mirror of the `transform` family's AST (src/engine/ops/transform.ts).
//
// TOOLING ONLY — the engine never imports this file (zod is a devDependency and must not reach the web bundle); the
// generated schema composer folds `schema` into `EffectSchema` / `ConditionSchema` / `TriggerEventSchema` /
// `AsEntersSchema` and, through them, into `CardScriptChecked`, so a per-card script may use these ops.
//
// Every list entry is a STRICT z.object whose discriminator is a z.literal (`op` for effects, `kind` for conditions /
// statics / as-enters, `on` for triggers), so the composed discriminated unions keep narrowing and a typo'd field is a
// validation error rather than a silently dropped clause. `amounts` and `targetKinds` are plain string literals: they
// widen enums, not unions.
import { z } from 'zod';
import type { FamilySchema } from './types.js';
import { AmountSchema, FilterSchema, RefSchema, TargetSpecSchema } from '../../cards/schema.js';

/** `target` as the family's ops accept it: a chosen target spec, a Ref, or the word `self`. */
const Subject = z.union([TargetSpecSchema, RefSchema, z.literal('self')]).optional();
/** Zones a permanent can have entered the battlefield from (src/engine/state.ts `Zone`). */
const ZONE = z.enum(['library', 'hand', 'battlefield', 'graveyard', 'exile', 'stack', 'command']);

export const schema: FamilySchema = {
  effects: [
    z.strictObject({ op: z.literal('transform'), target: Subject, to: z.enum(['front', 'back']).optional(), untap: z.boolean().optional(), asItEnters: z.literal(true).optional() }),
    z.strictObject({ op: z.literal('set-day-night'), to: z.enum(['day', 'night', 'neither']) }),
    z.strictObject({ op: z.literal('become-prepared'), target: Subject, on: z.literal(false).optional() }),
    z.strictObject({ op: z.literal('turn-face-up'), target: Subject, onlyIf: z.literal('creature-card').optional() }),
  ],
  conditions: [
    z.strictObject({ kind: z.literal('day-night'), is: z.enum(['day', 'night', 'neither']) }),
    z.strictObject({ kind: z.literal('descend'), count: z.number().int(), among: z.enum(['cards', 'permanent-cards', 'permanent-types']) }),
    z.strictObject({ kind: z.literal('entered-from'), zone: ZONE, who: z.enum(['you', 'any']).optional() }),
    z.strictObject({ kind: z.literal('prepared') }),
  ],
  triggers: [
    z.strictObject({
      on: z.literal('transforms'), self: z.boolean().optional(), into: z.enum(['front', 'back']).optional(),
      orEnters: z.boolean().optional(), attached: z.boolean().optional(), filter: FilterSchema.optional(),
      controller: z.enum(['you', 'any', 'opponent']).optional(),
    }),
    z.strictObject({ on: z.literal('day-night'), to: z.enum(['day', 'night']).optional() }),
    z.strictObject({ on: z.literal('first-main-phase'), whose: z.enum(['your', 'each']) }),
  ],
  statics: [
    z.strictObject({ kind: z.literal('daybound') }),
    z.strictObject({ kind: z.literal('nightbound') }),
  ],
  asEnters: [
    z.strictObject({ kind: z.literal('day-night-enters'), to: z.enum(['day', 'night']) }),
    z.strictObject({ kind: z.literal('prepared') }),
  ],
  amounts: ['permanent-cards-in-graveyard', 'permanent-types-in-graveyard'],
  targetKinds: ['face-down-permanent'],
};

/** Referenced so the import of `AmountSchema` is not dead: the family's amounts are plain counts on the core shape. */
export const AMOUNT_FORM = AmountSchema;

export default schema;
