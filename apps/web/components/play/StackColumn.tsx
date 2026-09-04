'use client';
// The stack as an animated column, top first. Each item shows its source as a mini card (the FLIP destination for a
// spell cast from hand: same `layoutId` as the hand card), its text and its target labels; items are anchors for the
// connector overlay and can themselves be targets (counterspells). Resolving items slide out; the item the current
// event is about glows.
import type { PlayerId } from '@engine/state';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import type { StackItemView } from '@play/view';
import { CardImage } from '@/components/card/CardImage';
import { OracleText } from '@/components/text/OracleText';
import styles from './table.module.css';

export interface StackColumnProps {
  stack: StackItemView[];
  viewer: PlayerId;
  legalStack?: Set<number> | null;
  dimOthers?: boolean;
  onClick?: (id: number) => void;
  /** Stack ids a drag in flight can be dropped on, and the one under the pointer. */
  dropStack?: Set<number> | null;
  dropOver?: number | null;
  /** The item the animation queue is playing (cast / trigger / resolve). */
  glowId?: number | null;
  /** Changes whenever the shown view changes through the queue (limits layout measurement to those renders). */
  layoutKey?: unknown;
  reducedMotion?: boolean;
}

export function StackColumn({ stack, viewer, legalStack, dimOthers, onClick, dropStack, dropOver, glowId, layoutKey, reducedMotion }: StackColumnProps) {
  const items = [...stack].reverse();
  const t = reducedMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.8 };
  return (
    <div className={styles.stackCol} data-testid="stack-column" data-count={stack.length}>
      {!stack.length && <div className={styles.stackEmpty} aria-label="The stack is empty" data-testid="stack-empty"><span>stack empty</span></div>}
      {stack.length > 0 && (
        <ol className={styles.stack} aria-label={`Stack, ${stack.length} items, top first`} data-testid="stack">
          <AnimatePresence initial={false}>
            {items.map((it, i) => {
              const legal = !!legalStack?.has(it.id);
              const clickable = legal && !!onClick;
              return (
                <motion.li key={it.id} layout="position" layoutDependency={layoutKey} transition={t}
                  initial={reducedMotion ? false : { opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reducedMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 18, scale: 0.96, transition: { duration: 0.24 } }}
                  className={clsx(styles.stackItem, it.controller === viewer ? styles.stackMine : styles.stackTheirs, legal && styles.legalTarget, dimOthers && !legal && styles.dimmed, it.countered && styles.stackCountered, i === 0 && styles.stackTop, dropStack?.has(it.id) && styles.dropTarget, dropOver === it.id && styles.dropOver, glowId === it.id && styles.stackGlow)}
                  data-card-name={it.name}
                  data-stack-id={it.id} data-legal-target={legal ? '' : undefined}
                  role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} onClick={clickable ? () => onClick!(it.id) : undefined}
                  onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(it.id); } } : undefined}>
                  <motion.div layoutId={`card-${it.sourceId}`} layoutDependency={layoutKey} transition={t} className={styles.stackThumbWrap} data-obj-id={it.sourceId}>
                    {it.source.printingId ? <CardImage printingId={it.source.printingId} face={it.source.face} size="small" alt="" className={styles.stackThumb} /> : <span className={styles.stackThumbEmpty} />}
                  </motion.div>
                  <div className={styles.stackBody}>
                    <div className={styles.stackName}>{it.name}<span className={styles.stackKind}>{it.kind}</span></div>
                    {it.text && <OracleText text={it.text} className={styles.stackText} symbolSize={11} />}
                    {it.targetLabels.length > 0 && <div className={styles.stackTargets}>→ {it.targetLabels.join(', ')}</div>}
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
    </div>
  );
}
