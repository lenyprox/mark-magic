// Typed game events. Every observable change the engine makes is emitted through Game.emit as one of these, in
// order, with a sequence number, the turn and the step. `renderEvent` turns an event into the log line the engine
// used to write directly, so the string log stays byte-for-byte what it was while the UI, the analysis layer and
// the replay/animation queue can consume structured data instead of grepping text.
import type { ManaSymbol } from '../cards/types.js';
import type { Decision, PlayerId, Step, Zone } from './state.js';
import { EVENT_META, HAS } from './ops/_registry.js';

export type EventMode = 'none' | 'counts' | 'full';

export type ZoneRef = Zone | 'none';
export type ZoneChangeReason = 'draw' | 'discard' | 'destroy' | 'sacrifice' | 'mill' | 'exile' | 'bounce' | 'cast' | 'resolve' | 'countered' | 'play' | 'enter' | 'token' | 'dredge' | 'search' | 'dig' | 'tuck' | 'mulligan' | 'sba' | 'cost' | 'effect' | 'return';

export type SbaKind = 'lethal-damage' | 'zero-toughness' | 'zero-loyalty' | 'aura-unattached' | 'legend-rule' | 'saga-final' | 'life' | 'poison' | 'counters-cancel' | 'empty-library' | 'commander-damage';

interface Base { seq: number; turn: number; step: Step; /** The log line this event produced (empty for silent events). */ text: string; /** Comprehensive Rules citation, when one applies. */ cr?: string }

export type CoreGameEventBody =
  | { type: 'game-start'; first: PlayerId; players: string[] }
  | { type: 'mulligan'; player: PlayerId; count: number }
  | { type: 'turn'; player: PlayerId; number: number }
  | { type: 'step'; player: PlayerId; to: Step }
  | { type: 'decision'; player: PlayerId; kind: Decision['kind'] }
  | { type: 'zone-change'; id: number; name: string; owner: PlayerId; controller: PlayerId; from: ZoneRef; to: ZoneRef; reason: ZoneChangeReason; token: boolean; /** Whether the card's identity is public knowledge after this move. */ public: boolean; libraryPos?: 'top' | 'bottom'; tapped?: boolean }
  | { type: 'draw'; player: PlayerId; id: number; name: string; public: boolean; stepDraw: boolean }
  | { type: 'damage'; sourceId: number; source: string; player?: PlayerId; targetId?: number; target?: string; amount: number; combat: boolean; total: number; loyalty?: boolean }
  | { type: 'life'; player: PlayerId; delta: number; total: number; reason: string }
  | { type: 'tap'; id: number; name: string; tapped: boolean; reason?: 'cost' | 'attack' | 'effect' | 'untap-step' | 'mana' }
  | { type: 'counter'; id: number; name: string; counter: string; delta: number; total: number }
  | { type: 'create-token'; id: number; name: string; controller: PlayerId; power: number; toughness: number; count?: number }
  | { type: 'control'; id: number; name: string; from: PlayerId; to: PlayerId }
  | { type: 'attach'; id: number; name: string; to: number | null; toName?: string }
  | { type: 'transform'; id: number; name: string; into: string; face: 0 | 1 }
  | { type: 'cast'; itemId: number; id: number; name: string; player: PlayerId; targets: string[]; how: string[]; x?: number }
  | { type: 'activate'; itemId: number; id: number; name: string; player: PlayerId; ability: string; targets: string[] }
  | { type: 'trigger'; itemId: number; id: number; name: string; player: PlayerId; ability: string; targets: string[] }
  | { type: 'resolve'; itemId: number; name: string; kind: 'spell' | 'ability' | 'trigger' }
  | { type: 'fizzle'; itemId: number; name: string; reason: 'all-targets-illegal' | 'enchant-target-illegal' }
  | { type: 'countered'; itemId: number; name: string; by?: string; unlessPaid?: boolean }
  | { type: 'attack'; player: PlayerId; target: PlayerId; attackers: { id: number; name: string }[]; /** Per attacker: the defending player, or the planeswalker (object id) it attacks. */ targets?: Record<number, PlayerId | { planeswalker: number }> }
  | { type: 'block'; player: PlayerId; blocks: { blocker: number; blockerName: string; attacker: number; attackerName: string }[] }
  | { type: 'sba'; kind: SbaKind; id?: number; name?: string; player?: PlayerId; detail?: string }
  | { type: 'player-eliminated'; player: PlayerId; reason: string }
  | { type: 'game-over'; winner: PlayerId | null; reason: string }
  | { type: 'replaced'; what: 'regenerate' | 'indestructible' | 'protection' | 'rebound' | 'dredge' | 'mox-diamond' | 'exile-instead' | 'shuffle-instead' | 'commander-zone'; id?: number; name?: string }
  | { type: 'prevented'; id?: number; name?: string; player?: PlayerId; amount: number | 'all'; by: string }
  | { type: 'mana'; player: PlayerId; added: ManaSymbol[]; source?: string }
  | { type: 'library'; player: PlayerId; action: 'shuffle' | 'scry' | 'surveil' | 'look' | 'reveal' | 'search' | 'dig' | 'order'; count?: number; found?: string[]; cards?: string[] }
  | { type: 'unsimulated'; id: number; name: string; clause: string }
  | { type: 'extra-turn'; player: PlayerId }
  | { type: 'note'; text: string; tag?: 'manual' | 'engine' };
