// The `transform` family (Phase 9.1, docs/vocabulary/transform.md): one scenario per op, per condition, per amount,
// per trigger, per as-enters kind, per target kind and per keyword parameter, each pinned to a Comprehensive Rule.
//
// Where a printed card already produces the shape (Sunrise Cavalier, Wolf Strike, Sidequest: Card Collection,
// Matzalantli, Neglected Heirloom, Ainok Survivalist, Sanctum of Stone Fangs, Graveyard Trespasser) the card is used
// as printed, so the parser rules are under test too. Where no card parses into the op yet (the prepare keyword
// action, the arithmetic amounts, "entered from your graveyard") a real card carries a scenario-only script, the way
// test/scenarios/composition.ts does.
//
// Every expectation fails if the op did nothing: a face change is read off the permanent's *characteristics* (the
// back face's P/T and keywords), never off a log line alone.
import type { Effect } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

// Double-faced cards are looked up in expectations by their exact printed `def.name`, which for a DFC is "A // B".
const DELVER = 'Delver of Secrets // Insectile Aberration';
const TRESPASSER = 'Graveyard Trespasser // Graveyard Glutton';
const HEIRLOOM = 'Neglected Heirloom // Ashmouth Blade';
const SIDEQUEST = 'Sidequest: Card Collection // Magicked Card';
const MATZALANTLI = 'Matzalantli, the Great Door // The Core';

