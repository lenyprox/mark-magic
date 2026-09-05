// Per-ability reachability probes (plan 2.2 stage 5, second half).
//
// `src/verify/sandbox.ts` answers "does this card break the engine?" — it casts the card, runs what it can and checks
// the invariants. It does NOT answer "did every ability of this card ever run?", and an ability that never runs is an
// ability nobody has tested: the sandbox verdict is green and the behaviour is unknown. These probes answer the
// second question, one ability at a time, by MAKING the event happen:
//
//   etb              cast it (or put it onto the battlefield through `enterBattlefield`)
//   dies             lethal damage, then state-based actions
//   ltb              move it to exile
//   attacks / combat-damage-player / deals-damage / you-attack     `simulateCombat` with it attacking
//   blocks / becomes-blocked                                        `simulateCombat` with it blocking
//   upkeep / end-step / draw-step / combat-begin / end-of-turn / chapter   play one turn
//   cast             cast a filler spell of the type the trigger filters for
//   targeted         cast a Shock at it
//   landfall         play a land
//   tapped           tap it (a KNOWN dead event — see docs/HANDOFF.md item 11 — so this probe reports unreachable)
//   draw / discard / life-gain / life-loss-opponent / sacrifice / leaves-graveyard   do that thing
//   activated        `performAction` on the legal action for that ability index, with its first legal targets
//   static           build the same board twice, the second time from a def with THAT ONE static ability removed,
//                    and compare every permanent's P/T, keywords and flags and the controller's legal actions
//
// The probes SHARE their setups: a card with six triggered abilities does not cost six games, it costs one game per
// distinct setup its abilities need (`scenariosFor`). Unreachable is never a failure — it is a WARNING that says
// "the blind-scenario author has to reach this one by hand" (plan 2.2 stage 5).
import type { CardDB } from '../cards/db.js';
import type { Ability, CardDef, TriggerEvent } from '../cards/types.js';
import { findObject, flags, keywords, power, toughness } from '../engine/characteristics.js';
import { cloneState } from '../engine/clone.js';
import { Game } from '../engine/game.js';
import { legalActions } from '../engine/legal.js';
import { opponentsOf } from '../engine/players.js';
import { makeObject, type GameObject, type GameState, type PlayerId } from '../engine/state.js';
import { Sandbox } from './sandbox.js';

/** One ability's verdict: the index into the face's `abilities`, whether a probe reached it, and which probe did. */
export interface AbilityProbe { index: number; reached: boolean; how?: string }

export interface ProbeOptions {
  /** Seat count of the probe game (2 by default; the sandbox trials 4 separately). */
  seats?: 2 | 4;
  /** Filler cards the probes cast / play. Defaults are read from the CardDB. */
  maxTurns?: number;
}

const TRIAL_SEAT: PlayerId = 0;
const SEAT_NAMES = ['A', 'B', 'C', 'D'];
const dropUndefined = (xs: (number | undefined)[]): number[] => xs.filter((x): x is number => x !== undefined);
const agentsFor = (seats: number) => Array.from({ length: seats }, (_, i) => new Sandbox(SEAT_NAMES[i]));

/** Cards the probes need. Every one is an old, always-present staple; a missing one disables only its own probe. */
const FILLER = {
  land: 'Forest', creature: 'Grizzly Bears', bigCreature: 'Hill Giant', instant: 'Shock', sorcery: 'Divination',
  artifact: 'Sol Ring', enchantment: 'Pacifism',
} as const;

// ---------------------------------------------------------------------------
// The rigged base state
// ---------------------------------------------------------------------------

interface Base { state: GameState; cardId: number; seats: number; maxTurns: number }

/**
 * Seat 0 has three of each basic land untapped, a filler card of every type in hand, a probe creature on the
 * battlefield and a card in the graveyard; every other seat has two creatures. The card under test starts in seat 0's
 * hand, so a probe can either cast it or put it onto the battlefield itself.
 */
