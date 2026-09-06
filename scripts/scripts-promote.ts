// Promote a finished script wave (plan 2.4 / 2.8). Reads the `script-wave` workflow's return value — the shape in
// plan Part 5 — and writes the parts of `verification` the workflow produced but no single agent owns: the blind
// scenario results, the judge verdicts, the derived `status`, and a blocked note per card the authors could not
// express. Deterministic, and run only by the orchestrator.
//
//   npm run scripts:promote -- --result data/scripts/reports/10.0-run1.json
//   npm run scripts:promote -- --result <file> --judges 2 --wave 10.0 --dry-run
//   npm run scripts:promote -- --result <file> --allow-dirty apps/web/lib/gl --allow-dirty test/scenemap.test.ts
//   npm run scripts:promote -- --human --by "Jared" --ids <id>,<id> --note "checked against the printed card"
//
// `--human` is plan 2.4's ONLY route to the `reviewed` state: it writes one review note per id under
// `data/scripts/reviewed/<2-hex>/<oracle_id>.json`, pinning the script hash and the oracle hash the person actually
// read. Nothing else promotes a card to `reviewed` — in particular a script that merely declares
// `"source": "hand"` does not, because an author agent can write that word (and both worked examples used to).
//
// How many faithful verdicts a card needs is a property of the CARD, not of this invocation: `src/cards/waveScope.ts`
// says two for the owner's decks and the EDHREC top-1k and one elsewhere, and `defaultSources()` installs it. Pass
// `--judges N` only to force the whole run to one number (a re-derivation experiment).
//
// IT REFUSES TO RUN ON A DIRTY TREE. `git status --porcelain -- src test apps scripts package.json` must be empty:
// promotion writes into data/, and a change anywhere else means an agent edited code it was told not to touch (plan
// Part 8, "Agents editing core files"). A second session's own work-in-progress counts as dirty too — that is the
// point, not a bug: pass `--allow-dirty <path-prefix>` (repeatable) for paths the orchestrator knows about, e.g. the
// 2.5D scene work in `apps/web/lib/gl` and `test/scenemap.test.ts`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import url from 'node:url';
import { projectRoot } from '../src/config/paths.js';
import {
  blockedPathFor, defaultSources, judgeCountFor, poolRows, readBlocked, readReview, reviewPathFor, stateOf,
  unearnedHumanSource, type BlockedNeed, type BlockedNote, type Judges, type ReviewNote,
} from '../src/cards/scriptState.js';
import { ORACLE_ID_RE, oracleHash, scriptFileText, ScriptStore, scriptHash, type CardScript, type Verification } from '../src/cards/scripts.js';
import { checkScript } from '../src/cards/scriptCheck.js';
import { CardDB } from '../src/cards/db.js';

// ---------------------------------------------------------------------------
// The workflow result (plan Part 5, `script-wave`'s return value)
// ---------------------------------------------------------------------------

export interface WaveBlocked { oracleId: string; clause: string; reason: string }
export interface WaveNeed { opFamily: string; proposedSignature: string; clause: string; cardIds: string[]; semantics?: string; cr?: string }
export interface WaveScenario { oracleId: string; scenarioFile: string; passed: boolean; failure?: string; names?: string[]; /** how many scenarios the card's file holds — the blind author reports one row per card */ scenarios?: number }
export interface WaveVerdict { oracleId: string; verdict: 'faithful' | 'unfaithful' | 'uncertain'; confidence: number; issues?: (string | { line?: string; expected?: string; scripted?: string; cr?: string })[]; model?: string }
export interface WaveBatchResult {
  batch: string;
  written?: string[];
  verified?: string[];
  blocked?: WaveBlocked[];
  needs?: WaveNeed[];
  scenarios?: WaveScenario[];
  verdicts?: WaveVerdict[];
}

/** The file may be the bare array the workflow returns, or `{ wave, results: [...] }` after the orchestrator stamps it. */
export function readResult(file: string): { wave: string | null; results: WaveBatchResult[] } {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (Array.isArray(raw)) return { wave: null, results: raw as WaveBatchResult[] };
  const o = raw as { wave?: string; results?: WaveBatchResult[]; batches?: WaveBatchResult[] };
  const results = o.results ?? o.batches;
  if (!Array.isArray(results)) throw new Error(`${file}: expected an array of batch results, or { wave, results: [...] }`);
  return { wave: o.wave ?? null, results };
}

// ---------------------------------------------------------------------------
// The dirty-tree gate
// ---------------------------------------------------------------------------

