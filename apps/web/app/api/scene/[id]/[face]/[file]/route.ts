// Serves the 2.5D scene pack files written by tools/scene/analyze.py (depth, matte, background, materials,
// phenomena, flow, scene.json). Nothing is generated on demand: a missing pack is a 404 and the card renders without a scene.
import fs from 'node:fs';
import path from 'node:path';
import { SCENE_DIR } from '@config/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILES: Record<string, string> = {
  'scene.json': 'application/json',
  'color.jpg': 'image/jpeg',
  'bg.jpg': 'image/jpeg',
  'depth.png': 'image/png',
  'bgdepth.png': 'image/png',
  'matte.png': 'image/png',
  'figdepth.png': 'image/png',
  'material.png': 'image/png',
  'fx.png': 'image/png',
  'flow.png': 'image/png',
  'sheet.jpg': 'image/jpeg',
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string; face: string; file: string }> }) {
  const { id, face, file } = await ctx.params;
  const type = FILES[file];
  if (!UUID.test(id) || !['0', '1'].includes(face) || !type) return new Response('bad request', { status: 400 });
  const p = path.join(SCENE_DIR(), id.slice(0, 2), `${id}-${face}`, file);
  let stat: fs.Stats;
  try { stat = fs.statSync(p); } catch { return new Response('no scene', { status: 404 }); }
  const etag = `"${id}-${face}-${file}-${stat.mtimeMs}"`;
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
  const body = fs.readFileSync(p);
  return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, 'Content-Length': String(body.length) } });
}
