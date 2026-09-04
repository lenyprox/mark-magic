// The pure part of the table's animation queue: how long each event plays for, what it touches, which rule chip it
// shows and how it reads in words. The browser-side queue (apps/web/lib/game/animQueue.ts) drains events through
// these functions; this file has no DOM so it is unit-tested under node.
import type { GameEvent } from '../engine/events.js';
import type { PlayerId, Step } from '../engine/state.js';
import { ruleFor } from '../rules/cite.js';

export type AnimKind =
  | 'draw' | 'play' | 'enter' | 'cast' | 'mana-tap' | 'tap' | 'untap' | 'trigger' | 'activate' | 'resolve' | 'counter-spell' | 'fizzle' | 'damage' | 'life'
  | 'counter' | 'token' | 'death' | 'leave' | 'attack' | 'block' | 'step' | 'turn' | 'control' | 'attach' | 'transform' | 'replaced' | 'prevented'
  | 'shuffle' | 'eliminated' | 'game-over' | 'mulligan' | 'extra-turn' | 'silent';

/** Base durations in milliseconds at 1× (the plan's mapping table). */
export const BASE_MS: Record<AnimKind, number> = {
  draw: 280, play: 320, enter: 320, cast: 380, 'mana-tap': 40, tap: 120, untap: 40, trigger: 240, activate: 300, resolve: 360, 'counter-spell': 320, fizzle: 320,
  damage: 320, life: 320, counter: 220, token: 280, death: 420, leave: 260, attack: 260, block: 260, step: 160, turn: 500, control: 320, attach: 260, transform: 360,
  replaced: 240, prevented: 240, shuffle: 200, eliminated: 400, 'game-over': 0, mulligan: 200, 'extra-turn': 300, silent: 0,
};

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 4;
export const RUSH_SPEED = 4;
/** A decision arriving with more than this much queue left makes the rest play at RUSH_SPEED. */
export const RUSH_THRESHOLD_MS = 1200;
/** The explain toggle halves playback speed and shows rule chips inline. */
export const EXPLAIN_FACTOR = 0.5;
/** How long an inline rule chip stays on screen (ms at 1×). */
export const CHIP_MS = 320;
/** How long a trigger glow stays on screen (ms at 1×). */
export const GLOW_MS = 240;

export const clampSpeed = (s: number): number => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(s) ? s : 1));

export function classify(ev: GameEvent): AnimKind {
  switch (ev.type) {
    case 'draw': return 'draw';
    case 'zone-change':
      if (ev.to === 'battlefield') return ev.token ? 'token' : ev.reason === 'play' ? 'play' : 'enter';
      if (ev.to === 'stack') return 'silent';                       // the following `cast` event plays the FLIP
      if (ev.from === 'battlefield') return ev.reason === 'destroy' || ev.reason === 'sba' || ev.reason === 'sacrifice' ? 'death' : 'leave';
      if (ev.from === 'stack') return 'silent';                     // covered by resolve / countered / fizzle
      if (ev.reason === 'mulligan') return 'silent';
      return 'leave';
    case 'cast': return 'cast';
    case 'tap': return ev.reason === 'mana' ? 'mana-tap' : ev.tapped ? 'tap' : 'untap';
    case 'trigger': return 'trigger';
    case 'activate': return 'activate';
    case 'resolve': return 'resolve';
    case 'countered': return ev.unlessPaid ? 'silent' : 'counter-spell';
    case 'fizzle': return 'fizzle';
    case 'damage': return 'damage';
    case 'life': return 'life';
    case 'counter': return 'counter';
    case 'create-token': return 'silent';                            // the token's zone-change materialises it
    case 'sba': return ev.kind === 'lethal-damage' || ev.kind === 'zero-toughness' || ev.kind === 'zero-loyalty' || ev.kind === 'legend-rule' || ev.kind === 'aura-unattached' || ev.kind === 'saga-final' ? 'death' : 'silent';
    case 'attack': return ev.attackers.length ? 'attack' : 'silent';
    case 'block': return 'block';
    case 'step': return 'step';
    case 'turn': return 'turn';
    case 'control': return 'control';
    case 'attach': return 'attach';
    case 'transform': return 'transform';
    case 'replaced': return 'replaced';
    case 'prevented': return 'prevented';
    case 'library': return ev.action === 'shuffle' ? 'shuffle' : 'silent';
    case 'player-eliminated': return 'eliminated';
    case 'game-over': return 'game-over';
    case 'mulligan': return 'mulligan';
    case 'extra-turn': return 'extra-turn';
    default: return 'silent';
  }
}

