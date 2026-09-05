<!-- Copied verbatim from ~/.claude/plans/immutable-greeting-puppy.md (approved by the owner on 2026-09-04). This is the live program plan; docs/HANDOFF.md tracks progress against it. -->

# Plan: every card scripted — harness hardening, then an ultracode build to 100% simulation coverage

## Context

The Vault engine simulates 11,541 of 34,513 playable oracle cards (33.4%). The rest fail because at least one
oracle line is not understood, and every remaining line is essentially unique: 22,972 cards carry 28,934 distinct
normalised clause shapes, 26,626 of them singletons. Parser rules cannot get there (the top blocker is worth 60
cards); the approved program plan already chose **per-card scripts over a small verb vocabulary** (B7/B9). The
plumbing exists (`src/cards/scripts.ts`, `scripts:draft`, `scripts:check`) but zero scripts are written, because
almost every failing card needs an engine op that does not exist yet — the vocabulary, not the wording, is the
bottleneck.

This plan does three things, in order:

1. **Harden the test/evaluation system** so that thousands of LLM-written scripts can be trusted: an engine
   extensibility layer (registries + declaration merging) so mechanic families can be added in parallel without
   touching core files; a script verification pipeline (schema, freshness, sandbox with per-ability reachability,
   round-trip text diff, blind behavioural scenarios, an independent judge); engine-wide gates (parallel pool
   sandbox, fuzzer with shrinking, golden event streams, fidelity ratchet, parse snapshot diff, op-coverage lint);
   and a faster `verify:quick / verify:all / verify:deep` ladder that speeds up only through caching and
   parallelism (simulation fidelity — game counts, turn limits, optimiser blocks — is untouched).
2. **Grow the vocabulary in waves** (Phase 9): a composition core first (the ~9,500 cards whose lines are only
   generic verbs), then the rules-depth families (control, cost alteration, combat restrictions, replacement
   effects, copies, layers, planeswalkers, dice/piles), then the ~100 named keywords, then whatever the script
   agents report as missing (blocked-by loop) until the queue is dry.
3. **Write, test and judge every script** (Phase 10) with Opus subagents orchestrated by this session (Fable):
   owner's six decks first (179 cards), then EDHREC top-5k Commander-legal, then the rest.

### Decisions taken with the user (2026-09-04)

- **Denominator = paper pool**: every card printed for paper/MTGO (≈32,100; exact count from `src/cards/pool.ts`).
  Un-/"funny" cards (1,402), Arena-only/Alchemy (≈980) and ante cards stay visible as separate tiers and are not
  part of the 100%.
- **Evidence bar = mechanical gates + blind scenario + independent judge** for every card before it counts as covered.
- **Run mode = waves with check-ins**: one wave per launch, commit, report numbers, wait for go-ahead.
- Script subagents run on **Opus**; this session orchestrates (workflows, merges, gates, commits, memory).

### Measured today

| Fact | Value |
|---|---|
| Playable oracle cards / fully simulated | 34,513 / 11,541 (33.4%) |
| Cards needing scripts | 22,972 — 14,865 with one unparsed line, 5,405 two, 2,702 three+ |
| Distinct clause shapes / singletons | 28,934 / 26,626 |
| Cards whose unparsed lines are only generic verbs (destroy, pump, counters, draw, tokens, damage, life, library, auras, tap, mana) | 9,500 |
| Rules-depth families (cards touching) | control change 1,663 · cost alteration 1,632 · combat restrictions 1,521 · replacement/instead 1,347 · keyword actions 1,079 · piles/choices 761 · copy/clone 749 · layers P/T/type 742 · transform 355 · planeswalkers 306 · dice/coin 245 · sagas 176 |
| Named keywords | ~100 families at 5–73 cards each (suspend 67, madness 63, foretell 58, ninjutsu 45, bestow 43, banding 43, plot 39, station 38, mutate 37, entwine 33 …) |
| Exclusions inside the 22,972 | Un/funny 1,315 · Arena-only 929 · ante/draft/attractions ≈ 282 |
| Owner's six decks | 179 of 444 distinct cards unscripted |
| EDHREC-ranked unscripted | 441 in top 1k · 3,315 in top 5k · 7,063 in top 10k · 20,714 ranked |
| Harness timings (8 cores, i7-7700K) | `npm test` 268 tests 13 s · typecheck:all 6 s · coverage:pool 9 s · verify:pool 19 s (11.5k cards) · bench 25 s (45.8 games/s 60-card, 4.8 Commander, 903 inert-text hits per 100 Commander games) |
| Toolchain facts | root `typescript` 7.0.2 has no JS compiler API (`ts.createProgram` undefined); `apps/web` has TS 5.9; `core.autocrlf=true`, tree is LF; every shipped agent falls back to `defaultAnswer`; tests that write user.db use temp dirs; `.claude/` worktrees have no `node_modules` and no `data/` |

---

## Part 1 — Architecture that lets Opus agents extend the engine in parallel (Phase 8a, serial)

One Opus agent, high effort, in the main checkout, adversarially reviewed by three lenses before merge. Nothing
else runs during 8a. Everything below is a contract the later waves rely on; a family that needs something not
listed here returns `coreChangeNeeded` instead of editing core.

### 1.1 Registry and hook points

`src/engine/ops/types.ts` defines `FamilyModule`; each family is `src/engine/ops/<family>.ts` (default export);
`src/engine/ops/_registry.ts` is **generated** by `npm run gen:registry` from the directory listing (duplicate keys
are a hard error naming both files; barrels are marked `linguist-generated`, never hand-edited, regenerated after
every merge).

```ts
export interface OpCtx { g: Game; s: GameState; item: StackItem; p: PlayerId; src: GameObject; T: TargetRef[]; idx: number; amt(a: Amount): number; objs(): GameObject[]; players(): PlayerId[]; apply(e: Effect): Promise<void> }
export interface FamilyModule {
  name: string;
  effects?: Record<string, (e: any, c: OpCtx) => void | Promise<void>>;
  conditions?: Record<string, (cond: any, s: GameState, src: GameObject) => boolean>;
  amounts?: Record<string, (a: any, s: GameState, ctrl: PlayerId, x: number, src?: GameObject, ctx?: AmountCtx) => number>;
  triggers?: Record<string, (ev: any, perm: GameObject, ctx: TriggerCtx, s: GameState) => boolean>;
  statics?: Record<string, (e: any, src: GameObject, o: GameObject, s: GameState, m: Mods) => void>;
  costParts?: Record<string, { payable(...): boolean; pay(...): Promise<boolean> }>;
  asEnters?: Record<string, (a: any, o: GameObject, ctx: EnterCtx, g: Game) => Promise<void> | void>;
  replacements?: { zoneMove?(...): ZoneMoveOverride | null; damage?(...): number; draw?(...): boolean; counters?(...): number; lifeGain?(...): number };
  steps?: Partial<Record<Step | 'cleanup-end' | 'turn-start', (g: Game, ap: PlayerId) => Promise<void> | void>>;
  sba?: (g: Game) => boolean;
  legalActions?: (g: Game, p: PlayerId, out: LegalAction[], sorceryTiming: boolean) => void;
  actions?: Record<string, (g: Game, p: PlayerId, a: any) => Promise<boolean>>;
  decisions?: Record<string, (s: GameState, me: PlayerId, d: any) => unknown>;
  keywordHooks?: { canBlock?(...): boolean | undefined; canAttack?(...): boolean | undefined; blockCheck?(...): boolean; blockFixup?(...): void; combatDamage?(g: Game, assignments: Damage[]): void };
  triggerSources?: (s: GameState) => GameObject[];          // emblems, command-zone statics
  events?: Record<string, { logged?: boolean; cr?: string; render?(ev: any, pname: (p: PlayerId) => string): string }>;
  redact?: (o: GameObject, viewer: PlayerId) => void;      // scrub hidden ext state
  cleanupEot?: (g: Game, o: GameObject) => void;
  schema?: never;                                           // zod schemas live in <family>.schema.ts (tooling only)
  render?: Record<string, (e: any) => string>;              // round-trip English per op (see 2.3)
}
```

