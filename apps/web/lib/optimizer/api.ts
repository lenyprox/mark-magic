// Client fetch helpers for the optimiser routes.
import type { DeckRecord } from '@user/decks';
import type { FieldEntry, OptimizerRun, PRESETS, StoredGame } from '@optimizer/types';
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

export type Preset = keyof typeof PRESETS;
export interface CreateRunRequest {
  deckId: string; name?: string; preset: Preset; field: FieldEntry[]; players: 2 | 3 | 4;
  pool: 'owned' | 'owned+bulk'; maxUnowned: number; seed?: number;
  lockIn?: string[]; ban?: string[]; lands?: number | null; onlyFullyParsedSwapIns?: boolean;
  games?: number; iterations?: number; workers?: number;
}
export interface RunListItem extends OptimizerRun { stale: boolean; deckName: string | null }
export interface RunDetail { run: OptimizerRun; stale: boolean; log: string[]; deckName: string | null }

export const optimizerApi = {
  list: (signal?: AbortSignal) => send<{ runs: RunListItem[] }>('/api/optimizer/runs', {}, signal),
  create: (body: CreateRunRequest) => send<{ run: OptimizerRun; pid: number | null }>('/api/optimizer/runs', { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string, signal?: AbortSignal) => send<RunDetail>(`/api/optimizer/runs/${encodeURIComponent(id)}`, {}, signal),
  remove: (id: string) => send<{ ok: boolean }>(`/api/optimizer/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  cancel: (id: string) => send<{ run: OptimizerRun }>(`/api/optimizer/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  resume: (id: string) => send<{ run: OptimizerRun; pid: number | null }>(`/api/optimizer/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  apply: (id: string, body: { mode: 'update' | 'new'; name?: string }) => send<{ deck: DeckRecord }>(`/api/optimizer/runs/${encodeURIComponent(id)}/apply`, { method: 'POST', body: JSON.stringify(body) }),
  games: (id: string, candidateId?: string, signal?: AbortSignal) => send<{ games: StoredGame[] }>(`/api/optimizer/runs/${encodeURIComponent(id)}/games${candidateId ? `?candidate=${encodeURIComponent(candidateId)}` : ''}`, {}, signal),
  bulkUrl: (id: string) => `/api/optimizer/runs/${encodeURIComponent(id)}/bulk`,
};
