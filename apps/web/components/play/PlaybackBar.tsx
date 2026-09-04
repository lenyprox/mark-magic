'use client';
// Playback controls for the animation queue: speed, skip, the explain toggle (E) and the settings sheet button.
// Sits at the end of the phase strip.
import clsx from 'clsx';
import { FastForward, Settings2, Sparkles } from 'lucide-react';
import { Button, IconButton, Kbd, Segmented } from '@/components/ui';
import type { Playback } from '@/lib/game/store';
import styles from './table.module.css';

export interface PlaybackBarProps {
  playback: Playback;
  settled: boolean;
  pending: number;
  onSpeed: (s: number) => void;
  onSkip: () => void;
  onExplain: (on: boolean) => void;
  onOpenSettings: () => void;
}

type SpeedKey = '0.5' | '1' | '2' | '4';

export function PlaybackBar({ playback, settled, pending, onSpeed, onSkip, onExplain, onOpenSettings }: PlaybackBarProps) {
  const speedKey = (String(playback.speed) as SpeedKey);
  return (
    <div className={styles.playback} data-testid="playback" data-settled={settled ? 'true' : 'false'} data-rushing={playback.rushing ? 'true' : undefined}>
      {!settled && <span className={styles.catching} role="status" aria-live="off">{playback.paused ? 'paused' : playback.rushing ? 'catching up · 4×' : `${pending} to play`}</span>}
      <Segmented size="sm" label="Playback speed" value={['0.5', '1', '2', '4'].includes(speedKey) ? speedKey : '1'} onChange={v => onSpeed(Number(v))} options={[{ value: '0.5', label: '½×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
      <Button size="sm" variant="quiet" icon={<FastForward size={13} />} onClick={onSkip} disabled={settled && !playback.paused} title="Skip the animation and show the current state" data-testid="skip">Skip</Button>
      <button type="button" className={clsx(styles.explainBtn, playback.explain && styles.explainOn)} aria-pressed={playback.explain} onClick={() => onExplain(!playback.explain)} title="Explain: inline rule chips next to every animation, at half speed (E)" data-testid="explain-key">
        <Sparkles size={13} aria-hidden /> Explain <Kbd>E</Kbd>
      </button>
      <IconButton size="sm" label="Table settings" onClick={onOpenSettings} data-testid="table-settings-button"><Settings2 size={14} /></IconButton>
    </div>
  );
}
