'use client';
// Left pane: search (autocomplete on top, full search below), quick filters, and a virtualised list/grid of results.
// Click or Enter adds one copy to the active board; right-click, long-press or Shift+Enter opens the quick-look.
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { autoUpdate, FloatingPortal, offset, size, useFloating } from '@floating-ui/react';
import clsx from 'clsx';
import { LayoutGrid, Library, List, Plus } from 'lucide-react';
import type { CardQuery, CardSummary } from '@cards/query';
import type { Color } from '@cards/types';
import { api, cardsKey, type AutocompleteHit } from '@/lib/api';
import { imgUrl } from '@/lib/img';
import { FORMATS, formatInfo } from '@/lib/deck/formats';
import { useDebouncedValue } from '@/lib/hooks/useDebounced';
import { useCollection } from '@/lib/collection/useCollection';
import { useDeckStore } from '@/lib/stores/deck';
import { toast } from '@/lib/stores/ui';
import { SearchInput } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Segmented } from '@/components/ui/Segmented';
import { Chip, ManaChip } from '@/components/ui/Chip';
import { Callout, EmptyState, Kbd, Skeleton } from '@/components/ui/Display';
import { ManaCost, ManaSymbol } from '@/components/text/ManaSymbol';
import { SetIcon } from '@/components/text/SetIcon';
import { useBuilder } from './context';
import styles from './deck.module.css';
import overlay from '@/components/ui/overlay.module.css';

const BOARD_LABEL: Record<string, string> = { main: 'main deck', side: 'sideboard', maybe: 'maybeboard', commander: 'command zone', companion: 'companion' };
const TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle', 'Land'];
const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
const LIST_H = 56; const GRID_MIN = 118; const GAP = 10;

export interface PickerProps { format: string; onQuickLook: (oracleId: string) => void }

