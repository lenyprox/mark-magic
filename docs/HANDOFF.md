# Handoff — "every card scripted" program

Written 2026-09-04/05 at the end of the first orchestration session. Everything a new session (any account, any
machine) needs is in this repository: the plan, the workflow scripts, the conventions, the state of every branch,
and the backlog. Read this file, then `docs/plans/every-card-scripted.md` (the approved plan), then
`docs/workflows/README.md` (how the work is executed).

## 1. What the program is

Take the rules engine from 33.4% of the playable pool fully simulated to 100% of the **paper pool** by writing a
per-card script for every card the oracle-text parser cannot finish (22,972 cards), using Opus subagents
orchestrated by a Claude Code session. The plan has three phases, continuing the repository's Phase 1–7 history:

- **Phase 8 — harness hardening** (in progress; slices 8a–8k): engine extensibility (registries + declaration
  merging), script format v2 with airtight accounting, a script verification pipeline, blind scenarios, a parallel
  pool sandbox, a fuzzer, goldens, a fidelity ratchet, an op-coverage ratchet, the speed ladder, dashboard v2 and the
  queue/promote tooling.
- **Phase 9 — vocabulary waves**: 9.0 composition core (serial), 9.1 rules-depth families (parallel worktrees),
  9.2 named-keyword bundles, 9.3+ blocked-by rounds driven by what script authors report as missing.
- **Phase 10 — script waves**: 10.0 the owner's six decks (179 cards), 10.1 EDHREC ≤ 5k Commander-legal, 10.2 the
  rest ranked, 10.3 unranked; author → blind scenario author → judge, promotion by the orchestrator only.

### Decisions taken by the owner (2026-09-04)

- Denominator = **paper pool** (cards with `paper` or `mtgo` in Scryfall `games`, not `set_type: funny`, not
  Attraction/Contraption/Sticker/Hero card types, not ante). Measured: paper 32,081 · digital 1,000 · un 1,423 ·
  ante 9. Un/digital tiers are tracked on the dashboard but are not part of the 100%.
- Evidence bar = mechanical gates **+ blind scenario + independent judge** for every card ("covered" = `judged`).
- Run mode = **Phase 8 continuously**, then waves with a check-in after each wave.
- Subagents on Opus; the orchestrating session is the only committer.

## 2. Status at handoff

`main` (pushed to `origin/main`):

| Commit | Slice | What it gives |
|---|---|---|
| 1797764, 460294e | 8b | `src/config/paths.ts` resolves `data/` from a linked worktree to the main checkout; `.gitattributes` pins LF |
| fde79f4 | — | `.claude/worktrees/` ignored |
| 8700360 | 8a-1 | `src/engine/ops/` registry (`npm run gen:registry`), hook points in every core function, `Core*` unions + registries in `types.ts`/`state.ts`/`events.ts`, `ext` bags, `docs/vocabulary/README.md`, `test/registry.test.ts` |
| 97983df | 8d | `src/verify/scenarioDsl.ts`, JSON corpus `data/scenarios/<2-hex>/<oracle_id>.json`, `npm run verify:scenarios` (sharded), `test/scenarios/README.md` for blind authors |
| 4e09a7c | 8a-1 fixes | extra-combat leak, step-hook placement, mode costs, counters fold, phasing scans, lints |
| 8249a67 | 8e + 8f | `src/engine/invariants.ts`, parallel `npm run verify:pool` (`--workers/--seats 2|4|both/--ids/--changed/--tier/--limit`), `npm run fuzz` / `fuzz:deep` with ddmin shrinking and `--repro` |
| d1f454e | docs | this handoff, the plan copy, `docs/workflows/` |
| 18a0939 | 8h | op-coverage ratchet: `npm run coverage:ops`, `test/lint-op-coverage.test.ts`, `test/fixtures/op-allowlist.json` (only shrinks; dead trigger events pinned) |
| 4aa3559 | 8a-2 | parser rule registry (`src/cards/rules/`, generated barrel), `PARSER_VERSION`, `npm run parse:diff` / `parse:accept` over `data/master/parse-snapshot.json`; `verify:all` includes `parse:diff` |
| 6e35aa7 | 8g | goldens (`test/fixtures/golden/`, `golden:check` / `golden:accept`), fidelity ratchet (`fidelity:check` / `fidelity:accept`, `test/fixtures/fidelity.json`), `test/determinism.test.ts`, inert-clause aggregation (`sim:batch --track-unsimulated`), worker pools settle on thread death |
| 9d945ba | 8x | engine fixes: static-mods recursion (layer-6 re-entrant reads), one `landScorer` for AiAgent/RolloutAgent (land from graveyard/exile), `Game.blockLegal` shared by declare-blockers and `simulateCombat` (menace, CR 509.1a) |
| e817a4f | 8a-3 | script format v2 (sharded, `llm` source, backFace/secondFace, typed value-matched covers, ignore whitelist, verification block, `scriptHash`), line-claim accounting for `fullyParsed`, `src/cards/pool.ts` tiers, `src/cards/schema.ts` (zod) + `typecheck:schema`, `scripts:check` v2, `scripts:shard`, `scripts:schema` |
| edceb29 | 9.0a | composition core, engine side: `Ref`, ten composition ops, amount forms, `multi` targets, four delayed-at points, `src/engine/refs.ts`, zod schema + structural gate + op-coverage probes extended, `docs/vocabulary/composition.md`; soft cast-time target requirements for older-container branches; `docs/workflows/phase-9-0a-composition-core.js` |

