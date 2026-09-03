'use client';
// One CardDetail per distinct oracle id in the draft, fetched through react-query and kept for the session.
import { useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { CardDetail } from '@cards/query';
import { api } from '@/lib/api';

export interface CardInfo { map: Map<string, CardDetail>; pending: number; ready: boolean }

const combine = (results: UseQueryResult<CardDetail, Error>[]): { list: (CardDetail | undefined)[]; pending: number } => ({
  list: results.map(r => r.data),
  pending: results.filter(r => r.isPending).length,
});

export const cardKey = (oracleId: string) => ['card', oracleId] as const;

export function useCardInfo(oracleIds: string[]): CardInfo {
  const ids = useMemo(() => [...new Set(oracleIds)].sort(), [oracleIds]);
  const { list, pending } = useQueries({
    queries: ids.map(id => ({ queryKey: cardKey(id), queryFn: ({ signal }: { signal?: AbortSignal }) => api.card(id, signal), staleTime: Infinity, gcTime: 30 * 60_000, retry: 1 })),
    combine,
  });
  return useMemo(() => {
    const map = new Map<string, CardDetail>();
    list.forEach((d, i) => { if (d) map.set(ids[i], d); });
    return { map, pending, ready: pending === 0 };
  }, [list, pending, ids]);
}
