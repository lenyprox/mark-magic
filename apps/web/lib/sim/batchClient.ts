'use client';
// Browser-side batch pool: one shared pool of batch workers (leaving a core for the UI), created on first use.
import { BatchPool, defaultBatchPoolSize, inlineBatchWorker, type BatchWorkerLike } from '@sim/batchPool';

let pool: BatchPool | null = null;

function makeWorker(): BatchWorkerLike {
  if (typeof Worker === 'undefined') return inlineBatchWorker();
  try { return new Worker(new URL('../../workers/batch.worker.ts', import.meta.url), { type: 'module' }) as unknown as BatchWorkerLike; }
  catch { return inlineBatchWorker(); }
}

export function getBatchPool(): BatchPool {
  if (!pool) pool = new BatchPool(makeWorker, defaultBatchPoolSize(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2));
  return pool;
}

export function batchPoolSize(): number { return getBatchPool().size; }
