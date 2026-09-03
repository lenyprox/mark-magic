'use client';
// One player's battlefield: lands compact and grouped by name, creatures, and everything else. Each card reports
// its interaction state through the table's `cardState` callback.
import { useMemo } from 'react';
import clsx from 'clsx';
import type { LegalAction } from '@engine/state';
import type { PermanentView } from '@play/view';
import { groupByName } from '@/lib/game/ui';
import { TableCard, type TableCardProps } from './TableCard';
import styles from './table.module.css';

export interface BattlefieldProps {
  permanents: PermanentView[];
  mine: boolean;
  cardWidth?: number;
  cardState: (id: number) => TableCardProps['state'];
  onActivate: (id: number) => void;
  actionsFor?: (id: number) => LegalAction[];
  menuCard?: number | null;
  onMenuOpenChange?: (id: number, open: boolean) => void;
  onPickAction?: (l: LegalAction) => void;
  blockedLabel?: (p: PermanentView) => string | null;
}

export function Battlefield({ permanents, mine, cardWidth = 88, cardState, onActivate, actionsFor, menuCard, onMenuOpenChange, onPickAction }: BattlefieldProps) {
  const { lands, creatures, others } = useMemo(() => {
    const lands: PermanentView[] = []; const creatures: PermanentView[] = []; const others: PermanentView[] = [];
    for (const p of permanents) { if (p.isCreature) creatures.push(p); else if (p.isLand) lands.push(p); else others.push(p); }
    return { lands, creatures, others };
  }, [permanents]);
  const landGroups = useMemo(() => groupByName(lands), [lands]);

  const render = (p: PermanentView, extra?: Partial<TableCardProps>) => {
    const acts = actionsFor?.(p.id) ?? [];
    return (
      <div key={p.id} className={clsx(styles.slot, p.attacking !== null && styles.slotAttacking, p.blocking.length > 0 && styles.slotBlocking)}>
        <TableCard card={p} width={cardWidth} tapped={p.tapped} state={{ ...cardState(p.id), sick: p.summoningSick && mine && p.isCreature }} onActivate={onActivate}
          menuActions={acts} menuOpen={menuCard === p.id} onMenuOpenChange={open => onMenuOpenChange?.(p.id, open)} onPickAction={onPickAction} {...extra} />
      </div>
    );
  };

  const rows: { key: string; label: string; node: React.ReactNode }[] = [];
  if (creatures.length) rows.push({ key: 'creatures', label: 'Creatures', node: creatures.map(p => render(p)) });
  if (others.length) rows.push({ key: 'others', label: 'Other permanents', node: others.map(p => render(p)) });
  if (lands.length) rows.push({ key: 'lands', label: 'Lands', node: landGroups.map(g => {
    // A land group shows one card per tapped state: untapped stack and tapped stack, each with a count.
    const untapped = g.items.filter(l => !l.tapped); const tapped = g.items.filter(l => l.tapped);
    const acts = actionsFor?.(untapped[0]?.id ?? g.items[0].id) ?? [];
    return (
      <div key={g.name} className={styles.landGroup}>
        {untapped.length > 0 && (
          <TableCard card={untapped[0]} width={Math.round(cardWidth * 0.7)} count={untapped.length} state={cardState(untapped[0].id)} onActivate={onActivate} live="hover"
            menuActions={acts} menuOpen={menuCard === untapped[0].id} onMenuOpenChange={open => onMenuOpenChange?.(untapped[0].id, open)} onPickAction={onPickAction} tilt={4} />
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
    <div className={clsx(styles.battlefield, mine ? styles.bfMine : styles.bfOpp)} aria-label={mine ? 'Your battlefield' : "Opponent's battlefield"}>
      {ordered.length === 0 && <div className={styles.bfEmpty} aria-hidden />}
      {ordered.map(r => (
        <div key={r.key} className={clsx(styles.bfRow, styles[`row_${r.key}` as keyof typeof styles])} role="group" aria-label={r.label}>{r.node}</div>
      ))}
    </div>
  );
}
