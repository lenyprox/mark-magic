// Op-coverage ratchet (phase 8h, plan 2.5f). "Does the harness actually *run* every op the engine can execute?"
//
// Two sets, computed from data rather than from a grep for op names in scenario files:
//   VOCABULARY — every literal discriminator the engine can execute. Derived from the engine itself (the `case` labels
//                of the switches that dispatch on them, plus the runtime registry lookups in src/engine/ops/_registry.ts),
//                never from a hand-maintained list, so a family that registers a new key is in the vocabulary the moment
//                it is registered and a core op that is deleted leaves it.
//   EXERCISED  — every discriminator appearing in the parsed CardDefs of the cards the harness actually names: the seats
//                and script steps of every scenario (the TS suites under test/scenarios/ and the JSON corpus under
//                data/scenarios/) plus every C('Name') / db.get('Name') literal in the unit tests.
//
// uncovered = vocabulary \ exercised, and test/lint-op-coverage.test.ts asserts it is a subset of the committed
// allowlist test/fixtures/op-allowlist.json. A new registry key is never in that allowlist, so a family that lands
// without a scenario fails the lint by construction.
//
// TEXT-DERIVED, ON PURPOSE: the engine switches are read as *text* (see `switchCases` / `unionBody` below). TypeScript
// erases the unions at runtime and the engine has no table of its own core ops, so there is nothing else to read. Every
// reader here throws when its anchor moves instead of silently returning a short list — a vocabulary that quietly
// shrinks is the one failure mode a ratchet must never have.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import { projectRoot } from '../config/paths.js';
import { AMOUNTS, AS_ENTERS, CONDITIONS, CORE_COST_KEYS, COST_PARTS, EFFECT_OPS, STATICS, TRIGGERS } from '../engine/ops/_registry.js';
import { SEAT_ZONE_FIELDS, type Scenario } from './scenarioDsl.js';
import { listScenarioFiles, readScenarioFile } from './scenarioFiles.js';

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
function engineFiles(): string[] {
  const dir = path.join(projectRoot(), 'src', 'engine');
  const out = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => path.join(dir, f));
  const agents = path.join(dir, 'agents');
  if (fs.existsSync(agents)) for (const f of fs.readdirSync(agents)) if (f.endsWith('.ts')) out.push(path.join(agents, f));
  return out.sort();
}

