'use client';
// A seat's command zone: the commander card(s) with the cast count and the current tax. For the viewer it is a drag
// source — dropping the commander on the battlefield casts it (the legal action with `from: 'command'`). A commander
// that is not in the zone (on the battlefield, in a graveyard) leaves a labelled slot behind.
import clsx from 'clsx';
import { Crown } from 'lucide-react';
import type { PlayerView, CardView } from '@play/view';
import type { DragSource } from '@play/targeting';
import { TableCard, type TableCardProps } from './TableCard';
import type { DragBindProps } from './useDragIntent';
import styles from './table.module.css';

export interface CommandZoneProps {
  player: PlayerView;
  mine: boolean;
  cardWidth?: number;
  cardState: (id: number) => TableCardProps['state'];
  onActivate?: (id: number) => void;
  bindDrag?: (source: DragSource, card: CardView) => DragBindProps;
  /** Where each commander currently is when it is not in the zone (for the empty slot's label). */
  whereIs?: (id: number) => string | null;
  layoutKey?: unknown;
  reducedMotion?: boolean;
}

export function CommandZone({ player, mine, cardWidth = 56, cardState, onActivate, bindDrag, whereIs, layoutKey, reducedMotion }: CommandZoneProps) {
  void layoutKey; void reducedMotion;
  if (!player.commanders?.length) return null;
  const casts = player.commanderCasts ?? {};
  return (
    <div className={clsx(styles.commandZone, mine && styles.commandZoneMine)} role="group" aria-label={`${player.name}'s command zone`} data-testid={`command-zone-${player.id}`} data-count={player.command.length}>
      <div className={styles.commandHead}><Crown size={12} aria-hidden /> Command</div>
      <div className={styles.commandCards}>
        {player.commanders.map(id => {
          const card = player.command.find(c => c.id === id);
          const n = casts[id] ?? 0;
          const tax = 2 * n;
          const label = n ? `cast ${n}× · tax {${tax}}` : 'tax {0}';
          if (!card) {
            return (
              <div key={id} className={styles.commandSlot} data-testid={`commander-slot-${id}`} title={`Commander is ${whereIs?.(id) ?? 'not in the command zone'} · ${label}`}>
                <span className={styles.commandSlotText}>{whereIs?.(id) ?? 'away'}</span>
                <span className={styles.commandTax}>{label}</span>
              </div>
            );
          }
          return (
            <div key={id} className={styles.commandCard} data-testid={`commander-${id}`}>
              <TableCard card={card} width={cardWidth} live="hover" tilt={4} state={cardState(id)} onActivate={onActivate} dragProps={mine ? bindDrag?.({ kind: 'command', cardId: id }, card) : undefined} />
              <span className={styles.commandTax} title={`Commander tax: {2} per previous cast from the command zone (CR 903.8)`}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
