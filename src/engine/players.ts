// Seat helpers for games of two to four players. Everything that used to assume "the opponent" goes through these
// so the engine, the AI and the analysis layer agree on who is still in the game and whose turn comes next.
import type { GameState, PlayerId } from './state.js';

export function playerCount(s: GameState): number { return s.players.length; }

/** Players still in the game, in turn order. */
export function alive(s: GameState): PlayerId[] {
  const order = s.turnOrder ?? s.players.map(p => p.id);
  return order.filter(p => !s.players[p].lost);
}

/** Every living opponent of `p`, in turn order starting after `p`. */
export function opponentsOf(s: GameState, p: PlayerId): PlayerId[] {
  const live = alive(s); const i = live.indexOf(p);
  if (i < 0) return live;
  return [...live.slice(i + 1), ...live.slice(0, i)];
}

/** The next living player after `p` in turn order (`p` itself when nobody else is left). */
export function nextInTurnOrder(s: GameState, p: PlayerId): PlayerId {
  const order = s.turnOrder ?? s.players.map(q => q.id);
  const n = order.length; const start = order.indexOf(p);
  for (let k = 1; k <= n; k++) { const q = order[(start + k) % n]; if (!s.players[q].lost) return q; }
  return p;
}

/**
 * The opponent two-player heuristics act against: the living opponent the game reaches first after `p` in turn order
 * (in a two-player game, simply the other player). Multiplayer-aware code should use `opponentsOf` instead.
 */
export function primaryOpponent(s: GameState, p: PlayerId): PlayerId {
  const next = nextInTurnOrder(s, p);
  if (next !== p) return next;
  // nobody else alive: fall back to the other seat so 2-player callers keep a valid index
  return s.players.find(q => q.id !== p)?.id ?? p;
}

/** Active player first, then the others in turn order (CR 101.4 APNAP). */
export function apnapOrder(s: GameState): PlayerId[] {
  const order = s.turnOrder ?? s.players.map(p => p.id);
  const i = order.indexOf(s.activePlayer);
  return i < 0 ? [...order] : [...order.slice(i), ...order.slice(0, i)];
}

/** Whether `q` is an opponent of `p` (different seat, still in the game). */
export function isOpponent(s: GameState, p: PlayerId, q: PlayerId): boolean { return p !== q && !s.players[q].lost; }
