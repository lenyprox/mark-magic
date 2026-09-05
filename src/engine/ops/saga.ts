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
import type { CardDef, FamilyModule, GameObject, GameState, PlayerId, TargetSpec, TriggerCtx, Amount, Game, TargetRef } from './types.js';
import { extDel, extGet, extSet } from './ext.js';
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
 * Queue the chapter abilities the lore total crossed, lowest first (CR 714.2b: a chapter ability triggers when the
 * number of lore counters *becomes* greater than or equal to its number, so a two-counter jump triggers two
 * chapters). The crossed number rides in `TriggerCtx.amount`, which is what `triggers.chapter` below matches on —
 * the total on the permanent is already the *final* one by then and would name only the last chapter.
 */
function queueCrossedChapters(g: Game, o: GameObject, before: number, after: number): void {
  for (let k = before + 1; k <= after; k++) g.queueTriggers('chapter', { obj: o, player: o.controller, amount: k });
}

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
     * core queues (`enterBattlefield`, the precombat-main lore counter) carry no amount, and then this reads the
     * total exactly as `game.ts`'s own `case 'chapter'` did — so a game with no family wording in it behaves
     * identically, and read ahead's skipped chapters fall out for free (the total is the chosen chapter, so only
     * that chapter's ability matches).
     */
    chapter: (ev: ChapterTrigger, perm, ctx, _s, event) =>
      event === 'chapter' && ctx.obj === perm && ev.chapters.includes(ctx.amount ?? lore(perm)),

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
      if (ev.when === 'triggers' && (ctx.amount ?? lore(ctx.obj)) !== d.finalChapter) return false;
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
     * Read ahead's "start with that many lore counters" (CR 614, a replacement of the counters the Saga enters
     * with). Only the very first lore counter of a Saga that chose a chapter is replaced: after it the total is at
     * least the chosen chapter, so the guard can never fire twice and no bookkeeping flag is needed.
     */
    counters: (_g, o, counter, delta) => {
      if (counter !== 'lore' || delta !== 1 || lore(o) !== 0) return delta;
      const n = extGet<number>(o, 'sagaReadAhead');
      return n === undefined || n <= 1 ? delta : n;
    },
  },

  /**
   * CR 714.4: once the final chapter ability has left the stack the Saga is sacrificed. That is the observable
   * moment "the final chapter ability of a Saga resolves" names, so the `resolves` half of `saga-final-chapter` is
   * raised from here, while the permanent still knows its controller and its counters.
   */
  leave: (g, o, zone) => {
    const d = sagaDef(o);
    extDel(o, 'sagaReadAhead');
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

/** English for a `saga-lore` target spec, in the shape the cards print it ("target Saga you control"). */
function describeSagaTarget(t: TargetSpec): string {
  const n = t.count === 'X' ? 'X ' : typeof t.count === 'number' && t.count > 1 ? `${t.count} ` : '';
  const up = t.optional ? 'up to ' : '';
  const ctl = t.controller === 'you' ? ' you control' : t.controller === 'opponent' ? ' an opponent controls' : '';
  return `${up}${n}target Saga${n || up ? 's' : ''}${ctl}`;
}

/** Trigger contexts are the core's; re-exported so the doc's examples and the tests can name the type. */
export type { TriggerCtx };

export default SAGA;
