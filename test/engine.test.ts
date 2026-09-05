// Engine, parser and AI tests. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardDB } from '../src/cards/db.js';
import { parseCard } from '../src/cards/parse.js';
import { Game } from '../src/engine/game.js';
import { legalActions } from '../src/engine/legal.js';
import { findObject, power, toughness, hasKeyword } from '../src/engine/characteristics.js';
import { AiAgent, evaluate } from '../src/ai/ai.js';
import type { Agent, Decision, GameState, PlayerId, GameObject } from '../src/engine/state.js';
import type { CardDef } from '../src/cards/types.js';

const db = new CardDB();
const C = (n: string): CardDef => { const d = db.get(n); if (!d) throw new Error('missing card ' + n); return d; };

/** A scripted agent: passes priority unless a script says otherwise; blocks/attacks per script. */
class Script implements Agent {
  name: string; queue: ((s: GameState, d: Decision) => unknown)[] = [];
  constructor(name: string) { this.name = name; }
  async decide(s: GameState, _me: PlayerId, d: Decision): Promise<unknown> {
    if (this.queue.length) { const f = this.queue[0]; const r = f(s, d); if (r !== undefined) { this.queue.shift(); return r; } }
    switch (d.kind) {
      case 'priority': return { type: 'pass' };
      case 'attackers': return { attackers: d.mustAttack };
      case 'blockers': return { blocks: [] };
      case 'choose-cards': return d.from.slice(0, d.count);
      case 'yes-no': return !d.prompt.startsWith('Mulligan');
      case 'choose-mode': return [0];
      case 'choose-color': return 'R';
      case 'order-blockers': return d.blockers;
    }
  }
}

/** Build a game with a prepared battlefield/hand for quick scenario tests. */
function setup(p0: { bf?: string[]; hand?: string[]; life?: number }, p1: { bf?: string[]; hand?: string[]; life?: number }, agents?: [Agent, Agent]) {
  const filler = Array(30).fill(C('Mountain'));
  const a: [Agent, Agent] = agents ?? [new Script('P0'), new Script('P1')];
  const g = new Game([filler, filler], a, { seed: 1, quiet: true, mulligans: false });
  const s = g.state;
  s.turn = 5; s.activePlayer = 0; s.step = 'main1';
  const put = (pid: PlayerId, cfg: { bf?: string[]; hand?: string[]; life?: number }) => {
    const pl = s.players[pid];
    pl.life = cfg.life ?? 20;
    for (const n of cfg.bf ?? []) { const o = { ...pl.library.pop()!, def: C(n) } as GameObject; o.zone = 'battlefield'; o.enteredTurn = 1; o.controller = pid; o.owner = pid; o.counters = {}; pl.battlefield.push(o); }
    for (const n of cfg.hand ?? []) { const o = { ...pl.library.pop()!, def: C(n) } as GameObject; o.zone = 'hand'; o.owner = pid; o.controller = pid; pl.hand.push(o); }
  };
  put(0, p0); put(1, p1);
  return g;
}
const find = (g: Game, n: string, pid?: PlayerId) => [...(pid == null ? [...g.state.players[0].battlefield, ...g.state.players[1].battlefield] : g.state.players[pid].battlefield)].find(o => o.def.name === n)!;
const inHand = (g: Game, n: string, pid: PlayerId) => g.state.players[pid].hand.find(o => o.def.name === n)!;

