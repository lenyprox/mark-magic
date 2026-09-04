// Worker side of the sharded scenario runner (scripts/verify-scenarios.ts). Booted exactly like src/sim/nodeWorker.ts:
// the .boot.mjs entry registers tsx's ESM loader in the thread (loader hooks are not inherited) and then imports this
// module, which serves the protocol when it finds itself off the main thread. Scenarios are plain data, so a whole
// task list crosses postMessage by structured clone and each worker only reports { file, name, failures, ms }.
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { runScenario, type Scenario } from './scenarioDsl.js';

export interface ScenarioTask { file: string; name: string; scenario: Scenario }
export interface ScenarioResult { file: string; name: string; failures: string[]; ms: number }
export type ToScenarioWorker = { type: 'run'; tasks: ScenarioTask[] };
export type FromScenarioWorker = { type: 'result'; result: ScenarioResult } | { type: 'done' } | { type: 'error'; message: string };

/** Run one scenario; a throw is reported as a failure so one broken card never kills the shard. */
export async function runTask(t: ScenarioTask): Promise<ScenarioResult> {
  const t0 = performance.now();
  try {
    const run = await runScenario(t.scenario);
    return { file: t.file, name: t.name, failures: run.failures, ms: Math.round((performance.now() - t0) * 100) / 100 };
  } catch (e) {
    return { file: t.file, name: t.name, failures: [`threw: ${(e as Error).message}`], ms: Math.round((performance.now() - t0) * 100) / 100 };
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (msg: ToScenarioWorker) => {
    void (async () => {
      try { for (const t of msg.tasks) port.postMessage({ type: 'result', result: await runTask(t) } satisfies FromScenarioWorker); }
      catch (e) { port.postMessage({ type: 'error', message: (e as Error).message } satisfies FromScenarioWorker); }
      port.postMessage({ type: 'done' } satisfies FromScenarioWorker);
    })();
  });
}

export interface ScenarioWorkerLike { postMessage(m: ToScenarioWorker): void; onMessage: ((m: FromScenarioWorker) => void) | null; terminate(): void }

/** A worker thread running this file. */
export function nodeScenarioWorker(): ScenarioWorkerLike {
  const w = new Worker(new URL('./scenarioWorker.boot.mjs', import.meta.url));
  const like: ScenarioWorkerLike = {
    onMessage: null,
    postMessage(m) { w.postMessage(m); },
    terminate() { like.onMessage = null; void w.terminate(); },
  };
  w.on('message', (m: FromScenarioWorker) => like.onMessage?.(m));
  w.on('error', (e: Error) => like.onMessage?.({ type: 'error', message: e.message }));
  return like;
}
