// The layers family (Phase 9.1, docs/vocabulary/layers.md): one scenario per op, per static, per condition, per
// as-enters kind and per keyword parameter of each of them.
//
// A type, a subtype and a colour are not expectations the scenario DSL has, so every scenario here asserts the layer
// through something the rules do with it and nothing else could produce:
//
//   * a land that became a Swamp turns swampwalk on — the block is really offered and must be REFUSED (`refused`);
//   * a permanent that became an artifact can be Shattered — the spell has no legal target otherwise;
//   * a creature that became black, or a Goblin, or every creature type, is reached by an anthem filtered on exactly
//     that characteristic, so the change shows up in `pt`;
//   * a land that became a 0/0 creature dies to the state-based action (CR 704.5f).
//
// The anthems are scripted onto real cards (the printed colour and kindred lords in the pool do not parse yet), the
// same device test/scenarios/composition.ts uses; the cards, the lands, the combat and the expectations are real.
import type { Ability, Effect, StaticEffect } from '../../src/cards/types.js';
import { attackWith, type Scenario, type ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>" (its printed vanilla body stays). */
const bears = (effects: Effect[], text = 'layers'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects, text }] } });
/** A static ability, as a script face for one card. */
const staticOn = (card: string, effect: StaticEffect, text = 'layers'): Record<string, ScenarioScript> =>
  ({ [card]: { abilities: [{ kind: 'static', effect, text }] } });
/** "<filter> creatures get +N/+N" as a scripted static, the probe every colour / subtype scenario reads its layer with. */
const anthem = (filter: Record<string, unknown>, power = 1, toughness = 1, anyPermanent = false): StaticEffect =>
  ({ kind: 'anthem', power, toughness, filter, scope: 'all', ...(anyPermanent ? { anyPermanent: true } : {}) } as unknown as StaticEffect);
const tc = (fields: Record<string, unknown>): StaticEffect => ({ kind: 'type-change', ...fields } as unknown as StaticEffect);
const act = (effects: Effect[], text = 'layers'): Ability => ({ kind: 'activated', cost: {}, effects, text });

