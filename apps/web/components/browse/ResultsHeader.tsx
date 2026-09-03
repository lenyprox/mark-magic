'use client';
import { useEffect, useRef, useState } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import { useReducedMotion } from '@/lib/hooks/useReducedMotion';
import { useBrowsePrefs, type GridDensity, type ViewMode } from '@/lib/stores/ui';
import { Segmented } from '@/components/ui/Segmented';
import { formatCount } from '@/lib/text/format';
import styles from './browse.module.css';

/** Tweens the displayed count toward the real one; instant under reduced motion. */
function useRollingNumber(target: number, ms = 480): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduced || Math.abs(target - from.current) < 2) { from.current = target; setShown(target); return; }
    const start = performance.now(); const a = from.current; let raf = 0;
    const tick = (t: number) => { const p = Math.min(1, (t - start) / ms); const e = 1 - Math.pow(1 - p, 3); setShown(Math.round(a + (target - a) * e)); if (p < 1) raf = requestAnimationFrame(tick); else from.current = target; };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, reduced]);
  return shown;
}

export interface ResultsHeaderProps {
  total: number | null;
  fetching: boolean;
  mode: 'oracle' | 'printing';
  onModeChange?: (m: 'oracle' | 'printing') => void;
  hideMode?: boolean;
  leading?: React.ReactNode;
}

export function ResultsHeader({ total, fetching, mode, onModeChange, hideMode, leading }: ResultsHeaderProps) {
  const { view, density, setView, setDensity } = useBrowsePrefs();
  const n = useRollingNumber(total ?? 0);
  const noun = mode === 'printing' ? 'printings' : 'cards';
  return (
    <div className={styles.header}>
      {leading}
      <div className={styles.count} aria-live="polite" aria-atomic="true">
        {total == null ? <span className={styles.countLabel}>Counting…</span> : (
          <><span className={styles.countNum}>{formatCount(n)}</span><span className={styles.countLabel}>{noun}</span></>
        )}
        {fetching && total != null && <span className={styles.countSub}>updating</span>}
      </div>
      <div className={styles.headerSpacer} />
      <div className={styles.headerControls}>
        {!hideMode && onModeChange && (
          <Segmented<'oracle' | 'printing'> size="sm" label="Show" value={mode} onChange={onModeChange} className={styles.modeToggle} options={[{ value: 'oracle', label: 'Distinct cards' }, { value: 'printing', label: 'All printings' }]} />
        )}
        <Segmented<GridDensity> size="sm" label="Card size" value={density} onChange={setDensity} options={[{ value: 's', label: 'S', title: 'Small cards' }, { value: 'm', label: 'M', title: 'Medium cards' }, { value: 'l', label: 'L', title: 'Large cards' }]} />
        <Segmented<ViewMode> size="sm" label="Layout" value={view} onChange={setView} options={[{ value: 'grid', label: <LayoutGrid />, title: 'Grid' }, { value: 'list', label: <List />, title: 'List' }]} />
      </div>
    </div>
  );
}
