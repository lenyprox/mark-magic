// The "control" family (Phase 9.1; docs/vocabulary/control.md).
//
// Control-change effects that the core's `gain-control` (permanent / until-end-of-turn only, one stolen permanent, the
// item's controller always the thief) and the composition core's `exchange what: 'control'` (permanent, two named
// permanents) cannot express:
//
//   * DURATIONS beyond end of turn — "until the end of your next turn", "until end of combat" and the five
//     "for as long as …" forms (CR 611.2b): the effect lasts while a condition holds and, if the condition is already
//     false when the effect would start, it never starts at all;
//   * A GAINER that is not the item's controller — "target opponent gains control of ~", "that player gains control
//     of ~", "the player with the most life gains control of ~";
//   * GROUP control changes — "gain control of all creatures", "gain control of all lands target player controls";
//   * GIVING EVERYTHING BACK — "each player gains control of all permanents they own" (Homeward Path, Brooding
//     Saurian, Trostani Discordant), which is not the end of a duration but an effect in its own right;
//   * EXCHANGES with a duration and the "two target permanents" single-spec form.
//
// State: a JSON-plain STACK of entries per stolen permanent, `o.ext.controlReturn` (see `ControlReturn`), oldest
// first — one entry per live control-change effect with a duration, which is this family's stand-in for the
// timestamp order of CR 613.7. Nothing here is hidden information — every player can see who controls what — so the
// family registers no `redact` hook. `clone.ts` deep-copies the bag and `serialize.ts` round-trips it; a permanent
// that leaves the battlefield is a new object (CR 400.7) and its whole stack is dropped by the `leave` hook.
//
// Where a duration ends:
//   time-based  `steps.cleanup` (eot, your-next-turn) and `steps['combat-end']` (end-of-combat)
//   condition   the `sba` hook — the engine keeps no continuous-effect layer for control (a controller is a field on
//               the object), so the state-based-action loop, which runs after every action and every resolution, is
//               where a "for as long as" duration is noticed to have ended (CR 611.2b). It is not a state-based
//               action in the CR sense; it is the engine's polling point.
import type { Condition, Ref } from '../../cards/types.js';
import type { Effect, Filter, FamilyModule, GameObject, GameState, Keyword, PlayerId, TargetRef, TargetSpec } from './types.js';
import { extDel, extGet, extHas, extPush } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/** How long a control change lasts. The `while-*` forms are CR 611.2b durations: they end the moment the condition is false. */
export type ControlDuration =
  | 'permanent' | 'eot' | 'end-of-combat' | 'your-next-turn'
  | 'while-source-on-battlefield' | 'while-you-control-source' | 'while-source-tapped'
  | 'while-you-control-source-and-tapped' | 'while-counter';

/**
 * Which single player gains control. There is deliberately no `target-player` / `target-opponent` here: `legal.ts`
 * only emits a player requirement for the ops it knows by name, so a `who` that named a target would ask for nobody
 * on cast and resolve to nobody. "Target opponent gains control of ~" is the composition core's `scoped`
 * (`{ op: 'scoped', who: 'target-opponent', do: [{ op: 'control-gain', target: 'self' }] }`), which does emit the
 * requirement and rebinds `you` to the payer — see docs/vocabulary/control.md.
 */
export type ControlWho = 'you' | 'that-player' | 'controller-of-that' | 'owner-of-that' | 'leader';

/** "the player with the most life / the most cards in hand / the most creatures" (CR 104.2 has no such player; ties mean nobody). */
export interface ControlLeader { of: 'life' | 'cards-in-hand' | 'permanents'; filter?: Filter; extreme: 'most' | 'least' }

/** Every permanent matching `all` that the named players control ("gain control of all creatures", "…all Dragons"). */
export interface ControlSet { all: Filter; who?: 'you' | 'each-player' | 'each-opponent' | 'that-player' }

