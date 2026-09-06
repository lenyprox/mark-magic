// The `transform` mechanic family (Phase 9.1): transform / flip triggers, day-night (CR 731), daybound / nightbound
// (CR 702.145), "turn it face up" outside the morph cost, "if it entered from your graveyard", descend (CR 207.2c /
// 110.4a) and the prepare keyword action's `prepared` state (CR 722.3). docs/vocabulary/transform.md is the
// reference; this file is the behaviour. Every `cr:` string here was checked against data/rules/cr.json (the repo's
// own Comprehensive Rules dump, version August 7, 2026) — 701.28 is *Convert*, 726 is *The Initiative*, 702.146 is
// *Disturb* and 701.51 is *Open an Attraction*, so none of those is this family's rule.
//
// The core already flips a double-faced permanent (`transform-self`, game.ts:applyEffect) but nothing ever *observes*
// the flip: no event is queued, so "Whenever this transforms into …" can never fire. This family observes it twice
// over. Every flip it performs itself — its own op, and the automatic daybound / nightbound flips — queues the
// `transforms` event from `flip` below, at the instant the face changes, because CR 603.2 makes the ability trigger
// on the EVENT and a transformation that kills the permanent (a werewolf shrinking back at dawn) must still be seen.
// A flip the family cannot reach — the core `transform-self` op — is caught by an `sba` hook that compares each
// double-faced permanent's `activeFace` with the last face reported and queues the event when they differ. checkSBA
// runs at the top of every priority round and after every resolution (game.ts:priorityRound / resolveTop), i.e.
// exactly where triggers wait to be put on the stack (CR 603.3). The same
// hook is where CR 702.145c / 702.145f live: those two are explicitly *not* state-based actions ("this happens
// immediately"), but the SBA loop is the only continuous check the engine has, so they are enforced there and the
// hook returns true when it corrected a face, which makes checkSBA run its loop again.
//
// The four hard rules (docs/vocabulary/README.md) are kept: no `node:` imports, only type imports from the core at
// module scope (plus the `chars` leaf), every observable change goes through a Game primitive where one exists, and
// every `ext` value is JSON-plain. `activeFace` / `transformed` have no Game primitive — this family is the one that
// owns them — so they are written here, always paired with the core `transform` event so the stream stays complete.
import type { CardDef, EnterCtx, FamilyModule, Filter, Game, GameObject, GameState, OpCtx, TargetRef, TargetSpec, Zone } from './types.js';
import type { Ref } from '../../cards/types.js';
import { extDel, extGet, extGetOr, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/**
 * CR 701.27a: turn a permanent to its other face. `to` forces a face (a no-op when it is already up).
 * `asItEnters` is the "return it to the battlefield transformed" clause (CR 712.14a): the subject is NOT on the
 * battlefield yet, so nothing transforms — the face it will arrive with is recorded and applied by the `zoneMove`
 * hook below, before the permanent enters. The distinction is observable: a permanent that enters transformed never
 * had its front face on the battlefield, so the front face's enters-the-battlefield abilities (and every other
 * permanent's "whenever a creature you control enters") see the BACK face, and no `transform` event is raised at all.
 */
export interface TransformEffect { op: 'transform'; target?: TargetSpec | Ref | 'self'; to?: 'front' | 'back'; untap?: boolean; asItEnters?: true }
/** CR 731.1: "it becomes day" / "it becomes night" (and the `neither` state a game starts in). */
export interface DayNightEffect { op: 'set-day-night'; to: 'day' | 'night' | 'neither' }
/** The prepare keyword action (CR 722.3a / 722.3b): "~ becomes prepared." (a marker read by `prepared`; see the doc's open issue). */
export interface PreparedEffect { op: 'become-prepared'; target?: TargetSpec | Ref | 'self'; on?: false }
/** CR 708.7: turn a face-down permanent face up without taking the morph special action (CR 702.37e). */
export interface TurnFaceUpEffect { op: 'turn-face-up'; target?: TargetSpec | Ref | 'self'; onlyIf?: 'creature-card' }

/** CR 731.1: is it day, night, or neither? */
export interface DayNightCondition { kind: 'day-night'; is: 'day' | 'night' | 'neither' }
/** The descend ability word (CR 207.2c): descend N (`permanent-cards`, CR 110.4a), descend 8 (`cards`), and "N or more permanent types among cards in your graveyard". */
export interface DescendCondition { kind: 'descend'; count: number; among: 'cards' | 'permanent-cards' | 'permanent-types' }
/** "if it entered from your graveyard" — the zone the permanent was in when it entered the battlefield (CR 400.7). */
export interface EnteredFromCondition { kind: 'entered-from'; zone: Zone; who?: 'you' | 'any' }
/** The prepare keyword action's state (CR 722.3a). */
export interface PreparedCondition { kind: 'prepared' }

/** "Whenever ~ transforms into ~" / "… enters or transforms into …" / "When equipped creature transforms" (CR 701.27e). */
export interface TransformsTrigger { on: 'transforms'; self?: boolean; into?: 'front' | 'back'; orEnters?: boolean; attached?: boolean; filter?: Filter; controller?: 'you' | 'any' | 'opponent' }
/** "Whenever day becomes night or night becomes day" (CR 731.1a). */
export interface DayNightTrigger { on: 'day-night'; to?: 'day' | 'night' }
/** "At the beginning of your first main phase" (CR 505.1: the precombat main phase). */
export interface FirstMainTrigger { on: 'first-main-phase'; whose: 'your' | 'each' }

/**
 * Daybound / nightbound (CR 702.145 — one rule, not two: 702.145b defines daybound, 702.145e nightbound). They are
 * *keywords* on the card, but they are carried here as static abilities rather than through `KeywordRegistry`: a
 * keyword a family registers is invisible to the op-coverage vocabulary (src/verify/opCoverage.ts derives the keyword
 * list from the `CoreKeyword` union alone, and every read of one would be scored as a discriminator the vocabulary
 * does not list), while a registered static is enumerated, ratcheted and covered by a scenario like every other hook.
 * Neither modifies `Mods`: `setDayNight`, `syncBound` and `flip` below are the only readers, and they look at the face
 * that is currently up — which is exactly the rule, since the front face has daybound and the back face nightbound.
 */
export interface DayboundStatic { kind: 'daybound' }
export interface NightboundStatic { kind: 'nightbound' }

/** "If it's neither day nor night, it becomes day as ~ enters." (CR 731.1) — and CR 702.145d / 702.145g / 702.145b. */
export interface DayNightAsEnters { kind: 'day-night-enters'; to: 'day' | 'night' }
/** "~ enters prepared." (CR 722.3a) */
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
/** CR 110.4a: the permanent card types, for descend and "permanent types among cards in your graveyard". */
const PERMANENT_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'] as const;
const isPermanentCard = (o: GameObject): boolean => o.def.types.some(t => (PERMANENT_TYPES as readonly string[]).includes(t));

/** `ext` keys this family owns (all JSON-plain, all on the object except `dayNight` on the state). */
const FACE_SEEN = 'transformFaceSeen';   // the activeFace the sba watcher last reported on
const CAME_FROM = 'transformCameFrom';   // the zone the permanent entered the battlefield from (CR 400.7)
const PREPARED = 'transformPrepared';    // the prepare keyword action's marker (CR 722.3a)
const ON_ENTER = 'transformOnEnter';     // the face this card will arrive with (CR 712.14a), set by `asItEnters`
const DAY_NIGHT = 'dayNight';            // 'day' | 'night' on GameState.ext; absent = neither (CR 731.1)
const PREV_AP = 'transformPrevAP';       // the previous turn's active player (CR 731.2a / 731.2b)

const dayNightOf = (s: GameState): DayNight | undefined => extGet<DayNight>(s, DAY_NIGHT);
/** The face-up card of a double-faced permanent for a given face index. */
const faceDef = (o: GameObject, face: 0 | 1): CardDef => (face === 1 && o.def.backFace ? o.def.backFace : o.def);

/** Does the face that is currently up carry daybound / nightbound? (the static marker, CR 702.145b / 702.145e) */
const bound = (o: GameObject, kind: 'daybound' | 'nightbound'): boolean =>
  chars.abilitiesOf(o).some(a => a.kind === 'static' && (a.effect as { kind: string }).kind === kind);

/**
 * Turn `o` to its other face (or to the named one). Returns whether anything moved.
 * CR 701.27a: only a permanent whose card has two faces can transform, and only on the battlefield; CR 306.5b: a
 * permanent that is now a planeswalker face carries that face's printed loyalty in counters.
 *
 * `why` enforces the last static ability of daybound and of nightbound — "This permanent can't transform except due
 * to its daybound ability" (CR 702.145b) / "… except due to its nightbound ability" (CR 702.145e). A werewolf is
 * therefore immune to a generic "transform target creature": only `setDayNight` and `syncBound` pass 'daybound'. The
 * core's own `{ op: 'transform-self' }` comes through here too since 9.1x items 16 and 19 (the module's `transform`
 * hook below), so the gate and the announcement cover it; its exile-and-return form is a new object entering, not a
 * transformation, and stays in the core.
 */
function flip(g: Game, o: GameObject, to?: 'front' | 'back', why: 'effect' | 'daybound' = 'effect'): boolean {
  if (o.zone !== 'battlefield' || o.def.backFace === undefined || o.faceDown) return false;
  const cur: 0 | 1 = o.activeFace === 1 ? 1 : 0;
  const next: 0 | 1 = to === 'front' ? 0 : to === 'back' ? 1 : cur === 1 ? 0 : 1;
  if (next === cur) return false;
  if (why !== 'daybound' && (bound(o, 'daybound') || bound(o, 'nightbound'))) return false;   // CR 702.145b / 702.145e
  o.activeFace = next;
  o.transformed = next === 1;
  g.state.bfGen = (g.state.bfGen ?? 0) + 1;          // the set of abilities on the battlefield just changed
  const d = faceDef(o, next);
  g.emit({ type: 'transform', id: o.id, name: o.def.name, into: d.name, face: next });
  if (d.types.includes('Planeswalker') && d.loyalty != null) g.setCounters(o, 'loyalty', d.loyalty);
  // CR 603.2: the ability triggers when the EVENT happens, and nothing requires the object to still be there
  // afterwards (CR 603.10a's look-back is for leaves-the-battlefield triggers only). The `sba` watcher below cannot
  // give that guarantee on its own: SBA_HOOKS run *after* the lethal-damage loop of the same `checkSBA` pass
  // (game.ts), so a permanent the transformation itself killed — every werewolf shrinks when it flips back at dawn,
  // Graveyard Glutton 4/4 → Graveyard Trespasser 3/3 — was already in the graveyard and out of `allPermanents` by
  // the time the watcher looked. So the flip announces itself here, at the instant it happens, and marks the face as
  // reported so the watcher does not raise it a second time. Since 9.1x the core `transform-self` comes through here
  // as well, so the watcher is a backstop for a face changed by some other route (none printed).
  extSet(o, FACE_SEEN, next);
  g.queueTriggers('transforms', { obj: o, player: o.controller });
  return true;
}

/**
 * CR 731.1: make it day / night / neither. A change also transforms every daybound permanent (front → back when it
 * becomes night) and every nightbound one (back → front when it becomes day) — CR 702.145b / 702.145e — and queues
 * the `day-night` trigger event. The flips themselves are picked up by the `sba` watcher below, so a "whenever this
 * transforms" trigger on a werewolf fires from the day/night change as well.
 */
function setDayNight(g: Game, to: DayNight | 'neither'): boolean {
  const s = g.state;
  const from: DayNight | 'neither' = dayNightOf(s) ?? 'neither';
  if (from === to) return false;
  if (to === 'neither') extDel(s, DAY_NIGHT); else extSet(s, DAY_NIGHT, to);
  g.emit({ type: 'day-night', from, to });
  syncBound(g);
  // CR 731.1a: "whenever day becomes night or night becomes day" is about the SWITCH. Becoming day (or night) out of
  // "neither" is not one, so those abilities do not trigger the first time a card sets the day/night cycle going.
  if (from !== 'neither' && to !== 'neither') g.queueTriggers('day-night', { player: s.activePlayer });
  return true;
}

/**
 * CR 702.145c: "Any time a player controls a permanent that is front face up with daybound and it's night, that
 * player transforms that permanent." CR 702.145f is the mirror for a nightbound permanent while it's day. Both are
 * continuous ("any time", "this happens immediately and isn't a state-based action"), so they are re-checked from the
 * `sba` hook as well as from `setDayNight` — which is what makes a daybound permanent that arrives while it is night
 * correct even when something else put it down front face up, and what undoes an illegal flip the family's own `flip`
 * gate cannot see (the core `transform-self` op). Returns whether it corrected anything.
 */
function syncBound(g: Game): boolean {
  const now = dayNightOf(g.state);
  if (now === undefined) return false;
  let changed = false;
  for (const o of chars.allPermanents(g.state)) {
    if (o.def.backFace === undefined || o.faceDown) continue;
    if (now === 'night' && o.activeFace !== 1 && bound(o, 'daybound')) changed = flip(g, o, 'back', 'daybound') || changed;
    else if (now === 'day' && o.activeFace === 1 && bound(o, 'nightbound')) changed = flip(g, o, 'front', 'daybound') || changed;
  }
  return changed;
}

/** The objects an op's `target` names: a chosen target list, or a Ref (`self`, `that`, `target:0`, `equipped`, …). */
async function subjects(target: TargetSpec | Ref | 'self' | undefined, c: OpCtx): Promise<GameObject[]> {
  const t = target ?? 'self';
  if (typeof t !== 'string') return c.objs();
  const { resolveRef } = await import('../refs.js');
  return resolveRef({ s: c.s, item: c.item, p: c.p, src: c.src }, t as Ref);
}

/** Does this value (an effect list, an intervening-if condition) hold a clause the engine cannot play? */
function hasUnknown(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasUnknown);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.op === 'unknown' || o.kind === 'unknown') return true;
    for (const k in o) if (hasUnknown(o[k])) return true;
  }
  return false;
}

