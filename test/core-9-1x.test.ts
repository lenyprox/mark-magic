// Phase 9.1x — the core changes a board cannot show as a scenario: what `legalActions` does NOT offer, what
// `performAction` refuses, the payment planner's Phyrexian routes, the parser's new shapes, the characteristics
// overlay's removal channel and the parser-rule host flags. Each `it` fails on the tree before its fix.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MASTER_DB } from '../src/config/paths.js';
import { CardDB } from '../src/cards/db.js';
import { parseCard, parseManaCost, energyOf } from '../src/cards/parse.js';
import { registerRules, unregisterRules } from '../src/cards/rules/_registry.js';
import type { OracleRow } from '../src/cards/types.js';
import { legalActions } from '../src/engine/legal.js';
import { findPayment } from '../src/engine/mana.js';
import { subtypes, types } from '../src/engine/characteristics.js';
import { registerFamily, unregisterFamily } from '../src/engine/ops/_registry.js';
import { runScenario } from '../src/verify/scenarioDsl.js';

const hasDb = fs.existsSync(MASTER_DB());
const skip = !hasDb;
/** A board built by the scenario DSL and nothing else done to it. */
const board = (seats: Parameters<typeof runScenario>[0]['seats']) => runScenario({ name: 'board', cr: '0', seats, script: [{ sba: true }], expect: [{ stack: 0 }] }).then(r => r.game);

// ------------------------------------------------------------------ item 1: CR 113.6b
test('item 1: an ability that functions only from the graveyard is not offered while the permanent is on the battlefield', { skip }, async () => {
  const g = await board([{ bf: ['Tymaret, the Murder King', 'Swamp', 'Mountain', 'Grizzly Bears'] }, {}]);
  const labels = legalActions(g, 0).map(l => l.label).filter(l => /Tymaret/.test(l));
  assert.ok(labels.some(l => /deals 2 damage/.test(l)), 'the battlefield ability is offered');
  assert.equal(labels.some(l => /from your graveyard/.test(l)), false, 'the graveyard-only ability is not (CR 113.6b)');
  // and it still is from the graveyard, as before
  const g2 = await board([{ bf: ['Swamp', 'Mountain', 'Grizzly Bears'], graveyard: ['Tymaret, the Murder King'] }, {}]);
  assert.ok(legalActions(g2, 0).some(l => /Tymaret.*from your graveyard/.test(l.label)));
});

// ------------------------------------------------------------------ item 2: CR 118.9
test('item 2: a cast that chose an alternative cost is never a free cast as well', { skip }, async () => {
  // a family that says "cast anything from your graveyard without paying its mana cost"
  registerFamily({ name: 'x-free', castFrom: (_g, _p, _c, from) => from === 'graveyard' ? true : undefined, freeCast: (_g, _p, _c, from) => from === 'graveyard' ? true : undefined });
  try {
    const g = await board([{ bf: ['Island', 'Island', 'Island'], graveyard: ['Think Twice'] }, {}]);
    const card = g.state.players[0].graveyard[0];
    assert.equal(await g.performAction(0, { type: 'cast', cardId: card.id, from: 'graveyard', alt: 'flashback' }), true, 'flashback is castable');
    const tapped = g.state.players[0].battlefield.filter(o => o.tapped).length;
    assert.equal(tapped, 3, 'the flashback cost {2}{U} was paid — the free-cast permission does not stack on a chosen alternative cost');
    // the permission itself still works when no alternative cost is chosen
    const g2 = await board([{ bf: ['Island', 'Island', 'Island'], graveyard: ['Think Twice'] }, {}]);
    const card2 = g2.state.players[0].graveyard[0];
    assert.equal(await g2.performAction(0, { type: 'cast', cardId: card2.id, from: 'graveyard' }), true);
    assert.equal(g2.state.players[0].battlefield.filter(o => o.tapped).length, 0, 'the plain graveyard cast is free');
  } finally { unregisterFamily('x-free'); }
});

