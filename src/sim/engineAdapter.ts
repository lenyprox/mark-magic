// The only file in src/sim that knows how many seats the engine can hold. When N-player lands (milestone B1) this
// becomes a one-line switch; everything else in the batch runner already speaks in deck indexes and seat indexes.
import type { CardDef } from '../cards/types.js';
import { Game, type GameOptions } from '../engine/game.js';
import type { Agent } from '../engine/state.js';

/** Seats the engine supports. */
export const MAX_SEATS = 4;

export function createGame(decks: CardDef[][], agents: Agent[], opts: GameOptions): Game {
  if (decks.length !== agents.length) throw new Error(`decks (${decks.length}) and agents (${agents.length}) differ`);
  if (decks.length < 2 || decks.length > MAX_SEATS) throw new Error(`the engine plays 2 to ${MAX_SEATS} seats (asked for ${decks.length})`);
  return new Game(decks, agents, opts);
}

/** Seat index of the winner (null: draw / turn limit). */
export function winnerSeat(g: Game): number | null { return g.state.winner; }

/** Seat index that took the first turn. */
export function firstSeat(g: Game): number {
  const line = g.state.log.find(l => l.endsWith('goes first.'));
  if (!line) return g.state.activePlayer;
  const name = line.slice(0, -' goes first.'.length);
  const i = g.state.players.findIndex(p => p.name === name);
  return i >= 0 ? i : g.state.activePlayer;
}

export function seatCount(g: Game): number { return g.state.players.length; }
