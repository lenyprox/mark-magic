// The `transform` mechanic family (Phase 9.1): transform / flip triggers, day-night (CR 726), daybound / nightbound,
// "turn it face up" outside the morph cost, "if it entered from your graveyard", descend (CR 701.51) and the prepare
// keyword action's `prepared` state. docs/vocabulary/transform.md is the reference; this file is the behaviour.
//
// The core already flips a double-faced permanent (`transform-self`, game.ts:applyEffect) but nothing ever *observes*
// the flip: no event is queued, so "Whenever this transforms into …" can never fire. Rather than route every flip
// through this family's own op (a card that already parses into `transform-self` would stay silent), the family
// WATCHES: an `sba` hook compares each double-faced permanent's `activeFace` with the last face it saw and queues a
// `transforms` event when they differ. checkSBA runs at the top of every priority round and after every resolution
// (game.ts:priorityRound / resolveTop), i.e. exactly where triggers wait to be put on the stack (CR 603.3), so every
// flip is caught — the core op's, this family's op's, and the automatic daybound / nightbound flips alike.
//
// The four hard rules (docs/vocabulary/README.md) are kept: no `node:` imports, only type imports from the core at
// module scope (plus the `chars` leaf), every observable change goes through a Game primitive where one exists, and
// every `ext` value is JSON-plain. `activeFace` / `transformed` have no Game primitive — this family is the one that
// owns them — so they are written here, always paired with the core `transform` event so the stream stays complete.
import type { CardDef, EnterCtx, FamilyModule, Filter, Game, GameObject, GameState, OpCtx, TargetSpec, Zone } from './types.js';
import type { Ref } from '../../cards/types.js';
import { extDel, extGet, extGetOr, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/** CR 701.28: turn a permanent to its other face. `to` forces a face (a no-op when it is already up). */
export interface TransformEffect { op: 'transform'; target?: TargetSpec | Ref | 'self'; to?: 'front' | 'back'; untap?: boolean }
/** CR 726.2: "it becomes day" / "it becomes night" (and the `neither` state a game starts in). */
export interface DayNightEffect { op: 'set-day-night'; to: 'day' | 'night' | 'neither' }
/** The prepare keyword action: "~ becomes prepared." (a marker read by `prepared`; see the doc's open issue). */
export interface PreparedEffect { op: 'become-prepared'; target?: TargetSpec | Ref | 'self'; on?: false }
/** CR 713.2 / 701.34: turn a face-down permanent face up without paying its morph cost. */
export interface TurnFaceUpEffect { op: 'turn-face-up'; target?: TargetSpec | Ref | 'self'; onlyIf?: 'creature-card' }

/** CR 726.1: is it day, night, or neither? */
export interface DayNightCondition { kind: 'day-night'; is: 'day' | 'night' | 'neither' }
/** CR 701.51: descend N (`permanent-cards`), descend 8 (`cards`), and "N or more permanent types among cards in your graveyard". */
export interface DescendCondition { kind: 'descend'; count: number; among: 'cards' | 'permanent-cards' | 'permanent-types' }
/** "if it entered from your graveyard" — the zone the permanent was in when it entered the battlefield (CR 400.7). */
export interface EnteredFromCondition { kind: 'entered-from'; zone: Zone; who?: 'you' | 'any' }
/** The prepare keyword action's state. */
export interface PreparedCondition { kind: 'prepared' }

/** "Whenever ~ transforms into ~" / "… enters or transforms into …" / "When equipped creature transforms". */
export interface TransformsTrigger { on: 'transforms'; self?: boolean; into?: 'front' | 'back'; orEnters?: boolean; attached?: boolean; filter?: Filter; controller?: 'you' | 'any' | 'opponent' }
/** "Whenever day becomes night or night becomes day" (CR 726.2c). */
export interface DayNightTrigger { on: 'day-night'; to?: 'day' | 'night' }
/** "At the beginning of your first main phase" (CR 505.1: the precombat main phase). */
export interface FirstMainTrigger { on: 'first-main-phase'; whose: 'your' | 'each' }

/**
 * Daybound / nightbound (CR 702.145 / 702.146). They are *keywords* on the card, but they are carried here as static
 * abilities rather than through `KeywordRegistry`: a keyword a family registers is invisible to the op-coverage
 * vocabulary (src/verify/opCoverage.ts derives the keyword list from the `CoreKeyword` union alone, and every read of
 * one would be scored as a discriminator the vocabulary does not list), while a registered static is enumerated,
 * ratcheted and covered by a scenario like every other hook. Neither modifies `Mods`: the day/night switch below is
 * the only reader, and it looks at the face that is currently up — which is exactly the rule, since the front face
 * has daybound and the back face nightbound.
 */
export interface DayboundStatic { kind: 'daybound' }
export interface NightboundStatic { kind: 'nightbound' }

/** "If it's neither day nor night, it becomes day as ~ enters." (CR 726.2a) — also what daybound / nightbound do. */
export interface DayNightAsEnters { kind: 'day-night-enters'; to: 'day' | 'night' }
/** "~ enters prepared." */
export interface PreparedAsEnters { kind: 'prepared' }

/** The day/night event this family raises (the core has none). */
export interface DayNightEvent { type: 'day-night'; from: 'day' | 'night' | 'neither'; to: 'day' | 'night' | 'neither' }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { transform: TransformEffect; transformDayNight: DayNightEffect; transformPrepared: PreparedEffect; transformFaceUp: TurnFaceUpEffect }
  interface ConditionRegistry { transformDayNight: DayNightCondition; transformDescend: DescendCondition; transformEnteredFrom: EnteredFromCondition; transformPrepared: PreparedCondition }
  interface TriggerRegistry { transformTransforms: TransformsTrigger; transformDayNight: DayNightTrigger; transformFirstMain: FirstMainTrigger }
  interface StaticRegistry { transformDaybound: DayboundStatic; transformNightbound: NightboundStatic }
  interface AsEntersRegistry { transformDayNight: DayNightAsEnters; transformPrepared: PreparedAsEnters }
  interface AmountCountRegistry { 'permanent-cards-in-graveyard': true; 'permanent-types-in-graveyard': true }
  interface TargetKindRegistry { 'face-down-permanent': true }
}
declare module '../events.js' {
  interface EventRegistry { transformDayNight: DayNightEvent }
}

