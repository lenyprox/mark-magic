// zod mirror of the `cost-alter` family's AST — TOOLING ONLY. The engine never imports this file (gen-registry skips
// every `<family>.schema.ts`), so zod stays out of the game and out of the web worker bundle.
//
// The schema composer folds `schema` into `src/cards/schema.ts`'s unions, so a per-card script may use these ops:
// each list entry is a STRICT object whose discriminator is a `z.literal` (`op` for effects, `kind` for conditions /
// statics / as-enters, `on` for triggers), and `amounts` / `targetKinds` are the bare string literals the family
// registers. The shared refs below are pulled through `z.lazy` on purpose: once the composer makes schema.ts import
// this file the two modules are a cycle, and a lazy reference is resolved at parse time rather than at module
// evaluation, so neither half sees a half-built binding.
import { z } from 'zod';
import type { FamilySchema } from './types.js';
import { AmountSchema, ConditionSchema, FilterSchema } from '../../cards/schema.js';

const Amount = z.lazy(() => AmountSchema);
const Condition = z.lazy(() => ConditionSchema);
const Filter = z.lazy(() => FilterSchema);
const CAST_ZONES = ['hand', 'graveyard', 'exile', 'command'] as const;   // = CastZone in src/cards/types.ts

export const schema: FamilySchema = {
  effects: [
    // "You may cast a spell with mana value X or less from your hand without paying its mana cost."
    z.strictObject({
      op: z.literal('cast-free'),
      from: z.enum(['hand', 'graveyard', 'exile', 'exiled-with']),
      filter: Filter.optional(),
      mvLE: Amount.optional(),
      optional: z.literal(true).optional(),
    }),
    // "Hideaway N" (CR 702.75).
    z.strictObject({ op: z.literal('hideaway'), count: z.number().int().min(1) }),
  ],
  statics: [
    // "~ costs {2} less to cast if you control a Wizard", "Spells your opponents cast cost {2} more to cast".
    z.strictObject({
      kind: z.literal('cost-alter'),
      amount: Amount,
      more: z.literal(true).optional(),
      self: z.literal(true).optional(),
      who: z.enum(['you', 'opponent', 'any']).optional(),
      filter: Filter.optional(),
      from: z.enum([...CAST_ZONES, 'non-hand']).optional(),
      condition: Condition.optional(),
      nthSpellEachTurn: z.number().int().min(1).optional(),
    }),
    // "You may cast <filter> spells from your graveyard [without paying their mana cost]."
    z.strictObject({
      kind: z.literal('cast-from'),
      zone: z.enum(['graveyard', 'exile']),
      filter: Filter.optional(),
      free: z.literal(true).optional(),
    }),
  ],
  amounts: ['party'],
  costParts: {
    exileSelf: z.literal(true),
    exileSelfFromGraveyard: z.literal(true),
    sacrificeMany: z.strictObject({ filter: Filter, count: z.number().int().min(1) }),
    returnToHandMany: z.strictObject({ filter: Filter, count: z.number().int().min(1) }),
    exileFromGraveyardMatching: z.strictObject({ count: z.number().int().min(1), filter: Filter.optional() }),
  },
  targetKinds: ['exiled-with-card'],
};
