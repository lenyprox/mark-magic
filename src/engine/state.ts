// Game state types shared by the engine, the AI and the CLI.
import type { Amount, CardDef, Color, Effect, Keyword, ManaSymbol, Ability, ActivatedAbility, TriggeredAbility } from '../cards/types.js';
import type { GameEvent, GameEventType } from './events.js';

/** A seat index (0..3). Two-player code that assumed 0 | 1 should use the helpers in players.ts. */
export type PlayerId = number;
export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'command';
export type Step = 'untap' | 'upkeep' | 'draw' | 'main1' | 'combat-begin' | 'declare-attackers' | 'declare-blockers' | 'first-strike-damage' | 'combat-damage' | 'combat-end' | 'main2' | 'end' | 'cleanup';

export interface TokenSpec { name: string; power: number; toughness: number; colors: Color[]; types: string[]; subtypes: string[]; keywords: Keyword[]; treasure?: boolean; clue?: boolean; spawn?: boolean; food?: boolean; dynamicPT?: Amount }

export interface GameObject {
  id: number;
  def: CardDef;
  owner: PlayerId;
  controller: PlayerId;
  zone: Zone;
  tapped: boolean;
  damage: number;
  counters: Record<string, number>;
  enteredTurn: number;             // turn number it came under current control (summoning sickness)
  attachedTo: number | null;       // aura/equipment -> host id
  token: TokenSpec | null;
  // until-end-of-turn modifications
  eotPower: number; eotToughness: number; eotKeywords: Keyword[]; eotFlags: { cantAttackOrBlock?: boolean; cantBlock?: boolean; preventDamage?: number | 'all'; regenerationShield?: number; crewed?: boolean; saddled?: boolean };
  noUntapNext: boolean;
  attacking: PlayerId | null;      // player being attacked (or the controller of the planeswalker being attacked)
  attackingPlaneswalker?: number;  // planeswalker being attacked, if any (CR 508.1)
  blocking: number[];              // attacker ids this creature blocks
  blockedBy: number[];
  activatedThisTurn: Set<number>;  // ability indexes used this turn (once-per-turn / loyalty)
  transformed: boolean;
  lastKnown?: { power: number; toughness: number; controller: PlayerId; counters?: Record<string, number> };
  /** Renown (702.111): already renowned. */
  renowned?: boolean;
  /** Echo paid (the upkeep cost is only due the turn after it came under your control). */
  echoPaid?: boolean;
  /** Unearth / similar: exile it instead if it would leave the battlefield. */
  exileIfLeaves?: boolean;
  /** How the spell was cast (kept on the permanent it became): alternative cost, zone, kicker, X, delve count. */
  castWith?: { alt?: AltCostId; from?: CastZone; kicked?: boolean; x?: number; delved?: number; colorsSpent?: number };
  /** Ids of cards exiled as a cost of casting this (delve) or imprinted on it. */
  exiledWith?: number[];
  chosen?: { creatureType?: string; color?: Color };
  /** Warp / rebound: this exiled card may be cast again from exile after `afterTurn`; `free` = without paying its mana cost, only in `upkeepOnly`'s upkeep. */
  castableFromExile?: { afterTurn: number; free: boolean; upkeepOnly?: PlayerId };
  warpExileTurn?: number;
  /** 0 = front face, 1 = back face of a double-faced card. */
  activeFace?: 0 | 1;
  /** Abilities granted by effects (Saga chapters); indexed after def.abilities. */
  grantedAbilities?: Ability[];
  /** This card is one of its owner's commanders (CR 903.3): it may return to the command zone when it would change zones. */
  commander?: boolean;
}
export type CastZone = 'hand' | 'graveyard' | 'exile' | 'command';
export type AltCostId = 'pitch' | 'life' | 'evoke' | 'warp' | 'impending' | 'flashback' | 'escape' | 'jump-start';

export interface DelayedTrigger { id: number; at: 'next-upkeep' | 'next-end-step' | 'your-next-end-step'; controller: PlayerId; sourceId: number; sourceName: string; effects: Effect[]; affected?: StackItem['affected']; createdTurn: number }

