import { getQuery } from '@/lib/db';
import { parseCardQuery } from '@/lib/query-params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const q = parseCardQuery(new URL(req.url).searchParams);
  const page = getQuery().search(q);
  return Response.json({ ...page, query: q }, { headers: { 'Cache-Control': 'private, max-age=60' } });
}