One-line insertions in core (existing switch cases stay where they are):

| File : function | Insertion |
|---|---|
| `src/engine/game.ts:applyEffect` | `default:` → `EFFECT_OPS[e.op]?.(e, ctx)` else emit `unsimulated` with clause `op <name>`; `ctx` is built from the locals already computed at the top of the function |
| `src/engine/characteristics.ts:conditionHolds` / `evalAmount` | `default:` → `CONDITIONS[kind]` / `AMOUNTS[count]` lookups |
| `src/engine/game.ts:queueTriggers` | inner `switch (ev.on)` `default:` → `TRIGGERS[ev.on]`; iterate `allPermanents(s)` plus every `triggerSources(s)` |
| `src/engine/characteristics.ts:computeStaticMods` | after anthem/self blocks → `STATICS[e.kind]`; `Mods.flags` gets an index signature; `Mods.setPT?` slot applied before additive terms (layer 7b-lite) |
| `characteristics.ts:canAttack / canBlock` | consult `CAN_ATTACK[] / CAN_BLOCK[]` before `return true`; `combatFrom` validates blocks with `BLOCK_CHECKS[]` and applies `BLOCK_FIXUPS[]` (lure, "blocks if able") |
| `src/engine/cost.ts:nonManaCostPayable` + `game.ts:payCost` | fold `COST_PARTS[k]` for non-core cost keys; `spellManaCost(def, alt, kicked, modes)` gets `modes` so entwine/spree/multikicker add mode costs |
| `src/engine/legal.ts:legalActions` | `for (const f of LEGAL_PROVIDERS) f(g, p, out, sorceryTiming)` before `return out`; export `castActionsFor`, `describeSpec`; `castSpell`'s `from` gate consults `CAST_FROM_HOOKS`, its `free` computation consults `FREE_CAST_HOOKS`; `AltCost.from` widens to `CastZone` |
| `game.ts:performAction` | `default:` → `ACTIONS[action.type]` |
| `game.ts:enterBattlefield` | `switch (a.kind)` `default:` → `AS_ENTERS[a.kind]` |
| `game.ts:moveTo` (after the commander redirect), `dealDamage`, `dealDamageToPlayer`, `draw`, `replaceCounters`, `gainLife` | fold `REPLACEMENTS[]` (generic "if … would …, instead" and prevention shields live here); `LEAVE_HOOKS[]` where `exiledUntilLeaves` is handled |
| `game.ts:runTurnFrom` / `runTurn` / `combatFrom` | `STEP_HOOKS[step][]` after each step's built-in work, plus `'turn-start'` and `'cleanup-end'`; `EOT_CLEANUP[]` inside the end-of-turn wipe loop; an extra-combat loop (`s.ext.extraCombats`) after main 2 |
| `game.ts:checkSBA` | `for (const h of SBA_HOOKS) if (h(this)) again = true` inside the loop |
| `game.ts:combatDamage` | `COMBAT_DAMAGE_HOOKS[]` after assignments are built, before they are dealt |
| `src/engine/agents/defaults.ts:defaultAnswer` | `default:` → `DECISION_DEFAULTS[d.kind]` |
| `src/engine/events.ts` | `EventRegistry` augmentation; `LOGGED`, `citation`, `renderEvent` consult `EVENT_META[type]` in their defaults |
| `src/engine/state.ts` | `GameObject.ext?`, `Player.ext?`, `GameState.ext?` (JSON-plain bags: `o.ext.suspended`, `pl.ext.emblems`, `s.ext.dayNight`); `clone.ts` deep-copies `ext` (plain objects/arrays only), `serialize.ts` passes it through, `view.ts:redact` calls `REDACT_HOOKS` |
| `characteristics.ts:defOf` | consults `o.ext.copyOf` (clone/copy effects) via `s.ext.defs` so copies survive clone/serialize |
| `legal.ts:targetOptionsFor` | `TargetSpec.kind` becomes `CoreTargetKind \| keyof TargetKindRegistry` with `TARGET_KINDS[kind](g, controller, source)` |
| token abilities | `treasure/clue/food/spawn` hardcoding in `activateAbility`/`legalActions` replaced by a `TOKEN_ABILITIES` registry keyed by token name |
| phasing | `o.ext.phasedOut` honoured by `allPermanents` callers via `isPhasedOut(o)` (treated as "not on the battlefield") |

Non-augmentable, stay central: `Step` (extra combats re-run `combatFrom`), `Zone` (foretell/madness use `exile` + `ext`).

### 1.2 Declaration merging (families never edit `types.ts`)

`src/cards/types.ts` renames its unions to `Core*` and exposes empty registries:

```ts
export interface EffectRegistry {}      export type Effect = CoreEffect | EffectRegistry[keyof EffectRegistry];
export interface ConditionRegistry {}   export type Condition = CoreCondition | ConditionRegistry[keyof ConditionRegistry];
export interface TriggerRegistry {}     export type TriggerEvent = CoreTriggerEvent | TriggerRegistry[keyof TriggerRegistry];
export interface StaticRegistry {}      export type StaticEffect = CoreStaticEffect | StaticRegistry[keyof StaticRegistry];
export interface AmountCountRegistry {} export type AmountCount = CoreAmountCount | keyof AmountCountRegistry;
export interface KeywordRegistry {}     export type Keyword = CoreKeyword | keyof KeywordRegistry;
export interface AltCostIdRegistry {}   export type AltCostId = CoreAltCostId | keyof AltCostIdRegistry;   // state.ts re-exports
export interface AsEntersRegistry {}    export type AsEnters = CoreAsEnters | AsEntersRegistry[keyof AsEntersRegistry];
export interface AbilityCostExt {}      export interface AbilityCost extends AbilityCostExt { /* core fields */ }
```
plus `DecisionRegistry`, `ActionRegistry`, `DelayedAtRegistry` in `state.ts` and `EventRegistry` in `events.ts`.
A family augments from its own file (`declare module '../../cards/types.js' { interface EffectRegistry { suspend: SuspendEffect } }`).
`keyof {}` is `never`, so `Core | never` collapses today; discriminant narrowing keeps working because every variant
carries a literal `op`/`kind`/`on`.

### 1.3 Parser rule registry

`src/cards/rules/<family>.ts` exports `{ effects?: Rule[]; lines?: LineRule[]; triggers?; conditions?; statics?; costs? }`;
generated `src/cards/rules/_registry.ts`. `parse.ts` consults the registry **after** its built-ins in
`parseEffectSentence`, in the line loop right before `unknown(def, line)` (and before the keyword bail-out regex so
registered keywords are claimed), and in `parseTrigger/parseCondition/parseStatic/parseCostPhrase` before returning
unknown. Built-ins first keeps every existing parse byte-identical; the parse snapshot (2.5e) proves it per merge.
`OracleRow.keywords` (Scryfall tags, ignored today) is passed to line rules. `export const PARSER_VERSION` is added.

### 1.4 Composition core (Phase 9.0 — the first vocabulary wave, serial, one Opus agent)

