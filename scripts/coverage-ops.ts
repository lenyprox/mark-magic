// Op-coverage report (phase 8h): which engine ops the harness actually executes, and which cards to write the
// missing scenarios with. Every scenario is run in-process behind the probe in src/verify/opProbe.ts, so "exercised"
// means the engine dispatched on the op, not that a file mentions a card that has it. See src/verify/opCoverage.ts.
//
//   npm run coverage:ops                       # the report, to stdout and data/master/op-coverage.json
//   npm run coverage:ops -- --json <path>      # write the JSON somewhere else
//   npm run coverage:ops -- --no-exemplars     # skip the full-pool walk (~8 s) that fills byOp
//   npm run coverage:ops -- --write-allowlist  # (re)generate test/fixtures/op-allowlist.json from today's uncovered set
//
// --write-allowlist is deliberately manual and loud: the allowlist is a ratchet that may only shrink, so regenerating
// it is a reviewed act, never something a script does on its own.
// Exit codes: 0 the report was written, 1 a scenario failed while coverage was being measured (the numbers
// would be meaningless), 2 the arguments are wrong.
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

console.log(`harness: ${r.harness.scenarios} scenarios ran under the probe (${r.harness.suites.length} TS suites, ${r.harness.jsonFiles} JSON files)` +
  (r.harness.failures.length ? `, ${r.harness.failures.length} FAILING` : ''));
for (const f of r.harness.failures) console.log(`  FAIL ${f}`);
console.log('');
console.log('category        vocab  exercised  uncovered');
for (const c of CATEGORIES) {
  const [v, e, u] = [r.vocabulary[c].length, r.exercised[c].length, r.uncovered[c].length];
  console.log(`${c.padEnd(14)} ${String(v).padStart(5)} ${String(e).padStart(10)} ${String(u).padStart(10)}`);
}
const tot = (k: 'vocabulary' | 'uncovered' | 'exercised') => CATEGORIES.reduce((n, c) => n + r[k][c].length, 0);
console.log(`${'TOTAL'.padEnd(14)} ${String(tot('vocabulary')).padStart(5)} ${String(tot('exercised')).padStart(10)} ${String(tot('uncovered')).padStart(10)}`);
console.log('');

// Ops the engine executed that the vocabulary does not know: the vocabulary has lost an anchor (this is how the
// `turned-face-up` hole was found — the tool scored a set it refused to enumerate).
const unknowns = CATEGORIES.flatMap(c => r.unknown[c].map(n => `${c}: ${n}`));
if (unknowns.length) {
  console.log(`${unknowns.length} discriminator(s) the engine dispatched on that are NOT in the vocabulary:`);
  for (const u of unknowns) console.log(`  ${u}`);
  console.log('');
}

if (r.dead.length) {
  console.log('dead trigger events (no scenario can ever cover these — they are engine defects):');
  for (const d of r.dead) console.log(`  ${d.name} — ${d.why}`);
  console.log('');
}
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
    '//': 'Op-coverage ratchet baseline (phase 8h). Engine discriminators that no scenario made the engine execute — ' +
      'measured by running every scenario behind src/verify/opProbe.ts, so being named in a file is not coverage. ' +
      'This list may only SHRINK: test/lint-op-coverage.test.ts fails both when an op outside it is uncovered and when ' +
      'an op inside it has become covered. Never regenerate it to make the lint pass — write the scenario instead. ' +
      '"deadEvents" is different in kind: those trigger events can never fire at all (the engine raises one nothing ' +
      'dispatches on, or dispatches on one it never raises), so they are defects to fix in the engine, not scenarios to write.',
  };
  for (const c of CATEGORIES) body[c] = r.uncovered[c];
  body.deadEvents = r.dead.map(d => d.name).sort();
  fs.writeFileSync(file, JSON.stringify(body, null, 2).replace(/\r\n/g, '\n') + '\n');
  console.log(`allowlist rewritten: ${rel(file)} (${tot('uncovered')} uncovered ops, ${r.dead.length} dead events)`);
} else if (fs.existsSync(ALLOWLIST_FILE())) {
  const { missing, stale, deadNew, deadFixed } = ratchet(toSets(r.uncovered), vocabulary(), readAllowlist());
  console.log(`ratchet: ${missing.length} not allowlisted, ${stale.length} allowlist entries that can go, ` +
    `${deadNew.length} new dead event(s), ${deadFixed.length} dead-event entr(ies) that can go`);
  for (const m of missing) console.log(`  MISSING  ${m.category}: ${m.name}`);
  for (const s of stale) console.log(`  STALE    ${s.category}: ${s.name} (${s.why})`);
  for (const d of deadNew) console.log(`  DEAD     ${d.name} (${d.why})`);
  for (const n of deadFixed) console.log(`  ALIVE    ${n} (allowlisted as dead but not dead any more)`);
}

// A red harness measures nothing: the counts above are only worth reading when every scenario passed.
if (r.harness.failures.length) process.exit(1);
