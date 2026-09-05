// zod variants for the `combat-restr` family (Phase 9.1) — TOOLING ONLY.
//
// The engine never imports this file (zod is a devDependency and must not reach the game or the web bundle); it is
// the half of the family contract that lets a per-card SCRIPT use these ops: the schema composer folds `schema` below
// into `CardScriptChecked`, so `scripts:check` / `scripts:verify` / `scripts:schema` validate a script that emits
// `{ "op": "lure", … }` or a static `{ "kind": "must-be-blocked", … }` exactly as they validate a core one.
//
// Every entry is a STRICT object whose discriminator is a `z.literal` — `op` for effects, `kind` for conditions,
// statics and as-enters, `on` for triggers — so a misspelt field in a hand- or LLM-written script is a validation
// error rather than a silently dropped clause. `amounts` and `targetKinds` are plain string literals: those two
// registries are keyed by name, not by an object shape.
//
// The field-level semantics live in docs/vocabulary/combat-restr.md; the engine side is ./combat-restr.ts.
import { z } from 'zod';
import { FilterSchema, RefSchema, TargetSpecSchema } from '../../cards/schema.js';
import type { Filter, Ref, TargetSpec } from '../../cards/types.js';

/**
 * What a family's `<family>.schema.ts` exports. `src/engine/ops/types.ts` declares no such type yet (it is the
 * engine contract and may not import zod), so it is declared here with the shape the wave's contract fixes; the
 * schema-composer slice adopts this declaration when it lands.
 */
export type FamilyVariant = z.ZodObject;
export interface FamilySchema {
  /** New `Effect` variants, discriminated by `op`. */
  effects?: readonly FamilyVariant[];
  /** New `Condition` variants, discriminated by `kind`. */
  conditions?: readonly FamilyVariant[];
  /** New `TriggerEvent` variants, discriminated by `on`. */
  triggers?: readonly FamilyVariant[];
  /** New `StaticEffect` variants, discriminated by `kind`. */
  statics?: readonly FamilyVariant[];
  /** New `Amount.count` names. */
  amounts?: readonly string[];
  /** New non-core `AbilityCost` keys, each with the schema of its value. */
  costParts?: Readonly<Record<string, z.ZodType>>;
  /** New `AsEnters` variants, discriminated by `kind`. */
  asEnters?: readonly FamilyVariant[];
  /** New `TargetSpec.kind` names. */
  targetKinds?: readonly string[];
}

const B = z.boolean();
const N = z.number();

// Forward references, exactly the idiom src/cards/schema.ts uses for its own recursive positions, and here for a
// second reason: the composer folds this file into schema.ts, so schema.ts imports it and it imports schema.ts.
// `z.lazy` is what makes that cycle safe — nothing in this module's body reads a binding of schema.ts while
// schema.ts is still evaluating; the annotation keeps `z.infer` exactly pinned to the AST type all the same.
const FilterRef: z.ZodType<Filter> = z.lazy(() => FilterSchema);
const TargetSpecRef: z.ZodType<TargetSpec> = z.lazy(() => TargetSpecSchema);
const RefRef: z.ZodType<Ref> = z.lazy(() => RefSchema);

/** The scope fields every combat-restr static carries (see `RestrScope` / `RestrSide` in ./combat-restr.ts). */
const SCOPE = {
  scope: z.enum(['self', 'enchanted', 'equipped', 'filter']),
  filter: FilterRef.optional(),
  side: z.enum(['you', 'opponents', 'all']).optional(),
};

/** `TargetSpec | Ref` — the target slot every one-shot combat restriction takes. */
const TargetOrRef = z.union([TargetSpecRef, RefRef]);

// `as const satisfies` rather than a `: FamilySchema` annotation: the annotation would widen every variant to the
// bare `z.ZodObject`, whose inferred output is `Record<string, unknown>`, and the composed union in schema.ts would
// stop matching `Effect` — `test/schema-types.test.ts`'s `Equals<>` pins would fail. `satisfies` checks exactly the
// same contract and keeps each variant's own inferred shape, which is what the pins are made of.
export const schema = {
  effects: [
    z.strictObject({
      op: z.literal('restrict-blocking'),
      whose: z.enum(['all', 'you', 'opponents']),
      filter: FilterRef.optional(),
      duration: z.literal('eot'),
    }),
    z.strictObject({
      op: z.literal('cant-block-source'),
      target: TargetOrRef,
      duration: z.literal('eot'),
    }),
    z.strictObject({
      op: z.literal('blocks-if-able'),
      target: TargetOrRef,
      duration: z.literal('eot'),
    }),
    z.strictObject({
      op: z.literal('lure'),
      target: TargetOrRef,
      duration: z.literal('eot'),
    }),
    z.strictObject({ op: z.literal('extra-combat') }),
  ],
  statics: [
    z.strictObject({ kind: z.literal('must-be-blocked'), ...SCOPE, all: B.optional() }),
    z.strictObject({ kind: z.literal('cant-be-blocked-except-by'), ...SCOPE, by: FilterRef.optional(), least: N.optional(), power: z.literal('ge-source').optional() }),
    z.strictObject({ kind: z.literal('cant-be-blocked-by'), ...SCOPE, by: FilterRef }),
    z.strictObject({ kind: z.literal('cant-block-creatures'), ...SCOPE, what: FilterRef.optional(), only: FilterRef.optional(), power: z.literal('gt-self').optional() }),
    z.strictObject({ kind: z.literal('cant-act-alone'), ...SCOPE, attack: B.optional(), block: B.optional() }),
    z.strictObject({ kind: z.literal('damage-as-though-unblocked'), ...SCOPE }),
  ],
} as const satisfies FamilySchema;

export default schema;