function baseState(cards: CardDB, def: CardDef, seats: number, maxTurns: number): Base {
  const filler = Array(12).fill(cards.get(FILLER.land)!);
  const g = new Game(Array.from({ length: seats }, () => filler), agentsFor(seats), { seed: 1, quiet: true, mulligans: false, events: 'full', maxTurns });
  const s = g.state; s.turn = 5; s.activePlayer = TRIAL_SEAT; s.step = 'main1'; s.priority = TRIAL_SEAT;
  const put = (pid: PlayerId, name: string, zone: 'hand' | 'battlefield' | 'graveyard'): GameObject | null => {
    const d = cards.get(name); if (!d) return null;
    const o = makeObject(s.nextId++, d, pid, zone, 1); o.enteredTurn = 1; s.players[pid][zone].push(o); return o;
  };
  for (const l of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) for (let i = 0; i < 3; i++) put(TRIAL_SEAT, l, 'battlefield');
  put(TRIAL_SEAT, FILLER.creature, 'battlefield');
  for (const n of [FILLER.creature, FILLER.artifact, FILLER.instant, FILLER.land]) put(TRIAL_SEAT, n, 'graveyard');
  for (const n of [FILLER.land, FILLER.creature, FILLER.instant, FILLER.sorcery, FILLER.artifact, FILLER.enchantment]) put(TRIAL_SEAT, n, 'hand');
  for (const pid of opponentsOf(s, TRIAL_SEAT)) { put(pid, FILLER.creature, 'battlefield'); put(pid, FILLER.bigCreature, 'battlefield'); }
  const card = makeObject(s.nextId++, def, TRIAL_SEAT, 'hand', 1); card.enteredTurn = 1; s.players[TRIAL_SEAT].hand.push(card);
  return { state: s, cardId: card.id, seats, maxTurns };
}

/** A fresh game on a clone of the base state — every probe runs from the same starting board. */
function fresh(base: Base): Game {
  return Game.fromState(cloneState(base.state), agentsFor(base.seats), { quiet: true, seed: 1, events: 'full', maxTurns: base.maxTurns });
}

/**
 * Put the card under test onto the battlefield through `enterBattlefield`, so its as-enters and etb triggers run.
 * An Aura or Equipment is attached to the probe creature afterwards: unattached, its whole static effect is inert
 * (and an unattached Aura is put into the graveyard by the next state-based action), so every such card would report
 * an unreachable static.
 */
async function land(g: Game, id: number): Promise<GameObject | null> {
  const o = findObject(g.state, id);
  if (!o) return null;
  if (o.zone !== 'battlefield') await g.enterBattlefield(o, { controller: TRIAL_SEAT, via: 'effect' });
  const self = findObject(g.state, id);
  if (self && self.zone === 'battlefield' && (self.def.subtypes.includes('Aura') || self.def.subtypes.includes('Equipment'))) {
    const host = g.state.players[TRIAL_SEAT].battlefield.find(x => x.id !== id && x.def.types.includes('Creature'));
    if (host) g.attach(self, host);
  }
  await g.resolveStackFully();
  return findObject(g.state, id) ?? null;
}

/** The first legal action for `card` of the given type, with its first legal targets filled in. */
function firstAction(g: Game, id: number, type: 'cast' | 'play-land' | 'activate', abilityIndex?: number) {
  for (const l of legalActions(g, TRIAL_SEAT)) {
    const a = l.action as { type: string; cardId?: number; objectId?: number; abilityIndex?: number };
    if (a.type !== type) continue;
    if ((a.cardId ?? a.objectId) !== id) continue;
    if (abilityIndex !== undefined && a.abilityIndex !== abilityIndex) continue;
    const reqs = l.targetOptions ?? [];
    return reqs.length ? { ...l.action, targets: reqs.map(r => r.options.slice(0, r.count)) } : l.action;
  }
  return null;
}

/** Cast a card from seat 0's hand by name (the filler spells the `cast` / `targeted` probes need). */
async function castFiller(g: Game, name: string): Promise<boolean> {
  const o = g.state.players[TRIAL_SEAT].hand.find(c => c.def.name === name);
  if (!o) return false;
  const action = firstAction(g, o.id, o.def.types.includes('Land') ? 'play-land' : 'cast');
  if (!action) return false;
  const ok = await g.performAction(TRIAL_SEAT, action);
  if (ok) await g.resolveStackFully();
  return ok;
}

// ---------------------------------------------------------------------------
// Trigger scenarios
// ---------------------------------------------------------------------------

type Scenario = (g: Game, base: Base) => Promise<void>;

