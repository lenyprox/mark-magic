// Parser rules for the generic-deals-damage family (Phase 9.1p; the parse:why item "sentence: ~ deals # damage to
// that <player>" — 60 paper-pool cards whose one unclaimed fragment is the *body* of a "punisher" trigger).
//
// The whole family is one sentence shape. A triggered ability whose head named a player ("Whenever an opponent draws
// a card", "At the beginning of each player's upkeep", "Whenever a player casts a noncreature spell") refers back to
// that player in its body with the anaphor "that player" (CR 608.2, the resolving ability reads the event that caused
// it). The engine already carries exactly that referent on the resolving stack item — `item.triggeringPlayer`, the
// `ScopeWho` word `that-player` (src/engine/refs.ts `thatPlayer`) — and it already knows how to make a source deal
// damage to the player a block is running as (`damage-you` inside a `scoped`, docs/vocabulary/composition.md §"scoped
// — run effects as another player"). So the claim is a pure composition of two ops the engine has:
//
//     ~ deals N damage to that player   ->   scoped that-player { damage-you N }
//
// which deals N damage from the ability's source to that player (CR 120.3: damage from a source, not life loss —
// lifelink, damage prevention, Sulfuric Vortex-style replacement and "damage dealt by ~" all see it, which a
// `lose-life` would not).
//
// CLAIMS (each pinned in test/parser-generic-deals-damage.test.ts, each an EffectRule on the *sentence* ladder):
//
//   "~ deals 1 damage to that player"            Underworld Dreams, Fate Unraveler, Ob Nixilis, the Hate-Twisted
//   "~ deals 2 damage to that player"            Megrim, Spellshock, Aether Sting, Mindsparker, Pyrostatic Pillar
//   "~ deals 6 damage to that player"            Ruric Thar, the Unbowed   (any literal count; see DECLINES for "X")
//                                                — and, through the built-in decompositions that hand the registry
//                                                one part at a time, the same fragment inside "…, then ~ deals N
//                                                damage to that player", "~ deals N damage to that player and you
//                                                gain N life" (Oath of Kaya) and "~ deals N damage to that player
//                                                unless they pay {N}" (the built-in `unless-pays` template).
//
//   ONLY inside a triggered ability's body (`ctx.host.triggering`). That is the one host the engine gives a
//   `triggeringId` / `triggeringPlayer` to, so it is the one host on which `that-player` has the referent the card
//   means. Everywhere else the rule declines rather than let `that-player` fall back to "the controller of whatever
//   the last op touched" (src/engine/refs.ts `thatPlayer`) and silently hit the wrong seat — the 9.1x item-17
//   discipline, and the same refusal src/cards/rules/dice-coin.ts makes for its triggering-frame ops.
//   (An instant/sorcery that said "target player … that player" never reaches here at all: parse.ts rewrites that
//   pronoun to "target player" before any rule runs.)
//
// DECLINES (a pin for each in the test file; the reason is in openIssues):
//
//   "~ deals X damage to that player"                                 X is not defined by the trigger head; no card
//                                                                     in the item prints it (the item's one clause is
//                                                                     "# damage") and an undefined X evaluates 0.
//   "~ deals N damage to that player for each <thing>"                Truth or Consequences, Blood Oath, Mob Verdict:
//                                                                     the multiplier is a vote / a revealed-card
//                                                                     count with no Amount form.
//   "~ deals N damage to that player or a planeswalker that player     Curse of the Pierced Heart: a choice between a
//    controls"                                                        player and one of their planeswalkers; the
//                                                                     `damage` op has no such target.
//   "~ deals N damage to that player and each creature that player     Mob Verdict, The Fall of Kroog: no group word
//    controls" / "… and M damage to each creature they control"       for "each creature that player controls".
//   "that land deals N damage to that player"                         Barbflare Gremlin: the source is not ~.
//   "~ deals N damage to that player or planeswalker"                 Searing Blaze: a player-or-planeswalker referent
//                                                                     the engine does not bind.
//
// Nothing here imports parse.ts at runtime: the shared sub-parsers arrive on the EffectCtx the parser hands the rule.
import type { Effect } from '../types.js';
import type { EffectCtx, EffectRule, RuleFamily } from './types.js';

/**
 * "~ deals N damage to that player" — the source deals the damage, so it is a `damage` from ~ and never a `lose-life`
 * (CR 120.3). Only a *literal* count is claimed: the item's single clause is "# damage", and an "X damage" a trigger
 * head never defined would evaluate 0 while the card counted as parsed.
 */
const DEALS_THAT_PLAYER = /^~ deals (\d+) damage to that player$/i;

/**
 * The block that deals it. `scoped` re-binds "you" to the player the word names for the ops inside it
 * (docs/vocabulary/composition.md §"scoped"), and `damage-you` is "~ deals N damage to you" — together, N damage from
 * the ability's source to that player, with the source, the prevention shields and every "damage dealt by ~" reading
 * intact.
 */
function dealToThatPlayer(amount: number): Effect {
  return { op: 'scoped', who: 'that-player', do: [{ op: 'damage-you', amount }] };
}

/**
 * May this sentence say "that player" at all? Only in a triggered ability's body: `item.triggeringPlayer` is set only
 * there (src/engine/game.ts, the trigger → stack site), and it is the only referent that is the player the card's
 * trigger head named. Off a trigger, `thatPlayer` falls through to "the controller of `that`" and then to "the first
 * player target" — both of which are somebody else's seat for these cards, so the rule declines instead.
 */
const hasThatPlayer = (ctx: EffectCtx): boolean => ctx.host.triggering;

const effects: EffectRule[] = [
  {
    re: DEALS_THAT_PLAYER,
    make: (m, ctx) => (hasThatPlayer(ctx) ? dealToThatPlayer(Number(m[1])) : null),
  },
];

const genericDealsDamage: RuleFamily = { name: 'generic-deals-damage', effects };
export default genericDealsDamage;
