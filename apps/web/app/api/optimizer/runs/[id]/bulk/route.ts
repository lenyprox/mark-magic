import { getOptimizer } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The "check your bulk" list as plain text (one card per line), for printing or pasting into a search. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getOptimizer().get(id);
  if (!run) return new Response('not found', { status: 404 });
  const lines = (run.report?.bulkCheck ?? []).map(b => `${b.name}\t${b.reason === 'swap-in' ? 'suggested swap-in' : 'in the deck, not registered'}`);
  return new Response(lines.join('\n') + (lines.length ? '\n' : ''), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `inline; filename="bulk-${id.slice(0, 8)}.txt"` } });
}
