import { dataStatus } from '@/lib/db';
import { cacheStats } from '@images/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const status = dataStatus();
  return Response.json({ ...status, images: cacheStats(), ok: status.master && status.index });
}
