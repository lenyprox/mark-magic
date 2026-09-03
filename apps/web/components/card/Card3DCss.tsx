'use client';
// CSS fallback for Card3D when WebGL2 is unavailable (or no provider is mounted): a perspective tilt
// driven by CSS variables plus one blend-mode sheen layer. Same props as Card3D.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import clsx from 'clsx';
import { CardImage } from './CardImage';
import type { Card3DProps } from './Card3D';
import { defaultFinish } from '@/lib/gl/frames';
import { TILT_PRESETS } from '@/lib/gl/interaction';
import { prefersReducedMotion } from '@/lib/gl/support';
import styles from './Card3DCss.module.css';

export function Card3DCss({ printing, face: faceProp, finish: finishProp, size = 'normal', live = 'hover', interactive = true, tapped, motion = 'auto', tilt, className, style, width, priority, onActivate, onFaceChange, 'aria-label': ariaLabel, embedded = false, imgProps }: Card3DProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [face, setFace] = useState<0 | 1>(faceProp ?? 0);
  const [reduced, setReduced] = useState(false);
  const labelId = useId();
  const hasBack = !!printing.hasBack;
  const finish = finishProp ?? defaultFinish(printing.finishes);
  const maxTilt = typeof tilt === 'number' ? tilt : TILT_PRESETS[tilt ?? (size === 'large' ? 'hero' : 'default')];
  const noMotion = motion === 'reduced' || (motion === 'auto' && reduced);

  useEffect(() => { if (faceProp != null) setFace(faceProp); }, [faceProp]);
  useEffect(() => { setReduced(prefersReducedMotion()); }, []);

  const setVars = (u: number, v: number, on: boolean) => {
    const el = ref.current;
    if (!el) return;
    const rx = noMotion ? 0 : -(v - 0.5) * 2 * maxTilt;
    const ry = noMotion ? 0 : (u - 0.5) * 2 * maxTilt;
    el.style.setProperty('--rx', `${on ? rx : 0}deg`);
    el.style.setProperty('--ry', `${on ? ry : 0}deg`);
    el.style.setProperty('--px', `${(on ? u : 0.62) * 100}%`);
    el.style.setProperty('--py', `${(on ? v : 0.3) * 100}%`);
    el.style.setProperty('--hover', on ? '1' : '0');
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!interactive || live === 'never') return;
    const r = ref.current!.getBoundingClientRect();
    setVars((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, true);
  };
  const onLeave = () => setVars(0.5, 0.5, false);

  const flip = useCallback(() => {
    if (!hasBack) return;
    setFace(f => { const next: 0 | 1 = f === 0 ? 1 : 0; onFaceChange?.(next); return next; });
  }, [hasBack, onFaceChange]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if ((e.key === 'f' || e.key === 'F') && hasBack) { flip(); e.preventDefault(); }
    else if ((e.key === 'Enter' || e.key === ' ') && onActivate) { onActivate(); e.preventDefault(); }
  };

  const label = ariaLabel ?? printing.name ?? 'Card';
  return (
    <div
      ref={ref}
      className={clsx(styles.card, styles[finish], live === 'never' && styles.static, tapped && styles.tapped, className)}
      style={{ ...(width != null ? { width } : null), ...style }}
      tabIndex={interactive && !embedded ? 0 : -1}
      role={embedded ? undefined : onActivate ? 'button' : 'img'}
      aria-labelledby={embedded ? undefined : labelId}
      aria-hidden={embedded || undefined}
      data-printing={printing.printingId}
      data-face={face}
      onPointerEnter={onMove}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onFocus={() => setVars(0.5, 0.5, true)}
      onBlur={onLeave}
      onKeyDown={embedded ? undefined : onKeyDown}
      onClick={embedded ? undefined : onActivate}
    >
      {!embedded && <span id={labelId} className={styles.srOnly}>{label}{hasBack ? `, ${face === 0 ? 'front' : 'back'} face` : ''}</span>}
      <div className={styles.tilt}>
        <CardImage printingId={printing.printingId} face={face} size={size === 'large' ? 'large' : 'normal'} alt="" priority={priority} className={styles.img} imgProps={{ ...imgProps, 'aria-hidden': true } as React.ImgHTMLAttributes<HTMLImageElement>} />
        <div className={styles.sheen} aria-hidden="true" />
      </div>
      {hasBack && interactive && !embedded && (
        <button type="button" className={styles.flip} aria-label={face === 0 ? 'Show back face (F)' : 'Show front face (F)'} onClick={(e) => { e.stopPropagation(); flip(); }}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M12 1.5v3h-3M4 14.5v-3h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
    </div>
  );
}
