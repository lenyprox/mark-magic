/// <reference lib="webworker" />
// Runs the rules engine and the AI opponent off the main thread. The human's decisions are forwarded to the page
// and awaited; the page only ever receives a redacted ViewState. The play analyzer runs here too (it needs the live
// state), fanning Monte Carlo work out to nested analysis workers, and its reports are forwarded to the page.
import { Game } from '@engine/game';
import { AiAgent } from '@ai/ai';
import { DeferredAgent, type AskRequest } from '@engine/agents/deferred';
import type { Agent, Decision } from '@engine/state';
import { redact } from '@engine/view';
import { redactEvent, type GameEvent } from '@engine/events';
import { defTable } from '@engine/serialize';
import { AnalysisPool, inlineWorker, defaultPoolSize, type WorkerLike } from '@analysis/pool';
import type { AnalysisReport, ListEntry, McRequest, OpponentModel } from '@analysis/types';
import { buildView } from '@play/view';
import { expandPayload } from '@play/payload';
import type { MainToWorker, WorkerToMain, StartOptions, DeckPayload } from '@play/protocol';
import type { Reasoning } from '@ai/ai';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerToMain) => ctx.postMessage(m);

let game: Game | null = null;
let gameId = '';
let viewer: number | null = 0;
let options: StartOptions | null = null;
const pending = new Map<number, (v: unknown) => void>();
let human: DeferredAgent | null = null;
const reasoning: Reasoning[] = [];
let viewScheduled = false;
let logIndex = 0;
let eventCursor = 0;

/** Events emitted since the last call, redacted for the viewer. */
function drainEvents(): GameEvent[] {
  const all = game?.state.events; if (!all) return [];
  const out = all.slice(eventCursor).map(e => redactEvent(e, viewer)); eventCursor = all.length;
  return out;
}

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
  try {
    const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    return w as unknown as WorkerLike;
  } catch { return inlineWorker(); }
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

async function start(id: string, decks: DeckPayload[], opts: StartOptions) {
  gameId = id; viewer = opts.humanSeat; options = opts; reasoning.length = 0; logIndex = 0; eventCursor = 0; pending.clear(); currentDecision = null; latestReport = null;
  myList = listOf(decks[0]); oppList = listOf(decks[1]);
  const defs = defTable([...Object.values(decks[0].defs), ...Object.values(decks[1].defs)]);
  const ask = (req: AskRequest) => new Promise<unknown>(resolve => {
    pending.set(req.id, resolve);
    currentDecision = { requestId: req.id, decision: req.decision };
    if (game) post({ type: 'decision', requestId: req.id, decision: req.decision, view: buildView(game, viewer, gameId), events: drainEvents() });
    runAnalysis();
  });
  const aiOpts = { name: opts.aiName ?? 'AI', aggression: opts.ai.aggression, maxSims: opts.ai.maxSims, verbose: opts.ai.verbose, cheat: opts.ai.cheat, determinizations: opts.ai.determinizations, seed: opts.seed, defs, myList: oppList, opponentModel: opts.ai.knowsOpponentList ? { kind: 'exact' as const, list: myList } : { kind: 'none' as const } };
  const ai = new AiAgent(aiOpts);
  ai.onReasoning = r => { reasoning.push(r); post({ type: 'reasoning', reasoning: r }); };
  let seat0: Agent;
  if (opts.humanSeat === 0) {
    human = new DeferredAgent({ name: opts.playerName ?? 'You', ask, stops: opts.stops, onLog });
    seat0 = human;
  } else {
    const ai0 = new AiAgent({ ...aiOpts, name: opts.playerName ?? 'AI 1', myList, opponentModel: opts.ai.knowsOpponentList ? { kind: 'exact', list: oppList } : { kind: 'none' } });
    ai0.onReasoning = r => { reasoning.push(r); post({ type: 'reasoning', reasoning: r }); };
    ai0.onLog = onLog;
    seat0 = ai0;
  }
  if (opts.analysis.enabled && opts.humanSeat === 0 && decks.length === 2) {
    pool?.cancel();
    pool = new AnalysisPool(makeAnalysisWorker, opts.analysis.workers ?? defaultPoolSize(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4));
    await pool.init(defs.values());
  }
  const extra = decks.slice(2).map((d, i) => { const a = new AiAgent({ ...aiOpts, name: `AI ${i + 2}`, myList: listOf(d), opponentModel: { kind: 'none' as const } }); a.onLog = onLog; return a; });
  const agents: Agent[] = [seat0, ai, ...extra];
  game = new Game(decks.map(expandPayload), agents, { seed: opts.seed, startingLife: opts.startingLife, maxTurns: opts.maxTurns, mulligans: opts.mulligans, events: 'full' });
  for (const a of agents) if (a instanceof AiAgent) a.attach(game);
  post({ type: 'started', gameId, view: buildView(game, viewer, gameId) });
  try {
    const winner = await game.play();
    post({ type: 'finished', gameId, winner, view: buildView(game, viewer, gameId), log: game.state.log, actions: human?.recorded ?? [], reasoning, turns: game.state.turn, events: drainEvents() });
  } catch (e) {
    post({ type: 'error', message: (e as Error).message, stack: (e as Error).stack });
  }
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'start': void start(m.gameId, m.decks, m.options); break;
    case 'answer': { const r = pending.get(m.requestId); if (r) { pending.delete(m.requestId); if (currentDecision?.requestId === m.requestId) { currentDecision = null; pool?.cancel(); } r(m.answer); } break; }
    case 'set-stops': human?.setStops(m.stops); break;
    case 'request-view': if (game) post({ type: 'view', view: buildView(game, viewer, gameId), events: drainEvents() }); break;
    case 'analyze': runAnalysis({ trials: m.trials, horizon: m.horizon, policy: m.policy }); break;
    case 'analysis-rerun': void rerun(m.req); break;
    case 'analysis-cancel': pool?.cancel(); break;
    case 'concede': { const [id] = [...pending.keys()]; if (id !== undefined) { const r = pending.get(id)!; pending.delete(id); currentDecision = null; pool?.cancel(); r({ type: 'concede' }); } break; }
    case 'terminate': pool?.cancel(); ctx.close(); break;
  }
};

post({ type: 'ready' });
