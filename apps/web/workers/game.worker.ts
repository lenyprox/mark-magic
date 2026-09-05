/// <reference lib="webworker" />
// Runs the rules engine and the AI opponents off the main thread. The human's decisions are forwarded to the page
// and awaited; the page only ever receives a redacted ViewState. The play analyzer runs here too (it needs the live
// state), fanning Monte Carlo work out to nested analysis workers, and its reports are forwarded to the page.
//
// Undo: a serialised snapshot of the state is taken right before every priority decision the human is asked. On
// `undo` the worker restores the snapshot taken before the human's previous priority decision, provided no hidden
// information was revealed since (library size, revealed / known-card lists) and no opponent acted since (opponent
// decisions other than passing priority). The old game loop is abandoned (its pending ask rejects), a fresh Game is
// built from the snapshot with fresh agents, the event stream is truncated to the snapshot and the turn resumes from
// the same priority round.
import { Game, type GameOptions } from '@engine/game';
import { AiAgent } from '@ai/ai';
import { MctsAgent } from '@ai/mcts';
import { DeferredAgent, type AskRequest, type StopPolicy } from '@engine/agents/deferred';
import type { Agent, Decision, PlayerAction } from '@engine/state';
import { redact } from '@engine/view';
import { redactEvent, type GameEvent } from '@engine/events';
import { defTable, deserializeState, serializeState, type SerializedState } from '@engine/serialize';
import { AnalysisPool, inlineWorker, defaultPoolSize, type WorkerLike } from '@analysis/pool';
import type { AnalysisReport, ListEntry, McRequest, OpponentModel } from '@analysis/types';
import type { FromWorker } from '@analysis/protocol';
import { buildView } from '@play/view';
import { expandPayload, isCommanderMatch, splitPayload } from '@play/payload';
import type { MainToWorker, WorkerToMain, StartOptions, DeckPayload, UndoAvailability } from '@play/protocol';
import type { Reasoning } from '@ai/ai';
import type { CardDef } from '@cards/types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerToMain) => ctx.postMessage(m);

let game: Game | null = null;
let gameId = '';
let viewer: number | null = 0;
let options: StartOptions | null = null;
let decksRef: DeckPayload[] = [];
let defs = new Map<string, CardDef>();
let gameOpts: GameOptions = {};
let stops: Partial<StopPolicy> = {};
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reqCounter = 0;
let human: DeferredAgent | null = null;
const reasoning: Reasoning[] = [];
let viewScheduled = false;
let logIndex = 0;
let eventCursor = 0;
/** Opponent decisions since the game started, not counting priority passes (the undo safety rule). */
let oppActs = 0;
/** Game loops that were abandoned by an undo: their rejection is expected and ignored. */
const abandoned = new WeakSet<Game>();
class UndoAbort extends Error { constructor() { super('undo'); } }

/** Events emitted since the last call, redacted for the viewer. */
function drainEvents(): GameEvent[] {
  const all = game?.state.events; if (!all) return [];
  const out = all.slice(eventCursor).map(e => redactEvent(e, viewer)); eventCursor = all.length;
  return out;
}

// ---- undo snapshots
interface Snapshot {
  requestId: number; kind: Decision['kind'];
  /** Only priority decisions are resumable (the engine can continue a priority round from a serialised state). */
  state: SerializedState | null;
  rng: number; eventCount: number; logIndex: number; oppActs: number; recorded: number;
  revealed: number; knownInHand: number; knownTop: number; library: number;
}
let history: Snapshot[] = [];
const HISTORY_MAX = 40;

const rngOf = (g: Game): number => (g.rng as unknown as { s: number }).s;
const setRng = (g: Game, s: number) => { (g.rng as unknown as { s: number }).s = s; };

function takeSnapshot(requestId: number, decision: Decision) {
  if (!game || viewer === null) return;
  const s = game.state;
  const resumable = decision.kind === 'priority' && s.turn >= 1 && s.winner === null;
  history.push({
    requestId, kind: decision.kind, state: resumable ? serializeState(s) : null, rng: rngOf(game),
    eventCount: s.events?.length ?? 0, logIndex, oppActs, recorded: human?.recorded.length ?? 0,
    revealed: s.knowledge.revealed.length, knownInHand: s.knowledge.knownInHand.length, knownTop: s.knowledge.knownTop[viewer]?.length ?? 0, library: s.players[viewer].library.length,
  });
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}

