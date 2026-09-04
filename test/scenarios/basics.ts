// Behavioural scenarios for rules the engine already implements. Each pins a CR number so failures read as rules
// regressions. Cards are looked up in master.db by name (the DB-backed suite skips when it is absent).
import { attackWith, type Scenario } from './dsl.js';

export const basics: Scenario[] = [
  {
    name: 'Lightning Bolt kills Grizzly Bears (lethal damage SBA)', cr: '704.5g',
    seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Lightning Bolt', 'graveyard'] }, { events: { type: 'damage', min: 1, max: 1 } }, { log: /is destroyed/ }, { unsimulated: 0 }],
  },
  {
    name: 'Lightning Bolt to the face', cr: '120.3',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 17] }, { events: { type: 'damage', min: 1 } }],
  },
  {
    name: 'Giant Growth in response saves the Bears', cr: '608.2b',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Forest', 'Grizzly Bears'], hand: ['Giant Growth'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { cast: 'Giant Growth', targets: [['Grizzly Bears']], by: 1 }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { pt: ['Grizzly Bears', 5, 5] }, { counters: ['Grizzly Bears', {}] }],
  },
  {
    name: 'Counterspell counters Lightning Bolt', cr: '701.5a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Island', 'Island'], hand: ['Counterspell'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { cast: 'Counterspell', targets: [['Lightning Bolt']], by: 1 }, { resolve: true }],
    expect: [{ life: [1, 20] }, { zone: ['Lightning Bolt', 'graveyard'] }, { zone: ['Counterspell', 'graveyard'] }, { events: { type: 'countered', min: 1, max: 1 } }, { stack: 0 }],
  },
  {
    name: 'A spell whose only target left fizzles', cr: '608.2b',
    seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { cast: 'Shock', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { events: { type: 'fizzle', min: 1, max: 1 } }, { log: /fizzles/ }],
  },
  {
    name: 'Unblocked attacker deals combat damage; blocked one trades', cr: '510.1',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    script: [attackWith(['Grizzly Bears', 'Hill Giant'], [['Grizzly Bears', 'Grizzly Bears']])],
    expect: [{ life: [1, 17] }, { events: { type: 'attack', min: 1 } }, { events: { type: 'block', min: 1 } }],
  },
  {
    name: 'Legend rule puts the older copy in the graveyard', cr: '704.5j',
    seats: [{ bf: ['Isamaru, Hound of Konda', 'Isamaru, Hound of Konda'] }, {}],
    script: [{ sba: true }],
    expect: [{ events: { type: 'sba', min: 1 } }, { log: /Legend rule/ }],
  },
  {
    name: '+1/+1 and -1/-1 counters cancel', cr: '704.5q',
    seats: [{ bf: ['Grizzly Bears'], counters: { 'Grizzly Bears': { '+1/+1': 2, '-1/-1': 1 } } }, {}],
    script: [{ sba: true }],
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 1, '-1/-1': 0 }] }, { pt: ['Grizzly Bears', 3, 3] }],
  },
  {
    name: 'Indestructible survives destroy', cr: '702.12b',
    seats: [{ bf: ['Swamp', 'Swamp'], hand: ['Doom Blade'] }, { bf: ['Darksteel Colossus'] }],
    script: [{ cast: 'Doom Blade', targets: [['Darksteel Colossus']] }, { resolve: true }],
    expect: [{ zone: ['Darksteel Colossus', 'battlefield'] }, { events: { type: 'replaced', min: 1 } }],
  },
  {
    name: 'Life gain and Wrath: sweeper destroys every creature', cr: '701.7',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Grizzly Bears'], hand: ['Wrath of God'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Wrath of God' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { zone: ['Hill Giant', 'graveyard'] }, { events: { type: 'zone-change', min: 3 } }],
  },
  {
    name: 'Opt scries, then draws', cr: '701.22',
    seats: [{ bf: ['Island'], hand: ['Opt'] }, {}],
    script: [{ cast: 'Opt' }, { resolve: true }],
    expect: [{ events: { type: 'library', min: 1 } }],
  },
];
