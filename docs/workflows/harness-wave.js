export const meta = {
  name: 'harness-wave-2',
  description: 'Phase 8 harness slices in parallel worktrees (per-item base branch): Opus implementer per slice, two adversarial reviewers, one fix round',
  phases: [{ title: 'Implement' }, { title: 'Review' }, { title: 'Fix' }],
}

const MAIN = 'C:/Users/vprog/dev/mark-magic'
const PLAN = 'C:/Users/vprog/.claude/plans/immutable-greeting-puppy.md'

const IMPL = { type: 'object', properties: {
  branch: { type: 'string' }, worktree: { type: 'string' }, headCommit: { type: 'string' },
  summary: { type: 'string' },
  filesChanged: { type: 'array', items: { type: 'string' } },
  filesAdded: { type: 'array', items: { type: 'string' } },
  proofs: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, result: { type: 'string' } }, required: ['check', 'result'] } },
  openIssues: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' },
}, required: ['branch', 'worktree', 'headCommit', 'summary', 'filesChanged', 'filesAdded', 'proofs', 'openIssues'] }

const REVIEW = { type: 'object', properties: {
  refuted: { type: 'boolean' },
  issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' } }, required: ['severity', 'claim', 'evidence'] } },
  checksRun: { type: 'array', items: { type: 'string' } },
  leftoverFiles: { type: 'array', items: { type: 'string' } },
}, required: ['refuted', 'issues', 'checksRun', 'leftoverFiles'] }

const setup = base => `WORKTREE SETUP (first, in order): (1) 'git rev-parse --show-toplevel' must be inside ${MAIN}/.claude/worktrees/<name> — if you are in ${MAIN} itself, STOP and return an error. (2) The worktree was created from an older commit: run 'git reset --hard ${base}' so you start from that base (compare 'git log --oneline -1' with 'git -C ${MAIN} log --oneline -1 ${base}'). (3) Install dependencies with EXACTLY 'npm ci --ignore-scripts --no-audit --no-fund' (plain npm ci fails: better-sqlite3 tries node-gyp; --ignore-scripts keeps its bundled prebuilds/win32-x64.node). (4) Confirm 'npx tsx -e "import(\\'./src/config/paths.ts\\').then(m=>console.log(m.DATA_DIR()))"' prints ${MAIN}\\data (the worktree has no database; paths.ts resolves the main checkout's data automatically; data/bench/*.json baselines live there too). HARD RULES: never create symlinks or junctions; never copy data/ into the worktree; never run 'npm run web:index'; never kill node processes you did not start; never touch ${MAIN} directly (other agents are editing it and its worktrees); do not stash or checkout other branches; write every file with LF; do not modify src/engine/game.ts, src/engine/state.ts, src/engine/characteristics.ts, src/engine/legal.ts, src/engine/cost.ts, src/engine/events.ts, src/cards/parse.ts, src/cards/types.ts, src/cards/scripts.ts or src/cards/db.ts (other slices own them right now — if you believe you need a change there, describe it in openIssues instead). Keep the code style of the surrounding files (dense, commented, ./x.js imports, TypeScript 7 strict, NodeNext; tests with node:test). Generated fixtures must be produced by the committed scripts, not by hand. When done: 'git add -A' (check 'git status' shows only intended files; node_modules and data/master/*.json outputs are ignored — fixtures under test/fixtures are tracked), commit on your worktree branch with the message '<title>' plus a body describing the change, and report branch, worktree path and commit hash.`

const implPrompt = it => `You are implementing "${it.title}" from the approved plan at ${PLAN} (Phase 8 harness hardening). ${setup(it.base || 'main')}

${it.deliverables}

General proof rules: every proof is a command you actually ran; report its exact output line(s); 'npm run typecheck:all' and 'npm test' must be green; run 'git ls-files --eol' on your changed files (must be i/lf) and grep -c $'\\r' on new files (must be 0). List in openIssues every plan item you could not do and why — never silently skip one. Return the structured result.`