/**
 * Does this value hold a clause that parsed into something the engine reads WRONG? `hasUnknown` cannot see these:
 * they are well-formed AST that no `unknown` marks, and the engine runs them to a silently incorrect outcome. Two
 * shapes, both found by a CardDB sweep of every `first-main-phase` body (the sweep declines exactly four abilities —
 * Static Prison, Electrozoa, Black Market, Altar of Shadows — and leaves the other 19 simulable ones alone):
 *
 *   * a MANA COST that costs nothing but was printed as something. `{E}` is energy (CR 118.12: an energy counter is
 *     paid from the player's pool, not from mana), and the mana-cost parser drops it: the cost lands as
 *     `{ generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{E}' }`. The engine then auto-pays a free cost
 *     and logs "pays {E}", so "sacrifice ~ unless you pay {E}" never sacrifices and "tap ~ unless you pay {E}" never
 *     taps, whatever the controller's energy. A genuinely free printed cost writes `raw` as `{0}` (or empty), which
 *     is why that spelling is excluded rather than the whole shape.
 *   * an `add-mana` carrying `perEach`. `game.ts`'s `case 'add-mana'` reads only `e.mana` / `e.amount`, never
 *     `e.perEach`, so "add {B} for each charge counter on ~" adds exactly one {B} whatever the counters say.
 *
 * Both are pre-existing CORE defects — Lathnu Hellion carries the same `{E}` cost under a core `end-step` head at
 * base, and 51 more abilities emit an unread `add-mana.perEach` — so neither can be repaired from this family; the
 * patches are in the 9.1 review's `coreChangeNeeded`. What the family CAN do is not put its own head in front of
 * them: declining here restores exactly the pre-9.1 reading (the head parsed as `{on:'unknown'}` and the ability
 * never fired), which is the family's standing discipline and the honest state until the core fix lands. See
 * docs/vocabulary/transform.md, "Open issues".
 */
