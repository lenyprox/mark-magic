// zod mirror of the keyword-action family's AST (TOOLING ONLY — the engine never imports this file; zod is a
// devDependency and must not reach the web worker bundle).
//
// The composer slice folds `schema` below into `CardScriptChecked` (src/cards/schema.ts's `EFFECT_VARIANTS`,
// `CONDITION_VARIANTS`, `TRIGGER_VARIANTS`, `AMOUNT` counts and `AbilityCostSchema`), so a per-card script may write
// `{ "op": "bolster", "amount": 3 }` and `scripts:check` validates it. Every entry is a STRICT object whose
// discriminator is a `z.literal` — `op` for effects, `kind` for conditions, `on` for triggers — exactly as
// src/cards/schema.ts spells the core variants, so the composed discriminated unions keep narrowing.
//
// Shapes here are pinned to the interfaces in ./keyword-action.ts by `test/scripts.test.ts` only in spirit; the
// compile-time pin is the composer's own `Equals<>` assertion once it lands. Until then this file is the single
// declaration of what a script may say, and it is deliberately written field-for-field against the interfaces above.
import { z } from 'zod';
import type { FamilySchema } from './types.js';
import { AmountSchema, EffectSchema, FilterSchema, TargetSpecSchema } from '../../cards/schema.js';

/** A `TargetSpec | Ref` slot, as the core schema spells a Ref. */
const RefSchema = z.union([
  z.enum(['self', 'that', 'those', 'triggering', 'enchanted', 'equipped', 'sacrificed', 'exiled-with']),
  z.custom<`target:${number}`>(v => typeof v === 'string' && /^target:\d+$/.test(v), { message: 'a `target:<index>` Ref' }),
]);
const TargetOrRef = z.union([TargetSpecSchema, RefSchema]);
const EffectList = z.array(z.lazy(() => EffectSchema));

export const schema: FamilySchema = {
  effects: [
    z.strictObject({ op: z.literal('investigate'), amount: AmountSchema }),
    z.strictObject({ op: z.literal('bolster'), amount: AmountSchema }),
    z.strictObject({ op: z.literal('support'), amount: z.number().int().positive(), target: TargetSpecSchema }),
    z.strictObject({ op: z.literal('adapt'), amount: AmountSchema }),
    z.strictObject({ op: z.literal('monstrosity'), amount: AmountSchema }),
    z.strictObject({ op: z.literal('manifest'), amount: AmountSchema }),
    z.strictObject({ op: z.literal('manifest-dread') }),
    z.strictObject({ op: z.literal('cloak') }),
    z.strictObject({ op: z.literal('populate') }),
    z.strictObject({ op: z.literal('goad'), target: TargetOrRef }),
    z.strictObject({ op: z.literal('incubate'), amount: AmountSchema, count: AmountSchema.optional() }),
    z.strictObject({ op: z.literal('connive'), amount: AmountSchema, target: TargetOrRef }),
    z.strictObject({ op: z.literal('learn') }),
    z.strictObject({ op: z.literal('discover'), amount: AmountSchema }),
    z.strictObject({ op: z.literal('forage') }),
    z.strictObject({ op: z.literal('clash') }),
    z.strictObject({ op: z.literal('exert'), target: TargetOrRef }),
    z.strictObject({ op: z.literal('collect-evidence'), amount: AmountSchema }),
    z.strictObject({ op: z.literal('endure'), amount: AmountSchema, target: TargetOrRef }),
    z.strictObject({ op: z.literal('suspect'), target: TargetOrRef }),
    z.strictObject({ op: z.literal('behold'), what: FilterSchema }),
    z.strictObject({ op: z.literal('villainous-choice'), who: z.enum(['each-opponent', 'that-player', 'target']), target: TargetSpecSchema.optional(), modes: z.array(EffectList).min(2).max(2) }),
    z.strictObject({ op: z.literal('exploit') }),
    z.strictObject({ op: z.literal('harness'), target: TargetOrRef }),
  ],
  conditions: [
    z.strictObject({ kind: z.literal('monstrous') }),
    z.strictObject({ kind: z.literal('harnessed') }),
    z.strictObject({ kind: z.literal('suspected') }),
    z.strictObject({ kind: z.literal('clash-won') }),
  ],
  triggers: [
    z.strictObject({ on: z.literal('exploits'), self: z.boolean() }),
    z.strictObject({ on: z.literal('clash') }),
    z.strictObject({ on: z.literal('connives'), self: z.boolean() }),
    z.strictObject({ on: z.literal('exerts') }),
    z.strictObject({ on: z.literal('discovers') }),
    z.strictObject({ on: z.literal('forages') }),
    z.strictObject({ on: z.literal('monstrous'), self: z.boolean() }),
  ],
  amounts: ['counters-on-source-any'],
  costParts: {
    collectEvidence: z.number().int().positive(),
    forage: z.literal(true),
    beholdWhat: FilterSchema,
    exertSelf: z.literal(true),
  },
};

export default schema;
