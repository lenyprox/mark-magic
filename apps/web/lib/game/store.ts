'use client';
// Zustand store mirroring the worker's view of the game plus the pending decision, log, AI reasoning and analysis.
// Two views live here: `liveView` is what the current decision is about (the worker's latest), `shownView` is what
// the DOM renders — the animation queue walks it forward through the typed events; `view` is an alias of shownView
// for the components that only read. Interaction is enabled when the two agree (`settled`).
import { create } from 'zustand';
import type { Decision, PlayerId } from '@engine/state';
import type { GameEvent } from '@engine/events';
import type { Reasoning } from '@ai/ai';
import type { AnalysisReport, McRequest, TrialResult } from '@analysis/types';
import type { DeckPayload, StartOptions, UndoAvailability, WorkerToMain } from '@play/protocol';
import type { ViewState } from '@play/view';
import type { RecordedAnswer } from '@engine/agents/deferred';
import { hydrate, indexCards, Replayer } from '@play/replay';
import { clampSpeed } from '@play/anim';
import { GameClient } from './client';
import { AnimQueue, EMPTY_FX, type Fx } from './animQueue';

export interface LogLine { index: number; line: string; turn: number; step: string; kind: 'engine' | 'ai' | 'note' }
export type GameStatus = 'idle' | 'starting' | 'running' | 'finished' | 'error';
export type AnalysisPhase = 'idle' | 'quick' | 'update' | 'done';

/** Keep this many events (the timeline window); older ones are dropped in chunks and the replayer re-based. */
export const EVENT_CAP = 2000;
const TRIM_CHUNK = 500;
export const SPEED_KEY = 'vault.play.speed';

export interface Playback {
  /** 0.5 – 4 (× the mapping-table durations). */
  speed: number;
  /** A skip is in progress (events drain instantly). */
  skipping: boolean;
  /** Global index of the next event shownView will fold in (also the timeline position). */
  cursor: number;
  /** The timeline holds shownView; events accumulate without playing. */
  paused: boolean;
  /** Inline rule chips next to animations, at half speed (key E). */
  explain: boolean;
  /** The decision-latency rule kicked in: the rest of the queue plays at 4×. */
  rushing: boolean;
  reducedMotion: boolean;
}

export interface Pulse { key: number; objects: number[]; players: PlayerId[] }

export interface GameStore {
  client: GameClient | null;
  gameId: string | null;
  status: GameStatus;
  /** Alias of shownView (what the DOM renders). */
  view: ViewState | null;
  liveView: ViewState | null;
  shownView: ViewState | null;
  settled: boolean;
  events: GameEvent[];
  eventBase: number;
  playback: Playback;
  fx: Fx;
  pulse: Pulse | null;
  decision: { requestId: number; decision: Decision } | null;
  /** Whether the worker would accept an undo for the pending decision (and why not). */
  undoAvailable: UndoAvailability | null;
  /** The last refused undo (a counter so the same reason can toast twice). */
  undoRefused: { key: number; reason: string } | null;
  /** An undo is in flight (between the request and the re-asked decision). */
  undoing: boolean;
  log: LogLine[];
  reasoning: Reasoning[];
  analysis: AnalysisReport | null;
  analysisPhase: AnalysisPhase;
  analysisFor: number | null;            // decision requestId the report belongs to
  reruns: Record<string, { identical: boolean; results: TrialResult[] }>;
  winner: PlayerId | null;
  error: string | null;
  decks: DeckPayload[] | null;
  options: StartOptions | null;
  finished: { log: string[]; actions: RecordedAnswer[]; reasoning: Reasoning[]; turns: number } | null;
  start(gameId: string, decks: DeckPayload[], options: StartOptions): Promise<void>;
  answer(answer: unknown): void;
  concede(): void;
  /** Take back the last action (Ctrl+Z); the worker decides whether it is safe. */
  undo(): void;
  setStops: GameClient['setStops'];
  deepen(trials?: number, policy?: 'rollout' | 'ai30'): void;
  rerun(req: McRequest): void;
  dispose(): void;
  // playback
  setSpeed(speed: number): void;
  setExplain(on: boolean): void;
  setReducedMotion(on: boolean): void;
  skip(): void;
  /** Timeline: hold the table at global event index `n`. */
  scrubTo(n: number): void;
  pause(): void;
  /** Play forward from the timeline cursor (or, when caught up, just return to live). */
  play(): void;
  goLive(): void;
  showMe(objects: number[], players: PlayerId[]): void;
}

