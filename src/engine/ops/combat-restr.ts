// combat-restr — combat restrictions and requirements (Phase 9.1).
//
// The rules this family speaks for (CR 506.4, 508.1, 509.1a-d, 510.1a):
//
//   * REQUIREMENTS — "~ must be blocked if able", "All creatures able to block ~ do so" (lure), "Target creature
//     blocks this turn if able". CR 509.1c: the defending player's declaration must satisfy the maximum possible
//     number of requirements without violating a restriction.
//   * RESTRICTIONS — "~ can't be blocked except by three or more creatures" (menace N, CR 509.1b), "~ can't be
//     blocked except by black creatures", "Creatures with power less than ~'s power can't block it", "~ can't block
//     creatures with power 3 or greater", "Enchanted creature can block only creatures with flying", "~ can't attack
//     or block alone", "Creatures without flying can't block this turn".
//   * DAMAGE — "You may have ~ assign its combat damage as though it weren't blocked" (CR 510.1a).
//   * PHASES — "After this phase, there is an additional combat phase" (CR 505.1, 506.1).
//
// Where each of those lands in the hook table (docs/vocabulary/README.md):
//
//   restriction decidable from the pair (blocker, attacker)           → `keywordHooks.canBlock`  (false forbids)
//   restriction only a whole declaration can judge (N-or-more, alone) → `keywordHooks.blockFixup`
//   requirement (must be blocked, lure, blocks if able)               → `keywordHooks.blockFixup`
//   "can't attack alone" where no other creature COULD attack         → `keywordHooks.canAttack`
//   "assign damage as though unblocked"                              → `keywordHooks.combatDamage`
//   an additional combat phase                                       → `s.ext.extraCombats` (README, "three mechanics are state")
//
// Two performance disciplines, because `canBlock` runs once per (blocker, attacker) pair of every simulated combat:
//   1. every static this family registers also folds a boolean into `Mods.flags`, and the pair hooks test that
//      memoised flag before they scan the battlefield for the static that set it;
//   2. the one-shot "this turn" markers live in `ext` bags whose absence is one property load (see ./ext.ts).
import type { Effect, FamilyModule, Filter, GameObject, GameState, Json, PlayerId, TargetSpec } from './types.js';
import type { Ref, StaticEffect } from '../../cards/types.js';
import { extBump, extDel, extGet, extSet, type ExtHost } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/** Which creatures a combat static speaks about. `filter` needs `scope: 'filter'`; `side` narrows it by controller. */
export type RestrScope = 'self' | 'enchanted' | 'equipped' | 'filter';
/** Whose creatures a `scope: 'filter'` static reaches, relative to the permanent that carries it. */
export type RestrSide = 'you' | 'opponents' | 'all';

/** The scope fields every static below shares, so `appliesTo` is written once. */
interface ScopedStatic { scope: RestrScope; filter?: Filter; side?: RestrSide }

/** CR 509.1c requirement: something must block it — one creature, or (`all`) every creature that can. */
export interface MustBeBlockedStatic extends ScopedStatic { kind: 'must-be-blocked'; all?: boolean }
/** CR 509.1b restriction on who may block it: a filter, a count (menace N) and/or a power comparison with the attacker. */
export interface BlockedExceptStatic extends ScopedStatic { kind: 'cant-be-blocked-except-by'; by?: Filter; least?: number; power?: 'ge-source' }
/** CR 509.1b, the complementary form: "~ can't be blocked by Walls" — the listed creatures may NOT block it. */
export interface BlockedByStatic extends ScopedStatic { kind: 'cant-be-blocked-by'; by: Filter }
/** CR 509.1b restriction on what it may block: a forbidden set, an only-set, or a power comparison with itself. */
export interface CantBlockStatic extends ScopedStatic { kind: 'cant-block-creatures'; what?: Filter; only?: Filter; power?: 'gt-self' }
/** CR 506.4 / 509.1b: "~ can't attack alone" / "~ can't block alone" / "~ can't attack or block alone". */
export interface CantActAloneStatic extends ScopedStatic { kind: 'cant-act-alone'; attack?: boolean; block?: boolean }
/** CR 510.1a: its combat damage is assigned as though it weren't blocked. */
export interface UnblockedDamageStatic extends ScopedStatic { kind: 'damage-as-though-unblocked' }