/** The named setups, each run at most once per card however many abilities want it. */
const SCENARIOS: Record<string, Scenario> = {
  async enter(g, b) { await land(g, b.cardId); },
  async cast(g, b) {
    const action = firstAction(g, b.cardId, 'cast') ?? firstAction(g, b.cardId, 'play-land');
    if (action) { await g.performAction(TRIAL_SEAT, action); await g.resolveStackFully(); }
    else await land(g, b.cardId);
  },
  // one turn PER SEAT: "at the beginning of your upkeep" is not reached by the next turn, which is an opponent's
  async turn(g, b) { await land(g, b.cardId); await g.resumeTurn(); await g.playTurns(b.seats); },
  async attack(g, b) {
    const o = await land(g, b.cardId);
    if (!o) return;
    o.enteredTurn = 0; o.tapped = false;
    g.state.step = 'combat-begin';
    // "whenever a creature you control attacks" needs a creature that is not the card under test, and a noncreature
    // card under test cannot attack at all, so the probe creature always joins the attack
    const mate = g.state.players[TRIAL_SEAT].battlefield.find(x => x.id !== o.id && x.def.types.includes('Creature'));
    if (mate) { mate.enteredTurn = 0; mate.tapped = false; }
    await g.simulateCombat(dropUndefined([o.id, mate?.id]), []);
    await g.resolveStackFully();
  },
  async block(g, b) {
    const o = await land(g, b.cardId);
    if (!o) return;
    o.enteredTurn = 0; o.tapped = false;
    const defender = opponentsOf(g.state, TRIAL_SEAT)[0];
    const attacker = defender === undefined ? undefined : g.state.players[defender].battlefield[0];
    if (attacker === undefined || defender === undefined) return;
    g.state.activePlayer = defender; g.state.step = 'combat-begin'; attacker.enteredTurn = 0;
    await g.simulateCombat([attacker.id], [{ blocker: o.id, attacker: attacker.id }]);
    await g.resolveStackFully();
  },
  async die(g, b) {
    const o = await land(g, b.cardId);
    if (!o) return;
    g.dealDamage(o, o, 99);
    g.checkSBA();
    await g.resolveStackFully();
  },
  async leave(g, b) {
    const o = await land(g, b.cardId);
    if (!o) return;
    g.moveTo(o, 'exile');
    await g.resolveStackFully();
  },
  async spells(g, b) {
    await land(g, b.cardId);
    for (const n of [FILLER.instant, FILLER.creature, FILLER.sorcery, FILLER.artifact]) await castFiller(g, n);
  },
  async targeted(g, b) {
    const o = await land(g, b.cardId);
    if (!o) return;
    const shock = g.state.players[TRIAL_SEAT].hand.find(c => c.def.name === FILLER.instant);
    if (!shock) return;
    const action = firstAction(g, shock.id, 'cast');
    if (!action) return;
    await g.performAction(TRIAL_SEAT, { ...action, targets: [[{ kind: 'object', id: o.id }]] } as typeof action);
    await g.resolveStackFully();
  },
  async playLand(g, b) { await land(g, b.cardId); await castFiller(g, FILLER.land); },
  async misc(g, b) {
    const o = await land(g, b.cardId);
    await g.draw(TRIAL_SEAT);
    const opp = opponentsOf(g.state, TRIAL_SEAT)[0];
    if (opp !== undefined) await g.draw(opp);                // "whenever an opponent draws a card"
    g.gainLife(TRIAL_SEAT, 1);
    if (opp !== undefined) g.loseLife(opp, 1, 'probe');
    const hand = g.state.players[TRIAL_SEAT].hand[0];
    if (hand) g.discard(TRIAL_SEAT, hand.id);
    const victim = g.state.players[TRIAL_SEAT].battlefield.find(x => x.id !== b.cardId && x.def.name === FILLER.creature);
    if (victim) g.sacrifice(victim);
    const dead = g.state.players[TRIAL_SEAT].graveyard.find(x => x.def.name === FILLER.creature);
    if (dead) g.moveTo(dead, 'hand');
    if (o && o.zone === 'battlefield') g.setTapped(o, true);
    await g.resolveStackFully();
  },
};

