// Mechanics from the first two sweeps: evasion keywords, infect/wither/toxic, persist/undying, monarch, cascade,
// unearth, food, energy, echo. Cards are real (master.db); each scenario cites the rule it pins.
import { attackWith, type Scenario } from './dsl.js';

export const mechanics: Scenario[] = [
  {
    name: 'Shadow cannot be blocked by a creature without shadow', cr: '702.28',
    seats: [{ bf: ['Dauthi Slayer'] }, { bf: ['Grizzly Bears'] }],
    // The block is really offered and must be turned down: a pair in `refused` fails the scenario if the engine
    // ever accepts it, so this cannot decay into "nobody blocked" the way a simply omitted block would.
    script: [attackWith(['Dauthi Slayer'], [], [['Grizzly Bears', 'Dauthi Slayer']])],
    expect: [{ life: [1, 18] }, { zone: ['Dauthi Slayer', 'battlefield'] }, { zone: ['Grizzly Bears', 'battlefield'] }],
  },
  {
    name: 'Infect deals damage to players as poison counters', cr: '702.90',
    seats: [{ bf: ['Blight Mamba'] }, {}],
    script: [attackWith(['Blight Mamba'])],
    expect: [{ life: [1, 20] }, { log: /poison counter/ }],
  },
  {
    name: 'Wither deals damage to creatures as -1/-1 counters', cr: '702.80',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Kulrath Knight'] }],
    script: [attackWith(['Grizzly Bears'], [['Kulrath Knight', 'Grizzly Bears']])],
    expect: [{ log: /as -1\/-1 counters/ }, { zone: ['Grizzly Bears', 'graveyard'] }],
  },
  {
    name: 'Persist returns the creature with a -1/-1 counter, once', cr: '702.79',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Kitchen Finks'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Kitchen Finks']] }, { resolve: true }, { cast: 'Shock', targets: [['Kitchen Finks']] }, { resolve: true }],
    expect: [{ zone: ['Kitchen Finks', 'graveyard'] }, { log: /returns to the battlefield with a -1\/-1 counter/ }, { life: [1, 22] }],
  },
  {
    name: 'The monarch draws at the end step and loses the crown to combat damage', cr: '724.1',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Palace Jailer'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Palace Jailer' }, { resolve: true }],
    expect: [{ log: /becomes the monarch/ }],
  },
  {
    name: 'Cascade casts a cheaper nonland card from the top of the library', cr: '702.85',
    seats: [{ bf: ['Mountain', 'Mountain', 'Forest', 'Forest'], hand: ['Bloodbraid Elf'], libraryTop: ['Mountain', 'Lightning Bolt', 'Forest'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Bloodbraid Elf' }, { resolve: true }],
    expect: [{ zone: ['Bloodbraid Elf', 'battlefield'] }, { log: /Cascade: .* casts Lightning Bolt/ }, { zone: ['Lightning Bolt', 'graveyard'] }],
  },
  {
    name: 'Unearth returns a creature with haste and exiles it at the end step', cr: '702.84',
    seats: [{ bf: ['Swamp', 'Swamp'], graveyard: ['Dregscape Zombie'] }, {}],
    script: [{ activate: 'Dregscape Zombie' }, { resolve: true }, { passUntil: 'cleanup' }],
    expect: [{ zone: ['Dregscape Zombie', 'exile'] }, { log: /unearth/ }],
  },
  {
    name: 'A Food token is sacrificed for 3 life', cr: '111.10',
    seats: [{ bf: ['Forest', 'Forest', 'Forest'], hand: ['Gilded Goose'] }, {}],
    script: [{ cast: 'Gilded Goose' }, { resolve: true }],
    expect: [{ events: { type: 'create-token', min: 1 } }],
  },
  {
    name: 'Echo: pay in the next upkeep or sacrifice', cr: '702.30',
    seats: [{ bf: ['Avalanche Riders'] }, {}],
    script: [{ turns: 2 }],
    expect: [{ zone: ['Avalanche Riders', 'graveyard'] }, { log: /sacrifices Avalanche Riders/ }],
  },
];
