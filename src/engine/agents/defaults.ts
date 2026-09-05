// Shared fallback answers for every decision kind, so an agent written before a decision kind existed keeps
// working: agents add `default: return defaultAnswer(s, me, d)` to their switch.
import type { Decision, GameState, PlayerId } from '../state.js';
import { DECISION_DEFAULTS, HAS } from '../ops/_registry.js';

export function defaultAnswer(_s: GameState, _me: PlayerId, d: Decision): unknown {
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
    case 'choose-player': return d.options[0];
    case 'choose-number': return d.min;
    case 'order-triggers': return d.items;
    default: { if (!HAS.decisions) return undefined; const h = DECISION_DEFAULTS[(d as { kind: string }).kind]; return h ? h(_s, _me, d as never) : undefined; }
  }
}