export function Picker({ format, onQuickLook }: PickerProps) {
  const { board } = useBuilder();
  const addCard = useDeckStore(s => s.addCard);
  const cards = useDeckStore(s => s.draft?.cards);
  const inDeck = useMemo(() => { const m = new Map<string, number>(); for (const c of cards ?? []) m.set(c.oracleId, (m.get(c.oracleId) ?? 0) + c.count); return m; }, [cards]);

  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 200);
  const [colors, setColors] = useState<Color[]>([]);
  const [colorless, setColorless] = useState(false);
  const [type, setType] = useState('');
  const fi = formatInfo(format);
  const [legality, setLegality] = useState<string>(fi.legality ?? '');
  useEffect(() => { setLegality(formatInfo(format).legality ?? ''); }, [format]);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const collection = useCollection();

  const query = useMemo<CardQuery>(() => ({
    q: dq.trim() || undefined, colors: colors.length ? colors : undefined, colorMode: colors.length ? 'identity' : undefined, colorless: colorless || undefined,
    types: type ? [type] : undefined, format: legality || undefined, legality: legality ? 'legal' : undefined, owned: ownedOnly || undefined,
    sort: dq.trim() ? 'relevance' : 'edhrec', dir: 'asc', pageSize: 40,
  }), [dq, colors, colorless, type, legality, ownedOnly]);
  const key = useMemo(() => ['picker', ...cardsKey(query)], [query]);
  const results = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => api.cards({ ...query, page: pageParam }, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
  const items = useMemo(() => results.data?.pages.flatMap(p => p.items) ?? [], [results.data]);
  const total = results.data?.pages[0]?.total ?? 0;

  // ---- add / quick-look
  const add = useCallback((c: { oracleId: string; name: string; printingId: string }) => {
    addCard({ oracleId: c.oracleId, name: c.name, printingId: c.printingId }, board);
    const n = (inDeck.get(c.oracleId) ?? 0) + 1;
    toast({ title: `${c.name} added`, body: `${n} in the deck · ${BOARD_LABEL[board] ?? board}`, kind: 'ok', ttl: 1800 });
  }, [addCard, board, inDeck]);

  // ---- autocomplete
  const input = useRef<HTMLInputElement>(null);
  const [acOpen, setAcOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ac = useQuery({ queryKey: ['autocomplete', dq.trim()], queryFn: ({ signal }) => api.autocomplete(dq.trim(), 8, signal), enabled: dq.trim().length >= 2, staleTime: 5 * 60_000 });
  // An exact name match always leads (basics like "Mountain" have no EDHREC rank and would otherwise sort last).
  const hits: AutocompleteHit[] = useMemo(() => {
    if (!acOpen || dq.trim().length < 2 || dq.trim() !== q.trim() || !ac.data) return [];
    const needle = dq.trim().toLowerCase();
    const exact = ac.data.filter(h => h.name.toLowerCase() === needle);
    return exact.length ? [...exact, ...ac.data.filter(h => !exact.includes(h))] : ac.data;
  }, [acOpen, dq, q, ac.data]);
  useEffect(() => { setActive(0); }, [ac.data]);
  const { refs, floatingStyles } = useFloating({ open: hits.length > 0, placement: 'bottom-start', whileElementsMounted: autoUpdate, middleware: [offset(4), size({ apply({ rects, elements }) { elements.floating.style.width = `${rects.reference.width}px`; } })] });
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); setActive(a => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { const h = hits[active]; if (h) { e.preventDefault(); add({ oracleId: h.oracleId, name: h.name, printingId: h.printingId }); setQ(''); setAcOpen(false); } }
    else if (e.key === 'Escape') { if (hits.length) { e.preventDefault(); setAcOpen(false); } else setQ(''); }
  };

  // ---- virtualised results (list or grid)
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(([en]) => setWidth(en.contentRect.width)); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = view === 'grid' ? Math.max(2, Math.floor((width + GAP) / (GRID_MIN + GAP))) : 1;
  const cellW = view === 'grid' && width ? (width - GAP * (cols - 1)) / cols : 0;
  const rowH = view === 'grid' ? cellW * (680 / 488) + 30 + GAP : LIST_H;
  const hasMore = !!results.hasNextPage;
  const rowCount = Math.ceil(Math.min(total || items.length, items.length + (hasMore ? cols * 3 : 0)) / cols);
  const virt = useVirtualizer({ count: rowCount, getScrollElement: () => scroller.current, estimateSize: () => rowH, overscan: 8, getItemKey: (i) => i });
  useEffect(() => { virt.measure(); }, [rowH, virt]);
  const rows = virt.getVirtualItems();
  const lastIdx = rows.length ? rows[rows.length - 1].index : 0;
  useEffect(() => { if (hasMore && !results.isFetchingNextPage && (lastIdx + 3) * cols >= items.length) void results.fetchNextPage(); }, [lastIdx, cols, items.length, hasMore, results]);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [key]);

  const [focus, setFocus] = useState(0);
  const focusCell = useCallback((i: number) => {
    const idx = Math.max(0, Math.min(items.length - 1, i)); setFocus(idx);
    const el = scroller.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); return; }
    virt.scrollToIndex(Math.floor(idx / cols), { align: 'auto' });
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.focus());
  }, [items.length, cols, virt]);
  const onGridKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement; const idx = Number(t.dataset.idx ?? focus); const c = items[idx];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusCell(idx + cols); break;
      case 'ArrowUp': e.preventDefault(); focusCell(idx - cols); break;
      case 'ArrowRight': if (cols > 1) { e.preventDefault(); focusCell(idx + 1); } break;
      case 'ArrowLeft': if (cols > 1) { e.preventDefault(); focusCell(idx - 1); } break;
      case 'Home': e.preventDefault(); focusCell(0); break;
      case 'End': e.preventDefault(); focusCell(items.length - 1); break;
      case 'PageDown': e.preventDefault(); focusCell(idx + cols * 6); break;
      case 'PageUp': e.preventDefault(); focusCell(idx - cols * 6); break;
      case 'Enter': if (c) { e.preventDefault(); if (e.shiftKey) onQuickLook(c.oracleId); else add(c); } break;
      case 'a': case 'A': if (c) { e.preventDefault(); add(c); } break;
      case '/': e.preventDefault(); input.current?.focus(); break;
    }
  };
  // long-press → quick-look
  const press = useRef<{ t: number; id: string } | null>(null);
  const onPointerDown = (c: CardSummary) => (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    press.current = { t: window.setTimeout(() => { press.current = null; onQuickLook(c.oracleId); }, 500), id: c.oracleId };
  };
  const cancelPress = () => { if (press.current) { window.clearTimeout(press.current.t); press.current = null; } };

  const toggleColor = (c: Color) => { setColors(cs => cs.includes(c) ? cs.filter(x => x !== c) : [...cs, c]); setColorless(false); };
  const isEmpty = results.isSuccess && items.length === 0;

  return (
    <div className={styles.picker}>
      <div className={styles.pickerTop}>
        <div ref={refs.setReference}>
          <SearchInput ref={input} value={q} onChange={(v) => { setQ(v); setAcOpen(true); }} onFocus={() => setAcOpen(true)} onBlur={() => setTimeout(() => setAcOpen(false), 120)} onKeyDown={onSearchKey}
            placeholder="Search cards — name, o:text, t:type" aria-label="Search cards to add" role="combobox" aria-expanded={hits.length > 0} aria-autocomplete="list" aria-controls="picker-ac" aria-activedescendant={hits[active] ? `picker-ac-${active}` : undefined}
            trailing={<span className={styles.kbdHint} aria-hidden><Kbd>/</Kbd></span>} />
        </div>
        {hits.length > 0 && (
          <FloatingPortal>
            <div ref={refs.setFloating} style={floatingStyles} className={clsx(overlay.popover, styles.suggest)} id="picker-ac" role="listbox" aria-label="Card name matches">
              {hits.map((h, i) => (
                <div key={h.oracleId} id={`picker-ac-${i}`} role="option" aria-selected={i === active} data-active={i === active || undefined} className={styles.suggestItem}
                  onMouseDown={(e) => { e.preventDefault(); add({ oracleId: h.oracleId, name: h.name, printingId: h.printingId }); setQ(''); setAcOpen(false); }} onMouseEnter={() => setActive(i)}>
                  <span className={styles.suggestThumb}><img src={imgUrl(h.printingId, 'small')} alt="" loading="lazy" /></span>
                  <span className={styles.suggestMeta}><b className="truncate">{h.name}</b><span className="truncate">{h.typeLine}</span></span>
                  <ManaCost cost={h.manaCost} size={12} />
                  {(inDeck.get(h.oracleId) ?? 0) > 0 && <span className={styles.inDeck}>{inDeck.get(h.oracleId)}</span>}
                  <Plus className={styles.suggestPlus} aria-hidden />
                </div>
              ))}
              <div className={styles.suggestHint}><Kbd>↵</Kbd> adds the highlighted card · <Kbd>Esc</Kbd> closes</div>
            </div>
          </FloatingPortal>
        )}
        <div className={styles.filters}>
          <div className={styles.manaRow} role="group" aria-label="Colour identity">
            {COLORS.map(c => <ManaChip key={c} color={c} pressed={colors.includes(c)} label={{ W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[c]} onClick={() => toggleColor(c)}><ManaSymbol sym={c} size={16} /></ManaChip>)}
            <ManaChip color="C" pressed={colorless} label="Colorless only" onClick={() => { setColorless(v => !v); setColors([]); }}><ManaSymbol sym="C" size={16} /></ManaChip>
          </div>
          <Select size="sm" aria-label="Card type" options={TYPES.map(t => ({ value: t, label: t }))} placeholder="Any type" value={type} onChange={(e) => setType(e.target.value)} />
          <Select size="sm" aria-label="Legal in" options={FORMATS.filter(f => f.legality).map(f => ({ value: f.legality!, label: `Legal in ${f.label}` }))} placeholder="Any format" value={legality} onChange={(e) => setLegality(e.target.value)} />
          {!collection.empty && <Chip size="sm" pressed={ownedOnly} onClick={() => setOwnedOnly(v => !v)} icon={<Library size={13} />} title="Only cards in your registered collection" data-testid="picker-owned">Owned</Chip>}
          <Segmented size="sm" label="Results view" value={view} onChange={setView} options={[{ value: 'list', label: <List />, title: 'List' }, { value: 'grid', label: <LayoutGrid />, title: 'Grid' }]} />
        </div>
        <div className={styles.resultCount} aria-live="polite">
          {results.isPending ? 'Searching…' : `${total.toLocaleString()} card${total === 1 ? '' : 's'}`}{results.isFetching && !results.isPending && ' · updating'}
          <span className="faint"> · adds to {BOARD_LABEL[board] ?? board}</span>
        </div>
      </div>

      <div ref={scroller} className={styles.results} role="grid" aria-label="Search results" aria-rowcount={Math.ceil(total / cols)} aria-colcount={cols} onKeyDown={onGridKey}>
        {results.isError && <Callout variant="danger" title="The search failed">{(results.error as Error).message}</Callout>}
        {isEmpty && <EmptyState title="No cards match" className={styles.pickerEmpty}>Loosen a filter, or search rules text with <b>o:</b>.</EmptyState>}
        {!isEmpty && (
          <div className={styles.resultsInner} style={{ height: virt.getTotalSize() }}>
            {rows.map(row => {
              const start = row.index * cols;
              const cells = Array.from({ length: cols }, (_, k) => {
                const i = start + k; const c = items[i];
                if (i >= (total || items.length)) return <div key={k} role="gridcell" aria-hidden />;
                if (!c) return <div key={k} role="gridcell" className={view === 'grid' ? styles.gridCell : undefined}>{view === 'grid' ? <Skeleton kind="card" /> : <div className={styles.listRow}><Skeleton width={30} height={42} /><Skeleton kind="text" width="50%" /></div>}</div>;
                const n = inDeck.get(c.oracleId) ?? 0;
                const common = {
                  'data-idx': i, tabIndex: i === focus ? 0 : -1, onFocus: () => setFocus(i),
                  onClick: (e: React.MouseEvent) => { if (e.shiftKey) onQuickLook(c.oracleId); else add(c); },
                  onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onQuickLook(c.oracleId); },
                  onPointerDown: onPointerDown(c), onPointerUp: cancelPress, onPointerLeave: cancelPress, onPointerMove: cancelPress,
                  'aria-label': `${c.name}, ${c.typeLine}${n ? `, ${n} in deck` : ''}. Add one copy`,
                } as const;
                return view === 'grid' ? (
                  <div key={c.oracleId} role="gridcell" aria-colindex={k + 1} className={styles.gridCell}>
                    <button type="button" className={styles.gridCard} {...common}>
                      <img src={imgUrl(c.printingId, 'normal')} alt="" loading="lazy" decoding="async" draggable={false} />
                      {n > 0 && <span className={styles.gridQty}>{n}</span>}
                      <span className={styles.gridName}>{c.name}</span>
                    </button>
                  </div>
                ) : (
                  <div key={c.oracleId} role="gridcell" className={styles.listCell}>
                    <button type="button" className={styles.listRow} {...common}>
                      <span className={styles.thumb}><img src={imgUrl(c.printingId, 'small')} alt="" loading="lazy" decoding="async" draggable={false} /></span>
                      <span className={styles.rowName}><b className="truncate">{c.name}</b><span className={styles.rowType}>{c.typeLine.split('//')[0].trim()}</span></span>
                      <ManaCost cost={c.manaCost} size={12} className={styles.rowCost} />
                      <span className={styles.rowSet} title={c.setName}><SetIcon code={c.setCode} rarity={c.rarity} size={13} /></span>
                      {!!c.owned && <span className={styles.rowOwned} title={`${c.owned} in your collection`}>×{c.owned}</span>}
                      {n > 0 ? <span className={styles.inDeck} title={`${n} in deck`}>{n}</span> : <span className={styles.rowAdd} aria-hidden><Plus /></span>}
                    </button>
                  </div>
                );
              });
              return (
                <div key={row.key} role="row" aria-rowindex={row.index + 1} className={styles.resultRow} style={{ transform: `translateY(${row.start}px)`, height: row.size - (view === 'grid' ? GAP : 0), gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, '--gap': `${GAP}px` } as CSSProperties}>
                  {cells}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className={styles.pickerFoot} aria-hidden>
        <span><Kbd>↵</Kbd> add</span><span><Kbd>⇧↵</Kbd> or right-click: quick look</span><span><Kbd>]</Kbd> deck</span>
      </div>
    </div>
  );
}
