// The op-coverage ratchet (phase 8h, plan 2.5f): every discriminator the engine can execute must be one a scenario
// actually makes it execute — or be listed in test/fixtures/op-allowlist.json, the baseline that may only shrink.
// A family that registers a new op, condition, trigger, static, amount, as-enters kind or cost part is never in that
// allowlist, so landing one without a scenario fails here by construction.
//
// "Exercised" is measured, not inferred: every scenario (the TS suites under test/scenarios/ and the JSON corpus under
// data/scenarios/) is run in-process behind the probe in src/verify/opProbe.ts, which records the op as applyEffect
// executes it, the condition as conditionHolds reads its kind, the trigger as it fires. Naming a card in a file is
// not coverage — most of a played card's AST never runs.
//
// The whole corpus is about a second of engine time, so this lint runs it rather than reading a report that could be
// stale. The full-pool walk that names exemplar cards for the uncovered ops stays in `npm run coverage:ops`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MASTER_DB } from '../src/config/paths.js';
import {
  ALLOWLIST_FILE, CATEGORIES, REPORT_FILE, deadEvents, ratchet, readAllowlist, toLists, uncoveredOps, vocabulary,
} from '../src/verify/opCoverage.js';
import { collectExercised } from '../src/verify/opProbe.js';

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
  assert.deepEqual(allow.deadEvents, [...new Set(allow.deadEvents)].sort(), `${ALLOWLIST_FILE()}: "deadEvents" must be sorted and free of duplicates`);
});

// A trigger event the engine raises that nothing dispatches on (or a `case` label for an event it never raises) can
// never fire: no scenario could cover it, and a card whose trigger keys off it is silently inert. Pinned exactly, so
// a new one fails here and fixing one in the engine forces the entry out of the allowlist.
test('the dead trigger events are exactly the ones the allowlist knows about', () => {
  const dead = deadEvents();
  const allowed = readAllowlist().deadEvents;
  const added = dead.filter(d => !allowed.includes(d.name));
  const fixed = allowed.filter(n => !dead.some(d => d.name === n));
  assert.deepEqual(added, [], added.length
    ? `${added.length} trigger event(s) the engine can never fire:\n`
      + added.map(d => `  ${d.name} — ${d.why}`).join('\n')
      + `\nFix the engine (raise the event, or dispatch on it), or record it under "deadEvents" in ${ALLOWLIST_FILE()}.`
    : '');
  assert.deepEqual(fixed, [], fixed.length
    ? `${fixed.join(', ')} is allowlisted as a dead trigger event but fires now — delete the entry from "deadEvents" in ${ALLOWLIST_FILE()}.`
    : '');
});

test('every engine op is executed by a scenario', { skip: !hasDb }, async () => {
  const vocab = vocabulary();
  const run = await collectExercised(vocab);
  assert.ok(run.scenarios >= 50, `only ${run.scenarios} scenarios ran — src/verify/opProbe.ts has stopped seeing them`);
  // Coverage measured from a red harness means nothing, and a scenario that fails only with the probe installed would
  // mean the probe is not transparent. Either way the numbers below are not to be trusted, so stop here.
  assert.deepEqual(run.failures, [], run.failures.length
    ? `${run.failures.length} scenario(s) failed while measuring coverage:\n  ${run.failures.join('\n  ')}` : '');

  // Anything the engine dispatched on that the vocabulary does not know means the vocabulary is wrong — which is the
  // failure that let a dead `turned-face-up` trigger read as covered before this check existed.
  const unknown = CATEGORIES.flatMap(c => [...run.unknown[c]].sort().map(n => `${c}: ${n}`));
  assert.deepEqual(unknown, [], unknown.length
    ? `the engine dispatched on ${unknown.length} discriminator(s) the vocabulary does not list:\n  ${unknown.join('\n  ')}\n`
      + 'Re-anchor the readers in src/verify/opCoverage.ts.' : '');

  const uncovered = uncoveredOps(vocab, run.sets);
  const { missing, stale, deadNew, deadFixed } = ratchet(uncovered, vocab, readAllowlist());
  const ex = exemplars();
  const named = (name: string): string => (ex[name]?.length ? ` — write a scenario with e.g. ${ex[name].slice(0, 5).join(', ')}` : '');
  assert.deepEqual(missing, [], missing.length
    ? `${missing.length} engine op(s) no scenario executes and the allowlist does not cover:\n`
      + missing.map(m => `  ${m.category}: ${m.name}${named(m.name)}`).join('\n')
      + `\nAdd a scenario (test/scenarios/*.ts or data/scenarios/**) that plays a card using it.`
      + (Object.keys(ex).length ? '' : ' Run `npm run coverage:ops` for exemplar cards.')
    : '');
  assert.deepEqual(stale, [], stale.length
    ? `${stale.length} allowlist entr(ies) in ${ALLOWLIST_FILE()} can go — the ratchet only shrinks:\n`
      + stale.map(s => `  ${s.category}: ${s.name} (${s.why})`).join('\n')
    : '');
  assert.deepEqual([...deadNew, ...deadFixed], [], 'the dead-event list moved — see the dead trigger events test');
});
