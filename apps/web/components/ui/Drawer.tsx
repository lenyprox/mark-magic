'use client';
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import styles from './overlay.module.css';

export interface DrawerProps { open: boolean; onClose: () => void; side?: 'left' | 'right' | 'bottom'; title?: ReactNode; children: ReactNode; width?: number; className?: string }

export function Drawer({ open, onClose, side = 'right', title, children, width, className }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (!el) return; if (open && !el.open) el.showModal(); else if (!open && el.open) el.close(); }, [open]);
  useEffect(() => { const el = ref.current; if (!el) return; const onCancel = (e: Event) => { e.preventDefault(); onClose(); }; el.addEventListener('cancel', onCancel); return () => el.removeEventListener('cancel', onCancel); }, [onClose]);
  return (
    <dialog ref={ref} data-side={side} className={clsx(styles.drawer, className)} style={width ? ({ '--drawer-w': `${width}px` } as CSSProperties) : undefined} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className={styles.drawerPanel}>
        {side === 'bottom' && <div className={styles.grip} aria-hidden />}
        <div className={styles.head}>
          <div className={styles.title}>{title}</div>
          <IconButton label="Close" onClick={onClose}><X /></IconButton>
        </div>
        <div className={styles.body} style={{ flex: 1 }}>{children}</div>
      </div>
    </dialog>
  );
}
