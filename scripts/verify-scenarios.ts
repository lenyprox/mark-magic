// Sharded behavioural scenario runner (phase 8d). Runs BOTH the TypeScript suites under test/scenarios/ and the JSON
// corpus under data/scenarios/, dealing the scenarios round-robin to worker_threads booted like src/sim/nodeWorker.ts.
// Results are sorted by file then name before anything is printed, so the report is byte-identical for any --workers.
//
//   npm run verify:scenarios
//   npm run verify:scenarios -- --workers 1
//   npm run verify:scenarios -- --ids 4457ed35-7c10-48c8-9776-456485fdf070,cc187110-1148-4090-bbb8-e205694a39f5
//   npm run verify:scenarios -- --changed            # only JSON files touched in the working tree
//   npm run verify:scenarios -- --family mechanics   # one TS suite
//   npm run verify:scenarios -- --file data/scenarios/44/4457ed35-....json
//   npm run verify:scenarios -- --json data/master/verify-scenarios.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from '../src/config/paths.js';
import { changed, forIds, listScenarioFiles, readScenarioFile, scenarioDir } from '../src/verify/scenarioFiles.js';
import { nodeScenarioWorker, type ScenarioResult, type ScenarioTask } from '../src/verify/scenarioWorker.js';
import type { Scenario } from '../src/verify/scenarioDsl.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const has = (k: string) => args.includes(k);

const root = projectRoot();
const workers = Math.max(1, Number(opt('--workers') ?? Math.max(1, os.cpus().length - 1)));
const idList = (opt('--ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const families = (opt('--family') ?? '').split(',').map(s => s.trim().replace(/\.ts$/, '')).filter(Boolean);
const onlyFiles = (opt('--file') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const outPath = path.resolve(root, opt('--json') ?? 'data/master/verify-scenarios.json');
const filtered = idList.length > 0 || families.length > 0 || onlyFiles.length > 0 || has('--changed');
const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');

// ---- collect the scenarios -------------------------------------------------------------------
const tasks: ScenarioTask[] = [];
const problems: string[] = [];

/** Is this exported value a list of scenarios? (Suites export one array; other exports are ignored.) */
function isScenarioList(v: unknown): v is Scenario[] {
  return Array.isArray(v) && v.length > 0 && v.every(x => !!x && typeof x === 'object' && typeof (x as Scenario).name === 'string' && Array.isArray((x as Scenario).script) && Array.isArray((x as Scenario).expect));
}

/** The TS suites: every module in test/scenarios/ except the DSL re-export itself, imported the way the test does. */
async function tsSuites(): Promise<void> {
  const dir = path.join(root, 'test', 'scenarios');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && f !== 'dsl.ts' && !f.endsWith('.test.ts')).sort();
  for (const f of files) {
    const family = f.replace(/\.ts$/, '');
    if (families.length && !families.includes(family)) continue;
    const mod = await import(pathToFileURL(path.join(dir, f)).href) as Record<string, unknown>;
    const lists = Object.values(mod).filter(isScenarioList);
    if (!lists.length) { problems.push(`${rel(path.join(dir, f))}: exports no scenario list`); continue; }
    for (const list of lists) for (const sc of list) tasks.push({ file: family, name: sc.name, scenario: sc });
  }
}

/** The JSON corpus, validated as it is read (a bad file is a hard error, not a silent skip). */
function jsonFiles(): void {
  let files: string[];
  if (onlyFiles.length) files = onlyFiles.map(f => path.resolve(root, f));
  else if (idList.length) {
    files = forIds(idList);
    const missing = idList.filter(id => !files.some(f => path.basename(f) === `${id}.json`));
    for (const id of missing) problems.push(`--ids: no scenario file for ${id} (expected ${rel(path.join(scenarioDir(), id.slice(0, 2), `${id}.json`))})`);
  } else if (has('--changed')) files = changed();
  else files = listScenarioFiles();
  for (const f of files) {
    try {
      const loaded = readScenarioFile(f);
      for (const sc of loaded.scenarios) tasks.push({ file: rel(f), name: sc.name, scenario: sc });
    } catch (e) { problems.push((e as Error).message); }
  }
}

if (!filtered || families.length) await tsSuites();
if (!filtered || idList.length || onlyFiles.length || has('--changed')) jsonFiles();

if (problems.length) { for (const p of problems) console.error(`! ${p}`); if (!tasks.length) process.exit(1); }
if (!tasks.length) { console.error('no scenarios selected'); process.exit(1); }

// ---- shard round-robin over the workers ------------------------------------------------------
const shards: ScenarioTask[][] = Array.from({ length: Math.min(workers, tasks.length) }, () => []);
tasks.forEach((t, i) => shards[i % shards.length].push(t));

const started = Date.now();
const results: ScenarioResult[] = await new Promise((resolve, reject) => {
  const out: ScenarioResult[] = []; const pool = shards.map(() => nodeScenarioWorker()); let done = 0; let failed = false;
  const finish = () => { for (const w of pool) w.terminate(); resolve(out); };
  pool.forEach((w, i) => {
    w.onMessage = m => {
      if (m.type === 'result') { out.push(m.result); return; }
      if (m.type === 'error') { if (failed) return; failed = true; for (const x of pool) x.terminate(); reject(new Error(`worker ${i}: ${m.message}`)); return; }
      if (++done === pool.length) finish();
    };
    w.postMessage({ type: 'run', tasks: shards[i] });
  });
});
const wallMs = Date.now() - started;

// ---- report (sorted, so any --workers gives the same bytes) ----------------------------------
results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const byFile = new Map<string, ScenarioResult[]>();
for (const r of results) (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)!).push(r);
const failures = results.filter(r => r.failures.length);

for (const [file, rows] of byFile) {
  const bad = rows.filter(r => r.failures.length).length;
  const ms = Math.round(rows.reduce((a, r) => a + r.ms, 0));
  console.log(`${bad ? 'FAIL' : ' ok '} ${file.padEnd(52)} ${String(rows.length - bad).padStart(4)}/${String(rows.length).padEnd(4)} ${String(ms).padStart(7)} ms`);
}
if (failures.length) {
  console.log('\nfailures:');
  for (const r of failures) console.log(`  [${r.file}] ${r.name}\n    - ${r.failures.join('\n    - ')}`);
}
const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log('\nslowest 5:');
for (const r of slowest) console.log(`  ${String(Math.round(r.ms)).padStart(6)} ms  [${r.file}] ${r.name}`);
const scenarioMs = Math.round(results.reduce((a, r) => a + r.ms, 0));
console.log(`\n${results.length} scenarios in ${byFile.size} files, ${failures.length} failing; ${scenarioMs} ms of scenario time in ${wallMs} ms wall across ${shards.length} worker(s)`);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  generated: new Date().toISOString(), workers: shards.length, wallMs, scenarioMs,
  totals: { scenarios: results.length, files: byFile.size, failed: failures.length },
  files: [...byFile].map(([file, rows]) => ({ file, total: rows.length, failed: rows.filter(r => r.failures.length).length, ms: Math.round(rows.reduce((a, r) => a + r.ms, 0)) })),
  results: results.map(r => ({ file: r.file, name: r.name, ms: r.ms, failures: r.failures })),
  problems,
}, null, 2) + '\n');
console.log(`wrote ${rel(outPath)}`);

if (failures.length || problems.length) process.exit(1);
