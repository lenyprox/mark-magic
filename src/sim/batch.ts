// Plays whole games between decks. Game i of a spec is fully determined by (baseSeed, i): its seed is
// hashSeed(baseSeed, i), its seating comes from the rotation, and every agent draws its randomness from that seed,
// so the same spec always produces byte-identical results and any single game can be replayed on its own.
import { hashSeed } from '../analysis/determinize.js';
import { wilson } from '../analysis/montecarlo.js';
import { RolloutAgent } from '../analysis/rolloutAgent.js';
import type { Derivation, Estimate } from '../analysis/types.js';
import { AiAgent } from '../ai/ai.js';
import type { CardDef } from '../cards/types.js';
import { defKey } from '../engine/serialize.js';
import type { Agent, PlayerId } from '../engine/state.js';
import { expandPayload, splitPayload } from '../play/payload.js';
import type { DeckPayload } from '../play/protocol.js';
import { createGame, firstSeat, winnerSeat } from './engineAdapter.js';
import { InstrumentedAgent, seenNames } from './instrument.js';
import type { DeckAggregate, GameRecordLite, MatchAggregate, MatchResult, MatchSpec, MatchSpecRef, SimRerunRef } from './types.js';

/**
 * Which deck sits in which seat for game `gameIndex`: seatOrder[seat] = deck. `rotate` is a Latin rotation
 * (seat s gets deck (s + i) mod n) so over any n consecutive games every deck takes every seat exactly once.
 */
export function seatOrderFor(gameIndex: number, decks: number, seats: number = decks, mode: MatchSpec['seating'] = 'rotate'): number[] {
  if (seats !== decks) throw new Error(`a match needs one deck per seat (${decks} decks, ${seats} seats)`);
  const order: number[] = [];
  for (let s = 0; s < seats; s++) order.push(mode === 'rotate' ? (s + gameIndex) % decks : s);
  return order;
}

/** The deck as the engine takes it, in canonical (sorted) order so a seed's shuffle permutation is a function of positions. */
export function deckArray(p: DeckPayload): CardDef[] {
  return expandPayload(p).sort((a, b) => (defKey(a) < defKey(b) ? -1 : defKey(a) > defKey(b) ? 1 : 0));
}