// ------------------------------------------------------------------ 3. shared helpers

type DayNight = 'day' | 'night';
/** CR 110.4c: the permanent card types, for descend and "permanent types among cards in your graveyard". */
const PERMANENT_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'] as const;
const isPermanentCard = (o: GameObject): boolean => o.def.types.some(t => (PERMANENT_TYPES as readonly string[]).includes(t));

/** `ext` keys this family owns (all JSON-plain, all on the object except `dayNight` on the state). */
const FACE_SEEN = 'transformFaceSeen';   // the activeFace the sba watcher last reported on
const CAME_FROM = 'transformCameFrom';   // the zone the permanent entered the battlefield from (CR 400.7)
const PREPARED = 'transformPrepared';    // the prepare keyword action's marker
const DAY_NIGHT = 'dayNight';            // 'day' | 'night' on GameState.ext; absent = neither (CR 726.1a)
const PREV_AP = 'transformPrevAP';       // the previous turn's active player (CR 726.3 / 726.4)

const dayNightOf = (s: GameState): DayNight | undefined => extGet<DayNight>(s, DAY_NIGHT);
/** The face-up card of a double-faced permanent for a given face index. */
const faceDef = (o: GameObject, face: 0 | 1): CardDef => (face === 1 && o.def.backFace ? o.def.backFace : o.def);

/**
 * Turn `o` to its other face (or to the named one). Returns whether anything moved.
 * CR 701.28b: only a permanent whose card has two faces can transform, and only on the battlefield; CR 712.4a: a
 * planeswalker that transforms into a planeswalker face gets that face's starting loyalty.
 */
function flip(g: Game, o: GameObject, to?: 'front' | 'back'): boolean {
  if (o.zone !== 'battlefield' || o.def.backFace === undefined || o.faceDown) return false;
  const cur: 0 | 1 = o.activeFace === 1 ? 1 : 0;
  const next: 0 | 1 = to === 'front' ? 0 : to === 'back' ? 1 : cur === 1 ? 0 : 1;
  if (next === cur) return false;
  o.activeFace = next;
  o.transformed = next === 1;
  g.state.bfGen = (g.state.bfGen ?? 0) + 1;          // the set of abilities on the battlefield just changed
  const d = faceDef(o, next);
  g.emit({ type: 'transform', id: o.id, name: o.def.name, into: d.name, face: next });
  if (d.types.includes('Planeswalker') && d.loyalty != null) g.setCounters(o, 'loyalty', d.loyalty);
  return true;
}

