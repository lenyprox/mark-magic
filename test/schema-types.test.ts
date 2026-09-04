// The zod mirror of the ability AST (src/cards/schema.ts) must stay exactly in step with types.ts.
//
// Compile-time half: `Equals<A, B>` is TypeScript's identity relation, so an added, removed or edited union member
// on either side makes this file fail `npm run typecheck:all` (see tsconfig.schema.json, wired into typecheck:all).
// Runtime half: the schemas must accept the parser's own output for a deterministic sample of the real pool, must
// reject a typo'd field, and must accept the documented example script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { DATA_DIR } from '../src/config/paths.js';
import {
  AbilityCostSchema, AbilitySchema, AltCostSchema, AsEntersSchema, CardScriptSchema, ConditionSchema, CostModifierSchema,
  EFFECT_VARIANTS, EffectSchema, FilterSchema, ManaCostSchema, ScriptFaceSchema, StaticEffectSchema, TargetSpecSchema,
  TriggerEventSchema, VerificationSchema, AmountSchema,
} from '../src/cards/schema.js';
import type { ParsedAbility, ParsedStaticEffect } from '../src/cards/schema.js';
import { oracleHash, type CardScript, type ScriptFace, type Verification } from '../src/cards/scripts.js';
import type { AbilityCost, AltCost, Amount, AsEnters, Condition, CostModifier, Effect, Filter, ManaCost, TargetSpec, TriggerEvent } from '../src/cards/types.js';
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Compile-time equality
// ---------------------------------------------------------------------------