/** Milliseconds this event plays for at `speed`; zero under reduced motion. `explain` halves the speed. */
export function durationFor(ev: GameEvent, speed = 1, reducedMotion = false, explain = false): number {
  if (reducedMotion) return 0;
  const base = BASE_MS[classify(ev)];
  if (!base) return 0;
  const s = clampSpeed(speed) * (explain ? EXPLAIN_FACTOR : 1);
  return Math.round(base / s);
}

/** Objects and players an event touches (for glows, chips and "show me"). */
export function involvedInEvent(ev: GameEvent): { objects: number[]; players: PlayerId[] } {
  const objects: number[] = []; const players: PlayerId[] = [];
  switch (ev.type) {
    case 'draw': objects.push(ev.id); players.push(ev.player); break;
    case 'zone-change': objects.push(ev.id); break;
    case 'damage': objects.push(ev.sourceId); if (ev.targetId !== undefined) objects.push(ev.targetId); if (ev.player !== undefined) players.push(ev.player); break;
    case 'life': players.push(ev.player); break;
    case 'tap': case 'counter': case 'control': case 'attach': case 'transform': case 'create-token': case 'unsimulated': objects.push(ev.id); if (ev.type === 'attach' && ev.to !== null) objects.push(ev.to); break;
    case 'cast': case 'activate': case 'trigger': objects.push(ev.id); players.push(ev.player); break;
    case 'attack': objects.push(...ev.attackers.map(a => a.id)); players.push(ev.target); break;
    case 'block': for (const b of ev.blocks) objects.push(b.blocker, b.attacker); break;
    case 'sba': case 'prevented': if (ev.id !== undefined) objects.push(ev.id); if (ev.player !== undefined) players.push(ev.player); break;
    case 'replaced': if (ev.id !== undefined) objects.push(ev.id); break;
    case 'player-eliminated': case 'mulligan': case 'mana': case 'library': case 'extra-turn': players.push(ev.player); break;
    case 'game-over': if (ev.winner !== null) players.push(ev.winner); break;
    default: break;
  }
  return { objects: [...new Set(objects)], players: [...new Set(players)] };
}

/** The rule chip an event shows (CR number), if any. */
export const chipFor = (ev: GameEvent): string | undefined => ruleFor(ev);

/** Which stack item an event refers to (for stack glows). */
export function stackItemOf(ev: GameEvent): number | null {
  return ev.type === 'cast' || ev.type === 'activate' || ev.type === 'trigger' || ev.type === 'resolve' || ev.type === 'countered' || ev.type === 'fizzle' ? ev.itemId : null;
}

/** Group events for playback: zero-length events ride along with the next timed one so they render in one frame. */
export function batchEvents(events: readonly GameEvent[], speed = 1, reducedMotion = false, explain = false): { events: GameEvent[]; duration: number }[] {
  const out: { events: GameEvent[]; duration: number }[] = [];
  let cur: GameEvent[] = [];
  for (const ev of events) {
    const d = durationFor(ev, speed, reducedMotion, explain);
    cur.push(ev);
    if (d > 0) { out.push({ events: cur, duration: d }); cur = []; }
  }
  if (cur.length) out.push({ events: cur, duration: 0 });
  return out;
}

export const totalDuration = (events: readonly GameEvent[], speed = 1, reducedMotion = false, explain = false): number => events.reduce((a, e) => a + durationFor(e, speed, reducedMotion, explain), 0);

/** The decision-latency rule: a decision arriving with more than RUSH_THRESHOLD_MS of queue left plays the rest at 4×. */
export const shouldRush = (remainingMs: number): boolean => remainingMs > RUSH_THRESHOLD_MS;

