// Phase 9.1px — the core parser changes the 9.1p parser-rule families declared (data/scripts/batches/
// parse-wave-1-core.json), one scenario per item a board can show, every one on a PRINTED card played as printed.
// Every expectation FAILS on the tree before its change: the item number in each name is the entry of the item list,
// the `ruling` says what the old tree did. The items a board cannot show (an antecedent inside a paragraph, a
// declined scoped block, a marker offered to the registry, a renderer string, a bind that bound nothing) are pinned in
// test/parser-core-9-1px.test.ts instead.
import type { Scenario } from './dsl.js';

const MOUNTAINS = (n: number): string[] => Array.from({ length: n }, () => 'Mountain');

export const core91px: Scenario[] = [
  // ------------------------------------------------------------------ item 2: "the number of cards in that player's hand"
  {
    name: "9.1px item 2: Sudden Impact deals damage equal to the TARGET player's hand, not the caster's", cr: '608.2h',
    ruling: 'The amount is read as the spell resolves, from the hand of the player it names. The `count: cards-in-hand` marker read the caster\'s hand (one card left after casting), so the target took 1 instead of 4.',
    seats: [{ bf: MOUNTAINS(4), hand: ['Sudden Impact', 'Grizzly Bears'] }, { hand: ['Forest', 'Forest', 'Forest', 'Island'] }],
    script: [{ cast: 'Sudden Impact', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 16] }, { life: [0, 20] }, { zone: ['Sudden Impact', 'graveyard'] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ items 5 / 15: "You may pay {2}{R}. When you do, …"
  {
    name: '9.1px item 15: Sparktongue Dragon asks for {2}{R} and only then puts the reflexive "When you do" damage on the stack', cr: '603.12',
    ruling: 'The payment is an action of the resolving trigger; the damage is a reflexive triggered ability that exists only if the payment was made. The old tree left "you may pay {2}{R}." unknown and the standalone `reflexive` after it fired off the unsimulated clause — 3 damage for free.',
    seats: [{ bf: MOUNTAINS(8), hand: ['Sparktongue Dragon'] }, { bf: ['Hill Giant'] }],
    // cast → the Dragon enters and its trigger goes on the stack → the queued `true` answers "pay {2}{R}?" as the
    // trigger resolves → the reflexive goes on the stack → it resolves and deals 3 damage to the target the controller chose
    script: [{ cast: 'Sparktongue Dragon' }, { resolve: true }, { answer: true }, { resolve: true }, { resolve: true }],
    expect: [{ log: /pays \{2\}\{R\} for Sparktongue Dragon/ }, { log: /deals 3 damage/ }, { events: { type: 'damage', min: 1 } }, { unsimulated: 0 }, { stack: 0 }],
  },

  // ------------------------------------------------------------------ item 7: the retention clause folded into its sentence
  {
    name: "9.1px item 7: Restless Reef animates into a 4/4 deathtouch Shark that is still a land", cr: '205.1b',
    ruling: '"It\'s still a land" says the type-changing effect ADDS the creature type: the Reef is a 4/4 Shark creature with deathtouch and keeps its land type. The old tree could not join the two sentences, declined the animation and did nothing.',
    seats: [{ bf: ['Restless Reef', 'Island', 'Island', 'Swamp', 'Swamp'] }, {}],
    script: [{ activate: 'Restless Reef', ability: 1 }, { resolve: true }],
    expect: [{ pt: ['Restless Reef', 4, 4] }, { keywords: ['Restless Reef', ['deathtouch']] }, { zone: ['Restless Reef', 'battlefield'] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 8: a trigger body's leading pronoun is the triggering object
  {
    name: '9.1px item 8: Primal Forcemage pumps the creature that entered, not itself', cr: '603.2',
    ruling: '"Whenever another creature you control enters, that creature gets +3/+3" is about the creature that entered. The old tree read the pronoun as the source and made Primal Forcemage a 5/5 while Grizzly Bears stayed 2/2.',
    seats: [{ bf: ['Primal Forcemage', 'Forest', 'Forest'], hand: ['Grizzly Bears'] }, {}],
    script: [{ cast: 'Grizzly Bears' }, { resolve: true }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 5, 5] }, { pt: ['Primal Forcemage', 2, 2] }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ item 9: a "land creature token" is a land
  {
    name: '9.1px item 9: an Awaken the Woods Dryad is a land, so it triggers landfall', cr: '305.6',
    ruling: 'A "Forest Dryad land creature token" has the card type Land; a land entering under your control is a landfall event. The old tree gave the token a bogus "Land" SUBTYPE and no land type, so Rampaging Baloths saw nothing enter.',
    seats: [{ bf: ['Rampaging Baloths', 'Forest', 'Forest', 'Forest'], hand: ['Awaken the Woods'] }, {}],
    script: [{ cast: 'Awaken the Woods', x: 1 }, { resolve: true }, { resolve: true }],
    expect: [{ zoneCount: [0, 'battlefield', 6] }, { log: /Beast/ }, { unsimulated: 0 }],
  },

  // ------------------------------------------------------------------ items 11 / 13: "Whenever you attack" is once per combat
  {
    name: '9.1px item 11: Razorkin Hordecaller makes ONE Gremlin when two creatures attack', cr: '508.1',
    ruling: 'Attackers are declared by a single turn-based action, so "Whenever you attack" triggers once per combat. The old tree read it as the per-attacker `attacks` event and made one Gremlin per attacking creature.',
    seats: [{ bf: ['Razorkin Hordecaller', 'Grizzly Bears'] }, {}],
    script: [{ attack: ['Razorkin Hordecaller', 'Grizzly Bears'] }],
    expect: [{ zoneCount: [0, 'battlefield', 3] }, { events: { type: 'create-token', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
];
