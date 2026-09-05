// The zod mirror of the ability AST (src/cards/schema.ts) must stay exactly in step with types.ts.
//
// Compile-time half: `Equals<A, B>` is TypeScript's identity relation, so an added, removed or edited union member
// on either side makes this file fail `npm run typecheck:all` (see tsconfig.schema.json, wired into typecheck:all).
// The pins are on the CORE faces of the schema (`CoreEffectSchema` = the hand-written `EFFECT_VARIANTS`, …) against
// the `Core*` types of types.ts: a family widens `Effect` by declaration merging and the COMPOSED face
// (`EffectSchema`) with it, but a family's variants are runtime values in a generated list, which no compile-time
// pin can see — the runtime half below covers them with `composeSchemas`.
// Runtime half: the schemas must accept the parser's own output for a deterministic sample of the real pool, must
// reject a typo'd field, must accept the documented example script, and — composed with an in-memory family — must
// accept a script that uses the family's vocabulary and reject a typo in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CardDB } from '../src/cards/db.js';
import { projectRoot } from '../src/config/paths.js';
import {
  AbilityCostSchema, AbilitySchema, AltCostSchema, AsEntersSchema, CardScriptChecked, CardScriptSchema, ConditionSchema, CostModifierSchema,
  CORE_VOCABULARY, CoreAbilityCostSchema, CoreAsEntersSchema, CoreConditionSchema, CoreEffectSchema, CoreStaticEffectSchema, CoreTriggerEventSchema,
  composeSchemas, EFFECT_VARIANTS, EffectSchema, FAMILY_EFFECT_VARIANTS, FAMILY_SCHEMA_ENTRIES, FilterSchema, ManaCostSchema, mergeFamilySchemas, ScriptFaceSchema,
  StaticEffectSchema, TargetSpecSchema, TriggerEventSchema, VerificationSchema, AmountSchema,
} from '../src/cards/schema.js';
import type { CoreAbilityCost, FamilySchemaEntry, ParsedAbility, ParsedCoreStaticEffect, ParsedStaticEffect } from '../src/cards/schema.js';
import { DEFAULT_SCRIPTS_DIR, oracleHash, type CardScript, type ScriptFace, type Verification } from '../src/cards/scripts.js';
import type {
  AbilityCost, AltCost, Amount, AsEnters, Condition, CoreAsEnters, CoreCondition, CoreEffect, CoreTriggerEvent, CostModifier, Effect, Filter,
  ManaCost, TargetSpec, TriggerEvent,
} from '../src/cards/types.js';

// ---------------------------------------------------------------------------
// Compile-time equality
// ---------------------------------------------------------------------------

