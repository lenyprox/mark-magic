import { getCollection, getQuery } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ oracleId: string }> }) {
  const { oracleId } = await ctx.params;
  const d = getQuery().detail(oracleId);
  if (!d) return Response.json({ error: 'not found' }, { status: 404 });
  let collection = null;
  try { collection = getCollection().ownedDetail(oracleId); } catch { collection = null; }
  return Response.json({ ...d, collection }, { headers: { 'Cache-Control': 'private, max-age=60' } });
}
