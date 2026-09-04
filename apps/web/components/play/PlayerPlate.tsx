'use client';
// A player's plate: name, life (rolling), poison, library count, hand (fanned card backs for the opponent),
// graveyard / exile stacks that open the zone drawer, and the mana pool. Doubles as a target when it is legal.
import clsx from 'clsx';
import { BookOpen, Skull, Sparkles, Crown } from 'lucide-react';
import type { PlayerId } from '@engine/state';
import type { PlayerView } from '@play/view';
import { ManaSymbol } from '@/components/text/ManaSymbol';
import { CardImage } from '@/components/card/CardImage';
import { NumberRoll } from './NumberRoll';
import styles from './table.module.css';

export interface PlayerPlateProps {
  player: PlayerView;
  isMe: boolean;
  active: boolean;
  hasPriority: boolean;
  legalTarget?: boolean;
  picked?: boolean;
  dimmed?: boolean;
  hovered?: boolean;
  thinking?: boolean;
  /** Drop-zone highlight while a drag that can land here is in flight. */
  dropTarget?: boolean;
  dropOver?: boolean;
  onClick?: (pid: PlayerId) => void;
  onOpenZone: (pid: PlayerId, zone: 'graveyard' | 'exile' | 'command') => void;
}

function CardBacks({ n }: { n: number }) {
  const shown = Math.min(n, 9);
  return (
    <div className={styles.backs} aria-label={`${n} cards in hand`} role="img">
      {Array.from({ length: shown }, (_, i) => <span key={i} className={styles.back} style={{ '--i': i, '--n': shown } as React.CSSProperties} />)}
    </div>
  );
}

export function PlayerPlate({ player, isMe, active, hasPriority, legalTarget, picked, dimmed, hovered, thinking, dropTarget, dropOver, onClick, onOpenZone }: PlayerPlateProps) {
  const clickable = !!onClick && legalTarget;
  const topGy = player.graveyard[player.graveyard.length - 1];
  const topEx = player.exile[player.exile.length - 1];
  const pool = player.manaPool;
  return (
    <div
      className={clsx(styles.plate, isMe && styles.plateMe, active && styles.plateActive, legalTarget && styles.legalTarget, picked && styles.picked, dimmed && styles.dimmed, hovered && styles.hovered, clickable && styles.plateClickable, dropTarget && styles.dropZone, dropOver && styles.dropZoneOver)}
      data-player-id={player.id}
      data-testid={isMe ? 'plate-me' : 'plate-opp'}
      data-legal-target={legalTarget ? '' : undefined}
      data-drop-target={dropTarget ? '' : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `Target ${player.name}` : undefined}
      onClick={clickable ? () => onClick!(player.id) : undefined}
      onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(player.id); } } : undefined}
    >
      <div className={styles.plateHead}>
        <span className={styles.plateName}>{player.name}</span>
        {active && <span className={styles.plateTurn} title="Active player">turn</span>}
        {hasPriority && <span className={styles.platePrio} title="Has priority">◆</span>}
        {thinking && <span className={styles.plateThinking} aria-live="off">thinking…</span>}
      </div>
      <div className={styles.plateLife} aria-label={`${player.name} life ${player.life}`}>
        <NumberRoll value={player.life} className={clsx(styles.lifeNum, player.life <= 5 && styles.lifeLow)} />
        {player.poison > 0 && <span className={styles.poison} title="Poison counters"><Skull size={12} aria-hidden /> {player.poison}</span>}
      </div>
      <div className={styles.plateZones}>
        {(player.commanders?.length > 0) && (
          <button type="button" className={clsx(styles.zoneBtn, !player.command.length && styles.zoneEmpty)} onClick={() => onOpenZone(player.id, 'command')} aria-label={`Command zone, ${player.command.length} cards`} title={`Command zone${Object.values(player.commanderCasts ?? {}).some(Boolean) ? ` · cast ${Object.values(player.commanderCasts).reduce((a, b) => a + b, 0)}× (tax {${2 * Object.values(player.commanderCasts).reduce((a, b) => a + b, 0)}})` : ''}${Object.values(player.commanderDamage ?? {}).length ? ` · commander damage taken ${Object.values(player.commanderDamage).join('/')}` : ''}`} data-testid={`command-zone-${player.id}`}>
            <Crown size={13} aria-hidden /><span className="mono">{player.command.length}</span>
          </button>
        )}
        <span className={styles.zoneStat} title="Library"><BookOpen size={13} aria-hidden /><span className="mono">{player.librarySize}</span><span className="sr-only"> cards in library</span></span>
        <button type="button" className={clsx(styles.zoneBtn, !player.graveyard.length && styles.zoneEmpty)} onClick={() => onOpenZone(player.id, 'graveyard')} aria-label={`Graveyard, ${player.graveyard.length} cards`} title="Graveyard">
          {topGy?.printingId ? <CardImage printingId={topGy.printingId} face={topGy.face} size="small" alt="" className={styles.zoneThumb} /> : <span className={styles.zoneThumbEmpty} />}
          <span className="mono">{player.graveyard.length}</span>
        </button>
        <button type="button" className={clsx(styles.zoneBtn, !player.exile.length && styles.zoneEmpty)} onClick={() => onOpenZone(player.id, 'exile')} aria-label={`Exile, ${player.exile.length} cards`} title="Exile">
          {topEx?.printingId ? <CardImage printingId={topEx.printingId} face={topEx.face} size="small" alt="" className={styles.zoneThumb} /> : <span className={styles.zoneThumbEmpty}><Sparkles size={12} aria-hidden /></span>}
          <span className="mono">{player.exile.length}</span>
        </button>
        {!isMe && <CardBacks n={player.handSize} />}
      </div>
      {pool.length > 0 && (
        <div className={styles.pool} aria-label={`Mana pool: ${pool.join(' ')}`}>
          {pool.map((m, i) => <ManaSymbol key={i} sym={m} size={16} />)}
        </div>
      )}
    </div>
  );
}
