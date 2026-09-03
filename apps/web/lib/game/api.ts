'use client';
// Client fetch helpers for the play flow (deck payloads, bundled decks, saving games).
import type { DeckPayload } from '@play/protocol';
import type { DeckList } from '@cards/db';
import type { DeckSummary, GameRecordInput } from '@user/decks';

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
  return res.json() as Promise<T>;
}

export interface BundledDeck { file: string; name: string; count: number }

export const fetchBundledDecks = () => fetch('/api/decks/adhoc/defs').then(r => j<BundledDeck[]>(r));
export const fetchDecks = (role?: 'mine' | 'opponent') => fetch(`/api/decks${role ? `?role=${role}` : ''}`).then(r => j<DeckSummary[]>(r));
export const fetchDeckPayload = (deckId: string) => fetch(`/api/decks/${deckId}/defs`).then(r => j<DeckPayload>(r));
export const fetchAdhocPayload = (body: { bundled?: string; text?: string; list?: DeckList; name?: string }) =>
  fetch('/api/decks/adhoc/defs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => j<DeckPayload>(r));
export const saveGame = (g: GameRecordInput) => fetch('/api/games', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(g) }).then(r => j<{ id: string }>(r));

/** A deck reference as chosen in the play setup: a saved deck id, a bundled file, or a metagame archetype. */
export type DeckRef = { kind: 'saved'; id: string; name: string } | { kind: 'bundled'; file: string; name: string } | { kind: 'archetype'; id: string; name: string; format: string };

export async function payloadFor(ref: DeckRef, seed: number): Promise<DeckPayload> {
  if (ref.kind === 'saved') return fetchDeckPayload(ref.id);
  if (ref.kind === 'bundled') return fetchAdhocPayload({ bundled: ref.file, name: ref.name });
  // archetype: ask the meta layer to sample a concrete list (deterministic per seed), saved as an opponent deck
  const res = await fetch(`/api/meta/archetypes/${ref.id}/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seed }) });
  const deck = await j<{ id: string }>(res);
  return fetchDeckPayload(deck.id);
}

/** Deterministic game id from the inputs so a game can be reproduced from its URL. */
export function makeGameId(seed: number, a: DeckRef, b: DeckRef): string {
  const key = (r: DeckRef) => r.kind === 'saved' ? `s.${r.id}` : r.kind === 'bundled' ? `b.${r.file}` : `a.${r.id}`;
  return `${seed}~${encodeURIComponent(key(a))}~${encodeURIComponent(key(b))}`;
}
export function parseGameId(id: string): { seed: number; a: string; b: string } | null {
  const m = id.split('~'); if (m.length !== 3) return null;
  const seed = Number(m[0]); if (!Number.isFinite(seed)) return null;
  return { seed, a: decodeURIComponent(m[1]), b: decodeURIComponent(m[2]) };
}