/** "Creatures (without flying / your opponents control) can't block this turn." (CR 509.1b, until end of turn) */
export interface RestrictBlockingEffect { op: 'restrict-blocking'; whose: 'all' | 'you' | 'opponents'; filter?: Filter; duration: 'eot' }
/** "Target creature can't block ~ this turn." — a restriction about one named attacker (`attacker`, default the source). */
export interface CantBlockSourceEffect { op: 'cant-block-source'; target: TargetSpec | Ref; duration: 'eot' }
/** "Target creature blocks this turn if able." (CR 509.1c requirement on the blocker) */
export interface BlocksIfAbleEffect { op: 'blocks-if-able'; target: TargetSpec | Ref; duration: 'eot' }
/** "All creatures able to block target creature this turn do so." (CR 509.1c requirement, lure) */
export interface LureEffect { op: 'lure'; target: TargetSpec | Ref; duration: 'eot' }
/** "After this phase, there is an additional combat phase." (CR 505.1 / 506.1; each extra combat is followed by an extra main phase) */
export interface ExtraCombatEffect { op: 'extra-combat' }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface StaticRegistry {
    mustBeBlocked: MustBeBlockedStatic;
    cantBeBlockedExceptBy: BlockedExceptStatic;
    cantBeBlockedBy: BlockedByStatic;
    cantBlockCreatures: CantBlockStatic;
    cantActAlone: CantActAloneStatic;
    damageAsThoughUnblocked: UnblockedDamageStatic;
  }
  interface EffectRegistry {
    restrictBlocking: RestrictBlockingEffect;
    cantBlockSource: CantBlockSourceEffect;
    blocksIfAble: BlocksIfAbleEffect;
    lure: LureEffect;
    extraCombat: ExtraCombatEffect;
  }
}

// ------------------------------------------------------------------ 3. shared helpers

/** The `Mods.flags` keys this family sets; the pair hooks read them instead of scanning the battlefield. */
const F = {
  mustBeBlocked: 'crMustBeBlocked', lure: 'crLure', blockedExcept: 'crBlockedExcept',
  cantBlock: 'crCantBlockSome', noAttackAlone: 'crNoAttackAlone', noBlockAlone: 'crNoBlockAlone',
  unblockedDamage: 'crUnblockedDamage',
} as const;

/** The `ext` keys this family owns: one list on the state, three markers on a permanent. */
const E = { bans: 'crBlockBans', lure: 'crLureTurn', mustBlock: 'crMustBlockTurn', cantBlock: 'crCantBlock' } as const;

/** One "creatures … can't block this turn" ban, as stored on `s.ext`. `filter` is held as `Json` — see readExt. */
type Ban = { whose: 'all' | 'you' | 'opponents'; ctrl: PlayerId; turn: number; filter?: Json };
/** "This creature can't block those attackers this turn", as stored on the blocker's `ext`. */
type CantBlockEntry = { turn: number; ids: number[] };

// `ext` is JSON-plain by contract, but a `Filter` is an *interface*, and TypeScript gives no implicit index signature
// to one — so the record types above cannot be written through `extSet<T extends Json>` directly. These two wrappers
// are the single place that cast, so every read and write below stays readable and still goes through ext.ts.
const readExt = <T>(host: ExtHost, key: string): T | undefined => extGet<Json>(host, key) as unknown as T | undefined;
const writeExt = <T>(host: ExtHost, key: string, v: T): void => { extSet<Json>(host, key, v as unknown as Json); };

/** Does the static `e` on `src` speak about `o`? (CR 613: one continuous effect, one affected set.) */
function appliesTo(e: ScopedStatic, src: GameObject, o: GameObject, s: GameState): boolean {
  switch (e.scope) {
    case 'self': return src.id === o.id;
    case 'enchanted': case 'equipped': return src.attachedTo === o.id;
    case 'filter': {
      const side = e.side ?? 'all';
      if (side === 'you' && o.controller !== src.controller) return false;
      if (side === 'opponents' && o.controller === src.controller) return false;
      return chars.isCreature(o) && chars.matchesFilter(s, o, e.filter, src);
    }
    default: return false;
  }
}

