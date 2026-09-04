'use client';
// A player's plate: name, life (rolling), poison, commander damage taken, library count, hand (fanned card backs
// for opponents), graveyard / exile stacks that open the zone drawer, and the mana pool. Doubles as a target when
// it is legal and as a drop zone for attackers. The graveyard thumb carries the top card's `layoutId`, so a dying
// permanent FLIPs into it. Eliminated seats are dimmed.
import clsx from 'clsx';
import { motion } from 'motion/react';
import { BookOpen, Skull, Sparkles, Crown, Swords } from 'lucide-react';
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
  /** "Show me" from the explain panel. */
  pulsed?: boolean;
  /** Smaller plate for opponents in a multiplayer ring. */
  compact?: boolean;
  /** Name lookup for commander damage sources (object id → commander name). */
  nameOf?: (id: number) => string | null;
  onClick?: (pid: PlayerId) => void;
  onOpenZone: (pid: PlayerId, zone: 'graveyard' | 'exile' | 'command') => void;
  layoutKey?: unknown;
  reducedMotion?: boolean;
}

function CardBacks({ n }: { n: number }) {
  const shown = Math.min(n, 9);
  return (
    <div className={styles.backs} aria-label={`${n} cards in hand`} role="img">
      {Array.from({ length: shown }, (_, i) => <span key={i} className={styles.back} style={{ '--i': i, '--n': shown } as React.CSSProperties} />)}
    </div>
  );
}

export const COMMANDER_DAMAGE_LETHAL = 21;

export function PlayerPlate({ player, isMe, active, hasPriority, legalTarget, picked, dimmed, hovered, thinking, dropTarget, dropOver, pulsed, compact, nameOf, onClick, onOpenZone, layoutKey, reducedMotion }: PlayerPlateProps) {
  const clickable = !!onClick && legalTarget;
  const topGy = player.graveyard[player.graveyard.length - 1];
  const topEx = player.exile[player.exile.length - 1];
  const pool = player.manaPool;
  const t = reducedMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.9 };
  const cmdDamage = Object.entries(player.commanderDamage ?? {}).map(([id, dmg]) => ({ id: Number(id), dmg })).filter(x => x.dmg > 0);
  const worst = cmdDamage.reduce((m, x) => Math.max(m, x.dmg), 0);
  const casts = Object.values(player.commanderCasts ?? {}).reduce((a, b) => a + b, 0);
  return (
    <div
      className={clsx(styles.plate, isMe && styles.plateMe, active && styles.plateActive, hasPriority && styles.platePriority, legalTarget && styles.legalTarget, picked && styles.picked, dimmed && styles.dimmed, hovered && styles.hovered, clickable && styles.plateClickable, dropTarget && styles.dropZone, dropOver && styles.dropZoneOver, pulsed && styles.platePulsed, player.lost && styles.plateLost, compact && styles.plateCompact)}
      data-player-id={player.id}
      data-testid={isMe ? 'plate-me' : 'plate-opp'}
      data-seat={player.id}
      data-active={active ? '' : undefined}
      data-priority={hasPriority ? '' : undefined}
      data-lost={player.lost ? '' : undefined}
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
        {player.lost && <span className={styles.plateOut} title={player.lossReason ?? 'Eliminated'}>out</span>}
        {active && !player.lost && <span className={styles.plateTurn} title="Active player">turn</span>}
        {hasPriority && !player.lost && <span className={styles.platePrio} title="Has priority">◆</span>}
        {thinking && <span className={styles.plateThinking} aria-live="off">thinking…</span>}
      </div>
      <div className={styles.plateLife} aria-label={`${player.name} life ${player.life}`}>
        <NumberRoll value={player.life} className={clsx(styles.lifeNum, player.life <= 5 && styles.lifeLow)} />
        {player.poison > 0 && <span className={styles.poison} title="Poison counters"><Skull size={12} aria-hidden /> {player.poison}</span>}
        {cmdDamage.length > 0 && (
          <span className={clsx(styles.cmdDamage, worst >= COMMANDER_DAMAGE_LETHAL && styles.cmdDamageLethal)} data-testid={`commander-damage-${player.id}`} data-worst={worst}
            title={`Commander damage taken: ${cmdDamage.map(x => `${x.dmg} from ${nameOf?.(x.id) ?? `#${x.id}`}`).join(', ')}. A player dealt 21 or more combat damage by the same commander loses the game (CR 704.6c).`}>
            <Swords size={12} aria-hidden /> {worst}<span className="sr-only"> commander damage taken</span>
          </span>
        )}
      </div>
      <div className={styles.plateZones}>
        {(player.commanders?.length > 0) && (
          <button type="button" className={clsx(styles.zoneBtn, !player.command.length && styles.zoneEmpty)} onClick={() => onOpenZone(player.id, 'command')} aria-label={`Command zone, ${player.command.length} cards`} title={`Command zone${casts ? ` · cast ${casts}× (tax {${2 * casts}})` : ''}`} data-testid={`command-btn-${player.id}`}>
            <Crown size={13} aria-hidden /><span className="mono">{player.command.length}</span>
          </button>
        )}
        <span className={styles.zoneStat} title="Library"><BookOpen size={13} aria-hidden /><span className="mono">{player.librarySize}</span><span className="sr-only"> cards in library</span></span>
        <button type="button" className={clsx(styles.zoneBtn, !player.graveyard.length && styles.zoneEmpty)} onClick={() => onOpenZone(player.id, 'graveyard')} aria-label={`Graveyard, ${player.graveyard.length} cards`} title="Graveyard" data-testid={`graveyard-${player.id}`}>
          {topGy ? (
            <motion.span key={topGy.id} layoutId={`card-${topGy.id}`} layoutDependency={layoutKey} transition={t} className={styles.zoneThumbWrap} data-obj-id={topGy.id}>
              {topGy.printingId ? <CardImage printingId={topGy.printingId} face={topGy.face} size="small" alt="" className={styles.zoneThumb} /> : <span className={styles.zoneThumbEmpty} />}
            </motion.span>
          ) : <span className={styles.zoneThumbEmpty} />}
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
