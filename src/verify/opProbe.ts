// Execution probe for the op-coverage ratchet (phase 8h). "Which discriminators did the engine actually *dispatch on*
// while the harness ran?" — as opposed to "which cards did somebody name in a file", which is what the first cut of
// this slice measured and which a review rightly rejected: a card named in a scenario carries its whole AST, and most
// of that AST never executes (Ainok Survivalist's `destroy` counted as covered even though its `turned-face-up`
// trigger can never fire).
//
// Nothing in src/engine is modified. The probe installs three seams around it and takes them out again afterwards:
//
//   CardDB.prototype.get      — every CardDef the harness plays comes back wrapped in a deep recording Proxy, so the
//                               discriminator of a node is recorded exactly when the engine READS it: `cond.kind` is
//                               read by conditionHolds' switch, `a.count` by evalAmount's, `a.kind` by the as-enters
//                               switch, a cost part key by the payer. Reading it *is* the dispatch.
//   Game.prototype.applyEffect        — one record per effect the engine executes (nested and family `ctx.apply` ones
//                               included, since those re-enter the same method).
//   scenarioCards.def           — the same wrapping for the defs a scenario builds itself (its `scripts` field applies a
//                               script to a real card, and the result is a fresh object the database never saw).
//   Game.prototype.flushDelayed / fireLeaveDelayed — one record per delayed-trigger point that actually FIRED (the
//                               delayed list shrank, or `pendingTriggers` grew), never per delayed trigger created.
//   Game.prototype.putTriggersOnStack — one record per trigger that actually FIRED, read off `pendingTriggers` before
//                               they go on the stack. Deliberately not `queueTriggers`: that reads `ev.on` for every
//                               triggered ability on the battlefield whenever any event is raised, so recording there
//                               would mark a trigger covered for merely sitting in play — the exact blindness that
//                               let a dead `turned-face-up` trigger read as exercised.
//
// The proxy is transparent by construction: it only observes `get`, hands out one memoised wrapper per node (so
// identity comparisons inside the engine still hold), and CardDefs are shared, never copied, by cloneState. That it
// really is transparent is checked empirically on every run: every scenario must still pass with it installed
// (collectExercised reports the ones that do not, and the lint fails on them).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import { projectRoot } from '../config/paths.js';
import { Game } from '../engine/game.js';
import { ownTargetSpecs } from '../engine/legal.js';
import type { DelayedTrigger, GameState } from '../engine/state.js';
import { HINT, categoryOfKind, emptySets, type Category, type Hint, type Sets } from './opCoverage.js';
import { runScenario, scenarioCards, type Scenario } from './scenarioDsl.js';
import { listScenarioFiles, readScenarioFile } from './scenarioFiles.js';

/** Ability kinds are not a category: `kind: 'triggered'` says what the ability is, not what the engine dispatches on. */
const ABILITY_KINDS = new Set(['triggered', 'activated', 'static', 'spell']);

export interface Probe {
  /** Discriminators the engine dispatched on, per category (only names the vocabulary knows). */
  readonly sets: Sets;
  /** Dispatched on but NOT in the vocabulary: either the vocabulary lost an anchor or the parser emits a dead name. */
  readonly unknown: Sets;
  uninstall(): void;
}

interface Patch { restore: () => void }
type AnyFn = (...a: never[]) => unknown;

/** Patch one method of a prototype, loudly: a renamed engine method must stop the ratchet, not quietly shrink it. */
function patch(proto: object, key: string, make: (orig: AnyFn) => AnyFn, where: string): Patch {
  const holder = proto as Record<string, AnyFn>;
  const orig = holder[key];
  if (typeof orig !== 'function') throw new Error(`op-coverage: ${where}.${key} is no longer a method — re-anchor src/verify/opProbe.ts`);
  holder[key] = make(orig);
  return { restore: () => { holder[key] = orig; } };
}

/**
 * Install the probe. Every recorded name is checked against `vocab`: known ones land in `sets`, unknown ones in
 * `unknown` (which the lint asserts is empty for the dispatch categories — a discriminator the engine executes that
 * the vocabulary does not know means the vocabulary is wrong, which is exactly how `turned-face-up` hid).
 */
