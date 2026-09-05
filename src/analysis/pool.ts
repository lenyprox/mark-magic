// The main-thread side: a pool of analysis workers. `analyze` runs the quick pass on one worker and then schedules
// Monte Carlo chunks per candidate round-robin across the pool, merging batches into the report as they arrive.
// Any newer request bumps the generation; stale results are dropped. `rerun` reproduces an MC estimate from its request.
import type { CardDef } from '../cards/types.js';
import { collectDefs, serializeState } from '../engine/serialize.js';
import type { GameState, PlayerId } from '../engine/state.js';
import { aggregate, mcDerivation } from './montecarlo.js';
import type { FromWorker, ToWorker } from './protocol.js';
import type { AnalysisReport, ListEntry, McRequest, OpponentModel, PlayAnalysis, TrialResult } from './types.js';
import { createHandler, type Handler } from './worker.js';

/** The subset of the DOM `Worker` interface the pool needs (a `worker_threads` or in-process shim fits too). */
export interface WorkerLike { postMessage(msg: ToWorker): void; onmessage: ((ev: { data: FromWorker }) => void) | null; terminate(): void }

/** An in-process worker: same protocol, no thread (for Node tests and as a fallback). */
export function inlineWorker(handler: Handler = createHandler()): WorkerLike {
  const w: WorkerLike = {
    onmessage: null,
    postMessage(msg) { setTimeout(() => { void handler(msg, m => w.onmessage?.({ data: m })); }, 0); },
    terminate() { w.onmessage = null; },
  };
  return w;
}

export interface AnalyzeRequest { state: GameState; viewer: PlayerId; model: OpponentModel; myList?: ListEntry[]; baseSeed: number }
export interface AnalyzeOptions {
  trials?: number;        // MC trials per candidate (default 200; 0 disables MC)
  horizon?: number;       // turns after the current one (default: 1 on my turn, 2 otherwise)
  policy?: McRequest['policy'];
  chunk?: number;         // trials per worker job (default 25)
  candidates?: number;    // candidates besides pass (default 4)
  maxSims?: number;
  onUpdate?: (report: AnalysisReport) => void;
}
export interface AnalysisHandle { requestId: string; quick: Promise<AnalysisReport>; done: Promise<AnalysisReport> }

interface Job { candidateId: string; req: McRequest }
interface Slot { worker: WorkerLike; busy: Job | null; ready: boolean; dead: boolean }

export class AnalysisPool {
  private slots: Slot[] = [];
  private generation = 0;
  private counter = 0;
  private current: { requestId: string; report: AnalysisReport; results: Map<string, TrialResult[]>; jobs: Job[]; pending: number; snapshot: Omit<Extract<ToWorker, { type: 'mc' }>, 'type' | 'requestId' | 'req'>; opts: AnalyzeOptions; resolveDone: (r: AnalysisReport) => void } | null = null;
  private lastEmit = 0; private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters = new Map<string, (m: FromWorker) => void>();
  /** The slot the current `quick` request went to: only that worker can answer it. */
  private quickSlot: Slot | null = null;
  readonly size: number;

  constructor(factory: () => WorkerLike, size = 1) {
    this.size = Math.max(1, size);
    for (let i = 0; i < this.size; i++) {
      const worker = factory(); const slot: Slot = { worker, busy: null, ready: false, dead: false };
      worker.onmessage = ev => this.onMessage(slot, ev.data);
      this.slots.push(slot);
    }
  }

  /** Load the card definitions into every worker; resolves when all are ready, rejects if one dies before answering. */
  init(defs: Iterable<CardDef>): Promise<void> {
    const list = [...defs];
    return Promise.all(this.slots.map((s, i) => new Promise<void>((res, rej) => {
      const key = `ready:${i}`;
      this.waiters.set(key, m => { this.waiters.delete(key); if (m.type === 'error') rej(new Error(m.message)); else { s.ready = true; res(); } });
      s.worker.postMessage({ type: 'init', defs: list });
    }))).then(() => undefined);
  }
  addDefs(defs: Iterable<CardDef>) { const list = [...defs]; for (const s of this.slots) if (!s.dead) s.worker.postMessage({ type: 'add-defs', defs: list }); }

