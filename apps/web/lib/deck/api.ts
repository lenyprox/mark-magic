// Client fetch helpers for the deck and metagame routes. Mirrors lib/api.ts: JSON in, JSON out, ApiError on failure.
import type { DeckCard, DeckInput, DeckRecord, DeckRole, DeckSummary } from '@user/decks';
import type { ArchetypeSummary, DecklistRecord, SyncReport } from '@meta/types';
import { ApiError } from '@/lib/api';

async function send<T>(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { ...init, signal, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  if (!res.ok) {
    let msg = res.statusText;
    let body: { error?: string } | null = null;
    try { body = await res.json(); if (body?.error) msg = String(body.error); } catch { /* ignore */ }
    throw new ApiError(res.status, msg || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface ImportPreview { name: string; format: string; cards: DeckCard[]; missing: string[]; unknownLines: string[]; mainCount: number; sideCount: number; deck?: DeckRecord }
export interface ImportBody { text: string; name?: string; format?: string; role?: DeckRole; save?: boolean; source?: string; sourceRef?: string }
export interface MetaSnapshot {
  format: string; configured: boolean; goldfishEnabled: boolean;
  lastRefresh: { finishedAt: string; ok: boolean; message: string } | null;
  archetypes: ArchetypeSummary[]; decklists: DecklistRecord[];
}
export type SyncResult = SyncReport & { configured: boolean; archetypes: number };

export const deckApi = {
  list: (role?: DeckRole, signal?: AbortSignal) => send<DeckSummary[]>(`/api/decks${role ? `?role=${role}` : ''}`, {}, signal),
  get: (id: string, signal?: AbortSignal) => send<DeckRecord>(`/api/decks/${encodeURIComponent(id)}`, {}, signal),
  create: (input: DeckInput) => send<DeckRecord>('/api/decks', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: Partial<DeckInput>, signal?: AbortSignal) => send<DeckRecord>(`/api/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }, signal),
  remove: (id: string) => send<{ ok: boolean }>(`/api/decks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importText: (body: ImportBody, signal?: AbortSignal) => send<ImportPreview>('/api/decks/import', { method: 'POST', body: JSON.stringify(body) }, signal),
  exportText: async (id: string, fmt: 'plain' | 'arena') => {
    const res = await fetch(`/api/decks/${encodeURIComponent(id)}/export?fmt=${fmt}`);
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.text();
  },
  meta: (format: string, signal?: AbortSignal) => send<MetaSnapshot>(`/api/meta/${encodeURIComponent(format)}?limit=120`, {}, signal),
  sync: (format: string, opts: { days?: number; force?: boolean } = {}) => send<SyncResult>('/api/meta/sync', { method: 'POST', body: JSON.stringify({ format, ...opts }) }),
  sampleArchetype: (id: string, seed?: number) => send<{ deck: DeckRecord; sourceDecklistId: string; seed: number; missing: string[] }>(`/api/meta/archetypes/${encodeURIComponent(id)}/sample`, { method: 'POST', body: JSON.stringify(seed != null ? { seed } : {}) }),
  importDecklist: (id: string) => send<{ deck: DeckRecord; missing: string[] }>(`/api/meta/decklists/${encodeURIComponent(id)}/import`, { method: 'POST' }),
};

/** Duplicate on the client: fetch the record, then POST a copy (the store's duplicate() has no route of its own). */
export async function duplicateDeck(id: string, overrides: Partial<DeckInput> = {}): Promise<DeckRecord> {
  const d = await deckApi.get(id);
  return deckApi.create({ name: overrides.name ?? `${d.name} (copy)`, format: d.format, role: d.role, source: d.source, sourceRef: d.sourceRef, archetype: d.archetype, notes: d.notes, coverPrintingId: d.coverPrintingId, cards: d.cards, ...overrides });
}
