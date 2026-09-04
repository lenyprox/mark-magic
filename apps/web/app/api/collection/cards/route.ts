// Adjust the hand-registered copies of a card ("found one in my bulk"): { oracleId, delta }.
import { getCollection } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { oracleId?: string; delta?: number; name?: string } | null;
  if (!body?.oracleId || typeof body.delta !== 'number' || !Number.isInteger(body.delta) || body.delta === 0 || Math.abs(body.delta) > 1000) return Response.json({ error: 'oracleId and a non-zero integer delta are required' }, { status: 400 });
  const store = getCollection();
  const owned = store.upsert(body.oracleId, body.delta, body.name);
  if (owned === null && store.owned(body.oracleId) === null && body.delta > 0) return Response.json({ error: 'unknown card' }, { status: 404 });
  return Response.json({ owned, version: store.version() });
}
