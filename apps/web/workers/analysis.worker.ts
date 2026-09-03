/// <reference lib="webworker" />
// One analysis worker: holds card definitions and runs quick analyses / Monte Carlo chunks on request.
import { createHandler } from '@analysis/worker';
import type { FromWorker, ToWorker } from '@analysis/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const handler = createHandler();
ctx.onmessage = (ev: MessageEvent<ToWorker>) => { void handler(ev.data, (m: FromWorker) => ctx.postMessage(m)); };