/** The snapshot an undo would restore right now, or why there is none. */
function undoTarget(): { ok: true; snap: Snapshot; index: number } | { ok: false; reason: string } {
  if (!game || viewer === null) return { ok: false, reason: 'Nothing to undo' };
  if (game.state.winner !== null) return { ok: false, reason: 'The game is over' };
  if (!currentDecision) return { ok: false, reason: "Wait until it's your decision" };
  const k = history.findIndex(h => h.requestId === currentDecision!.requestId);
  if (k < 0) return { ok: false, reason: 'Nothing to undo yet' };
  let j = k - 1; while (j >= 0 && !history[j].state) j--;
  if (j < 0) return { ok: false, reason: 'Nothing to undo yet' };
  const snap = history[j]; const s = game.state;
  if (oppActs !== snap.oppActs) return { ok: false, reason: 'An opponent has acted since your last decision' };
  if (s.players[viewer].library.length !== snap.library || s.knowledge.revealed.length !== snap.revealed || s.knowledge.knownInHand.length !== snap.knownInHand || (s.knowledge.knownTop[viewer]?.length ?? 0) !== snap.knownTop) {
    return { ok: false, reason: 'Hidden information was revealed since (a card was drawn or looked at)' };
  }
  return { ok: true, snap, index: j };
}
const undoAvailability = (): UndoAvailability => { const t = undoTarget(); return t.ok ? { ok: true } : { ok: false, reason: t.reason }; };

// ---- analysis
let pool: AnalysisPool | null = null;
let myList: ListEntry[] = [];
let oppList: ListEntry[] = [];
let currentDecision: { requestId: number; decision: Decision } | null = null;
let latestReport: AnalysisReport | null = null;

function listOf(p: DeckPayload): ListEntry[] {
  const m = new Map<string, number>();
  for (const e of [...p.main, ...p.commander]) { const d = p.defs[e.key]; if (d) m.set(d.name, (m.get(d.name) ?? 0) + e.count); }
  return [...m].map(([name, count]) => ({ name, count }));
}

