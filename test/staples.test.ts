// End-to-end engine tests for the metagame staples unlocked by the coverage work: alternative costs, as-enters
// effects, delve/escape/flashback, library manipulation, hand attack, delayed triggers, Sagas, crew, MDFC lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, find, inHand, Script, setup } from './helpers.js';
import { legalActions } from '../src/engine/legal.js';
import { isCreature, power, toughness } from '../src/engine/characteristics.js';
import type { Game } from '../src/engine/game.js';
import type { GameObject, LegalAction, PlayerId, TargetRef } from '../src/engine/state.js';

function addTo(g: Game, pid: PlayerId, zone: 'graveyard' | 'exile' | 'library', names: string[]): GameObject[] {
  const pl = g.state.players[pid]; const out: GameObject[] = [];
  for (const n of names) {
    const o = { ...pl.library.pop()!, def: C(n) } as GameObject; o.zone = zone; o.owner = pid; o.controller = pid; o.counters = {}; o.activatedThisTurn = new Set();
    if (zone === 'library') pl.library.unshift(o); else pl[zone].push(o);
    out.push(o);
  }
  return out;
}
const legal = (g: Game, p: PlayerId, prefix: string): LegalAction | undefined => legalActions(g, p).find(l => l.label.startsWith(prefix));
const labels = (g: Game, p: PlayerId) => legalActions(g, p).map(l => l.label);
async function perform(g: Game, p: PlayerId, l: LegalAction, targets?: TargetRef[][]) {
  const t = targets ?? (l.targetOptions ?? []).map(o => o.optional ? [] : o.options.slice(0, o.count));
  const ok = await g.performAction(p, { ...l.action, targets: t } as never);
  assert.ok(ok, `could not perform ${l.label}`);
}
const zoneOf = (g: Game, id: number) => { for (const pl of g.state.players) for (const z of ['hand', 'battlefield', 'graveyard', 'exile', 'library'] as const) if (pl[z].some(o => o.id === id)) return z; return g.state.stack.some(i => i.source.id === id) ? 'stack' : 'gone'; };

// ---------------------------------------------------------------- parser pins
test('staples fully parse', () => {
  for (const n of ['Force of Will', 'Daze', 'Force of Negation', 'Snuff Out', 'Solitude', 'Grief', 'Steam Vents', 'Seachrome Coast', 'Deserted Beach', 'Polluted Delta', 'Flooded Strand', 'Ancient Tomb', 'City of Traitors', 'Cavern of Souls', 'Mox Diamond', "Lion's Eye Diamond", 'Murktide Regent', 'Walking Ballista', 'Faithless Looting', 'Cabal Therapy', 'Life from the Loam', 'Leyline Binding', 'Thalia, Guardian of Thraben', 'Frogmite', 'Village Rites', 'Brainstorm', 'Ponder', 'Impulse', 'Stock Up', 'Flow State', 'Thoughtseize', 'Inquisition of Kozilek', 'Duress', 'Swords to Plowshares', 'Path to Exile', 'Fatal Push', 'Prismatic Ending', 'Stifle', 'Spell Snare', "Mishra's Bauble", 'Orcish Bowmasters', 'Reanimate', "Green Sun's Zenith", 'Stoneforge Mystic', "Dragon's Rage Channeler", 'Mox Opal', 'Sink into Stupor // Soporific Springs', 'Riverpyre Verge', 'Burst Lightning', 'Show and Tell', 'Chemister\'s Insight', 'Lotus Petal']) {
    const d = C(n); assert.ok(d.fullyParsed, `${n} should be fully parsed; unparsed: ${d.unparsed.join(' | ')}`);
  }
  assert.equal(C('Force of Will').altCosts?.[0].id, 'pitch');
  assert.deepEqual(C('Force of Will').altCosts?.[0].cost.exileFromHand?.filter, { colors: ['U'] });
  assert.equal(C('Daze').altCosts?.[0].cost.returnToHand?.subtypes?.[0], 'Island');
  assert.equal(C('Force of Negation').altCosts?.[0].condition?.kind, 'not-your-turn');
  assert.equal(C('Solitude').altCosts?.[0].id, 'evoke');
  assert.deepEqual(C('Steam Vents').asEnters?.[0], { kind: 'pay-life-or-tapped', life: 2 });
  assert.equal(C('Murktide Regent').costModifiers?.[0].kind, 'delve');
  assert.equal(C('Chalice of the Void').asEnters?.[0].kind, 'counters');
  assert.equal(C('Overlord of the Balemurk').altCosts?.find(a => a.id === 'impending')?.timeCounters, 5);
  assert.equal(C('Nethergoyf').altCosts?.[0].cost.exileOtherFromGraveyard?.minCardTypes, 4);
  assert.equal(C("Smuggler's Copter").abilities.find(a => a.kind === 'activated' && a.cost.tapCreaturesTotalPower)?.kind, 'activated');
  assert.ok(C("Kozilek's Command").unparsed.length > 0, 'modal unknowns are recorded');
  assert.equal(C("Urza's Saga").finalChapter, 3);
});

