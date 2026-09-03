// Main-thread side of the normal-map pipeline: IndexedDB lookup, a 2-worker pool with a priority queue,
// a main-thread fallback when workers / OffscreenCanvas are unavailable, and an IntersectionObserver
// prefetch (200 px margin, requestIdleCallback) so grid cards have their maps ready before hover.

import { imgUrl } from '@/lib/img';
import { computeNormalMap } from './normalmap-compute';
import { readNormalMap, writeNormalMap, NORMALMAP_WIDTH, NORMALMAP_HEIGHT } from './normalmap-cache';
import { idle } from './support';

export interface NormalMapResult { bitmap: ImageBitmap; fromCache: boolean }
export type Priority = 'interactive' | 'prefetch';

interface Job {
  key: string;
  printingId: string;
  face: 0 | 1;
  priority: Priority;
  resolve: (b: Blob) => void;
  reject: (e: unknown) => void;
  promise: Promise<Blob>;
}

const POOL_SIZE = 2;
const jobs = new Map<string, Job>();          // in-flight or queued, by key
const blobCache = new Map<string, Blob>();     // memory cache of finished blobs (small: keep 160)
const queue: Job[] = [];
let workers: { w: Worker; busy: Job | null }[] | null = null;
let workerMode: 'worker' | 'main' | 'unknown' = 'unknown';
let nextId = 1;
const pending = new Map<number, Job>();

function keyOf(printingId: string, face: 0 | 1) { return `${printingId}:${face}`; }

function absoluteUrl(printingId: string, face: 0 | 1): string {
  return new URL(imgUrl(printingId, 'normal', face), location.origin).toString();
}

function ensureWorkers(): boolean {
  if (workerMode === 'main') return false;
  if (workers) return true;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') { workerMode = 'main'; return false; }
  try {
    workers = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker(new URL('../../workers/normalmap.worker.ts', import.meta.url));
      const slot = { w, busy: null as Job | null };
      w.onmessage = (e: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
        const job = pending.get(e.data.id);
        pending.delete(e.data.id);
        slot.busy = null;
        if (job) {
          if (e.data.blob) job.resolve(e.data.blob);
          else job.reject(new Error(e.data.error ?? 'normal map failed'));
        }
        pump();
      };
      w.onerror = (ev) => {
        // A worker that fails to boot (bundling issue, CSP) flips the pipeline to main-thread mode.
        if (process.env.NODE_ENV !== 'production') console.warn('[CardGL] normal-map worker error; falling back to main thread', ev.message);
        const failed = slot.busy;
        slot.busy = null;
        workerMode = 'main';
        for (const s of workers ?? []) s.w.terminate();
        workers = null;
        if (failed) { pending.forEach((j, id) => { if (j === failed) pending.delete(id); }); queue.unshift(failed); }
        pump();
      };
      workers.push(slot);
    }
    workerMode = 'worker';
    return true;
  } catch {
    workerMode = 'main';
    workers = null;
    return false;
  }
}

let mainBusy = false;
async function runOnMain(job: Job): Promise<Blob> {
  const res = await fetch(absoluteUrl(job.printingId, job.face));
  if (!res.ok) throw new Error(`image ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const W = NORMALMAP_WIDTH, H = NORMALMAP_HEIGHT;
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const c2d = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!c2d) throw new Error('2d context unavailable');
  c2d.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const src = c2d.getImageData(0, 0, W, H);
  const packed = computeNormalMap(src.data, W, H);
  c2d.putImageData(new ImageData(packed, W, H), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    if ('convertToBlob' in canvas) canvas.convertToBlob({ type: 'image/webp', quality: 1 }).then(resolve, reject);
    else (canvas as HTMLCanvasElement).toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/webp', 1);
  });
  await writeNormalMap(job.printingId, job.face, blob);
  return blob;
}

function pump() {
  if (!queue.length) return;
  if (ensureWorkers() && workers) {
    for (const slot of workers) {
      if (slot.busy || !queue.length) continue;
      const job = queue.shift()!;
      slot.busy = job;
      const id = nextId++;
      pending.set(id, job);
      slot.w.postMessage({ id, printingId: job.printingId, face: job.face, url: absoluteUrl(job.printingId, job.face) });
    }
    return;
  }
  if (mainBusy) return;
  const job = queue.shift()!;
  mainBusy = true;
  runOnMain(job).then(job.resolve, job.reject).finally(() => { mainBusy = false; pump(); });
}

function enqueue(printingId: string, face: 0 | 1, priority: Priority): Promise<Blob> {
  const key = keyOf(printingId, face);
  const cached = blobCache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = jobs.get(key);
  if (existing) {
    if (priority === 'interactive' && existing.priority === 'prefetch') {
      existing.priority = 'interactive';
      const i = queue.indexOf(existing);
      if (i > 0) { queue.splice(i, 1); queue.unshift(existing); }
    }
    return existing.promise;
  }
  let resolve!: (b: Blob) => void, reject!: (e: unknown) => void;
  const promise = new Promise<Blob>((res, rej) => { resolve = res; reject = rej; });
  const job: Job = { key, printingId, face, priority, resolve, reject, promise };
  jobs.set(key, job);
  promise.then(blob => {
    blobCache.set(key, blob);
    if (blobCache.size > 160) { const first = blobCache.keys().next().value; if (first) blobCache.delete(first); }
  }).catch(() => {}).finally(() => jobs.delete(key));
  void (async () => {
    const hit = await readNormalMap(printingId, face);
    if (hit) { resolve(hit); return; }
    if (priority === 'interactive') queue.unshift(job); else queue.push(job);
    pump();
  })();
  return promise;
}

/** Resolve a decoded, unpremultiplied bitmap of the card's packed normal map. */
export async function getNormalMap(printingId: string, face: 0 | 1, priority: Priority = 'interactive'): Promise<NormalMapResult> {
  const key = keyOf(printingId, face);
  const fromCache = blobCache.has(key);
  const blob = await enqueue(printingId, face, priority);
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  return { bitmap, fromCache };
}

/** Warm the cache without decoding a bitmap. */
export function prefetchNormalMap(printingId: string, face: 0 | 1 = 0): void {
  if (typeof window === 'undefined') return;
  enqueue(printingId, face, 'prefetch').catch(() => {});
}

// ---- IntersectionObserver-driven prefetch ---------------------------------------------------------

let observer: IntersectionObserver | null = null;
const observed = new WeakMap<Element, { printingId: string; face: 0 | 1; cancel?: () => void }>();

function getObserver(): IntersectionObserver | null {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return null;
  if (!observer) {
    observer = new IntersectionObserver(entries => {
      for (const en of entries) {
        const rec = observed.get(en.target);
        if (!rec) continue;
        if (en.isIntersecting) {
          rec.cancel?.();
          rec.cancel = idle(() => { rec.cancel = undefined; prefetchNormalMap(rec.printingId, rec.face); });
        } else if (rec.cancel) { rec.cancel(); rec.cancel = undefined; }
      }
    }, { rootMargin: '200px' });
  }
  return observer;
}

/** Prefetch the normal map when `el` comes within 200 px of the viewport. Returns an unobserve. */
export function observePrefetch(el: Element, printingId: string, face: 0 | 1 = 0): () => void {
  const obs = getObserver();
  if (!obs) return () => {};
  observed.set(el, { printingId, face });
  obs.observe(el);
  return () => { observed.get(el)?.cancel?.(); observed.delete(el); obs.unobserve(el); };
}

export function normalMapPipelineInfo() {
  return { mode: workerMode, queued: queue.length, inflight: pending.size + (mainBusy ? 1 : 0), cached: blobCache.size };
}
