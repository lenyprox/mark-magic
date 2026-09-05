// Op-coverage ratchet (phase 8h, plan 2.5f). "Does the harness actually *run* every op the engine can execute?"
//
// Two sets, computed from data rather than from a grep for op names in scenario files:
//   VOCABULARY — every literal discriminator the engine can execute. Derived from the engine itself (the `case` labels
//                of the switches that dispatch on them, the events queueTriggers is *called* with, plus the runtime
//                registry lookups in src/engine/ops/_registry.ts), never from a hand-maintained list, so a family that
//                registers a new key is in the vocabulary the moment it is registered and a core op that is deleted
//                leaves it.
//   EXERCISED  — every discriminator the engine actually DISPATCHED ON while the harness ran: src/verify/opProbe.ts
//                runs every scenario (the TS suites under test/scenarios/ and the JSON corpus under data/scenarios/)
//                in-process behind a probe that records `e.op` as applyEffect executes it, `cond.kind` as
//                conditionHolds reads it, a trigger's event as it fires, and so on. Naming a card in a file is not
//                coverage: most of a played card's AST never executes, and a card named in a unit test that never
//                builds a Game executes nothing at all.
//
// uncovered = vocabulary \ exercised \ dead, and test/lint-op-coverage.test.ts asserts it is a subset of the committed
// allowlist test/fixtures/op-allowlist.json. A new registry key is never in that allowlist, so a family that lands
// without a scenario fails the lint by construction.
//
// WHAT THIS STILL DOES NOT MEASURE: that the op's *outcome* is asserted. Every scenario carries expectations and the
// lint refuses to score a run in which any of them failed, so an executed op ran inside a passing scenario — but a
// scenario may of course execute an op incidentally without checking what it did. Execution is the floor, not the
// ceiling; `npm run coverage:pool` and the scenario expectations are what raise it.
//
// DEAD OPS: a trigger event the engine raises that nothing dispatches on (`turned-face-up`), or a `case` label for an
// event the engine never raises (`tapped`), can never be exercised by any scenario — it is a defect, not a coverage
// gap, so it is counted apart from `uncovered` in `deadEvents()` and pinned by the allowlist's "deadEvents" list.
//
// TEXT-DERIVED, ON PURPOSE: the engine switches are read as *text* (see `switchCases` / `unionBody` below). TypeScript
// erases the unions at runtime and the engine has no table of its own core ops, so there is nothing else to read. Every
// reader here throws when its anchor moves instead of silently returning a short list — a vocabulary that quietly
// shrinks is the one failure mode a ratchet must never have.
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import { projectRoot } from '../config/paths.js';
import { AMOUNTS, AS_ENTERS, CONDITIONS, CORE_COST_KEYS, COST_PARTS, EFFECT_OPS, STATICS, TRIGGERS } from '../engine/ops/_registry.js';

// ------------------------------------------------------------------ categories
export const CATEGORIES = ['effects', 'conditions', 'triggers', 'statics', 'amounts', 'asEnters', 'altCosts', 'costModifiers', 'costParts', 'keywords'] as const;
export type Category = typeof CATEGORIES[number];
/** One string list per category (the JSON report shape). */
export type Lists = Record<Category, string[]>;
/** One set per category (the working shape). */
export type Sets = Record<Category, Set<string>>;

export const emptySets = (): Sets => Object.fromEntries(CATEGORIES.map(c => [c, new Set<string>()])) as Sets;
const sorted = (s: Set<string>): string[] => [...s].sort();
export const toLists = (s: Sets): Lists => Object.fromEntries(CATEGORIES.map(c => [c, sorted(s[c])])) as Lists;
export const toSets = (l: Partial<Lists>): Sets => Object.fromEntries(CATEGORIES.map(c => [c, new Set(l[c] ?? [])])) as Sets;

// ------------------------------------------------------------------ reading the engine's own source
const srcOf = (rel: string): string => fs.readFileSync(path.join(projectRoot(), ...rel.split('/')), 'utf8');

/** Drop `//` and block comments while leaving string literals alone (a comment must never contribute a discriminator). */
const stripComments = (s: string): string =>
  s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, m => ('\'"`'.includes(m[0]) ? m : ' '));

