'use client';
// Table settings persisted in localStorage (`vault.play.settings`): playback speed, reduced motion, the explain
// default, when the pay tray asks, the sound placeholder and the WebGL quality. A tiny external store so every
// component that reads a setting re-renders when the sheet changes it.
import { useSyncExternalStore } from 'react';
import type { AskToPay } from '@play/targeting';
import { clampSpeed } from '@play/anim';
import type { QualitySetting } from '@/lib/gl/support';
import { SPEED_KEY } from './store';

export const SETTINGS_KEY = 'vault.play.settings';

export interface PlaySettings {
  /** Placeholder: there is no sound yet. */
  sound: boolean;
  speed: number;
  /** 'system' follows prefers-reduced-motion; 'on' / 'off' override it. */
  reducedMotion: 'system' | 'on' | 'off';
  /** Explain mode on when a table opens. */
  explain: boolean;
  askToPay: AskToPay;
  glQuality: QualitySetting;
}

export const DEFAULT_SETTINGS: PlaySettings = { sound: false, speed: 1, reducedMotion: 'system', explain: false, askToPay: 'when-ambiguous', glQuality: 'auto' };

let cached: PlaySettings | null = null;
const listeners = new Set<() => void>();

export function readSettings(): PlaySettings {
  if (cached) return cached;
  let stored: Partial<PlaySettings> = {};
  try { const raw = localStorage.getItem(SETTINGS_KEY); if (raw) stored = JSON.parse(raw) as Partial<PlaySettings>; } catch { /* private mode */ }
  let speed = stored.speed;
  if (speed === undefined) { try { const s = localStorage.getItem(SPEED_KEY); if (s != null) speed = Number(s); } catch { /* ignore */ } }
  cached = { ...DEFAULT_SETTINGS, ...stored, speed: clampSpeed(speed ?? 1) };
  return cached;
}

export function writeSettings(patch: Partial<PlaySettings>) {
  const next = { ...readSettings(), ...patch };
  if (patch.speed !== undefined) next.speed = clampSpeed(patch.speed);
  cached = next;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); if (patch.speed !== undefined) localStorage.setItem(SPEED_KEY, String(next.speed)); } catch { /* private mode */ }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => readSettings();
const getServerSnapshot = () => DEFAULT_SETTINGS;

/** The persisted table settings (SSR renders the defaults). */
export function usePlaySettings(): PlaySettings {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
