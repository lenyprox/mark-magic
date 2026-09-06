// The `transform` family (Phase 9.1, docs/vocabulary/transform.md): one scenario per op, per condition, per amount,
// per trigger, per as-enters kind, per target kind and per keyword parameter, each pinned to a Comprehensive Rule.
// Every `cr` below names the rule that actually carries the text in data/rules/cr.json (version August 7, 2026).
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
const OJER = 'Ojer Axonil, Deepest Might // Temple of Power';

/** A card gains a free (no-cost) activated ability; its printed text stays (`mode` defaults to 'extend'). */
const free = (card: string, effects: Effect[], text = 'transform test'): Record<string, ScenarioScript> =>
  ({ [card]: { abilities: [{ kind: 'activated', cost: {}, effects, text }] } });
/** Lightning Bolt / Shock / Giant Growth become the given spell ({R}, {R}, {G} instants — three cheap switches). */
const spell = (card: string, effects: Effect[], text = 'transform test'): Record<string, ScenarioScript> =>
  ({ [card]: { mode: 'replace', abilities: [{ kind: 'spell', effects, text }] } });
/** A cheap instant that turns one creature you control to its back / front face. The flip has to come from OUTSIDE
 *  the permanent: an ability printed on the face that is turning away goes with it (CR 701.27a). */
const toBack = (card: string): Record<string, ScenarioScript> => spell(card, [{ op: 'transform', target: { kind: 'creature', controller: 'you' }, to: 'back' }]);
const toFront = (card: string): Record<string, ScenarioScript> => spell(card, [{ op: 'transform', target: { kind: 'creature', controller: 'you' }, to: 'front' }]);

