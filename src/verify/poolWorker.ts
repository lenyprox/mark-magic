// Worker side and pool side of the verify-pool protocol. When this module is loaded inside a worker thread it serves
// the protocol; on the main thread it exposes the pool. Each worker opens its own (read-only, per-thread shared)
// CardDB. Rows carry their oracle id, so the coordinator sorts them and gets a report identical for any --workers N.
//
// The full pool is scanned by the trial workers themselves: a `shard` is a rowid window of the oracle table, and the
// worker that scans a window also trials the cards it finds, so every card is parsed exactly once, on the thread that
// needs it (parsing the 34.5k oracle rows costs more than the trials, and used to be done once serially and then
// again in whichever trial worker got the card). An explicit id list skips the scan and goes straight to run chunks.
import os from 'node:os';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { CardDB } from '../cards/db.js';
import type { PoolTier } from '../cards/tiers.js';
import { trialCard, type Row, type Seats } from './sandbox.js';

/** A trial row plus the seat count it was produced at. */
export interface PoolRow extends Row { seats: Seats }

/** Which cards to trial when there is no explicit id list: a pool tier, capped at `limit` cards in database order. */
export interface ScanRequest { limit?: number; tier?: PoolTier }

export type ToPoolWorker =
  | { type: 'init' }
  | { type: 'run'; chunkId: number; ids: string[]; seats: Seats[]; maxTurns?: number }
  | { type: 'shard'; chunkId: number; index: number; count: number; tier: PoolTier; seats: Seats[]; maxTurns?: number };
export type FromPoolWorker =
  | { type: 'ready' }
  | { type: 'chunk-done'; chunkId: number; rows: PoolRow[]; parsed: number }
  | { type: 'error'; chunkId?: number; message: string };

export type PoolPost = (m: FromPoolWorker) => void;
export type PoolHandler = (msg: ToPoolWorker, post: PoolPost) => Promise<void>;

/** The worker's message handler; also drives the in-process worker below. */
export function createPoolHandler(): PoolHandler {
  let bounds: { min: number; max: number } | null = null;
  return async (msg, post) => {
    try {
      if (msg.type === 'init') { post({ type: 'ready' }); return; }
      const cards = CardDB.shared();
      if (msg.type === 'shard') {
        // the windows of a shard set partition the table's rowids exactly, so together they cover the same cards,
        // in the same order, as one unwindowed scan
        bounds ??= cards.rowIdBounds();
        const span = bounds.max - bounds.min + 1;
        const from = bounds.min + Math.floor((msg.index * span) / msg.count);
        const to = bounds.min + Math.floor(((msg.index + 1) * span) / msg.count) - 1;
        const rows: PoolRow[] = []; let parsed = 0;
        for (const def of cards.all({ from, to, tier: msg.tier })) {
          if (!def.fullyParsed) continue;
          parsed++;
          for (const seats of msg.seats) rows.push({ ...await trialCard(cards, def, { seats, maxTurns: msg.maxTurns }), seats });
        }
        post({ type: 'chunk-done', chunkId: msg.chunkId, rows, parsed });
        return;
      }
      const rows: PoolRow[] = []; let parsed = 0;
      for (const oracleId of msg.ids) {
        const def = cards.getByOracleId(oracleId);
        // an explicit id list can name cards the scan would have filtered out; say so rather than drop them
        if (!def) { rows.push({ name: oracleId, oracleId, verdict: 'skipped', detail: 'no such oracle id', actions: 0, abilities: 0, reached: 0, seats: msg.seats[0] }); continue; }
        if (!def.fullyParsed) { rows.push({ name: def.name, oracleId, verdict: 'skipped', detail: 'not fully parsed', actions: 0, abilities: 0, reached: 0, seats: msg.seats[0] }); continue; }
        parsed++;
        for (const seats of msg.seats) rows.push({ ...await trialCard(cards, def, { seats, maxTurns: msg.maxTurns }), seats });
      }
      post({ type: 'chunk-done', chunkId: msg.chunkId, rows, parsed });
    } catch (e) {
      post({ type: 'error', chunkId: msg.type === 'init' ? undefined : msg.chunkId, message: (e as Error).message });
    }
  };
}

export interface PoolWorkerLike { postMessage(msg: ToPoolWorker): void; onmessage: ((m: FromPoolWorker) => void) | null; terminate(): void }