/** Families add events by augmenting EventRegistry; EVENT_META[type] carries their logged flag, CR citation and renderer. */
export interface EventRegistry {}
export type GameEventBody = CoreGameEventBody | EventRegistry[keyof EventRegistry];

export type GameEvent = Base & GameEventBody;
export type GameEventType = GameEventBody['type'];

/** Event types whose rendered text is appended to the string log (the rest are silent structure). */
const CORE_LOGGED: ReadonlySet<string> = new Set<string>([
  'game-start', 'mulligan', 'turn', 'zone-change', 'draw', 'damage', 'life', 'create-token', 'control', 'attach', 'transform', 'cast', 'activate', 'trigger', 'resolve', 'fizzle', 'countered', 'attack', 'block', 'sba', 'player-eliminated', 'game-over', 'replaced', 'prevented', 'library', 'unsimulated', 'extra-turn', 'note',
]);
/** Set-like view over the core set plus every registered family event that asks to be logged. */
export const LOGGED: { has(t: GameEventType): boolean } = { has: (t: GameEventType): boolean => CORE_LOGGED.has(t as string) || (HAS.events && EVENT_META[t as string]?.logged === true) };

/** CR citations for the events that have a canonical rule. */
export function citation(ev: GameEventBody): string | undefined {
  switch (ev.type) {
    case 'draw': return ev.stepDraw ? '504.1' : '121.1';
    case 'step': return { untap: '502.1', upkeep: '503.1', draw: '504.1', main1: '505.1', 'combat-begin': '507.1', 'declare-attackers': '508.1', 'declare-blockers': '509.1', 'first-strike-damage': '510.4', 'combat-damage': '510.1', 'combat-end': '511.1', main2: '505.1', end: '513.1', cleanup: '514.1' }[ev.to];
    case 'cast': return '601.2';
    case 'activate': return '602.2';
    case 'trigger': return '603.2';
    case 'resolve': return ev.kind === 'spell' ? '608.2' : '608.2';
    case 'fizzle': return '608.2b';
    case 'countered': return '701.6a';
    case 'attack': return '508.1';
    case 'block': return '509.1';
    case 'damage': return ev.combat ? '510.2' : '120.3';
    case 'life': return ev.delta < 0 ? '119.3' : '119.3';
    case 'sba': return { 'lethal-damage': '704.5g', 'zero-toughness': '704.5f', 'zero-loyalty': '704.5i', 'aura-unattached': '704.5m', 'legend-rule': '704.5j', 'saga-final': '714.4', life: '704.5a', poison: '704.5c', 'counters-cancel': '704.5q', 'empty-library': '704.5b', 'commander-damage': '704.6c' }[ev.kind];
    case 'player-eliminated': return '104.3';
    case 'game-over': return ev.winner === null ? '104.4' : '104.2';
    case 'replaced': return ev.what === 'regenerate' ? '701.19a' : ev.what === 'indestructible' ? '702.12b' : ev.what === 'protection' ? '702.16' : ev.what === 'rebound' ? '702.88' : ev.what === 'dredge' ? '702.52' : ev.what === 'commander-zone' ? '903.9a' : '614.1';
    case 'prevented': return '615.1';
    case 'mulligan': return '103.5';
    case 'transform': return '712.1';
    case 'control': return '108.4';
    case 'create-token': return '111.1';
    case 'extra-turn': return '500.7';
    case 'mana': return '106.4';
    case 'library': return ev.action === 'scry' ? '701.22a' : ev.action === 'surveil' ? '701.25a' : ev.action === 'search' ? '701.23a' : ev.action === 'shuffle' ? '701.24a' : undefined;
    case 'zone-change': return ev.to === 'battlefield' ? '400.7' : ev.reason === 'destroy' ? '701.8a' : ev.reason === 'sacrifice' ? '701.21a' : ev.reason === 'discard' ? '701.9a' : ev.reason === 'mill' ? '701.17a' : ev.reason === 'exile' ? '406.1' : '400.7';
    case 'tap': return ev.tapped ? '701.26a' : '701.26b';
    case 'counter': return '122.1';
    default: return EVENT_META[(ev as { type: string }).type]?.cr;
  }
}

