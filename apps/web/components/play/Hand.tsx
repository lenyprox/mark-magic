'use client';
// The viewer's hand as a fanned arc of always-live cards. Hovering lifts and straightens a card; castable cards
// carry a brass rim; clicking asks the table for that card's actions.
import { useState } from 'react';
import clsx from 'clsx';
import type { LegalAction } from '@engine/state';
import type { CardView } from '@play/view';
import type { DragSource } from '@play/targeting';
import { TableCard, type TableCardProps } from './TableCard';
import type { DragBindProps } from './useDragIntent';
import styles from './table.module.css';

export interface HandProps {
  cards: CardView[];
  cardState: (id: number) => TableCardProps['state'];
  onActivate: (id: number) => void;
  actionsFor: (id: number) => LegalAction[];
  menuCard: number | null;
  onMenuOpenChange: (id: number, open: boolean) => void;
  onPickAction: (l: LegalAction) => void;
  compact?: boolean;
  /** Drag binding from useDragIntent; when absent the hand is click-only. */
  bindDrag?: (source: DragSource, card: CardView) => DragBindProps;
}

export function Hand({ cards, cardState, onActivate, actionsFor, menuCard, onMenuOpenChange, onPickAction, compact, bindDrag }: HandProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const n = cards.length;
  const width = compact ? 88 : 116;
  const maxFan = compact ? 340 : 720;
  // Angle spread grows with the hand up to ±18°, overlap tightens as it grows.
  const spread = Math.min(18, 4.5 * (n - 1));
  const step = n > 1 ? (spread * 2) / (n - 1) : 0;
  const overlap = n > 1 ? Math.max(width * 0.45, Math.min(width * 0.86, (maxFan - width) / (n - 1))) : width;
  return (
    <div className={clsx(styles.hand, compact && styles.handCompact)} role="group" aria-label={`Your hand, ${n} cards`} style={{ '--hand-w': `${width}px` } as React.CSSProperties} data-drop-zone="void" data-testid="hand">
      <div className={styles.fan} style={{ width: n ? overlap * (n - 1) + width : 0 }}>
        {cards.map((c, i) => {
          const angle = -spread + step * i;
          const lift = Math.abs(angle) * 0.9;
          const isHover = hovered === c.id;
          return (
            <div
              key={c.id}
              className={clsx(styles.fanSlot, isHover && styles.fanHover, menuCard === c.id && styles.fanHover)}
              style={{ '--x': `${i * overlap}px`, '--rot': `${angle}deg`, '--lift': `${lift}px`, zIndex: isHover ? 50 : i } as React.CSSProperties}
              onPointerEnter={() => setHovered(c.id)}
              onPointerLeave={() => setHovered(h => (h === c.id ? null : h))}
              onFocusCapture={() => setHovered(c.id)}
              onBlurCapture={() => setHovered(h => (h === c.id ? null : h))}
            >
              <TableCard card={c} width={width} live="always" tilt={10} state={cardState(c.id)} onActivate={onActivate}
                menuActions={actionsFor(c.id)} menuOpen={menuCard === c.id} onMenuOpenChange={open => onMenuOpenChange(c.id, open)} onPickAction={onPickAction} className={styles.handCard}
                dragProps={bindDrag?.({ kind: 'hand', cardId: c.id }, c)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