/** A card gains a free (no-cost) activated ability; its printed text stays (`mode` defaults to 'extend'). */
const free = (card: string, effects: Effect[], text = 'transform test'): Record<string, ScenarioScript> =>
  ({ [card]: { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** Lightning Bolt / Shock / Giant Growth become the given spell ({R}, {R}, {G} instants — three cheap switches). */
const spell = (card: string, effects: Effect[], text = 'transform test'): Record<string, ScenarioScript> =>
  ({ [card]: { mode: 'replace', abilities: [{ kind: 'spell', effects, text }] } });
/** A cheap instant that turns one creature you control to its back / front face. The flip has to come from OUTSIDE
 *  the permanent: an ability printed on the face that is turning away goes with it (CR 701.28a). */
const toBack = (card: string): Record<string, ScenarioScript> => spell(card, [{ op: 'transform', target: { kind: 'creature', controller: 'you' }, to: 'back' }]);
const toFront = (card: string): Record<string, ScenarioScript> => spell(card, [{ op: 'transform', target: { kind: 'creature', controller: 'you' }, to: 'front' }]);

export const transform: Scenario[] = [
  // ---------------------------------------------------------------- effect: transform
  {
    name: 'transform turns a double-faced permanent to its back face and it gains that face\'s characteristics', cr: '701.28a',
    seats: [{ bf: [DELVER] }, {}],
    scripts: free(DELVER, [{ op: 'transform', target: 'self' }]),
    script: [{ activate: DELVER }, { resolve: true }],
    expect: [
      { pt: [DELVER, 3, 2] },                                     // Insectile Aberration, not the 1/1 front face
      { keywords: [DELVER, ['flying']] },
      { log: 'transforms into Insectile Aberration' },
      { events: { type: 'transform', min: 1, max: 1 } },
    ],
  },
  {
    name: 'transform with to: back is idempotent — a permanent already on its back face does not flip again', cr: '701.28c',
    seats: [{ bf: ['Mountain', 'Mountain', DELVER], hand: ['Lightning Bolt', 'Shock'] }, {}],
    scripts: { ...toBack('Lightning Bolt'), ...toBack('Shock') },
    script: [{ cast: 'Lightning Bolt', targets: [[DELVER]] }, { resolve: true }, { cast: 'Shock', targets: [[DELVER]] }, { resolve: true }],
    expect: [{ pt: [DELVER, 3, 2] }, { events: { type: 'transform', min: 1, max: 1 } }],
  },
  {
    name: 'transform with to: front turns a transformed permanent back to its front face', cr: '701.28a',
    seats: [{ bf: [DELVER] }, {}],
    scripts: free(DELVER, [{ op: 'transform', target: 'self', to: 'back' }, { op: 'transform', target: 'self', to: 'front' }]),
    script: [{ activate: DELVER }, { resolve: true }],
    expect: [{ pt: [DELVER, 1, 1] }, { keywords: [DELVER, []] }, { events: { type: 'transform', min: 2, max: 2 } }],
  },
  {
    name: 'transform with untap untaps the permanent it turned over', cr: '701.28a',
    seats: [{ bf: [DELVER], tapped: [DELVER] }, {}],
    scripts: free(DELVER, [{ op: 'transform', target: 'self', untap: true }]),
    script: [{ activate: DELVER }, { resolve: true }],
    expect: [{ pt: [DELVER, 3, 2] }, { tapped: [DELVER, false] }],
  },
  {
    name: 'transform takes a chosen target: a spell transforms a creature it targets', cr: '115.1',
    seats: [{ bf: ['Mountain', DELVER], hand: ['Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'transform', target: { kind: 'creature', controller: 'you' } }]),
    script: [{ cast: 'Lightning Bolt', targets: [[DELVER]] }, { resolve: true }],
    expect: [{ pt: [DELVER, 3, 2] }, { keywords: [DELVER, ['flying']] }],
  },
  {
    name: 'transform does nothing to a permanent whose card has only one face', cr: '701.28b',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: free('Grizzly Bears', [{ op: 'transform', target: 'self' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 2, 2] }, { events: { type: 'transform', min: 0, max: 0 } }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- trigger: transforms
  {
    // CR 701.28a: the ability that triggers is the one on the face that is now up, so a front-face "whenever this
    // transforms" fires on the flip back TO the front, never on the flip away from it (both flips happen here).
    name: 'a "whenever this transforms" trigger fires when the permanent turns over to the face that carries it', cr: '603.2',
    seats: [{ bf: ['Mountain', 'Mountain', DELVER], hand: ['Lightning Bolt', 'Shock'] }, {}],
    scripts: {
      ...toBack('Lightning Bolt'), ...toFront('Shock'),
      [DELVER]: { mode: 'replace', abilities: [{ kind: 'triggered', event: { on: 'transforms', self: true }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'transform trigger' }] },
    },
    script: [{ cast: 'Lightning Bolt', targets: [[DELVER]] }, { resolve: true }, { cast: 'Shock', targets: [[DELVER]] }, { resolve: true }],
    expect: [{ pt: [DELVER, 1, 1] }, { life: [0, 23] }, { events: { type: 'transform', min: 2, max: 2 } }],
  },
  {
    name: 'a transforms trigger with into: back does not fire on a back-to-front transformation', cr: '603.2',
    seats: [{ bf: ['Mountain', 'Mountain', DELVER], hand: ['Lightning Bolt', 'Shock'] }, {}],
    scripts: {
      ...toBack('Lightning Bolt'), ...toFront('Shock'),
      [DELVER]: { mode: 'replace', abilities: [{ kind: 'triggered', event: { on: 'transforms', self: true, into: 'back' }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'transform trigger' }] },
    },
    script: [{ cast: 'Lightning Bolt', targets: [[DELVER]] }, { resolve: true }, { cast: 'Shock', targets: [[DELVER]] }, { resolve: true }],
    expect: [{ pt: [DELVER, 1, 1] }, { life: [0, 20] }, { events: { type: 'transform', min: 2, max: 2 } }],
  },
  {
    name: 'a transforms trigger with orEnters also fires when the permanent enters', cr: '603.2',
    seats: [{ bf: ['Island', 'Mountain'], hand: [DELVER] }, {}],
    scripts: { [DELVER]: { abilities: [{ kind: 'triggered', event: { on: 'transforms', self: true, orEnters: true }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'enters or transforms' }] } },
    script: [{ cast: DELVER }, { resolve: true }],
    expect: [{ zone: [DELVER, 'battlefield'] }, { life: [0, 23] }],
  },
  {
    name: 'Neglected Heirloom transforms into Ashmouth Blade when the creature it equips transforms', cr: '702.6a',
    seats: [{ bf: [DELVER, HEIRLOOM, 'Mountain'] }, {}],
    scripts: free(DELVER, [{ op: 'transform', target: 'self' }]),
    script: [{ activate: HEIRLOOM, targets: [[DELVER]] }, { resolve: true }, { activate: DELVER }, { resolve: true }],
    expect: [
      { attachedTo: [HEIRLOOM, DELVER] },
      { pt: [DELVER, 6, 5] },                                     // Insectile Aberration 3/2 + Ashmouth Blade's +3/+3
      { keywords: [DELVER, ['flying', 'first strike']] },
      { log: 'transforms into Ashmouth Blade' },
    ],
  },

  // ---------------------------------------------------------------- effect + condition + trigger + as-enters: day / night
  {
    name: 'Sunrise Cavalier makes it day as it enters when it is neither day nor night', cr: '726.2a',
    seats: [{ bf: ['Mountain', 'Plains', 'Plains'], hand: ['Sunrise Cavalier'] }, {}],
    script: [{ cast: 'Sunrise Cavalier' }, { resolve: true }],
    expect: [{ zone: ['Sunrise Cavalier', 'battlefield'] }, { log: 'It becomes day' }, { events: { type: 'day-night', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'set-day-night to night after day fires "whenever day becomes night or night becomes day"', cr: '726.2c',
    seats: [{ bf: ['Mountain', 'Plains', 'Plains', 'Mountain'], hand: ['Sunrise Cavalier', 'Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'set-day-night', to: 'night' }]),
    script: [{ cast: 'Sunrise Cavalier' }, { resolve: true }, { cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [
      { log: 'It becomes night' },
      { counters: ['Sunrise Cavalier', { '+1/+1': 1 }] },         // the only creature you control: the trigger resolved
      { pt: ['Sunrise Cavalier', 4, 4] },
      { events: { type: 'day-night', min: 2, max: 2 } },
    ],
  },
  {
    name: 'set-day-night to a state that is already in effect changes nothing', cr: '726.1a',
    seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, {}],
    scripts: { ...spell('Lightning Bolt', [{ op: 'set-day-night', to: 'night' }]), ...spell('Shock', [{ op: 'set-day-night', to: 'night' }]) },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Shock' }, { resolve: true }],
    expect: [{ events: { type: 'day-night', min: 1, max: 1 } }],
  },
  {
    name: 'Wolf Strike pumps its target only while it is night', cr: '726.1',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Mountain', 'Grizzly Bears'], hand: ['Wolf Strike', 'Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: spell('Lightning Bolt', [{ op: 'set-day-night', to: 'night' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Wolf Strike', targets: [['Grizzly Bears'], ['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 2] }],                    // +2/+0, and only because it is night
  },
  {
    name: 'Wolf Strike does not pump its target when it is neither day nor night', cr: '726.1a',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Grizzly Bears'], hand: ['Wolf Strike'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Wolf Strike', targets: [['Grizzly Bears'], ['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 2, 2] }],                    // no pump: it is neither day nor night
  },

  // ---------------------------------------------------------------- keywords: daybound / nightbound
  {
    name: 'a daybound permanent transforms when it becomes night, and back when it becomes day', cr: '702.145e',
    seats: [{ bf: [TRESPASSER, 'Mountain', 'Mountain', 'Forest'], hand: ['Lightning Bolt', 'Shock', 'Giant Growth'] }, {}],
    scripts: {
      ...spell('Lightning Bolt', [{ op: 'set-day-night', to: 'day' }]),
      ...spell('Shock', [{ op: 'set-day-night', to: 'night' }]),
      ...spell('Giant Growth', [{ op: 'set-day-night', to: 'day' }]),
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Shock' }, { resolve: true }],
    expect: [{ pt: [TRESPASSER, 4, 4] }, { log: 'transforms into Graveyard Glutton' }],
  },
  {
    name: 'a nightbound permanent transforms back to its front face when it becomes day', cr: '702.146d',
    seats: [{ bf: [TRESPASSER, 'Mountain', 'Mountain', 'Forest'], hand: ['Lightning Bolt', 'Shock', 'Giant Growth'] }, {}],
    scripts: {
      ...spell('Lightning Bolt', [{ op: 'set-day-night', to: 'day' }]),
      ...spell('Shock', [{ op: 'set-day-night', to: 'night' }]),
      ...spell('Giant Growth', [{ op: 'set-day-night', to: 'day' }]),
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Shock' }, { resolve: true }, { cast: 'Giant Growth' }, { resolve: true }],
    expect: [{ pt: [TRESPASSER, 3, 3] }, { log: 'transforms into Graveyard Trespasser' }],
  },
  {
    name: 'day becomes night as a turn begins when the previous turn\'s active player cast no spells', cr: '726.3',
    seats: [{ bf: [TRESPASSER, 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'set-day-night', to: 'day' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { turns: 2 }],
    expect: [{ pt: [TRESPASSER, 4, 4] }, { log: 'It becomes night' }],
  },

  // ---------------------------------------------------------------- condition: descend
  {
    name: 'Sidequest: Card Collection transforms at end step with eight cards in the graveyard', cr: '701.51b',
    seats: [{ bf: [SIDEQUEST], graveyard: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, {}],
    script: [{ passUntil: 'end' }, { resolve: true }],
    expect: [{ log: 'transforms into Magicked Card' }, { keywords: [SIDEQUEST, ['flying']] }],
  },
  {
    name: 'Sidequest: Card Collection does not transform with only seven cards in the graveyard', cr: '701.51b',
    seats: [{ bf: [SIDEQUEST], graveyard: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, {}],
    script: [{ passUntil: 'end' }, { resolve: true }],
    expect: [{ noLog: 'transforms into Magicked Card' }, { events: { type: 'transform', min: 0, max: 0 } }],
  },
  {
    name: 'Matzalantli transforms only with four permanent types among cards in the graveyard', cr: '701.51a',
    seats: [{ bf: [MATZALANTLI, 'Mountain', 'Mountain', 'Mountain', 'Mountain'], graveyard: ['Mountain', 'Grizzly Bears', 'Sol Ring', 'Rancor'] }, {}],
    script: [{ activate: MATZALANTLI, ability: 1 }, { resolve: true }],
    expect: [{ log: 'transforms into The Core' }, { events: { type: 'transform', min: 1, max: 1 } }],
  },
  {
    name: 'descend counting permanent cards ignores the instants in the graveyard', cr: '701.51a',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Mountain', 'Hill Giant', 'Lightning Bolt', 'Shock'] }, {}],
    scripts: free('Grizzly Bears', [{ op: 'conditional', condition: { kind: 'descend', count: 2, among: 'permanent-cards' }, then: [{ op: 'gain-life', amount: 5, who: 'you' }], else: [{ op: 'lose-life', amount: 5, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 25] }],
  },
  {
    name: 'descend counting permanent cards is not met by one permanent card and two instants', cr: '701.51a',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Mountain', 'Lightning Bolt', 'Shock'] }, {}],
    scripts: free('Grizzly Bears', [{ op: 'conditional', condition: { kind: 'descend', count: 2, among: 'permanent-cards' }, then: [{ op: 'gain-life', amount: 5, who: 'you' }], else: [{ op: 'lose-life', amount: 5, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 15] }],
  },

  // ---------------------------------------------------------------- amounts
  {
    name: 'the permanent-cards-in-graveyard amount counts only permanent cards', cr: '110.4c',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], graveyard: ['Mountain', 'Grizzly Bears', 'Shock'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'gain-life', amount: { count: 'permanent-cards-in-graveyard' }, who: 'you' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ life: [0, 22] }],
  },
  {
    name: 'the permanent-types-in-graveyard amount counts distinct permanent types', cr: '110.4c',
    seats: [{ bf: ['Mountain'], hand: ['Shock'], graveyard: ['Mountain', 'Grizzly Bears', 'Hill Giant', 'Sol Ring', 'Lightning Bolt'] }, {}],
    scripts: spell('Shock', [{ op: 'gain-life', amount: { count: 'permanent-types-in-graveyard' }, who: 'you' }]),
    script: [{ cast: 'Shock' }, { resolve: true }],
    expect: [{ life: [0, 23] }],                                  // Land + Creature + Artifact = 3, not 4 cards
  },

  // ---------------------------------------------------------------- condition: entered-from
  {
    name: '"if it entered from your graveyard" holds for a creature reanimated onto the battlefield', cr: '400.7',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], graveyard: ['Grizzly Bears'] }, {}],
    scripts: {
      ...spell('Lightning Bolt', [{ op: 'move', what: { filter: { types: ['Creature'] }, zone: 'graveyard', who: 'you', count: 1 }, to: 'battlefield', controller: 'you' }]),
      'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'conditional', condition: { kind: 'entered-from', zone: 'graveyard', who: 'you' }, then: [{ op: 'gain-life', amount: 5, who: 'you' }] }], text: 'entered from graveyard' }] },
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { life: [0, 25] }],
  },
  {
    name: '"if it entered from your graveyard" does not hold for a creature cast from hand', cr: '400.7',
    seats: [{ bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'conditional', condition: { kind: 'entered-from', zone: 'graveyard', who: 'you' }, then: [{ op: 'gain-life', amount: 5, who: 'you' }] }], text: 'entered from graveyard' }] } },
    script: [{ cast: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { life: [0, 20] }],
  },

  // ---------------------------------------------------------------- prepare: as-enters, op and condition
  {
    name: 'a permanent that enters prepared is prepared as its enters-the-battlefield trigger resolves', cr: '614.1c',
    seats: [{ bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }, {}],
    scripts: {
      'Grizzly Bears': {
        asEnters: [{ kind: 'prepared' }],
        abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'conditional', condition: { kind: 'prepared' }, then: [{ op: 'gain-life', amount: 4, who: 'you' }] }], text: 'prepared check' }],
      },
    },
    script: [{ cast: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 24] }, { ext: ['Grizzly Bears', 'transformPrepared', true] }],
  },
  {
    name: 'become-prepared marks a permanent prepared, and become-prepared with on: false clears it', cr: '701.1a',
    seats: [{ bf: ['Hill Giant'] }, {}],
    scripts: {
      'Hill Giant': {
        abilities: [
          { kind: 'activated', cost: {}, effects: [{ op: 'become-prepared', target: 'self' }], text: 'prepare' },
          { kind: 'activated', cost: {}, effects: [{ op: 'become-prepared', target: 'self', on: false }], text: 'unprepare' },
        ],
      },
    },
    script: [{ activate: 'Hill Giant', ability: 0 }, { resolve: true }, { activate: 'Hill Giant', ability: 1 }, { resolve: true }],
    expect: [{ log: 'Hill Giant becomes prepared' }, { log: 'Hill Giant is no longer prepared' }, { ext: ['Hill Giant', 'transformPrepared', undefined] }],
  },

  // ---------------------------------------------------------------- turn face up: the op, the target kind, the trigger
  {
    name: 'Ainok Survivalist\'s turned-face-up trigger fires when its megamorph cost is paid', cr: '701.34b',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Ainok Survivalist'] }, { bf: ['Sol Ring'] }],
    script: [{ cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true }, { turnFaceUp: 'Ainok Survivalist' }, { resolve: true }],
    expect: [
      { faceDown: ['Ainok Survivalist', false] },
      { zone: ['Sol Ring', 'graveyard'] },                        // the trigger really resolved (it was inert before 9.1)
      { counters: ['Ainok Survivalist', { '+1/+1': 1 }] },
    ],
  },
  {
    name: 'turn-face-up turns a face-down permanent face up without paying its morph cost', cr: '713.2',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Mountain'], hand: ['Ainok Survivalist', 'Lightning Bolt'] }, { bf: ['Sol Ring'] }],
    scripts: spell('Lightning Bolt', [{ op: 'turn-face-up', target: { kind: 'face-down-permanent', controller: 'you' }, onlyIf: 'creature-card' }]),
    script: [{ cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['Ainok Survivalist']] }, { resolve: true }],
    expect: [
      { faceDown: ['Ainok Survivalist', false] },
      { pt: ['Ainok Survivalist', 2, 1] },                        // its printed P/T, not the 2/2 of a face-down permanent
      { counters: ['Ainok Survivalist', { '+1/+1': 0 }] },        // no megamorph counter: no cost was paid
      { zone: ['Sol Ring', 'graveyard'] },                        // the op raises `turned-face-up` too
    ],
  },

  // ---------------------------------------------------------------- trigger: first-main-phase
  {
    name: 'Sanctum of Stone Fangs drains at the beginning of its controller\'s first main phase only', cr: '505.1',
    seats: [{ bf: ['Sanctum of Stone Fangs'] }, {}],
    script: [{ turns: 2 }],
    expect: [{ life: [0, 21] }, { life: [1, 19] }, { unsimulated: 0 }],
  },
  {
    name: 'a first-main-phase trigger with whose: each fires in every player\'s precombat main phase', cr: '505.1',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'first-main-phase', whose: 'each' }, effects: [{ op: 'gain-life', amount: 1, who: 'you' }], text: 'each main phase' }] } },
    script: [{ turns: 2 }],
    expect: [{ life: [0, 22] }],
  },
];