/** "Gain control of target creature until end of turn. Untap it. It gains haste until end of turn." and its relatives. */
export interface ControlGainEffect {
  op: 'control-gain';
  /**
   * The permanent(s) to take. Exactly one of `target` and `all` is given: a `TargetSpec` is chosen on cast (it is
   * this effect's own requirement, which `legal.ts:ownTargetSpecs` reads off the `target` field by name), a `Ref`
   * reads the binding frame, and `all` is the untargeted group form.
   */
  target?: TargetSpec | Ref;
  /** The group form: "gain control of all creatures" / "all Dragons". Never a target — nothing is chosen on cast. */ all?: ControlSet;
  /** Who gains control (default `you`, the item's controller — or the actor of a `scoped` block). */ who?: ControlWho;
  /** Default `permanent` (CR 611.2: a continuous effect with no duration lasts indefinitely). */ duration?: ControlDuration;
  /** The counter `while-counter` watches ("for as long as it has a shield counter on it"). */ counter?: string;
  /** The metric `who: 'leader'` reads. */ leader?: ControlLeader;
  /** "Untap it." — through `Game.setTapped`, so the untap is on the event stream. */ untap?: boolean;
  /** "It gains haste until end of turn." — only with `target` (it delegates to the core `grant-keyword`, which takes no group form). */ haste?: boolean;
}

/** "Each player gains control of all permanents they own" — the opposite of a theft, and not the end of a duration. */
export interface ControlReturnEffect {
  op: 'control-return';
  /** Default `each-player`. (No `target-player`, for the reason `ControlWho` gives: wrap it in a `scoped`.) */ who?: 'each-player' | 'each-opponent' | 'you' | 'that-player';
  /** Which of their permanents ("all nontoken permanents they own"); absent = all of them. */ filter?: Filter;
}

/** "Exchange control of two target permanents that share a card type" (CR 701.12) — with a duration, unlike the core `exchange`. */
export interface ControlExchangeEffect {
  op: 'control-exchange';
  /**
   * The permanents to swap, as ONE requirement so `legal.ts` finds it on the `target` field: a `multi` spec of two
   * parts ("target artifact and target creature"), or one spec with `count: 2` ("two target nonlegendary creatures").
   * With `self`, one spec naming the other side ("exchange control of ~ and target creature an opponent controls").
   */
  target: TargetSpec;
  /** The first side is the source itself. */ self?: boolean;
  /** "…that share a card type": checked as the effect resolves; nothing happens when they do not (see the doc). */ share?: 'card-type';
  /** Default `permanent`. */ duration?: ControlDuration;
}

/** "if a player has more life than each other player" — true only when exactly one player is strictly at the extreme. */
export interface ControlLeaderCondition { kind: 'control-leader'; of: 'life' | 'cards-in-hand' | 'permanents'; filter?: Filter; extreme: 'most' | 'least' }

/** "other players can't gain control of them" (Guardian Beast): the family's own ops refuse to move these permanents. */
export interface ControlLockStatic { kind: 'control-cant-change'; scope: 'self' | 'you-control' | 'all'; filter?: Filter; condition?: Condition }

/** "When you gain control of ~ from another player, …" — raised by this family's ops when a controller really changed. */
export interface ControlGainedTrigger { on: 'control-gained'; self?: boolean; who?: 'you' | 'any' }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { controlGain: ControlGainEffect; controlReturn: ControlReturnEffect; controlExchange: ControlExchangeEffect }
  interface ConditionRegistry { controlLeader: ControlLeaderCondition }
  interface StaticRegistry { controlCantChange: ControlLockStatic }
  interface TriggerRegistry { controlGained: ControlGainedTrigger }
  interface TargetKindRegistry { 'permanent-you-own-not-control': true }
}

// ------------------------------------------------------------------ 3. the ext entry and the duration predicate

/**
 * One entry of `o.ext.controlReturn` — what ONE live control-change effect with a duration remembers. JSON-plain
 * (numbers and strings only).
 *   to     the controller to hand it back to when THIS effect's duration ends: the controller the permanent had the
 *          instant this effect applied, i.e. what every OLDER effect still in the stack makes of it (CR 613.1c)
 *   by     the player who gained control — the "you" of "for as long as you control ~"
 *   src    the source object's id — the "~" of "for as long as ~ remains on the battlefield"
 *   turn   the turn the effect started (`your-next-turn`)
 */
export type ControlReturn = { to: PlayerId; by: PlayerId; until: ControlDuration; src: number; turn: number; counter: string };

/**
 * The bag key. Its value is a `ControlReturn[]` in timestamp order, oldest first — NOT a single entry: CR 613.1c
 * applies control-change effects in timestamp order, so a second theft over a still-live first one must give the
 * permanent back to the FIRST thief when it ends, not to the seat that held it before either effect existed. The
 * stack is the order; the top of it is the current controller's title.
 */
const EXT = 'controlReturn';

