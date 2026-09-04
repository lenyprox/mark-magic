'use client';
// Main-thread wrapper around the game worker.
import type { DeckPayload, MainToWorker, StartOptions, WorkerToMain } from '@play/protocol';
import type { StopPolicy } from '@engine/agents/deferred';
import type { McRequest } from '@analysis/types';

export type GameListener = (msg: WorkerToMain) => void;

export class GameClient {
  private worker: Worker;
  private listeners = new Set<GameListener>();
  private readyPromise: Promise<void>;
  constructor() {
    this.worker = new Worker(new URL('../../workers/game.worker.ts', import.meta.url), { type: 'module' });
    this.readyPromise = new Promise(resolve => {
      const onReady = (ev: MessageEvent<WorkerToMain>) => { if (ev.data.type === 'ready') { this.worker.removeEventListener('message', onReady); resolve(); } };
      this.worker.addEventListener('message', onReady);
    });
    this.worker.addEventListener('message', (ev: MessageEvent<WorkerToMain>) => { for (const l of this.listeners) l(ev.data); });
    this.worker.addEventListener('error', (ev) => { for (const l of this.listeners) l({ type: 'error', message: ev.message }); });
  }
  private send(m: MainToWorker) { this.worker.postMessage(m); }
  subscribe(l: GameListener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  async start(gameId: string, decks: DeckPayload[], options: StartOptions) { await this.readyPromise; this.send({ type: 'start', gameId, decks, options }); }
  answer(requestId: number, answer: unknown) { this.send({ type: 'answer', requestId, answer }); }
  setStops(stops: Partial<StopPolicy>) { this.send({ type: 'set-stops', stops }); }
  requestView() { this.send({ type: 'request-view' }); }
  analyze(opts: { trials?: number; horizon?: number; policy?: 'rollout' | 'ai30' } = {}) { this.send({ type: 'analyze', ...opts }); }
  rerun(req: McRequest) { this.send({ type: 'analysis-rerun', req }); }
  cancelAnalysis() { this.send({ type: 'analysis-cancel' }); }
  concede() { this.send({ type: 'concede' }); }
  /** Take back the last action (the worker answers with `undo-result`). */
  undo() { this.send({ type: 'undo' }); }
  dispose() { try { this.send({ type: 'terminate' }); } catch { /* ignore */ } this.worker.terminate(); this.listeners.clear(); }
}
