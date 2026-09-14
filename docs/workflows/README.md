# Orchestration workflows

The "every card scripted" program (see `docs/plans/every-card-scripted.md`) is executed by Claude Code workflows:
this session (the orchestrator) writes a small JavaScript workflow script, the `Workflow` tool runs it, and every
`agent(...)` call in it is an Opus subagent with a structured return value. The scripts in this directory are the
ones used in Phase 8; copy them into the `Workflow` tool (inline `script`, or `scriptPath` after saving) and pass
`args`.

## The pattern

Every slice is one **implementer** agent (`model: 'opus'`, `effort: 'high'`, `isolation: 'worktree'`) followed by
two or three **adversarial reviewers** (each with a distinct lens, told to default to `refuted = true`), then a
**fix** agent for blocker/major issues and a **re-review**. A slice is *mergeable* only when the last review found
no blocker/major issue. The orchestrator merges mergeable branches into `main` serially, running the gates after
each merge, and commits; agents never commit to `main` and never push.

| Script | Use | `args` |
|---|---|---|
| `core-wave.js` | Slices that may edit core files, with a per-item permission list | `{ wave, items: [{ key, base, title, forbid, deliverables }] }` |
| `harness-wave.js` | Harness slices that only add new files (core files forbidden in the prompt) | `{ wave, items: [{ key, base, title, deliverables }] }` |
| `example-serial-core-slice.js` | The Phase 8a-1 run: one implementer in the **main checkout** (nothing else running), three lenses, one fix round | none (prompts inline) |
| `example-fix-round.js` | A targeted second/third/fourth fix round on an existing worktree branch + re-review | none (prompts inline) |
| `renderer-slice.js` | Phase 8c-1: one Fable 5.1 high implementer in the **main checkout**, one adversarial Opus reviewer, one fix round, one re-review (prompts inline; the plan file is read for the item list) | `{ plan, base }` |
| `tooling-slice.js` | A tooling slice on main under the 2026-09-05/06 rules — the same shape as `renderer-slice.js` with the deliverables, proofs and reviewer lens read from a markdown brief (`docs/workflows/briefs/<name>.md`); the process slice ran through it | `{ name, brief, plan, base }` |
| `script-wave.js` | Phase 10.x: author → blind scenario (sampled) → judge per batch file; the return value is what `scripts:promote -- --result` reads | `{ wave, judges, batches, blindRate: 3, alwaysSample: [<owner-deck ids>], resume: { results: [<prior rows>], reauthor: [<batch paths>] }, rerun: 1 }` — `blindRate` (default 1 = every verified card) and `alwaysSample` draw the blind leg (rule 8); `resume` reuses the author result of any batch with a prior row not listed in `reauthor`; `rerun` is folded into every prompt so a refused agent is never replayed from the cache |
| `parse-wave.js` | Phase 9.1p+: one parser rule family per `parse:why` construct group, each in its own worktree (Opus), **new files only** (`src/cards/rules/<name>.ts`, `test/parser-<name>.test.ts`, `test/scenarios/<name>.ts` + the one-line registration, `gen:registry`); ONE correctness reviewer ("find a printed card this rule misparses": 20 cards sampled round-robin from the `parse:diff` groups, parser-alone ASTs via the `.no-scripts` store, scenarios must fail with the rule reverted), one fix round, one re-review; `mergeable` needs no blocker/major, no core file, ≥ 1 review and an empty `overClaimed`; the return rows are what the merge pipeline reads (`family` = item name, plus `paperCoverage`, `parseDiffChanged`, `overClaimed`, `constructCards`, `pins`) | `{ wave: '9.1p', base, argsFile: 'data/scripts/batches/parse-wave-1.json', items: [<the brief file's items>], rerun: 1 }` — the brief is built by `npx tsx scripts/parse-wave-briefs.ts --in data/master/parse-why.json --wave 9.1p --base <commit> --max 16 --out <file>` from `npm run parse:why` |
| `merge-parse-family.sh` + `union-scenarios.py` | The orchestrator's per-family merge for a parser wave: `bash docs/workflows/merge-parse-family.sh <branch> <family> <n>` merges `--no-ff --no-commit`, resolves the barrel / scenarios-suite / snapshot conflicts, runs the per-merge gate (gen:registry, typecheck:all, verify:quick, npm test, coverage:pool, parse:diff, `forge:diff --changed`, parser-only golden:check, coverage:ops, CRLF) and leaves the merge staged for the reading + `parse:accept` + commit; logs under `$MM_LOGDIR` (default data/bench/merge-logs) | `<branch> <family> <n>` |
| `parse-fix-round.js` | A second fix round + re-review for ONE parse-wave family whose first re-review still had blocker/major issues (prompt builders copied from parse-wave.js) | `{ wave, base, argsFile, it, worktree, branch, headCommit, issues, round: 2, rerun: 1 }` |
| `parse-core-slice.js` | Phase 9.1px: the `coreChangeNeeded` entries of a parser wave (built-ins fixed or re-ordered, trigger heads the first-comma split truncates, pronoun rewrites) — one Fable 5.1 high implementer in the **main checkout**, two Opus lenses (correctness with the same 20-card parse:diff sample, integration), one fix round + one re-review; bumps `PARSER_VERSION` once (5 → 6) with the pin in `test/parser-composition.test.ts`; `parse:diff` explained group by group, never accepted; `MTG_SCRIPTS=0 fuzz 100` | `{ items: 'data/scripts/batches/parse-wave-1-core.json', base, rerun: 1 }` — the item file is `{ items: [{ id, family, file, why, patch, cards }] }`, built by the orchestrator from the wave rows |