/**
 * The `case '…':` labels of ONE switch: the first `header` after `fn` in `src`, taking only the labels at the switch's
 * own brace depth (a nested block or switch inside a case contributes nothing). Throws when either anchor has moved.
 */
export function switchCases(src: string, where: string, fn: string, header: string): string[] {
  const at = src.indexOf(fn);
  if (at < 0) throw new Error(`op-coverage: ${where} no longer contains \`${fn}\` — re-anchor src/verify/opCoverage.ts`);
  const sw = src.indexOf(header, at);
  if (sw < 0) throw new Error(`op-coverage: ${where}: no \`${header}\` after \`${fn}\` — re-anchor src/verify/opCoverage.ts`);
  const out: string[] = [];
  let depth = 0, closed = false;
  for (let i = sw + header.length - 1; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { if (--depth === 0) { closed = true; break; } continue; }
    if (depth === 1 && src.startsWith("case '", i)) {
      const end = src.indexOf("'", i + 6);
      if (end > 0) { out.push(src.slice(i + 6, end)); i = end; }
    }
  }
  if (!closed) throw new Error(`op-coverage: ${where}: \`${header}\` is unbalanced`);
  if (!out.length) throw new Error(`op-coverage: ${where}: \`${header}\` has no case labels`);
  return out;
}

/** The right-hand side of `export type <name> = … ;`, to the first `;` at bracket depth 0. */
export function unionBody(src: string, name: string, where: string): string {
  const head = `export type ${name} =`;
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`op-coverage: ${where} no longer declares \`${name}\` — re-anchor src/verify/opCoverage.ts`);
  let depth = 0;
  for (let i = at + head.length; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ';' && depth === 0) return src.slice(at + head.length, i);
  }
  throw new Error(`op-coverage: ${where}: \`${name}\` has no terminating ";"`);
}
const literalsIn = (body: string): string[] => [...body.matchAll(/'([^'\n]+)'/g)].map(m => m[1]);
const discriminatorsIn = (body: string, key: string): string[] => [...body.matchAll(new RegExp(`\\b${key}\\s*:\\s*'([^'\\n]+)'`, 'g'))].map(m => m[1]);

/** The engine modules that dispatch on a discriminator; src/engine/ops/ is excluded — families register instead. */
function engineFiles(withFamilies = false): string[] {
  const dir = path.join(projectRoot(), 'src', 'engine');
  const out = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => path.join(dir, f));
  for (const sub of withFamilies ? ['agents', 'ops'] : ['agents']) {
    const d = path.join(dir, sub);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.ts')) out.push(path.join(d, f));
  }
  return out.sort();
}

// ------------------------------------------------------------------ trigger events
// Triggers are the one category with two independent halves that must agree: the engine RAISES events
// (`queueTriggers('etb', …)`) and it DISPATCHES on them (the `switch (ev.on)` inside queueTriggers, the registry, the
// `ev.on === 'or'` fan-out, and the trigger abilities the engine synthesises itself for storm/cascade/evoke/delayed
// triggers). Reading only the switch — the first cut of this file — made an event the engine raises but nothing
// handles invisible: `turned-face-up` is raised by Game.turnFaceUp, is what every morph card's trigger keys off, and
// can never fire. Both halves are in the vocabulary, and whatever appears in only one of them is dead.

/** Every event `queueTriggers` is called with. `withFamilies` also reads src/engine/ops/, where a family may raise. */
export function raisedEvents(withFamilies = true): Set<string> {
  const out = new Set<string>();
  for (const f of engineFiles(withFamilies)) for (const m of stripComments(fs.readFileSync(f, 'utf8')).matchAll(/queueTriggers\(\s*'([^'\n]+)'/g)) out.add(m[1]);
  if (out.size < 10) throw new Error('op-coverage: found almost no `queueTriggers(\'…\')` call sites — re-anchor src/verify/opCoverage.ts');
  return out;
}

/** The `case` labels of queueTriggers' own switch: the core half of the dispatch. */
const coreTriggerCases = (game: string): string[] => switchCases(game, 'src/engine/game.ts', 'queueTriggers(event: string', 'switch (ev.on) {');

/** Every event the engine dispatches on: the switch, the registry, `ev.on === '…'`, and the events it synthesises. */
function handledEvents(game: string): Set<string> {
  const out = new Set<string>(coreTriggerCases(game));
  for (const f of engineFiles()) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/\.on\s*===\s*'([^'\n]+)'/g)) out.add(m[1]);       // the 'or' fan-out
    for (const m of s.matchAll(/(?<![\w$])on:\s*'([^'\n]+)'/g)) out.add(m[1]);    // `event: { on: '…' }` the engine pushes itself (storm, cascade, evoke, delayed)
  }
  for (const k of Object.keys(TRIGGERS)) out.add(k);                             // a registry trigger is asked about every event
  return out;
}

