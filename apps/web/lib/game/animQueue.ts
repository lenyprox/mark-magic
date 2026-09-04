'use client';
// Drains the game's typed events into the view the DOM renders (`shownView`), one timed batch at a time, so the
// table can animate each change instead of snapping to the worker's latest view. The pure parts (durations, batching,
// the decision-latency rule) live in @play/anim; the view folding in @play/replay. The queue reads and writes the
// game store through a small host interface so it stays testable and free of React.
import type { GameEvent } from '@engine/events';
import type { PlayerId } from '@engine/state';
import type { ViewState, CardView } from '@play/view';
import { applyEvent, hydrate, indexCards, type ReplayView } from '@play/replay';
import { chipFor, classify, durationFor, involvedInEvent, RUSH_SPEED, shouldRush, stackItemOf, totalDuration } from '@play/anim';
import { playBatchSfx } from '@/lib/audio/sfx';

export interface FxChip { key: string; cr: string; object: number | null; player: PlayerId | null; label: string }
export interface FxPop { key: string; target: { kind: 'object' | 'player'; id: number }; text: string; tone: 'damage' | 'heal' | 'counter' | 'loss' }
export interface Fx {
  /** Changes with every batch; overlays key their animations on it. */
  key: number;
  /** How long the batch plays (ms), for overlays that should linger about as long. */
  duration: number;
  chips: FxChip[];
  pops: FxPop[];
  /** Objects that glow (triggers, activations, resolving sources). */
  glow: number[];
  /** Objects fading out under a state-based action. */
  dying: number[];
  /** Objects mid-flight between zones: rendered static (no live WebGL) until they land. */
  moving: number[];
  /** Objects shaking from damage. */
  hits: number[];
  stackGlow: number | null;
  banner: { turn: number; player: PlayerId } | null;
  step: string | null;
  /** The batch put a triggered ability on the stack / destroyed something by state-based action (tutorial hooks). */
  trigger: boolean;
  death: boolean;
}

export const EMPTY_FX: Fx = { key: 0, duration: 0, chips: [], pops: [], glow: [], dying: [], moving: [], hits: [], stackGlow: null, banner: null, step: null, trigger: false, death: false };

/** How far ahead the backlog estimate looks (enough to pass the 1.2 s sound cut-off without walking 2000 events). */
const BACKLOG_WINDOW = 200;

export interface QueueState {
  events: GameEvent[];
  /** Global index of events[0] (the list is trimmed from the front). */
  eventBase: number;
  /** Global index of the next event to fold into shownView. */
  cursor: number;
  liveView: ViewState | null;
  shownView: ViewState | null;
  speed: number;
  explain: boolean;
  paused: boolean;
  reducedMotion: boolean;
  rushing: boolean;
  settled: boolean;
}

export interface QueueHost {
  read(): QueueState;
  write(patch: Partial<QueueState> & { fx?: Fx }): void;
}

let fxKey = 1;

/** Overlay effects for a batch of events. Rule chips ride along with triggers, deaths and replacements; with `explain` every cited event gets one. */
export function fxFor(batch: GameEvent[], duration: number, explain: boolean): Fx {
  const fx: Fx = { ...EMPTY_FX, key: fxKey++, duration, chips: [], pops: [], glow: [], dying: [], moving: [], hits: [] };
  for (const ev of batch) {
    const kind = classify(ev);
    const inv = involvedInEvent(ev);
    const cr = chipFor(ev);
    const wantsChip = explain ? !!cr && kind !== 'silent' && kind !== 'mana-tap' && kind !== 'untap' : (kind === 'trigger' || kind === 'death' || kind === 'replaced' || kind === 'prevented' || kind === 'counter-spell' || kind === 'fizzle');
    if (cr && wantsChip) fx.chips.push({ key: `${ev.seq}`, cr, object: inv.objects[0] ?? null, player: inv.objects.length ? null : (inv.players[0] ?? null), label: chipLabel(ev) });
    switch (ev.type) {
      case 'damage': {
        const target = ev.targetId !== undefined ? { kind: 'object' as const, id: ev.targetId } : ev.player !== undefined ? { kind: 'player' as const, id: ev.player } : null;
        if (target && ev.amount > 0) { fx.pops.push({ key: `${ev.seq}`, target, text: `−${ev.amount}`, tone: 'damage' }); if (target.kind === 'object') fx.hits.push(target.id); }
        break;
      }
      case 'life': if (ev.delta) fx.pops.push({ key: `${ev.seq}`, target: { kind: 'player', id: ev.player }, text: ev.delta > 0 ? `+${ev.delta}` : `−${-ev.delta}`, tone: ev.delta > 0 ? 'heal' : 'loss' }); break;
      case 'counter': fx.pops.push({ key: `${ev.seq}`, target: { kind: 'object', id: ev.id }, text: `${ev.delta > 0 ? '+' : '−'}${Math.abs(ev.delta)} ${ev.counter}`, tone: 'counter' }); break;
      case 'trigger': case 'activate': fx.glow.push(ev.id); fx.stackGlow = ev.itemId; if (ev.type === 'trigger') fx.trigger = true; break;
      case 'cast': fx.moving.push(ev.id); fx.stackGlow = ev.itemId; break;
      case 'resolve': case 'countered': case 'fizzle': fx.stackGlow = stackItemOf(ev); break;
      case 'sba': if (kind === 'death' && ev.id !== undefined) { fx.dying.push(ev.id); fx.death = true; } break;
      case 'zone-change': if (ev.to === 'battlefield' || ev.to === 'stack' || ev.from === 'battlefield' || ev.from === 'stack') fx.moving.push(ev.id); break;
      case 'turn': fx.banner = { turn: ev.number, player: ev.player }; break;
      case 'step': fx.step = ev.to; break;
      default: break;
    }
  }
  return fx;
}