`base` is the branch or commit the worktree must `git reset --hard` to before starting (worktrees are created
from an older commit, see below). `deliverables` is the whole task text; write it the way the Phase 8 items were
written: read-list, numbered deliverables with file paths, a PROOFS list of commands whose exact output the agent
must report, and the numbers that must not move.

The Phase 9/10 scripts (`vocab-wave`, `script-wave`) are in Part 5 of the plan; they follow the same shape.

## Hard rules every agent prompt carries

- Work only inside the worktree (`git rev-parse --show-toplevel` must be under `.claude/worktrees/`); never touch
  the main checkout; never commit to `main`; never push.
- **Worktree setup**: `git reset --hard <base>` (the tool creates worktrees from an older commit), then
  `npm ci --ignore-scripts --no-audit --no-fund` (plain `npm ci` fails: better-sqlite3 tries `node-gyp`; the
  bundled `prebuilds/win32-x64.node` works). `src/config/paths.ts` resolves `data/` to the main checkout
  automatically (the worktree has no database).
- **Never create symlinks or junctions** (a junction to `data/` once let `git worktree remove --force` delete the
  real files). Never copy `data/` into a worktree. Never run `npm run web:index`. Never kill node processes you did
  not start (the owner's dev servers run on this machine). Write LF.
- Do not edit the files another running slice owns (listed per item in `forbid`); if a core change is unavoidable,
  describe it in `openIssues` / `coreChangeNeeded` instead of making it.
- Every proof is a command actually run, reported with its exact output line.

## Merge procedure (orchestrator)

1. `git merge --no-ff --no-commit <branch>`; resolve conflicts (so far only unions: README bullets, npm scripts,
   import blocks, a lint file list).
2. Gates: `npm run typecheck:all`; `node scripts/gen-registry.mjs` (must print "up to date"); `npm test`;
   `npm run sim:batch -- --verify data/bench/smoke.json` (and `smoke2.json`, `smoke-commander.json`) must print
   `identical`; `npm run coverage:pool` → `fully_parsed 11541` (then `git checkout -- data/master/parser-coverage.json`);
   `npm run verify:pool` → `sandbox-ok 11064 / unreachable 477`.
   **Parser waves** (`parse-wave.js` rows): after `npm run parse:diff` on the merged tree and BEFORE `parse:accept`,
   run `npm run forge:diff -- --changed --md <scratch>` (docs/plans/forge-oracle.md: the changed cards' structure
   against Forge's scripts) and read every `target-missing`, `may-missing` and `trigger-kind` finding on the newly
   claimed cards against the printed text before accepting — read, then decide: a finding is evidence, not a verdict
   (the measured rates and the labelled precision per category are in docs/vocabulary/README.md, "forge:diff"). A
   parser-wrong finding is an over-claim: do not accept the snapshot, send the family back for a fix round.
   A parse:diff "(same unparsed lines)" group is an over-claim UNLESS every card in it is an inner unknown fragment
   that now parses inside an ability whose head or another line still fails (9.1p: generic-you-do's 12 and
   generic-deals-damage's 53 were that) — dump the parser-alone ASTs before/after and read them; a previously
   fully-parsed card that changed shape is always an over-claim.
3. Commit with the `Phase 8x:` message, then remove the worktree: `git worktree remove <path>`; on Windows it may
   fail with "Directory not empty" after unregistering — delete the npm workspace junction first
   (`[System.IO.Directory]::Delete('<path>\node_modules\@mtg\web')` in PowerShell, which does not follow it), then
   `Remove-Item -Recurse -Force`, then `git worktree prune` and `git branch -d`.

Baselines (gitignored, regenerate if missing):

```
npm run sim:batch -- --deck mono-red-burn --deck mono-green-stompy --games 90 --seed 1 --out data/bench/smoke.json
npm run sim:batch -- --deck ub-control --deck wu-fliers --games 60 --seed 3 --out data/bench/smoke2.json
npm run sim:batch -- --deck "Varina, Lich Queen" --deck "The Slurpin Society" --games 40 --seed 1 --format commander --out data/bench/smoke-commander.json
```

They were recorded before any Phase 8 engine change; a merge that changes one of them changed engine behaviour and
must say why in its commit message (the goldens in `test/fixtures/golden/` take over this role once 8g is merged).

## Process rules adopted 2026-09-05 (after the Phase 8 retrospective)

These override the pattern above where they differ. They come from the owner's review of Phase 8 (`feedback 1.txt`):
roughly half of the Phase 8 overrun was process weight, not engineering.

1. **Reviewers**: one adversarial reviewer for tooling slices (new files only), two for engine slices (core edits or
   new ops). The lenses are `correctness` and, for engine slices, `engine-integration`. The `test-adequacy` /
   `hygiene` lens is dropped: in Phase 8 it restated the correctness findings plus minors.
2. **Fix rounds: two maximum.** After the second re-review, remaining minors and every finding of the shape "a later
   layer (renderer, blind scenario, judge) would catch this" go to the backlog in `docs/HANDOFF.md` §3, and the slice
   merges. The structural script checker is the first filter, never the sole guard.
3. **Evidence per merge**: `verify:quick` per merge; `verify:all` per wave; goldens + fidelity (`verify:deep`) per
   engine merge. The three seeded `data/bench/smoke*.json` baselines are retired as gates — the goldens carry that
   role. Regenerate the smoke files only if a golden diff needs a second opinion.
4. **Sequencing**: 8i (speed ladder, parse cache, Playwright leg) and 8j (dashboard v2) are deferred until after
   Phase 10.0 has produced real data; 9.0 runs first, then 8c + 8k in parallel worktrees, then a reduced Phase 8 gate
   (`verify:all`, `verify:deep`, `fuzz:deep`; no Playwright, no dashboard), then 10.0.
5. **Judges**: one judge per card — the default judge rule (`src/cards/waveScope.ts` `twoJudgeIds`, installed by
   `scriptState.defaultSources()`) asks two faithful verdicts of the owner's decks and ONE of every other card; the
   EDHREC top-1k half of plan 2.4's two-judge set was dropped on 2026-09-06 (`edhrecTopIds` stays exported for the
   queue's selections and the audit). `scripts:promote -- --judges N` still forces a whole run. The 2% re-judge audit
   stays for every wave (sorted judged ids, every 50th, one Opus judge, disagreements to HANDOFF), and a second judge
   returns only if the audit shows > 3% disagreement. **2026-09-14 (owner):** the 10.1 group-1 audit disagreed on its
   one sampled card (Breeches: a `choose-objects` standing in for a printed "target", excused by the wave judge as
   "forced by the vocabulary"); one judge STAYS for 10.1 groups 2+, and the mitigation is the explicit judge rule
   in `script-wave.js` (a resolution-time choice standing in for a printed target is unfaithful, CR 115.1 / 601.2c)
   plus the matching lint in `src/cards/lint.ts` (`printedTargets`; a scripts:check problem).
6. **Models**: serial Phase 9 work (9.0 and any later core slice on `main`) runs on **Fable 5.1 at high effort**
   (`model: 'fable', effort: 'high'`). Parallel worktree families (9.1, 9.2, 9.3+), the Phase 10 author / blind
   scenario / judge roles and reviewers stay on Opus unless the owner says otherwise. The orchestrating session
   remains the only committer.
7. **Op-coverage ratchet**: its `unknown` assertion and the type-only vocabularies (keywords, alt costs) are known
   half-built (HANDOFF §3 item 12); do not spend a review round on them — wire them to the schema barrel when 8c
   touches that area.
8. **Sampled blind leg** (decided 2026-09-06; revisit the rate after the first ~3k judged cards): the per-card blind
   scenario is universal for the owner's decks — the orchestrator computes `ownerDeckIds(db).ids` once per wave and
   passes it as `script-wave.js`'s `alwaysSample` — and SAMPLED elsewhere: `blindRate: 3` for the EDHREC waves from
   10.1 on (one verified card in three, drawn by index over the batch's sorted verified ids — `blindSample` in
   `src/cards/waveScope.ts`, no randomness, so a resume draws the same cards). An unsampled card is `judged` on the
   mechanical gate + one faithful verdict alone, recorded in its script as `verification.scenarios.sampled: false`
   (absence of the key = sampled); it is NEVER `tested` — a missing, uncertain or unfaithful verdict leaves it
   `verified` (queueable, so a rejected one is re-issued), and a scenario shard left on disk for such a card is
   skipped by test/scenarios-data.test.ts as stale. An owner's-deck card is never recorded unsampled: the promoter
   prints a NOTE and leaves its scenarios alone. The 2% re-judge audit of rule 5 stays; a rising audit disagreement
   rate is the signal to lower `blindRate` back toward 1.
