// The strict zod schema of a card script — the core vocabulary (./schema-core.ts) COMPOSED with every mechanic
// family's `src/engine/ops/<family>.schema.ts` (listed by the generated ./_schemas.ts). This is the module every
// consumer imports: `scripts:check`, `scripts:verify` (stage 1 is `CardScriptChecked`), `scripts:schema`
// (data/scripts/schema.json), the lint (src/cards/lint.ts derives its vocabularies from the composed unions),
// `vocab:doc` and the tests — and the module a family's `.schema.ts` imports its leaf schemas from.
//
// It defines nothing of its own on purpose. Everything lives in ./schema-core.ts and is re-exported here as an
// INDIRECT binding, because this module sits in an import cycle: it imports ./_schemas.ts, which imports every
// family's `.schema.ts`, and a family may import `FilterSchema` / `AmountSchema` / `EffectSchema` / … from THIS
// module at its own module scope. A family evaluating in the middle of that cycle reads a binding of this module
// before this module's body has run — fine for a re-export (it resolves to schema-core's environment, which finished
// evaluating before the cycle began), a temporal-dead-zone error for anything declared here. So: re-exports and the
// one side effect that installs the generated family list into the composition (a thunk, read on the first parse).
// The `export *` comes FIRST, before the import of ./_schemas.js: under ESM the order is immaterial (bindings are
// linked before anything evaluates), but a loader that lowers this graph to CommonJS (tsx running a file outside the
// package, a bundler) copies re-exports in statement order into a partially-built exports object, and a family
// evaluating mid-cycle must already find them there.
//
// TOOLING ONLY. Nothing under src/engine, src/sim, src/ai or apps/web may import this file: zod is a devDependency
// and must never reach the game or the web bundle.
export * from './schema-core.js';
import { installFamilySchemas } from './schema-core.js';
import { FAMILY_SCHEMA_ENTRIES } from './_schemas.js';

installFamilySchemas(() => FAMILY_SCHEMA_ENTRIES);

export {
  FAMILY_SCHEMA_ENTRIES, FAMILY_SCHEMAS, FAMILY_EFFECT_VARIANTS, FAMILY_CONDITION_VARIANTS, FAMILY_TRIGGER_VARIANTS, FAMILY_STATIC_VARIANTS,
  FAMILY_AMOUNTS, FAMILY_COST_PARTS, FAMILY_AS_ENTERS, FAMILY_TARGET_KINDS,
} from './_schemas.js';
