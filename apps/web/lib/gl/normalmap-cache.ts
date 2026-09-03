// IndexedDB cache for generated normal maps (WebP/PNG blobs), shared by the worker and the main thread.
import { createStore, get, set, del, keys } from 'idb-keyval';

export const NORMALMAP_VERSION = 'v1';
export const NORMALMAP_WIDTH = 256;
export const NORMALMAP_HEIGHT = 357;

let store: ReturnType<typeof createStore> | null = null;
function db() {
  if (!store) store = createStore('mtg-vault-gl', 'normalmaps');
  return store;
}

export function normalMapKey(printingId: string, face: 0 | 1): string {
  return `${printingId}:${face}:${NORMALMAP_VERSION}`;
}

export async function readNormalMap(printingId: string, face: 0 | 1): Promise<Blob | undefined> {
  try { return await get<Blob>(normalMapKey(printingId, face), db()); } catch { return undefined; }
}

export async function writeNormalMap(printingId: string, face: 0 | 1, blob: Blob): Promise<void> {
  try { await set(normalMapKey(printingId, face), blob, db()); } catch { /* quota or private mode: fine, we just recompute next time */ }
}

export async function deleteNormalMap(printingId: string, face: 0 | 1): Promise<void> {
  try { await del(normalMapKey(printingId, face), db()); } catch { /* ignore */ }
}

/** Number of cached maps (dev page). */
export async function countNormalMaps(): Promise<number> {
  try { return (await keys(db())).length; } catch { return 0; }
}
