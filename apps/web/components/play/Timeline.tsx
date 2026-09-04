'use client';
// The timeline rail: a scrubber over the event window that sets the shown view through the replayer (keyframes
// every 25 events). Scrubbing is disabled while a decision is pending unless the table is paused.
import { useMemo } from 'react';
import clsx from 'clsx';
import { Pause, Play, Radio, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import type { GameEvent } from '@engine/events';
import type { PlayerId } from '@engine/state';
import type { ViewState } from '@play/view';
import { describeEvent } from '@play/anim';
import { Button, IconButton, Kbd } from '@/components/ui';
import { STEP_LABELS } from '@/lib/game/ui';
import styles from './table.module.css';

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
  return (
    <div className={styles.timeline} data-testid="timeline" data-paused={paused ? 'true' : 'false'} data-locked={locked ? 'true' : 'false'}>
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
        <p className="faint small">Keyframes every 25 events keep scrubbing cheap; hidden cards show as blanks until they become public. <Kbd>E</Kbd> toggles inline rule chips.</p>
      </div>
    </div>
  );
}