// ------------------------------------------------------------------ item 3: CR 205.1a
test('item 3: the overlay can SET types and subtypes instead of adding to them', { skip }, async () => {
  const g = await board([{ bf: ['Grizzly Bears', 'Forest'] }, {}]);
  const bears = g.state.players[0].battlefield[0]; const forest = g.state.players[0].battlefield[1];
  const base = { power: 1, toughness: 1, colors: [], keywords: [] } as const;
  bears.animated = { ...base, types: ['Enchantment'], subtypes: ['Frog'] };
  assert.deepEqual(types(bears), ['Creature', 'Enchantment'], 'additive by default (CR 205.1b)');
  assert.deepEqual(subtypes(bears), ['Bear', 'Frog']);
  bears.animated = { ...base, types: ['Enchantment'], subtypes: ['Frog'], replaceTypes: true, replaceSubtypes: true };
  assert.deepEqual(types(bears), ['Enchantment'], 'a SET card type replaces the printed ones (CR 205.1a)');
  assert.deepEqual(subtypes(bears), ['Frog'], 'a SET creature type replaces the printed creature types');
  forest.animated = { ...base, types: ['Creature'], subtypes: ['Frog'], replaceSubtypes: true };
  assert.deepEqual(types(forest), ['Land', 'Creature']);
  assert.deepEqual(subtypes(forest), ['Forest', 'Frog'], 'only the subtypes of the same set are replaced — a land that becomes a Frog keeps its land types');
});

// ------------------------------------------------------------------ item 7: CR 601.2c
test('item 7: the engine refuses a cast whose required target has no legal option, whatever the caller', { skip }, async () => {
  const g = await board([{ bf: ['Forest', 'Forest'], hand: ['Naturalize'] }, {}]);
  const card = g.state.players[0].hand.find(c => c.def.name === 'Naturalize')!;
  assert.equal(legalActions(g, 0).some(l => /Naturalize/.test(l.label)), false, 'not offered (as before)');
  assert.equal(await g.performAction(0, { type: 'cast', cardId: card.id }), false, 'and refused when asked for directly');
  assert.equal(g.state.stack.length, 0);
  assert.equal(card.zone, 'hand');
});

// ------------------------------------------------------------------ items 8, 10, 15: the parser
test('item 8: "noncreature land you control" is a land target, not a creature that is not a creature', { skip }, () => {
  const db = CardDB.shared();
  const nissa = db.get('Nissa, Who Shakes the World')!;
  const plus = nissa.abilities.find(a => a.kind === 'activated' && a.loyalty === 1)!;
  assert.equal(plus.kind, 'activated');
  const t = (plus.effects[0] as { target: { kind: string; filter: { types: string[]; notTypes: string[] } } }).target;
  assert.equal(t.kind, 'land');
  assert.deepEqual(t.filter, { notTypes: ['Creature'], types: ['Land'] });
  const crush = db.get('Crush')!.abilities[0] as { effects: { target: { kind: string } }[] };
  assert.equal(crush.effects[0].target.kind, 'artifact', '"noncreature artifact" is an artifact');
  const cryo = db.get('Cryoclasm')!.abilities[0] as { effects: { target: { kind: string; filter: { subtypes: string[] } } }[] };
  assert.equal(cryo.effects[0].target.kind, 'land', '"target Plains or Island" is still a land (named by land type)');
  assert.deepEqual(cryo.effects[0].target.filter.subtypes, ['Plains', 'Island']);
  const gorilla = db.get('Guerrilla Gorilla')!.abilities.find(a => a.kind === 'activated') as { effects: { target: { kind: string } }[] };
  assert.equal(gorilla.effects[0].target.kind, 'artifact-or-enchantment', '"noncreature artifact or noncreature enchantment" reaches both');
});

test('item 10: a hybrid Phyrexian pip is parsed and counts one toward mana value', { skip }, () => {
  const mc = parseManaCost('{1}{G}{G/W/P}{W}')!;
  assert.deepEqual(mc.phyrexianHybrid, [['G', 'W']]);
  assert.deepEqual(mc.pips, ['G', 'W']);
  assert.equal(mc.phyrexian.length, 0);
  assert.equal(parseManaCost('{1}{G}')!.phyrexianHybrid, undefined, 'absent when there is none');
  const ajani = CardDB.shared().get('Ajani, Sleeper Agent')!;
  assert.equal(ajani.manaCost!.phyrexianHybrid!.length, 1);
  assert.ok(ajani.altCosts?.some(a => a.id === 'life'), 'the planeswalker family now claims his Compleated line');
});

