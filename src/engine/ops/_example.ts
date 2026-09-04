// TEMPLATE — copy this file to `src/engine/ops/<family>.ts`, drop the leading underscore, delete what you do not need
// and run `npm run gen:registry`. The underscore keeps this file out of the generated barrel, so nothing here is live.
//
// It is also kept out of the main program (tsconfig.json excludes it) because `declare module` augmentations are
// global: every variant declared below would otherwise be a permanent phantom member of `Effect`, `Decision` and
// friends that no registry can ever handle. `npm run typecheck:example` compiles it on its own, so the pattern here is
// still known to compile — but your real family file, which IS in the barrel, is the only place these belong.
//
// A family is one file. It never edits src/cards/types.ts, src/engine/state.ts, src/engine/events.ts or any other core
// file: new AST shapes arrive through *declaration merging* (the `declare module` blocks below) and new behaviour
// arrives through the hooks of the `FamilyModule` default export. If you need a hook that does not exist, stop and
// report `coreChangeNeeded` with the patch you want — do not add it yourself in a worktree.
//
// ------------------------------------------------------------------ the four rules
//
// 1. NO `node:` IMPORTS. Ops are bundled into the browser's web worker. `fs`, `path`, `crypto` and friends are out.
//    zod schemas for tooling go in `<family>.schema.ts`, which the engine never imports.
//
// 2. ONLY TYPE IMPORTS FROM THE CORE AT MODULE SCOPE. The core imports the generated barrel and the barrel imports
//    this file, so a value import of `../legal.js` here would be a module-evaluation cycle. Take what you need from
//    the `Game` you are handed, or `await import(...)` it lazily *inside* a hook body:
//        const { legalActions } = await import('../legal.js');
//    Computed characteristics are the exception, and the one a synchronous hook needs: `./chars.js` is a leaf module
//    the core fills in, so `chars.power(s, o)`, `chars.keywords`, `chars.matchesFilter`, ... are available at module
//    scope with no cycle. Call them inside a hook body, never while this module is evaluating.
//
// 3. NO DIRECT WRITES TO OBSERVABLE STATE. Use the Game primitives — `setTapped`, `addCounters` / `setCounters`,
//    `gainLife` / `loseLife`, `dealDamage` / `dealDamageToPlayer`, `moveTo`, `enterBattlefield`, `addMana`, `attach`,
//    `changeControl`, `emit` / `note` — so the event stream stays complete. `test/lint-direct-writes.test.ts` scans
//    `src/engine/ops/**` with a ceiling of 0 for every pattern.
//
// 4. `ext` IS JSON-PLAIN. Family state lives in the `ext` bags on GameObject / Player / GameState through the helpers
//    in `./ext.js`. Primitives, arrays and plain objects only: no `Set`, no `Map`, no class instances, no functions —
//    `clone.ts` deep-copies the bag and `serialize.ts` round-trips it through JSON. A lint enforces it, and
//    `plainCopy` throws on anything else rather than aliasing it into every simulated state.
//
// ------------------------------------------------------------------ how to add one
//
//   1. write `src/engine/ops/<family>.ts` (this shape) and, if the tooling needs it, `<family>.schema.ts`
//   2. `npm run gen:registry`            — regenerates `_registry.ts` (never hand-edit it)
//   3. `npm run verify:quick`            — typecheck + lints + registry test + scripts check
//   4. add scenarios under `test/scenarios/` and run `npm run verify:scenarios`
//   5. `npm run verify:all` before the merge
//
// Parser rules for the family's wordings are a separate registry (`src/cards/rules/<family>.ts`); it lands in 8a-2.
// Until then a family is reached through per-card scripts, which emit its ops directly.

import type { AltCost, CardDef, FamilyModule, ManaCost } from './types.js';
import { extBump, extDel, extGet, extGetOr, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds
// Each new variant carries a literal discriminant (`op` / `kind` / `on` / `type`) so the core's switches keep narrowing.

/** "Suspend N — {cost}": exile it with N time counters, remove one each upkeep, cast it free at zero. */
export interface ExampleEffect { op: 'example-suspend'; counters: number }
export interface ExampleCondition { kind: 'example-suspended'; least?: number }
export interface ExampleTrigger { on: 'example-last-counter-removed'; self: boolean }
/** A trigger that fires on a *core* event with an extra condition ("whenever this attacks the player with the most life"). */
export interface ExampleDethrone { on: 'example-dethrone'; self: boolean }
export interface ExampleStatic { kind: 'example-becomes'; power: number; toughness: number }
export interface ExampleAsEnters { kind: 'example-enters-suspended'; counters: number }
export interface ExampleDecision { kind: 'example-choose-pile'; piles: number[][]; reason: string }
export interface ExampleAction { type: 'example-unsuspend'; objectId: number }
export interface ExampleEvent { type: 'example-suspended'; id: number; name: string; counters: number }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { exampleSuspend: ExampleEffect }
  interface ConditionRegistry { exampleSuspended: ExampleCondition }
  interface TriggerRegistry { exampleLastCounter: ExampleTrigger; exampleDethrone: ExampleDethrone }
  interface StaticRegistry { exampleBecomes: ExampleStatic }
  interface AsEntersRegistry { exampleEntersSuspended: ExampleAsEnters }
  interface AmountCountRegistry { 'example-time-counters': true }
  interface KeywordRegistry { 'example-shroudwalk': true }
  interface AltCostIdRegistry { 'example-suspend-cast': true }
  interface TargetKindRegistry { 'example-suspended-card': true }
  interface AbilityCostExt { exampleTimeCounters?: number }
}
declare module '../state.js' {
  interface DecisionRegistry { exampleChoosePile: ExampleDecision }
  interface ActionRegistry { exampleUnsuspend: ExampleAction }
  interface DelayedAtRegistry { 'example-next-untap': true }
}
declare module '../events.js' {
  interface EventRegistry { exampleSuspended: ExampleEvent }
}

