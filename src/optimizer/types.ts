// The owned-pool deck optimiser: a seeded local search over single-card swaps, evaluated by whole-game batches
// against a field of opponents on paired seeds. Everything here is JSON so runs can be stored, checkpointed,
// resumed and re-run for verification.
import type { Derivation, Estimate, ListEntry } from '../analysis/types.js';
import type { BatchAgent, GameRecordLite, MulliganPolicy } from '../sim/types.js';

export type OptimizerStatus = 'queued' | 'running' | 'cancelling' | 'paused' | 'done' | 'cancelled' | 'failed';

/** An opponent in the field: a saved deck (or, later, a metagame archetype), with a relative weight. */
export type FieldEntry =
  | { kind: 'deck'; deckId: string; name: string; weight: number }
  | { kind: 'archetype'; id: string; name: string; format: string; weight: number };

export interface OptimizerBudget {
  /** Total games the run may simulate (reused games are free). */
  games: number;
  maxIterations: number;
  /** Games per evaluation block (the paired sample every comparison is made on). */
  blockSize: number;
  /** Neighbours proposed per iteration. */
  swapsPerIteration: number;
  /** Successive halving: stage-1 games per neighbour, and how many neighbours reach the full block. */
  race: { stage1: number; keep: number };
  /** Move to a fresh seed block every this many iterations (guards against overfitting one block). */
  rotateBlockEvery: number;
  /** Re-play the final comparison with the simulation AI (slow; off by default). */
  validateWithAi?: boolean;
}

export interface OptimizerConstraints {
  /** Target land count (null: keep the seed deck's). */
  lands: number | null;
  /** Card names that may never be swapped out. */
  lockIn: string[];
  /** Card names that may never be swapped in. */
  ban: string[];
  /** Only propose swap-ins the engine fully simulates. */
  onlyFullyParsedSwapIns: boolean;
}

export interface OptimizerSpec {
  name: string;
  seed: number;
  /** Commander card name (Commander runs) or null for 60-card formats. */
  commander: string | null;
  seedDeckId: string;
  format: 'commander' | 'freeform';
  /** 'owned': only registered cards; 'owned+bulk': also popular cards in the colour identity that are not registered (flagged "check your bulk"). */
  pool: 'owned' | 'owned+bulk';
  maxUnowned: number;
  field: FieldEntry[];
  players: 2 | 3 | 4;
  agent: BatchAgent;
  maxTurns: number;
  mulligans: MulliganPolicy;
  budget: OptimizerBudget;
  constraints: OptimizerConstraints;
}

export const PRESETS: Record<'quick' | 'standard' | 'deep', Pick<OptimizerBudget, 'games' | 'maxIterations' | 'blockSize' | 'swapsPerIteration' | 'race' | 'rotateBlockEvery'>> = {
  quick: { games: 3000, maxIterations: 12, blockSize: 120, swapsPerIteration: 6, race: { stage1: 40, keep: 2 }, rotateBlockEvery: 4 },
  standard: { games: 15000, maxIterations: 40, blockSize: 300, swapsPerIteration: 8, race: { stage1: 80, keep: 3 }, rotateBlockEvery: 5 },
  deep: { games: 60000, maxIterations: 120, blockSize: 600, swapsPerIteration: 10, race: { stage1: 150, keep: 3 }, rotateBlockEvery: 6 },
};

export type CandidateStatus = 'seed' | 'pending' | 'raced-out' | 'evaluated' | 'accepted' | 'rejected' | 'best';

export interface Candidate {
  id: string;
  list: ListEntry[];
  listHash: string;
  parentId: string | null;
  swapOut: string | null;
  swapIn: string | null;
  /** Explicit library order (card names) so a swap keeps every other card's shuffle position. */
  order: string[];
  block: number;
  iteration: number;
  status: CandidateStatus;
  /** Aggregate over the games this candidate has on its block. */
  games: number; wins: number; draws: number;
  /** Whether the swap-in is unregistered (a "check your bulk" candidate). */
  bulk: boolean;
}

export interface PairedComparison {
  n: number;
  /** Games the candidate won and the incumbent lost / the reverse. */
  a: number; b: number;
  /** Candidate win rate minus incumbent win rate on the same seeds, with its paired standard error and 95% interval. */
  delta: number; se: number; ci95: [number, number];
  accepted: boolean;
}

export interface SwapReport {
  iteration: number; block: number;
  out: string; in: string; bulk: boolean;
  candidateId: string; incumbentId: string;
  comparison: PairedComparison;
  reused: number; simulated: number;
  derivationId: string;
}

export interface CardContribution { name: string; withGames: number; withWins: number; withoutGames: number; withoutWins: number; lift: number; ci95: [number, number]; derivationId: string }
export interface KeepGuidance { signature: string; description: string; games: number; wins: number; winRate: Estimate }
export interface WinningPattern { feature: string; description: string; games: number; wins: number; lift: number; ci95: [number, number] }
export interface BulkCheck { name: string; reason: 'swap-in' | 'seed-deck-unowned'; owned: number }

export interface OptimizerReport {
  /** winRate counts wins only; draws (turn limit) are reported beside it. */
  baseline: { candidateId: string; list: ListEntry[]; winRate: Estimate; games: number; draws: number };
  best: { candidateId: string; list: ListEntry[]; winRate: Estimate; games: number; draws: number; changes: { out: string; in: string; bulk: boolean }[]; paired: PairedComparison | null };
  swaps: SwapReport[];
  cardContributions: CardContribution[];
  keepGuidance: KeepGuidance[];
  winningPatterns: WinningPattern[];
  bulkCheck: BulkCheck[];
  coverageCaveats: { name: string; unparsed: string[] }[];
  budget: { gamesSimulated: number; gamesReused: number; seconds: number; iterations: number; blocks: number };
  derivations: Derivation[];
  field: { name: string; games: number; wins: number }[];
}

export interface OptimizerProgress {
  status: OptimizerStatus;
  iteration: number; maxIterations: number;
  gamesSimulated: number; gamesReused: number; gamesBudget: number;
  bestWinRate: number | null; baselineWinRate: number | null;
  accepted: number; message: string;
  heartbeat: string; pid: number | null;
  startedAt: string | null; etaSeconds: number | null;
}

export interface OptimizerCheckpoint {
  bestId: string; baselineId: string; iteration: number; block: number;
  gamesSimulated: number; gamesReused: number;
  swaps: SwapReport[];
  rngState: number;
  /** Cards already tried (out→in) so a resumed run does not repeat them. */
  tried: string[];
  /** Seconds spent before this checkpoint. */
  seconds: number;
}

export interface OptimizerRun {
  id: string; name: string; status: OptimizerStatus;
  deckId: string; commander: string | null;
  spec: OptimizerSpec; seed: number;
  progress: OptimizerProgress;
  checkpoint: OptimizerCheckpoint | null;
  report: OptimizerReport | null;
  error: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null;
}

export interface StoredGame extends GameRecordLite { candidateId: string; opponent: string; reusedFrom: string | null }
