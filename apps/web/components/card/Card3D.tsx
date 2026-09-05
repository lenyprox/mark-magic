'use client';
// A card that upgrades from the plain <img> to the shared WebGL renderer. The CardImage stays in the DOM as
// the layout / accessibility anchor; once the GPU has the texture the picture is hidden and the renderer
// draws in its place (with tilt, relief and the finish's sheen). Falls back to CSS when WebGL2 is missing.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import clsx from 'clsx';
import { CardImage, type CardImageProps } from './CardImage';
import { Card3DCss } from './Card3DCss';
import { useCardGL, type CardLayer } from './CardGLProvider';
import type { CardHandle, CardSpec } from '@/lib/gl/renderer';
import { maskFor, finishCode, defaultFinish } from '@/lib/gl/frames';
import { TILT_PRESETS, type TiltPreset } from '@/lib/gl/interaction';
import { observePrefetch } from '@/lib/gl/normalmap';
import type { QualitySetting } from '@/lib/gl/support';
import styles from './Card3D.module.css';

export type FinishName = 'nonfoil' | 'foil' | 'etched';

export interface Card3DPrinting {
  printingId: string;
  name?: string;
  layout?: string | null;
  frame?: string | null;
  frameEffects?: string[] | null;
  finishes?: string[] | null;
  fullArt?: boolean | null;
  textless?: boolean | null;
  borderColor?: string | null;
  hasBack?: boolean | null;
}

export interface Card3DProps {
  printing: Card3DPrinting;
  face?: 0 | 1;
  finish?: FinishName;
  size?: 'normal' | 'large';
  /** always: live from mount; hover: upgrade on hover / focus; never: static image. */
  live?: 'always' | 'hover' | 'never';
  layer?: CardLayer;
  quality?: QualitySetting;
  interactive?: boolean;
  tapped?: boolean;
  motion?: 'full' | 'reduced' | 'auto';
  /** Tilt preset or explicit max degrees. */
  tilt?: TiltPreset | number;
  className?: string;
  style?: CSSProperties;
  width?: number | string;
  priority?: boolean;
  onActivate?: () => void;
  onFaceChange?: (face: 0 | 1) => void;
  'aria-label'?: string;
  /** Render without its own focus/role/flip button/key handling: for use inside an existing button or link. */
  embedded?: boolean;
  /** Extra attributes for the underlying <img> (view-transition names, data attributes). */
  imgProps?: CardImageProps['imgProps'];
  /** Show the 2.5D scene under the art when this printing has a scene pack (default off). */
  scene?: boolean;
}

const FLIP_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M12 1.5v3h-3M4 14.5v-3h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Card3D(props: Card3DProps) {
  const gl = useCardGL();
  if (!gl || gl.supported === false) return <Card3DCss {...props} />;
  return <Card3DGL {...props} />;
}