const LENS = [
  { key: 'correctness', text: 'Lens: CORRECTNESS AND SPEC COMPLIANCE. Read the plan section for this slice and check every deliverable item one by one against the code; try to refute each proof by re-running it yourself; construct at least two adversarial cases (wrong input, edge case, worker-count change, empty input, a deliberately corrupted state or fixture) and run them; read the diff for logic errors, N-player assumptions, nondeterminism (Math.random, Date.now, object iteration order across workers), and error handling that swallows failures.' },
  { key: 'integration', text: 'Lens: INTEGRATION AND HYGIENE. Verify with git diff <base> --stat that no forbidden core file was touched; that package.json changes are minimal; that npm test and typecheck:all pass in the worktree; that behaviour unchanged elsewhere (the numbers the slice must preserve are stated in its deliverables — re-measure them); that worker/threads code cannot leak handles (process exits, workers terminated on error, no hang on a dead worker); that documentation matches the code; that fixtures were generated by the committed scripts (regenerate and diff); no CRLF; the commit exists on the worktree branch. Temporarily break something in a scratch copy under C:/Users/vprog/AppData/Local/Temp/claude/ (never inside the repo) to confirm the new tests actually catch it, then discard the scratch.' },
]
const reviewPrompt = (it, impl, lens, again) => `You are an adversarial reviewer of "${it.title}". The implementer worked in the git worktree ${impl.worktree} on branch ${impl.branch} (commit ${impl.headCommit}, base ${it.base || 'main'}); cd there (node_modules installed; data/ resolves to the main checkout automatically). Do NOT commit, do NOT modify the implementer's files, do NOT touch ${MAIN} directly, never create junctions, never run 'npm run web:index', never kill node processes you did not start. The plan is ${PLAN}. Implementer report: ${JSON.stringify(impl).slice(0, 5000)}. ${again ? 'This is a RE-REVIEW after a fix round: check that each blocker/major issue was actually fixed and nothing regressed.' : ''} Default to refuted=true unless you fail to find a real defect after actually running the checks. ${lens.text} Report each issue with severity, file, claim and concrete evidence.`

const results = await pipeline(args.items,
  it => agent(implPrompt(it), { label: `impl:${it.key}`, phase: 'Implement', model: 'opus', effort: 'high', isolation: 'worktree', schema: IMPL }),
  (impl, it) => !impl ? { it, impl: null, reviews: [] }
    : parallel(LENS.map(l => () => agent(reviewPrompt(it, impl, l, false), { label: `review:${it.key}:${l.key}`, phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW }))).then(vs => ({ it, impl, reviews: vs.filter(Boolean) })),
  async r => {
    if (!r.impl) return r
    const blocking = r.reviews.flatMap(v => v.issues.filter(i => i.severity !== 'minor'))
    if (!blocking.length) return { ...r, mergeable: r.reviews.length === LENS.length }
    const fixed = await agent(`Fix the following blocker/major review issues for "${r.it.title}" in the worktree ${r.impl.worktree} (branch ${r.impl.branch}; cd there; node_modules installed). Issues: ${JSON.stringify(blocking)}. Re-run every proof from the original deliverables afterwards and add a commit '${r.it.title} — review fixes' on the same branch. Never touch ${MAIN} directly; never create junctions; never kill node processes you did not start; write LF; do not modify the forbidden core files.`, { label: `fix:${r.it.key}`, phase: 'Fix', model: 'opus', effort: 'high', schema: IMPL })
    const re = await agent(reviewPrompt(r.it, fixed ?? r.impl, LENS[0], true), { label: `re-review:${r.it.key}`, phase: 'Fix', model: 'opus', effort: 'high', schema: REVIEW })
    return { ...r, impl: fixed ?? r.impl, reviews: [...r.reviews, re].filter(Boolean), blocking, mergeable: !!re && !re.issues.some(i => i.severity !== 'minor') }
  })
const out = results.filter(Boolean)
log(`${out.length}/${args.items.length} slices finished; mergeable: ${out.filter(r => r.mergeable).map(r => r.it.key).join(', ') || 'none'}`)
return out.map(r => ({ key: r.it.key, base: r.it.base || 'main', branch: r.impl?.branch, worktree: r.impl?.worktree, commit: r.impl?.headCommit, mergeable: !!r.mergeable, openIssues: r.impl?.openIssues ?? [], issues: r.reviews.flatMap(v => v.issues), proofs: r.impl?.proofs ?? [] }))