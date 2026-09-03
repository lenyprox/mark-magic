'use client';
// A number that rolls from its previous value to the new one (320 ms); under reduced motion it simply swaps.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useReducedMotion } from '@/lib/hooks/useReducedMotion';
import styles from './table.module.css';

export function NumberRoll({ value, className, duration = 320 }: { value: number; className?: string; duration?: number }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current; prev.current = value;
    if (from === value) return;
    setDir(value > from ? 'up' : 'down');
    if (reduced) { setShown(value); return; }
    const t0 = performance.now(); let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / duration); const e = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(from + (value - from) * e));
      if (k < 1) raf = requestAnimationFrame(tick); else setDir(null);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, duration]);
  return <span className={clsx(styles.roll, className)} data-dir={dir ?? undefined}>{shown}</span>;
}
