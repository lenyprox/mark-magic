'use client';
import { useMemo } from 'react';
import { COLOR_NAME, COLOR_ORDER, pipCounts, type Entry } from '@/lib/deck/stats';
import { ManaSymbol } from '@/components/text/ManaSymbol';
import styles from './deck.module.css';

const SIZE = 132, R = 56, STROKE = 18;

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0); const [x1, y1] = p(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/** Donut of coloured pips across the main deck's spells, each slice carrying its mana symbol. */
export function ColorPie({ entries }: { entries: Entry[] }) {
  const pips = useMemo(() => pipCounts(entries), [entries]);
  const slices = COLOR_ORDER.filter(c => pips[c] > 0).map(c => ({ c, n: pips[c] }));
  const total = slices.reduce((a, s) => a + s.n, 0);
  const label = total ? `Colour pips: ${slices.map(s => `${COLOR_NAME[s.c]} ${Math.round(s.n / total * 100)}%`).join(', ')}` : 'No coloured pips';
  let angle = -Math.PI / 2;
  const cx = SIZE / 2, cy = SIZE / 2;
  return (
    <figure className={styles.chart}>
      <figcaption className={styles.chartTitle}>Colour pips <span className="faint">{total ? `${Math.round(total)} pips` : ''}</span></figcaption>
      <div className={styles.pieWrap}>
        <div className={styles.pie} style={{ width: SIZE, height: SIZE }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label={label}>
            <title>{label}</title>
            <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--bg-3)" strokeWidth={STROKE} />
            {slices.map(s => {
              const span = (s.n / total) * Math.PI * 2;
              const a0 = angle; const a1 = angle + span; angle = a1;
              if (span >= Math.PI * 2 - 1e-6) return <circle key={s.c} cx={cx} cy={cy} r={R} fill="none" stroke={`var(--mana-${s.c})`} strokeWidth={STROKE} />;
              return <path key={s.c} d={arc(cx, cy, R, a0 + 0.02, a1 - 0.02)} fill="none" stroke={`var(--mana-${s.c})`} strokeWidth={STROKE} strokeLinecap="butt" />;
            })}
          </svg>
          {(() => { let a = -Math.PI / 2; return slices.map(s => { const span = (s.n / total) * Math.PI * 2; const mid = a + span / 2; a += span; if (span < 0.28) return null; return <span key={s.c} className={styles.pieSym} style={{ left: cx + R * Math.cos(mid), top: cy + R * Math.sin(mid) }} aria-hidden><ManaSymbol sym={s.c} size={16} /></span>; }); })()}
          <span className={styles.pieCenter} aria-hidden>{total ? `${slices.length}c` : '—'}</span>
        </div>
        <ul className={styles.pieLegend}>
          {slices.length === 0 && <li className={`faint ${styles.pieEmpty}`}>Add spells to see the split.</li>}
          {slices.map(s => <li key={s.c} className={styles.pieRow}><ManaSymbol sym={s.c} size={13} /><span>{COLOR_NAME[s.c]}</span><span className="mono">{Math.round(s.n * 10) / 10}</span><span className="mono faint">{Math.round(s.n / total * 100)}%</span></li>)}
        </ul>
      </div>
    </figure>
  );
}
