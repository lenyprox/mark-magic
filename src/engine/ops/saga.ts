// Saga family (Phase 9.1; docs/vocabulary/saga.md).
//
// The engine already owns the *skeleton* of CR 714: a Saga enters with one lore counter, gains one as its
// controller's precombat main phase begins, its chapter abilities are triggered abilities `{ on: 'chapter' }`, and a
// state-based action sacrifices it once the final chapter has left the stack (game.ts:747 / :420 / :2081). What that
// skeleton cannot say is everything a card actually prints *about* the track:
//
//   * CR 714.2b — a chapter ability triggers for every number the lore total **crosses**, not only for the number it
//     lands on. "Put two lore counters on target Saga you control" on a fresh Saga triggers chapter I *and* II. The
//     core queue is one `chapter` event per counter and its matcher reads the total, so a two-counter jump would
//     silently skip a chapter. The family takes over the `chapter` dispatch (see `triggers.chapter`) and queues one
//     event per crossed number, naming the number in `TriggerCtx.amount`.
//   * CR 714.4b — **read ahead**: "As this Saga enters, choose a chapter and start with that many lore counters.
//     Skipped chapters don't trigger." An as-enters hook asks for the chapter and a counter replacement turns the
//     core's `setCounters(o, 'lore', 1)` into that many, so the core's own single `chapter` queue then matches the
//     chosen chapter and nothing below it (which is exactly "skipped chapters don't trigger").
//   * "Whenever you put a lore counter on a Saga you control" (Sigurd, Jarl of Ravensthorpe) and "Whenever the final
//     chapter ability of a Saga you control triggers / resolves" (Historian's Boon, Narci, Tom Bombadil).
//   * "target Saga you control" — a target kind the core's `CoreTargetKind` has no word for.
//   * "as long as there are four or more lore counters among Sagas you control" (Tom Bombadil).
//
// Everything else a chapter says is ordinary vocabulary: a chapter ability's body goes through `parseEffects` like
// any other triggered ability, so the composition ops (`for-each`, `scoped`, `may`, `move`, …) compose chapters with
// no help from here. The parser half of that is `src/cards/rules/saga.ts`.
//
// ext keys, all JSON-plain (clone.ts deep-copies them, view.ts never has to redact one — a chosen chapter is public
// information, CR 714.4b: the choice is made as the Saga enters, face up):
//   o.ext.sagaReadAhead  number   the chapter chosen by read ahead, consumed by the counter replacement and cleared
//                                 when the permanent leaves the battlefield.
//   o.ext.sagaReadAheadDone true   the counter replacement has already fired. Read ahead replaces the counters a Saga
//                                 ENTERS with (CR 614.1c, once), so the flag is what stops a later lore counter -
//                                 after `saga-lore {remove:true}` emptied the track, say - from being replaced again
//                                 and walking the Saga back up its own chapters.
//   o.ext.sagaLoreFrom  number    the lore total a Saga had before the counters currently being added. Written by
//                                 `replacements.counters` (the only hook that runs before `addCounters` applies a
//                                 delta) and read by `triggers.chapter` for the two core queues, which carry no
//                                 amount: the crossing is `(from, total]`, which is right whatever a counter
//                                 multiplier did to the delta in between. Swept in `sba`, after every dispatch point.
import type { CardDef, FamilyModule, GameObject, GameState, PlayerId, TargetSpec, TriggerCtx, Amount, Game, TargetRef } from './types.js';
import { extDel, extGet, extGetOr, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/**
 * "Put a lore counter on target Saga you control", "Remove a lore counter from target Saga you control",
 * "Put a lore counter on each Saga you control" (CR 714.2b for what that triggers).
 */
export interface SagaLoreEffect {
  op: 'saga-lore';
  /** Which Sagas: a target spec (normally `{ kind: 'saga' }`), or every Saga the resolving player controls. */
  target: TargetSpec | 'each-saga-you-control';
  /** How many counters (never negative — use `remove` for the other direction). */
  amount: Amount;
  /** Take the counters off instead of putting them on. Removing never triggers a chapter ability (CR 714.2b). */
  remove?: boolean;
}

/** "As long as there are four or more lore counters among Sagas you control, …" (Tom Bombadil). */
export interface SagaLoreGeCondition { kind: 'saga-lore-ge'; who: 'you' | 'opponent' | 'any'; value: number }

/** "Whenever you put a lore counter on a Saga you control, …" (Sigurd, Jarl of Ravensthorpe). */
export interface LoreCounterPutTrigger { on: 'lore-counter-put'; who: 'you' | 'any' }

/** "Whenever the final chapter ability of a Saga you control triggers / resolves, …" (Historian's Boon / Narci). */
export interface SagaFinalChapterTrigger { on: 'saga-final-chapter'; who: 'you' | 'any'; when: 'triggers' | 'resolves' }

/** Read ahead (CR 714.4b): "As this Saga enters, choose a chapter and start with that many lore counters." */
export interface ReadAheadAsEnters { kind: 'read-ahead' }

/** The core's own chapter trigger, re-declared here only so this file can type the handler that takes over its dispatch. */
interface ChapterTrigger { on: 'chapter'; chapters: number[] }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { sagaLore: SagaLoreEffect }
  interface ConditionRegistry { sagaLoreGe: SagaLoreGeCondition }
  interface TriggerRegistry { loreCounterPut: LoreCounterPutTrigger; sagaFinalChapter: SagaFinalChapterTrigger }
  interface AsEntersRegistry { readAhead: ReadAheadAsEnters }
  interface TargetKindRegistry { saga: true }
}

