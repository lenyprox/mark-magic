'use client';
// The stack, top first. Each item shows its source as a mini card, its text and its target labels; the items are
// anchors for the connector overlay and can themselves be targets (counterspells).
import type { PlayerId } from '@engine/state';
import clsx from 'clsx';
import type { StackItemView } from '@play/view';
import { CardImage } from '@/components/card/CardImage';
import { OracleText } from '@/components/text/OracleText';
import styles from './table.module.css';

export interface StackPanelProps {
  stack: StackItemView[];
  viewer: PlayerId;
  legalStack?: Set<number> | null;
  dimOthers?: boolean;
  onClick?: (id: number) => void;
  /** Stack ids a drag in flight can be dropped on, and the one under the pointer. */
  dropStack?: Set<number> | null;
  dropOver?: number | null;
}

export function StackPanel({ stack, viewer, legalStack, dimOthers, onClick, dropStack, dropOver }: StackPanelProps) {
  if (!stack.length) return <div className={styles.stackEmpty} aria-label="The stack is empty" data-testid="stack-empty"><span>stack empty</span></div>;
  const items = [...stack].reverse();
  return (
    <ol className={styles.stack} aria-label={`Stack, ${stack.length} items, top first`} data-testid="stack">
      {items.map((it, i) => {
        const legal = !!legalStack?.has(it.id);
        const clickable = legal && !!onClick;
        return (
          <li key={it.id} className={clsx(styles.stackItem, it.controller === viewer ? styles.stackMine : styles.stackTheirs, legal && styles.legalTarget, dimOthers && !legal && styles.dimmed, it.countered && styles.stackCountered, i === 0 && styles.stackTop, dropStack?.has(it.id) && styles.dropTarget, dropOver === it.id && styles.dropOver)}
            data-card-name={it.name}
            data-stack-id={it.id} data-legal-target={legal ? '' : undefined}
            role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} onClick={clickable ? () => onClick!(it.id) : undefined}
            onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(it.id); } } : undefined}>
            {it.source.printingId ? <CardImage printingId={it.source.printingId} face={it.source.face} size="small" alt="" className={styles.stackThumb} /> : <span className={styles.stackThumbEmpty} />}
            <div className={styles.stackBody}>
              <div className={styles.stackName}>{it.name}<span className={styles.stackKind}>{it.kind}</span></div>
              {it.text && <OracleText text={it.text} className={styles.stackText} symbolSize={11} />}
              {it.targetLabels.length > 0 && <div className={styles.stackTargets}>→ {it.targetLabels.join(', ')}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
