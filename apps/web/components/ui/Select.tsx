'use client';
import { forwardRef, useId, type SelectHTMLAttributes } from 'react';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import styles from './controls.module.css';

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: SelectOption[];
  size?: 'sm' | 'md';
  placeholder?: string;
  /** Visible label above the control. */
  label?: string;
  wrapClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, size = 'md', placeholder, label, wrapClassName, className, id, ...rest }, ref) {
  const auto = useId();
  const selId = id ?? auto;
  const control = (
    <span className={clsx(styles.select, size === 'sm' && styles.sm, !label && wrapClassName)}>
      <select ref={ref} id={selId} className={className} {...rest}>
        {placeholder != null && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
      <ChevronDown aria-hidden />
    </span>
  );
  if (!label) return control;
  return <div className={wrapClassName}><label htmlFor={selId} className={styles.label}>{label}</label>{control}</div>;
});