function Card3DGL({ printing, face: faceProp, finish: finishProp, size = 'normal', live = 'hover', layer = 'base', quality, interactive = true, tapped, motion = 'auto', tilt, className, style, width, priority, onActivate, onFaceChange, 'aria-label': ariaLabel, embedded = false, imgProps, scene = false }: Card3DProps) {
  const gl = useCardGL()!;
  const wrapRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CardHandle | null>(null);
  const releaseTimer = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [face, setFace] = useState<0 | 1>(faceProp ?? 0);
  const labelId = useId();
  const hasBack = !!printing.hasBack;
  const finish: FinishName = finishProp ?? defaultFinish(printing.finishes);
  const maxTilt = typeof tilt === 'number' ? tilt : TILT_PRESETS[tilt ?? (size === 'large' ? 'hero' : 'default')];
  const mask = useMemo(() => maskFor({ ...printing, face }), [printing, face]);

  useEffect(() => { if (faceProp != null) setFace(faceProp); }, [faceProp]);
  useEffect(() => { if (quality) gl.setQuality(quality); }, [quality, gl]);

  const spec = useMemo<CardSpec>(() => ({
    printingId: printing.printingId, face, finish: finishCode(finish), mask, size, hasBack, maxTilt, tapped,
    reducedMotion: motion === 'auto' ? undefined : motion === 'reduced',
    scene,
  }), [printing.printingId, face, finish, mask, size, hasBack, maxTilt, tapped, motion, scene]);

  // The live spec is read through a ref so `acquire` stays referentially stable across prop changes
  // (a new identity would tear the registration down and lose the flip / settle animations).
  const specRef = useRef(spec);
  const acquire = useCallback(() => {
    if (handleRef.current || !wrapRef.current) return;
    if (releaseTimer.current) { window.clearTimeout(releaseTimer.current); releaseTimer.current = null; }
    const h = gl.register(layer, wrapRef.current, specRef.current);
    if (!h) return;
    handleRef.current = h;
    h.onReady(setReady);
    if (h.ready) setReady(true);
  }, [gl, layer]);

  const release = useCallback(() => {
    const h = handleRef.current;
    if (!h) return;
    handleRef.current = null;
    h.destroy();
    setReady(false);
  }, []);

  // Release a hover-upgraded card once it has settled back to rest (so there's no pop mid-tilt).
  const scheduleRelease = useCallback(() => {
    const h = handleRef.current;
    if (!h || live !== 'hover') return;
    const done = () => { if (releaseTimer.current) { window.clearTimeout(releaseTimer.current); releaseTimer.current = null; } release(); };
    const off = h.onSettle(() => { off(); done(); });
    if (releaseTimer.current) window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => { off(); done(); }, 1200);
  }, [live, release]);

  // Always-live cards register on mount; hover cards prefetch their normal map when near the viewport.
  useEffect(() => {
    if (live === 'always') acquire();
    else if (live === 'never') release();
    return () => { release(); if (releaseTimer.current) { window.clearTimeout(releaseTimer.current); releaseTimer.current = null; } };
  }, [live, acquire, release]);

  useEffect(() => {
    if (live !== 'hover' || !wrapRef.current) return;
    return observePrefetch(wrapRef.current, printing.printingId, face);
  }, [live, printing.printingId, face]);

  // Keep the live registration in sync with prop changes.
  useEffect(() => {
    const prev = specRef.current;
    specRef.current = spec;
    const h = handleRef.current;
    if (!h) return;
    if (prev.face !== spec.face) h.setFace(spec.face);
    const patch: Partial<CardSpec> = {};
    if (prev.finish !== spec.finish) patch.finish = spec.finish;
    if (prev.mask !== spec.mask) patch.mask = spec.mask;
    if (prev.size !== spec.size) patch.size = spec.size;
    if (prev.maxTilt !== spec.maxTilt) patch.maxTilt = spec.maxTilt;
    if (prev.tapped !== spec.tapped) patch.tapped = spec.tapped;
    if (prev.reducedMotion !== spec.reducedMotion) patch.reducedMotion = spec.reducedMotion;
    if (prev.printingId !== spec.printingId) patch.printingId = spec.printingId;
    if (prev.hasBack !== spec.hasBack) patch.hasBack = spec.hasBack;
    if (prev.scene !== spec.scene) patch.scene = spec.scene;
    if (Object.keys(patch).length) h.setSpec(patch);
  }, [spec]);

  const uvFromEvent = (e: PointerEvent<HTMLElement>): [number, number] => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const onPointerEnter = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive || live === 'never') return;
    setHovering(true);
    acquire();
    const [u, v] = uvFromEvent(e);
    handleRef.current?.pointer(u, v);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive || !handleRef.current) return;
    const [u, v] = uvFromEvent(e);
    handleRef.current.pointer(u, v);
  };
  const onPointerLeave = () => {
    if (!interactive) return;
    setHovering(false);
    handleRef.current?.leave();
    if (document.activeElement !== wrapRef.current) scheduleRelease();
  };
  const onFocus = () => {
    if (!interactive || live === 'never') return;
    acquire();
    handleRef.current?.focus(true);
  };
  const onBlur = () => {
    if (!interactive) return;
    handleRef.current?.focus(false);
    if (!hovering) scheduleRelease();
  };

  const flip = useCallback(() => {
    if (!hasBack) return;
    setFace(f => { const next: 0 | 1 = f === 0 ? 1 : 0; onFaceChange?.(next); return next; });
  }, [hasBack, onFaceChange]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const h = handleRef.current;
    const step = 5;
    switch (e.key) {
      case 'ArrowLeft': h?.nudge(0, -step); e.preventDefault(); break;
      case 'ArrowRight': h?.nudge(0, step); e.preventDefault(); break;
      case 'ArrowUp': h?.nudge(step, 0); e.preventDefault(); break;
      case 'ArrowDown': h?.nudge(-step, 0); e.preventDefault(); break;
      case 'Escape': h?.reset(); break;
      case 'f': case 'F': if (hasBack) { flip(); e.preventDefault(); } break;
      case 'Enter': case ' ': if (onActivate) { onActivate(); e.preventDefault(); } break;
    }
  };

  const isLive = ready && live !== 'never';
  const label = ariaLabel ?? printing.name ?? 'Card';

  return (
    <div
      ref={wrapRef}
      className={clsx(styles.card, isLive && styles.live, interactive && styles.interactive, tapped && styles.tapped, className)}
      style={{ ...(width != null ? { width } : null), ...style }}
      tabIndex={interactive && !embedded ? 0 : -1}
      role={embedded ? undefined : onActivate ? 'button' : 'img'}
      aria-labelledby={embedded ? undefined : labelId}
      aria-hidden={embedded || undefined}
      data-printing={printing.printingId}
      data-face={face}
      data-live={isLive ? '' : undefined}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={embedded ? undefined : onKeyDown}
      onClick={embedded ? undefined : onActivate}
    >
      {!embedded && <span id={labelId} className={styles.srOnly}>{label}{hasBack ? `, ${face === 0 ? 'front' : 'back'} face` : ''}{finish !== 'nonfoil' ? `, ${finish}` : ''}</span>}
      <CardImage
        printingId={printing.printingId}
        face={face}
        size={size === 'large' ? 'large' : 'normal'}
        alt=""
        priority={priority}
        className={styles.anchor}
        imgProps={{ ...imgProps, 'aria-hidden': true } as React.ImgHTMLAttributes<HTMLImageElement>}
      />
      {hasBack && interactive && !embedded && (
        <button
          type="button"
          className={styles.flip}
          aria-label={face === 0 ? 'Show back face (F)' : 'Show front face (F)'}
          onClick={(e) => { e.stopPropagation(); flip(); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {FLIP_ICON}
        </button>
      )}
    </div>
  );
}