export interface Player {
  id: PlayerId;
  name: string;
  life: number;
  poison: number;
  energy: number;
  library: GameObject[];
  hand: GameObject[];
  graveyard: GameObject[];
  exile: GameObject[];
  battlefield: GameObject[];
  /** Command zone (Commander / Brawl): the player's commanders while not elsewhere. */
  command: GameObject[];
  /** Ids of this player's commanders. */
  commanders: number[];
  /** Times each commander was cast from the command zone (the tax counts them, CR 903.8). */
  commanderCasts: Record<number, number>;
  /** Combat damage taken from each commander id over the game (21 loses, CR 704.6c). */
  commanderDamage: Record<number, number>;
  manaPool: ManaSymbol[];
  landsPlayedThisTurn: number;
  lost: boolean;
  lossReason?: string;
  attackedThisTurn: boolean;
  lifeLostThisTurn: number;
  creaturesDiedThisTurn: number;
  spellsCastThisTurn: number;
  turnsTaken?: number;
  permanentsLeftThisTurn?: number;
  cardsDrawnThisTurn?: number;
  lifeGainedThisTurn?: number;
}

export interface StackItem {
  id: number;
  kind: 'spell' | 'ability' | 'trigger';
  name: string;
  source: GameObject;               // the card (for spells) or permanent (for abilities)
  controller: PlayerId;
  effects: Effect[];
  targets: (number | PlayerId | { player: PlayerId })[]; // one entry per targeting effect, in order
  targetsByEffect: Map<number, TargetRef[]>;             // effect index -> chosen targets
  x: number;
  modes?: number[];
  ability?: Ability;
  abilityIndex?: number;
  kicked?: boolean;
  countered?: boolean;
  text: string;
  castFrom?: CastZone;
  alt?: AltCostId;
  /** For triggers: the id of the object that triggered them (the spell cast, the card drawn, ...). */
  triggeringId?: number;
  /** Objects this item moved/affected while resolving, with their last known values ("that creature's controller gains life equal to its power"). */
  affected?: { id: number; lastKnown: { power: number; toughness: number; controller: PlayerId; manaValue: number } }[];
}
export type TargetRef = { kind: 'object'; id: number } | { kind: 'player'; id: PlayerId } | { kind: 'stack'; id: number };

/**
 * What is publicly known about hidden zones. `knownTop[p]` lists the ids on top of player p's library in order,
 * as known to p (scry/surveil keep) or to everyone (bounced to the top, also listed in `revealed`). `knownInHand`
 * lists hand cards whose identity is public (returned from a public zone, fetched by a search). `revealed` lists
 * ids whose identity is public regardless of zone.
 */
export interface PublicKnowledge { knownTop: number[][]; knownInHand: number[]; revealed: number[] }
export function makeKnowledge(players = 2): PublicKnowledge { return { knownTop: Array.from({ length: players }, () => []), knownInHand: [], revealed: [] }; }

export interface GameState {
  turn: number;
  activePlayer: PlayerId;
  step: Step;
  priority: PlayerId;
  players: Player[];
  /** Seats in turn order (eliminated players stay listed; `alive()` filters them). */
  turnOrder: PlayerId[];
  stack: StackItem[];
  nextId: number;
  log: string[];
  winner: PlayerId | null;
  attackers: number[];
  extraTurns: PlayerId[];
  passesInRow: number;
  knowledge: PublicKnowledge;
  delayed?: DelayedTrigger[];
  /** The monarch (CR 724), if any. */
  monarch?: PlayerId;
  /** Bumped on every emitted event; memoised derived data keys on it. */
  version: number;
  /** The typed event stream (only with GameOptions.events = 'full'). */
  events?: GameEvent[];
  /** Per-type event counts (GameOptions.events = 'counts' or 'full'). */
  eventCounts?: Partial<Record<GameEventType, number>>;
}

export const STEPS: Step[] = ['untap', 'upkeep', 'draw', 'main1', 'combat-begin', 'declare-attackers', 'declare-blockers', 'first-strike-damage', 'combat-damage', 'combat-end', 'main2', 'end', 'cleanup'];

// ---- Actions a player can take when they have priority --------------------------------------
export type PlayerAction =
  | { type: 'pass' }
  | { type: 'play-land'; cardId: number; face?: 0 | 1 }
  | { type: 'cast'; cardId: number; targets?: TargetRef[][]; x?: number; modes?: number[]; kicked?: boolean;
      /** Alternative cost id and the zone the card is cast from (default hand). */
      alt?: AltCostId; from?: CastZone;
      /** Optional explicit cost choices; when absent the engine picks (delve greedily, convoke via the mana solver, hand costs via choose-cards). */
      pay?: { delve?: number[]; convoke?: boolean; useExtras?: boolean; /** Permanents (ids) to tap for mana; when they cannot pay, the engine falls back to automatic payment. */ sources?: number[] } }
  | { type: 'activate'; objectId: number; abilityIndex: number; targets?: TargetRef[][]; x?: number; modes?: number[] }
  | { type: 'concede' };

