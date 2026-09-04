'use client';
// The viewer's hand. On a pointer device it is a fanned arc of live cards: hovering lifts and straightens a card,
// castable cards carry a brass rim, clicking asks the table for that card's actions. On a phone (`compact`) the fan
// flattens into a horizontal snap-scroll strip — the cards pan with the thumb (`touch-action: pan-x`) and a
// long press still picks one up to drag. Each card sits in a `layoutId` wrapper so it FLIPs to the stack or the
// battlefield when the animation queue moves it; only the first eight cards (plus the hovered one) are live WebGL,
// the rest upgrade on hover.
import { memo, useState } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import type { LegalAction } from '@engine/state';
import type { CardView } from '@play/view';
import type { DragSource } from '@play/targeting';
import { TableCard, type TableCardProps } from './TableCard';
import type { DragBindProps } from './useDragIntent';
import styles from './table.module.css';

const identity = <T,>(c: T): T => c;

export const LIVE_HAND_POOL = 8;

export interface HandProps {
  cards: CardView[];
  cardState: (id: number) => TableCardProps['state'];
  onActivate: (id: number) => void;
  actionsFor: (id: number) => LegalAction[];
  menuCard: number | null;
  onMenuOpenChange: (id: number, open: boolean) => void;
  onPickAction: (l: LegalAction) => void;
  /** Phone layout: a snap-scroll strip instead of the fan. */
  compact?: boolean;
  /** Drag binding from useDragIntent; when absent the hand is click-only. */
  bindDrag?: (source: DragSource, card: CardView, opts?: { touchAction?: string }) => DragBindProps;
  /** Changes whenever the shown view changes through the animation queue. */
  layoutKey?: unknown;
  reducedMotion?: boolean;
}

export const Hand = identity(function Hand({ cards, cardState, onActivate, onPickAction, actionsFor, menuCard, onMenuOpenChange, compact, bindDrag, layoutKey, reducedMotion }: HandProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const n = cards.length;
  const width = compact ? 96 : 116;
  const maxFan = 720;
  // Angle spread grows with the hand up to ±18°, overlap tightens as it grows.
  const spread = compact ? 0 : Math.min(18, 4.5 * (n - 1));
  const step = !compact && n > 1 ? (spread * 2) / (n - 1) : 0;
  const overlap = !compact && n > 1 ? Math.max(width * 0.45, Math.min(width * 0.86, (maxFan - width) / (n - 1))) : width;
  const t = reducedMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.9 };
  return (
    <div className={clsx(styles.hand, compact && styles.handCompact)} role="group" aria-label={`Your hand, ${n} cards`} style={{ '--hand-w': `${width}px` } as React.CSSProperties} data-drop-zone="void" data-testid="hand" data-layout={compact ? 'strip' : 'fan'}>
      <div className={clsx(styles.fan, compact && styles.fanStrip)} style={compact ? undefined : { width: n ? overlap * (n - 1) + width : 0 }}>
        <AnimatePresence initial={false}>
          {cards.map((c, i) => {
            const angle = -spread + step * i;
            const lift = Math.abs(angle) * 0.9;
            const isHover = hovered === c.id;
            const live: TableCardProps['live'] = i < LIVE_HAND_POOL || isHover ? 'always' : 'hover';
            return (
              <motion.div
                key={c.id}
                className={clsx(compact ? styles.stripSlot : styles.fanSlot, !compact && isHover && styles.fanHover, !compact && menuCard === c.id && styles.fanHover)}
                style={compact ? undefined : ({ '--x': `${i * overlap}px`, '--rot': `${angle}deg`, '--lift': `${lift}px`, zIndex: isHover ? 50 : i } as React.CSSProperties)}
                exit={{ opacity: 0, transition: { duration: reducedMotion ? 0 : 0.18 } }}
                onPointerEnter={() => setHovered(c.id)}
                onPointerLeave={() => setHovered(h => (h === c.id ? null : h))}
                onFocusCapture={() => setHovered(c.id)}
                onBlurCapture={() => setHovered(h => (h === c.id ? null : h))}
              >
                <motion.div layoutId={`card-${c.id}`} layoutDependency={layoutKey} transition={t} className={styles.flipWrap}>
                  <TableCard card={c} width={width} live={live} tilt={compact ? 4 : 10} state={cardState(c.id)} onActivate={onActivate}
                    menuActions={actionsFor(c.id)} menuOpen={menuCard === c.id} onMenuOpenChange={open => onMenuOpenChange(c.id, open)} onPickAction={onPickAction} className={styles.handCard}
                    dragProps={bindDrag?.({ kind: 'hand', cardId: c.id }, c, compact ? { touchAction: 'pan-x' } : undefined)} />
                </motion.div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
});
