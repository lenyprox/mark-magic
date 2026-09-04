'use client';
// The game log: engine lines, AI narration and engine notes ("unsimulated text" as engine callouts). Autoscrolls
// while the reader is at the bottom.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { LogLine } from '@/lib/game/store';
import { Callout } from '@/components/ui/Display';
import { STEP_SHORT } from '@/lib/game/ui';
import type { Step } from '@engine/state';
import styles from './table.module.css';

export function LogPanel({ log, className }: { log: LogLine[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'all' | 'engine' | 'ai' | 'note'>('all');
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [log.length, filter]);
  const onScroll = () => { const el = ref.current; if (!el) return; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  const lines = filter === 'all' ? log : log.filter(l => l.kind === filter);
  let lastTurn = -1;
  return (
    <section className={clsx(styles.log, className)} aria-label="Game log">
      <div className={styles.logHead}>
        <span className={styles.logTitle}>Log</span>
        <div className={styles.logFilters} role="group" aria-label="Filter log">
          {(['all', 'engine', 'ai', 'note'] as const).map(f => <button key={f} type="button" className={clsx(styles.logFilter, filter === f && styles.logFilterOn)} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'note' ? 'notes' : f}</button>)}
        </div>
      </div>
      <div ref={ref} className={styles.logBody} onScroll={onScroll} role="log" aria-live="off">
        {lines.map(l => {
          const turnHead = l.turn !== lastTurn; lastTurn = l.turn;
          return (
            <div key={l.index}>
              {turnHead && <div className={styles.logTurn}>Turn {l.turn}</div>}
              {l.kind === 'note' ? (
                <Callout variant="engine" className={styles.logNote}>{l.line}</Callout>
              ) : (
                <div className={clsx(styles.logLine, l.kind === 'ai' && styles.logAi)}>
                  <span className={styles.logStep} aria-hidden>{STEP_SHORT[l.step as Step] ?? ''}</span>
                  <span className={styles.logText}>{l.line}</span>
                </div>
              )}
            </div>
          );
        })}
        {!lines.length && <div className="faint small" style={{ padding: 12 }}>Nothing yet.</div>}
      </div>
    </section>
  );
}
