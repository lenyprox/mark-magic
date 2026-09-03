// The parsed CardDefs for a saved deck, ready for the game worker.
import { getCards, getDecks } from '@/lib/db';
import { buildDeckPayload } from '@play/payload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const decks = getDecks();
  const d = decks.get(id);
  if (!d) return Response.json({ error: 'not found' }, { status: 404 });
  const printings: Record<string, string | null> = {};
  for (const c of d.cards) if (c.printingId) printings[c.name] = c.printingId;
  const list = decks.toDeckList(id)!;
  const payload = buildDeckPayload(getCards(), list, { deckId: id, name: d.name, printings, archetype: d.archetype ? { id: d.sourceRef ?? '', name: d.archetype, format: d.format } : null });
  return Response.json(payload);
}