// ---- words --------------------------------------------------------------------------------------
const STEP_WORDS: Record<Step, string> = {
  untap: 'untap step', upkeep: 'upkeep', draw: 'draw step', main1: 'first main phase', 'combat-begin': 'beginning of combat', 'declare-attackers': 'declare attackers step', 'declare-blockers': 'declare blockers step',
  'first-strike-damage': 'first-strike damage step', 'combat-damage': 'combat damage step', 'combat-end': 'end of combat', main2: 'second main phase', end: 'end step', cleanup: 'cleanup step',
};
const ZONE_WORDS: Record<string, string> = { library: 'the library', hand: 'hand', battlefield: 'the battlefield', graveyard: 'the graveyard', exile: 'exile', stack: 'the stack', command: 'the command zone', none: 'nowhere' };
const a = (name: string) => name || 'a card';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A plain-words account of an event for the explain panel. */
export function describeEvent(ev: GameEvent, pname: (p: PlayerId) => string): string {
  switch (ev.type) {
    case 'game-start': return `The game begins; ${pname(ev.first)} takes the first turn.`;
    case 'mulligan': return `${pname(ev.player)} takes a mulligan (${ev.count}).`;
    case 'turn': return `Turn ${ev.number}: ${pname(ev.player)}'s turn begins.`;
    case 'step': return `${pname(ev.player)}'s ${STEP_WORDS[ev.to]} begins.`;
    case 'decision': return `${pname(ev.player)} is asked to decide (${ev.kind}).`;
    case 'draw': return `${pname(ev.player)} draws ${ev.stepDraw ? 'for the turn' : 'a card'}${ev.name ? `: ${ev.name}` : ''}.`;
    case 'zone-change': {
      const who = pname(ev.controller);
      switch (ev.reason) {
        case 'play': return `${who} plays ${a(ev.name)}${ev.tapped ? ', which enters tapped' : ''}.`;
        case 'cast': return `${a(ev.name)} is put on the stack from ${ZONE_WORDS[ev.from]}.`;
        case 'resolve': return ev.to === 'battlefield' ? `${a(ev.name)} enters the battlefield under ${who}'s control${ev.tapped ? ', tapped' : ''}.` : `${a(ev.name)} finishes resolving and goes to ${ZONE_WORDS[ev.to]}.`;
        case 'countered': return `${a(ev.name)} goes to ${ZONE_WORDS[ev.to]} after being countered.`;
        case 'destroy': return `${a(ev.name)} is destroyed and goes to ${ZONE_WORDS[ev.to]}.`;
        case 'sacrifice': return `${who} sacrifices ${a(ev.name)}.`;
        case 'discard': return `${pname(ev.owner)} discards ${a(ev.name)}.`;
        case 'mill': return `${pname(ev.owner)} mills ${a(ev.name)}.`;
        case 'exile': return `${a(ev.name)} is exiled.`;
        case 'bounce': return `${a(ev.name)} is returned to ${pname(ev.owner)}'s hand.`;
        case 'token': return `${who} creates ${a(ev.name)}.`;
        case 'sba': return `${a(ev.name)} is put into ${ZONE_WORDS[ev.to]} by state-based actions.`;
        case 'mulligan': return `${pname(ev.owner)} shuffles ${a(ev.name)} back into the library.`;
        case 'search': return `${pname(ev.owner)} finds ${a(ev.name)} and puts it into ${ZONE_WORDS[ev.to]}.`;
        case 'dig': return `${a(ev.name)} is put into ${ZONE_WORDS[ev.to]}.`;
        case 'tuck': return `${a(ev.name)} is put ${ev.libraryPos === 'bottom' ? 'on the bottom' : 'on top'} of the library.`;
        case 'cost': return `${a(ev.name)} is paid as a cost and goes to ${ZONE_WORDS[ev.to]}.`;
        case 'dredge': return `${pname(ev.owner)} dredges ${a(ev.name)}.`;
        default: return `${a(ev.name)} moves from ${ZONE_WORDS[ev.from]} to ${ZONE_WORDS[ev.to]}.`;
      }
    }
    case 'damage': {
      const src = `${ev.source}`;
      if (ev.player !== undefined) return `${src} deals ${ev.amount} ${ev.combat ? 'combat ' : ''}damage to ${pname(ev.player)} (${ev.total} life).`;
      if (ev.loyalty) return `${src} deals ${ev.amount} damage to ${ev.target}; its loyalty is now ${ev.total}.`;
      return `${src} deals ${ev.amount} ${ev.combat ? 'combat ' : ''}damage to ${ev.target} (${ev.total} marked).`;
    }
    case 'life': return ev.delta >= 0 ? `${pname(ev.player)} gains ${plural(ev.delta, 'life')} (${ev.total}).` : `${pname(ev.player)} loses ${-ev.delta} life (${ev.total}) — ${ev.reason}.`;
    case 'tap': return ev.tapped ? `${ev.name} is tapped${ev.reason === 'mana' ? ' for mana' : ev.reason === 'attack' ? ' to attack' : ev.reason === 'cost' ? ' to pay a cost' : ''}.` : `${ev.name} untaps${ev.reason === 'untap-step' ? ' during the untap step' : ''}.`;
    case 'counter': return ev.delta >= 0 ? `${ev.name} gets ${plural(ev.delta, `${ev.counter} counter`)} (${ev.total}).` : `${ev.name} loses ${plural(-ev.delta, `${ev.counter} counter`)} (${ev.total}).`;
    case 'create-token': return `${pname(ev.controller)} creates ${ev.count && ev.count > 1 ? `${ev.count} ` : 'a '}${ev.power}/${ev.toughness} ${ev.name} token${ev.count && ev.count > 1 ? 's' : ''}.`;
    case 'control': return `${pname(ev.to)} gains control of ${ev.name} from ${pname(ev.from)}.`;
    case 'attach': return ev.to === null ? `${ev.name} becomes unattached.` : `${ev.name} is attached to ${ev.toName ?? 'its target'}.`;
    case 'transform': return `${ev.name} transforms into ${ev.into}.`;
    case 'cast': return `${pname(ev.player)} casts ${ev.name}${ev.x ? ` with X = ${ev.x}` : ''}${ev.targets.length ? `, targeting ${ev.targets.join(' and ')}` : ''}${ev.how.length ? ` (${ev.how.join(', ')})` : ''}.`;
    case 'activate': return `${pname(ev.player)} activates ${ev.name}: ${ev.ability}${ev.targets.length ? `, targeting ${ev.targets.join(' and ')}` : ''}.`;
    case 'trigger': return `${ev.name}'s ability triggers and goes on the stack: ${ev.ability}`;
    case 'resolve': return `${ev.name} resolves.`;
    case 'fizzle': return `${ev.name} doesn't resolve: ${ev.reason === 'enchant-target-illegal' ? 'the permanent it would enchant is no longer a legal target' : 'all of its targets are illegal'}.`;
    case 'countered': return ev.unlessPaid ? `${ev.name} isn't countered — its controller paid.` : `${ev.name} is countered${ev.by ? ` by ${ev.by}` : ''}.`;
    case 'attack': return ev.attackers.length ? `${pname(ev.player)} attacks ${pname(ev.target)} with ${ev.attackers.map(x => x.name).join(', ')}.` : `${pname(ev.player)} declares no attackers.`;
    case 'block': {
      if (!ev.blocks.length) return `${pname(ev.player)} declares no blockers.`;
      const by = new Map<number, { name: string; blockers: string[] }>();
      for (const b of ev.blocks) { const e = by.get(b.attacker) ?? { name: b.attackerName, blockers: [] }; e.blockers.push(b.blockerName); by.set(b.attacker, e); }
      return `${pname(ev.player)} blocks: ${[...by.values()].map(e => `${e.name} with ${e.blockers.join(' and ')}`).join('; ')}.`;
    }
    case 'sba': {
      switch (ev.kind) {
        case 'lethal-damage': return `${ev.name} has lethal damage marked on it and is destroyed (state-based action).`;
        case 'zero-toughness': return `${ev.name} has toughness ${ev.detail ?? '0'} or less and is put into the graveyard.`;
        case 'zero-loyalty': return `${ev.name} has no loyalty left and is put into the graveyard.`;
        case 'aura-unattached': return `${ev.name} isn't attached to anything and is put into the graveyard.`;
        case 'legend-rule': return `Legend rule: two legendary permanents share the name ${ev.name}; the older one goes to the graveyard.`;
        case 'saga-final': return `${ev.name}'s final chapter has resolved; it is sacrificed.`;
        case 'life': return `${pname(ev.player!)} has 0 or less life and loses the game.`;
        case 'poison': return `${pname(ev.player!)} has ten or more poison counters and loses the game.`;
        case 'counters-cancel': return `${plural(Number(ev.detail ?? 1), '+1/+1 counter')} and as many -1/-1 counters on ${ev.name} cancel out.`;
        case 'empty-library': return `${pname(ev.player!)} tried to draw from an empty library and loses.`;
        case 'commander-damage': return `${pname(ev.player!)} has taken 21 or more combat damage from ${ev.name} and loses.`;
        default: return (ev as { detail?: string }).detail ?? 'A state-based action is performed.';
      }
    }
    case 'player-eliminated': return `${pname(ev.player)} loses the game: ${ev.reason}.`;
    case 'game-over': return ev.winner === null ? `The game ends in a draw: ${ev.reason}` : `${pname(ev.winner)} wins the game.`;
    case 'replaced': {
      switch (ev.what) {
        case 'regenerate': return `${ev.name} regenerates instead of being destroyed: it's tapped, removed from combat and its damage is removed.`;
        case 'indestructible': return `${ev.name} is indestructible and isn't destroyed.`;
        case 'protection': return `${ev.name}'s protection prevents the damage.`;
        case 'rebound': return `${ev.name} is exiled with rebound; it may be cast free during its owner's next upkeep.`;
        case 'dredge': return `${ev.name} is dredged back instead of a draw.`;
        case 'mox-diamond': return `${ev.name} goes to the graveyard instead of entering (no land discarded).`;
        case 'exile-instead': return `${ev.name} is exiled instead of going to the graveyard.`;
        case 'shuffle-instead': return `${ev.name} is shuffled into its owner's library instead.`;
        case 'commander-zone': return `${ev.name} goes to the command zone instead (its owner chose to).`;
        default: return `A replacement effect changes what happens to ${ev.name ?? 'it'}.`;
      }
    }
    case 'prevented': return ev.player !== undefined ? `${ev.amount === 'all' ? 'All' : ev.amount} damage to ${pname(ev.player)} is prevented (${ev.by}).` : `${ev.amount === 'all' ? 'All' : ev.amount} damage to ${ev.name} is prevented (${ev.by}).`;
    case 'mana': return `${pname(ev.player)} adds ${ev.added.map(m => `{${m}}`).join('')}${ev.source ? ` from ${ev.source}` : ''}.`;
    case 'library': {
      switch (ev.action) {
        case 'shuffle': return `${pname(ev.player)} shuffles.`;
        case 'scry': return `${pname(ev.player)} scries ${ev.count ?? 1}.`;
        case 'surveil': return `${pname(ev.player)} surveils ${ev.count ?? 1}.`;
        case 'look': return `${pname(ev.player)} looks at the top card of the library${ev.cards?.length ? ` (${ev.cards[0]})` : ''}.`;
        case 'reveal': return `${pname(ev.player)} reveals ${ev.cards?.join(', ') || 'a card'}.`;
        case 'search': return ev.found?.length ? `${pname(ev.player)} searches the library and finds ${ev.found.join(', ')}.` : `${pname(ev.player)} searches the library and finds nothing.`;
        case 'dig': return `${pname(ev.player)} looks at the top ${plural(ev.count ?? 1, 'card')}${ev.found?.length ? ` and takes ${ev.found.join(', ')}` : ''}.`;
        default: return `${pname(ev.player)} reorders the library.`;
      }
    }
    case 'unsimulated': return `${ev.name} has text the engine doesn't simulate: "${ev.clause}".`;
    case 'extra-turn': return `${pname(ev.player)} will take an extra turn after this one.`;
    case 'note': return ev.text;
    default: return (ev as GameEvent).text || '';
  }
}

/** Events worth a card in the explain panel (silent bookkeeping is folded away). */
export function isExplainable(ev: GameEvent): boolean {
  if (ev.type === 'decision' || ev.type === 'game-start') return false;
  if (ev.type === 'mana') return false;
  if (ev.type === 'zone-change' && (ev.to === 'stack' || ev.from === 'stack' || ev.reason === 'mulligan')) return false;
  if (ev.type === 'tap' && ev.reason === 'untap-step') return false;
  if (ev.type === 'library' && (ev.action === 'order' || ev.action === 'look')) return false;
  if (ev.type === 'note' && !ev.text) return false;
  return true;
}
