// Worker side and pool side of the verify-pool protocol. A chunk is a list of oracle ids; the worker opens its own
// (read-only, per-thread shared) CardDB, trials every id at the requested seat counts and posts the rows back.
// When this module is loaded inside a worker thread it serves the protocol; on the main thread it exposes the pool.
// Rows carry their oracle id, so the coordinator sorts them and gets a report that is identical for any --workers N.
// Picking the cards is a worker job too (`scan`): parsing the 34k oracle rows to find the fully parsed ones costs
// more than the trials themselves, so it runs on its own thread and streams ids to the pool as it finds them.
import os from 'node:os';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { CardDB } from '../cards/db.js';
import { trialCard, type Row, type Seats } from './sandbox.js';

/** A trial row plus the seat count it was produced at. */
export interface PoolRow extends Row { seats: Seats }

/** Which cards to trial: every fully parsed card, narrowed by name and/or an explicit oracle id set, then capped. */
export interface ScanRequest { limit?: number; name?: string; oracleIds?: string[]; batch?: number }

export type ToPoolWorker =
  | { type: 'init' }
  | { type: 'scan'; scan: ScanRequest }
  | { type: 'run'; chunkId: number; ids: string[]; seats: Seats[]; maxTurns?: number };
export type FromPoolWorker =
  | { type: 'ready' }
  | { type: 'scanned'; ids: string[]; done: boolean }
  | { type: 'chunk-done'; chunkId: number; rows: PoolRow[] }
  | { type: 'error'; chunkId?: number; message: string };

export type PoolPost = (m: FromPoolWorker) => void;
export type PoolHandler = (msg: ToPoolWorker, post: PoolPost) => Promise<void>;

/** The worker's message handler; also drives the in-process worker below. */
export function createPoolHandler(): PoolHandler {
  return async (msg, post) => {
    try {
      if (msg.type === 'init') { post({ type: 'ready' }); return; }
      const cards = CardDB.shared();
      if (msg.type === 'scan') {
        const { limit = 0, name, oracleIds, batch = 256 } = msg.scan;
        const wanted = oracleIds ? new Set(oracleIds) : null;
        let out: string[] = []; let n = 0;
        for (const def of cards.all()) {
          if (name && def.name !== name) continue;
          if (wanted && !wanted.has(def.oracleId)) continue;
          if (!def.fullyParsed) continue;
          if (limit && n >= limit) break;
          n++; out.push(def.oracleId);
          if (out.length >= batch) { post({ type: 'scanned', ids: out, done: false }); out = []; }
        }
        post({ type: 'scanned', ids: out, done: true });
        return;
      }
      const rows: PoolRow[] = [];
      for (const oracleId of msg.ids) {
        const def = cards.getByOracleId(oracleId);
        // an explicit --ids / --changed list can name cards the scan would have filtered out; say so rather than drop them
        if (!def) { rows.push({ name: oracleId, oracleId, verdict: 'skipped', detail: 'no such oracle id', actions: 0, seats: msg.seats[0] }); continue; }
        if (!def.fullyParsed) { rows.push({ name: def.name, oracleId, verdict: 'skipped', detail: 'not fully parsed', actions: 0, seats: msg.seats[0] }); continue; }
        for (const seats of msg.seats) rows.push({ ...await trialCard(cards, def, { seats, maxTurns: msg.maxTurns }), seats });
      }
      post({ type: 'chunk-done', chunkId: msg.chunkId, rows });
    } catch (e) {
      post({ type: 'error', chunkId: msg.type === 'run' ? msg.chunkId : undefined, message: (e as Error).message });
    }
  };
}

export interface PoolWorkerLike { postMessage(msg: ToPoolWorker): void; onmessage: ((m: FromPoolWorker) => void) | null; terminate(): void }

/** A real worker thread running this file (poolWorker.boot.mjs registers tsx's loader in the thread). */
export function nodePoolWorker(): PoolWorkerLike {
  const w = new Worker(new URL('./poolWorker.boot.mjs', import.meta.url));
  const like: PoolWorkerLike = { onmessage: null, postMessage(msg) { w.postMessage(msg); }, terminate() { like.onmessage = null; void w.terminate(); } };
  w.on('message', (m: FromPoolWorker) => like.onmessage?.(m));
  w.on('error', (e: Error) => like.onmessage?.({ type: 'error', message: e.message }));
  return like;
}

/** An in-process worker: same protocol, no thread (tests and debugging). */
export function inlinePoolWorker(handler: PoolHandler = createPoolHandler()): PoolWorkerLike {
  const w: PoolWorkerLike = { onmessage: null, postMessage(msg) { setTimeout(() => { void handler(msg, m => w.onmessage?.(m)); }, 0); }, terminate() { w.onmessage = null; } };
  return w;
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const handler = createPoolHandler();
  port.on('message', (msg: ToPoolWorker) => { void handler(msg, m => port.postMessage(m)); });
}

