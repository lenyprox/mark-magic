// scripts/parse-wave-briefs.ts: the parse:why histogram → the parser wave's brief file. Grouping (stage + the
// template-sized part of the shape), the drops (keyword / second-face stages, under 3 cards), the sums, the
// `generic-<slug>` names unique against the families already on disk, the `suggestedHome` rules, the 16 + residual
// cut, and byte-identical output on a second run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, contentWords, groupKeyOf, slugOf } from '../scripts/parse-wave-briefs.js';
import type { Construct, Report } from '../scripts/parse-why.js';

const construct = (o: Partial<Construct> & { key: string; stage: Construct['stage']; shape: string; cards: number }): Construct => ({
  norm: o.key.slice(o.stage.length + 1), lines: o.cards, finishes: 0, scripted: 0, weight: 0.5 * o.cards, passes: { builtin: 0, registry: o.cards }, hints: { commaHeads: 0, pronounStarts: 0 },
  families: [{ family: 'generic', lines: o.cards }], examples: [{ oracleId: `id-${o.key}`, name: `Card ${o.key}`, edhrec: o.cards, line: o.norm ?? o.key, finishes: true }], rawFragments: [{ n: o.cards, fragment: o.key }], ...o,
});
const report = (constructs: Construct[]): Report => ({
  generatedFrom: { tier: 'paper', selection: 'pool:paper', ids: null, nested: false, excludeStages: ['keyword'], minCards: 1, top: 60, parserVersion: 5, rulesHash: 'abc' },
  totals: { cards: 0, unparsedCards: 0, oneLineCards: 0, finishCards: 0, lines: 0, lineCauses: 0, causes: constructs.length, byStage: {} },
  constructs, shapes: [], prefixes: [], nestedCauses: [],
});

test('groupKeyOf: the first four shape tokens for head stages, the whole shape otherwise', () => {
  assert.equal(groupKeyOf({ stage: 'trigger-head', shape: 'whenever equipped <obj> deals combat damage to a <player>' }), 'trigger-head|whenever equipped <obj> deals');
  assert.equal(groupKeyOf({ stage: 'cost', shape: 'exile ~ from your <zone>' }), 'cost|exile ~ from your');
  assert.equal(groupKeyOf({ stage: 'condition', shape: 'you do' }), 'condition|you do');
  assert.equal(groupKeyOf({ stage: 'sentence', shape: 'the ring tempts you' }), 'sentence|the ring tempts you');
  assert.equal(groupKeyOf({ stage: 'static', shape: 'start your engines!' }), 'static|start your engines!');
});

test('slugOf: three content tokens, stopwords kept only when nothing else names the item', () => {
  assert.equal(slugOf('trigger-head', 'whenever equipped <obj> deals combat damage'), 'generic-whenever-equipped-deals');
  assert.equal(slugOf('condition', 'you do'), 'generic-you-do');
  assert.equal(slugOf('condition', "you're the monarch"), 'generic-youre-monarch');
  assert.equal(slugOf('sentence', '# <obj> {m}'), 'generic-sentence');
  assert.equal(slugOf('trigger-head', "At the beginning of each player's draw step"), 'generic-beginning-player-draw');
  assert.equal(contentWords('at the beginning of'), 1);
  assert.equal(contentWords('whenever equipped <obj> attacks'), 3);
});