function classify(line: string): LogLine['kind'] {
  if (/^\s*\[.+ thinks\]/.test(line)) return 'ai';
  if (/unsimulated text/.test(line)) return 'note';
  return 'engine';
}

const initialPlayback = (): Playback => ({ speed: 1, skipping: false, cursor: 0, paused: false, explain: false, rushing: false, reducedMotion: false });

/** Run `flush` at most once per animation frame (falls back to a timer where rAF is missing, e.g. a hidden tab). */
function frameBatcher(flush: () => void) {
  let handle: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => { handle = null; timer = null; flush(); };
  return {
    schedule() {
      if (handle !== null || timer !== null) return;
      if (typeof requestAnimationFrame === 'function') handle = requestAnimationFrame(run);
      else timer = setTimeout(run, 16);
    },
    /** Apply anything pending right now (before a message whose ordering matters). */
    flushNow() {
      if (handle !== null) { cancelAnimationFrame(handle); handle = null; }
      if (timer !== null) { clearTimeout(timer); timer = null; }
      flush();
    },
    cancel() {
      if (handle !== null) { cancelAnimationFrame(handle); handle = null; }
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
  };
}

export const useGameStore = create<GameStore>((set, get) => {
  let replayer: Replayer | null = null;
  const queue = new AnimQueue({
    read() {
      const s = get();
      return { events: s.events, eventBase: s.eventBase, cursor: s.playback.cursor, liveView: s.liveView, shownView: s.shownView, speed: s.playback.speed, explain: s.playback.explain, paused: s.playback.paused, reducedMotion: s.playback.reducedMotion, rushing: s.playback.rushing, settled: s.settled };
    },
    write(patch) {
      set(s => {
        const pb = { ...s.playback };
        if (patch.cursor !== undefined) pb.cursor = patch.cursor;
        if (patch.rushing !== undefined) pb.rushing = patch.rushing;
        if (patch.paused !== undefined) pb.paused = patch.paused;
        const next: Partial<GameStore> = { playback: pb };
        if (patch.shownView !== undefined) { next.shownView = patch.shownView; next.view = patch.shownView; }
        if (patch.settled !== undefined) next.settled = patch.settled;
        if (patch.fx) next.fx = patch.fx;
        return next;
      });
    },
  });

  // The worker streams `view`, `log` and `reasoning` messages far faster than the screen refreshes (a four-seat
  // AI game emits hundreds a second). They are buffered here and committed once per animation frame; the messages
  // whose ordering matters — decision, finished, undo — take the buffer over first so nothing is reordered.
  let pendingEvents: GameEvent[] = [];
  let pendingView: ViewState | null = null;
  let pendingLog: LogLine[] = [];
  let pendingReasoning: Reasoning[] = [];

  const flushSideChannels = () => {
    if (!pendingLog.length && !pendingReasoning.length) return;
    const logs = pendingLog; const reas = pendingReasoning;
    pendingLog = []; pendingReasoning = [];
    set(s => ({ log: logs.length ? [...s.log, ...logs] : s.log, reasoning: reas.length ? [...s.reasoning, ...reas].slice(-200) : s.reasoning }));
  };
  const takeEvents = (): GameEvent[] => { const e = pendingEvents; pendingEvents = []; pendingView = null; return e; };
  const clearPending = () => { pendingEvents = []; pendingView = null; pendingLog = []; pendingReasoning = []; };

  /** Append a message's events, feed the replayer, trim the window, then let the queue play. */
  const ingest = (events: GameEvent[] | undefined, live: ViewState, opts: { decision?: boolean } = {}) => {
    const s = get();
    let all = events?.length ? [...s.events, ...events] : s.events;
    let base = s.eventBase;
    let cursor = s.playback.cursor;
    if (events?.length && replayer) replayer.append(events);
    if (all.length > EVENT_CAP && replayer) {
      const drop = Math.min(TRIM_CHUNK, Math.max(0, cursor - base)); // never drop what has not been shown yet
      if (drop > 0) { all = all.slice(drop); base += drop; replayer.trim(drop); }
    }
    const patch: Partial<GameStore> = { liveView: live, events: all, eventBase: base };
    if (!s.shownView) { patch.shownView = live; patch.view = live; patch.settled = true; cursor = base + all.length; }
    patch.playback = { ...s.playback, cursor };
    set(patch);
    queue.notify(opts);
  };

  const batcher = frameBatcher(() => { flushSideChannels(); const v = pendingView; const e = takeEvents(); if (v) ingest(e, v); });

  return {
    client: null, gameId: null, status: 'idle', view: null, liveView: null, shownView: null, settled: false, events: [], eventBase: 0, playback: initialPlayback(), fx: EMPTY_FX, pulse: null,
    decision: null, undoAvailable: null, undoRefused: null, undoing: false, log: [], reasoning: [], analysis: null, analysisPhase: 'idle', analysisFor: null, reruns: {},
    winner: null, error: null, decks: null, options: null, finished: null,
    async start(gameId, decks, options) {
      get().client?.dispose();
      queue.cancel();
      batcher.cancel(); clearPending();
      const client = new GameClient();
      let speed = 1;
      try { speed = clampSpeed(Number(localStorage.getItem(SPEED_KEY) ?? 1)); } catch { /* private mode */ }
      replayer = null;
      set({ client, gameId, status: 'starting', view: null, liveView: null, shownView: null, settled: false, events: [], eventBase: 0, playback: { ...initialPlayback(), speed, explain: get().playback.explain, reducedMotion: get().playback.reducedMotion }, fx: EMPTY_FX, pulse: null, decision: null, undoAvailable: null, undoRefused: null, undoing: false, log: [], reasoning: [], analysis: null, analysisPhase: 'idle', analysisFor: null, reruns: {}, winner: null, error: null, decks, options, finished: null });
      client.subscribe((m: WorkerToMain) => {
        switch (m.type) {
          case 'started': {
            replayer = new Replayer(m.view);
            batcher.cancel(); clearPending();
            set({ status: 'running', view: m.view, liveView: m.view, shownView: m.view, settled: true, events: [], eventBase: 0, playback: { ...get().playback, cursor: 0, paused: false, rushing: false } });
            if (m.events?.length) ingest(m.events, m.view);
            break;
          }
          case 'view': {
            if (m.events?.length) pendingEvents.push(...m.events);
            pendingView = m.view;
            batcher.schedule();
            break;
          }
          case 'decision': {
            batcher.cancel(); flushSideChannels();
            const buffered = takeEvents();
            set({ decision: { requestId: m.requestId, decision: m.decision }, undoAvailable: m.undo ?? null, undoing: false, analysis: null, analysisPhase: 'idle', analysisFor: m.requestId, reruns: {} });
            ingest([...buffered, ...(m.events ?? [])], m.view, { decision: true });
            break;
          }
          case 'undo-result': {
            batcher.flushNow();
            if (!m.ok) { set(s => ({ undoing: false, undoRefused: { key: (s.undoRefused?.key ?? 0) + 1, reason: m.reason ?? 'Undo is not possible right now' } })); break; }
            // Drop everything after the snapshot: events (the timeline just truncates), log lines, the pending decision.
            const s = get();
            const keep = Math.max(0, Math.min((m.eventCount ?? 0) - s.eventBase, s.events.length));
            queue.cancel();
            replayer?.truncate(keep);
            const logKeep = m.logIndex ?? Number.POSITIVE_INFINITY;
            set(st => ({ events: st.events.slice(0, keep), log: st.log.filter(l => l.index < logKeep), decision: null, undoAvailable: null, analysis: null, analysisPhase: 'idle', analysisFor: null, reruns: {}, settled: false, fx: EMPTY_FX, playback: { ...st.playback, cursor: st.eventBase + keep, paused: false, rushing: false } }));
            break;
          }
          case 'log': pendingLog.push({ index: m.index, line: m.line, turn: m.turn, step: m.step, kind: classify(m.line) }); batcher.schedule(); break;
          case 'reasoning': pendingReasoning.push(m.reasoning); batcher.schedule(); break;
          case 'analysis': set(s => (s.decision?.requestId === m.requestId || s.analysisFor === m.requestId) ? { analysis: m.report, analysisPhase: m.phase, analysisFor: m.requestId } : {}); break;
          case 'analysis-rerun-result': set(s => ({ reruns: { ...s.reruns, [`${m.req.candidateId}:${m.req.trialStart}:${m.req.trialCount}:${m.req.baseSeed}`]: { identical: m.identical, results: m.results } } })); break;
          case 'finished': {
            batcher.cancel(); flushSideChannels();
            const buffered = takeEvents();
            set({ status: 'finished', winner: m.winner, decision: null, finished: { log: m.log, actions: m.actions, reasoning: m.reasoning, turns: m.turns } });
            ingest([...buffered, ...(m.events ?? [])], m.view);
            break;
          }
          case 'error': batcher.cancel(); flushSideChannels(); set({ status: 'error', error: m.message }); break;
        }
      });
      await client.start(gameId, decks, options);
    },
    answer(answer) {
      const { client, decision } = get();
      if (!client || !decision) return;
      client.answer(decision.requestId, answer);
      set({ decision: null });
    },
    concede() { get().client?.concede(); },
    undo() {
      const { client, status, undoing } = get();
      if (!client || status !== 'running' || undoing) return;
      set({ undoing: true });
      client.undo();
    },
    setStops(stops) { get().client?.setStops(stops); },
    deepen(trials = 400, policy) { get().client?.analyze({ trials, policy, horizon: 4 }); },
    rerun(req) { get().client?.rerun(req); },
    dispose() { queue.dispose(); batcher.cancel(); clearPending(); get().client?.dispose(); set({ client: null, status: 'idle', decision: null }); },

    setSpeed(speed) {
      const s = clampSpeed(speed);
      try { localStorage.setItem(SPEED_KEY, String(s)); } catch { /* private mode */ }
      set(st => ({ playback: { ...st.playback, speed: s } }));
    },
    setExplain(on) { set(st => ({ playback: { ...st.playback, explain: on } })); },
    setReducedMotion(on) { if (get().playback.reducedMotion !== on) { set(st => ({ playback: { ...st.playback, reducedMotion: on } })); queue.schedule(); } },
    skip() { set(st => ({ playback: { ...st.playback, skipping: true } })); queue.skip(); set(st => ({ playback: { ...st.playback, skipping: false } })); },
    scrubTo(n) {
      const s = get();
      if (!replayer || !s.liveView) return;
      const local = Math.max(0, Math.min(n - s.eventBase, s.events.length));
      if (!s.playback.paused) queue.pause();
      const shown = hydrate(replayer.at(local), indexCards(s.liveView));
      set(st => ({ shownView: shown, view: shown, settled: false, fx: EMPTY_FX, playback: { ...st.playback, cursor: s.eventBase + local, paused: true } }));
    },
    pause() { queue.pause(); },
    play() { queue.resume(); },
    goLive() { queue.skip(); },
    showMe(objects, players) { set(st => ({ pulse: { key: (st.pulse?.key ?? 0) + 1, objects, players } })); },
  };
});

export const rerunKey = (req: McRequest) => `${req.candidateId}:${req.trialStart}:${req.trialCount}:${req.baseSeed}`;
