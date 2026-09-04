// "for each" amounts: characteristic-defining power, life gain and cost reduction that scale with the board.
import { type Scenario } from './dsl.js';

export const foreach: Scenario[] = [
  {
    name: 'Wight of the Reliquary grows with creature cards in the graveyard', cr: '613.4',
    seats: [{ bf: ['Wight of the Reliquary'], graveyard: ['Grizzly Bears', 'Hill Giant', 'Lightning Bolt'] }, {}],
    script: [{ sba: true }],
    expect: [{ pt: ['Wight of the Reliquary', 4, 4] }],
  },
  {
    name: 'Haughty Djinn counts instants and sorceries in the graveyard',
    seats: [{ bf: ['Haughty Djinn'], graveyard: ['Lightning Bolt', 'Counterspell', 'Grizzly Bears'] }, {}],
    script: [{ sba: true }],
    expect: [{ pt: ['Haughty Djinn', 2, 4] }],
  },
  {
    name: 'Congregate gains two life for each creature on the battlefield',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Grizzly Bears'], hand: ['Congregate'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Congregate', targets: [['P0']] }, { resolve: true }],
    expect: [{ life: [0, 24] }],
  },
  {
    name: 'Cabal Coffers funds itself and adds one black mana per Swamp',
    seats: [{ bf: ['Cabal Coffers', 'Swamp', 'Swamp', 'Swamp', 'Island', 'Island'], hand: ['Sign in Blood'] }, {}],
    script: [{ cast: 'Sign in Blood', targets: [['P1'], ['P1']] }, { resolve: true }],
    expect: [{ zone: ['Sign in Blood', 'graveyard'] }, { life: [1, 18] }],
  },
  {
    name: 'A filter land funds itself to pay a double-coloured cost',
    seats: [{ bf: ['Cascade Bluffs', 'Island'], hand: ['Counterspell'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['P0']] }, { cast: 'Counterspell', by: 0, targets: [['Lightning Bolt']] }, { resolve: true }],
    expect: [{ zone: ['Lightning Bolt', 'graveyard'] }, { life: [0, 20] }],
  },
  {
    name: 'Cryptolith Rite grants every creature you control a mana ability',
    seats: [{ bf: ['Cryptolith Rite', 'Grizzly Bears', 'Hill Giant'], hand: ['Lightning Bolt'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ zone: ['Lightning Bolt', 'graveyard'] }, { life: [1, 17] }],
  },
];
