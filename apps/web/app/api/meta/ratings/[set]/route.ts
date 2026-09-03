// GET /api/meta/ratings/[set]?format=PremierDraft&force=1 -> 17lands card ratings (24 h cache).
import { getMeta, jsonError } from '../../_service';
import { SEVENTEENLANDS_FORMATS, type SeventeenLandsFormat } from '@meta/seventeenlands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ set: string }> }) {
  const { set } = await ctx.params;
  if (!/^[A-Za-z0-9]{2,6}$/.test(set)) return jsonError('bad set code');
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'PremierDraft') as SeventeenLandsFormat;
  if (!SEVENTEENLANDS_FORMATS.includes(format)) return jsonError(`format must be one of ${SEVENTEENLANDS_FORMATS.join(', ')}`);
  try {
    const r = await getMeta().cardRatings(set, { format, force: url.searchParams.get('force') === '1' });
    return Response.json({ set: set.toUpperCase(), format, attribution: '17lands.com (CC BY 4.0)', ...r });
  } catch (e) {
    return jsonError(`17lands unavailable: ${(e as Error).message}`, 502);
  }
}
