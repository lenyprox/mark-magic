// Worker side and pool side of the fuzz protocol, built the same way as src/verify/poolWorker.ts (Phase 8e): loaded
// inside a worker thread this module serves the protocol, on the main thread it exposes the pool. Each worker opens
// its own read-only CardDB and builds its own pool index, so nothing is shared and nothing is sent but small messages.
//
// A run has two phases over the *same* workers: play the games (chunk = a list of game indexes), then shrink one
// task per bucket. Both phases are keyed by chunk id / bucket id and everything is sorted before it is returned, so
// the report is identical for any --workers N.
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { CardDB } from '../cards/db.js';
import { runGame, shrinkBucket, type Failure, type FuzzOptions, type FuzzSeats } from './fuzz.js';
import type { FuzzFormat, FuzzPool } from './fuzzDecks.js';

export type ToFuzzWorker =
  | { type: 'init' }
  | { type: 'run'; chunkId: number; games: number[]; opts: FuzzOptions }
  | { type: 'shrink'; chunkId: number; bucket: string; first: { game: number; seat: number }; opts: FuzzOptions; maxRuns: number };
export type FromFuzzWorker =
  | { type: 'ready' }
  | { type: 'chunk-done'; chunkId: number; games: number; failures: Failure[] }
  | { type: 'shrink-done'; chunkId: number; bucket: string; minimalDeck: string[]; commander?: string; runs: number; capped: boolean }
  | { type: 'error'; chunkId?: number; message: string };

export type FuzzPost = (m: FromFuzzWorker) => void;
export type FuzzHandler = (msg: ToFuzzWorker, post: FuzzPost) => Promise<void>;

/** The worker's message handler; also drives the in-process worker below. */
export function createFuzzHandler(): FuzzHandler {
  return async (msg, post) => {
    try {
      if (msg.type === 'init') { post({ type: 'ready' }); return; }
      const cards = CardDB.shared();
      if (msg.type === 'shrink') {
        const r = await shrinkBucket(cards, msg.opts, msg.first, msg.bucket, msg.maxRuns);
        post({ type: 'shrink-done', chunkId: msg.chunkId, bucket: msg.bucket, minimalDeck: r.minimalDeck, ...(r.commander ? { commander: r.commander } : {}), runs: r.runs, capped: r.capped });
        return;
      }
      const failures: Failure[] = [];
      for (const i of msg.games) { const out = await runGame(cards, msg.opts, i); if (out.failure) failures.push(out.failure); }
      post({ type: 'chunk-done', chunkId: msg.chunkId, games: msg.games.length, failures });
    } catch (e) {
      post({ type: 'error', chunkId: msg.type === 'init' ? undefined : msg.chunkId, message: (e as Error).message });
    }
  };
}

export interface FuzzWorkerLike { postMessage(msg: ToFuzzWorker): void; onmessage: ((m: FromFuzzWorker) => void) | null; terminate(): void }

/**
 * A real worker thread running this file (fuzzWorker.boot.mjs registers tsx's loader in the thread). As in the pool
 * worker, a thread that dies without an error event is reported as an error so the run settles instead of hanging.
 */
export function nodeFuzzWorker(): FuzzWorkerLike {
  const w = new Worker(new URL('./fuzzWorker.boot.mjs', import.meta.url));
  let stopped = false;
  const like: FuzzWorkerLike = { onmessage: null, postMessage(msg) { w.postMessage(msg); }, terminate() { stopped = true; like.onmessage = null; void w.terminate(); } };
  w.on('message', (m: FromFuzzWorker) => like.onmessage?.(m));
  w.on('error', (e: Error) => { if (!stopped) like.onmessage?.({ type: 'error', message: `worker thread failed: ${e.message}` }); });
  w.on('exit', code => { if (!stopped) like.onmessage?.({ type: 'error', message: `worker thread exited with code ${code} before its chunk finished` }); });
  return like;
}

