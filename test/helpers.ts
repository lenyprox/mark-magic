// Shared test helpers: real cards from master.db, a scriptable agent, and a scenario builder.
import { CardDB } from '../src/cards/db.js';
import { Game } from '../src/engine/game.js';
import type { Agent, Decision, GameObject, GameState, PlayerId } from '../src/engine/state.js';
import type { CardDef } from '../src/cards/types.js';
import { defaultAnswer } from '../src/engine/agents/defaults.js';

export const db = CardDB.shared();
export const C = (n: string): CardDef => { const d = db.get(n); if (!d) throw new Error('missing card ' + n); return d; };

/** A scripted agent: passes priority unless a script says otherwise; blocks/attacks per script. */
export class Script implements Agent {
  name: string; queue: ((s: GameState, d: Decision) => unknown)[] = [];
  constructor(name: string) { this.name = name; }
  async decide(s: GameState, _me: PlayerId, d: Decision): Promise<unknown> {
    if (this.queue.length) { const f = this.queue[0]; const r = f(s, d); if (r !== undefined) { this.queue.shift(); return r; } }
    switch (d.kind) {
      case 'priority': return { type: 'pass' };
      case 'attackers': return { attackers: d.mustAttack };
      case 'blockers': return { blocks: [] };
      case 'choose-cards': return d.from.slice(0, d.count);
      case 'yes-no': return d.tag === 'dredge' || d.tag === 'optional' ? false : !d.prompt.startsWith('Mulligan');
      case 'choose-mode': return [0];
      case 'choose-color': return 'R';
      case 'choose-option': return d.options[0];
      case 'order-blockers': return d.blockers;
      default: return defaultAnswer(s, _me, d);
    }
  }
}

export interface Side { bf?: string[]; hand?: string[]; life?: number; library?: string[] }

/** Build a game with a prepared battlefield/hand for quick scenario tests. */
export function setup(p0: Side, p1: Side, agents?: [Agent, Agent], opts: { seed?: number } = {}) {
  const filler = Array(30).fill(C('Mountain'));
  const a: [Agent, Agent] = agents ?? [new Script('P0'), new Script('P1')];
  const g = new Game([p0.library ? p0.library.map(C) : filler, p1.library ? p1.library.map(C) : filler], a, { seed: opts.seed ?? 1, quiet: true, mulligans: false });
  const s = g.state;
  s.turn = 5; s.activePlayer = 0; s.step = 'main1';
  const put = (pid: PlayerId, cfg: Side) => {
    const pl = s.players[pid];
    pl.life = cfg.life ?? 20;
    for (const n of cfg.bf ?? []) { const o = { ...pl.library.pop()!, def: C(n) } as GameObject; o.zone = 'battlefield'; o.enteredTurn = 1; o.controller = pid; o.owner = pid; o.counters = {}; o.activatedThisTurn = new Set(); pl.battlefield.push(o); }
    for (const n of cfg.hand ?? []) { const o = { ...pl.library.pop()!, def: C(n) } as GameObject; o.zone = 'hand'; o.owner = pid; o.controller = pid; o.activatedThisTurn = new Set(); pl.hand.push(o); }
  };
  put(0, p0); put(1, p1);
  return g;
}
export const find = (g: Game, n: string, pid?: PlayerId) => [...(pid == null ? [...g.state.players[0].battlefield, ...g.state.players[1].battlefield] : g.state.players[pid].battlefield)].find(o => o.def.name === n)!;
export const inHand = (g: Game, n: string, pid: PlayerId) => g.state.players[pid].hand.find(o => o.def.name === n)!;