// ---------------------------------------------------------------- alternative costs
test('Force of Will: pitch a blue card to counter for free', async () => {
  const g = setup({ bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }, { hand: ['Force of Will', 'Counterspell'] });
  await perform(g, 0, legal(g, 0, 'cast Grizzly Bears')!);
  const ls = labels(g, 1);
  assert.ok(ls.some(l => l.startsWith('cast Force of Will (')), `expected a pitch variant in ${ls.join(', ')}`);
  assert.ok(!ls.includes('cast Force of Will'), 'no mana: the plain cast is not legal');
  const fow = legal(g, 1, 'cast Force of Will (')!;
  await perform(g, 1, fow, [[{ kind: 'stack', id: g.state.stack[0].id }]]);
  await g.resolveStackFully();
  assert.equal(g.state.players[1].life, 19);
  assert.equal(zoneOf(g, inHandOrElse(g, 1, 'Counterspell')), 'exile');
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === 'Grizzly Bears'), true, 'Bears countered');
  assert.equal(g.state.players[1].graveyard.some(o => o.def.name === 'Force of Will'), true);
});
function inHandOrElse(g: Game, p: PlayerId, n: string): number { const all = [...g.state.players[p].hand, ...g.state.players[p].exile, ...g.state.players[p].graveyard]; return all.find(o => o.def.name === n)!.id; }

test('Daze: return an Island to counter unless they pay {1}', async () => {
  const g = setup({ bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }, { bf: ['Island'], hand: ['Daze'] });
  await perform(g, 0, legal(g, 0, 'cast Grizzly Bears')!);
  const daze = legal(g, 1, 'cast Daze (')!;
  await perform(g, 1, daze, [[{ kind: 'stack', id: g.state.stack[0].id }]]);
  assert.equal(g.state.players[1].hand.some(o => o.def.name === 'Island'), true, 'Island returned to hand');
  await g.resolveStackFully();
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === 'Grizzly Bears'), true, 'no spare mana: Bears countered');
});

test('Force of Negation: the pitch cost only on an opponent\'s turn', async () => {
  const g = setup({ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { hand: ['Force of Negation', 'Counterspell'] });
  await perform(g, 0, legal(g, 0, 'cast Lightning Bolt')!, [[{ kind: 'player', id: 1 }]]);
  assert.ok(labels(g, 1).some(l => l.startsWith('cast Force of Negation (')));
  g.state.activePlayer = 1;
  assert.ok(!labels(g, 1).some(l => l.startsWith('cast Force of Negation')));
});

test('Solitude evoked: exile a creature, its controller gains life, then Solitude is sacrificed', async () => {
  const g = setup({ bf: ['Grizzly Bears'] }, { hand: ['Solitude', 'Swords to Plowshares'] });
  const ev = legal(g, 1, 'cast Solitude (evoke')!;
  await perform(g, 1, ev);
  await g.resolveStackFully();
  assert.equal(g.state.players[0].exile.some(o => o.def.name === 'Grizzly Bears'), true, 'Bears exiled');
  assert.equal(g.state.players[0].life, 22);
  assert.equal(g.state.players[1].graveyard.some(o => o.def.name === 'Solitude'), true, 'evoked Solitude dies');
  assert.equal(g.state.players[1].exile.some(o => o.def.name === 'Swords to Plowshares'), true, 'pitched card exiled');
});

test('Village Rites: additional cost sacrifices a creature', async () => {
  const g = setup({ bf: ['Swamp', 'Grizzly Bears'], hand: ['Village Rites'] }, {});
  const before = g.state.players[0].hand.length;
  await perform(g, 0, legal(g, 0, 'cast Village Rites')!);
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === 'Grizzly Bears'), true);
  await g.resolveStackFully();
  assert.equal(g.state.players[0].hand.length, before - 1 + 2);
});