test('item 15: "{E}" is energy — on a sacrifice-unless-pay and in a cost phrase', { skip }, () => {
  assert.equal(energyOf('{E}{E}'), 2);
  const db = CardDB.shared();
  const prison = db.get('Static Prison')!.abilities[1] as { effects: { op: string; energy?: number; mana: { pips: string[]; raw: string } }[] };
  assert.equal(prison.effects[0].op, 'sacrifice-unless-pay');
  assert.equal(prison.effects[0].energy, 1);
  const hellion = db.get('Lathnu Hellion')!.abilities[1] as { effects: { energy?: number }[] };
  assert.equal(hellion.effects[0].energy, 2);
  const zoa = db.get('Electrozoa')!.abilities[1] as { effects: { op: string; cost: { energy?: number; mana?: unknown } }[] };
  assert.equal(zoa.effects[0].op, 'unless-pays');
  assert.equal(zoa.effects[0].cost.energy, 1);
  assert.equal(zoa.effects[0].cost.mana, undefined, 'no empty mana cost beside it');
});

// ------------------------------------------------------------------ item 11: CR 107.4f
test('item 11: the payment planner solves a Phyrexian pip with mana when it can, with life when it must, and never past the life total', { skip }, async () => {
  const g = await board([{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ["Vraska, Betrayal's Sting"] }, {}]);
  const pl = g.state.players[0];
  const vraska = pl.hand.find(c => c.def.name === "Vraska, Betrayal's Sting")!;
  const cost = vraska.def.manaCost!;                                                   // {4}{B}{B/P}
  const six = findPayment(g.state, pl, cost)!;
  assert.ok(six, 'payable');
  assert.equal(six.life, undefined, 'six Swamps: the pip is paid with mana');
  assert.equal(six.taps.length, 6);
  pl.battlefield.pop(); g.state.bfGen = (g.state.bfGen ?? 0) + 1;
  const five = findPayment(g.state, pl, cost)!;
  assert.ok(five, 'five Swamps: still payable — the pip is paid with 2 life (the old greedy solve took the colour first and failed on the generic)');
  assert.equal(five.life, 2);
  assert.equal(five.taps.length, 5);
  pl.life = 1;
  assert.equal(findPayment(g.state, pl, cost), null, 'at 1 life the 2-life route is not available (CR 119.4)');
  pl.life = 20;
  // paying the plan charges the life and records the route for compleated (CR 107.4f)
  assert.equal(await g.performAction(0, { type: 'cast', cardId: vraska.id }), true);
  assert.equal(pl.life, 18);
  assert.equal(vraska.castWith?.phyrexianLife, 1);
  await g.resolveStackFully();
  assert.equal(vraska.counters.loyalty, 4, 'compleated: two fewer loyalty counters for the pip paid with life, on the printed route');
});

// ------------------------------------------------------------------ item 17: EffectCtx.host
test('item 17: a registry effect rule is told whether its host is a triggered ability', { skip }, () => {
  const seen: { triggering: boolean; bound: boolean }[] = [];
  registerRules({ name: 'x-host', effects: [{ re: /^probe the host$/i, make: (_m, ctx) => { seen.push({ triggering: ctx.host.triggering, bound: ctx.host.bound }); return { op: 'draw', amount: 1, who: 'you' }; } }] });
  try {
    const row = (types: string[], text: string): OracleRow => ({
      name: 'Host Test', oracle_id: 'probe-host-0001', mana_cost: '{1}', mana_value: 1, colors: [], color_identity: [],
      types: types as OracleRow['types'], supertypes: [], subtypes: [], type_line: types.join(' '), oracle_text: text,
      power: null, toughness: null, loyalty: null, keywords: [], layout: 'normal',
    });
    parseCard(row(['Sorcery'], 'Probe the host.'));
    parseCard(row(['Creature'], 'Whenever a creature you control dies, probe the host.'));
    parseCard(row(['Creature'], '{T}: Probe the host.'));
    assert.deepEqual(seen.map(h => h.triggering), [false, true, false], 'spell body, triggered body, activated body');
    assert.equal(seen[1].bound, true, 'a trigger about another object holds it as the frame');
  } finally { unregisterRules('x-host'); }
});

after(() => { /* nothing registered outlives its test */ });