Cross-family AST additions in `CoreEffect`/`Amount`, evaluated in `applyEffect`/`evalAmount` the way `conditional`
and `optional-then` recurse today; the parser gains rules for the common wordings so `coverage:pool` rises on its own:

```ts
type Ref = 'self' | 'that' | 'those' | 'triggering' | 'target:<i>' | 'enchanted' | 'equipped' | 'sacrificed' | 'exiled-with';
| { op: 'for-each'; over: (Filter & { zone?; who? }) | 'those' | 'targets'; do: Effect[] }     // binds `that` per iteration
| { op: 'bind'; as: 'that'; from: 'targets' | 'affected' | 'triggering' }
| { op: 'reflexive'; when: 'you-do'; effects: Effect[] }                                          // "When you do, …"
| { op: 'scoped'; who: 'you'|'each-player'|'each-opponent'|'target-player'|'that-player'|'controller-of-that'; do: Effect[] }
| { op: 'may'; effects: Effect[]; prompt?: string }
| { op: 'unless-pays'; who; cost: AbilityCost | { mana: ManaCost }; otherwise: Effect[] }
| { op: 'move'; what: TargetSpec | Ref | { filter; zone; who; count: Amount | 'all'; choose?: 'you'|'owner'|'random' }; to: Zone; pos?; controller?; tapped?; faceDown?; withCounters?; until?: 'leaves'|'eot'|'your-next-end-step' }
| { op: 'set-pt'; target; power: Amount; toughness: Amount; base?: true; duration }               // via Mods.setPT
| { op: 'lose-abilities'; target; keywords?: Keyword[] | 'all'; duration }                         // o.ext.lost honoured by abilitiesOf/keywords
| { op: 'exchange'; what: 'life' | 'control'; a; b }
Amount |= { count: AmountCount | 'objects'; filter?; zone?; who?; plus?; times?; half?: 'up'|'down'; max? } | { diff: [Amount, Amount] } | { sum: Amount[] } | { max: Amount[] } | { min: Amount[] } | { prop: 'power'|'toughness'|'mv'|'life'|'cards-in-hand'; of: Ref | 'you' | 'that-player' | 'target-player' }
TargetSpec |= { kind: 'multi'; specs: TargetSpec[] }
DelayedTrigger.at |= 'this-turn:dies' | 'this-turn:ltb' | 'next-turn:upkeep' | 'until-eot:end'  (bind: 'that' | 'those')
```

### 1.5 Script format v2 and pool tiers

- Layout: `data/scripts/<2-hex>/<oracle_id>.json` (256 shards; `ScriptStore.load()` walks one level; `scripts:shard`
  migrates flat files). Scenarios mirror it under `data/scenarios/<2-hex>/`.
- `source: 'generated' | 'llm' | 'reviewed' | 'hand'`; `put()` precedence `hand > reviewed > llm > generated`; an
  `llm` script may overwrite an `llm` script only when the existing one has no passing verification.
- New fields: `backFace` (same shape as the front; `applyScript` applies it to `def.backFace` set at `parse.ts:1365`),
  `ignore: [{ line, reason: 'draft-matters'|'ante'|'outside-the-game'|'deck-construction'|'reminder-only'|'un-physical'|'digital-only' }]`
  (exact normalised line; rejected when the line contains a simulable verb), `covers: ['*']` allowed only with
  `mode: 'replace'`, and a tool-owned `verification` block:

