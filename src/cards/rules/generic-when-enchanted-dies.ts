// Parser rules for the generic-when-enchanted-dies family (Phase 9.1p; the parse:why construct
// `trigger-head|When enchanted creature dies`, 54 paper-pool cards, 27 of them one rule short of a full parse).
//
// One trigger head, and nothing else. src/cards/parse.ts already reads the *Whenever* spelling of it —
// `whenever (equipped|enchanted) (creature|permanent) dies` → `{ on: 'dies', self: false, filter:
// { attachedToSource: true }, controller: 'any' }` — but every Aura that prints this as a one-shot writes **When**
// (CR 603.2: "when", "whenever" and "at" are the same trigger word; the difference is prose, not rules), so the head
// falls through to `{ on: 'unknown' }` and takes the whole line with it. Demonic Vigor, Bequeathal, Angelic Destiny,
// Minion's Return, Fungal Fortitude, Pattern of Rebirth … all parse their *bodies* today and fail on the head alone.
//
// CLAIMS — exactly one wording, and it emits byte-for-byte what the built-in emits for its "Whenever" twin:
//
//   trigger   "When enchanted creature dies"   →  { on: 'dies', self: false, filter: { attachedToSource: true },
//                                                   controller: 'any' }
//
//     * "enchanted creature" is the permanent this Aura is attached to (CR 303.4a), which is what the
//       `attachedToSource` filter means: `characteristics.ts:matchesFilter` reads `source.attachedTo === o.id`.
//     * "dies" is "put into a graveyard from the battlefield" (CR 700.4). The Aura is still attached when the
//       trigger is matched — a leave-the-battlefield ability looks back in time at the game state before the event
//       (CR 603.10a), and `Game.moveTo` queues `dies` before it detaches anything for exactly that reason — so the
//       Aura still sees the creature it enchanted even though both are on their way to the graveyard (the Aura by
//       the attachment state-based action, CR 704.5m).
//     * `controller: 'any'`: the printed head says nothing about who controlled the creature, and an Aura may
//       enchant a creature an opponent controls (Minion's Return, Abduction).
//
// DECLINES — the wordings a reader will find one shelf over. Each is left `unknown`, and each has a decline pin in
// test/parser-generic-when-enchanted-dies.test.ts:
//
//   "When enchanted permanent dies or is put into exile"  (Kaya's Ghostform) — a compound head. A `TriggerRule` is
//       handed nothing but the head string (no `EffectCtx`, no sub-parsers), so it cannot build the `or` branch, and
//       the engine has no "put into exile from the battlefield" trigger event to build it out of anyway.
//   "When enchanted permanent dies"                       (the bare form) — `Game.moveTo` queues the `dies` event
//       only `if (zone === 'graveyard' && creature)`, so a non-creature permanent never raises it. CR 700.4 covers
//       every permanent; claiming this head would silently mis-fire on an enchanted artifact or planeswalker.
//   "When enchanted land dies"                            (the six Zendikons) — same hole: the land is a creature
//       only while the animating static holds, and the head is not the construct this family was written for.
//   "When enchanted artifact is put into a graveyard"     (Tezzeret's Touch, Gremlin Infestation, Viridian Harvest)
//       and the Genju cycle's "When enchanted <basic land> is put into a graveyard" — the old templating for the
//       same event, but on a non-creature permanent, so the same engine hole applies.
//   "Whenever enchanted creature or another modified creature you control dies"  (One with the Kami) — the second
//       branch needs `parseFilterWords` to read "another modified creature you control", and a `TriggerRule` is not
//       given it. Approximating it with `attachedToSource` alone would silently drop half the trigger.
//
// The discipline is src/cards/rules/composition.ts's and src/cards/rules/dice-coin.ts's: a rule never claims what it
// cannot express exactly, and declines rather than approximates. Nothing here imports parse.ts at runtime.
import type { TriggerEvent } from '../types.js';
import type { RuleFamily, TriggerRule } from './types.js';

/**
 * The one head this family reads. Anchored on both ends: "When enchanted creature dies or is put into exile" and
 * "When enchanted creature dies this turn" are different triggers and must stay `unknown`. `Whenever` is deliberately
 * NOT in the alternation — parse.ts's built-in table claims that spelling before the registry is ever consulted, and
 * a registry rule that also matched it would be dead code pretending to be a rule.
 */
const WHEN_ENCHANTED_CREATURE_DIES = /^when enchanted creature dies$/;

const triggers: TriggerRule[] = [
  {
    name: 'when-enchanted-creature-dies',
    make: (head): TriggerEvent | null => {
      const t = head.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!WHEN_ENCHANTED_CREATURE_DIES.test(t)) return null;
      // Byte-identical with parse.ts's `whenever (equipped|enchanted) (creature|permanent) dies` built-in, on purpose:
      // the two spellings of one trigger must not produce two different ASTs (CR 603.2).
      return { on: 'dies', self: false, filter: { attachedToSource: true }, controller: 'any' };
    },
  },
];

const genericWhenEnchantedDies: RuleFamily = { name: 'generic-when-enchanted-dies', triggers };
export default genericWhenEnchantedDies;
