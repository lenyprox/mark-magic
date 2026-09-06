export const meta = {
  name: 'tooling-slice',
  description: 'A tooling slice on main (process rules 2026-09-05 + the 2026-09-06 revision): one Fable 5.1 high implementer in the main checkout, one adversarial Opus reviewer, one fix round, one re-review; the brief (deliverables, proofs, reviewer lens) is a markdown file named in args',
  phases: [{ title: 'Implement', model: 'fable' }, { title: 'Review' }, { title: 'Fix' }],
}
// args: { name: 'process-slice', brief: '<path to the brief .md>', plan: '<path to the approved plan>', base: '<commit>' }
const ROOT = 'C:/Users/vprog/dev/mark-magic'

const IMPL = { type: 'object', properties: {
  summary: { type: 'string' },
  filesChanged: { type: 'array', items: { type: 'string' } },
  filesAdded: { type: 'array', items: { type: 'string' } },
  items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'deferred', 'refuted'] }, notes: { type: 'string' } }, required: ['id', 'status', 'notes'] } },
  proofs: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, result: { type: 'string' } }, required: ['check', 'result'] } },
  numbers: { type: 'object', additionalProperties: true },
  openIssues: { type: 'array', items: { type: 'string' } },
  notes: { type: 'string' },
}, required: ['summary', 'filesChanged', 'filesAdded', 'items', 'proofs', 'openIssues'] }

const REVIEW = { type: 'object', properties: {
  refuted: { type: 'boolean' },
  issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' }, cr: { type: 'string' } }, required: ['severity', 'claim', 'evidence'] } },
  checksRun: { type: 'array', items: { type: 'string' } },
  leftoverFiles: { type: 'array', items: { type: 'string' } },
}, required: ['refuted', 'issues', 'checksRun', 'leftoverFiles'] }

const HARD = `HARD RULES: work in the main checkout ${ROOT} on branch main (base commit ${args.base}; nothing else runs there during this slice). Do NOT git commit, do not create branches, do not stash, checkout or reset, do not push. Never create symlinks or junctions. Never run 'npm run web:index', 'parse:accept', 'golden:accept', 'fidelity:accept' or 'scripts:promote' (except --dry-run). Never kill node processes you did not start (the owner's dev servers run on this machine). Do NOT touch apps/web/lib/gl/*, test/scenemap.test.ts (another session owns them) or any file under data/ unless the brief names it (the untracked files under data/scripts and data/scenarios are another wave's output: never edit, delete or quarantine them). Write LF (no \\r), keep the surrounding code style (dense, commented, ./x.js imports, TypeScript strict, node:test). Scratch files go under C:/Users/vprog/AppData/Local/Temp/claude/ and are deleted afterwards. You do not have the Workflow tool: a workflow .js file is proved by the syntax check the brief gives and by unit-testing any pure helper it embeds.`

phase('Implement')
const impl = await agent(`You are implementing the tooling slice "${args.name}" of the approved plan at ${args.plan}. Your brief is ${args.brief}: read it IN FULL first (it names the plan sections to read, the deliverables with ids, the proofs, and the reviewer's lens), then read docs/workflows/README.md ("Process rules adopted 2026-09-05"). ${HARD}

WORK item by item in the brief's order. For every item: the smallest change that is right, a test in the style of the file it lives in, and the proof the brief asks for. An item you believe is wrong or unsafe: REFUTE it with evidence in its notes rather than doing it badly; an item that needs something outside this slice: DEFER with the reason. Run every proof in the brief and report the exact output line. Update docs/HANDOFF.md (a short note in the phase log; section 3 for anything you leave open). Return the structured result: one 'items' entry per brief item id with status and notes, 'numbers' for whatever the brief asks you to measure, 'openIssues' listing everything not done and why — never silently skip an item.`, { label: `impl:${args.name}`, phase: 'Implement', model: 'fable', effort: 'high', schema: IMPL })
if (!impl) return { failed: 'implementer produced nothing' }
log(`implementer: ${impl.summary.slice(0, 220)} — items: ${impl.items.map(i => `${i.id}:${i.status}`).join(' ')}; open=${impl.openIssues.length}`)

const reviewPrompt = (report, again) => `You are an adversarial reviewer of the tooling slice "${args.name}" in ${ROOT} (main checkout, branch main, UNCOMMITTED working tree on top of ${args.base} — do NOT commit, do NOT modify the implementer's files, do NOT stash, checkout or reset anything, never create junctions, never run web:index / parse:accept / golden:accept / fidelity:accept / scripts:promote (except --dry-run), never kill node processes you did not start, never touch the untracked files under data/scripts or data/scenarios). The plan is ${args.plan}; the brief is ${args.brief} — read its "Reviewer lens" section and follow it, running every check yourself rather than trusting the report. Implementer report: ${JSON.stringify(report).slice(0, 7000)}. ${again ? 'This is a RE-REVIEW after the fix round: check that each blocker/major issue was actually fixed (with a test) or convincingly refuted, and that nothing regressed; do not re-open minors.' : ''} Default to refuted=true unless you fail to find a real defect after actually running the checks. Severity: blocker = a broken gate, a wrong outcome the brief's lens names as such, a forbidden file edited; major = an item marked done that is not, or one that misleads the agents who will use the tool; minor = everything else (backlog). Read the diff ('git diff -- src scripts test docs') in full. Check that every 'refuted' or 'deferred' item's reason holds. Delete scratch files; list leftovers.`

phase('Review')
const review = await agent(reviewPrompt(impl, false), { label: `review:${args.name}`, phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW })
let blocking = review ? review.issues.filter(i => i.severity !== 'minor') : []
log(`review: ${review ? 'returned' : 'missing'}, ${blocking.length} blocker/major issues`)

let fixed = null, rereview = null
if (blocking.length) {
  phase('Fix')
  fixed = await agent(`Fix the following blocker/major review issues from the tooling slice "${args.name}" in ${ROOT} (main checkout, uncommitted working tree on top of ${args.base}; do NOT commit). Issues: ${JSON.stringify(blocking)}. For each issue either fix it (with a test) or refute it with evidence in notes. Then re-run the full proof list in the brief ${args.brief} and return the same structured result (every item's status again). The plan is ${args.plan}. ${HARD}`, { label: `fix:${args.name}`, phase: 'Fix', model: 'fable', effort: 'high', schema: IMPL })
  rereview = await agent(reviewPrompt(fixed ?? impl, true), { label: `re-review:${args.name}`, phase: 'Fix', model: 'opus', effort: 'high', schema: REVIEW })
  blocking = rereview ? rereview.issues.filter(i => i.severity !== 'minor') : []
  log(`fix round: ${blocking.length} blocker/major remaining`)
}
return { impl: fixed ?? impl, review, fixed, rereview, remaining: blocking, mergeable: blocking.length === 0 && !!review, minors: [review, rereview].filter(Boolean).flatMap(v => v.issues.filter(i => i.severity === 'minor')) }