/** The paths a promotion must not find modified. `data/` is deliberately absent: that is what a wave writes. */
export const GUARDED_PATHS = ['src', 'test', 'apps', 'scripts', 'package.json'] as const;

/** Modified / untracked paths under the guarded roots, minus the allowed prefixes. */
export function dirtyPaths(allow: string[] = [], root = projectRoot()): string[] {
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain', '-uall', '--', ...GUARDED_PATHS], { cwd: root, encoding: 'utf8' }); }
  catch (e) { throw new Error(`scripts:promote: git is unavailable here, so the dirty-tree gate cannot run (${(e as Error).message})`); }
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let rel = line.slice(3).trim();
    const arrow = rel.indexOf(' -> '); if (arrow >= 0) rel = rel.slice(arrow + 4);
    if (rel.startsWith('"') && rel.endsWith('"')) rel = JSON.parse(rel) as string;
    const norm = rel.split(path.sep).join('/');
    if (allow.some(a => norm === a || norm.startsWith(a.replace(/\/$/, '') + '/'))) continue;
    paths.push(norm);
  }
  return [...new Set(paths)].sort();
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export interface PromotionRow {
  oracleId: string;
  name: string;
  /** The status written into the script (or that would be written, under --dry-run). */
  status: Verification['status'] | null;
  /** 'judged' | 'tested' | 'verified' | 'scripted' | 'rejected' | 'refused' | 'blocked' | 'missing' — the summary bucket. */
  bucket: string;
  note?: string;
}

export interface PromoteCardInput {
  store: ScriptStore; cards: CardDB; judges: Judges; at: string;
  scenarios?: WaveScenario[]; verdicts?: WaveVerdict[]; dryRun?: boolean;
}

/**
 * Promote ONE card: fold the wave's scenario rows and verdicts into its `verification`, derive the status, run the
 * structural check `scripts:check` runs (src/cards/scriptCheck.ts) and REFUSE a card that fails it — the block is
 * still written, with `status: 'scripted'` and the check's messages recorded as `check: …` problems, so the file
 * and `stateOf` agree and the row lands in the `refused` bucket for the orchestrator to read. `scripts:verify`
 * used to mint `verified` for a card whose printed line stayed unclaimed, and the check then rejected the promoted
 * file (Deflecting Swat, Multiversal Passage — fbf6f97); the two tools now cannot disagree here.
 */
export function promoteCard(oracleId: string, inp: PromoteCardInput): { row: PromotionRow; next?: CardScript; rejectedIssues?: string[] } {
  const { store } = inp;
  const script = store.get(oracleId);
  if (!script) return { row: { oracleId, name: '?', status: null, bucket: 'missing', note: `no script under ${path.relative(projectRoot(), store.pathFor(oracleId))}` } };
  if (!script.verification) return { row: { oracleId, name: script.name, status: null, bucket: 'missing', note: 'no verification block — run scripts:verify before promoting' } };
  const v: Verification = { ...script.verification };
  if (inp.scenarios?.length) v.scenarios = scenarioBlock(inp.scenarios);
  if (inp.verdicts?.length) v.judge = judgeBlock(inp.verdicts, inp.at);
  v.status = deriveStatus(v, inp.judges);
  const check = checkScript(oracleId, { store, cards: inp.cards }).problems;
  if (check.length) { v.status = 'scripted'; v.problems = [...(v.problems ?? []), ...check.map(p => `check: ${p}`)]; }
  // `scriptHash` excludes `verification`, so this write-back never invalidates the verification it just wrote
  const next: CardScript = { ...script, verification: { ...v, scriptHash: scriptHash(script) } };
  const bad = (inp.verdicts ?? []).filter(x => x.verdict === 'unfaithful');
  const rejectedIssues = bad.length ? (v.judge ?? []).flatMap(j => (j.verdict === 'unfaithful' ? j.issues : [])) : undefined;
  const bucket = check.length ? 'refused' : bad.length ? 'rejected' : v.status;
  if (!inp.dryRun) fs.writeFileSync(store.pathFor(oracleId), scriptFileText(next));
  return { row: { oracleId, name: script.name, status: v.status, bucket, ...(check.length ? { note: check[0] } : {}) }, next, ...(rejectedIssues ? { rejectedIssues } : {}) };
}

/** Fold one card's scenario results into the `verification.scenarios` block. */
export function scenarioBlock(rows: WaveScenario[]): Verification['scenarios'] {
  // a wave row is one CARD: `passed` says every scenario in its file passed and `scenarios` how many there are
  const passed = rows.reduce((n, r) => n + (r.passed ? Math.max(1, r.scenarios ?? 1) : 0), 0);
  const failed = rows.reduce((n, r) => n + (r.passed ? 0 : Math.max(1, r.scenarios ?? 1)), 0);
  const names = [...new Set(rows.flatMap(r => r.names ?? []))].sort();
  return { file: rows[0]?.scenarioFile ?? '', passed, failed, names };
}