// ------------------------------------------------------------------ the vocabulary
/** How each category's core half was derived — echoed into the report so a reader can re-check it by hand. */
export const SOURCES: Record<Category, string> = {
  effects: "case labels of `switch (e.op)` in Game.applyEffect (src/engine/game.ts) + EFFECT_OPS keys",
  conditions: "case labels of `switch (cond.kind)` in conditionHolds (src/engine/characteristics.ts) + CONDITIONS keys",
  triggers: "case labels of `switch (ev.on)` in Game.queueTriggers (src/engine/game.ts) + TRIGGERS keys",
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
  add('triggers', switchCases(game, 'src/engine/game.ts', 'queueTriggers(event: string', 'switch (ev.on) {'));
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
export const resetVocabulary = (): void => { vocabCache = null; };

// ------------------------------------------------------------------ walking a CardDef for the discriminators it uses
const ABILITY_KINDS = new Set(['triggered', 'activated', 'static', 'spell']);
/**
 * Key → what lives under it. The ability AST is regular enough to name the category positionally, which keeps the two
 * `kind` collisions honest (an as-enters `counters` is not the effect op `counters`). `'skip'` marks a TargetSpec,
 * whose `kind` is a target kind and belongs to no category here.
 */
const HINT: Record<string, Category | 'skip'> = {
  condition: 'conditions', intervening: 'conditions', activateOnlyIf: 'conditions', unless: 'conditions', conditions: 'conditions',
  effects: 'effects', then: 'effects', else: 'effects', first: 'effects', modes: 'effects',
  event: 'triggers', events: 'triggers',
  asEnters: 'asEnters', costModifiers: 'costModifiers',
  altCosts: 'altCosts', cost: 'costParts', additionalCosts: 'costParts',
  keywords: 'keywords', extraKeywords: 'keywords', withKeyword: 'keywords',
  target: 'skip', enchant: 'skip',
};

/** The category a bare `kind` belongs to when nothing positional says: the one whose vocabulary knows the name. */
function categoryOfKind(kind: string, vocab: Sets): Category | undefined {
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

/** Every discriminator this card definition would make the engine execute. */
export function usedBy(def: CardDef, vocab: Sets, into: Sets = emptySets()): Sets {
  walk(def, undefined, into, vocab);
  // def-level flags the engine turns into effects at cast time (they never appear as `{ op }` in the AST)
  if (def.storm) into.effects.add('storm-copies');
  if (def.cascade) into.effects.add('cascade');
  return into;
}

// ------------------------------------------------------------------ the pool: cards the harness actually names
const isPlayerRef = (s: string): boolean => /^P\d+$/.test(s);

/** Every card name a scenario seeds or names in a script step (seat zones, counters keys, tapped, and each step). */
export function namesInScenario(sc: Scenario, into: Set<string>): void {
  for (const seat of sc.seats ?? []) {
    const rec = seat as unknown as Record<string, unknown>;
    for (const f of SEAT_ZONE_FIELDS) for (const n of (rec[f] as string[] | undefined) ?? []) into.add(n);
    for (const n of seat.tapped ?? []) into.add(n);
    for (const n of Object.keys(seat.counters ?? {})) into.add(n);
  }
  for (const step of sc.script ?? []) {
    const s = step as unknown as Record<string, unknown>;
    for (const k of ['cast', 'activate', 'playLand', 'turnFaceUp']) if (typeof s[k] === 'string') into.add(s[k] as string);
    if (Array.isArray(s.attack)) for (const n of s.attack) if (typeof n === 'string') into.add(n);
    for (const k of ['blocks', 'refused', 'block']) if (Array.isArray(s[k])) for (const pair of s[k] as unknown[]) if (Array.isArray(pair)) for (const n of pair) if (typeof n === 'string') into.add(n);
    if (Array.isArray(s.targets)) for (const g of s.targets as unknown[]) if (Array.isArray(g)) for (const n of g) if (typeof n === 'string' && !isPlayerRef(n)) into.add(n);
  }
}

const isScenarioList = (v: unknown): v is Scenario[] => Array.isArray(v) && v.every(x => !!x && typeof x === 'object' && typeof (x as Scenario).name === 'string' && Array.isArray((x as Scenario).script));

/** Where the pool came from, for the report's summary line. */
export interface Pool { names: string[]; scenarios: number; suites: string[]; jsonFiles: number; testFiles: number }

/**
 * Every card the harness names. The TS suites are imported the way scripts/verify-scenarios.ts imports them (a computed
 * specifier, because tsconfig's rootDir is src/ and src may not import test/); the JSON corpus is read and validated by
 * the same loader the runner uses; the unit tests are scanned for their `C('Name')` / `db.get('Name')` literals.
 */
export async function collectPool(): Promise<Pool> {
  const root = projectRoot();
  const names = new Set<string>();
  let scenarios = 0;

  const suiteDir = path.join(root, 'test', 'scenarios');
  const suites: string[] = [];
  if (fs.existsSync(suiteDir)) {
    for (const f of fs.readdirSync(suiteDir).filter(x => x.endsWith('.ts') && x !== 'dsl.ts' && !x.endsWith('.test.ts')).sort()) {
      const mod = await import(pathToFileURL(path.join(suiteDir, f)).href) as Record<string, unknown>;
      const lists = Object.values(mod).filter(isScenarioList);
      if (!lists.length) throw new Error(`op-coverage: test/scenarios/${f} exports no scenario list`);
      suites.push(f.replace(/\.ts$/, ''));
      for (const list of lists) for (const sc of list) { scenarios++; namesInScenario(sc, names); }
    }
  }

  const jsonPaths = listScenarioFiles();
  for (const p of jsonPaths) for (const sc of readScenarioFile(p).scenarios) { scenarios++; namesInScenario(sc, names); }

  // The unit tests, by regex: `C('Name')` / `db.get('Name')` is how test/helpers.ts pulls one real card into a test,
  // and `setup({ bf: [...], hand: [...] })` is how most of them seed a board — helpers.setup maps every one of those
  // names through C(), so those cards are just as played as the ones named directly. Names that master.db does not
  // know (a token name, a local variable) resolve to nothing and drop out in exercisedBy.
  const testDir = path.join(root, 'test');
  const testFiles = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter(f => f.endsWith('.ts')).sort() : [];
  for (const f of testFiles) {
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    for (const m of src.matchAll(/\b(?:C|db\.get)\(\s*(['"])([^'"\n]+)\1\s*\)/g)) names.add(m[2]);
    for (const m of src.matchAll(/\b(?:bf|hand|library|libraryTop|graveyard|exile|command|deck)\s*:\s*\[([^\][]*)\]/g))
      for (const q of m[1].matchAll(/(['"])([^'"\n]+)\1/g)) names.add(q[2]);
  }
  return { names: [...names].sort(), scenarios, suites, jsonFiles: jsonPaths.length, testFiles: testFiles.length };
}

// ------------------------------------------------------------------ the report
export interface CoverageReport {
  at: string;
  pool: { cards: number; resolved: number; scenarios: number; suites: string[]; jsonFiles: number; testFiles: number };
  vocabulary: Lists; exercised: Lists; uncovered: Lists;
  byOp: Record<string, string[]>;
  sources: Record<Category, string>;
}

/** Parse the named cards and fold every discriminator they use into one set of sets. Unknown names are ignored. */
export function exercisedBy(names: string[], vocab: Sets, db = CardDB.shared()): { sets: Sets; resolved: number } {
  const sets = emptySets(); let resolved = 0;
  for (const n of names) { const def = db.get(n); if (!def) continue; resolved++; usedBy(def, vocab, sets); }
  return { sets, resolved };
}

export const difference = (a: Sets, b: Sets): Sets =>
  Object.fromEntries(CATEGORIES.map(c => [c, new Set([...a[c]].filter(n => !b[c].has(n)))])) as Sets;

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

/** The whole report. `withExemplars` costs one full pool walk. */
export async function report(opts: { withExemplars?: boolean } = {}): Promise<CoverageReport> {
  const vocab = vocabulary();
  const pool = await collectPool();
  const { sets: used, resolved } = exercisedBy(pool.names, vocab);
  const uncovered = difference(vocab, used);
  return {
    at: new Date().toISOString(),
    pool: { cards: pool.names.length, resolved, scenarios: pool.scenarios, suites: pool.suites, jsonFiles: pool.jsonFiles, testFiles: pool.testFiles },
    vocabulary: toLists(vocab), exercised: toLists(used), uncovered: toLists(uncovered),
    byOp: opts.withExemplars ? exemplars(uncovered, vocab) : {},
    sources: SOURCES,
  };
}

// ------------------------------------------------------------------ the ratchet
export const ALLOWLIST_FILE = (): string => path.join(projectRoot(), 'test', 'fixtures', 'op-allowlist.json');
export const REPORT_FILE = (): string => path.join(projectRoot(), 'data', 'master', 'op-coverage.json');

export function readAllowlist(file = ALLOWLIST_FILE()): Lists {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const out = {} as Lists;
  for (const c of CATEGORIES) {
    const v = raw[c];
    if (v !== undefined && !(Array.isArray(v) && v.every(x => typeof x === 'string'))) throw new Error(`${file}: "${c}" must be a list of strings`);
    out[c] = ((v as string[] | undefined) ?? []).slice();
  }
  for (const k of Object.keys(raw)) if (!(CATEGORIES as readonly string[]).includes(k) && k !== '//') throw new Error(`${file}: unknown category "${k}"`);
  return out;
}

export interface Ratchet {
  /** Uncovered and NOT allowlisted: a new op landed without a scenario. */
  missing: { category: Category; name: string }[];
  /** Allowlisted but covered now (or gone from the vocabulary): the list has to shrink. */
  stale: { category: Category; name: string; why: 'covered' | 'not in the vocabulary' }[];
}

export function ratchet(uncovered: Sets, vocab: Sets, allow: Lists): Ratchet {
  const missing: Ratchet['missing'] = [];
  const stale: Ratchet['stale'] = [];
  for (const c of CATEGORIES) {
    const allowed = new Set(allow[c]);
    for (const n of sorted(uncovered[c])) if (!allowed.has(n)) missing.push({ category: c, name: n });
    for (const n of allow[c]) {
      if (!vocab[c].has(n)) stale.push({ category: c, name: n, why: 'not in the vocabulary' });
      else if (!uncovered[c].has(n)) stale.push({ category: c, name: n, why: 'covered' });
    }
  }
  return { missing, stale };
}