/**
 * A real worker thread running this file (poolWorker.boot.mjs registers tsx's loader in the thread).
 * A thread that dies without an error event (process.exit, an OOM abort, a native crash in better-sqlite3) is
 * reported as an error too: otherwise the chunk it was running would never come back and the pool would never settle.
 */
export function nodePoolWorker(): PoolWorkerLike {
  const w = new Worker(new URL('./poolWorker.boot.mjs', import.meta.url));
  let stopped = false;
  const like: PoolWorkerLike = { onmessage: null, postMessage(msg) { w.postMessage(msg); }, terminate() { stopped = true; like.onmessage = null; void w.terminate(); } };
  w.on('message', (m: FromPoolWorker) => like.onmessage?.(m));
  w.on('error', (e: Error) => { if (!stopped) like.onmessage?.({ type: 'error', message: `worker thread failed: ${e.message}` }); });
  w.on('exit', code => { if (!stopped) like.onmessage?.({ type: 'error', message: `worker thread exited with code ${code} before its chunk finished` }); });
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
  /** Trial workers to use. Default: one per core, minus one for the coordinator. */
  workers?: number;
  /** Seat counts to trial each card at, in order; the first one is the primary verdict. */
  seats?: Seats[];
  maxTurns?: number;
  /** Oracle ids per chunk for a fixed id list. Default: about eight chunks per worker. */
  chunk?: number;
  /** Shards the scan is cut into. Default: eight per worker, more when a limit should stop the run early. */
  shards?: number;
  /** Run everything in this thread instead of spawning workers (tests). */
  inline?: boolean;
  /** Worker factory; overrides `inline`. Tests use it to inject a worker that fails or dies. */
  makeWorker?: () => PoolWorkerLike;
  onProgress?: (done: number) => void;
}

/** Default pool size: one trial worker per core, leaving one for the coordinator. */
export function defaultPoolWorkers(cpus = os.cpus().length): number { return Math.max(1, Math.floor(cpus) - 1); }

/** Coerce a worker count that may have come from a command line: anything non-numeric would build a zero-worker pool. */
function poolSize(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(1, Math.floor(n as number)) : defaultPoolWorkers();
}

/**
 * Trial oracle ids across a pool of workers and return the rows sorted by (oracleId, seats). The sort is what makes
 * the result independent of the worker count: chunks come back in whatever order the threads finish.
 * `source` is either a fixed list of oracle ids or a scan request, which is cut into rowid shards that the trial
 * workers scan themselves.
 *
 * Any worker or chunk error fails the whole run: a gate that quietly returned fewer cards than it was asked for would
 * report success while cards went untrialled.
 */
export function runPool(source: string[] | { scan: ScanRequest }, opts: RunPoolOptions = {}): Promise<PoolRow[]> {
  const seats = opts.seats ?? [2];
  const size = poolSize(opts.workers);
  const fixed = Array.isArray(source) ? source : null;
  const scan = fixed ? null : (source as { scan: ScanRequest }).scan;
  const limit = scan?.limit && Number.isFinite(scan.limit) ? Math.max(1, Math.floor(scan.limit)) : 0;
  const chunkSize = fixed ? Math.max(8, opts.chunk ?? Math.ceil(fixed.length / (size * 8))) : 0;
  // a capped run wants small shards, so the contiguous prefix reaches the cap after one or two of them
  const shardCount = fixed ? 0 : Math.max(size * 8, opts.shards ?? (limit ? 512 : 0));
  return new Promise<PoolRow[]>((resolve, reject) => {
    const byChunk = new Map<number, PoolRow[]>();
    const parsedByChunk = new Map<number, number>();
    const queue: string[] = fixed ? [...fixed] : [];
    let inFlight = 0, nextChunk = 0, nextShard = 0, done = 0, prefix = 0, prefixParsed = 0, capped = false, settled = false;
    const make = opts.makeWorker ?? (opts.inline ? () => inlinePoolWorker() : nodePoolWorker);
    const slots = Array.from({ length: size }, () => make());
    const stop = () => { for (const w of slots) w.terminate(); };
    const fail = (message: string) => { if (settled) return; settled = true; stop(); reject(new Error(message)); };
    const finish = () => {
      if (settled) return; settled = true;
      stop();
      // flatten in chunk order (database order for a scan) so a limit cuts the first N cards, then sort
      const ordered = [...byChunk.keys()].sort((a, b) => a - b).flatMap(k => byChunk.get(k)!);
      const rows = limit ? cut(ordered, limit) : ordered;
      rows.sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : a.seats - b.seats));
      resolve(rows);
    };
    const hasWork = () => (fixed ? queue.length > 0 : nextShard < shardCount && !capped);
    const feed = (w: PoolWorkerLike) => {
      if (!hasWork()) { if (!inFlight) finish(); return; }
      inFlight++;
      if (fixed) w.postMessage({ type: 'run', chunkId: nextChunk++, ids: queue.splice(0, chunkSize), seats, maxTurns: opts.maxTurns });
      else { const index = nextShard++; w.postMessage({ type: 'shard', chunkId: index, index, count: shardCount, tier: scan?.tier ?? 'all', seats, maxTurns: opts.maxTurns }); }
    };
    for (const w of slots) {
      w.onmessage = m => {
        if (settled) return;
        if (m.type === 'ready') { feed(w); return; }
        if (m.type === 'error') { fail(m.chunkId === undefined ? m.message : `chunk ${m.chunkId}: ${m.message}`); return; }
        if (m.type !== 'chunk-done') return;
        byChunk.set(m.chunkId, m.rows); parsedByChunk.set(m.chunkId, m.parsed);
        done += m.rows.length; opts.onProgress?.(done);
        while (parsedByChunk.has(prefix)) { prefixParsed += parsedByChunk.get(prefix)!; prefix++; }
        if (limit && prefixParsed >= limit) capped = true;
        inFlight--; feed(w);
      };
      w.postMessage({ type: 'init' });
    }
    if (!slots.length) fail('the pool was built with no workers');
  });
}

