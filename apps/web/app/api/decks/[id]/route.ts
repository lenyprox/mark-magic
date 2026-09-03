import { getDecks } from '@/lib/db';
import type { DeckInput } from '@user/decks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const d = getDecks().get(id);
  return d ? Response.json(d) : Response.json({ error: 'not found' }, { status: 404 });
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const patch = (await req.json()) as Partial<DeckInput>;
  const d = getDecks().update(id, patch);
  return d ? Response.json(d) : Response.json({ error: 'not found' }, { status: 404 });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return Response.json({ ok: getDecks().remove(id) });
}