Numbers on `main` after 9.0a (2026-09-05, machine shared with a second session): `coverage:pool` 11,541 / 34,513 fully
parsed overall, paper headline 11,391 / 32,081 (35.5%) — unchanged by design (parser rules are 9.0b); `verify:pool`
11,064 sandbox-ok / 477 unreachable; `parse:diff` 0 changed; goldens replay identically; fidelity 13.28 / 16.12 /
8.33 / 20.38 (ceilings unchanged); `npm test` 546 tests; `coverage:ops` 0 not allowlisted (allowlist shrank by 17
entries); bench 47.2 games/s 60-card and 4.89 Commander (≥ 20 / ≥ 4 budget).

### Branches not yet merged

None. Every Phase 8 branch produced in this session was merged into `main` after its review rounds; the worktrees
and the remote `worktree-*` branches were deleted. Section 6 records what each merge left open.

## 3. Known defects and backlog (found by reviewers and the fuzzer; not yet fixed unless noted)

1. `Game.simulateCombat` accepts a lone blocker against a menace attacker (CR 702.110b); `combatFrom` enforces it,
   `simulateCombat` does not. The scenario DSL's block-acceptance check depends on the engine refusing it. → 8x.
2. `characteristics.ts` `computeStaticMods → staticMods → keywords` can recurse without bound (fuzz bucket
   `a909b8b2`, `npm run fuzz -- --repro a909b8b2` after a seed-1 300-game run). → 8x.
3. `src/analysis/rolloutAgent.ts` `score` dereferences an undefined object (fuzz bucket `3492eb01`). → 8x.
4. The parser certifies 170 split/adventure/flip cards as fully parsed although it never parses `faces[1]`
   (333 pool cards have a playable second face; `parse.ts` parses `faces[0]` only and builds `backFace` for
   modal_dfc/transform only). Script accounting (8a-3) requires a `secondFace` block for scripted cards; the parser
   itself should mark the second half unparsed. → a parser slice behind `parse:diff`/`parse:accept`.
5. `parse.ts` `parseGrantedAbility` (~line 960) contains literal 0x08 backspace bytes where `\b` was intended, so
   its "this creature" → "~" normalisation never fires. Fix behind `parse:diff`; bump `PARSER_VERSION`.
6. `state.attackers` is not cleared by `simulateCombat` (only by `simulateRemainingCombat`); harmless today.
7. `npm run bench:games` is unreliable while agents share the CPU (Commander 1.7–2.6 games/s under load vs ≈ 5
   quiet) — run the bench gate only on a quiet machine.
8. `verify:deep` is a stub until 8g (goldens + fidelity) and 8i (Playwright leg) are merged; the fuzz legs are in
   `fuzz:deep`.