/** Does the face that is currently up carry daybound / nightbound? (the static marker, CR 702.145a / 702.146a) */
const bound = (o: GameObject, kind: 'daybound' | 'nightbound'): boolean =>
  chars.abilitiesOf(o).some(a => a.kind === 'static' && (a.effect as { kind: string }).kind === kind);

/**
 * CR 726.2: make it day / night / neither. A change also transforms every daybound permanent (front → back when it
 * becomes night) and every nightbound one (back → front when it becomes day) — CR 702.145e / 702.146d — and queues
 * the `day-night` trigger event. The flips themselves are picked up by the `sba` watcher below, so a "whenever this
 * transforms" trigger on a werewolf fires from the day/night change as well.
 */
function setDayNight(g: Game, to: DayNight | 'neither'): boolean {
  const s = g.state;
  const from: DayNight | 'neither' = dayNightOf(s) ?? 'neither';
  if (from === to) return false;
  if (to === 'neither') extDel(s, DAY_NIGHT); else extSet(s, DAY_NIGHT, to);
  g.emit({ type: 'day-night', from, to });
  if (to !== 'neither') {
    for (const o of chars.allPermanents(s)) {
      if (o.def.backFace === undefined) continue;
      if (to === 'night' && bound(o, 'daybound')) flip(g, o, 'back');
      else if (to === 'day' && bound(o, 'nightbound')) flip(g, o, 'front');
    }
  }
  // CR 726.2c: "whenever day becomes night or night becomes day" is about the SWITCH. Becoming day (or night) out of
  // "neither" is not one, so those abilities do not trigger the first time a card sets the day/night cycle going.
  if (from !== 'neither' && to !== 'neither') g.queueTriggers('day-night', { player: s.activePlayer });
  return true;
}

/** The objects an op's `target` names: a chosen target list, or a Ref (`self`, `that`, `target:0`, `equipped`, …). */
async function subjects(target: TargetSpec | Ref | 'self' | undefined, c: OpCtx): Promise<GameObject[]> {
  const t = target ?? 'self';
  if (typeof t !== 'string') return c.objs();
  const { resolveRef } = await import('../refs.js');
  return resolveRef({ s: c.s, item: c.item, p: c.p, src: c.src }, t as Ref);
}

// ------------------------------------------------------------------ 4. the module

