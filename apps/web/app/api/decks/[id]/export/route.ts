import { getDecks, getQuery } from '@/lib/db';
import { toArenaText, toPlainText } from '@decks/format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const d = getDecks().get(id);
  if (!d) return new Response('not found', { status: 404 });
  const fmt = new URL(req.url).searchParams.get('fmt') ?? 'plain';
  let text: string;
  if (fmt === 'arena') {
    const q = getQuery();
    text = toArenaText(d.cards.map(c => { const p = c.printingId ? q.printing(c.printingId) : null; return { ...c, set: p?.setCode ?? null, number: p?.collectorNumber ?? null }; }));
  } else text = toPlainText(d.cards, d.name);
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${d.name.replace(/[^\w.-]+/g, '_')}.txt"` } });
}
