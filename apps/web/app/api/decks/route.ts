import { getDecks } from '@/lib/db';
import type { DeckInput, DeckRole } from '@user/decks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const role = new URL(req.url).searchParams.get('role') as DeckRole | null;
  return Response.json(getDecks().list(role === 'mine' || role === 'opponent' ? role : undefined));
}

export async function POST(req: Request) {
  const body = (await req.json()) as DeckInput;
  if (!body?.name?.trim()) return Response.json({ error: 'name required' }, { status: 400 });
  const deck = getDecks().create({ ...body, name: body.name.trim() });
  return Response.json(deck, { status: 201 });
}
