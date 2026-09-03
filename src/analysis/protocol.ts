// Messages between the analysis pool (main thread) and its workers. Everything is JSON-safe.
import type { CardDef } from '../cards/types.js';
import type { SerializedState } from '../engine/serialize.js';
import type { PlayerId } from '../engine/state.js';
import type { AnalysisReport, ListEntry, McRequest, OpponentModel, TrialResult } from './types.js';

export interface Snapshot { snapshot: SerializedState; viewer: PlayerId; model: OpponentModel; myList?: ListEntry[] }

export type ToWorker =
  | { type: 'init'; defs: CardDef[] }
  | { type: 'add-defs'; defs: CardDef[] }
  | ({ type: 'quick'; requestId: string; baseSeed: number; maxCandidates?: number; maxSims?: number } & Snapshot)
  | ({ type: 'mc'; requestId: string; req: McRequest } & Snapshot)
  | { type: 'cancel'; requestId?: string };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'quick-result'; requestId: string; report: AnalysisReport }
  | { type: 'mc-batch'; requestId: string; candidateId: string; results: TrialResult[] }
  | { type: 'mc-done'; requestId: string; candidateId: string; trialStart: number; trialCount: number; cancelled: boolean }
  | { type: 'error'; requestId?: string; message: string };
