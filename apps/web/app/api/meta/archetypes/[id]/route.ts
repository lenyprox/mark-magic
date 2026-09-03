// GET /api/meta/archetypes/[id] -> { archetype, profile, members }
import { getMeta, jsonError } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const service = getMeta();
  const archetype = service.store.archetype(id);
  if (!archetype) return jsonError('archetype not found', 404);
  const url = new URL(req.url);
  const members = Math.min(100, Math.max(0, Number(url.searchParams.get('members') ?? 20) || 20));
  return Response.json({ archetype, profile: service.profile(id), members: service.memberDecks(id, members).map(m => ({ ...m, cards: undefined })) });
}
