// Owned-collection sweep, batch 3: graveyard-leave and discard triggers with filters, filtered combat-damage triggers,
// two-tribe anthems, anthems that work from the graveyard, and casting from the graveyard under a condition.
import { attackWith, type Scenario } from './dsl.js';

export const owned2: Scenario[] = [
  {
    name: 'Quintorius makes a Spirit when cards leave your graveyard',
    seats: [{ bf: ['Quintorius, Field Historian', 'Swamp', 'Swamp', 'Swamp'], hand: ['Reanimate'], graveyard: ['Grizzly Bears'] }, {}],
    script: [{ cast: 'Reanimate', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { events: { type: 'create-token', min: 1 } }],
  },
  {
    name: 'Bone Miser triggers only on the matching discarded card type',
    seats: [{ bf: ['Bone Miser', 'Mountain', 'Swamp'], hand: ['Faithless Looting', 'Forest', 'Grizzly Bears'] }, {}],
    script: [{ cast: 'Faithless Looting' }, { resolve: true }],
    expect: [{ events: { type: 'create-token', min: 1, max: 1 } }, { log: /adds \{B\}\{B\}|Bone Miser/ }],
  },
  {
    name: 'Ohran Frostfang draws when any creature you control connects', cr: '603.2',
    seats: [{ bf: ['Ohran Frostfang', 'Grizzly Bears'] }, {}],
    script: [attackWith(['Grizzly Bears'])],
    expect: [{ life: [1, 18] }, { events: { type: 'draw', min: 1 } }],
  },
  {
    name: 'Death Baron pumps Skeletons and other Zombies and grants deathtouch',
    seats: [{ bf: ['Death Baron', 'Gravecrawler'] }, {}],
    script: [{ sba: true }],
    expect: [{ pt: ['Gravecrawler', 3, 2] }, { keywords: ['Gravecrawler', ['deathtouch']] }, { pt: ['Death Baron', 2, 2] }],
  },
  {
    name: 'Anger grants haste from the graveyard while you control a Mountain', cr: '113.6',
    seats: [{ bf: ['Mountain', 'Grizzly Bears'], graveyard: ['Anger'] }, {}],
    script: [{ sba: true }],
    expect: [{ keywords: ['Grizzly Bears', ['haste']] }],
  },
  {
    name: 'Gravecrawler can be cast from the graveyard while you control a Zombie',
    seats: [{ bf: ['Swamp', 'Death Baron'], graveyard: ['Gravecrawler'] }, {}],
    script: [{ cast: 'Gravecrawler' }, { resolve: true }],
    expect: [{ zone: ['Gravecrawler', 'battlefield'] }],
  },

  {
    name: 'Firebending mana stays in the pool until end of turn',
    seats: [{ bf: ['Mai and Zuko'], hand: ['Lightning Bolt'] }, {}],
    script: [attackWith(['Mai and Zuko']), { cast: 'Lightning Bolt', targets: [['P1']], by: 0 }, { resolve: true }],
    expect: [{ life: [1, 14] }, { zone: ['Lightning Bolt', 'graveyard'] }],
  },
];
