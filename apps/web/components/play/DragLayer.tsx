'use client';
// The drag ghost (a plain DOM copy of the card image that follows the pointer with a velocity tilt), the tether
// arrow that runs from a casting source to the pointer while targets are being chosen, and the casting slot that
// holds a spell dropped on the battlefield until its targets are picked. Ghost and tether are portalled to
// document.body above the shared WebGL overlay canvas (z-index 1000).
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { motion, useMotionValue, useTransform, useVelocity, type MotionValue } from 'motion/react';
import type { DragSource } from '@play/targeting';
import type { CardView } from '@play/view';
import { imgUrl } from '@/lib/img';
import { Kbd } from '@/components/ui';
import type { DragBindProps, DragIntent } from './useDragIntent';
import styles from './table.module.css';

function GhostFace({ card }: { card: CardView }) {
  if (card.printingId) return <img className={styles.ghostImg} src={imgUrl(card.printingId, 'normal', card.face)} alt="" draggable={false} />;
  return <div className={clsx(styles.token, styles.ghostToken)} aria-hidden><div className={styles.tokenName}>{card.name}</div><div className={styles.tokenType}>{card.typeLine}</div></div>;
}

/** Tracks the pointer into two motion values (used by the tether while no drag is in progress). */
function usePointer(active: boolean, px: MotionValue<number>, py: MotionValue<number>) {
  useEffect(() => {
    if (!active) return;
    const on = (e: PointerEvent) => { px.set(e.clientX); py.set(e.clientY); };
    window.addEventListener('pointermove', on);
    return () => window.removeEventListener('pointermove', on);
  }, [active, px, py]);
}

/** Centre of an element in viewport coordinates, re-measured on resize / scroll / layout settle. */
function useAnchor(find: () => HTMLElement | null, deps: unknown[], ax: MotionValue<number>, ay: MotionValue<number>) {
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => { raf = 0; const el = find(); if (!el) return; const r = el.getBoundingClientRect(); ax.set(r.left + r.width / 2); ay.set(r.top + r.height / 2); };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    const t = setTimeout(schedule, 360);
    const iv = setInterval(schedule, 500);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    return () => { clearTimeout(t); clearInterval(iv); if (raf) cancelAnimationFrame(raf); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export interface TetherProps {
  /** Where the tether starts: a selector inside rootRef (the casting slot or the source permanent). */
  from: string | null;
  rootRef: RefObject<HTMLElement | null>;
  tone?: 'brass' | 'danger' | 'info';
}

export interface DragLayerProps {
  drag: DragIntent;
  tether: TetherProps | null;
  reducedMotion?: boolean;
}

export function DragLayer({ drag, tether, reducedMotion }: DragLayerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const vx = useVelocity(drag.x);
  const rotate = useTransform(vx, [-2400, 0, 2400], reducedMotion ? [0, 0, 0] : [-11, 0, 11], { clamp: true });
  const scale = drag.phase === 'dragging' ? 1.06 : 1;

  // Tether endpoints: from an anchor element to the pointer (or to the ghost's centre while a drag is in flight).
  const ax = useMotionValue(0); const ay = useMotionValue(0);
  const px = useMotionValue(0); const py = useMotionValue(0);
  const dragging = drag.phase === 'dragging';
  usePointer(!!tether && !dragging, px, py);
  useAnchor(() => (tether?.from && tether.rootRef.current ? tether.rootRef.current.querySelector<HTMLElement>(tether.from) : null), [tether?.from, tether?.rootRef, drag.phase], ax, ay);
  const gw = drag.ghost?.w ?? 0; const gh = drag.ghost?.h ?? 0;
  const ex = useTransform([drag.x, px], ([x, p]) => (dragging ? (x as number) + gw / 2 : (p as number)));
  const ey = useTransform([drag.y, py], ([y, p]) => (dragging ? (y as number) + gh / 2 : (p as number)));
  const d = useTransform([ax, ay, ex, ey], ([x1, y1, x2, y2]) => {
    const [a, b, c, e] = [x1, y1, x2, y2] as number[];
    const mx = (a + c) / 2; const my = (b + e) / 2; const dx = c - a; const dy = e - b; const len = Math.hypot(dx, dy) || 1;
    const cx = mx - dy / len * Math.min(60, len * 0.18); const cy = my + dx / len * Math.min(60, len * 0.18);
    return `M${a},${b} Q${cx},${cy} ${c},${e}`;
  });

  if (!mounted) return null;
  const showTether = !!tether && (tether.from !== null);
  return createPortal(
    <>
      {showTether && (
        <svg className={styles.tetherSvg} aria-hidden data-testid="tether">
          <defs>
            <marker id="tether-brass" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--brass-1)" /></marker>
            <marker id="tether-danger" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--danger)" /></marker>
            <marker id="tether-info" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--info)" /></marker>
          </defs>
          <motion.path className={styles.arrow} data-tone={tether!.tone ?? 'brass'} d={d} markerEnd={`url(#tether-${tether!.tone ?? 'brass'})`} />
        </svg>
      )}
      {drag.ghost && drag.phase !== 'idle' && drag.phase !== 'pending' && (
        <motion.div className={styles.ghost} style={{ x: drag.x, y: drag.y, width: drag.ghost.w, height: drag.ghost.h, rotate }} animate={{ scale }} transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
          data-testid="drag-ghost" data-phase={drag.phase} data-card-name={drag.ghost.card.name} aria-hidden>
          <GhostFace card={drag.ghost.card} />
        </motion.div>
      )}
    </>,
    document.body,
  );
}

export interface CastingSlotProps {
  card: CardView;
  label: string;
  bind?: (source: DragSource, card: CardView) => DragBindProps;
  onCancel: () => void;
  width?: number;
}

/** The spell being cast, parked above the hand while its targets are chosen. Draggable: drop it on a target. */
export function CastingSlot({ card, label, bind, onCancel, width = 104 }: CastingSlotProps) {
  const bound = bind?.({ kind: 'hand', cardId: card.id }, card);
  return (
    <div className={styles.castSlot} data-testid="casting-slot" data-card-name={card.name} role="group" aria-label={`Casting ${card.name}: ${label}`}>
      <div className={styles.castSlotCard} style={{ width, ...bound?.style }} onPointerDown={bound?.onPointerDown} data-draggable={bound ? '' : undefined} data-cast-slot="">
        <GhostFace card={card} />
      </div>
      <div className={styles.castSlotText}>
        <b>{card.name}</b>
        <span>{label}</span>
        <button type="button" className={styles.castSlotCancel} onClick={onCancel}>Cancel <Kbd>Esc</Kbd></button>
      </div>
    </div>
  );
}