export interface DeadEvent { name: string; why: 'raised but nothing dispatches on it' | 'dispatched on but the engine never raises it' }

let deadCache: DeadEvent[] | null = null;
/**
 * Trigger events that can never fire: raised with no handler, or handled with nothing raising them. Both halves are
 * engine defects — a card whose trigger keys off one of them is silently inert — so they are reported apart from the
 * ordinary coverage gaps and pinned by the allowlist rather than being written off as "no scenario yet".
 */
export function deadEvents(): DeadEvent[] {
  if (deadCache) return deadCache;
  const game = stripComments(srcOf('src/engine/game.ts'));
  const raised = raisedEvents();
  const handled = handledEvents(game);
  const out: DeadEvent[] = [];
  for (const n of [...raised].sort()) if (!handled.has(n)) out.push({ name: n, why: 'raised but nothing dispatches on it' });
  // Only the core `case` labels are checked the other way: a registry trigger is offered every event and an event the
  // engine synthesises is pushed straight onto pendingTriggers, so neither needs a queueTriggers call site.
  for (const n of [...new Set(coreTriggerCases(game))].sort()) if (!raised.has(n)) out.push({ name: n, why: 'dispatched on but the engine never raises it' });
  return (deadCache = out);
}

// ------------------------------------------------------------------ the vocabulary
/** How each category's core half was derived — echoed into the report so a reader can re-check it by hand. */
export const SOURCES: Record<Category, string> = {
  effects: "case labels of `switch (e.op)` in Game.applyEffect (src/engine/game.ts) + EFFECT_OPS keys",
  conditions: "case labels of `switch (cond.kind)` in conditionHolds (src/engine/characteristics.ts) + CONDITIONS keys",
  triggers: "case labels of `switch (ev.on)` in Game.queueTriggers, every event `queueTriggers('…')` is called with, the `ev.on === '…'` fan-out and the `event: { on: '…' }` abilities the engine synthesises (src/engine/*.ts) + TRIGGERS keys",
  statics: "CoreStaticEffect kinds that src/engine/*.ts actually tests with `kind === '…'` + STATICS keys",
  amounts: "case labels of `switch (a.count)` in evalAmount (src/engine/characteristics.ts) + AMOUNTS keys",
  asEnters: "case labels of `switch (a.kind)` in Game.enterBattlefield plus the CoreAsEnters kinds src/engine/*.ts tests with `kind === '…'` + AS_ENTERS keys",
  altCosts: 'the CoreAltCostId union in src/cards/types.ts (AltCostIdRegistry is types-only: nothing to enumerate at runtime)',
  costModifiers: 'the CostModifier union kinds in src/cards/types.ts',
  costParts: 'CORE_COST_KEYS in src/engine/ops/_registry.ts + COST_PARTS keys',
  keywords: 'the CoreKeyword union in src/cards/types.ts (KeywordRegistry is types-only)',
};

