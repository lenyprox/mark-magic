import { getOptimizer } from '@/lib/db';
import { isStale } from '@/lib/optimizer/daemon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ask the daemon to stop at the next game boundary (a stale run is marked cancelled outright). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getOptimizer(); const run = store.get(id);
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  if (run.status === 'done' || run.status === 'cancelled' || run.status === 'failed') return Response.json({ run });
  store.setStatus(id, isStale(run) || run.status === 'queued' || run.status === 'paused' ? 'cancelled' : 'cancelling');
  return Response.json({ run: store.get(id) });
}