  /** Start an analysis: the quick report resolves first, MC updates follow via `onUpdate`, `done` resolves when all trials finished. */
  analyze(input: AnalyzeRequest, opts: AnalyzeOptions = {}): AnalysisHandle {
    this.cancel();
    const gen = ++this.generation;
    const requestId = `a${gen}-${++this.counter}`;
    const defs = [...collectDefs(input.state).values()];
    for (const s of this.slots) if (!s.dead) s.worker.postMessage({ type: 'add-defs', defs });
    const snapshot = { snapshot: serializeState(input.state), viewer: input.viewer, model: input.model, myList: input.myList };
    let resolveDone!: (r: AnalysisReport) => void;
    const done = new Promise<AnalysisReport>(res => { resolveDone = res; });
    // The quick pass runs on one worker; a dead one could never answer it, so pick a live slot and remember which.
    const head = this.slots.find(s => !s.dead);
    this.quickSlot = head ?? null;
    const quick = new Promise<AnalysisReport>((res, rej) => {
      if (!head) { rej(new Error('every analysis worker has died')); resolveDone(null as unknown as AnalysisReport); return; }
      this.waiters.set(`quick:${requestId}`, m => {
        this.waiters.delete(`quick:${requestId}`);
        if (m.type === 'error') { rej(new Error(m.message)); resolveDone(null as unknown as AnalysisReport); return; }
        if (m.type !== 'quick-result' || this.generation !== gen) return;
        const report = m.report;
        this.current = { requestId, report, results: new Map(), jobs: [], pending: 0, snapshot, opts, resolveDone };
        res(structuredClone(report)); // a stable snapshot: the live report is mutated as MC batches arrive
        this.scheduleMc(report, input, opts);
      });
    });
    head?.worker.postMessage({ type: 'quick', requestId, baseSeed: input.baseSeed, maxCandidates: opts.candidates, maxSims: opts.maxSims, ...snapshot });
    return { requestId, quick, done };
  }

  private scheduleMc(report: AnalysisReport, input: AnalyzeRequest, opts: AnalyzeOptions) {
    const cur = this.current!; const trials = opts.trials ?? 200;
    if (trials <= 0) { this.finish(); return; }
    const horizon = opts.horizon ?? (input.state.activePlayer === input.viewer ? 1 : 2);
    const chunk = Math.max(1, opts.chunk ?? 25);
    const cands = [report.baseline, ...report.plays];
    for (let start = 0; start < trials; start += chunk) for (const c of cands) {
      cur.jobs.push({ candidateId: c.id, req: { candidateId: c.id, concrete: c.concrete, trialStart: start, trialCount: Math.min(chunk, trials - start), baseSeed: input.baseSeed, horizon, policy: opts.policy ?? 'rollout' } });
    }
    for (const c of cands) { c.status = 'mc-running'; cur.results.set(c.id, []); }
    cur.pending = cur.jobs.length;
    this.pump();
  }

  private pump() {
    const cur = this.current; if (!cur) return;
    for (const slot of this.slots) {
      if (slot.busy || slot.dead || !cur.jobs.length) continue;
      const job = cur.jobs.shift()!; slot.busy = job;
      slot.worker.postMessage({ type: 'mc', requestId: cur.requestId, req: job.req, ...cur.snapshot });
    }
  }

  private onMessage(slot: Slot, m: FromWorker) {
    if (slot.dead) return;
    if (m.type === 'ready') { this.waiters.get(`ready:${this.slots.indexOf(slot)}`)?.(m); return; }
    // An error naming no request is the worker itself going down: it will never answer anything again, and whatever
    // it was running would otherwise leave `init`, `quick`, `done` or a `rerun` pending for good.
    if (m.type === 'error' && !m.requestId) { this.killSlot(slot, m.message); return; }
    if (m.type === 'error' && m.requestId?.startsWith('rerun')) { this.waiters.get(m.requestId)?.(m); return; }
    if (m.type === 'quick-result' || (m.type === 'error' && m.requestId && this.waiters.has(`quick:${m.requestId}`))) { this.waiters.get(`quick:${m.requestId}`)?.(m); return; }
    if ((m.type === 'mc-batch' || m.type === 'mc-done') && m.requestId.startsWith('rerun')) { this.waiters.get(m.requestId)?.(m); if (m.type === 'mc-done') slot.busy = null; this.pump(); return; }
    const cur = this.current;
    if (!cur || !('requestId' in m) || m.requestId !== cur.requestId) { if (m.type === 'mc-done') { slot.busy = null; this.pump(); } return; }
    if (m.type === 'mc-batch') { cur.results.get(m.candidateId)?.push(...m.results); this.refresh(m.candidateId); this.emit(); }
    if (m.type === 'mc-done') { slot.busy = null; cur.pending--; if (cur.pending <= 0) this.finish(); else this.pump(); }
    if (m.type === 'error') { cur.report.warnings.push(`worker error: ${m.message}`); slot.busy = null; cur.pending--; if (cur.pending <= 0) this.finish(); else this.pump(); }
  }

