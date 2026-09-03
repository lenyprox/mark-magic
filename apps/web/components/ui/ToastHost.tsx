'use client';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { IconButton } from './Button';
import styles from './overlay.module.css';

function ToastItem({ id, title, body, kind, ttl }: { id: number; title: string; body?: string; kind?: string; ttl?: number }) {
  const dismiss = useUi(s => s.dismissToast);
  useEffect(() => { if (!ttl) return; const t = setTimeout(() => dismiss(id), ttl); return () => clearTimeout(t); }, [id, ttl, dismiss]);
  return (
    <div className={styles.toast} data-kind={kind ?? 'note'} role="status">
      <div className={styles.toastBar} />
      <div>
        <div className={styles.toastTitle}>{title}</div>
        {body && <div className={styles.toastBody}>{body}</div>}
      </div>
      <IconButton label="Dismiss" size="sm" onClick={() => dismiss(id)}><X /></IconButton>
    </div>
  );
}

export function ToastHost() {
  const toasts = useUi(s => s.toasts);
  return (
    <div className={styles.toasts} aria-live="polite" aria-relevant="additions">
      {toasts.map(t => <ToastItem key={t.id} {...t} />)}
    </div>
  );
}
