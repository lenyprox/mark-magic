/// <reference lib="webworker" />
// One batch worker: holds loaded match specs and plays chunks of whole games on request.
import { createBatchHandler } from '@sim/batchWorker';
import type { FromBatchWorker, ToBatchWorker } from '@sim/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const handler = createBatchHandler();
ctx.onmessage = (ev: MessageEvent<ToBatchWorker>) => { void handler(ev.data, (m: FromBatchWorker) => ctx.postMessage(m)); };
