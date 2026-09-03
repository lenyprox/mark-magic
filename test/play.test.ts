// Play runtime: deck payloads, redacted views, and a game driven through the DeferredAgent protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDeckList } from '../src/cards/db.js';
import { buildDeckPayload, expandPayload } from '../src/play/payload.js';
import { buildView } from '../src/play/view.js';
import { Game } from '../src/engine/game.js';
import { AiAgent } from '../src/ai/ai.js';
import { DeferredAgent } from '../src/engine/agents/deferred.js';
import { db, find, setup } from './helpers.js';
import type { Decision } from '../src/engine/state.js';

test('deck payload: one def per distinct card, counts preserved, printing keys', () => {
  const list = parseDeckList(fs.readFileSync('decks/mono-red-burn.txt', 'utf8'), 'burn');
  const p = buildDeckPayload(db, list, { printings: { 'Lightning Bolt': 'abc' } });
  assert.deepEqual(p.missing, []);
  assert.ok(p.main.some(e => e.key === 'Lightning Bolt@abc'));
  assert.equal(p.defs['Lightning Bolt@abc'].printingId, 'abc');
  const cards = expandPayload(p);
  assert.equal(cards.length, list.cards.reduce((a, c) => a + c.count, 0));
  assert.ok(JSON.stringify(p).length > 1000);
});

test('view: opponent hand hidden, libraries never included, stack targets labelled, JSON-safe', async () => {
  const g = setup({ bf: ['Mountain', 'Glorious Anthem', 'Grizzly Bears'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Grizzly Bears'], hand: ['Counterspell'] });
  const bears = find(g, 'Grizzly Bears', 1);
  await g.performAction(0, { type: 'cast', cardId: g.state.players[0].hand[0].id, targets: [[{ kind: 'object', id: bears.id }]] });
  const v = buildView(g, 0, 'g1');
  assert.equal(v.players[0].hand!.length, 1); assert.equal(v.players[1].hand, null); assert.equal(v.players[1].handSize, 1);
  assert.ok(!('library' in v.players[0])); assert.equal(v.players[0].librarySize, g.state.players[0].library.length);
  const myBears = v.players[0].battlefield.find(o => o.name === 'Grizzly Bears')!;
  assert.equal(myBears.curPower, 3, 'anthem applied'); assert.equal(myBears.canAttack, true);
  assert.equal(v.stack.length, 1); assert.match(v.stack[0].targetLabels[0], /Grizzly Bears#/);
  const json = JSON.parse(JSON.stringify(v));
  assert.equal(json.stack[0].source.name, 'Lightning Bolt');
  const both = buildView(g, null); assert.equal(both.players[1].hand!.length, 1);
});

test('protocol: a DeferredAgent driven game against the AI finishes', async () => {
  const burn = buildDeckPayload(db, parseDeckList(fs.readFileSync('decks/mono-red-burn.txt', 'utf8'), 'burn'));
  const stompy = buildDeckPayload(db, parseDeckList(fs.readFileSync('decks/mono-green-stompy.txt', 'utf8'), 'stompy'));
  let asks = 0; const kinds = new Set<Decision['kind']>();
  const human = new DeferredAgent({ name: 'H', ask: async ({ decision, state, me }) => {
    asks++; kinds.add(decision.kind);
    switch (decision.kind) {
      case 'priority': { const cast = decision.legal.find(l => l.action.type === 'play-land') ?? decision.legal.find(l => l.action.type === 'cast' && !l.targetOptions?.length); return cast ? cast.action : { type: 'pass' }; }
      case 'attackers': return { attackers: decision.candidates };
      case 'blockers': return { blocks: [] };
      case 'choose-cards': return decision.from.slice(0, decision.exact ? decision.count : 0);
      case 'yes-no': return false;
      case 'choose-mode': return [0];
      case 'choose-color': return 'R';
      case 'order-blockers': return decision.blockers;
      default: void state; void me; return null;
    }
  } });
  const ai = new AiAgent({ name: 'AI', verbose: false, maxSims: 60 });
  const g = new Game([expandPayload(burn), expandPayload(stompy)], [human, ai], { seed: 11, quiet: true, maxTurns: 40 });
  ai.attach(g);
  const w = await g.play();
  assert.ok(w === 0 || w === 1 || w === null);
  assert.ok(asks > 5); assert.ok(kinds.has('priority'));
  assert.equal(human.recorded.length, asks);
});
