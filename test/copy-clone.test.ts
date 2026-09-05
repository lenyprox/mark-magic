// The copy / clone family (Phase 9.1), for the two things a scenario cannot say.
//
//   * a TARGETING RESTRICTION is a negative — "Lithoform Engine may not copy an opponent's spell" is not an outcome
//     any board reaches, it is an option the engine must never offer, so it is asserted against `targetOptionsFor`
//     directly (CR 115.4: "you control" restricts what may be chosen, and CR 707.10 copies only what was targeted);
//   * a SERIALIZE ROUND TRIP is not a game state at all. `serializeState` is on the live path for the Monte-Carlo
//     rollouts of src/analysis/pool.ts and for apps/web's game worker, so a copy that survives the game but not the
//     snapshot makes a rollout score a board that never existed (CR 707.9a: the "except ..." clause is part of the
//     copy's copiable values, not a decoration).
//
// The behavioural half of the family lives in test/scenarios/copy-clone.ts, the way the composition family splits
// test/composition.test.ts from test/scenarios/composition.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardDB } from '../src/cards/db.js';
import { targetOptionsFor } from '../src/engine/legal.js';
import { collectDefs, deserializeState, serializeState } from '../src/engine/serialize.js';
import { cloneState } from '../src/engine/clone.js';
import { defOf } from '../src/engine/characteristics.js';
import type { Game } from '../src/engine/game.js';
import type { GameObject, GameState, PlayerId, StackItem } from '../src/engine/state.js';
import type { TargetSpec } from '../src/cards/types.js';
import { runScenario, type Scenario } from './scenarios/dsl.js';
import { find, setup } from './helpers.js';

const db = CardDB.shared();

// ---------------------------------------------------------------------------
// The printed wordings route to the family's own stack kinds, never to the core ones
// ---------------------------------------------------------------------------

/** The first `copy-stack` / `change-targets` target in one ability of a real card, as the parser produces it. */
type AnyEffect = { op: string; target?: unknown; effects?: AnyEffect[] };
function firstStackTarget(list: AnyEffect[] | undefined): TargetSpec | undefined {
  for (const e of list ?? []) {
    // "You may choose new targets ..." arrives wrapped in parse.ts's own `may`, so look inside containers too
    if ((e.op === 'copy-stack' || e.op === 'change-targets') && typeof e.target === 'object') return e.target as TargetSpec;
    const inner = firstStackTarget(e.effects); if (inner) return inner;
  }
  return undefined;
}
function stackSpecOf(name: string, ability: number): TargetSpec {
  const d = db.get(name); assert.ok(d, `no such card: ${name}`);
  const ab = d!.abilities[ability]; assert.ok(ab, `${name} has no ability #${ability}`);
  const spec = firstStackTarget((ab as { effects?: AnyEffect[] }).effects);
  assert.ok(spec, `${name} #${ability} has no copy-stack / change-targets with a target spec`);
  return spec!;
}

test('copy-clone: every "you control" copy wording carries a kind that actually enforces it', () => {
  // src/engine/legal.ts `case 'spell'` and `case 'ability'` never read `spec.controller`, and `case 'ability'` cannot
  // tell an activated ability from a triggered one — so a wording that routed there would silently drop half of what
  // the card prints. These are the fully-parsed cards that print one (CR 115.4).
  assert.deepEqual(stackSpecOf('Lithoform Engine', 0), { kind: 'stack-ability', controller: 'you' });
  assert.deepEqual(stackSpecOf('Lithoform Engine', 1), { kind: 'stack-spell', filter: { types: ['Instant', 'Sorcery'] }, controller: 'you' });
  assert.deepEqual(stackSpecOf('Lithoform Engine', 2), { kind: 'stack-spell', filter: { notTypes: ['Instant', 'Sorcery'] }, controller: 'you' });
  assert.deepEqual(stackSpecOf('Strionic Resonator', 0), { kind: 'stack-triggered-ability', controller: 'you' });
  assert.deepEqual(stackSpecOf('Nivix Guildmage', 1), { kind: 'stack-spell', filter: { types: ['Instant', 'Sorcery'] }, controller: 'you' });
  assert.deepEqual(stackSpecOf('Mirrorpool', 1), { kind: 'stack-spell', filter: { types: ['Instant', 'Sorcery'] }, controller: 'you' });
  // and the unrestricted forms keep the family kinds too, so ONE code path answers every one of these wordings
  assert.deepEqual(stackSpecOf('Reverberate', 0), { kind: 'stack-spell', filter: { types: ['Instant', 'Sorcery'] } });
  assert.deepEqual(stackSpecOf('Deflecting Swat', 0), { kind: 'spell-or-ability' });
  assert.deepEqual(stackSpecOf('Swerve', 0), { kind: 'single-target-spell' });
});