test('Thalia taxes noncreature spells; Leyline Binding costs less with domain', () => {
  const g = setup({ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Thalia, Guardian of Thraben'] });
  assert.ok(!labels(g, 0).some(l => l.startsWith('cast Lightning Bolt')), 'one Mountain cannot pay {R} + {1}');
  const g2 = setup({ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Thalia, Guardian of Thraben'] });
  assert.ok(labels(g2, 0).some(l => l.startsWith('cast Lightning Bolt')));
  const g3 = setup({ bf: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'], hand: ['Leyline Binding'] }, { bf: ['Grizzly Bears'] });
  const lb = legal(g3, 0, 'cast Leyline Binding')!; assert.ok(lb);
});

// ---------------------------------------------------------------- as-enters
test('shockland: pay 2 life to enter untapped, or enter tapped', async () => {
  const g = setup({ hand: ['Steam Vents'] }, {});
  await perform(g, 0, legal(g, 0, 'play land Steam Vents')!);
  const v = find(g, 'Steam Vents', 0); assert.equal(v.tapped, false); assert.equal(g.state.players[0].life, 18);
  const s2 = new Script('P0'); s2.queue.push((_s, d) => d.kind === 'yes-no' && d.tag === 'shock' ? false : undefined);
  const g2 = setup({ hand: ['Steam Vents'] }, {}, [s2, new Script('P1')]);
  await perform(g2, 0, legal(g2, 0, 'play land Steam Vents')!);
  assert.equal(find(g2, 'Steam Vents', 0).tapped, true); assert.equal(g2.state.players[0].life, 20);
});

test('fastland and slowland enter tapped by land count; Starting Town by turn number', async () => {
  const g = setup({ bf: ['Plains', 'Island'], hand: ['Seachrome Coast'] }, {});
  await perform(g, 0, legal(g, 0, 'play land Seachrome Coast')!); assert.equal(find(g, 'Seachrome Coast', 0).tapped, false);
  const g2 = setup({ bf: ['Plains', 'Island', 'Plains'], hand: ['Seachrome Coast'] }, {});
  await perform(g2, 0, legal(g2, 0, 'play land Seachrome Coast')!); assert.equal(find(g2, 'Seachrome Coast', 0).tapped, true);
  const g3 = setup({ bf: ['Plains'], hand: ['Deserted Beach'] }, {});
  await perform(g3, 0, legal(g3, 0, 'play land Deserted Beach')!); assert.equal(find(g3, 'Deserted Beach', 0).tapped, true);
  const g4 = setup({ hand: ['Starting Town'] }, {}); g4.state.players[0].turnsTaken = 3;
  await perform(g4, 0, legal(g4, 0, 'play land Starting Town')!); assert.equal(find(g4, 'Starting Town', 0).tapped, false);
  const g5 = setup({ hand: ['Starting Town'] }, {}); g5.state.players[0].turnsTaken = 4;
  await perform(g5, 0, legal(g5, 0, 'play land Starting Town')!); assert.equal(find(g5, 'Starting Town', 0).tapped, true);
});

test('fetchland: pay 1 life, sacrifice, find an Island onto the battlefield', async () => {
  const g = setup({ bf: ['Polluted Delta'], library: ['Island', ...Array(20).fill('Mountain')] }, {});
  const fetch = legal(g, 0, 'Polluted Delta#')!; assert.ok(fetch, labels(g, 0).join(', '));
  await perform(g, 0, fetch);
  await g.resolveStackFully();
  assert.equal(g.state.players[0].life, 19);
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === 'Polluted Delta'), true);
  assert.equal(g.state.players[0].battlefield.some(o => o.def.name === 'Island'), true);
});

test('Ancient Tomb auto-tapped for a spell deals 2 damage', async () => {
  const g = setup({ bf: ['Ancient Tomb', 'Forest'], hand: ['Grizzly Bears'] }, {});
  await perform(g, 0, legal(g, 0, 'cast Grizzly Bears')!);
  assert.equal(g.state.players[0].life, 18);
});

test('Chalice of the Void X=1 counters one-drops', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain'], hand: ['Chalice of the Void'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] });
  const ls = legalActions(g, 0).filter(l => l.label.startsWith('cast Chalice'));
  assert.ok(ls.length >= 2, 'X=0 and X=1 variants');
  const x1 = ls.find(l => l.action.type === 'cast' && l.action.x === 1)!;
  await perform(g, 0, x1); await g.resolveStackFully();
  assert.equal(find(g, 'Chalice of the Void', 0).counters.charge, 1);
  await perform(g, 1, legal(g, 1, 'cast Lightning Bolt')!, [[{ kind: 'player', id: 0 }]]);
  await g.resolveStackFully();
  assert.equal(g.state.players[0].life, 20, 'Bolt was countered by Chalice');
});

test('Walking Ballista enters with X counters; Moonshadow dies to its -1/-1 counters', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Walking Ballista'] }, {});
  const x2 = legalActions(g, 0).find(l => l.label.startsWith('cast Walking Ballista') && l.action.type === 'cast' && l.action.x === 2)!;
  await perform(g, 0, x2); await g.resolveStackFully();
  const b = find(g, 'Walking Ballista', 0); assert.equal(b.counters['+1/+1'], 2); assert.equal(power(g.state, b), 2);
  const g2 = setup({ bf: Array(6).fill('Swamp'), hand: ['Moonshadow'] }, {});
  await perform(g2, 0, legal(g2, 0, 'cast Moonshadow')!); await g2.resolveStackFully();
  const moon = find(g2, 'Moonshadow', 0); assert.equal(moon.counters['-1/-1'], 6); assert.equal(toughness(g2.state, moon), 1);
});

test('Cavern of Souls: choose a creature type on entering', async () => {
  const g = setup({ hand: ['Cavern of Souls', 'Grizzly Bears'] }, {});
  await perform(g, 0, legal(g, 0, 'play land Cavern of Souls')!);
  const c = find(g, 'Cavern of Souls', 0); assert.equal(c.chosen?.creatureType, 'Bear');
  assert.ok(labels(g, 0).some(l => l.startsWith('cast Grizzly Bears')), 'creature spells can use Cavern mana');
});

test('Mox Diamond: discard a land or go to the graveyard', async () => {
  const g = setup({ hand: ['Mox Diamond', 'Forest'] }, {});
  await perform(g, 0, legal(g, 0, 'cast Mox Diamond')!); await g.resolveStackFully();
  assert.equal(zoneOf(g, find(g, 'Mox Diamond', 0)?.id ?? -1), 'battlefield');
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === 'Forest'), true);
  const g2 = setup({ hand: ['Mox Diamond', 'Lightning Bolt'] }, {});
  await perform(g2, 0, legal(g2, 0, 'cast Mox Diamond')!); await g2.resolveStackFully();
  assert.equal(g2.state.players[0].graveyard.some(o => o.def.name === 'Mox Diamond'), true);
});

