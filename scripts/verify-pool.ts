// Pool sandbox (B10c, parallel since 8e): every fully parsed card is put in hand (or on the battlefield) in a
// sandbox with plenty of mana, every legal action for it is tried and resolved, state-based actions run, and the
// state is checked against src/engine/invariants.ts. Cards that throw or break an invariant are listed so engine
// bugs surface before a real game hits them. The trial itself lives in src/verify/sandbox.ts and the worker pool in
// src/verify/poolWorker.ts; this script owns the command line and the report (data/master/verify-pool.json).
//   npm run verify:pool [-- --workers N] [--seats 2|4|both] [--limit N] [--name "Card"] [--ids id,id] [--changed]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Seats } from '../src/verify/sandbox.js';
import { byOracleId, defaultPoolWorkers, runPool, type PoolRow, type ScanRequest } from '../src/verify/poolWorker.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k: string) => args.includes(k);

const limit = Number(opt('--limit') ?? '0'); const only = opt('--name');
const workers = Math.max(1, Number(opt('--workers') ?? String(defaultPoolWorkers(os.cpus().length))));
const seatsArg = opt('--seats') ?? '2';
if (!['2', '4', 'both'].includes(seatsArg)) { console.error(`--seats must be 2, 4 or both (got ${seatsArg})`); process.exit(2); }
const seatList: Seats[] = seatsArg === 'both' ? [2, 4] : seatsArg === '4' ? [4] : [2];
const primary: Seats = seatList[0];
const idsArg = opt('--ids')?.split(',').map(s => s.trim()).filter(Boolean);

/** Oracle ids of the scripts touched in the working tree (`data/scripts/<oracle_id>.json`). */
function changedOracleIds(): string[] {
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain', '--', 'data/scripts'], { encoding: 'utf8' }); }
  catch (e) { console.error(`--changed: git status failed (${(e as Error).message})`); return []; }
  const ids = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();                       // "XY path", with renames written "old -> new"
    const arrow = file.lastIndexOf(' -> '); if (arrow >= 0) file = file.slice(arrow + 4);
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    if (!file.endsWith('.json')) continue;
    const id = path.basename(file, '.json');
    if (/^[0-9a-f-]{30,}$/i.test(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * The cards to trial. An explicit id list goes straight to the workers; anything else needs the scanner worker,
 * which walks the database in order (so `--limit N` picks the same N cards it always did) and streams the fully
 * parsed ids to the pool while the trial workers are already busy.
 */
function source(): string[] | { scan: ScanRequest } {
  const oracleIds = idsArg ?? (flag('--changed') ? changedOracleIds() : undefined);
  if (oracleIds && !only) return limit ? oracleIds.slice(0, limit) : oracleIds;
  return { scan: { limit: limit || undefined, name: only, oracleIds } };
}

async function main() {
  const t0 = Date.now();
  let last = 0;
  const rows: PoolRow[] = await runPool(source(), {
    workers, seats: seatList,
    onProgress: done => { if (done - last >= 500) { last = done; process.stdout.write(`\r  ${done} trials, ${((Date.now() - t0) / 1000).toFixed(0)} s`); } },
  });
  process.stdout.write('\n');

  const primaryRows = rows.filter(r => r.seats === primary);
  const counts: Record<string, number> = {}; for (const r of primaryRows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const problems = rows.filter(r => r.verdict === 'sandbox-throws' || r.verdict === 'invariant-violation');
  const byDetail = new Map<string, { n: number; cards: string[] }>();
  for (const r of problems) { const k = (r.detail ?? '').replace(/\d+/g, '#').slice(0, 80); const e = byDetail.get(k) ?? { n: 0, cards: [] }; e.n++; if (e.cards.length < 5) e.cards.push(r.name); byDetail.set(k, e); }
  const report = {
    generated_at: new Date().toISOString(), cards: primaryRows.length, seats: seatsArg, workers, counts,
    seconds: Math.round((Date.now() - t0) / 1000),
    top_problems: [...byDetail].sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([detail, e]) => ({ n: e.n, detail, cards: e.cards })),
    by_oracle_id: byOracleId(rows, primary),
    problems: problems.slice(0, 2000),
  };
  fs.mkdirSync('data/master', { recursive: true });
  fs.writeFileSync('data/master/verify-pool.json', JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, by_oracle_id: undefined, problems: undefined }, null, 1));
  if (only) for (const r of rows) console.log(r);
}
main().catch(e => { console.error(e); process.exit(1); });
