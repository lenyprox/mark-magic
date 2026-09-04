import { getCollection } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ oracleId: string }> }) {
  const { oracleId } = await ctx.params;
  return Response.json(getCollection().ownedDetail(oracleId), { headers: { 'Cache-Control': 'private, no-store' } });
}
