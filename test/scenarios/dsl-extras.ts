// One scenario per expectation kind added in phase 8d, so the DSL vocabulary itself is covered by the same harness
// it powers. Every scenario uses fully simulated cards and asserts something the ability actually changed.
import { attackWith, type Scenario } from './dsl.js';

export const dslExtras: Scenario[] = [
  {
    name: 'playerCounters: Meren gives an experience counter when a creature you control dies', cr: '122.1',
    seats: [{ bf: ['Meren of Clan Nel Toth', 'Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ playerCounters: [0, { experience: 1 }] }, { playerCounters: [1, { experience: 0 }] }, { zone: ['Grizzly Bears', 'graveyard'] }],
  },
  {
    name: 'zoneCount: Wrath of God empties both battlefields of creatures', cr: '701.7',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Wrath of God'] }, { bf: ['Grizzly Bears', 'Hill Giant'] }],
    script: [{ cast: 'Wrath of God' }, { resolve: true }],
    expect: [{ zoneCount: [1, 'battlefield', 0] }, { zoneCount: [1, 'graveyard', 2] }, { zoneCount: [0, 'stack', 0] }],
  },
  {
    name: 'handCount: Divination draws exactly two cards', cr: '121.3',
    seats: [{ bf: ['Island', 'Island', 'Island'], hand: ['Divination'] }, {}],
    script: [{ cast: 'Divination' }, { resolve: true }],
    expect: [{ handCount: [0, 2] }, { handCount: [1, 0] }],
  },
  {
    name: 'graveyardCount: the burn spell and its victim both end up in graveyards', cr: '608.2m',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ graveyardCount: [0, 1] }, { graveyardCount: [1, 1] }],
  },
  {
    name: 'libraryCount: Divination takes two cards off the top of the library', cr: '121.3',
    seats: [{ bf: ['Island', 'Island', 'Island'], hand: ['Divination'] }, {}],
    script: [{ cast: 'Divination' }, { resolve: true }],
    expect: [{ libraryCount: [0, 18] }, { libraryCount: [1, 20] }],
  },
  {
    name: 'stackNames: Counterspell sits on top of the spell it targets', cr: '405.2',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Island', 'Island'], hand: ['Counterspell'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { cast: 'Counterspell', targets: [['Lightning Bolt']], by: 1 }],
    expect: [{ stackNames: ['Counterspell', 'Lightning Bolt'] }, { stack: 2 }],
  },
  {
    name: 'mana: two Lotus Petals leave one white and one red mana in the pool', cr: '106.4',
    seats: [{ bf: ['Lotus Petal', 'Lotus Petal'] }, {}],
    script: [{ answer: 'W' }, { activate: 'Lotus Petal' }, { activate: 'Lotus Petal' }],
    expect: [{ mana: [0, 'RW'] }, { mana: [1, ''] }, { graveyardCount: [0, 2] }],
  },
  {
    name: 'attachedTo: Rancor attaches to the creature it enchants', cr: '303.4',
    seats: [{ bf: ['Forest', 'Grizzly Bears'], hand: ['Rancor'] }, {}],
    script: [{ cast: 'Rancor', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ attachedTo: ['Rancor', 'Grizzly Bears'] }, { pt: ['Grizzly Bears', 4, 2] }, { attachedTo: ['Grizzly Bears', null] }],
  },
  {
    name: 'faceDown: a morph creature is cast as a face-down 2/2', cr: '708.2',
    seats: [{ bf: ['Forest', 'Forest', 'Forest'], hand: ['Ainok Survivalist'] }, {}],
    script: [{ cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true }],
    expect: [{ faceDown: ['Ainok Survivalist', true] }, { pt: ['Ainok Survivalist', 2, 2] }],
  },
  {
    name: 'commanderDamage: combat damage from a commander is tracked per seat', cr: '704.6c',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], command: ['The Whizzer, Classic Speedster'] }, {}],
    format: 'commander',
    script: [{ cast: 'The Whizzer, Classic Speedster' }, { resolve: true }, attackWith(['The Whizzer, Classic Speedster'])],
    expect: [{ commanderDamage: [1, 'The Whizzer, Classic Speedster', 3] }, { commanderDamage: [0, 'The Whizzer, Classic Speedster', 0] }, { life: [1, 37] }],
  },
  {
    // The same pattern really does match when the creature dies — test/scenario-dsl.test.ts pins that, so this
    // noLog is a live assertion and not a regex that could never fire.
    name: 'noLog: two damage does not destroy a 3/3', cr: '704.5g',
    seats: [{ bf: ['Mountain'], hand: ['Shock'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Shock', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { noLog: 'Hill Giant is destroyed' }, { log: 'deals 2 damage' }],
  },
  {
    // Seat 1 attacks: the engine sends the attackers at seat 2, so seat 2 declares the block even though seat 0 has
    // a creature of the same name. With the defending seat mistaken for seat 1's "other" seat, seat 0's Hill Giant
    // would block and seat 2 would be at 18.
    name: 'attack: in a three-player game only the defending seat blocks', cr: '509.1a',
    seats: [{ bf: ['Hill Giant'] }, { bf: ['Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    active: 1,
    script: [attackWith(['Grizzly Bears'], [['Hill Giant', 'Grizzly Bears']])],
    expect: [{ life: [2, 20] }, { life: [0, 20] }, { life: [1, 20] }, { zoneCount: [1, 'graveyard', 1] }, { zoneCount: [0, 'battlefield', 1] }, { zoneCount: [2, 'battlefield', 1] }],
  },
  {
    name: 'ext: a permanent carries no engine extension data by default', cr: '110.1',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    script: [{ sba: true }],
    expect: [{ ext: ['Grizzly Bears', 'anything', undefined] }],
  },
];