function misparsed(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(misparsed);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // (9.1x items 14 and 15: `add-mana.perEach` is multiplied by the core and "{E}" is an energy cost, so neither shape is declined any more)
    for (const k in o) if (misparsed(o[k])) return true;
  }
  return false;
}

/**
 * Is the whole triggered ability whose event object is `ev` something the engine can actually play?
 *
 * Only `first-main-phase` asks. It is the one head this family adds that fires EVERY turn on EVERY permanent carrying
 * it, and the parser contract cannot gate it: `TriggerRule.make` is handed the trigger head alone, never the body, so
 * the family cannot decline the head on the 33 cards ("Ripples of Undeath", "Advanced Reconstruction", "Sab-Sunen,
 * Luxa Embodied", …) whose body still holds an `unknown` clause. Claiming the head there would put an ability on the
 * stack once a turn, forever, whose only observable effect is an `unsimulated` event — strictly worse than the
 * pre-9.1 reading, where the head parsed as `{on:'unknown'}` and the ability simply never fired. So the family's
 * discipline ("decline rather than claim what you cannot express") is applied one hop later, here: the trigger fires
 * only for an ability the engine can run end to end. That is two questions, not one — `hasUnknown` for a body the
 * parser openly gave up on (33 abilities), and `misparsed` for a body that parsed into well-formed AST the engine
 * reads WRONG (4 more: Static Prison, Electrozoa, Black Market, Altar of Shadows). 19 of the 56 abilities carrying
 * this head pass both gates; the other 37 keep exactly their pre-9.1 behaviour, which is why `npm run fidelity:check`
 * does not regress. See docs/vocabulary/transform.md, "Open issues".
 */
