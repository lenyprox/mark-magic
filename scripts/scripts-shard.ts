// Move flat data/scripts/<oracle_id>.json files into their shard (data/scripts/<first two hex chars>/), the v2
// layout. Idempotent: a file already in the right shard is left alone; a flat duplicate of a sharded file is
// removed only when the two are byte-identical, otherwise it is reported and left for a person.
//   npm run scripts:shard [-- --dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCRIPTS_DIR, ORACLE_ID_RE, shardOf } from '../src/cards/scripts.js';

const dry = process.argv.includes('--dry-run');
const dir = DEFAULT_SCRIPTS_DIR();
if (!fs.existsSync(dir)) { console.log(`no ${dir} — nothing to do`); process.exit(0); }

let moved = 0, already = 0, removedDupes = 0;
const conflicts: string[] = [];

for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  if (e.isDirectory() || !e.name.endsWith('.json')) continue;
  const id = e.name.slice(0, -5);
  if (!ORACLE_ID_RE.test(id)) continue;   // schema.json and friends are tooling output, not scripts
  const from = path.join(dir, e.name);
  const to = path.join(dir, shardOf(id), e.name);
  if (fs.existsSync(to)) {
    if (fs.readFileSync(from, 'utf8') === fs.readFileSync(to, 'utf8')) { if (!dry) fs.rmSync(from); removedDupes++; }
    else conflicts.push(`${id}: a different script already exists at ${path.relative(process.cwd(), to)} — resolve by hand`);
    continue;
  }
  if (!dry) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
  moved++;
}

// count what is already sharded, so the summary reads as a state and not just a delta
for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  if (!e.isDirectory() || !/^[0-9a-f]{2}$/.test(e.name)) continue;
  already += fs.readdirSync(path.join(dir, e.name)).filter(f => f.endsWith('.json') && ORACLE_ID_RE.test(f.slice(0, -5))).length;
}

console.log(`${dry ? '[dry run] ' : ''}${moved} script(s) moved into shards, ${removedDupes} flat duplicate(s) removed, ${already} already sharded`);
for (const c of conflicts) console.log('  ' + c);
process.exit(conflicts.length ? 1 : 0);