/** Fold one card's verdicts into the `verification.judge` block. Issue objects are flattened to readable strings. */
export function judgeBlock(rows: WaveVerdict[], at: string): NonNullable<Verification['judge']> {
  return rows.map(v => ({
    model: v.model ?? 'unknown',
    verdict: v.verdict,
    issues: (v.issues ?? []).map(i => (typeof i === 'string' ? i : [i.line, i.expected && `expected ${i.expected}`, i.scripted && `scripted ${i.scripted}`, i.cr && `CR ${i.cr}`].filter(Boolean).join(' — '))),
    at,
  }));
}

/**
 * The status plan 2.4 derives. `judges` faithful verdicts and no unfaithful one make it `judged`; a passing blind
 * scenario per reachable ability makes it `tested`; the mechanical gate alone makes it `verified`.
 *
 * A verification that RECORDS a problem is not verified, whatever its sub-scores say: scripts:verify writes
 * `status: 'scripted'` for exactly that case (scriptVerify.ts, `passed = problems.length === 0`), and re-deriving the
 * status from schema / lint / sandbox / round trip alone used to promote a card that left a printed line unclaimed
 * (Deflecting Swat, 10.0 re-run) to `verified` — which scripts:check then rejected.
 */
export function deriveStatus(v: Verification, judges: Judges): Verification['status'] {
  if (v.schema !== 'ok' || v.lint === 'fail') return 'scripted';
  if (v.problems?.length) return 'scripted';
  const sandboxOk = v.sandbox.seats2 !== 'throws' && v.sandbox.seats2 !== 'invariant' && v.sandbox.seats4 !== 'throws' && v.sandbox.seats4 !== 'invariant';
  if (!sandboxOk || v.roundTrip.score < 0.55) return 'scripted';
  const reachable = v.sandbox.abilities.filter(a => a.reached).length;
  const tested = v.scenarios.failed === 0 && v.scenarios.passed >= Math.max(1, reachable);
  if (!tested) return 'verified';
  const list = v.judge ?? [];
  if (list.some(j => j.verdict === 'unfaithful')) return 'tested';
  return list.filter(j => j.verdict === 'faithful').length >= judges ? 'judged' : 'tested';
}

// ---------------------------------------------------------------------------
// --human: the ONLY route to `reviewed`
// ---------------------------------------------------------------------------

/** The note a person's sign-off leaves behind. Both hashes are pinned, so any later edit invalidates the review. */
export function reviewNoteFor(script: CardScript, oracleTextHash: string, by: string, at: string, note?: string): ReviewNote {
  return {
    oracleId: script.oracleId, name: script.name, by, at,
    scriptHash: scriptHash(script), oracleHash: oracleTextHash,
    ...(note ? { note } : {}),
  };
}

export interface HumanRow { oracleId: string; name: string; wrote: boolean; why?: string }

/**
 * Sign off the scripts named by `ids`. A card with no script, or whose script no longer matches the oracle text,
 * is refused rather than signed: the note would be stale the moment it was written.
 */