/** `o`'s live duration entries, oldest first (the live array — callers that walk it must snapshot). */
const stackOf = (o: GameObject): ControlReturn[] | undefined => extGet<ControlReturn[]>(o, EXT);

/** Is `d` one of the CR 611.2b conditional durations (the ones the sba hook polls)? */
const isWhile = (d: ControlDuration): boolean => d.startsWith('while-');

/**
 * Does a `while-*` duration still hold? Time-based durations always answer true here — their end is a step hook's
 * business. Read with the entry's own `src` / `by`, so the answer does not depend on who is asking.
 */
function whileHolds(s: GameState, o: GameObject, e: { until: ControlDuration; by: PlayerId; src: number; counter?: string }): boolean {
  if (!isWhile(e.until)) return true;
  if (e.until === 'while-counter') return (o.counters[e.counter ?? ''] ?? 0) > 0;
  const src = chars.findObject(s, e.src);
  if (!src || src.zone !== 'battlefield') return false;
  switch (e.until) {
    case 'while-source-on-battlefield': return true;
    case 'while-you-control-source': return src.controller === e.by;
    case 'while-source-tapped': return src.tapped;
    case 'while-you-control-source-and-tapped': return src.controller === e.by && src.tapped;
    default: return true;
  }
}

/**
 * Every permanent carrying live entries, as a snapshot of both the object list and each stack (the callers change
 * control and splice stacks while they walk it). The entry objects themselves are the live ones, so `endControl`
 * can find them by identity.
 */
function stolen(s: GameState): { o: GameObject; es: ControlReturn[] }[] {
  const out: { o: GameObject; es: ControlReturn[] }[] = [];
  for (const o of chars.allPermanents(s)) { const es = stackOf(o); if (es !== undefined && es.length) out.push({ o, es: [...es] }); }
  return out;
}

/**
 * End the ONE effect `e` and forget its entry.
 *
 * CR 613.1c / 611.2: the other entries on the stack are effects that have not ended, and they go on applying. So the
 * permanent moves only when `e` is the TOP entry (the newest live effect — the one whose word is currently law);
 * ending an effect UNDERNEATH a live one changes nothing on the battlefield, it only rewrites where the effect above
 * will hand the permanent when its own turn comes: with `e` gone, "the controller before the effect above" is what
 * `e` recorded, so the entry above inherits `e.to`. That is what keeps Sower of Temptation's creature coming back to
 * the Sower's controller when an Act of Treason cast on top of it wears off, and going home to its owner instead
 * once the Sower has died first.
 *
 * CR 800.4a: a player who has left the game controls nothing, and every effect that gave them control of anything has
 * already ended. `leaveGame` only re-homes what the leaver *controlled* at the moment they left, so an entry pointing
 * at their seat can outlive them (they were the previous controller of a permanent a third player had since stolen);
 * handing the permanent back would park it on an empty battlefield, where it still counts for filters, anthems and
 * board evaluation but can never act. The empty seat is skipped and the permanent goes to its OWNER instead - who
 * controls it once the leaver's own control-change effect has ended - or, when the owner has left too, it stays where
 * it is (`leaveGame` exiles what a leaver owns, so that case only arises mid-elimination).
 */
function endControl(g: { state: GameState; changeControl(o: GameObject, to: PlayerId): void; note(s: string): void }, o: GameObject, e: ControlReturn, why: string): void {
  const st = stackOf(o);
  const i = st ? st.indexOf(e) : -1;
  if (!st || i < 0) return;                                                       // already ended (a cascade got here first)
  const top = i === st.length - 1;
  if (!top) st[i + 1].to = e.to;                                                  // CR 613.1c: the effect above now sits on what this one sat on
  st.splice(i, 1);
  if (!st.length) extDel(o, EXT);
  if (!top) return;                                                               // a newer effect still says who controls it
  const to = !g.state.players[e.to]?.lost ? e.to : g.state.players[o.owner]?.lost ? undefined : o.owner;
  if (to === undefined || o.controller === to) return;
  g.changeControl(o, to);
  g.note(`${chars.name(o)} returns to ${g.state.players[to].name} (${why}).`);
}

// ------------------------------------------------------------------ 4. the leader metric

/** Players still in the game, in seat order. */
const seated = (s: GameState): PlayerId[] => s.players.filter(pl => !pl.lost).map(pl => pl.id);

