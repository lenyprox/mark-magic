// POST /api/meta/decklists/[id]/import -> the tournament list saved as an opponent deck (source 'meta:topdeck').
import { getDecks, getMeta, jsonError } from '../../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const service = getMeta();
  if (!service.cards) return jsonError('master.db is not available; cannot resolve card names', 503);
  const r = service.importDecklistAsDeck(decodeURIComponent(id), getDecks());
  if (!r) return jsonError('decklist not found', 404);
  return Response.json(r, { status: 201 });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const d = getMeta().decklist(decodeURIComponent(id));
  return d ? Response.json(d) : jsonError('decklist not found', 404);
}
