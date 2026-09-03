'use client';
// Zustand store mirroring the worker's view of the game plus the pending decision, log, AI reasoning and analysis.
import { create } from 'zustand';
import type { Decision, PlayerId } from '@engine/state';
import type { Reasoning } from '@ai/ai';
import type { AnalysisReport, McRequest, TrialResult } from '@analysis/types';
import type { DeckPayload, StartOptions, WorkerToMain } from '@play/protocol';
import type { ViewState } from '@play/view';
import type { RecordedAnswer } from '@engine/agents/deferred';
import { GameClient } from './client';

export interface LogLine { index: number; line: string; turn: number; step: string; kind: 'engine' | 'ai' | 'note' }
export type GameStatus = 'idle' | 'starting' | 'running' | 'finished' | 'error';
export type AnalysisPhase = 'idle' | 'quick' | 'update' | 'done';

export interface GameStore {
  client: GameClient | null;
  gameId: string | null;
  status: GameStatus;
  view: ViewState | null;
  decision: { requestId: number; decision: Decision } | null;
  log: LogLine[];
  reasoning: Reasoning[];
  analysis: AnalysisReport | null;
  analysisPhase: AnalysisPhase;
  analysisFor: number | null;            // decision requestId the report belongs to
  reruns: Record<string, { identical: boolean; results: TrialResult[] }>;
  winner: PlayerId | null;
  error: string | null;
  decks: [DeckPayload, DeckPayload] | null;
  options: StartOptions | null;
  finished: { log: string[]; actions: RecordedAnswer[]; reasoning: Reasoning[]; turns: number } | null;
  start(gameId: string, decks: [DeckPayload, DeckPayload], options: StartOptions): Promise<void>;
  answer(answer: unknown): void;
  concede(): void;
  setStops: GameClient['setStops'];
  deepen(trials?: number, policy?: 'rollout' | 'ai30'): void;
  rerun(req: McRequest): void;
  dispose(): void;
}

function classify(line: string): LogLine['kind'] {
  if (/^\s*\[.+ thinks\]/.test(line)) return 'ai';
  if (/unsimulated text/.test(line)) return 'note';
  return 'engine';
}

export const useGameStore = create<GameStore>((set, get) => ({
  client: null, gameId: null, status: 'idle', view: null, decision: null, log: [], reasoning: [], analysis: null, analysisPhase: 'idle', analysisFor: null, reruns: {},
  winner: null, error: null, decks: null, options: null, finished: null,
  async start(gameId, decks, options) {
    get().client?.dispose();
    const client = new GameClient();
    set({ client, gameId, status: 'starting', view: null, decision: null, log: [], reasoning: [], analysis: null, analysisPhase: 'idle', analysisFor: null, reruns: {}, winner: null, error: null, decks, options, finished: null });
    client.subscribe((m: WorkerToMain) => {
      switch (m.type) {
        case 'started': set({ status: 'running', view: m.view }); break;
        case 'view': set({ view: m.view }); break;
        case 'decision': set({ view: m.view, decision: { requestId: m.requestId, decision: m.decision }, analysis: null, analysisPhase: 'idle', analysisFor: m.requestId, reruns: {} }); break;
        case 'log': set(s => ({ log: [...s.log, { index: m.index, line: m.line, turn: m.turn, step: m.step, kind: classify(m.line) }] })); break;
        case 'reasoning': set(s => ({ reasoning: [...s.reasoning.slice(-200), m.reasoning] })); break;
        case 'analysis': set(s => (s.decision?.requestId === m.requestId || s.analysisFor === m.requestId) ? { analysis: m.report, analysisPhase: m.phase, analysisFor: m.requestId } : {}); break;
        case 'analysis-rerun-result': set(s => ({ reruns: { ...s.reruns, [`${m.req.candidateId}:${m.req.trialStart}:${m.req.trialCount}:${m.req.baseSeed}`]: { identical: m.identical, results: m.results } } })); break;
        case 'finished': set({ status: 'finished', view: m.view, winner: m.winner, decision: null, finished: { log: m.log, actions: m.actions, reasoning: m.reasoning, turns: m.turns } }); break;
        case 'error': set({ status: 'error', error: m.message }); break;
      }
    });
    await client.start(gameId, decks, options);
  },
  answer(answer) {
    const { client, decision } = get();
    if (!client || !decision) return;
    client.answer(decision.requestId, answer);
    set({ decision: null });
  },
  concede() { get().client?.concede(); },
  setStops(stops) { get().client?.setStops(stops); },
  deepen(trials = 400, policy) { get().client?.analyze({ trials, policy, horizon: 4 }); },
  rerun(req) { get().client?.rerun(req); },
  dispose() { get().client?.dispose(); set({ client: null, status: 'idle', decision: null }); },
}));

export const rerunKey = (req: McRequest) => `${req.candidateId}:${req.trialStart}:${req.trialCount}:${req.baseSeed}`;
