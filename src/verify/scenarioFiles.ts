// JSON scenario files: the blind behavioural corpus. One file per card, sharded by the first two hex digits of its
// oracle id so a directory never grows past a few hundred entries:
//   data/scenarios/44/4457ed35-7c10-48c8-9776-456485fdf070.json = { oracleId, name, scenarios: Scenario[] }
// The files are plain data in the same DSL the TS suites use (src/verify/scenarioDsl.ts), which is what lets a
// scenario author work blind: they never see engine code, only the card text and this vocabulary.
// Consumers: scripts/verify-scenarios.ts (sharded runner) and test/scenarios-data.test.ts (a sample inside npm test).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
import { validateScenario, type Scenario } from './scenarioDsl.js';

export interface ScenarioFile { oracleId: string; name: string; scenarios: Scenario[] }
/** A file read off disk, with the path it came from. */
export interface LoadedScenarioFile extends ScenarioFile { path: string }

const ORACLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The corpus root. Scenario files are committed source (not generated data), so they live in the *worktree's* own
 * data/ directory — never DATA_DIR(), which points a linked worktree at the main checkout's gitignored database.
 */
export function scenarioDir(): string { return path.join(projectRoot(), 'data', 'scenarios'); }

/** Where a card's scenarios belong: <dir>/<first two hex digits>/<oracle id>.json. */
export function shardPathFor(oracleId: string, dir = scenarioDir()): string {
  const id = oracleId.trim().toLowerCase();
  if (!ORACLE_ID.test(id)) throw new Error(`not an oracle id: ${oracleId}`);
  return path.join(dir, id.slice(0, 2), `${id}.json`);
}

/** Every scenario file under `dir`, sorted by oracle id so any run order is reproducible. */
export function listScenarioFiles(dir = scenarioDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const shard of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, shard.name))) if (f.endsWith('.json')) out.push(path.join(dir, shard.name, f));
  }
  return out.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : path.basename(a) > path.basename(b) ? 1 : 0));
}

/** Parse and validate one file; throws with every problem listed at once so a bad file is fixed in one pass. */
export function readScenarioFile(file: string): LoadedScenarioFile {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: not valid JSON (${(e as Error).message})`); }
  const f = raw as Partial<ScenarioFile>;
  const problems: string[] = [];
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error(`${file}: expected an object { oracleId, name, scenarios }`);
  if (typeof f.oracleId !== 'string' || !ORACLE_ID.test(f.oracleId)) problems.push('oracleId is missing or not an oracle id');
  if (typeof f.name !== 'string' || !f.name) problems.push('name is missing');
  if (!Array.isArray(f.scenarios) || !f.scenarios.length) problems.push('scenarios is empty');
  if (typeof f.oracleId === 'string' && ORACLE_ID.test(f.oracleId)) {
    const want = shardPathFor(f.oracleId, path.resolve(file, '..', '..'));
    if (path.resolve(file) !== path.resolve(want)) problems.push(`lives at the wrong path (expected ${path.relative(process.cwd(), want)})`);
  }
  for (const sc of Array.isArray(f.scenarios) ? f.scenarios : []) problems.push(...validateScenario(sc, { card: typeof f.name === 'string' ? f.name : undefined }));
  if (problems.length) throw new Error(`${file}:\n  - ${problems.join('\n  - ')}`);
  return { ...(f as ScenarioFile), path: file };
}

/** The files of the given oracle ids that exist (unknown ids are reported by the caller, not silently dropped). */
export function forIds(ids: string[], dir = scenarioDir()): string[] {
  return ids.map(id => shardPathFor(id, dir)).filter(p => fs.existsSync(p));
}

/** Scenario files added or modified in the working tree (`git status --porcelain -- data/scenarios`). */
export function changed(dir = scenarioDir()): string[] {
  const root = projectRoot();
  const spec = path.relative(root, dir).split(path.sep).join('/') || 'data/scenarios';
  let out = '';
  // -uall so a brand new shard directory is reported file by file, not as one "data/scenarios/" entry
  try { out = execFileSync('git', ['status', '--porcelain', '-uall', '--', spec], { cwd: root, encoding: 'utf8' }); }
  catch { return []; }
  const files: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let rel = line.slice(3).trim();                       // "XY <path>", renames read "old -> new"
    const arrow = rel.indexOf(' -> '); if (arrow >= 0) rel = rel.slice(arrow + 4);
    if (rel.startsWith('"') && rel.endsWith('"')) rel = JSON.parse(rel) as string;
    if (!rel.endsWith('.json')) continue;
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) files.push(abs);
  }
  return [...new Set(files)].sort();
}
