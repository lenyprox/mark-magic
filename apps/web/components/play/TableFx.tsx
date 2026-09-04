'use client';
// Transient overlays driven by the animation queue's `fx`: the turn banner, damage / life / counter number pops
// anchored to cards and plates, and inline rule chips next to the objects an event touches. Anchors are located by
// the same data attributes the connector overlay uses; everything here is pointer-transparent.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import type { PlayerId } from '@engine/state';
import type { Fx } from '@/lib/game/animQueue';
import { RuleChip } from '@/components/rules/RuleChip';
import styles from './table.module.css';

function anchorRect(root: HTMLElement, target: { kind: 'object' | 'player'; id: number }): { x: number; y: number; w: number; h: number } | null {
  const el = root.querySelector<HTMLElement>(target.kind === 'player' ? `[data-player-id="${target.id}"]` : `[data-obj-id="${target.id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect(); const rr = root.getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height };
}

interface Placed<T> { item: T; x: number; y: number; w: number; h: number }

function usePlaced<T>(rootRef: RefObject<HTMLElement | null>, key: number, items: T[], target: (t: T) => { kind: 'object' | 'player'; id: number } | null): Placed<T>[] {
  const [placed, setPlaced] = useState<Placed<T>[]>([]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !items.length) { setPlaced([]); return; }
    let raf = requestAnimationFrame(() => {
      raf = 0;
      const out: Placed<T>[] = [];
      for (const item of items) { const t = target(item); if (!t) continue; const r = anchorRect(root, t); if (r) out.push({ item, ...r }); }
      setPlaced(out);
    });
    return () => { if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rootRef]);
  return placed;
}

export function TurnBanner({ fx, viewer, names, reducedMotion }: { fx: Fx; viewer: PlayerId; names: string[]; reducedMotion: boolean }) {
  const [show, setShow] = useState<{ key: number; turn: number; player: PlayerId } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!fx.banner) return;   // later batches leave a showing banner to its own timer
    const b = { key: fx.key, ...fx.banner };
    setShow(b);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setShow(s => (s?.key === b.key ? null : s)); }, reducedMotion ? 600 : Math.max(700, fx.duration + 400));
  }, [fx.key, fx.banner, fx.duration, reducedMotion]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <AnimatePresence>
      {show && (
        <motion.div key={show.key} className={clsx(styles.banner, show.player === viewer ? styles.bannerMine : styles.bannerTheirs)} data-testid="turn-banner" role="status" aria-live="polite"
          initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 14, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, transition: { duration: reducedMotion ? 0 : 0.25 } }} transition={{ duration: reducedMotion ? 0 : 0.28, ease: [0.2, 0.8, 0.2, 1] }}>
          <span className={styles.bannerTurn}>Turn {show.turn}</span>
          <span className={styles.bannerWho}>{show.player === viewer ? 'Your turn' : `${names[show.player] ?? 'Opponent'}'s turn`}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function NumberPops({ fx, rootRef, reducedMotion }: { fx: Fx; rootRef: RefObject<HTMLElement | null>; reducedMotion: boolean }) {
  const placed = usePlaced(rootRef, fx.key, fx.pops, p => p.target);
  return (
    <div className={styles.fxLayer} aria-hidden>
      <AnimatePresence>
        {placed.map(({ item, x, y, w }, i) => (
          <motion.span key={`${fx.key}-${item.key}`} className={clsx(styles.pop, styles[`pop_${item.tone}` as keyof typeof styles])} style={{ left: x + w / 2, top: y + 10 + i * 4 }}
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 8, scale: 0.7 }} animate={reducedMotion ? { opacity: 1 } : { opacity: [0, 1, 1, 0], y: [8, -6, -18, -30], scale: [0.7, 1.15, 1, 0.95] }} exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.001 : 0.9, times: [0, 0.2, 0.7, 1], ease: 'easeOut' }}>
            {item.text}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function EventChips({ fx, rootRef, explain, reducedMotion }: { fx: Fx; rootRef: RefObject<HTMLElement | null>; explain: boolean; reducedMotion: boolean }) {
  const placed = usePlaced(rootRef, fx.key, fx.chips, c => (c.object !== null ? { kind: 'object', id: c.object } : c.player !== null ? { kind: 'player', id: c.player } : null));
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    const t = setTimeout(() => setVisible(false), reducedMotion ? 900 : Math.max(explain ? 1400 : 900, fx.duration + (explain ? 900 : 500)));
    return () => clearTimeout(t);
  }, [fx.key, fx.duration, explain, reducedMotion]);
  return (
    <div className={styles.fxLayer} aria-hidden data-testid="event-chips">
      <AnimatePresence>
        {visible && placed.map(({ item, x, y, w }, i) => (
          <motion.div key={`${fx.key}-${item.key}`} className={styles.chipFloat} style={{ left: x + w / 2, top: y - 6 - i * 18 }}
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 6, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, transition: { duration: reducedMotion ? 0 : 0.18 } }} transition={{ duration: reducedMotion ? 0 : 0.2 }}>
            <RuleChip cr={item.cr} label={item.label} size="sm" inert />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
