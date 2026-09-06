// zod variants for the saga family (docs/vocabulary/saga.md). TOOLING ONLY — the engine never imports this file
// (`scripts/gen-registry.mjs` skips every `<family>.schema.ts`, and `test/lint-ops.test.ts` asserts it does), so zod
// stays a devDependency and never reaches the web worker.
//
// The shape is the one the schema composer folds into `CardScriptChecked`: one strict `z.object` per AST variant,
// each discriminated by a `z.literal` (`op` for effects, `kind` for conditions / statics / as-enters, `on` for
// triggers), and plain string literals for the enum-shaped registries (`amounts`, `targetKinds`). Once the composer
// slice lands, `EffectSchema = z.discriminatedUnion('op', [...core, ...every family's `schema.effects`])`, and a
// script may then use `saga-lore` the way it uses a core op.
//
// The nested slots (`Amount`, `TargetSpec`) are the core's own shapes; they are referenced loosely here rather than
// re-declared, because `src/cards/schema.ts` owns their single definition and the composer substitutes it.
import { z } from 'zod';
import type { FamilySchema } from './types.js';

/** The core `Amount` shape, referenced (not re-declared): a number, the literal 'X', or an amount expression object. */
const AmountLike = z.union([z.number(), z.literal('X'), z.looseObject({})]);
/** The core `TargetSpec` shape, referenced the same way — `kind` is what a family widens, and 'saga' is this one's. */
const TargetSpecLike = z.looseObject({ kind: z.string() });

export const schema: FamilySchema = {
  effects: [
    // "Put a lore counter on target Saga you control." / "Remove a lore counter from target Saga you control."
    z.strictObject({
      op: z.literal('saga-lore'),
      target: z.union([TargetSpecLike, z.literal('each-saga-you-control')]),
      amount: AmountLike,
      remove: z.boolean().optional(),
    }),
  ],
  conditions: [
    // "as long as there are four or more lore counters among Sagas you control"
    z.strictObject({
      kind: z.literal('saga-lore-ge'),
      who: z.enum(['you', 'opponent', 'any']),
      value: z.number().int().nonnegative(),
    }),
  ],
  triggers: [
    // "Whenever you put a lore counter on a Saga you control, …"
    z.strictObject({
      on: z.literal('lore-counter-put'),
      who: z.enum(['you', 'any']),
    }),
    // "Whenever the final chapter ability of a Saga you control triggers / resolves, …"
    z.strictObject({
      on: z.literal('saga-final-chapter'),
      who: z.enum(['you', 'any']),
      when: z.enum(['triggers', 'resolves']),
    }),
  ],
  asEnters: [
    // Read ahead (CR 714.4b)
    z.strictObject({ kind: z.literal('read-ahead') }),
  ],
  targetKinds: ['saga'],
};

export default schema;
