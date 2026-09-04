// A transport-agnostic human agent: every decision the engine asks for is forwarded to an `ask` callback
// (readline in the CLI, postMessage in the web worker) and the engine awaits the answer. Priority decisions
// outside the configured "stops" are auto-passed, mirroring the original terminal client's behaviour.
import type { Agent, Decision, GameState, PlayerAction, PlayerId } from '../state.js';
import { defaultAnswer } from './defaults.js';

export interface StopPolicy {
  ownMain: boolean;        // stop in my main phases
  ownCombatBegin: boolean; // stop at my beginning of combat
  ownBlockers: boolean;    // stop after blockers are declared on my turn (combat tricks)
  ownEnd: boolean;         // stop at my end step
  oppUpkeep: boolean;
  oppMain: boolean;
  oppAttackers: boolean;   // stop after the opponent declares attackers
  oppBlockers: boolean;    // stop after blockers are declared on the opponent's turn
  oppEnd: boolean;         // stop at the opponent's end step
  alwaysOnStack: boolean;  // always stop when something is on the stack
}

export const DEFAULT_STOPS: StopPolicy = {
  ownMain: true, ownCombatBegin: false, ownBlockers: true, ownEnd: false,
  oppUpkeep: false, oppMain: false, oppAttackers: true, oppBlockers: true, oppEnd: true, alwaysOnStack: true,
};

export interface AskRequest { id: number; decision: Decision; state: GameState; me: PlayerId }
export interface RecordedAnswer { id: number; kind: Decision['kind']; answer: unknown }

export interface DeferredAgentOptions {
  name: string;
  ask: (req: AskRequest) => Promise<unknown>;
  stops?: Partial<StopPolicy>;
  onLog?: (line: string) => void;
  /** When true the engine hands this agent a redacted view of the state (see engine/view.ts). */
  hidden?: boolean;
}

export class DeferredAgent implements Agent {
  name: string;
  stops: StopPolicy;
  hidden: boolean;
  wantsHints = true;
  onLog?: (line: string) => void;
  /** Every answer given, in order: enough to replay a game deterministically with the same seed. */
  recorded: RecordedAnswer[] = [];
  private ask: (req: AskRequest) => Promise<unknown>;
  private nextId = 1;

  constructor(opts: DeferredAgentOptions) {
    this.name = opts.name; this.ask = opts.ask; this.stops = { ...DEFAULT_STOPS, ...(opts.stops ?? {}) };
    this.onLog = opts.onLog; this.hidden = opts.hidden ?? true;
  }

  setStops(stops: Partial<StopPolicy>) { this.stops = { ...this.stops, ...stops }; }

  /** Should a priority decision be presented to the human, or auto-passed? */
  shouldStop(s: GameState, me: PlayerId, d: Decision): boolean {
    if (d.kind !== 'priority') return true;
    const actionable = d.legal.some(l => l.action.type !== 'pass');
    const stackNonEmpty = s.stack.length > 0;
    if (!actionable && !stackNonEmpty) return false;
    if (stackNonEmpty && this.stops.alwaysOnStack) return true;
    const myTurn = s.activePlayer === me; const st = this.stops;
    if (myTurn) {
      if ((s.step === 'main1' || s.step === 'main2') && st.ownMain) return true;
      if (s.step === 'combat-begin' && st.ownCombatBegin) return true;
      if (s.step === 'declare-blockers' && st.ownBlockers) return true;
      if (s.step === 'end' && st.ownEnd) return true;
      return false;
    }
    if (s.step === 'upkeep' && st.oppUpkeep) return true;
    if ((s.step === 'main1' || s.step === 'main2') && st.oppMain) return true;
    if (s.step === 'declare-attackers' && st.oppAttackers) return true;
    if (s.step === 'declare-blockers' && st.oppBlockers) return true;
    if (s.step === 'end' && st.oppEnd) return true;
    return false;
  }

  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (d.kind === 'priority' && !this.shouldStop(s, me, d)) return { type: 'pass' } satisfies PlayerAction;
    const id = this.nextId++;
    const answer = await this.ask({ id, decision: d, state: s, me });
    this.recorded.push({ id, kind: d.kind, answer });
    return answer;
  }
}

/** Replays a recorded list of answers (from DeferredAgent.recorded) in order; falls back to safe defaults when exhausted. */
export class ReplayAgent implements Agent {
  name: string;
  private i = 0;
  constructor(name: string, private answers: RecordedAnswer[]) { this.name = name; }
  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    const r = this.answers[this.i];
    if (r && r.kind === d.kind) { this.i++; return r.answer; }
    switch (d.kind) {
      case 'priority': return { type: 'pass' };
      case 'attackers': return { attackers: d.mustAttack };
      case 'blockers': return { blocks: [] };
      case 'choose-cards': return d.from.slice(0, d.exact ? d.count : 0);
      case 'yes-no': return d.tag === 'dredge' || d.tag === 'optional' ? false : !d.prompt.startsWith('Mulligan');
      case 'choose-mode': return [0];
      case 'choose-color': return 'G';
      case 'choose-option': return d.options[0];
      case 'order-blockers': return d.blockers;
      default: return defaultAnswer(s, me, d);
    }
  }
}
