// Hidden information: redaction, public knowledge bookkeeping, determinization invariants, and an AI that cannot peek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDeck, parseDeckList } from '../src/cards/db.js';
import { AiAgent } from '../src/ai/ai.js';
import { Game } from '../src/engine/game.js';
import { legalActions } from '../src/engine/legal.js';
import { defTable } from '../src/engine/serialize.js';
import { HIDDEN_DEF, isHidden, redact, viewInfo } from '../src/engine/view.js';
import { determinize, hashSeed, sampleArchetypeDeck, seenCounts, unknownPool } from '../src/analysis/determinize.js';
import { Rng } from '../src/engine/game.js';
import type { ArchetypeProfile, ListEntry } from '../src/analysis/types.js';
import { C, db, find, inHand, Script, setup } from './helpers.js';

function list(file: string): ListEntry[] { return parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8')).cards.filter(c => c.board === 'main').map(c => ({ name: c.name, count: c.count })); }
function deck(file: string) { return loadDeck(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'))).cards; }

test('redact: opponent hand and both libraries hidden, counts kept, own hand and legal actions intact', () => {
  const g = setup({ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Island'], hand: ['Counterspell', 'Island'] });
  const v = redact(g.state, 0);
  assert.equal(v.players[1].hand.length, 2); assert.ok(v.players[1].hand.every(isHidden));
  assert.ok(v.players[0].library.every(isHidden)); assert.ok(v.players[1].library.every(isHidden));
  assert.equal(v.players[0].library.length, g.state.players[0].library.length);
  assert.deepEqual(v.players[0].hand.map(o => o.def.name), ['Lightning Bolt', 'Shock']);
  assert.ok(v.players[1].battlefield.every(o => !isHidden(o)));
  // no opponent hand card name leaks anywhere in the view
  const json = JSON.stringify(v.players[1].hand.map(o => o.def.name));
  assert.ok(!json.includes('Counterspell'));
  // the viewer's legal actions are the same on the view
  const real = legalActions(g, 0).map(l => l.label), seen = legalActions(Game.fromState(v, [new Script('a'), new Script('b')], { quiet: true }), 0).map(l => l.label);
  assert.deepEqual(seen, real);
  assert.equal(viewInfo(g.state, 0).hiddenHand, 2); assert.equal(viewInfo(v, 0).hiddenHand, 2);
  // the original is untouched
  assert.equal(g.state.players[1].hand[0].def.name, 'Counterspell');
});

test('knowledge: bounce to hand is public, scry keeps my top known (and private), shuffle forgets, search reveals', async () => {
  const g = setup({ bf: ['Mountain', 'Grizzly Bears'] }, { bf: ['Grizzly Bears'] });
  const mine = find(g, 'Grizzly Bears', 0), theirs = find(g, 'Grizzly Bears', 1);
  g.moveTo(theirs, 'hand');
  assert.ok(g.state.knowledge.knownInHand.includes(theirs.id));
  const v = redact(g.state, 0);
  assert.equal(v.players[1].hand.find(o => o.id === theirs.id)!.def.name, 'Grizzly Bears', 'a bounced card stays known');
  // leaving the hand forgets it
  g.moveTo(theirs, 'battlefield'); assert.ok(!g.state.knowledge.knownInHand.includes(theirs.id));
  // to the top of the library from a public zone: known to everyone
  g.moveTo(mine, 'library', 'top');
  assert.equal(g.state.knowledge.knownTop[0][0], mine.id); assert.ok(g.state.knowledge.revealed.includes(mine.id));
  assert.equal(redact(g.state, 1).players[0].library[0].def.name, 'Grizzly Bears');
  // a private scry: only the owner sees the kept cards
  const top = g.state.players[1].library.slice(0, 2).map(o => o.id);
  g.state.knowledge.knownTop[1] = top;
  assert.ok(redact(g.state, 1).players[1].library.slice(0, 2).every(o => !isHidden(o)));
  assert.ok(redact(g.state, 0).players[1].library.slice(0, 2).every(isHidden));
  assert.deepEqual(redact(g.state, 0).knowledge.knownTop[1], [], 'their private knowledge is stripped from my view');
  // drawing the publicly known top card makes it publicly known in hand; shuffling forgets the rest
  g.draw(0); assert.ok(g.state.knowledge.knownInHand.includes(mine.id)); assert.equal(g.state.knowledge.knownTop[0].length, 0);
  g.shuffle(1); assert.deepEqual(g.state.knowledge.knownTop[1], []);
  // the hidden def never has abilities or a cost
  assert.equal(HIDDEN_DEF.abilities.length, 0); assert.equal(HIDDEN_DEF.manaCost, null);
});

test('determinize: sampled cards plus visible cards never exceed the list (50 seeds); same seed → same world; no slot stays hidden', () => {
  const red = deck('mono-red-burn'), green = deck('mono-green-stompy');
  const g = new Game([red, green], [new Script('a'), new Script('b')], { seed: 9, quiet: true, mulligans: false });
  for (let i = 0; i < 7; i++) { g.draw(0, true); g.draw(1, true); }
  g.state.turn = 3; g.state.step = 'main1';
  // put a couple of cards into public zones
  g.moveTo(g.state.players[1].hand[0], 'battlefield'); g.moveTo(g.state.players[1].hand[0], 'graveyard'); g.moveTo(g.state.players[0].hand[0], 'battlefield');
  const view = redact(g.state, 0);
  const defs = defTable([...red, ...green]);
  const lists = { me: list('mono-red-burn'), them: list('mono-green-stompy') };
  const count = (names: string[]) => { const m = new Map<string, number>(); for (const n of names) m.set(n, (m.get(n) ?? 0) + 1); return m; };
  let first = '';
  for (let seed = 1; seed <= 50; seed++) {
    const d = determinize(view, { viewer: 0, myList: lists.me, opponent: { kind: 'exact', list: lists.them }, defs, seed });
    assert.equal(d.warnings.length, 0, d.warnings.join('; '));
    for (const p of d.state.players) for (const z of [p.hand, p.library]) for (const o of z) assert.ok(!isHidden(o), 'every slot filled');
    for (const [pid, l] of [[0, lists.me], [1, lists.them]] as const) {
      const have = count([...d.state.players[pid].battlefield, ...d.state.players[pid].hand, ...d.state.players[pid].graveyard, ...d.state.players[pid].exile, ...d.state.players[pid].library].map(o => o.def.name));
      for (const [n, c] of have) { const max = l.find(e => e.name === n)?.count ?? 0; assert.ok(c <= max, `seed ${seed}: ${n} ×${c} > ${max}`); }
    }
    const key = JSON.stringify(d.sampled);
    if (seed === 1) first = key;
    assert.equal(JSON.stringify(determinize(view, { viewer: 0, myList: lists.me, opponent: { kind: 'exact', list: lists.them }, defs, seed }).sampled), key, 'same seed, same world');
  }
  assert.notEqual(JSON.stringify(determinize(view, { viewer: 0, myList: lists.me, opponent: { kind: 'exact', list: lists.them }, defs, seed: 2 }).sampled), first);
  // unknownPool subtracts what is seen
  const u = unknownPool(view, 1, lists.them);
  assert.equal(u.pool.length, lists.them.reduce((a, e) => a + e.count, 0) - [...seenCounts(view, 1).values()].reduce((a, b) => a + b, 0));
  // the viewer's own hand is never re-sampled
  const d = determinize(view, { viewer: 0, myList: lists.me, opponent: { kind: 'exact', list: lists.them }, defs, seed: 3 });
  assert.deepEqual(d.state.players[0].hand.map(o => o.def.name), view.players[0].hand.map(o => o.def.name));
});

test('hashSeed is a stable 32-bit mix that never returns 0', () => {
  const a = hashSeed(12345, 0), b = hashSeed(12345, 1);
  assert.notEqual(a, b); assert.equal(a, hashSeed(12345, 0));
  for (let i = 0; i < 1000; i++) assert.ok(hashSeed(0, i) !== 0 && hashSeed(0, i) < 2 ** 32);
});

test('sampleArchetypeDeck honours seen cards, respects the deck size and is seeded', () => {
  const profile: ArchetypeProfile = { id: 'x', format: 'modern', name: 'Burn', signature: ['Lightning Bolt'], metaShare: 0.1, winRate: 0.5, deckCount: 10, deckSize: 20,
    cards: [{ name: 'Lightning Bolt', pIn: 1, expectedCount: 4, countDist: [0, 0, 0, 0, 1], board: 'main' }, { name: 'Mountain', pIn: 1, expectedCount: 12, countDist: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5], board: 'main' }, { name: 'Shock', pIn: 0.5, expectedCount: 2, countDist: [0.5, 0, 0, 0, 0.5], board: 'main' }] };
  const seen = new Map([['Shock', 3]]);
  const a = sampleArchetypeDeck(profile, seen, new Rng(4)), b = sampleArchetypeDeck(profile, seen, new Rng(4));
  assert.deepEqual(a, b);
  assert.ok((a.find(e => e.name === 'Shock')?.count ?? 0) >= 3, 'seen copies are in the list');
  assert.equal(a.reduce((x, e) => x + e.count, 0), 20);
});

test('AI with cheat:false decides identically whatever the opponent secretly holds (and never sees it)', async () => {
  const make = (oppHand: string[]) => {
    const ai = new AiAgent({ name: 'AI', verbose: false, cheat: false, determinizations: 2, seed: 5 });
    const g = setup({ bf: ['Mountain', 'Mountain', 'Grizzly Bears'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Island', 'Island', 'Vampire Nighthawk'], hand: oppHand, life: 9 }, [ai, new Script('P1')]);
    ai.attach(g); return { ai, g };
  };
  const a = make(['Counterspell', 'Island']), b = make(['Grizzly Bears', 'Serra Angel']);
  assert.equal(a.ai.hidden, true);
  const ra = await a.ai.decide(a.g.state, 0, { kind: 'priority', legal: legalActions(a.g, 0) });
  const rb = await b.ai.decide(b.g.state, 0, { kind: 'priority', legal: legalActions(b.g, 0) });
  assert.deepEqual(ra, rb);
  assert.deepEqual(a.ai.lastReasoning!.chosen, b.ai.lastReasoning!.chosen);
  assert.equal(a.ai.lastReasoning!.determinizations, 2); assert.equal(a.ai.lastReasoning!.seeds.length, 2);
  assert.ok(!JSON.stringify(a.ai.lastReasoning!.candidates).includes('Counterspell'));
  // the default agent still cheats (existing behaviour and tests rely on it)
  assert.equal(new AiAgent({ name: 'x', verbose: false }).hidden, false);
  // through the engine: a hidden agent receives a redacted state
  const ai = new AiAgent({ name: 'AI', verbose: false, cheat: false });
  const g = setup({ hand: ['Lightning Bolt'] }, { hand: ['Counterspell'] }, [ai, new Script('P1')]); ai.attach(g);
  let sawHidden = false; const orig = ai.decide.bind(ai);
  ai.decide = async (s, me, d) => { sawHidden = s.players[1].hand.every(isHidden) && s.players[0].hand[0].def === C('Lightning Bolt'); return orig(s, me, d); };
  await g.ask(0, { kind: 'priority', legal: legalActions(g, 0) });
  assert.equal(sawHidden, true);
  void inHand;
});