test('buildBrief: grouping, sums, drops, names, homes, the cut, and determinism', () => {
  const cs: Construct[] = [
    construct({ key: 'trigger-head|Whenever equipped creature deals combat damage to a player', stage: 'trigger-head', shape: 'whenever equipped <obj> deals combat damage to a <player>', cards: 21, finishes: 9, weight: 15 }),
    construct({ key: 'trigger-head|Whenever equipped creature deals damage', stage: 'trigger-head', shape: 'whenever equipped <obj> deals damage', cards: 4, finishes: 2, weight: 3 }),
    construct({ key: 'condition|you do', stage: 'condition', shape: 'you do', cards: 59, finishes: 31, weight: 45 }),
    construct({ key: 'trigger-head|Whenever ~ attacks, blocks, or becomes blocked', stage: 'trigger-head', shape: 'whenever ~ attacks, blocks, or becomes blocked', cards: 6, finishes: 6, weight: 6, hints: { commaHeads: 6, pronounStarts: 0 } }),
    construct({ key: 'sentence|Its controller frobnicates', stage: 'sentence', shape: 'its <player> frobnicates', cards: 5, finishes: 5, weight: 5, hints: { commaHeads: 0, pronounStarts: 5 } }),
    construct({ key: 'static|Wugs you control have frobnication', stage: 'static', shape: '<subtype> you control have frobnication', cards: 4, finishes: 1, weight: 2.5, passes: { builtin: 4, registry: 0 } }),
    construct({ key: 'keyword|Bestow {}', stage: 'keyword', shape: 'bestow {m}', cards: 40, finishes: 40, weight: 40 }),
    construct({ key: 'second-face|Draw a card', stage: 'second-face', shape: 'draw a <obj>', cards: 40, finishes: 0, weight: 20 }),
    construct({ key: 'sentence|Frobnicate the wug', stage: 'sentence', shape: 'frobnicate the wug', cards: 2, finishes: 2, weight: 2 }),
    construct({ key: 'condition|you do', stage: 'condition', shape: 'you do', cards: 3, finishes: 3, weight: 3, norm: 'you do it' }),
  ];
  cs[9].key = 'condition|you do it';
  const opts = { wave: '9.1p', base: 'abc1234', max: 3, file: 'data/master/parse-why.json', existing: ['composition.ts', 'generic-you-do.ts', 'types.ts'] };
  const b = buildBrief(report(cs), opts);
  assert.equal(b.wave, '9.1p'); assert.equal(b.base, 'abc1234'); assert.equal(b.generatedFrom.constructs, 10);
  // keyword / second-face and the 2-card construct are gone; the two "whenever equipped <obj> deals" constructs and the two "you do" conditions are one group each
  assert.deepEqual([...b.items, ...b.residual].map(i => i.group), ['condition|you do', 'trigger-head|whenever equipped <obj> deals', 'trigger-head|whenever ~ attacks, blocks,', 'sentence|its <player> frobnicates', 'static|<subtype> you control have frobnication']);
  assert.equal(b.items.length, 3); assert.equal(b.residual.length, 2);
  const eq = b.items[1];
  assert.deepEqual([eq.cards, eq.finishes, eq.lines, eq.weight], [25, 11, 25, 18]);
  assert.deepEqual(eq.clauses, [{ n: 21, clause: 'trigger-head|Whenever equipped creature deals combat damage to a player' }, { n: 4, clause: 'trigger-head|Whenever equipped creature deals damage' }]);
  assert.deepEqual(eq.cardIds, ['id-trigger-head|Whenever equipped creature deals damage', 'id-trigger-head|Whenever equipped creature deals combat damage to a player']);   // by EDHREC rank
  assert.equal(eq.title, 'trigger-head: whenever equipped <obj> deals');
  assert.equal(eq.suggestedHome, 'registry');
  // names: unique against the families on disk (generic-you-do.ts exists → -2) and within the file
  assert.deepEqual([...b.items, ...b.residual].map(i => i.name), ['generic-you-do-2', 'generic-whenever-equipped-deals', 'generic-whenever-attacks-blocks', 'generic-controller-frobnicates', 'generic-wugs-frobnication']);
  // suggestedHome: an inner-comma trigger head, a pronoun start, a builtin-dominated pass
  const homes = Object.fromEntries([...b.items, ...b.residual].map(i => [i.group, [i.suggestedHome, i.notes]]));
  assert.equal(homes['trigger-head|whenever ~ attacks, blocks,'][0], 'core'); assert.match(homes['trigger-head|whenever ~ attacks, blocks,'][1], /comma inside the head/);
  assert.equal(homes['sentence|its <player> frobnicates'][0], 'core'); assert.match(homes['sentence|its <player> frobnicates'][1], /unrewritten pronoun/);
  assert.equal(homes['static|<subtype> you control have frobnication'][0], 'core'); assert.match(homes['static|<subtype> you control have frobnication'][1], /dominant pass is builtin/);
  assert.equal(homes['condition|you do'][0], 'registry');
  // deterministic
  assert.equal(JSON.stringify(buildBrief(report(cs), opts)), JSON.stringify(b));
});
