// Commander rules (CR 903): command zone, casting with tax, zone replacement, 21 commander damage, 40 life,
// free first mulligan in pods, deck validation and a batch of real Commander games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canBeCommander, colorIdentityOf, commanderPairLegal, validateCommanderDeck } from '../src/decks/validate.js';
import { Game } from '../src/engine/game.js';
import { legalActions } from '../src/engine/legal.js';
import { makeObject, type Agent, type Decision, type GameState, type PlayerId } from '../src/engine/state.js';
import { buildDeckPayload, isCommanderMatch, splitPayload } from '../src/play/payload.js';
import { runMatches } from '../src/sim/batch.js';
import { resolveDeckRef } from '../src/sim/deckRef.js';
import { openUserDb } from '../src/user/db.js';
import { USER_DB } from '../src/config/paths.js';
import type { MatchSpec } from '../src/sim/types.js';
import { runScenario, type Scenario } from './scenarios/dsl.js';
import { C, db, Script } from './helpers.js';

const filler = () => Array(30).fill(C('Swamp'));

/** A two-player Commander game with the given commanders, main-phase of turn 5, seat 0 active. */
function commanderGame(cmd0: string, cmd1: string, agents?: Agent[]) {
  const a = agents ?? [new Script('P0'), new Script('P1')];
  const g = new Game([filler(), filler()], a, { seed: 1, quiet: true, mulligans: false, events: 'full', format: 'commander', commanders: [[C(cmd0)], [C(cmd1)]] });
  const s = g.state; s.turn = 5; s.activePlayer = 0; s.step = 'main1'; s.priority = 0;
  const lands = (pid: number, names: string[]) => { for (const n of names) { const o = makeObject(s.nextId++, C(n), pid, 'battlefield', 1); o.enteredTurn = 1; s.players[pid].battlefield.push(o); } };
  return { g, s, lands };
}

test('commanders start in the command zone; life is 40; the deck stays 99', () => {
  const { s } = commanderGame('Grizzly Bears', 'Hill Giant');
  assert.equal(s.players[0].life, 40); assert.equal(s.players[1].life, 40);
  assert.equal(s.players[0].command.length, 1); assert.equal(s.players[0].command[0].def.name, 'Grizzly Bears'); assert.ok(s.players[0].command[0].commander);
  assert.deepEqual(s.players[0].commanders, [s.players[0].command[0].id]);
  assert.equal(s.players[0].library.length, 30);
});

test('a commander is cast from the command zone; the second cast costs {2} more; it returns to the command zone when it dies', async () => {
  const { g, s, lands } = commanderGame('Grizzly Bears', 'Hill Giant');
  lands(0, ['Forest', 'Forest', 'Forest', 'Forest']);
  const bears = s.players[0].command[0];
  const cast = legalActions(g, 0).find(l => l.action.type === 'cast' && l.action.cardId === bears.id)!;
  assert.ok(cast, 'the commander is castable from the command zone'); assert.match(cast.label, /from command zone/); assert.equal(cast.manaValue, 2);
  assert.ok(await g.performAction(0, cast.action));
  await g.resolveStackFully();
  assert.equal(bears.zone, 'battlefield'); assert.equal(s.players[0].commanderCasts[bears.id], 1);
  assert.equal(s.players[0].battlefield.filter(o => !o.tapped && o.def.types.includes('Land')).length, 2, 'paid {1}{G}');
  // it dies: back to the command zone instead of the graveyard (903.9a)
  g.destroy(bears);
  assert.equal(bears.zone, 'command'); assert.equal(s.players[0].graveyard.length, 0);
  assert.ok(s.events!.some(e => e.type === 'replaced' && e.what === 'commander-zone'));
  assert.ok(s.log.some(l => /put into the command zone instead/.test(l)));
  // untap and recast: tax of {2}
  for (const o of s.players[0].battlefield) o.tapped = false;
  const again = legalActions(g, 0).find(l => l.action.type === 'cast' && l.action.cardId === bears.id)!;
  assert.ok(again); assert.match(again.label, /tax 2/);
  assert.ok(await g.performAction(0, again.action));
  assert.equal(s.players[0].battlefield.filter(o => !o.tapped && o.def.types.includes('Land')).length, 0, 'paid {1}{G} plus {2}');
  await g.resolveStackFully();
  assert.equal(bears.zone, 'battlefield'); assert.equal(s.players[0].commanderCasts[bears.id], 2);
  // with only four lands a third cast (tax 4) is unaffordable
  for (const o of s.players[0].battlefield) o.tapped = false;
  g.destroy(bears);
  assert.equal(legalActions(g, 0).some(l => l.action.type === 'cast' && l.action.cardId === bears.id), false);
});

test('21 combat damage from one commander loses the game (704.6c); non-combat and split damage do not', async () => {
  const { g, s } = commanderGame('Grizzly Bears', 'Hill Giant');
  const bears = s.players[0].command[0];
  g.moveTo(bears, 'battlefield'); bears.enteredTurn = 1; bears.controller = 0;
  s.step = 'combat-damage';
  for (let i = 0; i < 10; i++) g.dealDamageToPlayer(bears, 1, 2);
  g.checkSBA();
  assert.equal(s.players[1].commanderDamage[bears.id], 20); assert.equal(s.winner, null);
  s.step = 'main1'; g.dealDamageToPlayer(bears, 1, 5); g.checkSBA();
  assert.equal(s.players[1].commanderDamage[bears.id], 20, 'non-combat damage does not count'); assert.equal(s.winner, null);
  s.step = 'combat-damage'; g.dealDamageToPlayer(bears, 1, 1); g.checkSBA();
  assert.equal(s.winner, 0); assert.match(s.players[1].lossReason ?? '', /21 combat damage/);
  assert.ok(s.events!.some(e => e.type === 'sba' && e.kind === 'commander-damage'));
});