9. `BatchPool.run()` can stall if a worker dies mid-chunk (8g fix round 2 addresses it).
11. **Dead trigger events** (found by the 8h probe): `turned-face-up` is raised by `Game.turnFaceUp` but no
    `queueTriggers` case dispatches it, so a morph card's "When ~ is turned face up" trigger can never fire
    (proof: Ainok Survivalist turned face up destroys nothing); `tapped` has a case but is never raised. Both are
    pinned under `deadEvents` in `test/fixtures/op-allowlist.json`; fixing them is a `game.ts` change (add the
    dispatch / raise the event) after which the allowlist entry must be removed.
12. Op-coverage strictness gaps (8h re-review): the probe's `unknown` assertion can false-positive on cards whose
    parser output carries the `unknown` sentinel; keywords/alt-cost/cost-modifier vocabularies have no runtime source
    (type-only registries) — derive them from the zod schema barrel once 8a-3 lands.
13. Parser-registry purity gap (8a-2 re-review): the built-in `EFFECT_RULES` entry `~ gains "(.+)"` (parse.ts ~472)
    calls `parseActivatedLine` with the registry enabled even during the built-ins-only pass, and four line-loop
    condition slots consult condition rules in place (documented in parse.ts's header). With catch-all claiming
    families the measured effect is 0 fully-parsed cards moved; a proper fix threads the pass flag into table
    `make` callbacks. Always read `npm run parse:diff` after a rule family lands.
14. Analysis worker pool (`src/analysis/pool.ts`, 8g re-review): `AnalysisPool.rerun()` never settles when the
    worker it was posted to dies while another worker lives (the pool does not record which slot a rerun went to);
    a slot that dies before `init()` leaves `init()` waiting; `killSlot` charges an in-flight rerun to the current
    analysis. In `src/sim/batchPool.ts` a worker answering `load` with an error while another worker already loaded
    is never retired. All edge cases of worker death, not of normal runs.
15. Fidelity ceilings were re-baselined with `fidelity:accept --force` in 8g (Goph vs Quintorius 14.3 → 16.1, pod
    19.8 → 20.5): the earlier ceilings came from runs where 18 of 240 games died on the land-drop crash, so they
    undercounted inert clauses. This is a measurement correction; ceilings only ratchet down from here.
16. Layer dependency cycles (8x): `staticMods` now parks an in-progress marker and answers a re-entrant read with
    `layer6Mods` (keywords/flags kept, layer-7 P/T terms zeroed), so keyword-filtered anthems see granted keywords
    and no longer overflow the stack; a filter that reads P/T (`powerGE`, `toughnessLE`, `toughnessGtPower`) still
    sees printed values on a re-entrant read — the real fix is CR 613.8 dependency ordering (plan B3).
17. `Game.blockLegal` (shared by the declare-blockers step and `simulateCombat`) now enforces CR 509.1a (only the
    defending player's creatures block). The 8x re-review warns that `simulateCombat` sets every attacker's
    `attacking` to the primary opponent, so simulated blocks by a non-primary defender in a pod are refused; the
    3-player golden and the fidelity pod were the gates: 3 of 30 pod golden games changed (accepted, first
    difference at a turn where a non-defending seat's block is no longer simulated), both 2-player goldens and the
    three seeded baselines reproduced exactly, and the fidelity pod improved (20.52 → 20.38 hits/game). If pods
    with attackers aimed at several defenders ever matter to the AI's combat evaluation, `simulateCombat`'s
    `targets` parameter must be used instead of the primary-opponent default.
18. Script accounting — residual mechanical bypasses (8a-3 round-5 re-review; deliberately left to 8c): the
    structural gate in `src/cards/scripts.ts` (claims, per-line substantive-effect budget, marker ops, zero
    magnitudes, typed covers) still accepts an `Amount` object with `times: 0`, negative magnitudes, `add-mana` with
    `mana: []`, zero-valued statics (`cost-adjust 0`, `extra-land 0`, `equipment 0/0`, `aura 0/0` with no flags),
    `costModifiers` covers whose printed reduction has non-numeric symbols, and all-empty `animate`/`token` bodies.
    The structural gate is the first filter only: 8c's round-trip renderer rejects every one of these because the
    rendered text cannot match the oracle line's numbers, and the blind scenario and judge follow. When writing 8c,
    also extend `MAGNITUDE_RULES`/`EMPTY_LIST_RULES` for these cases so the cheap gate catches them too.
19. **Fight targets fizzle** (found while building 9.0a): `targetingEffects` registers a `fight`'s two requirements
    under the same effect index and `assignTargets` overwrites the first pick with the second, so `Prey Upon`
    ("target creature you control fights target creature you don't control") is cast with only the opposing creature
    in its target list and fizzles at resolution ("all targets illegal"). Left exactly as it was because fixing it
    changes AI play and the goldens; the composition core's `part` mechanism (a second requirement appends instead
    of replacing) is the fix — mark fight's second requirement as `part: 1` and re-baseline the goldens deliberately.
20. Composition core (9.0a) — deliberately left open, see docs/vocabulary/composition.md §7: control changes with
    durations (`exchange` is permanent; 9.1's `o.ext.controlReturn`), timestamp order for `lose-abilities` /
    `set-pt` (approximated: keyword counters and eot grants survive an "all" loss, a later `set-pt` wins), targets
    inside the older containers (`conditional`, `optional-then`, `optional-pay`) are asked for at cast time as *soft*
    requirements (an empty option list never refuses the cast; the cast gate does not evaluate which branch will run;
    `then` and `else` share the container's index, so for the four parser-produced kicker cards that target in both
    branches — Fight with Fire, Hypnotic Cloud, Tear Asunder, Bog Down — the `else` pick overwrites the `then` pick;
    the script schema rejects that shape, so scripts are unaffected), a delayed
    trigger whose source was a token that has ceased to exist cannot fire, `for-each` iterates objects only (players
    go through `scoped`), and `unless-pays` cannot name "the controller of target spell" (use `counter`'s
    `unlessPay`). The parser rules for these wordings are slice 9.0b; until then only scripts and the scenario DSL's
    `scripts` field (test/scenarios/README.md §2) emit them.
21. Composition core (9.0a) — reviewer minors left to the backlog under the two-fix-round rule (none changes a gate):
    `cloneStackItem` copies the new `item.sacrificed` array by reference (the `{...it}` spread); a `reflexive` at the
    head of a NESTED list fires off its container's preceding sibling (`lastHappened` is reset once per item, not
    per list); `exchange` with `what: 'life'` between a player WORD and a TargetSpec advances the target cursor only
    in the object branch; the CR 115.3 duplicate-pick guard in `chooseTargets` runs only for `part`-numbered picks,
    so a plain spec with `count > 1` ("two target creatures") can still accept one object twice; `unless-pays`
    charges the mana before `payCost` pays the non-mana parts, so a refused non-mana part leaves the mana spent;
    `move` sets `faceDown` before `enterBattlefield` and does not clear it when the entry is refused; the cleanup
    step repeats at most once after `until-eot:end` fires (CR 514.3a allows a chain); `resolveTop` falls back to the
    union check for a stack item without a `targetParts` record (states serialized before 9.0a); `childIndex`'s
    nesting/list limits (3 levels, 63 effects) are enforced by the helper's throw, not by the schema or the
    structural gate.
10. `test/` is not covered by `tsconfig.json` (only `src/**`); test files are transpile-only under tsx. 8a-3 added
    `tsconfig.schema.json` for its type-equality test; a whole-of-test typecheck has ~40 pre-existing errors.

## 4. Remaining Phase 8 slices (not started)

- **8c `scripts:verify`** — the mechanical gate for a batch of scripts: strict schema → freshness (`oracleHash`,
  `PARSER_VERSION`, `registryHash`, `scriptHash`) → registry → lint → 2p/4p sandbox with per-ability reachability
  probes → round-trip renderer `src/cards/render.ts` (numbers exact, keyword/zone tokens present, Jaccard ≥ 0.55) →
  `verification` block written into the script + batch report `data/scripts/reports/<batch>.json`. Depends on
  8a-3 (schema, script format), 8e (sandbox), 8a-1 (registry), 8a-2 (`PARSER_VERSION`).
- **8i speed ladder** — `verify:quick` (≤ 15 s), `verify:all` (≤ 2.5 min full, incremental ≈ 70 s), `verify:deep`
  (fuzz + goldens + fidelity + Playwright against `next build --webpack` + `next start -p 3199`); the parse cache
  `data/master/parse-cache.sqlite` keyed by `(oracleId, oracleHash, scriptHash, PARSER_VERSION, registryHash)`;
  `MTG_PARSE_CACHE=0` escape hatch. Touches `src/cards/db.ts` (merge after 8a-3).
- **8k fan-out tooling** — `scripts:queue` (batches of 30 by family/type/EDHREC with parser drafts, nearest judged
  scripts, vocabulary excerpt; blind copies without ASTs), `scripts:promote` (refuses on a dirty
  `src/test/apps/scripts` tree), `scripts:quarantine`, `scripts:needs`, `scripts:render`, `vocab:doc` →
  `data/scripts/VOCABULARY.md`, `src/cards/scriptState.ts` (state derived from files only).
- **8j dashboard v2** — `verification.json` with pool tiers, slices (Commander-legal, owner's decks, EDHREC top-1k/5k,
  by type), script statuses, fidelity, fuzz, goldens, blocked families; `apps/web/components/coverage/CoveragePage.tsx`.
- **Phase 8 gate** — `verify:all` and `verify:deep` green on a quiet machine; goldens/fidelity/parse-snapshot
  fixtures accepted; dashboard shows tiers; Playwright green; then the first check-in with the owner (numbers, git
  log, cost so far, proposed 9.0).

## 5. How to continue (checklist for the next session)

1. Read the plan (`docs/plans/every-card-scripted.md`) Part 6 (orchestrator loop) and `docs/workflows/README.md`.
2. `git fetch --all`; inspect the branches in section 6; for each unmerged branch decide: merge (run the gates), or
   run one more fix round (`docs/workflows/example-fix-round.js` shape) with the listed issues, or re-implement.
3. Finish 8c → 8i → 8k → 8j with `core-wave.js` / `harness-wave.js` (two reviewers + fix round each), merge serially.
4. Run the Phase 8 gate on a quiet machine, commit `Phase 8: gate`, check in with the owner.
5. Phase 9.0 (composition core) is a serial core slice like 8a-1; 9.1/9.2 use the `vocab-wave` script from the plan
   (Part 5) with the family list from Part 3 and the taxonomy counts; Phase 10 uses `script-wave` over
   `scripts:queue` batches, promotion by the orchestrator only.
6. Keep this file and the memory notes current after every wave.

Commit convention: `Phase 8x: …` harness, `Phase 9.n: …` vocabulary, `Phase 10.x.g: …` scripts; end every commit
message with the co-author trailer your session is instructed to use.

## 6. State at the end of the session (2026-09-05)

- `main` = `e817a4f` (pushed). No unmerged branches, no worktrees, working tree clean.
- Every slice went through Opus implementation + two or three adversarial reviews + fix rounds: 8a-1 (1 fix
  round + a follow-up slice), 8a-2 (2), 8a-3 (5), 8d (2), 8e (1), 8f (1), 8g (2), 8h (1), 8x (1). The findings the
  last reviews left open are items 11–18 in section 3; none of them breaks a gate.
- What the gates say on `main`: `npm run verify:all` green (typecheck:all incl. `typecheck:schema`, 439 tests,
  `scripts:check`, `coverage:pool`, `parse:diff` 0, `verify:pool` 11064/477, bench 45.4 / 4.66 games/s);
  `npm run golden:check` reproduces exactly; `npm run fidelity:check` 13.28 / 16.12 / 8.33 / 20.38 hits per game;
  `npm run fuzz -- --games 300 --seed 1` 0 buckets; `npm run coverage:ops` 0 not allowlisted.
- Not done in Phase 8: 8c (`scripts:verify` + renderer), 8i (speed ladder, parse cache, Playwright leg of
  `verify:deep`), 8k (queue/promote/needs/vocab tooling), 8j (dashboard v2), the Phase 8 gate and the owner
  check-in. `verify:deep` today = `golden:check && fidelity:check`; the fuzz legs are `npm run fuzz:deep`.
- Cost of this session: ≈ 15 workflows, ≈ 55 Opus agents, ≈ 14 M subagent tokens, ≈ 20 h wall-clock including
  review loops.
- Owner's memory notes for this project live outside the repo (`~/.claude/projects/…/memory/`); everything they
  contain that matters is in this file, `docs/plans/every-card-scripted.md` and `docs/workflows/README.md`.