/** Keep the rows of the first `limit` distinct oracle ids, in the order they were scanned. */
function cut(rows: PoolRow[], limit: number): PoolRow[] {
  const seen = new Set<string>(); const out: PoolRow[] = [];
  for (const r of rows) {
    if (!seen.has(r.oracleId)) { if (seen.size >= limit) break; seen.add(r.oracleId); }
    out.push(r);
  }
  return out;
}

/**
 * The compact per-card map in the report: `v` primary verdict, `v4` the four-seat verdict, `a` actions tried,
 * `r` = [reached, activated abilities] for cards that have activated abilities at all.
 */
export interface ByOracleEntry { v: Row['verdict']; v4?: Row['verdict']; a: number; r?: [number, number] }

/** Fold sorted rows into `by_oracle_id`; `primary` is the seat count whose verdict lands in `v`. */
export function byOracleId(rows: PoolRow[], primary: Seats): Record<string, ByOracleEntry> {
  const out: Record<string, ByOracleEntry> = {};
  for (const r of rows) {
    const e = (out[r.oracleId] ??= { v: r.verdict, a: r.actions });
    if (r.seats === primary) { e.v = r.verdict; e.a = r.actions; if (r.abilities) e.r = [r.reached, r.abilities]; }
    if (r.seats === 4 && primary !== 4) e.v4 = r.verdict;
  }
  return out;
}

/** How much of the pool's activated abilities the sandbox actually performed, bucketed by per-card reachability. */
export interface AbilityReachability {
  cards: number; abilities: number; reached: number;
  buckets: { none: number; some: number; all: number; no_abilities: number };
  worst: { name: string; oracleId: string; reached: number; abilities: number }[];
}

/** Fold the primary-seat rows into the report's `by_ability_reachability` section. */
export function abilityReachability(rows: PoolRow[], primary: Seats, worst = 40): AbilityReachability {
  const out: AbilityReachability = { cards: 0, abilities: 0, reached: 0, buckets: { none: 0, some: 0, all: 0, no_abilities: 0 }, worst: [] };
  const missing: AbilityReachability['worst'] = [];
  for (const r of rows) {
    if (r.seats !== primary) continue;
    out.cards++; out.abilities += r.abilities; out.reached += r.reached;
    if (!r.abilities) { out.buckets.no_abilities++; continue; }
    if (r.reached >= r.abilities) { out.buckets.all++; continue; }
    out.buckets[r.reached ? 'some' : 'none']++;
    missing.push({ name: r.name, oracleId: r.oracleId, reached: r.reached, abilities: r.abilities });
  }
  missing.sort((a, b) => (b.abilities - b.reached) - (a.abilities - a.reached) || (a.name < b.name ? -1 : 1));
  out.worst = missing.slice(0, worst);
  return out;
}
