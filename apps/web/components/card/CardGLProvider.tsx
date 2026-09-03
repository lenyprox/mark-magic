'use client';
// Mounts the shared full-viewport canvases (`base` under dialogs, `overlay` above them) and hands out
// card registrations. Renderers are created lazily on first use so children can register from their own
// effects (which run before the provider's).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CardGL, type CardHandle, type CardSpec, type RendererStats, type Tuning } from '@/lib/gl/renderer';
import { hasWebGL2, type QualitySetting } from '@/lib/gl/support';
import styles from './CardGLProvider.module.css';

export type CardLayer = 'base' | 'overlay';

export interface CardGLContextValue {
  /** false when WebGL2 is unavailable (Card3D falls back to CSS). null while unknown (SSR / first paint). */
  supported: boolean | null;
  register(layer: CardLayer, anchor: HTMLElement, spec: CardSpec): CardHandle | null;
  renderer(layer: CardLayer): CardGL | null;
  tuning: Tuning;
  setTuning(patch: Partial<Tuning>): void;
  quality: QualitySetting;
  setQuality(q: QualitySetting): void;
  subscribeStats(cb: (s: RendererStats) => void): () => void;
  enableDeviceOrientation(): Promise<boolean>;
}

const CardGLContext = createContext<CardGLContextValue | null>(null);

export function useCardGL(): CardGLContextValue | null {
  return useContext(CardGLContext);
}

const DEFAULT_TUNING: Tuning = { relief: 1, foil: 1, glare: 1, tiltScale: 1, radius: 0.046 };

export function CardGLProvider({ children, quality: initialQuality = 'auto', tuning: initialTuning }: { children: ReactNode; quality?: QualitySetting; tuning?: Partial<Tuning> }) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const renderers = useRef<{ base: CardGL | null; overlay: CardGL | null }>({ base: null, overlay: null });
  const statsSubs = useRef(new Set<(s: RendererStats) => void>());
  const [supported, setSupported] = useState<boolean | null>(null);
  const [tuning, setTuningState] = useState<Tuning>({ ...DEFAULT_TUNING, ...initialTuning });
  const [quality, setQualityState] = useState<QualitySetting>(initialQuality);
  const tuningRef = useRef(tuning);
  const qualityRef = useRef(quality);

  useEffect(() => { setSupported(hasWebGL2()); }, []);

  const getRenderer = useCallback((layer: CardLayer, create: boolean): CardGL | null => {
    const existing = renderers.current[layer];
    if (existing || !create) return existing;
    if (!hasWebGL2()) return null;
    const canvas = (layer === 'base' ? baseRef : overlayRef).current;
    if (!canvas) return null;
    const r = new CardGL(canvas, { quality: qualityRef.current, onStats: (s) => { if (layer === 'base') for (const cb of statsSubs.current) cb(s); } });
    if (!r.supported) return null;
    r.setTuning(tuningRef.current);
    renderers.current[layer] = r;
    return r;
  }, []);

  useEffect(() => () => {
    renderers.current.base?.destroy();
    renderers.current.overlay?.destroy();
    renderers.current = { base: null, overlay: null };
  }, []);

  const value = useMemo<CardGLContextValue>(() => ({
    supported,
    register: (layer, anchor, spec) => getRenderer(layer, true)?.register(anchor, spec) ?? null,
    renderer: (layer) => getRenderer(layer, false),
    tuning,
    setTuning: (patch) => {
      setTuningState(prev => { const next = { ...prev, ...patch }; tuningRef.current = next; return next; });
      renderers.current.base?.setTuning(patch);
      renderers.current.overlay?.setTuning(patch);
    },
    quality,
    setQuality: (q) => {
      qualityRef.current = q;
      setQualityState(q);
      renderers.current.base?.setQuality(q);
      renderers.current.overlay?.setQuality(q);
    },
    subscribeStats: (cb) => { statsSubs.current.add(cb); return () => { statsSubs.current.delete(cb); }; },
    enableDeviceOrientation: async () => {
      const r = getRenderer('base', true);
      if (!r) return false;
      const ok = await r.enableDeviceOrientation();
      if (ok) await renderers.current.overlay?.enableDeviceOrientation();
      return ok;
    },
  }), [supported, tuning, quality, getRenderer]);

  return (
    <CardGLContext.Provider value={value}>
      {children}
      <canvas ref={baseRef} className={styles.base} aria-hidden="true" data-card-layer="base" />
      <canvas ref={overlayRef} className={styles.overlay} aria-hidden="true" data-card-layer="overlay" />
    </CardGLContext.Provider>
  );
}

/** Live renderer stats for the base layer (dev tooling). */
export function useCardGLStats(): RendererStats | null {
  const ctx = useCardGL();
  const [stats, setStats] = useState<RendererStats | null>(null);
  useEffect(() => ctx?.subscribeStats(setStats), [ctx]);
  return stats;
}
