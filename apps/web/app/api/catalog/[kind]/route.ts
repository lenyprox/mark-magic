import { getQuery } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set(['types', 'subtypes', 'supertypes', 'keywords']);
const cache = new Map<string, string[]>();

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  if (!KINDS.has(kind)) return Response.json({ error: 'bad kind' }, { status: 400 });
  const sp = new URL(req.url).searchParams;
  const prefix = sp.get('q') ?? '';
  const key = `${kind}:${prefix.toLowerCase()}`;
  let out = cache.get(key);
  if (!out) { out = getQuery().catalog(kind as 'types' | 'subtypes' | 'supertypes' | 'keywords', prefix, Number(sp.get('limit') ?? 40) || 40); cache.set(key, out); }
  return Response.json(out, { headers: { 'Cache-Control': 'private, max-age=3600' } });
}
