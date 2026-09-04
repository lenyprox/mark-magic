'use client';
// One player's battlefield: lands compact and grouped by name, creatures, and everything else. Each card reports
// its interaction state through the table's `cardState` callback. Creatures and other permanents sit in `layoutId`
// wrappers (FLIP in from the hand or the stack, fade out when they die); land groups settle in with CSS.
import { useMemo } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import type { LegalAction } from '@engine/state';
import type { PermanentView } from '@play/view';
import type { PlayerId } from '@engine/state';
import type { DragSource } from '@play/targeting';
import { groupByName } from '@/lib/game/ui';
import { TableCard, type TableCardProps } from './TableCard';
import type { DragBindProps } from './useDragIntent';
import styles from './table.module.css';

export interface BattlefieldProps {
  permanents: PermanentView[];
  mine: boolean;
  /** Whose battlefield this is (the drop zone id). */
  player?: PlayerId;
  cardWidth?: number;
  cardState: (id: number) => TableCardProps['state'];
  onActivate: (id: number) => void;
  actionsFor?: (id: number) => LegalAction[];
  menuCard?: number | null;
  onMenuOpenChange?: (id: number, open: boolean) => void;
  onPickAction?: (l: LegalAction) => void;
  blockedLabel?: (p: PermanentView) => string | null;
  bindDrag?: (source: DragSource, card: PermanentView) => DragBindProps;
  /** Drop-zone highlight for the whole battlefield (a drag is in flight and this zone has an effect / is hovered). */
  dropTarget?: boolean;
  dropOver?: boolean;
  /** Changes whenever the shown view changes through the animation queue. */
  layoutKey?: unknown;
  reducedMotion?: boolean;
}

export function Battlefield({ permanents, mine, player, cardWidth = 88, cardState, onActivate, actionsFor, menuCard, onMenuOpenChange, onPickAction, bindDrag, dropTarget, dropOver, layoutKey, reducedMotion }: BattlefieldProps) {
  const { lands, creatures, others } = useMemo(() => {
    const lands: PermanentView[] = []; const creatures: PermanentView[] = []; const others: PermanentView[] = [];
    for (const p of permanents) { if (p.isCreature) creatures.push(p); else if (p.isLand) lands.push(p); else others.push(p); }
    return { lands, creatures, others };
  }, [permanents]);
  const landGroups = useMemo(() => groupByName(lands), [lands]);
  const t = reducedMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 380, damping: 32, mass: 0.9 };
  const exit = reducedMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.9, y: 6, transition: { duration: 0.3 } };

  const render = (p: PermanentView, extra?: Partial<TableCardProps>) => {
    const acts = actionsFor?.(p.id) ?? [];
    return (
      <motion.div key={p.id} layoutId={`card-${p.id}`} layoutDependency={layoutKey} transition={t} exit={exit} className={clsx(styles.slot, p.attacking !== null && styles.slotAttacking, p.blocking.length > 0 && styles.slotBlocking)}>
        <TableCard card={p} width={cardWidth} tapped={p.tapped} state={{ ...cardState(p.id), sick: p.summoningSick && mine && p.isCreature }} onActivate={onActivate}
          menuActions={acts} menuOpen={menuCard === p.id} onMenuOpenChange={open => onMenuOpenChange?.(p.id, open)} onPickAction={onPickAction} dragProps={bindDrag?.({ kind: 'permanent', id: p.id }, p)} {...extra} />
      </motion.div>
    );
  };

  const rows: { key: string; label: string; node: React.ReactNode }[] = [];
  if (creatures.length) rows.push({ key: 'creatures', label: 'Creatures', node: <AnimatePresence initial={false}>{creatures.map(p => render(p))}</AnimatePresence> });
  if (others.length) rows.push({ key: 'others', label: 'Other permanents', node: <AnimatePresence initial={false}>{others.map(p => render(p))}</AnimatePresence> });
  if (lands.length) rows.push({ key: 'lands', label: 'Lands', node: landGroups.map(g => {
    // A land group shows one card per tapped state: untapped stack and tapped stack, each with a count.
    const untapped = g.items.filter(l => !l.tapped); const tapped = g.items.filter(l => l.tapped);
    const acts = actionsFor?.(untapped[0]?.id ?? g.items[0].id) ?? [];
    return (
      <div key={g.name} className={styles.landGroup} data-land-group={g.name}>
        {untapped.length > 0 && (
          <TableCard card={untapped[0]} width={Math.round(cardWidth * 0.7)} count={untapped.length} state={cardState(untapped[0].id)} onActivate={onActivate} live="hover"
            menuActions={acts} menuOpen={menuCard === untapped[0].id} onMenuOpenChange={open => onMenuOpenChange?.(untapped[0].id, open)} onPickAction={onPickAction} tilt={4} dragProps={bindDrag?.({ kind: 'permanent', id: untapped[0].id }, untapped[0])} />
        )}
        {tapped.length > 0 && <TableCard card={tapped[0]} width={Math.round(cardWidth * 0.7)} count={tapped.length} tapped state={cardState(tapped[0].id)} onActivate={onActivate} live="hover" tilt={4} />}
        {/* Hidden anchors so connector lines can find any land in the group. */}
        {g.items.slice(1).map(l => <span key={l.id} data-obj-id={l.id} className={styles.hiddenAnchor} aria-hidden />)}
      </div>
    );
  }) });

  // Order: for the opponent, lands nearest the middle would be far; keep creatures nearest the centre strip.
  const ordered = mine ? rows : [...rows].reverse();
  return (
    <div className={clsx(styles.battlefield, mine ? styles.bfMine : styles.bfOpp, dropTarget && styles.dropZone, dropOver && styles.dropZoneOver)} aria-label={mine ? 'Your battlefield' : "Opponent's battlefield"}
      data-drop-zone={player !== undefined ? `battlefield:${player}` : undefined} data-testid={mine ? 'battlefield-me' : 'battlefield-opp'} data-drop-target={dropTarget ? '' : undefined}>
      {ordered.length === 0 && <div className={styles.bfEmpty} aria-hidden />}
      {ordered.map(r => (
        <div key={r.key} className={clsx(styles.bfRow, styles[`row_${r.key}` as keyof typeof styles])} role="group" aria-label={r.label}>{r.node}</div>
      ))}
    </div>
  );
}
