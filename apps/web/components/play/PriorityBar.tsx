'use client';
// "You have priority" / "Opponent is thinking…" with the AI's latest narration, the numbered legal actions,
// Pass (Space) and Concede.
import clsx from 'clsx';
import { Flag } from 'lucide-react';
import type { LegalAction } from '@engine/state';
import { Button, Kbd } from '@/components/ui';
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
}

export function PriorityBar({ hasDecision, decisionText, thinking, narration, numbered, onPick, onPass, onConcede, canPass, stackSize, finished }: PriorityBarProps) {
  const status = finished ? 'Game over' : hasDecision ? decisionText : thinking ? 'Opponent is thinking…' : 'Resolving…';
  return (
    <div className={clsx(styles.prio, hasDecision && styles.prioMine, thinking && styles.prioThinking)} data-testid="priority-bar" data-state={finished ? 'finished' : hasDecision ? 'mine' : thinking ? 'thinking' : 'resolving'}>
      <div className={styles.prioStatus}>
        <span className={styles.prioDot} aria-hidden />
        <span className={styles.prioText} role="status" aria-live="polite">{status}</span>
        {narration && !hasDecision && <span className={styles.prioNarration} title={narration}>{narration}</span>}
      </div>
      {hasDecision && numbered.length > 0 && (
        <div className={styles.prioActions} role="group" aria-label="Legal actions">
          {numbered.slice(0, 9).map((l, i) => (
            <button key={i} type="button" className={styles.prioAction} onClick={() => onPick(l)} title={l.label}>
              <Kbd>{i + 1}</Kbd>
              <span className="truncate">{l.label}</span>
              {l.manaValue != null && l.action.type === 'cast' && <span className={styles.prioMv}>{l.manaValue}</span>}
            </button>
          ))}
          {numbered.length > 9 && <span className="faint small">+{numbered.length - 9} more</span>}
        </div>
      )}
      <div className={styles.prioButtons}>
        <Button variant="primary" size="sm" disabled={!canPass} onClick={onPass} data-testid="pass-button" trailing={<Kbd>Space</Kbd>}>{stackSize ? 'Pass · resolve' : 'Pass'}</Button>
        <Button variant="ghost" size="sm" icon={<Flag size={14} />} onClick={onConcede} disabled={finished}>Concede</Button>
      </div>
      <span className="sr-only">{hasDecision && numbered.length > 0 ? `${numbered.length} legal actions; press 1 to ${Math.min(9, numbered.length)} to pick one` : ''}</span>
    </div>
  );
}
