// Event replay over the UI view. `applyEvent` folds one typed engine event into a ViewState, producing the
// intermediate picture the table shows while the animation queue plays events one at a time; `replayTo` and the
// `Replayer` (keyframe cache) drive the timeline scrubber. Pure and DOM-free so it runs under node tests.
//
// What the replayer models (verified against `buildView` at every decision in test/replay.test.ts):
//   - zones: hand (viewer's, by card id and order), battlefield, graveyard, exile, command (ids), handSize, librarySize
//   - permanents: tapped, damage, counters (incl. loyalty), controller, attachedTo, attacking / blocking / blockedBy,
//     transformed face, token identity (name, P/T), +1/+1 and -1/-1 counter effects on curPower / curToughness
//   - players: life, lost / lossReason, landsPlayedThisTurn, manaPool (added mana; pools empty at each step),
//     commanderCasts (casts from the command zone) and commanderDamage (combat damage from a commander)
//   - the stack: item ids in order, kind, name, controller, source card, target labels
//   - turn, activePlayer, step, attackers, winner, logLength, priority (from decision events, when emitted)
// What it does not model (no event carries it): passesInRow, poison, mana spent from the pool, continuous
// power/toughness effects beyond counters (anthems, pump), curKeywords, canAttack beyond "untapped, not summoning
// sick", the identity of hidden cards (placeholders with an empty name stand in until the authoritative view arrives).
import type { GameEvent, ZoneRef } from '../engine/events.js';
import type { PlayerId } from '../engine/state.js';
import type { CardView, PermanentView, PlayerView, StackItemView, ViewState } from './view.js';

export interface ReplayView extends ViewState {
  /** Cards between zones: cast spells whose stack item has not been pushed yet, and resolved spells still leaving the stack. */
  transit?: Record<number, CardView>;
}

export const REPLAY_MODELS = [
  'zones (hand ids/order for the viewer, battlefield, graveyard, exile, command)', 'handSize', 'librarySize',
  'tapped', 'damage', 'counters', 'controller', 'attachedTo', 'attacking/blocking/blockedBy', 'transform face', 'token P/T',
  'life', 'lost/lossReason', 'landsPlayedThisTurn', 'manaPool (additions)', 'commanderCasts', 'commanderDamage',
  'stack (ids, kind, name, controller, source, target labels)', 'turn', 'activePlayer', 'step', 'attackers', 'winner', 'logLength',
] as const;
export const REPLAY_DOES_NOT_MODEL = ['priority (no engine event)', 'passesInRow', 'poison', 'mana spent', 'continuous P/T effects', 'curKeywords', 'canAttack (heuristic only)', 'hidden card identity'] as const;

const CARD_KEYS: (keyof CardView)[] = ['id', 'name', 'oracleId', 'printingId', 'face', 'manaCost', 'manaValue', 'typeLine', 'text', 'power', 'toughness', 'loyalty', 'colors', 'types', 'keywords', 'fullyParsed', 'unparsed', 'isToken', 'token', 'hasBack', 'layout'];

/** A stand-in for a card the events name but the view has not seen (hidden draws, opponent's hand, tokens). */
export function placeholderCard(id: number, name = '', token = false): CardView {
  return { id, name, oracleId: null, printingId: null, face: 0, manaCost: null, manaValue: 0, typeLine: '', text: '', power: null, toughness: null, loyalty: null, colors: [], types: [], keywords: [], fullyParsed: true, unparsed: [], isToken: token, hasBack: false, layout: 'normal' };
}
export const isPlaceholder = (c: CardView): boolean => c.printingId === null && !c.isToken && c.oracleId === null;

/** The CardView part of a card (drops PermanentView fields when a permanent leaves the battlefield). */
export function stripPermanent(c: CardView | PermanentView): CardView {
  const out = {} as Record<string, unknown>;
  for (const k of CARD_KEYS) out[k] = (c as unknown as Record<string, unknown>)[k];
  return out as unknown as CardView;
}

const num = (s: string | null): number => { const n = Number(s); return Number.isFinite(n) ? n : 0; };

