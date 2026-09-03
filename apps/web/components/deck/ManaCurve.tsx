'use client';
import { useId, useMemo } from 'react';
import { manaCurve, type Entry } from '@/lib/deck/stats';
import styles from './deck.module.css';

const W = 320, H = 130, PAD_L = 8, PAD_B = 22, PAD_T = 18, GAP = 6;

/** Bars per mana value 0–7+, on the odds gradient so the tallest bar reads brightest. */
export function ManaCurve({ entries }: { entries: Entry[] }) {
  const id = useId();
  const curve = useMemo(() => manaCurve(entries), [entries]);
  const max = Math.max(1, ...curve);
  const total = curve.reduce((a, b) => a + b, 0);
  const bw = (W - PAD_L * 2 - GAP * 7) / 8;
  const label = `Mana curve: ${curve.map((n, i) => `${i === 7 ? '7+' : i}: ${n}`).join(', ')}`;
  return (
    <figure className={styles.chart}>
      <figcaption className={styles.chartTitle}>Mana curve <span className="faint">{total ? `${total} spells` : ''}</span></figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.curveSvg} role="img" aria-label={label}>
        <title>{label}</title>
        <defs>
          <linearGradient id={`${id}-g`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" style={{ stopColor: 'var(--odds-0)' }} />
            <stop offset="0.55" style={{ stopColor: 'var(--odds-1)' }} />
            <stop offset="1" style={{ stopColor: 'var(--odds-2)' }} />
          </linearGradient>
        </defs>
        <line x1={PAD_L} x2={W - PAD_L} y1={H - PAD_B + 0.5} y2={H - PAD_B + 0.5} className={styles.axis} />
        {curve.map((n, i) => {
          const h = n ? Math.max(3, (n / max) * (H - PAD_B - PAD_T)) : 0;
          const x = PAD_L + i * (bw + GAP);
          const y = H - PAD_B - h;
          return (
            <g key={i}>
              {n > 0 && <rect x={x} y={y} width={bw} height={h} rx={3} fill={`url(#${id}-g)`} opacity={0.35 + 0.65 * (n / max)} />}
              {n === 0 && <rect x={x} y={H - PAD_B - 2} width={bw} height={2} rx={1} className={styles.barEmpty} />}
              {n > 0 && <text x={x + bw / 2} y={y - 5} textAnchor="middle" className={styles.barValue}>{n}</text>}
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className={styles.axisLabel}>{i === 7 ? '7+' : i}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
