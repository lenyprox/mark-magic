'use client';
// Browser-side batch pool: one shared pool of batch workers (leaving a core for the UI), created on first use.
import { BatchPool, defaultBatchPoolSize, inlineBatchWorker, type BatchWorkerLike } from '@sim/batchPool';
import type { FromBatchWorker } from '@sim/protocol';

let pool: BatchPool | null = null;

function makeWorker(): BatchWorkerLike {
  if (typeof Worker === 'undefined') return inlineBatchWorker();
  let w: Worker;
  try { w = new Worker(new URL('../../workers/batch.worker.ts', import.meta.url), { type: 'module' }); }
  catch { return inlineBatchWorker(); }
  // A worker that fails to load, or whose module throws while importing, fires 'error' and posts no message of its
  // own: the pool would wait for an init answer that can never come. Translate it into the bare protocol error the
  // pool reads as "this worker is gone" — the same shape src/sim/nodeWorker.ts sends on a thread 'error'/'exit'.
  const like: BatchWorkerLike = {
    onmessage: null,
    postMessage(msg) { w.postMessage(msg); },
    terminate() { like.onmessage = null; w.terminate(); },
  };
  w.onmessage = ev => like.onmessage?.({ data: ev.data as FromBatchWorker });
  w.onerror = e => like.onmessage?.({ data: { type: 'error', message: e.message || 'batch worker failed to load' } });
  w.onmessageerror = () => like.onmessage?.({ data: { type: 'error', message: 'batch worker sent an unreadable message' } });
  return like;
}

export function getBatchPool(): BatchPool {
  if (!pool) pool = new BatchPool(makeWorker, defaultBatchPoolSize(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2));
  return pool;
}

export function batchPoolSize(): number { return getBatchPool().size; }
