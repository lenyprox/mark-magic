// Runs the oracle-text parser over every playable card in the master file and reports
// how many are fully simulable, plus the most common unparsed clauses (to prioritise parser work).
import fs from 'node:fs';
import { CardDB } from '../src/cards/db.js';

const db = new CardDB();
let total = 0, full = 0, vanillaOrKeywordOnly = 0;
const byType: Record<string, { total: number; full: number }> = {};
const unparsedFreq = new Map<string, number>();
const byFormatSample: Record<string, string[]> = {};
for (const c of db.all()) {
  total++;
  const primary = c.types.includes('Creature') ? 'Creature' : c.types[0] ?? 'Other';
  byType[primary] ??= { total: 0, full: 0 };
  byType[primary].total++;
  if (c.fullyParsed) { full++; byType[primary].full++; if (c.abilities.length === 0) vanillaOrKeywordOnly++; }
  for (const u of c.unparsed) {
    // normalise numbers and names so similar clauses group together
    const key = u.replace(/\d+/g, '#').replace(/\{[^}]+\}/g, '{}').slice(0, 90);
    unparsedFreq.set(key, (unparsedFreq.get(key) ?? 0) + 1);
  }
}
const top = [...unparsedFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
const report = {
  generated_at: new Date().toISOString(),
  playable_oracle_cards: total,
  fully_parsed: full,
  fully_parsed_pct: +(100 * full / total).toFixed(2),
  of_which_vanilla_or_keyword_only: vanillaOrKeywordOnly,
  by_primary_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { ...v, pct: +(100 * v.full / v.total).toFixed(1) }])),
  most_common_unparsed_clauses: top.map(([clause, n]) => ({ n, clause })),
};
fs.writeFileSync('data/master/parser-coverage.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, most_common_unparsed_clauses: report.most_common_unparsed_clauses.slice(0, 25) }, null, 2));
db.close();
