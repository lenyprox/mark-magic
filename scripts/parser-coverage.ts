// Runs the oracle-text parser over every playable card in the master file and reports
// how many are fully simulable, plus the most common unparsed clauses (to prioritise parser work).
// Also reports the pool tiers (src/cards/pool.ts): the headline number is the *paper* tier.
import fs from 'node:fs';
import { CardDB } from '../src/cards/db.js';
import { POOL_TIERS, type PoolTier } from '../src/cards/pool.js';

const db = new CardDB();
let total = 0, full = 0, vanillaOrKeywordOnly = 0;
const byType: Record<string, { total: number; full: number }> = {};
const byTier: Record<PoolTier, { total: number; fully_parsed: number }> = { paper: { total: 0, fully_parsed: 0 }, digital: { total: 0, fully_parsed: 0 }, un: { total: 0, fully_parsed: 0 }, ante: { total: 0, fully_parsed: 0 } };
const unparsedFreq = new Map<string, number>();
for (const { def: c, tier } of db.allWithTier()) {
  total++;
  byTier[tier].total++;
  const primary = c.types.includes('Creature') ? 'Creature' : c.types[0] ?? 'Other';
  byType[primary] ??= { total: 0, full: 0 };
  byType[primary].total++;
  if (c.fullyParsed) { full++; byType[primary].full++; byTier[tier].fully_parsed++; if (c.abilities.length === 0) vanillaOrKeywordOnly++; }
  for (const u of c.unparsed) {
    // normalise numbers and names so similar clauses group together
    const key = u.replace(/\d+/g, '#').replace(/\{[^}]+\}/g, '{}').slice(0, 90);
    unparsedFreq.set(key, (unparsedFreq.get(key) ?? 0) + 1);
  }
}
const pct = (n: number, d: number) => +(100 * n / (d || 1)).toFixed(2);
const tiers = Object.fromEntries(POOL_TIERS.map(t => [t, { ...byTier[t], pct: pct(byTier[t].fully_parsed, byTier[t].total) }])) as Record<PoolTier, { total: number; fully_parsed: number; pct: number }>;
const top = [...unparsedFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
const report = {
  generated_at: new Date().toISOString(),
  playable_oracle_cards: total,
  fully_parsed: full,
  fully_parsed_pct: pct(full, total),
  of_which_vanilla_or_keyword_only: vanillaOrKeywordOnly,
  /** The pool the 100% target is measured against (src/cards/pool.ts: tier 'paper'). */
  headline: tiers.paper,
  tiers,
  by_primary_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { ...v, pct: +(100 * v.full / v.total).toFixed(1) }])),
  most_common_unparsed_clauses: top.map(([clause, n]) => ({ n, clause })),
};
fs.writeFileSync('data/master/parser-coverage.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, most_common_unparsed_clauses: report.most_common_unparsed_clauses.slice(0, 25) }, null, 2));
db.close();
