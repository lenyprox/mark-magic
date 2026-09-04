import { getCollection } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(getCollection().stats(), { headers: { 'Cache-Control': 'private, no-store' } });
}