/** True only when A and B are the *identical* type (not merely mutually assignable). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// The leaves. Their family-widenable slots (`TargetSpec.kind`, `Amount.count`, `Keyword`, `AltCost.id`) are typed
// with the widened alias of types.ts and validate the composed enum, so these hold before and after a family merges.
const _manaCost: Equals<z.infer<typeof ManaCostSchema>, ManaCost> = true;
const _filter: Equals<z.infer<typeof FilterSchema>, Filter> = true;
const _amount: Equals<z.infer<typeof AmountSchema>, Amount> = true;
const _targetSpec: Equals<z.infer<typeof TargetSpecSchema>, TargetSpec> = true;
const _altCost: Equals<z.infer<typeof AltCostSchema>, AltCost> = true;
const _costModifier: Equals<z.infer<typeof CostModifierSchema>, CostModifier> = true;
// The CORE faces of the unions a family extends, against the `Core*` types: an added, removed or edited core variant
// on either side fails here. (`AbilityCost` gains keys, not variants: its core object is pinned to the interface
// minus the family cost parts, `CoreAbilityCost`.)
const _abilityCost: Equals<z.infer<typeof CoreAbilityCostSchema>, CoreAbilityCost> = true;
const _asEnters: Equals<z.infer<typeof CoreAsEntersSchema>, CoreAsEnters> = true;
const _condition: Equals<z.infer<typeof CoreConditionSchema>, CoreCondition> = true;
const _effect: Equals<z.infer<typeof CoreEffectSchema>, CoreEffect> = true;
const _trigger: Equals<z.infer<typeof CoreTriggerEventSchema>, CoreTriggerEvent> = true;
// NARROWED (2 of the 16). parse.ts spreads four undeclared fields into `self-keywords`, one into `anthem` and a
// `condition` into `self-pt` with `as object` casts, and the engine reads them back (see the header of
// src/cards/schema-core.ts). The schema must accept what the parser really emits, so these two members are pinned
// against `ParsedCoreStaticEffect` / `ParsedAbility` — which are derived from types.ts with `Extract<>` / `Exclude<>`
// / `Replace<>`: a variant added to or removed from types.ts breaks the assertion, and so does adding, removing or
// retyping any FIELD of those three static variants, because they are `Extract`ed rather than re-declared. The hole
// is exactly six field NAMES (anthem.opponentsOnly, self-pt.condition, self-keywords.mustAttack / .doesntUntap /
// .blockOnlyFlying / .evasion), which the schema may declare without types.ts knowing. Nothing else is weakened.
const _static: Equals<z.infer<typeof CoreStaticEffectSchema>, ParsedCoreStaticEffect> = true;
const _ability: Equals<z.infer<typeof AbilitySchema>, ParsedAbility> = true;
const _face: Equals<z.infer<typeof ScriptFaceSchema>, ScriptFace> = true;
const _verification: Equals<z.infer<typeof VerificationSchema>, Verification> = true;
const _cardScript: Equals<z.infer<typeof CardScriptSchema>, CardScript> = true;
// The COMPOSED faces are typed with the widened aliases by annotation (`z.ZodType<Effect>`), so these hold by
// construction — they are here so a retyping of a composed face is caught, not because they can see a family:
// the Equals pin cannot; only the runtime composition below does.
const _composedEffect: Equals<z.infer<typeof EffectSchema>, Effect> = true;
const _composedCondition: Equals<z.infer<typeof ConditionSchema>, Condition> = true;
const _composedTrigger: Equals<z.infer<typeof TriggerEventSchema>, TriggerEvent> = true;
const _composedStatic: Equals<z.infer<typeof StaticEffectSchema>, ParsedStaticEffect> = true;
const _composedAsEnters: Equals<z.infer<typeof AsEntersSchema>, AsEnters> = true;
const _composedAbilityCost: Equals<z.infer<typeof AbilityCostSchema>, AbilityCost> = true;

const PINNED = [
  _manaCost, _filter, _amount, _targetSpec, _abilityCost, _altCost, _costModifier, _asEnters, _condition, _effect,
  _trigger, _static, _ability, _face, _verification, _cardScript,
  _composedEffect, _composedCondition, _composedTrigger, _composedStatic, _composedAsEnters, _composedAbilityCost,
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
  // DEFAULT_SCRIPTS_DIR(), not DATA_DIR(): scripts are tracked and live in this checkout. DATA_DIR() falls back to
  // the main checkout when a linked worktree has no master.db, which would validate a *different* example file.
  const file = path.join(DEFAULT_SCRIPTS_DIR(), '_example.json.txt');
  assert.ok(file.startsWith(projectRoot()), `the example must be read from this checkout (${projectRoot()}), got ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('\r'), `${file} must be LF`);
  const example = JSON.parse(raw) as CardScript;
  example.oracleHash = oracleHash('Whenever this creature attacks, you gain 1 life.');
  const ok = CardScriptSchema.safeParse(example);
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues, null, 1));
  const checked = CardScriptChecked.safeParse(example);   // the cross-field rules scripts:check applies
  assert.equal(checked.success, true, checked.success ? '' : JSON.stringify(checked.error.issues, null, 1));

  const bad = { ...example, ignore: [{ line: 'Draft this card face up.', reason: 'because-i-say-so' }] };
  assert.ok(!CardScriptSchema.safeParse(bad).success, 'unknown ignore reason must be rejected');
  const good = { ...example, ignore: [{ line: 'Draft this card face up.', reason: 'draft-matters' }] };
  assert.ok(CardScriptSchema.safeParse(good).success);
  assert.ok(!CardScriptSchema.safeParse({ ...example, backFace: { keyword: ['flying'] } }).success, 'backFace is strict too');
});

// ---------------------------------------------------------------------------
// Runtime: the composition with a family schema
// ---------------------------------------------------------------------------

/**
 * An in-memory family written to the contract of `FamilySchema` — one entry of every slot. Its fields are plain zod
 * leaves on purpose: a real family imports `AmountSchema` / `TargetSpecSchema` / … from src/cards/schema.js, i.e. the
 * instance the tools use, which lists that family — while a probe composed into a SECOND instance would borrow the
 * tools' leaves, which know nothing of it. The composed slots are exercised through the core ops below instead
 * (`damage` with the probe's amount count and target kind, `conditional` nesting the probe op).
 */
