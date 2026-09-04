'use client';
// Playback controls for the animation queue: speed, skip, the explain toggle (E) and a small settings popover
// (tutorial reset, reduced-motion note). Sits at the end of the phase strip.
import clsx from 'clsx';
import { FastForward, Settings2, Sparkles } from 'lucide-react';
import { Button, IconButton, Kbd, Popover, Segmented } from '@/components/ui';
import type { Playback } from '@/lib/game/store';
import styles from './table.module.css';

export interface PlaybackBarProps {
  playback: Playback;
  settled: boolean;
  pending: number;
  onSpeed: (s: number) => void;
  onSkip: () => void;
  onExplain: (on: boolean) => void;
  onResetTutorial: () => void;
  tutorialOff: boolean;
  onTutorialOff: (off: boolean) => void;
}

type SpeedKey = '0.5' | '1' | '2' | '4';

export function PlaybackBar({ playback, settled, pending, onSpeed, onSkip, onExplain, onResetTutorial, tutorialOff, onTutorialOff }: PlaybackBarProps) {
  const speedKey = (String(playback.speed) as SpeedKey);
  return (
    <div className={styles.playback} data-testid="playback" data-settled={settled ? 'true' : 'false'} data-rushing={playback.rushing ? 'true' : undefined}>
      {!settled && <span className={styles.catching} role="status" aria-live="off">{playback.paused ? 'paused' : playback.rushing ? 'catching up · 4×' : `${pending} to play`}</span>}
      <Segmented size="sm" label="Playback speed" value={['0.5', '1', '2', '4'].includes(speedKey) ? speedKey : '1'} onChange={v => onSpeed(Number(v))} options={[{ value: '0.5', label: '½×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
      <Button size="sm" variant="quiet" icon={<FastForward size={13} />} onClick={onSkip} disabled={settled && !playback.paused} title="Skip the animation and show the current state" data-testid="skip">Skip</Button>
      <button type="button" className={clsx(styles.explainBtn, playback.explain && styles.explainOn)} aria-pressed={playback.explain} onClick={() => onExplain(!playback.explain)} title="Explain: inline rule chips next to every animation, at half speed (E)" data-testid="explain-key">
        <Sparkles size={13} aria-hidden /> Explain <Kbd>E</Kbd>
      </button>
      <Popover trigger={<IconButton size="sm" label="Table settings"><Settings2 size={14} /></IconButton>} placement="bottom-end">
        <div className={styles.settings} data-testid="table-settings">
          <div className={styles.settingsTitle}>Table settings</div>
          <label className={styles.settingsRow}><input type="checkbox" checked={!tutorialOff} onChange={e => onTutorialOff(!e.target.checked)} /> Show tutorial tips</label>
          <Button size="sm" variant="quiet" onClick={onResetTutorial} data-testid="tutorial-reset">Reset tutorial</Button>
          <p className="faint small">{playback.reducedMotion ? 'Reduced motion is on: changes apply instantly.' : 'Animations follow your speed setting; the system "reduce motion" preference disables them.'}</p>
        </div>
      </Popover>
    </div>
  );
}