test("Lion's Eye Diamond: discard hand, sacrifice, three mana", async () => {
  const g = setup({ bf: ["Lion's Eye Diamond"], hand: ['Lightning Bolt', 'Grizzly Bears'] }, {});
  const led = legal(g, 0, "Lion's Eye Diamond#")!; assert.ok(led, labels(g, 0).join(', '));
  await perform(g, 0, led);
  assert.equal(g.state.players[0].hand.length, 0);
  assert.equal(g.state.players[0].manaPool.length, 3);
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === "Lion's Eye Diamond"), true);
});

// ---------------------------------------------------------------- delve / escape / flashback / dredge / rebound
test('Murktide Regent: delve five instants, enters with five counters', async () => {
  const g = setup({ bf: ['Island', 'Island'], hand: ['Murktide Regent'] }, {});
  addTo(g, 0, 'graveyard', ['Lightning Bolt', 'Counterspell', 'Brainstorm', 'Ponder', 'Lightning Bolt']);
  const v = legal(g, 0, 'cast Murktide Regent (delve 5)')!; assert.ok(v, labels(g, 0).join(', '));
  await perform(g, 0, v); await g.resolveStackFully();
  const m = find(g, 'Murktide Regent', 0);
  assert.equal(m.counters['+1/+1'], 5); assert.equal(power(g.state, m), 8);
  assert.equal(g.state.players[0].graveyard.length, 0); assert.equal(g.state.players[0].exile.length, 5);
});