/** An in-process worker: same protocol, no thread (tests and debugging). */
export function inlineFuzzWorker(handler: FuzzHandler = createFuzzHandler()): FuzzWorkerLike {
  const w: FuzzWorkerLike = { onmessage: null, postMessage(msg) { setTimeout(() => { void handler(msg, m => w.onmessage?.(m)); }, 0); }, terminate() { w.onmessage = null; } };
  return w;
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const handler = createFuzzHandler();
  port.on('message', (msg: ToFuzzWorker) => { void handler(msg, m => port.postMessage(m)); });
}

/** One distinct failure mode, with the deck ddmin reduced it to. */
export interface FuzzBucket {
  id: string;
  signature: string;
  /** Games in the run that landed in this bucket. */
  n: number;
  first: { seed: number; game: number; seat: number };
  /** The shrunk failing deck as "<count>x <name>" lines (nonland cards plus the basics they are played with). */
  minimalDeck: string[];
  commander?: string;
  /** Predicate runs ddmin spent, and whether it stopped at the cap instead of reaching a 1-minimal deck. */
  shrinkRuns: number;
  shrinkCapped: boolean;
}

export interface FuzzReport {
  /** Passed in by the coordinator (never read from the clock in a worker), so a report is reproducible. */
  at?: string;
  seed: number;
  games: number;
  seats: FuzzSeats;
  format: FuzzFormat;
  pool: FuzzPool;
  buckets: FuzzBucket[];
}

export interface RunFuzzOptions {
  /** Workers to use. Default: one per core minus the coordinator (`defaultPoolWorkers` in poolWorker.ts). */
  workers?: number;
  /** Games per chunk. Default: about eight chunks per worker. */
  chunk?: number;
  /** Predicate runs ddmin may spend on one bucket (default 200). */
  shrinkRuns?: number;
  /** Run everything in this thread instead of spawning workers (tests). */
  inline?: boolean;
  /** Worker factory; overrides `inline`. Tests use it to inject a worker that fails or dies. */
  makeWorker?: () => FuzzWorkerLike;
  onProgress?: (games: number, failures: number) => void;
}

/**
 * Coerce a worker count that may have come from a command line: a NaN would build a zero-worker pool. The
 * "one per core" default lives in the CLI (scripts/fuzz-games.ts uses `defaultPoolWorkers` from poolWorker.ts) —
 * this module must not import poolWorker.ts, whose worker-thread block would answer `init` a second time.
 */
function poolSize(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(1, Math.floor(n as number)) : 1;
}

/**
 * Play `games` games of `opts` across a pool of workers, bucket the failures and shrink each bucket's first game.
 * Any worker or chunk error fails the whole run: a fuzzer that quietly played fewer games than it was asked for
 * would report "no failures" while games went unplayed.
 */