/** A game with one stack item of each kind, per seat: [spell, activated ability, triggered ability] x [P0, P1]. */
function stackedGame() {
  const g = setup({ bf: ['Mountain', 'Grizzly Bears'], hand: ['Lightning Bolt'] }, { bf: ['Mountain', 'Hill Giant'], hand: ['Shock'] });
  const s = g.state;
  const push = (kind: StackItem['kind'], src: GameObject, p: PlayerId, label: string) => {
    const it = g.makeStackItem(kind, src, p, [], label, 0, undefined, label);
    s.stack.push(it); return it;
  };
  const mine = s.players[0].hand.find(o => o.def.name === 'Lightning Bolt')!;
  const theirs = s.players[1].hand.find(o => o.def.name === 'Shock')!;
  mine.zone = 'stack'; theirs.zone = 'stack';
  return {
    g, s,
    mySpell: push('spell', mine, 0, 'Lightning Bolt'),
    theirSpell: push('spell', theirs, 1, 'Shock'),
    myActivated: push('ability', find(g, 'Grizzly Bears', 0), 0, 'my activated'),
    theirActivated: push('ability', find(g, 'Hill Giant', 1), 1, 'their activated'),
    myTrigger: push('trigger', find(g, 'Grizzly Bears', 0), 0, 'my trigger'),
    theirTrigger: push('trigger', find(g, 'Hill Giant', 1), 1, 'their trigger'),
  };
}

/** The stack items seat 0 may target with `spec`, sorted (the source is a permanent seat 0 controls). */
const ids = (g: Game, spec: TargetSpec): number[] =>
  targetOptionsFor(g, 0, spec, g.state.players[0].battlefield[0]).filter(r => r.kind === 'stack').map(r => r.id).sort((a, b) => a - b);
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);

test('copy-clone: "you control" really is enforced — an opponent\'s spell is never offered (CR 115.4)', () => {
  const t = stackedGame();
  // "Copy target instant or sorcery spell you control": the opponent's Shock must not be a legal target
  assert.deepEqual(ids(t.g, { kind: 'stack-spell', filter: { types: ['Instant', 'Sorcery'] }, controller: 'you' }), [t.mySpell.id]);
  // without the restriction both spells are offered, which is what proves the restriction above did the work
  assert.deepEqual(ids(t.g, { kind: 'stack-spell', filter: { types: ['Instant', 'Sorcery'] } }), sorted([t.mySpell.id, t.theirSpell.id]));
  // "Copy target activated or triggered ability you control" — abilities only, and only mine
  assert.deepEqual(ids(t.g, { kind: 'stack-ability', controller: 'you' }), sorted([t.myActivated.id, t.myTrigger.id]));
  // the family's spell-or-ability kind honours the opposite restriction too
  assert.deepEqual(ids(t.g, { kind: 'spell-or-ability', controller: 'opponent' }), sorted([t.theirSpell.id, t.theirActivated.id, t.theirTrigger.id]));
});

test('copy-clone: an activated ability and a triggered ability are different targets (CR 113.3a-c)', () => {
  const t = stackedGame();
  // Strionic Resonator copies a TRIGGERED ability you control and nothing else
  assert.deepEqual(ids(t.g, { kind: 'stack-triggered-ability', controller: 'you' }), [t.myTrigger.id]);
  assert.deepEqual(ids(t.g, { kind: 'stack-activated-ability', controller: 'you' }), [t.myActivated.id]);
  // a spell is neither
  assert.ok(!ids(t.g, { kind: 'stack-triggered-ability' }).includes(t.mySpell.id));
  assert.ok(!ids(t.g, { kind: 'stack-activated-ability' }).includes(t.theirSpell.id));
});

