'use client';
// Landing search: a combobox over /api/autocomplete. Enter with no pick runs a full-text search on /cards.
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { autoUpdate, FloatingPortal, offset, size, useFloating } from '@floating-ui/react';
import { api } from '@/lib/api';
import { imgUrl } from '@/lib/img';
import { useDebouncedValue } from '@/lib/hooks/useDebounced';
import { SearchInput } from '@/components/ui/Input';
import { Kbd } from '@/components/ui/Display';
import { ManaCost } from '@/components/text/ManaSymbol';
import styles from './home.module.css';

export function QuickSearch() {
  const router = useRouter();
  const id = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const dq = useDebouncedValue(q, 120);
  const input = useRef<HTMLInputElement>(null);
  const hits = useQuery({ queryKey: ['autocomplete', dq], queryFn: ({ signal }) => api.autocomplete(dq, 7, signal), enabled: dq.trim().length >= 2, staleTime: 5 * 60_000 });
  const items = dq.trim().length >= 2 ? (hits.data ?? []) : [];
  const { refs, floatingStyles } = useFloating({ open, placement: 'bottom-start', whileElementsMounted: autoUpdate, middleware: [offset(6), size({ apply({ rects, elements }) { elements.floating.style.width = `${rects.reference.width}px`; } })] });
  useEffect(() => { setActive(-1); }, [dq]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const submit = () => { const t = q.trim(); if (!t) return; setOpen(false); router.push(`/cards?q=${encodeURIComponent(t)}`); };
  const pick = (i: number) => { const h = items[i]; if (!h) return submit(); setOpen(false); router.push(`/cards/${h.oracleId}`); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(-1, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); active >= 0 ? pick(active) : submit(); }
    else if (e.key === 'Escape') { setOpen(false); }
  };
  const showList = open && (items.length > 0 || (dq.trim().length >= 2 && !hits.isFetching));
  return (
    <div ref={refs.setReference} className={styles.quick}>
      <SearchInput ref={input} value={q} onChange={(v) => { setQ(v); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown}
        placeholder="Search any card, or rules text with o:" aria-label="Search cards" role="combobox" aria-expanded={showList} aria-controls={`${id}-list`} aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined} aria-autocomplete="list"
        trailing={<span className={styles.quickKbd} aria-hidden><Kbd>/</Kbd></span>} />
      {showList && (
        <FloatingPortal>
          <ul ref={refs.setFloating} style={floatingStyles} id={`${id}-list`} role="listbox" className={styles.quickList}>
            {items.length === 0 && <li className={styles.quickEmpty}>No card is named that. Press Enter to search rules text.</li>}
            {items.map((h, i) => (
              <li key={h.oracleId} id={`${id}-opt-${i}`} role="option" aria-selected={i === active} className={styles.quickItem} data-active={i === active || undefined}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setActive(i)}>
                <img src={imgUrl(h.printingId, 'small')} alt="" className={styles.quickThumb} loading="lazy" />
                <span className={styles.quickName}>{h.name}</span>
                <span className={styles.quickType}>{h.typeLine}</span>
                <ManaCost cost={h.manaCost} size={13} />
              </li>
            ))}
            <li className={styles.quickFoot}><Kbd>Enter</Kbd> search everything for “{q.trim()}”</li>
          </ul>
        </FloatingPortal>
      )}
    </div>
  );
}