/** The log line an event produces. Names of players are resolved by the caller through `pname`. */
export function renderEvent(ev: GameEventBody, pname: (p: PlayerId) => string): string {
  switch (ev.type) {
    case 'game-start': return `${pname(ev.first)} goes first.`;
    case 'mulligan': return `${pname(ev.player)} mulligans.`;
    case 'turn': return `\n=== Turn ${ev.number}: ${pname(ev.player)} ===`;
    case 'draw': return `${pname(ev.player)} draws a card.`;
    case 'damage': {
      if (ev.player !== undefined) return `${ev.source} deals ${ev.amount} damage to ${pname(ev.player)} (${ev.total}).`;
      if (ev.loyalty) return `${ev.source} deals ${ev.amount} damage to ${ev.target} (loyalty ${ev.total}).`;
      return `${ev.source} deals ${ev.amount} damage to ${ev.target}#${ev.targetId}.`;
    }
    case 'life': return ev.delta >= 0 ? `${pname(ev.player)} gains ${ev.delta} life (${ev.total}).` : `${pname(ev.player)} loses ${-ev.delta} life (${ev.total}) — ${ev.reason}.`;
    case 'create-token': return `${pname(ev.controller)} creates ${ev.count ?? 1} ${ev.power}/${ev.toughness} ${ev.name} token${(ev.count ?? 1) > 1 ? 's' : ''}.`;
    case 'control': return `${pname(ev.to)} gains control of ${ev.name}.`;
    case 'attach': return ev.to === null ? `${ev.name} becomes unattached.` : `${ev.name} is attached to ${ev.toName}.`;
    case 'transform': return `${ev.name} transforms into ${ev.into}.`;
    case 'cast': return `${pname(ev.player)} casts ${ev.name}${ev.targets.length ? ` targeting ${ev.targets.join(', ')}` : ''}${ev.x ? ` (X=${ev.x})` : ''}${ev.how.length ? ` (${ev.how.join(', ')})` : ''}.`;
    case 'activate': return `${pname(ev.player)} activates ${ev.name}: ${ev.ability}${ev.targets.length ? ` targeting ${ev.targets.join(', ')}` : ''}.`;
    case 'trigger': return `Trigger: ${ev.name} trigger: ${ev.ability}`;
    case 'resolve': return `${ev.name} resolves.`;
    case 'fizzle': return `${ev.name} fizzles (${ev.reason === 'enchant-target-illegal' ? 'enchant target illegal' : 'all targets illegal'}).`;
    case 'countered': return ev.unlessPaid ? `${ev.name} is not countered.` : `${ev.name} is countered.`;
    case 'attack': return `${pname(ev.player)} attacks with ${ev.attackers.map(a => `${a.name}#${a.id}`).join(', ')}.`;
    case 'block': {
      if (!ev.blocks.length) return `${pname(ev.player)} declares no blocks.`;
      const by = new Map<number, { name: string; blockers: string[] }>();
      for (const b of ev.blocks) { const e = by.get(b.attacker) ?? { name: b.attackerName, blockers: [] }; e.blockers.push(`${b.blockerName}#${b.blocker}`); by.set(b.attacker, e); }
      return `${pname(ev.player)} blocks: ${[...by].map(([id, e]) => `${e.name}#${id} blocked by ${e.blockers.join(' + ')}`).join('; ')}.`;
    }
    case 'sba': {
      switch (ev.kind) {
        case 'zero-toughness': return `${ev.name}#${ev.id} has toughness ${ev.detail} and is put into the graveyard.`;
        case 'zero-loyalty': return `${ev.name} has 0 loyalty.`;
        case 'aura-unattached': return `${ev.name} is put into the graveyard (not attached).`;
        case 'legend-rule': return `Legend rule: ${ev.name}#${ev.id} is put into the graveyard.`;
        case 'saga-final': return `${ev.name} is sacrificed (final chapter).`;
        case 'lethal-damage': return `${ev.name}#${ev.id} is destroyed.`;
        case 'commander-damage': return `${pname(ev.player!)} has taken 21 or more combat damage from ${ev.name}.`;
        default: return ev.detail ?? '';
      }
    }
    case 'player-eliminated': return `${pname(ev.player)} loses (${ev.reason}).`;
    case 'game-over': return ev.winner === null ? ev.reason : `${pname(ev.winner)} wins the game.`;
    case 'replaced': {
      switch (ev.what) {
        case 'regenerate': return `${ev.name} regenerates.`;
        case 'indestructible': return `${ev.name} is indestructible.`;
        case 'protection': return `${ev.name} has protection; damage prevented.`;
        case 'rebound': return `${ev.name} is exiled (rebound); it may be cast for free during its owner's next upkeep.`;
        case 'mox-diamond': return `${ev.name} is put into its owner's graveyard instead of entering.`;
        case 'commander-zone': return `${ev.name} is put into the command zone instead.`;
        default: return `${ev.name ?? 'It'} is replaced (${ev.what}).`;
      }
    }
    case 'prevented': return ev.player !== undefined ? `Damage to ${pname(ev.player)} prevented.` : `Damage to ${ev.name} prevented.`;
    case 'library': {
      switch (ev.action) {
        case 'shuffle': return `${pname(ev.player)} shuffles.`;
        case 'reveal': return `${pname(ev.player)} reveals ${ev.cards?.join(', ') ?? ''}.`;
        case 'search': return ev.found?.length ? `${pname(ev.player)} searches for ${ev.found.join(', ')}.` : `${pname(ev.player)} searches and finds nothing.`;
        case 'dig': return `${pname(ev.player)} looks at the top ${ev.count} card${(ev.count ?? 1) > 1 ? 's' : ''}${ev.found?.length ? ` and takes ${ev.found.length}` : ''}.`;
        case 'look': return `${pname(ev.player)} looks at the top card of their library${ev.cards?.length ? ` (${ev.cards[0]})` : ''}.`;
        default: return '';
      }
    }
    case 'unsimulated': return `  (unsimulated text: "${ev.clause}")`;
    case 'extra-turn': return `${pname(ev.player)} will take an extra turn.`;
    case 'note': return ev.text;
    case 'zone-change': return zoneChangeText(ev, pname);
    default: { const m = EVENT_META[(ev as { type: string }).type]; return m?.render ? m.render(ev, pname) : ''; }
  }
}

