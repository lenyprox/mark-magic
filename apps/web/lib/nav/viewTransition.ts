'use client';
// View Transitions helper: wraps a navigation so the browser cross-fades and moves shared elements
// (`view-transition-name: card-{printingId}`) between the grid and the detail hero.

export function cardTransitionName(printingId: string): string {
  return `card-${printingId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

type DocWithVT = Document & { startViewTransition?: (cb: () => void | Promise<void>) => { finished: Promise<void> } };

export function withViewTransition(update: () => void | Promise<void>, opts: { reducedMotion?: boolean } = {}): void {
  const doc = typeof document !== 'undefined' ? (document as DocWithVT) : null;
  if (!doc?.startViewTransition || opts.reducedMotion) { void update(); return; }
  document.documentElement.dataset.vt = '1';
  const t = doc.startViewTransition(update);
  t.finished.finally(() => { delete document.documentElement.dataset.vt; });
}
