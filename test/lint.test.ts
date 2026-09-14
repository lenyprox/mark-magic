// src/cards/lint.ts — one case per rule, plus the derivation of the vocabularies themselves. The derivation matters
// as much as the rules: every list is read out of the zod schema barrel and the op registries at run time (which is
// what closed the "type-only vocabularies" half of docs/HANDOFF.md item 12), so a zod upgrade that moved the
// discriminator internals must fail here rather than quietly produce an empty vocabulary that accepts anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_ROLES, AMOUNT_COUNT_VOCAB, CONDITION_VOCAB, countersOf, discriminators, EFFECT_OP_VOCAB, isAmountCountNode, KEYWORD_VOCAB,
  lintScript, printedTargets, STATIC_VOCAB, TARGET_KIND_VOCAB, TRIGGER_VOCAB,
} from '../src/cards/lint.js';
import { EFFECT_VARIANTS } from '../src/cards/schema.js';
import { parseCard } from '../src/cards/parse.js';
import { oracleHash, type CardScript } from '../src/cards/scripts.js';
import type { CardDef } from '../src/cards/types.js';
import { db } from './helpers.js';

/** The parser's own def (no script applied), the way `scripts:verify` loads a card. */
function parsed(name: string): CardDef {
  const row = db.db.prepare('SELECT json FROM oracle_cards WHERE name = ? ORDER BY first_printed LIMIT 1').get(name) as { json: string } | undefined;
  if (!row) throw new Error(`no card named ${name}`);
  const raw = JSON.parse(row.json) as Record<string, unknown>;
  return parseCard({ ...raw, representative_id: raw.representative_id ?? raw.id ?? null } as never);
}

const script = (def: CardDef, rest: Partial<CardScript> = {}): CardScript =>
  ({ oracleId: def.oracleId, name: def.name, oracleHash: oracleHash(def.oracleText), source: 'hand', mode: 'replace', ...rest });

const BOLT = parsed('Lightning Bolt');
const BEARS = parsed('Grizzly Bears');
const ANTHEM = parsed('Glorious Anthem');

/** The lint problems of a script for Lightning Bolt whose single spell ability is `effects`. */
function boltLint(effects: unknown[], rest: Partial<CardScript> = {}) {
  return lintScript(script(BOLT, { abilities: [{ kind: 'spell', effects: effects as never, text: '~ deals 3 damage to any target.' }], ...rest }), BOLT);
}

test('the vocabularies are derived at run time and are not empty', () => {
  assert.deepEqual(discriminators(EFFECT_VARIANTS, 'op').slice(0, 3), ['damage', 'destroy', 'exile']);
  assert.throws(() => discriminators(EFFECT_VARIANTS, 'kind'), /re-anchor src\/cards\/lint\.ts/);
  for (const [name, v] of [['effects', EFFECT_OP_VOCAB], ['conditions', CONDITION_VOCAB], ['triggers', TRIGGER_VOCAB], ['statics', STATIC_VOCAB], ['keywords', KEYWORD_VOCAB], ['target kinds', TARGET_KIND_VOCAB], ['amount counts', AMOUNT_COUNT_VOCAB]] as const) {
    assert.ok(v.size > 5, `${name} vocabulary has only ${v.size} entries`);
  }
  assert.ok(EFFECT_OP_VOCAB.has('for-each') && EFFECT_OP_VOCAB.has('damage'));
  assert.ok(TARGET_KIND_VOCAB.has('multi'), "the composition core's `multi` spec is a target kind");
  assert.ok(AMOUNT_COUNT_VOCAB.has('objects'), 'an amount may count a filter rather than a named set');
  assert.ok(KEYWORD_VOCAB.has('flying') && !KEYWORD_VOCAB.has('flyingg'));
});

test('a correct script lints clean', () => {
  const r = boltLint([{ op: 'damage', amount: 3, target: { kind: 'any' } }], { aiHints: { role: 'removal' } });
  assert.deepEqual(r.problems, []);
  assert.equal(r.level, 'ok');
});

test('an unknown op, trigger, kind or amount count is a problem', () => {
  assert.match(boltLint([{ op: 'drawww', amount: 1, who: 'you' }]).problems.join(), /unknown effect op 'drawww'/);
  assert.match(boltLint([{ op: 'damage', amount: { count: 'creatures-i-like' }, target: { kind: 'any' } }]).problems.join(), /unknown amount count 'creatures-i-like'/);
  assert.match(boltLint([{ op: 'damage', amount: 3, target: { kind: 'unicorn' } }]).problems.join(), /unknown kind 'unicorn'/);
  assert.match(
    lintScript(script(BEARS, { abilities: [{ kind: 'triggered', event: { on: 'somebody-sneezes' }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'x' }] }), BEARS).problems.join(),
    /unknown trigger event 'somebody-sneezes'/);
});