test('the first mulligan is free in a pod but not in a duel', async () => {
  class Mull implements Agent {
    name: string; n = 0;
    constructor(name: string) { this.name = name; }
    async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
      if (d.kind === 'yes-no' && d.prompt.startsWith('Mulligan')) return this.n++ < 1;
      return new Script(this.name).decide(s, me, d);
    }
  }
  const pod = new Game([filler(), filler(), filler()], [new Mull('a'), new Mull('b'), new Mull('c')], { seed: 2, quiet: true, maxTurns: 1, format: 'commander', commanders: [[C('Grizzly Bears')], [C('Hill Giant')], [C('Grizzly Bears')]] });
  await pod.play();
  assert.ok(pod.state.players.every(p => p.hand.length + p.cardsDrawnThisTurn! >= 7), 'seven kept after the free mulligan');
  const duel = new Game([filler(), filler()], [new Mull('a'), new Mull('b')], { seed: 2, quiet: true, maxTurns: 1, format: 'commander', commanders: [[C('Grizzly Bears')], [C('Hill Giant')]] });
  await duel.play();
  const nonActive = duel.state.players.find(p => p.id !== duel.state.activePlayer)!;
  assert.equal(nonActive.hand.length, 6, 'a duel bottoms one card after the mulligan');
});

test('scenario DSL supports command zones', async () => {
  const sc: Scenario = {
    name: 'commander cast', format: 'commander',
    seats: [{ bf: ['Forest', 'Forest'], command: ['Grizzly Bears'] }, {}],
    script: [{ cast: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { life: [1, 40] }, { events: { type: 'cast', min: 1 } }],
  };
  const r = await runScenario(sc);
  assert.deepEqual(r.failures, []);
});

test('validateCommanderDeck: legality, identity, singleton, size; partner pairs', () => {
  const lookup = (n: string) => db.get(n);
  const ok = validateCommanderDeck([{ name: 'Varina, Lich Queen', count: 1, board: 'commander' }, ...Array.from({ length: 33 }, () => ({ name: 'Swamp', count: 1, board: 'main' })), ...Array.from({ length: 33 }, () => ({ name: 'Island', count: 1, board: 'main' })), ...Array.from({ length: 33 }, () => ({ name: 'Plains', count: 1, board: 'main' }))], lookup);
  assert.deepEqual(ok, []);
  const bad = validateCommanderDeck([{ name: 'Grizzly Bears', count: 1, board: 'commander' }, { name: 'Lightning Bolt', count: 2, board: 'main' }, { name: 'Forest', count: 97, board: 'main' }], lookup);
  const kinds = bad.map(i => i.kind);
  assert.ok(kinds.includes('commander'), 'Bears is not legendary'); assert.ok(kinds.includes('identity'), 'Bolt is off-colour'); assert.ok(kinds.includes('singleton'));
  assert.ok(!kinds.includes('size'));
  assert.ok(canBeCommander(db.get('Varina, Lich Queen')!)); assert.ok(!canBeCommander(db.get('Grizzly Bears')!));
  const thrasios = db.get('Thrasios, Triton Hero'), tymna = db.get('Tymna the Weaver');
  if (thrasios && tymna) { assert.ok(commanderPairLegal(thrasios, tymna)); assert.deepEqual(colorIdentityOf([thrasios, tymna]), ['W', 'U', 'B', 'G']); }
  assert.ok(!commanderPairLegal(db.get('Varina, Lich Queen')!, db.get('Grizzly Bears')!));
});

test('payload split and a 2-player Commander batch with real decks (commanders never in the library)', async () => {
  const user = fs.existsSync(USER_DB()) ? openUserDb() : null;
  if (!user) return;
  const a = resolveDeckRef('Varina', db, user).payload, b = resolveDeckRef('Doran', db, user).payload;
  assert.ok(isCommanderMatch([a, b]));
  const sa = splitPayload(a); assert.equal(sa.commanders.length, 1); assert.ok(sa.library.length >= 98 && sa.library.length <= 99, `library ${sa.library.length}`);
  const spec: MatchSpec = { id: 'cmdr', decks: [a, b], games: 4, baseSeed: 3, seating: 'rotate', agent: 'rollout', format: 'commander', maxTurns: 40, mulligans: 'lands', record: 'summary' };
  const r = await runMatches(spec);
  assert.equal(r.aggregate.errors, 0, JSON.stringify(r.games.map(g => g.error)));
  assert.ok(r.games.every(g => g.openingHand.every(h => !h.includes('Varina, Lich Queen') && !h.includes('Doran, the Siege Tower'))), 'commanders are not drawn');
  const cast = r.games.flatMap(g => g.firstCommanderCastTurn).filter(t => t !== null);
  assert.ok(cast.length > 0, `some commander got cast from the command zone: ${JSON.stringify(r.games.map(g => g.firstCommanderCastTurn))}`);
  user.close();
});

test('two-player freeform games are untouched by the Commander plumbing', () => {
  const p = buildDeckPayload(db, { name: 'x', cards: [{ name: 'Lightning Bolt', count: 4, board: 'main' }] });
  assert.ok(!isCommanderMatch([p, p]));
  const g = new Game([[C('Mountain')], [C('Mountain')]], [new Script('a'), new Script('b')], { quiet: true });
  assert.equal(g.state.players[0].life, 20); assert.equal(g.state.players[0].command.length, 0); assert.ok(!g.commanderRules);
});
