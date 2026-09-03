// Messages between the browser (main thread) and the game worker, plus the deck payload the server hands to both.
// Everything here is plain JSON.
import type { CardDef } from '../cards/types.js';
import type { DeckList } from '../cards/db.js';
import type { StopPolicy, RecordedAnswer } from '../engine/agents/deferred.js';
import type { Decision, PlayerId, Step } from '../engine/state.js';
import type { Reasoning } from '../ai/ai.js';
import type { AnalysisReport, ArchetypeProfile, McRequest, TrialResult } from '../analysis/types.js';
import type { ViewState } from './view.js';

export interface DeckPayload {
  deckId: string | null;
  name: string;
  /** One CardDef per distinct key (name, or name@printingId when a printing was chosen). */
  defs: Record<string, CardDef>;
  main: { key: string; count: number }[];
  commander: { key: string; count: number }[];
  missing: string[];
  partial: { name: string; unparsed: string[] }[];
  list: DeckList;
  /** For archetype opponents: which archetype this list was sampled from. */
  archetype?: { id: string; name: string; format: string } | null;
}

export interface AiSettings {
  aggression: number; maxSims: number; verbose: boolean;
  /** false (default in the app): the AI plays from a redacted view over sampled worlds. */
  cheat: boolean; determinizations?: number;
  /** Whether the AI is told the human's decklist (it still never sees the hidden hand/library order). */
  knowsOpponentList: boolean;
}

export interface AnalysisSettings {
  enabled: boolean;
  trials: number;                 // Monte Carlo trials per candidate (0 = quick pass only)
  horizon?: number;               // turns after the current one
  policy: 'rollout' | 'ai30';
  candidates: number;             // candidates besides pass
  /** How the analyzer models the opponent's unknown cards. */
  opponentModel: 'exact' | 'archetype' | 'none';
  opponentProfile?: ArchetypeProfile | null;
  workers?: number;
}

export interface StartOptions {
  seed: number;
  startingLife: number;
  maxTurns?: number;
  mulligans: boolean;
  /** 0 = the human plays seat 0; null = AI vs AI (spectate). */
  humanSeat: 0 | null;
  ai: AiSettings;
  analysis: AnalysisSettings;
  stops?: Partial<StopPolicy>;
  playerName?: string;
  aiName?: string;
}

export const DEFAULT_START_OPTIONS: Omit<StartOptions, 'seed'> = {
  startingLife: 20, mulligans: true, humanSeat: 0,
  ai: { aggression: 1, maxSims: 300, verbose: true, cheat: false, determinizations: 3, knowsOpponentList: false },
  analysis: { enabled: true, trials: 200, policy: 'rollout', candidates: 4, opponentModel: 'exact' },
};

export type MainToWorker =
  | { type: 'start'; gameId: string; decks: [DeckPayload, DeckPayload]; options: StartOptions }
  | { type: 'answer'; requestId: number; answer: unknown }
  | { type: 'set-stops'; stops: Partial<StopPolicy> }
  | { type: 'request-view' }
  | { type: 'analyze'; trials?: number; horizon?: number; policy?: 'rollout' | 'ai30' }   // (re)run analysis on the current decision
  | { type: 'analysis-rerun'; req: McRequest }                                              // reproduce one MC estimate (verification)
  | { type: 'analysis-cancel' }
  | { type: 'concede' }
  | { type: 'terminate' };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'started'; gameId: string; view: ViewState }
  | { type: 'decision'; requestId: number; decision: Decision; view: ViewState }
  | { type: 'view'; view: ViewState }
  | { type: 'log'; line: string; turn: number; step: Step; index: number }
  | { type: 'reasoning'; reasoning: Reasoning }
  | { type: 'analysis'; requestId: number; report: AnalysisReport; phase: 'quick' | 'update' | 'done' }
  | { type: 'analysis-rerun-result'; req: McRequest; identical: boolean; results: TrialResult[] }
  | { type: 'finished'; gameId: string; winner: PlayerId | null; view: ViewState; log: string[]; actions: RecordedAnswer[]; reasoning: Reasoning[]; turns: number }
  | { type: 'error'; message: string; stack?: string };
