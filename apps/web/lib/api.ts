// Typed client fetch helpers for the JSON routes under /api. Every function returns parsed JSON or throws ApiError.
import type { CardDetail, CardQuery, CardSummary, Page, PrintingDetail, SetSummary } from '@cards/query';
import { cardQueryToParams } from '@/lib/query-params';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let msg = res.statusText;
    try { const body = await res.json(); if (body?.error) msg = String(body.error); } catch { /* ignore */ }
    throw new ApiError(res.status, msg || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export type CardPage = Page<CardSummary> & { query: CardQuery };
export interface AutocompleteHit { name: string; oracleId: string; printingId: string; typeLine: string; manaCost: string | null }
export interface HealthStatus {
  ok: boolean; root: string; master: boolean; index: boolean; indexStale: boolean; masterBuiltAt: string | null; indexBuiltAt: string | null;
  userDb: boolean; manaSprite: boolean; images: { files: number; bytes: number };
}
export type CatalogKind = 'types' | 'subtypes' | 'supertypes' | 'keywords';

export const api = {
  cards: (q: CardQuery, signal?: AbortSignal) => getJson<CardPage>(`/api/cards?${cardQueryToParams(q)}`, signal),
  card: (oracleId: string, signal?: AbortSignal) => getJson<CardDetail>(`/api/cards/${encodeURIComponent(oracleId)}`, signal),
  printing: (id: string, signal?: AbortSignal) => getJson<PrintingDetail>(`/api/printings/${encodeURIComponent(id)}`, signal),
  printingCard: (id: string, signal?: AbortSignal) => getJson<CardDetail>(`/api/printings/${encodeURIComponent(id)}?full=1`, signal),
  sets: (signal?: AbortSignal) => getJson<SetSummary[]>('/api/sets', signal),
  autocomplete: (q: string, limit = 10, signal?: AbortSignal) => getJson<AutocompleteHit[]>(`/api/autocomplete?q=${encodeURIComponent(q)}&limit=${limit}`, signal),
  catalog: (kind: CatalogKind, q = '', signal?: AbortSignal) => getJson<string[]>(`/api/catalog/${kind}?q=${encodeURIComponent(q)}`, signal),
  health: (signal?: AbortSignal) => getJson<HealthStatus>('/api/health', signal),
};

/** Stable react-query key for a card search; page is handled by useInfiniteQuery. */
export function cardsKey(q: CardQuery): unknown[] {
  const { page: _p, ...rest } = q;
  return ['cards', rest];
}
