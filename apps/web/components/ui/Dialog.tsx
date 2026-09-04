'use client';
import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import styles from './overlay.module.css';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** No padding; content owns the panel. */
  plain?: boolean;
  className?: string;
  labelledBy?: string;
  closeLabel?: string;
}

/** Native <dialog> modal: Esc closes (via cancel), backdrop click closes, focus is trapped by the browser. */
export function Dialog({ open, onClose, title, children, footer, width, plain, className, labelledBy, closeLabel = 'Close' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const autoId = useId();
  const titleId = labelledBy ?? (title ? `${autoId}-title` : undefined);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);
  return (
    <dialog ref={ref} className={clsx(styles.dialog, className)} style={width ? ({ '--dialog-w': `${width}px` } as CSSProperties) : undefined} aria-labelledby={titleId}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className={styles.panel}>
        <IconButton label={closeLabel} className={styles.closeBtn} onClick={onClose}><X /></IconButton>
        {title && <div className={styles.head}><h2 id={titleId} className={styles.title}>{title}</h2></div>}
        <div className={clsx(styles.body, plain && styles.plain)}>{children}</div>
        {footer && <div className={styles.foot}>{footer}</div>}
      </div>
    </dialog>
  );
}
