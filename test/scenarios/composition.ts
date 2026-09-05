// Composition core (Phase 9.0, docs/vocabulary/composition.md): one scenario per op, per Ref, per Amount form, per
// delayed-trigger point and per `who` scope, plus one per target kind the ratchet had never seen executed.
//
// No printed card parses into these ops yet (the parser rules are slice 9.0b), so every scenario scripts a real card
// through the DSL's `scripts` field: an activated {T} ability added to Grizzly Bears, or Lightning Bolt's spell text
// replaced. The cards, the lands and the opponents' creatures are real; the expectations are about what the op did.
import type { Effect, TargetSpec } from '../../src/cards/types.js';
import { attackWith, type Scenario, type ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>" (the printed vanilla body stays). */
const bears = (effects: Effect[], text = 'composition'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects, text }] } });
/** Grizzly Bears gains a free "<effects>" ability (no tap, so it can be activated twice in one turn). */
const bearsFree = (effects: Effect[], text = 'composition'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** Lightning Bolt's spell becomes <effects> ({R}, instant). */
const bolt = (effects: Effect[], text = 'composition'): Record<string, ScenarioScript> =>
  ({ 'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects, text }] } });
const creature: TargetSpec = { kind: 'creature' };
const T = (kind: TargetSpec['kind'], extra: Partial<TargetSpec> = {}): TargetSpec => ({ kind, ...extra });

export const composition: Scenario[] = [
  // ------------------------------------------------------------------ for-each
  {
    name: 'for-each over creatures you control puts a counter on each of them and only them', cr: '608.2f',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: bears([{ op: 'for-each', over: { types: ['Creature'], who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 4, 4] }, { pt: ['Grizzly Bears', 3, 3] }, { pt: ['Runeclaw Bear', 2, 2] }, { unsimulated: 0 }],
  },
  {
    name: 'for-each iterates a snapshot: an object destroyed by an earlier iteration is skipped and the rest still run', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear'], life: 20 }],
    // each opponent creature: its controller loses 1 life, then it is destroyed — every iteration binds a fresh 'that'
    scripts: bolt([{ op: 'for-each', over: { types: ['Creature'], who: 'each-opponent' }, do: [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: 1, who: 'you' }] }, { op: 'destroy', target: 'that' }] }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ life: [1, 18] }, { zone: ['Hill Giant', 'graveyard'] }, { zone: ['Runeclaw Bear', 'graveyard'] }, { zone: ['Grizzly Bears', 'battlefield'] }],
  },
  {
    name: "for-each over 'targets' walks every chosen target of the spell", cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    // the spell's targets come from the `tap` (two creatures); the loop then shrinks each of them
    scripts: bolt([{ op: 'tap', target: T('creature', { count: 2 }) }, { op: 'for-each', over: 'targets', do: [{ op: 'counters', target: 'that', counter: '-1/-1', amount: 1 }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant', 'Runeclaw Bear']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 2, 2] }, { pt: ['Runeclaw Bear', 1, 1] }, { tapped: ['Hill Giant', true] }],
  },
  // ------------------------------------------------------------------ bind
  {
    name: "bind from targets makes 'that' the target: it is dealt damage equal to its own power", cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'tap', target: creature }, { op: 'bind', as: 'that', from: 'targets' }, { op: 'damage', amount: { prop: 'power', of: 'that' }, target: 'that' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { events: { type: 'damage', min: 1, max: 1 } }],
  },
  {
    name: "bind from triggering: an ETB trigger puts a counter on the creature that entered", cr: '603.2',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Hill Giant'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'etb', self: false, filter: { types: ['Creature'] }, controller: 'you' }, effects: [{ op: 'bind', as: 'that', from: 'triggering' }, { op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }], text: 'composition' }] } },
    script: [{ cast: 'Hill Giant' }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 4, 4] }, { pt: ['Grizzly Bears', 2, 2] }],
  },
  // ------------------------------------------------------------------ reflexive / may
  {
    name: 'reflexive "when you do" fires after an optional sacrifice that was taken', cr: '603.12',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'may', effects: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature'], other: true }, amount: 1 }] }, { op: 'reflexive', when: 'you-do', effects: [{ op: 'draw', amount: 2, who: 'you' }] }]),
    script: [{ answer: true }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { handCount: [0, 2] }, { events: { type: 'trigger', min: 1 } }],
  },
  {
    name: 'reflexive does not fire when the optional action was declined', cr: '603.12',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'may', effects: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature'], other: true }, amount: 1 }] }, { op: 'reflexive', when: 'you-do', effects: [{ op: 'draw', amount: 2, who: 'you' }] }]),
    script: [{ answer: false }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { handCount: [0, 0] }, { events: { type: 'trigger', max: 0 } }],
  },
  {
    name: 'reflexive does not fire when the action was taken but nothing happened (no creature to sacrifice)', cr: '603.12',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'may', effects: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature'], other: true }, amount: 1 }] }, { op: 'reflexive', when: 'you-do', effects: [{ op: 'draw', amount: 2, who: 'you' }] }]),
    script: [{ answer: true }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ handCount: [0, 0] }, { events: { type: 'trigger', max: 0 } }],
  },
  {
    name: 'may: the default agent takes the optional action', cr: '608.2d',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'may', prompt: 'Draw a card?', effects: [{ op: 'draw', amount: 1, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ handCount: [0, 1] }, { events: { type: 'decision', min: 1 } }],
  },
  // ------------------------------------------------------------------ scoped and the who scopes
  {
    name: 'scoped each-opponent: each opponent sacrifices a creature, then draws a card (APNAP, the active player first)', cr: '101.4',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }, { bf: ['Wind Drake'] }],
    scripts: bears([{ op: 'scoped', who: 'each-opponent', do: [{ op: 'sacrifice', who: 'you', what: { types: ['Creature'] }, amount: 1 }, { op: 'draw', amount: 1, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Runeclaw Bear', 'graveyard'] }, { zone: ['Wind Drake', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }, { handCount: [1, 1] }, { handCount: [2, 1] }, { handCount: [0, 0] }],
  },
  {
    name: 'scoped each-player: every player, the active player included, loses 1 life', cr: '101.4',
    seats: [{ bf: ['Grizzly Bears'] }, {}, {}],
    scripts: bears([{ op: 'scoped', who: 'each-player', do: [{ op: 'lose-life', amount: 1, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 19] }, { life: [1, 19] }, { life: [2, 19] }],
  },
  {
    name: "scoped target-player: 'you' inside the block is the targeted player, who discards", cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { hand: ['Hill Giant'] }],
    scripts: bolt([{ op: 'scoped', who: 'target-player', do: [{ op: 'discard', amount: 1, who: 'you' }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ handCount: [1, 0] }, { zone: ['Hill Giant', 'graveyard'] }, { handCount: [0, 0] }],
  },
  {
    name: "scoped that-player: a trigger about a player acts as that player", cr: '603.2',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Mountain'], hand: ['Shock'] }],
    // whenever an opponent casts a spell, that player loses 2 life
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'cast', filter: {}, who: 'opponent' }, effects: [{ op: 'scoped', who: 'that-player', do: [{ op: 'lose-life', amount: 2, who: 'you' }] }], text: 'composition' }] } },
    script: [{ cast: 'Shock', by: 1, targets: [['P0']] }, { resolve: true }],
    expect: [{ life: [1, 18] }, { life: [0, 18] }],
  },
  {
    name: "scoped controller-of-that: for each creature, its controller loses life equal to its power", cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: bears([{ op: 'for-each', over: { types: ['Creature'], who: 'each-opponent' }, do: [{ op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: { prop: 'power', of: 'that' }, who: 'you' }] }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [1, 15] }, { life: [0, 20] }],
  },
  {
    name: "scoped you: an explicit 'you' block is the controller's own", cr: '608.2c',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'scoped', who: 'you', do: [{ op: 'gain-life', amount: 3, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { life: [1, 20] }],
  },
  // ------------------------------------------------------------------ unless-pays
  {
    name: 'unless-pays: the targeted player pays {2} (the default agent pays) and keeps their hand', cr: '118.12',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Island', 'Island'], hand: ['Hill Giant'] }],
    scripts: bolt([{ op: 'unless-pays', who: 'target-player', cost: { mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, otherwise: [{ op: 'discard', amount: 1, who: 'you' }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ handCount: [1, 1] }, { tapped: ['Island', true] }, { log: 'pays \\{2\\}' }],
  },
  {
    name: "unless-pays: a player who cannot pay suffers the alternative, as 'you'", cr: '118.3',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { hand: ['Hill Giant'] }],
    scripts: bolt([{ op: 'unless-pays', who: 'target-player', cost: { mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, otherwise: [{ op: 'discard', amount: 1, who: 'you' }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ handCount: [1, 0] }, { zone: ['Hill Giant', 'graveyard'] }, { log: 'cannot pay' }],
  },
  {
    name: 'unless-pays each-opponent: each opponent decides for themselves', cr: '118.12',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Island', 'Island'] }, {}],
    scripts: bears([{ op: 'unless-pays', who: 'each-opponent', cost: { mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, otherwise: [{ op: 'lose-life', amount: 3, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [1, 20] }, { life: [2, 17] }, { life: [0, 20] }],
  },
  {
    name: 'unless-pays with a non-mana cost: sacrifice a creature or lose 5 life', cr: '118.12',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'unless-pays', who: 'each-opponent', cost: { sacrifice: { types: ['Creature'] } }, otherwise: [{ op: 'lose-life', amount: 5, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [1, 20] }],
  },
  // ------------------------------------------------------------------ move
  {
    name: 'move: return a creature card from your graveyard to the battlefield tapped under your control with a counter', cr: '610.3c',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Hill Giant'] }, {}],
    scripts: bears([{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'graveyard', who: 'you', count: 1 }, to: 'battlefield', controller: 'you', tapped: true, withCounters: { counter: '+1/+1', amount: 1 } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { control: ['Hill Giant', 0] }, { tapped: ['Hill Giant', true] }, { pt: ['Hill Giant', 4, 4] }, { log: 'puts Hill Giant onto the battlefield tapped' }],
  },
  {
    name: 'move: exile target creature until the source leaves the battlefield, and it returns when it does', cr: '610.3',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Shock'] }, { bf: ['Hill Giant'] }],
    scripts: bearsFree([{ op: 'move', what: creature, to: 'exile', until: 'leaves' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { cast: 'Shock', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }, { control: ['Hill Giant', 1] }, { events: { type: 'zone-change', min: 4 } }],
  },
  {
    name: 'move: exile target creature until end of turn; it comes back at the cleanup step under its owner\'s control', cr: '514.2',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'move', what: creature, to: 'exile', until: 'eot' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { passUntil: 'upkeep' }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { control: ['Hill Giant', 1] }, { log: 'puts Hill Giant onto the battlefield' }],
  },
  {
    name: 'move: put a chosen card on the bottom of its owner\'s library, and a Ref move brings it nowhere once hidden', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'battlefield', who: 'each-opponent', count: 'all' }, to: 'library', pos: 'bottom' }, { op: 'move', what: 'those', to: 'hand' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'library'] }, { libraryCount: [1, 21] }, { handCount: [1, 0] }],
  },
  {
    name: 'move: a random choice is drawn from the seeded rng (one of two creatures is exiled)', cr: '608.2d',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: bears([{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'battlefield', who: 'each-opponent', count: 1, choose: 'random' }, to: 'exile' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zoneCount: [1, 'exile', 1] }, { zoneCount: [1, 'battlefield', 1] }],
  },
  {
    name: 'move: each opponent chooses which of their own creatures goes to their hand (choose: owner)', cr: '608.2d',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }, { bf: ['Wind Drake'] }],
    scripts: bears([{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'battlefield', who: 'each-opponent', count: 1, choose: 'owner' }, to: 'hand' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ handCount: [1, 1] }, { handCount: [2, 1] }, { zone: ['Wind Drake', 'hand'] }, { zoneCount: [1, 'battlefield', 1] }],
  },
  {
    name: 'move: put a card from your hand onto the battlefield face down (a 2/2 with no abilities)', cr: '708.2',
    seats: [{ bf: ['Grizzly Bears'], hand: ['Wind Drake'] }, {}],
    scripts: bears([{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'hand', who: 'you', count: 1 }, to: 'battlefield', controller: 'you', faceDown: true }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Wind Drake', 'battlefield'] }, { faceDown: ['Wind Drake', true] }, { pt: ['Wind Drake', 2, 2] }],
  },
  // ------------------------------------------------------------------ set-pt / lose-abilities
  {
    name: 'set-pt: base 0/1 until end of turn, with a +1/+1 counter still applied on top (layer 7b before 7c)', cr: '613.4b',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'counters', target: creature, counter: '+1/+1', amount: 1 }, { op: 'set-pt', target: 'target:0', power: 0, toughness: 1, base: true, duration: 'eot' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 1, 2] }, { ext: ['Hill Giant', 'setPT', { power: 0, toughness: 1, base: true, untilTurn: 5 }] }],
  },
  {
    name: 'set-pt until end of turn wears off at cleanup; a permanent one does not', cr: '514.2',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: bears([{ op: 'set-pt', target: 'creatures-you-control', power: 5, toughness: 5, duration: 'eot' }, { op: 'set-pt', target: { kind: 'creature', controller: 'opponent' }, power: 1, toughness: 1, duration: 'permanent' }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Runeclaw Bear']] }, { resolve: true }, { passUntil: 'upkeep' }],
    expect: [{ pt: ['Hill Giant', 3, 3] }, { pt: ['Grizzly Bears', 2, 2] }, { pt: ['Runeclaw Bear', 1, 1] }],
  },
  {
    name: 'lose-abilities all: a flyer that lost its abilities can be blocked by a ground creature', cr: '613.1f',
    seats: [{ bf: ['Wind Drake', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    scripts: bolt([{ op: 'lose-abilities', target: creature, keywords: 'all', duration: 'eot' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Wind Drake']] }, { resolve: true }, { attack: ['Wind Drake'], blocks: [['Grizzly Bears', 'Wind Drake']] }],
    expect: [{ zone: ['Wind Drake', 'graveyard'] }, { zone: ['Grizzly Bears', 'graveyard'] }, { life: [1, 20] }],
  },
  {
    name: 'lose-abilities with a keyword list removes just those keywords, permanently', cr: '613.1f',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Wind Drake'] }],
    scripts: bears([{ op: 'lose-abilities', target: 'all-creatures', keywords: ['flying'], duration: 'permanent' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'upkeep' }],
    expect: [{ ext: ['Wind Drake', 'lost', { keywords: ['flying'] }] }, { noLog: 'Wind Drake has flying' }],
  },
  // ------------------------------------------------------------------ exchange
  {
    name: 'exchange life totals: each player gains or loses the difference', cr: '701.12c',
    seats: [{ bf: ['Grizzly Bears'], life: 20 }, { life: 5 }],
    scripts: bears([{ op: 'exchange', what: 'life', a: 'you', b: { kind: 'opponent' } }]),
    script: [{ activate: 'Grizzly Bears', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [0, 5] }, { life: [1, 20] }, { events: { type: 'life', min: 2, max: 2 } }],
  },
  {
    name: 'exchange control of two creatures with different controllers', cr: '701.12b',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Runeclaw Bear'] }],
    scripts: bolt([{ op: 'exchange', what: 'control', a: T('creature', { controller: 'you' }), b: T('creature', { controller: 'opponent' }) }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant'], ['Runeclaw Bear']] }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 1] }, { control: ['Runeclaw Bear', 0] }, { events: { type: 'control', min: 2, max: 2 } }],
  },
  {
    name: 'exchange control does nothing when both permanents share a controller', cr: '701.12b',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Runeclaw Bear', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([{ op: 'exchange', what: 'control', a: creature, b: creature }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant'], ['Runeclaw Bear']] }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { control: ['Runeclaw Bear', 0] }, { events: { type: 'control', max: 0 } }],
  },
  // ------------------------------------------------------------------ Refs
  {
    name: "Ref self: the source sets its own base power and toughness", cr: '613.4b',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'set-pt', target: 'self', power: 4, toughness: 4, duration: 'eot' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 4] }],
  },
  {
    name: "Ref those: after a move, 'those' are the objects that moved", cr: '400.7',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: bears([{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'battlefield', who: 'each-opponent', count: 'all' }, to: 'exile' }, { op: 'move', what: 'those', to: 'battlefield', controller: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { control: ['Runeclaw Bear', 0] }, { zoneCount: [1, 'battlefield', 0] }],
  },
  {
    name: 'Ref target:<i> names the i-th target: the second target is tapped, the first is not', cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: bolt([{ op: 'bind', as: 'that', from: 'targets' }, { op: 'tap', target: T('creature', { count: 2 }) }, { op: 'untap', target: 'target:0' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant', 'Runeclaw Bear']] }, { resolve: true }],
    expect: [{ tapped: ['Hill Giant', false] }, { tapped: ['Runeclaw Bear', true] }],
  },
  {
    name: 'Ref enchanted: an Aura\'s ability puts a counter on the creature it enchants', cr: '303.4',
    seats: [{ bf: ['Grizzly Bears', 'Plains'], hand: ['Holy Strength'] }, {}],
    scripts: { 'Holy Strength': { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'counters', target: 'enchanted', counter: '+1/+1', amount: 1 }], text: 'composition' }] } },
    script: [{ cast: 'Holy Strength', targets: [['Grizzly Bears']] }, { resolve: true }, { activate: 'Holy Strength' }, { resolve: true }],
    expect: [{ attachedTo: ['Holy Strength', 'Grizzly Bears'] }, { pt: ['Grizzly Bears', 4, 5] }],
  },
  {
    name: 'Ref equipped: an Equipment\'s ability taps the creature it is attached to', cr: '301.5',
    seats: [{ bf: ['Grizzly Bears', 'Short Sword', 'Plains'] }, {}],
    scripts: { 'Short Sword': { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'tap', target: 'equipped' }], text: 'composition' }] } },
    script: [{ activate: 'Short Sword', ability: -3, targets: [['Grizzly Bears']] }, { resolve: true }, { activate: 'Short Sword', ability: 1 }, { resolve: true }],
    expect: [{ attachedTo: ['Short Sword', 'Grizzly Bears'] }, { tapped: ['Grizzly Bears', true] }],
  },
  {
    name: 'Ref sacrificed: damage equal to the power of the creature sacrificed to pay the cost (Fling)', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { sacrifice: { types: ['Creature'] } }, effects: [{ op: 'lose-life', amount: { prop: 'power', of: 'sacrificed' }, who: 'each-opponent' }], text: 'composition' }] } },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [1, 17] }],
  },
  {
    name: 'Ref exiled-with: the cards imprinted on the source come back to the battlefield', cr: '406.3',
    seats: [{ bf: ['Grizzly Bears'], hand: ['Hill Giant'] }, {}],
    scripts: bearsFree([{ op: 'exile-from-hand', filter: { types: ['Creature'] }, imprint: true }, { op: 'move', what: 'exiled-with', to: 'battlefield', controller: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { control: ['Hill Giant', 0] }, { handCount: [0, 0] }],
  },
  // ------------------------------------------------------------------ Amount forms
  {
    name: "Amount objects: gain 1 life for each creature on the battlefield (every player's)", cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: bears([{ op: 'gain-life', amount: { count: 'objects', filter: { types: ['Creature'] } }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 23] }],
  },
  {
    name: 'Amount objects with zone and who: lose 1 life per card in each opponent\'s graveyard', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Shock'] }, { graveyard: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: bears([{ op: 'lose-life', amount: { count: 'objects', zone: 'graveyard', who: 'each-opponent' }, who: 'each-opponent' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [1, 18] }, { life: [0, 20] }],
  },
  {
    name: 'Amount diff: the difference between two counts, never below zero', cr: '107.1b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear', 'Wind Drake'] }],
    // opponents' creatures minus yours = 2; yours minus theirs would be negative and reads as 0
    scripts: bears([{ op: 'gain-life', amount: { diff: [{ count: 'opponent-creatures' }, { count: 'creatures-you-control' }] }, who: 'you' }, { op: 'lose-life', amount: { diff: [{ count: 'creatures-you-control' }, { count: 'opponent-creatures' }] }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 22] }],
  },
  {
    name: 'Amount sum: the sum of two amounts', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'gain-life', amount: { sum: [{ count: 'creatures-you-control' }, { count: 'opponent-creatures' }, 3] }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 25] }],
  },
  {
    name: 'Amount max / min over a list', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: bears([{ op: 'gain-life', amount: { max: [{ count: 'creatures-you-control' }, { count: 'opponent-creatures' }] }, who: 'you' }, { op: 'lose-life', amount: { min: [{ count: 'creatures-you-control' }, { count: 'opponent-creatures' }] }, who: 'each-opponent' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 22] }, { life: [1, 19] }],
  },
  {
    name: 'Amount prop of a player: lose life equal to the cards in the targeted player\'s hand', cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { hand: ['Hill Giant', 'Runeclaw Bear', 'Wind Drake'] }],
    scripts: bolt([{ op: 'lose-life', amount: { prop: 'cards-in-hand', of: 'target-player' }, who: 'target-player' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 17] }],
  },
  {
    name: 'Amount prop of a Ref: a creature gets +X/+X where X is its own toughness', cr: '613.4c',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'for-each', over: { types: ['Creature'], who: 'you', other: true }, do: [{ op: 'pump', target: 'that', power: { prop: 'toughness', of: 'that' }, toughness: { prop: 'toughness', of: 'that' }, duration: 'eot' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 6, 6] }, { pt: ['Grizzly Bears', 2, 2] }],
  },
  {
    name: "Amount half up/down, times, plus and a max cap", cr: '107.1b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear', 'Wind Drake'] }],
    // 3 opponent creatures: half up = 2, half down = 1, ×2+1 capped at 4 = 4
    scripts: bears([{ op: 'gain-life', amount: { count: 'opponent-creatures', half: 'up' }, who: 'you' }, { op: 'lose-life', amount: { count: 'opponent-creatures', half: 'down' }, who: 'each-opponent' }, { op: 'gain-life', amount: { count: 'opponent-creatures', times: 2, plus: 1, max: 4 }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 26] }, { life: [1, 19] }],
  },
  {
    name: 'Amount prop life: a creature\'s base toughness becomes your life total', cr: '613.4b',
    seats: [{ bf: ['Grizzly Bears'], life: 7 }, {}],
    scripts: bears([{ op: 'set-pt', target: 'self', power: { prop: 'life', of: 'you' }, toughness: { prop: 'life', of: 'you' }, duration: 'eot' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 7, 7] }],
  },
  {
    name: 'Amount prop mv: lose life equal to the mana value of the triggering spell', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Hill Giant'] }],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'cast', filter: {}, who: 'opponent' }, effects: [{ op: 'lose-life', amount: { prop: 'mv', of: 'triggering' }, who: 'that-player' }], text: 'composition' }] } },
    active: 1,
    script: [{ cast: 'Hill Giant', by: 1 }, { resolve: true }],
    expect: [{ life: [1, 16] }],
  },
  // ------------------------------------------------------------------ multi target
  {
    name: "multi target: 'target creature and target player' are chosen independently and each dealt 2 damage", cr: '115.3',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'damage', amount: 2, target: { kind: 'multi', specs: [{ kind: 'creature' }, { kind: 'player' }] } }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant'], ['P1']] }, { resolve: true }],
    expect: [{ life: [1, 18] }, { events: { type: 'damage', min: 2, max: 2 } }, { log: 'deals 2 damage to Hill Giant' }],
  },
  // ------------------------------------------------------------------ delayed-trigger points
  {
    name: 'delayed next-upkeep fires at the very next upkeep, this turn\'s if it is still ahead', cr: '603.7',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    step: 'untap',
    scripts: bears([{ op: 'delayed-trigger', at: 'next-upkeep', effects: [{ op: 'draw', amount: 1, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'upkeep' }, { resolve: true }],
    expect: [{ handCount: [0, 1] }],
  },
  {
    name: 'delayed next-turn:upkeep waits for the next TURN\'s upkeep, not this turn\'s', cr: '603.7',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    step: 'untap',
    scripts: bears([{ op: 'delayed-trigger', at: 'next-turn:upkeep', effects: [{ op: 'draw', amount: 1, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'upkeep' }, { resolve: true }],
    expect: [{ handCount: [0, 0] }],
  },
  {
    name: 'delayed next-turn:upkeep fires at the following turn\'s upkeep (the opponent\'s)', cr: '603.7',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'delayed-trigger', at: 'next-turn:upkeep', effects: [{ op: 'draw', amount: 1, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'upkeep' }, { resolve: true }],
    expect: [{ handCount: [0, 1] }],
  },
  {
    name: 'delayed end-of-combat fires at the end of combat step (even of an empty combat)', cr: '603.7',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'delayed-trigger', at: 'end-of-combat', effects: [{ op: 'gain-life', amount: 4, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'combat-end' }, { resolve: true }],
    expect: [{ life: [0, 24] }],
  },
  {
    name: 'delayed your-next-end-step fires at the controller\'s next end step', cr: '603.7',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'delayed-trigger', at: 'your-next-end-step', effects: [{ op: 'draw', amount: 1, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'end' }, { resolve: true }],
    expect: [{ handCount: [0, 1] }],
  },
  {
    name: 'delayed this-turn:dies fires when the bound creature dies this turn, binding it as \'that\'', cr: '603.7b',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'bind', as: 'that', from: 'targets' }, { op: 'delayed-trigger', at: 'this-turn:dies', bind: 'that', effects: [{ op: 'move', what: 'that', to: 'exile' }] }, { op: 'damage', amount: 3, target: creature }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'exile'] }],
  },
  {
    name: 'delayed this-turn:dies expires at cleanup: a creature that dies next turn does not fire it', cr: '603.7b',
    seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Hill Giant'] }],
    // Shock is the scripted card here; the real Lightning Bolt does the killing a turn later
    scripts: { Shock: { mode: 'replace', abilities: [{ kind: 'spell', effects: [{ op: 'tap', target: creature }, { op: 'bind', as: 'that', from: 'targets' }, { op: 'delayed-trigger', at: 'this-turn:dies', bind: 'that', effects: [{ op: 'move', what: 'that', to: 'exile' }] }], text: 'composition' }] } },
    script: [{ cast: 'Shock', targets: [['Hill Giant']] }, { resolve: true }, { passUntil: 'main1' }, { cast: 'Lightning Bolt', by: 0, targets: [['Hill Giant']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }],
  },
  {
    name: 'delayed this-turn:ltb fires when the bound permanent leaves the battlefield this turn by any route', cr: '603.7b',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'bind', as: 'that', from: 'targets' }, { op: 'delayed-trigger', at: 'this-turn:ltb', bind: 'that', effects: [{ op: 'draw', amount: 1, who: 'you' }] }, { op: 'bounce', target: creature, to: 'hand' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'hand'] }, { handCount: [0, 1] }],
  },
  {
    name: 'delayed until-eot:end fires in the cleanup step, after the turn\'s "until end of turn" effects', cr: '514.3a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'delayed-trigger', at: 'until-eot:end', effects: [{ op: 'gain-life', amount: 2, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'end' }, { resolve: true }],
    expect: [{ life: [0, 20] }],
  },
  {
    name: 'delayed until-eot:end has fired once the next turn begins', cr: '514.3a',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: bears([{ op: 'delayed-trigger', at: 'until-eot:end', effects: [{ op: 'gain-life', amount: 2, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { passUntil: 'upkeep' }],
    expect: [{ life: [0, 22] }],
  },
  // ------------------------------------------------------------------ target kinds the ratchet had never seen executed
  ...([
    ['artifact', { bf: ['Sol Ring'] }, 'Sol Ring'],
    ['enchantment', { bf: ['Glorious Anthem'] }, 'Glorious Anthem'],
    ['planeswalker', { bf: ['Jace Beleren'] }, 'Jace Beleren'],
    ['permanent', { bf: ['Sol Ring'] }, 'Sol Ring'],
    ['nonland-permanent', { bf: ['Glorious Anthem'] }, 'Glorious Anthem'],
    ['artifact-or-enchantment', { bf: ['Glorious Anthem'] }, 'Glorious Anthem'],
    ['artifact-enchantment-or-nonbasic-land', { bf: ['Sol Ring'] }, 'Sol Ring'],
    ['creature-or-planeswalker', { bf: ['Jace Beleren'] }, 'Jace Beleren'],
    ['tapped-creature', { bf: ['Hill Giant'], tapped: ['Hill Giant'] }, 'Hill Giant'],
    ['spell-or-nonland-permanent', { bf: ['Hill Giant'] }, 'Hill Giant'],
  ] as const).map(([kind, seat, victim]): Scenario => ({
    name: `target kind ${kind}: destroy target ${kind}`, cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { ...seat }],
    scripts: bolt([{ op: 'destroy', target: { kind } }]),
    script: [{ cast: 'Lightning Bolt', targets: [[victim]] }, { resolve: true }],
    expect: [{ zone: [victim, 'graveyard'] }],
  })),
  {
    name: 'target kind creature-or-player: 2 damage to a creature', cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    scripts: bolt([{ op: 'damage', amount: 2, target: { kind: 'creature-or-player' } }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }],
  },
  {
    name: 'target kind opponent (reveal-hand-discard): Duress takes a noncreature, nonland card', cr: '115.1',
    seats: [{ bf: ['Swamp'], hand: ['Duress'] }, { hand: ['Shock'] }],
    script: [{ cast: 'Duress', targets: [['P1']] }, { resolve: true }],
    expect: [{ zone: ['Shock', 'graveyard'] }, { handCount: [1, 0] }],
  },
  {
    name: 'target kind attacking-creature: an attack trigger destroys target attacking creature (itself)', cr: '115.1',
    seats: [{ bf: ['Hill Giant'] }, {}],
    scripts: { 'Hill Giant': { abilities: [{ kind: 'triggered', event: { on: 'attacks', self: true }, effects: [{ op: 'destroy', target: { kind: 'attacking-creature' } }], text: 'composition' }] } },
    script: [{ attack: ['Hill Giant'] }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [1, 20] }],
  },
  {
    name: 'target kind blocking-creature: a becomes-blocked trigger destroys target blocking creature', cr: '115.1',
    seats: [{ bf: ['Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    scripts: { 'Hill Giant': { abilities: [{ kind: 'triggered', event: { on: 'becomes-blocked', self: true }, effects: [{ op: 'destroy', target: { kind: 'blocking-creature' } }], text: 'composition' }] } },
    script: [{ attack: ['Hill Giant'], blocks: [['Grizzly Bears', 'Hill Giant']] }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }],
  },
  {
    name: 'target kind creature-spell: counter target creature spell (Essence Scatter)', cr: '115.1',
    seats: [{ bf: ['Island', 'Island'], hand: ['Essence Scatter'] }, { bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }],
    active: 1,
    script: [{ cast: 'Grizzly Bears', by: 1 }, { cast: 'Essence Scatter', by: 0, targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { events: { type: 'countered', min: 1 } }],
  },
  {
    name: 'target kind noncreature-spell: counter target noncreature spell', cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Mountain'], hand: ['Shock'] }],
    scripts: bolt([{ op: 'counter', target: { kind: 'noncreature-spell' } }]),
    script: [{ cast: 'Shock', by: 1, targets: [['P0']] }, { cast: 'Lightning Bolt', by: 0, targets: [['Shock']] }, { resolve: true }],
    expect: [{ zone: ['Shock', 'graveyard'] }, { life: [0, 20] }, { events: { type: 'countered', min: 1 } }],
  },
  {
    name: 'target kind ability: counter target activated ability on the stack', cr: '115.1',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] }],
    scripts: { ...bears([{ op: 'draw', amount: 1, who: 'you' }]), ...bolt([{ op: 'counter', target: { kind: 'ability' } }]) },
    script: [{ activate: 'Grizzly Bears' }, { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ handCount: [0, 0] }, { events: { type: 'countered', min: 1 } }],
  },
  {
    name: 'target kind graveyard-card: exile target card from a graveyard', cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { graveyard: ['Hill Giant'] }],
    scripts: bolt([{ op: 'move', what: { kind: 'graveyard-card' }, to: 'exile' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'exile'] }],
  },
  // ------------------------------------------------------------------ 9.0a review fixes: one target list per effect, modifiers on every amount form, frameless who, deep nesting
  {
    name: "move with a target card and a 'target-player' controller keeps both targets through resolution: the card enters under the targeted player's control", cr: '608.2b',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], graveyard: ['Hill Giant'] }, {}],
    // two requirements on one effect (the card, then the player): the legality pass checks both together instead of dropping the player because it is not a graveyard card
    scripts: bolt([{ op: 'move', what: { kind: 'graveyard-card', filter: { types: ['Creature'] } }, to: 'battlefield', controller: 'target-player' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant'], ['P1']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { control: ['Hill Giant', 1] }, { log: 'P1 puts Hill Giant onto the battlefield' }],
  },
  {
    name: 'Amount modifiers apply to every form: half of a prop rounded down, a diff ×2 +1 capped', cr: '107.1a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    // Hill Giant is 3/3: half its power rounded down is +1/+0; (5 − 2) × 2 + 1 = 7, capped at 6
    scripts: bolt([{ op: 'pump', target: creature, power: { prop: 'power', of: 'target:0', half: 'down' }, toughness: 0, duration: 'eot' }, { op: 'lose-life', who: 'you', amount: { diff: [5, 2], times: 2, plus: 1, max: 6 } }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 4, 3] }, { life: [0, 14] }],
  },
  {
    name: "Amount objects with no binding frame honours who: a self-pt static counts your creatures for power and each opponent's for toughness", cr: '613.4c',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear', 'Wind Drake', 'Hill Giant'] }],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'static', effect: { kind: 'self-pt', power: { count: 'objects', filter: { types: ['Creature'] }, who: 'you' }, toughness: { count: 'objects', filter: { types: ['Creature'] }, who: 'each-opponent' } }, text: 'composition' }] } },
    script: [{ resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 5] }],
  },
  {
    name: 'targets inside four nested containers are keyed apart: a fourth-level target and its third-level sibling each take their own damage', cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: bolt([{ op: 'scoped', who: 'you', do: [{ op: 'scoped', who: 'you', do: [{ op: 'scoped', who: 'you', do: [{ op: 'may', effects: [{ op: 'damage', amount: 1, target: creature }] }, { op: 'damage', amount: 2, target: creature }] }] }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant'], ['Runeclaw Bear']] }, { resolve: true }],
    expect: [{ log: 'deals 1 damage to Hill Giant' }, { zone: ['Runeclaw Bear', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }],
  },
  // ------------------------------------------------------------------ 9.0a review fixes 2: each pick against its own requirement, last known base P/T, targets under the older containers
  {
    name: "multi target checks each pick against its own part: a creature that changed sides no longer satisfies 'creature you control' and is dropped, the other part's target is still hit and the spell does not fizzle", cr: '608.2b',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    // the union of the two parts would still accept Grizzly Bears (it is now a creature P0 doesn't control); CR 608.2b asks for the quality ITS part demanded
    scripts: { ...bolt([{ op: 'damage', amount: 2, target: { kind: 'multi', specs: [T('creature', { controller: 'you' }), T('creature', { controller: 'opponent' })] } }]), 'Runeclaw Bear': { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'gain-control', target: T('creature', { controller: 'opponent' }), duration: 'permanent' }], text: 'composition' }] } },
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears'], ['Hill Giant']] }, { activate: 'Runeclaw Bear', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }, { resolve: true }],
    expect: [{ control: ['Grizzly Bears', 1] }, { zone: ['Grizzly Bears', 'battlefield'] }, { log: 'deals 2 damage to Hill Giant' }, { events: { type: 'damage', min: 1, max: 1 } }, { events: { type: 'fizzle', max: 0 } }],
  },
  {
    name: 'multi target: a pick is never dropped for failing a requirement it did not answer (a player answering the player part, a creature the creature part)', cr: '608.2b',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'damage', amount: 2, target: { kind: 'multi', specs: [T('creature', { controller: 'opponent' }), T('player')] } }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant'], ['P1']] }, { resolve: true }],
    expect: [{ life: [1, 18] }, { log: 'deals 2 damage to Hill Giant' }, { events: { type: 'damage', min: 2, max: 2 } }],
  },
  {
    name: 'last known information keeps the base power a set-pt gave a creature that then left the battlefield: gain life equal to its power gains 6, not the printed 2', cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    scripts: bolt([{ op: 'set-pt', target: creature, power: 6, toughness: 6, base: true, duration: 'eot' }, { op: 'destroy', target: 'target:0' }, { op: 'gain-life', amount: { prop: 'power', of: 'that' }, who: 'you' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { life: [0, 26] }],
  },
  {
    name: "a target inside an older container is asked for at cast time: 'if <condition>, you may destroy target creature' destroys it", cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    // conditional hands `may` its own index; `may` keys the destroy under childIndex of that — targetingEffects walks the same path
    scripts: bolt([{ op: 'conditional', condition: { kind: 'opponents-ge', value: 1 }, then: [{ op: 'may', effects: [{ op: 'destroy', target: creature }] }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }],
  },
  {
    name: "optional-pay's child targets under the container's own index: pay {1} and put a -1/-1 counter on target creature", cr: '115.1',
    seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'optional-pay', mana: { generic: 1, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{1}' }, then: [{ op: 'counters', target: creature, counter: '-1/-1', amount: 1 }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 2, 2] }, { log: 'P0 pays .1. for Lightning Bolt' }],
  },
  // ------------------------------------------------------------------ older containers: soft target requirements
  {
    name: "a conditional's else-branch target requirement is soft: the spell is castable while that branch has no legal target", cr: '601.2c',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    // no artifact anywhere: before the fix the cast was refused because the else requirement had zero options
    scripts: bolt([{ op: 'conditional', condition: { kind: 'total-toughness-ge', value: 1 }, then: [{ op: 'damage', amount: 3, target: creature }], else: [{ op: 'destroy', target: T('artifact') }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: 'the else branch runs with the pick made for it when the condition fails', cr: '608.2b',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    // not kicked: the else branch destroys its target and the then branch never runs (then and else share one index today: HANDOFF §3 item 20)
    scripts: bolt([{ op: 'conditional', condition: { kind: 'kicked' }, then: [{ op: 'damage', amount: 3, target: creature }], else: [{ op: 'destroy', target: creature }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant'], ['Runeclaw Bear']] }, { resolve: true }],
    expect: [{ zone: ['Runeclaw Bear', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }, { pt: ['Hill Giant', 3, 3] }],
  },
  {
    name: "a trigger's auto-picked target sees a hostile effect nested in a conditional and aims it at the opponent", cr: '603.3d',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: { 'Hill Giant': { abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'conditional', condition: { kind: 'total-toughness-ge', value: 1 }, then: [{ op: 'destroy', target: creature }] }], text: 'composition' }] } },
    script: [{ cast: 'Hill Giant' }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Runeclaw Bear', 'graveyard'] }, { zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Hill Giant', 'battlefield'] }],
  },
  // ================================================================== 9.0c: bindings, scopes, filters, targets, amounts, LKI
  // ------------------------------------------------------------------ bindings: every op that acts on objects records them
  {
    name: 'pump binds what it pumped: "it gains haste" after "target creature gets +2/+2" reads the frame', cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'pump', target: creature, power: 2, toughness: 2, duration: 'eot' }, { op: 'grant-keyword', target: 'that', keywords: ['haste'], duration: 'eot' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 5, 5] }, { keywords: ['Hill Giant', ['haste']] }, { unsimulated: 0 }],
  },
  {
    name: 'grant-keyword binds the granted set: "those creatures get +1/+1" after "creatures you control gain flying" is the same set', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: bears([{ op: 'grant-keyword', target: 'creatures-you-control', keywords: ['flying'], duration: 'eot' }, { op: 'pump', target: 'those', power: 1, toughness: 1, duration: 'eot' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 4, 4] }, { keywords: ['Hill Giant', ['flying']] }, { pt: ['Grizzly Bears', 3, 3] }, { pt: ['Runeclaw Bear', 2, 2] }],
  },
  {
    name: "counters binds the object it put counters on: its controller loses life (controller-of-that)", cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'counters', target: creature, counter: '+1/+1', amount: 1 }, { op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: 2, who: 'you' }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 4, 4] }, { life: [1, 18] }, { life: [0, 20] }],
  },
  {
    name: '"Untap all creatures you control. Those creatures get +1/+1": the untapped set is bound (a tapped land is neither untapped nor pumped)', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Mountain'], tapped: ['Hill Giant', 'Mountain'] }, {}],
    scripts: bears([{ op: 'untap', target: 'creatures-you-control' }, { op: 'pump', target: 'those', power: 1, toughness: 1, duration: 'eot' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ tapped: ['Hill Giant', false] }, { pt: ['Hill Giant', 4, 4] }, { tapped: ['Mountain', true] }, { pt: ['Grizzly Bears', 3, 3] }],
  },
  {
    name: 'gain-control binds the stolen creature: "it gains haste" is the creature, not the sorcery', cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'gain-control', target: creature, duration: 'permanent' }, { op: 'grant-keyword', target: 'that', keywords: ['haste'], duration: 'eot' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { keywords: ['Hill Giant', ['haste']] }],
  },
  {
    name: "the sacrifice OP binds what was sacrificed with the values it had: \"you gain life equal to that creature's power\"", cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'sacrifice', who: 'you', what: { types: ['Creature'], other: true }, amount: 1 }, { op: 'gain-life', amount: { prop: 'power', of: 'that' }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [0, 23] }],
  },
  {
    name: 'look-top binds the looked-at card: "you may exile that card" exiles it from the library', cr: '400.7',
    seats: [{ bf: ['Grizzly Bears'], libraryTop: ['Wind Drake'] }, {}],
    scripts: bears([{ op: 'look-top', who: 'you', amount: 1 }, { op: 'move', what: 'that', to: 'exile' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Wind Drake', 'exile'] }, { libraryCount: [0, 20] }],
  },
  {
    name: "counter binds the countered spell with its stack-time controller and mana value: its controller mills, X is the spell's mana value", cr: '608.2h',
    seats: [{ bf: ['Island', 'Island'], hand: ['Counterspell'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    scripts: { Counterspell: { mode: 'replace', abilities: [{ kind: 'spell', effects: [{ op: 'counter', target: T('spell') }, { op: 'scoped', who: 'controller-of-that', do: [{ op: 'mill', amount: 3, who: 'you' }] }, { op: 'token', count: { count: 'mv-of-that' }, power: 1, toughness: 1, colors: [], types: ['Artifact', 'Creature'], subtypes: ['Thopter'], keywords: ['flying'] }], text: 'composition' }] } },
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Counterspell', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { libraryCount: [1, 17] }, { libraryCount: [0, 20] }, { zoneCount: [0, 'battlefield', 6] }, { events: { type: 'countered', min: 1, max: 1 } }],
  },
  {
    name: "bind from targets reads a spell target (a stack ref) as the spell's card: its controller loses life before it is countered", cr: '608.2h',
    seats: [{ bf: ['Island', 'Island'], hand: ['Counterspell'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    scripts: { Counterspell: { mode: 'replace', abilities: [{ kind: 'spell', effects: [{ op: 'bind', as: 'that', from: 'targets' }, { op: 'scoped', who: 'controller-of-that', do: [{ op: 'lose-life', amount: 2, who: 'you' }] }, { op: 'counter', target: T('spell') }], text: 'composition' }] } },
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Counterspell', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { life: [1, 18] }, { life: [0, 20] }],
  },
  // ------------------------------------------------------------------ scopes: target-opponent, owner-of-that, otherwiseAs
  {
    name: 'scoped target-opponent: only an opponent can be chosen, and that player draws (a three-player pod)', cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}, {}],
    scripts: bolt([{ op: 'scoped', who: 'target-opponent', do: [{ op: 'draw', amount: 1, who: 'you' }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['P2']] }, { resolve: true }],
    expect: [{ handCount: [2, 1] }, { handCount: [1, 0] }, { handCount: [0, 0] }],
  },
  {
    name: "scoped owner-of-that: after an exile, \"the exiled card's owner\" gains life", cr: '608.2h',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: bolt([{ op: 'exile', target: creature }, { op: 'scoped', who: 'owner-of-that', do: [{ op: 'gain-life', amount: 3, who: 'you' }] }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'exile'] }, { life: [1, 23] }, { life: [0, 20] }],
  },
  {
    name: "unless-pays with otherwiseAs 'controller': the targeted player cannot pay, so the CONTROLLER draws (Rhystic Study's shape)", cr: '118.12',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: bolt([{ op: 'unless-pays', who: 'target-player', cost: { mana: { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' } }, otherwise: [{ op: 'draw', amount: 1, who: 'you' }], otherwiseAs: 'controller' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ handCount: [0, 1] }, { handCount: [1, 0] }, { log: 'cannot pay' }],
  },
  // ------------------------------------------------------------------ filters: the 9.0c fields
  {
    name: 'Filter.notSubtypes: "destroy each non-Angel creature" spares the Angel', cr: '205.3',
    seats: [{ bf: ['Grizzly Bears', 'Serra Angel'] }, {}],
    scripts: bears([{ op: 'destroy', target: 'all-creatures', filter: { notSubtypes: ['Angel'] } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Serra Angel', 'battlefield'] }],
  },
  {
    name: 'Filter.supertypes: "destroy each legendary creature" takes the legend and spares the rest', cr: '205.4',
    seats: [{ bf: ['Grizzly Bears', 'Isamaru, Hound of Konda'] }, {}],
    scripts: bears([{ op: 'destroy', target: 'all-creatures', filter: { supertypes: ['Legendary'] } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Isamaru, Hound of Konda', 'graveyard'] }, { zone: ['Grizzly Bears', 'battlefield'] }],
  },
  {
    name: 'Filter.notKeywords: "each creature without flying" spares the flier', cr: '702.9',
    seats: [{ bf: ['Grizzly Bears', 'Wind Drake'] }, {}],
    scripts: bears([{ op: 'destroy', target: 'all-creatures', filter: { notKeywords: ['flying'] } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Wind Drake', 'battlefield'] }],
  },
  {
    name: 'Filter.powerEQ / toughnessEQ: "each 3/3 creature"', cr: '208.1',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'destroy', target: 'all-creatures', filter: { powerEQ: 3, toughnessEQ: 3 } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zone: ['Grizzly Bears', 'battlefield'] }],
  },
  {
    name: 'Filter.typesAll: "artifact creature" is both, not either (Ornithopter yes, a plain creature no)', cr: '205.2',
    seats: [{ bf: ['Grizzly Bears', 'Ornithopter'] }, {}],
    scripts: bears([{ op: 'destroy', target: 'all-creatures', filter: { types: ['Artifact', 'Creature'], typesAll: true } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Ornithopter', 'graveyard'] }, { zone: ['Grizzly Bears', 'battlefield'] }],
  },
  {
    name: 'Filter.monocolored / historic: a colourless artifact creature is not monocolored; a legend and an artifact are historic', cr: '105.2',
    seats: [{ bf: ['Grizzly Bears', 'Ornithopter', 'Isamaru, Hound of Konda'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [
      { kind: 'activated', cost: {}, effects: [{ op: 'for-each', over: { types: ['Creature'], monocolored: true, who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] }], text: 'mono' },
      { kind: 'activated', cost: {}, effects: [{ op: 'for-each', over: { historic: true, who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 2 }] }], text: 'historic' },
    ] } },
    script: [{ activate: 'Grizzly Bears', ability: 0 }, { resolve: true }, { activate: 'Grizzly Bears', ability: 1 }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 1 }] }, { counters: ['Ornithopter', { '+1/+1': 2 }] }, { counters: ['Isamaru, Hound of Konda', { '+1/+1': 3 }] }],
  },
  {
    name: 'Filter.enchanted / modified: a creature wearing an Aura is enchanted and modified; a bare one is neither', cr: '702.?',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'], hand: ['Rancor'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [
      { kind: 'activated', cost: {}, effects: [{ op: 'for-each', over: { types: ['Creature'], enchanted: true, who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 1 }] }], text: 'enchanted' },
      { kind: 'activated', cost: {}, effects: [{ op: 'for-each', over: { types: ['Creature'], modified: true, who: 'you' }, do: [{ op: 'counters', target: 'that', counter: '+1/+1', amount: 2 }] }], text: 'modified' },
    ] } },
    script: [{ cast: 'Rancor', targets: [['Hill Giant']] }, { resolve: true }, { activate: 'Grizzly Bears', ability: 0 }, { resolve: true }, { activate: 'Grizzly Bears', ability: 1 }, { resolve: true }],
    expect: [{ attachedTo: ['Rancor', 'Hill Giant'] }, { counters: ['Hill Giant', { '+1/+1': 3 }] }, { counters: ['Grizzly Bears', { '+1/+1': 0 }] }],
  },
  {
    name: 'Filter.dealtDamageBySource: "each creature dealt damage by ~ this turn" is the one it hit, recorded per turn', cr: '120.3',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Hill Giant', 'Runeclaw Bear'] }],
    scripts: { 'Grizzly Bears': { abilities: [
      { kind: 'activated', cost: {}, effects: [{ op: 'damage', amount: 1, target: creature }], text: 'ping' },
      { kind: 'activated', cost: {}, effects: [{ op: 'destroy', target: 'all-creatures', filter: { dealtDamageBySource: true } }], text: 'reap' },
    ] } },
    script: [{ activate: 'Grizzly Bears', ability: 0, targets: [['Hill Giant']] }, { resolve: true }, { activate: 'Grizzly Bears', ability: 1 }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zone: ['Runeclaw Bear', 'battlefield'] }, { zone: ['Grizzly Bears', 'battlefield'] }],
  },
  {
    name: "dies trigger with controller 'opponent': an opponent's creature dying gains life, your own does not", cr: '603.2',
    seats: [{ bf: ['Grizzly Bears', 'Runeclaw Bear', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Hill Giant'] }],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'dies', self: false, filter: { types: ['Creature'] }, controller: 'opponent' }, effects: [{ op: 'gain-life', amount: 1, who: 'you' }], text: 'composition' }] } },
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { cast: 'Shock', targets: [['Runeclaw Bear']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zone: ['Runeclaw Bear', 'graveyard'] }, { life: [0, 21] }],
  },
  // ------------------------------------------------------------------ targets and amounts
  {
    name: 'return-from-graveyard with count 2 and optional: two of three creature cards come back', cr: '601.2c',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Hill Giant', 'Runeclaw Bear', 'Wind Drake'] }, {}],
    scripts: bears([{ op: 'return-from-graveyard', what: { types: ['Creature'] }, to: 'hand', target: true, count: 2, optional: true }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant', 'Wind Drake']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'hand'] }, { zone: ['Wind Drake', 'hand'] }, { zone: ['Runeclaw Bear', 'graveyard'] }, { handCount: [0, 2] }, { graveyardCount: [0, 1] }],
  },
  {
    name: "a graveyard-card target spec with who: 'opponent' offers only the opponents' graveyards", cr: '115.1',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], graveyard: ['Runeclaw Bear'] }, { graveyard: ['Hill Giant'] }],
    scripts: bolt([{ op: 'move', what: { kind: 'graveyard-card', filter: { types: ['Creature'] }, who: 'opponent' }, to: 'battlefield', controller: 'you' }]),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { control: ['Hill Giant', 0] }, { zone: ['Runeclaw Bear', 'graveyard'] }],
  },
  {
    name: "\"up to X target creatures\": the spell's X is the target count", cr: '601.2b',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Blaze'] }, { bf: ['Hill Giant', 'Runeclaw Bear', 'Wind Drake'] }],
    scripts: { Blaze: { mode: 'replace', abilities: [{ kind: 'spell', effects: [{ op: 'destroy', target: T('creature', { count: 'X', optional: true }) }], text: 'composition' }] } },
    script: [{ cast: 'Blaze', x: 2, targets: [['Hill Giant', 'Runeclaw Bear']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zone: ['Runeclaw Bear', 'graveyard'] }, { zone: ['Wind Drake', 'battlefield'] }],
  },
  {
    name: 'aggregate amounts: "the greatest power among creatures you control" and "the total toughness of …"', cr: '107.1',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'lose-life', amount: { prop: 'power', agg: 'max', over: { types: ['Creature'], who: 'you' } }, who: 'you' }, { op: 'gain-life', amount: { prop: 'toughness', agg: 'sum', over: { types: ['Creature'], who: 'you' } }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 22] }],   // 20 − 3 + (2 + 3)
  },
  {
    name: '"that many": the last amount the item evaluated — discard your hand, then draw that many cards', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears'], hand: ['Shock', 'Shock'] }, {}],
    scripts: bears([{ op: 'discard', amount: 'hand', who: 'you' }, { op: 'draw', amount: { count: 'that-many' }, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ handCount: [0, 2] }, { graveyardCount: [0, 2] }, { libraryCount: [0, 18] }],
  },
  {
    name: 'scry takes an Amount: "scry X" looks at X cards', cr: '701.26',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'scry', amount: { count: 'creatures-you-control' } }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ events: { type: 'library', min: 1 } }, { libraryCount: [0, 20] }, { unsimulated: 0 }],
  },
  {
    name: '"that many" under a trigger is the number the event was about: combat damage dealt becomes that many counters', cr: '603.2',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'combat-damage-player', self: true }, effects: [{ op: 'counters', target: 'self', counter: '+1/+1', amount: { count: 'that-many' } }], text: 'composition' }] } },
    script: [{ attack: ['Grizzly Bears'] }, { resolve: true }],
    expect: [{ life: [1, 18] }, { counters: ['Grizzly Bears', { '+1/+1': 2 }] }],
  },
  // ------------------------------------------------------------------ last known information
  {
    name: "power-of-source reads last known information once the source has left: a creature that pumped itself before dying", cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    // "When this creature dies, you gain life equal to its power" after a +2/+0 pump: 4, not the printed 2
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'pump', target: 'self', power: 2, toughness: 0, duration: 'eot' }], text: 'pump' }, { kind: 'triggered', event: { on: 'dies', self: true }, effects: [{ op: 'gain-life', amount: { count: 'power-of-source' }, who: 'you' }], text: 'lki' }] } },
    script: [{ activate: 'Grizzly Bears', ability: 0 }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { life: [0, 24] }],
  },
  // ------------------------------------------------------------------ combat damage assignment (fuzz bucket 450c456a)
  {
    name: 'a double striker blocked by an indestructible 0/1 assigns its regular damage to that blocker and deals none to the player', cr: '510.1c',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Darksteel Myr'], life: 20 }],
    scripts: { 'Grizzly Bears': { keywords: ['double strike'] } },
    script: [attackWith(['Grizzly Bears'], [['Darksteel Myr', 'Grizzly Bears']])],
    expect: [{ life: [1, 20] }, { zone: ['Darksteel Myr', 'battlefield'] }, { zone: ['Grizzly Bears', 'battlefield'] }, { unsimulated: 0 }],
  },
  // ------------------------------------------------------------------ spells as objects: copy-spell, bounce / move off the stack (10.0 author findings)
  {
    name: 'copy-spell copies the targeted spell on the stack (the copy resolves too)', cr: '707.10',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { life: 20 }],
    scripts: bearsFree([{ op: 'copy-spell', target: { kind: 'spell' } }]),
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { activate: 'Grizzly Bears', targets: [['Lightning Bolt']] }, { resolve: true }, { resolve: true }, { resolve: true }],
    expect: [{ life: [1, 14] }, { unsimulated: 0 }],
  },
  {
    name: "bounce through a Ref returns the targeted spell's card to hand and takes the spell off the stack (Narset's Reversal shape)", cr: '608.2b',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Mountain'], hand: ['Shock'], life: 20 }],
    // the opponent's Shock at P0; Bears: "copy target spell, then return it to its owner's hand"
    scripts: bearsFree([{ op: 'copy-spell', target: { kind: 'spell' } }, { op: 'bounce', target: 'target:0', to: 'hand' }]),
    script: [{ cast: 'Shock', by: 1, targets: [['P0']] }, { activate: 'Grizzly Bears', targets: [['Shock']] }, { resolve: true }, { resolve: true }, { resolve: true }],
    expect: [{ life: [0, 18] }, { zone: ['Shock', 'hand'] }, { stackNames: [] }, { unsimulated: 0 }],
  },
  {
    name: "move to hand takes the targeted spell off the stack instead of leaving a resolving item behind", cr: '608.2b',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Mountain'], hand: ['Shock'], life: 20 }],
    scripts: bearsFree([{ op: 'move', what: { kind: 'spell' }, to: 'hand' }]),
    script: [{ cast: 'Shock', by: 1, targets: [['P0']] }, { activate: 'Grizzly Bears', targets: [['Shock']] }, { resolve: true }, { resolve: true }],
    expect: [{ life: [0, 20] }, { zone: ['Shock', 'hand'] }, { stackNames: [] }, { unsimulated: 0 }],
  },
];