test('Nethergoyf escapes when four card types are in the graveyard', async () => {
  const g = setup({ bf: ['Swamp', 'Swamp', 'Swamp'] }, {});
  addTo(g, 0, 'graveyard', ['Nethergoyf', 'Mountain', 'Grizzly Bears', 'Lightning Bolt']);
  assert.ok(!labels(g, 0).some(l => l.startsWith('cast Nethergoyf')), 'three types: not castable');
  addTo(g, 0, 'graveyard', ['Chalice of the Void']);
  const esc = legal(g, 0, 'cast Nethergoyf (escape')!; assert.ok(esc, labels(g, 0).join(', '));
  await perform(g, 0, esc); await g.resolveStackFully();
  const n = find(g, 'Nethergoyf', 0); assert.equal(n.castWith?.alt, 'escape');
  assert.equal(g.state.players[0].exile.length, 4, 'one card per type exiled');
  assert.equal(g.state.players[0].graveyard.length, 0);
});

test('Faithless Looting flashback from the graveyard exiles it afterwards', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Grizzly Bears', 'Lightning Bolt'] }, {});
  const [fl] = addTo(g, 0, 'graveyard', ['Faithless Looting']);
  const fb = legal(g, 0, 'cast Faithless Looting (flashback')!; assert.ok(fb, labels(g, 0).join(', '));
  await perform(g, 0, fb); await g.resolveStackFully();
  assert.equal(zoneOf(g, fl.id), 'exile');
  assert.equal(g.state.players[0].hand.length, 2);
});

test('Cabal Therapy flashback by sacrificing a creature', async () => {
  const g = setup({ bf: ['Grizzly Bears'] }, { hand: ['Counterspell', 'Counterspell', 'Island'] });
  addTo(g, 0, 'graveyard', ['Cabal Therapy']);
  const fb = legal(g, 0, 'cast Cabal Therapy (flashback')!; assert.ok(fb, labels(g, 0).join(', '));
  await perform(g, 0, fb, [[{ kind: 'player', id: 1 }]]); await g.resolveStackFully();
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === 'Grizzly Bears'), true);
  assert.deepEqual(g.state.players[1].hand.map(o => o.def.name), ['Island']);
});

test('dredge replaces a draw when the player says yes', async () => {
  const s0 = new Script('P0'); s0.queue.push((_s, d) => d.kind === 'yes-no' && d.tag === 'dredge' ? true : undefined);
  const g = setup({}, {}, [s0, new Script('P1')]);
  const [loam] = addTo(g, 0, 'graveyard', ['Life from the Loam']);
  const lib = g.state.players[0].library.length;
  await g.draw(0);
  assert.equal(zoneOf(g, loam.id), 'hand'); assert.equal(g.state.players[0].library.length, lib - 3);
  const g2 = setup({}, {}); addTo(g2, 0, 'graveyard', ['Life from the Loam']); const h = g2.state.players[0].hand.length;
  await g2.draw(0); assert.equal(g2.state.players[0].hand.length, h + 1, 'default agents never dredge');
});

test('rebound: exiled on resolution, castable free during the next upkeep only', async () => {
  const g = setup({ bf: ['Island', 'Grizzly Bears'], hand: ['Distortion Strike'] }, {});
  const [bears] = [find(g, 'Grizzly Bears', 0)];
  await perform(g, 0, legal(g, 0, 'cast Distortion Strike')!, [[{ kind: 'object', id: bears.id }]]); await g.resolveStackFully();
  const ds = g.state.players[0].exile.find(o => o.def.name === 'Distortion Strike')!; assert.ok(ds.castableFromExile?.free);
  g.state.turn += 2; g.state.activePlayer = 0; g.state.step = 'upkeep';
  const again = legal(g, 0, 'cast Distortion Strike (from exile)'); assert.ok(again, labels(g, 0).join(', '));
  g.state.step = 'main1';
  assert.ok(!legal(g, 0, 'cast Distortion Strike'), 'only during the upkeep');
});

// ---------------------------------------------------------------- library manipulation, hand attack, riders
test('Brainstorm draws three and puts two back on top', async () => {
  const g = setup({ bf: ['Island'], hand: ['Brainstorm', 'Grizzly Bears', 'Lightning Bolt'] }, {});
  await perform(g, 0, legal(g, 0, 'cast Brainstorm')!); await g.resolveStackFully();
  const pl = g.state.players[0];
  assert.equal(pl.hand.length, 3);
  assert.ok(pl.library.slice(0, 2).every(o => o.def.name !== 'Mountain'), 'the two put-back cards sit on top');
});

