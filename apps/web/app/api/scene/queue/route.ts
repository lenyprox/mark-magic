// On-demand scene analysis: the renderer posts `{ printingId, face }` when a live card has no scene pack.
// The id is appended to data/scene/queue.txt, which `tools/scene/analyze.py --watch` drains while it runs.
// Nothing here runs the models; without the watcher the queue simply accumulates.
import fs from 'node:fs';
import path from 'node:path';
import { SCENE_DIR } from '@config/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const recent = new Map<string, number>();   // de-duplicate bursts from many tabs / re-registrations

export async function POST(req: Request) {
  let body: { printingId?: unknown; face?: unknown };
  try { body = (await req.json()) as { printingId?: unknown; face?: unknown }; } catch { return new Response('bad request', { status: 400 }); }
  const id = typeof body.printingId === 'string' ? body.printingId.toLowerCase() : '';
  const face = body.face === 1 || body.face === '1' ? 1 : 0;
  if (!UUID.test(id)) return new Response('bad request', { status: 400 });
  const key = `${id}:${face}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < 10 * 60 * 1000) return Response.json({ queued: false, reason: 'recent' });
  recent.set(key, now);
  if (recent.size > 5000) for (const [k, t] of recent) if (now - t > 10 * 60 * 1000) recent.delete(k);
  const dir = SCENE_DIR();
  if (fs.existsSync(path.join(dir, id.slice(0, 2), `${id}-${face}`, 'scene.json'))) return Response.json({ queued: false, reason: 'exists' });
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'queue.txt'), `${key}\n`);
  return Response.json({ queued: true });
}