/**
 * Every static of `kind` that applies to `o`. Guarded by the caller on the memoised `Mods.flags` entry that same
 * static folds in, so this battlefield scan only runs when something really is there.
 */
function staticsOn<T extends ScopedStatic>(s: GameState, o: GameObject, kind: string): T[] {
  const out: T[] = [];
  for (const src of chars.allPermanents(s)) {
    for (const ab of chars.abilitiesOf(src)) {
      if (ab.kind !== 'static') continue;
      const e = ab.effect as StaticEffect & { kind: string };
      if (e.kind !== kind) continue;
      const sc = e as unknown as T;
      if (appliesTo(sc, src, o, s)) out.push(sc);
    }
  }
  return out;
}

/** `Mods.flags[key]` for `o` — one memoised static pass (characteristics.ts caches it per battlefield generation). */
const flag = (s: GameState, o: GameObject, key: string): boolean => chars.flags(s, o)[key] === true;

/** The blanket "creatures can't block this turn" bans in force right now (empty when nothing set one). */
function bansOf(s: GameState): Ban[] {
  const list = readExt<Ban[]>(s, E.bans);
  return list === undefined ? [] : list.filter(b => b.turn === s.turn);
}

/**
 * CR 509.1b: how many creatures must block `a` at once for the block to be legal; 0 = no such restriction.
 *
 * Both sources count, and the larger wins: the CORE `menace` keyword (CR 702.110b, "can't be blocked except by two
 * or more creatures", which `Game.applyBlockFixups` enforces *before* this family's hook runs and therefore never
 * re-checks afterwards) and this family's own `cant-be-blocked-except-by` statics with a `least`. Every requirement
 * pass below asks this before it forces a block, because CR 509.1c never meets a requirement by violating a
 * restriction — a lone blocker on a menace attacker is an illegal declaration, not a forced one.
 */
function leastBlockers(s: GameState, a: GameObject): number {
  let n = chars.hasKeyword(s, a, 'menace') ? 2 : 0;
  if (flag(s, a, F.blockedExcept)) for (const e of staticsOn<BlockedExceptStatic>(s, a, 'cant-be-blocked-except-by')) if (e.least !== undefined && e.least > n) n = e.least;
  return n;
}

/** How many additional creatures `b` may block beyond the first (CR 509.1b; the core's `extra-blocks` static). */
function extraBlocks(b: GameObject): number {
  let n = 0;
  for (const ab of chars.abilitiesOf(b)) if (ab.kind === 'static' && ab.effect.kind === 'extra-blocks') n += ab.effect.amount;
  return n;
}

/**
 * May `b` be added to `a`'s blockers right now? The same clauses `Game.blockLegal` applies (CR 509.1a-b) — a family
 * hook cannot call that private method, and a forced block the rules step would have refused is worse than none.
 */
function canAdd(s: GameState, b: GameObject, a: GameObject, moving = false): boolean {
  if (b.zone !== 'battlefield' || a.zone !== 'battlefield') return false;
  if (a.attacking === null || a.attacking !== b.controller) return false;
  if (!chars.isCreature(b) || b.tapped) return false;
  if (b.blocking.includes(a.id)) return false;
  // `moving` asks the counterfactual "could it block `a` if it gave up what it is blocking now?" — the requirement
  // passes need that to count able blockers before they force anything (CR 509.1c), and `attach` performs the move.
  if (!moving && b.blocking.length > extraBlocks(b)) return false;
  if (a.blockedBy.length >= 1 && chars.abilitiesOf(a).some(ab => ab.kind === 'static' && ab.effect.kind === 'cant-be-blocked-by-more-than-one')) return false;
  return chars.canBlock(s, b, a);
}

/** Record one block, both sides, with a log line a scenario can assert on. */
function addBlock(g: { note(t: string): unknown }, b: GameObject, a: GameObject, why: string): void {
  b.blocking.push(a.id); a.blockedBy.push(b.id);
  g.note(`${chars.name(b)} blocks ${chars.name(a)} (${why}).`);
}

/** Take `b` out of every block it is in (both sides of the link). */
function detach(s: GameState, b: GameObject): void {
  for (const id of b.blocking) { const a = chars.findObject(s, id); if (a) a.blockedBy = a.blockedBy.filter(x => x !== b.id); }
  b.blocking = [];
}

