// Optimiser runs: list them (with staleness) and create + launch a new run in a detached daemon.
import { getCards, getDecks, getOptimizer } from '@/lib/db';
import { isStale, spawnDaemon } from '@/lib/optimizer/daemon';
import type { CreateRunRequest } from '@/lib/optimizer/api';
import { PRESETS, type OptimizerSpec } from '@optimizer/types';
import { resolveRun } from '@optimizer/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const store = getOptimizer(); const decks = getDecks();
  const runs = store.list().map(r => ({ ...r, stale: isStale(r), deckName: decks.get(r.deckId)?.name ?? null }));
  return Response.json({ runs }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(req: Request) {
  const body = (await req.json()) as CreateRunRequest;
  const decks = getDecks(); const cards = getCards();
  const deck = decks.get(body.deckId);
  if (!deck) return Response.json({ error: 'seed deck not found' }, { status: 404 });
  const preset = PRESETS[body.preset] ?? PRESETS.quick;
  const commanderCard = deck.cards.find(c => c.board === 'commander');
  const format: OptimizerSpec['format'] = /^(commander|edh|cedh|brawl)$/i.test(deck.format) || !!commanderCard ? 'commander' : 'freeform';
  const players = ([2, 3, 4].includes(body.players) ? body.players : 2) as 2 | 3 | 4;
  const spec: OptimizerSpec = {
    name: body.name?.trim() || `${deck.name} vs ${body.field.map(f => f.name).join(', ')}`,
    seed: body.seed ?? Math.floor(Math.random() * 1e9) + 1,
    commander: commanderCard?.name ?? null, seedDeckId: deck.id, format,
    pool: body.pool === 'owned+bulk' ? 'owned+bulk' : 'owned', maxUnowned: Math.max(0, Math.min(20, body.maxUnowned ?? 5)),
    field: body.field, players, agent: 'rollout', maxTurns: Math.round((format === 'commander' ? 60 : 30) * players / 2), mulligans: 'lands',
    budget: { ...preset, games: body.games ?? preset.games, maxIterations: body.iterations ?? preset.maxIterations, validateWithAi: false },
    constraints: { lands: body.lands ?? null, lockIn: body.lockIn ?? [], ban: body.ban ?? [], onlyFullyParsedSwapIns: !!body.onlyFullyParsedSwapIns },
  };
  // validate before launching so the user sees a readable error now rather than a failed run later
  try { resolveRun({ db: getOptimizer().db, cards }, spec); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
  const run = getOptimizer().create(spec, { deckId: deck.id, commander: spec.commander });
  const { pid } = spawnDaemon(run.id, body.workers);
  return Response.json({ run, pid }, { status: 201 });
}
