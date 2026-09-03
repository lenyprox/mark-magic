// GET /api/meta/[format]?limit=50 -> { format, configured, goldfishEnabled, lastRefresh, archetypes, decklists }
import { getMeta, jsonError, parseFormat } from '../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ format: string }> }) {
  const { format: raw } = await ctx.params;
  const format = parseFormat(raw);
  if (!format) return jsonError('unknown format', 404);
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
  const service = getMeta();
  return Response.json({
    format,
    configured: service.configured(),
    goldfishEnabled: service.goldfishEnabled(),
    lastRefresh: service.lastRefresh(format),
    archetypes: service.archetypes(format),
    decklists: service.recentDecklists(format, limit),
  });
}
