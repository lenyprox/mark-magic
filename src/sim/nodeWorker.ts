// Node worker_threads wrapper for the batch protocol. Imported by scripts only (the web app has its own worker file).
// When this module is loaded inside a worker thread it serves the protocol; on the main thread it exposes a factory.
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import type { BatchWorkerLike } from './batchPool.js';
import { createBatchHandler } from './batchWorker.js';
import type { FromBatchWorker, ToBatchWorker } from './protocol.js';

if (!isMainThread && parentPort) {
  const port = parentPort;
  const handler = createBatchHandler();
  port.on('message', (msg: ToBatchWorker) => { void handler(msg, (m: FromBatchWorker) => port.postMessage(m)); });
}

/** A worker thread running this file (nodeWorker.boot.mjs registers tsx's loader in the thread). */
export function nodeBatchWorker(): BatchWorkerLike {
  const w = new Worker(new URL('./nodeWorker.boot.mjs', import.meta.url));
  let stopped = false;
  const like: BatchWorkerLike = {
    onmessage: null,
    postMessage(msg) { if (!stopped) w.postMessage(msg); },
    terminate() { stopped = true; like.onmessage = null; void w.terminate(); },
  };
  w.on('message', (m: FromBatchWorker) => like.onmessage?.({ data: m }));
  w.on('error', (e: Error) => like.onmessage?.({ data: { type: 'error', message: e.message } }));
  // A thread that dies (tsx's loader failing inside nodeWorker.boot.mjs, an OOM) posts nothing of its own; without
  // this the pool would wait forever for an init answer that can never come.
  w.on('exit', (code: number) => { if (!stopped) { stopped = true; like.onmessage?.({ data: { type: 'error', message: `batch worker thread exited with code ${code}` } }); } });
  return like;
}