function metric(s: GameState, p: PlayerId, of: ControlLeader['of'], filter?: Filter): number {
  const pl = s.players[p];
  if (of === 'life') return pl.life;
  if (of === 'cards-in-hand') return pl.hand.length;
  return chars.battlefieldOf(s, p).filter(o => chars.matchesFilter(s, o, filter)).length;
}

/** The single player strictly at the extreme, or undefined when nobody is (a tie, or no players). CR 104.2 note in the doc. */
function leaderOf(s: GameState, spec: ControlLeader): PlayerId | undefined {
  const ps = seated(s);
  if (!ps.length) return undefined;
  const vals = ps.map(p => metric(s, p, spec.of, spec.filter));
  const best = spec.extreme === 'most' ? Math.max(...vals) : Math.min(...vals);
  const winners = ps.filter((_p, i) => vals[i] === best);
  return winners.length === 1 ? winners[0] : undefined;
}

// ------------------------------------------------------------------ 5. helpers the effect ops share

/** May this permanent's controller be changed at all? (`control-cant-change`, Guardian Beast.) */
const lockedDown = (s: GameState, o: GameObject): boolean => chars.flags(s, o).cantChangeControl === true;

/** What an effect op is handed (the barrel's `OpCtx`, named once so the helpers below can take it). */
type Ctx = Parameters<NonNullable<FamilyModule['effects']>[string]>[1];

/**
 * The permanents `target` names: a `TargetSpec` reads the item's chosen targets (the picks `legal.ts` asked for on
 * cast), a `Ref` reads the binding frame. Objects that have left the battlefield are dropped — a control change is
 * about a permanent, and one that changed zones is a new object (CR 400.7).
 */
async function targetsOf(c: Ctx, t: TargetSpec | Ref): Promise<GameObject[]> {
  if (typeof t !== 'string') return c.objs().filter(o => o.zone === 'battlefield');
  const { resolveRef } = await import('../refs.js');
  return resolveRef({ s: c.s, item: c.item, p: c.p, src: c.src }, t).filter(o => o.zone === 'battlefield');
}

/** The permanents a `ControlSet` names: everything matching `all` on the battlefields of `who` (default: everyone). */
async function setOf(c: Ctx, set: ControlSet): Promise<GameObject[]> {
  const { resolveWho } = await import('../refs.js');
  const who = set.who ? resolveWho({ s: c.s, item: c.item, p: c.p, src: c.src }, set.who) : seated(c.s);
  const out: GameObject[] = [];
  for (const p of who) for (const o of chars.battlefieldOf(c.s, p)) if (chars.matchesFilter(c.s, o, set.all, c.src)) out.push(o);
  return out;
}

/**
 * The one player an effect hands control to.
 *
 * `that-player` is deliberately NARROWER here than the core's `thatPlayer` (refs.ts), which falls back to the
 * controller of the last bound object and then to the first player target. A control change hands a permanent over
 * for good, so it may only follow a referent the sentence really named: the player the TRIGGER was about. Goblin
 * Festival is why - "{2}: ~ deals 1 damage to any target. Flip a coin. If you lose the flip, choose one of your
 * opponents. That player gains control of ~." parses with its coin flip and its choice still `unknown`, and the core
 * fallback would read "that player" off the `damage` binding and give the enchantment away on EVERY activation, with
 * no flip and to the wrong player. With no trigger there is no such player and the effect does nothing (CR 608.2: an
 * effect does as much as it can, which here is nothing) - exactly what the unparsed sentence did before.
 */
async function gainerOf(c: Ctx, e: ControlGainEffect): Promise<PlayerId | undefined> {
  if (e.who === 'leader') return e.leader ? leaderOf(c.s, e.leader) : undefined;
  if (e.who === undefined || e.who === 'you') return c.item.actor ?? c.p;
  if (e.who === 'that-player') return c.item.triggeringPlayer;
  const { resolveOnePlayer } = await import('../refs.js');
  return resolveOnePlayer({ s: c.s, item: c.item, p: c.p, src: c.src }, e.who, c.T);
}

/**
 * Hand `o` to `to` for `duration`, recording what has to happen when the duration ends. Returns true when a
 * controller really changed (which is what raises `control-gained` and what "if you do" reads).
 */
