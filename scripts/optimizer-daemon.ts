// Detached optimiser worker: runs one stored run to completion with a pool of worker threads, heartbeating into
// user.db so the web app can show progress, pause on a lost heartbeat and resume from the checkpoint.
//   npm run optimize:daemon -- --run <id> [--workers N] [--log file]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { CardQueryDB } from '../src/cards/query.js';
import { DATA_DIR, USER_DB } from '../src/config/paths.js';
import { runOptimizer } from '../src/optimizer/runner.js';
import { OptimizerStore } from '../src/optimizer/store.js';
import { BatchPool, defaultBatchPoolSize } from '../src/sim/batchPool.js';
import { nodeBatchWorker } from '../src/sim/nodeWorker.js';
import { openUserDb } from '../src/user/db.js';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const runId = opt('--run'); if (!runId) { console.error('usage: optimizer-daemon --run <id> [--workers N]'); process.exit(2); }
const workers = Number(opt('--workers', String(defaultBatchPoolSize(os.cpus().length))));
const logFile = opt('--log') ?? path.join(DATA_DIR(), 'optimizer', `${runId}.log`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = (msg: string) => { const line = `${new Date().toISOString()} ${msg}\n`; fs.appendFileSync(logFile, line); if (process.stdout.isTTY) process.stdout.write(line); };

async function main() {
  const db = openUserDb(USER_DB());
  const cards = CardDB.shared();
  let query: CardQueryDB | null = null;
  try { const q = new CardQueryDB(cards.db); if (q.hasWebIndex()) { q.attachUser(USER_DB()); query = q; } } catch { query = null; }
  const store = new OptimizerStore(db);
  const run = store.get(runId!); if (!run) { log(`run ${runId} not found`); process.exit(1); }
  if (run.status === 'done' || run.status === 'cancelled') { log(`run ${runId} already ${run.status}`); process.exit(0); }
  const pool = workers > 1 ? new BatchPool(nodeBatchWorker, workers) : null;
  if (pool) await pool.ready();
  log(`start run ${runId} (${run.spec.name}) with ${workers} worker(s), pid ${process.pid}`);
  const beat = setInterval(() => { try { const p = store.get(runId!)?.progress; if (p) store.saveProgress(runId!, { ...p, heartbeat: new Date().toISOString(), pid: process.pid }); } catch { /* ignore */ } }, 5000);
  try {
    const report = await runOptimizer({ db, cards, query, pool, log, pid: process.pid }, runId!);
    log(report ? `finished: best ${(report.best.winRate.value * 100).toFixed(1)}% vs baseline ${(report.baseline.winRate.value * 100).toFixed(1)}% (${report.budget.gamesSimulated} games simulated, ${report.budget.gamesReused} reused)` : 'stopped');
  } finally {
    clearInterval(beat); pool?.dispose(); db.close();
  }
}

main().catch(e => { log(`error: ${(e as Error).stack ?? e}`); process.exit(1); });
