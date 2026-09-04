'use client';
// A small menu listing a card's legal actions (or every legal action, from the priority bar). Replaces the numbered
// buttons that used to sit in the priority bar: the number keys still pick actions, this is the visible surface.
// Anchored above its parent by default, or at a fixed viewport point (a drop location).
import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import type { LegalAction } from '@engine/state';
import { ManaCost } from '@/components/text/ManaSymbol';
import { Kbd } from '@/components/ui';
import styles from './table.module.css';

export interface ActionsPopoverProps {
  title: string;
  actions: LegalAction[];
  onPick: (l: LegalAction) => void;
  onClose: () => void;
  /** Viewport point to pin the menu at (a drop); omitted = above the parent element. */
  at?: { x: number; y: number } | null;
  /** Show 1–9 key hints (the priority bar's list, whose order matches the number keys). */
  numbered?: boolean;
  manaCost?: string | null;
  testId?: string;
}

export function ActionsPopover({ title, actions, onPick, onClose, at, numbered, manaCost, testId }: ActionsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onDoc = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);

  // Keep a fixed menu inside the viewport.
  const style = at ? { left: Math.max(8, Math.min(at.x, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 240)), top: Math.max(8, Math.min(at.y, (typeof window === 'undefined' ? 800 : window.innerHeight) - 40 * actions.length - 48)) } : undefined;

  return (
    <div ref={ref} className={clsx(styles.actionMenu, at && styles.actionMenuFixed)} style={style} role="menu" aria-label={`Actions for ${title}`} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} data-testid={testId ?? 'actions-popover'}>
      <div className={styles.actionMenuTitle}>{title}</div>
      {actions.map((l, i) => (
        <button key={i} type="button" role="menuitem" className={styles.actionMenuItem} onClick={() => onPick(l)}
          onKeyDown={e => { const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]; const j = items.indexOf(e.currentTarget); if (e.key === 'ArrowDown') { e.preventDefault(); items[(j + 1) % items.length]?.focus(); } if (e.key === 'ArrowUp') { e.preventDefault(); items[(j - 1 + items.length) % items.length]?.focus(); } }}>
          {numbered && i < 9 && <Kbd>{i + 1}</Kbd>}
          <span className="truncate">{l.label}</span>
          {l.action.type === 'cast' && manaCost && <ManaCost cost={manaCost} size={12} />}
          {!manaCost && l.manaValue != null && l.action.type === 'cast' && <span className={styles.prioMv}>{l.manaValue}</span>}
        </button>
      ))}
    </div>
  );
}
