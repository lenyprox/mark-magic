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
