'use client';
// One card object on the table: a live Card3D (or a token placeholder), with the interaction states the table needs
// (castable rim, legal target pulse, dimmed, picked, attacking / blocking, selected) and a `data-obj-id` anchor for
// the connector overlay. Multi-action cards open a small menu to choose the action. Draggable when the table
// passes drag props (pointer gesture from useDragIntent); drop-zone highlights come through `state`. The animation
// queue adds glow / dying / hit / pulsed states and marks cards mid-flight (`moving`), which render static.
import { memo, type CSSProperties, type ReactNode } from 'react';
import clsx from 'clsx';
import type { LegalAction } from '@engine/state';
import type { CardView, PermanentView } from '@play/view';
import { Card3D } from '@/components/card/Card3D';
import { printingFor } from '@/lib/game/ui';
import { ActionsPopover } from './ActionsPopover';
import type { DragBindProps } from './useDragIntent';
import styles from './table.module.css';

export interface TableCardProps {
  card: CardView | PermanentView;
  width?: number;
  live?: 'always' | 'hover' | 'never';
  tapped?: boolean;
  state?: {
    castable?: boolean; legalTarget?: boolean; dimmed?: boolean; picked?: boolean; hovered?: boolean; selected?: boolean; attacking?: boolean; blocking?: boolean; source?: boolean; sick?: boolean; dropTarget?: boolean; dropOver?: boolean; lifted?: boolean;
    /** From the animation queue / explain layer. */
    glow?: boolean; dying?: boolean; hit?: boolean; pulsed?: boolean; moving?: boolean;
    /** Manual mana: the engine would tap this for the spell being dragged / it is chosen in the pay tray / it can be chosen. */
    willTap?: boolean; paySource?: boolean; payCandidate?: boolean;
  };
  badge?: ReactNode;
  count?: number;
  onActivate?: (id: number) => void;
  menuActions?: LegalAction[];
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  onPickAction?: (l: LegalAction) => void;
  className?: string;
  style?: CSSProperties;
  tilt?: number;
  /** From useDragIntent's bind(): makes the card draggable. */
  dragProps?: DragBindProps;
}

function TokenFace({ card }: { card: CardView }) {
  return (
    <div className={clsx(styles.token, !card.name && styles.tokenHidden)} aria-hidden>
      <div className={styles.tokenName}>{card.name || (card.isToken ? 'Token' : '')}</div>
      <div className={styles.tokenType}>{card.typeLine}</div>
      {card.power != null && <div className={styles.tokenPt}>{card.power}/{card.toughness}</div>}
    </div>
  );
}

export const TableCard = memo(function TableCard({ card, width = 92, live = 'hover', tapped, state = {}, badge, count, onActivate, menuActions, menuOpen, onMenuOpenChange, onPickAction, className, style, tilt, dragProps }: TableCardProps) {
  const printing = printingFor(card);
  const perm = 'controller' in card ? (card as PermanentView) : null;
  const pt = perm?.isCreature ? `${perm.curPower}/${perm.curToughness}` : card.power != null ? `${card.power}/${card.toughness}` : null;
  const damaged = perm && perm.damage > 0;
  const label = `${card.name || 'Unknown card'}${pt ? `, ${pt}` : ''}${tapped ? ', tapped' : ''}${state.castable ? ', playable' : ''}${state.legalTarget ? ', legal target' : ''}`;
  const activate = onActivate ? () => onActivate(card.id) : undefined;
  const hasMenu = !!menuActions && menuActions.length > 1 && !!onPickAction;
  const liveMode = state.moving || state.dying ? 'never' : live;

  return (
    <div
      className={clsx(styles.tcard, tapped && styles.tcardTapped, state.castable && styles.castable, state.legalTarget && styles.legalTarget, state.dimmed && styles.dimmed, state.picked && styles.picked, state.hovered && styles.hovered, state.selected && styles.selected, state.attacking && styles.attacking, state.blocking && styles.blocking, state.source && styles.source, state.sick && styles.sick, state.dropTarget && styles.dropTarget, state.dropOver && styles.dropOver, state.lifted && styles.lifted, dragProps && styles.draggable,
        state.glow && styles.glow, state.dying && styles.dying, state.hit && styles.hit, state.pulsed && styles.pulsed, state.willTap && styles.willTap, state.paySource && styles.paySource, state.payCandidate && styles.payCandidate, className)}
      style={{ width, ...style, ...dragProps?.style }}
      data-obj-id={card.id}
      data-card-name={card.name}
      data-castable={state.castable ? '' : undefined}
      data-legal-target={state.legalTarget ? '' : undefined}
      data-drop-target={state.dropTarget ? '' : undefined}
      data-draggable={dragProps ? '' : undefined}
      data-will-tap={state.willTap ? '' : undefined}
      data-pay-source={state.paySource ? '' : undefined}
      onClick={activate}
      onPointerDown={dragProps?.onPointerDown}
    >
      {printing ? (
        <Card3D printing={printing} face={card.face} live={liveMode} tapped={tapped} size="normal" tilt={tilt ?? 8} onActivate={activate} aria-label={label} />
      ) : (
        <div role={activate ? 'button' : 'img'} tabIndex={activate ? 0 : -1} aria-label={label} className={clsx(styles.tokenWrap, tapped && styles.tokenTapped)} onKeyDown={e => { if (activate && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } }}>
          <TokenFace card={card} />
        </div>
      )}
      {pt && <span className={clsx(styles.pt, damaged && styles.ptDamaged)} aria-hidden>{pt}</span>}
      {count != null && count > 1 && <span className={styles.countBadge} aria-label={`${count} copies`}>×{count}</span>}
      {badge}
      {perm && Object.keys(perm.counters).length > 0 && (
        <span key={Object.values(perm.counters).join(',')} className={styles.counters} aria-hidden>{Object.entries(perm.counters).map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`).join(' · ')}</span>
      )}
      {hasMenu && menuOpen && <ActionsPopover title={card.name} manaCost={card.manaCost} actions={menuActions!} onPick={l => { onMenuOpenChange?.(false); onPickAction!(l); }} onClose={() => onMenuOpenChange?.(false)} />}
    </div>
  );
});
