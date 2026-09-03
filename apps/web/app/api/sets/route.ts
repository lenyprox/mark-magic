import { getQuery } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(getQuery().sets(), { headers: { 'Cache-Control': 'private, max-age=3600' } });
}
