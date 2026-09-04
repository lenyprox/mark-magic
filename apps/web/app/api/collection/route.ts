// The registered collection: version, headline numbers, every owned card (oracle level) and the import sources.
import { getCollection } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? undefined;
  const store = getCollection();
  const { items } = store.list({ q, limit: 100_000 });
  return Response.json({ version: store.version(), summary: store.summary(), cards: items, sources: store.sources() }, { headers: { 'Cache-Control': 'private, no-store' } });
}
