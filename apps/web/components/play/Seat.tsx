'use client';
// One opponent seat (plate, command zone, battlefield) and the ring that lays the opponents out: a single wide seat
// in a duel (the layout the two-player table always had), a row of two or three compact seats in a pod, and a ring
// (left · top · right) from 1600 px on. The viewer's own seat stays at the bottom of the table.
import clsx from 'clsx';
import type { PlayerId } from '@engine/state';
import type { PlayerView, PermanentView, CardView } from '@play/view';
import type { DragSource } from '@play/targeting';
import { PlayerPlate, type PlayerPlateProps } from './PlayerPlate';
import { Battlefield, type BattlefieldProps } from './Battlefield';
import { CommandZone } from './CommandZone';
import type { TableCardProps } from './TableCard';
import type { DragBindProps } from './useDragIntent';
import styles from './table.module.css';

export interface SeatProps {
  player: PlayerView;
  /** Number of opponents on the table (1 = duel layout). */
  seats: number;
  plate: Omit<PlayerPlateProps, 'player' | 'isMe' | 'compact'>;
  battlefield: Omit<BattlefieldProps, 'permanents' | 'mine' | 'player'>;
  cardState: (id: number) => TableCardProps['state'];
  onActivate: (id: number) => void;
  whereIs: (id: number) => string | null;
  bindDrag?: (source: DragSource, card: CardView) => DragBindProps;
  isMobile: boolean;
}

export function Seat({ player, seats, plate, battlefield, cardState, onActivate, whereIs, isMobile }: SeatProps) {
  const compact = seats > 1;
  return (
    <section className={clsx(styles.seat, compact && styles.seatCompact, player.lost && styles.seatLost)} aria-label={`${player.name}'s side`} data-testid="seat" data-seat={player.id} data-lost={player.lost ? '' : undefined}>
      <div className={styles.seatPlate}>
        <PlayerPlate {...plate} player={player} isMe={false} compact={compact} />
        {player.commanders?.length > 0 && <CommandZone player={player} mine={false} cardWidth={compact ? 40 : 52} cardState={cardState} onActivate={onActivate} whereIs={whereIs} layoutKey={plate.layoutKey} reducedMotion={plate.reducedMotion} />}
      </div>
      <Battlefield {...battlefield} permanents={player.battlefield} mine={false} player={player.id} cardWidth={compact ? (isMobile ? 48 : 62) : (isMobile ? 60 : 78)} cardState={cardState} onActivate={onActivate} />
    </section>
  );
}

export interface SeatRingProps {
  opponents: PlayerView[];
  children: (p: PlayerView, index: number) => React.ReactNode;
  /** Ring order: with three opponents the seat before the viewer sits left, the next across, the last right. */
  activePlayer?: PlayerId;
}

export function SeatRing({ opponents, children }: SeatRingProps) {
  const n = opponents.length;
  return (
    <div className={clsx(styles.seatRing, n === 1 && styles.ring1, n === 2 && styles.ring2, n === 3 && styles.ring3)} data-testid="seat-ring" data-seats={n}>
      {opponents.map((p, i) => children(p, i))}
    </div>
  );
}

export type { PermanentView };