function chipLabel(ev: GameEvent): string {
  switch (ev.type) {
    case 'trigger': return 'triggers';
    case 'sba': return ev.kind === 'lethal-damage' ? 'lethal damage' : ev.kind === 'zero-toughness' ? 'toughness 0' : ev.kind === 'legend-rule' ? 'legend rule' : 'state-based action';
    case 'replaced': return ev.what;
    case 'prevented': return 'prevented';
    case 'countered': return 'countered';
    case 'fizzle': return 'fizzles';
    case 'cast': return 'cast';
    case 'resolve': return 'resolves';
    case 'draw': return 'draw';
    case 'damage': return ev.combat ? 'combat damage' : 'damage';
    case 'attack': return 'attack';
    case 'block': return 'block';
    case 'zone-change': return ev.reason;
    case 'tap': return ev.tapped ? 'tap' : 'untap';
    case 'step': return ev.to;
    default: return ev.type;
  }
}

export class AnimQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private indexFor: ViewState | null = null;
  private index = new Map<number, CardView>();
  constructor(private host: QueueHost) {}

  private known(live: ViewState | null): Map<number, CardView> {
    if (live !== this.indexFor) { this.indexFor = live; this.index = indexCards(live); }
    return this.index;
  }

  /** New events (already appended to the store) and the authoritative view they lead to. */
  notify(opts: { decision?: boolean } = {}) {
    const s = this.host.read();
    if (opts.decision && !s.rushing && !s.paused) {
      const remaining = totalDuration(s.events.slice(Math.max(0, s.cursor - s.eventBase)), s.speed, s.reducedMotion, s.explain);
      if (shouldRush(remaining)) this.host.write({ rushing: true });
    }
    this.schedule();
  }

  /** Start ticking unless already running or paused. */
  schedule() {
    if (this.timer !== null) return;
    this.tick();
  }

  private tick = () => {
    this.timer = null;
    const s = this.host.read();
    if (s.paused) return;
    const start = s.cursor - s.eventBase;
    if (!s.liveView) return;
    if (start >= s.events.length) {
      // caught up: the worker's view is authoritative (it also fixes anything the replayer does not model)
      if (s.shownView !== s.liveView || !s.settled || s.rushing) this.host.write({ shownView: s.liveView, settled: true, rushing: false, fx: { ...EMPTY_FX, key: fxKey++ } });
      return;
    }
    const speed = s.rushing ? RUSH_SPEED : s.speed;
    const batch: GameEvent[] = []; let duration = 0; let i = Math.max(0, start);
    while (i < s.events.length) {
      const ev = s.events[i++]; batch.push(ev);
      const d = durationFor(ev, speed, s.reducedMotion, s.explain);
      if (d > 0) { duration = d; break; }
    }
    let shown: ReplayView = (s.shownView ?? s.liveView) as ReplayView;
    for (const ev of batch) shown = applyEvent(shown, ev);
    shown = hydrate(shown, this.known(s.liveView));
    const fx = fxFor(batch, duration, s.explain);
    // Sound rides the batch that is about to play; it goes quiet when the queue is racing (see sfx.ts).
    playBatchSfx(batch, { speed, backlogMs: totalDuration(s.events.slice(i, i + BACKLOG_WINDOW), speed, s.reducedMotion, s.explain) });
    this.host.write({ shownView: shown, cursor: s.eventBase + i, settled: false, fx });
    if (duration > 0) this.timer = setTimeout(this.tick, duration);
    else this.tick();
  };

  /** Drop the animation and show the live view now. */
  skip() {
    this.cancel();
    const s = this.host.read();
    this.host.write({ shownView: s.liveView, cursor: s.eventBase + s.events.length, settled: !!s.liveView, rushing: false, paused: false, fx: { ...EMPTY_FX, key: fxKey++ } });
  }

  /** Stop ticking (the timeline takes over shownView). */
  pause() { this.cancel(); this.host.write({ paused: true, settled: false }); }

  /** Continue playing from the current cursor. */
  resume() { this.host.write({ paused: false }); this.schedule(); }

  cancel() { if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; } }
  dispose() { this.cancel(); }
}
