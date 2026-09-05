// The needs backlog (plan 2.8): aggregate every blocked note under data/scripts/blocked/** into
// data/scripts/needs.json, ranked by cards blocked, so the orchestrator can pick the next vocabulary families by
// cards-unlocked-per-agent-hour rather than by intuition. Also carries the pool-wide taxonomy histogram, which is
// how the plan's Part 3 "cards touching" table is re-measured after a parser or vocabulary change.
//
//   npm run scripts:needs                        # write data/scripts/needs.json and print the ranking
//   npm run scripts:needs -- --taxonomy          # the pool-wide family histogram (cards touching, lines)
//   npm run scripts:needs -- --taxonomy --tier paper --top 20 --out <file>
//   npm run scripts:needs -- --taxonomy --explain "Whenever a creature you control dies, …"
//
// A family that already exists in the registry (or in the core schema) is marked `unlocked: true` and sorted to the
// bottom: those blocked notes are spent and their cards are queueable again — `scriptState` clears them on its own,
// this file just makes the fact visible.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { projectRoot } from '../src/config/paths.js';
import { CardDB } from '../src/cards/db.js';
import { tierOf, type PoolTier } from '../src/cards/pool.js';
import { DEFAULT_SCRIPTS_DIR } from '../src/cards/scripts.js';
import { listBlocked, poolRows, unlockedOpFamilies, type BlockedNote } from '../src/cards/scriptState.js';
import {
  addToHistogram, emptyFamilyHistogram, familiesOf, familyOfLine, histogramRows, namedKeywordOfLine,
} from '../src/cards/taxonomy.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

export interface NeedRow {
  opFamily: string;
  /** True when a family of that name is already registered — the notes naming it are spent. */
  unlocked: boolean;
  cards: number;
  cardIds: string[];
  exampleClauses: string[];
  proposedSignatures: string[];
  crCitations: string[];
  /** Waves that recorded this need, and the worst `attempts` count among its cards. */
  waves: string[];
  maxAttempts: number;
}

/** Aggregate blocked notes by op family. Deterministic: every list is sorted and capped. */
export function aggregate(notes: BlockedNote[], unlocked: ReadonlySet<string>): NeedRow[] {
  const by = new Map<string, NeedRow>();
  for (const n of notes) {
    for (const need of n.needs) {
      const key = need.opFamily;
      let row = by.get(key);
      if (!row) {
        row = { opFamily: key, unlocked: unlocked.has(key.toLowerCase().replace(/[\s_]+/g, '-')), cards: 0, cardIds: [], exampleClauses: [], proposedSignatures: [], crCitations: [], waves: [], maxAttempts: 0 };
        by.set(key, row);
      }
      if (!row.cardIds.includes(n.oracleId)) { row.cardIds.push(n.oracleId); row.cards++; }
      const clause = need.clause || n.clause;
      if (clause && !row.exampleClauses.includes(clause) && row.exampleClauses.length < 5) row.exampleClauses.push(clause);
      if (need.proposedSignature && !row.proposedSignatures.includes(need.proposedSignature)) row.proposedSignatures.push(need.proposedSignature);
      if (need.cr && !row.crCitations.includes(need.cr)) row.crCitations.push(need.cr);
      if (n.wave && !row.waves.includes(n.wave)) row.waves.push(n.wave);
      row.maxAttempts = Math.max(row.maxAttempts, n.attempts);
    }
  }
  for (const r of by.values()) { r.cardIds.sort(); r.proposedSignatures.sort(); r.crCitations.sort(); r.waves.sort(); }
  // ranking: still-locked families first, then most cards blocked, then name
  return [...by.values()].sort((a, b) => Number(a.unlocked) - Number(b.unlocked) || b.cards - a.cards || (a.opFamily < b.opFamily ? -1 : 1));
}

// ---------------------------------------------------------------------------
// --taxonomy
// ---------------------------------------------------------------------------

function taxonomyMode() {
  const tier = (opt('--tier') ?? 'paper') as PoolTier | 'all';
  const top = Number(opt('--top') ?? '20');
  const explain = opt('--explain');
  if (explain) {
    const kw = namedKeywordOfLine(explain);
    const hit = familyOfLine(explain);
    console.log(JSON.stringify({ line: explain, rule: hit, namedKeyword: kw }, null, 2));
    return;
  }
  const db = CardDB.shared();
  const hist = emptyFamilyHistogram();
  let scanned = 0;
  for (const row of poolRows()) {
    if (tier !== 'all' && tierOf(row.raw as Parameters<typeof tierOf>[0]) !== tier) continue;
    scanned++;
    if (!row.def.unparsed.length && !(row.def.backFace?.unparsed.length)) continue;
    const kw = (row.raw as { keywords?: unknown }).keywords;
    addToHistogram(hist, familiesOf({ unparsed: row.def.unparsed, backFace: row.def.backFace ?? null, scryfallKeywords: Array.isArray(kw) ? (kw as unknown[]).map(String) : [] }));
  }
  const rows = histogramRows(hist);
  console.log(`taxonomy over the ${tier} pool: ${scanned} card(s) scanned, ${hist.totalCards} with unparsed text, ${hist.totalLines} unparsed line(s)`);
  console.log('');
  console.log('| Family | Cards touching | Lines |');
  console.log('|---|---:|---:|');
  for (const r of rows.slice(0, top)) console.log(`| ${r.family} | ${r.cards} | ${r.lines} |`);
  if (rows.length > top) console.log(`| … ${rows.length - top} more families | | |`);
  const out = opt('--out');
  if (out) {
    fs.writeFileSync(path.resolve(out), JSON.stringify({ tier, cardsScanned: scanned, cardsWithUnparsedText: hist.totalCards, unparsedLines: hist.totalLines, families: rows }, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
  db.close();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  if (args.includes('--taxonomy')) { taxonomyMode(); return; }
  const notes = listBlocked();
  const unlocked = unlockedOpFamilies();
  const rows = aggregate(notes, unlocked);
  const file = path.resolve(opt('--out') ?? path.join(DEFAULT_SCRIPTS_DIR(), 'needs.json'));
  const report = {
    blockedCards: notes.length,
    families: rows.length,
    stillLocked: rows.filter(r => !r.unlocked).length,
    cardsUnlockedByTopFamily: rows.find(r => !r.unlocked)?.cards ?? 0,
    needs: rows,
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`${notes.length} blocked card(s) over ${rows.length} op famil(ies) -> ${path.relative(projectRoot(), file).split(path.sep).join('/')}`);
  if (!rows.length) console.log('  (no blocked notes yet — nothing is waiting on the engine)');
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.unlocked ? '[unlocked] ' : ''}${r.opFamily}: ${r.cards} card(s)${r.maxAttempts ? `, up to ${r.maxAttempts} attempt(s)` : ''}`);
    if (r.exampleClauses.length) console.log(`      e.g. ${JSON.stringify(r.exampleClauses[0])}`);
    if (r.proposedSignatures.length) console.log(`      proposed: ${r.proposedSignatures[0]}`);
  }
}

// run only as a CLI: `test/scripts-tooling.test.ts` imports `aggregate` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
