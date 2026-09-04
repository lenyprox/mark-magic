// Messages between a batch pool (main thread) and its workers. A spec (with card definitions) is loaded once per
// worker under a job id; chunks of games then refer to it by that id. Everything is JSON-safe.
import type { GameRecordLite, MatchSpec } from './types.js';

export type ToBatchWorker =
  | { type: 'init' }
  | { type: 'load'; jobId: string; spec: MatchSpec }
  | { type: 'run'; jobId: string; chunkId: string; gameStart: number; games: number }
  | { type: 'unload'; jobId: string }
  | { type: 'cancel'; jobId?: string };

export type FromBatchWorker =
  | { type: 'ready' }
  | { type: 'loaded'; jobId: string }
  | { type: 'progress'; jobId: string; chunkId: string; records: GameRecordLite[] }
  | { type: 'chunk-done'; jobId: string; chunkId: string; games: number; cancelled: boolean }
  | { type: 'error'; jobId?: string; chunkId?: string; message: string };
