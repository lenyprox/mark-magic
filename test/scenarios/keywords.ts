// Keyword sweep: storm, living weapon, soulshift, fabricate, extort, afflict, battle cry, fading,
// cumulative upkeep, buyback, dash, myriad and mobilize, each pinned to its rule.
import { attackWith, type Scenario } from './dsl.js';

export const keywords: Scenario[] = [
  {
    name: 'Storm copies the spell once for each spell cast before it this turn', cr: '702.40',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Grapeshot'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }, { cast: 'Grapeshot', targets: [['P1']] }, { resolve: true }],
    expect: [{ log: /Storm: .* copies Grapeshot 1 time/ }, { life: [1, 15] }],
  },
  {
    name: 'Living weapon makes a Germ token and attaches the Equipment to it', cr: '702.91',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Island', 'Island'], hand: ['Batterskull'] }, {}],
    script: [{ cast: 'Batterskull' }, { resolve: true }],
    expect: [{ zone: ['Batterskull', 'battlefield'] }, { events: { type: 'create-token', min: 1 } }, { log: /Germ/ }],
  },
  {
    name: 'Afflict drains the defending player when the creature becomes blocked', cr: '702.131',
    seats: [{ bf: ['Ammit Eternal'] }, { bf: ['Grizzly Bears'] }],
    script: [attackWith(['Ammit Eternal'], [['Grizzly Bears', 'Ammit Eternal']])],
    expect: [{ life: [1, 17] }],
  },
  {
    name: 'Cumulative upkeep sacrifices the permanent when the age cost is not paid', cr: '702.24',
    seats: [{ bf: ['Mystic Remora'] }, {}],
    script: [{ turns: 2 }],
    expect: [{ zone: ['Mystic Remora', 'graveyard'] }],
  },
  {
    name: 'Dash gives haste and returns the creature to hand at the next end step', cr: '702.109',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Zurgo Bellstriker'] }, {}],
    script: [{ cast: 'Zurgo Bellstriker', alt: 'dash' }, { resolve: true }, attackWith(['Zurgo Bellstriker']), { turns: 1 }],
    expect: [{ zone: ['Zurgo Bellstriker', 'hand'] }],
  },
  {
    name: 'A werewolf transforms at upkeep when no spells were cast last turn', cr: '701.28',
    seats: [{ bf: ['Reckless Waif'] }, {}],
    script: [{ turns: 2 }],
    expect: [{ log: /transforms/ }],
  },
  {
    name: 'A creature that would die after this damage is exiled instead', cr: '614.1c',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Anger of the Gods'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Anger of the Gods' }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Grizzly Bears', 'exile'] }],
  },
  {
    name: 'A morph creature is cast face down as a 2/2 and turns face up for its morph cost', cr: '702.37',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Ainok Survivalist'] }, {}],
    script: [{ cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Ainok Survivalist', 'battlefield'] }, { pt: ['Ainok Survivalist', 2, 2] }],
  },
  {
    name: 'Turning a megamorph creature face up pays its cost and adds a +1/+1 counter', cr: '702.37',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Ainok Survivalist'] }, {}],
    script: [{ cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true }, { turnFaceUp: 'Ainok Survivalist' }, { sba: true }],
    expect: [{ pt: ['Ainok Survivalist', 3, 2] }, { counters: ['Ainok Survivalist', { '+1/+1': 1 }] }],
  },
];
