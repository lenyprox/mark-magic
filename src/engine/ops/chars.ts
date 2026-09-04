// The computed characteristics a hook may call — the sanctioned way around rule 2 ("only type imports from the core
// at module scope"). A *synchronous* hook (conditions, amounts, statics, triggers, canAttack/canBlock, blockCheck,
// legalActions, decisions, targetKinds) cannot `await import('../characteristics.js')` and is handed only a
// GameState/GameObject, so without this bundle a combat restriction like "can't be blocked by creatures with power 2
// or less" would have no legal implementation.
//
// This file is a leaf: it imports nothing at runtime, so a family may `import { chars } from './chars.js'` at module
// scope with no evaluation cycle. `characteristics.ts` fills it in (bindChars) as its own module body runs, which is
// long before any hook can fire — call `chars.x(...)` inside a hook body, never at module scope.
//
//   import { chars } from './chars.js';
//   keywordHooks: { canBlock: (s, blocker) => chars.power(s, blocker) <= 2 ? false : undefined }
import type * as Characteristics from '../characteristics.js';

/** The subset of `characteristics.ts` hooks may use; the types are the core's own, so they can never drift. */
export type Chars = Pick<typeof Characteristics,
  | 'power' | 'toughness' | 'keywords' | 'hasKeyword' | 'flags'
  | 'types' | 'subtypes' | 'colors' | 'name' | 'manaValueOf' | 'isCreature' | 'isLand' | 'isType'
  | 'defOf' | 'abilitiesOf' | 'printedAbilities'
  | 'matchesFilter' | 'evalAmount' | 'conditionHolds'
  | 'allPermanents' | 'battlefieldOf' | 'findObject' | 'isPhasedOut' | 'phasingOn'
  | 'canAttack' | 'canBlock' | 'protectedFrom'>;

/** The bundle. Empty until `characteristics.ts` binds it (which happens when the engine is imported at all). */
export const chars = {} as Chars;

/** Called once by `characteristics.ts`; not for families. */
export function bindChars(impl: Chars): void { Object.assign(chars, impl); }
