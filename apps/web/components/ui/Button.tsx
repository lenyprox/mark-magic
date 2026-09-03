'use client';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import styles from './controls.module.css';

export type ButtonVariant = 'primary' | 'quiet' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  block?: boolean;
  icon?: ReactNode;
  /** Icon after the label. */
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'quiet', size = 'md', block, icon, trailing, className, children, type = 'button', ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} className={clsx(styles.btn, styles[variant], size === 'sm' && styles.sm, block && styles.block, className)} {...rest}>
      {icon}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', className, children, type = 'button', ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={clsx(styles.btn, styles.icon, styles[variant], size === 'sm' && styles.sm, className)} {...rest}>
      {children}
    </button>
  );
});
