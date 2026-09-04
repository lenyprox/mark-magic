'use client';
// Pointer-gesture hook for dragging cards on the table. pending (pointer down) → dragging (6 px of travel, or a
// 180 ms long-press on touch) → dropped (an effect applied) | returning (spring back, then idle). The plan for the
// drag comes from @play/targeting's planDrag through `planFor`; drop zones are located by hit-testing the DOM
// under the pointer (data-obj-id / data-player-id / data-stack-id / data-drop-zone attributes), which works while
// the pointer is captured. Ghost coordinates live in motion values so the ghost follows the pointer without
// re-rendering React on every move.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { animate, useMotionValue } from 'motion/react';
import { resolveDrop, type DragPlan, type DragSource, type DropEffect, type DropZone, type IllegalReason } from '@play/targeting';
import type { CardView } from '@play/view';

export type DragPhase = 'idle' | 'pending' | 'dragging' | 'returning';

export interface DragBindProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  style: CSSProperties;
  'data-draggable': '';
}

export interface DragGhost { w: number; h: number; ox: number; oy: number; card: CardView; source: DragSource }

export interface DragIntentOptions {
  /** Plan for picking a source up; null when the source is not draggable at all (no gesture starts). */
  planFor: (source: DragSource) => DragPlan | null;
  /** A drop that does something. `point` is the viewport position of the release. */
  onDrop: (plan: DragPlan, zone: DropZone, effect: Exclude<DropEffect, { kind: 'none' }>, point: { x: number; y: number }) => void;
  /** A drop on the wrong place (or an un-pick-up-able card released anywhere but the void). */
  onIllegal: (plan: DragPlan, zone: DropZone, reason: IllegalReason) => void;
  onDragStart?: (plan: DragPlan) => void;
  onDragEnd?: () => void;
  reducedMotion?: boolean;
}

const SLOP = 6;
const LONG_PRESS = 180;
const SPRING = { type: 'spring' as const, stiffness: 520, damping: 34, mass: 0.9 };

/** Drop zones under a viewport point, innermost first. */
export function zonesAt(x: number, y: number): DropZone[] {
  const out: DropZone[] = [];
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const obj = el.dataset?.objId; const pl = el.dataset?.playerId; const st = el.dataset?.stackId; const dz = el.dataset?.dropZone;
    if (obj !== undefined) out.push({ kind: 'object', id: Number(obj) });
    else if (st !== undefined) out.push({ kind: 'stack', id: Number(st) });
    else if (pl !== undefined) out.push({ kind: 'player', id: Number(pl) as 0 | 1 });
    else if (dz !== undefined) {
      const [kind, arg] = dz.split(':');
      if (kind === 'battlefield') out.push({ kind: 'battlefield', player: Number(arg) as 0 | 1 });
      else if (kind === 'void') { out.push({ kind: 'void' }); break; }
    }
    el = el.parentElement;
  }
  return out;
}

/** The zone a release at this point resolves to: the innermost zone with an effect, else the innermost zone, else the void. */
export function zoneFor(plan: DragPlan, x: number, y: number): { zone: DropZone; effect: DropEffect } {
  const zones = zonesAt(x, y);
  for (const zone of zones) { const effect = resolveDrop(plan, zone); if (effect.kind !== 'none') return { zone, effect }; }
  // nothing applies: inside an explicit void container (the hand) it is a silent cancel, otherwise the innermost zone explains
  const zone = zones.find(z => z.kind === 'void') ?? zones[0] ?? { kind: 'void' as const };
  return { zone, effect: resolveDrop(plan, zone) };
}