let vocabCache: Sets | null = null;
/** Every discriminator the engine can execute right now (core switches + whatever families have registered). */
export function vocabulary(): Sets {
  if (vocabCache) return vocabCache;
  const game = stripComments(srcOf('src/engine/game.ts'));
  const chars = stripComments(srcOf('src/engine/characteristics.ts'));
  const types = stripComments(srcOf('src/cards/types.ts'));
  const v = emptySets();
  const add = (c: Category, names: Iterable<string>) => { for (const n of names) v[c].add(n); };

  add('effects', switchCases(game, 'src/engine/game.ts', 'async applyEffect(', 'switch (e.op) {'));
  add('conditions', switchCases(chars, 'src/engine/characteristics.ts', 'export function conditionHolds(', 'switch (cond.kind) {'));
  // Both halves of the trigger vocabulary: what the engine dispatches on and what it raises (see deadEvents()).
  add('triggers', handledEvents(game));
  add('triggers', raisedEvents());
  add('amounts', switchCases(chars, 'src/engine/characteristics.ts', 'export function evalAmount(', 'switch (a.count) {'));
  add('asEnters', switchCases(game, 'src/engine/game.ts', 'for (const a of def.asEnters ?? []) {', 'switch (a.kind) {'));

  // Statics have no single switch: each kind is read where it applies (characteristics, mana, cost, game), and a few
  // as-enters kinds are read outside the switch too (discard-or-graveyard). Intersecting the `kind === '…'` /
  // `kind !== '…'` tests in src/engine with the kinds the union declares keeps unrelated discriminators (ability kinds,
  // zones, decision kinds) out and leaves exactly the kinds the engine acts on — a kind the parser can emit but nothing
  // reads (can-be-commander, look-top-anytime, may-not-untap) is not "executable" and is not in the vocabulary.
  const declared = (union: string, min: number): Set<string> => {
    const set = new Set(discriminatorsIn(unionBody(types, union, 'src/cards/types.ts'), 'kind'));
    if (set.size < min) throw new Error(`op-coverage: ${union} looks empty — re-anchor src/verify/opCoverage.ts`);
    return set;
  };
  const handled: Record<'statics' | 'asEnters', Set<string>> = { statics: declared('CoreStaticEffect', 20), asEnters: declared('CoreAsEnters', 5) };
  for (const f of engineFiles()) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/\bkind\s*[!=]==\s*'([^'\n]+)'/g)) for (const c of ['statics', 'asEnters'] as const) if (handled[c].has(m[1])) v[c].add(m[1]);
  }

  add('altCosts', literalsIn(unionBody(types, 'CoreAltCostId', 'src/cards/types.ts')));
  add('costModifiers', discriminatorsIn(unionBody(types, 'CostModifier', 'src/cards/types.ts'), 'kind'));
  add('keywords', literalsIn(unionBody(types, 'CoreKeyword', 'src/cards/types.ts')));
  add('costParts', CORE_COST_KEYS);

  // ...and the registry, read live: registerFamily() mutates these lookups, so a family added at runtime is in the
  // vocabulary immediately (which is what makes the lint's mutation check meaningful).
  add('effects', Object.keys(EFFECT_OPS)); add('conditions', Object.keys(CONDITIONS)); add('triggers', Object.keys(TRIGGERS));
  add('statics', Object.keys(STATICS)); add('amounts', Object.keys(AMOUNTS)); add('asEnters', Object.keys(AS_ENTERS));
  add('costParts', Object.keys(COST_PARTS));
  return (vocabCache = v);
}
/** Drop the memoised vocabulary (the lint's mutation check registers a family after the first read). */
export const resetVocabulary = (): void => { vocabCache = null; deadCache = null; };

// ------------------------------------------------------------------ walking a CardDef for the discriminators it uses
const ABILITY_KINDS = new Set(['triggered', 'activated', 'static', 'spell']);
/**
 * Key → what lives under it. The ability AST is regular enough to name the category positionally, which keeps the two
 * `kind` collisions honest (an as-enters `counters` is not the effect op `counters`). `'skip'` marks a TargetSpec,
 * whose `kind` is a target kind and belongs to no category here.
 */
export type Hint = Category | 'skip' | undefined;
export const HINT: Record<string, Category | 'skip'> = {
  condition: 'conditions', intervening: 'conditions', activateOnlyIf: 'conditions', unless: 'conditions', conditions: 'conditions',
  effects: 'effects', then: 'effects', else: 'effects', first: 'effects', modes: 'effects',
  event: 'triggers', events: 'triggers',
  asEnters: 'asEnters', costModifiers: 'costModifiers',
  altCosts: 'altCosts', cost: 'costParts', additionalCosts: 'costParts',
  keywords: 'keywords', extraKeywords: 'keywords', withKeyword: 'keywords',
  target: 'skip', enchant: 'skip',
};

