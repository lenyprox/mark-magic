// Owned-collection sweep, batch 4: token copies, proliferate, player (experience) counters, "whenever you attack",
// earthbend with a computed amount, and filter lands. Cards are real (master.db).
import { attackWith, type Scenario } from './dsl.js';

export const owned3: Scenario[] = [
  {
    name: 'Necroduality copies a nontoken Zombie that enters', cr: '707.2',
    seats: [{ bf: ['Necroduality', 'Swamp'], hand: ['Gravecrawler'] }, {}],
    script: [{ cast: 'Gravecrawler' }, { resolve: true }],
    expect: [{ zone: ['Gravecrawler', 'battlefield'] }, { log: /token copy of Gravecrawler/ }, { events: { type: 'create-token', min: 1 } }],
  },
  {
    name: 'Bloated Contaminator proliferates after combat damage', cr: '701.28',
    seats: [{ bf: ['Bloated Contaminator'] }, {}],
    script: [attackWith(['Bloated Contaminator'])],
    expect: [{ log: /proliferates/ }],
  },
  {
    name: 'Toph gets an experience counter whenever a land enters and earthbends that many when attacking',
    seats: [{ bf: ['Toph, Earthbending Master'], hand: ['Forest'] }, {}],
    script: [{ playLand: 'Forest' }, { resolve: true }, attackWith(['Toph, Earthbending Master'])],
    expect: [{ log: /experience counter/ }, { log: /is earthbent/ }],
  },
];