/** A PermanentView for a card entering the battlefield. */
export function toPermanent(card: CardView, controller: PlayerId, owner: PlayerId, tapped: boolean, turn: number): PermanentView {
  const base = stripPermanent(card);
  const isCreature = base.types.includes('Creature');
  const counters: Record<string, number> = {};
  if (base.loyalty != null && base.types.includes('Planeswalker')) counters.loyalty = base.loyalty;
  const perm: PermanentView = {
    ...base, controller, owner, tapped, damage: 0, counters,
    curPower: isCreature ? num(base.power) : 0, curToughness: isCreature ? num(base.toughness) : 0, curKeywords: isCreature ? [...base.keywords] : [], isCreature, isLand: base.types.includes('Land'),
    summoningSick: false, canAttack: false, attacking: null, blocking: [], blockedBy: [], attachedTo: null, transformed: card.face === 1, enteredTurn: turn,
  };
  return refresh(perm, turn);
}

function refresh(p: PermanentView, turn: number): PermanentView {
  p.summoningSick = p.isCreature && p.enteredTurn === turn && !(p.curKeywords as string[]).includes('haste') && !(p.keywords as string[]).includes('haste');
  p.canAttack = p.isCreature && !p.tapped && !p.summoningSick;
  return p;
}

function cloneView(v: ViewState): ReplayView {
  const r = v as ReplayView;
  return {
    ...v,
    players: v.players.map(p => ({
      ...p, hand: p.hand ? [...p.hand] : null, battlefield: p.battlefield.map(o => ({ ...o, counters: { ...o.counters }, blocking: [...o.blocking], blockedBy: [...o.blockedBy] })),
      graveyard: [...p.graveyard], exile: [...p.exile], command: [...p.command], commanders: [...p.commanders], commanderCasts: { ...p.commanderCasts }, commanderDamage: { ...p.commanderDamage }, manaPool: [...p.manaPool],
    })),
    stack: [...v.stack], attackers: [...v.attackers], turnOrder: [...v.turnOrder], transit: { ...(r.transit ?? {}) },
  };
}

function findPerm(v: ReplayView, id: number): PermanentView | null {
  for (const p of v.players) { const o = p.battlefield.find(b => b.id === id); if (o) return o; }
  return null;
}
function findAnywhere(v: ReplayView, id: number): CardView | null {
  for (const p of v.players) {
    for (const zone of [p.hand ?? [], p.battlefield, p.graveyard, p.exile, p.command]) { const c = zone.find(x => x.id === id); if (c) return c; }
  }
  if (v.transit?.[id]) return v.transit[id];
  const it = v.stack.find(s => s.sourceId === id); if (it) return it.source;
  return null;
}

/** Remove a card from every zone it might sit in; returns the card as last seen. */
function removeEverywhere(v: ReplayView, id: number): CardView | null {
  let found: CardView | null = null;
  for (const p of v.players) {
    if (p.hand) { const i = p.hand.findIndex(c => c.id === id); if (i >= 0) { found = p.hand[i]; p.hand.splice(i, 1); } }
    const bi = p.battlefield.findIndex(c => c.id === id);
    if (bi >= 0) {
      found = p.battlefield[bi]; p.battlefield.splice(bi, 1);
      for (const q of v.players) for (const o of q.battlefield) { if (o.attachedTo === id) o.attachedTo = null; o.blockedBy = o.blockedBy.filter(x => x !== id); o.blocking = o.blocking.filter(x => x !== id); }
      v.attackers = v.attackers.filter(x => x !== id);
    }
    for (const zone of ['graveyard', 'exile', 'command'] as const) { const i = p[zone].findIndex(c => c.id === id); if (i >= 0) { found = p[zone][i]; p[zone].splice(i, 1); } }
  }
  if (v.transit && v.transit[id]) { found = found ?? v.transit[id]; delete v.transit[id]; }
  return found;
}

function clearCombat(v: ReplayView) {
  v.attackers = [];
  for (const p of v.players) for (const o of p.battlefield) { o.attacking = null; o.blocking = []; o.blockedBy = []; }
}

