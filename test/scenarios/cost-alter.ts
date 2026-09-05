// cost-alter (Phase 9.1, docs/vocabulary/cost-alter.md): one scenario per op, per static, per cost part, per amount
// and per target kind the family registers, plus one per keyword parameter that changes what happens.
//
// Wherever a printed card now parses into the family's vocabulary the scenario uses that card (Bone Picker, Highspire
// Bell-Ringer, Patrician Geist, Sea Gate Colossus, Fireblast, Gush, Qarsi Revenant, Drivnod, Windbrisk Heights,
// Electrodominance): those runs test the parser rule and the engine together. The four shapes no printed card parses
// into yet — the `cast-from` permission, a cost tax on an opponent's spells, `cast-free` from the cards exiled with
// the source, and the `exiled-with-card` target — are scripted onto Grizzly Bears through the DSL's `scripts` field.
//
// Every expectation fails if the alteration did nothing: a discount is always paired with a board that has exactly
// the mana the discounted cost needs (without it there is no legal cast at all and the run throws), and a tax is
// measured by floating the mana first and asserting the pool is empty afterwards.
import type { Effect, StaticEffect } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains a free (no-cost) activated ability, so it can be used the turn it is scripted in. */
const bearsAbility = (effects: Effect[], text = 'cost-alter'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** Grizzly Bears gains a static ability. */
const bearsStatic = (effect: StaticEffect, text = 'cost-alter'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'static', effect, text }] } });