// ---------------------------------------------------------------- parser
test('parser: Lightning Bolt is a 3-damage any-target spell', () => {
  const d = C('Lightning Bolt');
  assert.equal(d.fullyParsed, true);
  assert.deepEqual(d.abilities[0], { kind: 'spell', effects: [{ op: 'damage', amount: 3, target: { kind: 'any' } }], text: 'Lightning Bolt deals 3 damage to any target.' });
});
test('parser: keywords, P/T and mana cost of Serra Angel', () => {
  const d = C('Serra Angel');
  assert.deepEqual(d.keywords.sort(), ['flying', 'vigilance']);
  assert.equal(d.power, '4'); assert.equal(d.toughness, '4'); assert.equal(d.manaValue, 5);
  assert.deepEqual(d.manaCost!.pips, ['W', 'W']); assert.equal(d.manaCost!.generic, 3);
});
test('parser: Counterspell targets a spell; Mana Leak has an unless-pay clause', () => {
  const cs = C('Counterspell'); assert.deepEqual(cs.abilities[0], { kind: 'spell', effects: [{ op: 'counter', target: { kind: 'spell' } }], text: 'Counter target spell.' });
  const ml = C('Mana Leak'); const e = (ml.abilities[0] as { effects: { op: string; unlessPay?: number }[] }).effects[0]; assert.equal(e.op, 'counter'); assert.equal(e.unlessPay, 3);
});
test('parser: triggered ETB ability (Cloudkin Seer) and static anthem (Glorious Anthem)', () => {
  const seer = C('Cloudkin Seer'); const t = seer.abilities.find(a => a.kind === 'triggered')!; assert.equal(t.kind, 'triggered'); assert.deepEqual((t as { event: unknown }).event, { on: 'etb', self: true }); assert.deepEqual((t as { effects: unknown }).effects, [{ op: 'draw', amount: 1, who: 'you' }]);
  const anthem = C('Glorious Anthem'); assert.deepEqual((anthem.abilities[0] as { effect: unknown }).effect, { kind: 'anthem', power: 1, toughness: 1, filter: { types: ['Creature'] }, scope: 'you-control', keywords: [] });
});
test('parser: basic lands get an intrinsic mana ability; Llanowar Elves has a mana ability', () => {
  assert.deepEqual(C('Forest').producesMana, ['G']); assert.equal(C('Forest').abilities.length, 1);
  const elf = C('Llanowar Elves'); assert.equal(elf.abilities[0].kind, 'activated'); assert.equal((elf.abilities[0] as { manaAbility?: boolean }).manaAbility, true);
});
test('parser: unknown text marks the card partially parsed but never crashes', () => {
  const d = parseCard({ name: 'Weird', oracle_id: 'x', mana_cost: '{1}', mana_value: 1, colors: [], color_identity: [], types: ['Creature'], supertypes: [], subtypes: [], type_line: 'Creature', oracle_text: 'Flying\nWhenever a Weird phases out, you win the game.', power: '1', toughness: '1', loyalty: null, keywords: [], layout: 'normal' });
  assert.equal(d.fullyParsed, false); assert.deepEqual(d.keywords, ['flying']); assert.equal(d.unparsed.length, 1);
});
test('parser: modal spell modes are collected across lines', () => {
  const d = parseCard({ name: 'Modal', oracle_id: 'y', mana_cost: '{R}', mana_value: 1, colors: ['R'], color_identity: ['R'], types: ['Instant'], supertypes: [], subtypes: [], type_line: 'Instant', oracle_text: 'Choose one —\n• Modal deals 2 damage to any target.\n• Destroy target artifact.', power: null, toughness: null, loyalty: null, keywords: [], layout: 'normal' });
  const eff = (d.abilities[0] as { effects: { op: string; modes?: unknown[] }[] }).effects[0];
  assert.equal(eff.op, 'choose-mode'); assert.equal(eff.modes!.length, 2); assert.equal(d.fullyParsed, true);
});

