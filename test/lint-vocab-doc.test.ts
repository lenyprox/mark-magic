// data/scripts/VOCABULARY.md is generated (scripts/vocab-doc.ts) and TRACKED: the script agents are told to use only
// the ops it lists, so a stale file would hand them a vocabulary the checker rejects. This lint regenerates the
// document into a string and compares it with the file on disk — it must be byte-identical, and running the
// generator twice must produce the same bytes (no timestamp, no absolute path, no readdir order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONDITION_VARIANTS, EFFECT_VARIANTS, STATIC_VARIANTS, TRIGGER_VARIANTS } from '../src/cards/schema.js';
import { projectRoot } from '../src/config/paths.js';
import { dslCheatSheet, renderVocabulary, sectionOf, variantDocs, vocabularyExcerpt, vocabularyFor, VOCAB_FILE } from '../scripts/vocab-doc.js';

test('data/scripts/VOCABULARY.md is what vocab:doc would write (run `npm run vocab:doc`)', () => {
  const file = VOCAB_FILE();
  assert.ok(fs.existsSync(file), `${file} is missing — run npm run vocab:doc`);
  const have = fs.readFileSync(file, 'utf8');
  assert.ok(!have.includes('\r'), 'VOCABULARY.md must be LF only');
  const want = renderVocabulary();
  if (have !== want) {
    const h = have.split('\n'), w = want.split('\n');
    const i = h.findIndex((l, n) => l !== w[n]);
    assert.fail(`VOCABULARY.md is stale at line ${i + 1}\n  on disk:    ${JSON.stringify(h[i])}\n  generated:  ${JSON.stringify(w[i])}\nRun: npm run vocab:doc`);
  }
});

test('the generator is idempotent', () => {
  assert.equal(renderVocabulary(), renderVocabulary());
});

test('the generator reads NO wave output — the tracked file is a function of source alone', () => {
  // VOCABULARY.md is tracked and this lint runs in `verify:quick`, the per-merge gate. The first cut of 8k built the
  // "## Examples" section out of the judged scripts in `data/scripts/**`, so the first successful `scripts:promote`
  // would have turned this test (and `npm test`) red for a reason having nothing to do with the merge, with nothing
  // in the pipeline regenerating the file. The examples an author needs are per-card and live in their BATCH.
  const src = fs.readFileSync(path.join(projectRoot(), 'scripts', 'vocab-doc.ts'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const forbidden of ['ScriptStore', 'stateOf', 'defaultSources', 'scriptState.js']) {
    assert.ok(!code.includes(forbidden), `scripts/vocab-doc.ts must not read wave output (found ${forbidden})`);
  }
  // and the section it does emit is the two tracked worked examples, always
  const md = renderVocabulary();
  assert.ok(md.includes('### `_example.json.txt`'));
  assert.ok(md.includes('### `_example-split.json.txt`'));
  assert.ok(!md.includes('No script has been judged yet'), 'the section is unconditional now');
});

test('the worked examples tell an author to write source "llm", never "hand"', () => {
  // both examples used to say `"source": "hand"`, and an author agent that copies that word used to make its card
  // `reviewed` — covered, never re-queued, never judged. `stateOf` ignores the claim now; the examples must not
  // teach it either.
  const md = renderVocabulary();
  const blocks = md.split('```json').slice(1).map(b => b.split('```')[0]);
  assert.ok(blocks.length >= 2);
  for (const b of blocks) {
    assert.ok(!/"source":\s*"(hand|reviewed)"/.test(b), `an example must not declare a human source:\n${b.slice(0, 200)}`);
  }
  assert.ok(md.includes('scripts:promote -- --human'), 'the document names the only route to `reviewed`');
});

test('every core union reaches the document, and `unknown` never does', () => {
  const md = renderVocabulary();
  for (const [variants, key] of [[EFFECT_VARIANTS, 'op'], [CONDITION_VARIANTS, 'kind'], [TRIGGER_VARIANTS, 'on'], [STATIC_VARIANTS, 'kind']] as const) {
    for (const d of variantDocs(variants, key)) {
      if (d.literal === 'unknown') continue;
      assert.ok(md.includes(`| \`${d.literal}\` |`), `${key} '${d.literal}' is missing from VOCABULARY.md`);
    }
  }
  assert.ok(!md.includes('| `unknown` |'), 'the unknown marker must never be offered as vocabulary');
});

test('optional schema fields are marked with a `?`', () => {
  const damage = variantDocs(EFFECT_VARIANTS, 'op').find(d => d.literal === 'damage')!;
  assert.deepEqual(damage.fields, ['amount', 'target', 'divided?', 'kickedAmount?']);
});

test('sectionOf cuts at the next heading of the same or a higher level', () => {
  const md = '# T\n\n## A\n\na1\n\n### A.1\n\ndeep\n\n## B\n\nb1\n';
  assert.equal(sectionOf(md, '## A'), '## A\n\na1\n\n### A.1\n\ndeep');
  assert.equal(sectionOf(md, '### A.1'), '### A.1\n\ndeep');
  assert.equal(sectionOf(md, '## Nope'), '');
});

test('a batch excerpt carries the core vocabulary plus the batch family', () => {
  const excerpt = vocabularyExcerpt('copy-clone');
  assert.ok(excerpt.startsWith('## Core vocabulary'));
  assert.ok(excerpt.includes('## Family — copy-clone'));
  assert.ok(excerpt.includes('| `draw` |'), 'the core effect table must be in every batch');
  // a named keyword has no section of its own and falls back to the catch-all family's advice
  assert.ok(vocabularyExcerpt('named-keyword:suspend').includes('## Family — other'));
});

test('a multi-family excerpt carries the core section ONCE and every family after it', () => {
  // `scripts:queue` used to join per-family excerpts, and each one starts with the ~13 KB core section: a batch that
  // spanned 21 families shipped five copies of it (67 KB, most of it duplication).
  const fams = ['copy-clone', 'layers', 'saga', 'named-keyword:suspend', 'copy-clone'] as const;
  const v = vocabularyFor(fams);
  assert.equal(v.split('## Core vocabulary').length - 1, 1);
  assert.ok(v.startsWith('## Core vocabulary'));
  for (const f of ['copy-clone', 'layers', 'saga']) assert.equal(v.split(`## Family — ${f}`).length - 1, 1, f);
  assert.equal(v.split('## Family — other').length - 1, 1, 'the named keyword falls back to `other`, once');
  // one family is exactly the old single-family excerpt
  assert.equal(vocabularyFor(['saga']), vocabularyExcerpt('saga'));
  // and it is never longer than the naive concatenation it replaces
  const naive = [...new Set(fams)].map(f => vocabularyExcerpt(f)).join('\n\n');
  assert.ok(v.length < naive.length / 2, `${v.length} vs ${naive.length}`);
});

test('the DSL cheat sheet is sections 1-6 of test/scenarios/README.md', () => {
  const sheet = dslCheatSheet();
  assert.ok(sheet.startsWith('## 1. '), sheet.slice(0, 40));
  assert.ok(sheet.includes('## 6. '));
  assert.ok(!sheet.includes('## 7. '), 'section 7 (running the suites) is not part of the cheat sheet');
  assert.equal(dslCheatSheet(path.join('no', 'such', 'file.md')), '');
});
