// Parse snapshot: a hash of every playable card's parsed CardDef, so a parser change that is *meant* to be
// behaviour-preserving can prove it.
//
//   npm run parse:diff     reparse everything and compare with data/master/parse-snapshot.json.
//                          Prints the changed cards grouped by how their unparsed lines moved and exits 1 if any did.
//   npm run parse:accept   rewrite the snapshot (do this only when the diff is the change you intended).
//
// The snapshot is committed (see the `!data/master/parse-snapshot.json` allowlist entry in .gitignore) and lives next
// to the master file it describes, but it is resolved from the *repo root*, not DATA_DIR(): master.db is data a
// worktree borrows from the main checkout, while the snapshot is source that travels with the branch.
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { PARSER_VERSION } from '../src/cards/parse.js';
import { rulesHash } from '../src/cards/rules/_registry.js';
import { registryHash } from '../src/engine/ops/_registry.js';
import { projectRoot } from '../src/config/paths.js';
import type { CardDef } from '../src/cards/types.js';

const SNAPSHOT = path.join(projectRoot(), 'data', 'master', 'parse-snapshot.json');

/** Fields that are printing metadata or script bookkeeping, not a parse: they move with the data set, not the parser. */
const OMIT = new Set(['imageUri', 'faceImageUris', 'representativePrintingId', 'script']);

/** Canonical JSON: object keys sorted, `undefined` members dropped, OMIT fields removed at every depth. */
function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => !OMIT.has(k) && o[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

/** fnv-1a over the canonical JSON — 8 hex chars per card keeps the committed snapshot small. */
function hashDef(def: CardDef): string {
  const s = canonical(def);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface Snapshot {
  parserVersion: number;
  rulesHash: string;
  registryHash: string;
  cards: Record<string, string>;
  /** Only for cards that have any: the unparsed lines, so parse:diff can group changes by what stopped/started parsing. */
  unparsed: Record<string, string[]>;
}

function scan(): { snap: Snapshot; names: Map<string, string> } {
  const db = new CardDB();
  const cards: Record<string, string> = {};
  const unparsed: Record<string, string[]> = {};
  const names = new Map<string, string>();
  for (const c of db.all()) {
    cards[c.oracleId] = hashDef(c);
    if (c.unparsed.length) unparsed[c.oracleId] = c.unparsed;
    names.set(c.oracleId, c.name);
  }
  db.close();
  return { snap: { parserVersion: PARSER_VERSION, rulesHash: rulesHash(), registryHash: registryHash(), cards, unparsed }, names };
}

/** One line per card, keys sorted — a git diff of the snapshot is then a readable list of the cards that moved. */
function serialize(s: Snapshot): string {
  const out: string[] = ['{'];
  out.push(`  "parserVersion": ${s.parserVersion},`);
  out.push(`  "rulesHash": ${JSON.stringify(s.rulesHash)},`);
  out.push(`  "registryHash": ${JSON.stringify(s.registryHash)},`);
  const ids = Object.keys(s.cards).sort();
  out.push('  "cards": {');
  out.push(ids.map(id => `    ${JSON.stringify(id)}: ${JSON.stringify(s.cards[id])}`).join(',\n'));
  out.push('  },');
  const uids = Object.keys(s.unparsed).sort();
  out.push('  "unparsed": {');
  out.push(uids.map(id => `    ${JSON.stringify(id)}: ${JSON.stringify(s.unparsed[id])}`).join(',\n'));
  out.push('  }');
  out.push('}');
  return out.join('\n') + '\n';
}

const accept = process.argv.includes('--accept');
const { snap, names } = scan();

if (accept) {
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, serialize(snap), 'utf8');
  const kb = (fs.statSync(SNAPSHOT).size / 1024).toFixed(1);
  console.log(`parse:accept — wrote ${path.relative(process.cwd(), SNAPSHOT)}: ${Object.keys(snap.cards).length} cards, parserVersion ${snap.parserVersion}, rulesHash ${snap.rulesHash}, registryHash ${snap.registryHash} (${kb} KB)`);
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT)) {
  console.error(`parse:diff — no snapshot at ${path.relative(process.cwd(), SNAPSHOT)}. Run: npm run parse:accept`);
  process.exit(1);
}
const old = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
old.unparsed ??= {};

// Header mismatches are informational: they say *why* a diff is expected, they are not themselves the failure.
if (old.parserVersion !== snap.parserVersion) console.log(`parse:diff — parserVersion ${old.parserVersion} -> ${snap.parserVersion} (built-in parser changed)`);
if (old.rulesHash !== snap.rulesHash) console.log(`parse:diff — rulesHash ${old.rulesHash} -> ${snap.rulesHash} (parser rule families changed)`);
if (old.registryHash !== snap.registryHash) console.log(`parse:diff — registryHash ${old.registryHash} -> ${snap.registryHash} (engine op registry changed)`);

const added = Object.keys(snap.cards).filter(id => !(id in old.cards)).sort();
const removed = Object.keys(old.cards).filter(id => !(id in snap.cards)).sort();
const changed = Object.keys(snap.cards).filter(id => id in old.cards && old.cards[id] !== snap.cards[id]).sort();

// Group the changed cards by their unparsed-line delta, because that is what a parser change is usually trying to do:
// "+N these lines now parse" is a win, "-N these lines stopped parsing" is a regression, and "(same unparsed lines)"
// means the shape of an already-parsing ability moved — the group to read most carefully.
const groups = new Map<string, string[]>();
for (const id of changed) {
  const before = old.unparsed[id] ?? [];
  const after = snap.unparsed[id] ?? [];
  const gone = before.filter(l => !after.includes(l));
  const gained = after.filter(l => !before.includes(l));
  const norm = (l: string) => l.replace(/\d+/g, '#').replace(/\{[^}]+\}/g, '{}').slice(0, 90);
  const key = !gone.length && !gained.length
    ? '(same unparsed lines — an ability that already parsed changed shape)'
    : [...gone.map(l => '  now parses: ' + norm(l)), ...gained.map(l => '  NO LONGER parses: ' + norm(l))].join('\n');
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(names.get(id) ?? id);
}

for (const [key, cards] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${cards.length} card${cards.length === 1 ? '' : 's'}:\n${key}`);
  console.log('  e.g. ' + cards.slice(0, 20).join(', ') + (cards.length > 20 ? `, ... (+${cards.length - 20} more)` : ''));
}
if (added.length) console.log(`\n${added.length} card(s) new to the pool: ${added.slice(0, 20).map(id => names.get(id) ?? id).join(', ')}`);
if (removed.length) console.log(`\n${removed.length} card(s) no longer in the pool: ${removed.slice(0, 20).join(', ')}`);

console.log(`\nparse:diff — ${changed.length} changed, ${added.length} added, ${removed.length} removed of ${Object.keys(snap.cards).length} cards`);
if (changed.length || added.length || removed.length) {
  console.log('If this is the change you intended, re-baseline with: npm run parse:accept');
  process.exit(1);
}