/**
 * Put `b` onto `a`'s blockers, giving up the blocks it has to give up first, and report whether it worked. A block
 * this family requires is worth strictly more than a block nothing requires (CR 509.1c: the declaration must meet
 * the maximum possible number of requirements), so the move is the correct reading — but only when it succeeds:
 * a failed attempt puts every abandoned block back exactly as it was.
 */
function attach(g: { note(t: string): unknown }, s: GameState, b: GameObject, a: GameObject, why: string): boolean {
  if (canAdd(s, b, a)) { addBlock(g, b, a, why); return true; }
  if (!b.blocking.length) return false;
  const was = [...b.blocking];
  detach(s, b);
  if (canAdd(s, b, a)) { addBlock(g, b, a, why); return true; }
  for (const id of was) { const at = chars.findObject(s, id); if (at) { b.blocking.push(id); at.blockedBy.push(b.id); } }
  return false;
}

/** What an effect op is handed, narrowed to the fields the target resolvers need. */
interface TargetCtx { s: GameState; item: unknown; p: PlayerId; src: GameObject; objs(): GameObject[] }

/** The objects a `Ref` names in this item's binding frame (refs.ts is a core value import, so it is loaded lazily). */
async function refObjects(ref: Ref, c: TargetCtx): Promise<GameObject[]> {
  const { resolveRef } = await import('../refs.js');
  return resolveRef({ s: c.s, item: c.item as never, p: c.p, src: c.src }, ref);
}

/** An effect's `target`: this effect's chosen targets, `self`, or a bound Ref. */
async function targetObjects(t: TargetSpec | Ref, c: TargetCtx): Promise<GameObject[]> {
  if (typeof t === 'string') return refObjects(t, c);
  return (t.self ? [c.src] : c.objs()).filter(o => o.zone === 'battlefield');
}

// ------------------------------------------------------------------ 4. the module

