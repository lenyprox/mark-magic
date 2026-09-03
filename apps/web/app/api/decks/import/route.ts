// Parse deck text, resolve every card against the master DB, and optionally save it.
import { getCards, getDecks, getQuery } from '@/lib/db';
import { parseDeckText, resolveDeck } from '@decks/format';
import type { DeckRole } from '@user/decks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json()) as { text: string; name?: string; format?: string; role?: DeckRole; save?: boolean; source?: string; sourceRef?: string };
  if (typeof body?.text !== 'string' || !body.text.trim()) return Response.json({ error: 'text required' }, { status: 400 });
  const parsed = parseDeckText(body.text);
  const { cards, missing } = resolveDeck(getCards(), getQuery(), parsed);
  const name = body.name?.trim() || parsed.name || 'Imported deck';
  const summary = { name, format: body.format ?? parsed.format ?? 'casual', cards, missing, unknownLines: parsed.unknownLines, mainCount: cards.filter(c => c.board === 'main' || c.board === 'commander').reduce((a, c) => a + c.count, 0), sideCount: cards.filter(c => c.board === 'side').reduce((a, c) => a + c.count, 0) };
  if (!body.save) return Response.json(summary);
  const deck = getDecks().create({ name, format: summary.format, role: body.role ?? 'mine', source: body.source ?? 'import:text', sourceRef: body.sourceRef ?? null, cards });
  return Response.json({ ...summary, deck }, { status: 201 });
}