// ------------------------------------------------------------------ 3. helpers

/** Is this permanent a Saga? Read through `chars.subtypes` so an animated / copied / face-down permanent answers correctly. */
const isSaga = (o: GameObject): boolean => chars.subtypes(o).includes('Saga');
/** A Saga with a chapter track: `finalChapter` is set by the parser from the chapter lines it found (CR 714.2a). */
const sagaDef = (o: GameObject): CardDef | null => { const d = chars.defOf(o); return d.finalChapter && isSaga(o) ? d : null; };
/** The lore counters on a permanent (0 when it has none). */
const lore = (o: GameObject): number => o.counters.lore ?? 0;
/** Chapter numbers are printed as Roman numerals (CR 714.2a); Sagas never go past VI. */
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const roman = (n: number): string => ROMAN[n] ?? String(n);
/** Lore counters among the Sagas one player controls (CR 714.2a: counters live on the permanent). */
const loreOf = (s: GameState, p: PlayerId): number => chars.battlefieldOf(s, p).reduce((n, o) => n + (isSaga(o) ? lore(o) : 0), 0);

/**
 * Queue the chapter abilities the lore total crossed (CR 714.2b: a chapter ability triggers when the number of lore
 * counters *becomes* greater than or equal to its number, so a two-counter jump triggers two chapters). The crossed
 * number rides in `TriggerCtx.amount`, which is what `triggers.chapter` below matches on — the total on the permanent
 * is already the *final* one by then and would name only the last chapter.
 *
 * Queued **highest first**, because `putTriggersOnStack` pushes the queue onto the stack in order and a stack
 * resolves top-down: the last one pushed is the first one to resolve. Chapter I therefore resolves before chapter II,
 * which is the order the docs promise and the only one whose board is right — the token chapter II makes has to exist
 * before chapter III pumps it (CR 611.2c locks the affected set at resolution). CR 603.3b makes the order the
 * controller's choice; this is the family's default, not a rule.
 */
function queueCrossedChapters(g: Game, o: GameObject, before: number, after: number): void {
  for (let k = after; k > before; k--) g.queueTriggers('chapter', { obj: o, player: o.controller, amount: k });
}

/**
 * What an amount-less core `chapter` event (`enterBattlefield`'s `setCounters`, the precombat-main counter) crossed:
 * the lore numbers in `(from, to]`. `from` is what `replacements.counters` recorded before the delta was applied, so
 * this is exact even when a counter multiplier (Doubling Season, CR 614.1c) turned one counter into two — reading the
 * TOTAL instead, as the core matcher does, makes the chapter the jump flew past vanish.
 */