test('Ponder reorders the top three; Impulse takes one of four and bottoms the rest', async () => {
  const g = setup({ bf: ['Island'], hand: ['Ponder'], library: ['Lightning Bolt', 'Grizzly Bears', 'Counterspell', ...Array(20).fill('Mountain')] }, {});
  await perform(g, 0, legal(g, 0, 'cast Ponder')!); await g.resolveStackFully();
  assert.equal(g.state.players[0].hand.length, 1, 'Ponder draws a card');
  const g2 = setup({ bf: ['Island', 'Island'], hand: ['Impulse'], library: ['Lightning Bolt', 'Grizzly Bears', 'Counterspell', 'Island', ...Array(20).fill('Mountain')] }, {});
  const n = g2.state.players[0].library.length;
  await perform(g2, 0, legal(g2, 0, 'cast Impulse')!); await g2.resolveStackFully();
  assert.equal(g2.state.players[0].hand.length, 1); assert.equal(g2.state.players[0].library.length, n - 4 + 3);
  assert.equal(g2.state.players[0].library[0].def.name, 'Mountain', 'the rest went to the bottom');
});

test('Thoughtseize reveals the hand, discards a nonland card, costs 2 life', async () => {
  const g = setup({ bf: ['Swamp'], hand: ['Thoughtseize'] }, { hand: ['Counterspell', 'Island'] });
  await perform(g, 0, legal(g, 0, 'cast Thoughtseize')!, [[{ kind: 'player', id: 1 }]]); await g.resolveStackFully();
  assert.deepEqual(g.state.players[1].hand.map(o => o.def.name), ['Island']);
  assert.equal(g.state.players[0].life, 18);
  assert.ok(g.state.knowledge.knownInHand.includes(g.state.players[1].hand[0].id), 'the revealed Island stays known');
});

test('Swords to Plowshares exiles and its controller gains life equal to its power', async () => {
  const g = setup({ bf: ['Plains'], hand: ['Swords to Plowshares'] }, { bf: ['Serra Angel'] });
  const angel = find(g, 'Serra Angel', 1);
  await perform(g, 0, legal(g, 0, 'cast Swords to Plowshares')!, [[{ kind: 'object', id: angel.id }]]); await g.resolveStackFully();
  assert.equal(zoneOf(g, angel.id), 'exile'); assert.equal(g.state.players[1].life, 24);
});

test('Fatal Push: mana value 2 or less, or 4 or less with revolt', async () => {
  const g = setup({ bf: ['Swamp'], hand: ['Fatal Push'] }, { bf: ['Centaur Courser'] });
  const c = find(g, 'Centaur Courser', 1);
  await perform(g, 0, legal(g, 0, 'cast Fatal Push')!, [[{ kind: 'object', id: c.id }]]); await g.resolveStackFully();
  assert.equal(zoneOf(g, c.id), 'battlefield', 'MV 3 survives without revolt');
  const g2 = setup({ bf: ['Swamp'], hand: ['Fatal Push'] }, { bf: ['Centaur Courser'] });
  g2.state.players[0].permanentsLeftThisTurn = 1;
  const c2 = find(g2, 'Centaur Courser', 1);
  await perform(g2, 0, legal(g2, 0, 'cast Fatal Push')!, [[{ kind: 'object', id: c2.id }]]); await g2.resolveStackFully();
  assert.equal(zoneOf(g2, c2.id), 'graveyard');
});

test('Stifle counters a triggered ability', async () => {
  const g = setup({ bf: ['Island', 'Island', 'Island', 'Island'], hand: ['Divination', 'Stifle'] }, { bf: ['Orcish Bowmasters'] });
  await perform(g, 0, legal(g, 0, 'cast Divination')!);
  await (g as unknown as { resolveTop(): Promise<void> }).resolveTop();
  (g as unknown as { putTriggersOnStack(): void }).putTriggersOnStack();
  assert.equal(g.state.stack.length, 2, 'two Bowmasters triggers on the stack');
  const st = legal(g, 0, 'cast Stifle')!; assert.ok(st, labels(g, 0).join(', '));
  await perform(g, 0, st, [[{ kind: 'stack', id: g.state.stack[1].id }]]);
  await g.resolveStackFully();
  assert.equal(g.state.players[0].life, 19, 'one trigger countered, one resolved');
});

