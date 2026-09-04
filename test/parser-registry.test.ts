// The parser rule registry (src/cards/rules/): every rule kind is reachable, and none of them can shadow a built-in.
//
// A probe family is registered at runtime with one rule of each kind — line, effect, trigger, condition, static, cost
// — and a synthetic oracle row is pushed through parseCard. Each rule has to fire, the card has to come out
// fullyParsed, and the effect rule that also matches a sentence the built-ins already understand has to lose to them.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCard, parseEffectSentence, PARSER_VERSION, type OracleRow } from '../src/cards/parse.js';
import { CONDITION_RULES, COST_RULES, EFFECT_RULES, LINE_RULES, registerRules, RULE_FAMILIES, rulesHash, STATIC_RULES, TRIGGER_RULES, unregisterRules } from '../src/cards/rules/_registry.js';
import type { RuleFamily } from '../src/cards/rules/types.js';
import { renderRules, RULES_OUT_FILE } from '../scripts/gen-registry.mjs';

/** Which probe rules fired during the parse (the assertions below read this). */
const fired = new Set<string>();
/** What the line rule saw on LineCtx.keywords — Scryfall's own tags for the card. */
let sawScryfallKeywords: readonly string[] = [];

const PROBE: RuleFamily = {
  name: 'probe-parser',
  lines: [
    {
      // "Melee 2" reaches the keyword bail-out (melee is a keyword the built-ins know of but do not implement), so
      // this rule proves hook 1: a registered keyword line is claimable before it is recorded as unparsed.
      name: 'probe-melee',
      match: (line, ctx) => {
        if (!/^Melee \d+$/i.test(line)) return false;
        fired.add('line:melee');
        sawScryfallKeywords = ctx.keywords;
        ctx.addKeyword('trample');
        return true;
      },
    },
    {
      // "Probeform 3" is not a keyword the built-ins have heard of, so it falls all the way through the ladder: this
      // rule proves hook 2, the last chance before unknown(def, line).
      name: 'probe-form',
      match: (line, ctx) => {
        const m = line.match(/^Probeform (\d+)$/i);
        if (!m) return false;
        fired.add('line:probeform');
        ctx.addAsEnters({ kind: 'counters', counter: '+1/+1', amount: Number(m[1]) });
        ctx.addAltCost({ id: 'evoke', label: 'probeform', cost: { mana: ctx.parseManaCost('{1}')! }, from: 'hand' });
        ctx.addCostModifier({ kind: 'convoke' });
        ctx.addAbility({ kind: 'static', effect: { kind: 'self-keywords', keywords: ['haste'] }, text: line });
        return true;
      },
    },
  ],
  effects: [
    { re: /^probeflux$/i, make: () => { fired.add('effect:probeflux'); return { op: 'gain-life', amount: 3, who: 'you' }; } },
    // Also matches a sentence the built-in table already parses — the built-in must win (asserted below).
    { re: /^draw a card$/i, make: () => { fired.add('effect:shadow'); return { op: 'gain-life', amount: 99, who: 'you' }; } },
  ],
  triggers: [
    { name: 'probetriggers', make: h => (/^whenever ~ probetriggers$/i.test(h.trim()) ? (fired.add('trigger'), { on: 'etb', self: true }) : null) },
  ],
  conditions: [
    { name: 'probe-active', make: t => (/^the probe is active$/i.test(t.trim()) ? (fired.add('condition'), { kind: 'your-turn' }) : null) },
  ],
  statics: [
    { name: 'probeguard', make: (line, card) => (/^~ is probeguarded\.?$/i.test(line.trim()) && card.types.includes('Creature') ? (fired.add('static'), { kind: 'self-keywords', keywords: ['flying'] }) : null) },
  ],
  costs: [
    { name: 'probesac', make: p => (/^probesac$/i.test(p.trim()) ? (fired.add('cost'), { payLife: 1 }) : null) },
  ],
};

const TEXT = [
  'Melee 2',
  'Probeform 3',
  '{T}: Probeflux.',
  'Whenever Probe Golem probetriggers, if the probe is active, draw a card.',
  'Probe Golem is probeguarded.',
  'Probesac: Draw a card.',
].join('\n');

const ROW: OracleRow = {
  name: 'Probe Golem', oracle_id: 'probe-parser-0001', mana_cost: '{2}{U}', mana_value: 3, colors: ['U'], color_identity: ['U'],
  types: ['Creature'], supertypes: [], subtypes: ['Golem'], type_line: 'Creature — Golem', oracle_text: TEXT,
  power: '2', toughness: '3', loyalty: null, keywords: ['Melee'], layout: 'normal',
};

const hashBefore = rulesHash();
registerRules(PROBE);
after(() => unregisterRules(PROBE.name));

