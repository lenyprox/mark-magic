// Batch simulation: play whole games between decks and aggregate the results. Everything here is JSON-serializable so
// a spec can cross a worker boundary, be stored with an optimiser run, and be re-run to reproduce a result exactly.
import type { Derivation, Estimate } from '../analysis/types.js';
import type { DeckPayload } from '../play/protocol.js';

export type SeatingMode = 'rotate' | 'fixed';
export type BatchAgent = 'rollout' | 'ai';
/** 'none': always keep; 'lands': the AI's rule (mulligan a 7-card hand with 0-1 or 6-7 lands, at most once). */
export type MulliganPolicy = 'none' | 'lands';
export type BatchFormat = 'freeform' | 'commander';

export interface MatchSpec {
  id: string;
  /** Two decks today; three or four once the engine plays pods (milestone B1). Deck index is the identity used in results. */
  decks: DeckPayload[];
  /** Number of games to play; game `gameStart + i` uses seed hashSeed(baseSeed, gameStart + i). */
  games: number;
  gameStart?: number;
  baseSeed: number;
  /** rotate: Latin rotation so every deck takes every seat equally; fixed: deck i always sits in seat i. */
  seating: SeatingMode;
  agent: BatchAgent;
  /** Simulations per decision for the `ai` agent (default 30). */
  aiSims?: number;
  format: BatchFormat;
  /** Seats at the table (defaults to decks.length). */
  players?: number;
  startingLife?: number;
  maxTurns: number;
  mulligans: MulliganPolicy;
  record: 'summary' | 'events';
  /** Optional explicit library order (card names, one per copy) per deck; null keeps the canonical sorted order. */
  orders?: (string[] | null)[];
}

/** The spec without the card definitions: what a result carries and what a re-run needs alongside the decks. */
export interface MatchSpecRef extends Omit<MatchSpec, 'decks'> {
  decks: { deckId: string | null; name: string; cards: number; hash: string }[];
}

export interface GameRecordLite {
  index: number;
  seed: number;
  /** seatOrder[seat] = deck index sitting there. */
  seatOrder: number[];
  /** Deck index of the winner (null: draw or turn limit). */
  winner: number | null;
  /** Seat index of the deck that went first. */
  firstSeat: number;
  turns: number;
  /** Per deck index. */
  mulligans: number[];
  openingHand: string[][];
  /** Card names each deck had outside its library when the game ended (drawn, played, milled...). */
  seen: string[][];
  firstCommanderCastTurn: (number | null)[];
  lossReason: (string | null)[];
  unsimulated: number;
  error?: string;
  ms: number;
  /** With record: 'events', the engine log. */
  log?: string[];
}

export interface DeckAggregate {
  deck: number; name: string;
  games: number; wins: number; losses: number; draws: number;
  /** (wins + draws/2) / games with a Wilson 95% interval. */
  winRate: Estimate;
  /** Wins by the seat the deck sat in (index = seat). */
  seatWins: number[]; seatGames: number[];
  /** Wins when this deck went first / second. */
  onThePlay: { games: number; wins: number }; onTheDraw: { games: number; wins: number };
  mulliganRate: number;
  avgTurnsWon: number | null;
  commanderCastTurn: { mean: number | null; byTurn3: number; byTurn5: number; never: number } | null;
}

export interface MatchAggregate {
  games: number; decided: number; draws: number; errors: number;
  byDeck: DeckAggregate[];
  avgTurns: number;
  unsimulated: number;
  ms: number;
  gamesPerSecond: number;
}

export interface MatchResult {
  spec: MatchSpecRef;
  games: GameRecordLite[];
  aggregate: MatchAggregate;
  derivation: Derivation;
  /** Which deck has the highest win rate (index), or null when tied within the interval. */
  best: number | null;
}

/** What `Derivation.sim` carries: enough to replay the batch and compare the win count. */
export interface SimRerunRef { specId: string; baseSeed: number; gameStart: number; games: number; deck: number; decks: MatchSpecRef['decks']; successes: number; n: number; ci95: [number, number]; agent: BatchAgent; seating: SeatingMode; mulligans: MulliganPolicy; maxTurns: number }
