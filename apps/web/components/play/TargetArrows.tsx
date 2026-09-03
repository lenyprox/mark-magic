'use client';
// Brass connector lines drawn in an SVG overlay over the table: stack items → their targets, blockers → attackers,
// and the current targeting source → its picks. Endpoints are located by data attributes on the table.
import { useEffect, useState, type RefObject } from 'react';
import type { TargetRef } from '@engine/state';
import styles from './table.module.css';

export interface Connector { from: { kind: 'object' | 'stack'; id: number }; to: TargetRef; tone?: 'brass' | 'danger' | 'info' }

function find(root: HTMLElement, ref: { kind: string; id: number }): HTMLElement | null {
  const sel = ref.kind === 'player' ? `[data-player-id="${ref.id}"]` : ref.kind === 'stack' ? `[data-stack-id="${ref.id}"]` : `[data-obj-id="${ref.id}"]`;
  return root.querySelector<HTMLElement>(sel);
}

export function TargetArrows({ rootRef, connectors, version }: { rootRef: RefObject<HTMLElement | null>; connectors: Connector[]; version: unknown }) {
  const [lines, setLines] = useState<{ key: string; x1: number; y1: number; x2: number; y2: number; tone: string }[]>([]);
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const rr = root.getBoundingClientRect();
      const out: typeof lines = [];
      for (const c of connectors) {
        const a = find(root, c.from); const b = find(root, c.to);
        if (!a || !b) continue;
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
        if (!ra.width || !rb.width) continue;
        out.push({ key: `${c.from.kind}${c.from.id}-${c.to.kind}${c.to.id}`, x1: ra.left + ra.width / 2 - rr.left, y1: ra.top + ra.height / 2 - rr.top, x2: rb.left + rb.width / 2 - rr.left, y2: rb.top + rb.height / 2 - rr.top, tone: c.tone ?? 'brass' });
      }
      setLines(out);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    schedule();
    const ro = new ResizeObserver(schedule); ro.observe(root);
    window.addEventListener('scroll', schedule, true);
    const t = setTimeout(schedule, 350); // after enter animations settle
    return () => { ro.disconnect(); window.removeEventListener('scroll', schedule, true); clearTimeout(t); if (raf) cancelAnimationFrame(raf); };
  }, [rootRef, connectors, version]);
  if (!lines.length) return null;
  return (
    <svg className={styles.arrows} aria-hidden>
      <defs>
        <marker id="arrow-brass" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--brass-1)" /></marker>
        <marker id="arrow-danger" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--danger)" /></marker>
        <marker id="arrow-info" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--info)" /></marker>
      </defs>
      {lines.map(l => {
        const mx = (l.x1 + l.x2) / 2; const my = (l.y1 + l.y2) / 2; const dx = l.x2 - l.x1; const dy = l.y2 - l.y1; const len = Math.hypot(dx, dy) || 1;
        const cx = mx - dy / len * Math.min(60, len * 0.18); const cy = my + dx / len * Math.min(60, len * 0.18);
        return <path key={l.key} className={styles.arrow} data-tone={l.tone} d={`M${l.x1},${l.y1} Q${cx},${cy} ${l.x2},${l.y2}`} markerEnd={`url(#arrow-${l.tone})`} />;
      })}
    </svg>
  );
}
