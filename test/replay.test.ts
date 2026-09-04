// Event replay: folding the recorded (redacted) event stream over the initial view reproduces `buildView` at every
// decision for the fields the replayer models (see src/play/replay.ts for the list), the Replayer keyframe cache
// agrees with the plain fold, and placeholders stand in for hidden cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDeck, parseDeckList } from '../src/cards/db.js';
import { Game } from '../src/engine/game.js';
import { redactEvent, type GameEvent } from '../src/engine/events.js';
import type { Agent, Decision, GameState, PlayerId } from '../src/engine/state.js';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import { buildView, type PermanentView, type PlayerView, type ViewState } from '../src/play/view.js';
import { applyEvent, hydrate, indexCards, isPlaceholder, placeholderCard, replayTo, Replayer } from '../src/play/replay.js';
import { db } from './helpers.js';

const deck = (file: string) => loadDeck(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'))).cards;

/** Wraps an agent and snapshots the viewer-0 view (and the event count) at every decision. */
class Recording implements Agent {
  name: string; hidden = false;
  snaps: { at: number; view: ViewState; kind: Decision['kind'] }[] = [];
  game: Game | null = null;
  constructor(private inner: Agent) { this.name = inner.name; }
  decide(state: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (this.game) this.snaps.push({ at: this.game.state.events!.length, view: buildView(this.game, 0, 'g'), kind: d.kind });
    return this.inner.decide(state, me, d);
  }
}

const sortedIds = (cs: { id: number }[]) => cs.map(c => c.id).sort((a, b) => a - b);
function permFacts(p: PermanentView) {
  return { id: p.id, tapped: p.tapped, damage: p.damage, counters: p.counters, controller: p.controller, attachedTo: p.attachedTo, attacking: p.attacking, blocking: [...p.blocking].sort(), blockedBy: [...p.blockedBy].sort(), transformed: p.transformed };
}
function playerFacts(p: PlayerView) {
  return {
    id: p.id, life: p.life, lost: p.lost, handSize: p.handSize, librarySize: p.librarySize, landsPlayedThisTurn: p.landsPlayedThisTurn,
    hand: p.hand ? p.hand.map(c => c.id) : null, battlefield: p.battlefield.map(permFacts).sort((a, b) => a.id - b.id), graveyard: sortedIds(p.graveyard), exile: sortedIds(p.exile), command: sortedIds(p.command),
    commanderCasts: p.commanderCasts, commanderDamage: p.commanderDamage,
  };
}
function facts(v: ViewState) {
  // activePlayer is chosen before the mulligan decisions and only becomes an event at game-start
  return { turn: v.turn, activePlayer: v.turn > 0 ? v.activePlayer : null, step: v.step, winner: v.winner, attackers: [...v.attackers].sort(), logLength: v.logLength, stack: v.stack.map(s => ({ id: s.id, kind: s.kind, name: s.name, controller: s.controller, sourceId: s.sourceId })), players: v.players.map(playerFacts) };
}

async function recordGame(seed: number, maxTurns = 10) {
  const a = new Recording(new RolloutAgent('P0')); const b = new Recording(new RolloutAgent('P1'));
  const g = new Game([deck('mono-red-burn'), deck('mono-green-stompy')], [a, b], { seed, quiet: true, maxTurns, events: 'full' });
  a.game = g; b.game = g;
  const view0 = buildView(g, 0, 'g');
  await g.play();
  const events = g.state.events!.map(e => redactEvent(e, 0));
  const snaps = [...a.snaps, ...b.snaps].sort((x, y) => x.at - y.at);
  return { g, view0, events, snaps, final: buildView(g, 0, 'g') };
}

test('replaying the redacted event stream reproduces buildView at every decision (modelled fields)', async () => {
  const { view0, events, snaps, final, g } = await recordGame(7);
  assert.ok(events.length > 200, `events ${events.length}`);
  assert.ok(snaps.length > 20, `snapshots ${snaps.length}`);
  const kinds = new Set(snaps.map(s => s.kind));
  assert.ok(kinds.has('priority') && (kinds.has('attackers') || kinds.has('blockers')), 'saw priority and combat decisions');
  let v: ViewState = view0; let cursor = 0;
  for (const snap of snaps) {
    for (; cursor < snap.at; cursor++) v = applyEvent(v, events[cursor]);
    assert.deepEqual(facts(v), facts(snap.view), `decision ${snap.kind} after event ${snap.at} (turn ${snap.view.turn} ${snap.view.step})`);
  }
  for (; cursor < events.length; cursor++) v = applyEvent(v, events[cursor]);
  assert.deepEqual(facts(v), facts(final), 'final view');
  assert.equal(v.logLength, g.state.log.length);
  // hidden cards: the opponent's hand is a count, and the draw placeholders in the viewer's hand carry names
  const mine = v.players[0].hand!; assert.ok(mine.every(c => c.name), 'viewer sees names of own cards');
  assert.equal(v.players[1].hand, null);
});

test('a second seed and the Replayer keyframe cache agree with the plain fold', async () => {
  const { view0, events, snaps } = await recordGame(23, 8);
  const r = new Replayer(view0, events, 25);
  assert.equal(r.length, events.length);
  for (const n of [0, 1, 24, 25, 26, 49, 50, 77, 100, Math.floor(events.length / 2), events.length - 1, events.length]) {
    if (n > events.length) continue;
    assert.deepEqual(facts(r.at(n)), facts(replayTo(view0, events, n)), `at(${n})`);
  }
  for (const snap of snaps.slice(0, 40)) assert.deepEqual(facts(r.at(snap.at)), facts(snap.view), `keyframe at ${snap.at}`);
  // trimming re-bases without changing what later cursors show
  const before = facts(r.at(events.length));
  const mid = facts(r.at(60));
  r.trim(30);
  assert.equal(r.length, events.length - 30);
  assert.deepEqual(facts(r.at(30)), mid);
  assert.deepEqual(facts(r.at(r.length)), before);
  assert.deepEqual(facts(r.latest), before);
});

test('applyEvent never mutates its input and placeholders hydrate from the authoritative view', async () => {
  const { view0, events, final } = await recordGame(3, 4);
  const frozen = JSON.stringify(view0);
  const v = replayTo(view0, events, 30);
  assert.equal(JSON.stringify(view0), frozen, 'input untouched');
  assert.ok(v !== view0);
  const drawn = v.players[0].hand!;
  assert.ok(drawn.length >= 7 && drawn.every(isPlaceholder), 'opening hand cards are placeholders until hydrated');
  const known = indexCards(final);
  const full = replayTo(view0, events);
  const h = hydrate(full, known);
  const stillHidden = h.players[0].hand!.filter(isPlaceholder);
  assert.equal(stillHidden.length, 0, 'every card in the viewer hand is known to the final view');
  assert.ok(h.players[0].hand!.every(c => c.printingId || c.oracleId), 'hydrated cards carry identity');
  const p = placeholderCard(999, '', false);
  assert.ok(isPlaceholder(p) && p.name === '' && p.types.length === 0);
});

test('stack push/pop, zone moves and combat are modelled event by event', () => {
  const base: ViewState = {
    gameId: 'x', viewer: 0, turn: 3, activePlayer: 0, step: 'main1', priority: 0, winner: null, turnOrder: [0, 1], attackers: [], logLength: 0, passesInRow: 0, format: 'freeform', monarch: null,
    players: [0, 1].map(id => ({ id, name: `P${id}`, life: 20, poison: 0, energy: 0, librarySize: 30, handSize: 0, hand: id === 0 ? [] : null, battlefield: [], graveyard: [], exile: [], command: [], commanders: [], commanderCasts: {}, commanderDamage: {}, manaPool: [], landsPlayedThisTurn: 0, lost: false })),
    stack: [],
  };
  const ev = (body: Omit<GameEvent, 'seq' | 'turn' | 'step' | 'text'>, text = ''): GameEvent => ({ seq: 1, turn: 3, step: 'main1', text, ...body } as GameEvent);
  let v = applyEvent(base, ev({ type: 'draw', player: 0, id: 10, name: 'Lightning Bolt', public: false, stepDraw: false }));
  assert.equal(v.players[0].hand!.length, 1); assert.equal(v.players[0].librarySize, 29); assert.equal(v.players[0].handSize, 1);
  v = applyEvent(v, ev({ type: 'draw', player: 1, id: 11, name: '', public: false, stepDraw: true }));
  assert.equal(v.players[1].hand, null); assert.equal(v.players[1].handSize, 1);
  v = applyEvent(v, ev({ type: 'zone-change', id: 12, name: 'Grizzly Bears', owner: 1, controller: 1, from: 'hand', to: 'battlefield', reason: 'resolve', token: false, public: true, tapped: false }));
  assert.equal(v.players[1].handSize, 0); assert.equal(v.players[1].battlefield[0].name, 'Grizzly Bears');
  v = applyEvent(v, ev({ type: 'zone-change', id: 10, name: 'Lightning Bolt', owner: 0, controller: 0, from: 'hand', to: 'stack', reason: 'cast', token: false, public: true }));
  assert.equal(v.players[0].hand!.length, 0); assert.ok(v.transit?.[10]);
  v = applyEvent(v, ev({ type: 'cast', itemId: 50, id: 10, name: 'Lightning Bolt', player: 0, targets: ['Grizzly Bears#12'], how: [] }, 'P0 casts Lightning Bolt.'));
  assert.equal(v.stack.length, 1); assert.equal(v.stack[0].sourceId, 10); assert.deepEqual(v.stack[0].targetLabels, ['Grizzly Bears#12']); assert.equal(v.logLength, 1);
  v = applyEvent(v, ev({ type: 'resolve', itemId: 50, name: 'Lightning Bolt', kind: 'spell' }, 'Lightning Bolt resolves.'));
  assert.equal(v.stack.length, 0);
  v = applyEvent(v, ev({ type: 'damage', sourceId: 10, source: 'Lightning Bolt', targetId: 12, target: 'Grizzly Bears', amount: 3, combat: false, total: 3 }));
  assert.equal(v.players[1].battlefield[0].damage, 3);
  v = applyEvent(v, ev({ type: 'zone-change', id: 10, name: 'Lightning Bolt', owner: 0, controller: 0, from: 'stack', to: 'graveyard', reason: 'resolve', token: false, public: true }));
  assert.deepEqual(v.players[0].graveyard.map(c => c.id), [10]); assert.equal(Object.keys(v.transit ?? {}).length, 0);
  v = applyEvent(v, ev({ type: 'sba', kind: 'lethal-damage', id: 12, name: 'Grizzly Bears' }));
  v = applyEvent(v, ev({ type: 'zone-change', id: 12, name: 'Grizzly Bears', owner: 1, controller: 1, from: 'battlefield', to: 'graveyard', reason: 'destroy', token: false, public: true }));
  assert.equal(v.players[1].battlefield.length, 0); assert.deepEqual(v.players[1].graveyard.map(c => c.id), [12]);
  // tokens, tapping, counters, combat, control
  v = applyEvent(v, ev({ type: 'zone-change', id: 20, name: 'Soldier', owner: 0, controller: 0, from: 'none', to: 'battlefield', reason: 'token', token: true, public: true, tapped: false }));
  v = applyEvent(v, ev({ type: 'create-token', id: 20, name: 'Soldier', controller: 0, power: 1, toughness: 1 }));
  const tok = v.players[0].battlefield[0]; assert.ok(tok.isToken && tok.isCreature && tok.curPower === 1 && tok.summoningSick);
  v = applyEvent(v, ev({ type: 'counter', id: 20, name: 'Soldier', counter: '+1/+1', delta: 2, total: 2 }));
  assert.equal(v.players[0].battlefield[0].curPower, 3); assert.equal(v.players[0].battlefield[0].counters['+1/+1'], 2);
  v = applyEvent(v, ev({ type: 'turn', player: 0, number: 4 }));
  assert.equal(v.turn, 4); assert.equal(v.players[0].battlefield[0].summoningSick, false);
  v = applyEvent(v, ev({ type: 'attack', player: 0, target: 1, attackers: [{ id: 20, name: 'Soldier' }] }));
  assert.deepEqual(v.attackers, [20]); assert.equal(v.players[0].battlefield[0].attacking, 1);
  v = applyEvent(v, ev({ type: 'tap', id: 20, name: 'Soldier', tapped: true, reason: 'attack' }));
  assert.equal(v.players[0].battlefield[0].tapped, true);
  v = applyEvent(v, ev({ type: 'damage', sourceId: 20, source: 'Soldier', player: 1, amount: 3, combat: true, total: 17 }));
  assert.equal(v.players[1].life, 17);
  v = applyEvent(v, ev({ type: 'step', player: 0, to: 'main2' }));
  assert.deepEqual(v.attackers, []); assert.equal(v.players[0].battlefield[0].attacking, null); assert.equal(v.step, 'main2');
  v = applyEvent(v, ev({ type: 'control', id: 20, name: 'Soldier', from: 0, to: 1 }));
  assert.equal(v.players[0].battlefield.length, 0); assert.equal(v.players[1].battlefield[0].controller, 1);
  v = applyEvent(v, ev({ type: 'zone-change', id: 20, name: 'Soldier', owner: 0, controller: 1, from: 'battlefield', to: 'none', reason: 'sacrifice', token: true, public: true }));
  assert.equal(v.players[1].battlefield.length, 0); assert.equal(v.players[0].graveyard.length, 1, 'tokens cease to exist');
  v = applyEvent(v, ev({ type: 'player-eliminated', player: 1, reason: 'life' }));
  v = applyEvent(v, ev({ type: 'game-over', winner: 0, reason: 'x' }));
  assert.ok(v.players[1].lost && v.winner === 0);
});