// ---------------------------------------------------------------------------
// The copy round-trips (clone, serialize) — CR 707.9a values that live only on the def
// ---------------------------------------------------------------------------

/** The token copy on a seat's battlefield (a token, so `o.token` is set); these scenarios make exactly one. */
function tokenOn(s: GameState, seat = 0): GameObject {
  const t = s.players[seat].battlefield.filter(o => o.token);
  assert.equal(t.length, 1, 'exactly one token on that battlefield');
  return t[0];
}

const copyWithException: Scenario = {
  name: 'token copy with an except clause',
  seats: [{ bf: ['Grizzly Bears', 'Isamaru, Hound of Konda'] }, { bf: ['Mountain'] }],
  scripts: { 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [
    { op: 'copy-permanent', target: { kind: 'creature', controller: 'you' }, except: { power: 7, toughness: 7, notLegendary: true, colors: ['B'], keywords: ['flying'] } },
  ], text: 'copy, except' }] } },
  script: [{ activate: 'Grizzly Bears', targets: [['Isamaru, Hound of Konda']] }, { resolve: true }],
  expect: [{ zoneCount: [0, 'battlefield', 3] }],
};

test('copy-clone: an "except ..." token copy survives clone AND serialize (CR 707.9a, 707.2)', async () => {
  const run = await runScenario(copyWithException);
  assert.deepEqual(run.failures, [], run.game.state.log.join('\n'));
  const s = run.game.state;
  const check = (c: GameState, label: string) => {
    const d = defOf(tokenOn(c));
    assert.equal(d.name, 'Isamaru, Hound of Konda', `${label}: name`);
    assert.equal(d.power, '7', `${label}: power`);
    assert.equal(d.toughness, '7', `${label}: toughness`);
    assert.deepEqual(d.colors, ['B'], `${label}: colors`);
    assert.ok(d.keywords.includes('flying'), `${label}: keywords`);
    // the whole point: "except it isn't legendary" lives ONLY on the def, so a round trip that re-linked the token to
    // the printed card would hand the legend rule (CR 704.5j) a second Isamaru and eat one of them
    assert.ok(!d.supertypes.includes('Legendary'), `${label}: not legendary`);
  };
  check(s, 'live');
  check(cloneState(s), 'clone');
  check(deserializeState(JSON.parse(JSON.stringify(serializeState(s))), collectDefs(s)), 'serialize');
});

test('copy-clone: a derived def keeps a key of its own, so collectDefs cannot shadow it with the printed card', async () => {
  const run = await runScenario(copyWithException);
  const s = run.game.state;
  const tok = tokenOn(s);
  const printed = find(run.game, 'Isamaru, Hound of Konda', 0);
  assert.notEqual(tok.def, printed.def, 'the token carries a derived def, not the printed one');
  const keys = [...collectDefs(s).keys()].filter(k => k.startsWith('Isamaru, Hound of Konda'));
  assert.equal(keys.length, 2, `the printed def and the derived def need separate keys, got ${JSON.stringify(keys)}`);
});

test('copy-clone: become-copy round-trips through clone and serialize (the copy rides on o.copyDef)', () => {
  const g = setup({ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] });
  const bears = find(g, 'Grizzly Bears', 0), giant = find(g, 'Hill Giant', 1);
  g.setCopyDef(bears, { ...giant.def });
  const check = (c: GameState, label: string) => {
    const o = c.players[0].battlefield.find(x => x.id === bears.id)!;
    assert.equal(defOf(o).name, 'Hill Giant', `${label}: the copy def`);
    assert.equal(defOf(o).power, '3', `${label}: the copied power`);
  };
  check(g.state, 'live');
  check(cloneState(g.state), 'clone');
  check(deserializeState(JSON.parse(JSON.stringify(serializeState(g.state))), collectDefs(g.state)), 'serialize');
});

test('copy-clone: the routing change did not un-claim a card the wave reports as fully parsed', () => {
  for (const n of ['Clone', 'Reverberate', 'Lithoform Engine', 'Strionic Resonator', 'Nivix Guildmage', 'Swerve', 'Redirect', 'Mirror Image', 'Mirrorpool']) {
    const d = db.get(n); assert.ok(d, `no such card: ${n}`);
    assert.deepEqual(d!.unparsed, [], `${n} has unparsed lines`);
  }
});
