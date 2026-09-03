// 17lands public card ratings (CC BY 4.0): GET /card_ratings/data?expansion=<SET>&format=PremierDraft. 24 h cache.
import { DAY_MS, type HttpClient } from './http.js';
import type { CardRating } from './types.js';

export const SEVENTEENLANDS_ORIGIN = 'https://www.17lands.com';
export const SEVENTEENLANDS_FORMATS = ['PremierDraft', 'TradDraft', 'QuickDraft', 'Sealed', 'TradSealed'] as const;
export type SeventeenLandsFormat = typeof SEVENTEENLANDS_FORMATS[number];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function ratingsUrl(set: string, format: SeventeenLandsFormat = 'PremierDraft'): string {
  return `${SEVENTEENLANDS_ORIGIN}/card_ratings/data?expansion=${encodeURIComponent(set.toUpperCase())}&format=${encodeURIComponent(format)}`;
}

/** Map the raw JSON array into CardRating rows (unknown fields ignored; rows without a name dropped). */
export function parseCardRatings(raw: unknown): CardRating[] {
  if (!Array.isArray(raw)) return [];
  const out: CardRating[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim()) continue;
    out.push({
      name: r.name.trim(), oracleId: null,
      gameCount: num(r.game_count) ?? num(r.ever_drawn_game_count),
      everDrawnWinRate: num(r.ever_drawn_win_rate), openingHandWinRate: num(r.opening_hand_win_rate), drawnWinRate: num(r.drawn_win_rate),
      gihWinRate: num(r.ever_drawn_win_rate), avgSeen: num(r.avg_seen), avgPick: num(r.avg_pick),
      color: typeof r.color === 'string' ? r.color : null, rarity: typeof r.rarity === 'string' ? r.rarity : null,
    });
  }
  return out;
}

export async function fetchCardRatings(set: string, opts: { http: HttpClient; format?: SeventeenLandsFormat; force?: boolean }): Promise<{ ratings: CardRating[]; fromCache: boolean }> {
  const { data, res } = await opts.http.json<unknown>(ratingsUrl(set, opts.format ?? 'PremierDraft'), { ttlMs: DAY_MS, force: opts.force });
  return { ratings: parseCardRatings(data), fromCache: res.fromCache };
}
