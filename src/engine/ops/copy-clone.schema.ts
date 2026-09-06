// zod mirror of the copy / clone family's AST (Phase 9.1). TOOLING ONLY — the engine never imports this file, the
// generated barrel skips every `<family>.schema.ts`, and zod stays a devDependency that never reaches the worker.
//
// The shape is the family-schema contract of docs/vocabulary/README.md: one `schema` export whose lists hold STRICT
// z.objects discriminated by a `z.literal` (`op` for effects, `kind` for conditions / statics / as-enters, `on` for
// triggers), plus plain string literals for the amount counts and target kinds a family mints. The script
// schema-composer folds these into `CardScriptChecked`, so a per-card script may use `copy-permanent`,
// `copy-stack`, `change-targets`, `become-copy`, the `enter-as-copy` as-enters, the `cant-be-copied` static and the
// two stack target kinds, and `scripts:check` / `scripts:verify` validate them exactly as they validate core ops.
import { z } from 'zod';
import type { FamilySchema } from './types.js';
import { AbilitySchema, AmountSchema, CardTypeSchema, ColorSchema, FilterSchema, KeywordSchema, RefSchema, TargetSpecSchema } from '../../cards/schema.js';

/** A target spec or a Ref: every copy op names what it copies either way (composition.md §1). */
const TargetOrRef = z.union([TargetSpecSchema, RefSchema]);

/** The "except ..." clause (CR 707.9a). Replacing fields and `add*` fields are separate on purpose. */
export const CopyExceptionSchema = z.strictObject({
  power: z.number().optional(),
  toughness: z.number().optional(),
  colors: z.array(ColorSchema).optional(),
  name: z.string().optional(),
  types: z.array(CardTypeSchema).optional(),
  addTypes: z.array(CardTypeSchema).optional(),
  subtypes: z.array(z.string()).optional(),
  addSubtypes: z.array(z.string()).optional(),
  keywords: z.array(KeywordSchema).optional(),
  toxic: z.number().optional(),
  notLegendary: z.boolean().optional(),
  loseAbilities: z.boolean().optional(),
  abilities: z.array(AbilitySchema).optional(),
}).refine(e => Object.keys(e).length > 0, 'an "except" clause with no fields changes nothing — drop it');

export const schema: FamilySchema = {
  effects: [
    // "Create a token that's a copy of target creature you control, except it's a 4/4 black Zombie." (CR 707.2)
    z.strictObject({
      op: z.literal('copy-permanent'),
      target: TargetOrRef,
      count: AmountSchema.optional(),
      except: CopyExceptionSchema.optional(),
      tapped: z.boolean().optional(),
      attacking: z.union([z.boolean(), z.literal('each-other-opponent')]).optional(),
    }),
    // "Copy target instant or sorcery spell. You may choose new targets for the copy." (CR 707.10)
    z.strictObject({
      op: z.literal('copy-stack'),
      target: TargetOrRef,
      count: AmountSchema.optional(),
      newTargets: z.literal('may').optional(),
    }),
    // "You may choose new targets for target spell or ability." / "Change the target of ..." (CR 115.7)
    z.strictObject({
      op: z.literal('change-targets'),
      target: z.union([TargetSpecSchema, z.literal('the-copies')]),
      how: z.enum(['choose-new', 'change-one']),
      optional: z.boolean().optional(),
    }),
    // "~ becomes a copy of target creature until end of turn." (CR 706.2, 613.2)
    z.strictObject({
      op: z.literal('become-copy'),
      target: TargetOrRef,
      becomes: RefSchema.optional(),
      duration: z.enum(['eot', 'permanent']),
      except: CopyExceptionSchema.optional(),
    }),
  ],
  statics: [
    // "~ can't be copied." — folded into Mods.flags.cantBeCopied, which every copy op consults.
    z.strictObject({
      kind: z.literal('cant-be-copied'),
      scope: z.enum(['self', 'you-control']),
      filter: FilterSchema.optional(),
    }),
  ],
  asEnters: [
    // "You may have ~ enter as a copy of any creature on the battlefield." (CR 706.9)
    z.strictObject({
      kind: z.literal('enter-as-copy'),
      filter: FilterSchema.optional(),
      who: z.enum(['you', 'any']).optional(),
      optional: z.boolean().optional(),
      except: CopyExceptionSchema.optional(),
    }),
  ],
  // CR 115.7's two stack kinds, plus the four that ask what the core `spell` / `ability` kinds do not: whose spell it
  // is (CR 115.4 "you control") and whether an ability on the stack is activated or triggered (CR 113.3a-c).
  targetKinds: [
    'spell-or-ability', 'single-target-spell-or-ability', 'single-target-spell',
    'stack-spell', 'stack-ability', 'stack-activated-ability', 'stack-triggered-ability',
  ],
};
