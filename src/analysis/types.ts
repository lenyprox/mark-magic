// Result types of the play-analysis engine. Everything here is JSON-serializable so it can cross a worker boundary.
import type { LegalAction, PlayerAction, PlayerId } from '../engine/state.js';
import type { SimRerunRef } from '../sim/types.js';

export type Method = 'exact' | 'hypergeometric' | 'montecarlo' | 'heuristic';

export interface Estimate { value: number; ci95?: [number, number]; method: Method; n?: number; seed?: number }

export interface McRequest { candidateId: string; concrete: PlayerAction; trialStart: number; trialCount: number; baseSeed: number; horizon: number; policy: 'rollout' | 'ai30' }

export interface Derivation {
  id: string; method: Method; title: string;
  formula: string;
  inputs: { name: string; value: number | string; note?: string }[];
  steps: { text: string; value?: number | string }[];
  result: number;
  assumptions: string[];
  mc?: { n: number; seed: number; successes: number; ci95: [number, number]; rerun: McRequest };
  /** For whole-game batch estimates: the spec reference needed to replay the games (the batch analogue of mc.rerun). */
  sim?: SimRerunRef;
}

export type RiskKind = 'lethal-crackback' | 'counterspell' | 'removal' | 'sweeper' | 'combat-trick' | 'burn' | 'discard' | 'mana-screw' | 'decking';
export interface Risk { kind: RiskKind; text: string; prob: Estimate; derivationId: string }

export interface PlayAnalysis {
  id: string; action: LegalAction; concrete: PlayerAction; label: string;
  evalDelta: number;                     // 1-ply heuristic score minus the pass baseline (never shown as a probability)
  winProb?: Estimate; expectedLifeDelta?: Estimate; expectedBoardDelta?: Estimate;
  risks: Risk[]; derivations: Derivation[];
  status: 'quick' | 'mc-running' | 'mc-done';
}

export interface Clock { turns: number | null; damagePerTurn: number; text: string }
export interface RaceReport {
  viewer: PlayerId;
  mine: { unopposed: Clock; blocked: Clock }; theirs: { unopposed: Clock; blocked: Clock };
  crackback: { lethal: boolean; damageThrough: number; life: number; text: string };
  method: Method; assumptions: string[]; derivationId: string; derivation: Derivation;
}

export type InteractionClass = 'counterspell' | 'removal' | 'sweeper' | 'burn' | 'combat-trick' | 'discard' | 'card-draw' | 'bounce' | 'ramp' | 'lifegain' | 'creature' | 'land';

export interface CouldHaveCard { name: string; prob: Estimate; copiesUnseen: number; classes: InteractionClass[]; derivationId: string }
export interface CouldHaveReport {
  model: 'exact' | 'archetype' | 'none';
  hiddenHand: number; unknownPool: number;
  cards: CouldHaveCard[];                                // top cards by probability
  classes: { cls: InteractionClass; prob: Estimate; copiesUnseen: number; derivationId: string }[];
  known: { id: number; name: string }[];                 // opponent hand cards whose identity is public
  derivations: Derivation[];
  warnings: string[];
}

export interface DrawOdds { name: string; prob: Estimate; draws: number; derivationId: string }
export interface DrawOddsReport {
  librarySize: number; knownTop: string[];
  landNext: Estimate | null; landByNextTurn: Estimate | null;
  outs: DrawOdds[];                                      // per card name still in the library
  derivations: Derivation[];
  warnings: string[];
}

export interface AnalysisReport {
  requestId: string; viewer: PlayerId; baseSeed: number; generatedAt: string;
  baseline: PlayAnalysis; plays: PlayAnalysis[];
  race: RaceReport; couldHave: CouldHaveReport; draws: DrawOddsReport;
  quickMs: number;
  warnings: string[];
}

// ---------------------------------------------------------------- opponent models
export interface ListEntry { name: string; count: number }

/** A metagame archetype as produced by the meta layer: per-card inclusion statistics plus optional sample lists. */
export interface ArchetypeProfile {
  id: string; format: string; name: string;
  signature: string[];
  metaShare: number; winRate: number; deckCount: number; deckSize: number;
  cards: { name: string; pIn: number; expectedCount: number; countDist: number[]; board: 'main' | 'side' }[];
  sampleLists?: ListEntry[][];
}

export type OpponentModel = { kind: 'exact'; list: ListEntry[] } | { kind: 'archetype'; profile: ArchetypeProfile } | { kind: 'none' };

// ---------------------------------------------------------------- Monte Carlo
export interface TrialResult {
  trial: number; seed: number;
  outcome: 'win' | 'loss' | 'draw';
  lifeDelta: number; boardDelta: number; evalEnd: number;
  turnsPlayed: number; unsimulated: number;
  note?: string;
}

export interface McAggregate {
  n: number; wins: number; losses: number; draws: number;
  win: Estimate; life: Estimate; board: Estimate;
  unsimulated: number;
}
