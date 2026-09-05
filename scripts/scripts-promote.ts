// Promote a finished script wave (plan 2.4 / 2.8). Reads the `script-wave` workflow's return value — the shape in
// plan Part 5 — and writes the parts of `verification` the workflow produced but no single agent owns: the blind
// scenario results, the judge verdicts, the derived `status`, and a blocked note per card the authors could not
// express. Deterministic, and run only by the orchestrator.
//
//   npm run scripts:promote -- --result data/scripts/reports/10.0-run1.json
//   npm run scripts:promote -- --result <file> --judges 2 --wave 10.0 --dry-run
//   npm run scripts:promote -- --result <file> --allow-dirty apps/web/lib/gl --allow-dirty test/scenemap.test.ts
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
  blockedPathFor, defaultSources, readBlocked, stateOf, type BlockedNeed, type BlockedNote,
} from '../src/cards/scriptState.js';
import { ScriptStore, scriptHash, type CardScript, type Verification } from '../src/cards/scripts.js';
import { CardDB } from '../src/cards/db.js';

// ---------------------------------------------------------------------------
// The workflow result (plan Part 5, `script-wave`'s return value)
// ---------------------------------------------------------------------------

export interface WaveBlocked { oracleId: string; clause: string; reason: string }
export interface WaveNeed { opFamily: string; proposedSignature: string; clause: string; cardIds: string[]; semantics?: string; cr?: string }
export interface WaveScenario { oracleId: string; scenarioFile: string; passed: boolean; failure?: string; names?: string[] }
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
  /** 'judged' | 'tested' | 'verified' | 'scripted' | 'rejected' | 'blocked' | 'missing' — the summary bucket. */
  bucket: string;
  note?: string;
}

/** Fold one card's scenario results into the `verification.scenarios` block. */
export function scenarioBlock(rows: WaveScenario[]): Verification['scenarios'] {
  const passed = rows.filter(r => r.passed).length;
  const failed = rows.length - passed;
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
 */
export function deriveStatus(v: Verification, judges: 1 | 2): Verification['status'] {
  if (v.schema !== 'ok' || v.lint === 'fail') return 'scripted';
  const sandboxOk = v.sandbox.seats2 !== 'throws' && v.sandbox.seats2 !== 'invariant' && v.sandbox.seats4 !== 'throws' && v.sandbox.seats4 !== 'invariant';
  if (!sandboxOk || v.roundTrip.score < 0.55) return 'scripted';
  const reachable = v.sandbox.abilities.filter(a => a.reached).length;
  const tested = v.scenarios.failed === 0 && v.scenarios.passed >= Math.max(1, reachable);
  if (!tested) return 'verified';
  const list = v.judge ?? [];
  if (list.some(j => j.verdict === 'unfaithful')) return 'tested';
  return list.filter(j => j.verdict === 'faithful').length >= judges ? 'judged' : 'tested';
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const many = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));

  const resultFile = opt('--result');
  if (!resultFile) { console.error('scripts:promote: --result <workflow-result.json> is required'); process.exit(1); }
  const dryRun = args.includes('--dry-run');
  const judges = (Number(opt('--judges') ?? '1') === 2 ? 2 : 1) as 1 | 2;
  const allow = many('--allow-dirty').map(p => p.split(path.sep).join('/'));
  const at = opt('--at') ?? process.env.MTG_PROMOTE_NOW ?? new Date().toISOString();

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
  const sources = defaultSources({ scripts: store, judges });
  const rows: PromotionRow[] = [];
  const rejected: { oracleId: string; name: string; issues: string[] }[] = [];
  const blockedWritten: string[] = [];

  for (const batch of results) {
    const scenariosBy = new Map<string, WaveScenario[]>();
    for (const s of batch.scenarios ?? []) (scenariosBy.get(s.oracleId) ?? scenariosBy.set(s.oracleId, []).get(s.oracleId)!).push(s);
    const verdictsBy = new Map<string, WaveVerdict[]>();
    for (const v of batch.verdicts ?? []) (verdictsBy.get(v.oracleId) ?? verdictsBy.set(v.oracleId, []).get(v.oracleId)!).push(v);

    const ids = [...new Set([...(batch.written ?? []), ...(batch.verified ?? [])])].sort();
    for (const oracleId of ids) {
      const script = store.get(oracleId);
      if (!script) { rows.push({ oracleId, name: '?', status: null, bucket: 'missing', note: `no script under ${path.relative(projectRoot(), store.pathFor(oracleId))}` }); continue; }
      if (!script.verification) { rows.push({ oracleId, name: script.name, status: null, bucket: 'missing', note: 'no verification block — run scripts:verify before promoting' }); continue; }
      const v: Verification = { ...script.verification };
      const sc = scenariosBy.get(oracleId);
      if (sc?.length) v.scenarios = scenarioBlock(sc);
      const vs = verdictsBy.get(oracleId);
      if (vs?.length) v.judge = judgeBlock(vs, at);
      v.status = deriveStatus(v, judges);
      // `scriptHash` excludes `verification`, so this write-back never invalidates the verification it just wrote
      const next: CardScript = { ...script, verification: { ...v, scriptHash: scriptHash(script) } };
      const bad = (vs ?? []).filter(x => x.verdict === 'unfaithful');
      if (bad.length) rejected.push({ oracleId, name: script.name, issues: (v.judge ?? []).flatMap(j => (j.verdict === 'unfaithful' ? j.issues : [])) });
      rows.push({ oracleId, name: script.name, status: v.status, bucket: bad.length ? 'rejected' : v.status });
      if (!dryRun) fs.writeFileSync(store.pathFor(oracleId), JSON.stringify(next, null, 2) + '\n');
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
  const header = `${dryRun ? '[dry run] ' : ''}promote ${path.basename(resultFile)} (wave ${wave}, ${judges} judge${judges > 1 ? 's' : ''} required)`;
  console.log(header);
  console.log(`  judged ${count('judged')} / tested ${count('tested')} / verified ${count('verified')} / scripted ${count('scripted')} / blocked ${count('blocked')} / rejected ${count('rejected')}${count('missing') ? ` / missing ${count('missing')}` : ''}`);
  for (const r of rows.filter(x => x.bucket === 'missing')) console.log(`  MISSING ${r.oracleId} ${r.name}: ${r.note}`);
  if (rejected.length) {
    console.log(`  ${rejected.length} card(s) rejected by a judge — re-author pass:`);
    for (const r of rejected) console.log(`    ${r.oracleId} ${r.name}: ${r.issues.slice(0, 2).join(' | ') || 'no issue text'}`);
  }
  if (blockedWritten.length) console.log(`  ${blockedWritten.length} blocked note(s) ${dryRun ? 'would be ' : ''}written under data/scripts/blocked/`);

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
