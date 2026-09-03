'use client';
// Segmented toggle between the finishes a printing was produced in (nonfoil / foil / etched).
import clsx from 'clsx';
import type { FinishName } from './Card3D';
import styles from './FinishToggle.module.css';

const ORDER: FinishName[] = ['nonfoil', 'foil', 'etched'];
const LABELS: Record<FinishName, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };

export interface FinishToggleProps {
  /** Finishes the printing exists in; unknown finishes are ignored. Defaults to all three. */
  finishes?: readonly string[] | null;
  value: FinishName;
  onChange: (finish: FinishName) => void;
  /** Show every finish even if the printing lacks it (dev tuning). */
  showAll?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
}

export function FinishToggle({ finishes, value, onChange, showAll, size = 'md', className, 'aria-label': ariaLabel = 'Finish' }: FinishToggleProps) {
  const available = showAll || !finishes?.length ? ORDER : ORDER.filter(f => finishes.includes(f));
  if (available.length < 2 && !showAll) return null;
  return (
    <div role="group" aria-label={ariaLabel} className={clsx(styles.group, size === 'sm' && styles.sm, className)}>
      {available.map(f => (
        <button
          key={f}
          type="button"
          className={clsx(styles.btn, styles[f], value === f && styles.active)}
          aria-pressed={value === f}
          onClick={() => onChange(f)}
        >
          <span className={styles.swatch} aria-hidden="true" />
          {LABELS[f]}
        </button>
      ))}
    </div>
  );
}
