import { getCollection } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const fmt = new URL(req.url).searchParams.get('fmt') === 'arena' ? 'arena' : 'csv';
  const text = getCollection().exportText(fmt);
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="collection.${fmt === 'csv' ? 'csv' : 'txt'}"` } });
}