/** Which setups can raise which trigger event. An event with no entry is never reachable by a probe. */
const TRIGGER_SCENARIOS: Record<string, string[]> = {
  etb: ['enter', 'cast'], dies: ['die', 'misc'], ltb: ['leave', 'die'],
  attacks: ['attack'], 'you-attack': ['attack'], 'becomes-blocked': ['block', 'attack'],
  blocks: ['block'], 'combat-damage-player': ['attack'], 'deals-damage': ['attack', 'block'],
  upkeep: ['turn'], 'end-step': ['turn'], 'draw-step': ['turn'], 'combat-begin': ['turn'], 'end-of-turn': ['turn'],
  chapter: ['turn'], cast: ['spells'], targeted: ['targeted'], landfall: ['playLand', 'turn'],
  draw: ['misc', 'turn'], discard: ['misc'], 'life-gain': ['misc'], 'life-loss-opponent': ['misc'],
  sacrifice: ['misc'], 'leaves-graveyard': ['misc'], tapped: ['misc'], 'turned-face-up': [], reflexive: [],
  or: [], unknown: [],
};

/** The events one trigger can fire on (an `or` trigger is any of its members). */
function eventsOf(ev: TriggerEvent): string[] {
  return ev.on === 'or' ? ev.events.flatMap(eventsOf) : [ev.on];
}

/** The setups this card's abilities need, deduplicated and in a stable order. */
function scenariosFor(abilities: readonly Ability[]): string[] {
  const want = new Set<string>();
  for (const a of abilities) {
    if (a.kind === 'triggered') for (const on of eventsOf(a.event)) for (const s of TRIGGER_SCENARIOS[on] ?? []) want.add(s);
    if (a.kind === 'spell') want.add('cast');
  }
  return Object.keys(SCENARIOS).filter(k => want.has(k));
}

// ---------------------------------------------------------------------------
// Statics
// ---------------------------------------------------------------------------

/** The characteristics a static effect could change, as one comparable string. */
function snapshot(g: Game): string {
  const s = g.state;
  const parts: string[] = [];
  for (const pid of s.players.map(p => p.id)) {
    for (const o of s.players[pid].battlefield) {
      parts.push(`${pid}:${o.def.name}:${power(s, o)}/${toughness(s, o)}:${keywords(s, o).slice().sort().join(',')}:${JSON.stringify(flags(s, o))}:${o.tapped ? 'T' : 'U'}`);
    }
  }
  // a static that grants no characteristic still shows up as a legal action the controller would not otherwise have
  // (flash-for, play-lands-from, a mana ability granted to a land, a cost reduction that makes a card castable)
  parts.push(legalActions(g, TRIAL_SEAT).map(l => l.label).sort().join('|'));
  return parts.sort().join('\n');
}

/**
 * Whether THIS ONE static ability changes anything a probe can see — the only probe that works for a static, because
 * a static never "runs".
 *
 * The comparison is with and WITHOUT THE ABILITY, not with and without the card. Comparing a board that has the card
 * on the battlefield against one that does not is vacuous: the card's own row is on one board and not the other, so
 * the two snapshots differ by construction and EVERY permanent reported a reached static whether or not its static
 * did anything — a `Glorious Anthem` that pumped only Kavu (with no Kavu in the probe deck) read exactly like the
 * real one. So the same board is built twice from the same base state, the second time from a def with this ability
 * removed, and the card is put onto the battlefield in both. Every id, every other permanent and every trigger is
 * identical between the two runs; the only difference left is what this static does — to another permanent, to the
 * controller's legal actions, or to the card itself.
 */
async function staticReached(cards: CardDB, def: CardDef, base: Base, index: number): Promise<boolean> {
  const withIt = fresh(base);
  await land(withIt, base.cardId);
  const stripped: CardDef = { ...def, abilities: (def.abilities ?? []).filter((_, i) => i !== index) };
  const bare = baseState(cards, stripped, base.seats, base.maxTurns);
  const without = fresh(bare);
  await land(without, bare.cardId);
  return snapshot(withIt) !== snapshot(without);
}

// ---------------------------------------------------------------------------
// The probe run
// ---------------------------------------------------------------------------

/** Every `{ type: 'trigger' }` event the run announced for the card under test, by the ability text that fired. */
function firedAbilities(g: Game, cardId: number): Set<string> {
  const out = new Set<string>();
  for (const ev of g.state.events ?? []) {
    if (ev.type !== 'trigger') continue;
    const t = ev as { type: 'trigger'; id: number; ability: string };
    if (t.id === cardId) out.add(t.ability);
  }
  return out;
}