const COMBAT_RESTR: FamilyModule = {
  name: 'combat-restr',

  // --------------------------------------------------------------- statics
  // Each folds one boolean into `Mods.flags` for the object it speaks about. That is what makes the pair hooks cheap:
  // `flags(s, o)` is memoised per battlefield generation, the battlefield scan below it is not.
  statics: {
    'must-be-blocked': (e: MustBeBlockedStatic, src, o, s, m) => {
      if (!appliesTo(e, src, o, s)) return;
      m.flags[F.mustBeBlocked] = true;
      if (e.all) m.flags[F.lure] = true;
    },
    'cant-be-blocked-except-by': (e: BlockedExceptStatic, src, o, s, m) => { if (appliesTo(e, src, o, s)) m.flags[F.blockedExcept] = true; },
    'cant-be-blocked-by': (e: BlockedByStatic, src, o, s, m) => { if (appliesTo(e, src, o, s)) m.flags[F.blockedExcept] = true; },
    'cant-block-creatures': (e: CantBlockStatic, src, o, s, m) => { if (appliesTo(e, src, o, s)) m.flags[F.cantBlock] = true; },
    'cant-act-alone': (e: CantActAloneStatic, src, o, s, m) => {
      if (!appliesTo(e, src, o, s)) return;
      if (e.attack) m.flags[F.noAttackAlone] = true;
      if (e.block) m.flags[F.noBlockAlone] = true;
    },
    'damage-as-though-unblocked': (e: UnblockedDamageStatic, src, o, s, m) => { if (appliesTo(e, src, o, s)) m.flags[F.unblockedDamage] = true; },
  },

  // --------------------------------------------------------------- effects
  effects: {
    // "Creatures without flying can't block this turn." — a blanket restriction, so it is recorded once on the game
    // state rather than per creature: a creature that ENTERS later this turn is restricted too (the effect fixes no
    // affected set at resolution, CR 611.2c), and the filter is read fresh at block time.
    'restrict-blocking': (e: RestrictBlockingEffect, c) => {
      const list = bansOf(c.s);
      list.push({ whose: e.whose, ctrl: c.p, turn: c.s.turn, ...(e.filter ? { filter: e.filter as unknown as Json } : {}) });
      writeExt<Ban[]>(c.s, E.bans, list);
      c.g.note(`${subjectOf(e.whose, e.filter)} can't block this turn.`);
    },

    // "Target creature can't block ~ this turn." — the attacker is named by object id, so the restriction survives
    // the source leaving the battlefield (CR 509.1b is checked against the object, not against the ability).
    'cant-block-source': async (e: CantBlockSourceEffect, c) => {
      const attacker = c.src;
      for (const o of await targetObjects(e.target, c)) {
        const cur = readExt<CantBlockEntry>(o, E.cantBlock);
        const ids = cur !== undefined && cur.turn === c.s.turn ? [...cur.ids] : [];
        if (!ids.includes(attacker.id)) ids.push(attacker.id);
        writeExt<CantBlockEntry>(o, E.cantBlock, { turn: c.s.turn, ids });
        c.g.note(`${chars.name(o)} can't block ${chars.name(attacker)} this turn.`);
      }
    },

    // "Target creature blocks this turn if able." (CR 509.1c)
    'blocks-if-able': async (e: BlocksIfAbleEffect, c) => {
      for (const o of await targetObjects(e.target, c)) { extSet<number>(o, E.mustBlock, c.s.turn); c.g.note(`${chars.name(o)} blocks this turn if able.`); }
    },

    // "All creatures able to block target creature this turn do so." (CR 509.1c; Lure as a one-shot)
    lure: async (e: LureEffect, c) => {
      for (const o of await targetObjects(e.target, c)) { extSet<number>(o, E.lure, c.s.turn); c.g.note(`All creatures able to block ${chars.name(o)} do so this turn.`); }
    },

    // "After this phase, there is an additional combat phase." (CR 506.1) — the counter belongs to this turn and the
    // core clears it three times over (cleanup, turn start, elimination), so it can never cross a turn boundary.
    'extra-combat': (_e: ExtraCombatEffect, c) => {
      extBump(c.s, 'extraCombats', 1);
      c.g.note('After this phase, there is an additional combat phase.');
    },
  },

  // --------------------------------------------------------------- combat hooks
  keywordHooks: {
    /**
     * CR 506.4, the half a single creature can be judged by: a creature that can't attack alone and that is the only
     * creature its controller could possibly attack with can never attack, so the hook forbids it outright and the
     * AI is never offered the attack. The other half — a declaration that ends up with this creature alone although
     * something else could have come along — needs a hook that judges the FINISHED declaration, which the hook table
     * has no seat for: the `attackFixup` patch (core, verified but not applied here) is in `coreChangeNeeded`, and
     * section 6 of docs/vocabulary/combat-restr.md says what the family does and does not enforce until it lands.
     */
    canAttack: (s, o) => {
      if (!flag(s, o, F.noAttackAlone)) return undefined;
      for (const other of chars.battlefieldOf(s, o.controller)) {
        if (other.id === o.id || !chars.isCreature(other) || other.tapped) continue;
        // deliberately NOT chars.canAttack: that re-enters this hook for `other` and would recurse
        if (other.enteredTurn === s.turn && !chars.hasKeyword(s, other, 'haste')) continue;
        if (chars.hasKeyword(s, other, 'defender')) continue;
        const f = chars.flags(s, other);
        if (f.cantAttack === true || f.cantAttackOrBlock === true) continue;
        return undefined;                                  // somebody else could attack: the declaration may be legal
      }
      return false;
    },

    /** Every restriction decidable from the pair alone (CR 509.1b). `false` forbids, `undefined` abstains. */
    canBlock: (s, blocker, attacker) => {
      // ---- restrictions the ATTACKER carries: "can't be blocked except by …"
      if (flag(s, attacker, F.blockedExcept)) {
        for (const e of staticsOn<BlockedExceptStatic>(s, attacker, 'cant-be-blocked-except-by')) {
          if (e.by !== undefined && !chars.matchesFilter(s, blocker, e.by, attacker)) return false;
          if (e.power === 'ge-source' && chars.power(s, blocker) < chars.power(s, attacker)) return false;
        }
        for (const e of staticsOn<BlockedByStatic>(s, attacker, 'cant-be-blocked-by')) if (chars.matchesFilter(s, blocker, e.by, attacker)) return false;
      }
      // ---- restrictions the BLOCKER carries: "can't block …" / "can block only …"
      if (flag(s, blocker, F.cantBlock)) {
        for (const e of staticsOn<CantBlockStatic>(s, blocker, 'cant-block-creatures')) {
          if (e.what !== undefined && chars.matchesFilter(s, attacker, e.what, blocker)) return false;
          if (e.only !== undefined && !chars.matchesFilter(s, attacker, e.only, blocker)) return false;
          if (e.power === 'gt-self' && chars.power(s, attacker) > chars.power(s, blocker)) return false;
        }
      }
      // ---- one-shot restrictions ("… can't block this turn", "… can't block ~ this turn")
      for (const b of bansOf(s)) {
        if (b.whose === 'you' && blocker.controller !== b.ctrl) continue;
        if (b.whose === 'opponents' && blocker.controller === b.ctrl) continue;
        if (chars.matchesFilter(s, blocker, b.filter as unknown as Filter | undefined, undefined)) return false;
      }
      const cb = readExt<CantBlockEntry>(blocker, E.cantBlock);
      if (cb !== undefined && cb.turn === s.turn && cb.ids.includes(attacker.id)) return false;
      return undefined;
    },

    /**
     * The pass a declaration can only be judged as a whole by (CR 509.1c-d): requirements are met first, in the order
     * that satisfies the most of them, then the restrictions that count blockers throw out whatever is still illegal
     * (a requirement is never met by violating a restriction). Runs once per defending player, right after the core's
     * own menace pass.
     */
    blockFixup: (g, attackers, defender) => {
      const s = g.state;
      const candidates = chars.battlefieldOf(s, defender).filter(o => chars.isCreature(o) && !o.tapped);
      if (!candidates.length) return;

      // ---- requirement 1: "All creatures able to block ~ do so" (the static and the one-shot both land here).
      // A candidate that is unable only because it is already blocking something else is MOVED: blocking the lure
      // creature is a requirement and blocking anything else is not, so the move meets strictly more of them.
      // CR 509.1c: none of them moves when the attacker's own "except by N or more" restriction (menace included)
      // could not be satisfied by the creatures that are able — the requirement is then simply not met.
      for (const a of attackers) {
        if (!(flag(s, a, F.lure) || extGet<number>(a, E.lure) === s.turn)) continue;
        const able = candidates.filter(b => b.blocking.includes(a.id) || canAdd(s, b, a, true));
        if (able.length < Math.max(1, leastBlockers(s, a))) continue;
        for (const b of able) if (!b.blocking.includes(a.id)) attach(g, s, b, a, 'must block');
      }

      // ---- requirement 2: "~ must be blocked if able" — one blocker is enough, or as many as the attacker's own
      //      "except by N or more" restriction (or the core `menace` keyword) demands. A creature already blocking
      //      elsewhere is moved for exactly the reason the lure pass moves one, and for the same rule; free
      //      creatures are spent first, so a move only happens when nothing else can meet the requirement.
      for (const a of attackers) {
        if (!flag(s, a, F.mustBeBlocked) || flag(s, a, F.lure)) continue;
        const need = Math.max(1, leastBlockers(s, a));
        if (a.blockedBy.length >= need) continue;
        const pool = candidates.filter(b => !b.blocking.includes(a.id) && canAdd(s, b, a, true)).sort((x, y) => x.blocking.length - y.blocking.length);
        if (a.blockedBy.length + pool.length < need) continue;   // cannot be met without violating the restriction
        for (const b of pool) { if (a.blockedBy.length >= need) break; attach(g, s, b, a, 'must be blocked'); }
      }

      // ---- requirement 3: "Target creature blocks this turn if able" — it blocks an attacker it can legally block
      //      ALONE (one more blocker has to finish the "N or more" count, or the block is no block at all).
      for (const b of candidates) {
        if (extGet<number>(b, E.mustBlock) !== s.turn || b.blocking.length) continue;
        for (const a of attackers) {
          if (!canAdd(s, b, a)) continue;
          const need = leastBlockers(s, a);
          if (need && a.blockedBy.length + 1 < need) continue;   // menace and friends: this creature is not "able"
          addBlock(g, b, a, 'blocks if able'); break;
        }
      }

      // ---- restriction: "can't be blocked except by N or more creatures" (CR 509.1b, menace N)
      for (const a of attackers) {
        if (!a.blockedBy.length) continue;                        // cheap first: leastBlockers reads a keyword
        const need = leastBlockers(s, a);
        if (!need || a.blockedBy.length >= need) continue;
        const dropped = a.blockedBy.map(id => chars.findObject(s, id)).filter((o): o is GameObject => o !== undefined);
        a.blockedBy = [];
        for (const b of dropped) { b.blocking = b.blocking.filter(id => id !== a.id); g.note(`${chars.name(b)} can't block ${chars.name(a)} except with ${need} or more creatures.`); }
      }

      // ---- restriction: "can't block alone" (CR 509.1b) — judged over this defending player's whole declaration
      for (const b of candidates) {
        if (!b.blocking.length || !flag(s, b, F.noBlockAlone)) continue;
        if (candidates.some(x => x.id !== b.id && x.blocking.length)) continue;
        detach(s, b);
        g.note(`${chars.name(b)} can't block alone.`);
      }
    },

    /**
     * CR 510.1a: "you may have ~ assign its combat damage as though it weren't blocked". Every point the attacker was
     * about to put on its blockers goes to the player (or planeswalker) it is attacking instead. The choice is taken
     * every time: this hook is synchronous, so it cannot ask (see the doc's Declines).
     */
    combatDamage: (g, assignments) => {
      const s = g.state;
      const seen: number[] = [];
      for (const d of [...assignments]) {
        const a = d.src;
        if (seen.includes(a.id)) continue;
        seen.push(a.id);
        const target = a.attacking;
        if (target === null || !a.blockedBy.length || !flag(s, a, F.unblockedDamage)) continue;
        let total = 0;
        for (let i = assignments.length - 1; i >= 0; i--) if (assignments[i].src.id === a.id) { total += assignments[i].n; assignments.splice(i, 1); }
        if (total <= 0) continue;
        const pw = a.attackingPlaneswalker != null ? chars.findObject(s, a.attackingPlaneswalker) : undefined;
        assignments.push({ src: a, to: pw !== undefined && pw.zone === 'battlefield' ? pw : target, n: total });
        g.note(`${chars.name(a)} assigns its combat damage as though it weren't blocked.`);
      }
    },
  },

  // --------------------------------------------------------------- housekeeping
  // The per-creature "this turn" markers end with the turn (CR 514.2); the state-level bans go with them. Both are
  // stamped with the turn they were made in as well, so a mid-turn clone the AI keeps cannot spend one later.
  cleanupEot: (_g, o) => { extDel(o, E.lure); extDel(o, E.mustBlock); extDel(o, E.cantBlock); },
  steps: {
    'cleanup-end': (g) => { extDel(g.state, E.bans); },
    'turn-start': (g) => { extDel(g.state, E.bans); },
  },
  /** A permanent that leaves the battlefield is a new object (CR 400.7): its markers do not follow it. */
  leave: (_g, o) => { extDel(o, E.lure); extDel(o, E.mustBlock); extDel(o, E.cantBlock); },

  // --------------------------------------------------------------- round-trip English (scripts:verify)
  // Keyed by op for the effects (src/cards/render.ts consults RENDERERS from its `default:` branch) and by kind for
  // the statics, which `renderStatic` cannot reach yet — see `coreChangeNeeded` in the report.
  render: {
    'restrict-blocking': (e: RestrictBlockingEffect) => `${subjectOf(e.whose, e.filter)} can't block this turn`,
    'cant-block-source': (e: CantBlockSourceEffect) => `${refWords(e.target)} can't block ~ this turn`,
    'blocks-if-able': (e: BlocksIfAbleEffect) => `${refWords(e.target)} blocks this turn if able`,
    lure: (e: LureEffect) => `all creatures able to block ${refWords(e.target)} this turn do so`,
    'extra-combat': (_e: ExtraCombatEffect) => 'after this phase, there is an additional combat phase',
    'must-be-blocked': (e: MustBeBlockedStatic) => e.all ? `all creatures able to block ${who(e)} do so` : `${who(e)} must be blocked if able`,
    'cant-be-blocked-except-by': (e: BlockedExceptStatic) => e.least !== undefined ? `${who(e)} can't be blocked except by ${numberWord(e.least)} or more creatures`
      : e.power === 'ge-source' ? `creatures with power less than ${who(e)}'s power can't block it`
        : `${who(e)} can't be blocked except by ${filterWords(e.by)}s`,
    'cant-be-blocked-by': (e: BlockedByStatic) => `${who(e)} can't be blocked by ${filterWords(e.by)}s`,
    'cant-block-creatures': (e: CantBlockStatic) => e.only !== undefined ? `${who(e)} can block only ${filterWords(e.only)}s`
      : e.power === 'gt-self' ? `${who(e)} can't block creatures with power greater than ${who(e)}'s power`
        : `${who(e)} can't block ${filterWords(e.what)}s`,
    'cant-act-alone': (e: CantActAloneStatic) => `${who(e)} can't ${e.attack && e.block ? 'attack or block' : e.block ? 'block' : 'attack'} alone`,
    'damage-as-though-unblocked': (e: UnblockedDamageStatic) => `you may have ${who(e)} assign its combat damage as though it weren't blocked`,
  },
};