test('Orcish Bowmasters punishes extra draws and amasses', async () => {
  const g = setup({ bf: ['Island', 'Island', 'Island'], hand: ['Divination'] }, { bf: ['Orcish Bowmasters'] });
  await perform(g, 0, legal(g, 0, 'cast Divination')!); await g.resolveStackFully();
  assert.equal(g.state.players[0].life, 18);
  const army = g.state.players[1].battlefield.find(o => o.token?.subtypes.includes('Army'))!;
  assert.ok(army); assert.equal(army.counters['+1/+1'], 2);
});

test("Mishra's Bauble draws at the beginning of the next turn's upkeep", async () => {
  const g = setup({ bf: ["Mishra's Bauble"] }, {});
  await perform(g, 0, legal(g, 0, "Mishra's Bauble#")!, [[{ kind: 'player', id: 1 }]]); await g.resolveStackFully();
  assert.equal(g.state.delayed?.length, 1);
  const h = g.state.players[0].hand.length;
  await g.playTurns(1);
  assert.equal(g.state.players[0].hand.length, h + 1);
  assert.equal(g.state.delayed?.length, 0);
});

test('Burst Lightning kicked deals 4', async () => {
  const g = setup({ bf: Array(5).fill('Mountain'), hand: ['Burst Lightning'] }, {});
  await perform(g, 0, legal(g, 0, 'cast Burst Lightning (kicked)')!, [[{ kind: 'player', id: 1 }]]); await g.resolveStackFully();
  assert.equal(g.state.players[1].life, 16);
});

// ---------------------------------------------------------------- Sagas, crew, MDFC, convoke
test("Urza's Saga gains abilities chapter by chapter and is sacrificed after III", async () => {
  const g = setup({ bf: ['Mountain', 'Mountain'], hand: ["Urza's Saga"] }, {});
  await perform(g, 0, legal(g, 0, "play land Urza's Saga")!); await g.resolveStackFully();
  const saga = find(g, "Urza's Saga", 0);
  assert.equal(saga.counters.lore, 1); assert.equal(saga.grantedAbilities?.length, 1);
  assert.ok(labels(g, 0).length >= 1);
  saga.counters.lore = 2; g.queueTriggers('chapter', { obj: saga, player: 0 }); await g.resolveStackFully();
  assert.equal(saga.grantedAbilities?.length, 2);
  assert.ok(labels(g, 0).some(l => l.includes('Construct')), 'the granted token ability is an action');
  saga.counters.lore = 3; g.queueTriggers('chapter', { obj: saga, player: 0 }); await g.resolveStackFully();
  assert.equal(zoneOf(g, saga.id), 'graveyard', 'sacrificed after the final chapter');
});

test('Crew 1 turns Smuggler\'s Copter into a creature until end of turn', async () => {
  const g = setup({ bf: ["Smuggler's Copter", 'Grizzly Bears'] }, {});
  const copter = find(g, "Smuggler's Copter", 0);
  assert.equal(isCreature(copter), false);
  await perform(g, 0, legal(g, 0, "Smuggler's Copter#")!); await g.resolveStackFully();
  assert.equal(find(g, 'Grizzly Bears', 0).tapped, true);
  assert.equal(isCreature(copter), true); assert.equal(power(g.state, copter), 3); assert.equal(toughness(g.state, copter), 3);
});

test('MDFC: the back face can be played as a land', async () => {
  const g = setup({ hand: ['Sink into Stupor // Soporific Springs'] }, {});
  const l = legal(g, 0, 'play land Soporific Springs')!; assert.ok(l, labels(g, 0).join(', '));
  await perform(g, 0, l);
  const land = g.state.players[0].battlefield[0];
  assert.equal(land.activeFace, 1); assert.equal(land.tapped, false, 'paid 3 life to enter untapped'); assert.equal(g.state.players[0].life, 17);
  assert.ok(labels(g, 0).every(x => !x.startsWith('cast Sink')));
});

test('convoke pays for Siege Wurm with creatures', async () => {
  const g = setup({ bf: ['Forest', 'Forest', 'Forest', 'Grizzly Bears', 'Grizzly Bears', 'Grizzly Bears', 'Grizzly Bears'], hand: ['Siege Wurm'] }, {});
  const v = legal(g, 0, 'cast Siege Wurm (convoke)')!; assert.ok(v, labels(g, 0).join(', '));
  await perform(g, 0, v); await g.resolveStackFully();
  assert.ok(find(g, 'Siege Wurm', 0));
  assert.ok(g.state.players[0].battlefield.filter(o => o.def.name === 'Grizzly Bears').every(o => o.tapped));
});