function zoneChange(v: ReplayView, ev: Extract<GameEvent, { type: 'zone-change' }>) {
  const owner = v.players[ev.owner]; const controller = v.players[ev.controller] ?? owner;
  if (!owner) return;
  const seen = removeEverywhere(v, ev.id);
  const card: CardView = seen ? stripPermanent(seen) : placeholderCard(ev.id, ev.name, ev.token);
  if (ev.name && (!card.name || (ev.token && card.isToken))) card.name = ev.name;
  if (ev.from === 'library') owner.librarySize = Math.max(0, owner.librarySize - 1);
  if (ev.from === 'hand') owner.handSize = owner.hand ? owner.hand.length : Math.max(0, owner.handSize - 1);
  if (ev.from === 'command' && ev.to === 'stack' && owner.commanders.includes(ev.id)) owner.commanderCasts[ev.id] = (owner.commanderCasts[ev.id] ?? 0) + 1;
  switch (ev.to) {
    case 'library': owner.librarySize++; break;
    case 'hand': if (owner.hand) { owner.hand.push(card); owner.handSize = owner.hand.length; } else owner.handSize++; break;
    case 'battlefield': {
      controller.battlefield.push(toPermanent(card, ev.controller, ev.owner, !!ev.tapped, v.turn));
      if (ev.reason === 'play') controller.landsPlayedThisTurn++;
      break;
    }
    case 'graveyard': case 'exile': case 'command': owner[ev.to].push(card); break;
    case 'stack': v.transit![ev.id] = card; break;
    case 'none': break;
    default: break;
  }
}

