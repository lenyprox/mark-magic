// Serves card images from the local cache, fetching from Scryfall on the first request.
import fs from 'node:fs';
import { getQuery } from '@/lib/db';
import { getImage, SIZES, type ImageSize } from '@images/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(req: Request, ctx: { params: Promise<{ id: string; face: string; size: string }> }) {
  const { id, face, size } = await ctx.params;
  if (!UUID.test(id) || !['0', '1'].includes(face) || !SIZES.includes(size as ImageSize)) return new Response('bad request', { status: 400 });
  const etag = `"${id}-${face}-${size}"`;
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
  let result;
  try {
    const q = getQuery();
    result = await getImage(id, Number(face), size as ImageSize, (pid, f) => q.imageSource(pid, f));
  } catch (e) {
    return new Response(`image fetch failed: ${(e as Error).message}`, { status: 502 });
  }
  if (!result) return new Response('no image', { status: 404 });
  const body = fs.readFileSync(result.path);
  return new Response(body, { status: 200, headers: { 'Content-Type': result.contentType, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'Content-Length': String(body.length) } });
}
