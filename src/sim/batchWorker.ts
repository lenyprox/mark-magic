// Worker side of the batch protocol, as a plain message handler so a browser Worker, a Node worker_thread or an
// in-process shim can wrap it. Cancellation is cooperative: the runner checks between games.
import { runMatches } from './batch.js';
import type { FromBatchWorker, ToBatchWorker } from './protocol.js';
import type { MatchSpec } from './types.js';

export type BatchPost = (m: FromBatchWorker) => void;
export type BatchHandler = (msg: ToBatchWorker, post: BatchPost) => Promise<void>;

export function createBatchHandler(): BatchHandler {
  const specs = new Map<string, MatchSpec>();
  const cancelled = new Set<string>();
  return async (msg, post) => {
    try {
      switch (msg.type) {
        case 'init': post({ type: 'ready' }); return;
        case 'load': specs.set(msg.jobId, msg.spec); cancelled.delete(msg.jobId); post({ type: 'loaded', jobId: msg.jobId }); return;
        case 'unload': specs.delete(msg.jobId); return;
        case 'cancel': if (msg.jobId) cancelled.add(msg.jobId); else cancelled.add('*'); return;
        case 'run': {
          cancelled.delete('*');
          const spec = specs.get(msg.jobId);
          if (!spec) { post({ type: 'error', jobId: msg.jobId, chunkId: msg.chunkId, message: `job ${msg.jobId} is not loaded` }); return; }
          const stop = () => cancelled.has(msg.jobId) || cancelled.has('*');
          let n = 0;
          await runMatches({ ...spec, gameStart: msg.gameStart, games: msg.games }, {
            shouldStop: stop, batch: 2, indices: msg.indices,
            onProgress: records => { n += records.length; if (!stop()) post({ type: 'progress', jobId: msg.jobId, chunkId: msg.chunkId, records }); },
          });
          post({ type: 'chunk-done', jobId: msg.jobId, chunkId: msg.chunkId, games: n, cancelled: stop() });
          return;
        }
      }
    } catch (e) {
      post({ type: 'error', jobId: 'jobId' in msg ? msg.jobId : undefined, chunkId: 'chunkId' in msg ? msg.chunkId : undefined, message: (e as Error).message });
    }
  };
}

export const handleBatchMessage: BatchHandler = createBatchHandler();