test('a counter name must be a known counter, a keyword counter, or one the card itself prints', () => {
  assert.match(boltLint([{ op: 'counters', target: { kind: 'creature' }, counter: 'wibble', amount: 1 }]).problems.join(), /unknown counter name "wibble"/);
  assert.deepEqual(boltLint([{ op: 'counters', target: { kind: 'creature' }, counter: '+1/+1', amount: 1 }]).problems, []);
  assert.deepEqual(boltLint([{ op: 'counters', target: { kind: 'creature' }, counter: 'flying', amount: 1 }]).problems, [], 'CR 122.1: every keyword is a counter name');
  // "names the card text mentions": a card that prints its own exotic counter may use it
  const hoof = { ...BOLT, oracleText: 'Put a mannequin counter on ~.' };
  assert.ok(countersOf(hoof).has('mannequin'));
  assert.ok(!countersOf(BOLT).has('mannequin'));
});

test('a subtype must be one the pool prints (the generated vocabulary, never a live DB query)', () => {
  assert.match(boltLint([{ op: 'token', count: 1, power: 1, toughness: 1, colors: [], types: ['Creature'], subtypes: ['Zomby'], keywords: [] }]).problems.join(), /"Zomby" is not a subtype/);
  assert.deepEqual(boltLint([{ op: 'token', count: 1, power: 2, toughness: 2, colors: ['B'], types: ['Creature'], subtypes: ['Zombie'], keywords: [] }]).problems, []);
});

test('an unknown keyword is a problem wherever it appears', () => {
  assert.match(boltLint([{ op: 'grant-keyword', target: { kind: 'creature' }, keywords: ['flyng'], duration: 'eot' }]).problems.join(), /unknown keyword "flyng"/);
  assert.match(boltLint([{ op: 'damage', amount: 3, target: { kind: 'creature', filter: { withKeyword: 'flyng' } } }]).problems.join(), /unknown keyword "flyng" in a filter/);
  assert.match(lintScript(script(BEARS, { keywords: ['flyng' as never] }), BEARS).problems.join(), /unknown keyword "flyng"/);
});

test('a trigger the card can never raise fails', () => {
  // an instant never reaches the battlefield
  assert.match(
    lintScript(script(BOLT, { abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'x' }] }), BOLT).problems.join(),
    /never reaches the battlefield/);
  // an `attacks` trigger on a noncreature with no animate
  assert.match(
    lintScript(script(ANTHEM, { abilities: [{ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'x' }] }), ANTHEM).problems.join(),
    /is not a creature and nothing in the script animates it/);
  // …unless the script animates it
  assert.deepEqual(
    lintScript(script(ANTHEM, { abilities: [{ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'animate', target: 'self', power: 2, toughness: 2, colors: [], types: ['Creature'], subtypes: [], keywords: [], duration: 'eot' }], text: 'x' }] }), ANTHEM).problems,
    []);
  // and a creature's own combat trigger is fine
  assert.deepEqual(
    lintScript(script(BEARS, { abilities: [{ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'x' }] }), BEARS).problems,
    []);
});

test('covers and ignore must name lines the card really prints, and match their rules', () => {
  const angel = parsed('Serra Angel');
  assert.deepEqual(lintScript(script(angel, { keywords: ['flying', 'vigilance'], covers: [{ line: 'Flying', by: 'keywords' }] }), angel).problems, []);
  assert.match(
    lintScript(script(angel, { keywords: ['flying'], covers: [{ line: 'Trample', by: 'keywords' }] }), angel).problems.join(),
    /covers names a line the card does not print/);
  assert.match(
    lintScript(script(angel, { covers: [{ line: 'Flying', by: 'keywords' }] }), angel).problems.join(),
    /this face declares no keywords/);
  assert.match(
    lintScript(script(BOLT, { ignore: [{ line: '~ deals 3 damage to any target.', reason: 'ante' }] }), BOLT).problems.join(),
    /ignore\[ante\]/);
});

test('aiHints.role is a closed vocabulary and value is a warning', () => {
  assert.match(boltLint([{ op: 'damage', amount: 3, target: { kind: 'any' } }], { aiHints: { role: 'vibes' } }).problems.join(), /aiHints.role "vibes" is not one of/);
  assert.ok(AI_ROLES.includes('removal'));
  const warn = boltLint([{ op: 'damage', amount: 3, target: { kind: 'any' } }], { aiHints: { role: 'removal', value: 99 } });
  assert.deepEqual(warn.problems, []);
  assert.equal(warn.level, 'warn');
  assert.match(warn.warnings.join(), /outside 0\.\.10/);
});

