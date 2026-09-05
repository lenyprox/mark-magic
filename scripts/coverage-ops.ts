// Op-coverage report (phase 8h): which engine ops the harness actually exercises, and which cards to write the
// missing scenarios with. See src/verify/opCoverage.ts for how the two sets are derived.
//
//   npm run coverage:ops                       # the report, to stdout and data/master/op-coverage.json
//   npm run coverage:ops -- --json <path>      # write the JSON somewhere else
//   npm run coverage:ops -- --no-exemplars     # skip the full-pool walk (~8 s) that fills byOp
//   npm run coverage:ops -- --write-allowlist  # (re)generate test/fixtures/op-allowlist.json from today's uncovered set
//
// --write-allowlist is deliberately manual and loud: the allowlist is a ratchet that may only shrink, so regenerating
// it is a reviewed act, never something a script does on its own.
// Exit codes: 0 the report was written, 2 the arguments are wrong.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/config/paths.js';
import { ALLOWLIST_FILE, CATEGORIES, REPORT_FILE, readAllowlist, ratchet, report, toSets, vocabulary } from '../src/verify/opCoverage.js';

const args = process.argv.slice(2);
const usage = 'usage: coverage-ops [--json path] [--no-exemplars] [--write-allowlist]';
const die = (msg: string): never => { console.error(msg); console.error(usage); process.exit(2); };

let jsonOut: string | null = null, exemplars = true, writeAllowlist = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-exemplars') exemplars = false;
  else if (a === '--write-allowlist') writeAllowlist = true;
  else if (a === '--json' || a.startsWith('--json=')) { const v = a.startsWith('--json=') ? a.slice(7) : args[++i]; if (!v) die('--json needs a path'); jsonOut = v; }
  else die(`unknown argument: ${a}`);
}

const rel = (p: string) => path.relative(projectRoot(), p).split(path.sep).join('/');
const r = await report({ withExemplars: exemplars });
const out = jsonOut ? path.resolve(jsonOut) : REPORT_FILE();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(r, null, 2).replace(/\r\n/g, '\n') + '\n');

console.log(`pool: ${r.pool.cards} card names (${r.pool.resolved} resolved) from ${r.pool.scenarios} scenarios ` +
  `(${r.pool.suites.length} TS suites, ${r.pool.jsonFiles} JSON files) and ${r.pool.testFiles} test files`);
console.log('');
console.log('category        vocab  exercised  uncovered');
for (const c of CATEGORIES) {
  const [v, e, u] = [r.vocabulary[c].length, r.exercised[c].filter(n => r.vocabulary[c].includes(n)).length, r.uncovered[c].length];
  console.log(`${c.padEnd(14)} ${String(v).padStart(5)} ${String(e).padStart(10)} ${String(u).padStart(10)}`);
}
const tot = (k: 'vocabulary' | 'uncovered') => CATEGORIES.reduce((n, c) => n + r[k][c].length, 0);
console.log(`${'TOTAL'.padEnd(14)} ${String(tot('vocabulary')).padStart(5)} ${String(tot('vocabulary') - tot('uncovered')).padStart(10)} ${String(tot('uncovered')).padStart(10)}`);
console.log('');
for (const c of CATEGORIES) {
  if (!r.uncovered[c].length) continue;
  console.log(`uncovered ${c}:`);
  for (const n of r.uncovered[c]) {
    const ex = r.byOp[n] ?? [];
    console.log(`  ${n}${ex.length ? ` — e.g. ${ex.join(', ')}` : exemplars ? ' — no card in the pool uses it' : ''}`);
  }
  console.log('');
}
console.log(`report: ${rel(out)}`);

if (writeAllowlist) {
  const file = ALLOWLIST_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: Record<string, unknown> = {
    '//': 'Op-coverage ratchet baseline (phase 8h). Engine discriminators no scenario or unit test exercises yet. ' +
      'This list may only SHRINK: test/lint-op-coverage.test.ts fails both when an op outside it is uncovered and when ' +
      'an op inside it has become covered. Never regenerate it to make the lint pass — write the scenario instead.',
  };
  for (const c of CATEGORIES) body[c] = r.uncovered[c];
  fs.writeFileSync(file, JSON.stringify(body, null, 2).replace(/\r\n/g, '\n') + '\n');
  console.log(`allowlist rewritten: ${rel(file)} (${tot('uncovered')} entries)`);
} else if (fs.existsSync(ALLOWLIST_FILE())) {
  const { missing, stale } = ratchet(toSets(r.uncovered), vocabulary(), readAllowlist());
  console.log(`ratchet: ${missing.length} not allowlisted, ${stale.length} allowlist entries that can go`);
  for (const m of missing) console.log(`  MISSING  ${m.category}: ${m.name}`);
  for (const s of stale) console.log(`  STALE    ${s.category}: ${s.name} (${s.why})`);
}