export function installProbe(vocab: Sets): Probe {
  const sets = emptySets();
  const unknown = emptySets();
  const rec = (c: Category, n: string): void => { (vocab[c].has(n) ? sets : unknown)[c].add(n); };

  // ---- the recording proxy ---------------------------------------------------------------------
  // One wrapper per node, memoised by the node itself, so `item.ability === ab` and every other identity check inside
  // the engine still compares equal. The hint is the key the node hung off (the same positional table `usedBy` walks
  // with), captured when the node is first wrapped; array elements inherit their array's hint.
  const cache = new WeakMap<object, object>();
  const wrap = (v: object, hint: Hint): object => {
    const hit = cache.get(v);
    if (hit) return hit;
    const px = new Proxy(v, {
      get(t, p) {
        const val = Reflect.get(t, p, t);
        if (typeof p !== 'string') return val;
        const childHint: Hint = Array.isArray(t) ? hint : HINT[p];
        observe(p, val, hint, childHint);
        return val !== null && typeof val === 'object' ? wrap(val as object, childHint) : val;
      },
    });
    cache.set(v, px);
    return px;
  };

  /** Record what reading `key` off a node with hint `hint` says the engine is dispatching on. */
  function observe(key: string, val: unknown, hint: Hint, childHint: Hint): void {
    if (typeof val === 'string') {
      if (key === 'op') rec('effects', val);                                      // switch (e.op) in applyEffect
      else if (key === 'count') { if (val !== 'all') rec('amounts', val); }        // switch (a.count) in evalAmount ('all' is a `move` count, not an amount)
      else if (key === 'prop') rec('amounts', 'prop');                            // evalAmountForm's `prop` form
      else if (key === 'id' && hint === 'altCosts') rec('altCosts', val);          // the alt cost the caster chose
      else if (childHint === 'keywords') { if (val !== 'all') rec('keywords', val); }   // withKeyword: 'flying' ('all' is lose-abilities' "every ability")
      else if (key === 'kind' && hint !== 'skip' && !ABILITY_KINDS.has(val)) {
        const cat = hint && hint !== 'keywords' && hint !== 'costParts' ? hint : categoryOfKind(val, vocab);
        if (cat) rec(cat, val);                                                    // conditions, statics, as-enters, cost modifiers
      }
      return;
    }
    // the list-shaped amount forms: evalAmountForm reads `diff` / `sum` / `max` / `min` off the expression it dispatches on
    if ((key === 'diff' || key === 'sum' || key === 'max' || key === 'min') && Array.isArray(val)) { rec('amounts', key); return; }
    // A keyword list is a bag, not a discriminated union: the engine reads the whole list and asks it questions
    // (`keywords(s, o).includes('flying')`), so reading it is as fine-grained as this seam gets.
    if (childHint === 'keywords' && Array.isArray(val)) { for (const k of val) if (typeof k === 'string') rec('keywords', k); return; }
    // An AbilityCost is a bag too: every key it carries that the payer looks at (and that is really there) is a part.
    if (hint === 'costParts' && val !== undefined && vocab.costParts.has(key)) { rec('costParts', key); return; }
    // Cast-time flags the engine turns into effects; they never appear as `{ op }` in the AST.
    if (val === true && (key === 'storm' || key === 'cascade')) rec('effects', key === 'storm' ? 'storm-copies' : 'cascade');
  }

  // ---- the three seams -------------------------------------------------------------------------
  const patches: Patch[] = [];
  patches.push(patch(CardDB.prototype, 'get', orig => function (this: CardDB, ...a: never[]) {
    const def = orig.apply(this, a) as CardDef | null;
    return def ? wrap(def, undefined) as CardDef : def;
  }, 'CardDB'));
  patches.push(patch(scenarioCards, 'def', orig => function (this: typeof scenarioCards, ...a: never[]) {
    const def = orig.apply(this, a) as CardDef;
    return wrap(def, undefined) as CardDef;
  }, 'scenarioCards'));
  patches.push(patch(Game.prototype, 'applyEffect', orig => function (this: Game, ...a: never[]) {
    const e = a[1] as { op?: unknown } | undefined;
    if (e && typeof e.op === 'string') {
      rec('effects', e.op);
      // the target kinds this effect resolves with (a `multi` spec counts itself and each of its parts)
      for (const spec of ownTargetSpecs(e as never)) { rec('targetKinds', spec.kind as string); if (spec.kind === 'multi') for (const sub of spec.specs ?? []) rec('targetKinds', sub.kind as string); }
    }
    return orig.apply(this, a);
  }, 'Game'));
  // a delayed-trigger point is exercised when a trigger scheduled at it FIRES: flushDelayed removes it from the list
  // (and pushes a pending trigger), fireLeaveDelayed does the same for the `this-turn:*` points from moveTo
  const pendingOf = (g: Game) => (g as unknown as { pendingTriggers: unknown[] }).pendingTriggers;
  patches.push(patch(Game.prototype, 'flushDelayed', orig => function (this: Game, ...a: never[]) {
    const at = a[0] as string; const before = pendingOf(this).length;
    const r = orig.apply(this, a);
    if (pendingOf(this).length > before) rec('delayedAt', at);
    return r;
  }, 'Game'));
  patches.push(patch(Game.prototype, 'fireLeaveDelayed', orig => function (this: Game, ...a: never[]) {
    const s = this.state as GameState; const before = (s.delayed ?? []).map(d => ({ at: d.at as string, n: d.affected?.length ?? 0, id: d.id }));
    const r = orig.apply(this, a);
    const after = new Map((s.delayed ?? []).map(d => [d.id, d.affected?.length ?? 0] as const));
    for (const d of before) if ((after.get(d.id) ?? 0) < d.n) rec('delayedAt', d.at);
    return r;
  }, 'Game'));
  void (0 as unknown as DelayedTrigger);
  patches.push(patch(Game.prototype, 'putTriggersOnStack', orig => function (this: Game, ...a: never[]) {
    const pending = (this as unknown as { pendingTriggers?: { ability?: { event?: { on?: unknown } } }[] }).pendingTriggers;
    if (!Array.isArray(pending)) throw new Error('op-coverage: Game.pendingTriggers is no longer an array — re-anchor src/verify/opProbe.ts');
    for (const t of pending) { const on = t.ability?.event?.on; if (typeof on === 'string') rec('triggers', on); }
    return orig.apply(this, a);
  }, 'Game'));

  return { sets, unknown, uninstall: () => { for (const p of patches.reverse()) p.restore(); } };
}

