// Capability detection and the frame-time quality probe.

export type Quality = 'high' | 'medium';
export type QualitySetting = Quality | 'auto';

let webgl2Cache: boolean | null = null;

/** True when the browser can create a WebGL2 context (cached; false during SSR). */
export function hasWebGL2(): boolean {
  if (webgl2Cache != null) return webgl2Cache;
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    webgl2Cache = !!gl;
    if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); ext?.loseContext(); }
  } catch { webgl2Cache = false; }
  return webgl2Cache;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Subscribe to reduced-motion changes; returns an unsubscribe. */
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const h = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', h);
  return () => mq.removeEventListener('change', h);
}

/**
 * Collects frame times for roughly the first second of active rendering and decides a tier:
 * if the 75th percentile is above the budget (14 ms) the renderer drops to `medium`.
 */
export class QualityProbe {
  private samples: number[] = [];
  private startedAt = 0;
  decided: Quality | null = null;
  constructor(private readonly budgetMs = 14, private readonly windowMs = 1000, private readonly minSamples = 20) {}
  /** Feed one frame's CPU+submit time (ms). Returns the decided tier once it's known. */
  sample(frameMs: number, now: number): Quality | null {
    if (this.decided) return this.decided;
    if (!this.startedAt) this.startedAt = now;
    this.samples.push(frameMs);
    if (now - this.startedAt >= this.windowMs && this.samples.length >= this.minSamples) {
      const sorted = [...this.samples].sort((a, b) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      this.decided = p75 > this.budgetMs ? 'medium' : 'high';
    }
    return this.decided;
  }
}

/** Device pixel ratio cap per tier. */
export function dprFor(q: Quality): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(dpr, q === 'high' ? 2 : 1.25);
}

/** requestIdleCallback with a setTimeout fallback. */
export function idle(cb: () => void, timeout = 1500): () => void {
  if (typeof window === 'undefined') return () => {};
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) { const id = w.requestIdleCallback(cb, { timeout }); return () => w.cancelIdleCallback?.(id); }
  const id = window.setTimeout(cb, 50);
  return () => window.clearTimeout(id);
}
