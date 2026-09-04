// The engine extensibility contract. A mechanic family is one file `src/engine/ops/<family>.ts` whose default export
// is a `FamilyModule`; `npm run gen:registry` folds every such file into the generated barrel `_registry.ts`, and the
// core consults the barrel's flat lookups from its `default:` branches and fold loops. Families never edit core files.
//
// Two hard rules make this safe (both linted by test/lint-ops.test.ts):
//   1. no `node:` imports — ops are bundled into the web worker;
//   2. only *type* imports from the core at module scope. Core values (parse, legal, ...) must be pulled in lazily
//      inside a hook body (`const { legalActions } = await import('../legal.js')`) or taken from the `Game` handed to
//      the hook, because the core imports the barrel and the barrel imports the families. Computed characteristics are
//      the exception: `import { chars } from './chars.js'` is a leaf import a family may make at module scope, and it
//      is how a *synchronous* hook (which cannot await) reads power/toughness/keywords/matchesFilter — see chars.ts.
import type { Ability, AbilityCost, AltCost, Amount, CardDef, CastZone, Effect, Filter, Keyword, ManaCost, ManaSymbol, TargetSpec } from '../../cards/types.js';
import type { AmountCtx } from '../characteristics.js';
import type { GameEventBody } from '../events.js';
import type { Game, TriggerCtx } from '../game.js';
import type { Decision, GameObject, GameState, LegalAction, Player, PlayerAction, PlayerId, StackItem, Step, TargetRef, TokenSpec, Zone } from '../state.js';

export type { AmountCtx, TriggerCtx };

/** JSON-plain values: everything an `ext` bag may hold (clone deep-copies these, serialize round-trips them). */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** What an effect op is handed: the locals `applyEffect` already computed, built lazily only for a registry op. */
export interface OpCtx {
  g: Game; s: GameState; item: StackItem; p: PlayerId; src: GameObject;
  /** Targets chosen for this effect index. */ T: TargetRef[];
  /** This effect's index in the item's effect list. */ idx: number;
  /** Evaluate an Amount in this item's context (X, "that", colours spent). */ amt(a: Amount): number;
  /** The target objects of this effect (players filtered out). */ objs(): GameObject[];
  /** The target players of this effect. */ players(): PlayerId[];
  /** Recurse into another effect with the same item/index (how `conditional` and `optional-then` compose). */ apply(e: Effect): Promise<void>;
}

/** Static modifications collected for one permanent (a simplified CR 613 layer pass). */
export interface Mods {
  p: number; t: number; kw: Keyword[]; landwalk?: string[];
  /** Layer 7b-lite: a base power/toughness set by a static ("becomes a 4/4"), applied before the additive terms. */
  setPT?: { power: number; toughness: number };
  flags: { cantAttack?: boolean; cantBlock?: boolean; cantAttackOrBlock?: boolean; doesntUntap?: boolean } & Record<string, boolean | undefined>;
}

/** The context an as-enters hook gets; writing `ctx.entersTapped` changes whether the permanent enters tapped. */
export interface EnterCtx {
  controller: PlayerId; via: 'cast' | 'land-drop' | 'token' | 'effect'; item?: StackItem;
  /** Set from moveTo's exile-return path: skip every decision. */ sync?: boolean;
  /** The X the permanent was cast with (enters-with-counters). */ x: number;
  /** Whether it is entering tapped so far; a hook may flip it. */ entersTapped: boolean;
}

/** What a zone-move replacement returns; `null` = no replacement. */
export interface ZoneMoveOverride {
  /** Send it to this zone instead. */ zone?: Zone;
  /** Library position when `zone` is 'library'. */ pos?: 'top' | 'bottom';
  /** Leave it where it is: the move does not happen at all. Nothing has moved yet when the hook runs, so the object keeps its zone, its place in that zone's array and its battlefield state (animated / face-down / earthbent). */ cancel?: boolean;
  /** A log line for the replacement (emitted as a `note`). */ emit?: string;
}

/** One combat damage assignment, before it is dealt. */
export interface DamageAssignment { src: GameObject; to: GameObject | PlayerId; n: number }

/** A non-mana cost part keyed by its `AbilityCost` field name. */
export interface CostPart {
  /** Can this part be paid right now? (cost.ts:nonManaCostPayable) */
  payable(v: unknown, s: GameState, pl: Player, self: GameObject): boolean;
  /** Pay it (game.ts:payCost); returning false aborts the payment. */
  pay(v: unknown, g: Game, p: PlayerId, self: GameObject, label: string, item?: StackItem): Promise<boolean>;
}