/** True only when A and B are the *identical* type (not merely mutually assignable). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const _manaCost: Equals<z.infer<typeof ManaCostSchema>, ManaCost> = true;
const _filter: Equals<z.infer<typeof FilterSchema>, Filter> = true;
const _amount: Equals<z.infer<typeof AmountSchema>, Amount> = true;
const _targetSpec: Equals<z.infer<typeof TargetSpecSchema>, TargetSpec> = true;
const _abilityCost: Equals<z.infer<typeof AbilityCostSchema>, AbilityCost> = true;
const _altCost: Equals<z.infer<typeof AltCostSchema>, AltCost> = true;
const _costModifier: Equals<z.infer<typeof CostModifierSchema>, CostModifier> = true;
const _asEnters: Equals<z.infer<typeof AsEntersSchema>, AsEnters> = true;
const _condition: Equals<z.infer<typeof ConditionSchema>, Condition> = true;
const _effect: Equals<z.infer<typeof EffectSchema>, Effect> = true;
const _trigger: Equals<z.infer<typeof TriggerEventSchema>, TriggerEvent> = true;
// NARROWED (2 of the 16). parse.ts spreads four undeclared fields into `self-keywords`, one into `anthem` and a
// `condition` into `self-pt` with `as object` casts, and the engine reads them back (see the header of
// src/cards/schema.ts). The schema must accept what the parser really emits, so these two members are pinned against
// `ParsedStaticEffect` / `ParsedAbility` — which are themselves derived from types.ts with `Exclude<>` / `Replace<>`,
// so a variant added to or removed from types.ts still breaks the assertion; only the extra FIELDS of those three
// static variants are unpinned. Nothing else is weakened.
const _static: Equals<z.infer<typeof StaticEffectSchema>, ParsedStaticEffect> = true;
const _ability: Equals<z.infer<typeof AbilitySchema>, ParsedAbility> = true;
const _face: Equals<z.infer<typeof ScriptFaceSchema>, ScriptFace> = true;
const _verification: Equals<z.infer<typeof VerificationSchema>, Verification> = true;
const _cardScript: Equals<z.infer<typeof CardScriptSchema>, CardScript> = true;

const PINNED = [
  _manaCost, _filter, _amount, _targetSpec, _abilityCost, _altCost, _costModifier, _asEnters, _condition, _effect,
  _trigger, _static, _ability, _face, _verification, _cardScript,
];

test('schema: every AST union is pinned to types.ts at compile time', () => {
  // The assignments above are the assertion; this only proves the file was actually loaded.
  assert.ok(PINNED.every(Boolean));
  assert.ok(EFFECT_VARIANTS.length > 90, `expected the full effect vocabulary, got ${EFFECT_VARIANTS.length}`);
});

// ---------------------------------------------------------------------------
// Runtime: the parser's own output must validate
// ---------------------------------------------------------------------------

test('schema: every ability of every 10th playable card validates', () => {
  const db = new CardDB();
  const failures: string[] = [];
  let sampled = 0, abilities = 0, i = 0;
  try {
    for (const def of db.all()) {
      if (i++ % 10) continue;
      sampled++;
      for (const [n, a] of def.abilities.entries()) {
        abilities++;
        const r = AbilitySchema.safeParse(a);
        if (!r.success && failures.length < 25) failures.push(`${def.name} ability#${n} (${a.kind}): ${JSON.stringify(r.error.issues.slice(0, 3))}`);
        else if (!r.success) failures.push('…');
      }
      for (const c of def.altCosts ?? []) { const r = AltCostSchema.safeParse(c); if (!r.success && failures.length < 25) failures.push(`${def.name} altCost: ${JSON.stringify(r.error.issues.slice(0, 3))}`); }
      for (const c of def.asEnters ?? []) { const r = AsEntersSchema.safeParse(c); if (!r.success && failures.length < 25) failures.push(`${def.name} asEnters: ${JSON.stringify(r.error.issues.slice(0, 3))}`); }
      for (const c of def.costModifiers ?? []) { const r = CostModifierSchema.safeParse(c); if (!r.success && failures.length < 25) failures.push(`${def.name} costModifier: ${JSON.stringify(r.error.issues.slice(0, 3))}`); }
      for (const c of def.additionalCosts ?? []) { const r = AbilityCostSchema.safeParse(c); if (!r.success && failures.length < 25) failures.push(`${def.name} additionalCost: ${JSON.stringify(r.error.issues.slice(0, 3))}`); }
    }
  } finally { db.close(); }
  assert.ok(sampled > 3000, `expected ~3,450 sampled cards, got ${sampled}`);
  assert.ok(abilities > 3000, `expected thousands of abilities, got ${abilities}`);
  assert.deepEqual(failures, [], `parser output the schema rejects (the SCHEMA is wrong, not parse.ts):\n${failures.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Runtime: strictness and the documented example
// ---------------------------------------------------------------------------

test('schema: strict objects reject a typo\'d field', () => {
  assert.ok(EffectSchema.safeParse({ op: 'draw', amount: 1, who: 'you' }).success);
  assert.ok(!EffectSchema.safeParse({ op: 'draw', amount: 1, who: 'you', whom: 'you' }).success, 'unknown key must be rejected');
  assert.ok(!EffectSchema.safeParse({ op: 'draw', amount: 1, whoo: 'you' }).success, 'a typo\'d required key must be rejected');
  assert.ok(!AbilitySchema.safeParse({ kind: 'static', effect: { kind: 'self-keywords', keywords: ['flying'] }, text: 'x', extra: 1 }).success);
  assert.ok(!AbilitySchema.safeParse({ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'gain-life', amount: 1, who: 'yuo' }], text: 'x' }).success, 'a bad enum value must be rejected');
  assert.ok(!TargetSpecSchema.safeParse({ kind: 'creature', contoller: 'you' }).success);
});

test('schema: CardScriptSchema accepts the documented example and rejects a bad ignore reason', () => {
  const raw = fs.readFileSync(path.join(DATA_DIR(), 'scripts', '_example.json.txt'), 'utf8');
  assert.ok(!raw.includes('\r'), '_example.json.txt must be LF');
  const example = JSON.parse(raw) as CardScript;
  example.oracleHash = oracleHash('Whenever this creature attacks, you gain 1 life.');
  const ok = CardScriptSchema.safeParse(example);
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues, null, 1));

  const bad = { ...example, ignore: [{ line: 'Draft this card face up.', reason: 'because-i-say-so' }] };
  assert.ok(!CardScriptSchema.safeParse(bad).success, 'unknown ignore reason must be rejected');
  const good = { ...example, ignore: [{ line: 'Draft this card face up.', reason: 'draft-matters' }] };
  assert.ok(CardScriptSchema.safeParse(good).success);
  assert.ok(!CardScriptSchema.safeParse({ ...example, backFace: { keyword: ['flying'] } }).success, 'backFace is strict too');
});