export const layers: Scenario[] = [
  // ---------------------------------------------------------------- `become`: the one-shot layer

  {
    name: 'become makes a land a Swamp, so swampwalk stops the defender blocking', cr: '613.1d',
    ruling: 'A subtype-changing effect (layer 4) is what landwalk reads: the defending player now controls a Swamp.',
    seats: [{ bf: ['Grizzly Bears', 'Bog Wraith'] }, { bf: ['Forest', 'Runeclaw Bear'] }],
    scripts: bears([{ op: 'become', target: { kind: 'land' }, subtypes: ['Swamp'], duration: 'eot' } as unknown as Effect]),
    script: [
      { activate: 'Grizzly Bears', targets: [['Forest']] }, { resolve: true },
      attackWith(['Bog Wraith'], [], [['Runeclaw Bear', 'Bog Wraith']]),
    ],
    expect: [{ life: [1, 17] }, { zone: ['Runeclaw Bear', 'battlefield'] }, { noLog: 'Runeclaw Bear blocks' }],
  },
  {
    name: 'become adds a card type: a land that became an artifact is a legal target for Shatter', cr: '205.1b',
    ruling: 'Layer 4 adds the type; the land keeps its own (CR 205.1b, "in addition to its other types").',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Shatter'] }, { bf: ['Forest'] }],
    scripts: bears([{ op: 'become', target: { kind: 'land' }, types: ['Artifact'], duration: 'permanent' } as unknown as Effect]),
    script: [{ activate: 'Grizzly Bears', targets: [['Forest']] }, { resolve: true }, { cast: 'Shatter', targets: [['Forest']] }, { resolve: true }],
    expect: [{ zone: ['Forest', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: 'become sets a base power and toughness (layer 7b), so the animated land is a 4/4', cr: '613.4b',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bears([{ op: 'become', target: { kind: 'land' }, types: ['Creature'], subtypes: ['Golem'], power: 4, toughness: 4, duration: 'eot' } as unknown as Effect]),
    script: [{ activate: 'Grizzly Bears', targets: [['Forest']] }, { resolve: true }],
    expect: [{ pt: ['Forest', 4, 4] }, { pt: ['Grizzly Bears', 2, 2] }],
  },
  {
    name: 'become grants the keywords it names (layer 6)', cr: '613.1f',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bears([{ op: 'become', target: { kind: 'land' }, types: ['Creature'], subtypes: ['Elemental'], power: 3, toughness: 3, keywords: ['haste', 'trample'], duration: 'eot' } as unknown as Effect]),
    script: [{ activate: 'Grizzly Bears', targets: [['Forest']] }, { resolve: true }],
    expect: [{ keywords: ['Forest', ['haste', 'trample']] }, { pt: ['Forest', 3, 3] }],
  },
  {
    name: 'become changes colour (layer 5): a black anthem now reaches the creature', cr: '613.1e',
    ruling: 'A colour-setting effect replaces the printed colours entirely (CR 105.2, 613.1e).',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'become', target: { kind: 'creature' }, colors: ['B'], duration: 'eot' } as unknown as Effect], text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ colors: ['B'] }), text: 'layers' }] },
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 4, 4] }, { pt: ['Grizzly Bears', 2, 2] }],
  },
  {
    name: 'become with everyCreatureType makes the target a Goblin for a Goblin anthem', cr: '702.73a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'become', target: { kind: 'creature' }, everyCreatureType: true, duration: 'permanent' } as unknown as Effect], text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ subtypes: ['Goblin'] }, 2, 2), text: 'layers' }] },
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 5, 5] }, { pt: ['Grizzly Bears', 2, 2] }],
  },
  {
    name: "become with duration 'eot' ends in the cleanup step", cr: '514.2',
    ruling: 'The layer is gone, so the land is a land again — which is why `pt` cannot be asked for it any more. The '
      + "engine's record of the layer (o.ext.layers) is empty; the sibling scenario shows a `permanent` one surviving.",
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bears([{ op: 'become', target: { kind: 'land' }, types: ['Creature'], subtypes: ['Golem'], power: 4, toughness: 4, duration: 'eot' } as unknown as Effect]),
    script: [{ activate: 'Grizzly Bears', targets: [['Forest']] }, { resolve: true }, { turns: 1 }],
    expect: [{ ext: ['Forest', 'layers', undefined] }, { zone: ['Forest', 'battlefield'] }],
  },
  {
    name: "become with duration 'permanent' survives the cleanup step", cr: '611.2b',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, {}],
    scripts: bears([{ op: 'become', target: { kind: 'land' }, types: ['Creature'], subtypes: ['Golem'], power: 4, toughness: 4, duration: 'permanent' } as unknown as Effect]),
    script: [{ activate: 'Grizzly Bears', targets: [['Forest']] }, { resolve: true }, { turns: 1 }],
    expect: [{ pt: ['Forest', 4, 4] }, { zone: ['Forest', 'battlefield'] }],
  },
  {
    name: "become with target 'self' changes the source itself", cr: '613.1d',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Shatter'] }, {}],
    scripts: bears([{ op: 'become', target: 'self', types: ['Artifact'], duration: 'permanent' } as unknown as Effect]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { cast: 'Shatter', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: "become with the Ref 'that' acts on what the previous effect touched", cr: '608.2c',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [
        { op: 'pump', target: { kind: 'creature' }, power: 1, toughness: 0, duration: 'eot' },
        { op: 'become', target: 'that', colors: ['B'], duration: 'eot' } as unknown as Effect,
      ], text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ colors: ['B'] }), text: 'layers' }] },
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ pt: ['Hill Giant', 5, 4] }, { pt: ['Grizzly Bears', 2, 2] }],
  },
  {
    name: "become with the group word 'creatures-you-control' reaches your creatures and not the opponent's", cr: '613.1e',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'become', target: 'creatures-you-control', colors: ['B'], duration: 'eot' } as unknown as Effect], text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ colors: ['B'] }), text: 'layers' }] },
    },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 3, 3] }, { pt: ['Hill Giant', 4, 4] }, { pt: ['Runeclaw Bear', 2, 2] }],
  },

  // ---------------------------------------------------------------- `type-change`: the static layer

  {
    name: "type-change scope 'all' makes every land a Swamp, so swampwalk is on", cr: '613.1d',
    ruling: 'The Urborg layer, SCRIPTED: the printed card is declined by the parser (CR 305.6 — a basic land type '
      + 'brings an intrinsic "{T}: Add {B}" this engine cannot grant), and the scenario after this one pins that '
      + 'decline. The layer itself is real, and a script may still write it: it is what landwalk reads.',
    seats: [{ bf: ['Bog Wraith', 'Hill Giant'] }, { bf: ['Forest', 'Runeclaw Bear'] }],
    scripts: staticOn('Hill Giant', tc({ scope: 'all', filter: { types: ['Land'] }, subtypes: ['Swamp'] })),
    script: [{ sba: true }, attackWith(['Bog Wraith'], [], [['Runeclaw Bear', 'Bog Wraith']])],
    expect: [{ life: [1, 17] }, { zone: ['Runeclaw Bear', 'battlefield'] }, { noLog: 'Runeclaw Bear blocks' }],
  },
  {
    name: 'the printed basic-land-type wordings are DECLINED, so Urborg does nothing at all', cr: '305.6',
    ruling: 'A land with a basic land type intrinsically has "{T}: Add {B}" for it (CR 305.6), and an effect that '
      + 'SETS a land type also takes the old land types away (CR 305.7). This engine expresses neither, so the parser '
      + 'rules decline the wording outright rather than half-claiming it: Urborg, Blanket of Night, Evil Presence, '
      + 'Spreading Seas, Sea\u2019s Claim and Tidal Warrior keep their line in `unparsed`. The Forest here is still a '
      + 'Forest, swampwalk is OFF, and the block is really made.',
    seats: [{ bf: ['Bog Wraith', 'Urborg, Tomb of Yawgmoth'] }, { bf: ['Forest', 'Runeclaw Bear'] }],
    // the parser declines the line; a per-card script in the store may cover it (10.0 re-run wrote one), so the
    // premise "no layer at all" is pinned here with an empty face rather than read from the store
    scripts: { 'Urborg, Tomb of Yawgmoth': { abilities: [], mode: 'replace' } },
    script: [{ sba: true }, attackWith(['Bog Wraith'], [['Runeclaw Bear', 'Bog Wraith']])],
    expect: [{ life: [1, 20] }, { zone: ['Runeclaw Bear', 'graveyard'] }, { events: { type: 'block', min: 1 } }, { log: /Runeclaw Bear deals 2 damage to Bog Wraith/ }],
  },
  {
    name: "type-change scope 'enchanted' reads the basic land type its Aura chose as it entered", cr: '613.1d',
    ruling: 'The chain Convincing Mirage and Phantasmal Terrain are printed with: an as-enters "choose a basic land '
      + 'type" writes `o.ext.chosenLandType` on the AURA, and the enchanted-scope layer reads that slot — not '
      + '`chosen.creatureType`, which nothing on those cards ever writes. Both cards are themselves declined by CR '
      + '305.6; this is the engine half, scripted onto Evil Presence so the Aura is cast on a real land.',
    seats: [{ bf: ['Bog Wraith', 'Swamp'], hand: ['Evil Presence'] }, { bf: ['Forest', 'Runeclaw Bear'] }],
    scripts: {
      'Evil Presence': {
        mode: 'replace',
        asEnters: [{ kind: 'choose-type', what: 'basic-land-type' } as never],
        abilities: [
          { kind: 'static', effect: { kind: 'aura', power: 0, toughness: 0, keywords: [], enchant: { kind: 'land' } } as unknown as StaticEffect, text: 'layers' },
          { kind: 'static', effect: tc({ scope: 'enchanted', subtypes: 'chosen-basic-land-type' }), text: 'layers' },
        ],
      },
    },
    script: [
      { answer: 'Swamp' }, { cast: 'Evil Presence', targets: [['Forest']] }, { resolve: true },
      attackWith(['Bog Wraith'], [], [['Runeclaw Bear', 'Bog Wraith']]),
    ],
    expect: [{ attachedTo: ['Evil Presence', 'Forest'] }, { ext: ['Evil Presence', 'chosenLandType', 'Swamp'] }, { life: [1, 17] }, { noLog: 'Runeclaw Bear blocks' }],
  },
  {
    name: "type-change scope 'you-control' with a filter animates only your lands, and a 0/0 land dies", cr: '704.5f',
    ruling: 'A land that becomes a creature with no power or toughness set is 0/0 and is put into its graveyard.',
    seats: [{ bf: ['Grizzly Bears', 'Forest'] }, { bf: ['Island'] }],
    scripts: staticOn('Grizzly Bears', tc({ scope: 'you-control', filter: { types: ['Land'] }, types: ['Creature'] })),
    script: [{ sba: true }],
    expect: [{ zone: ['Forest', 'graveyard'] }, { zone: ['Island', 'battlefield'] }, { events: { type: 'sba', min: 1 } }],
  },
  {
    name: "type-change scope 'equipped' with everyCreatureType makes the equipped creature a Goblin", cr: '702.73a',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Bonesplitter', 'Mountain'] }, {}],
    scripts: {
      Bonesplitter: { abilities: [{ kind: 'static', effect: tc({ scope: 'equipped', everyCreatureType: true }), text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ subtypes: ['Goblin'] }, 2, 2), text: 'layers' }] },
    },
    script: [{ activate: 'Bonesplitter', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ attachedTo: ['Bonesplitter', 'Grizzly Bears'] }, { pt: ['Grizzly Bears', 6, 4] }, { pt: ['Hill Giant', 3, 3] }],
  },
  {
    name: "type-change scope 'all' with a colour list recolours every creature, yours and theirs", cr: '613.1e',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'static', effect: tc({ scope: 'all', filter: { types: ['Creature'] }, colors: ['B'] }), text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ colors: ['B'] }), text: 'layers' }] },
    },
    script: [{ sba: true }],
    expect: [{ pt: ['Grizzly Bears', 3, 3] }, { pt: ['Hill Giant', 4, 4] }, { pt: ['Runeclaw Bear', 3, 3] }],
  },
  {
    name: "Mistform Ultimus is every creature type, so a Goblin anthem pumps it (type-change scope 'self')", cr: '702.73a',
    seats: [{ bf: ['Mistform Ultimus', 'Hill Giant'] }, {}],
    scripts: staticOn('Hill Giant', anthem({ subtypes: ['Goblin'] }, 2, 2)),
    script: [{ sba: true }],
    expect: [{ pt: ['Mistform Ultimus', 5, 5] }, { pt: ['Hill Giant', 3, 3] }],
  },

  // ---------------------------------------------------------------- `choose-type` and the `chosen-…` slots

  {
    name: "choose-type 'color' feeds a scope 'self' type-change with colors 'chosen'", cr: '105.2',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      'Grizzly Bears': { abilities: [act([{ op: 'choose-type', what: 'color' } as unknown as Effect]), { kind: 'static', effect: tc({ scope: 'self', colors: 'chosen' }), text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ colors: ['B'] }), text: 'layers' }] },
    },
    script: [{ answer: 'B' }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 3, 3] }, { pt: ['Hill Giant', 3, 3] }, { log: 'chooses black' }],
  },
  {
    name: "choose-type 'creature-type' feeds a type-change with subtypes 'chosen-creature-type'", cr: '205.1b',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'], graveyard: ['Raging Goblin'] }, {}],
    scripts: {
      'Grizzly Bears': { abilities: [act([{ op: 'choose-type', what: 'creature-type' } as unknown as Effect]), { kind: 'static', effect: tc({ scope: 'self', subtypes: 'chosen-creature-type' }), text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ subtypes: ['Goblin'] }, 2, 2), text: 'layers' }] },
    },
    script: [{ answer: 'Goblin' }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 4] }, { pt: ['Hill Giant', 3, 3] }, { log: 'chooses Goblin' }],
  },
  {
    name: "choose-type 'basic-land-type' feeds a type-change with subtypes 'chosen-basic-land-type'", cr: '305.7',
    seats: [{ bf: ['Grizzly Bears', 'Bog Wraith'] }, { bf: ['Forest', 'Runeclaw Bear'] }],
    scripts: {
      'Grizzly Bears': { abilities: [act([{ op: 'choose-type', what: 'basic-land-type' } as unknown as Effect]), { kind: 'static', effect: tc({ scope: 'all', filter: { types: ['Land'] }, subtypes: 'chosen-basic-land-type' }), text: 'layers' }] },
    },
    script: [
      { answer: 'Swamp' }, { activate: 'Grizzly Bears' }, { resolve: true },
      attackWith(['Bog Wraith'], [], [['Runeclaw Bear', 'Bog Wraith']]),
    ],
    expect: [{ ext: ['Grizzly Bears', 'chosenLandType', 'Swamp'] }, { life: [1, 17] }, { noLog: 'Runeclaw Bear blocks' }],
  },
  {
    name: 'the choose-type as-enters records a basic land type as the permanent enters', cr: '614.12',
    seats: [{ bf: ['Bog Wraith'], hand: ['Plains'] }, { bf: ['Forest', 'Runeclaw Bear'] }],
    scripts: {
      Plains: { asEnters: [{ kind: 'choose-type', what: 'basic-land-type' } as never], abilities: [{ kind: 'static', effect: tc({ scope: 'all', filter: { types: ['Land'] }, subtypes: 'chosen-basic-land-type' }), text: 'layers' }] },
    },
    script: [
      { answer: 'Swamp' }, { playLand: 'Plains' }, { sba: true },
      attackWith(['Bog Wraith'], [], [['Runeclaw Bear', 'Bog Wraith']]),
    ],
    expect: [{ ext: ['Plains', 'chosenLandType', 'Swamp'] }, { life: [1, 17] }, { noLog: 'Runeclaw Bear blocks' }],
  },

  // ---------------------------------------------------------------- `attached-is`: the "as long as" condition

  {
    name: "attached-is holds when the host matches, so the enchanted Bear is every creature type", cr: '611.2c',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Forest'], hand: ['Rancor'] }, {}],
    scripts: {
      Rancor: { abilities: [{ kind: 'static', effect: tc({ scope: 'enchanted', everyCreatureType: true, condition: { kind: 'attached-is', filter: { subtypes: ['Bear'] } } }), text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ subtypes: ['Goblin'] }, 2, 2), text: 'layers' }] },
    },
    script: [{ cast: 'Rancor', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ attachedTo: ['Rancor', 'Grizzly Bears'] }, { pt: ['Grizzly Bears', 6, 4] }, { pt: ['Hill Giant', 3, 3] }],
  },
  {
    name: 'attached-is fails when the host does not match, so no layer is applied', cr: '611.2c',
    seats: [{ bf: ['Hill Giant', 'Grizzly Bears', 'Forest'], hand: ['Rancor'] }, {}],
    scripts: {
      Rancor: { abilities: [{ kind: 'static', effect: tc({ scope: 'enchanted', everyCreatureType: true, condition: { kind: 'attached-is', filter: { subtypes: ['Bear'] } } }), text: 'layers' }] },
      'Grizzly Bears': { abilities: [{ kind: 'static', effect: anthem({ subtypes: ['Goblin'] }, 2, 2), text: 'layers' }] },
    },
    script: [{ cast: 'Rancor', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ attachedTo: ['Rancor', 'Hill Giant'] }, { pt: ['Hill Giant', 5, 3] }, { pt: ['Grizzly Bears', 2, 2] }],
  },
  {
    name: "attached-is with of 'self' reads the source's own characteristics", cr: '611.2c',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Shatter'] }, {}],
    scripts: staticOn('Grizzly Bears', tc({ scope: 'self', types: ['Artifact'], condition: { kind: 'attached-is', of: 'self', filter: { subtypes: ['Bear'] } } })),
    script: [{ sba: true }, { cast: 'Shatter', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }],
  },

  // ---------------------------------------------------------------- `exchange-life-toughness`

  {
    name: "Tree of Perdition exchanges an opponent's life total with its own toughness", cr: '701.12',
    ruling: "The exchange sets the creature's base toughness (layer 7b), so counters still apply on top of it.",
    seats: [{ bf: ['Tree of Perdition'] }, { life: 20 }],
    script: [{ activate: 'Tree of Perdition', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 13] }, { pt: ['Tree of Perdition', 0, 20] }, { unsimulated: 0 }],
  },
  {
    name: "exchange-life-toughness with an explicit `permanent` Ref uses the bound permanent, not the source", cr: '613.4b',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { life: 20 }],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [
        { op: 'pump', target: { kind: 'creature' }, power: 0, toughness: 0, duration: 'eot' },
        { op: 'exchange-life-toughness', target: { kind: 'opponent' }, permanent: 'that' } as unknown as Effect,
      ], text: 'layers' }] },
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant'], ['P1']] }, { resolve: true }],
    expect: [{ life: [1, 3] }, { pt: ['Hill Giant', 3, 20] }, { pt: ['Grizzly Bears', 2, 2] }],
  },

  // ---------------------------------------------------------------- the continuous-effects pass itself

  {
    name: "a type-change static's layer is TAKEN BACK when its source leaves the battlefield", cr: '611.2b',
    ruling: 'A static ability\u2019s continuous effect exists only while its source is on the battlefield (CR 611.2b) '
      + 'and ends the moment the source stops existing (CR 613.6). This family PROJECTS its layers into `o.animated`, '
      + 'so the projection pass has to run once more with no sources left to take them back; the flag `s.ext.layersOn` '
      + 'is what lets it. While the Bears live every creature is black and the anthem reaches the opponent\u2019s Bear '
      + '(the sibling scenario above pins the 3/3); once Lightning Bolt kills them the Bear is green again, at 2/2, '
      + 'and its overlay fingerprint `layersProj` is gone.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'static', effect: tc({ scope: 'all', filter: { types: ['Creature'] }, colors: ['B'] }), text: 'layers' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: anthem({ colors: ['B'] }), text: 'layers' }] },
    },
    script: [{ sba: true }, { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }],
    expect: [
      { zone: ['Grizzly Bears', 'graveyard'] }, { pt: ['Runeclaw Bear', 2, 2] }, { pt: ['Hill Giant', 3, 3] },
      { ext: ['Runeclaw Bear', 'layersProj', undefined] },
    ],
  },
  {
    name: 'a layer that sets no P/T keeps a token\u2019s DYNAMIC base power and toughness', cr: '613.4b',
    ruling: 'Layer 7b is only touched by an effect that sets a base P/T; a colour-only layer must leave it alone. '
      + 'A token whose base P/T is "0/0 plus a count" (Urza\u2019s Saga\u2019s Construct) reads that count through '
      + '`token.dynamicPT`, which `baseP` adds only while nothing is projected \u2014 so the overlay has to carry the '
      + 'evaluated total, not the printed 0/0, or CR 704.5f puts the token in the graveyard the instant any layer '
      + 'touches it. Three creatures here, so the Construct is a 3/3 and survives; the anthem is filtered to Bears so '
      + 'that it cannot prop the token up, and Grizzly Bears at 3/3 is the proof the colour layer really is applied.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [
        { op: 'token', count: 1, power: 0, toughness: 0, colors: [], types: ['Artifact', 'Creature'], subtypes: ['Construct'], keywords: [], name: 'Construct', dynamicPT: { count: 'permanents-you-control', filter: { types: ['Creature'] } } } as unknown as Effect,
      ], text: 'layers' }] },
      'Hill Giant': { abilities: [
        { kind: 'static', effect: tc({ scope: 'all', filter: { types: ['Creature'] }, colors: ['B'] }), text: 'layers' },
        { kind: 'static', effect: anthem({ colors: ['B'], subtypes: ['Bear'] }), text: 'layers' },
      ] },
    },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { sba: true }],
    expect: [
      { zoneCount: [0, 'battlefield', 3] }, { noLog: 'is put into the graveyard' },
      { pt: ['Grizzly Bears', 3, 3] }, { pt: ['Hill Giant', 3, 3] },
    ],
  },
  {
    name: 'CR 613.7 timestamps: a `become` colour resolving now beats a type-change static already in play', cr: '613.7',
    ruling: 'Within layer 5 the effects apply in timestamp order, and a static\u2019s timestamp is when its source '
      + 'entered the battlefield \u2014 which is before the one-shot that is resolving right now. So the Bear the '
      + 'static had made black is red, and the red anthem reaches it; Grizzly Bears, a Bear the one-shot did not '
      + 'touch, is still black and still 2/2.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'become', target: { kind: 'creature' }, colors: ['R'], duration: 'eot' } as unknown as Effect], text: 'layers' }] },
      'Hill Giant': { abilities: [
        { kind: 'static', effect: tc({ scope: 'all', filter: { subtypes: ['Bear'] }, colors: ['B'] }), text: 'layers' },
        { kind: 'static', effect: anthem({ colors: ['R'] }, 3, 3), text: 'layers' },
      ] },
    },
    script: [{ sba: true }, { activate: 'Grizzly Bears', targets: [['Runeclaw Bear']] }, { resolve: true }],
    // Hill Giant is printed RED and is a Giant, so the static never reaches it and its own anthem does: 6/6.
    expect: [{ pt: ['Runeclaw Bear', 5, 5] }, { pt: ['Grizzly Bears', 2, 2] }, { pt: ['Hill Giant', 6, 6] }],
  },

  // ---------------------------------------------------------------- end to end, through the parser

  {
    name: 'Liquimetal Coating makes a land an artifact until end of turn, and Shatter destroys it', cr: '205.1b',
    seats: [{ bf: ['Liquimetal Coating', 'Mountain', 'Mountain'], hand: ['Shatter'] }, { bf: ['Forest'] }],
    script: [{ activate: 'Liquimetal Coating', targets: [['Forest']] }, { resolve: true }, { cast: 'Shatter', targets: [['Forest']] }, { resolve: true }],
    expect: [{ zone: ['Forest', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: 'a "becomes a <creature type>" that does not say "in addition" is DECLINED (Mild-Mannered Librarian)', cr: '205.1a',
    ruling: 'CR 205.1a: "when an effect sets one or more of an object’s subtypes, the new subtype(s) replaces any '
      + 'existing subtypes from the appropriate set (creature types, …)". "This creature becomes a Werewolf" therefore '
      + 'makes the printed HUMAN a Werewolf and only a Werewolf. Three readings, three numbers, and this scenario '
      + 'separates all of them: the card is 1/1, the ability puts two +1/+1 counters on it, a scripted Werewolf anthem '
      + 'gives +2/+2 and a scripted Human anthem +1/+1. CR-correct is 5/5 (Werewolf, not Human). The additive engine '
      + 'cannot take the Human away — `characteristics.ts:subtypes()` UNIONS `o.animated` with the printed list — so '
      + 'claiming the line gave 6/6, BOTH lords, strictly more than the card grants; that is the same over-claim the '
      + 'basic-land-type decline above removes (CR 305.7), applied to creature types. Declined, the clause is reported '
      + 'as unsimulated text and the rest of the ability still resolves: 1/1 + two counters + the Human anthem = 4/4. '
      + 'Omnibian, Mimic, Dire Mimic, Serpentine Ambush and Startling Development leave `fullyParsed` for the same '
      + 'reason; their abilities are ALL-unknown, so the engine does not even offer them (legal.ts).',
    seats: [{ bf: ['Mild-Mannered Librarian', 'Hill Giant', 'Runeclaw Bear', 'Forest', 'Forest', 'Forest', 'Forest'] }, {}],
    scripts: { ...staticOn('Hill Giant', anthem({ subtypes: ['Werewolf'] }, 2, 2)), ...staticOn('Runeclaw Bear', anthem({ subtypes: ['Human'] })) },
    script: [{ activate: 'Mild-Mannered Librarian' }, { resolve: true }],
    expect: [{ pt: ['Mild-Mannered Librarian', 4, 4] }, { counters: ['Mild-Mannered Librarian', { '+1/+1': 2 }] }, { log: /unsimulated text: "~ becomes a Werewolf/ }],
  },
  {
    name: 'an Aura’s "Enchanted creature is a Demon Spirit." is DECLINED (Oni Possession)', cr: '205.1a',
    ruling: 'The static half of the same rule. Oni Possession SETS the creature types, so under CR 205.1a the enchanted '
      + 'Bear is a Demon Spirit and nothing else — a Demon anthem reaches it and a Bear anthem no longer does. The '
      + 'engine can only add, so the claimed reading (Bear + Demon + Spirit) was strictly more than the card grants: '
      + 'the Demon anthem AND every Bear lord. Declined, the type line is left in `unparsed` and the Aura’s other '
      + 'line still works: the Bear is 2/2 + the printed +3/+3 = 5/5 with trample, and the Demon anthem misses it '
      + '(it read 6/6 while the line was claimed).',
    seats: [{ bf: ['Hill Giant', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['Oni Possession'] }, { bf: ['Grizzly Bears'] }],
    scripts: staticOn('Hill Giant', anthem({ subtypes: ['Demon'] })),
    script: [{ cast: 'Oni Possession', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 5, 5] }, { keywords: ['Grizzly Bears', ['trample']] }, { attachedTo: ['Oni Possession', 'Grizzly Bears'] }],
  },
  {
    // 9.1 merge: a pronoun subject of "becomes" after an antecedent is the bound object, not the source. Ashnod's
    // Transmogrant is sacrificed as a cost, so a `become` on the source would land on nothing; the Bears must become
    // an artifact (2/2 + the counter + an artifact-creature anthem = 4/4).
    name: "'That creature becomes an artifact' after a target lands on the target, not the source (Ashnod's Transmogrant)", cr: '608.2c',
    seats: [{ bf: ["Ashnod's Transmogrant", 'Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: staticOn('Hill Giant', anthem({ types: ['Artifact'] })),
    script: [{ activate: "Ashnod's Transmogrant", targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ["Ashnod's Transmogrant", 'graveyard'] }, { pt: ['Grizzly Bears', 4, 4] }, { unsimulated: 0 }],
  },
];
