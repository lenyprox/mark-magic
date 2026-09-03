// Metagame sync CLI. Usage:
//   npm run meta:sync -- --format Modern [--source topdeck,goldfish,17lands] [--days 30] [--set BLB] [--force]
// Reads TOPDECK_API_KEY and META_GOLDFISH_ENABLED from the environment (.env.local is loaded by the npm script).
import fs from 'node:fs';
import { CardDB } from '../src/cards/db.js';
import { MASTER_DB } from '../src/config/paths.js';
import { openUserDb } from '../src/user/db.js';
import { parseSources, runSync } from '../src/meta/sync.js';
import { META_FORMATS } from '../src/meta/types.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2); const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.format) {
    console.log(`usage: meta-sync --format <${META_FORMATS.join('|')}> [--source topdeck,goldfish,17lands] [--days 30] [--set <code>] [--force]`);
    process.exit(args.help ? 0 : 2);
  }
  const sources = parseSources(typeof args.source === 'string' ? args.source : undefined);
  const days = args.days ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  const cards = fs.existsSync(MASTER_DB()) ? CardDB.shared() : null;
  if (!cards) console.warn('warning: master.db not found; card names will not be resolved to oracle ids');
  const user = openUserDb();
  const t0 = Date.now();
  const report = await runSync({ user, cards, format: String(args.format), sources, days, set: typeof args.set === 'string' ? args.set : undefined, force: !!args.force, log: m => console.log(m) });
  console.log('');
  for (const r of report.reports) {
    const counts = Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`${r.ok ? (r.skipped ? 'SKIP' : ' OK ') : 'FAIL'} ${r.source.padEnd(8)} ${r.format.padEnd(9)} ${r.message}${counts ? `  [${counts}]` : ''}`);
  }
  console.log(`\n${report.ok ? 'done' : 'finished with errors'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  user.close();
  const hardFailure = report.reports.some(r => !r.ok && !r.skipped && r.source !== 'goldfish');
  process.exit(hardFailure ? 1 : 0);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
