// The event pipeline: every log line is the text of an event, the stream is deterministic, counts match the
// string log, redaction hides what the viewer may not know, and clones/serialisation carry the version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDeck, parseDeckList } from '../src/cards/db.js';
import { cloneState } from '../src/engine/clone.js';
import { redactEvent, renderEvent, zoneIsPublic, type GameEvent } from '../src/engine/events.js';
import { Game } from '../src/engine/game.js';
import { defTable, deserializeState, serializeState } from '../src/engine/serialize.js';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import { C, db, find, inHand, Script, setup } from './helpers.js';

const deck = (file: string) => loadDeck(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'))).cards;

async function fullGame(seed: number, events: 'full' | 'counts' | 'none') {
  const g = new Game([deck('mono-red-burn'), deck('mono-green-stompy')], [new RolloutAgent('P0'), new RolloutAgent('P1')], { seed, quiet: true, maxTurns: 12, events });
  await g.play();
  return g;
}

test('full mode: the string log is exactly the text of the logged events, in order; seq is monotonic', async () => {
  const g = await fullGame(5, 'full');
  const evs = g.state.events!;
  assert.ok(evs.length > 100, `events ${evs.length}`);
  assert.deepEqual(g.state.log, evs.filter(e => e.text).map(e => e.text));
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].seq > evs[i - 1].seq);
  assert.equal(g.state.version, evs.length, 'version counts emitted events');
  const types = new Set(evs.map(e => e.type));
  for (const t of ['game-start', 'turn', 'step', 'draw', 'zone-change', 'tap', 'cast', 'resolve', 'attack', 'damage', 'game-over']) assert.ok(types.has(t as GameEvent['type']), `saw ${t}`);
  assert.ok(evs.every(e => e.turn >= 0 && e.step));
  const cr = evs.filter(e => e.cr); assert.ok(cr.length > 20, 'events carry rule citations');
});

test('the event stream is deterministic for a seed and identical between full and counts modes (counts)', async () => {
  const a = await fullGame(9, 'full'); const b = await fullGame(9, 'full'); const c = await fullGame(9, 'counts');
  assert.deepEqual(a.state.events, b.state.events);
  assert.deepEqual(a.state.log, c.state.log);
  assert.deepEqual(a.state.eventCounts, c.state.eventCounts);
  assert.equal(c.state.events, undefined);
  const d = await fullGame(9, 'none');
  assert.equal(d.state.eventCounts, undefined); assert.deepEqual(d.state.log, a.state.log);
});

test('unsimulated clauses are counted as events and equal the log grep', async () => {
  const g = setup({ bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] });
  (g as unknown as { opts: { events: 'full' } }).opts.events = 'full'; g.state.events = [];
  const bolt = inHand(g, 'Lightning Bolt', 0); const bears = find(g, 'Grizzly Bears');
  assert.ok(await g.performAction(0, { type: 'cast', cardId: bolt.id, targets: [[{ kind: 'object', id: bears.id }]] }));
  await g.resolveStackFully();
  const ev = g.state.events!;
  const cast = ev.find(e => e.type === 'cast')!; assert.equal(cast.type === 'cast' && cast.name, 'Lightning Bolt'); assert.deepEqual(cast.type === 'cast' && cast.targets, ['Grizzly Bears#' + bears.id]);
  const dmg = ev.find(e => e.type === 'damage')!; assert.ok(dmg.type === 'damage' && dmg.amount === 3 && dmg.targetId === bears.id && dmg.combat === false);
  const died = ev.find(e => e.type === 'zone-change' && e.reason === 'destroy'); assert.ok(died, 'lethal damage destroys through the funnel');
  assert.equal(g.state.eventCounts?.unsimulated ?? 0, g.state.log.filter(l => l.includes('unsimulated text')).length);
  assert.equal(g.state.eventCounts?.cast, 1);
});