/**
 * Probe every ability of `def`'s front face and say which ones a probe could reach. The result is the
 * `verification.sandbox.abilities` block; an unreached ability is a warning for the blind-scenario author, never a
 * verification failure. A probe that throws is reported as unreached with the error in `how` — the sandbox stage is
 * what judges throwing, and it runs on the same card.
 */
export async function probeAbilities(cards: CardDB, def: CardDef, opts: ProbeOptions = {}): Promise<AbilityProbe[]> {
  const abilities = def.abilities ?? [];
  if (!abilities.length) return [];
  const seats = opts.seats ?? 2;
  const maxTurns = opts.maxTurns ?? 8;
  const base = baseState(cards, def, seats, maxTurns);
  const out: AbilityProbe[] = abilities.map((_, index) => ({ index, reached: false }));

  // --- triggered and spell abilities: run each needed setup once, then read the announced triggers -------------
  const fired = new Map<string, string>();                     // ability text -> the scenario that fired it
  const castWorked = { ok: false };
  for (const name of scenariosFor(abilities)) {
    const g = fresh(base);
    try {
      await SCENARIOS[name](g, base);
      if (name === 'cast') castWorked.ok = findObject(g.state, base.cardId)?.zone !== 'hand';
      for (const text of firedAbilities(g, base.cardId)) if (!fired.has(text)) fired.set(text, name);
    } catch { /* a throwing setup reaches nothing; src/verify/sandbox.ts is what reports the throw */ }
  }

  // --- activated abilities: the legal action for that index, on the battlefield and then after a turn ----------
  const activatedIdx = abilities.flatMap((a, i) => (a.kind === 'activated' ? [i] : []));
  if (activatedIdx.length) {
    const g = fresh(base);
    try {
      const self = await land(g, base.cardId);
      // it entered this turn, so a `{T}:` ability would be refused for summoning sickness; the probe asks "can this
      // ability ever run", not "can it run the turn it lands"
      if (self) { self.enteredTurn = 0; self.tapped = false; }
      for (const i of activatedIdx) {
        // each ability is probed from the same board: untap the source and forget what it already activated, so a
        // second `{T}:` ability is not refused because the first one tapped it
        const now = findObject(g.state, base.cardId);
        if (now) { now.tapped = false; now.enteredTurn = 0; now.activatedThisTurn.clear(); }
        // a plain mana ability is deliberately absent from `legalActions` (src/engine/legal.ts:387 — the payment
        // planner taps it), so fall back to the bare action; `activateAbility` validates the cost itself
        const action = firstAction(g, base.cardId, 'activate', i)
          ?? { type: 'activate' as const, objectId: base.cardId, abilityIndex: i };
        if (await g.performAction(TRIAL_SEAT, action)) { out[i] = { index: i, reached: true, how: 'activated' }; await g.resolveStackFully(); }
      }
    } catch { /* the sandbox stage reports the throw */ }
  }

  // --- statics: one with/without-THIS-ABILITY comparison per static --------------------------------------------
  for (const i of abilities.flatMap((a, j) => (a.kind === 'static' ? [j] : []))) {
    let changed = false;
    try { changed = await staticReached(cards, def, base, i); } catch { changed = false; }
    if (changed) out[i] = { index: i, reached: true, how: 'static: the board differs with and without this ability' };
  }

  for (let i = 0; i < abilities.length; i++) {
    const a = abilities[i];
    if (out[i].reached) continue;
    if (a.kind === 'triggered') { const how = fired.get(a.text); if (how) out[i] = { index: i, reached: true, how: `trigger fired in the '${how}' probe` }; }
    if (a.kind === 'spell' && castWorked.ok) out[i] = { index: i, reached: true, how: 'cast' };
  }
  return out;
}

/** The abilities no probe reached — what `scripts:verify` lists as a warning for the scenario author. */
export function unreachable(probes: readonly AbilityProbe[], abilities: readonly Ability[]): string[] {
  return probes.filter(p => !p.reached).map(p => `ability ${p.index} (${abilities[p.index]?.kind}) was never reached: ${JSON.stringify(abilities[p.index]?.text ?? '')}`);
}
