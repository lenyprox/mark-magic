// The parser rule registry (src/cards/rules/): every rule kind is reachable, and none of them can take a line, a
// sentence, a trigger head or a cost phrase away from a built-in.
//
// Two probe families are registered at runtime.
//   * `probe-parser` has one rule of each kind — line, effect, trigger, condition, static, cost — and a synthetic
//     oracle row is pushed through parseCard. Each rule has to fire, the card has to come out fullyParsed, and the
//     effect rule that also matches a sentence the built-ins already understand has to lose to them.
//   * `probe-adversarial` (in its own test) is the interesting one: its rules are deliberately wide enough to reach
//     lines the built-ins claim at a *later* stage than the sub-parser the rule hangs off. Each assertion pairs a
//     built-in that must still win with a positive control on the same rule, so the test cannot pass vacuously.
//
// Sizes are asserted as deltas and every synthetic line uses a nonsense word, so a real rule family landing in a later
// phase neither breaks these tests nor makes them silently stop testing anything.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCard, parseEffects, parseEffectSentence, PARSER_VERSION, type OracleRow } from '../src/cards/parse.js';
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
      // "Melee 3 probemark" reaches the keyword bail-out (melee is a keyword the built-ins know of but do not
      // implement), so this rule proves hook 1: a registered keyword line is claimable before it is recorded as
      // unparsed. The "probemark" suffix keeps the line out of reach of any real melee rule family.
      name: 'probe-melee',
      match: (line, ctx) => {
        if (!/^Melee \d+ probemark$/i.test(line)) return false;
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
  'Melee 3 probemark',
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

/** Sizes are asserted as deltas: a real rule family landing later must not break this test. */
const sizeBefore = { lines: LINE_RULES.length, effects: EFFECT_RULES.length, triggers: TRIGGER_RULES.length, conditions: CONDITION_RULES.length, statics: STATIC_RULES.length, costs: COST_RULES.length };
const hashBefore = rulesHash();
registerRules(PROBE);
after(() => unregisterRules(PROBE.name));

test('registerRules exposes the family in every flat array', () => {
  assert.ok(RULE_FAMILIES.some(f => f.name === 'probe-parser'));
  assert.equal(LINE_RULES.length, sizeBefore.lines + 2);
  assert.equal(EFFECT_RULES.length, sizeBefore.effects + 2);
  assert.equal(TRIGGER_RULES.length, sizeBefore.triggers + 1);
  assert.equal(CONDITION_RULES.length, sizeBefore.conditions + 1);
  assert.equal(STATIC_RULES.length, sizeBefore.statics + 1);
  assert.equal(COST_RULES.length, sizeBefore.costs + 1);
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

// A rule's own dispatch point running "built-ins first" is not enough on its own: a sub-parser's `unknown`/`null` is
// also the signal a LATER built-in stage uses to claim the line. Each case below would pass on the naive ordering only
// because the registry answered too early; every one is paired with a positive control on the same rule.
const ADVERSARIAL: RuleFamily = {
  name: 'probe-adversarial',
  // Matches a whole sentence the built-ins only understand after their " and " decomposition.
  effects: [{ re: /^draw a card and you gain 2 life(?: exactly)?$/i, make: () => ({ op: 'gain-life', amount: 99, who: 'you' }) }],
  // Matches the narrow first-comma trigger head of a line whose greedy re-split the built-ins do parse.
  triggers: [{ name: 'narrow-head', make: h => (/^whenever a goblin$/i.test(h.trim()) ? { on: 'upkeep', whose: 'your' } : null) }],
  // Matches lines the built-in static table declines but the built-in spell-text branch owns on an instant/sorcery.
  statics: [{ name: 'wide-static', make: l => (/^creatures you control (?:gain|have) /i.test(l.trim()) ? { kind: 'self-keywords', keywords: ['flying'] } : null) }],
  // Makes parseActivatedLine claim the head of a line the built-in static table parses as a granted mana ability.
  costs: [{ name: 'wide-cost', make: p => (/^creatures you control have /i.test(p.trim()) ? { payLife: 1 } : null) }],
};

const row = (types: string[], text: string): OracleRow => ({
  name: 'Adversary Test', oracle_id: 'probe-adversarial-0001', mana_cost: '{1}', mana_value: 1, colors: [], color_identity: [],
  types: types as OracleRow['types'], supertypes: [], subtypes: [], type_line: types.join(' '), oracle_text: text,
  power: null, toughness: null, loyalty: null, keywords: [], layout: 'normal',
});

test('a rule can never pre-empt a built-in stage that runs later than its own dispatch point', () => {
  registerRules(ADVERSARIAL);
  try {
    // 1. parseStatic runs *above* the spell-text branch: a static rule must not take a line off an instant/sorcery.
    const sorcery = parseCard(row(['Sorcery'], 'Creatures you control gain trample until end of turn.\nDraw a card.'));
    assert.equal(sorcery.abilities.length, 1);
    const spell = sorcery.abilities[0];
    assert.ok(spell.kind === 'spell');
    assert.deepEqual(spell.effects, [
      { op: 'grant-keyword', target: 'creatures-you-control', keywords: ['trample'], duration: 'eot' },
      { op: 'draw', amount: 1, who: 'you' },
    ]);
    // ... but the same rule still claims that line on a permanent, where no built-in stage below wanted it.
    const permanent = parseCard(row(['Creature'], 'Creatures you control gain trample until end of turn.'));
    assert.deepEqual(permanent.abilities.map(a => (a.kind === 'static' ? a.effect : null)), [{ kind: 'self-keywords', keywords: ['flying'] }]);

    // 2. parseCostPhrase feeds parseActivatedLine, which runs *above* the static branch.
    const granted = parseCard(row(['Enchantment'], 'Creatures you control have "{T}: Add one mana of any color."'));
    assert.equal(granted.fullyParsed, true);
    assert.equal(granted.abilities.length, 1);
    assert.equal(granted.abilities[0].kind === 'static' && granted.abilities[0].effect.kind, 'grant-mana-ability');
    // ... and the cost rule still claims a "cost: effect" line no built-in cost phrase matches.
    const activated = parseCard(row(['Enchantment'], 'Creatures you control have flair: Draw a card.'));
    assert.equal(activated.abilities[0].kind === 'activated' && activated.abilities[0].cost.payLife, 1);

    // 3. The trigger head's greedy comma re-split is itself a built-in stage, below the narrow first-comma split.
    const trigger = parseCard(row(['Creature'], 'Whenever a Goblin, Elf, or Zombie you control dies, draw a card.'));
    assert.equal(trigger.fullyParsed, true);
    assert.ok(trigger.abilities[0].kind === 'triggered');
    assert.equal(trigger.abilities[0].event.on, 'dies');
    // ... and the trigger rule still answers a head both built-in splits decline.
    const narrow = parseCard(row(['Creature'], 'Whenever a Goblin, draw a card.'));
    assert.ok(narrow.abilities[0].kind === 'triggered');
    assert.deepEqual(narrow.abilities[0].event, { on: 'upkeep', whose: 'your' });

    // 4. parseEffectSentence runs above the built-in ", then" / " and " decomposition of the same sentence.
    assert.deepEqual(parseEffects('Draw a card and you gain 2 life.'), [
      { op: 'draw', amount: 1, who: 'you' },
      { op: 'gain-life', amount: 2, who: 'you' },
    ]);
    // ... and the same rule answers the sentence the built-ins cannot decompose.
    assert.deepEqual(parseEffects('Draw a card and you gain 2 life exactly.'), [{ op: 'gain-life', amount: 99, who: 'you' }]);
  } finally {
    unregisterRules(ADVERSARIAL.name);
  }
});

test('unregisterRules empties the flat arrays again', () => {
  unregisterRules(PROBE.name);
  assert.equal(LINE_RULES.length, sizeBefore.lines);
  assert.equal(EFFECT_RULES.length, sizeBefore.effects);
  assert.equal(rulesHash(), hashBefore);
  const def = parseCard(ROW);
  assert.equal(def.fullyParsed, false, 'with the probe family gone the synthetic lines are unparsed again');
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
