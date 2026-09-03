// Metagame parser coverage CLI. Usage:
//   npm run coverage:meta -- [--format Modern,Legacy] [--days 90] [--fixture test/fixtures/meta/topdeck-modern.json]
//                            [--out data/master/meta-coverage.json] [--top 60] [--no-write]
// Reads synced decklists from data/user.db (or a raw TopDeck JSON file with --fixture), resolves every card name against
// master.db, and reports how much of each format's real decklists the parser fully simulates.
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { DATA_DIR, MASTER_DB, USER_DB } from '../src/config/paths.js';
import { openUserDb } from '../src/user/db.js';
import { MetaStore } from '../src/meta/store.js';
import { mapTournaments } from '../src/meta/topdeck.js';
import { NameResolver } from '../src/meta/normalize.js';
import { computeCoverage, formatCoverageTable, masterLookup, type CoverageDeck } from '../src/meta/coverage.js';

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
  if (args.help) {
    console.log('usage: meta-coverage [--format Modern,Standard,Pioneer,Legacy] [--days 90] [--fixture <topdeck.json>] [--out <file>] [--top 60] [--no-write]');
    process.exit(0);
  }
  if (!fs.existsSync(MASTER_DB())) { console.error(`master.db not found at ${MASTER_DB()}; run npm run data:all first`); process.exit(2); }
  const formats = String(args.format ?? 'Modern,Standard,Pioneer,Legacy').split(',').map(s => s.trim()).filter(Boolean);
  const days = args.days ? Number(args.days) : 90;
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  const top = args.top ? Number(args.top) : 60;
  const out = typeof args.out === 'string' ? args.out : path.join(DATA_DIR(), 'master', 'meta-coverage.json');
  const cards = CardDB.shared();
  const lookup = masterLookup(cards);
  const decksByFormat: Record<string, CoverageDeck[]> = {};
  let source: 'user.db' | 'fixture' = 'user.db';

  if (typeof args.fixture === 'string') {
    if (formats.length !== 1) throw new Error('--fixture needs exactly one --format');
    source = 'fixture';
    const raw = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
    const resolver = new NameResolver(cards);
    const { decklists } = mapTournaments(raw, formats[0], cs => resolver.normalize(cs));
    decksByFormat[formats[0]] = decklists.map(d => ({ id: d.sourceId, archetype: d.archetype, archetypeId: null, cards: d.cards }));
  } else {
    if (!fs.existsSync(USER_DB())) console.warn(`user.db not found at ${USER_DB()}; nothing synced yet`);
    const store = new MetaStore(openUserDb());
    for (const f of formats) {
      decksByFormat[f] = store.decklists(f, { sinceDays: days, withCards: true, limit: 5000 }).map(d => ({ id: d.id, archetype: d.archetype, archetypeId: d.archetypeId, cards: d.cards }));
    }
  }

  const report = computeCoverage(decksByFormat, lookup, { topCards: top, topClauses: top, windowDays: source === 'fixture' ? null : days, source });
  console.log(formatCoverageTable(report));
  if (!args['no-write']) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${out}`);
  }
  cards.close();
}

main().catch(e => { console.error(e); process.exit(1); });
