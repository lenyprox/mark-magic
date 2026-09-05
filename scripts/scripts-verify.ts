// The mechanical gate for a batch of card scripts (plan 2.2, phase 8c): schema -> freshness -> registry -> lint ->
// 2p/4p sandbox with per-ability reachability probes -> round-trip renderer -> write-back. The pipeline itself is
// `verifyCards` in src/verify/scriptVerify.ts (re-exported here, which is what test/scripts-verify.test.ts drives);
// this file is the argument parsing, the console report and the exit code.
//
//   npm run scripts:verify -- --ids a,b,c            # exactly these oracle ids; never parses the whole pool
//   npm run scripts:verify -- --batch <file>         # the 8k queue format, or any JSON carrying oracle ids
//   npm run scripts:verify -- --changed              # scripts git reports as modified / untracked
//   npm run scripts:verify -- --stale                # scripts whose verification block is missing or out of date
//   npm run scripts:verify -- --ids … --report <path> --json --no-write --seats 2 --dir <scripts dir>
//
// Exit 1 when any card has a problem, 2 when the arguments are wrong. `--report` defaults to
// data/scripts/reports/<batch>.json (gitignored) and is written only for `--batch` or an explicit `--report`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CardDB } from '../src/cards/db.js';
import { DEFAULT_SCRIPTS_DIR, ScriptStore } from '../src/cards/scripts.js';
import { batchNameOf, idsInBatch, staleIds, verifyCards, type VerifyReport } from '../src/verify/scriptVerify.js';
import type { Seats } from '../src/verify/sandbox.js';

export { verifyCards } from '../src/verify/scriptVerify.js';

const USAGE = 'usage: scripts:verify -- (--batch <file> | --ids a,b,c | --changed | --stale) [--dir <scripts dir>] [--report <path>] [--json] [--no-write] [--no-sandbox] [--seats 2|4|both]';

/** Every `.json` under a directory git reported as untracked, relative to the repo root. */
function walkJson(rel: string, into: Set<string>): void {
  if (!fs.existsSync(rel)) return;
  for (const e of fs.readdirSync(rel, { withFileTypes: true })) {
    const p = path.posix.join(rel.replace(/\\/g, '/').replace(/\/$/, ''), e.name);
    if (e.isDirectory()) walkJson(p, into); else if (e.name.endsWith('.json')) into.add(p);
  }
}

/** `--changed`: the scripts git reports as modified or untracked under data/scripts. */
function changedIds(store: ScriptStore): string[] {
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain', '--', 'data/scripts'], { encoding: 'utf8' }); }
  catch { console.log('--changed: git is unavailable here; falling back to every script'); return store.ids(); }
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    const p = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!p) continue;
    if (p.endsWith('/')) walkJson(p, files); else if (p.endsWith('.json')) files.add(p);
  }
  const ids: string[] = [];
  for (const f of files) { const id = path.basename(f, '.json'); if (store.fileOf(id)) ids.push(id); }
  return ids;
}

async function main(argv: string[]): Promise<number> {
  const die = (msg: string): number => { console.error(msg); console.error(USAGE); return 2; };
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const modes = ['--batch', '--ids', '--changed', '--stale'].filter(m => argv.includes(m));
  if (modes.length !== 1) return die(modes.length ? `pick exactly one of ${modes.join(' ')}` : 'no mode given');

  const dir = opt('--dir') ?? DEFAULT_SCRIPTS_DIR();
  const store = new ScriptStore(dir);
  let ids: string[] = [];
  let batch: string | undefined;
  if (argv.includes('--ids')) {
    ids = (opt('--ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return die('--ids needs a comma-separated list of oracle ids');
  } else if (argv.includes('--batch')) {
    const file = opt('--batch');
    if (!file) return die('--batch needs a file');
    if (!fs.existsSync(file)) return die(`no such batch file: ${file}`);
    let json: unknown;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return die(`${file} is not valid JSON (${(e as Error).message})`); }
    ids = idsInBatch(json);
    batch = batchNameOf(json, file);
    if (!ids.length) return die(`${file} carries no oracle ids`);
  } else if (argv.includes('--changed')) {
    ids = changedIds(store);
  } else {
    ids = staleIds(store);
  }

  const seatArg = opt('--seats');
  const seats: Seats[] = seatArg === '2' ? [2] : seatArg === '4' ? [4] : [2, 4];
  const reportPath = opt('--report');
  const cards = CardDB.shared();
  const report = await verifyCards(ids, {
    dir, cards, seats, batch: batch ?? (reportPath ? 'adhoc' : undefined), reportPath,
    write: !argv.includes('--no-write'), skipSandbox: argv.includes('--no-sandbox'),
  });
  cards.close();

  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report, reportPath ?? (batch ? path.join(dir, 'reports', `${batch}.json`) : null));
  return report.summary.problems ? 1 : 0;
}

function printReport(r: VerifyReport, file: string | null): void {
  const s = r.summary;
  console.log(`${s.total} script(s) verified in ${(s.ms / 1000).toFixed(1)}s — ${s.verified} verified, ${s.scripted} scripted, ${s.stale} stale, ${s.missing} missing; ${s.problems} problem(s), ${s.unreached} unreached abilit${s.unreached === 1 ? 'y' : 'ies'}`);
  for (const c of r.cards) {
    const reach = c.sandbox.abilities.length ? ` reach ${c.sandbox.abilities.filter(a => a.reached).length}/${c.sandbox.abilities.length}` : '';
    console.log(`  ${c.status.toUpperCase().padEnd(9)} ${c.name} — schema ${c.schema}, lint ${c.lint}, sandbox ${c.sandbox.seats2}/${c.sandbox.seats4}, round trip ${c.roundTrip.score.toFixed(2)}${reach} (${c.ms} ms)`);
    for (const p of c.problems) console.log(`      ${p}`);
    for (const w of c.warnings) console.log(`      WARN ${w}`);
    for (const l of c.roundTrip.lowest) console.log(`      LOW  ${l.score.toFixed(2)} ${JSON.stringify(l.text)} -> ${JSON.stringify(l.rendered)}`);
  }
  if (file) console.log(`report: ${file}`);
}

// Imported by the tests (for `verifyCards`) as well as run as a CLI, so the CLI only runs when it IS the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
