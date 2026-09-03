// POST /api/meta/archetypes/[id]/sample { seed? } -> a concrete member list saved as an opponent deck.
import { getDecks, getMeta, jsonError, readJson } from '../../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readJson<{ seed?: number }>(req);
  const seed = Number.isFinite(Number(body.seed)) && body.seed != null ? Math.floor(Number(body.seed)) >>> 0 : (Math.random() * 0xffffffff) >>> 0;
  const service = getMeta();
  if (!service.cards) return jsonError('master.db is not available; cannot resolve card names', 503);
  const r = service.sampleArchetypeAsDeck(id, seed, getDecks());
  if (!r) return jsonError('archetype not found or has no member decklists', 404);
  return Response.json(r, { status: 201 });
}
