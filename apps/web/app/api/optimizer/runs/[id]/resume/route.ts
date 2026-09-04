import { getOptimizer } from '@/lib/db';
import { isStale, spawnDaemon } from '@/lib/optimizer/daemon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Respawn the daemon for a paused or stale run; it continues from the checkpoint. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getOptimizer(); const run = store.get(id);
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  if (run.status === 'running' && !isStale(run)) return Response.json({ error: 'the run is still running' }, { status: 409 });
  if (run.status === 'done') return Response.json({ error: 'the run is finished' }, { status: 409 });
  const body = (await req.json().catch(() => ({}))) as { workers?: number };
  store.setStatus(id, 'queued');
  const { pid } = spawnDaemon(id, body.workers);
  return Response.json({ run: store.get(id), pid });
}
