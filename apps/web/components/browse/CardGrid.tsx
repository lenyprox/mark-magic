'use client';
// Virtualised card grid on the window scroller. Roving tabindex, aria-grid semantics, keyboard navigation.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { RefreshCw } from 'lucide-react';
import type { CardSummary } from '@cards/query';
import { Card3D } from '@/components/card/Card3D';
import { SetIcon } from '@/components/text/SetIcon';
import { Skeleton } from '@/components/ui/Display';
import { cardTransitionName, withViewTransition } from '@/lib/nav/viewTransition';
import { useReducedMotion } from '@/lib/hooks/useReducedMotion';
import { formatPrice } from '@/lib/text/format';
import type { GridDensity } from '@/lib/stores/ui';
import styles from './browse.module.css';

const MIN_W: Record<GridDensity, number> = { s: 132, m: 172, l: 228 };
const GAP = 14;

export interface CardGridProps {
  items: CardSummary[];
  total: number;
  density: GridDensity;
  hasMore: boolean;
  fetchingMore: boolean;
  onLoadMore: () => void;
  cardHref: (c: CardSummary) => string;
}

function useColumns(ref: React.RefObject<HTMLElement | null>, minW: number) {
  const [cols, setCols] = useState(4);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width; setWidth(w);
      setCols(Math.max(2, Math.floor((w + GAP) / (minW + GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, minW]);
  return { cols, width };
}

export function CardGrid({ items, total, density, hasMore, fetchingMore, onLoadMore, cardHref }: CardGridProps) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const { cols, width } = useColumns(wrap, MIN_W[density]);
  const cellW = width ? (width - GAP * (cols - 1)) / cols : MIN_W[density];
  const rowH = cellW * (680 / 488) + GAP;
  const rowCount = Math.ceil(Math.min(total, items.length + (hasMore ? cols * 2 : 0)) / cols);
  const [focus, setFocus] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => { const el = wrap.current; if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY); }, [width]);

  const virt = useWindowVirtualizer({ count: rowCount, estimateSize: () => rowH, overscan: 6, scrollMargin, getItemKey: (i) => i });
  const rows = virt.getVirtualItems();
  useEffect(() => { virt.measure(); }, [rowH, virt]);
  const lastIdx = rows.length ? rows[rows.length - 1].index : 0;
  useEffect(() => {
    if (hasMore && !fetchingMore && (lastIdx + 3) * cols >= items.length) onLoadMore();
  }, [lastIdx, cols, items.length, hasMore, fetchingMore, onLoadMore]);

  // Remember where we left from so Esc out of the quick-look puts focus back on the same cell.
  const pathname = usePathname();
  const leftFrom = useRef<{ path: string; idx: number } | null>(null);
  const open = useCallback((c: CardSummary, full = false) => {
    const href = cardHref(c);
    if (full) { window.location.assign(href); return; }
    leftFrom.current = { path: pathname, idx: focus };
    withViewTransition(() => router.push(href), { reducedMotion: reduced });
  }, [cardHref, router, reduced, pathname, focus]);
  useEffect(() => {
    const l = leftFrom.current;
    if (!l || l.path !== pathname) return;
    leftFrom.current = null;
    // Next's own focus management runs after the route commit; take over once it is done.
    const t = setTimeout(() => {
      if (!wrap.current?.contains(document.activeElement)) wrap.current?.querySelector<HTMLElement>(`[data-idx="${l.idx}"]`)?.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(t);
  }, [pathname]);

  const focusCell = useCallback((i: number) => {
    const idx = Math.max(0, Math.min(items.length - 1, i));
    setFocus(idx);
    // Focus synchronously when the cell is rendered so rapid key presses read the right target; otherwise scroll, then focus.
    const el = wrap.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); return; }
    virt.scrollToIndex(Math.floor(idx / cols), { align: 'auto' });
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.focus());
  }, [items.length, cols, virt]);

  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement; const idx = Number(t.dataset.idx ?? focus);
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); focusCell(idx + 1); break;
      case 'ArrowLeft': e.preventDefault(); focusCell(idx - 1); break;
      case 'ArrowDown': e.preventDefault(); focusCell(idx + cols); break;
      case 'ArrowUp': e.preventDefault(); focusCell(idx - cols); break;
      case 'Home': e.preventDefault(); focusCell(e.ctrlKey ? 0 : idx - (idx % cols)); break;
      case 'End': e.preventDefault(); focusCell(e.ctrlKey ? items.length - 1 : idx - (idx % cols) + cols - 1); break;
      case 'PageDown': e.preventDefault(); focusCell(idx + cols * 3); break;
      case 'PageUp': e.preventDefault(); focusCell(idx - cols * 3); break;
      case 'Enter': { e.preventDefault(); const c = items[idx]; if (c) open(c, e.shiftKey); break; }
      case 'f': case 'F': e.preventDefault(); break; // reserved: flip (renderer slice)
    }
  };

  const rowStyle = useMemo(() => ({ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, '--gap': `${GAP}px` }) as React.CSSProperties, [cols]);

  return (
    <div ref={wrap} className={styles.grid} role="grid" aria-rowcount={Math.ceil(total / cols)} aria-colcount={cols} aria-label="Cards" onKeyDown={onKey} style={{ height: virt.getTotalSize() }}>
      {rows.map(row => {
        const start = row.index * cols;
        return (
          <div key={row.key} role="row" aria-rowindex={row.index + 1} className={styles.row} style={{ ...rowStyle, transform: `translateY(${row.start - scrollMargin}px)`, height: row.size - GAP }}>
            {Array.from({ length: cols }, (_, k) => {
              const i = start + k; const c = items[i];
              if (i >= total) return <div key={k} role="gridcell" aria-hidden />;
              if (!c) return <div key={k} role="gridcell" className={styles.cell}><Skeleton kind="card" className={styles.cellSkeleton} /></div>;
              return (
                <div key={c.printingId} role="gridcell" aria-colindex={k + 1} className={styles.cell}>
                  <button type="button" data-idx={i} tabIndex={i === focus ? 0 : -1} data-focused={i === focus} className={styles.card}
                    aria-label={`${c.name}, ${c.typeLine}, ${c.setName}`} onFocus={() => setFocus(i)}
                    onClick={(e) => open(c, e.shiftKey)} onAuxClick={(e) => { if (e.button === 1) window.open(cardHref(c), '_blank'); }}>
                    <Card3D embedded live="hover" tilt={10} priority={i < cols * 2}
                      printing={{ printingId: c.printingId, name: c.name, layout: c.layout, frame: c.frame, frameEffects: c.frameEffects, finishes: c.finishes, fullArt: c.fullArt, borderColor: c.borderColor, hasBack: c.hasBack }}
                      imgProps={{ style: i === focus ? { viewTransitionName: cardTransitionName(c.printingId) } : undefined, 'data-card-anchor': c.printingId } as React.ImgHTMLAttributes<HTMLImageElement>} />
                    {c.hasBack && <span className={styles.dfcTag} title="Double-faced"><RefreshCw /></span>}
                    <span className={styles.caption} aria-hidden>
                      <span className={styles.capName}>{c.name}</span>
                      <span className={styles.capMeta}><SetIcon code={c.setCode} rarity={c.rarity} size={12} /><span>{c.setCode.toUpperCase()}</span><span className="rarity-dot" data-rarity={c.rarity} /><span className={styles.price}>{formatPrice(c.priceUsd)}</span></span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
