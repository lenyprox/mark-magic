'use client';
// The timeline rail: a scrubber over the event window that sets the shown view through the replayer (keyframes
// every 25 events), the event that is playing now, and a running log of the window in plain words. Scrubbing is
// disabled while a decision is pending unless the table is paused. The log is a `role="log"` list; past ~200
// events it is virtualised (only the visible rows exist in the DOM), which keeps a long four-player game cheap.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Pause, Play, Radio, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import type { GameEvent } from '@engine/events';
import type { PlayerId } from '@engine/state';
import type { ViewState } from '@play/view';
import { describeEvent } from '@play/anim';
import { Button, IconButton, Kbd } from '@/components/ui';
import { STEP_LABELS } from '@/lib/game/ui';
import styles from './table.module.css';

/** Rows above this count are virtualised. */
export const VIRTUALIZE_AT = 200;
const ROW_H = 26;

export interface TimelineProps {
  events: GameEvent[];
  eventBase: number;
  cursor: number;
  paused: boolean;
  settled: boolean;
  decisionPending: boolean;
  view: ViewState;
  onScrub: (n: number) => void;
  onPause: () => void;
  onPlay: () => void;
  onLive: () => void;
}

export function Timeline({ events, eventBase, cursor, paused, settled, decisionPending, view, onScrub, onPause, onPlay, onLive }: TimelineProps) {
  const min = eventBase; const max = eventBase + events.length;
  const pos = Math.max(min, Math.min(max, cursor));
  const locked = decisionPending && !paused;
  const pname = useMemo(() => (p: PlayerId) => view.players[p]?.name ?? `Player ${p + 1}`, [view]);
  const current = pos > min ? events[pos - 1 - eventBase] : null;
  const live = pos >= max && !paused;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = events.length > VIRTUALIZE_AT;
  const rows = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    enabled: virtual,
  });
  const stick = useRef(true);
  const onScroll = useCallback(() => { const el = scrollRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }, []);
  // Follow the tail while the reader has not scrolled away.
  useEffect(() => {
    if (!stick.current) return;
    if (virtual) rows.scrollToIndex(Math.max(0, events.length - 1), { align: 'end' });
    else { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length, virtual]);

  const row = (i: number) => {
    const ev = events[i];
    const index = eventBase + i;
    const played = index < pos;
    return (
      <button type="button" key={ev.seq} className={clsx(styles.tlRow, !played && styles.tlRowFuture, index === pos - 1 && styles.tlRowNow)}
        disabled={locked} data-testid="timeline-row" data-seq={ev.seq} onClick={() => onScrub(index + 1)}
        aria-label={`Event ${index + 1}, turn ${ev.turn}: ${describeEvent(ev, pname) || ev.type}. Scrub here.`}>
        <span className={styles.tlRowStep} aria-hidden>T{ev.turn}</span>
        <span className={styles.tlRowText} aria-hidden>{describeEvent(ev, pname) || ev.type}</span>
      </button>
    );
  };

  return (
    <div className={styles.timeline} data-testid="timeline" data-paused={paused ? 'true' : 'false'} data-locked={locked ? 'true' : 'false'} data-virtual={virtual ? 'true' : 'false'}>
      <div className={styles.railHead}>
        <span className={styles.railTitle}>Timeline</span>
        <span className="faint small">event <b className="mono" data-testid="timeline-cursor">{pos}</b> of <span className="mono">{max}</span></span>
        {live && settled ? <span className={styles.liveTag}><Radio size={11} aria-hidden /> live</span> : paused ? <span className={styles.pausedTag}>paused</span> : <span className={styles.pausedTag}>playing…</span>}
      </div>
      <div className={styles.timelineBody}>
        <input type="range" className={styles.scrubber} min={min} max={max} step={1} value={pos} disabled={locked || max === min} aria-label="Timeline position" data-testid="timeline-scrubber" onChange={e => onScrub(Number(e.target.value))} />
        <div className={styles.timelineButtons}>
          <IconButton size="sm" label="Jump to start" disabled={locked || pos <= min} onClick={() => onScrub(min)} data-testid="timeline-start"><SkipBack size={14} /></IconButton>
          <IconButton size="sm" label="Back one event" disabled={locked || pos <= min} onClick={() => onScrub(pos - 1)} data-testid="timeline-back"><StepBack size={14} /></IconButton>
          {paused ? (
            <IconButton size="sm" label="Play from here" disabled={pos >= max} onClick={onPlay} data-testid="timeline-play"><Play size={14} /></IconButton>
          ) : (
            <IconButton size="sm" label="Pause" onClick={onPause} data-testid="timeline-pause"><Pause size={14} /></IconButton>
          )}
          <IconButton size="sm" label="Forward one event" disabled={locked || pos >= max} onClick={() => onScrub(pos + 1)} data-testid="timeline-forward"><StepForward size={14} /></IconButton>
          <IconButton size="sm" label="Jump to end" disabled={locked || pos >= max} onClick={() => onScrub(max)} data-testid="timeline-end"><SkipForward size={14} /></IconButton>
          <Button size="sm" variant={live ? 'quiet' : 'primary'} disabled={live && settled} onClick={onLive} data-testid="timeline-live" icon={<Radio size={13} />}>Live</Button>
        </div>
        {locked && <p className={clsx('faint', 'small', styles.timelineNote)}>A decision is pending — press pause to scrub back through what happened. Playback stays interactive only at the live position.</p>}
        <div className={styles.timelineNow} data-testid="timeline-now">
          {current ? (
            <>
              <span className={styles.evStepTag}>T{current.turn} · {STEP_LABELS[current.step] ?? current.step}</span>
              <p className={styles.evText}>{describeEvent(current, pname) || current.type}</p>
            </>
          ) : <p className="faint small">Before the first event.</p>}
        </div>
        <div ref={scrollRef} className={styles.tlLog} role="log" aria-label="Event log" aria-live="off" onScroll={onScroll} data-testid="timeline-log">
          {!events.length && <p className="faint small">No events yet.</p>}
          {virtual ? (
            <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
              {rows.getVirtualItems().map(v => (
                <div key={v.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)` }}>{row(v.index)}</div>
              ))}
            </div>
          ) : events.map((_, i) => row(i))}
        </div>
        <p className="faint small">Keyframes every 25 events keep scrubbing cheap; hidden cards show as blanks until they become public. <Kbd>E</Kbd> toggles inline rule chips.</p>
      </div>
    </div>
  );
}
