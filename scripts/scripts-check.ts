// Validate the scripts under data/scripts. The check itself is `checkScript` in src/cards/scriptCheck.ts (schema,
// LF-only bytes, oracle-hash freshness, substantive effects and line budgets, covers / ignore validity, no
// `unknown`, every face fully simulated — see that file's header); this CLI only selects the ids and prints. The
// promoter runs the same `checkScript` on every card it promotes and refuses one that fails, so the two tools
// cannot disagree about a script. Exit 1 on problems.
//
//   npm run scripts:check                 # every script (default)
//   npm run scripts:check -- --changed    # only files git reports as modified/untracked under data/scripts
//   npm run scripts:check -- --ids a,b,c
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CardDB } from '../src/cards/db.js';
import { checkIds } from '../src/cards/scriptCheck.js';
import { ScriptStore } from '../src/cards/scripts.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const mode = args.includes('--ids') ? 'ids' : args.includes('--changed') ? 'changed' : 'all';

const store = new ScriptStore();

/** Oracle ids to check, per --all / --changed / --ids. */
function selectIds(): string[] {
  if (mode === 'ids') return (opt('--ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (mode === 'all') return store.ids();
  // --changed: git's view of data/scripts, untracked directories expanded
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain', '--', 'data/scripts'], { encoding: 'utf8' }); }
  catch { console.log('--changed: git is unavailable here; falling back to --all'); return store.ids(); }
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    const p = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!p) continue;
    if (p.endsWith('/')) { walk(p, files); continue; }
    if (p.endsWith('.json')) files.add(p);
  }
  const ids: string[] = [];
  for (const f of files) { const id = path.basename(f, '.json'); if (store.fileOf(id)) ids.push(id); }
  return ids;
}

function walk(rel: string, into: Set<string>) {
  if (!fs.existsSync(rel)) return;
  for (const e of fs.readdirSync(rel, { withFileTypes: true })) {
    const p = path.posix.join(rel.replace(/\\/g, '/').replace(/\/$/, ''), e.name);
    if (e.isDirectory()) walk(p, into); else if (e.name.endsWith('.json')) into.add(p);
  }
}

const cards = CardDB.shared();
const ids = selectIds();
const { ok, problems, warnings: warn, info } = checkIds(ids, { store, cards });

console.log(`${ok} script(s) checked${mode === 'all' ? '' : ` (--${mode})`}, ${problems.length} problem(s)${warn.length ? `, ${warn.length} warning(s)` : ''}`);
for (const p of problems) console.log('  ' + p);
for (const w of warn) console.log('  WARN ' + w);
for (const i of info) console.log('  INFO ' + i);
cards.close();
process.exit(problems.length ? 1 : 0);
