// POST /api/meta/sync { format, sources?, days?, force?, set? } -> per-source counts.
import { getMeta, jsonError, parseFormat, readJson } from '../_service';
import { parseSources, runSync } from '@meta/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { format?: string; sources?: string | string[]; days?: number; force?: boolean; set?: string }

export async function POST(req: Request) {
  const body = await readJson<Body>(req);
  const format = parseFormat(body.format);
  if (!format) return jsonError('format must be one of Standard, Modern, Pioneer, Legacy, Vintage, Pauper, EDH');
  let sources;
  try { sources = parseSources(body.sources); } catch (e) { return jsonError((e as Error).message); }
  const days = body.days == null ? 30 : Number(body.days);
  if (!Number.isFinite(days) || days <= 0 || days > 365) return jsonError('days must be between 1 and 365');
  const service = getMeta();
  if (sources.includes('topdeck') && !service.configured()) {
    return Response.json({ error: 'TOPDECK_API_KEY is not set. Add it to .env.local and restart the dev server.', configured: false }, { status: 409 });
  }
  try {
    const report = await runSync({ user: service.store.db, cards: service.cards, service, format, sources, days, set: body.set, force: !!body.force });
    return Response.json({ ...report, configured: service.configured(), archetypes: service.archetypes(format).length });
  } catch (e) {
    return jsonError((e as Error).message, 500);
  }
}