export interface RunPoolOptions {
  /** Trial workers to use. Default: one per core, minus one (the scanner, when there is one, gets that core). */
  workers?: number;
  /** Seat counts to trial each card at, in order; the first one is the primary verdict. */
  seats?: Seats[];
  maxTurns?: number;
  /** Oracle ids per chunk. Default: about eight chunks per worker for a fixed list, 64 for a streamed scan. */
  chunk?: number;
  /** Run everything in this thread instead of spawning workers (tests). */
  inline?: boolean;
  onProgress?: (done: number) => void;
}

/** Default pool size: one trial worker per core, leaving one for the scanner and the coordinator. */
export function defaultPoolWorkers(cpus = os.cpus().length): number { return Math.max(1, cpus - 1); }

/**
 * Trial oracle ids across a pool of workers and return the rows sorted by (oracleId, seats). The sort is what makes
 * the result independent of the worker count: chunks come back in whatever order the threads finish.
 * `source` is either a fixed list of oracle ids or a `{ scan }` request, which a dedicated worker answers by
 * streaming the fully parsed cards to the pool while the trial workers are already busy.
 */
export function runPool(source: string[] | { scan: ScanRequest }, opts: RunPoolOptions = {}): Promise<PoolRow[]> {
  const seats = opts.seats ?? [2];
  const size = Math.max(1, opts.workers ?? defaultPoolWorkers());
  const fixed = Array.isArray(source) ? source : null;
  const chunkSize = fixed ? Math.max(8, opts.chunk ?? Math.ceil(fixed.length / (size * 8))) : Math.max(1, opts.chunk ?? 64);
  return new Promise<PoolRow[]>((resolve, reject) => {
    const rows: PoolRow[] = [];
    const errors: string[] = [];
    const queue: string[] = fixed ? [...fixed] : [];
    const idle: PoolWorkerLike[] = [];
    let scanDone = !!fixed, inFlight = 0, nextId = 0, done = 0, settled = false;
    const make = opts.inline ? () => inlinePoolWorker() : nodePoolWorker;
    const slots = Array.from({ length: size }, () => make());
    const scanner = fixed ? null : make();
    const finish = () => {
      if (settled) return; settled = true;
      for (const w of slots) w.terminate();
      scanner?.terminate();
      if (errors.length && !rows.length) { reject(new Error(errors[0])); return; }
      rows.sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : a.seats - b.seats));
      resolve(rows);
    };
    const feed = (w: PoolWorkerLike) => {
      if (!queue.length) { if (scanDone) { if (!inFlight) finish(); } else idle.push(w); return; }
      inFlight++; w.postMessage({ type: 'run', chunkId: nextId++, ids: queue.splice(0, chunkSize), seats, maxTurns: opts.maxTurns });
    };
    for (const w of slots) {
      w.onmessage = m => {
        if (settled) return;
        if (m.type === 'ready') { feed(w); return; }
        if (m.type === 'error') { errors.push(m.message); if (m.chunkId === undefined) { finish(); return; } inFlight--; feed(w); return; }
        if (m.type !== 'chunk-done') return;
        rows.push(...m.rows); done += m.rows.length; opts.onProgress?.(done);
        inFlight--; feed(w);
      };
      w.postMessage({ type: 'init' });
    }
    if (scanner) {
      scanner.onmessage = m => {
        if (settled) return;
        if (m.type === 'ready') { scanner.postMessage({ type: 'scan', scan: (source as { scan: ScanRequest }).scan }); return; }
        if (m.type === 'error') { errors.push(m.message); scanDone = true; }
        else if (m.type === 'scanned') { queue.push(...m.ids); scanDone ||= m.done; }
        else return;
        while (idle.length && (queue.length || scanDone)) feed(idle.shift()!);
      };
      scanner.postMessage({ type: 'init' });
    }
  });
}

/** The compact per-card map in the report: `v` primary verdict, `v4` the four-seat verdict, `a` actions tried. */
export interface ByOracleEntry { v: Row['verdict']; v4?: Row['verdict']; a: number }

/** Fold sorted rows into `by_oracle_id`; `primary` is the seat count whose verdict lands in `v`. */
export function byOracleId(rows: PoolRow[], primary: Seats): Record<string, ByOracleEntry> {
  const out: Record<string, ByOracleEntry> = {};
  for (const r of rows) {
    const e = (out[r.oracleId] ??= { v: r.verdict, a: r.actions });
    if (r.seats === primary) { e.v = r.verdict; e.a = r.actions; }
    if (r.seats === 4 && primary !== 4) e.v4 = r.verdict;
  }
  return out;
}
