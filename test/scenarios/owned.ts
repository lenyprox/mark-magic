// Mechanics added for the owned Commander decks (sweeps 5–6): toughness-based combat damage, counter replacement
// effects, commander-identity mana, earthbend, impulse draw, flash grants, lands played from the graveyard and tutors
// to the top of the library. Cards are real (master.db); each scenario cites the rule it pins.
import { attackWith, type Scenario } from './dsl.js';

export const owned: Scenario[] = [
  {
    name: 'Bedrock Tortoise assigns combat damage equal to its toughness', cr: '510.1a',
    seats: [{ bf: ['Bedrock Tortoise'] }, {}],
    script: [attackWith(['Bedrock Tortoise'])],
    expect: [{ life: [1, 14] }],
  },
  {
    name: 'Hardened Scales adds one to +1/+1 counters placed on a creature you control', cr: '614.1c',
    seats: [{ bf: ['Hardened Scales', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Walking Ballista'] }, {}],
    script: [{ cast: 'Walking Ballista', x: 2 }, { resolve: true }],
    expect: [{ counters: ['Walking Ballista', { '+1/+1': 3 }] }],
  },
  {
    name: "Command Tower adds mana of the commander's colour identity", cr: '903.4',
    format: 'commander',
    seats: [{ command: ['Varina, Lich Queen'], bf: ['Command Tower', 'Swamp'], hand: ['Doom Blade'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Doom Blade', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { tapped: ['Command Tower', true] }],
  },
  {
    name: 'Earthbend turns a land into a 0/0 Elemental creature with +1/+1 counters',
    seats: [{ bf: ['Forest', 'Forest', 'Forest'], hand: ['Earthbending Student'] }, {}],
    script: [{ cast: 'Earthbending Student' }, { resolve: true }],
    expect: [{ log: /is earthbent/ }, { zone: ['Earthbending Student', 'battlefield'] }],
  },
  {
    name: 'Impulse draw: exiled cards may be cast from exile until the end of the next turn',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain'], hand: ["Wrenn's Resolve"], libraryTop: ['Lightning Bolt', 'Grizzly Bears', 'Mountain'] }, {}],
    script: [{ cast: "Wrenn's Resolve" }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'exile'] }, { zone: ['Lightning Bolt', 'graveyard'] }, { life: [1, 17] }],
  },
  {
    name: 'Ancient Greenwarden lets you play lands from your graveyard', cr: '305.1',
    seats: [{ bf: ['Ancient Greenwarden'], graveyard: ['Forest'] }, {}],
    script: [{ playLand: 'Forest' }],
    expect: [{ zone: ['Forest', 'battlefield'] }],
  },
  {
    name: 'Vampiric Tutor puts the found card on top after shuffling and costs 2 life',
    seats: [{ bf: ['Swamp'], hand: ['Vampiric Tutor'], libraryTop: ['Forest', 'Forest', 'Forest'] }, {}],
    script: [{ cast: 'Vampiric Tutor' }, { resolve: true }],
    expect: [{ log: /on top of their library/ }, { life: [0, 18] }],
  },
];
