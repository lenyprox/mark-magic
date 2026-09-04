// Main-thread side: a pool of batch workers. A job loads its spec into every worker, splits the games into chunks
// dealt round-robin to idle workers, and assembles the records (sorted by game index, so the result is identical to
// a serial run) into a MatchResult. Cancelling stops workers at their next game boundary and resolves with what ran.
import { assembleResult } from './batch.js';
import type { FromBatchWorker, ToBatchWorker } from './protocol.js';
import { createBatchHandler, type BatchHandler } from './batchWorker.js';
import type { GameRecordLite, MatchResult, MatchSpec } from './types.js';

export interface BatchWorkerLike { postMessage(msg: ToBatchWorker): void; onmessage: ((ev: { data: FromBatchWorker }) => void) | null; terminate(): void }

/** An in-process worker: same protocol, no thread (tests, and a fallback where workers are unavailable). */
export function inlineBatchWorker(handler: BatchHandler = createBatchHandler()): BatchWorkerLike {
  const w: BatchWorkerLike = {
    onmessage: null,
    postMessage(msg) { setTimeout(() => { void handler(msg, m => w.onmessage?.({ data: m })); }, 0); },
    terminate() { w.onmessage = null; },
  };
  return w;
}

export interface BatchProgress { done: number; total: number; records: GameRecordLite[]; partial: MatchResult }
export interface BatchRunOptions {
  /** Games per worker chunk (default: about four chunks per worker, at least 2 games). */
  chunk?: number;
  onProgress?: (p: BatchProgress) => void;
  /** Minimum ms between onProgress calls (default 150). */
  throttleMs?: number;
  /** Play exactly these game indexes (spec.games is then ignored for chunking). */
  indices?: number[];
}
export interface BatchHandle { jobId: string; result: Promise<MatchResult>; cancel(): void; readonly cancelled: boolean }

interface Slot { worker: BatchWorkerLike; busy: string | null; ready: boolean }
interface Job {
  id: string; spec: MatchSpec; chunks: { id: string; gameStart: number; games: number; indices?: number[] }[]; pendingChunks: number; loaded: number;
  records: GameRecordLite[]; started: number; cancelled: boolean; opts: BatchRunOptions; lastEmit: number; emitTimer: ReturnType<typeof setTimeout> | null;
  resolve: (r: MatchResult) => void; reject: (e: Error) => void; errors: string[];
}

export class BatchPool {
  private slots: Slot[] = [];
  private jobs = new Map<string, Job>();
  private counter = 0;
  private readyWaiters: (() => void)[] = [];
  readonly size: number;

