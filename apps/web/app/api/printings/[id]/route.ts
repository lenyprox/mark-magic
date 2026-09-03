import { getQuery } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const full = new URL(req.url).searchParams.get('full') === '1';
  const q = getQuery();
  const d = full ? q.byPrinting(id) : q.printing(id);
  if (!d) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(d, { headers: { 'Cache-Control': 'private, max-age=300' } });
}