test("8c-1 L-1: a TargetSpec's or an op's `count: 'X'` is not an amount count", () => {
  assert.equal(isAmountCountNode({ kind: 'creature', count: 'X' }), false);
  assert.equal(isAmountCountNode({ op: 'token', count: 'X' }), false);
  assert.equal(isAmountCountNode({ filter: {}, zone: 'graveyard', who: 'you', count: 'all' }), false);
  assert.equal(isAmountCountNode({ count: 'creatures-you-control' }), true);
  assert.deepEqual(boltLint([{ op: 'damage', amount: 'X', target: { kind: 'creature', count: 'X' } }]).problems, [], 'up to X target creatures');
  assert.deepEqual(boltLint([{ op: 'token', count: 'X', power: 1, toughness: 1, colors: [], types: ['Creature'], subtypes: ['Elf'], keywords: [] }]).problems, [], 'create X tokens');
  assert.match(boltLint([{ op: 'damage', amount: { count: 'X' }, target: { kind: 'any' } }]).problems.join(), /unknown amount count 'X'/, "an AmountExpr count of 'X' is still wrong");
});

test("owner rule 2026-09-14: a 'choose-objects' standing in for a printed \"target\" is a problem", () => {
  const choose = { op: 'choose-objects', chooser: 'you', from: { filter: { types: ['Creature'] }, who: 'each-player' }, count: 1 };
  // Breeches' shape: "Target creature can't block" scripted as a resolution-time choice + cant-block on 'that'
  const bad = boltLint([choose, { op: 'cant-block', target: 'that', duration: 'eot' }]);
  assert.equal(bad.level, 'fail'); assert.match(bad.problems.join('\n'), /prints "target" 1 time\(s\) but declares 0 TargetSpec\(s\).*CR 115\.1, 601\.2c/);
  // the same line with a real TargetSpec is clean, and so is a resolution-time choice beside a declared target
  assert.equal(boltLint([{ op: 'cant-block', target: { kind: 'creature' }, duration: 'eot' }]).level, 'ok');
  assert.equal(boltLint([{ op: 'damage', amount: 3, target: { kind: 'any' } }, choose, { op: 'tap', target: 'that' }]).level, 'ok');
  // one printed target across two modes: a TargetSpec in one mode and a choice in the other is still one short
  const modal = boltLint([{ op: 'choose-mode', count: 1, modes: [[{ op: 'damage', amount: 3, target: { kind: 'any' } }], [choose, { op: 'tap', target: 'that' }]] }]);
  assert.equal(modal.level, 'ok');
  const twoPrinted = lintScript(script(BOLT, { abilities: [{ kind: 'spell', effects: [{ op: 'choose-mode', count: 1, modes: [[{ op: 'damage', amount: 3, target: { kind: 'any' } }], [choose, { op: 'tap', target: 'that' }]] }] as never, text: 'Choose one — ~ deals 3 damage to any target; or tap target creature.' }] }), BOLT);
  assert.equal(twoPrinted.level, 'fail');
  // a modal ability is checked mode by mode: the printed mode line against its own effects (Breeches, Eager Pillager)
  const modes = lintScript(script(BOLT, { abilities: [{ kind: 'spell', effects: [{ op: 'choose-modes', count: 1, labels: ['~ deals 3 damage to any target.', "Target creature can't block this turn."], modes: [[{ op: 'damage', amount: 3, target: { kind: 'any' } }], [choose, { op: 'cant-block', target: 'that', duration: 'eot' }]] }] as never, text: 'Choose one —' }] }), BOLT);
  assert.equal(modes.level, 'fail'); assert.match(modes.problems.join('; '), /"Target creature can't block this turn\." prints "target" 1 time/);
  // "becomes the target of" is targeting by something else: a choice there is not standing in for a target
  const targeted = lintScript(script(BEARS, { abilities: [{ kind: 'triggered', event: { on: 'targeted', self: true }, effects: [choose, { op: 'tap', target: 'that' }] as never, text: 'Whenever ~ becomes the target of a spell, tap a creature of your choice.' }] }), BEARS);
  assert.equal(targeted.level, 'ok', targeted.problems.join('; '));
  assert.equal(printedTargets("Destroy target creature. (It can't be regenerated.)"), 1);
  assert.equal(printedTargets('~ deals 2 damage divided as you choose among one or two targets.'), 1);
  assert.equal(printedTargets('Whenever ~ becomes the target of a spell or ability an opponent controls, draw a card.'), 0);
  assert.equal(printedTargets('Target creature gets +2/+2 until end of turn. Target player draws a card.'), 2);
});