const PROBE: FamilySchemaEntry = {
  family: 'probe', file: '(test) src/engine/ops/probe.schema.ts',
  schema: {
    effects: [z.strictObject({ op: z.literal('probe-note'), amount: z.number(), loud: z.boolean().optional() })],
    conditions: [z.strictObject({ kind: z.literal('probe-always') })],
    triggers: [z.strictObject({ on: z.literal('probe-fires'), self: z.boolean() })],
    statics: [z.strictObject({ kind: z.literal('probe-becomes'), power: z.number(), toughness: z.number() })],
    asEnters: [z.strictObject({ kind: z.literal('probe-enters-suspended'), counters: z.number() })],
    amounts: ['probe-time-counters'], targetKinds: ['probe-suspended-card'], costParts: { probeTimeCounters: z.number() },
  },
};
/** A script for the documented example card that uses every slot of PROBE — nested inside core containers too. */
const probeScript = (): CardScript => ({
  oracleId: '00000000-0000-0000-0000-000000000000', name: 'Example Card', oracleHash: oracleHash('x'), source: 'llm', mode: 'replace',
  abilities: [
    { kind: 'triggered', event: { on: 'probe-fires', self: true } as never, condition: { kind: 'probe-always' } as never, effects: [
      { op: 'probe-note', amount: 2 } as never,
      { op: 'conditional', condition: { kind: 'probe-always' } as never, then: [{ op: 'probe-note', amount: 5 } as never] },
      { op: 'damage', amount: { count: 'probe-time-counters' } as never, target: { kind: 'probe-suspended-card' } as never },
    ], text: 'Whenever the probe fires, note it.' },
    { kind: 'activated', cost: { tap: true, probeTimeCounters: 2 } as never, effects: [{ op: 'probe-note', amount: 1, loud: true } as never], text: '{T}, remove two time counters: note it.' },
    { kind: 'static', effect: { kind: 'probe-becomes', power: 4, toughness: 4 } as never, text: 'It is 4/4.' },
  ],
  asEnters: [{ kind: 'probe-enters-suspended', counters: 3 } as never],
});

test('schema: a family composed through composeSchemas makes a script with its ops pass CardScriptChecked, and a typo fail', () => {
  const S = composeSchemas([...FAMILY_SCHEMA_ENTRIES, PROBE]);
  const r = S.CardScriptChecked.safeParse(probeScript());
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues, null, 1));
  // the instance the tools use has no probe: the same script dies at stage 1 there, which is the whole HANDOFF item 26
  assert.equal(CardScriptChecked.safeParse(probeScript()).success, false);
  // the composed vocabulary carries the family in every slot
  const v = S.vocabulary();
  assert.ok(v.amountCounts.includes('probe-time-counters') && v.targetKinds.includes('probe-suspended-card') && v.costKeys.includes('probeTimeCounters'));
  // relative to the generated barrel, whatever families are merged on this checkout
  assert.equal(v.effectVariants.length, EFFECT_VARIANTS.length + FAMILY_EFFECT_VARIANTS.length + 1);
  assert.equal(v.families.effects.length, FAMILY_EFFECT_VARIANTS.length + 1);
  // typos: an unknown key on a family op, a misspelt op, a misspelt cost part, amount count and target kind
  const bad = (mutate: (s: CardScript) => void, what: string) => { const s = probeScript(); mutate(s); assert.equal(S.CardScriptChecked.safeParse(s).success, false, what); };
  bad(s => { (s.abilities![0] as { effects: unknown[] }).effects[0] = { op: 'probe-note', amount: 2, lowd: true }; }, 'a typo\'d field on a family op must be rejected');
  bad(s => { (s.abilities![0] as { effects: unknown[] }).effects[0] = { op: 'probe-notes', amount: 2 }; }, 'a misspelt family op must be rejected');
  bad(s => { (s.abilities![1] as { cost: unknown }).cost = { tap: true, probeTimeCounter: 2 }; }, 'a misspelt family cost part must be rejected (the cost object stays strict)');
  bad(s => { (s.abilities![0] as { effects: unknown[] }).effects[2] = { op: 'damage', amount: { count: 'probe-time-counter' }, target: { kind: 'any' } }; }, 'a misspelt family amount count must be rejected');
  bad(s => { (s.abilities![0] as { effects: unknown[] }).effects[2] = { op: 'damage', amount: 1, target: { kind: 'probe-suspended-cards' } }; }, 'a misspelt family target kind must be rejected');
  bad(s => { (s.abilities![2] as { effect: unknown }).effect = { kind: 'probe-becomes', power: 4 }; }, 'a family static missing a field must be rejected');
  bad(s => { s.asEnters = [{ kind: 'probe-enters-suspended' } as never]; }, 'a family as-enters missing a field must be rejected');
  // and the core is untouched: the documented example still passes the composed instance, a core typo still fails
  const example = JSON.parse(fs.readFileSync(path.join(DEFAULT_SCRIPTS_DIR(), '_example.json.txt'), 'utf8')) as CardScript;
  example.oracleHash = oracleHash('Whenever this creature attacks, you gain 1 life.');
  assert.equal(S.CardScriptChecked.safeParse(example).success, true);
  assert.equal(S.EffectSchema.safeParse({ op: 'draw', amount: 1, whoo: 'you' }).success, false);
});