export function useDragIntent(opts: DragIntentOptions) {
  const [phase, setPhase] = useState<DragPhase>('idle');
  const [plan, setPlan] = useState<DragPlan | null>(null);
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const [over, setOver] = useState<DropZone | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const optsRef = useRef(opts); optsRef.current = opts;

  const gesture = useRef<{
    pointerId: number; el: HTMLElement; startX: number; startY: number; grabX: number; grabY: number; w: number; h: number; ox: number; oy: number;
    card: CardView; source: DragSource; plan: DragPlan; dragging: boolean; timer: number | null; overKey: string;
  } | null>(null);

  const zoneKey = (z: DropZone | null) => z ? (z.kind === 'void' ? 'void' : z.kind === 'battlefield' ? `bf${z.player}` : `${z.kind}${z.id}`) : '';

  const finish = useCallback(() => {
    const g = gesture.current; if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);
    try { if (g.el.hasPointerCapture(g.pointerId)) g.el.releasePointerCapture(g.pointerId); } catch { /* element gone */ }
    document.body.style.userSelect = '';
    gesture.current = null;
  }, []);

  const settle = useCallback(() => { setPhase('idle'); setPlan(null); setGhost(null); setOver(null); optsRef.current.onDragEnd?.(); }, []);

  /** Snap the ghost back to where it came from, then go idle. */
  const snapBack = useCallback((ox: number, oy: number) => {
    setPhase('returning'); setOver(null);
    if (optsRef.current.reducedMotion) { x.set(ox); y.set(oy); settle(); return; }
    const ax = animate(x, ox, SPRING); const ay = animate(y, oy, SPRING);
    let done = 0; const one = () => { if (++done === 2) settle(); };
    ax.then(one); ay.then(one);
  }, [x, y, settle]);

  const startDrag = useCallback(() => {
    const g = gesture.current; if (!g || g.dragging) return;
    g.dragging = true;
    try { g.el.setPointerCapture(g.pointerId); } catch { /* pointer already gone */ }
    document.body.style.userSelect = 'none';
    window.getSelection()?.removeAllRanges();
    setPhase('dragging'); setPlan(g.plan); setGhost({ w: g.w, h: g.h, ox: g.ox, oy: g.oy, card: g.card, source: g.source });
    optsRef.current.onDragStart?.(g.plan);
  }, []);

  const cancel = useCallback(() => {
    const g = gesture.current; if (!g) return;
    const wasDragging = g.dragging; const { ox, oy } = g;
    finish();
    if (wasDragging) snapBack(ox, oy); else settle();
  }, [finish, snapBack, settle]);

  // Window-level listeners for the active gesture (pointer capture keeps them flowing even off-element).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current; if (!g || e.pointerId !== g.pointerId) return;
      const dx = e.clientX - g.startX; const dy = e.clientY - g.startY;
      if (!g.dragging) {
        if (e.pointerType === 'mouse' ? Math.hypot(dx, dy) >= SLOP : Math.hypot(dx, dy) >= SLOP * 2) {
          if (e.pointerType === 'mouse') startDrag();
          else { finish(); setPhase('idle'); return; } // touch moved before the long press: it was a scroll / flick, not a drag
        } else return;
      }
      x.set(e.clientX - g.grabX); y.set(e.clientY - g.grabY);
      const { zone, effect } = zoneFor(g.plan, e.clientX, e.clientY);
      const key = effect.kind === 'none' ? (zone.kind === 'void' ? '' : `x:${zoneKey(zone)}`) : zoneKey(zone);
      if (key !== g.overKey) { g.overKey = key; setOver(effect.kind === 'none' ? null : zone); }
    };
    const onUp = (e: PointerEvent) => {
      const g = gesture.current; if (!g || e.pointerId !== g.pointerId) return;
      if (!g.dragging) { finish(); setPhase('idle'); return; } // a click: leave it to the element's onClick
      // swallow the click that follows a drag
      const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 80);
      const { zone, effect } = zoneFor(g.plan, e.clientX, e.clientY);
      const { ox, oy, plan: p } = g;
      finish();
      if (effect.kind !== 'none') { optsRef.current.onDrop(p, zone, effect, { x: e.clientX, y: e.clientY }); settle(); return; }
      if (zone.kind !== 'void' || p.illegal) optsRef.current.onIllegal(p, zone, effect.reason);
      snapBack(ox, oy);
    };
    const onCancel = (e: PointerEvent) => { const g = gesture.current; if (g && e.pointerId === g.pointerId) cancel(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && gesture.current) { e.stopImmediatePropagation(); e.preventDefault(); cancel(); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel); window.removeEventListener('keydown', onKey, true); };
  }, [x, y, startDrag, finish, cancel, snapBack, settle]);

  useEffect(() => () => { const g = gesture.current; if (g?.timer) window.clearTimeout(g.timer); }, []);

  /** Props for a draggable card element. */
  const bind = useCallback((source: DragSource, card: CardView): DragBindProps => ({
    'data-draggable': '',
    style: { touchAction: 'none' },
    onPointerDown: (e) => {
      if (e.button !== 0 || gesture.current || phase === 'returning') return;
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      const p = optsRef.current.planFor(source);
      if (!p) return;
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      const w = el.offsetWidth || r.width; const h = Math.round(w * 680 / 488);
      const ox = r.left + (r.width - w) / 2; const oy = r.top + (r.height - h) / 2;
      const grabX = Math.min(Math.max(e.clientX - ox, 0), w); const grabY = Math.min(Math.max(e.clientY - oy, 0), h);
      x.set(ox); y.set(oy);
      gesture.current = { pointerId: e.pointerId, el, startX: e.clientX, startY: e.clientY, grabX, grabY, w, h, ox, oy, card, source, plan: p, dragging: false, timer: null, overKey: '' };
      setPhase('pending');
      if (e.pointerType !== 'mouse') gesture.current.timer = window.setTimeout(() => { if (gesture.current && !gesture.current.dragging) startDrag(); }, LONG_PRESS);
    },
  }), [phase, startDrag, x, y]);

  /** Data attribute props for a container drop zone (cards, plates and stack items are found by their own ids). */
  const zone = useCallback((z: DropZone) => ({ 'data-drop-zone': z.kind === 'battlefield' ? `battlefield:${z.player}` : z.kind === 'void' ? 'void' : `${z.kind}:${z.id}` }), []);

  return useMemo(() => ({ phase, plan, ghost, over, x, y, bind, zone, cancel, dragging: phase === 'dragging' }), [phase, plan, ghost, over, x, y, bind, zone, cancel]);
}

export type DragIntent = ReturnType<typeof useDragIntent>;
