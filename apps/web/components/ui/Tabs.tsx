'use client';
import { type ReactNode, useId } from 'react';
import clsx from 'clsx';
import styles from './controls.module.css';

export interface TabItem<T extends string> { value: T; label: ReactNode; count?: number }
export interface TabsProps<T extends string> {
  value: T; onChange: (v: T) => void; items: TabItem<T>[]; label: string; className?: string;
  /** Set when the caller renders matching `<id>-panel-<value>` panels: only then is `aria-controls` valid. */
  idBase?: string;
}

export function Tabs<T extends string>({ value, onChange, items, label, className, idBase }: TabsProps<T>) {
  const auto = useId();
  const id = idBase ?? auto;
  const onKey = (e: React.KeyboardEvent) => {
    const i = items.findIndex(t => t.value === value);
    if (e.key === 'ArrowRight') { e.preventDefault(); onChange(items[(i + 1) % items.length].value); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(items[(i - 1 + items.length) % items.length].value); }
  };
  return (
    <div role="tablist" aria-label={label} className={clsx(styles.tabs, className)} onKeyDown={onKey}>
      {items.map(t => (
        <button key={t.value} type="button" role="tab" id={`${id}-tab-${t.value}`} aria-selected={t.value === value} aria-controls={idBase && t.value === value ? `${id}-panel-${t.value}` : undefined} tabIndex={t.value === value ? 0 : -1} className={styles.tab} onClick={() => onChange(t.value)}>
          {t.label}{t.count != null && <span className={styles.tabCount}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
