// Move scripts out of the way without deleting them (plan 2.8). `data/scripts/_quarantine/` is one of the
// directories `ScriptStore` never indexes (NON_SHARD_DIRS in src/cards/scripts.ts), so a quarantined script stops
// being applied by the engine the moment it is moved — and moving it back restores it exactly.
//
//   npm run scripts:quarantine -- --batch data/scripts/batches/10.0/003.json
//   npm run scripts:quarantine -- --batch 3 --dir data/scripts/batches/10.0
//   npm run scripts:quarantine -- --ids 4457ed35-…,cc0e6f2a-…
//   npm run scripts:quarantine -- --restore --batch 3 --dir data/scripts/batches/10.0
//
// `--batch <n>` needs `--dir` (the wave directory); `--batch <file>` does not. `--dry-run` lists the moves only.
// The quarantine directory is gitignored, so a quarantined script leaves the tracked tree — that is the point: the
// orchestrator quarantines a batch whose scripts broke a gate, re-runs `verify:quick`, and restores or re-authors.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { projectRoot } from '../src/config/paths.js';
import { DEFAULT_SCRIPTS_DIR, ORACLE_ID_RE, ScriptStore, shardOf } from '../src/cards/scripts.js';

export const QUARANTINE_DIR = (): string => path.join(DEFAULT_SCRIPTS_DIR(), '_quarantine');

/** Where a quarantined script lives: the same shard layout, under `_quarantine/`. */
export function quarantinePathFor(oracleId: string, dir = QUARANTINE_DIR()): string {
  return path.join(dir, shardOf(oracleId), `${oracleId}.json`);
}

/** The oracle ids a batch file names (the `cards[]` of a `scripts:queue` batch, blind or not). */
export function idsOfBatch(file: string): string[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { cards?: { oracleId?: string }[] };
  if (!Array.isArray(raw.cards)) throw new Error(`${file}: not a batch file (no cards[])`);
  return raw.cards.map(c => String(c.oracleId)).filter(id => ORACLE_ID_RE.test(id));
}

export interface Move { oracleId: string; from: string; to: string; done: boolean; why?: string }

/** Move a script into (or, with `restore`, out of) the quarantine. Never overwrites an existing file at the target. */
export function move(oracleId: string, opts: { restore?: boolean; dryRun?: boolean; store?: ScriptStore; quarantineDir?: string } = {}): Move {
  const store = opts.store ?? new ScriptStore();
  const live = store.pathFor(oracleId);
  const held = quarantinePathFor(oracleId, opts.quarantineDir ?? path.join(store.dir, '_quarantine'));
  const from = opts.restore ? held : live;
  const to = opts.restore ? live : held;
  if (!fs.existsSync(from)) return { oracleId, from, to, done: false, why: opts.restore ? 'not in the quarantine' : 'no script to quarantine' };
  if (fs.existsSync(to)) return { oracleId, from, to, done: false, why: `a file already exists at ${path.relative(projectRoot(), to)}` };
  if (!opts.dryRun) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
  return { oracleId, from, to, done: true };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const restore = args.includes('--restore');
  const dryRun = args.includes('--dry-run');

  let ids: string[] = [];
  const batch = opt('--batch');
  if (batch) {
    const file = /^\d+$/.test(batch)
      ? path.join(opt('--dir') ?? path.join(DEFAULT_SCRIPTS_DIR(), 'batches'), `${batch.padStart(3, '0')}.json`)
      : batch;
    if (!fs.existsSync(file)) { console.error(`scripts:quarantine: no such batch file: ${file}`); process.exit(1); }
    ids = idsOfBatch(file);
  } else if (opt('--ids')) {
    ids = (opt('--ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  } else {
    console.error('scripts:quarantine: --batch <file|number> (with --dir for a number) or --ids a,b,c is required');
    process.exit(1);
  }

  const store = new ScriptStore();
  const moves = ids.map(id => move(id, { restore, dryRun, store }));
  const done = moves.filter(m => m.done);
  console.log(`${dryRun ? '[dry run] ' : ''}${restore ? 'restored' : 'quarantined'} ${done.length}/${moves.length} script(s)`);
  for (const m of done) console.log(`  ${m.oracleId} -> ${path.relative(projectRoot(), m.to).split(path.sep).join('/')}`);
  for (const m of moves.filter(x => !x.done)) console.log(`  SKIP ${m.oracleId}: ${m.why}`);
  process.exit(moves.some(m => !m.done && m.why?.startsWith('a file already exists')) ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
