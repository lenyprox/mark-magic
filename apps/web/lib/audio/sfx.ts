'use client';
// Synthesised table sounds (Web Audio, no assets): a soft tick for a draw, a thud for a land, a whoosh for a cast, a
// click for a tap, a chime for a resolve, a thump for damage, a low tone for life loss, a fade for a death, a swish
// for an attack, two notes for a new turn, a ping for a trigger and a buzz for an illegal action. Off by default;
// the settings sheet turns it on and sets the volume. The AudioContext is created and resumed on the first
// pointer-down / key-down (browsers block audio before a gesture). Nothing plays under Playwright
// (`navigator.webdriver`) or while the tab is hidden. `sfxForEvents` maps a batch of game events to the sounds it
// should make; the animation queue calls it when a batch starts.
import type { GameEvent } from '@engine/events';
import { classify } from '@play/anim';

export type SfxName = 'draw' | 'land' | 'cast' | 'tap' | 'resolve' | 'damage' | 'life' | 'death' | 'attack' | 'turn' | 'trigger' | 'error';

export const SFX_NAMES: SfxName[] = ['draw', 'land', 'cast', 'tap', 'resolve', 'damage', 'life', 'death', 'attack', 'turn', 'trigger', 'error'];

/** Playback speeds at or above this play no sounds (the queue is racing). */
export const SFX_MAX_SPEED = 3;
/** Sounds are skipped while the queue is draining more than this much backlog (ms). */
export const SFX_BACKLOG_MS = 1200;
/** Same-sound spacing (ms) so a run of mana taps or two death events do not stutter. */
const MIN_GAP: Partial<Record<SfxName, number>> = { tap: 70, death: 500, turn: 800, life: 250, damage: 90, draw: 60 };
const DEFAULT_GAP = 45;
/** Sounds per batch, in the order they take precedence. */
const PRIORITY: SfxName[] = ['turn', 'attack', 'cast', 'resolve', 'trigger', 'damage', 'death', 'life', 'land', 'draw', 'tap', 'error'];
const MAX_PER_BATCH = 2;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let unlocked = false;
let enabled = false;
let volume = 0.6;
let uninstall: (() => void) | null = null;
const lastAt = new Map<SfxName, number>();

export interface SfxConfig { enabled: boolean; /** 0–100 */ volume: number }

/** Apply the persisted settings (called whenever they change). */
export function configureSfx(cfg: SfxConfig) {
  enabled = cfg.enabled;
  volume = Math.min(1, Math.max(0, cfg.volume / 100));
  if (master && ctx) master.gain.setTargetAtTime(volume * volume, ctx.currentTime, 0.02);
  if (enabled && !uninstall && typeof window !== 'undefined') installUnlock();
}

export function sfxState(): { enabled: boolean; volume: number; unlocked: boolean } { return { enabled, volume: Math.round(volume * 100), unlocked }; }

/** Whether a sound may play right now (setting on, context unlocked, not automated, tab visible). */
export function sfxAllowed(): boolean {
  if (!enabled || !unlocked || !ctx || typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
  if (document.hidden) return false;
  return ctx.state === 'running';
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { return null; }
  master = ctx.createGain();
  master.gain.value = volume * volume;
  master.connect(ctx.destination);
  return ctx;
}

/** Create / resume the context from a user gesture. Returns true once audio can play. */
export function unlockSfx(): boolean {
  const c = ensureContext();
  if (!c) return false;
  if (c.state !== 'running') void c.resume().then(() => { unlocked = c.state === 'running'; }).catch(() => undefined);
  unlocked = c.state === 'running' || unlocked;
  return unlocked;
}

/** Listen for the first pointer-down / key-down to unlock the context; idempotent. */
export function installUnlock(): () => void {
  if (uninstall) return uninstall;
  if (typeof window === 'undefined') return () => undefined;
  const on = () => { unlockSfx(); if (unlocked) remove(); };
  const remove = () => { window.removeEventListener('pointerdown', on, true); window.removeEventListener('keydown', on, true); uninstall = null; };
  window.addEventListener('pointerdown', on, true);
  window.addEventListener('keydown', on, true);
  uninstall = remove;
  return remove;
}

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === c.sampleRate) return noiseBuffer;
  const len = Math.floor(c.sampleRate * 0.6);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

interface ToneOpts { type?: OscillatorType; from: number; to?: number; dur: number; gain: number; attack?: number; at?: number; lowpass?: number }
function tone(c: AudioContext, out: AudioNode, o: ToneOpts) {
  const t0 = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.from, t0);
  if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.dur);
  const g = c.createGain();
  const a = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  let node: AudioNode = osc;
  if (o.lowpass) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lowpass; osc.connect(f); node = f; }
  node.connect(g); g.connect(out);
  osc.start(t0); osc.stop(t0 + o.dur + 0.02);
}

