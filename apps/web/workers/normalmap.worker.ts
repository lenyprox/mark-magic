/// <reference lib="webworker" />
// Normal-map worker: fetches the card's `normal` JPG, downsamples to 256x357, runs the height/normal
// synthesis and returns a WebP (or PNG) blob, also writing it to the IndexedDB cache.

import { computeNormalMap } from '@/lib/gl/normalmap-compute';
import { writeNormalMap, NORMALMAP_WIDTH, NORMALMAP_HEIGHT } from '@/lib/gl/normalmap-cache';

export interface NormalMapJob { id: number; printingId: string; face: 0 | 1; url: string }
export type NormalMapReply = { id: number; blob: Blob } | { id: number; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let canvas: OffscreenCanvas | null = null;
let c2d: OffscreenCanvasRenderingContext2D | null = null;

async function run(job: NormalMapJob): Promise<Blob> {
  const res = await fetch(job.url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' });
  if (!canvas) {
    canvas = new OffscreenCanvas(NORMALMAP_WIDTH, NORMALMAP_HEIGHT);
    c2d = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!c2d) throw new Error('2d context unavailable in worker');
  c2d.imageSmoothingEnabled = true;
  c2d.imageSmoothingQuality = 'high';
  c2d.clearRect(0, 0, NORMALMAP_WIDTH, NORMALMAP_HEIGHT);
  c2d.drawImage(bmp, 0, 0, NORMALMAP_WIDTH, NORMALMAP_HEIGHT);
  bmp.close();
  const src = c2d.getImageData(0, 0, NORMALMAP_WIDTH, NORMALMAP_HEIGHT);
  const packed = computeNormalMap(src.data, NORMALMAP_WIDTH, NORMALMAP_HEIGHT);
  c2d.putImageData(new ImageData(packed, NORMALMAP_WIDTH, NORMALMAP_HEIGHT), 0, 0);
  let blob: Blob;
  try {
    blob = await canvas!.convertToBlob({ type: 'image/webp', quality: 1 });
    if (blob.type !== 'image/webp') blob = await canvas!.convertToBlob({ type: 'image/png' });
  } catch {
    blob = await canvas!.convertToBlob({ type: 'image/png' });
  }
  await writeNormalMap(job.printingId, job.face, blob);
  return blob;
}

ctx.onmessage = async (e: MessageEvent<NormalMapJob>) => {
  const job = e.data;
  try {
    const blob = await run(job);
    ctx.postMessage({ id: job.id, blob } satisfies NormalMapReply);
  } catch (err) {
    ctx.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) } satisfies NormalMapReply);
  }
};