/** What an attacker attacks: a player (seat) or a planeswalker (object id). */
export type AttackTarget = PlayerId | { planeswalker: number };
/** `targets`: defender per attacker id (default: the primary opponent). */
export interface AttackDeclaration { attackers: number[]; targets?: Record<number, AttackTarget> }
export interface BlockDeclaration { blocks: { blocker: number; attacker: number }[] }

/** Something the engine needs a player to decide. */
export type Decision =
  | { kind: 'priority'; legal: LegalAction[]; /** Why cards with no legal action cannot be played right now (only for agents with `wantsHints`). */ illegal?: IllegalHint[] }
  | { kind: 'attackers'; candidates: number[]; mustAttack: number[]; /** Players that can be attacked (multiplayer). */ defenders?: PlayerId[]; /** Planeswalkers that can be attacked (with their controller). */ planeswalkers?: { id: number; controller: PlayerId }[] }
  | { kind: 'blockers'; attackers: number[]; candidates: number[] }
  | { kind: 'choose-cards'; from: number[]; count: number; reason: string; exact: boolean }
  | { kind: 'yes-no'; prompt: string; tag?: 'mulligan' | 'shock' | 'unless-pay' | 'dredge' | 'optional' | 'commander-zone' }
  | { kind: 'choose-mode'; modes: string[]; count: number }
  | { kind: 'choose-color'; reason: string }
  | { kind: 'choose-option'; options: string[]; reason: string }
  | { kind: 'order-blockers'; attacker: number; blockers: number[] }
  | { kind: 'choose-player'; options: PlayerId[]; reason: string }
  | { kind: 'choose-number'; min: number; max: number; reason: string }
  | { kind: 'order-triggers'; items: number[]; labels: string[] };

/** Why an object in hand or on the battlefield has no legal action right now, with the rule that says so. */
export interface IllegalHint { id: number; reasons: { code: 'land-drop-used' | 'sorcery-timing' | 'not-your-turn' | 'stack-not-empty' | 'summoning-sick' | 'tapped' | 'cant-pay' | 'no-action' | 'once-per-turn' | 'no-targets'; rule: string; text: string }[] }

export interface LegalAction {
  action: PlayerAction;
  label: string;
  /** For cast/activate: target requirements per targeting effect; each entry lists legal target refs */
  targetOptions?: { spec: string; options: TargetRef[]; optional: boolean; count: number }[];
  manaValue?: number;
  /** The engine's automatic payment for this action (what it will tap): the UI shows it and may override it with `pay.sources`. */
  pay?: { cost: string; taps: { id: number; name: string; mana: ManaSymbol[] }[]; pool: ManaSymbol[] };
}

export interface Agent {
  name: string;
  decide(state: GameState, me: PlayerId, decision: Decision): Promise<unknown>;
  /** Called whenever the log gains a line; UI hook */
  onLog?(line: string): void;
  /** When true the engine hands this agent a redacted state (opponent's hand and both libraries hidden). */
  hidden?: boolean;
  /** When true priority decisions carry `illegal` hints (why the other cards cannot be played); UIs set it, AIs do not. */
  wantsHints?: boolean;
}

export function makePlayer(id: PlayerId, name: string): Player {
  return { id, name, life: 20, poison: 0, energy: 0, library: [], hand: [], graveyard: [], exile: [], battlefield: [], command: [], commanders: [], commanderCasts: {}, commanderDamage: {}, manaPool: [], landsPlayedThisTurn: 0, lost: false, attackedThisTurn: false, lifeLostThisTurn: 0, creaturesDiedThisTurn: 0, spellsCastThisTurn: 0 };
}

export function makeObject(id: number, def: CardDef, owner: PlayerId, zone: Zone, turn: number): GameObject {
  return { id, def, owner, controller: owner, zone, tapped: false, damage: 0, counters: {}, enteredTurn: turn, attachedTo: null, token: null, eotPower: 0, eotToughness: 0, eotKeywords: [], eotFlags: {}, noUntapNext: false, attacking: null, blocking: [], blockedBy: [], activatedThisTurn: new Set(), transformed: false };
}

/** @deprecated two-player helper kept for the analysis layer; engine and AI code use players.ts (opponentsOf / primaryOpponent). */
export function opponentOf(p: PlayerId): PlayerId { return p === 0 ? 1 : 0; }

export function isTriggered(a: Ability): a is TriggeredAbility { return a.kind === 'triggered'; }
export function isActivated(a: Ability): a is ActivatedAbility { return a.kind === 'activated'; }