export const transform: Scenario[] = [
  // ---------------------------------------------------------------- effect: transform
  {
    name: 'transform turns a double-faced permanent to its back face and it gains that face\'s characteristics', cr: '701.27a',
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
    name: 'transform with to: back is idempotent — a permanent already on its back face does not flip again', cr: '701.27a',
    seats: [{ bf: ['Mountain', 'Mountain', DELVER], hand: ['Lightning Bolt', 'Shock'] }, {}],
    scripts: { ...toBack('Lightning Bolt'), ...toBack('Shock') },
    script: [{ cast: 'Lightning Bolt', targets: [[DELVER]] }, { resolve: true }, { cast: 'Shock', targets: [[DELVER]] }, { resolve: true }],
    expect: [{ pt: [DELVER, 3, 2] }, { events: { type: 'transform', min: 1, max: 1 } }],
  },
  {
    name: 'transform with to: front turns a transformed permanent back to its front face', cr: '701.27a',
    seats: [{ bf: [DELVER] }, {}],
    scripts: free(DELVER, [{ op: 'transform', target: 'self', to: 'back' }, { op: 'transform', target: 'self', to: 'front' }]),
    script: [{ activate: DELVER }, { resolve: true }],
    expect: [{ pt: [DELVER, 1, 1] }, { keywords: [DELVER, []] }, { events: { type: 'transform', min: 2, max: 2 } }],
  },
  {
    name: 'transform with untap untaps the permanent it turned over', cr: '701.27a',
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
    name: 'transform does nothing to a permanent whose card has only one face', cr: '701.27c',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: free('Grizzly Bears', [{ op: 'transform', target: 'self' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 2, 2] }, { events: { type: 'transform', min: 0, max: 0 } }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- trigger: transforms
  {
    // CR 701.27a: the ability that triggers is the one on the face that is now up, so a front-face "whenever this
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
    name: 'Sunrise Cavalier makes it day as it enters when it is neither day nor night', cr: '731.1',
    seats: [{ bf: ['Mountain', 'Plains', 'Plains'], hand: ['Sunrise Cavalier'] }, {}],
    script: [{ cast: 'Sunrise Cavalier' }, { resolve: true }],
    expect: [{ zone: ['Sunrise Cavalier', 'battlefield'] }, { log: 'It becomes day' }, { events: { type: 'day-night', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'set-day-night to night after day fires "whenever day becomes night or night becomes day"', cr: '731.1a',
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
    name: 'set-day-night to a state that is already in effect changes nothing', cr: '731.1',
    seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, {}],
    scripts: { ...spell('Lightning Bolt', [{ op: 'set-day-night', to: 'night' }]), ...spell('Shock', [{ op: 'set-day-night', to: 'night' }]) },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Shock' }, { resolve: true }],
    expect: [{ events: { type: 'day-night', min: 1, max: 1 } }],
  },
  {
    name: 'Wolf Strike pumps its target only while it is night', cr: '731.1',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Mountain', 'Grizzly Bears'], hand: ['Wolf Strike', 'Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: spell('Lightning Bolt', [{ op: 'set-day-night', to: 'night' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Wolf Strike', targets: [['Grizzly Bears'], ['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 2] }],                    // +2/+0, and only because it is night
  },
  {
    name: 'Wolf Strike does not pump its target when it is neither day nor night', cr: '731.1',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Grizzly Bears'], hand: ['Wolf Strike'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Wolf Strike', targets: [['Grizzly Bears'], ['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 2, 2] }],                    // no pump: it is neither day nor night
  },

  // ---------------------------------------------------------------- keywords: daybound / nightbound
  {
    name: 'a daybound permanent transforms when it becomes night, and back when it becomes day', cr: '702.145b',
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
    name: 'a nightbound permanent transforms back to its front face when it becomes day', cr: '702.145e',
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
    name: 'day becomes night as a turn begins when the previous turn\'s active player cast no spells', cr: '731.2a',
    seats: [{ bf: [TRESPASSER, 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'set-day-night', to: 'day' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { turns: 2 }],
    expect: [{ pt: [TRESPASSER, 4, 4] }, { log: 'It becomes night' }],
  },

  // ---------------------------------------------------------------- condition: descend
  {
    name: 'Sidequest: Card Collection transforms at end step with eight cards in the graveyard', cr: '207.2c',
    seats: [{ bf: [SIDEQUEST], graveyard: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, {}],
    script: [{ passUntil: 'end' }, { resolve: true }],
    expect: [{ log: 'transforms into Magicked Card' }, { keywords: [SIDEQUEST, ['flying']] }],
  },
  {
    name: 'Sidequest: Card Collection does not transform with only seven cards in the graveyard', cr: '207.2c',
    seats: [{ bf: [SIDEQUEST], graveyard: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, {}],
    script: [{ passUntil: 'end' }, { resolve: true }],
    expect: [{ noLog: 'transforms into Magicked Card' }, { events: { type: 'transform', min: 0, max: 0 } }],
  },
  {
    name: 'Matzalantli transforms only with four permanent types among cards in the graveyard', cr: '207.2c',
    seats: [{ bf: [MATZALANTLI, 'Mountain', 'Mountain', 'Mountain', 'Mountain'], graveyard: ['Mountain', 'Grizzly Bears', 'Sol Ring', 'Rancor'] }, {}],
    script: [{ activate: MATZALANTLI, ability: 1 }, { resolve: true }],
    expect: [{ log: 'transforms into The Core' }, { events: { type: 'transform', min: 1, max: 1 } }],
  },
  {
    name: 'descend counting permanent cards ignores the instants in the graveyard', cr: '207.2c',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Mountain', 'Hill Giant', 'Lightning Bolt', 'Shock'] }, {}],
    scripts: free('Grizzly Bears', [{ op: 'conditional', condition: { kind: 'descend', count: 2, among: 'permanent-cards' }, then: [{ op: 'gain-life', amount: 5, who: 'you' }], else: [{ op: 'lose-life', amount: 5, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 25] }],
  },
  {
    name: 'descend counting permanent cards is not met by one permanent card and two instants', cr: '207.2c',
    seats: [{ bf: ['Grizzly Bears'], graveyard: ['Mountain', 'Lightning Bolt', 'Shock'] }, {}],
    scripts: free('Grizzly Bears', [{ op: 'conditional', condition: { kind: 'descend', count: 2, among: 'permanent-cards' }, then: [{ op: 'gain-life', amount: 5, who: 'you' }], else: [{ op: 'lose-life', amount: 5, who: 'you' }] }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 15] }],
  },

  // ---------------------------------------------------------------- amounts
  {
    name: 'the permanent-cards-in-graveyard amount counts only permanent cards', cr: '110.4a',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'], graveyard: ['Mountain', 'Grizzly Bears', 'Shock'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'gain-life', amount: { count: 'permanent-cards-in-graveyard' }, who: 'you' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ life: [0, 22] }],
  },
  {
    name: 'the permanent-types-in-graveyard amount counts distinct permanent types', cr: '110.4a',
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
    name: 'a permanent that enters prepared is prepared as its enters-the-battlefield trigger resolves', cr: '722.3a',
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
    name: 'become-prepared marks a permanent prepared, and become-prepared with on: false clears it', cr: '722.3a',
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
    name: 'Ainok Survivalist\'s turned-face-up trigger fires when its megamorph cost is paid', cr: '702.37b',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Ainok Survivalist'] }, { bf: ['Sol Ring'] }],
    script: [{ cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true }, { turnFaceUp: 'Ainok Survivalist' }, { resolve: true }],
    expect: [
      { faceDown: ['Ainok Survivalist', false] },
      { zone: ['Sol Ring', 'graveyard'] },                        // the trigger really resolved (it was inert before 9.1)
      { counters: ['Ainok Survivalist', { '+1/+1': 1 }] },
    ],
  },
  {
    name: 'turn-face-up turns a face-down permanent face up without paying its morph cost', cr: '708.7',
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

  // ---------------------------------------------------------------- daybound's other two static abilities (9.1 review)
  {
    // CR 702.145b, ability 1 of 3: "If it is night and this permanent is represented by a double-faced card, it
    // enters transformed." Entering transformed is a replacement (CR 614.1), NOT a transformation - so the back
    // face's characteristics are the ones the permanent has from the moment it arrives, and no `transform` event is
    // raised at all (a "whenever this transforms" trigger must not fire).
    name: 'a daybound permanent that enters while it is night enters transformed', cr: '702.145b',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Mountain'], hand: [TRESPASSER, 'Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'set-day-night', to: 'night' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: TRESPASSER }, { resolve: true }],
    expect: [
      { pt: [TRESPASSER, 4, 4] },                                 // Graveyard Glutton, not the 3/3 front face
      { log: 'Graveyard Glutton enters transformed' },
      { events: { type: 'transform', min: 0, max: 0 } },          // a replacement, not a transformation
    ],
  },
  {
    // The same permanent entering while it is DAY keeps its front face: the check is on the night designation, not on
    // the mere existence of a day/night cycle.
    name: 'a daybound permanent that enters while it is day enters with its front face up', cr: '702.145b',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Mountain'], hand: [TRESPASSER, 'Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'set-day-night', to: 'day' }]),
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: TRESPASSER }, { resolve: true }],
    expect: [{ pt: [TRESPASSER, 3, 3] }, { events: { type: 'transform', min: 0, max: 0 } }],
  },
  {
    // CR 702.145b, ability 3 of 3 (and CR 702.145e, ability 2 of 2): "This permanent can't transform except due to
    // its daybound ability." A generic "transform target creature you control" is not that ability, so nothing
    // happens - the permanent keeps its front face and no `transform` event is raised.
    name: 'a daybound permanent cannot be transformed by an effect other than its daybound ability', cr: '702.145b',
    seats: [{ bf: [TRESPASSER, 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'transform', target: { kind: 'creature', controller: 'you' } }]),
    script: [{ cast: 'Lightning Bolt', targets: [[TRESPASSER]] }, { resolve: true }],
    expect: [{ pt: [TRESPASSER, 3, 3] }, { events: { type: 'transform', min: 0, max: 0 } }],
  },
  {
    // CR 702.145f: "Any time a player controls a permanent that is back face up with nightbound and it's day, that
    // player transforms that permanent. This happens immediately and isn't a state-based action." (CR 702.145c is the
    // daybound mirror.) The core's own `transform-self` op is not routed through this family's can't-transform gate,
    // so it is the cleanest way to put a werewolf on the wrong face while it is day - and the continuous check, which
    // lives in the family's `sba` hook, has to put it straight back on the very next state-based check.
    // Since 9.1x item 16 the core `transform-self` op comes through this family's `flip`, which refuses a daybound /
    // nightbound permanent outright (CR 702.145b) - the face never changes, so there is nothing for CR 702.145f's
    // continuous check to put back. The check itself is still pinned by the next scenario.
    name: 'a daybound permanent cannot be transformed by a plain transform effect while it is day', cr: '702.145b',
    ruling: 'CR 702.145b: a permanent with daybound can\'t transform except due to its daybound ability.',
    seats: [{ bf: [TRESPASSER, 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: {
      ...spell('Lightning Bolt', [{ op: 'set-day-night', to: 'day' }]),
      ...free(TRESPASSER, [{ op: 'transform-self' }], 'illegal flip'),
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { activate: TRESPASSER }, { resolve: true }],
    expect: [
      { pt: [TRESPASSER, 3, 3] },                                 // still Graveyard Trespasser, the day face
      { noLog: 'transforms into' },                               // never flipped, never flipped back
    ],
  },

  // ---------------------------------------------------------------- "return it to the battlefield ... transformed"
  {
    // CR 712.14a: a card put onto the battlefield "transformed" ENTERS with its back face up. Ojer Axonil returns as
    // Temple of Power, a LAND - so no creature entered, and Impact Tremors ("whenever a creature you control enters")
    // must not trigger. Before the fix the god entered front face up as a creature and flipped a moment later, so
    // Impact Tremors dealt its damage and every other permanent's enter trigger saw the wrong object.
    name: 'Ojer Axonil returns to the battlefield already transformed, so no creature entered', cr: '712.14a',
    seats: [{ bf: [OJER, 'Impact Tremors', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: spell('Lightning Bolt', [{ op: 'destroy', target: { kind: 'creature', controller: 'you' } }]),
    script: [{ cast: 'Lightning Bolt', targets: [[OJER]] }, { resolve: true }],
    expect: [
      { zone: [OJER, 'battlefield'] },
      { tapped: [OJER, true] },
      { life: [1, 20] },                                          // Impact Tremors did NOT trigger: a land entered
      { events: { type: 'transform', min: 0, max: 0 } },          // it entered transformed; it never transformed
      { log: 'puts Temple of Power onto the battlefield tapped' },
    ],
  },

  // ---------------------------------------------------------------- target kind: face-down-permanent
  {
    // CR 702.18a: a permanent with shroud can't be the target of spells or abilities. A face-down permanent has no
    // characteristics of its own (CR 708.2), so shroud can only come from outside - Lightning Greaves. The family
    // target kind is reached through `legal.ts:targetOptionsFor`'s DEFAULT branch, which never runs that function's
    // own `targetable()` closure, so the kind has to apply shroud / hexproof / protection / filter itself.
    //
    // Two face-down permanents, the shrouded one first, and a TRIGGERED ability so the engine picks the target from
    // `targetOptionsFor` rather than the script naming one. Exactly one permanent is turned face up, and which one is
    // the whole assertion: before the fix the shrouded Ainok Survivalist was offered, and being the earlier permanent
    // it was the one chosen.
    name: 'a face-down permanent with shroud is not a legal face-down-permanent target', cr: '702.18a',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Lightning Greaves'], hand: ['Ainok Survivalist', 'Kin-Tree Warden', 'Grizzly Bears'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'turn-face-up', target: { kind: 'face-down-permanent', controller: 'you' } }], text: 'unmask' }] } },
    script: [
      { cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true },
      { cast: 'Kin-Tree Warden', alt: 'morph' }, { resolve: true },
      { activate: 'Lightning Greaves', targets: [['Ainok Survivalist']] }, { resolve: true },
      { cast: 'Grizzly Bears' }, { resolve: true }, { resolve: true },
    ],
    expect: [
      { attachedTo: ['Lightning Greaves', 'Ainok Survivalist'] },
      { faceDown: ['Ainok Survivalist', true] },                  // shrouded: never a legal target
      { faceDown: ['Kin-Tree Warden', false] },                   // the only legal one, so the kind is not just empty
    ],
  },
  {
    // The same gate's `spec.filter` half (CR 115.4: an illegal target can't be chosen); `filter` was not read at all
    // before the fix. The discriminator is `equipped`: Bonesplitter is on the SECOND face-down permanent, so a filter
    // that is honoured turns Kin-Tree Warden face up, while a filter that is ignored turns the first permanent -
    // Ainok Survivalist - face up instead.
    name: 'the face-down-permanent target kind applies spec.filter', cr: '115.4',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Bonesplitter'], hand: ['Ainok Survivalist', 'Kin-Tree Warden', 'Grizzly Bears'] }, { bf: ['Sol Ring'] }],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'turn-face-up', target: { kind: 'face-down-permanent', controller: 'you', filter: { equipped: true } } }], text: 'unmask the armed one' }] } },
    script: [
      { cast: 'Ainok Survivalist', alt: 'morph' }, { resolve: true },
      { cast: 'Kin-Tree Warden', alt: 'morph' }, { resolve: true },
      { activate: 'Bonesplitter', targets: [['Kin-Tree Warden']] }, { resolve: true },
      { cast: 'Grizzly Bears' }, { resolve: true }, { resolve: true },
    ],
    expect: [
      { faceDown: ['Kin-Tree Warden', false] },                   // the equipped one, so the filter was read
      { faceDown: ['Ainok Survivalist', true] },
      { events: { type: 'transform', min: 1, max: 1 } },
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
    // `TriggerRule.make` sees only the trigger head, so the parser claims "At the beginning of your first main phase"
    // on 33 cards whose BODY still holds an `unknown` clause. Firing those would put an inert ability on the stack
    // every turn for the rest of the game - strictly worse than the pre-9.1 reading, where the head was `unknown` and
    // the ability never fired. The family's trigger declines an ability it cannot run end to end
    // (src/engine/ops/transform.ts:bodySimulable); Ripples of Undeath is one of the 33.
    name: 'a first-main-phase trigger whose body is only partly parsed does not fire at all', cr: '505.1',
    seats: [{ bf: ['Ripples of Undeath'], libraryTop: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, {}],
    script: [{ turns: 2 }],
    expect: [{ unsimulated: 0 }, { graveyardCount: [0, 0] }],     // no mill, and no inert-text hit either
  },
  {
    // The second half of the same gate (9.1 review 2), closed by 9.1x item 15: "unless you pay {E}" is energy
    // (CR 118.12: energy counters are paid from the player's pool, not with mana). The parser now puts `energy: 1` on
    // the `sacrifice-unless-pay`, so a player with no energy cannot keep Static Prison, and `misparsed` no longer
    // declines the trigger.
    name: 'Static Prison is sacrificed in the first main phase of a player with no energy to pay {E}', cr: '118.12',
    seats: [{ bf: ['Static Prison'] }, {}],
    script: [{ turns: 2 }],
    expect: [
      { zone: ['Static Prison', 'graveyard'] },
      { noLog: 'pays \\{E\\}' },                                  // no payment was possible, none is claimed
      { unsimulated: 0 },
    ],
  },
  {
    // The other misparse, closed by 9.1x item 14: `game.ts`'s `case 'add-mana'` now multiplies the symbol list by
    // `perEach`, so "add {B} for each charge counter on ~" adds three {B} for three counters (one `mana` event per
    // symbol list), and `misparsed` no longer declines the trigger.
    name: 'Black Market\'s first-main-phase trigger adds one {B} per charge counter', cr: '505.1',
    seats: [{ bf: ['Black Market'], counters: { 'Black Market': { charge: 3 } } }, {}],
    script: [{ turns: 2 }],
    expect: [
      { counters: ['Black Market', { charge: 3 }] },
      { events: { type: 'mana', min: 3, max: 3 } },               // three {B}: one per charge counter, not one stray {B}
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a first-main-phase trigger with whose: each fires in every player\'s precombat main phase', cr: '505.1',
    seats: [{ bf: ['Grizzly Bears'] }, {}],
    scripts: { 'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'first-main-phase', whose: 'each' }, effects: [{ op: 'gain-life', amount: 1, who: 'you' }], text: 'each main phase' }] } },
    script: [{ turns: 2 }],
    expect: [{ life: [0, 22] }],
  },

  // ---------------------------------------------------------------- a transformation that kills the permanent (9.1 review 2)
  {
    // CR 603.2: the ability triggers when the event happens; nothing requires the object to survive it (CR 603.10a's
    // look-back applies to leaves-the-battlefield triggers, not to this). Every werewolf SHRINKS when it flips back
    // at dawn - Graveyard Glutton 4/4 -> Graveyard Trespasser 3/3 - so a damaged one dies to the very state-based
    // action pass that follows the flip. While `transforms` was raised by the `sba` watcher alone, the permanent was
    // already in the graveyard (SBA_HOOKS run after the lethal-damage loop of the same checkSBA pass) and the trigger
    // was silently lost. `flip` now announces the transformation itself, so the death cannot swallow it.
    name: 'a transforms trigger fires even when the transformation kills the permanent that transformed', cr: '603.2',
    seats: [{ bf: [TRESPASSER, 'Grizzly Bears', 'Mountain', 'Mountain', 'Forest'], hand: ['Lightning Bolt', 'Shock', 'Giant Growth'] }, {}],
    scripts: {
      ...spell('Lightning Bolt', [{ op: 'set-day-night', to: 'night' }]),
      ...spell('Shock', [{ op: 'damage', amount: 3, target: { kind: 'creature', controller: 'you' } }]),
      ...spell('Giant Growth', [{ op: 'set-day-night', to: 'day' }]),
      'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'transforms', self: false, filter: { types: ['Creature'], other: true }, controller: 'you' }, effects: [{ op: 'gain-life', amount: 5, who: 'you' }], text: 'another creature transforms' }] },
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Shock', targets: [[TRESPASSER]] }, { resolve: true }, { cast: 'Giant Growth' }, { resolve: true }],
    expect: [
      { zone: [TRESPASSER, 'graveyard'] },                        // 3 damage on the 3/3 front face it flipped back to
      { log: 'transforms into Graveyard Trespasser' },
      { life: [0, 30] },                                          // +5 at dusk AND +5 at dawn, not just the first
    ],
  },
  {
    // The same rule through the family's own `transform` op rather than the daybound machinery, and on the permanent's
    // OWN trigger: the ability that fires is the one on the face that is now up (CR 701.27a), and it fires even though
    // that face - Delver of Secrets, 1/1 - dies immediately to the 1 damage Insectile Aberration was carrying.
    name: 'a self transforms trigger fires when the flip shrinks the permanent to lethal damage', cr: '603.2',
    seats: [{ bf: [DELVER, 'Mountain', 'Mountain', 'Forest'], hand: ['Lightning Bolt', 'Shock', 'Giant Growth'] }, {}],
    scripts: {
      ...toBack('Lightning Bolt'),
      ...spell('Shock', [{ op: 'damage', amount: 1, target: { kind: 'creature', controller: 'you' } }]),
      ...toFront('Giant Growth'),
      [DELVER]: { mode: 'replace', abilities: [{ kind: 'triggered', event: { on: 'transforms', self: true }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'transform trigger' }] },
    },
    script: [{ cast: 'Lightning Bolt', targets: [[DELVER]] }, { resolve: true }, { cast: 'Shock', targets: [[DELVER]] }, { resolve: true }, { cast: 'Giant Growth', targets: [[DELVER]] }, { resolve: true }],
    expect: [
      { zone: [DELVER, 'graveyard'] },
      { life: [0, 23] },                                          // the front face's trigger still resolved
      { events: { type: 'transform', min: 2, max: 2 } },
    ],
  },
];
