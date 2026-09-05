// data/scripts/VOCABULARY.md is generated (scripts/vocab-doc.ts) and TRACKED: the script agents are told to use only
// the ops it lists, so a stale file would hand them a vocabulary the checker rejects. This lint regenerates the
// document into a string and compares it with the file on disk — it must be byte-identical, and running the
// generator twice must produce the same bytes (no timestamp, no absolute path, no readdir order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONDITION_VARIANTS, EFFECT_VARIANTS, STATIC_VARIANTS, TRIGGER_VARIANTS } from '../src/cards/schema.js';
import { dslCheatSheet, renderVocabulary, sectionOf, variantDocs, vocabularyExcerpt, VOCAB_FILE } from '../scripts/vocab-doc.js';

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

test('the DSL cheat sheet is sections 1-6 of test/scenarios/README.md', () => {
  const sheet = dslCheatSheet();
  assert.ok(sheet.startsWith('## 1. '), sheet.slice(0, 40));
  assert.ok(sheet.includes('## 6. '));
  assert.ok(!sheet.includes('## 7. '), 'section 7 (running the suites) is not part of the cheat sheet');
  assert.equal(dslCheatSheet(path.join('no', 'such', 'file.md')), '');
});
