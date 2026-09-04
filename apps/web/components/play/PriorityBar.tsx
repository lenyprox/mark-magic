'use client';
// "You have priority" / "Opponent is thinking…" with the AI's latest narration, an "Actions" button that opens the
// legal actions as a popover (the number keys 1–9 still pick them directly), Pass (Space) and Concede. While the
// animation queue is still catching up to the decision the bar shows the decision but reads `catching-up`.
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, Flag } from 'lucide-react';
import type { LegalAction } from '@engine/state';
import { Button, Kbd } from '@/components/ui';
import { ActionsPopover } from './ActionsPopover';
import styles from './table.module.css';

export interface PriorityBarProps {
  hasDecision: boolean;
  decisionText: string;
  thinking: boolean;
  narration: string | null;
  numbered: LegalAction[];
  onPick: (l: LegalAction) => void;
  onPass: () => void;
  onConcede: () => void;
  canPass: boolean;
  stackSize: number;
  finished: boolean;
  /** The shown view has caught up with the decision's view (table interaction enabled). */
  settled?: boolean;
}

export function PriorityBar({ hasDecision, decisionText, thinking, narration, numbered, onPick, onPass, onConcede, canPass, stackSize, finished, settled = true }: PriorityBarProps) {
  const catching = hasDecision && !settled;
  const status = finished ? 'Game over' : hasDecision ? (catching ? `${decisionText} · catching up…` : decisionText) : thinking ? 'Opponent is thinking…' : 'Resolving…';
  const [open, setOpen] = useState(false);
  const showActions = hasDecision && numbered.length > 0 && settled;
  return (
    <div className={clsx(styles.prio, hasDecision && settled && styles.prioMine, thinking && styles.prioThinking)} data-testid="priority-bar" data-state={finished ? 'finished' : hasDecision ? (settled ? 'mine' : 'catching-up') : thinking ? 'thinking' : 'resolving'}>
      <div className={styles.prioStatus}>
        <span className={styles.prioDot} aria-hidden />
        <span className={styles.prioText} role="status" aria-live="polite">{status}</span>
        {narration && !hasDecision && <span className={styles.prioNarration} title={narration}>{narration}</span>}
      </div>
      {showActions && (
        <div className={styles.prioActionsWrap}>
          <button type="button" className={styles.prioAction} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} data-testid="actions-button" title="Legal actions (1–9)">
            <span>{numbered.length} {numbered.length === 1 ? 'action' : 'actions'}</span>
            <ChevronDown size={12} aria-hidden />
          </button>
          {open && <ActionsPopover title="Legal actions" actions={numbered} numbered onPick={l => { setOpen(false); onPick(l); }} onClose={() => setOpen(false)} testId="actions-menu" />}
        </div>
      )}
      <div className={styles.prioButtons}>
        <Button variant="primary" size="sm" disabled={!canPass || catching} onClick={onPass} data-testid="pass-button" trailing={<Kbd>Space</Kbd>}>{stackSize ? 'Pass · resolve' : 'Pass'}</Button>
        <Button variant="ghost" size="sm" icon={<Flag size={14} />} onClick={onConcede} disabled={finished}>Concede</Button>
      </div>
      <span className="sr-only">{hasDecision && numbered.length > 0 ? `${numbered.length} legal actions; press 1 to ${Math.min(9, numbered.length)} to pick one` : ''}</span>
    </div>
  );
}
