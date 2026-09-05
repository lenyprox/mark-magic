// The op-coverage ratchet (phase 8h, plan 2.5f): every discriminator the engine can execute must be exercised by a
// scenario or by a card a unit test names — or be listed in test/fixtures/op-allowlist.json, the baseline that may
// only shrink. A family that registers a new op, condition, trigger, static, amount, as-enters kind or cost part is
// never in that allowlist, so landing one without a scenario fails here by construction.
//
// Fast on purpose: the vocabulary is read out of the engine's own source and the registry, and only the ~120 cards the
// harness actually names are parsed. The full-pool walk that names exemplar cards lives in `npm run coverage:ops`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MASTER_DB } from '../src/config/paths.js';
import {
  ALLOWLIST_FILE, CATEGORIES, REPORT_FILE, collectPool, difference, exercisedBy, ratchet, readAllowlist, toLists, vocabulary,
} from '../src/verify/opCoverage.js';

const hasDb = fs.existsSync(MASTER_DB());

/** Exemplar cards for an op, from the last `npm run coverage:ops` report if one has been written. */
function exemplars(): Record<string, string[]> {
  try { return (JSON.parse(fs.readFileSync(REPORT_FILE(), 'utf8')) as { byOp?: Record<string, string[]> }).byOp ?? {}; }
  catch { return {}; }
}

test('the engine vocabulary is derivable and the allowlist is well formed', () => {
  const vocab = vocabulary();
  const lists = toLists(vocab);
  for (const c of CATEGORIES) assert.ok(lists[c].length > 0, `the ${c} vocabulary came back empty — src/verify/opCoverage.ts has lost an anchor`);
  const allow = readAllowlist();
  for (const c of CATEGORIES) {
    assert.deepEqual(allow[c], [...new Set(allow[c])].sort(), `${ALLOWLIST_FILE()}: "${c}" must be sorted and free of duplicates`);
    const gone = allow[c].filter(n => !vocab[c].has(n));
    assert.deepEqual(gone, [], `${ALLOWLIST_FILE()}: "${c}" lists ${gone.join(', ')}, which the engine no longer executes — delete the entries`);
  }
});

test('every engine op is exercised by a scenario or a test card', { skip: !hasDb }, async () => {
  const vocab = vocabulary();
  const pool = await collectPool();
  assert.ok(pool.names.length >= 50, `the scenario/test pool named only ${pool.names.length} cards — collectPool() has stopped seeing them`);
  const { sets: used, resolved } = exercisedBy(pool.names, vocab);
  assert.ok(resolved >= 50, `only ${resolved} of ${pool.names.length} pool cards resolved in master.db`);
  const uncovered = difference(vocab, used);
  const { missing, stale } = ratchet(uncovered, vocab, readAllowlist());

  const ex = exemplars();
  const named = (name: string): string => (ex[name]?.length ? ` — write a scenario with e.g. ${ex[name].slice(0, 5).join(', ')}` : '');
  assert.deepEqual(missing, [], missing.length
    ? `${missing.length} engine op(s) nothing exercises and the allowlist does not cover:\n`
      + missing.map(m => `  ${m.category}: ${m.name}${named(m.name)}`).join('\n')
      + `\nAdd a scenario (test/scenarios/*.ts or data/scenarios/**) that plays a card using it.`
      + (Object.keys(ex).length ? '' : ' Run `npm run coverage:ops` for exemplar cards.')
    : '');
  assert.deepEqual(stale, [], stale.length
    ? `${stale.length} allowlist entr(ies) in ${ALLOWLIST_FILE()} can go — the ratchet only shrinks:\n`
      + stale.map(s => `  ${s.category}: ${s.name} (${s.why})`).join('\n')
    : '');
});