test('schema: mergeFamilySchemas enforces the contract and names both files on a duplicate', () => {
  const entry = (family: string, schema: FamilySchemaEntry['schema']): FamilySchemaEntry => ({ family, file: `src/engine/ops/${family}.schema.ts`, schema });
  assert.throws(() => mergeFamilySchemas([PROBE, entry('other', { effects: [z.strictObject({ op: z.literal('probe-note') })] })], CORE_VOCABULARY),
    /duplicate effect op "probe-note" declared by both \(test\) src\/engine\/ops\/probe\.schema\.ts and src\/engine\/ops\/other\.schema\.ts/);
  assert.throws(() => mergeFamilySchemas([entry('other', { effects: [z.strictObject({ op: z.literal('draw') })] })], CORE_VOCABULARY),
    /duplicate effect op "draw" declared by both src\/cards\/schema-core\.ts \(the core vocabulary\) and src\/engine\/ops\/other\.schema\.ts/);
  assert.throws(() => mergeFamilySchemas([entry('other', { amounts: ['objects'] })], CORE_VOCABULARY), /duplicate amount count "objects"/);
  assert.throws(() => mergeFamilySchemas([entry('other', { targetKinds: ['multi'] })], CORE_VOCABULARY), /duplicate target kind "multi"/);
  assert.throws(() => mergeFamilySchemas([entry('other', { costParts: { mana: z.number() } })], CORE_VOCABULARY), /duplicate cost part "mana"/);
  assert.throws(() => mergeFamilySchemas([entry('other', { effects: [z.object({ op: z.literal('loose') })] })], CORE_VOCABULARY), /other\.schema\.ts: effects\[0\] must be STRICT/);
  assert.throws(() => mergeFamilySchemas([entry('other', { effects: [z.strictObject({ kind: z.literal('wrong-key') })] })], CORE_VOCABULARY), /no string-literal 'op' discriminator/);
  assert.throws(() => mergeFamilySchemas([entry('other', { keywords: ['zzz'] } as never)], CORE_VOCABULARY), /declares "keywords", which is not part of the FamilySchema contract/);
  assert.throws(() => mergeFamilySchemas([PROBE, { ...PROBE, file: 'twin.schema.ts' }], CORE_VOCABULARY), /two schemas named "probe"/);
  // the empty case — the state with no families — merges to empty lists
  const none = mergeFamilySchemas([], CORE_VOCABULARY);
  assert.deepEqual([none.effects, none.conditions, none.triggers, none.statics, none.asEnters, none.amounts, none.targetKinds, Object.keys(none.costParts)], [[], [], [], [], [], [], [], []]);
});
