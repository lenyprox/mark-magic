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

  {
    // `costAdjust` runs BEFORE game.ts's `pl.spellsCastThisTurn++`, while `parseCondition` calibrates "you've cast
    // another spell this turn" for a resolving spell (which has already been counted). Without the cost-time shift
    // the discount would only arrive on the third spell and {1}{U} would not be payable here at all.
    name: "Gigastorm Titan's discount arrives on the second spell of the turn, not the third", cr: '601.2f',
    ruling: `"If you've cast another spell this turn" is satisfied by the one spell cast before it, so {4}{U} becomes {1}{U}.`,
    seats: [{ bf: ['Island', 'Island', 'Mountain'], hand: ['Gigastorm Titan', 'Lightning Bolt'] }, {}],
    script: [
      { cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true },
      { cast: 'Gigastorm Titan' }, { resolve: true },
    ],
    expect: [
      { life: [1, 17] },
      { zone: ['Gigastorm Titan', 'battlefield'] },    // only the {3} reduction makes {4}{U} payable off two Islands
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Gigastorm Titan cast as the first spell of the turn pays its full cost', cr: '601.2f',
    ruling: 'With no other spell cast this turn the condition fails, so the full {4}{U} is paid.',
    seats: [{ bf: ['Island', 'Plains', 'Swamp', 'Mountain', 'Forest'], hand: ['Gigastorm Titan'] }, {}],
    script: [{ cast: 'Gigastorm Titan' }, { resolve: true }],
    expect: [
      { zone: ['Gigastorm Titan', 'battlefield'] },
      // every one of the five lands is tapped: an over-eager discount (counting the spell being cast as the
      // "another" spell) would have made it {1}{U} and left three of them untapped.
      { tapped: ['Island', true] }, { tapped: ['Plains', true] }, { tapped: ['Swamp', true] }, { tapped: ['Mountain', true] }, { tapped: ['Forest', true] },
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
    // Regression pin for the zone gate on `exileSelfFromGraveyard`. legal.ts's battlefield scan does not skip
    // `ab.fromGraveyard`, so the only thing that keeps a graveyard ability off the battlefield is its cost being
    // unpayable there. The DSL has no "this action is not offered" expectation, so the pin is made by competition:
    // `{ activate }` takes the FIRST legal ability of that permanent, and Mother Bear's printed graveyard ability is
    // index 0 while the scripted draw is index 1. With the gate missing, index 0 wins and Mother Bear exiles itself
    // from PLAY for two 2/2 Bears; with it, only the draw is legal.
    name: "Mother Bear's graveyard ability cannot be activated while Mother Bear is on the battlefield", cr: '113.6b',
    ruling: 'An ability that states the zone it functions in functions only from that zone: "Exile this card from your graveyard" cannot be paid by the permanent in play.',
    seats: [{ bf: ['Mother Bear', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'] }, {}],
    scripts: { 'Mother Bear': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: '{T}: Draw a card.' }] } },
    script: [{ activate: 'Mother Bear' }, { resolve: true }],
    expect: [
      { zone: ['Mother Bear', 'battlefield'] },        // it did not exile itself from play
      { zoneCount: [0, 'exile', 0] },
      { zoneCount: [0, 'battlefield', 6] },            // five Forests and the Bear; no Bear tokens were made
      { handCount: [0, 1] },                           // the only legal ability was the scripted draw
    ],
  },
  {
    name: 'Time Sieve is one of the five artifacts it sacrifices to pay for its own ability', cr: '601.2h',
    ruling: 'A permanent may be sacrificed to pay for its own activated ability, so five artifacts on the battlefield is enough when Time Sieve is one of them.',
    seats: [{ bf: ['Time Sieve', 'Ornithopter', 'Ornithopter', 'Ornithopter', 'Ornithopter'] }, {}],
    script: [{ activate: 'Time Sieve' }, { resolve: true }],
    expect: [
      { zone: ['Time Sieve', 'graveyard'] },           // the source itself paid
      { zoneCount: [0, 'battlefield', 0] },            // all five artifacts are gone
      { graveyardCount: [0, 5] },
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
    // game.ts:571 runs FREE_CAST_HOOKS unconditionally, unlike the CAST_FROM_HOOKS block two lines above it, which
    // is guarded by `!alt` — and the hook is not told which alternative cost the cast chose. Without the family's
    // own guard the flashback cast below would take ZERO_COST *and* still pay the flashback cost, so no Mountain
    // would be tapped.
    name: "a free cast-from permission does not make a card's own flashback cost free", cr: '118.9',
    ruling: 'An alternative cost replaces the mana cost; the "without paying its mana cost" permission is a different way to cast the card, not a discount on top of flashback.',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], graveyard: ['Firebolt'] }, {}],
    scripts: bearsStatic({ kind: 'cast-from', zone: 'graveyard', free: true }, 'You may cast spells from your graveyard without paying their mana costs.'),
    script: [{ cast: 'Firebolt', alt: 'flashback', targets: [['P1']] }, { resolve: true }],
    expect: [
      { life: [1, 18] },
      { zone: ['Firebolt', 'exile'] },                // flashback exiles it (CR 702.34a)
      // the {4}{R} flashback cost was really paid: all five Mountains are tapped
      { tapped: ['Mountain', true] }, { mana: [0, ''] },
    ],
  },
  {
    // The family's `legalActions` provider does not go through legal.ts:castActionsFor, which is the only place the
    // core applies `opponents-cant-cast` (legal.ts:293), so the provider re-checks it itself. This pins the *scope*
    // of that re-check: Grand Abolisher locks its controller's turn only, so on seat 0's own turn the permission
    // still works. (The other half — nothing is offered on seat 1's turn — the DSL cannot express: it has no
    // "this action is not offered" expectation.)
    name: 'a cast-from permission still works on your own turn while an opponent controls Grand Abolisher', cr: '601.2',
    ruling: `"During your turn, your opponents can't cast spells" restricts only the Abolisher controller's turn.`,
    seats: [{ bf: ['Grizzly Bears', 'Forest', 'Forest'], graveyard: ['Runeclaw Bear'] }, { bf: ['Grand Abolisher'] }],
    scripts: bearsStatic({ kind: 'cast-from', zone: 'graveyard', filter: { types: ['Creature'] } }, 'You may cast creature spells from your graveyard.'),
    script: [{ cast: 'Runeclaw Bear' }, { resolve: true }],
    expect: [
      { zone: ['Runeclaw Bear', 'battlefield'] },
      { tapped: ['Forest', true] },
    ],
  },
  {
    // The marker `cast-free` sets is deleted in a `finally`: a throw inside the nested cast would otherwise leave it
    // on the card, and both hooks read it BEFORE their zone check, so the card would stay free-castable from any
    // zone for the rest of the game (and `ext` is JSON-plain, so clone.ts and serialize.ts would carry it into every
    // rollout). This pins the happy path; the throwing path is not scriptable from the DSL.
    name: 'a cast-free leaves no free-cast marker on the card it cast', cr: '608.2f',
    ruling: 'The permission is granted for that one cast only.',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Electrodominance', 'Lightning Bolt'] }, {}],
    script: [{ cast: 'Electrodominance', x: 2, targets: [['P1']] }, { resolve: true }, { resolve: true }],
    expect: [
      { life: [1, 15] },
      { zone: ['Lightning Bolt', 'graveyard'] },
      { ext: ['Lightning Bolt', 'costAlterFree', undefined] },
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
