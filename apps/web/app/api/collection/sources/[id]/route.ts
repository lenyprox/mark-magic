// Remove one import source (its cards leave the collection); ?deck=1 also deletes the deck registered from it.
import { getCollection } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deleteDeck = new URL(req.url).searchParams.get('deck') === '1';
  const store = getCollection();
  const ok = store.removeSource(id, { deleteDeck });
  if (!ok) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ ok, version: store.version() });
}