// ------------------------------------------------------------------ 3. the module
// Every hook kind appears once. `test/registry.test.ts` registers an equivalent probe at runtime and asserts each one
// is observed in a real game, so this list is also the contract's test plan.

const EXAMPLE: FamilyModule = {
  name: 'example',

  // applyEffect's default branch. `c` is the OpCtx: g, s, item, p, src, T, idx, amt(), objs(), players(), apply().
  effects: {
    'example-suspend': (e: ExampleEffect, c) => {
      c.g.moveTo(c.src, 'exile', 'top', 'exile');
      extSet(c.src, 'exampleTime', e.counters);
      c.g.note(`${c.src.def.name} is suspended with ${e.counters} time counters.`);
    },
  },

  // conditionHolds' default branch. Synchronous: everything comes from (cond, s, src).
  conditions: {
    'example-suspended': (cond: ExampleCondition, _s, src) => extGetOr<number>(src, 'exampleTime', 0) >= (cond.least ?? 1),
  },

  // evalAmount's default branch, keyed by Amount.count.
  amounts: {
    'example-time-counters': (_a, _s, _ctrl, _x, src) => src ? extGetOr<number>(src, 'exampleTime', 0) : 0,
  },

  // Does this permanent's trigger fire? Consulted for EVERY event the core queues, with `event` naming the one that
  // actually happened — which is how a family trigger keys off a core event (dethrone on 'attacks') as well as off an
  // event it queues itself (`g.queueTriggers('example-last-counter-removed', ...)` from an effect or a step hook).
  triggers: {
    'example-last-counter-removed': (ev: ExampleTrigger, perm, ctx, _s, event) => event === 'example-last-counter-removed' && (ev.self ? ctx.obj === perm : ctx.player === perm.controller),
    'example-dethrone': (_ev: ExampleDethrone, perm, ctx, s, event) => event === 'attacks' && ctx.obj === perm
      && s.players.every(pl => pl.id === perm.controller || pl.life <= s.players[perm.controller].life),
  },

  // computeStaticMods, after the built-in kinds. Fold into `m` — including `m.setPT` (layer 7b-lite).
  statics: {
    'example-becomes': (e: ExampleStatic, src, o, _s, m) => { if (src.id === o.id) m.setPT = { power: e.power, toughness: e.toughness }; },
  },

  // Non-core AbilityCost keys: checked by cost.ts:nonManaCostPayable, paid by game.ts:payCost.
  costParts: {
    exampleTimeCounters: {
      payable: (v, _s, _pl, self) => extGetOr<number>(self, 'exampleTime', 0) >= (v as number),
      async pay(v, _g, _p, self) { extBump(self, 'exampleTime', -(v as number)); return true; },
    },
  },

  // Non-core AsEnters kinds. Write `ctx.entersTapped` to change whether it enters tapped.
  asEnters: {
    'example-enters-suspended': (a: ExampleAsEnters, o, ctx) => { extSet(o, 'exampleTime', a.counters); ctx.entersTapped = true; },
  },

  // Replacement effects. Each returns the replacement, never mutates the caller's locals.
  replacements: {
    zoneMove: (_g, o, zone) => zone === 'graveyard' && extGet<number>(o, 'exampleTime') !== undefined
      ? { zone: 'exile', emit: `${o.def.name} is exiled instead of dying (example).` } : null,
    damage: (_g, _src, target, n) => typeof target === 'number' ? n : Math.max(0, n - (extGetOr<number>(target, 'exampleShield', 0))),
    draw: () => false,                                   // true = the draw was replaced (no card is drawn)
    counters: (_g, _o, counter, delta) => counter === 'time' ? delta : delta,
    lifeGain: (_g, _p, n) => n,
  },

  // Step hooks: every Step, plus 'turn-start' (before untap) and 'cleanup-end' (after the end-of-turn wipe).
  steps: {
    upkeep: (g, ap) => { for (const o of g.state.players[ap].exile) if (extGet<number>(o, 'exampleTime') !== undefined) extBump(o, 'exampleTime', -1); },
    'turn-start': () => { /* day/night flips, "at the beginning of each turn" bookkeeping */ },
    'cleanup-end': () => { /* state that survives the eot wipe but not the turn */ },
  },

  // Extra state-based actions, inside checkSBA's loop. Return true when you changed something (the loop runs again).
  sba: (g) => { void g; return false; },

  // Extra legal actions, appended at the end of legalActions.
  legalActions: (g, p, out) => {
    for (const o of g.state.players[p].exile) if (extGetOr<number>(o, 'exampleTime', 1) === 0) out.push({ action: { type: 'example-unsuspend', objectId: o.id }, label: `cast ${o.def.name} (suspended)` });
  },

  // performAction's default branch, keyed by PlayerAction.type.
  actions: {
    'example-unsuspend': async (g, p, a: ExampleAction) => {
      const o = g.state.players[p].exile.find(x => x.id === a.objectId); if (!o) return false;
      extDel(o, 'exampleTime');
      return g.performAction(p, { type: 'cast', cardId: o.id, from: 'exile' });
    },
  },

  // defaultAnswer's default branch: what a shipped agent answers for a family decision it has never seen.
  decisions: {
    'example-choose-pile': (_s, _me, d: ExampleDecision) => d.piles[0] ?? [],
  },

  // Combat restrictions and requirements.
  keywordHooks: {
    canAttack: (_s, o) => extGet<number>(o, 'exampleTime') !== undefined ? false : undefined,   // undefined = abstain
    // a synchronous hook reads computed characteristics through `chars` ("can't be blocked by creatures with power 2 or less")
    canBlock: (s, blocker, attacker) => extGet<boolean>(attacker, 'exampleMenacing') === true && chars.power(s, blocker) <= 2 ? false
      : extGet<boolean>(blocker, 'exampleCantBlock') === true ? false : undefined,
    blockCheck: (_s, blocker, attacker) => !(extGet<number>(attacker, 'exampleLure') !== undefined && extGet<boolean>(blocker, 'exampleIgnoresLure') === true),
    blockFixup: (g, attackers) => { void g; void attackers; /* "blocks if able", lure */ },
    combatDamage: (_g, assignments) => { for (const a of assignments) if (extGet<boolean>(a.src, 'exampleDoubles') === true) a.n *= 2; },
  },

  // Objects queueTriggers should scan beyond the battlefield (emblems, command-zone statics).
  triggerSources: (s) => s.players.flatMap(pl => pl.command ?? []).filter(o => extGet<boolean>(o, 'exampleEmblem') === true),

  // Metadata for the family's own events: whether they reach the string log, their CR citation, their renderer.
  events: {
    'example-suspended': { logged: true, cr: '702.61a', render: (ev) => `${(ev as ExampleEvent).name} is suspended (${(ev as ExampleEvent).counters}).` },
  },

  // Scrub state a viewer must not see (view.ts:redact runs these over every object, every seat and the game itself).
  redact: (o, viewer) => { if (o.owner !== viewer) extDel(o, 'exampleSecretPile'); },
  redactPlayer: (pl, viewer) => { if (pl.id !== viewer) extDel(pl, 'exampleSecretVote'); },
  redactState: (s, viewer) => { void viewer; extDel(s, 'exampleHiddenDeckOrder'); },

  // Run for every permanent in the end-of-turn wipe loop.
  cleanupEot: (_g, o) => extDel(o, 'exampleShield'),

  // Non-core TargetSpec kinds (legal.ts:targetOptionsFor).
  targetKinds: {
    'example-suspended-card': (g, controller) => g.state.players[controller].exile.filter(o => extGet<number>(o, 'exampleTime') !== undefined).map(o => ({ kind: 'object' as const, id: o.id })),
  },

  // Built-in abilities of a predefined token, keyed by token name (Treasure/Clue/Food/Spawn live in `_tokens.ts`).
  tokenAbilities: {},

  // Called from moveTo when a permanent leaves the battlefield ("exile until this leaves").
  leave: (_g, o) => extDel(o, 'exampleAttachedShield'),

  // What the chosen modes add to the mana cost actually paid (entwine, escalate, spree, multikicker); null abstains.
  modeCost: (def: CardDef, modes: number[], _alt: AltCost | undefined, _kicked: boolean): ManaCost | null =>
    modes.length > 1 ? { generic: modes.length - 1, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '' } : null,
  // Cost alteration the core's fixed-amount `cost-adjust` static cannot express (positive = cheaper, negative = a tax).
  costMod: (s, p, card, from) => from === 'graveyard' ? -extGetOr<number>(s.players[p], 'exampleGraveyardTax', 0) : chars.types(card).includes('Creature') ? 1 : 0,

  // castSpell's `from` gate: true allows, false forbids, undefined abstains.
  castFrom: (_g, _p, card, from) => from === 'exile' && extGetOr<number>(card, 'exampleTime', 1) === 0 ? true : undefined,
  // castSpell's free computation: true = the mana cost is not paid.
  freeCast: (_g, _p, card, from) => from === 'exile' && extGetOr<number>(card, 'exampleTime', 1) === 0 ? true : undefined,

  // Round-trip English per op — what the script verification pipeline diffs against the oracle text.
  render: {
    'example-suspend': (e: ExampleEffect) => `Suspend ${e.counters}`,
  },
};

export default EXAMPLE;