export function runFuzz(opts: FuzzOptions & { games: number; at?: string }, run: RunFuzzOptions = {}): Promise<FuzzReport> {
  const size = poolSize(run.workers);
  const total = Math.max(0, Math.floor(opts.games));
  const chunkSize = Math.max(1, run.chunk ?? Math.ceil(total / (size * 8)));
  const shrinkRuns = run.shrinkRuns ?? 200;
  const cfg: FuzzOptions = { seed: opts.seed, seats: opts.seats, format: opts.format, pool: opts.pool, ...(opts.tier ? { tier: opts.tier } : {}), ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}) };
  const report = (buckets: FuzzBucket[]): FuzzReport => ({ ...(opts.at ? { at: opts.at } : {}), seed: opts.seed, games: total, seats: opts.seats, format: opts.format, pool: opts.pool, buckets });

  return new Promise<FuzzReport>((resolve, reject) => {
    const runQueue: number[][] = [];
    for (let i = 0; i < total; i += chunkSize) runQueue.push(Array.from({ length: Math.min(chunkSize, total - i) }, (_, k) => i + k));
    const failures: Failure[] = [];
    const shrinkQueue: { bucket: string; first: { game: number; seat: number } }[] = [];
    const shrunk = new Map<string, { minimalDeck: string[]; commander?: string; runs: number; capped: boolean }>();
    let phase: 'run' | 'shrink' = 'run';
    let inFlight = 0, nextChunk = 0, playedGames = 0, settled = false;
    const make = run.makeWorker ?? (run.inline ? () => inlineFuzzWorker() : nodeFuzzWorker);
    const slots = Array.from({ length: size }, () => make());
    const idle: FuzzWorkerLike[] = [];
    const stop = () => { for (const w of slots) w.terminate(); };
    const fail = (message: string) => { if (settled) return; settled = true; stop(); reject(new Error(message)); };

    /** Group the failures into buckets; the first occurrence is the lowest game index, so worker order cannot change it. */
    const planShrinks = () => {
      const byBucket = new Map<string, Failure[]>();
      for (const f of failures) { const l = byBucket.get(f.bucket); if (l) l.push(f); else byBucket.set(f.bucket, [f]); }
      for (const [bucket, list] of [...byBucket].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const first = list.reduce((a, b) => (b.game < a.game ? b : a));
        shrinkQueue.push({ bucket, first: { game: first.game, seat: first.seat } });
      }
    };
    const finish = () => {
      if (settled) return; settled = true; stop();
      const byBucket = new Map<string, Failure[]>();
      for (const f of failures) { const l = byBucket.get(f.bucket); if (l) l.push(f); else byBucket.set(f.bucket, [f]); }
      const buckets: FuzzBucket[] = [...byBucket].map(([id, list]) => {
        const first = list.reduce((a, b) => (b.game < a.game ? b : a));
        const s = shrunk.get(id);
        return { id, signature: first.signature, n: list.length, first: { seed: opts.seed, game: first.game, seat: first.seat }, minimalDeck: s?.minimalDeck ?? [], ...(s?.commander ? { commander: s.commander } : {}), shrinkRuns: s?.runs ?? 0, shrinkCapped: s?.capped ?? false };
      });
      buckets.sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : a.id < b.id ? -1 : 1));
      resolve(report(buckets));
    };
    /** Hand every idle worker whatever work the current phase has; flip phases when a phase has fully drained. */
    const pump = () => {
      for (;;) {
        if (!idle.length) return;
        if (phase === 'run') {
          if (runQueue.length) { const w = idle.pop()!; inFlight++; w.postMessage({ type: 'run', chunkId: nextChunk++, games: runQueue.shift()!, opts: cfg }); continue; }
          if (inFlight) return;                                   // the last run chunks are still out; wait for them
          phase = 'shrink'; planShrinks(); continue;
        }
        if (shrinkQueue.length) { const w = idle.pop()!; const t = shrinkQueue.shift()!; inFlight++; w.postMessage({ type: 'shrink', chunkId: nextChunk++, bucket: t.bucket, first: t.first, opts: cfg, maxRuns: shrinkRuns }); continue; }
        if (inFlight) return;
        finish(); return;
      }
    };
    for (const w of slots) {
      w.onmessage = m => {
        if (settled) return;
        if (m.type === 'ready') { idle.push(w); pump(); return; }
        if (m.type === 'error') { fail(m.chunkId === undefined ? m.message : `chunk ${m.chunkId}: ${m.message}`); return; }
        if (m.type === 'chunk-done') { playedGames += m.games; failures.push(...m.failures); run.onProgress?.(playedGames, failures.length); }
        else if (m.type === 'shrink-done') shrunk.set(m.bucket, { minimalDeck: m.minimalDeck, ...(m.commander ? { commander: m.commander } : {}), runs: m.runs, capped: m.capped });
        else return;
        inFlight--; idle.push(w); pump();
      };
      w.postMessage({ type: 'init' });
    }
    if (!slots.length) fail('the fuzz pool was built with no workers');
  });
}
