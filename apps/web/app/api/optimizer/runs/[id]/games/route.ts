import { getOptimizer } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The stored game records behind a run (for one candidate, default the best list). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getOptimizer(); const run = store.get(id);
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  const candidate = new URL(req.url).searchParams.get('candidate') ?? run.report?.best.candidateId ?? run.checkpoint?.bestId ?? 'seed';
  return Response.json({ candidate, games: store.games(id, candidate) }, { headers: { 'Cache-Control': 'private, no-store' } });
}