/** A short content hash of a deck (sorted keys with counts), for result references. */
export function deckHash(p: DeckPayload): string {
  const parts = [...p.commander.map(e => `c:${e.key}x${e.count}`), ...p.main.map(e => `${e.key}x${e.count}`)].sort();
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export function commanderNames(p: DeckPayload): Set<string> {
  const s = new Set<string>();
  for (const e of p.commander) { const d = p.defs[e.key]; if (d) s.add(d.name); }
  return s;
}

export function specRef(spec: MatchSpec): MatchSpecRef {
  const { decks, ...rest } = spec;
  return { ...rest, gameStart: spec.gameStart ?? 0, decks: decks.map(d => ({ deckId: d.deckId, name: d.name, cards: d.main.reduce((a, e) => a + e.count, 0) + d.commander.reduce((a, e) => a + e.count, 0), hash: deckHash(d) })) };
}

export interface PreparedMatch { arrays: CardDef[][]; commanders: Set<string>[]; commanderDefs: CardDef[][]; seats: number }

export function prepare(spec: MatchSpec): PreparedMatch {
  if (spec.decks.length < 2) throw new Error('a match needs at least two decks');
  const seats = spec.players ?? spec.decks.length;
  const commander = spec.format === 'commander';
  const fromOrder = (d: DeckPayload, order: string[]): CardDef[] => { const byName = new Map<string, CardDef>(); for (const x of Object.values(d.defs)) byName.set(x.name, x); return order.map(n => byName.get(n)).filter((x): x is CardDef => !!x); };
  const arrays = spec.decks.map((d, i) => { const order = spec.orders?.[i]; if (order) return fromOrder(d, order); return commander ? splitPayload(d).library.sort((a, b) => (defKey(a) < defKey(b) ? -1 : defKey(a) > defKey(b) ? 1 : 0)) : deckArray(d); });
  return { arrays, commanders: spec.decks.map(commanderNames), commanderDefs: spec.decks.map(d => commander ? splitPayload(d).commanders : []), seats };
}

function makeAgent(spec: MatchSpec, name: string, seat: number, seed: number): Agent {
  if (spec.agent === 'ai') return new AiAgent({ name, verbose: false, maxSims: spec.aiSims ?? 30, cheat: true, seed: hashSeed(seed, seat + 1) });
  return new RolloutAgent(name);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Play game `i` of the spec (absolute index: seeds and seating depend on it, not on the chunk it ran in). */
export async function playOne(spec: MatchSpec, prepared: PreparedMatch, i: number): Promise<GameRecordLite> {
  const seed = hashSeed(spec.baseSeed, i);
  const order = seatOrderFor(i, spec.decks.length, prepared.seats, spec.seating);
  const n = spec.decks.length;
  const names = order.map((d, seat) => `${spec.decks[d].name} (seat ${seat + 1})`);
  const agents = order.map((d, seat) => new InstrumentedAgent(makeAgent(spec, names[seat], seat, seed), { mulligan: spec.mulligans, commanders: prepared.commanders[d] }));
  const t0 = now();
  const rec: GameRecordLite = { index: i, seed, seatOrder: order, winner: null, firstSeat: 0, turns: 0, mulligans: Array(n).fill(0), openingHand: Array.from({ length: n }, () => []), seen: Array.from({ length: n }, () => []), firstCommanderCastTurn: Array(n).fill(null), lossReason: Array(n).fill(null), unsimulated: 0, ms: 0 };
  let game;
  try {
    game = createGame(order.map(d => prepared.arrays[d]), agents, { seed, quiet: true, mulligans: spec.mulligans !== 'none', maxTurns: spec.maxTurns, startingLife: spec.startingLife ?? (spec.format === 'commander' ? 40 : 20), fastMana: true, format: spec.format, commanders: order.map(d => prepared.commanderDefs[d]) });
    for (const a of agents) if (a.inner instanceof AiAgent) a.inner.attach(game);
    await game.play();
  } catch (e) {
    rec.error = (e as Error).message;
  }
  rec.ms = Math.round((now() - t0) * 10) / 10;
  if (!game) return rec;
  const s = game.state;
  const ws = winnerSeat(game);
  rec.winner = ws === null ? null : order[ws];
  rec.firstSeat = firstSeat(game);
  rec.turns = s.turn;
  rec.unsimulated = s.eventCounts?.unsimulated ?? s.log.filter(l => l.includes('unsimulated text')).length;
  order.forEach((d, seat) => {
    const st = agents[seat].stats;
    rec.mulligans[d] = st.mulligans; rec.openingHand[d] = st.openingHand ?? s.players[seat].hand.map(c => c.def.name);
    rec.firstCommanderCastTurn[d] = st.firstCommanderCastTurn; rec.lossReason[d] = s.players[seat].lossReason ?? null;
    rec.seen[d] = seenNames(s, seat as PlayerId);
  });
  if (spec.record === 'events') rec.log = s.log.slice();
  return rec;
}

export interface RunOptions {
  onProgress?: (records: GameRecordLite[], done: number, total: number) => void | Promise<void>;
  shouldStop?: () => boolean;
  /** Play exactly these absolute game indexes instead of gameStart..gameStart+games. */
  indices?: number[];
  /** Use these prepared arrays (explicit library order per deck) instead of the canonical sort. */
  prepared?: PreparedMatch;
  /** Records per onProgress call (default 5). */
  batch?: number;
  /** Yield to the event loop every this many games (default 1) so cancel messages get through. */
  yieldEvery?: number;
}

const yieldToLoop = () => new Promise<void>(r => setTimeout(r, 0));

/** Run the games of a spec in order and assemble the result. */
export async function runMatches(spec: MatchSpec, opts: RunOptions = {}): Promise<MatchResult> {
  const prepared = opts.prepared ?? prepare(spec);
  const start = spec.gameStart ?? 0; const list = opts.indices ?? Array.from({ length: spec.games }, (_, k) => start + k); const total = list.length; const batch = Math.max(1, opts.batch ?? 5); const yieldEvery = Math.max(1, opts.yieldEvery ?? 1);
  const records: GameRecordLite[] = []; let pending: GameRecordLite[] = [];
  const t0 = now();
  for (let k = 0; k < total; k++) {
    if (opts.shouldStop?.()) break;
    const rec = await playOne(spec, prepared, list[k]);
    records.push(rec); pending.push(rec);
    if (pending.length >= batch) { await opts.onProgress?.(pending, records.length, total); pending = []; }
    if (k % yieldEvery === yieldEvery - 1) await yieldToLoop();
  }
  if (pending.length) await opts.onProgress?.(pending, records.length, total);
  return assembleResult(spec, records, now() - t0);
}

function estimate(succ: number, n: number, seed: number): Estimate {
  return { value: n ? round(succ / n) : 0, ci95: wilson(succ, n).map(round) as [number, number], method: 'montecarlo', n, seed };
}
const round = (x: number) => Math.round(x * 10000) / 10000;

/** Per-deck and table-level statistics for a set of game records. */
export function aggregateMatches(spec: MatchSpecRef, records: GameRecordLite[], ms = 0): MatchAggregate {
  const n = spec.decks.length; const seats = spec.players ?? n;
  const ok = records.filter(r => !r.error);
  const draws = ok.filter(r => r.winner === null).length;
  const byDeck: DeckAggregate[] = spec.decks.map((d, deck) => {
    const games = ok.length;
    const wins = ok.filter(r => r.winner === deck).length;
    const losses = ok.filter(r => r.winner !== null && r.winner !== deck).length;
    const dr = games - wins - losses;
    const seatWins = Array(seats).fill(0), seatGames = Array(seats).fill(0);
    const play = { games: 0, wins: 0 }, drawSide = { games: 0, wins: 0 };
    let mulls = 0; const wonTurns: number[] = []; const castTurns: number[] = []; let never = 0;
    for (const r of ok) {
      const seat = r.seatOrder.indexOf(deck); if (seat < 0) continue;
      seatGames[seat]++; if (r.winner === deck) { seatWins[seat]++; wonTurns.push(r.turns); }
      const side = r.firstSeat === seat ? play : drawSide; side.games++; if (r.winner === deck) side.wins++;
      if (r.mulligans[deck] > 0) mulls++;
      const ct = r.firstCommanderCastTurn[deck]; if (ct === null) never++; else castTurns.push(ct);
    }
    const hasCommander = castTurns.length + never > 0 && spec.format === 'commander';
    return {
      deck, name: d.name, games, wins, losses, draws: dr,
      winRate: estimate(wins + dr / n, games, spec.baseSeed),
      seatWins, seatGames, onThePlay: play, onTheDraw: drawSide,
      mulliganRate: games ? round(mulls / games) : 0,
      avgTurnsWon: wonTurns.length ? round(wonTurns.reduce((a, b) => a + b, 0) / wonTurns.length) : null,
      commanderCastTurn: hasCommander ? { mean: castTurns.length ? round(castTurns.reduce((a, b) => a + b, 0) / castTurns.length) : null, byTurn3: games ? round(castTurns.filter(t => t <= 3).length / games) : 0, byTurn5: games ? round(castTurns.filter(t => t <= 5).length / games) : 0, never: games ? round(never / games) : 0 } : null,
    };
  });
  return {
    games: records.length, decided: ok.length - draws, draws, errors: records.length - ok.length, byDeck,
    avgTurns: ok.length ? round(ok.reduce((a, r) => a + r.turns, 0) / ok.length) : 0,
    unsimulated: records.reduce((a, r) => a + r.unsimulated, 0),
    ms: Math.round(ms), gamesPerSecond: ms > 0 ? round(records.length / (ms / 1000)) : 0,
  };
}

/** The derivation of one deck's win rate, with the reference needed to replay the batch. */
export function matchDerivation(spec: MatchSpecRef, agg: MatchAggregate, deck = 0): Derivation {
  const d = agg.byDeck[deck]; const n = spec.decks.length; const succ = d.wins + d.draws / n;
  const others = spec.decks.filter((_, i) => i !== deck).map(x => x.name).join(', ');
  const sim: SimRerunRef = { specId: spec.id, baseSeed: spec.baseSeed, gameStart: spec.gameStart ?? 0, games: spec.games, deck, decks: spec.decks, successes: succ, n: d.games, ci95: d.winRate.ci95 ?? [0, 1], agent: spec.agent, seating: spec.seating, mulligans: spec.mulligans, maxTurns: spec.maxTurns };
  return {
    id: `sim-${spec.id}-${deck}`, method: 'montecarlo', title: `Win rate: ${d.name} vs ${others}`,
    formula: `P(win) ≈ (wins + draws/${n}) / games, Wilson 95% interval; game i uses seed = hashSeed(baseSeed, i) and the Latin seat rotation`,
    inputs: [
      { name: 'games', value: d.games }, { name: 'baseSeed', value: spec.baseSeed }, { name: 'gameStart', value: spec.gameStart ?? 0 },
      { name: 'agent', value: spec.agent === 'ai' ? `ai (${spec.aiSims ?? 30} sims)` : 'rollout' }, { name: 'seating', value: spec.seating }, { name: 'mulligans', value: spec.mulligans }, { name: 'maxTurns', value: spec.maxTurns },
      ...spec.decks.map((x, i) => ({ name: `deck ${i + 1}`, value: `${x.name} (${x.cards} cards, ${x.hash})` })),
    ],
    steps: [
      { text: `wins ${d.wins}, losses ${d.losses}, draws ${d.draws}${agg.errors ? `, ${agg.errors} game(s) hit an engine error and were excluded` : ''}` },
      { text: `(${d.wins} + ${d.draws}/${n}) / ${d.games} = ${d.winRate.value}`, value: d.winRate.value },
      { text: `Wilson 95%: [${d.winRate.ci95?.[0]}, ${d.winRate.ci95?.[1]}]` },
      { text: `on the play ${d.onThePlay.wins}/${d.onThePlay.games}, on the draw ${d.onTheDraw.wins}/${d.onTheDraw.games}; seat wins ${d.seatWins.join('/')} of ${d.seatGames.join('/')}` },
      { text: `unsimulated card text encountered: ${agg.unsimulated}`, value: agg.unsimulated },
    ],
    result: d.winRate.value,
    assumptions: [
      spec.agent === 'rollout' ? 'both seats follow the deterministic rollout policy (no look-ahead)' : `both seats use the simulation AI with ${spec.aiSims ?? 30} sims per decision`,
      spec.mulligans === 'none' ? 'every seven is kept' : 'a seven with 0-1 or 6-7 lands is mulliganed once',
      `a game still running after turn ${spec.maxTurns} is a draw (1/${n} of a win each)`,
      'cards with unparsed text play with those lines inert',
      ...(spec.format === 'commander' ? ['Commander rules: 40 life, command zone with tax, 21 combat damage from one commander loses, commanders return to the command zone'] : []),
    ],
    sim,
  };
}

export function assembleResult(spec: MatchSpec | MatchSpecRef, records: GameRecordLite[], ms: number): MatchResult {
  const ref: MatchSpecRef = 'defs' in (spec.decks[0] ?? {}) ? specRef(spec as MatchSpec) : (spec as MatchSpecRef);
  const sorted = [...records].sort((a, b) => a.index - b.index);
  const aggregate = aggregateMatches(ref, sorted, ms);
  const top = [...aggregate.byDeck].sort((a, b) => b.winRate.value - a.winRate.value);
  const best = top.length && aggregate.decided > 0 && top.every((d, i) => i === 0 || (d.winRate.ci95?.[1] ?? 1) < (top[0].winRate.ci95?.[0] ?? 0)) ? top[0].deck : null;
  return { spec: ref, games: sorted, aggregate, derivation: matchDerivation(ref, aggregate, 0), best };
}

/** Replay the games a derivation refers to and report whether the win count reproduced. */
export async function verifyRerun(ref: SimRerunRef, decks: DeckPayload[], opts: RunOptions = {}): Promise<{ identical: boolean; successes: number; result: MatchResult }> {
  const spec: MatchSpec = { id: ref.specId, decks, games: ref.games, gameStart: ref.gameStart, baseSeed: ref.baseSeed, seating: ref.seating, agent: ref.agent, format: decks.some(d => d.commander.length) ? 'commander' : 'freeform', maxTurns: ref.maxTurns, mulligans: ref.mulligans, record: 'summary' };
  const result = await runMatches(spec, opts);
  const d = result.aggregate.byDeck[ref.deck]; const successes = d.wins + d.draws / decks.length;
  return { identical: d.games === ref.n && Math.abs(successes - ref.successes) < 1e-9, successes, result };
}
