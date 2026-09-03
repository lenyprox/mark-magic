'use client';
import { type ReactNode, useRef } from 'react';
import clsx from 'clsx';
import styles from './controls.module.css';

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; title?: string; icon?: ReactNode }
export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** Radio-group semantics with arrow-key movement, styled as a single control. */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md', className }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const i = options.findIndex(o => o.value === value);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onChange(options[(i + 1) % options.length].value); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onChange(options[(i - 1 + options.length) % options.length].value); }
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={clsx(styles.segmented, size === 'sm' && styles.sm, className)} onKeyDown={onKey}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} title={o.title} className={styles.seg} onClick={() => onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