test('tap, counter, mana and life primitives emit events with totals', async () => {
  const g = setup({ bf: ['Mountain', 'Grizzly Bears'] }, {});
  (g as unknown as { opts: { events: 'full' } }).opts.events = 'full'; g.state.events = [];
  const bears = find(g, 'Grizzly Bears'); const mtn = find(g, 'Mountain');
  g.setTapped(mtn, true, 'effect'); g.setTapped(mtn, true, 'effect');
  g.addCounters(bears, '+1/+1', 2); g.addCounters(bears, '+1/+1', -2);
  g.addMana(0, ['R', 'R']); g.gainLife(0, 3); g.loseLife(0, 5, 'test');
  const ev = g.state.events!;
  assert.equal(ev.filter(e => e.type === 'tap').length, 1, 'a no-op tap emits nothing');
  const counters = ev.filter(e => e.type === 'counter'); assert.equal(counters.length, 2); assert.equal(counters[1].type === 'counter' && counters[1].total, 0); assert.equal(bears.counters['+1/+1'], undefined);
  assert.equal(ev.filter(e => e.type === 'mana').length, 1); assert.deepEqual(g.state.players[0].manaPool, ['R', 'R']);
  const life = ev.filter(e => e.type === 'life'); assert.equal(life.length, 2); assert.equal(life[1].type === 'life' && life[1].total, 18);
  assert.equal(g.state.log.at(-1), 'P0 loses 5 life (18) — test.');
});

test('redactEvent hides the opponent\'s unknown draws and zone changes; renderEvent covers every logged type', () => {
  const draw = { seq: 1, turn: 1, step: 'draw', text: 'P1 draws a card.', type: 'draw', player: 1, id: 5, name: 'Lightning Bolt', public: false, stepDraw: true } as GameEvent;
  assert.equal(redactEvent(draw, 0).type === 'draw' && (redactEvent(draw, 0) as { name: string }).name, '');
  assert.equal((redactEvent(draw, 1) as { name: string }).name, 'Lightning Bolt');
  assert.equal((redactEvent(draw, null) as { name: string }).name, 'Lightning Bolt');
  const zc = { seq: 2, turn: 1, step: 'main1', text: '', type: 'zone-change', id: 5, name: 'Bolt', owner: 1, controller: 1, from: 'hand', to: 'library', reason: 'tuck', token: false, public: false } as GameEvent;
  assert.equal((redactEvent(zc, 0) as { name: string }).name, '');
  assert.ok(zoneIsPublic('battlefield') && !zoneIsPublic('hand') && !zoneIsPublic('library'));
  const pn = (p: 0 | 1) => `P${p}`;
  assert.equal(renderEvent({ type: 'attack', player: 0, target: 1, attackers: [{ id: 3, name: 'Bears' }] }, pn), 'P0 attacks with Bears#3.');
  assert.equal(renderEvent({ type: 'block', player: 1, blocks: [] }, pn), 'P1 declares no blocks.');
  assert.equal(renderEvent({ type: 'block', player: 1, blocks: [{ blocker: 4, blockerName: 'Wall', attacker: 3, attackerName: 'Bears' }] }, pn), 'P1 blocks: Bears#3 blocked by Wall#4.');
  assert.equal(renderEvent({ type: 'sba', kind: 'legend-rule', id: 9, name: 'Ragavan' }, pn), 'Legend rule: Ragavan#9 is put into the graveyard.');
});

test('clone and serialisation keep the version and drop the event stream', async () => {
  const g = await fullGame(3, 'full');
  const s = g.state;
  const c = cloneState(s);
  assert.equal(c.version, s.version); assert.deepEqual(c.events, []); assert.deepEqual(c.eventCounts, s.eventCounts);
  const ser = serializeState(s);
  assert.equal(ser.version, 1); assert.equal(ser.stateVersion, s.version); assert.equal((ser as { events?: unknown }).events, undefined);
  const back = deserializeState(JSON.parse(JSON.stringify(ser)), defTable([...deck('mono-red-burn'), ...deck('mono-green-stompy')]));
  assert.equal(back.version, s.version);
  // a game resumed from a snapshot keeps numbering events after the snapshot
  const g2 = Game.fromState(back, [new Script('P0'), new Script('P1')], { quiet: true, events: 'full' });
  g2.note('hello');
  assert.equal(g2.state.events!.at(-1)!.text, 'hello'); assert.equal(g2.state.version, s.version + 1);
});
