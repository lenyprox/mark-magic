// How much of a saved deck the collection covers (maybeboard excluded).
import { getCollection, getDecks } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ deckId: string }> }) {
  const { deckId } = await ctx.params;
  const deck = getDecks().get(deckId);
  if (!deck) return Response.json({ error: 'deck not found' }, { status: 404 });
  const cov = getCollection().coverageOf(deck.cards);
  return Response.json({ ...cov, deck: { id: deck.id, name: deck.name } }, { headers: { 'Cache-Control': 'private, no-store' } });
}