function steal(g: { state: GameState; changeControl(o: GameObject, to: PlayerId): void; note(s: string): void }, o: GameObject, to: PlayerId, duration: ControlDuration, src: GameObject, counter?: string): boolean {
  const s = g.state;
  if (o.zone !== 'battlefield' || lockedDown(s, o)) return false;
  if (s.players[to]?.lost) return false;                                          // CR 800.4a: a seat that has left the game controls nothing
  // CR 611.2b: a duration that has already ended never starts the effect (Sower of Temptation that died in response)
  if (!whileHolds(s, o, { until: duration, by: to, src: src.id, counter })) return false;
  const same = o.controller === to;                                               // it is already theirs; only the TIMESTAMP is new
  if (duration === 'permanent') extDel(o, EXT);                                   // the newest effect never ends: nothing under it can ever hand it back
  // A new entry records the controller it found (CR 613.1c — see `endControl`). When `to` already controls the
  // permanent the entry is worth keeping only over a live stack, where it outranks the older effect and so keeps the
  // permanent here when that one ends (Act of Treason on the creature your own Sower of Temptation is holding);
  // over a bare permanent it would record `to` returning it to `to`, so it is not written at all.
  else if (!same || extHas(o, EXT)) extPush<ControlReturn>(o, EXT, { to: o.controller, by: to, until: duration, src: src.id, turn: s.turn, counter: counter ?? '' });
  if (same) return false;                                                         // nothing changed hands: no note, no `control-gained` (CR 603.2)
  g.changeControl(o, to);
  return true;
}

// ------------------------------------------------------------------ 6. the module

