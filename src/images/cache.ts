// Card image cache: fetches from Scryfall's image CDN on first request and stores the file under data/images/,
// so the app never hotlinks Scryfall in pages (their published etiquette) and repeat views are local.
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_DIR } from '../config/paths.js';

export type ImageSize = 'small' | 'normal' | 'large' | 'png' | 'art_crop' | 'border_crop';
export const SIZES: readonly ImageSize[] = ['small', 'normal', 'large', 'png', 'art_crop', 'border_crop'];
export const USER_AGENT = 'mtg-master-sim/0.1 (local desktop tool; github.com/kyan12/mark-magic)';
const MAX_CONCURRENT = 6;

export function cachePath(id: string, face: number, size: ImageSize, dir = IMAGE_DIR()): string {
  return path.join(dir, size, id.slice(0, 2), `${id}-${face}.${size === 'png' ? 'png' : 'jpg'}`);
}

/** Derive any Scryfall image size URL from the stored `normal` URL. */
export function scryfallUrl(normalUrl: string, size: ImageSize): string {
  const u = normalUrl.replace(/\/(small|normal|large|png|art_crop|border_crop)\//, `/${size}/`);
  return size === 'png' ? u.replace(/\.jpg(\?|$)/, '.png$1') : u.replace(/\.png(\?|$)/, '.jpg$1');
}

export interface ImageResult { path: string; contentType: string; cached: boolean }

const inFlight = new Map<string, Promise<ImageResult | null>>();
const negative = new Map<string, number>(); // key -> expiry ms
let active = 0; const waiters: (() => void)[] = [];
async function acquire() { if (active < MAX_CONCURRENT) { active++; return; } await new Promise<void>(r => waiters.push(r)); active++; }
function release() { active--; const w = waiters.shift(); if (w) w(); }

export type SourceLookup = (id: string, face: number) => string | null;

/** Return the local file for a printing image, downloading it on a miss. Null when the printing has no such image. */
export async function getImage(id: string, face: number, size: ImageSize, lookup: SourceLookup, opts: { dir?: string; fetchImpl?: typeof fetch } = {}): Promise<ImageResult | null> {
  const dir = opts.dir ?? IMAGE_DIR();
  const file = cachePath(id, face, size, dir);
  const contentType = size === 'png' ? 'image/png' : 'image/jpeg';
  if (fs.existsSync(file)) return { path: file, contentType, cached: true };
  const key = `${id}:${face}:${size}`;
  const neg = negative.get(key); if (neg && neg > Date.now()) return null;
  const existing = inFlight.get(key); if (existing) return existing;
  const p = (async () => {
    const src = lookup(id, face);
    if (!src) { negative.set(key, Date.now() + 10 * 60_000); return null; }
    const url = scryfallUrl(src, size);
    await acquire();
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' } });
      if (res.status === 404) { negative.set(key, Date.now() + 10 * 60_000); return null; }
      if (!res.ok) throw new Error(`Scryfall image fetch failed: ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.part`;
      fs.writeFileSync(tmp, buf);
      try { fs.renameSync(tmp, file); } catch { if (!fs.existsSync(file)) throw new Error('rename failed'); fs.rmSync(tmp, { force: true }); }
      return { path: file, contentType, cached: false };
    } finally { release(); }
  })();
  inFlight.set(key, p);
  try { return await p; } finally { inFlight.delete(key); }
}

export async function prefetch(items: { id: string; face: number; size: ImageSize }[], lookup: SourceLookup, opts: { concurrency?: number; onProgress?: (done: number, total: number, failed: number) => void } = {}): Promise<{ ok: number; failed: number; skipped: number }> {
  let ok = 0, failed = 0, skipped = 0, done = 0;
  const conc = Math.max(1, Math.min(MAX_CONCURRENT, opts.concurrency ?? 4));
  const queue = [...items];
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) {
      const it = queue.shift(); if (!it) return;
      try { const r = await getImage(it.id, it.face, it.size, lookup); if (!r) skipped++; else ok++; } catch { failed++; }
      done++; opts.onProgress?.(done, items.length, failed);
    }
  }));
  return { ok, failed, skipped };
}

export function cacheStats(dir = IMAGE_DIR()): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.endsWith('.part')) { files++; bytes += fs.statSync(p).size; } } };
  walk(dir);
  return { files, bytes };
}
