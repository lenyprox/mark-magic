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
| 8249a67 | 8e + 8f | `src/engine/invariants.ts`, parallel `npm run verify:pool` (`--workers/--seats 2|4|both/--ids/--changed/--limit`), `npm run fuzz` / `fuzz:deep` with ddmin shrinking and `--repro` |

Numbers on `main` (unchanged by design through every merge): `coverage:pool` 11,541 / 34,513 fully parsed;
`verify:pool` 11,064 sandbox-ok / 477 unreachable; the three seeded baselines replay identically; `npm test`
380 tests; bench 45–54 games/s 60-card and ≈ 5 Commander on a quiet machine.

### Branches not yet merged

See section 6 (filled in at the end of the session) for the exact state of every branch. Each branch is pushed to
`origin`; each was produced by an Opus implementer plus adversarial review rounds, and its last review verdict and
remaining issues are listed there.

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

## 6. Branch states at the end of the session

_Filled in below by the orchestrator before the final push._