/** The category a bare `kind` belongs to when nothing positional says: the one whose vocabulary knows the name. */
export function categoryOfKind(kind: string, vocab: Sets): Category | undefined {
  for (const c of ['conditions', 'statics', 'asEnters', 'costModifiers'] as const) if (vocab[c].has(kind)) return c;
  return undefined;
}

function walk(v: unknown, hint: Category | 'skip' | undefined, out: Sets, vocab: Sets): void {
  if (Array.isArray(v)) { for (const x of v) walk(x, hint, out, vocab); return; }
  if (typeof v === 'string') { if (hint === 'keywords') out.keywords.add(v); return; }
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  if (typeof o.op === 'string') out.effects.add(o.op);
  else if (typeof o.on === 'string') out.triggers.add(o.on);
  else if (typeof o.count === 'string') out.amounts.add(o.count);
  else if (hint === 'altCosts' && typeof o.id === 'string') out.altCosts.add(o.id);
  else if (typeof o.kind === 'string' && hint !== 'skip' && !ABILITY_KINDS.has(o.kind)) {
    const cat = hint && hint !== 'keywords' && hint !== 'costParts' ? hint : categoryOfKind(o.kind, vocab);
    if (cat) out[cat].add(o.kind);
  }
  // an AbilityCost is a bag of optional keys, not a discriminated union: every key it carries is one cost part
  if (hint === 'costParts' && typeof o.kind !== 'string') for (const k of Object.keys(o)) if (vocab.costParts.has(k)) out.costParts.add(k);
  for (const k of Object.keys(o)) walk(o[k], HINT[k], out, vocab);
}

/**
 * Every discriminator this card definition *could* make the engine execute. This is a static read of the AST, so it
 * is not coverage — it is only used to suggest exemplar cards for the ops nothing exercises (see `exemplars`).
 */
export function usedBy(def: CardDef, vocab: Sets, into: Sets = emptySets()): Sets {
  walk(def, undefined, into, vocab);
  // def-level flags the engine turns into effects at cast time (they never appear as `{ op }` in the AST)
  if (def.storm) into.effects.add('storm-copies');
  if (def.cascade) into.effects.add('cascade');
  return into;
}

// ------------------------------------------------------------------ the report
export interface CoverageReport {
  at: string;
  harness: { scenarios: number; suites: string[]; jsonFiles: number; failures: string[] };
  vocabulary: Lists; exercised: Lists; uncovered: Lists;
  /** Dispatched on while the harness ran but absent from the vocabulary — the vocabulary has lost an anchor. */
  unknown: Lists;
  dead: DeadEvent[];
  byOp: Record<string, string[]>;
  sources: Record<Category, string>;
}

export const difference = (a: Sets, b: Sets): Sets =>
  Object.fromEntries(CATEGORIES.map(c => [c, new Set([...a[c]].filter(n => !b[c].has(n)))])) as Sets;

/**
 * What no scenario made the engine execute: vocabulary \ exercised, minus the dead trigger events, which no scenario
 * could ever cover (they are defects, tracked by `deadEvents()` and the allowlist's "deadEvents" list instead).
 */
export function uncoveredOps(vocab: Sets, used: Sets, dead: DeadEvent[] = deadEvents()): Sets {
  const out = difference(vocab, used);
  for (const d of dead) out.triggers.delete(d.name);
  return out;
}

/**
 * Up to `max` cards from the whole playable pool that use each uncovered discriminator, so an author knows what to
 * write the missing scenario with. Walks master.db (~8 s), so it belongs in the report, never in the lint's hot path.
 */
export function exemplars(uncovered: Sets, vocab: Sets, max = 5, db = CardDB.shared()): Record<string, string[]> {
  const wanted = new Map<Category, Set<string>>(CATEGORIES.map(c => [c, new Set(uncovered[c])]));
  const out: Record<string, string[]> = {};
  let left = CATEGORIES.reduce((n, c) => n + uncovered[c].size, 0);
  if (!left) return out;
  for (const def of db.all()) {
    const used = usedBy(def, vocab);
    for (const c of CATEGORIES) {
      const want = wanted.get(c)!;
      for (const n of used[c]) {
        if (!want.has(n)) continue;
        const list = (out[n] ??= []);
        if (!list.includes(def.name)) list.push(def.name);
        if (list.length >= max) { want.delete(n); left--; }
      }
    }
    if (!left) break;
  }
  for (const c of CATEGORIES) for (const n of uncovered[c]) out[n] ??= [];
  return out;
}

