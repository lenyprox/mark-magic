'use client';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Search, X } from 'lucide-react';
import styles from './controls.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  label?: string;
  hint?: string;
  size?: 'sm' | 'md';
  prefix?: ReactNode;
  suffix?: ReactNode;
  wrapClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, size = 'md', prefix, suffix, className, wrapClassName, id, ...rest }, ref) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className={wrapClassName}>
      {label && <label htmlFor={inputId} className={styles.label}>{label}</label>}
      <div className={clsx(styles.field, size === 'sm' && styles.sm)}>
        {prefix}
        <input ref={ref} id={inputId} className={clsx(styles.input, className)} {...rest} />
        {suffix}
      </div>
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
});

export interface SearchInputProps extends Omit<InputProps, 'prefix' | 'onChange' | 'value'> {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  trailing?: ReactNode;
}
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({ value, onChange, onClear, trailing, size = 'md', className, wrapClassName, ...rest }, ref) {
  return (
    <div className={clsx(styles.field, size === 'sm' && styles.sm, wrapClassName)}>
      <Search aria-hidden />
      <input ref={ref} type="search" role="searchbox" value={value} onChange={(e) => onChange(e.target.value)} className={clsx(styles.input, className)} spellCheck={false} autoComplete="off" {...rest} />
      {value ? (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => { onChange(''); onClear?.(); }}><X size={14} /></button>
      ) : trailing}
    </div>
  );
});