function makeAnalysisWorker(): WorkerLike {
  if (typeof Worker === 'undefined') return inlineWorker();
  let w: Worker;
  try { w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' }); }
  catch { return inlineWorker(); }
  // As in lib/sim/batchClient.ts: a nested worker that fails to load fires 'error' rather than posting anything, and
  // the pool needs the bare protocol error to know the slot is gone instead of waiting on it for ever.
  const like: WorkerLike = {
    onmessage: null,
    postMessage(msg) { w.postMessage(msg); },
    terminate() { like.onmessage = null; w.terminate(); },
  };
  w.onmessage = ev => like.onmessage?.({ data: ev.data as FromWorker });
  w.onerror = e => like.onmessage?.({ data: { type: 'error', message: e.message || 'analysis worker failed to load' } });
  w.onmessageerror = () => like.onmessage?.({ data: { type: 'error', message: 'analysis worker sent an unreadable message' } });
  return like;
}

function opponentModel(): OpponentModel {
  const a = options?.analysis;
  if (!a || a.opponentModel === 'none') return { kind: 'none' };
  if (a.opponentModel === 'archetype' && a.opponentProfile) return { kind: 'archetype', profile: a.opponentProfile };
  return { kind: 'exact', list: oppList };
}

function runAnalysis(overrides: { trials?: number; horizon?: number; policy?: 'rollout' | 'ai30' } = {}) {
  if (!game || !pool || !options?.analysis.enabled || !currentDecision || viewer === null) return;
  const d = currentDecision.decision;
  if (d.kind !== 'priority' && d.kind !== 'attackers' && d.kind !== 'blockers') return;
  const requestId = currentDecision.requestId;
  const state = redact(game.state, 0);
  const baseSeed = ((options.seed * 2654435761) ^ (game.state.turn * 977 + requestId * 31)) >>> 0 || 1;
  const a = options.analysis;
  const handle = pool.analyze({ state, viewer: 0, model: opponentModel(), myList, baseSeed }, {
    trials: overrides.trials ?? a.trials, horizon: overrides.horizon ?? a.horizon, policy: overrides.policy ?? a.policy, candidates: a.candidates,
    onUpdate: report => { if (currentDecision?.requestId === requestId) { latestReport = report; post({ type: 'analysis', requestId, report, phase: 'update' }); } },
  });
  handle.quick.then(report => { if (currentDecision?.requestId === requestId) { latestReport = report; post({ type: 'analysis', requestId, report, phase: 'quick' }); } }).catch(() => undefined);
  handle.done.then(report => { if (currentDecision?.requestId === requestId) { latestReport = report; post({ type: 'analysis', requestId, report, phase: 'done' }); } }).catch(() => undefined);
}

async function rerun(req: McRequest) {
  if (!game || !pool) return;
  const state = redact(game.state, 0);
  const results = await pool.rerun(req, { state, viewer: 0, model: opponentModel(), myList, baseSeed: req.baseSeed });
  // Verify against the published estimate: same trial count and the same number of wins means the seeded run reproduced.
  const mc = latestReport ? [...latestReport.plays, latestReport.baseline].flatMap(p => p.derivations).map(d => d.mc).find(m => m && m.rerun.candidateId === req.candidateId && m.rerun.baseSeed === req.baseSeed) : null;
  const wins = results.filter(r => r.outcome === 'win').length + results.filter(r => r.outcome === 'draw').length / 2;
  const identical = mc ? (mc.n === results.length && Math.abs(mc.successes - wins) < 1e-9) : true;
  post({ type: 'analysis-rerun-result', req, identical, results });
}

function scheduleView() {
  if (viewScheduled || !game) return;
  viewScheduled = true;
  setTimeout(() => { viewScheduled = false; if (game) post({ type: 'view', view: buildView(game, viewer, gameId), events: drainEvents() }); }, 0);
}

function onLog(line: string) {
  if (!game) return;
  post({ type: 'log', line, turn: game.state.turn, step: game.state.step, index: logIndex++ });
  scheduleView();
}

/** The human's decisions go to the page under a worker-side request id (unique across undo restarts). */
const ask = (req: AskRequest) => new Promise<unknown>((resolve, reject) => {
  const id = ++reqCounter;
  pending.set(id, { resolve, reject });
  if (game) {
    takeSnapshot(id, req.decision);
    currentDecision = { requestId: id, decision: req.decision };
    post({ type: 'decision', requestId: id, decision: req.decision, view: buildView(game, viewer, gameId), events: drainEvents(), undo: undoAvailability() });
  }
  runAnalysis();
});

/** How often the game loop hands the worker's macrotask queue a turn. */
const YIELD_MS = 16;
let lastYield = 0;
/** The engine's loop only ever awaits already-resolved promises, so `scheduleView`'s timer would never fire while
 *  an AI is playing: a spectated (AI-vs-AI) table would sit still until the game ended, and an AI turn in a normal
 *  game would arrive as one lump. Yielding between AI decisions lets the view stream out as it is produced. */
async function breathe() {
  const now = Date.now();
  if (now - lastYield < YIELD_MS) return;
  lastYield = now;
  scheduleView();
  await new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

/** Let the view stream, and count an AI's decisions other than priority passes (what makes an undo unsafe). */
function countActs<T extends Agent>(a: T): T {
  const orig = a.decide.bind(a);
  a.decide = async (s, me, d) => { await breathe(); const r = await orig(s, me, d); if (d.kind !== 'priority' || (r as PlayerAction | undefined)?.type !== 'pass') oppActs++; return r; };
  return a;
}

/** One agent per seat: the human's DeferredAgent at `humanSeat`, AIs elsewhere. Fresh instances on every call (undo re-creates them). */
function buildAgents(opts: StartOptions, decks: DeckPayload[]): Agent[] {
  const aiOpts = { name: opts.aiName ?? 'AI', aggression: opts.ai.aggression, maxSims: opts.ai.maxSims, verbose: opts.ai.verbose, cheat: opts.ai.cheat, determinizations: opts.ai.determinizations, seed: opts.seed, defs, myList: oppList, opponentModel: opts.ai.knowsOpponentList ? { kind: 'exact' as const, list: myList } : { kind: 'none' as const } };
  const mkAi = (o: typeof aiOpts) => {
    const a = opts.ai.policy === 'mcts' ? new MctsAgent({ ...o, iterations: opts.ai.iterations ?? 120 }) : new AiAgent(o);
    a.onReasoning = r => { reasoning.push(r); post({ type: 'reasoning', reasoning: r }); };
    a.onLog = onLog;
    return countActs(a);
  };
  return decks.map((d, i) => {
    if (i === opts.humanSeat) { human = new DeferredAgent({ name: opts.playerName ?? 'You', ask, stops, onLog }); return human; }
    if (i === 0) return mkAi({ ...aiOpts, name: opts.playerName ?? 'AI 1', myList, opponentModel: opts.ai.knowsOpponentList ? { kind: 'exact' as const, list: oppList } : { kind: 'none' as const } });
    if (i === 1) return mkAi(aiOpts);
    return mkAi({ ...aiOpts, name: d.archetype?.name ?? d.name ?? `AI ${i + 1}`, myList: listOf(d), opponentModel: { kind: 'none' as const } });
  });
}

/** Play (or resume) a game loop; the finished message goes out only for the loop that is still current. */
async function runLoop(g: Game, resumed: boolean) {
  try {
    let winner: number | null;
    if (resumed) {
      await g.resumeTurn();
      winner = g.state.winner !== null ? g.state.winner : await g.playTurns(Number.MAX_SAFE_INTEGER);
      if (g.state.winner !== null && !g.state.events?.some(e => e.type === 'game-over')) g.emit({ type: 'game-over', winner: g.state.winner, reason: g.state.players.filter(p => p.id !== g.state.winner && p.lossReason).map(p => p.lossReason).join(', ') || 'opponents lost' });
    } else winner = await g.play();
    if (game !== g) return;
    post({ type: 'finished', gameId, winner, view: buildView(g, viewer, gameId), log: g.state.log, actions: human?.recorded ?? [], reasoning, turns: g.state.turn, events: drainEvents() });
  } catch (e) {
    if (e instanceof UndoAbort || abandoned.has(g) || game !== g) return;
    post({ type: 'error', message: (e as Error).message, stack: (e as Error).stack });
  }
}

async function start(id: string, decks: DeckPayload[], opts: StartOptions) {
  gameId = id; viewer = opts.humanSeat; options = opts; decksRef = decks; reasoning.length = 0; logIndex = 0; eventCursor = 0; oppActs = 0; history = []; currentDecision = null; latestReport = null; human = null;
  for (const [, p] of pending) p.reject(new UndoAbort()); pending.clear();
  stops = { ...(opts.stops ?? {}) };
  const me = opts.humanSeat ?? 0;
  myList = listOf(decks[me]); oppList = listOf(decks[me === 0 ? 1 : 0]);
  defs = defTable(decks.flatMap(d => Object.values(d.defs)));
  if (opts.analysis.enabled && opts.humanSeat === 0 && decks.length === 2) {
    pool?.cancel();
    pool = new AnalysisPool(makeAnalysisWorker, opts.analysis.workers ?? defaultPoolSize(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4));
    await pool.init(defs.values());
  }
  const agents = buildAgents(opts, decks);
  const commander = isCommanderMatch(decks, opts.format);
  const split = decks.map(splitPayload);
  gameOpts = { seed: opts.seed, startingLife: opts.startingLife, maxTurns: opts.maxTurns, mulligans: opts.mulligans, events: 'full', format: commander ? 'commander' : 'freeform', commanders: commander ? split.map(x => x.commanders) : undefined };
  game = new Game(commander ? split.map(x => x.library) : decks.map(expandPayload), agents, gameOpts);
  for (const a of agents) if (a instanceof AiAgent) a.attach(game);
  post({ type: 'started', gameId, view: buildView(game, viewer, gameId) });
  await runLoop(game, false);
}

function undo() {
  const t = undoTarget();
  if (!t.ok) { post({ type: 'undo-result', ok: false, reason: t.reason }); return; }
  if (!game || !options) { post({ type: 'undo-result', ok: false, reason: 'Nothing to undo' }); return; }
  const old = game; const oldEvents = old.state.events ?? []; const oldRecorded = human?.recorded ?? [];
  const { snap, index } = t;
  history.length = index;                          // the target is re-taken when the decision is asked again
  abandoned.add(old);
  for (const [rid, p] of pending) { pending.delete(rid); p.reject(new UndoAbort()); }
  currentDecision = null; latestReport = null; pool?.cancel();
  let g: Game;
  try {
    const state = deserializeState(snap.state!, defs);
    state.events = oldEvents.slice(0, snap.eventCount);
    const agents = buildAgents(options, decksRef);
    g = Game.fromState(state, agents, { ...gameOpts, commanders: undefined });
    setRng(g, snap.rng);
    for (const a of agents) if (a instanceof AiAgent) a.attach(g);
    if (human) human.recorded = oldRecorded.slice(0, snap.recorded);
  } catch (e) {
    post({ type: 'undo-result', ok: false, reason: `Could not restore: ${(e as Error).message}` });
    return;
  }
  game = g; eventCursor = snap.eventCount; logIndex = snap.logIndex; oppActs = snap.oppActs;
  post({ type: 'undo-result', ok: true, eventCount: snap.eventCount, logIndex: snap.logIndex });
  post({ type: 'view', view: buildView(g, viewer, gameId), events: [] });
  void runLoop(g, true);
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'start': void start(m.gameId, m.decks, m.options); break;
    case 'answer': { const r = pending.get(m.requestId); if (r) { pending.delete(m.requestId); if (currentDecision?.requestId === m.requestId) { currentDecision = null; pool?.cancel(); } r.resolve(m.answer); } break; }
    case 'set-stops': stops = { ...stops, ...m.stops }; human?.setStops(m.stops); break;
    case 'request-view': if (game) post({ type: 'view', view: buildView(game, viewer, gameId), events: drainEvents() }); break;
    case 'analyze': runAnalysis({ trials: m.trials, horizon: m.horizon, policy: m.policy }); break;
    case 'analysis-rerun': void rerun(m.req); break;
    case 'analysis-cancel': pool?.cancel(); break;
    case 'undo': undo(); break;
    case 'concede': { const [id] = [...pending.keys()]; if (id !== undefined) { const r = pending.get(id)!; pending.delete(id); currentDecision = null; pool?.cancel(); r.resolve({ type: 'concede' }); } break; }
    case 'terminate': pool?.cancel(); ctx.close(); break;
  }
};

post({ type: 'ready' });