/**
 * The whole report: run the harness behind the probe, then diff what it executed against the vocabulary.
 * `withExemplars` costs one extra full-pool walk. The probe is imported lazily so that reading the vocabulary (which
 * the lint does first, and which must work without a card database) never pulls the engine in.
 */
export async function report(opts: { withExemplars?: boolean } = {}): Promise<CoverageReport> {
  const vocab = vocabulary();
  const { collectExercised } = await import('./opProbe.js');
  const run = await collectExercised(vocab);
  const uncovered = uncoveredOps(vocab, run.sets);
  return {
    at: new Date().toISOString(),
    harness: { scenarios: run.scenarios, suites: run.suites, jsonFiles: run.jsonFiles, failures: run.failures },
    vocabulary: toLists(vocab), exercised: toLists(run.sets), uncovered: toLists(uncovered), unknown: toLists(run.unknown),
    dead: deadEvents(),
    byOp: opts.withExemplars ? exemplars(uncovered, vocab) : {},
    sources: SOURCES,
  };
}

// ------------------------------------------------------------------ the ratchet
export const ALLOWLIST_FILE = (): string => path.join(projectRoot(), 'test', 'fixtures', 'op-allowlist.json');
export const REPORT_FILE = (): string => path.join(projectRoot(), 'data', 'master', 'op-coverage.json');

/** The allowlist: one list per category, plus the dead trigger events the engine is known to carry. */
export type Allowlist = Lists & { deadEvents: string[] };
const ALLOWLIST_KEYS: readonly string[] = [...CATEGORIES, 'deadEvents'];

export function readAllowlist(file = ALLOWLIST_FILE()): Allowlist {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const out = { deadEvents: [] } as unknown as Allowlist;
  const strings = (k: string): string[] => {
    const v = raw[k];
    if (v !== undefined && !(Array.isArray(v) && v.every(x => typeof x === 'string'))) throw new Error(`${file}: "${k}" must be a list of strings`);
    return ((v as string[] | undefined) ?? []).slice();
  };
  for (const c of CATEGORIES) out[c] = strings(c);
  out.deadEvents = strings('deadEvents');
  for (const k of Object.keys(raw)) if (!ALLOWLIST_KEYS.includes(k) && k !== '//') throw new Error(`${file}: unknown category "${k}"`);
  return out;
}

export interface Ratchet {
  /** Uncovered and NOT allowlisted: a new op landed without a scenario. */
  missing: { category: Category; name: string }[];
  /** Allowlisted but covered now (or gone from the vocabulary): the list has to shrink. */
  stale: { category: Category; name: string; why: 'covered' | 'not in the vocabulary' | 'a dead event: it belongs under "deadEvents"' }[];
  /** A trigger event the engine can never fire that the allowlist does not know about: a new dead op landed. */
  deadNew: DeadEvent[];
  /** Allowlisted as dead but alive again (or gone): the engine was fixed, so the entry has to go. */
  deadFixed: string[];
}

export function ratchet(uncovered: Sets, vocab: Sets, allow: Allowlist, dead: DeadEvent[] = deadEvents()): Ratchet {
  const missing: Ratchet['missing'] = [];
  const stale: Ratchet['stale'] = [];
  const deadNames = new Set(dead.map(d => d.name));
  const deadNew = dead.filter(d => !allow.deadEvents.includes(d.name));
  const deadFixed = allow.deadEvents.filter(n => !deadNames.has(n));
  for (const c of CATEGORIES) {
    const allowed = new Set(allow[c]);
    for (const n of sorted(uncovered[c])) if (!allowed.has(n)) missing.push({ category: c, name: n });
    for (const n of allow[c]) {
      if (!vocab[c].has(n)) stale.push({ category: c, name: n, why: 'not in the vocabulary' });
      else if (c === 'triggers' && deadNames.has(n)) stale.push({ category: c, name: n, why: 'a dead event: it belongs under "deadEvents"' });
      else if (!uncovered[c].has(n)) stale.push({ category: c, name: n, why: 'covered' });
    }
  }
  return { missing, stale, deadNew, deadFixed };
}
