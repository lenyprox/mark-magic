// combat-restr (Phase 9.1): combat restrictions and requirements, one scenario per op and per parameter.
//
// Written from the printed cards and the Comprehensive Rules: CR 506.4 (who may attack), 509.1a-d (the declare
// blockers step and how requirements and restrictions are weighed) and 510.1a (combat damage assignment).
//
// Two DSL idioms carry most of the weight here:
//   * `refused` really OFFERS the block and fails the scenario if the engine takes it, so a restriction is tested,
//     not merely left untested by nobody blocking;
//   * a requirement is tested by declaring NO block at all and asserting the engine added one — the defending player
//     never wants to chump-block, so a scenario whose op did nothing shows up as damage on the player's life total.
import { type Scenario } from './dsl.js';

export const combatRestr: Scenario[] = [
  // ---------------------------------------------------------------- requirements (CR 509.1c)
  {
    name: 'Gaea\'s Protector must be blocked if able, so the untapped creature is forced to block it', cr: '509.1c',
    ruling: 'A blocking requirement must be obeyed: the defending player must declare a block that satisfies it.',
    seats: [{ bf: ['Gaea\'s Protector'] }, { bf: ['Grizzly Bears'] }],
    script: [{ attack: ['Gaea\'s Protector'] }],
    expect: [
      { life: [1, 20] },                                          // nothing got through: the block really happened
      { log: 'Grizzly Bears blocks Gaea\'s Protector \\(must be blocked\\)' },
      { zone: ['Grizzly Bears', 'graveyard'] },                   // 4 power against 2 toughness
      { zone: ['Gaea\'s Protector', 'graveyard'] },               // 2 power against 2 toughness
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Every creature able to block Elvish Bard does so', cr: '509.1c',
    ruling: 'A requirement that names every able creature forces all of them into the block, not just one.',
    seats: [{ bf: ['Elvish Bard'] }, { bf: ['Grizzly Bears', 'Walking Corpse'] }],
    script: [{ attack: ['Elvish Bard'] }],
    expect: [
      { life: [1, 20] },
      { log: 'Grizzly Bears blocks Elvish Bard \\(must block\\)' },
      { log: 'Walking Corpse blocks Elvish Bard \\(must block\\)' },
      { zone: ['Elvish Bard', 'graveyard'] },                     // 2 + 2 damage against toughness 4
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Lure makes every creature able to block the enchanted creature do so', cr: '509.1c',
    ruling: 'The requirement is on the enchanted creature, wherever the Aura came from.',
    seats: [
      { bf: ['Forest', 'Forest', 'Forest', 'Hill Giant'], hand: ['Lure'] },
      { bf: ['Grizzly Bears', 'Wall of Wood'] },
    ],
    script: [{ cast: 'Lure', targets: [['Hill Giant']] }, { resolve: true }, { attack: ['Hill Giant'] }],
    expect: [
      { attachedTo: ['Lure', 'Hill Giant'] },
      { life: [1, 20] },
      { log: 'Grizzly Bears blocks Hill Giant \\(must block\\)' },
      { log: 'Wall of Wood blocks Hill Giant \\(must block\\)' },
      { zone: ['Grizzly Bears', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Alluring Scent drags a creature off the attacker it declared a block on', cr: '509.1c',
    ruling: 'CR 509.1c: the declaration must satisfy the maximum possible number of requirements, so a creature that could block the lured attacker may not block a different one instead.',
    seats: [
      { bf: ['Forest', 'Forest', 'Forest', 'Hill Giant', 'Bog Rats'], hand: ['Alluring Scent'] },
      { bf: ['Grizzly Bears'] },
    ],
    // the block on Bog Rats is legal in isolation and is still refused: blocking Hill Giant is a requirement
    script: [
      { cast: 'Alluring Scent', targets: [['Hill Giant']] }, { resolve: true },
      { attack: ['Hill Giant', 'Bog Rats'], refused: [['Grizzly Bears', 'Bog Rats']] },
    ],
    expect: [
      { life: [1, 19] },                                          // only Bog Rats got through
      { log: 'Grizzly Bears blocks Hill Giant \\(must block\\)' },
      { zone: ['Grizzly Bears', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Culling Mark makes the target creature block if it is able', cr: '509.1c',
    ruling: 'The requirement is on the blocker: it must block something it can block.',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Hill Giant'], hand: ['Culling Mark'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Culling Mark', targets: [['Grizzly Bears']] }, { resolve: true }, { attack: ['Hill Giant'] }],
    expect: [
      { life: [1, 20] },
      { log: 'Grizzly Bears blocks Hill Giant \\(blocks if able\\)' },
      { zone: ['Grizzly Bears', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- restrictions (CR 509.1b)
  {
    name: 'Phyrexian Colossus can\'t be blocked except by three or more creatures — two are not enough', cr: '509.1b',
    ruling: 'A restriction on how many creatures must block is judged over the whole declaration, so a two-creature block is illegal and neither block happens.',
    seats: [{ bf: ['Phyrexian Colossus'] }, { bf: ['Grizzly Bears', 'Hill Giant'] }],
    script: [{ attack: ['Phyrexian Colossus'], refused: [['Grizzly Bears', 'Phyrexian Colossus'], ['Hill Giant', 'Phyrexian Colossus']] }],
    expect: [
      { life: [1, 12] },                                          // all 8 power reached the player
      { log: 'can\'t block Phyrexian Colossus except with 3 or more creatures' },
      { zone: ['Grizzly Bears', 'battlefield'] },                 // no combat damage was dealt to them
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Three creatures may block Phyrexian Colossus', cr: '509.1b',
    ruling: 'The positive control for the restriction above: at three blockers the declaration is legal.',
    seats: [{ bf: ['Phyrexian Colossus'] }, { bf: ['Grizzly Bears', 'Hill Giant', 'Wall of Wood'] }],
    script: [{ attack: ['Phyrexian Colossus'], blocks: [['Grizzly Bears', 'Phyrexian Colossus'], ['Hill Giant', 'Phyrexian Colossus'], ['Wall of Wood', 'Phyrexian Colossus']] }],
    expect: [
      { life: [1, 20] },
      { zone: ['Grizzly Bears', 'graveyard'] },
      { zone: ['Hill Giant', 'graveyard'] },
      { zone: ['Wall of Wood', 'graveyard'] },
      { zone: ['Phyrexian Colossus', 'battlefield'] },            // 2 + 3 + 0 damage against toughness 8
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Dread Warlock can\'t be blocked except by black creatures', cr: '509.1b',
    ruling: 'The restriction names the blockers that are allowed; every other creature simply cannot be declared.',
    seats: [{ bf: ['Dread Warlock'] }, { bf: ['Grizzly Bears', 'Walking Corpse'] }],
    script: [{ attack: ['Dread Warlock'], blocks: [['Walking Corpse', 'Dread Warlock']], refused: [['Grizzly Bears', 'Dread Warlock']] }],
    expect: [
      { life: [1, 20] },
      { zone: ['Dread Warlock', 'graveyard'] },                   // 2/2 traded with the black 2/2
      { zone: ['Walking Corpse', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'A creature with power less than Skarrgan Pit-Skulk\'s power can\'t block it', cr: '509.1b',
    ruling: 'The comparison is made as blockers are declared, against the attacker\'s power at that time.',
    seats: [{ bf: ['Skarrgan Pit-Skulk'] }, { bf: ['Wall of Wood', 'Grizzly Bears'] }],
    script: [{ attack: ['Skarrgan Pit-Skulk'], blocks: [['Grizzly Bears', 'Skarrgan Pit-Skulk']], refused: [['Wall of Wood', 'Skarrgan Pit-Skulk']] }],
    expect: [
      { life: [1, 20] },
      { zone: ['Skarrgan Pit-Skulk', 'graveyard'] },              // the 2/2 that could block killed it
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Bog Rats can\'t be blocked by Walls', cr: '509.1b',
    ruling: 'The complementary form of the restriction: the named creatures are the ones that may NOT block.',
    seats: [{ bf: ['Bog Rats'] }, { bf: ['Wall of Wood', 'Grizzly Bears'] }],
    script: [{ attack: ['Bog Rats'], blocks: [['Grizzly Bears', 'Bog Rats']], refused: [['Wall of Wood', 'Bog Rats']] }],
    expect: [
      { life: [1, 20] },
      { zone: ['Bog Rats', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Ironclaw Orcs can\'t block a creature with power 2 or greater', cr: '509.1b',
    ruling: 'This restriction is carried by the blocker and read against the attacker it is being declared against.',
    // The refused pair is the Orcs\' ONLY declaration: a blocker that is already blocking something else would be
    // turned down by the one-block-per-creature rule (CR 509.1b) and the scenario would pass for the wrong reason.
    seats: [{ bf: ['Hill Giant', 'Bog Rats'] }, { bf: ['Ironclaw Orcs', 'Grizzly Bears'] }],
    script: [{ attack: ['Hill Giant', 'Bog Rats'], blocks: [['Grizzly Bears', 'Bog Rats']], refused: [['Ironclaw Orcs', 'Hill Giant']] }],
    expect: [
      { life: [1, 17] },                                          // Hill Giant was unblockable by the Orcs
      { zone: ['Bog Rats', 'graveyard'] },
      { zone: ['Ironclaw Orcs', 'battlefield'] },                 // it blocked nothing at all
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Ironclaw Orcs may block a creature with power 1', cr: '509.1b',
    ruling: 'The positive control: only attackers inside the named set are forbidden.',
    seats: [{ bf: ['Bog Rats'] }, { bf: ['Ironclaw Orcs'] }],
    script: [{ attack: ['Bog Rats'], blocks: [['Ironclaw Orcs', 'Bog Rats']] }],
    expect: [{ life: [1, 20] }, { zone: ['Bog Rats', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: 'A creature enchanted with Air Bladder can block only creatures with flying', cr: '509.1b',
    ruling: 'An "only" restriction forbids every attacker outside the named set, whoever controls the Aura.',
    seats: [{ bf: ['Island', 'Hill Giant'], hand: ['Air Bladder'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Air Bladder', targets: [['Grizzly Bears']] }, { resolve: true }, { attack: ['Hill Giant'], refused: [['Grizzly Bears', 'Hill Giant']] }],
    expect: [
      { attachedTo: ['Air Bladder', 'Grizzly Bears'] },
      { keywords: ['Grizzly Bears', ['flying']] },
      { life: [1, 17] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Spitfire Handler can\'t block a creature with power greater than its own', cr: '509.1b',
    ruling: 'The comparison is between the attacker\'s power and the blocker\'s own power, both read as blockers are declared.',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Spitfire Handler'] }],
    script: [{ attack: ['Grizzly Bears'], refused: [['Spitfire Handler', 'Grizzly Bears']] }],
    expect: [
      { life: [1, 18] },                                          // the 2/2 was unblockable by the 1/1
      { zone: ['Spitfire Handler', 'battlefield'] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Spitfire Handler may block a creature with the same power', cr: '509.1b',
    ruling: 'The positive control: only strictly greater power is forbidden.',
    seats: [{ bf: ['Bog Rats'] }, { bf: ['Spitfire Handler'] }],
    script: [{ attack: ['Bog Rats'], blocks: [['Spitfire Handler', 'Bog Rats']] }],
    expect: [{ life: [1, 20] }, { zone: ['Bog Rats', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: 'A "Bears can\'t block Giants" static reaches every creature the filter names', cr: '509.1b',
    ruling: 'The scoped form of the restriction (Cowards can\'t block Warriors): both sides are filters, and the permanent that carries the ability is not itself involved.',
    // Boldwyr Intimidator prints this shape, but the Cowards it makes come from an ability the parser has not
    // learned yet, so the static is scripted onto a card with the right creature types instead.
    // The static sits on a land the attacking player controls, which is the point: neither side of the restriction is
    // the permanent that carries the ability.
    scripts: { Mountain: { abilities: [{ kind: 'static', effect: { kind: 'cant-block-creatures', scope: 'filter', filter: { subtypes: ['Bear'] }, side: 'all', what: { subtypes: ['Giant'] } }, text: 'Bears can\'t block Giants.' }] } },
    seats: [{ bf: ['Mountain', 'Hill Giant', 'Bog Rats'] }, { bf: ['Grizzly Bears', 'Walking Corpse'] }],
    script: [{ attack: ['Hill Giant', 'Bog Rats'], blocks: [['Walking Corpse', 'Bog Rats']], refused: [['Grizzly Bears', 'Hill Giant']] }],
    expect: [
      { life: [1, 17] },                                          // the Giant could not be blocked by the Bear
      { zone: ['Bog Rats', 'graveyard'] },                         // the 2/2 that could block killed it
      { zone: ['Grizzly Bears', 'battlefield'] },                  // the Bear blocked nothing at all
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- "alone" restrictions (CR 506.4 / 509.1b)
  {
    name: 'Craven Hulk can\'t block alone', cr: '509.1b',
    ruling: 'The restriction is on the whole declaration: with no other creature blocking, the block is illegal.',
    seats: [{ bf: ['Hill Giant'] }, { bf: ['Craven Hulk'] }],
    script: [{ attack: ['Hill Giant'], refused: [['Craven Hulk', 'Hill Giant']] }],
    expect: [
      { life: [1, 17] },
      { log: 'Craven Hulk can\'t block alone' },
      { zone: ['Hill Giant', 'battlefield'] },                    // it was never in combat with the 4/4
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Craven Hulk may block when another creature blocks too', cr: '509.1b',
    ruling: 'The positive control: the restriction is only about being the only blocker.',
    seats: [{ bf: ['Hill Giant', 'Bog Rats'] }, { bf: ['Craven Hulk', 'Grizzly Bears'] }],
    script: [{ attack: ['Hill Giant', 'Bog Rats'], blocks: [['Craven Hulk', 'Hill Giant'], ['Grizzly Bears', 'Bog Rats']] }],
    expect: [
      { life: [1, 20] },
      { zone: ['Hill Giant', 'graveyard'] },                      // the 4/4 killed it
      { noLog: 'Craven Hulk can\'t block alone' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Mogg Flunkies can\'t attack alone, so it never attacks with nothing beside it', cr: '506.4',
    ruling: 'With no other creature that could attack, the restriction can never be satisfied and the creature cannot be declared as an attacker at all.',
    // Mogg Flunkies is also given "attacks each combat if able", so a creature that CAN attack always does — the
    // scenario then measures the restriction rather than the default agent's taste for attacking.
    scripts: { 'Mogg Flunkies': { abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: [], mustAttack: true }, text: '~ attacks each combat if able.' }] } },
    seats: [{ bf: ['Mogg Flunkies'] }, {}],
    script: [{ passUntil: 'end' }],
    expect: [
      { life: [1, 20] },
      { events: { type: 'attack', max: 0 } },
      { tapped: ['Mogg Flunkies', false] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Mogg Flunkies attacks when another creature attacks with it', cr: '506.4',
    ruling: 'The positive control for the restriction above.',
    scripts: {
      'Mogg Flunkies': { abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: [], mustAttack: true }, text: '~ attacks each combat if able.' }] },
      'Hill Giant': { abilities: [{ kind: 'static', effect: { kind: 'self-keywords', keywords: [], mustAttack: true }, text: '~ attacks each combat if able.' }] },
    },
    seats: [{ bf: ['Mogg Flunkies', 'Hill Giant'] }, {}],
    script: [{ passUntil: 'end' }],
    expect: [
      { life: [1, 14] },                                          // 3 + 3 power got through
      { events: { type: 'attack', min: 1 } },
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- damage (CR 510.1a)
  {
    name: 'Thorn Elemental assigns its combat damage as though it weren\'t blocked', cr: '510.1a',
    ruling: 'The attacker is still blocked — the blocker takes no damage and deals its own — but every point the attacker assigns goes to the defending player.',
    seats: [{ bf: ['Thorn Elemental'] }, { bf: ['Grizzly Bears'] }],
    script: [{ attack: ['Thorn Elemental'], blocks: [['Grizzly Bears', 'Thorn Elemental']] }],
    expect: [
      { life: [1, 13] },                                          // all 7 power reached the player
      { zone: ['Grizzly Bears', 'battlefield'] },                 // the blocker took nothing
      { log: 'assigns its combat damage as though it weren\'t blocked' },
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- one-shot restrictions (until end of turn)
  {
    name: 'Falter stops creatures without flying from blocking this turn', cr: '509.1b',
    ruling: 'The effect names no creatures as it resolves: a creature is checked against the filter when blockers are declared.',
    seats: [{ bf: ['Mountain', 'Mountain', 'Hill Giant'], hand: ['Falter'] }, { bf: ['Grizzly Bears', 'Wind Drake'] }],
    script: [{ cast: 'Falter' }, { resolve: true }, { attack: ['Hill Giant'], blocks: [['Wind Drake', 'Hill Giant']], refused: [['Grizzly Bears', 'Hill Giant']] }],
    expect: [
      { life: [1, 20] },
      { zone: ['Wind Drake', 'graveyard'] },                      // the flier could still block, and died to 3 power
      { log: 'can\'t block this turn' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Cosmotronic Wave stops only the opponent\'s creatures from blocking', cr: '509.1b',
    ruling: 'The ban is scoped to the caster\'s opponents.',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Hill Giant'], hand: ['Cosmotronic Wave'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Cosmotronic Wave' }, { resolve: true }, { attack: ['Hill Giant'], refused: [['Grizzly Bears', 'Hill Giant']] }],
    expect: [
      { life: [1, 17] },
      { log: 'can\'t block this turn' },
      { zone: ['Grizzly Bears', 'battlefield'] },
    ],
  },
  {
    name: 'A "creatures you control can\'t block" effect leaves the opponent\'s blockers alone', cr: '509.1b',
    ruling: 'The `you` scope of the ban is read from the player who put it there, not from the defending player.',
    // No printed card in the pool bans only the caster's own blockers, so the shape is scripted onto an instant.
    scripts: { Shock: { mode: 'replace', abilities: [{ kind: 'spell', effects: [{ op: 'restrict-blocking', whose: 'you', filter: { types: ['Creature'] }, duration: 'eot' }], text: 'Creatures you control can\'t block this turn.' }] } },
    active: 1,
    seats: [{ bf: ['Mountain', 'Grizzly Bears'], hand: ['Shock'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Shock', by: 0 }, { resolve: true }, { attack: ['Hill Giant'], refused: [['Grizzly Bears', 'Hill Giant']] }],
    expect: [
      { life: [0, 17] },
      { log: 'can\'t block this turn' },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'Spin Engine stops one creature from blocking Spin Engine only', cr: '509.1b',
    ruling: 'The restriction names one attacker: the creature may still block anything else.',
    seats: [{ bf: ['Mountain', 'Spin Engine'] }, { bf: ['Grizzly Bears'] }],
    script: [
      { activate: 'Spin Engine', targets: [['Grizzly Bears']] }, { resolve: true },
      { attack: ['Spin Engine'], refused: [['Grizzly Bears', 'Spin Engine']] },
    ],
    expect: [
      { life: [1, 17] },                                          // Spin Engine's 3 power got through
      { log: 'Grizzly Bears can\'t block Spin Engine this turn' },
      { zone: ['Grizzly Bears', 'battlefield'] },
      { unsimulated: 0 },
    ],
  },
  {
    name: 'A creature Spin Engine named may still block a different attacker', cr: '509.1b',
    ruling: 'The positive control: the restriction is about one attacker, not about blocking at all.',
    seats: [{ bf: ['Mountain', 'Spin Engine', 'Hill Giant'] }, { bf: ['Grizzly Bears'] }],
    script: [
      { activate: 'Spin Engine', targets: [['Grizzly Bears']] }, { resolve: true },
      { attack: ['Spin Engine', 'Hill Giant'], blocks: [['Grizzly Bears', 'Hill Giant']] },
    ],
    expect: [
      { life: [1, 17] },                                          // only Spin Engine got through
      { zone: ['Grizzly Bears', 'graveyard'] },                   // it blocked the Hill Giant and died
      { unsimulated: 0 },
    ],
  },

  // ---------------------------------------------------------------- an additional combat phase (CR 505.1 / 506.1)
  {
    name: 'Seize the Day gives an additional combat phase, and the untapped creature attacks in it', cr: '506.1',
    ruling: 'The extra combat phase comes after the postcombat main phase, and is followed by another main phase.',
    // Juggernaut attacks each combat if able, so both combats are really declared rather than left to taste.
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Juggernaut'], hand: ['Seize the Day'] }, {}],
    script: [
      { passUntil: 'main2' },
      { cast: 'Seize the Day', targets: [['Juggernaut']] }, { resolve: true },
      { passUntil: 'end' },
    ],
    expect: [
      { life: [1, 10] },                                          // 5 power, twice
      { events: { type: 'attack', min: 2, max: 2 } },
      { log: 'additional combat phase' },
      { unsimulated: 0 },
    ],
  },
];