/** What one harness run measured. `failures` is empty when every scenario passed with the probe installed. */
export interface Harness {
  sets: Sets; unknown: Sets;
  scenarios: number; suites: string[]; jsonFiles: number;
  failures: string[];
}

const isScenarioList = (v: unknown): v is Scenario[] =>
  Array.isArray(v) && v.every(x => !!x && typeof x === 'object' && typeof (x as Scenario).name === 'string' && Array.isArray((x as Scenario).script));

/** Every scenario the harness owns, in report order: the TS suites under test/scenarios/, then the JSON corpus. */
export async function collectScenarios(): Promise<{ tasks: { file: string; scenario: Scenario }[]; suites: string[]; jsonFiles: number }> {
  const root = projectRoot();
  const tasks: { file: string; scenario: Scenario }[] = [];
  const suites: string[] = [];
  const dir = path.join(root, 'test', 'scenarios');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ts') && x !== 'dsl.ts' && !x.endsWith('.test.ts')).sort()) {
      // Imported the way scripts/verify-scenarios.ts imports them: a computed specifier, because tsconfig's rootDir
      // is src/ and src may not import test/.
      const mod = await import(pathToFileURL(path.join(dir, f)).href) as Record<string, unknown>;
      const lists = Object.values(mod).filter(isScenarioList);
      if (!lists.length) throw new Error(`op-coverage: test/scenarios/${f} exports no scenario list`);
      const family = f.replace(/\.ts$/, '');
      suites.push(family);
      for (const list of lists) for (const sc of list) tasks.push({ file: family, scenario: sc });
    }
  }
  const jsonPaths = listScenarioFiles();
  for (const p of jsonPaths) for (const sc of readScenarioFile(p).scenarios) tasks.push({ file: path.relative(root, p).split(path.sep).join('/'), scenario: sc });
  return { tasks, suites, jsonFiles: jsonPaths.length };
}

/**
 * Run every scenario the harness owns with the probe installed and return what the engine actually dispatched on.
 * Sequential and in-process on purpose: the probe lives in this process's engine prototypes, and the whole corpus is
 * about a second of engine time, so the lint can afford to measure coverage by running it rather than by reading it
 * off a file that may be stale.
 */
export async function collectExercised(vocab: Sets): Promise<Harness> {
  const { tasks, suites, jsonFiles } = await collectScenarios();
  const probe = installProbe(vocab);
  const failures: string[] = [];
  try {
    for (const t of tasks) {
      try {
        const run = await runScenario(t.scenario);
        for (const f of run.failures) failures.push(`[${t.file}] ${t.scenario.name}: ${f}`);
      } catch (e) { failures.push(`[${t.file}] ${t.scenario.name}: threw: ${(e as Error).message}`); }
    }
  } finally { probe.uninstall(); }
  return { sets: probe.sets, unknown: probe.unknown, scenarios: tasks.length, suites, jsonFiles, failures };
}
