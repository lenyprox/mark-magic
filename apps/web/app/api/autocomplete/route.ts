import { getQuery } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const q = sp.get('q') ?? '';
  const limit = Math.min(30, Math.max(1, Number(sp.get('limit') ?? 12) || 12));
  return Response.json(getQuery().autocomplete(q, limit));
}
