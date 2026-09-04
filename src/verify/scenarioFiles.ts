// JSON scenario files: the blind behavioural corpus. One file per card, sharded by the first two hex digits of its
// oracle id so a directory never grows past a few hundred entries:
//   data/scenarios/44/4457ed35-7c10-48c8-9776-456485fdf070.json = { oracleId, name, scenarios: Scenario[] }
// The files are plain data in the same DSL the TS suites use (src/verify/scenarioDsl.ts), which is what lets a
// scenario author work blind: they never see engine code, only the card text and this vocabulary.
// Consumers: scripts/verify-scenarios.ts (sharded runner) and test/scenarios-data.test.ts (a sample inside npm test).
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, USER_DB } from '../config/paths.js';
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

/** The oracle id a corpus file is named after. */
export const oracleIdOf = (file: string): string => path.basename(file, '.json').toLowerCase();
const byOracleId = (a: string, b: string) => (oracleIdOf(a) < oracleIdOf(b) ? -1 : oracleIdOf(a) > oracleIdOf(b) ? 1 : 0);

/** Every scenario file under `dir`, sorted by oracle id so any run order is reproducible. */
export function listScenarioFiles(dir = scenarioDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const shard of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, shard.name))) if (f.endsWith('.json')) out.push(path.join(dir, shard.name, f));
  }
  return out.sort(byOracleId);
}

/**
 * Oracle ids of every card in the owner's own decks (user.db, role 'mine'); [] when there is no user database, which
 * is the case in CI and in a fresh clone. Opened read-only and with `fileMustExist`, so reading the sample never
 * creates or migrates the owner's database.
 */
export function ownerDeckOracleIds(dbPath = USER_DB()): string[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT DISTINCT c.oracle_id AS id FROM deck_cards c JOIN decks d ON d.id = c.deck_id WHERE d.role = 'mine'").all() as { id: string }[];
    return [...new Set(rows.map(r => String(r.id).toLowerCase()).filter(id => ORACLE_ID.test(id)))].sort();
  } catch { return []; }                                  // no schema yet, or the file is locked: fall back to the seeded draw alone
  finally { try { db?.close(); } catch { /* ignore */ } }
}

/** Deterministic PRNG (mulberry32): the same corpus and seed always draw the same sample. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The seed the `npm test` sample uses; change it to rotate which cards the fast run covers. */
export const SAMPLE_SEED = 8004;

/**
 * A deterministic sample of the corpus: every file for a card in `must` (the owner's decks — the cards Phase 10.0 is
 * gated on) plus `seeded` more drawn from the rest with a seeded shuffle. Not a lexicographic prefix: a prefix would
 * pin `npm test` to the alphabetically first shards forever and never touch the other ~99% of a grown corpus.
 */
export function sampleScenarioFiles(files: string[], opts: { seeded: number; seed?: number; must?: string[] } = { seeded: 200 }): string[] {
  const must = new Set((opts.must ?? []).map(id => id.trim().toLowerCase()));
  const picked = files.filter(f => must.has(oracleIdOf(f)));
  const rest = files.filter(f => !must.has(oracleIdOf(f)));
  if (rest.length <= opts.seeded) return [...files].sort(byOracleId);
  const bag = [...rest].sort(byOracleId);                 // shuffle a sorted list, so the draw does not depend on readdir order
  const next = mulberry32(opts.seed ?? SAMPLE_SEED);
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  return [...picked, ...bag.slice(0, opts.seeded)].sort(byOracleId);
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
