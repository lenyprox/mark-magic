// TopDeck.gg official API v2 adapter (POST /api/v2/tournaments). Field names verified against
// https://topdeck.gg/docs/tournaments-v2 on 2026-09-03; the mapper tolerates missing/renamed fields.
import { parseDeckList } from '../cards/db.js';
import { normalizeCards } from './normalize.js';
import type { HttpClient } from './http.js';
import type { MetaFormat, NormalizedCard, NormalizedDecklist, NormalizedEvent } from './types.js';

export const TOPDECK_API = 'https://topdeck.gg/api/v2/tournaments';
export const TOPDECK_COLUMNS = ['name', 'id', 'decklist', 'wins', 'losses', 'draws', 'winRate'] as const;

export interface TopdeckDeckObjEntry { count?: number; qty?: number; quantity?: number; id?: string; name?: string }
export interface TopdeckDeckObj { Mainboard?: Record<string, TopdeckDeckObjEntry | number>; Sideboard?: Record<string, TopdeckDeckObjEntry | number>; Commanders?: Record<string, TopdeckDeckObjEntry | number> }
export interface TopdeckStanding {
  standing?: number; name?: string; id?: string; decklist?: string | null; deckObj?: TopdeckDeckObj | null;
  wins?: number; losses?: number; draws?: number; winRate?: number;
}
export interface TopdeckTournament {
  TID: string; tournamentName?: string; startDate?: number; game?: string; format?: string; swissNum?: number; topCut?: number;
  standings?: TopdeckStanding[];
}

export interface TopdeckMapResult { events: NormalizedEvent[]; decklists: NormalizedDecklist[]; skippedUrlOnly: number; skippedEmpty: number }
export type CardResolver = (cards: { name: string; count: number; board: string }[]) => NormalizedCard[];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.round(n); };

function boardEntries(obj: Record<string, TopdeckDeckObjEntry | number> | undefined, board: string): { name: string; count: number; board: string }[] {
  if (!obj || typeof obj !== 'object') return [];
  const out: { name: string; count: number; board: string }[] = [];
  for (const [name, v] of Object.entries(obj)) {
    const count = typeof v === 'number' ? v : v && typeof v === 'object' ? (num(v.count) ?? num(v.qty) ?? num(v.quantity) ?? 1) : 1;
    const label = (typeof v === 'object' && v && typeof v.name === 'string' && v.name) || name;
    if (count > 0) out.push({ name: label, count, board });
  }
  return out;
}

/** Cards of a standing from deckObj (preferred) or the decklist text; null when only a URL/empty. */
export function standingCards(s: TopdeckStanding): { cards: { name: string; count: number; board: string }[]; kind: 'obj' | 'text' | 'url' | 'empty' } {
  const obj = s.deckObj;
  if (obj && typeof obj === 'object') {
    const cards = [...boardEntries(obj.Commanders, 'commander'), ...boardEntries(obj.Mainboard, 'main'), ...boardEntries(obj.Sideboard, 'side')];
    if (cards.length) return { cards, kind: 'obj' };
  }
  const text = typeof s.decklist === 'string' ? s.decklist.trim() : '';
  if (!text) return { cards: [], kind: 'empty' };
  if (/^https?:\/\/\S+$/i.test(text)) return { cards: [], kind: 'url' };
  const parsed = parseDeckList(text);
  const cards = parsed.cards.filter(c => c.count > 0 && c.name && !/^https?:\/\//i.test(c.name)).map(c => ({ name: c.name, count: c.count, board: c.board }));
  return cards.length ? { cards, kind: 'text' } : { cards: [], kind: 'empty' };
}

/** Map raw tournaments to normalised events and decklists. Pure; `resolve` attaches oracle ids when a CardDB is available. */
export function mapTournaments(raw: unknown, format: string, resolve: CardResolver = cards => normalizeCards(null, cards)): TopdeckMapResult {
  const events: NormalizedEvent[] = []; const decklists: NormalizedDecklist[] = [];
  let skippedUrlOnly = 0, skippedEmpty = 0;
  const list = Array.isArray(raw) ? (raw as TopdeckTournament[]) : [];
  for (const t of list) {
    if (!t || typeof t !== 'object' || !t.TID) continue;
    const date = typeof t.startDate === 'number' ? new Date(t.startDate * (t.startDate < 1e12 ? 1000 : 1)).toISOString().slice(0, 10) : null;
    const standings = Array.isArray(t.standings) ? t.standings : [];
    const url = `https://topdeck.gg/event/${t.TID}`;
    events.push({ source: 'topdeck', sourceId: String(t.TID), name: t.tournamentName ?? null, format: t.format ?? format, date, players: standings.length || null, url });
    standings.forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const { cards: rawCards, kind } = standingCards(s);
      if (kind === 'url') { skippedUrlOnly++; return; }
      if (kind === 'empty') { skippedEmpty++; return; }
      const cards = resolve(rawCards);
      const deckSize = cards.filter(c => c.board !== 'side').reduce((a, c) => a + c.count, 0);
      if (deckSize < 20) { skippedEmpty++; return; }
      const playerId = typeof s.id === 'string' && s.id ? s.id : String(i + 1);
      decklists.push({
        source: 'topdeck', sourceId: `${t.TID}:${playerId}`, eventSourceId: String(t.TID), format: t.format ?? format, archetype: null,
        player: typeof s.name === 'string' ? s.name : null, placement: int(s.standing) ?? i + 1,
        wins: int(s.wins), losses: int(s.losses), draws: int(s.draws), date, url: `${url}/standings`, deckSize, cards,
      });
    });
  }
  return { events, decklists, skippedUrlOnly, skippedEmpty };
}

export interface TopdeckFetchOptions { http: HttpClient; apiKey: string; days?: number; participantMin?: number; force?: boolean; ttlMs?: number; resolve?: CardResolver }

export function topdeckRequestBody(format: MetaFormat | string, days: number, participantMin: number): string {
  return JSON.stringify({ game: 'Magic: The Gathering', format, last: days, participantMin, columns: [...TOPDECK_COLUMNS] });
}

/** Fetch and map the last `days` days of tournaments for a format. Cached 6 h by default (the sync layer decides freshness). */
export async function fetchTopdeck(format: MetaFormat | string, opts: TopdeckFetchOptions): Promise<TopdeckMapResult & { fromCache: boolean; tournaments: number }> {
  if (!opts.apiKey) throw new Error('TOPDECK_API_KEY is not set');
  const body = topdeckRequestBody(format, opts.days ?? 30, opts.participantMin ?? 8);
  const { data, res } = await opts.http.json<unknown>(TOPDECK_API, {
    method: 'POST', body, headers: { Authorization: opts.apiKey, 'Content-Type': 'application/json' },
    ttlMs: opts.ttlMs ?? 6 * 60 * 60 * 1000, force: opts.force,
    cacheKey: `POST ${TOPDECK_API}#${format}:${opts.days ?? 30}:${opts.participantMin ?? 8}`,
  });
  const mapped = mapTournaments(data, format, opts.resolve);
  return { ...mapped, fromCache: res.fromCache, tournaments: Array.isArray(data) ? data.length : 0 };
}