const CONTROL: FamilyModule = {
  name: 'control',

  effects: {
    // "Gain control of target creature [until end of turn / for as long as ~ remains on the battlefield]."
    'control-gain': async (e: ControlGainEffect, c) => {
      const to = await gainerOf(c, e);
      if (to === undefined) return;                                               // a tie for "the player with the most life": no one
      const list = e.target !== undefined ? await targetsOf(c, e.target) : e.all !== undefined ? await setOf(c, e.all) : [];
      const took: GameObject[] = [];
      // `held`: already the gainer's — no change of control, no note, no `control-gained` (CR 613.7 / 603.2), but the
      // untap and the haste of "Untap target creature and gain control of it" still happen (CR 608.2c: an effect does
      // as much as it can). Word of Seizing / Threaten on your own tapped creature is a normal line.
      const held: GameObject[] = [];
      for (const o of list) if (steal(c.g, o, to, e.duration ?? 'permanent', c.src, e.counter)) took.push(o); else if (o.controller === to && o.zone === 'battlefield') held.push(o);
      for (const o of took) {
        c.g.note(`${c.g.state.players[to].name} gains control of ${chars.name(o)}${e.duration && e.duration !== 'permanent' ? ` (${e.duration})` : ''}.`);
        c.g.queueTriggers('control-gained', { obj: o, player: to });
      }
      if (e.untap) for (const o of [...took, ...held]) c.g.setTapped(o, false, 'effect');
      // "It gains haste until end of turn" / "They gain haste until end of turn." The targeted form goes through the
      // core op, so the grant is one shape everywhere (and it binds `that`). The GROUP form cannot: `grant-keyword`
      // takes one TargetSpec/Ref and `all` binds nothing, so the same end-of-turn keyword list game.ts writes is
      // written here directly - the cleanup step wipes it exactly as it wipes the core op's (CR 514.2, 702.10b).
      if (e.haste && (took.length || held.length)) {
        if (e.target !== undefined) await c.apply({ op: 'grant-keyword', target: e.target, keywords: ['haste' as Keyword], duration: 'eot' } as Effect);
        else for (const o of [...took, ...held]) if (!o.eotKeywords.includes('haste' as Keyword)) o.eotKeywords.push('haste' as Keyword);
      }
    },

    // "At the beginning of your end step, each player gains control of all creatures they own."
    'control-return': async (e: ControlReturnEffect, c) => {
      const { resolveWho } = await import('../refs.js');
      const who = resolveWho({ s: c.s, item: c.item, p: c.p, src: c.src }, e.who ?? 'each-player');
      for (const p of who) {
        for (const o of chars.allPermanents(c.s).filter(x => x.owner === p && x.controller !== p)) {
          if (!chars.matchesFilter(c.s, o, e.filter, c.src) || lockedDown(c.s, o)) continue;
          extDel(o, EXT);
          c.g.changeControl(o, p);
          c.g.note(`${c.g.state.players[p].name} gains control of ${chars.name(o)} (they own it).`);
          c.g.queueTriggers('control-gained', { obj: o, player: p });
        }
      }
    },

    // "Exchange control of two target permanents that share a card type." (CR 701.12b)
    'control-exchange': async (e: ControlExchangeEffect, c) => {
      const picks = await targetsOf(c, e.target);
      const A = e.self ? c.src : picks[0];
      const B = e.self ? picks[0] : picks[1];
      if (!A || !B || A === B) return;
      if (A.zone !== 'battlefield' || B.zone !== 'battlefield') return;            // CR 701.12b: nothing happens
      if (A.controller === B.controller) return;
      if (lockedDown(c.s, A) || lockedDown(c.s, B)) return;
      if (e.share === 'card-type' && !chars.types(A).some(t => chars.types(B as GameObject).includes(t))) return;
      const ca = A.controller; const cb = B.controller;
      const d = e.duration ?? 'permanent';
      steal(c.g, A, cb, d, c.src); steal(c.g, B, ca, d, c.src);
      c.g.note(`Control of ${chars.name(A)} and ${chars.name(B)} is exchanged.`);
      c.g.queueTriggers('control-gained', { obj: A, player: cb });
      c.g.queueTriggers('control-gained', { obj: B, player: ca });
    },
  },

  conditions: {
    // "if a player has more life than each other player" / "if a player controls more creatures than each other player"
    'control-leader': (cond: ControlLeaderCondition, s) => leaderOf(s, cond) !== undefined,
  },

  statics: {
    // "As long as ~ is untapped, … other players can't gain control of them."
    'control-cant-change': (e: ControlLockStatic, src, o, s, m) => {
      if (e.condition && !chars.conditionHolds(s, src, e.condition)) return;
      const inScope = e.scope === 'self' ? o.id === src.id
        : e.scope === 'you-control' ? o.controller === src.controller && chars.matchesFilter(s, o, e.filter, src)
          : chars.matchesFilter(s, o, e.filter, src);
      if (inScope) m.flags.cantChangeControl = true;
    },
  },

  triggers: {
    // Raised by this family's own ops (the core's `gain-control` and `exchange` do not raise it — see the doc).
    'control-gained': (ev: ControlGainedTrigger, perm, ctx, _s, event) => event === 'control-gained'
      && (ev.self !== false ? ctx.obj === perm : true)
      && (ev.who === 'you' ? ctx.player === perm.controller : true),
  },

  targetKinds: {
    /**
     * "target permanent you own but don't control" (Coveted Falcon).
     *
     * `legal.ts:targetOptionsFor` runs its own `targetable()` guard only for the kinds it knows by name; whatever a
     * family handler returns is pushed into the option list unchecked, so EVERY legality a target has to pass is this
     * handler's own job: shroud (CR 702.18b), hexproof from anyone but its controller (CR 702.11b), protection from
     * the source (CR 702.16b) and the spec's own `filter` (CR 115.4 - an illegal target may not be chosen). The kind
     * already fixes the controller relation ("you own but don't control"), so `controller: 'you'` on the spec is a
     * contradiction and offers nothing; `controller: 'opponent'` is what the kind already means.
     */
    'permanent-you-own-not-control': (g, controller, source, spec): TargetRef[] => {
      const s = g.state;
      if (spec.controller === 'you') return [];
      const out: TargetRef[] = [];
      for (const o of chars.allPermanents(s)) {
        if (o.owner !== controller || o.controller === controller || o.zone !== 'battlefield') continue;
        if (chars.hasKeyword(s, o, 'shroud')) continue;
        if (chars.hasKeyword(s, o, 'hexproof')) continue;                         // the chooser is never its controller here
        if (chars.protectedFrom(s, o, source)) continue;
        if (spec.filter && !chars.matchesFilter(s, o, spec.filter, source)) continue;
        out.push({ kind: 'object', id: o.id });
      }
      return out;
    },
  },

  steps: {
    // CR 514.2: "until end of turn" effects end during the cleanup step. `your-next-turn` ends at the cleanup of a
    // LATER turn of the player who gained control, so a theft on your own turn survives that turn (CR 611.2).
    cleanup: (g, ap) => {
      for (const { o, es } of stolen(g.state)) for (const e of es) {
        if (e.until === 'eot') endControl(g, o, e, 'until end of turn');
        else if (e.until === 'your-next-turn' && ap === e.by && g.state.turn > e.turn) endControl(g, o, e, 'until the end of your next turn');
      }
    },
    // CR 511.3: "until end of combat" effects end as the combat phase ends.
    'combat-end': (g) => { for (const { o, es } of stolen(g.state)) for (const e of es) if (e.until === 'end-of-combat') endControl(g, o, e, 'until end of combat'); },
  },

  // CR 611.2b: a "for as long as" duration ends the moment its condition stops holding. Control is a field on the
  // object rather than a continuous effect, so this loop — which runs after every action and every resolution — is
  // where that is noticed. Returning true makes checkSBA run again, and the entry is gone, so it cannot loop.
  sba: (g) => {
    let changed = false;
    for (const { o, es } of stolen(g.state)) for (const e of es) if (isWhile(e.until) && !whileHolds(g.state, o, e)) { endControl(g, o, e, e.until); changed = true; }
    return changed;
  },

  // CR 400.7: a permanent that left the battlefield is a new object — moveTo already handed it back to its owner.
  leave: (_g, o) => extDel(o, EXT),
  /** The core `gain-control ... until end of turn` (Act of Treason) recorded as one more entry of the stack, so it interleaves with the "for as long as" durations (CR 613.7; 9.1x item 13). */
  controlUntilEot: (g, o, to, src) => { steal(g, o, to, 'eot', src); return true; },

  render: {
    'control-gain': (e: ControlGainEffect) => {
      const dur = e.duration === undefined || e.duration === 'permanent' ? ''
        : e.duration === 'eot' ? ' until end of turn'
          : e.duration === 'end-of-combat' ? ' until end of combat'
            : e.duration === 'your-next-turn' ? ' until the end of your next turn'
              : e.duration === 'while-source-on-battlefield' ? ' for as long as ~ remains on the battlefield'
                : e.duration === 'while-you-control-source' ? ' for as long as you control ~'
                  : e.duration === 'while-source-tapped' ? ' for as long as ~ remains tapped'
                    : e.duration === 'while-you-control-source-and-tapped' ? ' for as long as you control ~ and ~ remains tapped'
                      : ` for as long as it has a ${e.counter ?? ''} counter on it`;
      const who = e.who === undefined || e.who === 'you' ? 'gain control of'
        : e.who === 'leader' ? `the player with the ${e.leader?.extreme === 'least' ? 'lowest' : 'most'} ${e.leader?.of === 'cards-in-hand' ? 'cards in hand' : e.leader?.of === 'permanents' ? 'permanents' : 'life'} gains control of`
          : `${e.who.replace(/-/g, ' ')} gains control of`;
      const what = e.target === undefined ? `all ${filterWord(e.all?.all)}${e.all?.who === 'you' ? ' you control' : ''}`
        : typeof e.target === 'string' ? refWord(e.target) : specWord(e.target);
      return `${who} ${what}${dur}${e.untap ? '. Untap it' : ''}${e.haste ? '. It gains haste until end of turn' : ''}`;
    },
    'control-return': (e: ControlReturnEffect) => `${(e.who ?? 'each-player').replace(/-/g, ' ')} gains control of all ${filterWord(e.filter)} they own`,
    'control-exchange': (e: ControlExchangeEffect) => `exchange control of ${e.self ? '~ and ' : ''}${specWord(e.target)}${e.share === 'card-type' ? ' that share a card type' : ''}`,
  },
};

// ------------------------------------------------------------------ renderer word-shop (round-trip English only)
function refWord(r: Ref): string {
  return r === 'self' ? '~' : r === 'that' ? 'that permanent' : r === 'those' ? 'those permanents' : r === 'triggering' ? 'that permanent'
    : r === 'enchanted' ? 'enchanted permanent' : r === 'equipped' ? 'equipped permanent' : 'it';
}
function filterWord(f: Filter | undefined): string {
  if (!f) return 'permanents';
  const t = f.subtypes?.[0] ?? f.types?.[0];
  return t ? `${t.toLowerCase()}s` : 'permanents';
}
function specWord(t: TargetSpec): string {
  const n = t.count === undefined || t.count === 1 ? '' : `${t.optional ? 'up to ' : ''}${t.count} `;
  const who = t.controller === 'you' ? ' you control' : t.controller === 'opponent' ? ' an opponent controls' : '';
  return `${n}target ${filterWord(t.filter).replace(/s$/, '') || String(t.kind)}${who}`.replace(/target $/, `target ${String(t.kind)}`);
}

export default CONTROL;