function crossed(o: GameObject): { from: number; to: number } {
  const to = lore(o);
  return { from: Math.min(extGetOr<number>(o, 'sagaLoreFrom', to - 1), to - 1), to };
}
/** Does an ability listing `chapters` trigger off a crossing? (CR 714.2b) */
const crossedAny = (chapters: number[], c: { from: number; to: number }): boolean => chapters.some(n => n > c.from && n <= c.to);

// ------------------------------------------------------------------ 4. the module

const SAGA: FamilyModule = {
  name: 'saga',

  effects: {
    // "Put a lore counter on target Saga you control." / "… on each Saga you control." / "Remove a lore counter from …"
    'saga-lore': (e: SagaLoreEffect, c) => {
      const n = c.amt(e.amount);
      if (n <= 0) return;
      const list = (e.target === 'each-saga-you-control' ? chars.battlefieldOf(c.s, c.p) : c.objs())
        .filter(o => o.zone === 'battlefield' && isSaga(o));
      for (const o of list) {
        const before = lore(o);
        c.g.addCounters(o, 'lore', e.remove ? -n : n);
        const after = lore(o);
        if (after <= before) continue;                     // a removal, or a replacement that ate the whole delta
        c.g.note(`${chars.name(o)} gets ${after - before} lore counter${after - before > 1 ? 's' : ''}.`);
        // "Whenever you put a lore counter on a Saga you control": one event per Saga, however many counters landed
        c.g.queueTriggers('lore-counter-put', { obj: o, player: c.p, amount: after - before });
        queueCrossedChapters(c.g, o, before, after);
      }
    },
  },

  conditions: {
    // "as long as there are N or more lore counters among Sagas you control"
    'saga-lore-ge': (cond: SagaLoreGeCondition, s, src) => {
      const mine = loreOf(s, src.controller);
      if (cond.who === 'you') return mine >= cond.value;
      const opps = s.players.filter(pl => pl.id !== src.controller && !pl.lost).reduce((n, pl) => Math.max(n, loreOf(s, pl.id)), 0);
      return cond.who === 'opponent' ? opps >= cond.value : Math.max(mine, opps) >= cond.value;
    },
  },

  triggers: {
    /**
     * The core's `chapter` dispatch, taken over so the family can be precise about *which* chapter a lore change
     * triggered. `ctx.amount` is the crossed chapter number when the family queued the event (`saga-lore`); the two
     * core queues (`enterBattlefield`, the precombat-main lore counter) carry no amount, and then the crossing is
     * read from `ext.sagaLoreFrom` rather than from the TOTAL. That difference is the whole point: with a counter
     * multiplier out (Doubling Season, CR 614.1c) the precombat-main counter takes a Saga from II straight to IV,
     * and a matcher reading the total finds no ability whose `chapters` contains 4 — chapter III silently never
     * triggers and CR 714.4 then sacrifices the Saga. Read ahead's skipped chapters fall out of the same range:
     * its replacement records `from = chapter - 1`, so only the chosen chapter is ever crossed (CR 714.4b).
     */
    chapter: (ev: ChapterTrigger, perm, ctx, _s, event) => {
      if (event !== 'chapter' || ctx.obj !== perm) return false;
      return ctx.amount !== undefined ? ev.chapters.includes(ctx.amount) : crossedAny(ev.chapters, crossed(perm));
    },

    /** "Whenever you put a lore counter on a Saga you control" — the family's own event, plus the two core queues. */
    'lore-counter-put': (ev: LoreCounterPutTrigger, perm, ctx, _s, event) => {
      if (event !== 'lore-counter-put' && event !== 'chapter') return false;
      // The core adds its lore counter and queues `chapter` with no amount; the family's `saga-lore` queues its own
      // event, so keying off an amount-less `chapter` here counts each core addition exactly once and never twice.
      if (event === 'chapter' && ctx.amount !== undefined) return false;
      if (!ctx.obj || !isSaga(ctx.obj)) return false;
      return ev.who === 'any' || ctx.obj.controller === perm.controller;
    },

    /**
     * "Whenever the final chapter ability of a Saga you control triggers / resolves."
     * `triggers` reads the `chapter` event directly. `resolves` is raised by the `leave` hook: CR 714.4 sacrifices
     * the Saga as a state-based action once the final chapter ability has left the stack, so a Saga on its way to
     * the graveyard with a full lore track is exactly that moment.
     */
    'saga-final-chapter': (ev: SagaFinalChapterTrigger, perm, ctx, _s, event) => {
      const want = ev.when === 'resolves' ? 'saga-final-chapter' : 'chapter';
      if (event !== want || !ctx.obj) return false;
      const d = sagaDef(ctx.obj);
      if (!d) return false;
      // "triggers": the final chapter number must be one this lore change CROSSED. With a multiplier out the total
      // can already be past it, so the total on its own is not the question (CR 714.2b).
      const final = d.finalChapter!;
      if (ev.when === 'triggers' && !(ctx.amount !== undefined ? ctx.amount === final : crossedAny([final], crossed(ctx.obj)))) return false;
      return ev.who === 'any' || ctx.obj.controller === perm.controller;
    },
  },

  asEnters: {
    /**
     * Read ahead (CR 714.4b). The chapter is chosen as the Saga enters; the counters themselves are put on by the
     * core a few lines later (`enterBattlefield`'s `setCounters(o, 'lore', 1)`), which `replacements.counters`
     * turns into the chosen number. Choosing here rather than there is what makes the choice a real decision: a
     * counter replacement is synchronous and could not ask anybody.
     */
    'read-ahead': async (_a: ReadAheadAsEnters, o, ctx, g) => {
      const final = chars.defOf(o).finalChapter ?? 1;
      if (final <= 1) return;
      const pick = ctx.sync ? 1 : await g.ask(ctx.controller, { kind: 'choose-number', min: 1, max: final, reason: `${chars.defOf(o).name}: read ahead — choose a chapter` });
      const n = typeof pick === 'number' && Number.isInteger(pick) && pick >= 1 && pick <= final ? pick : 1;
      extSet(o, 'sagaReadAhead', n);
      if (n > 1) g.note(`${chars.defOf(o).name}: read ahead — chapter ${roman(n)} is chosen; the chapters below it are skipped.`);
    },
  },

  replacements: {
    /**
     * Two jobs, and this hook is the only place either can be done: it is the one moment a family is handed a counter
     * change *before* `addCounters` applies it.
     *
     *  1. Read ahead's "start with that many lore counters" (CR 614.1c — a replacement of the counters the Saga
     *     ENTERS with, which happens exactly once). `sagaReadAheadDone` is what makes it once: `lore(o) === 0` is not
     *     a one-shot guard, because this same family prints `saga-lore {remove: true}` (Clash of the Eikons), and
     *     emptying the track would otherwise make the *next* single lore counter be replaced by the chosen chapter all
     *     over again — the Saga would jump back up its own track and re-run a chapter it had already run.
     *  2. Record the lore total the Saga had before this delta, for `triggers.chapter`: it is how the two amount-less
     *     core queues learn what they crossed (see `crossed()`). Only the first record of a run is kept, so several
     *     adds before the next dispatch still describe one range, and `sba` below sweeps it.
     */
    counters: (g, o, counter, delta) => {
      if (counter !== 'lore' || delta <= 0 || !isSaga(o) || o.zone !== 'battlefield') return delta;
      let n = delta;
      let readAhead = false;
      if (delta === 1 && lore(o) === 0 && extGet<boolean>(o, 'sagaReadAheadDone') === undefined) {
        const chapter = extGet<number>(o, 'sagaReadAhead');
        if (chapter !== undefined) { extSet(o, 'sagaReadAheadDone', true); if (chapter > 1) { n = chapter; readAhead = true; } }
      }
      // a read-ahead start crosses only the chapter that was chosen, never the ones below it (CR 714.4b)
      if (extGet<number>(o, 'sagaLoreFrom') === undefined) { extSet(o, 'sagaLoreFrom', readAhead ? n - 1 : lore(o)); extSet(g.state, 'sagaLoreMarks', true); }
      return n;
    },
  },

  /**
   * Not a state-based action: the sweep that ends a lore-counter run. `checkSBA` runs before every trigger dispatch
   * and before every priority round, so by the time this sees a `sagaLoreFrom` the `chapter` event that counter
   * raised has already been matched against it; clearing it here is what stops the *next* add from reusing a stale
   * range. Returns false — nothing an SBA loop has to re-check has changed. The state-level flag keeps it O(1) on
   * every board where no lore counter moved, which is almost all of them.
   */
  sba: (g) => {
    if (extGet<boolean>(g.state, 'sagaLoreMarks') === undefined) return false;
    extDel(g.state, 'sagaLoreMarks');
    for (const o of chars.allPermanents(g.state)) if (extGet<number>(o, 'sagaLoreFrom') !== undefined) extDel(o, 'sagaLoreFrom');
    return false;
  },

  /**
   * CR 714.4: once the final chapter ability has left the stack the Saga is sacrificed. That is the observable
   * moment "the final chapter ability of a Saga resolves" names, so the `resolves` half of `saga-final-chapter` is
   * raised from here, while the permanent still knows its controller and its counters.
   */
  leave: (g, o, zone) => {
    const d = sagaDef(o);
    extDel(o, 'sagaReadAhead'); extDel(o, 'sagaReadAheadDone'); extDel(o, 'sagaLoreFrom');
    if (!d || zone !== 'graveyard' || lore(o) < (d.finalChapter ?? 0)) return;
    g.queueTriggers('saga-final-chapter', { obj: o, player: o.controller });
  },

  targetKinds: {
    /** "target Saga you control" / "target Saga" — the same shroud / hexproof / protection gate every core kind uses. */
    saga: (g, controller, source, spec: TargetSpec): TargetRef[] => {
      const s = g.state;
      const out: TargetRef[] = [];
      for (const o of chars.allPermanents(s)) {
        if (o.zone !== 'battlefield' || !isSaga(o)) continue;
        if (spec.controller === 'you' ? o.controller !== controller : spec.controller === 'opponent' ? o.controller === controller : false) continue;
        if (chars.hasKeyword(s, o, 'shroud')) continue;
        if (chars.hasKeyword(s, o, 'hexproof') && o.controller !== controller) continue;
        if (chars.protectedFrom(s, o, source)) continue;
        if (spec.filter && !chars.matchesFilter(s, o, spec.filter, source)) continue;
        out.push({ kind: 'object', id: o.id });
      }
      return out;
    },
  },

  render: {
    'saga-lore': (e: SagaLoreEffect) => {
      const n = typeof e.amount === 'number' ? e.amount : 'X';
      const many = n !== 1;
      const where = e.target === 'each-saga-you-control' ? 'each Saga you control' : describeSagaTarget(e.target);
      return e.remove
        ? `Remove ${n === 1 ? 'a' : n} lore counter${many ? 's' : ''} from ${where}`
        : `Put ${n === 1 ? 'a' : n} lore counter${many ? 's' : ''} on ${where}`;
    },
  },
};