function zoneChangeText(ev: Extract<GameEventBody, { type: 'zone-change' }>, pname: (p: PlayerId) => string): string {
  switch (ev.reason) {
    case 'discard': return `${pname(ev.owner)} discards ${ev.name}.`;
    case 'destroy': return `${ev.name}#${ev.id} is destroyed.`;
    case 'sacrifice': return `${pname(ev.controller)} sacrifices ${ev.name}#${ev.id}.`;
    case 'play': return `${pname(ev.controller)} plays ${ev.name}${ev.tapped ? ' (tapped)' : ''}.`;
    case 'resolve': return ev.to === 'battlefield' ? `${ev.name} enters the battlefield under ${pname(ev.controller)}'s control${ev.tapped ? ' tapped' : ''}.` : '';
    default: return '';
  }
}

/** Public-knowledge rule for a zone change: identity is public when either end is a public zone (CR 400.2). */
export function zoneIsPublic(z: ZoneRef): boolean { return z === 'battlefield' || z === 'graveyard' || z === 'exile' || z === 'stack' || z === 'command'; }

/** Redact an event for a viewer: hide the identity of cards the viewer may not know. */
export function redactEvent(ev: GameEvent, viewer: PlayerId | null): GameEvent {
  if (viewer === null) return ev;
  if (ev.type === 'draw' && ev.player !== viewer && !ev.public) return { ...ev, name: '', text: ev.text };
  if (ev.type === 'zone-change' && !ev.public && ev.owner !== viewer) return { ...ev, name: '' };
  return ev;
}