function bodySimulable(perm: GameObject, ev: object): boolean {
  for (const ab of chars.abilitiesOf(perm)) {
    if (ab.kind !== 'triggered') continue;
    const evs: object[] = ab.event.on === 'or' ? ab.event.events : [ab.event];
    if (!evs.includes(ev)) continue;
    return !hasUnknown(ab.effects) && !hasUnknown(ab.intervening) && !misparsed(ab.effects) && !misparsed(ab.intervening);
  }
  return true;                                        // not found: a delayed / synthesised trigger, nothing to check
}

// ------------------------------------------------------------------ 4. the module

const TRANSFORM: FamilyModule = {
  name: 'transform',

  effects: {
    // "Transform ~" / "Transform target creature you control" / "Transform ~, then untap it" (CR 701.27a), and
    // "… return it to the battlefield transformed" (CR 712.14a) when `asItEnters` is set.
    transform: async (e: TransformEffect, c) => {
      const list = await subjects(e.target, c);
      if (e.asItEnters) {                              // CR 712.14a: not a transformation — the face it will arrive with
        for (const o of list) if (o.zone !== 'battlefield') extSet(o, ON_ENTER, e.to ?? 'back');
        return;
      }
      const moved: GameObject[] = [];
      for (const o of list) {
        if (!flip(c.g, o, e.to)) continue;
        moved.push(o);
        if (e.untap) c.g.setTapped(o, false, 'effect');
      }
      if (moved.length) c.item.affected = moved.map(o => ({ id: o.id, lastKnown: { power: chars.power(c.s, o), toughness: chars.toughness(c.s, o), controller: o.controller, manaValue: chars.manaValueOf(o), zone: 'battlefield' as Zone } }));
    },

    // "It becomes day." / "It becomes night." (CR 731.1)
    'set-day-night': (e: DayNightEffect, c) => {
      if (setDayNight(c.g, e.to)) c.g.note(`It becomes ${e.to === 'neither' ? 'neither day nor night' : e.to}.`);
    },

    // "~ becomes prepared." / (with `on: false`) "unprepare it" (CR 722.3a / 722.3b)
    'become-prepared': async (e: PreparedEffect, c) => {
      for (const o of await subjects(e.target, c)) {
        if (o.zone !== 'battlefield') continue;
        if (e.on === false) { extDel(o, PREPARED); c.g.note(`${chars.name(o)} is no longer prepared.`); }
        else { extSet(o, PREPARED, true); c.g.note(`${chars.name(o)} becomes prepared.`); }
      }
    },

    // "You may turn it face up." (CR 708.7: the ability that let the permanent be face down may let its controller
    // turn it face up; CR 708.8: its copiable values revert. No morph cost is paid — that is the special action of
    // CR 702.37e, which the core's `turnFaceUp` owns.)
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
    // The descend ability word (CR 207.2c): "descend N" counts permanent CARDS (CR 110.4a); "descend 8" counts cards
    // of any kind. Neither is CR 700.11's "descended this turn", a different question the core already owns.
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
    // "X is the number of permanent cards in your graveyard" (fathomless descent) — CR 110.4a
    'permanent-cards-in-graveyard': (_a, s, ctrl) => s.players[ctrl].graveyard.filter(isPermanentCard).length,
    // "there are four or more permanent types among cards in your graveyard" — CR 110.4
    'permanent-types-in-graveyard': (_a, s, ctrl) => {
      const seen = new Set<string>();
      for (const o of s.players[ctrl].graveyard) for (const t of o.def.types) if ((PERMANENT_TYPES as readonly string[]).includes(t)) seen.add(t);
      return seen.size;
    },
  },

  triggers: {
    // Raised by the `sba` watcher below. `orEnters` also answers the core `etb` event ("Whenever ~ enters or
    // transforms into ~"), which is one triggered ability with two firing conditions (CR 603.2 / 701.27e).
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
    'first-main-phase': (ev: FirstMainTrigger, perm, ctx, _s, event) => event === 'first-main-phase'
      && (ev.whose === 'each' || ctx.player === perm.controller) && bodySimulable(perm, ev),
    // The core raises `turned-face-up` (Game.turnFaceUp) but its own switch has no case for it, so every morph /
    // megamorph / disguise "When this is turned face up" trigger is inert (test/fixtures/op-allowlist.json listed it
    // under "deadEvents"). Registering the core event name here is the fix: CR 702.37e / 708.7.
    'turned-face-up': (ev: { on: 'turned-face-up'; self: boolean }, perm, ctx, _s, event) => event === 'turned-face-up' && (ev.self ? ctx.obj === perm : ctx.player === perm.controller),
  },

  // Daybound / nightbound are markers, not modifications: they add nothing to `Mods`. `setDayNight`, `syncBound` and
  // `flip` read them off the face that is up, which is what makes a werewolf flip one way at night and back at dawn.
  statics: {
    daybound: (_e: DayboundStatic, _src, _o, _s, _m) => { /* CR 702.145b: read by setDayNight / syncBound / flip, no layer effect */ },
    nightbound: (_e: NightboundStatic, _src, _o, _s, _m) => { /* CR 702.145e */ },
  },

  asEnters: {
    /**
     * Two of daybound's three static abilities, plus the printed "If it's neither day nor night, it becomes day as ~
     * enters" line that non-keyword cards (The Celestus, Sunrise Cavalier) carry:
     *   * CR 702.145d / 702.145g / 731.1 — if it is neither day nor night, it becomes day (night for nightbound);
     *   * CR 702.145b — "If it is night and this permanent is represented by a double-faced card, it enters
     *     transformed". Entering transformed is a replacement effect (CR 614.1), not a transformation: no `transform`
     *     event is raised, no "whenever this transforms" trigger fires, and the BACK face's enters-the-battlefield
     *     abilities are the ones that trigger — which is why it has to happen here, in the as-enters pass, and not
     *     from `syncBound` a moment later.
     */
    'day-night-enters': (a: DayNightAsEnters, o: GameObject, _ctx: EnterCtx, g: Game) => {
      if (dayNightOf(g.state) === undefined) setDayNight(g, a.to);
      if (dayNightOf(g.state) === 'night' && o.def.backFace !== undefined && !o.faceDown && o.activeFace !== 1 && bound(o, 'daybound')) {
        o.activeFace = 1; o.transformed = true;
        g.state.bfGen = (g.state.bfGen ?? 0) + 1;
        g.note(`${faceDef(o, 1).name} enters transformed.`);
      }
    },
    prepared: (_a: PreparedAsEnters, o: GameObject, _ctx: EnterCtx) => { extSet(o, PREPARED, true); },
  },

  replacements: {
    // Not a replacement at all: `zoneMove` is the one hook that sees a move *before* it happens, which is the only
    // moment `o.zone` still names where the permanent is coming from. Recording it (and nothing else — `null` means
    // "no replacement") is what makes "if it entered from your graveyard" answerable. Only battlefield arrivals are
    // recorded, so the bag stays off every card in a library.
    //
    // It is also where an `asItEnters` transform is applied (CR 712.14a). Nothing has moved yet, `moveTo` clears
    // `activeFace` only for a permanent LEAVING the battlefield, and `enterBattlefield` reads the object's face for
    // the whole entry — so setting the face here is what makes the four Ojer / Aclazotz gods arrive as their back
    // face rather than enter as a creature and flip a moment later. The marker is cleared on any other destination so
    // it can never leak into a later, unrelated arrival.
    zoneMove: (_g, o, zone) => {
      if (zone === 'battlefield' && o.zone !== 'battlefield') {
        extSet(o, CAME_FROM, o.zone);
        const face = extGet<'front' | 'back'>(o, ON_ENTER);
        if (face !== undefined) {
          extDel(o, ON_ENTER);
          if (o.def.backFace !== undefined) { o.activeFace = face === 'back' ? 1 : 0; o.transformed = face === 'back'; }
        }
      } else if (zone !== 'battlefield') extDel(o, ON_ENTER);
      return null;
    },
  },

  steps: {
    // CR 731.2 / 731.2a / 731.2b, checked as the turn begins: day becomes night when the previous turn's active
    // player cast no spells; night becomes day when they cast two or more. `spellsCastLastTurn` was rotated just above
    // this hook (game.ts:runTurn), so it is exactly "during that player's own turn". CR 731.2c: neither stays neither.
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
   * The transform watcher, and the home of the two continuous daybound / nightbound checks.
   *
   * `syncBound` first (CR 702.145c / 702.145f): any front-face-up daybound permanent while it is night, or back-face-up
   * nightbound permanent while it is day, is put on the right face. Those two rules are explicitly not state-based
   * actions, but the SBA loop is the engine's only continuous check, and it runs at the top of every priority round and
   * after every resolution — so "immediately" is as close as the engine gets. Returning true when it corrected a face
   * makes checkSBA loop again, which is what a state change owes the loop.
   *
   * Then the watcher, which is now the BACKSTOP only: `flip` above announces its own transformation the instant it
   * happens (CR 603.2), and since 9.1x the core `{ op: 'transform-self' }` is handed to `flip` too (the `transform`
   * hook), so no printed route reaches here unreported. This compares each double-faced permanent's face with the
   * last one reported and raises `transforms` when they differ. A permanent seen for the first time is only recorded
   * — entering with its back face up (a disturb arrival, or the CR 702.145b / 712.14a "enters transformed"
   * replacement) is not a transformation and must raise nothing.
   */
  /** The core `transform-self` op, handed over so a werewolf refuses it (CR 702.145b / 702.145e) and a lethal flip still raises `transforms` (CR 603.2; 9.1x items 16 and 19). */
  transform: (g, o) => { flip(g, o); return true; },

  sba: (g) => {
    const s = g.state;
    const corrected = syncBound(g);
    for (const o of chars.allPermanents(s)) {
      if (o.def.backFace === undefined) continue;
      const face = o.activeFace === 1 ? 1 : 0;
      const seen = extGet<number>(o, FACE_SEEN);
      if (seen === face) continue;
      extSet(o, FACE_SEEN, face);
      if (seen !== undefined) g.queueTriggers('transforms', { obj: o, player: o.controller });
    }
    return corrected;
  },

  // Every one of this family's per-object markers is about the permanent it was (CR 400.7): a new object has none.
  leave: (_g, o, zone) => { if (zone !== 'battlefield') { extDel(o, FACE_SEEN); extDel(o, CAME_FROM); extDel(o, PREPARED); extDel(o, ON_ENTER); } },

  targetKinds: {
    /**
     * "Turn target face-down creature face up" (Ixidor, Skirk Alarmist, Expose the Culprit).
     *
     * legal.ts:targetOptionsFor applies shroud / hexproof / protection / `spec.filter` in the `targetable()` closure of
     * its own cases and hands a registry kind only the raw `spec`. That closure is not exported, so a family kind that
     * does not repeat the check offers illegal targets (CR 702.18a shroud, 702.11b hexproof, 702.16e protection,
     * 115.4 "an illegal target can't be chosen"). Everything below the `faceDown` test is that gate, reproduced
     * through `chars`. A face-down permanent has no characteristics of its own (CR 708.2), so `spec.filter` and
     * protection can only ever match what an external effect gave it — Lightning Greaves' shroud, an Aura, a granted
     * keyword — which is exactly the case that leaked.
     */
    'face-down-permanent': (g, controller, src, spec) => {
      const s = g.state; const out: TargetRef[] = [];
      for (const o of chars.allPermanents(s)) {
        if (o.faceDown !== true) continue;
        if (spec.controller === 'you' ? o.controller !== controller : spec.controller === 'opponent' ? o.controller === controller : false) continue;
        if (chars.hasKeyword(s, o, 'shroud')) continue;                                      // CR 702.18a
        if (chars.hasKeyword(s, o, 'hexproof') && o.controller !== controller) continue;     // CR 702.11b
        if (chars.protectedFrom(s, o, src)) continue;                                        // CR 702.16e
        if (spec.filter && !chars.matchesFilter(s, o, spec.filter, src)) continue;
        out.push({ kind: 'object', id: o.id });
      }
      return out;
    },
  },

  events: {
    'day-night': { logged: true, cr: '731.1', render: (ev) => { const e = ev as DayNightEvent; return e.to === 'neither' ? 'It becomes neither day nor night.' : `It becomes ${e.to}.`; } },
  },

  // Round-trip English (the templates scripts:verify diffs against the oracle line).
  render: {
    transform: (e: TransformEffect) => e.asItEnters
      ? `it returns to the battlefield${e.to === 'front' ? '' : ' transformed'}`
      : `Transform ${typeof e.target === 'string' || e.target === undefined ? '~' : 'target permanent'}${e.untap ? ', then untap it' : ''}`,
    'set-day-night': (e: DayNightEffect) => e.to === 'neither' ? 'It becomes neither day nor night' : `It becomes ${e.to}`,
    'become-prepared': (e: PreparedEffect) => e.on === false ? '~ is no longer prepared' : '~ becomes prepared',
    'turn-face-up': (e: TurnFaceUpEffect) => `${e.onlyIf === 'creature-card' ? 'If it\'s a creature card, ' : ''}turn it face up`,
  },
};

export default TRANSFORM;

/** Read-only predicates, exported for a reviewer / a future family that needs the same two questions. */
export { dayNightOf, isPermanentCard };
