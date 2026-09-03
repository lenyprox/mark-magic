'use client';
import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import styles from './controls.module.css';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onToggle'> {
  /** Controlled pressed state; renders as aria-pressed toggle. */
  pressed?: boolean;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  onRemove?: () => void;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip({ pressed, size = 'md', icon, onRemove, className, children, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} aria-pressed={pressed} className={clsx(styles.chip, size === 'sm' && styles.sm, className)} {...rest}>
      {icon}
      {children}
      {onRemove && (
        <span role="button" tabIndex={-1} aria-label="Remove" className={styles.chipX} onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          <X size={12} />
        </span>
      )}
    </button>
  );
});

export interface ManaChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  color: 'W' | 'U' | 'B' | 'R' | 'G' | 'C' | 'M';
  pressed: boolean;
  label: string;
  children: ReactNode; // the glyph
}
/** Round mana-coloured toggle; the glyph stays visible when off so colour is never the only signal. */
export function ManaChip({ color, pressed, label, className, children, type = 'button', ...rest }: ManaChipProps) {
  const style = { '--m': `var(--mana-${color})`, '--m-ink': `var(--mana-${color}-ink)`, '--m-glow': `var(--mana-${color}-glow)` } as CSSProperties;
  return (
    <button type={type} aria-pressed={pressed} aria-label={label} title={label} style={style} className={clsx(styles.chip, styles.mana, className)} {...rest}>
      {children}
    </button>
  );
}
