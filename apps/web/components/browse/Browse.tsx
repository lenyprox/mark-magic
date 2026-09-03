'use client';
// Orchestrates the browse page: URL filter state (nuqs) → CardQuery → useInfiniteQuery over /api/cards.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useQueryStates } from 'nuqs';
import { SlidersHorizontal } from 'lucide-react';
import type { CardQuery, CardSummary } from '@cards/query';
import { api, cardsKey, type CardPage } from '@/lib/api';
import { activeFilterCount, searchParsers, toCardQuery, type SearchState } from '@/lib/search/params';
import { useBrowsePrefs } from '@/lib/stores/ui';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { Callout, EmptyState } from '@/components/ui/Display';
import { FilterRail, type Patch } from './FilterRail';
import { ResultsHeader } from './ResultsHeader';
import { CardGrid } from './CardGrid';
import { CardList } from './CardList';
import styles from './browse.module.css';

export interface BrowseProps {
  /** First page rendered on the server for the initial URL. */
  initial?: CardPage | null;
  /** Fixed query fields (e.g. the set page). Hidden from the rail and merged into every request. */
  lock?: Partial<CardQuery>;
  lockedKeys?: (keyof SearchState)[];
  cardHref?: (c: CardSummary) => string;
}

export function Browse({ initial, lock, lockedKeys = [], cardHref }: BrowseProps) {
  const [state, setState] = useQueryStates(searchParsers, { shallow: true, history: 'replace' });
  const query = useMemo<CardQuery>(() => ({ ...toCardQuery(state), ...lock }), [state, lock]);
  const key = useMemo(() => cardsKey(query), [query]);
  const initialKey = useRef(initial ? JSON.stringify(cardsKey({ ...initial.query, ...lock })) : null);
  const mobile = useIsMobile();
  const [sheet, setSheet] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { view, density } = useBrowsePrefs();

  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => api.cards({ ...query, page: pageParam }, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    initialData: initial && JSON.stringify(key) === initialKey.current ? { pages: [initial], pageParams: [1] } : undefined,
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
  const items = useMemo(() => q.data?.pages.flatMap(p => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? null;
  const onChange = useCallback((patch: Patch) => { setState(patch); }, [setState]);
  const loadMore = useCallback(() => { if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage(); }, [q]);
  const href = useCallback((c: CardSummary) => cardHref ? cardHref(c) : `/cards/${c.oracleId}${state.mode === 'printing' ? `?p=${c.printingId}` : ''}`, [cardHref, state.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)) {
        e.preventDefault();
        if (mobile) setSheet(true); else searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [mobile]);

  const rail = <FilterRail state={state} onChange={onChange} locked={lockedKeys} searchRef={searchRef} />;
  const active = activeFilterCount(state);
  const isEmpty = q.isSuccess && items.length === 0;

  return (
    <div className={styles.layout}>
      <aside className={styles.rail} aria-label="Filters">{rail}</aside>
      <div className={styles.main}>
        <ResultsHeader total={total} fetching={q.isFetching && !q.isFetchingNextPage} mode={state.mode} hideMode={lockedKeys.includes('mode')} onModeChange={(mode) => onChange({ mode, sort: null, dir: null })}
          leading={<div className={styles.mobileBar}><Button size="sm" icon={<SlidersHorizontal />} onClick={() => setSheet(true)} aria-haspopup="dialog">Filters{active > 0 && ` (${active})`}</Button></div>} />
        {q.isError && <Callout variant="danger" title="The search failed">{(q.error as Error).message}. Check that the dev server is running and the index is built.</Callout>}
        {isEmpty ? (
          <EmptyState title="No cards match" actions={active > 0 ? <Button size="sm" onClick={() => onChange({ q: '', c: [], colorless: false, cm: 'any', t: [], st: [], sup: [], set: lockedKeys.includes('set') ? state.set : '', r: [], f: '', leg: 'legal', mvmin: null, mvmax: null, pmin: null, pmax: null })}>Clear filters</Button> : undefined}>
            Loosen a filter, or search rules text with <b>o:</b> and the type line with <b>t:</b>.
          </EmptyState>
        ) : view === 'list' ? (
          <CardList items={items} total={total ?? items.length} hasMore={!!q.hasNextPage} fetchingMore={q.isFetchingNextPage} onLoadMore={loadMore} cardHref={href} />
        ) : (
          <CardGrid items={items} total={total ?? items.length} density={density} hasMore={!!q.hasNextPage} fetchingMore={q.isFetchingNextPage} onLoadMore={loadMore} cardHref={href} />
        )}
        {!isEmpty && total != null && !q.hasNextPage && items.length > 0 && <div className={styles.foot}>That is every {state.mode === 'printing' ? 'printing' : 'card'} that matches.</div>}
      </div>
      {mobile && (
        <Drawer open={sheet} onClose={() => setSheet(false)} side="bottom" title="Filters">
          <div className={styles.sheetBody}>{rail}</div>
          <div className={styles.sheetActions}><Button variant="primary" block onClick={() => setSheet(false)}>Show {total != null ? total.toLocaleString() : ''} results</Button></div>
        </Drawer>
      )}
    </div>
  );
}
