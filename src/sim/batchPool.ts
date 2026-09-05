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

interface Slot { worker: BatchWorkerLike; busy: string | null; ready: boolean; dead: boolean }
interface ReadyWaiter { resolve: () => void; reject: (e: Error) => void }
interface Job {
  id: string; spec: MatchSpec; chunks: { id: string; gameStart: number; games: number; indices?: number[] }[]; pendingChunks: number; loaded: number;
  records: GameRecordLite[]; started: number; cancelled: boolean; opts: BatchRunOptions; lastEmit: number; emitTimer: ReturnType<typeof setTimeout> | null;
  resolve: (r: MatchResult) => void; reject: (e: Error) => void; errors: string[];
}

export class BatchPool {
  private slots: Slot[] = [];
  private jobs = new Map<string, Job>();
  private counter = 0;
  private readyWaiters: ReadyWaiter[] = [];
  /** Set when a worker errored or died before answering init: ready() then rejects instead of waiting forever. */
  private startupError: string | null = null;
  readonly size: number;

  constructor(factory: () => BatchWorkerLike, size = 1) {
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i++) {
      const worker = factory(); const slot: Slot = { worker, busy: null, ready: false, dead: false };
      worker.onmessage = ev => this.onMessage(slot, ev.data);
      worker.postMessage({ type: 'init' });
      this.slots.push(slot);
    }
  }

  /** Resolves once every worker answered the init message; rejects if one errored or died before answering. */
  ready(): Promise<void> {
    if (this.startupError) return Promise.reject(new Error(this.startupError));
    if (this.slots.every(s => s.ready)) return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  /** Slots that can still answer a message (a dead worker is one that errored or exited on us). */
  private live(): number { return this.slots.reduce((n, s) => n + (s.dead ? 0 : 1), 0); }

  /** A worker that never booted (a loader failure in the thread, an exit) can never answer init: fail the waiters. */
  private failStartup(message: string) {
    this.startupError ??= message;
    const waiters = this.readyWaiters; this.readyWaiters = [];
    for (const w of waiters) w.reject(new Error(this.startupError));
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
    // Every worker is gone (they died, or the pool was disposed): nothing can ever run these chunks. Settle on the
    // next turn so the caller has its handle — and its rejection handler — before the promise settles.
    else if (!this.live()) setTimeout(() => this.fail(job, this.startupError ?? 'every batch worker has died'), 0);
    else for (const s of this.slots) if (!s.dead) s.worker.postMessage({ type: 'load', jobId: id, spec });
    const handle: BatchHandle = { jobId: id, result, cancel: () => this.cancel(id), get cancelled() { return job.cancelled; } };
    return handle;
  }

  cancel(jobId: string) {
    const job = this.jobs.get(jobId); if (!job || job.cancelled) return;
    job.cancelled = true; job.chunks.length = 0;
    for (const s of this.slots) if (!s.dead) s.worker.postMessage({ type: 'cancel', jobId });
    // chunks that never started are dropped now; running ones report chunk-done when they stop
    const running = this.slots.filter(s => s.busy?.startsWith(`${jobId}/`)).length;
    job.pendingChunks = running;
    if (!running) this.finish(job);
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy || !slot.ready || slot.dead) continue;
      const job = [...this.jobs.values()].find(j => j.chunks.length && j.loaded >= this.live() && !j.cancelled);
      if (!job) return;
      const c = job.chunks.shift()!; slot.busy = c.id;
      slot.worker.postMessage({ type: 'run', jobId: job.id, chunkId: c.id, gameStart: c.gameStart, games: c.games, indices: c.indices });
    }
  }

  private onMessage(slot: Slot, m: FromBatchWorker) {
    if (slot.dead) return;
    if (m.type === 'ready') { slot.ready = true; if (this.slots.every(s => s.ready)) { const w = this.readyWaiters; this.readyWaiters = []; for (const r of w) r.resolve(); } this.pump(); return; }
    if (m.type === 'loaded') { const job = this.jobs.get(m.jobId); if (job) { job.loaded++; this.pump(); } return; }
    const job = 'jobId' in m && m.jobId ? this.jobs.get(m.jobId) : undefined;
    if (m.type === 'progress') { if (job && !job.cancelled) { job.records.push(...m.records); this.emit(job); } return; }
    if (m.type === 'chunk-done') {
      if (slot.busy === m.chunkId) slot.busy = null;
      if (job) { job.pendingChunks--; if (job.pendingChunks <= 0) this.finish(job); }
      this.pump(); return;
    }
    if (m.type === 'error') {
      if (!slot.ready) this.failStartup(m.message);
      // An error naming neither a job nor a chunk is the worker itself going down (a thread 'error' or 'exit'): it
      // will never answer again, so retiring the slot is the only way its busy chunk ever settles.
      if (!m.jobId && !m.chunkId) { this.killSlot(slot, m.message); return; }
      if (m.chunkId && slot.busy === m.chunkId) slot.busy = null;
      if (job) { job.errors.push(m.message); if (m.chunkId) { job.pendingChunks--; if (job.pendingChunks <= 0) this.finish(job); } else if (!job.loaded) { this.jobs.delete(job.id); job.reject(new Error(m.message)); } }
      this.pump();
    }
  }

  /**
   * Retire a worker that died on us: pump() stops feeding it, the chunk it was running is charged to its job (which
   * can no longer complete, so the run rejects with the worker's message), and if it was the last live worker every
   * remaining job rejects too rather than waiting for a message that can never arrive.
   */
  private killSlot(slot: Slot, message: string) {
    if (slot.dead) return;
    slot.dead = true;
    const busy = slot.busy; slot.busy = null;
    slot.worker.onmessage = null;
    const doomed = new Set<Job>();
    if (busy) { const j = [...this.jobs.values()].find(x => busy.startsWith(`${x.id}/`)); if (j) doomed.add(j); }
    if (!this.live()) for (const j of this.jobs.values()) doomed.add(j);
    for (const j of doomed) this.fail(j, message);
    this.pump();
  }

  /** Settle a job as a failure: drop it, stop its timer and reject its result promise. */
  private fail(job: Job, message: string) {
    if (!this.jobs.has(job.id)) return;
    this.jobs.delete(job.id);
    if (job.emitTimer) { clearTimeout(job.emitTimer); job.emitTimer = null; }
    job.reject(new Error(message));
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
    for (const s of this.slots) if (!s.dead) s.worker.postMessage({ type: 'unload', jobId: job.id });
    if (job.errors.length && !job.records.length) { job.reject(new Error(job.errors[0])); return; }
    const result = assembleResult(job.spec, job.records, Date.now() - job.started);
    if (job.errors.length) result.derivation.assumptions.push(`${job.errors.length} worker error(s): ${job.errors[0]}`);
    job.resolve(result);
  }

  /** Terminate every worker and settle every outstanding job; nothing is left waiting on a worker that is gone. */
  dispose() {
    for (const j of [...this.jobs.values()]) this.cancel(j.id);
    for (const s of this.slots) { s.dead = true; s.busy = null; s.worker.onmessage = null; s.worker.terminate(); }
    // cancel() leaves a job pending until the worker running its chunk reports back; those workers are gone now, so
    // close the rest here with whatever they had rather than leaving their promises open for good.
    for (const j of [...this.jobs.values()]) this.finish(j);
    this.slots = [];
    this.failStartup('batch pool disposed');
  }
}

/** Default pool size: leave one core for the UI (browser) or the main thread (Node). */
export function defaultBatchPoolSize(hardwareConcurrency?: number): number { return Math.max(1, (hardwareConcurrency ?? 2) - 1); }
