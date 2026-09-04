import { getDecks, getOptimizer } from '@/lib/db';
import { isStale, logTail } from '@/lib/optimizer/daemon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getOptimizer().get(id);
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ run, stale: isStale(run), log: logTail(id), deckName: getDecks().get(run.deckId)?.name ?? null }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getOptimizer(); const run = store.get(id);
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  if (run.status === 'running' && !isStale(run)) store.setStatus(id, 'cancelling');
  return Response.json({ ok: store.remove(id) });
}