export const costAlter: Scenario[] = [
  // ------------------------------------------------------------------ the `cost-alter` static
  {
    name: 'Bone Picker costs {3} less once a creature has died this turn (a conditional self cost alteration)', cr: '601.2f',
    ruling: 'Cost reductions are applied as the total cost is determined; Bone Picker is castable for {B} alone after a creature died.',
    seats: [{ bf: ['Swamp', 'Mountain'], hand: ['Bone Picker', 'Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    script: [
      { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Bone Picker' }, { resolve: true },
    ],
    expect: [
      { zone: ['Grizzly Bears', 'graveyard'] },
      { zone: ['Bone Picker', 'battlefield'] },       // only the {3} reduction makes {3}{B} payable with one Swamp
      { pt: ['Bone Picker', 3, 2] },
      { unsimulated: 0 },
    ],
  },
  {
    name: "a {2} tax on opponents' spells eats the X of their X spell (the `more` direction)", cr: '601.2f',
    ruling: 'An increase applies after reductions and before the cost is paid, so with four lands the largest payable X is 0 rather than 2.',
    active: 1,
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Electrodominance'] }],
    scripts: bearsStatic({ kind: 'cost-alter', amount: 2, more: true, who: 'opponent' }, 'Spells your opponents cast cost {2} more to cast.'),
    script: [{ cast: 'Electrodominance', targets: [['P0']] }, { resolve: true }],
    expect: [
      { life: [0, 20] },                              // untaxed, {X}{R}{R} with four lands would be X = 2
      { zone: ['Electrodominance', 'graveyard'] },
      { events: { type: 'damage', min: 0, max: 0 } },
    ],
  },
  {
    name: "Patrician Geist makes Firebolt's flashback cost {1} less (a cost alteration keyed to the cast zone)", cr: '601.2f',
    ruling: '"Spells you cast from your graveyard cost {1} less to cast" applies to the flashback cost, so {4}{R} is payable with four lands.',
    seats: [{ bf: ['Patrician Geist', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], graveyard: ['Firebolt'] }, {}],
    script: [{ cast: 'Firebolt', alt: 'flashback', targets: [['P1']] }, { resolve: true }],
    expect: [
      { life: [1, 18] },
      { zone: ['Firebolt', 'exile'] },                // flashback exiles it (CR 702.34a)
    ],
  },
  {
    name: 'Highspire Bell-Ringer discounts the second spell of the turn and not the first', cr: '601.2f',
    ruling: 'Hill Giant is the second spell cast this turn, so it costs {2}{R} instead of {3}{R}.',
    seats: [{ bf: ['Highspire Bell-Ringer', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Hill Giant'] }, {}],
    script: [
      { cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true },
      { cast: 'Hill Giant' }, { resolve: true },
    ],
    expect: [
      { life: [1, 17] },
      { zone: ['Hill Giant', 'battlefield'] },        // three untapped lands are left; only the discount makes it castable
      { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ the `party` amount (CR 700.7)
  {
    name: 'Sea Gate Colossus costs {1} less for each of the four creatures in a full party', cr: '700.7',
    ruling: 'A full party is one Cleric, one Rogue, one Warrior and one Wizard, so {7} becomes {3}.',
    seats: [{ bf: ['Death Speakers', 'Bane Alley Blackguard', 'Oreskos Swiftclaw', 'Fugitive Wizard', 'Mountain', 'Mountain', 'Mountain'], hand: ['Sea Gate Colossus'] }, {}],
    script: [{ cast: 'Sea Gate Colossus' }, { resolve: true }],
    expect: [{ zone: ['Sea Gate Colossus', 'battlefield'] }, { pt: ['Sea Gate Colossus', 7, 5] }, { unsimulated: 0 }],
  },
  {
    name: 'two Rogues and a Cleric are a party of two, not of three', cr: '700.7',
    ruling: 'Each party slot is filled by at most one creature and each creature fills at most one slot, so {7} becomes {5}.',
    seats: [{ bf: ['Bane Alley Blackguard', 'Vampire Cutthroat', 'Death Speakers', 'Plains', 'Island', 'Swamp', 'Mountain', 'Forest'], hand: ['Sea Gate Colossus'] }, {}],
    script: [{ cast: 'Sea Gate Colossus' }, { resolve: true }],
    expect: [
      { zone: ['Sea Gate Colossus', 'battlefield'] },
      // {7} less a party of two is {5}: every one of the five lands is tapped. Counting the two Rogues separately
      // would have made it {3} and left two of them untapped.
      { tapped: ['Plains', true] }, { tapped: ['Island', true] }, { tapped: ['Swamp', true] }, { tapped: ['Mountain', true] }, { tapped: ['Forest', true] },
    ],
  },

  // ------------------------------------------------------------------ cost parts
  {
    name: 'Fireblast is cast by sacrificing two Mountains instead of paying its mana cost', cr: '118.9',
    ruling: 'An alternative cost replaces the mana cost; the two Mountains are sacrificed as the cost is paid.',
    seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Fireblast'] }, {}],
    script: [{ cast: 'Fireblast', alt: 'pitch', targets: [['P1']] }, { resolve: true }],
    expect: [
      { life: [1, 16] },
      { zoneCount: [0, 'battlefield', 0] },           // both Mountains were really sacrificed
      { graveyardCount: [0, 3] },                     // two Mountains and Fireblast
    ],
  },
  {
    name: 'Gush is cast by returning two Islands to their owner\'s hand instead of paying its mana cost', cr: '118.9',
    ruling: 'The two Islands are returned as the alternative cost is paid, so they are in hand alongside the two cards drawn.',
    seats: [{ bf: ['Island', 'Island'], hand: ['Gush'] }, {}],
    script: [{ cast: 'Gush', alt: 'pitch' }, { resolve: true }],
    expect: [
      { zoneCount: [0, 'battlefield', 0] },
      { handCount: [0, 4] },                          // the two Islands plus the two cards Gush draws
      { zone: ['Gush', 'graveyard'] },
    ],
  },
  {
    name: 'Qarsi Revenant is exiled from the graveyard to pay for its own ability', cr: '118.3',
    ruling: 'Exiling the card is part of the cost, so the ability still resolves after the source has left the graveyard.',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp'], graveyard: ['Qarsi Revenant'] }, { bf: ['Grizzly Bears'] }],
    script: [{ activate: 'Qarsi Revenant', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [
      { zone: ['Qarsi Revenant', 'exile'] },
      { counters: ['Grizzly Bears', { flying: 1, deathtouch: 1, lifelink: 1 }] },
      { keywords: ['Grizzly Bears', ['flying', 'deathtouch', 'lifelink']] },
    ],
  },
  {
    name: 'Drivnod exiles three creature cards from the graveyard as a cost', cr: '118.3',
    ruling: 'The cost names a count and a filter; all three creature cards leave the graveyard and the counter is put on.',
    seats: [{ bf: ['Drivnod, Carnage Dominus', 'Swamp', 'Swamp'], graveyard: ['Grizzly Bears', 'Hill Giant', 'Runeclaw Bear'] }, {}],
    script: [{ activate: 'Drivnod, Carnage Dominus' }, { resolve: true }],
    expect: [
      { graveyardCount: [0, 0] },
      { counters: ['Drivnod, Carnage Dominus', { indestructible: 1 }] },
    ],
  },
  {
    name: 'Inquisitive Puppet exiles itself to pay for its ability', cr: '118.3',
    ruling: 'The "Exile this creature" cost moves the source to exile as the ability is activated; the ability still resolves.',
    seats: [{ bf: ['Inquisitive Puppet'] }, {}],
    script: [{ activate: 'Inquisitive Puppet', ability: 1 }, { resolve: true }],
    expect: [
      { zoneCount: [0, 'exile', 1] },                 // the card itself paid the cost
      { zoneCount: [0, 'battlefield', 1] },           // all that is left is the 1/1 Human token the ability created
      { pt: ['Inquisitive Puppet', 1, 1] },           // the token (the printed card is a 0/2), so the source really left
      { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ hideaway and the exiled card
  {
    name: 'Hideaway 4 exiles one of the top four cards and puts the rest on the bottom', cr: '702.75a',
    ruling: 'Hideaway looks at the top four cards, exiles one, and the other three go to the bottom of the library.',
    seats: [{ hand: ['Windbrisk Heights'], libraryTop: ['Lightning Bolt'] }, {}],
    script: [{ playLand: 'Windbrisk Heights' }, { resolve: true }],
    expect: [
      { zone: ['Lightning Bolt', 'exile'] },
      { zoneCount: [0, 'exile', 1] },
      { libraryCount: [0, 20] },                      // 21 cards, four looked at, three put back
      { tapped: ['Windbrisk Heights', true] },
    ],
  },
  {
    name: 'the card hidden away with a permanent can be cast from exile without paying its mana cost', cr: '702.75b',
    ruling: 'The permission is about the cards exiled with the source, and the spell is cast during the ability\'s resolution.',
    seats: [{ bf: ['Forest', 'Mountain'], hand: ['Grizzly Bears'], libraryTop: ['Lightning Bolt'] }, {}],
    scripts: {
      'Grizzly Bears': {
        abilities: [
          { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'hideaway', count: 4 }], text: 'Hideaway 4' },
          { kind: 'activated', cost: {}, effects: [{ op: 'cast-free', from: 'exiled-with', filter: { types: ['Instant'] }, optional: true }], text: 'You may play the exiled card without paying its mana cost.' },
        ],
      },
    },
    script: [
      { cast: 'Grizzly Bears' }, { resolve: true },
      { activate: 'Grizzly Bears' }, { resolve: true },
      { resolve: true },
    ],
    expect: [
      { life: [1, 17] },                              // the free Lightning Bolt resolved
      { zone: ['Lightning Bolt', 'graveyard'] },
      { zoneCount: [0, 'battlefield', 3] },           // two lands and the Bears; no mana was spent on the Bolt
    ],
  },
  {
    name: 'a card exiled with a permanent is a legal target for that permanent\'s ability', cr: '115.1',
    ruling: 'The exiled-with-card target kind offers exactly the cards exiled with the source.',
    seats: [{ bf: ['Forest', 'Mountain'], hand: ['Grizzly Bears'], libraryTop: ['Lightning Bolt'] }, {}],
    scripts: {
      'Grizzly Bears': {
        abilities: [
          { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'hideaway', count: 4 }], text: 'Hideaway 4' },
          { kind: 'activated', cost: {}, effects: [{ op: 'move', what: { kind: 'exiled-with-card' }, to: 'hand' }], text: 'Return target card exiled with this creature to your hand.' },
        ],
      },
    },
    script: [
      { cast: 'Grizzly Bears' }, { resolve: true },
      { activate: 'Grizzly Bears', targets: [['Lightning Bolt']] }, { resolve: true },
    ],
    expect: [
      { zone: ['Lightning Bolt', 'hand'] },
      { zoneCount: [0, 'exile', 0] },
    ],
  },

  // ------------------------------------------------------------------ cast-free from hand, and the cast-from permission
  {
    name: 'Electrodominance casts a spell with mana value X or less from hand without paying its mana cost', cr: '601.2b',
    ruling: 'The free cast happens while Electrodominance resolves, so the spell it casts is put on the stack above it.',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Electrodominance', 'Lightning Bolt'] }, {}],
    script: [
      { cast: 'Electrodominance', x: 2, targets: [['P1']] }, { resolve: true }, { resolve: true },
    ],
    expect: [
      { life: [1, 15] },                              // 2 from Electrodominance, 3 from the free Lightning Bolt
      { zone: ['Lightning Bolt', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a cast-from permission lets a creature card be cast out of the graveyard for its mana cost', cr: '601.2',
    ruling: 'The permission only says where the card may be cast from; the mana cost is still paid.',
    seats: [{ bf: ['Grizzly Bears', 'Forest', 'Forest'], graveyard: ['Runeclaw Bear'] }, {}],
    scripts: bearsStatic({ kind: 'cast-from', zone: 'graveyard', filter: { types: ['Creature'] } }, 'You may cast creature spells from your graveyard.'),
    script: [{ cast: 'Runeclaw Bear' }, { resolve: true }],
    expect: [
      { zone: ['Runeclaw Bear', 'battlefield'] },
      { tapped: ['Forest', true] },                   // its {1}{G} was really paid
    ],
  },
  {
    name: 'a free cast-from permission pays no mana at all', cr: '118.9b',
    ruling: '"Without paying its mana cost" means no mana is paid, so the cast works with no lands on the battlefield.',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Runeclaw Bear'] }, {}],
    scripts: bearsStatic({ kind: 'cast-from', zone: 'graveyard', filter: { types: ['Creature'] }, free: true }, 'You may cast creature spells from your graveyard without paying their mana costs.'),
    script: [{ cast: 'Runeclaw Bear' }, { resolve: true }],
    expect: [
      { zone: ['Runeclaw Bear', 'battlefield'] },
      { zoneCount: [0, 'graveyard', 0] },
    ],
  },
  {
    name: 'a cast-free that finds nothing to cast does nothing', cr: '608.2',
    ruling: 'With no card in hand cheap enough, the effect simply has no legal choice and the game continues.',
    seats: [{ bf: ['Forest', 'Mountain'], hand: ['Grizzly Bears'] }, {}],
    scripts: bearsAbility([{ op: 'cast-free', from: 'hand', mvLE: 1 }], 'You may cast a spell with mana value 1 or less from your hand without paying its mana cost.'),
    script: [{ cast: 'Grizzly Bears' }, { resolve: true }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [
      { handCount: [0, 0] },
      { zone: ['Grizzly Bears', 'battlefield'] },
      { stack: 0 },
    ],
  },
];