  /**
   * Retire a worker that died on us. Its in-flight MC chunk is charged to the current analysis (so `done` still
   * settles), and anything only this worker -- or, once every worker is gone, any worker -- could have answered is
   * failed with its message instead of left pending.
   */
  private killSlot(slot: Slot, message: string) {
    if (slot.dead) return;
    slot.dead = true;
    const busy = slot.busy; slot.busy = null;
    slot.worker.onmessage = null;
    const allDead = this.slots.every(s => s.dead);
    const err: FromWorker = { type: 'error', message };
    this.waiters.get(`ready:${this.slots.indexOf(slot)}`)?.(err); // died before answering init
    // The quick pass only ever went to one worker; a rerun went to some idle one, so only give up on a rerun when
    // there is no worker left that could still answer it.
    for (const [key, w] of [...this.waiters]) {
      if (allDead || (key.startsWith('quick:') && this.quickSlot === slot)) { this.waiters.delete(key); w(err); }
    }
    const cur = this.current;
    if (cur) {
      cur.report.warnings.push(`worker error: ${message}`);
      if (busy) cur.pending--;
      if (allDead) { cur.jobs.length = 0; cur.pending = 0; }
      if (cur.pending <= 0) { this.finish(); return; }
    }
    this.pump();
  }

  /** Recompute a candidate's MC estimates from its accumulated trials. */
  private refresh(candidateId: string) {
    const cur = this.current!; const results = cur.results.get(candidateId); if (!results?.length) return;
    const play: PlayAnalysis | undefined = [cur.report.baseline, ...cur.report.plays].find(p => p.id === candidateId); if (!play) return;
    const sorted = [...results].sort((a, b) => a.trial - b.trial);
    const agg = aggregate(sorted, cur.report.baseSeed);
    const job = cur.jobs.find(j => j.candidateId === candidateId)?.req;
    const req: McRequest = { candidateId, concrete: play.concrete, trialStart: 0, trialCount: sorted.length, baseSeed: cur.report.baseSeed, horizon: job?.horizon ?? (cur.opts.horizon ?? 1), policy: job?.policy ?? (cur.opts.policy ?? 'rollout') };
    play.winProb = agg.win; play.expectedLifeDelta = agg.life; play.expectedBoardDelta = agg.board;
    const id = `mc-${candidateId}`;
    play.derivations = [...play.derivations.filter(d => d.id !== id), mcDerivation(id, `Monte Carlo: ${play.label}`, req, agg)];
  }

  private emit(final = false) {
    const cur = this.current; if (!cur?.opts.onUpdate) return;
    const now = Date.now();
    if (final || now - this.lastEmit >= 100) { if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; } this.lastEmit = now; cur.opts.onUpdate(cur.report); return; }
    if (!this.emitTimer) this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit(true); }, 100 - (now - this.lastEmit));
  }

  private finish() {
    const cur = this.current; if (!cur) return;
    for (const p of [cur.report.baseline, ...cur.report.plays]) { this.refresh(p.id); p.status = 'mc-done'; }
    this.emit(true);
    cur.resolveDone(cur.report);
  }

  /** Drop the current analysis: workers stop at their next trial boundary and stale messages are ignored. */
  cancel() {
    if (this.current) { const cur = this.current; this.current = null; for (const s of this.slots) if (!s.dead) s.worker.postMessage({ type: 'cancel', requestId: cur.requestId }); cur.resolveDone(cur.report); }
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.generation++;
  }

  /** Re-run an MC request on an idle worker; the results must be identical to the original (same seeds, same policy). */
  rerun(req: McRequest, snapshot: AnalyzeRequest): Promise<TrialResult[]> {
    const requestId = `rerun-${++this.counter}`;
    const defs = [...collectDefs(snapshot.state).values()];
    const slot = this.slots.find(s => !s.dead && !s.busy) ?? this.slots.find(s => !s.dead);
    if (!slot) return Promise.reject(new Error('every analysis worker has died'));
    const results: TrialResult[] = [];
    return new Promise<TrialResult[]>((res, rej) => {
      this.waiters.set(requestId, m => {
        if (m.type === 'mc-batch') results.push(...m.results);
        else if (m.type === 'mc-done') { this.waiters.delete(requestId); res(results.sort((a, b) => a.trial - b.trial)); }
        else if (m.type === 'error') { this.waiters.delete(requestId); rej(new Error(m.message)); }
      });
      slot.busy = { candidateId: req.candidateId, req };
      slot.worker.postMessage({ type: 'add-defs', defs });
      slot.worker.postMessage({ type: 'mc', requestId, req, snapshot: serializeState(snapshot.state), viewer: snapshot.viewer, model: snapshot.model, myList: snapshot.myList });
    });
  }

  /** Cancel, terminate every worker and fail anything still waiting on one, so no promise is left open. */
  dispose() {
    this.cancel();
    for (const s of this.slots) { s.dead = true; s.busy = null; s.worker.onmessage = null; s.worker.terminate(); }
    this.slots = []; this.quickSlot = null;
    for (const [key, w] of [...this.waiters]) { this.waiters.delete(key); w({ type: 'error', message: 'analysis pool disposed' }); }
  }
}

/** Default pool size for a browser: leave one core for the UI. */
export function defaultPoolSize(hardwareConcurrency?: number): number { return Math.max(1, (hardwareConcurrency ?? 2) - 1); }
