'use client';
// The owned map (oracle id -> copies) for surfaces that are not fed by /api/cards: deck rows, hover previews, callouts.
// One fetch per session; invalidate after imports/upserts with useInvalidateCollection().
import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { collectionApi, type CollectionSummary } from './api';

export const COLLECTION_KEY = ['collection'] as const;

export interface CollectionHandle {
  owned: Map<string, number>;
  version: number;
  summary: CollectionSummary | null;
  ready: boolean;
  /** No collection registered yet (or not loaded): callers hide ownership hints. */
  empty: boolean;
  isOwned: (oracleId: string) => number;
}

export function useCollection(): CollectionHandle {
  const q = useQuery({ queryKey: COLLECTION_KEY, queryFn: ({ signal }) => collectionApi.list(undefined, signal), staleTime: 60_000, retry: 1 });
  const owned = useMemo(() => new Map((q.data?.cards ?? []).map(c => [c.oracleId, c.count] as const)), [q.data]);
  const isOwned = useCallback((id: string) => owned.get(id) ?? 0, [owned]);
  return { owned, version: q.data?.version ?? 0, summary: q.data?.summary ?? null, ready: q.isSuccess, empty: !q.data || q.data.summary.distinct === 0, isOwned };
}

/** Everything that shows ownership re-fetches: the collection itself, card searches, card details, coverage. */
export function useInvalidateCollection(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: COLLECTION_KEY }),
      qc.invalidateQueries({ queryKey: ['collection-stats'] }),
      qc.invalidateQueries({ queryKey: ['collection-detail'] }),
      qc.invalidateQueries({ queryKey: ['collection-coverage'] }),
      qc.invalidateQueries({ queryKey: ['cards'] }),
      qc.invalidateQueries({ queryKey: ['picker'] }),
      qc.invalidateQueries({ queryKey: ['card'] }),
      qc.invalidateQueries({ queryKey: ['decks'] }),
    ]);
  }, [qc]);
}
