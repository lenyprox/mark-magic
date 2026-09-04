// Client fetch helpers for the collection routes. JSON in, JSON out, ApiError on failure.
import type { CollectionStats, CoverageReport, ImportResult, OwnedDetail, OwnedEntry, SourceRecord } from '@collection/store';
import type { CommanderInference } from '@collection/names';
import type { CountNameRow } from '@collection/csv';
import type { DeckRecord } from '@user/decks';
import { ApiError } from '@/lib/api';

async function send<T>(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { ...init, signal, headers: { Accept: 'application/json', ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  if (!res.ok) {
    let msg = res.statusText;
    try { const body = await res.json(); if (body?.error) msg = String(body.error); } catch { /* ignore */ }
    throw new ApiError(res.status, msg || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface CollectionSummary { distinct: number; copies: number; sources: number; decks: number; updatedAt: string | null }
export interface CollectionList { version: number; summary: CollectionSummary; cards: OwnedEntry[]; sources: SourceRecord[] }
export interface ImportFile { name: string; text: string }
export interface ImportPreviewFile { name: string; format: string; label: string; rows: number; copies: number; resolved: number; unresolved: CountNameRow[]; errors: { line: number; text: string; reason: string }[]; skippedLines: string[]; commander: CommanderInference; existing: SourceRecord | null }
export interface ImportRequest { files?: ImportFile[]; bundled?: boolean; preview?: boolean; asDecks?: boolean; format?: string; mode?: 'replace' | 'merge'; commanders?: Record<string, string | null> }
export interface ImportResponse { previews?: ImportPreviewFile[]; results?: (ImportResult & { errors: { line: number; text: string; reason: string }[]; skippedLines: string[]; deck: DeckRecord | null })[]; version: number; summary: CollectionSummary }

export const collectionApi = {
  list: (q?: string, signal?: AbortSignal) => send<CollectionList>(`/api/collection${q ? `?q=${encodeURIComponent(q)}` : ''}`, {}, signal),
  stats: (signal?: AbortSignal) => send<CollectionStats>('/api/collection/stats', {}, signal),
  import: (body: ImportRequest, signal?: AbortSignal) => send<ImportResponse>('/api/collection/import', { method: 'POST', body: JSON.stringify(body) }, signal),
  upsert: (oracleId: string, delta: number) => send<{ owned: OwnedEntry | null; version: number }>('/api/collection/cards', { method: 'POST', body: JSON.stringify({ oracleId, delta }) }),
  detail: (oracleId: string, signal?: AbortSignal) => send<OwnedDetail | null>(`/api/collection/cards/${encodeURIComponent(oracleId)}`, {}, signal),
  removeSource: (id: string, deleteDeck = false) => send<{ ok: boolean; version: number }>(`/api/collection/sources/${encodeURIComponent(id)}${deleteDeck ? '?deck=1' : ''}`, { method: 'DELETE' }),
  coverage: (deckId: string, signal?: AbortSignal) => send<CoverageReport & { deck: { id: string; name: string } }>(`/api/collection/coverage/${encodeURIComponent(deckId)}`, {}, signal),
  exportUrl: (fmt: 'csv' | 'arena') => `/api/collection/export?fmt=${fmt}`,
};
