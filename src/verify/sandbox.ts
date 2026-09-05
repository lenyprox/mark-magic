// The pool sandbox: one card at a time is dropped into a rigged game with plenty of mana, every legal action for it
// is performed and resolved, and the state is checked against src/engine/invariants.ts. Extracted from
// scripts/verify-pool.ts (Phase 8e) so the coordinator, its workers and the tests all run the same trial.
// `seats: 2` reproduces the original two-player sandbox exactly; `seats: 4` puts the same card into a pod.
import type { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import { findObject } from '../engine/characteristics.js';
import { cloneState } from '../engine/clone.js';
import { Game } from '../engine/game.js';
import { assertInvariants } from '../engine/invariants.js';
import { legalActions } from '../engine/legal.js';
import { defaultAnswer } from '../engine/agents/defaults.js';
import { makeObject, type Agent, type Decision, type GameState, type PlayerId } from '../engine/state.js';

/** Answers every decision the same way in every seat: keep the first cards, say yes, never mulligan. */
export class Sandbox implements Agent {
  name: string; constructor(name: string) { this.name = name; }
  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (d.kind === 'choose-cards') return d.from.slice(0, d.count);
    if (d.kind === 'yes-no') return d.tag === 'mulligan' ? false : true;
    return defaultAnswer(s, me, d);
  }
}

export type Verdict = 'sandbox-ok' | 'sandbox-throws' | 'invariant-violation' | 'unreachable' | 'skipped';
export interface Row {
  name: string; oracleId: string; verdict: Verdict; detail?: string; actions: number;
  /** Activated abilities the parser gave the card (the ones the sandbox could in principle reach). */
  abilities: number;
  /** How many of those the sandbox actually performed — `abilities - reached` is the card's unreached ability count. */
  reached: number;
}
export type Seats = 2 | 4;
/** The card under test always sits in this seat; the other seats hold the filler opponents (any pod size). */
const TRIAL_SEAT: PlayerId = 0;

export interface TrialOptions { seats: Seats; maxTurns?: number }

const SEAT_NAMES = ['A', 'B', 'C', 'D'];
const agentsFor = (seats: Seats) => Array.from({ length: seats }, (_, i) => new Sandbox(SEAT_NAMES[i]));
const structuredCloneState = (s: GameState): GameState => cloneState(s);

function withFirstTargets(l: ReturnType<typeof legalActions>[number]) {
  const reqs = l.targetOptions ?? [];
  if (!reqs.length) return l.action;
  return { ...l.action, targets: reqs.map(r => r.options.slice(0, r.count)) } as typeof l.action;
}

/** Indexes into `def.abilities` that the sandbox could reach by activating them (`legalActions` keys off the index). */
const activatedIndexes = (def: CardDef): number[] => def.abilities.flatMap((a, i) => (a.kind === 'activated' ? [i] : []));

/**
 * Put `def` in seat 0's hand in a sandbox of `opts.seats` players, try up to six of its legal actions (each on a
 * fresh clone), resolve, run its activated abilities and a full turn, and check the invariants after each stage.
 * Every activated ability the trial performs is recorded, so the report can say which abilities stayed unreached.
 */
export async function trialCard(cards: CardDB, def: CardDef, opts: TrialOptions): Promise<Row> {
  const seats = opts.seats; const maxTurns = opts.maxTurns ?? 4;
  const activatable = new Set(activatedIndexes(def));
  const reached = new Set<number>();
  const record = (a: { type: string; abilityIndex?: number }) => { if (a.type === 'activate' && a.abilityIndex !== undefined && activatable.has(a.abilityIndex)) reached.add(a.abilityIndex); };
  const row = (verdict: Verdict, actions: number, detail?: string): Row =>
    ({ name: def.name, oracleId: def.oracleId, verdict, ...(detail === undefined ? {} : { detail }), actions, abilities: activatable.size, reached: reached.size });
  const lands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].map(n => cards.get(n)!);
  const filler = Array(10).fill(cards.get('Forest')!);
  const g = new Game(Array.from({ length: seats }, () => filler), agentsFor(seats), { seed: 1, quiet: true, mulligans: false, events: 'counts', maxTurns });
  const s = g.state; s.turn = 5; s.activePlayer = 0; s.step = 'main1'; s.priority = 0;
  const put = (pid: PlayerId, d: CardDef, zone: 'hand' | 'battlefield') => { const o = makeObject(s.nextId++, d, pid, zone, 1); o.enteredTurn = 1; s.players[pid][zone].push(o); return o; };
  for (const l of lands) for (let i = 0; i < 3; i++) put(0, l, 'battlefield');
  for (let pid = 1; pid < seats; pid++) { put(pid, cards.get('Grizzly Bears')!, 'battlefield'); put(pid, cards.get('Hill Giant')!, 'battlefield'); }
  const isPermanent = !(def.types.includes('Instant') || def.types.includes('Sorcery'));
  const card = put(0, def, 'hand');
  let actions = 0;
  try {
    const legal = legalActions(g, 0).filter(l => (l.action.type === 'cast' && l.action.cardId === card.id) || (l.action.type === 'play-land' && l.action.cardId === card.id) || (l.action.type === 'activate' && l.action.objectId === card.id));
    for (const l of legal.slice(0, 6)) {
      const g2 = Game.fromState(structuredCloneState(s), agentsFor(seats), { quiet: true, seed: 1, events: 'counts', maxTurns });
      const concrete = withFirstTargets(l);
      const ok = await g2.performAction(0, concrete);
      if (!ok) continue;
      actions++; record(concrete);
      await g2.resolveStackFully();
      const v = assertInvariants(g2.state); if (v) return row('invariant-violation', actions, `after ${l.label}: ${v}`);
      // permanents: try each activated ability once it is on the battlefield, then attack, then a full turn
      const perm = findObject(g2.state, card.id);
      if (perm && perm.zone === 'battlefield') {
        for (const a of legalActions(g2, 0).filter(x => x.action.type === 'activate' && x.action.objectId === card.id).slice(0, 4)) { const act = withFirstTargets(a); const ok2 = await g2.performAction(0, act); if (ok2) { actions++; record(act); await g2.resolveStackFully(); } }
        const v2 = assertInvariants(g2.state); if (v2) return row('invariant-violation', actions, `after abilities: ${v2}`);
        await g2.resumeTurn(); await g2.playTurns(1);
        const v3 = assertInvariants(g2.state); if (v3) return row('invariant-violation', actions, `after a turn: ${v3}`);
      }
    }
    if (!actions && isPermanent && !def.types.includes('Land')) {
      // uncastable in the sandbox (alternative costs, X, timing): drop it on the battlefield and run a turn
      const g3 = Game.fromState(structuredCloneState(s), agentsFor(seats), { quiet: true, seed: 1, events: 'counts', maxTurns });
      const hand = g3.state.players[TRIAL_SEAT].hand.find(o => o.id === card.id)!; g3.state.players[TRIAL_SEAT].hand.splice(g3.state.players[TRIAL_SEAT].hand.indexOf(hand), 1);
      hand.zone = 'battlefield'; hand.enteredTurn = 1; g3.state.players[TRIAL_SEAT].battlefield.push(hand);
      g3.checkSBA(); await g3.resumeTurn(); await g3.playTurns(1);
      const v = assertInvariants(g3.state); if (v) return row('invariant-violation', actions, `on battlefield: ${v}`);
      return row('unreachable', actions, 'no castable action in the sandbox (played on the battlefield instead)');
    }
    return row(actions ? 'sandbox-ok' : 'unreachable', actions);
  } catch (e) {
    return row('sandbox-throws', actions, (e as Error).message);
  }
}
