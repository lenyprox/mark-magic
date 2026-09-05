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

/** The scope fields every combat-restr static carries (see `RestrScope` / `RestrSide` in ./combat-restr.ts). */
const SCOPE = {
  scope: z.enum(['self', 'enchanted', 'equipped', 'filter']),
  filter: FilterSchema.optional(),
  side: z.enum(['you', 'opponents', 'all']).optional(),
};

/** `TargetSpec | Ref` — the target slot every one-shot combat restriction takes. */
const TargetOrRef = z.union([TargetSpecSchema, RefSchema]);

export const schema: FamilySchema = {
  effects: [
    z.strictObject({
      op: z.literal('restrict-blocking'),
      whose: z.enum(['all', 'you', 'opponents']),
      filter: FilterSchema.optional(),
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
    z.strictObject({ kind: z.literal('cant-be-blocked-except-by'), ...SCOPE, by: FilterSchema.optional(), least: N.optional(), power: z.literal('ge-source').optional() }),
    z.strictObject({ kind: z.literal('cant-be-blocked-by'), ...SCOPE, by: FilterSchema }),
    z.strictObject({ kind: z.literal('cant-block-creatures'), ...SCOPE, what: FilterSchema.optional(), only: FilterSchema.optional(), power: z.literal('gt-self').optional() }),
    z.strictObject({ kind: z.literal('cant-act-alone'), ...SCOPE, attack: B.optional(), block: B.optional() }),
    z.strictObject({ kind: z.literal('damage-as-though-unblocked'), ...SCOPE }),
  ],
};

export default schema;
