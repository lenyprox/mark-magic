// Rule citations for the explain layer. The engine stamps `cr` on every event through `citation()`; a few of its
// keyword-action numbers (701.x) pre-date the August 2026 renumbering of section 701, so the display layer re-derives
// those here against the CR text that ships with the app. Everything else passes through unchanged.
import type { GameEvent, GameEventBody } from '../engine/events.js';
import { citation } from '../engine/events.js';

/** Section 701 keyword actions as numbered in the CR effective August 7, 2026. */
export const KEYWORD_ACTIONS = {
  attach: '701.3a', counter: '701.6a', destroy: '701.8a', discard: '701.9a', exile: '701.13', mill: '701.17a', play: '701.18',
  regenerate: '701.19a', reveal: '701.20', sacrifice: '701.21a', scry: '701.22a', search: '701.23a', shuffle: '701.24a', surveil: '701.25a',
  tap: '701.26a', untap: '701.26b', transform: '701.27a',
} as const;

/** The CR number to show for an event (the engine's citation, corrected for renumbered keyword actions). */
export function ruleFor(ev: GameEvent | GameEventBody): string | undefined {
  switch (ev.type) {
    case 'zone-change':
      if (ev.to === 'battlefield') return ev.reason === 'play' ? '305.1' : '400.7';
      if (ev.reason === 'destroy') return KEYWORD_ACTIONS.destroy;
      if (ev.reason === 'sacrifice') return KEYWORD_ACTIONS.sacrifice;
      if (ev.reason === 'discard') return KEYWORD_ACTIONS.discard;
      if (ev.reason === 'mill') return KEYWORD_ACTIONS.mill;
      if (ev.reason === 'exile') return '406.1';
      if (ev.reason === 'mulligan') return '103.5';
      if (ev.reason === 'sba') return '704.3';
      if (ev.reason === 'cast' && ev.to === 'stack') return '601.2a';
      return '400.7';
    case 'tap': return ev.tapped ? KEYWORD_ACTIONS.tap : KEYWORD_ACTIONS.untap;
    case 'countered': return ev.unlessPaid ? '601.2' : KEYWORD_ACTIONS.counter;
    case 'attach': return KEYWORD_ACTIONS.attach;
    case 'transform': return KEYWORD_ACTIONS.transform;
    case 'library':
      return ev.action === 'scry' ? KEYWORD_ACTIONS.scry : ev.action === 'surveil' ? KEYWORD_ACTIONS.surveil : ev.action === 'search' ? KEYWORD_ACTIONS.search
        : ev.action === 'shuffle' ? KEYWORD_ACTIONS.shuffle : ev.action === 'reveal' ? KEYWORD_ACTIONS.reveal : undefined;
    case 'replaced': return ev.what === 'regenerate' ? KEYWORD_ACTIONS.regenerate : ('cr' in ev && ev.cr) || citation(ev);
    case 'sba': return ('cr' in ev && ev.cr) || citation(ev);
    default: return ('cr' in ev && ev.cr) || citation(ev);
  }
}
