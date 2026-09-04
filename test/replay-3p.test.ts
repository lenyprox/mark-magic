// Event replay with three seats: folding the redacted event stream over the initial view reproduces `buildView` at
// every decision for the modelled fields (as test/replay.test.ts does for a duel), so nothing in replay.ts assumes
// players[0]/players[1]. `attacking` is compared as a flag: the engine's `attack` event names only the primary
// defender, so which of several defenders an attacker was sent at is corrected by the next authoritative view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDeck, parseDeckList } from '../src/cards/db.js';
import { Game } from '../src/engine/game.js';
import { redactEvent } from '../src/engine/events.js';
import type { Agent, Decision, GameState, PlayerId } from '../src/engine/state.js';
import { RolloutAgent } from '../src/analysis/rolloutAgent.js';
import { buildView, type PermanentView, type PlayerView, type ViewState } from '../src/play/view.js';
import { applyEvent, Replayer } from '../src/play/replay.js';
import { describeEvent, involvedInEvent } from '../src/play/anim.js';
import { db } from './helpers.js';

const deck = (file: string) => loadDeck(db, parseDeckList(fs.readFileSync(`decks/${file}.txt`, 'utf8'))).cards;
const THIRD = ['wu-fliers', 'ub-control', 'mono-red-burn'].find(f => fs.existsSync(`decks/${f}.txt`))!;

class Recording implements Agent {
  name: string; hidden = false;
  snaps: { at: number; view: ViewState; kind: Decision['kind']; me: PlayerId }[] = [];
  game: Game | null = null;
  constructor(private inner: Agent) { this.name = inner.name; }
  decide(state: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (this.game) this.snaps.push({ at: this.game.state.events!.length, view: buildView(this.game, 0, 'g'), kind: d.kind, me });
    return this.inner.decide(state, me, d);
  }
}

const sortedIds = (cs: { id: number }[]) => cs.map(c => c.id).sort((a, b) => a - b);
function permFacts(p: PermanentView) {
  return { id: p.id, tapped: p.tapped, damage: p.damage, counters: p.counters, controller: p.controller, attachedTo: p.attachedTo, attacking: p.attacking !== null, blocking: [...p.blocking].sort(), blockedBy: [...p.blockedBy].sort(), transformed: p.transformed };
}
function playerFacts(p: PlayerView) {
  return {
    id: p.id, life: p.life, lost: p.lost, handSize: p.handSize, librarySize: p.librarySize, landsPlayedThisTurn: p.landsPlayedThisTurn,
    hand: p.hand ? p.hand.map(c => c.id) : null, battlefield: p.battlefield.map(permFacts).sort((a, b) => a.id - b.id), graveyard: sortedIds(p.graveyard), exile: sortedIds(p.exile), command: sortedIds(p.command),
    commanderCasts: p.commanderCasts, commanderDamage: p.commanderDamage,
  };
}
function facts(v: ViewState) {
  return { turn: v.turn, activePlayer: v.turn > 0 ? v.activePlayer : null, step: v.step, winner: v.winner, attackers: [...v.attackers].sort(), logLength: v.logLength, stack: v.stack.map(s => ({ id: s.id, kind: s.kind, name: s.name, controller: s.controller, sourceId: s.sourceId })), players: v.players.map(playerFacts) };
}

async function recordGame(seed: number, maxTurns = 30) {
  const agents = [new Recording(new RolloutAgent('P0')), new Recording(new RolloutAgent('P1')), new Recording(new RolloutAgent('P2'))];
  const g = new Game([deck('mono-red-burn'), deck('mono-green-stompy'), deck(THIRD)], agents, { seed, quiet: true, maxTurns, events: 'full' });
  for (const a of agents) a.game = g;
  const view0 = buildView(g, 0, 'g');
  assert.equal(view0.players.length, 3);
  await g.play();
  const events = g.state.events!.map(e => redactEvent(e, 0));
  const snaps = agents.flatMap(a => a.snaps).sort((x, y) => x.at - y.at);
  return { g, view0, events, snaps, final: buildView(g, 0, 'g') };
}

test('three seats: replaying the redacted event stream reproduces buildView at every decision', async () => {
  const { view0, events, snaps, final, g } = await recordGame(11);
  assert.ok(events.length > 200, `events ${events.length}`);
  assert.ok(new Set(snaps.map(s => s.me)).size === 3, 'every seat decided something');
  assert.ok(events.some(e => e.type === 'turn' && e.player === 2), 'seat 2 took a turn');
  let v: ViewState = view0; let cursor = 0;
  for (const snap of snaps) {
    for (; cursor < snap.at; cursor++) v = applyEvent(v, events[cursor]);
    assert.deepEqual(facts(v), facts(snap.view), `decision ${snap.kind} by P${snap.me} after event ${snap.at} (turn ${snap.view.turn} ${snap.view.step})`);
  }
  for (; cursor < events.length; cursor++) v = applyEvent(v, events[cursor]);
  // a turn-limit draw increments `turn` without a turn event (the game-over event carries no turn number)
  const finalFacts = (x: ViewState) => (g.state.winner === null ? { ...facts(x), turn: null, activePlayer: null } : facts(x));
  assert.deepEqual(finalFacts(v), finalFacts(final), 'final view');
  assert.equal(v.logLength, g.state.log.length);
  assert.deepEqual(v.turnOrder, [0, 1, 2]);
  // hidden information: only the viewer's hand is listed
  assert.ok(v.players[0].hand && v.players[1].hand === null && v.players[2].hand === null);
  // the keyframe cache agrees with the plain fold at the seat-2 decisions
  const r = new Replayer(view0, events, 25);
  for (const snap of snaps.filter(s => s.me === 2).slice(0, 30)) assert.deepEqual(facts(r.at(snap.at)), facts(snap.view), `keyframe at ${snap.at}`);
  // truncate (undo) rewinds the head to the fold after the kept prefix
  const cut = Math.floor(events.length / 2);
  const expected = facts(r.at(cut));
  r.truncate(cut);
  assert.equal(r.length, cut);
  assert.deepEqual(facts(r.latest), expected);
  assert.deepEqual(facts(r.at(cut)), expected);
  // the animation words and involvement never assume two seats
  const names = (p: PlayerId) => ['P0', 'P1', 'P2'][p];
  for (const ev of events) {
    const inv = involvedInEvent(ev);
    for (const p of inv.players) assert.ok(p >= 0 && p <= 2, `player id ${p} in ${ev.type}`);
    assert.equal(typeof describeEvent(ev, names), 'string');
  }
});
