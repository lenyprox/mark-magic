// The copy / clone family (Phase 9.1, docs/vocabulary/copy-clone.md): one scenario per op, per keyword parameter of
// the "except ..." clause, per as-enters kind, per static and per target kind the family registers.
//
// Most of them use real printed cards, because the parser rules of this slice make those cards parse: Cackling
// Counterpart, The Scarab God, Reverberate, Lithoform Engine, Swerve, Redirect, Untimely Malfunction, Deflecting
// Swat and Clone. The two shapes no printed card parses into yet — `become-copy` and the `cant-be-copied` static —
// script a real card through the DSL's `scripts` field, the way test/scenarios/composition.ts does.
//
// Every expectation is written so that it FAILS if the op did nothing: a life total the copy changed, a power and
// toughness the exception set, a permanent count only the token can reach, a target only the retarget could move.
import type { Effect, TargetSpec } from '../../src/cards/types.js';
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>", or an end-step trigger with them (the printed 2/2 body stays). */
const bears = (effects: Effect[], text = 'copy-clone', kind: 'activated' | 'triggered' = 'activated'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [kind === 'activated'
    ? { kind: 'activated', cost: { tap: true }, effects, text }
    : { kind: 'triggered', event: { on: 'end-step', whose: 'your' }, effects, text }] } });

const creature: TargetSpec = { kind: 'creature' };