// ---------------------------------------------------------------- engine
test('engine: casting Lightning Bolt at a creature destroys it via state-based actions', async () => {
  const g = setup({ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] });
  const bolt = inHand(g, 'Lightning Bolt', 0), bears = find(g, 'Grizzly Bears');
  const legal = legalActions(g, 0);
  assert.ok(legal.some(l => l.label === 'cast Lightning Bolt'));
  assert.ok(await g.performAction(0, { type: 'cast', cardId: bolt.id, targets: [[{ kind: 'object', id: bears.id }]] }));
  await g.resolveStackFully();
  assert.equal(bears.zone, 'graveyard'); assert.equal(g.state.players[1].graveyard.includes(bears), true);
  assert.equal(find(g, 'Mountain', 0).tapped, true);
});
test('engine: a spell fizzles when its only target becomes illegal', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Grizzly Bears'] });
  const bears = find(g, 'Grizzly Bears');
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Lightning Bolt', 0).id, targets: [[{ kind: 'object', id: bears.id }]] });
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Shock', 0).id, targets: [[{ kind: 'object', id: bears.id }]] });
  await g.resolveStackFully();
  assert.ok(g.state.log.some(l => l.includes('fizzles')));
});
test('engine: Counterspell counters a creature spell', async () => {
  const g = setup({ bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }, { bf: ['Island', 'Island'], hand: ['Counterspell'] });
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Grizzly Bears', 0).id });
  const spell = g.state.stack[0];
  assert.ok(await g.performAction(1, { type: 'cast', cardId: inHand(g, 'Counterspell', 1).id, targets: [[{ kind: 'stack', id: spell.id }]] }));
  await g.resolveStackFully();
  assert.equal(g.state.players[0].battlefield.some(o => o.def.name === 'Grizzly Bears'), false);
  assert.equal(g.state.players[0].graveyard.some(o => o.def.name === 'Grizzly Bears'), true);
});
test('engine: combat with trample, deathtouch, first strike and lifelink', async () => {
  const g = setup({ bf: ['Leatherback Baloth', 'Kalonian Tusker'] }, { bf: ['Grizzly Bears', 'Vampire Nighthawk'], life: 20 });
  const baloth = find(g, 'Leatherback Baloth'), tusker = find(g, 'Kalonian Tusker'), bears = find(g, 'Grizzly Bears'), hawk = find(g, 'Vampire Nighthawk');
  baloth.eotKeywords.push('trample'); tusker.eotKeywords.push('first strike');
  await g.simulateCombat([baloth.id, tusker.id], [{ blocker: bears.id, attacker: baloth.id }, { blocker: hawk.id, attacker: tusker.id }]);
  // Baloth 4/5 trample blocked by 2/2: 2 to bears, 2 tramples over
  assert.equal(bears.zone, 'graveyard'); assert.equal(g.state.players[1].life, 18);
  // Tusker 3/3 first strike kills the 2/3 Nighthawk before it deals deathtouch damage
  assert.equal(hawk.zone, 'graveyard'); assert.equal(tusker.zone, 'battlefield');
});
test('engine: deathtouch blocker kills a bigger attacker, lifelink gains life', async () => {
  const g = setup({ bf: ['Leatherback Baloth'] }, { bf: ['Vampire Nighthawk'], life: 20 });
  const baloth = find(g, 'Leatherback Baloth'), hawk = find(g, 'Vampire Nighthawk');
  await g.simulateCombat([baloth.id], [{ blocker: hawk.id, attacker: baloth.id }]);
  assert.equal(baloth.zone, 'graveyard'); assert.equal(hawk.zone, 'graveyard'); assert.equal(g.state.players[1].life, 22);
});
test('engine: flying creatures cannot be blocked by ground creatures', async () => {
  const g = setup({ bf: ['Serra Angel'] }, { bf: ['Grizzly Bears'] });
  const angel = find(g, 'Serra Angel'), bears = find(g, 'Grizzly Bears');
  const { canBlock } = await import('../src/engine/characteristics.js');
  assert.equal(canBlock(g.state, bears, angel), false);
});
test('engine: anthem and aura modify power/toughness; aura falls off when host dies', async () => {
  const g = setup({ bf: ['Glorious Anthem', 'Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Plains', 'Plains', 'Grizzly Bears'], hand: ['Pacifism'] });
  const myBears = find(g, 'Grizzly Bears', 0);
  assert.equal(power(g.state, myBears), 3); assert.equal(toughness(g.state, myBears), 3);
  const theirBears = find(g, 'Grizzly Bears', 1);
  g.state.activePlayer = 1;
  assert.ok(await g.performAction(1, { type: 'cast', cardId: inHand(g, 'Pacifism', 1).id, targets: [[{ kind: 'object', id: myBears.id }]] }));
  await g.resolveStackFully();
  const pac = find(g, 'Pacifism', 1); assert.equal(pac.attachedTo, myBears.id);
  const { canAttack } = await import('../src/engine/characteristics.js');
  assert.equal(canAttack(g.state, myBears), false);
  g.state.activePlayer = 0;
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Lightning Bolt', 0).id, targets: [[{ kind: 'object', id: myBears.id }]] });
  await g.resolveStackFully();
  assert.equal(myBears.zone, 'graveyard'); assert.equal(pac.zone, 'graveyard');
  void theirBears;
});
test('engine: ETB trigger draws a card; summoning sickness prevents attacking', async () => {
  const g = setup({ bf: ['Island', 'Island', 'Island'], hand: ['Cloudkin Seer'] }, {});
  const before = g.state.players[0].hand.length;
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Cloudkin Seer', 0).id });
  await g.resolveStackFully();
  assert.equal(g.state.players[0].hand.length, before); // -1 cast +1 drawn
  const { canAttack } = await import('../src/engine/characteristics.js');
  assert.equal(canAttack(g.state, find(g, 'Cloudkin Seer', 0)), false);
});
test('engine: mana payment taps only the lands needed and handles colour requirements', async () => {
  const g = setup({ bf: ['Island', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains'], hand: ['Serra Angel'] }, {});
  assert.ok(await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Serra Angel', 0).id }));
  const tapped = g.state.players[0].battlefield.filter(o => o.tapped).map(o => o.def.name).sort();
  assert.equal(tapped.length, 5); assert.ok(tapped.filter(n => n === 'Plains').length >= 2);
});
test('engine: legend rule and 0-toughness SBA', async () => {
  const g = setup({ bf: ['Lyra Dawnbringer', 'Lyra Dawnbringer', 'Grizzly Bears'] }, {});
  g.checkSBA();
  assert.equal(g.state.players[0].battlefield.filter(o => o.def.name === 'Lyra Dawnbringer').length, 1);
  const bears = find(g, 'Grizzly Bears', 0); bears.eotToughness = -2; g.checkSBA();
  assert.equal(bears.zone, 'graveyard');
});
test('engine: full AI vs AI game finishes with a winner and no exceptions', async () => {
  const red = db, list = (await import('../src/cards/db.js'));
  const fs = await import('node:fs');
  const d1 = list.loadDeck(red, list.parseDeckList(fs.readFileSync('decks/mono-red-burn.txt', 'utf8'))).cards;
  const d2 = list.loadDeck(red, list.parseDeckList(fs.readFileSync('decks/mono-green-stompy.txt', 'utf8'))).cards;
  const a = new AiAgent({ name: 'A', verbose: false }), b = new AiAgent({ name: 'B', verbose: false });
  const g = new Game([d1, d2], [a, b], { seed: 3, quiet: true, maxTurns: 60 });
  a.attach(g); b.attach(g);
  const w = await g.play();
  assert.ok(w === 0 || w === 1 || w === null);
  assert.ok(g.state.log.filter(l => l.includes('casts')).length > 5, 'AI should cast spells');
});

// ---------------------------------------------------------------- AI
test('AI: blocks to prevent lethal damage', async () => {
  const ai = new AiAgent({ name: 'AI', verbose: false });
  const g = setup({ bf: ['Leatherback Baloth', 'Kalonian Tusker'] }, { bf: ['Grizzly Bears'], life: 6 }, [new Script('P0'), ai]);
  ai.attach(g);
  const baloth = find(g, 'Leatherback Baloth'), tusker = find(g, 'Kalonian Tusker'), bears = find(g, 'Grizzly Bears');
  g.state.step = 'declare-blockers';
  baloth.attacking = 1; tusker.attacking = 1; g.state.attackers = [baloth.id, tusker.id];
  const decl = await ai.decide(g.state, 1, { kind: 'blockers', attackers: [baloth.id, tusker.id], candidates: [bears.id] }) as { blocks: { blocker: number; attacker: number }[] };
  assert.equal(decl.blocks.length, 1); assert.equal(decl.blocks[0].attacker, baloth.id, 'should chump the 4-power attacker');
});
test('AI: counters a big threat with Counterspell in response', async () => {
  const ai = new AiAgent({ name: 'AI', verbose: false });
  const g = setup({ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Leatherback Baloth'] }, { bf: ['Island', 'Island'], hand: ['Counterspell'] }, [new Script('P0'), ai]);
  ai.attach(g);
  await g.performAction(0, { type: 'cast', cardId: inHand(g, 'Leatherback Baloth', 0).id });
  g.state.priority = 1;
  const action = await ai.decide(g.state, 1, { kind: 'priority', legal: legalActions(g, 1) }) as { type: string };
  assert.equal(action.type, 'cast');
  assert.match(ai.lastReason, /responds to Leatherback Baloth with cast Counterspell/);
});
test('AI: burns face for lethal instead of killing a creature', async () => {
  const ai = new AiAgent({ name: 'AI', verbose: false });
  const g = setup({ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'], life: 3 }, [ai, new Script('P1')]);
  ai.attach(g);
  const action = await ai.decide(g.state, 0, { kind: 'priority', legal: legalActions(g, 0) }) as { type: string; targets?: { kind: string; id: number }[][] };
  assert.equal(action.type, 'cast'); assert.deepEqual(action.targets, [[{ kind: 'player', id: 1 }]]);
});
test('AI: evaluation prefers more life and bigger board', () => {
  const g = setup({ bf: ['Grizzly Bears'], life: 20 }, { life: 10 });
  assert.ok(evaluate(g.state, 0) > evaluate(g.state, 1));
  assert.ok(hasKeyword(g.state, find(g, 'Grizzly Bears'), 'flying') === false);
  assert.ok(findObject(g.state, find(g, 'Grizzly Bears').id));
});

// ---- Phase 8x: defects the game fuzzer and the reviewers found
test('engine: simulateCombat refuses a lone blocker against menace', async () => {
  // CR 702.110b. The simulation path used to accept a block the real declare-blockers step drops, so a search could
  // "prove" a menace attacker was stopped by one creature and then watch the damage land in the real game.
  const g = setup({ bf: ['Goblin Trailblazer'] }, { bf: ['Grizzly Bears'], life: 20 });
  const goblin = find(g, 'Goblin Trailblazer'), bears = find(g, 'Grizzly Bears');
  await g.simulateCombat([goblin.id], [{ blocker: bears.id, attacker: goblin.id }]);
  assert.equal(g.state.players[1].life, 18, 'the block is dropped, so the 2/1 connects');
  assert.equal(goblin.zone, 'battlefield'); assert.equal(bears.zone, 'battlefield');
});
test('engine: simulateCombat accepts two blockers against menace', async () => {
  const g = setup({ bf: ['Goblin Trailblazer'] }, { bf: ['Grizzly Bears', 'Runeclaw Bear'], life: 20 });
  const goblin = find(g, 'Goblin Trailblazer'), bears = find(g, 'Grizzly Bears'), claw = find(g, 'Runeclaw Bear');
  await g.simulateCombat([goblin.id], [{ blocker: bears.id, attacker: goblin.id }, { blocker: claw.id, attacker: goblin.id }]);
  assert.equal(g.state.players[1].life, 20); assert.equal(goblin.zone, 'graveyard');
});
test('engine: a static filtered by a keyword it can grant does not recurse', () => {
  // CR 613.8. Windstorm Drake pumps "other creatures you control with flying": computing any creature's static mods
  // asked for that creature's keywords, which asked for its static mods, until the stack blew (fuzz bucket a909b8b2).
  const g = setup({ bf: ['Windstorm Drake', 'Wind Drake', 'Grizzly Bears'] }, {});
  const drake = find(g, 'Windstorm Drake'), wind = find(g, 'Wind Drake'), bears = find(g, 'Grizzly Bears');
  assert.equal(hasKeyword(g.state, drake, 'flying'), true);
  assert.equal(power(g.state, drake), 3, 'other-you-control: the Drake does not pump itself');
  assert.equal(power(g.state, wind), 3, 'the 2/2 flier gets +1/+0');
  assert.equal(power(g.state, bears), 2, 'no flying, no pump');
  assert.equal(toughness(g.state, wind), 2);
});

// ---- Phase 8x review fixes
test('AI: ranks a land it may play from outside the hand (fuzz bucket 3492eb01)', async () => {
  // The same defect the rollout policy had, in the copy of the land ranking that plays the real games: Ramunap
  // Excavator hands out a `play-land` whose card is in the graveyard, and the hand-only lookup threw on `.def`.
  // One candidate is enough here — `score` is called for the reasoning trace, not only from a sort comparator.
  const g = setup({ bf: ['Ramunap Excavator', 'Forest'], hand: ['Mountain'] }, {});
  g.moveTo(inHand(g, 'Mountain', 0), 'graveyard');
  g.state.priority = 0;
  const legal = legalActions(g, 0);
  const lands = legal.filter(l => l.action.type === 'play-land');
  assert.equal(lands.length, 1, 'only the Mountain in the graveyard');
  const action = await new AiAgent({ verbose: false, maxSims: 1 }).decide(g.state, 0, { kind: 'priority', legal }) as { type: string; cardId?: number };
  assert.equal(action.type, 'play-land');
  assert.equal(action.cardId, (lands[0].action as { cardId: number }).cardId);
});
test('engine: an anthem sees a keyword another static granted (CR 613.8)', () => {
  // Layer 6 before layer 7c: Flight's granted flying is decidable without the anthem, so "creatures you control with
  // flying get +1/+1" must see it. The re-entrancy guard used to answer the nested read with printed characteristics,
  // which dropped the grant and left the creature at its printed 2/2.
  const g = setup({ bf: ['Favorable Winds', 'Flight', 'Grizzly Bears'] }, {});
  const bears = find(g, 'Grizzly Bears'); find(g, 'Flight').attachedTo = bears.id;
  assert.equal(hasKeyword(g.state, bears, 'flying'), true);
  assert.equal(power(g.state, bears), 3, 'the aura-granted flier is pumped like a printed one');
  assert.equal(toughness(g.state, bears), 3);
  // control: a printed flier and a keyword counter already answered 3/3, and they still do
  const printed = setup({ bf: ['Favorable Winds', 'Wind Drake'] }, {});
  assert.equal(power(printed.state, find(printed, 'Wind Drake')), 3);
  const counter = setup({ bf: ['Favorable Winds', 'Grizzly Bears'] }, {});
  find(counter, 'Grizzly Bears').counters['flying'] = 1;
  assert.equal(power(counter.state, find(counter, 'Grizzly Bears')), 3);
});
test('engine: a granted keyword is seen whichever characteristic is asked for first', () => {
  // Levitation grants flying to every creature its controller has; Windstorm Drake pumps the ones with flying. The
  // answer must not depend on which read populated the memo table first.
  for (const kwFirst of [true, false]) {
    const g = setup({ bf: ['Levitation', 'Windstorm Drake', 'Grizzly Bears'] }, {});
    const bears = find(g, 'Grizzly Bears');
    if (kwFirst) assert.equal(hasKeyword(g.state, bears, 'flying'), true);
    assert.equal(power(g.state, bears), 3, `power asked ${kwFirst ? 'second' : 'first'}`);
    assert.equal(hasKeyword(g.state, bears, 'flying'), true);
  }
});
test('engine: simulateCombat refuses a blocker the defending player does not control (CR 509.1a)', async () => {
  // `blockLegal` is the whole rules step only if it carries the controller restriction too: the real step gets it
  // from the zones it draws its lists out of, but simulateCombat is handed arbitrary ids and used to accept a
  // creature of the *attacking* player as a blocker, which then absorbed the attack and died.
  const g = setup({ bf: ['Runeclaw Bear', 'Grizzly Bears'] }, { bf: [], life: 20 });
  const rune = find(g, 'Runeclaw Bear'), griz = find(g, 'Grizzly Bears');
  await g.simulateCombat([rune.id], [{ blocker: griz.id, attacker: rune.id }]);
  assert.equal(g.state.players[1].life, 18, 'the illegal block is dropped, so the 2/2 connects');
  assert.equal(griz.zone, 'battlefield');
  // control: the defending player's own creature still blocks
  const ok = setup({ bf: ['Runeclaw Bear'] }, { bf: ['Grizzly Bears'], life: 20 });
  await ok.simulateCombat([find(ok, 'Runeclaw Bear').id], [{ blocker: find(ok, 'Grizzly Bears').id, attacker: find(ok, 'Runeclaw Bear').id }]);
  assert.equal(ok.state.players[1].life, 20);
});
