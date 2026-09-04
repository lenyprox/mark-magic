// Gathers every verification signal into data/master/verification.json (the /coverage page reads it):
// parser coverage by type, scripted/stale cards, the pool sandbox, scenario inventory with cited rules,
// metagame coverage when present, and the latest benchmark.   npm run verify:dashboard
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { scriptStore } from '../src/cards/scripts.js';
import { DATA_DIR } from '../src/config/paths.js';
import { basics } from '../test/scenarios/basics.js';
import { mechanics } from '../test/scenarios/mechanics.js';

const read = (f: string) => { const p = path.join(DATA_DIR(), 'master', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const cards = CardDB.shared();
const store = scriptStore();

// scripts: how many, how many stale, how many of the scripted cards are fully parsed thanks to them
let scripted = 0, stale = 0, scriptedFull = 0;
for (const id of store.ids()) { const d = cards.getByOracleId(id); if (!d) continue; scripted++; if (d.script?.stale) stale++; else if (d.fullyParsed) scriptedFull++; }

// keyword coverage: which keyword lines the parser still bails out on (from the coverage report's clause list)
const coverage = read('parser-coverage.json');
const keywordBailouts = (coverage?.most_common_unparsed_clauses ?? []).filter((c: { clause: string }) => /^[A-Z][a-z]+( \{\}| #)*$/.test(c.clause)).slice(0, 30);

const scenarios = [...basics, ...mechanics];
const cited = [...new Set(scenarios.map(s => s.cr).filter(Boolean))].sort();
const sandbox = read('verify-pool.json');
const meta = read('meta-coverage.json');
const benchPath = path.join(DATA_DIR(), 'bench', 'latest.json');
const bench = fs.existsSync(benchPath) ? JSON.parse(fs.readFileSync(benchPath, 'utf8')) : null;

const report = {
  generated_at: new Date().toISOString(),
  parser: coverage ? { playable: coverage.playable_oracle_cards, fully_parsed: coverage.fully_parsed, pct: coverage.fully_parsed_pct, by_type: coverage.by_primary_type, top_unparsed: coverage.most_common_unparsed_clauses.slice(0, 40), keyword_bailouts: keywordBailouts, generated_at: coverage.generated_at } : null,
  scripts: { total: scripted, stale, fully_parsed_via_script: scriptedFull },
  sandbox: sandbox ? { cards: sandbox.cards, counts: sandbox.counts, top_problems: sandbox.top_problems, generated_at: sandbox.generated_at } : null,
  scenarios: { total: scenarios.length, files: { basics: basics.length, mechanics: mechanics.length }, rules_cited: cited },
  meta: meta ?? null,
  bench: bench ? { at: bench.at, results: bench.results } : null,
};
fs.writeFileSync(path.join(DATA_DIR(), 'master', 'verification.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ parser: report.parser && { pct: report.parser.pct, fully_parsed: report.parser.fully_parsed }, scripts: report.scripts, sandbox: report.sandbox?.counts, scenarios: report.scenarios.total, rules: cited.length, bench: report.bench?.results?.map((r: { name: string; gamesPerSecond: number }) => `${r.name} ${r.gamesPerSecond}/s`) }, null, 1));
cards.close();
