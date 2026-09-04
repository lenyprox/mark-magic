import { getCards, getDecks, getOptimizer } from '@/lib/db';
import type { DeckCard } from '@user/decks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Write the best list back: update the seed deck in place or save it as a new deck. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const store = getOptimizer(); const run = store.get(id);
  if (!run) return Response.json({ error: 'not found' }, { status: 404 });
  if (!run.report) return Response.json({ error: 'no report yet' }, { status: 409 });
  const body = (await req.json()) as { mode: 'update' | 'new'; name?: string };
  const decks = getDecks(); const cards = getCards();
  const seed = decks.get(run.deckId);
  const printings = new Map<string, string | null>(); for (const c of seed?.cards ?? []) printings.set(c.name, c.printingId);
  const out: DeckCard[] = [];
  run.report.best.list.forEach((e, i) => { const d = cards.get(e.name); if (d) out.push({ board: 'main', oracleId: d.oracleId, name: d.name, printingId: printings.get(d.name) ?? null, count: e.count, position: i }); });
  if (run.commander) { const d = cards.get(run.commander); if (d) out.push({ board: 'commander', oracleId: d.oracleId, name: d.name, printingId: printings.get(d.name) ?? null, count: 1, position: 0 }); }
  // keep sideboard / maybeboard of the seed deck
  for (const c of seed?.cards ?? []) if (c.board === 'side' || c.board === 'maybe') out.push(c);
  if (body.mode === 'update' && seed) { const deck = decks.update(seed.id, { cards: out }); return Response.json({ deck }); }
  const deck = decks.create({ name: body.name?.trim() || `${seed?.name ?? run.name} (optimised)`, format: seed?.format ?? (run.spec.format === 'commander' ? 'commander' : 'casual'), role: seed?.role ?? 'mine', source: 'optimizer', sourceRef: run.id, notes: `Optimised from ${seed?.name ?? run.deckId}: ${run.report.best.changes.map(c => `−${c.out} +${c.in}`).join(', ') || 'no changes'}`, cards: out });
  return Response.json({ deck }, { status: 201 });
}
