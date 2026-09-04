// Import collection files (count,name CSVs, Moxfield/Archidekt exports, Arena/plain deck text) into data/user.db.
//   npm run collection:import -- decks/*.csv [--as-decks] [--format commander] [--replace] [--merge] [--commander "file=Card Name"] [--dry-run]
// Globs are expanded here (Windows shells do not). Each file becomes one source; re-importing an unchanged file is a no-op.
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { CollectionStore } from '../src/collection/store.js';
import { parseCollectionText } from '../src/collection/formats.js';
import { deckNameFromFile } from '../src/collection/names.js';
import { openUserDb } from '../src/user/db.js';

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(k);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const commanderOverrides = new Map<string, string>();
for (let i = 0; i < args.length; i++) if (args[i] === '--commander' && args[i + 1]) { const [file, name] = args[i + 1].split('='); if (file && name) commanderOverrides.set(path.basename(file), name); }

function expand(patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (p.startsWith('--')) { if (['--format', '--commander'].includes(p)) patterns.splice(patterns.indexOf(p) + 1, 1); continue; }
    if (p.includes('*')) {
      const dir = path.dirname(p); const re = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f));
    } else if (fs.existsSync(p)) { if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) { if (/\.(csv|txt)$/i.test(f)) out.push(path.join(p, f)); } else out.push(p); }
    else console.error(`skip ${p}: not found`);
  }
  return [...new Set(out)];
}

const files = expand(args.filter((a, i) => !a.startsWith('--') && !['--format', '--commander'].includes(args[i - 1] ?? '')));
if (!files.length) { console.error('usage: npm run collection:import -- <files or globs> [--as-decks] [--format commander] [--replace] [--merge] [--commander "file=Card"] [--dry-run]'); process.exit(2); }

const cards = CardDB.shared();
const db = openUserDb();
const store = new CollectionStore(db, cards);
const dry = flag('--dry-run');
const asDecks = flag('--as-decks');
const format = opt('--format') ?? 'commander';

if (flag('--replace') && !dry) { store.clear(); console.log('cleared the collection'); }

let totalRows = 0, totalCopies = 0, totalUnresolved = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const base = path.basename(file);
  if (dry) {
    const parsed = parseCollectionText(text, base);
    const label = deckNameFromFile(base);
    let unresolved = 0; const ids: string[] = [];
    for (const r of parsed.rows) { const res = store['resolver'].resolve(r.name); if (res.oracleId) ids.push(res.oracleId); else { unresolved++; console.log(`  ? ${base}:${r.line} ${r.name}`); } }
    const inf = store.inferCommanderFor(label, ids);
    const copies = parsed.rows.reduce((a, r) => a + r.count, 0);
    console.log(`${base}: ${parsed.format}, ${parsed.rows.length} rows, ${copies} copies, ${unresolved} unresolved, deck "${label}", commander ${inf.pick ? `${inf.pick.name} (${inf.confidence})` : `none (${inf.confidence}${inf.candidates.length ? ': ' + inf.candidates.slice(0, 4).map(c => c.name).join(' / ') : ''})`}`);
    for (const e of parsed.errors) console.log(`  ! line ${e.line}: ${e.reason}`);
    totalRows += parsed.rows.length; totalCopies += copies; totalUnresolved += unresolved;
    continue;
  }
  const override = commanderOverrides.get(base);
  let commander: string | null | undefined = undefined;
  if (override) { const def = cards.get(override); if (!def) { console.error(`  ! commander "${override}" not found for ${base}`); } else commander = def.oracleId; }
  const r = store.importText(text, base, { mode: flag('--merge') ? 'merge' : 'replace', asDeck: asDecks ? { format, role: 'mine', commander } : null });
  const cmd = r.deck ? r.deck.cards.find(c => c.board === 'commander')?.name ?? 'none' : '-';
  console.log(`${base}: ${r.format}, ${r.source.rows} rows, ${r.copies} copies, ${r.unresolved.length} unresolved${r.skipped ? ', unchanged' : ''}${r.deck ? `, deck "${r.deck.name}" (commander: ${cmd}${r.commander && !r.commander.pick && r.commander.candidates.length ? `; candidates: ${r.commander.candidates.slice(0, 4).map(c => c.name).join(' / ')}` : ''})` : ''}`);
  for (const u of r.unresolved) console.log(`  ? line ${u.line}: ${u.name}`);
  for (const e of r.errors) console.log(`  ! line ${e.line}: ${e.reason}`);
  totalRows += r.source.rows; totalCopies += r.copies; totalUnresolved += r.unresolved.length;
}
const s = dry ? null : store.stats();
console.log(`\n${files.length} file(s): ${totalRows} rows, ${totalCopies} copies, ${totalUnresolved} unresolved${s ? `; collection now ${s.distinct} distinct cards, ${s.copies} copies, ${s.sources} sources` : ' (dry run, nothing written)'}`);
db.close();