/** The view after one event. Never mutates its input. */
export function applyEvent(view: ViewState, ev: GameEvent): ReplayView {
  const v = cloneView(view);
  if (ev.text) v.logLength++;
  switch (ev.type) {
    case 'zone-change': zoneChange(v, ev); break;
    case 'draw': {
      const p = v.players[ev.player]; if (!p) break;
      p.librarySize = Math.max(0, p.librarySize - 1);
      if (p.hand) { p.hand.push(placeholderCard(ev.id, ev.name)); p.handSize = p.hand.length; } else p.handSize++;
      break;
    }
    case 'cast': {
      const source = v.transit?.[ev.id] ?? findAnywhere(v, ev.id) ?? placeholderCard(ev.id, ev.name);
      if (v.transit) delete v.transit[ev.id];
      v.stack.push({ id: ev.itemId, kind: 'spell', name: ev.name, controller: ev.player, text: source.text, sourceId: ev.id, source: stripPermanent(source), targets: [], targetLabels: [...ev.targets], countered: false } satisfies StackItemView);
      break;
    }
    case 'activate': case 'trigger': {
      const source = findAnywhere(v, ev.id) ?? placeholderCard(ev.id, ev.name);
      // the engine labels a triggered ability's stack item "<source> trigger: <text>"; activated abilities vary and are corrected by the next view
      v.stack.push({ id: ev.itemId, kind: ev.type === 'activate' ? 'ability' : 'trigger', name: ev.type === 'trigger' ? `${ev.name} trigger: ${ev.ability}` : ev.name, controller: ev.player, text: ev.ability, sourceId: ev.id, source: stripPermanent(source), targets: [], targetLabels: [...ev.targets], countered: false });
      break;
    }
    case 'resolve': case 'fizzle': case 'countered': {
      if (ev.type === 'countered' && ev.unlessPaid) break;
      const i = v.stack.findIndex(s => s.id === ev.itemId);
      if (i >= 0) { const [item] = v.stack.splice(i, 1); if (item.kind === 'spell') v.transit![item.sourceId] = item.source; }
      break;
    }
    case 'tap': { const o = findPerm(v, ev.id); if (o) { o.tapped = ev.tapped; refresh(o, v.turn); } break; }
    case 'counter': {
      const o = findPerm(v, ev.id); if (!o) break;
      if (ev.total <= 0) delete o.counters[ev.counter]; else o.counters[ev.counter] = ev.total;
      if (ev.counter === '+1/+1') { o.curPower += ev.delta; o.curToughness += ev.delta; }
      if (ev.counter === '-1/-1') { o.curPower -= ev.delta; o.curToughness -= ev.delta; }
      break;
    }
    case 'damage': {
      if (ev.targetId !== undefined) {
        const o = findPerm(v, ev.targetId); if (!o) break;
        if (ev.loyalty) { if (ev.total <= 0) delete o.counters.loyalty; else o.counters.loyalty = ev.total; } else o.damage = ev.total;
      } else if (ev.player !== undefined) {
        const p = v.players[ev.player]; if (!p) break;
        p.life = ev.total;
        if (ev.combat && v.players.some(q => q.commanders.includes(ev.sourceId))) p.commanderDamage[ev.sourceId] = (p.commanderDamage[ev.sourceId] ?? 0) + ev.amount;
      }
      break;
    }
    case 'life': { const p = v.players[ev.player]; if (p) p.life = ev.total; break; }
    case 'create-token': {
      const o = findPerm(v, ev.id); if (!o) break;
      o.name = ev.name; o.isToken = true; o.power = String(ev.power); o.toughness = String(ev.toughness);
      if (!o.types.includes('Creature')) o.types = [...o.types, 'Creature'];
      o.isCreature = true; o.curPower = ev.power; o.curToughness = ev.toughness; refresh(o, v.turn);
      break;
    }
    case 'control': {
      const from = v.players[ev.from]; const to = v.players[ev.to]; if (!from || !to) break;
      const i = from.battlefield.findIndex(o => o.id === ev.id); if (i < 0) break;
      const [o] = from.battlefield.splice(i, 1); o.controller = ev.to; to.battlefield.push(o);
      break;
    }
    case 'attach': { const o = findPerm(v, ev.id); if (o) o.attachedTo = ev.to; break; }
    case 'transform': { const o = findPerm(v, ev.id); if (o) { o.face = ev.face; o.transformed = ev.face === 1; o.name = ev.into; } break; }
    case 'attack': {
      v.attackers = ev.attackers.map(a => a.id);
      for (const a of ev.attackers) { const o = findPerm(v, a.id); if (o) o.attacking = ev.target; }
      break;
    }
    case 'block': {
      for (const p of v.players) for (const o of p.battlefield) { o.blocking = []; o.blockedBy = []; }
      for (const b of ev.blocks) { const bl = findPerm(v, b.blocker); const at = findPerm(v, b.attacker); if (bl && !bl.blocking.includes(b.attacker)) bl.blocking.push(b.attacker); if (at && !at.blockedBy.includes(b.blocker)) at.blockedBy.push(b.blocker); }
      break;
    }
    case 'player-eliminated': { const p = v.players[ev.player]; if (p) { p.lost = true; p.lossReason = ev.reason; } break; }
    case 'game-over': v.winner = ev.winner; break;
    case 'turn': {
      v.turn = ev.number; v.activePlayer = ev.player;
      for (const p of v.players) { p.landsPlayedThisTurn = 0; for (const o of p.battlefield) refresh(o, v.turn); }
      clearCombat(v);
      break;
    }
    case 'step': {
      v.step = ev.to;
      for (const p of v.players) p.manaPool = [];
      if (ev.to === 'cleanup') for (const p of v.players) for (const o of p.battlefield) o.damage = 0;
      if (ev.to === 'main2' || ev.to === 'end' || ev.to === 'cleanup' || ev.to === 'untap') clearCombat(v);
      break;
    }
    case 'mana': { const p = v.players[ev.player]; if (p) p.manaPool.push(...ev.added); break; }
    case 'replaced': {
      if (ev.what === 'regenerate' && ev.id !== undefined) { const o = findPerm(v, ev.id); if (o) { o.tapped = true; o.damage = 0; o.attacking = null; o.blocking = []; v.attackers = v.attackers.filter(x => x !== ev.id); refresh(o, v.turn); } }
      break;
    }
    case 'game-start': v.activePlayer = ev.first; break;
    case 'decision': if (ev.kind === 'priority') v.priority = ev.player; break;
    default: break;
  }
  return v;
}

/** The view after the first `n` events (all of them when `n` is omitted). */
export function replayTo(view0: ViewState, events: readonly GameEvent[], n = events.length): ReplayView {
  let v: ReplayView = view0 as ReplayView;
  const end = Math.min(n, events.length);
  for (let i = 0; i < end; i++) v = applyEvent(v, events[i]);
  return v;
}