  constructor(factory: () => BatchWorkerLike, size = 1) {
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i++) {
      const worker = factory(); const slot: Slot = { worker, busy: null, ready: false };
      worker.onmessage = ev => this.onMessage(slot, ev.data);
      worker.postMessage({ type: 'init' });
      this.slots.push(slot);
    }
  }

  /** Resolves once every worker answered the init message. */
  ready(): Promise<void> {
    if (this.slots.every(s => s.ready)) return Promise.resolve();
    return new Promise(res => this.readyWaiters.push(res));
  }

  run(spec: MatchSpec, opts: BatchRunOptions = {}): BatchHandle {
    const id = `${spec.id}#${++this.counter}`;
    const start = spec.gameStart ?? 0;
    const chunkSize = Math.max(2, opts.chunk ?? Math.ceil(spec.games / (this.size * 4)));
    const chunks: Job['chunks'] = [];
    if (opts.indices) { const list = opts.indices; const size = Math.max(2, opts.chunk ?? Math.ceil(list.length / (this.size * 4))); for (let g = 0, k = 0; g < list.length; g += size, k++) { const part = list.slice(g, g + size); chunks.push({ id: `${id}/${k}`, gameStart: part[0], games: part.length, indices: part }); } }
    else for (let g = 0, k = 0; g < spec.games; g += chunkSize, k++) chunks.push({ id: `${id}/${k}`, gameStart: start + g, games: Math.min(chunkSize, spec.games - g) });
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const result = new Promise<MatchResult>((res, rej) => { resolve = res; reject = rej; });
    const job: Job = { id, spec, chunks, pendingChunks: chunks.length, loaded: 0, records: [], started: Date.now(), cancelled: false, opts, lastEmit: 0, emitTimer: null, resolve, reject, errors: [] };
    this.jobs.set(id, job);
    if (!chunks.length) { this.finish(job); }
    else for (const s of this.slots) s.worker.postMessage({ type: 'load', jobId: id, spec });
    const handle: BatchHandle = { jobId: id, result, cancel: () => this.cancel(id), get cancelled() { return job.cancelled; } };
    return handle;
  }

  cancel(jobId: string) {
    const job = this.jobs.get(jobId); if (!job || job.cancelled) return;
    job.cancelled = true; job.chunks.length = 0;
    for (const s of this.slots) s.worker.postMessage({ type: 'cancel', jobId });
    // chunks that never started are dropped now; running ones report chunk-done when they stop
    const running = this.slots.filter(s => s.busy?.startsWith(`${jobId}/`)).length;
    job.pendingChunks = running;
    if (!running) this.finish(job);
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy || !slot.ready) continue;
      const job = [...this.jobs.values()].find(j => j.chunks.length && j.loaded >= this.size && !j.cancelled);
      if (!job) return;
      const c = job.chunks.shift()!; slot.busy = c.id;
      slot.worker.postMessage({ type: 'run', jobId: job.id, chunkId: c.id, gameStart: c.gameStart, games: c.games, indices: c.indices });
    }
  }

  private onMessage(slot: Slot, m: FromBatchWorker) {
    if (m.type === 'ready') { slot.ready = true; if (this.slots.every(s => s.ready)) { const w = this.readyWaiters; this.readyWaiters = []; for (const r of w) r(); } this.pump(); return; }
    if (m.type === 'loaded') { const job = this.jobs.get(m.jobId); if (job) { job.loaded++; this.pump(); } return; }
    const job = 'jobId' in m && m.jobId ? this.jobs.get(m.jobId) : undefined;
    if (m.type === 'progress') { if (job && !job.cancelled) { job.records.push(...m.records); this.emit(job); } return; }
    if (m.type === 'chunk-done') {
      if (slot.busy === m.chunkId) slot.busy = null;
      if (job) { job.pendingChunks--; if (job.pendingChunks <= 0) this.finish(job); }
      this.pump(); return;
    }
    if (m.type === 'error') {
      if (m.chunkId && slot.busy === m.chunkId) slot.busy = null;
      if (job) { job.errors.push(m.message); if (m.chunkId) { job.pendingChunks--; if (job.pendingChunks <= 0) this.finish(job); } else if (!job.loaded) { this.jobs.delete(job.id); job.reject(new Error(m.message)); } }
      this.pump();
    }
  }

  private emit(job: Job, final = false) {
    if (!job.opts.onProgress) return;
    const now = Date.now(); const gap = job.opts.throttleMs ?? 150;
    if (final || now - job.lastEmit >= gap) {
      if (job.emitTimer) { clearTimeout(job.emitTimer); job.emitTimer = null; }
      job.lastEmit = now;
      job.opts.onProgress({ done: job.records.length, total: job.opts.indices?.length ?? job.spec.games, records: job.records, partial: assembleResult(job.spec, job.records, now - job.started) });
      return;
    }
    if (!job.emitTimer) job.emitTimer = setTimeout(() => { job.emitTimer = null; this.emit(job, true); }, gap - (now - job.lastEmit));
  }

  private finish(job: Job) {
    if (!this.jobs.has(job.id)) return;
    this.jobs.delete(job.id);
    if (job.emitTimer) { clearTimeout(job.emitTimer); job.emitTimer = null; }
    for (const s of this.slots) s.worker.postMessage({ type: 'unload', jobId: job.id });
    if (job.errors.length && !job.records.length) { job.reject(new Error(job.errors[0])); return; }
    const result = assembleResult(job.spec, job.records, Date.now() - job.started);
    if (job.errors.length) result.derivation.assumptions.push(`${job.errors.length} worker error(s): ${job.errors[0]}`);
    job.resolve(result);
  }

  dispose() { for (const j of [...this.jobs.values()]) this.cancel(j.id); for (const s of this.slots) s.worker.terminate(); this.slots = []; }
}

/** Default pool size: leave one core for the UI (browser) or the main thread (Node). */
export function defaultBatchPoolSize(hardwareConcurrency?: number): number { return Math.max(1, (hardwareConcurrency ?? 2) - 1); }