export default COMBAT_RESTR;

// ------------------------------------------------------------------ 5. renderer vocabulary
// Deliberately tiny: the round-trip scorer needs the oracle's own words for the shapes this family emits, and the
// full filter renderer lives in src/cards/render.ts, which a family may not import (it imports the barrel).

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/** What a static's scope reads as in the oracle's own phrasing. */
function who(e: ScopedStatic): string {
  if (e.scope === 'self') return '~';
  if (e.scope === 'enchanted') return 'enchanted creature';
  if (e.scope === 'equipped') return 'equipped creature';
  const side = e.side === 'you' ? ' you control' : e.side === 'opponents' ? ' your opponents control' : '';
  return `${filterWords(e.filter)}s${side}`;
}

/** A `restrict-blocking` subject: "creatures", "creatures you control", "creatures without flying". */
function subjectOf(whose: 'all' | 'you' | 'opponents', f: Filter | undefined): string {
  const side = whose === 'you' ? ' you control' : whose === 'opponents' ? ' your opponents control' : '';
  return `${filterWords(f)}s${side}`;
}

const COLOUR_WORDS: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

/** The words an oracle line uses for a filter this family emits. */
function filterWords(f: Filter | undefined): string {
  if (!f) return 'creature';
  const head: string[] = [];
  if (f.colors?.length) head.push(f.colors.map(c => COLOUR_WORDS[c] ?? c).join(' and '));
  if (f.notColors?.length) head.push(f.notColors.map(c => `non${COLOUR_WORDS[c] ?? c}`).join(' '));
  if (f.subtypes?.length) head.push(f.subtypes.join(' '));
  head.push('creature');
  const tail: string[] = [];
  if (f.withKeyword) tail.push(`with ${f.withKeyword}`);
  if (f.notKeywords?.length) tail.push(`without ${f.notKeywords.join(' or ')}`);
  if (f.powerGE !== undefined) tail.push(`with power ${f.powerGE} or greater`);
  if (f.powerLE !== undefined) tail.push(`with power ${f.powerLE} or less`);
  return [head.join(' '), ...tail].join(' ');
}

/** A target slot as the oracle prints it ("target creature", "that creature"). */
function refWords(t: TargetSpec | Ref): string {
  if (typeof t === 'string') return t === 'self' ? '~' : t === 'those' ? 'those creatures' : 'that creature';
  return `${t.optional ? 'up to one ' : ''}target ${t.controller === 'opponent' ? 'creature an opponent controls' : 'creature'}`;
}

/** Type-only anchor: the new ops must stay assignable to `Effect`, so a mistyped op is a compile error here. */
const TYPE_ANCHOR: Effect[] = [
  { op: 'restrict-blocking', whose: 'all', duration: 'eot' },
  { op: 'cant-block-source', target: { kind: 'creature' }, duration: 'eot' },
  { op: 'blocks-if-able', target: { kind: 'creature' }, duration: 'eot' },
  { op: 'lure', target: { kind: 'creature' }, duration: 'eot' },
  { op: 'extra-combat' },
];
void TYPE_ANCHOR;