interface BurstOpts { dur: number; gain: number; type?: BiquadFilterType; from: number; to?: number; q?: number; at?: number; attack?: number }
function burst(c: AudioContext, out: AudioNode, o: BurstOpts) {
  const t0 = c.currentTime + (o.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const f = c.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.Q.value = o.q ?? 0.8;
  f.frequency.setValueAtTime(o.from, t0);
  if (o.to !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + o.dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + (o.attack ?? 0.01));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(f); f.connect(g); g.connect(out);
  src.start(t0); src.stop(t0 + o.dur + 0.02);
}

/** The synth patch per sound. */
function synth(c: AudioContext, out: AudioNode, name: SfxName) {
  switch (name) {
    case 'draw': burst(c, out, { dur: 0.035, gain: 0.35, type: 'highpass', from: 3500 }); tone(c, out, { from: 2100, dur: 0.04, gain: 0.12 }); break;
    case 'land': tone(c, out, { from: 120, to: 48, dur: 0.16, gain: 0.9, attack: 0.003 }); burst(c, out, { dur: 0.07, gain: 0.5, type: 'lowpass', from: 420 }); break;
    case 'cast': burst(c, out, { dur: 0.28, gain: 0.55, from: 380, to: 2600, q: 1.1, attack: 0.05 }); break;
    case 'tap': tone(c, out, { type: 'square', from: 1300, dur: 0.014, gain: 0.18, attack: 0.001, lowpass: 3000 }); burst(c, out, { dur: 0.02, gain: 0.2, type: 'highpass', from: 2500 }); break;
    case 'resolve': tone(c, out, { from: 880, dur: 0.32, gain: 0.28, attack: 0.006 }); tone(c, out, { from: 1318.5, dur: 0.36, gain: 0.16, attack: 0.02, at: 0.02 }); break;
    case 'damage': tone(c, out, { from: 95, to: 38, dur: 0.17, gain: 1, attack: 0.002 }); burst(c, out, { dur: 0.09, gain: 0.6, type: 'lowpass', from: 320 }); break;
    case 'life': tone(c, out, { type: 'triangle', from: 165, to: 120, dur: 0.34, gain: 0.5, attack: 0.02 }); break;
    case 'death': tone(c, out, { type: 'sawtooth', from: 320, to: 70, dur: 0.48, gain: 0.32, attack: 0.02, lowpass: 900 }); break;
    case 'attack': burst(c, out, { dur: 0.2, gain: 0.5, from: 1800, to: 500, q: 1.4, attack: 0.03 }); break;
    case 'turn': tone(c, out, { from: 523.25, dur: 0.14, gain: 0.3 }); tone(c, out, { from: 783.99, dur: 0.22, gain: 0.3, at: 0.13 }); break;
    case 'trigger': tone(c, out, { from: 1567.98, dur: 0.16, gain: 0.3, attack: 0.002 }); tone(c, out, { from: 2349.3, dur: 0.1, gain: 0.08, attack: 0.002 }); break;
    case 'error': {
      const t0 = c.currentTime;
      const osc = c.createOscillator(); osc.type = 'square'; osc.frequency.value = 140;
      const trem = c.createOscillator(); trem.frequency.value = 28;
      const depth = c.createGain(); depth.gain.value = 0.5;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      trem.connect(depth); depth.connect(g.gain);
      osc.connect(lp); lp.connect(g); g.connect(out);
      osc.start(t0); trem.start(t0); osc.stop(t0 + 0.22); trem.stop(t0 + 0.22);
      break;
    }
  }
}

/** Play one sound if allowed; returns whether it played. */
export function playSfx(name: SfxName): boolean {
  if (!sfxAllowed() || !ctx || !master) return false;
  const now = performance.now();
  const gap = MIN_GAP[name] ?? DEFAULT_GAP;
  const last = lastAt.get(name) ?? -Infinity;
  if (now - last < gap) return false;
  lastAt.set(name, now);
  try { synth(ctx, master, name); } catch { return false; }
  return true;
}

/** Play the sounds for a batch of events (see `sfxForEvents`) unless the queue is racing. */
export function playBatchSfx(events: readonly GameEvent[], opts: { speed: number; backlogMs: number }): SfxName[] {
  if (!enabled || opts.speed >= SFX_MAX_SPEED || opts.backlogMs > SFX_BACKLOG_MS) return [];
  const names = sfxForEvents(events);
  return names.filter(n => playSfx(n));
}

/** Pure mapping from a batch of events to at most two sounds, in precedence order. */
export function sfxForEvents(events: readonly GameEvent[]): SfxName[] {
  const set = new Set<SfxName>();
  let sawDamage = false;
  for (const ev of events) {
    switch (ev.type) {
      case 'draw': set.add('draw'); break;
      case 'cast': set.add('cast'); break;
      case 'trigger': case 'activate': set.add('trigger'); break;
      case 'resolve': set.add('resolve'); break;
      case 'countered': if (!ev.unlessPaid) set.add('death'); break;
      case 'fizzle': set.add('death'); break;
      case 'damage': if (ev.amount > 0) { set.add('damage'); sawDamage = true; } break;
      case 'life': if (ev.delta < 0) set.add('life'); break;
      case 'attack': if (ev.attackers.length) set.add('attack'); break;
      case 'turn': set.add('turn'); break;
      case 'player-eliminated': set.add('death'); break;
      case 'tap': if (ev.tapped) set.add('tap'); break;
      case 'sba': if (classify(ev) === 'death') set.add('death'); break;
      case 'zone-change': {
        const k = classify(ev);
        if (k === 'play') set.add('land');
        else if (k === 'death') set.add('death');
        break;
      }
      default: break;
    }
  }
  if (sawDamage) set.delete('life');
  const out: SfxName[] = [];
  for (const n of PRIORITY) if (set.has(n)) { out.push(n); if (out.length >= MAX_PER_BATCH) break; }
  return out;
}

/** Test hook: tear down the context (dev tooling / hot reload). */
export function disposeSfx() {
  uninstall?.();
  if (ctx) { void ctx.close().catch(() => undefined); }
  ctx = null; master = null; noiseBuffer = null; unlocked = false; lastAt.clear();
}