/** A token's built-in activated ability (Treasure, Clue, Food, Eldrazi Spawn and whatever a family adds). */
export interface TokenAbility {
  /** The negative ability index this token's built-in ability answers to. */ index: number;
  /** The `TokenSpec` flag that marks the token; a family token without one is marked by `o.ext.tokenAbility = <name>`. */ flag?: keyof TokenSpec;
  /** A legal action for it right now, or null. */ legal(g: Game, p: PlayerId, o: GameObject): LegalAction | null;
  /** Perform it (already matched on `index`). */ activate(g: Game, p: PlayerId, o: GameObject): Promise<boolean>;
}

/** Metadata for a family event type: whether it reaches the string log, its CR citation and its renderer. */
export interface EventMeta { logged?: boolean; cr?: string; render?(ev: GameEventBody, pname: (p: PlayerId) => string): string }

export interface FamilyModule {
  /** Unique family name; also the file's basename by convention. */
  name: string;
  /** `applyEffect` default branch: `EFFECT_OPS[e.op](e, ctx)`. */
  effects?: Record<string, (e: never, c: OpCtx) => void | Promise<void>>;
  /** `conditionHolds` default branch. */
  conditions?: Record<string, (cond: never, s: GameState, src: GameObject) => boolean>;
  /** `evalAmount` default branch, keyed by `Amount.count`. */
  amounts?: Record<string, (a: never, s: GameState, ctrl: PlayerId, x: number, src?: GameObject, ctx?: AmountCtx) => number>;
  /** Does this permanent's trigger fire? Keyed by `TriggerEvent.on` and consulted *instead of* the core switch, for
   * every event the core queues: `event` is what actually happened, so a family trigger keys off a core event with an
   * extra condition (dethrone on 'attacks', afflict on 'becomes-blocked', exploit on 'etb') as well as off its own
   * queued event. A permanent carrying one is offered every event, so return false fast when `event` is not yours. */
  triggers?: Record<string, (ev: never, perm: GameObject, ctx: TriggerCtx, s: GameState, event: string) => boolean>;
  /** `computeStaticMods` after the built-in kinds, keyed by `StaticEffect.kind`. */
  statics?: Record<string, (e: never, src: GameObject, o: GameObject, s: GameState, m: Mods) => void>;
  /** Non-core `AbilityCost` keys (`nonManaCostPayable` + `payCost`). */
  costParts?: Record<string, CostPart>;
  /** Non-core `AsEnters.kind`s (`enterBattlefield`). */
  asEnters?: Record<string, (a: never, o: GameObject, ctx: EnterCtx, g: Game) => Promise<void> | void>;
  /** Replacement effects ("if ... would ..., instead") and prevention shields. */
  replacements?: {
    /** `moveTo`, right after the commander redirect. */
    zoneMove?(g: Game, o: GameObject, zone: Zone, pos: 'top' | 'bottom', reason: string): ZoneMoveOverride | null;
    /** `dealDamage` / `dealDamageToPlayer`, after protection and prevention shields; return the new amount. */
    damage?(g: Game, src: GameObject, target: GameObject | PlayerId, n: number, combat: boolean): number;
    /** `draw`, after the dredge block; return true when the draw was replaced (no card is drawn). */
    draw?(g: Game, p: PlayerId): boolean;
    /** `replaceCounters`; return the new delta. */
    counters?(g: Game, o: GameObject, counter: string, delta: number): number;
    /** `gainLife`; return the new amount. */
    lifeGain?(g: Game, p: PlayerId, n: number): number;
  };
  /** Run after each step's built-in work; `'turn-start'` runs before untap, `'cleanup-end'` after the end-of-turn wipe. */
  steps?: Partial<Record<Step | 'cleanup-end' | 'turn-start', (g: Game, ap: PlayerId) => Promise<void> | void>>;
  /** Extra state-based actions inside `checkSBA`'s loop; return true when something changed (the loop runs again). */
  sba?: (g: Game) => boolean;
  /** Extra legal actions, appended at the end of `legalActions`. */
  legalActions?: (g: Game, p: PlayerId, out: LegalAction[], sorceryTiming: boolean) => void;
  /** `performAction` default branch, keyed by `PlayerAction.type`. */
  actions?: Record<string, (g: Game, p: PlayerId, a: never) => Promise<boolean>>;
  /** `defaultAnswer` default branch, keyed by `Decision.kind`. */
  decisions?: Record<string, (s: GameState, me: PlayerId, d: never) => unknown>;
  /** Combat restrictions and requirements. */
  keywordHooks?: {
    /** Consulted before `canBlock` returns true; `false` forbids, `undefined` abstains. */
    canBlock?(s: GameState, blocker: GameObject, attacker: GameObject): boolean | undefined;
    /** Consulted before `canAttack` returns true; `false` forbids, `undefined` abstains. */
    canAttack?(s: GameState, o: GameObject): boolean | undefined;
    /** Extra validation of one declared block (lure, "can't block alone"); false drops the block. */
    blockCheck?(s: GameState, blocker: GameObject, attacker: GameObject): boolean;
    /** Rewrite the declared blocks of one defender ("blocks if able", lure). */
    blockFixup?(g: Game, attackers: GameObject[], defender: PlayerId): void;
    /** Rewrite combat damage after the assignments are built and before they are dealt. */
    combatDamage?(g: Game, assignments: DamageAssignment[]): void;
  };
  /** Extra objects `queueTriggers` scans beyond `allPermanents` (emblems, command-zone statics). */
  triggerSources?: (s: GameState) => GameObject[];
  /** Metadata for the family's own event types. */
  events?: Record<string, EventMeta>;
  /** Scrub hidden family state from one object for a viewer (`view.ts:redact`). */
  redact?: (o: GameObject, viewer: PlayerId) => void;
  /** Scrub hidden family state from one player's `ext` bag for a viewer (secret piles, votes, chosen names). */
  redactPlayer?: (pl: Player, viewer: PlayerId) => void;
  /** Scrub hidden family state from the game's own `ext` bag for a viewer. */
  redactState?: (s: GameState, viewer: PlayerId) => void;
  /** Called for every permanent in the end-of-turn wipe loop. */
  cleanupEot?: (g: Game, o: GameObject) => void;
  /** Non-core `TargetSpec.kind`s (`legal.ts:targetOptionsFor`). */
  targetKinds?: Record<string, (g: Game, controller: PlayerId, source: GameObject, spec: TargetSpec) => TargetRef[]>;
  /** Built-in abilities of predefined tokens, keyed by token name. */
  tokenAbilities?: Record<string, TokenAbility>;
  /** Called from `moveTo` when a permanent leaves the battlefield (where "exile until this leaves" is handled). */
  leave?: (g: Game, o: GameObject, zone: Zone) => void;
  /** `cost.ts:spellManaCost`: what the chosen modes add to the cost actually paid (entwine, escalate, spree, multikicker); `null` abstains. */
  modeCost?: (def: CardDef, modes: number[], alt: AltCost | undefined, kicked: boolean) => ManaCost | null;
  /** `cost.ts:costAdjust`: extra generic-mana reduction for casting `card` from `from` (positive = cheaper, negative = a tax). Cost-alteration statics the core's fixed-`amount` `cost-adjust` cannot express live here. */
  costMod?: (s: GameState, p: PlayerId, card: GameObject, from: CastZone) => number;
  /** `castSpell`'s `from` gate: `true` allows the cast from that zone, `false` forbids, `undefined` abstains. */
  castFrom?: (g: Game, p: PlayerId, card: GameObject, from: CastZone) => boolean | undefined;
  /** `castSpell`'s free-cast computation: `true` = no mana cost is paid, `undefined` abstains. */
  freeCast?: (g: Game, p: PlayerId, card: GameObject, from: CastZone) => boolean | undefined;
  /** Round-trip English per op (the renderer the script verification pipeline uses). */
  render?: Record<string, (e: never) => string>;
  /** zod schemas live in `<family>.schema.ts` (tooling only, never imported by the engine). */
  schema?: never;
}

// Re-exported so a family file needs one import for everything it touches.
export type { Ability, AbilityCost, AltCost, Amount, CardDef, CastZone, Decision, Effect, Filter, Game, GameEventBody, GameObject, GameState, Keyword, LegalAction, ManaCost, ManaSymbol, Player, PlayerAction, PlayerId, StackItem, Step, TargetRef, TargetSpec, TokenSpec, Zone };
