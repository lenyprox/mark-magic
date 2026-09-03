import { getGames } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const g = getGames().get(id);
  return g ? Response.json(g) : Response.json({ error: 'not found' }, { status: 404 });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return Response.json({ ok: getGames().remove(id) });
}
