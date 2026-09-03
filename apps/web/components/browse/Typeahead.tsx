'use client';
// Small combobox used by the filter rail: type to filter a vocabulary, pick one to add it.
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { autoUpdate, FloatingPortal, offset, size, useFloating } from '@floating-ui/react';
import { useDebouncedValue } from '@/lib/hooks/useDebounced';
import { SearchInput } from '@/components/ui/Input';
import styles from './browse.module.css';
import overlay from '@/components/ui/overlay.module.css';

export interface TypeaheadItem { value: string; label: string; code?: string; icon?: ReactNode }
export interface TypeaheadProps {
  placeholder: string;
  label: string;
  /** Resolve suggestions for a (debounced) query. */
  fetchItems: (q: string) => Promise<TypeaheadItem[]>;
  onPick: (item: TypeaheadItem) => void;
  /** Allow Enter on free text. */
  allowFree?: boolean;
  size?: 'sm' | 'md';
}

export function Typeahead({ placeholder, label, fetchItems, onPick, allowFree, size: sz = 'sm' }: TypeaheadProps) {
  const id = useId();
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 120);
  const [items, setItems] = useState<TypeaheadItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { refs, floatingStyles } = useFloating({ open, placement: 'bottom-start', whileElementsMounted: autoUpdate, middleware: [offset(4), size({ apply({ rects, elements }) { elements.floating.style.width = `${rects.reference.width}px`; } })] });
  useEffect(() => {
    let alive = true;
    fetchItems(dq).then(r => { if (alive) { setItems(r); setActive(0); } }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [dq, fetchItems]);
  const pick = (it: TypeaheadItem | undefined) => {
    if (!it) { if (allowFree && q.trim()) onPick({ value: q.trim(), label: q.trim() }); else return; }
    else onPick(it);
    setQ(''); setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };
  const show = open && (items.length > 0 || dq.trim().length > 0);
  return (
    <div ref={refs.setReference}>
      <SearchInput ref={input} size={sz} value={q} onChange={(v) => { setQ(v); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKey}
        placeholder={placeholder} aria-label={label} role="combobox" aria-expanded={show} aria-controls={`${id}-l`} aria-autocomplete="list" aria-activedescendant={show && items[active] ? `${id}-${active}` : undefined} />
      {show && (
        <FloatingPortal>
          <div ref={refs.setFloating} style={floatingStyles} className={overlay.popover} id={`${id}-l`} role="listbox">
            <div className={styles.taList}>
              {items.length === 0 && <div className={styles.taEmpty}>{allowFree ? 'Press Enter to use it as typed.' : 'Nothing matches.'}</div>}
              {items.map((it, i) => (
                <div key={it.value} id={`${id}-${i}`} role="option" aria-selected={i === active} data-active={i === active || undefined} className={styles.taItem} onMouseDown={(e) => { e.preventDefault(); pick(it); }} onMouseEnter={() => setActive(i)}>
                  {it.icon}<span className="truncate">{it.label}</span>{it.code && <span className={styles.taCode}>{it.code}</span>}
                </div>
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