const TRANSFORM: FamilyModule = {
  name: 'transform',

  effects: {
    // "Transform ~" / "Transform target creature you control" / "Transform ~, then untap it" (CR 701.28)
    transform: async (e: TransformEffect, c) => {
      const list = await subjects(e.target, c);
      const moved: GameObject[] = [];
      for (const o of list) {
        if (!flip(c.g, o, e.to)) continue;
        moved.push(o);
        if (e.untap) c.g.setTapped(o, false, 'effect');
      }
      if (moved.length) c.item.affected = moved.map(o => ({ id: o.id, lastKnown: { power: chars.power(c.s, o), toughness: chars.toughness(c.s, o), controller: o.controller, manaValue: chars.manaValueOf(o), zone: 'battlefield' as Zone } }));
    },

    // "It becomes day." / "It becomes night." (CR 726.2b)
    'set-day-night': (e: DayNightEffect, c) => {
      if (setDayNight(c.g, e.to)) c.g.note(`It becomes ${e.to === 'neither' ? 'neither day nor night' : e.to}.`);
    },

    // "~ becomes prepared." / (with `on: false`) "unprepare it"
    'become-prepared': async (e: PreparedEffect, c) => {
      for (const o of await subjects(e.target, c)) {
        if (o.zone !== 'battlefield') continue;
        if (e.on === false) { extDel(o, PREPARED); c.g.note(`${chars.name(o)} is no longer prepared.`); }
        else { extSet(o, PREPARED, true); c.g.note(`${chars.name(o)} becomes prepared.`); }
      }
    },

    // "You may turn it face up." (CR 713.2: turning a permanent face up is not a special action here — the effect does it)
    'turn-face-up': async (e: TurnFaceUpEffect, c) => {
      for (const o of await subjects(e.target, c)) {
        if (o.zone !== 'battlefield' || !o.faceDown) continue;
        if (e.onlyIf === 'creature-card' && !o.def.types.includes('Creature')) continue;
        delete o.faceDown;
        c.g.state.bfGen = (c.g.state.bfGen ?? 0) + 1;
        c.g.emit({ type: 'transform', id: o.id, name: o.def.name, into: o.def.name, face: 0 }, `${chars.name(o)} is turned face up.`);
        c.g.queueTriggers('turned-face-up', { obj: o, player: o.controller });
      }
    },
  },

  conditions: {
    'day-night': (cond: DayNightCondition, s) => (dayNightOf(s) ?? 'neither') === cond.is,
    // CR 701.51a: descend N counts permanent CARDS; 701.51b: descend 8 counts cards of any kind
    descend: (cond: DescendCondition, s, src) => {
      const gy = s.players[src.controller].graveyard;
      if (cond.among === 'cards') return gy.length >= cond.count;
      if (cond.among === 'permanent-cards') return gy.filter(isPermanentCard).length >= cond.count;
      const seen = new Set<string>();
      for (const o of gy) for (const t of o.def.types) if ((PERMANENT_TYPES as readonly string[]).includes(t)) seen.add(t);
      return seen.size >= cond.count;
    },
    'entered-from': (cond: EnteredFromCondition, _s, src) => extGet<Zone>(src, CAME_FROM) === cond.zone && (cond.who !== 'you' || src.owner === src.controller),
    prepared: (_cond: PreparedCondition, _s, src) => extGetOr<boolean>(src, PREPARED, false),
  },

  amounts: {
    // "X is the number of permanent cards in your graveyard" (fathomless descend)
    'permanent-cards-in-graveyard': (_a, s, ctrl) => s.players[ctrl].graveyard.filter(isPermanentCard).length,
    // "there are four or more permanent types among cards in your graveyard"
    'permanent-types-in-graveyard': (_a, s, ctrl) => {
      const seen = new Set<string>();
      for (const o of s.players[ctrl].graveyard) for (const t of o.def.types) if ((PERMANENT_TYPES as readonly string[]).includes(t)) seen.add(t);
      return seen.size;
    },
  },

  triggers: {
    // Raised by the `sba` watcher below. `orEnters` also answers the core `etb` event ("Whenever ~ enters or
    // transforms into ~"), which is one triggered ability with two firing conditions (CR 603.2).
    transforms: (ev: TransformsTrigger, perm, ctx, s, event) => {
      if (event === 'etb') return ev.orEnters === true && ctx.obj === perm;
      if (event !== 'transforms' || !ctx.obj) return false;
      if (ev.into !== undefined && (ctx.obj.activeFace === 1) !== (ev.into === 'back')) return false;
      if (ev.attached) return perm.attachedTo === ctx.obj.id;
      if (ev.self !== false && !ev.filter) return ctx.obj === perm;
      if (ev.filter && !chars.matchesFilter(s, ctx.obj, ev.filter, perm)) return false;
      return ev.controller === 'you' ? ctx.obj.controller === perm.controller : ev.controller === 'opponent' ? ctx.obj.controller !== perm.controller : true;
    },
    'day-night': (ev: DayNightTrigger, _perm, _ctx, s, event) => event === 'day-night' && (ev.to === undefined || dayNightOf(s) === ev.to),
    'first-main-phase': (ev: FirstMainTrigger, perm, ctx, _s, event) => event === 'first-main-phase' && (ev.whose === 'each' || ctx.player === perm.controller),
    // The core raises `turned-face-up` (Game.turnFaceUp) but its own switch has no case for it, so every morph /
    // megamorph / disguise "When this is turned face up" trigger is inert (test/fixtures/op-allowlist.json listed it
    // under "deadEvents"). Registering the core event name here is the fix: CR 701.34b / 707.9a.
    'turned-face-up': (ev: { on: 'turned-face-up'; self: boolean }, perm, ctx, _s, event) => event === 'turned-face-up' && (ev.self ? ctx.obj === perm : ctx.player === perm.controller),
  },

  // Daybound / nightbound are markers, not modifications: they add nothing to `Mods`. `setDayNight` reads them off the
  // face that is up, which is what makes a werewolf flip one way at night and the other way at dawn.
  statics: {
    daybound: (_e: DayboundStatic, _src, _o, _s, _m) => { /* CR 702.145a: read by setDayNight, no layer effect */ },
    nightbound: (_e: NightboundStatic, _src, _o, _s, _m) => { /* CR 702.146a */ },
  },

  asEnters: {
    // "If it's neither day nor night, it becomes day as ~ enters." (CR 726.2a / 702.145b)
    'day-night-enters': (a: DayNightAsEnters, _o, _ctx, g) => { if (dayNightOf(g.state) === undefined) setDayNight(g, a.to); },
    prepared: (_a: PreparedAsEnters, o: GameObject, _ctx: EnterCtx) => { extSet(o, PREPARED, true); },
  },

  replacements: {
    // Not a replacement at all: `zoneMove` is the one hook that sees a move *before* it happens, which is the only
    // moment `o.zone` still names where the permanent is coming from. Recording it (and nothing else — `null` means
    // "no replacement") is what makes "if it entered from your graveyard" answerable. Only battlefield arrivals are
    // recorded, so the bag stays off every card in a library.
    zoneMove: (_g, o, zone) => { if (zone === 'battlefield' && o.zone !== 'battlefield') extSet(o, CAME_FROM, o.zone); return null; },
  },

  steps: {
    // CR 726.3 / 726.4, checked as the turn begins: day becomes night when the previous turn's active player cast no
    // spells; night becomes day when they cast two or more. `spellsCastLastTurn` was rotated just above this hook
    // (game.ts:runTurn), so it is exactly "during that player's own turn".
    'turn-start': (g, ap) => {
      const s = g.state;
      const prev = extGet<number>(s, PREV_AP);
      const now = dayNightOf(s);
      if (prev !== undefined && now !== undefined && s.players[prev] !== undefined) {
        const cast = s.players[prev].spellsCastLastTurn ?? 0;
        if (now === 'day' && cast === 0) setDayNight(g, 'night');
        else if (now === 'night' && cast >= 2) setDayNight(g, 'day');
      }
      extSet(s, PREV_AP, ap);
    },
    // "At the beginning of your first main phase" (CR 505.1). Queued here rather than as a core event so the trigger
    // and the event it answers are declared by the same family (op-coverage checks the two halves agree).
    main1: (g, ap) => { g.queueTriggers('first-main-phase', { player: ap }); },
  },

  /**
   * The transform watcher. Nothing in the core announces a face change, so this compares each double-faced
   * permanent's face with the last one reported and raises `transforms` when they differ. A permanent seen for the
   * first time is only recorded (entering with its back face up — a disturb / "enters transformed" arrival — is not
   * a transformation, CR 701.28c). It never returns true: it changes no game state a state-based action must
   * re-examine, it only queues triggers.
   */
  sba: (g) => {
    const s = g.state;
    for (const o of chars.allPermanents(s)) {
      if (o.def.backFace === undefined) continue;
      const face = o.activeFace === 1 ? 1 : 0;
      const seen = extGet<number>(o, FACE_SEEN);
      if (seen === face) continue;
      extSet(o, FACE_SEEN, face);
      if (seen !== undefined) g.queueTriggers('transforms', { obj: o, player: o.controller });
    }
    return false;
  },

  // Every one of this family's per-object markers is about the permanent it was (CR 400.7): a new object has none.
  leave: (_g, o, zone) => { if (zone !== 'battlefield') { extDel(o, FACE_SEEN); extDel(o, CAME_FROM); extDel(o, PREPARED); } },

  targetKinds: {
    'face-down-permanent': (g, controller, _src, spec) => chars.allPermanents(g.state)
      .filter(o => o.faceDown === true && (spec.controller === 'you' ? o.controller === controller : spec.controller === 'opponent' ? o.controller !== controller : true))
      .map(o => ({ kind: 'object' as const, id: o.id })),
  },

  events: {
    'day-night': { logged: true, cr: '726.2', render: (ev) => { const e = ev as DayNightEvent; return e.to === 'neither' ? 'It becomes neither day nor night.' : `It becomes ${e.to}.`; } },
  },

  // Round-trip English (the templates scripts:verify diffs against the oracle line).
  render: {
    transform: (e: TransformEffect) => `Transform ${typeof e.target === 'string' || e.target === undefined ? '~' : 'target permanent'}${e.untap ? ', then untap it' : ''}`,
    'set-day-night': (e: DayNightEffect) => e.to === 'neither' ? 'It becomes neither day nor night' : `It becomes ${e.to}`,
    'become-prepared': (e: PreparedEffect) => e.on === false ? '~ is no longer prepared' : '~ becomes prepared',
    'turn-face-up': (e: TurnFaceUpEffect) => `${e.onlyIf === 'creature-card' ? 'If it\'s a creature card, ' : ''}turn it face up`,
  },
};

export default TRANSFORM;

/** Read-only predicates, exported for a reviewer / a future family that needs the same two questions. */
export { dayNightOf, isPermanentCard };
