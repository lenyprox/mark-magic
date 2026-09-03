'use client';
import { useId } from 'react';
import clsx from 'clsx';
import styles from './controls.module.css';

export interface RangeSliderProps {
  min: number; max: number; step?: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  onCommit?: (v: [number, number]) => void;
  label: string;
  format?: (v: number, edge: 'lo' | 'hi') => string;
  className?: string;
}

/** Dual-thumb slider built from two native range inputs on a shared track (keyboard and screen-reader friendly). */
export function RangeSlider({ min, max, step = 1, value, onChange, onCommit, label, format = (v) => String(v), className }: RangeSliderProps) {
  const id = useId();
  const [lo, hi] = value;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const setLo = (v: number) => onChange([Math.min(v, hi), hi]);
  const setHi = (v: number) => onChange([lo, Math.max(v, lo)]);
  const commit = () => onCommit?.([lo, hi]);
  return (
    <div className={className}>
      <div className={styles.range} role="group" aria-label={label}>
        <div className={styles.rangeTrack}><div className={styles.rangeFill} style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }} /></div>
        <input id={`${id}-lo`} type="range" min={min} max={max} step={step} value={lo} aria-label={`${label} minimum`} aria-valuetext={format(lo, 'lo')}
          onChange={(e) => setLo(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} style={{ zIndex: lo > max - (max - min) * 0.05 ? 3 : 2 }} />
        <input id={`${id}-hi`} type="range" min={min} max={max} step={step} value={hi} aria-label={`${label} maximum`} aria-valuetext={format(hi, 'hi')}
          onChange={(e) => setHi(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} style={{ zIndex: 2 }} />
      </div>
      <div className={clsx(styles.rangeLabels)} aria-hidden>
        <span>{format(lo, 'lo')}</span><span>{format(hi, 'hi')}</span>
      </div>
    </div>
  );
}