/** Keyframe cache over an event list: `at(n)` costs at most `every` applications. */
export class Replayer {
  private frames = new Map<number, ReplayView>();
  private head: ReplayView;
  readonly events: GameEvent[] = [];
  constructor(public base: ViewState, events: readonly GameEvent[] = [], readonly every = 25) {
    this.head = base as ReplayView;
    this.frames.set(0, this.head);
    this.append(events);
  }
  get length(): number { return this.events.length; }
  /** The modelled view after every event appended so far. */
  get latest(): ReplayView { return this.head; }
  append(events: readonly GameEvent[]) {
    for (const ev of events) {
      this.events.push(ev);
      this.head = applyEvent(this.head, ev);
      if (this.events.length % this.every === 0) this.frames.set(this.events.length, this.head);
    }
  }
  at(n: number): ReplayView {
    const target = Math.max(0, Math.min(n, this.events.length));
    if (target === this.events.length) return this.head;
    const key = target - (target % this.every);
    let v = this.frames.get(key) ?? this.frames.get(0)!;
    let from = this.frames.has(key) ? key : 0;
    if (!this.frames.has(key)) { for (const k of this.frames.keys()) if (k <= target && k > from) { from = k; v = this.frames.get(k)!; } }
    for (let i = from; i < target; i++) v = applyEvent(v, this.events[i]);
    return v;
  }
  /** Drop the oldest `n` events, re-basing on the view after them (keeps the cache bounded). */
  trim(n: number) {
    const drop = Math.min(n, this.events.length);
    if (drop <= 0) return;
    const newBase = this.at(drop);
    const rest = this.events.splice(0, drop);
    void rest;
    const remaining = this.events.splice(0);
    this.base = newBase; this.head = newBase; this.frames = new Map([[0, newBase]]);
    this.append(remaining);
  }
  /** Drop every event from local index `n` on (undo): the head becomes the view after the first `n` events. */
  truncate(n: number) {
    const keep = Math.max(0, Math.min(n, this.events.length));
    if (keep === this.events.length) return;
    const kept = this.events.slice(0, keep);
    this.events.length = 0;
    this.head = this.base as ReplayView; this.frames = new Map([[0, this.head]]);
    this.append(kept);
  }
  /** The event window a UI cursor refers to; `seq` of the first event when the list has been trimmed. */
  get firstSeq(): number { return this.events[0]?.seq ?? 0; }
}

/** Cards known to the authoritative view, keyed by id (for filling in placeholders during playback). */
export function indexCards(view: ViewState | null): Map<number, CardView> {
  const m = new Map<number, CardView>();
  if (!view) return m;
  for (const p of view.players) {
    for (const zone of [p.hand ?? [], p.battlefield, p.graveyard, p.exile, p.command]) for (const c of zone) m.set(c.id, c);
  }
  for (const it of view.stack) if (!m.has(it.sourceId)) m.set(it.sourceId, it.source);
  return m;
}

/** Replace placeholder cards in a replayed view with the identity the authoritative view knows for the same id. */
export function hydrate(view: ReplayView, known: Map<number, CardView>): ReplayView {
  if (!known.size) return view;
  let changed = false;
  const fix = <T extends CardView>(c: T): T => {
    if (!isPlaceholder(c) && !(c.isToken && !c.typeLine)) return c;
    const k = known.get(c.id); if (!k) return c;
    changed = true;
    const base = stripPermanent(k);
    if ('controller' in c) {
      const p = c as unknown as PermanentView;
      const isCreature = base.types.includes('Creature');
      return { ...p, ...base, face: p.face, name: p.transformed ? p.name : base.name, isCreature, isLand: base.types.includes('Land'), curPower: isCreature && !p.curPower ? num(base.power) : p.curPower, curToughness: isCreature && !p.curToughness ? num(base.toughness) : p.curToughness, curKeywords: p.curKeywords.length ? p.curKeywords : [...base.keywords] } as unknown as T;
    }
    return base as T;
  };
  const players: PlayerView[] = view.players.map(p => ({ ...p, hand: p.hand ? p.hand.map(fix) : null, battlefield: p.battlefield.map(o => refresh(fix(o), view.turn)), graveyard: p.graveyard.map(fix), exile: p.exile.map(fix), command: p.command.map(fix) }));
  const stack = view.stack.map(it => ({ ...it, source: fix(it.source) }));
  return changed ? { ...view, players, stack } : view;
}

export type { ZoneRef };
