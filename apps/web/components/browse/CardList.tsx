'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { CardSummary } from '@cards/query';
import { imgUrl } from '@/lib/img';
import { ManaCost } from '@/components/text/ManaSymbol';
import { SetIcon } from '@/components/text/SetIcon';
import { Skeleton } from '@/components/ui/Display';
import { formatPrice } from '@/lib/text/format';
import styles from './browse.module.css';

const ROW_H = 62;

export interface CardListProps { items: CardSummary[]; total: number; hasMore: boolean; fetchingMore: boolean; onLoadMore: () => void; cardHref: (c: CardSummary) => string }

export function CardList({ items, total, hasMore, fetchingMore, onLoadMore, cardHref }: CardListProps) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focus, setFocus] = useState(0);
  useLayoutEffect(() => { const el = wrap.current; if (el) setScrollMargin(el.getBoundingClientRect().top + window.scrollY); }, []);
  const count = Math.min(total, items.length + (hasMore ? 10 : 0));
  const virt = useWindowVirtualizer({ count, estimateSize: () => ROW_H, overscan: 12, scrollMargin, getItemKey: (i) => i });
  const rows = virt.getVirtualItems();
  const lastIdx = rows.length ? rows[rows.length - 1].index : 0;
  useEffect(() => { if (hasMore && !fetchingMore && lastIdx + 8 >= items.length) onLoadMore(); }, [lastIdx, items.length, hasMore, fetchingMore, onLoadMore]);
  const focusRow = useCallback((i: number) => {
    const idx = Math.max(0, Math.min(items.length - 1, i)); setFocus(idx);
    const el = wrap.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); return; }
    virt.scrollToIndex(idx, { align: 'auto' });
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.focus());
  }, [items.length, virt]);
  const onKey = (e: React.KeyboardEvent) => {
    const idx = Number((e.target as HTMLElement).dataset.idx ?? focus);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(0); }
    else if (e.key === 'End') { e.preventDefault(); focusRow(items.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = items[idx]; if (c) e.shiftKey ? window.location.assign(cardHref(c)) : router.push(cardHref(c)); }
  };
  return (
    <div>
      <div className={styles.listHead} aria-hidden><span /><span>Card</span><span>Type</span><span>Set</span><span>Rarity</span><span style={{ textAlign: 'right' }}>Price</span></div>
      <div ref={wrap} className={styles.list} role="grid" aria-rowcount={total} aria-label="Cards" onKeyDown={onKey} style={{ height: virt.getTotalSize() }}>
        {rows.map(row => {
          const c = items[row.index];
          const style = { transform: `translateY(${row.start - scrollMargin}px)`, height: ROW_H - 4 };
          if (!c) return <div key={row.key} role="row" className={styles.listRow} style={style}><Skeleton width={36} height={50} /><Skeleton kind="text" width="50%" /></div>;
          return (
            <div key={row.key} role="row" aria-rowindex={row.index + 1} style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}>
              <button type="button" role="gridcell" data-idx={row.index} tabIndex={row.index === focus ? 0 : -1} className={styles.listRow} style={style} onFocus={() => setFocus(row.index)}
                onClick={(e) => e.shiftKey ? window.location.assign(cardHref(c)) : router.push(cardHref(c))} aria-label={`${c.name}, ${c.typeLine}, ${c.setName}`}>
                <span className={styles.listThumb}><img src={imgUrl(c.printingId, 'small')} alt="" loading="lazy" decoding="async" /></span>
                <span className={styles.listName}><b>{c.name}</b><ManaCost cost={c.manaCost} size={12} /></span>
                <span className={styles.listType}>{c.typeLine}</span>
                <span className={styles.listSet}><SetIcon code={c.setCode} rarity={c.rarity} size={14} /><span>{c.setCode.toUpperCase()} {c.collectorNumber}</span></span>
                <span className={styles.listRarity}><span className="rarity-dot" data-rarity={c.rarity} />{c.rarity}</span>
                <span className={styles.listPrice}>{formatPrice(c.priceUsd)}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
