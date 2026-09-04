// An agent wrapper that applies the batch mulligan policy and records what the optimiser later wants per seat
// (mulligans, opening hand, first commander cast) without touching the engine. `seen` is read off the final state.
import { findObject, isLand } from '../engine/characteristics.js';
import type { Agent, Decision, GameState, PlayerAction, PlayerId } from '../engine/state.js';
import type { MulliganPolicy } from './types.js';

export interface SeatStats { mulligans: number; openingHand: string[] | null; firstCommanderCastTurn: number | null; decisions: number }

export interface InstrumentOptions { mulligan: MulliganPolicy; commanders: ReadonlySet<string> }

export class InstrumentedAgent implements Agent {
  name: string;
  hidden?: boolean;
  stats: SeatStats = { mulligans: 0, openingHand: null, firstCommanderCastTurn: null, decisions: 0 };
  constructor(readonly inner: Agent, private readonly opts: InstrumentOptions) {
    this.name = inner.name; this.hidden = inner.hidden;
    if (inner.onLog) this.onLog = line => inner.onLog!(line);
  }
  onLog?: (line: string) => void;

  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    this.stats.decisions++;
    if (d.kind === 'yes-no' && (d.tag === 'mulligan' || d.prompt.startsWith('Mulligan'))) {
      const mull = this.shouldMulligan(s, me);
      if (mull) this.stats.mulligans++;
      return mull;
    }
    // The starting player skips the turn-1 draw and the other player has not drawn yet, so the hand at the first
    // decision of turn 1 is the kept opening hand (after any cards put on the bottom).
    if (this.stats.openingHand === null && s.turn >= 1) this.stats.openingHand = s.players[me].hand.map(c => c.def.name);
    const answer = await this.inner.decide(s, me, d);
    if (d.kind === 'priority' && this.opts.commanders.size && this.stats.firstCommanderCastTurn === null) {
      const a = answer as PlayerAction | undefined;
      if (a && a.type === 'cast') { const c = findObject(s, a.cardId); if (c && this.opts.commanders.has(c.def.name)) this.stats.firstCommanderCastTurn = s.turn; }
    }
    return answer;
  }

  /** The AI's keep rule: mulligan a seven with 0-1 or 6-7 lands, once. */
  shouldMulligan(s: GameState, me: PlayerId): boolean {
    if (this.opts.mulligan === 'none' || this.stats.mulligans >= 1) return false;
    const hand = s.players[me].hand; if (hand.length < 7) return false;
    const lands = hand.filter(isLand).length;
    return lands <= 1 || lands >= 6;
  }
}

/** Names of every non-token card `seat` owns that is no longer in its library (drawn, played, milled, exiled...). */
export function seenNames(s: GameState, seat: PlayerId): string[] {
  const p = s.players[seat]; const out: string[] = [];
  for (const zone of [p.hand, p.battlefield, p.graveyard, p.exile]) for (const o of zone) if (!o.token && o.owner === seat) out.push(o.def.name);
  for (const it of s.stack) if (it.kind === 'spell' && it.source.owner === seat && !it.source.token) out.push(it.source.def.name);
  // cards controlled by the other seat but owned by this one (stolen) still count as seen
  for (const q of s.players) if (q.id !== seat) for (const o of q.battlefield) if (!o.token && o.owner === seat) out.push(o.def.name);
  return out.sort();
}