/** Counting words in the spelling the cards print them ("up to one target Saga", never "up to 1"). */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
/**
 * English for a `saga-lore` target spec, in the shape the cards print it. Every shape `sagaTarget()` in
 * src/cards/rules/saga.ts can emit has a case here: `count: 99, optional: true` is "any number of" (Chong and Lily,
 * Nomads) and `count: 1, optional: true` is "up to one" — neither survives treating the count and `optional` as two
 * independent adjectives, which is what made "up to 99 target Sagas" and "up to target Sagas".
 */
function describeSagaTarget(t: TargetSpec): string {
  const ctl = t.controller === 'you' ? ' you control' : t.controller === 'opponent' ? ' an opponent controls' : '';
  if (t.optional && t.count === 99) return `any number of target Sagas${ctl}`;
  const c = t.count;
  const n = c === 'X' ? 'X' : typeof c === 'number' && c > 0 ? c : 1;
  const word = n === 'X' ? 'X' : WORDS[n] ?? String(n);
  const plural = n === 'X' || n > 1;
  if (t.optional) return `up to ${word} target Saga${plural ? 's' : ''}${ctl}`;
  return n === 1 ? `target Saga${ctl}` : `${word} target Sagas${ctl}`;
}

/** Trigger contexts are the core's; re-exported so the doc's examples and the tests can name the type. */
export type { TriggerCtx };

export default SAGA;