export function humanReview(
  ids: string[],
  opts: { by: string; at: string; note?: string; dryRun?: boolean; store?: ScriptStore; reviewedDir?: string },
): HumanRow[] {
  const store = opts.store ?? new ScriptStore();
  const rows: HumanRow[] = [];
  for (const oracleId of [...new Set(ids)].sort()) {
    const script = store.get(oracleId);
    if (!script) { rows.push({ oracleId, name: '?', wrote: false, why: 'no script to review' }); continue; }
    const def = [...poolRows({ ids: [oracleId] })][0]?.def;
    if (!def) { rows.push({ oracleId, name: script.name, wrote: false, why: 'no such card in master.db' }); continue; }
    const fresh = oracleHash(def.oracleText);
    if (script.oracleHash !== fresh) { rows.push({ oracleId, name: script.name, wrote: false, why: 'the script is stale — the oracle text changed under it' }); continue; }
    const file = reviewPathFor(oracleId, opts.reviewedDir);
    const note = reviewNoteFor(script, fresh, opts.by, opts.at, opts.note);
    if (!opts.dryRun) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(note, null, 2) + '\n'); }
    rows.push({ oracleId, name: script.name, wrote: true });
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const many = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));

  const dryRun = args.includes('--dry-run');
  const at = opt('--at') ?? process.env.MTG_PROMOTE_NOW ?? new Date().toISOString();

  // --- the human sign-off (plan 2.4's `scripts:promote --human`): no workflow result, no dirty-tree gate — it
  // writes only data/scripts/reviewed/, and what a person read is not affected by another session's work in progress
  if (args.includes('--human')) {
    const by = opt('--by') ?? '';
    if (!by.trim()) { console.error('scripts:promote --human: --by "<person>" is required (the review is signed)'); process.exit(1); }
    const ids = (opt('--ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const bad = ids.filter(id => !ORACLE_ID_RE.test(id));
    if (!ids.length || bad.length) { console.error(`scripts:promote --human: --ids <oracle_id>[,<oracle_id>…] is required${bad.length ? ` (not an oracle id: ${bad.join(', ')})` : ''}`); process.exit(1); }
    const rows = humanReview(ids, { by, at, note: opt('--note'), dryRun });
    const wrote = rows.filter(r => r.wrote);
    console.log(`${dryRun ? '[dry run] ' : ''}reviewed ${wrote.length}/${rows.length} script(s) as ${by}`);
    for (const r of wrote) console.log(`  ${r.oracleId} ${r.name} -> ${path.relative(projectRoot(), reviewPathFor(r.oracleId)).split(path.sep).join('/')}`);
    for (const r of rows.filter(x => !x.wrote)) console.log(`  SKIP ${r.oracleId} ${r.name}: ${r.why}`);
    process.exit(rows.some(r => !r.wrote) ? 1 : 0);
  }

  const resultFile = opt('--result');
  if (!resultFile) { console.error('scripts:promote: --result <workflow-result.json> is required (or --human --by … --ids …)'); process.exit(1); }
  // per CARD by default (waveScope: the owner's decks and the EDHREC top-1k need two); --judges forces the run
  const forced = opt('--judges') ? ((Number(opt('--judges')) === 2 ? 2 : 1) as Judges) : undefined;
  const allow = many('--allow-dirty').map(p => p.split(path.sep).join('/'));

  const dirty = dirtyPaths(allow);
  if (dirty.length) {
    console.error(`scripts:promote: REFUSING — ${dirty.length} path(s) under ${GUARDED_PATHS.join(' / ')} are modified or untracked:`);
    for (const p of dirty.slice(0, 40)) console.error('  ' + p);
    if (dirty.length > 40) console.error(`  … and ${dirty.length - 40} more`);
    console.error('Commit, revert, or exclude a known path with --allow-dirty <path-prefix>.');
    process.exit(1);
  }

  const { wave: waveInFile, results } = readResult(path.resolve(resultFile));
  const wave = opt('--wave') ?? waveInFile ?? 'unknown';

  const store = new ScriptStore();
  const db = CardDB.shared();
  const sources = defaultSources({ scripts: store, ...(forced ? { judges: forced } : {}) });
  const rows: PromotionRow[] = [];
  const rejected: { oracleId: string; name: string; issues: string[] }[] = [];
  const blockedWritten: string[] = [];
  const unearned: string[] = [];

  for (const batch of results) {
    const scenariosBy = new Map<string, WaveScenario[]>();
    for (const s of batch.scenarios ?? []) (scenariosBy.get(s.oracleId) ?? scenariosBy.set(s.oracleId, []).get(s.oracleId)!).push(s);
    const verdictsBy = new Map<string, WaveVerdict[]>();
    for (const v of batch.verdicts ?? []) (verdictsBy.get(v.oracleId) ?? verdictsBy.set(v.oracleId, []).get(v.oracleId)!).push(v);

    // an author may return "Name (uuid) — path" instead of a bare id (10.0 did): the uuid inside is the id
    const idOf = (s: string): string => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s)?.[0].toLowerCase() ?? s;
    const ids = [...new Set([...(batch.written ?? []), ...(batch.verified ?? [])].map(idOf))].sort();
    for (const oracleId of ids) {
      // a script that CLAIMS a person wrote it, with no review note to back that up, is reported and otherwise
      // treated as any other machine-authored script (see src/cards/scriptState.ts `unearnedHumanSource`)
      const script = store.get(oracleId);
      if (script && unearnedHumanSource(script, readReview(oracleId))) unearned.push(`${oracleId} ${script.name} (source: '${script.source}')`);
      const { row, rejectedIssues } = promoteCard(oracleId, {
        store, cards: db, judges: judgeCountFor(sources, oracleId), at, dryRun,
        scenarios: scenariosBy.get(oracleId), verdicts: verdictsBy.get(oracleId),
      });
      if (rejectedIssues) rejected.push({ oracleId, name: row.name, issues: rejectedIssues });
      rows.push(row);
    }

    // blocked[] -> data/scripts/blocked/<2-hex>/<id>.json, attempts incremented, needs matched by cardIds
    for (const b of batch.blocked ?? []) {
      const existing = readBlocked(b.oracleId);
      const def = db.getByOracleId(b.oracleId);
      const needs: BlockedNeed[] = (batch.needs ?? [])
        .filter(n => n.cardIds.includes(b.oracleId))
        .map(n => ({ opFamily: n.opFamily, proposedSignature: n.proposedSignature, semantics: n.semantics ?? n.clause, cr: n.cr, clause: n.clause }));
      const note: BlockedNote = {
        oracleId: b.oracleId,
        name: def?.name ?? existing?.name ?? '',
        clause: b.clause || existing?.clause || '',
        // keep families an earlier wave recorded; a family is listed once
        needs: dedupeNeeds([...(existing?.needs ?? []), ...needs]),
        wave,
        attempts: (existing?.attempts ?? 0) + 1,
      };
      if (!note.needs.length) note.needs = [{ opFamily: 'unclassified', semantics: b.reason }];
      const file = blockedPathFor(b.oracleId);
      if (!dryRun) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(note, null, 2) + '\n'); }
      blockedWritten.push(b.oracleId);
      rows.push({ oracleId: b.oracleId, name: note.name, status: null, bucket: 'blocked', note: note.needs.map(n => n.opFamily).join(', ') });
    }
  }

  // the summary the orchestrator pastes into the commit message
  const count = (bucket: string) => rows.filter(r => r.bucket === bucket).length;
  const header = `${dryRun ? '[dry run] ' : ''}promote ${path.basename(resultFile)} (wave ${wave}, ${forced ? `${forced} judge${forced > 1 ? 's' : ''} forced` : 'judges per card: 2 for the owner\'s decks and the EDHREC top-1k'})`;
  console.log(header);
  console.log(`  judged ${count('judged')} / tested ${count('tested')} / verified ${count('verified')} / scripted ${count('scripted')} / blocked ${count('blocked')} / rejected ${count('rejected')}${count('refused') ? ` / refused ${count('refused')}` : ''}${count('missing') ? ` / missing ${count('missing')}` : ''}`);
  for (const r of rows.filter(x => x.bucket === 'missing')) console.log(`  MISSING ${r.oracleId} ${r.name}: ${r.note}`);
  // a card scripts:check rejects is written as `scripted` with the check's message: never promoted past the check
  for (const r of rows.filter(x => x.bucket === 'refused')) console.log(`  REFUSED ${r.oracleId} ${r.name}: ${r.note}`);
  if (rejected.length) {
    console.log(`  ${rejected.length} card(s) rejected by a judge — re-author pass:`);
    for (const r of rejected) console.log(`    ${r.oracleId} ${r.name}: ${r.issues.slice(0, 2).join(' | ') || 'no issue text'}`);
  }
  if (blockedWritten.length) console.log(`  ${blockedWritten.length} blocked note(s) ${dryRun ? 'would be ' : ''}written under data/scripts/blocked/`);
  if (unearned.length) {
    console.log(`  WARN ${unearned.length} script(s) claim a human source with no review note under data/scripts/reviewed/:`);
    for (const u of unearned.slice(0, 10)) console.log(`    ${u}`);
    console.log('    The claim is ignored. Sign one off with: npm run scripts:promote -- --human --by "<person>" --ids <id>');
  }

  // a promoted card whose derived state disagrees with the file is a bug in the pipeline, not in the data
  if (!dryRun) {
    store.reset();
    for (const r of rows.filter(x => x.status)) {
      const st = stateOf(r.oracleId, sources);
      if (st.state !== r.status && st.state !== 'reviewed') console.log(`  NOTE ${r.name}: written status '${r.status}' but scriptState says '${st.state}' (${st.why})`);
    }
  }
  db.close();
}

/** One entry per op family, the first (oldest) description kept. */
function dedupeNeeds(needs: BlockedNeed[]): BlockedNeed[] {
  const seen = new Map<string, BlockedNeed>();
  for (const n of needs) if (!seen.has(n.opFamily)) seen.set(n.opFamily, n);
  return [...seen.values()].sort((a, b) => (a.opFamily < b.opFamily ? -1 : a.opFamily > b.opFamily ? 1 : 0));
}

// run only as a CLI: the tests import `dirtyPaths` / `deriveStatus` / `readResult` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
