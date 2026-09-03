// Game state types shared by the engine, the AI and the CLI.
import type { CardDef, Color, Effect, Keyword, ManaSymbol, Ability, ActivatedAbility, TriggeredAbility } from '../cards/types.js';

export type PlayerId = 0 | 1;
export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack';
export type Step = 'untap' | 'upkeep' | 'draw' | 'main1' | 'combat-begin' | 'declare-attackers' | 'declare-blockers' | 'first-strike-damage' | 'combat-damage' | 'combat-end' | 'main2' | 'end' | 'cleanup';

export interface TokenSpec { name: string; power: number; toughness: number; colors: Color[]; types: string[]; subtypes: string[]; keywords: Keyword[]; treasure?: boolean }

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
  eotPower: number; eotToughness: number; eotKeywords: Keyword[]; eotFlags: { cantAttackOrBlock?: boolean; preventDamage?: number | 'all'; regenerationShield?: number };
  noUntapNext: boolean;
  attacking: PlayerId | null;      // player being attacked (this engine has no planeswalker attacks)
  blocking: number[];              // attacker ids this creature blocks
  blockedBy: number[];
  activatedThisTurn: Set<number>;  // ability indexes used this turn (once-per-turn / loyalty)
  transformed: boolean;
  lastKnown?: { power: number; toughness: number; controller: PlayerId };
}

export interface Player {
  id: PlayerId;
  name: string;
  life: number;
  poison: number;
  library: GameObject[];
  hand: GameObject[];
  graveyard: GameObject[];
  exile: GameObject[];
  battlefield: GameObject[];
  manaPool: ManaSymbol[];
  landsPlayedThisTurn: number;
  lost: boolean;
  lossReason?: string;
  attackedThisTurn: boolean;
  lifeLostThisTurn: number;
  creaturesDiedThisTurn: number;
  spellsCastThisTurn: number;
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
}
export type TargetRef = { kind: 'object'; id: number } | { kind: 'player'; id: PlayerId } | { kind: 'stack'; id: number };

export interface GameState {
  turn: number;
  activePlayer: PlayerId;
  step: Step;
  priority: PlayerId;
  players: [Player, Player];
  stack: StackItem[];
  nextId: number;
  log: string[];
  winner: PlayerId | null;
  attackers: number[];
  extraTurns: PlayerId[];
  passesInRow: number;
}

// ---- Actions a player can take when they have priority --------------------------------------
export type PlayerAction =
  | { type: 'pass' }
  | { type: 'play-land'; cardId: number }
  | { type: 'cast'; cardId: number; targets?: TargetRef[][]; x?: number; modes?: number[]; kicked?: boolean }
  | { type: 'activate'; objectId: number; abilityIndex: number; targets?: TargetRef[][]; x?: number; modes?: number[] }
  | { type: 'concede' };

export interface AttackDeclaration { attackers: number[] }
export interface BlockDeclaration { blocks: { blocker: number; attacker: number }[] }

/** Something the engine needs a player to decide. */
export type Decision =
  | { kind: 'priority'; legal: LegalAction[] }
  | { kind: 'attackers'; candidates: number[]; mustAttack: number[] }
  | { kind: 'blockers'; attackers: number[]; candidates: number[] }
  | { kind: 'choose-cards'; from: number[]; count: number; reason: string; exact: boolean }
  | { kind: 'yes-no'; prompt: string }
  | { kind: 'choose-mode'; modes: string[]; count: number }
  | { kind: 'choose-color'; reason: string }
  | { kind: 'order-blockers'; attacker: number; blockers: number[] };

export interface LegalAction {
  action: PlayerAction;
  label: string;
  /** For cast/activate: target requirements per targeting effect; each entry lists legal target refs */
  targetOptions?: { spec: string; options: TargetRef[]; optional: boolean; count: number }[];
  manaValue?: number;
}

export interface Agent {
  name: string;
  decide(state: GameState, me: PlayerId, decision: Decision): Promise<unknown>;
  /** Called whenever the log gains a line; UI hook */
  onLog?(line: string): void;
}

export function makePlayer(id: PlayerId, name: string): Player {
  return { id, name, life: 20, poison: 0, library: [], hand: [], graveyard: [], exile: [], battlefield: [], manaPool: [], landsPlayedThisTurn: 0, lost: false, attackedThisTurn: false, lifeLostThisTurn: 0, creaturesDiedThisTurn: 0, spellsCastThisTurn: 0 };
}

export function makeObject(id: number, def: CardDef, owner: PlayerId, zone: Zone, turn: number): GameObject {
  return { id, def, owner, controller: owner, zone, tapped: false, damage: 0, counters: {}, enteredTurn: turn, attachedTo: null, token: null, eotPower: 0, eotToughness: 0, eotKeywords: [], eotFlags: {}, noUntapNext: false, attacking: null, blocking: [], blockedBy: [], activatedThisTurn: new Set(), transformed: false };
}

export function opponentOf(p: PlayerId): PlayerId { return p === 0 ? 1 : 0; }

export function isTriggered(a: Ability): a is TriggeredAbility { return a.kind === 'triggered'; }
export function isActivated(a: Ability): a is ActivatedAbility { return a.kind === 'activated'; }
