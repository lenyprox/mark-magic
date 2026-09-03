import { getQuery } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ oracleId: string }> }) {
  const { oracleId } = await ctx.params;
  const d = getQuery().detail(oracleId);
  if (!d) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(d, { headers: { 'Cache-Control': 'private, max-age=300' } });
}