```ts
interface Verification {
  at: string; parserVersion: number; registryHash: string; oracleHash: string; scriptHash: string;   // scriptHash = fnv of the JSON minus `verification`
  schema: 'ok'|'fail'; lint: 'ok'|'warn'|'fail';
  sandbox: { seats2: 'ok'|'throws'|'invariant'|'unreachable'; seats4: same; abilities: { index: number; reached: boolean; how?: string }[] };
  roundTrip: { score: number; lowest: { text: string; rendered: string; score: number }[] };
  scenarios: { file: string; passed: number; failed: number; names: string[] };
  judge?: { model: string; verdict: 'faithful'|'unfaithful'|'uncertain'; issues: string[]; at: string }[];
  status: 'scripted' | 'verified' | 'tested' | 'judged';   // derived (see 2.4)
  problems: string[];
}
```
- Freshness: `oracleHash` mismatch → script stale (not applied, today's rule); `parserVersion`/`registryHash`/`scriptHash`
  mismatch → verification stale (dashboard counts the card as `scripted`, `scripts:verify --stale` re-runs only those).
- `src/cards/pool.ts`: `tierOf(row)` → `paper` (games ∋ paper|mtgo, `set_type ≠ funny`, no Attraction/Contraption/Hero
  card type/stickers, not ante) | `digital` (Arena-only) | `un`; `CardDB.all({ tier })`; every report carries the tier.
- Validation without the TS compiler API: `zod` (devDependency; tooling only). `src/cards/schema.ts` hand-writes the
  core schemas; each family adds `src/engine/ops/<family>.schema.ts`; generated `_schemas.ts` composes
  `EffectSchema = z.discriminatedUnion('op', …)` etc. `test/schema-types.test.ts` pins schema to types at compile time:
  `const _e: Equals<z.infer<typeof EffectSchema>, Effect> = true` (same for Condition, TriggerEvent, StaticEffect,
  Ability, CardScript). `npm run scripts:schema` emits `data/scripts/schema.json` for editors and prompts.

---

## Part 2 — Harness hardening (Phase 8b–8k, parallel Opus agents in worktrees, one `harness-wave` workflow)

Each item is a NEW file set (no core edits beyond 8a), implemented by one Opus agent, reviewed by two adversarial
lenses (correctness, engine-integration), merged serially by the orchestrator with `verify:quick` per merge.

### 2.1 Worktree-safe paths (8b, tiny, first)
`src/config/paths.ts`: when `<root>/data/master/master.db` is missing and `<root>/.git` is a *file*, resolve the main
checkout through its `gitdir:` pointer (equivalent of `git rev-parse --git-common-dir`) and use that `data/` for
`MASTER_DB/USER_DB/IMAGE_DIR/DATA_DIR`; scripts and scenarios stay in the worktree (tracked). No junctions, ever.
`.gitattributes`: `* text=auto eol=lf`. `MTG_PARSE_CACHE=0` escape hatch (see 2.6).

### 2.2 `scripts:verify` — the mechanical gate (8c)
`scripts/scripts-verify.ts -- --batch <file> | --ids … | --changed | --stale`, stages in order (a failure records a
problem and continues, except schema which stops that card):
1. **Schema** — `CardScriptSchema.strict().safeParse` (typos cannot pass).
2. **Freshness** — `oracleHash`, `parserVersion`, `registryHash`.
3. **Registry** — every `op/kind/on` exists; no `unknown` for `source !== 'generated'`; `applyScript(def).fullyParsed`.
4. **Lint** (`src/cards/lint.ts`) — counter names from a registry + names the card text mentions; `Filter.subtypes`
   against master.db's distinct subtypes; keywords/target kinds/amount counts against the registries; every
   `covers`/`ignore` line matches an oracle line; triggers impossible for the card type fail; `aiHints.role` enum.
5. **Sandbox** — `src/verify/sandbox.ts` (today's `trial()` extracted): 2-seat and 4-seat games, then per-ability
   reachability probes (etb → cast; dies → lethal damage + SBA; attacks/blocks/combat damage → `simulateCombat`;
   upkeep/end/draw/combat-begin → `playTurns(1)`; cast-filter → cast a matching filler spell; tapped/targeted →
   `setTapped`/`Shock`; landfall → play a land; activated → `performAction`; static → compare a probe creature's
   P/T/keywords/flags with and without the permanent). Unreachable is a warning listed for the scenario author.
6. **Round-trip** — `src/cards/render.ts`: `renderAbility(a)`/`renderEffect(e)` with deterministic templates per op
   (families contribute `render` next to their ops). Score per oracle line against the ability whose `text` names it:
   all numbers (`\d+|X`) must appear → else 0; keyword/zone/counter vocabulary present in the line must appear; token
   Jaccard over lemmatised words. Card score = min over lines; **≥ 0.55** for `verified`; lines < 0.4 listed as `lowest`.
7. **Write-back** — `verification` (minus `scenarios`/`judge`) into the script; batch report
   `data/scripts/reports/<batch>.json` `{ batch, at, parserVersion, registryHash, cards: [{ oracleId, name, status, schema, lint, sandbox, roundTrip, problems }], summary }` (gitignored).
Target ≤ 15 s for a 30-card batch (`--ids` never parses the whole pool).

### 2.3 Blind behavioural scenarios (8d)
- `data/scenarios/<2-hex>/<oracle_id>.json` = `{ oracleId, name, scenarios: Scenario[] }` in the `test/scenarios/dsl.ts`
  vocabulary with `log` as a regex source string and `{ attack, blocks }` as data. The runner rejects a scenario that
  never places the card under test and requires `cr`.
- `dsl.ts` additions: `playerCounters`, `zoneCount`, `handCount`, `graveyardCount`, `libraryCount`, `stackNames`,
  `mana`, `attachedTo`, `faceDown`, `commanderDamage`, `noLog`, `ext` (family state).
- `scripts/verify-scenarios.ts -- [--workers 8] [--ids …] [--changed] [--family <name>]`: round-robin over
  `worker_threads` booted by `src/sim/nodeWorker.boot.mjs` (`src/verify/scenarioWorker.ts`), ~12 ms/scenario → 25k in
  ~40 s. `test/scenarios-data.test.ts` runs a sample (owner's decks + 200 seeded) so `npm test` stays fast.
- `test/scenarios/README.md`: the DSL reference blind scenario authors read (they never see scripts).

### 2.4 Tiers and promotion
`src/cards/scriptState.ts` derives state from files only: `parsed` (parser alone) · `todo` · `blocked`
(`data/scripts/blocked/<2-hex>/<oracle_id>.json { clause, needs[], wave, attempts }`, auto-cleared when the family
appears in the registry) · `scripted` · `verified` (mechanical pass) · `tested` (+ ≥1 blind scenario per ability
passes, or unreachable abilities excused) · `judged` (+ judge faithful; two judges by majority for the owner's decks
and EDHREC top-1k, one elsewhere) · `reviewed` (a person; `scripts:promote --human`) · `stale`.
**Dashboard "covered" = `judged`**; "simulated" = `scripted+` (what the sim uses). `scripts:promote -- --result <json>`
is deterministic and run only by the orchestrator; it refuses to promote if `git status --porcelain -- src test apps scripts`
is dirty. Judge-rejected cards get their issues written to `verification.judge` and one re-author pass.

### 2.5 Engine-wide gates (8e–8h)
- (a) **Parallel pool sandbox** — `scripts/verify-pool.ts` coordinates 8 workers (`src/verify/poolWorker.ts`);
  `--seats 2|4|both`, `--ids`, `--changed`, `--tier paper`; per-card rows keyed by oracle id + `by_ability_reachability`.
  ≈ 18 s for the full pool × both seat modes.
- (b) **Fuzzer** — `scripts/fuzz-games.ts -- --games 2000 --seed N --seats 2|4 --pool judged|scripted|all --format freeform|commander`:
  seeded random decks from the chosen tier; `GameOptions.assertInvariants: 'game'|'event'` calling
  `src/engine/invariants.ts` (today's sandbox checks plus: zone/field consistency, attachment legality, symmetric
  `blocking/blockedBy` only in combat, no tapped cards off the battlefield, tokens never in hand/library/graveyard after
  SBA, eliminated players' zones empty, monotone `version`, empty EOT state after cleanup, unique ids incl. `s.delayed`);
  errors bucketed by normalised stack signature; ddmin shrink to the minimal deck; `data/master/fuzz-failures.json`
  `{ buckets: [{ signature, n, minimalDecks, firstSeed, firstGame }] }`; `--repro <bucket>`. Engine-fix agents take one
  bucket each and must add a pinning scenario.
- (c) **Golden event streams** — `test/fixtures/golden/<pair>.json` (committed) for `mono-red-burn/mono-green-stompy`,
  `ub-control/wu-fliers`, and a 3-player pod: 30 games each with `{ seed, winner, turns, eventVector, logHash }`;
  `test/golden-games.test.ts` names the games that changed and the first differing log line; `npm run golden:accept`.
  The sample decks are fully simulated today, so this is a true regression gate.
- (d) **Fidelity ratchet** — `scripts/fidelity.ts`: 60 seeded games per owner-deck pairing (three pairings + one
  4-player pod), `unsimulated hits per game`; `test/fixtures/fidelity.json` ceilings (10% RNG slack);
  `npm run fidelity:accept` only lowers. `GameRecordLite.unsimulatedClauses` (`${name}|${clause}` → hits) via a
  `Game.onEvent` listener in `src/sim/batch.ts:playOne`; `MatchAggregate.topUnsimulated` feeds the optimiser report
  and the dashboard ("which inert text actually fires").
- (e) **Parse snapshot** — `data/master/parse-snapshot.json` (added to the `.gitignore` allowlist): per-card AST hash
  for all 34,513 cards + `parserVersion` + `registryHash`; `npm run parse:diff` (9 s, bypasses the cache) lists changed
  cards grouped by unparsed-clause delta; `parse:accept` rewrites; `verify:all` fails on an unaccepted diff.
- (f) **Op coverage lint** — `test/lint-op-coverage.test.ts`: every registered op/condition/trigger/static/amount is
  exercised by ≥1 scenario (TS or JSON) or unit test; an allowlist that can only shrink.
- (g) **Determinism** — `test/determinism.test.ts` plays the smoke pair twice in-process and once in a worker and
  compares event vectors; grep-lint forbids `Math.random(` outside `src/engine/rng.ts`. `sim:batch --verify` stays.
- Lint extensions: `lint-direct-writes` covers `src/engine/ops/**` with ceiling 0 for direct writes (ops must use
  `setTapped/addCounters/gainLife/loseLife/dealDamage/moveTo/enterBattlefield/addMana/attach/changeControl/emit`);
  `lint-nplayer` scans `src/engine/ops`; a lint forbids `node:` imports and `Set/Map` inside `ext` under `src/engine/ops`.

### 2.6 Speed ladder (8i) — fidelity untouched, gains only from caching and parallelism

| Command | Contents | Target |
|---|---|---|
| `verify:quick` | `typecheck` · `node --test test/{schema-types,lint-*,scripts,determinism}.test.ts` · `scripts:check --changed` | ≤ 15 s |
| `verify:all` | typecheck:all · `npm test` · `scripts:check --all` · `coverage:pool` · `verify:pool --workers 8 --changed` · `verify:scenarios --workers 8` · `parse:diff` · `bench:games` | ≤ 2.5 min full, ≈ 70 s incremental |
| `verify:deep` | `fuzz --seats 2 --games 2000` + `--seats 4 --games 500` · goldens · fidelity · Playwright against `next build --webpack` + `next start -p 3199` | ≈ 15 min, per V-wave / every 3rd S-wave |

Parse cache: `data/master/parse-cache.sqlite` (gitignored) keyed by `(oracleId, oracleHash, scriptHash, PARSER_VERSION, registryHash)`
→ serialised `CardDef`; consulted by `CardDB.parse()`; `coverage:pool`, `scripts:check`, `verify:dashboard` and deck
loading all hit it. Game counts, `maxTurns` and optimiser blocks are not changed anywhere.

### 2.7 Dashboard v2 (8j)
`scripts/verify-dashboard.ts` → `verification.json` adds `pool: { paper, digital, un }` tiers (each `{ total, parsed, scripted, verified, tested, judged, reviewed, pct_simulated, pct_covered }`),
`slices` (commanderLegal, ownerDecks with per-card status, edhrecTop1k/5k, byType), `scripts` (byStatus, stale,
staleVerification, ignoredLines by reason), `fidelity` (pairings + topClauses), `fuzz`, `golden`, `blocked` (family →
cards → proposed ops), `sandbox.unreachableAbilities`. `apps/web/components/coverage/CoveragePage.tsx`: three headline
stats (Simulated / Verified / Covered, paper pool), owner's-decks table, fidelity card, blocked-families list.

### 2.8 Fan-out tooling (8k)
- `npm run gen:registry` (barrels for ops, rules, schemas, renders), `npm run vocab:doc` → `data/scripts/VOCABULARY.md`
  (from registries + `docs/vocabulary/<family>.md` + two example scripts per op).
- `npm run scripts:queue -- --wave S1 --select "edhrec<=5000 commander:legal pool:paper" --only-unlocked --size 30 --out data/scripts/batches/S1`:
  derive state → drop `judged/reviewed/blocked` → group by primary family (rarest of the card's taxonomy families) →
  sub-group by card type → order by EDHREC rank. Batch file per 30 cards: oracleId, name, type line, P/T/loyalty,
  layout + back-face facts, oracle text, parser draft, unparsed lines verbatim, Scryfall keywords, families, rank,
  state, up to 3 nearest **judged** scripts (token-Jaccard over normalised clauses) as examples; per batch the family's
  vocabulary excerpt and the DSL cheat-sheet; `manifest.json`. Blind-scenario authors receive a stripped copy (no ASTs).
- `scripts:promote`, `scripts:quarantine --batch <n>` (moves to `data/scripts/_quarantine/…`, ignored by `ScriptStore`),
  `scripts:needs` (aggregates `blocked/**` → `data/scripts/needs.json` by family with cards, example clauses, proposals),
  `scripts:render -- --ids …`, `scripts:shard`, `scripts:schema`.
- `docs/vocabulary/README.md` + `src/engine/ops/_example.ts` (the template every family agent reads).

Gate for Phase 8: `verify:all` and `verify:deep` green, goldens/fidelity/parse-snapshot fixtures accepted, dashboard
shows tiers, bench ≥ 45 games/s 60-card and ≥ 4.8 Commander. Commits `Phase 8a … 8k`.

---

## Part 3 — Vocabulary program (Phase 9)

Ordering principle: cards unlocked per agent-hour. Each family module = `src/engine/ops/<family>.ts` (+ `.schema.ts`),
`src/cards/rules/<family>.ts`, `test/scenarios/<family>.ts` (≥1 scenario per op and per keyword parameter, `cr`
cited), `docs/vocabulary/<family>.md`; `gen:registry`; `verify:quick` + `parse:diff` reviewed; commit on the branch.

| Wave | Content | Modules | Cards touched |
|---|---|---|---|
| **9.0 composition core** (serial, 1 agent, ~6 h) | §1.4 ops, `Ref` resolution, arithmetic amounts, `move`, `set-pt`, `lose-abilities`, `exchange`, reflexive + this-turn delayed triggers, multi-target specs + parser rules | 1 | the 9,500 generic-only cards become expressible |
| **9.1 rules depth** (parallel) | control change with durations (`o.ext.controlReturn`) · cost alteration statics (`cost-adjust` with `Amount`, `cast-from {zone, filter}`, free-cast permissions) · combat restrictions (must-be-blocked, "except by N", blocks-if-able, extra combats, "as though unblocked") · generic replacement `{ would, instead }` + prevention shields · keyword actions bundle (investigate, adapt, bolster, support, manifest, populate, goad, incubate, connive, learn, discover, forage, clash, monstrosity, exert, collect evidence, cloak, endure, harness, suspect, behold, villainous choice, manifest dread) · piles/opponent-chooses/votes decisions · copy/clone (`asEnters.copy-of`, `become-copy`, new targets for copies) · layers-lite (base P/T, type/colour changes with durations, changeling) · transform/meld/flip triggers · planeswalkers + emblems (`pl.ext.emblems`, `triggerSources`) · dice/coin on `g.rng` with a `random` event · saga chapter composition | 12 | ≈ 9,900 |
| **9.2 named keywords** (parallel, 3–5 related keywords per module) | alt-cost family (ninjutsu, bestow, prototype, emerge, surge, prowl, spectacle, blitz, dash, evoke-likes) · graveyard-cast family (retrace, scavenge, embalm/eternalize, encore, disturb, unearth-likes) · timing family (suspend + time counters + vanishing/fading, madness, foretell, plot, miracle) · modal/cost family (multikicker, entwine, spree, escalate, overload, fuse, splice, replicate, conspire, casualty, bargain, gift, offspring, freerunning, cleave, assist, squad, double team, teamwork) · counter family (graft, devour, riot, outlast, backup, amplify, tribute, mentor, training, enlist, ravenous, umbra armor, afterlife, haunt, sunburst) · combat family (banding-lite, provoke, dethrone, annihilator, melee, exploit, soulbond, ingest, prepare) · economy family (cumulative upkeep variants, echo, level up/levelers, class levels, station, speed, day/night, initiative/Undercity, the Ring, dungeons, ascend, monarch extensions, job select, for Mirrodin!, compleated, storied, increment, ready to run, read ahead, hideaway, cipher, transmute, reconfigure, specialize, craft/MTMTE, mutate, awaken, epic, recover, ripple, web-slinging, tiered, sneak, mayhem, harmonize, exhaust) · player counters (poison/toxic/proliferate, rad, experience, energy) · stun/shield/finality counters · phasing | ~30 | ≈ 3,500 |
| **9.3+ blocked-by loop** | families aggregated from `data/scripts/needs.json` after each script wave, top-N by cards blocked; ends when two consecutive rounds unblock < 50 cards | per round | the residual 3,586 cards with unmatched lines |

Each V-wave: `vocab-wave` workflow (implement in worktree → 3 adversarial lenses → fix once → re-review), then the
orchestrator applies `coreChangeNeeded` patches serially on `main`, merges mergeable branches one at a time
(`--no-ff`, regenerate barrels on conflict, `verify:quick`, revert + re-queue on failure), runs `verify:all` +
`verify:deep`, accepts golden/parse-snapshot changes deliberately (diff in the commit message), commits
`Phase 9.n: <family> vocabulary`, removes worktrees (`git worktree remove` only with a clean status, never `--force`),
regenerates `VOCABULARY.md`.

---

## Part 4 — Script program (Phase 10)

| Wave | Selection | Batches (30) | Agents (author + blind scenario + judge, +30% retries) | Gate / commit |
|---|---|---|---|---|
| **10.0** owner's decks | the 179 unscripted cards of the six `decks/*.csv` | 6 | ≈ 24 | `verify:all` + fidelity ratchet on the six decks; `Phase 10.0` |
| **10.1** EDHREC ≤ 5,000, Commander-legal, paper | ≈ 3,300 | ≈ 110 | ≈ 430 | `verify:quick` per 20 batches, `verify:all` per wave; `Phase 10.1.g` |
| **10.2** rest of ranked paper | ≈ 15,400 | ≈ 515 → 4 workflow runs of ≤ 145 batches | ≈ 2,000 | same; `Phase 10.2.g` |
| **10.3** unranked paper | ≈ 1,800 | ≈ 60 | ≈ 230 | same; `Phase 10.3` |
| **10.4+** re-runs | blocked cards whose families landed in 9.3+; judge-rejected re-author passes | as needed | | |
| (later, optional) digital / Un tiers | not part of the 100%; only on request | | | |

The queue only issues cards whose families are unlocked; the rest wait in `blocked` with needs recorded, so no
agent-hour is spent on inexpressible cards. Script agents write only under `data/scripts/**`; scenario agents only
under `data/scenarios/**`; no agent commits in S-waves; the orchestrator commits one group per ~20 batches:
`Phase 10.1.3: scripts — auras/equipment 061–080 (487 judged, 61 blocked)`.

### Roles (Opus) and hard rules
Shared hard rules in every prompt: never edit `src/`, `test/`, `apps/`, `scripts/`, `package.json`; never create
symlinks/junctions; never run `npm run web:index`; never kill node processes you did not start; never `git commit`
(S-waves); write LF; use only ops in `data/scripts/VOCABULARY.md`; if a clause cannot be expressed, do not fake it —
leave the card unwritten, record it in `blocked[]` and describe the missing op in `needs[]` with a proposed signature,
semantics and CR citation.

- **Author** (`effort: high`): reads the batch file; prefers `mode: 'extend'` with exact `covers` when the parser draft
  is right, `replace` when wrong; `source: 'llm'`, confidence, `oracleHash` from the batch; runs
  `npm run scripts:verify -- --batch <file>` and fixes up to 3 times. Returns
  `{ written[], verified[], blocked[{oracleId, clause, reason}], needs[{opFamily, proposedSignature, clause, cardIds}], parserRuleSuggestions[], iterations }`.
- **Blind scenario author** (`effort: high`): sees only card facts + rulings (`CardDB.rulings`) + `test/scenarios/README.md`
  + three example scenario files — never `data/scripts/**`; one scenario per ability that would fail if the ability
  did nothing; runs `npm run verify:scenarios -- --ids …`; never weakens an expectation to pass. Returns
  `{ results[{oracleId, scenarioFile, passed, failure?}], failures[{oracleId, scenario, expectation, rulesReading}] }`.
- **Judge** (`effort: medium`, refuter stance): sees oracle text, script, `scripts:render` output, scenario results,
  verify report; checks every line for presence, numbers, targets, timing, zones, durations, optionality,
  controller/owner, replacement-vs-trigger; `faithful` only with no discrepancy, `uncertain` when it hinges on a rule it
  cannot cite. Returns `{ verdicts[{oracleId, verdict, confidence, issues[{line, expected, scripted, cr?}]}] }`.
- Audit: 2% of `judged` cards per wave re-judged by a fresh agent; disagreement > 3% pauses the wave.

---

## Part 5 — Workflows (ultracode; scripts passed inline at launch per the authoring reference)

### `harness-wave` (Phase 8b–8k)
`pipeline(items 8b…8k, implement in worktree (opus, schema IMPL), 2 review lenses (barrier per item), fix once)`; the
orchestrator merges serially. Same skeleton as `vocab-wave` with harness prompts.

### `vocab-wave` (Phase 9.1, 9.2, 9.3+) — skeleton
```js
export const meta = { name: 'vocab-wave', description: 'Implement engine vocabulary families in isolated worktrees; adversarially review; fix once', phases: [{ title: 'Implement' }, { title: 'Review' }, { title: 'Fix' }] }
// args: { wave: '9.1', families: [{ name, cards, clauses: [≤40 normalised examples], cardIds, proposed, notes }] }
const IMPL = { type: 'object', properties: { branch: {type:'string'}, worktree: {type:'string'}, files: {type:'array', items:{type:'string'}}, opsAdded: {type:'array', items:{type:'string'}}, scenarios: {type:'integer'}, verifyQuick: {type:'string', enum:['pass','fail']}, coreChangeNeeded: {type:'array', items:{type:'object', properties:{file:{type:'string'}, why:{type:'string'}, patch:{type:'string'}}, required:['file','why']}}, notes: {type:'string'} }, required: ['branch','worktree','files','opsAdded','scenarios','verifyQuick','coreChangeNeeded'] }
const REVIEW = { type: 'object', properties: { refuted: {type:'boolean'}, issues: {type:'array', items:{type:'object', properties:{severity:{type:'string', enum:['blocker','major','minor']}, file:{type:'string'}, claim:{type:'string'}, cr:{type:'string'}}, required:['severity','claim']}}, coreFilesTouched: {type:'array', items:{type:'string'}}, testsRun: {type:'string'} }, required: ['refuted','issues','coreFilesTouched'] }
const LENSES = ['rules-correctness (cite CR numbers; construct a board where the op misbehaves)', 'engine-integration (registry wiring, clone/serialize/view/redact of new ext state, N-player, no core edits)', 'test-adequacy (a scenario per op and keyword parameter; parse snapshot diff reviewed)']
const HARD = `Work ONLY inside the worktree you were started in (report 'git rev-parse --show-toplevel'); run 'npm ci' first. Never create symlinks or junctions (data/ resolves to the main checkout automatically). Never run 'npm run web:index'; never kill node processes you did not start; write LF. Do not edit game.ts, state.ts, characteristics.ts, legal.ts, cost.ts, parse.ts or types.ts — new families live in NEW files (src/engine/ops/<family>.ts + .schema.ts, src/cards/rules/<family>.ts, test/scenarios/<family>.ts, docs/vocabulary/<family>.md), then 'npm run gen:registry'. If a core change is unavoidable, do NOT make it: describe it in coreChangeNeeded with a patch. Finish with 'npm run verify:quick' and 'npm run parse:diff'; commit on your branch: 'Phase ${args.wave}: <family> vocabulary'.`
const implPrompt = f => `Implement the "${f.name}" vocabulary family (read docs/vocabulary/README.md and src/engine/ops/_example.ts first). Make these clauses simulable: ${JSON.stringify(f.clauses)}. Sample cards: ${f.cardIds.slice(0, 12).join(', ')}. Proposals from script authors (adapt, don't blindly accept): ${JSON.stringify(f.proposed)}. Follow the Comprehensive Rules exactly (cite rule numbers in scenario 'cr'); ≥1 scenario per op and per keyword parameter; parser rules for the common wordings so coverage:pool rises. ${HARD}`
const reviewPrompt = (f, impl, lens) => `Adversarial reviewer, ${lens} lens, family "${f.name}", branch ${impl.branch}, worktree ${impl.worktree} (cd there; node_modules exist). Default refuted=true unless you fail to find a real defect after running 'npm run verify:quick' and 'npm run verify:scenarios -- --family ${f.name}' and reading every file in ${JSON.stringify(impl.files)}. Run 'git diff main --stat' and list any core file touched in coreFilesTouched. Cite CR numbers.`
const fixPrompt = (f, impl, reviews) => `Fix the blocker/major issues in worktree ${impl.worktree} (branch ${impl.branch}), re-run verify:quick, add a commit 'Phase ${args.wave}: ${f.name} review fixes'. Issues: ${JSON.stringify(reviews.flatMap(r => r.issues.filter(i => i.severity !== 'minor')))}. ${HARD}`
const results = await pipeline(args.families,
  f => agent(implPrompt(f), { label: `impl:${f.name}`, phase: 'Implement', model: 'opus', isolation: 'worktree', schema: IMPL }),
  (impl, f) => !impl || impl.verifyQuick !== 'pass' ? { f, impl, reviews: [] }
    : parallel(LENSES.map(lens => () => agent(reviewPrompt(f, impl, lens), { label: `review:${f.name}`, phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW }))).then(vs => ({ f, impl, reviews: vs.filter(Boolean) })),
  async r => {
    if (!r.impl) return r
    const blocking = r.reviews.some(v => v.refuted && v.issues.some(i => i.severity !== 'minor'))
    if (!blocking) return { ...r, mergeable: r.reviews.length === LENSES.length && r.reviews.every(v => v.coreFilesTouched.length === 0) }
    const fixed = await agent(fixPrompt(r.f, r.impl, r.reviews), { label: `fix:${r.f.name}`, phase: 'Fix', model: 'opus', schema: IMPL })
    const re = await agent(reviewPrompt(r.f, fixed ?? r.impl, LENSES[0]), { label: `re-review:${r.f.name}`, phase: 'Fix', model: 'opus', effort: 'high', schema: REVIEW })
    return { ...r, impl: fixed ?? r.impl, reviews: [...r.reviews, re].filter(Boolean), mergeable: !!re && !re.refuted && re.coreFilesTouched.length === 0 }
  })
const dropped = results.filter(r => !r || !r.impl); if (dropped.length) log(`${dropped.length} families produced nothing — re-queue`)
return results.filter(Boolean).map(r => ({ family: r.f.name, branch: r.impl?.branch, worktree: r.impl?.worktree, mergeable: !!r.mergeable, coreChangeNeeded: r.impl?.coreChangeNeeded ?? [], issues: r.reviews.flatMap(v => v.issues) }))
```

### `script-wave` (Phase 10.x) — skeleton
```js
export const meta = { name: 'script-wave', description: 'Author, blind-test and judge per-card scripts for a batch manifest', phases: [{ title: 'Author' }, { title: 'Scenario' }, { title: 'Judge' }] }
// args: { wave: '10.1', batches: ['data/scripts/batches/S1/001.json', …] }   (≤ 145 batches per run)
const AUTHOR = { type:'object', properties:{ written:{type:'array', items:{type:'string'}}, verified:{type:'array', items:{type:'string'}}, blocked:{type:'array', items:{type:'object', properties:{oracleId:{type:'string'}, clause:{type:'string'}, reason:{type:'string'}}, required:['oracleId','clause','reason']}}, needs:{type:'array', items:{type:'object', properties:{opFamily:{type:'string'}, proposedSignature:{type:'string'}, clause:{type:'string'}, cardIds:{type:'array', items:{type:'string'}}}, required:['opFamily','proposedSignature','clause','cardIds']}}, parserRuleSuggestions:{type:'array', items:{type:'string'}}, iterations:{type:'integer'} }, required:['written','verified','blocked','needs','iterations'] }
const SCEN = { type:'object', properties:{ results:{type:'array', items:{type:'object', properties:{oracleId:{type:'string'}, scenarioFile:{type:'string'}, passed:{type:'boolean'}, failure:{type:'string'}}, required:['oracleId','scenarioFile','passed']}} }, required:['results'] }
const JUDGE = { type:'object', properties:{ verdicts:{type:'array', items:{type:'object', properties:{oracleId:{type:'string'}, verdict:{type:'string', enum:['faithful','unfaithful','uncertain']}, confidence:{type:'number'}, issues:{type:'array', items:{type:'string'}}}, required:['oracleId','verdict','confidence']}} }, required:['verdicts'] }
const HARD = `Never edit anything under src/, test/, apps/, scripts/ or package.json — authors write only data/scripts/<2-hex>/<oracle_id>.json, scenario authors only data/scenarios/<2-hex>/<oracle_id>.json. Never create symlinks or junctions; never run 'npm run web:index'; never kill node processes you did not start; never git commit; write LF. Use only ops documented in data/scripts/VOCABULARY.md (no 'unknown' effects in a finished script): if a clause cannot be expressed, do not fake it — leave the card unwritten, record it in blocked[] and describe the missing op in needs[] with a concrete proposed signature, semantics and CR citation.`
const authorPrompt = b => `Write per-card scripts for the batch at ${b} (each entry has oracle text, type line, P/T, the parser's draft AST, the unparsed lines, Scryfall keywords, nearest judged scripts as examples, and the family's vocabulary excerpt). Prefer mode 'extend' with exact 'covers' lines when the draft is right; 'replace' when it is wrong. Set source 'llm', confidence, oracleHash from the batch. Then run 'npm run scripts:verify -- --batch ${b}' and fix/re-run up to 3 times. Skip cards already judged/reviewed. ${HARD}`
const scenarioPrompt = (b, ids) => `Blind behavioural tests for ${JSON.stringify(ids)}: read ONLY the card facts in the stripped batch file ${b.replace('.json', '.blind.json')} (never open data/scripts/**). Write one scenario per ability in data/scenarios/<2-hex>/<oracle_id>.json using test/scenarios/README.md (board, script, ≥2 expectations, cr) that would fail if the ability did nothing; run 'npm run verify:scenarios -- --ids …'; report pass/fail with the failure text; never weaken an expectation. ${HARD}`
const judgePrompt = (b, r) => `Skeptical rules judge. For each card in ${JSON.stringify(r.a.verified)} compare the oracle text (${b}), the script, 'npm run scripts:render -- --ids …' and the blind scenario results ${JSON.stringify(r.s?.results ?? [])}. Default 'unfaithful' unless every clause is expressed with correct numbers, targets, timing, zones, durations, optionality and controller. Read-only.`
const out = await pipeline(args.batches,
  b => (budget.total && budget.remaining() < 200_000) ? (log(`budget: skipping ${b}`), null) : agent(authorPrompt(b), { label: `author:${b.split('/').pop()}`, phase: 'Author', model: 'opus', effort: 'high', schema: AUTHOR }),
  (a, b) => !a || !a.verified.length ? { b, a, s: null } : agent(scenarioPrompt(b, a.verified), { label: `scenario:${b.split('/').pop()}`, phase: 'Scenario', model: 'opus', effort: 'high', schema: SCEN }).then(s => ({ b, a, s })),
  r => !r.a || !r.a.verified.length ? r : agent(judgePrompt(r.b, r), { label: `judge:${r.b.split('/').pop()}`, phase: 'Judge', model: 'opus', effort: 'medium', schema: JUDGE }).then(j => ({ ...r, j })))
const done = out.filter(Boolean); log(`${done.length}/${args.batches.length} batches finished; ${out.length - done.length} dropped — re-queue`)
return done.map(r => ({ batch: r.b, written: r.a?.written ?? [], verified: r.a?.verified ?? [], blocked: r.a?.blocked ?? [], needs: r.a?.needs ?? [], scenarios: r.s?.results ?? [], verdicts: r.j?.verdicts ?? [] }))
```
The workflow result is written to `data/scripts/reports/<wave>-<run>.json` (stamped after return) and consumed by
`scripts:promote`; workflow journals allow `resumeFromRunId`.

---

## Part 6 — Orchestrator loop (this session) and check-ins

Between workflows: (1) read the return value (or `journal.jsonl`), list dropped items for re-queue; (2) V-wave:
apply `coreChangeNeeded` patches on `main` → `verify:quick` → merge mergeable branches one at a time; (3) S-wave:
`scripts:promote --result`, verify no changes outside `data/`, `scripts:check --changed`; (4) `scripts:needs` →
pick the next vocabulary families by cards-per-hour; (5) gates — `verify:all` after every wave, `verify:deep` after
every V-wave and every 3rd S-wave, Playwright after Phase 8 and before the final report; (6) `verify:dashboard`,
`vocab:doc`; (7) commit; `git worktree prune`; delete merged branches; (8) update memory
(`mark-magic-project.md`: phase, tier counts, needs backlog, next wave; `mark-magic-toolchain.md` for new traps);
(9) **check in with the user**: numbers (tiers, owner's decks, fidelity hits/game, bench), git log, cost so far,
proposed next wave — and wait.

Check-in points: after Phase 8 · after 9.0 · after 10.0 (owner's decks) · after 9.1 · after 10.1 · after 9.2 ·
after each 10.2 run · after each blocked-loop round · final report.

---

## Part 7 — Cost and time model (honest)

Per 30-card batch: author ≈ 25k output / 300k total tokens, ~8 min (three `scripts:verify` runs of ≤ 15 s);
blind scenario ≈ 20k / 150k, ~7 min; judge ≈ 8k / 80k, ~4 min → ≈ 530k tokens and 19 agent-minutes per batch;
six concurrent slots (min(16, cpus−2)) → ≈ 19 batches/h ≈ 550 cards/h when nothing is blocked. Vocabulary family ≈ 2.3
agent-hours (implementer 60–120 min incl. `npm ci`; three reviewers; a fix round in ~40%).

| Item | Agents | Wall-clock | Tokens |
|---|---|---|---|
| Phase 8 (harness) | 1 serial + ~10 parallel + reviews | ≈ 12 h | ≈ 40M |
| Phase 9.0–9.2 (≈ 45 families) + 9.3+ (≈ 40) | ≈ 340 | ≈ 37 h + 5 h merges | ≈ 155M |
| Phase 10 (≈ 20,700 paper cards → ≈ 690 batches + 30% blocked re-runs + 10% re-authoring ≈ 970 chains) | ≈ 2,900 | ≈ 70 h | ≈ 510M |
| Orchestration, gates, commits | — | ≈ 15 h | ≈ 30M |
| **Total** | | **≈ 140 h ≈ 6 days of continuous running** | **≈ 700M (≈ 80M output)** |

| Elapsed | Milestone | Fully simulated (paper pool) |
|---|---|---|
| 12 h | Phase 8 merged, `verify:all`/`verify:deep` green, dashboard tiers | 33% |
| 24 h | 9.0 merged; 10.0 done (owner's decks covered or blocked with needs) | ≈ 37% |
| 48 h | 9.1 merged; 10.1 first pass | ≈ 52% |
| 84 h | 9.2 merged; 10.2 first pass (all generic-only cards done) | ≈ 80% |
| 110 h | blocked loop rounds 1–2 | ≈ 93% |
| 140 h | loop dry; residual singletons with explicit needs reported | ≈ 97–98% |
| +10–20 h | last rule-system gaps (banding, subgames, physical mechanics) closed or explicitly marked `ignore` | 100% of the paper pool |

The 1000-agent cap means one workflow per wave (≤ 145 batches or ≤ 48 families per invocation); the `budget`
guard skips batches below 200k remaining tokens when a target is set.

---

## Part 8 — Risks and mitigations

- **Well-formed but wrong scripts** — three independent signals (blind scenario, refuting judge, fuzz/fidelity/goldens on real decks); round-trip number exactness catches the commonest slip; 2% re-judge audit per wave; `covered` = `judged` only.
- **Agents editing core files** — hard rule + reviewer `git diff main --stat` + `scripts:promote` refuses on a dirty `src/test/apps/scripts` tree and reverts.
- **A family needs a missing hook** — never edited in the worktree; returned as `coreChangeNeeded` with a patch; applied serially on `main` by the orchestrator.
- **Hot-path cost of hooks** — registry lookups only in `default` branches; replacement folds gated by `if (REPLACEMENTS.length)` and per-family fast flags; `bench:games` asserted per merge (≥ 45 / ≥ 4.8 games/s).
- **Clone/serialize/redact of new state** — `ext` must be JSON-plain (lint); `defOf` indirection resolves through `s.ext.defs`; hidden ext state scrubbed by `redact` hooks.
- **Web worker bundle** — ops may import only engine/types modules (lint forbids `node:`); zod stays in `.schema.ts` files used by tooling only.
- **Model drift across ~1,000 batches** — few-shot from nearest judged scripts, per-family style guides, family-clustered batches, the audit.
- **Sandbox unreachable abilities / renderer false negatives** — reported not failed; judge sees `lowest` lines and can override with an explicit `renderer` issue; renderer median score ratcheted against the 11,541 parsed cards.
- **Cache staleness** — every key includes `PARSER_VERSION`, `registryHash`, `scriptHash`; `parse:diff` bypasses the cache; `MTG_PARSE_CACHE=0`.
- **Worktree hygiene** — no junctions; `paths.ts` resolves data via the git common dir; removal only with a clean status, never `--force`.
- **CRLF** — `.gitattributes` `eol=lf`; `scripts:check` fails on `\r`.
- **CPU contention** — agents run only `verify:quick` and targeted `scripts:verify`/`verify:scenarios --ids`; pool sandbox, bench, fuzz, Playwright are orchestrator gates.
- **Scryfall refresh mid-program** — `data:all` is never run mid-wave; stale scripts go to the front of the queue.
- **Silent truncation** — every pipeline stage tolerates `null`; dropped batches/families are logged and re-queued, never counted.

---

## Verification (end-to-end)

1. Phase 8: `npm run verify:quick` (≤ 15 s), `npm run verify:all` (≤ 2.5 min full), `npm run verify:deep`; `npm run bench:games` ≥ 45 / ≥ 4.8; `npm run parse:diff` reports zero changes after 8a (registry hooks are byte-identical); `test/schema-types.test.ts` compiles; `npm run verify:pool -- --workers 8 --seats both` ≈ 18 s with the same `sandbox-ok` count (11,064); `npm run fuzz -- --games 500` has zero buckets before any vocabulary lands; goldens/fidelity/parse-snapshot fixtures accepted and committed; `/coverage` shows tiers; Playwright (production build on port 3199) green.
2. Each V-wave: per family `verify:quick` + `verify:scenarios --family`; per wave `verify:all` + `verify:deep`; coverage:pool rises by the family's parser rules; `lint-op-coverage` green; bench within budget.
3. Each S-wave: `scripts:verify --batch` reports; `verify:scenarios --changed`; `scripts:promote` refuses on any change outside `data/`; `verify:all`; fidelity ceilings lowered for the owner's decks after 10.0; the dashboard's paper-pool `covered` count matches the manifest.
4. Final: `verify:all` + `verify:deep` green; `verification.json` shows paper pool `pct_simulated = 100`, `pct_covered` = 100 minus explicitly listed `ignore`d cards; `npm run sim:batch -- --deck "Varina, Lich Queen" --deck "The Slurpin Society" --games 100` reports `unsimulated: 0`; optimiser quick preset re-run on Varina shows the caveat list empty.

## Out of scope / deferred
Digital-only and Un tiers (tracked, not built); full CR 613 layer ordering (layers-lite `setPT` + durations cover printed cards; a true timestamp/dependency system remains B3 proper); damage-assignment-order decisions; subgames; physical-world Un mechanics (marked `ignore: un-physical` if ever scripted).