test('registerRules exposes the family in every flat array', () => {
  assert.ok(RULE_FAMILIES.some(f => f.name === 'probe-parser'));
  assert.equal(LINE_RULES.length, 2);
  assert.equal(EFFECT_RULES.length, 2);
  assert.equal(TRIGGER_RULES.length, 1);
  assert.equal(CONDITION_RULES.length, 1);
  assert.equal(STATIC_RULES.length, 1);
  assert.equal(COST_RULES.length, 1);
  assert.notEqual(rulesHash(), hashBefore, 'rulesHash must move when a family is registered');
  assert.throws(() => registerRules(PROBE), /already registered/);
});

test('every parser rule kind fires on a synthetic card, and the card is fullyParsed', () => {
  fired.clear();
  const def = parseCard(ROW);

  assert.deepEqual(def.unparsed, [], 'no line may be left unparsed');
  assert.equal(def.fullyParsed, true);
  assert.deepEqual([...fired].sort(), ['condition', 'cost', 'effect:probeflux', 'line:melee', 'line:probeform', 'static', 'trigger']);

  // line rule 1 (the keyword bail-out hook) — and the Scryfall keyword tags reached LineCtx
  assert.ok(def.keywords.includes('trample'));
  assert.deepEqual([...sawScryfallKeywords], ['Melee']);

  // line rule 2 (the last-chance hook) and its LineCtx mutators
  assert.deepEqual(def.asEnters, [{ kind: 'counters', counter: '+1/+1', amount: 3 }]);
  assert.equal(def.altCosts?.[0].id, 'evoke');
  assert.deepEqual(def.costModifiers, [{ kind: 'convoke' }]);

  // effect rule, reached through an activated ability's body
  const flux = def.abilities.find(a => a.kind === 'activated' && a.cost.tap);
  assert.ok(flux && flux.kind === 'activated');
  assert.deepEqual(flux.effects, [{ op: 'gain-life', amount: 3, who: 'you' }]);

  // trigger rule + condition rule (the latter as the intervening "if")
  const trig = def.abilities.find(a => a.kind === 'triggered');
  assert.ok(trig && trig.kind === 'triggered');
  assert.deepEqual(trig.event, { on: 'etb', self: true });
  assert.equal(trig.intervening?.kind, 'your-turn');
  assert.deepEqual(trig.effects, [{ op: 'draw', amount: 1, who: 'you' }]);

  // static rule
  const stat = def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'self-keywords' && a.effect.keywords.includes('flying'));
  assert.ok(stat, 'the registry static rule should have produced a self-keywords static');

  // cost rule, reached through parseCostPhrase on an activated ability's cost
  const sac = def.abilities.find(a => a.kind === 'activated' && a.cost.payLife === 1);
  assert.ok(sac && sac.kind === 'activated');
  assert.deepEqual(sac.effects, [{ op: 'draw', amount: 1, who: 'you' }]);
});

test('a registry effect rule cannot shadow a built-in', () => {
  fired.clear();
  // The probe family registers /^draw a card$/i too, but the built-in table runs first and owns that sentence.
  assert.deepEqual(parseEffectSentence('Draw a card.'), { op: 'draw', amount: 1, who: 'you' });
  assert.equal(fired.has('effect:shadow'), false, 'the registry rule must never have been consulted');
  // ... and it still fires for a sentence no built-in claims.
  assert.deepEqual(parseEffectSentence('Probeflux.'), { op: 'gain-life', amount: 3, who: 'you' });
  assert.equal(fired.has('effect:probeflux'), true);
});

test('unregisterRules empties the flat arrays again', () => {
  unregisterRules(PROBE.name);
  assert.equal(LINE_RULES.length, 0);
  assert.equal(EFFECT_RULES.length, 0);
  assert.equal(rulesHash(), hashBefore);
  const def = parseCard(ROW);
  assert.equal(def.fullyParsed, false, 'with no rules registered the synthetic lines are unparsed again');
  registerRules(PROBE); // put it back for the after() hook / any later test
});

test('src/cards/rules/_registry.ts is what gen:registry produces (run `npm run gen:registry`)', () => {
  const onDisk = fs.readFileSync(RULES_OUT_FILE, 'utf8');
  assert.equal(onDisk, renderRules(), 'generated rules barrel is stale — run `npm run gen:registry` and commit the result');
  assert.ok(onDisk.startsWith('// GENERATED by scripts/gen-registry.mjs — do not edit'), 'the barrel must carry the generated header');
  assert.equal(onDisk.includes('\r'), false, 'the generated barrel must be written with LF endings');
});

test('PARSER_VERSION is a positive integer (it is stamped into the parse snapshot)', () => {
  assert.ok(Number.isInteger(PARSER_VERSION) && PARSER_VERSION >= 1);
});