export const copyClone: Scenario[] = [
  // ------------------------------------------------------------------ copy-permanent
  {
    name: "Cackling Counterpart creates a token that's a copy of a creature you control", cr: '707.2',
    ruling: 'The token copies the copiable values of the printed card, so it is a second 2/2 Grizzly Bears.',
    seats: [
      { bf: ['Island', 'Island', 'Island', 'Grizzly Bears'], hand: ['Cackling Counterpart'] },
      { bf: ['Mountain'] },
    ],
    script: [{ cast: 'Cackling Counterpart', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [
      // three Islands + the printed Bears + the token; 4 would mean no token was made
      { zoneCount: [0, 'battlefield', 5] },
      { events: { type: 'create-token', min: 1, max: 1 } },
      { log: 'creates a token copy of Grizzly Bears' },
      { unsimulated: 0 },
    ],
  },
  {
    name: "The Scarab God's token copy is a 4/4 black Zombie (the copy exception overrides P/T, colour and creature type)", cr: '707.9a',
    ruling: 'CR 707.9a: the copy has the copiable values of the exiled card except for what the effect states, so it is 4/4 rather than 2/2.',
    seats: [
      { bf: ['Island', 'Island', 'Swamp', 'Swamp', 'The Scarab God'], graveyard: ['Grizzly Bears'] },
      { bf: ['Mountain'] },
    ],
    script: [{ activate: 'The Scarab God', ability: 1, targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [
      // the battlefield copy is found before the exiled card: 2/2 would mean the exception did nothing
      { pt: ['Grizzly Bears', 4, 4] },
      { zone: ['Grizzly Bears', 'battlefield'] },
      { zoneCount: [0, 'exile', 1] },
      { events: { type: 'create-token', min: 1, max: 1 } },
    ],
  },
  {
    name: "a permanent with \"can't be copied\" produces no token", cr: '707.2',
    ruling: 'The ability is a restriction on the copy effect, not on targeting: the spell resolves and simply makes nothing.',
    seats: [
      { bf: ['Island', 'Island', 'Island', 'Hill Giant'], hand: ['Cackling Counterpart'] },
      { bf: ['Mountain'] },
    ],
    scripts: { 'Hill Giant': { abilities: [{ kind: 'static', effect: { kind: 'cant-be-copied', scope: 'self' }, text: "Hill Giant can't be copied." }] } },
    script: [{ cast: 'Cackling Counterpart', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [
      { zoneCount: [0, 'battlefield', 4] },                 // three Islands + Hill Giant, no token
      { events: { type: 'create-token', min: 0, max: 0 } },
      { log: "can't be copied" },
      { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ copy-stack (spells)
  {
    name: 'Reverberate copies Lightning Bolt and both deal 3 damage', cr: '707.10',
    ruling: 'The copy is created on the stack and is not cast; it resolves first, then the original.',
    seats: [
      { bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Reverberate'] },
      { bf: ['Forest'] },
    ],
    script: [
      { cast: 'Lightning Bolt', targets: [['P1']] },
      { cast: 'Reverberate', targets: [['Lightning Bolt']] },
      { resolve: true },
    ],
    expect: [
      { life: [1, 14] },                                   // 17 would mean the copy never resolved
      { events: { type: 'damage', min: 2, max: 2 } },
      { log: 'copies Lightning Bolt' },
      { unsimulated: 0 },
    ],
  },
  {
    name: "Reverberate's copy is redirected off its controller's own creature by \"you may choose new targets for the copy\"", cr: '115.7b',
    ruling: 'CR 707.10c: the copy\'s controller may choose new legal targets for it; the original keeps its own.',
    seats: [
      { bf: ['Mountain', 'Mountain', 'Grizzly Bears'], hand: ['Reverberate'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [
      { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] },
      { cast: 'Reverberate', by: 0, targets: [['Lightning Bolt']] },
      { resolve: true },
    ],
    expect: [
      { life: [1, 17] },                                   // 20 would mean the copy still pointed at Grizzly Bears
      { zone: ['Grizzly Bears', 'graveyard'] },            // the ORIGINAL bolt still kills it
      { log: 'chooses new targets for Lightning Bolt' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Lithoform Engine copies an activated ability on the stack', cr: '707.10',
    ruling: 'A copy of an ability has the same source and the same controller choices; both copies resolve.',
    seats: [
      { bf: ['Island', 'Island', 'Island', 'Mountain', 'Lithoform Engine', 'Grizzly Bears'] },
      { bf: ['Forest'] },
    ],
    scripts: bears([{ op: 'damage', amount: 1, target: { kind: 'player', controller: 'opponent' } as TargetSpec }], 'pinger'),
    script: [
      { activate: 'Grizzly Bears', targets: [['P1']] },
      { activate: 'Lithoform Engine', ability: 0, targets: [['Grizzly Bears']] },
      { resolve: true },
    ],
    expect: [
      { life: [1, 18] },                                   // 19 would mean the ability was never copied
      { events: { type: 'damage', min: 2, max: 2 } },
      { unsimulated: 0 },
    ],
  },

  {
    name: 'Strionic Resonator copies a TRIGGERED ability you control and nothing else', cr: '113.3c',
    ruling: "CR 113.3b-c: an activated ability and a triggered ability are different kinds of object on the stack, and \"target triggered ability you control\" names one of them. The core `ability` target kind offers every non-spell item of every player, so routing this wording there would have let Strionic Resonator copy an activated ability, and an opponent's at that (CR 115.4).",
    seats: [
      { bf: ['Island', 'Island', 'Island', 'Strionic Resonator', 'Grizzly Bears'] },
      { bf: ['Mountain'] },
    ],
    scripts: bears([{ op: 'draw', amount: 1, who: 'you' }], 'end-step draw', 'triggered'),
    // `passUntil` stops at the first decision of the end step, which is after that step's triggers reached the stack
    script: [
      { passUntil: 'end' },
      { activate: 'Strionic Resonator', targets: [['Grizzly Bears']] },
      { resolve: true },
    ],
    expect: [
      { handCount: [0, 2] },                               // 1 would mean the trigger was never copied
      { log: 'copies' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'the activated-ability target kind copies an activated ability and leaves the opponent\'s alone', cr: '113.3b',
    ruling: 'CR 707.10: the copy of an ability has the same source and the same choices; both resolve. "Target activated ability you control" is narrower than the core `ability` kind in both directions - kind and controller.',
    seats: [
      { bf: ['Grizzly Bears', 'Hill Giant'] },
      { bf: ['Mountain'] },
    ],
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'damage', amount: 1, target: { kind: 'player', controller: 'opponent' } as TargetSpec }], text: 'pinger' }] },
      'Hill Giant': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'copy-stack', target: { kind: 'stack-activated-ability', controller: 'you' } as TargetSpec }], text: 'copy an activated ability you control' }] },
    },
    script: [
      { activate: 'Grizzly Bears', targets: [['P1']] },
      { activate: 'Hill Giant', targets: [['Grizzly Bears']] },
      { resolve: true },
    ],
    expect: [
      { life: [1, 18] },                                   // 19 would mean the ability was never copied
      { events: { type: 'damage', min: 2, max: 2 } },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a copy of a permanent spell becomes a token as it resolves', cr: '707.10a',
    ruling: 'CR 707.10a: the copy is not a card, so a permanent-spell copy enters the battlefield as a token.',
    seats: [
      { bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Lithoform Engine'], hand: ['Grizzly Bears'] },
      { bf: ['Mountain'] },
    ],
    script: [
      { cast: 'Grizzly Bears' },
      { activate: 'Lithoform Engine', ability: 2, targets: [['Grizzly Bears']] },
      { resolve: true },
    ],
    expect: [
      // six Forests + Lithoform Engine + the printed Bears + the token copy; 8 would mean the copy never became one
      { zoneCount: [0, 'battlefield', 9] },
      { log: 'copies Grizzly Bears' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Wild Ricochet still copies the spell when its optional first sentence is declined', cr: '707.10',
    ruling: "Wild Ricochet prints three sentences: \"You may choose new targets for target instant or sorcery spell. Then copy that spell. You may choose new targets for the copy.\" Only the first and third are optional - CR 707.10 makes the middle one mandatory. parse.ts's `bindAntecedent` puts the `bind that from targets` INSIDE the `may` that wraps the first sentence, so declining it left 'that' unbound and `copy-stack` copied nothing at all. Declining is a normal line of play: you cast this on your OWN spell to copy it without moving the original off its target. `stackItemFor` falls back to the item's single stack target - the same object the bind would have named.",
    seats: [
      { bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Wild Ricochet'] },
      { bf: ['Mountain'], hand: ['Shock'] },
    ],
    script: [
      { cast: 'Shock', by: 1, targets: [['P0']] },
      // queued on the seat holding priority (P0): the first decision P0 is asked for is that first "You may ..."
      { answer: false },
      { cast: 'Wild Ricochet', by: 0, targets: [['Shock']] },
      { resolve: true },
    ],
    expect: [
      { log: 'copies Shock' },                             // no line at all before the fix: the copy was a silent no-op
      { life: [0, 18] },                                   // the ORIGINAL still hits P0: sentence one really was declined
      { life: [1, 18] },                                   // 20 would mean no copy was ever made
      { events: { type: 'damage', min: 2, max: 2 } },
      { unsimulated: 0 },
    ],
  },
  {
    name: "Wild Ricochet's first sentence, accepted, moves the original and copies it anyway", cr: '115.7b',
    ruling: 'The control for the scenario above: with the optional retarget taken, the original Shock is moved off its caster\'s opponent and the copy is made all the same, so both hit P1.',
    seats: [
      { bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Wild Ricochet'] },
      { bf: ['Mountain'], hand: ['Shock'] },
    ],
    script: [
      { cast: 'Shock', by: 1, targets: [['P0']] },
      { cast: 'Wild Ricochet', by: 0, targets: [['Shock']] },
      { resolve: true },
    ],
    expect: [
      { life: [0, 20] },                                   // 18 would mean the original was never moved
      { life: [1, 16] },                                   // both the original and the copy
      { log: 'chooses new targets for Shock' },
      { log: 'copies Shock' },
      { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ change-targets
  {
    name: "Swerve changes a Lightning Bolt's single target away from the creature it was aimed at", cr: '115.7',
    ruling: 'CR 115.7: the target is changed to another legal target; it may not stay where it was.',
    seats: [
      { bf: ['Island', 'Mountain', 'Grizzly Bears'], hand: ['Swerve'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [
      { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] },
      { cast: 'Swerve', by: 0, targets: [['Lightning Bolt']] },
      { resolve: true },
    ],
    expect: [
      { zone: ['Grizzly Bears', 'battlefield'] },          // the graveyard would mean the target never moved
      { life: [1, 17] },
      { log: 'chooses new targets for Lightning Bolt' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Redirect moves a spell aimed at its controller (the "you may choose new targets" form)', cr: '115.7b',
    ruling: 'Every target of the spell may be changed or kept; a target aimed at the chooser is the one worth moving.',
    seats: [
      { bf: ['Island', 'Island', 'Grizzly Bears'], hand: ['Redirect'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [
      { cast: 'Lightning Bolt', by: 1, targets: [['P0']] },
      { cast: 'Redirect', by: 0, targets: [['Lightning Bolt']] },
      { resolve: true },
    ],
    expect: [
      { life: [0, 20] },                                   // 17 would mean the bolt still hit its original target
      { life: [1, 17] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Untimely Malfunction changes the target of a spell or ability with a single target', cr: '115.7',
    ruling: 'The mode targets a stack object of either kind, and only one whose target count is exactly one.',
    seats: [
      { bf: ['Mountain', 'Mountain', 'Grizzly Bears'], hand: ['Untimely Malfunction'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [
      { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] },
      { cast: 'Untimely Malfunction', by: 0, modes: [1], targets: [['Lightning Bolt']] },
      { resolve: true },
    ],
    expect: [
      { zone: ['Grizzly Bears', 'battlefield'] },
      { life: [1, 17] },
      { unsimulated: 0 },
    ],
  },
  {
    name: "Deflecting Swat moves an Aura spell's enchant choice, which is a target too", cr: '115.7b',
    ruling: "CR 115.2b: an Aura spell targets the permanent its enchant ability names, and CR 115.7b lets a \"choose new targets\" effect change every target of the spell — including that one. The core keeps the enchant choice at index -1 of the item's target map, outside the effect requirements, so a retarget that only walked the effects left removal Auras (Pacifism, Song of the Dryads, Darksteel Mutation) untouched.",
    active: 1,
    seats: [
      { bf: ['Mountain', 'Mountain', 'Mountain', 'Grizzly Bears'], hand: ['Deflecting Swat'] },
      { bf: ['Plains', 'Plains', 'Hill Giant'], hand: ['Pacifism'] },
    ],
    script: [
      { cast: 'Pacifism', by: 1, targets: [['Grizzly Bears']] },
      { cast: 'Deflecting Swat', by: 0, targets: [['Pacifism']] },
      { resolve: true },
    ],
    expect: [
      { attachedTo: ['Pacifism', 'Hill Giant'] },          // 'Grizzly Bears' would mean the enchant target never moved
      { zone: ['Pacifism', 'battlefield'] },
      { log: 'chooses new targets for Pacifism' },
      { noLog: 'Pacifism keeps its targets' },
    ],
  },
  {
    name: 'Deflecting Swat retargets a spell through the spell-or-ability target kind', cr: '115.7b',
    ruling: 'The stack object it targets may be a spell or an ability; a bolt aimed at its controller is moved off.',
    seats: [
      { bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Deflecting Swat'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [
      { cast: 'Lightning Bolt', by: 1, targets: [['P0']] },
      { cast: 'Deflecting Swat', by: 0, targets: [['Lightning Bolt']] },
      { resolve: true },
    ],
    expect: [
      { life: [0, 20] },
      { life: [1, 17] },
      // Deflecting Swat's other printed line ("you may cast this spell without paying its mana cost") belongs to the
      // cost-alter family and is still unparsed, so exactly one clause is skipped
    ],
  },
  {
    // the free-spell cycle: a script declares the conditional altCost and COVERS the printed line with it (8c-1
    // CR-2), so the card is fully simulated; the cast is legal for nothing only while the commander is in play
    name: 'Deflecting Swat is cast without paying its mana cost while its controller controls their commander', cr: '118.9',
    ruling: 'CR 118.9: an alternative cost may be paid instead of the mana cost; this one is offered only while "you control a commander" holds.',
    format: 'commander',
    seats: [
      { bf: ['Forest', 'Forest'], hand: ['Deflecting Swat'], command: ['Grizzly Bears'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    scripts: {
      'Deflecting Swat': {
        mode: 'replace',
        altCosts: [{ id: 'pitch', label: 'without paying its mana cost', cost: {}, condition: { kind: 'controls-commander' }, from: 'hand' }],
        covers: [{ line: 'If you control a commander, you may cast ~ without paying its mana cost.', by: 'altCosts' }],
        abilities: [{
          kind: 'spell',
          effects: [{ op: 'may', effects: [{ op: 'change-targets', target: { kind: 'spell-or-ability' }, how: 'choose-new' }] }],
          text: 'You may choose new targets for target spell or ability.',
        }],
      },
    },
    script: [
      { cast: 'Grizzly Bears', by: 0 },
      { resolve: true },
      { cast: 'Lightning Bolt', by: 1, targets: [['P0']] },
      // both Forests are tapped for the commander: the only cast left is the free one
      { cast: 'Deflecting Swat', by: 0, alt: 'pitch', targets: [['Lightning Bolt']] },
      { resolve: true },
    ],
    expect: [
      { zone: ['Grizzly Bears', 'battlefield'] },
      { life: [0, 40] },
      { life: [1, 37] },
      { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ become-copy
  {
    name: 'a permanent that becomes a copy of another creature has that creature\'s power and toughness', cr: '706.2',
    ruling: 'CR 613.2: the copy is applied in layer 1, so the copied printed P/T is what every later layer builds on.',
    seats: [
      { bf: ['Forest', 'Grizzly Bears'] },
      { bf: ['Mountain', 'Hill Giant'] },
    ],
    scripts: bears([{ op: 'become-copy', target: creature, duration: 'eot' }], 'becomes a copy'),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [
      { pt: ['Grizzly Bears', 3, 3] },                     // 2/2 would mean the copy never applied
      { log: 'becomes a copy of Hill Giant' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a copy that lasts until end of turn is gone the next turn', cr: '514.2',
    ruling: 'CR 514.2: until-end-of-turn effects end during the cleanup step, so the permanent is itself again.',
    seats: [
      { bf: ['Forest', 'Grizzly Bears'] },
      { bf: ['Mountain', 'Hill Giant'] },
    ],
    scripts: bears([{ op: 'become-copy', target: creature, duration: 'eot' }], 'becomes a copy'),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }, { turns: 1 }],
    expect: [
      { pt: ['Grizzly Bears', 2, 2] },                     // 3/3 would mean the eot copy never ended
      { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ enter-as-copy
  {
    name: 'Clone enters the battlefield as a copy of a creature already on it', cr: '706.9',
    ruling: 'A copy replacement effect is applied as the permanent enters, so it is never on the battlefield as a 0/0.',
    seats: [
      { bf: ['Island', 'Island', 'Island', 'Island'], hand: ['Clone'] },
      { bf: ['Mountain', 'Hill Giant'] },
    ],
    script: [{ cast: 'Clone' }, { resolve: true }],
    expect: [
      { pt: ['Clone', 3, 3] },                             // Clone's printed 0/0 would die to the SBA instead
      { zone: ['Clone', 'battlefield'] },
      { log: 'enters the battlefield as a copy of Hill Giant' },
      { unsimulated: 0 },
    ],
  },

  // ------------------------------------------------------------------ the "except ..." fields and the op's flags
  {
    name: "a copy exception sets the token's power, toughness and keywords; count and tapped shape how many arrive and how", cr: '707.9a',
    ruling: 'CR 707.9a: everything the effect states overrides the copiable values; everything else is copied.',
    seats: [
      { bf: ['Grizzly Bears'] },
      { bf: ['Mountain', 'Hill Giant'] },
    ],
    scripts: bears([{ op: 'copy-permanent', target: creature, count: 2, tapped: true, except: { power: 1, toughness: 1, keywords: ['flying'] } }], 'two tapped 1/1 flying copies'),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [
      { zoneCount: [0, 'battlefield', 3] },                // Grizzly Bears + two tokens; 2 would mean `count` was ignored
      { pt: ['Hill Giant', 1, 1] },                        // seat 0's token is found first; 3/3 would mean the exception did nothing
      { keywords: ['Hill Giant', ['flying']] },
      { tapped: ['Hill Giant', true] },
      { unsimulated: 0 },
    ],
  },
  {
    name: "\"except it isn't legendary\" keeps the token alive next to the legend it copied", cr: '704.5j',
    ruling: 'CR 205.4: without the exception the token is legendary too and the legend rule (704.5j) puts one of them into the graveyard.',
    seats: [
      { bf: ['Grizzly Bears', 'Isamaru, Hound of Konda'] },
      { bf: ['Mountain'] },
    ],
    scripts: bears([{ op: 'copy-permanent', target: { kind: 'creature', controller: 'you' }, except: { notLegendary: true } }], 'nonlegendary copy'),
    script: [{ activate: 'Grizzly Bears', targets: [['Isamaru, Hound of Konda']] }, { resolve: true }, { sba: true }],
    expect: [
      { zoneCount: [0, 'battlefield', 3] },                // Bears + the legend + the token; 2 would mean the legend rule ate one
      { graveyardCount: [0, 0] },
      { unsimulated: 0 },
    ],
  },
  {
    name: "copy-stack's own \"you may choose new targets\" moves the copy off its controller's creature", cr: '707.10c',
    ruling: "The copy's controller chooses; the original spell keeps the targets its controller chose.",
    seats: [
      { bf: ['Mountain', 'Hill Giant'], hand: ['Lightning Bolt'] },
      { bf: ['Mountain'], hand: ['Shock'] },
    ],
    scripts: { 'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects: [{ op: 'copy-stack', target: { kind: 'spell', filter: { types: ['Instant', 'Sorcery'] } }, newTargets: 'may' }], text: 'copy with new targets' }] } },
    script: [
      { cast: 'Shock', by: 1, targets: [['Hill Giant']] },
      { cast: 'Lightning Bolt', by: 0, targets: [['Shock']] },
      { resolve: true },
    ],
    expect: [
      { life: [1, 18] },                                   // 20 would mean the copy still pointed at Hill Giant
      { zone: ['Hill Giant', 'battlefield'] },             // 2 damage from the original is not lethal to a 3/3
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a Clone that entered as a copy of a legend you control is caught by the legend rule', cr: '704.5j',
    ruling: "CR 704.5j names \"legendary permanents with the same name\", and CR 707.2 says a copy has the copied permanent's name and supertypes — so the Clone IS a second Isamaru and one of them is put into its owner's graveyard. `checkSBA`'s own legend pass reads the PRINTED def, which for a permanent that entered as a copy still says \"Clone\"; this family's SBA hook asks the same question of the def the copy effect gave it.",
    seats: [
      { bf: ['Island', 'Island', 'Island', 'Island', 'Isamaru, Hound of Konda'], hand: ['Clone'] },
      { bf: ['Mountain'] },
    ],
    script: [{ cast: 'Clone' }, { resolve: true }, { sba: true }],
    expect: [
      // four Islands + exactly one hound; 6 would mean the two copies coexisted
      { zoneCount: [0, 'battlefield', 5] },
      { graveyardCount: [0, 1] },
      { zone: ['Clone', 'battlefield'] },                  // the newest of the pair is the one kept
      { zone: ['Isamaru, Hound of Konda', 'graveyard'] },
      { log: 'enters the battlefield as a copy of Isamaru, Hound of Konda' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'a copy made by the core copy-spell op is still what "you may choose new targets for the copy" moves', cr: '707.10c',
    ruling: "CR 707.10c: the copy's controller may choose new targets for it. The copy sentence and the retarget sentence are two printed sentences, and on most cards (Fork, Geistblast, Sea Gate Stormcaller, Fury Storm) the copy is made by the core `copy-spell` op — which leaves no record of what it made. Without the fallback the second sentence asked the player and then did nothing.",
    seats: [
      { bf: ['Mountain', 'Hill Giant'], hand: ['Lightning Bolt'] },
      { bf: ['Mountain'], hand: ['Shock'] },
    ],
    // the core op, deliberately: this scenario is about the sentence NEXT to a copy this family did not make
    scripts: { 'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects: [
      { op: 'copy-spell', target: { kind: 'spell', filter: { types: ['Instant', 'Sorcery'] } } },
      { op: 'may', effects: [{ op: 'change-targets', target: 'the-copies', how: 'choose-new' }] },
    ], text: 'core copy, then new targets' }] } },
    script: [
      { cast: 'Shock', by: 1, targets: [['Hill Giant']] },
      { cast: 'Lightning Bolt', by: 0, targets: [['Shock']] },
      { resolve: true },
    ],
    expect: [
      { life: [1, 18] },                                   // 20 would mean the copy still pointed at Hill Giant
      { zone: ['Hill Giant', 'battlefield'] },             // 2 damage from the original is not lethal to a 3/3
      { log: 'chooses new targets for Shock' },
      { unsimulated: 0 },
    ],
  },
];