test('branching stays small with several alternative-cost cards in hand', () => {
  const g = setup({ bf: ['Island', 'Island', 'Mountain'], hand: ['Force of Will', 'Daze', 'Murktide Regent', "Smuggler's Copter", 'Chalice of the Void', 'Counterspell'] }, {});
  addTo(g, 0, 'graveyard', ['Lightning Bolt', 'Ponder']);
  const ls = legalActions(g, 0);
  assert.ok(ls.length <= 14, `${ls.length} actions: ${ls.map(l => l.label).join(', ')}`);
});

test('clone and serialize carry the new fields', async () => {
  const { cloneState } = await import('../src/engine/clone.js');
  const { serializeState, deserializeState, collectDefs } = await import('../src/engine/serialize.js');
  const g = setup({ bf: ['Cavern of Souls'] }, {});
  const c = find(g, 'Cavern of Souls', 0); c.chosen = { creatureType: 'Elf' }; c.castWith = { alt: 'pitch', from: 'hand' }; c.exiledWith = [1, 2]; c.castableFromExile = { afterTurn: 3, free: true }; c.grantedAbilities = [{ kind: 'static', effect: { kind: 'cant-be-countered' }, text: 'x' }];
  g.state.delayed = [{ id: 1, at: 'next-upkeep', controller: 0, sourceId: c.id, sourceName: 'x', effects: [], createdTurn: 5 }];
  const cl = cloneState(g.state); const cc = cl.players[0].battlefield.find(o => o.id === c.id)!;
  assert.deepEqual(cc.chosen, c.chosen); assert.notEqual(cc.exiledWith, c.exiledWith); assert.deepEqual(cc.exiledWith, [1, 2]); assert.equal(cl.delayed?.length, 1);
  const back = deserializeState(JSON.parse(JSON.stringify(serializeState(g.state))), collectDefs(g.state));
  const bc = back.players[0].battlefield.find(o => o.id === c.id)!;
  assert.deepEqual(bc.castWith, c.castWith); assert.deepEqual(bc.castableFromExile, c.castableFromExile); assert.equal(back.delayed?.length, 1);
});

test('impending: Overlord enters as a non-creature with time counters that tick down at end step', async () => {
  const g = setup({ bf: ['Swamp', 'Swamp'], hand: ['Overlord of the Balemurk'] }, {});
  const imp = legal(g, 0, 'cast Overlord of the Balemurk (impending')!; assert.ok(imp, labels(g, 0).join(', '));
  await perform(g, 0, imp); await g.resolveStackFully();
  const o = find(g, 'Overlord of the Balemurk', 0);
  assert.equal(o.counters.time, 5); assert.equal(isCreature(o), false);
  await g.resumeTurn();
  assert.equal(o.counters.time, 4, 'one time counter removed at the end step');
  o.counters.time = 0; delete o.counters.time;
  assert.equal(isCreature(o), true);
});

test('warp: cast for the warp cost, exiled at the end step, castable from exile later', async () => {
  const g = setup({ bf: ['Island', 'Island'], hand: ['Quantum Riddler'] }, {});
  const w = legal(g, 0, 'cast Quantum Riddler (warp')!; assert.ok(w, labels(g, 0).join(', '));
  await perform(g, 0, w); await g.resolveStackFully();
  const r = find(g, 'Quantum Riddler', 0); assert.equal(r.castWith?.alt, 'warp');
  await g.resumeTurn();
  assert.equal(zoneOf(g, r.id), 'exile'); assert.ok(r.castableFromExile && !r.castableFromExile.free);
  g.state.turn += 2; g.state.activePlayer = 0; g.state.step = 'main1'; g.state.stack = [];
  for (const o of g.state.players[0].battlefield) o.tapped = false;
  g.state.players[0].battlefield.push(...[C('Island'), C('Island'), C('Island')].map((d, i) => ({ ...g.state.players[0].library[i], def: d, zone: 'battlefield' as const, tapped: false, enteredTurn: 1, counters: {}, activatedThisTurn: new Set<number>() })));
  assert.ok(legal(g, 0, 'cast Quantum Riddler (from exile)'), labels(g, 0).join(', '));
});

test('Uro: gain life, draw, and put a land from hand onto the battlefield (recursive sentence split)', () => {
  const uro = C("Uro, Titan of Nature's Wrath");
  assert.ok(uro.fullyParsed, uro.unparsed.join(' | '));
});
