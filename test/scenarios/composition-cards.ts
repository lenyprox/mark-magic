// Composition core, parser side (Phase 9.0b): owner-deck cards that the composition rule family
// (src/cards/rules/composition.ts) makes fully parsed, each with a behavioural scenario written from the printed
// text and the rules. Nothing here is scripted except the props marked `prop` — the card under test is parsed from
// its oracle text, so a scenario fails when the parse is wrong, not only when the engine is.
import type { Scenario, ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: Discard your hand." — a deterministic discard outlet for a trigger under test. */
const discardOutlet: Record<string, ScenarioScript> = { 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'discard', amount: 'hand', who: 'you' }], text: 'prop' }] } };

export const compositionCards: Scenario[] = [
  {
    // "Sacrifice a creature: Target player mills cards equal to the sacrificed creature's power."
    name: 'Altar of Dementia mills the targeted player for the sacrificed creature\'s power (last known information)', cr: '608.2h',
    seats: [{ bf: ['Altar of Dementia', 'Hill Giant'] }, {}],
    script: [{ activate: 'Altar of Dementia', targets: [['P1']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { libraryCount: [1, 17] }, { graveyardCount: [1, 3] }, { libraryCount: [0, 20] }, { unsimulated: 0 }],
  },
  {
    // "{5}, {T}: Add five mana in any combination of colors."
    name: 'Cascading Cataracts turns five generic mana into five coloured mana', cr: '605.1a',
    seats: [{ bf: ['Cascading Cataracts', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, {}],
    script: [{ answer: 'G' }, { activate: 'Cascading Cataracts', ability: 1 }],
    expect: [{ tapped: ['Cascading Cataracts', true] }, { tapped: ['Mountain', true] }, { mana: [0, 'GGGGG'] }, { events: { type: 'mana', min: 1 } }, { unsimulated: 0 }],
  },
  {
    // "Whenever you discard a card, you may exile that card from your graveyard. If you do, you may play that card this turn."
    name: 'Containment Construct exiles the discarded card and lets it be cast from exile this turn', cr: '603.2',
    seats: [{ bf: ['Containment Construct', 'Grizzly Bears', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Hill Giant'] }, {}],
    scripts: discardOutlet,
    script: [{ answer: true }, { answer: true }, { activate: 'Grizzly Bears' }, { resolve: true }, { cast: 'Hill Giant' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { handCount: [0, 0] }, { graveyardCount: [0, 0] }, { unsimulated: 0 }],
  },
  {
    name: 'Containment Construct: declining the exile leaves the discarded card in the graveyard', cr: '603.2',
    seats: [{ bf: ['Containment Construct', 'Grizzly Bears', 'Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Hill Giant'] }, {}],
    scripts: discardOutlet,
    script: [{ answer: false }, { activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zoneCount: [0, 'exile', 0] }],
  },
  {
    // "{2}{B}: Return this card from your graveyard to the battlefield. Activate only as a sorcery and only if you have one or fewer cards in hand."
    name: 'Dread Wanderer returns itself from the graveyard to the battlefield, and enters tapped as printed', cr: '602.2',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp'], graveyard: ['Dread Wanderer'] }, {}],
    script: [{ activate: 'Dread Wanderer' }, { resolve: true }],
    expect: [{ zone: ['Dread Wanderer', 'battlefield'] }, { control: ['Dread Wanderer', 0] }, { tapped: ['Dread Wanderer', true] }, { unsimulated: 0 }],
  },
  {
    // "{2}, {T}, Sacrifice this land: Destroy target nonbasic land an opponent controls. Each player searches their library for a basic land card, puts it onto the battlefield, then shuffles."
    name: 'Field of Ruin destroys the nonbasic land and every player fetches a basic (APNAP)', cr: '101.4',
    seats: [{ bf: ['Field of Ruin', 'Mountain', 'Mountain'] }, { bf: ['Reliquary Tower'] }],
    script: [{ activate: 'Field of Ruin', ability: 1, targets: [['Reliquary Tower']] }, { resolve: true }],
    expect: [{ zone: ['Reliquary Tower', 'graveyard'] }, { zone: ['Field of Ruin', 'graveyard'] }, { libraryCount: [0, 19] }, { libraryCount: [1, 19] }, { zoneCount: [0, 'battlefield', 3] }, { zoneCount: [1, 'battlefield', 1] }, { unsimulated: 0 }],
  },
  {
    // "When this creature enters, you may discard a card. If you do, search your library for a creature card, reveal it, put it into your hand, then shuffle."
    name: 'Formidable Speaker: discarding a card on entry fetches a creature card', cr: '603.2',
    seats: [{ bf: ['Forest', 'Forest', 'Forest'], hand: ['Formidable Speaker', 'Shock'], libraryTop: ['Hill Giant'] }, {}],
    script: [{ answer: true }, { cast: 'Formidable Speaker' }, { resolve: true }],
    expect: [{ zone: ['Formidable Speaker', 'battlefield'] }, { zone: ['Shock', 'graveyard'] }, { zone: ['Hill Giant', 'hand'] }, { libraryCount: [0, 20] }, { unsimulated: 0 }],
  },
  {
    // "{W}, {T}: Put target card from your graveyard on the bottom of your library. Activate only if you control two or more white permanents."
    name: 'Mistveil Plains puts a graveyard card on the bottom of the library while two white permanents are around', cr: '602.5d',
    seats: [{ bf: ['Mistveil Plains', 'Plains', 'Savannah Lions', 'Savannah Lions'], graveyard: ['Hill Giant'] }, {}],
    script: [{ activate: 'Mistveil Plains', ability: 1, targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'library'] }, { libraryCount: [0, 21] }, { graveyardCount: [0, 0] }, { unsimulated: 0 }],
  },
  {
    // "Put a +1/+1 counter on each creature target player controls. Target creature gains your choice of double strike or lifelink until end of turn."
    name: 'Practiced Offense counters every creature of the targeted player and grants the chosen keyword', cr: '608.2c',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Grizzly Bears', 'Hill Giant'], hand: ['Practiced Offense'] }, { bf: ['Runeclaw Bear'] }],
    script: [{ cast: 'Practiced Offense', targets: [['P0'], ['Grizzly Bears']], modes: [0] }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 3, 3] }, { pt: ['Hill Giant', 4, 4] }, { pt: ['Runeclaw Bear', 2, 2] }, { keywords: ['Grizzly Bears', ['double strike']] }, { unsimulated: 0 }],
  },
  {
    // "As long as there are seven or more cards in your graveyard, Putrid Imp gets +1/+1 and can't block."
    name: 'Putrid Imp with threshold is a 2/2 that cannot block', cr: '702.16', active: 1,
    seats: [{ bf: ['Putrid Imp'], graveyard: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain'] }, { bf: ['Hill Giant'] }],
    script: [{ attack: ['Hill Giant'], refused: [['Putrid Imp', 'Hill Giant']] }],
    expect: [{ pt: ['Putrid Imp', 2, 2] }, { life: [0, 17] }, { unsimulated: 0 }],
  },
  {
    name: 'Putrid Imp without threshold is a 1/1 that blocks', cr: '702.16', active: 1,
    seats: [{ bf: ['Putrid Imp'], graveyard: ['Mountain', 'Mountain'] }, { bf: ['Hill Giant'] }],
    script: [{ attack: ['Hill Giant'], blocks: [['Putrid Imp', 'Hill Giant']] }],
    expect: [{ pt: ['Hill Giant', 3, 3] }, { zone: ['Putrid Imp', 'graveyard'] }, { life: [0, 20] }],
  },
  {
    // "Landfall — Whenever a land you control enters, double the power of target creature you control until end of turn."
    name: 'Mightform Harmonizer doubles a creature\'s power when a land enters', cr: '603.2',
    seats: [{ bf: ['Mightform Harmonizer'], hand: ['Forest'] }, {}],
    script: [{ playLand: 'Forest' }, { resolve: true }],
    expect: [{ pt: ['Mightform Harmonizer', 8, 4] }, { unsimulated: 0 }],
  },
  {
    // "Exile two target artifacts, creatures, and/or lands you control, then return those cards to the battlefield under your control."
    name: 'Ghostly Flicker returns both permanents as new objects (counters gone) under your control', cr: '400.7',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Grizzly Bears', 'Hill Giant'], hand: ['Ghostly Flicker'], counters: { 'Grizzly Bears': { '+1/+1': 1 } } }, {}],
    script: [{ cast: 'Ghostly Flicker', targets: [['Grizzly Bears', 'Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Hill Giant', 'battlefield'] }, { control: ['Grizzly Bears', 0] }, { pt: ['Grizzly Bears', 2, 2] }, { counters: ['Grizzly Bears', { '+1/+1': 0 }] }, { events: { type: 'zone-change', min: 4 } }, { unsimulated: 0 }],
  },
  {
    // "−4: Spirits you control gain double strike and vigilance until end of turn."
    name: 'Quintorius, History Chaser -4 gives every Spirit you control double strike and vigilance', cr: '608.2f',
    seats: [{ bf: ['Quintorius, History Chaser', 'Wandering Ones', 'Grizzly Bears'] }, {}],
    script: [{ activate: 'Quintorius, History Chaser', ability: 2 }, { resolve: true }],
    expect: [{ keywords: ['Wandering Ones', ['double strike', 'vigilance']] }, { counters: ['Quintorius, History Chaser', { loyalty: 1 }] }, { noLog: 'Grizzly Bears gains' }, { unsimulated: 0 }],
  },
  {
    // "+1: You may discard a card. If you do, draw two cards, then mill a card."
    name: 'Quintorius, History Chaser +1: discarding draws two and mills one', cr: '608.2c',
    seats: [{ bf: ['Quintorius, History Chaser'], hand: ['Shock'], libraryTop: ['Hill Giant', 'Runeclaw Bear', 'Wind Drake'] }, {}],
    script: [{ answer: true }, { activate: 'Quintorius, History Chaser', ability: 1 }, { resolve: true }],
    expect: [{ zone: ['Shock', 'graveyard'] }, { zone: ['Hill Giant', 'hand'] }, { zone: ['Runeclaw Bear', 'hand'] }, { zone: ['Wind Drake', 'graveyard'] }, { handCount: [0, 2] }, { counters: ['Quintorius, History Chaser', { loyalty: 6 }] }],
  },

  // ---- 9.0b review fixes: the wrong player, the missing choice, the pronoun, the subtype vocabulary, the cost's "another"
  {
    // "Destroy target creature. Its controller loses 2 life and you gain 2 life."
    name: 'Certain Death: the creature\'s controller loses the life and you gain it', cr: '608.2',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['Certain Death'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Certain Death', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { life: [1, 18] }, { life: [0, 22] }, { unsimulated: 0 }],
  },
  {
    // "You may mill three cards. Then return a creature card from your graveyard to the battlefield."
    name: 'Summon Undead: declining the mill mills nothing, and the creature still returns', cr: '608.2',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['Summon Undead'], graveyard: ['Hill Giant'] }, {}],
    script: [{ answer: false }, { cast: 'Summon Undead' }, { resolve: true }],
    expect: [{ libraryCount: [0, 20] }, { zone: ['Hill Giant', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    name: 'Summon Undead: accepting the mill puts three cards into the graveyard first', cr: '608.2',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['Summon Undead'], graveyard: ['Hill Giant'] }, {}],
    script: [{ answer: true }, { cast: 'Summon Undead' }, { resolve: true }],
    expect: [{ libraryCount: [0, 17] }, { unsimulated: 0 }],
  },
  {
    // "{T}: Add {C} for each Locus on the battlefield." — "Locus" is its own singular
    name: 'Cloudpost taps for one colorless mana as the only Locus', cr: '605.1a',
    seats: [{ bf: ['Cloudpost'], hand: ['Sol Ring'] }, {}],
    script: [{ cast: 'Sol Ring' }, { resolve: true }],
    expect: [{ zone: ['Sol Ring', 'battlefield'] }, { tapped: ['Cloudpost', true] }, { unsimulated: 0 }],
  },
  {
    // "At the beginning of your upkeep, tap this creature unless you sacrifice another creature." — it cannot pay with itself
    name: 'Apocalypse Demon alone cannot sacrifice itself to its own upkeep cost, so it taps', cr: '601.2h', active: 1,
    seats: [{ bf: ['Apocalypse Demon'], graveyard: ['Swamp', 'Swamp', 'Swamp'] }, {}],
    script: [{ passUntil: 'upkeep' }, { resolve: true }],
    expect: [{ zone: ['Apocalypse Demon', 'battlefield'] }, { tapped: ['Apocalypse Demon', true] }, { unsimulated: 0 }],
  },
  {
    // "{5}: Target Elf you control gets +2/+2 until end of turn." — a target named by its subtype
    name: 'Safewright Cavalry pumps the targeted Elf', cr: '115.1',
    seats: [{ bf: ['Safewright Cavalry', 'Llanowar Elves', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'] }, {}],
    script: [{ activate: 'Safewright Cavalry', targets: [['Llanowar Elves']] }, { resolve: true }],
    expect: [{ pt: ['Llanowar Elves', 3, 3] }, { pt: ['Safewright Cavalry', 4, 4] }, { unsimulated: 0 }],
  },
  {
    // "Whenever a creature dies, that creature's controller may draw a card."
    name: 'Fecundity: the dead creature\'s controller may decline the draw', cr: '603.2',
    seats: [{ bf: ['Fecundity', 'Grizzly Bears', 'Mountain'], hand: ['Shock'] }, {}],
    script: [{ answer: false }, { cast: 'Shock', targets: [['Grizzly Bears']] }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { libraryCount: [0, 20] }, { unsimulated: 0 }],
  },
  {
    name: 'Fecundity: accepting the draw draws one card', cr: '603.2',
    seats: [{ bf: ['Fecundity', 'Grizzly Bears', 'Mountain'], hand: ['Shock'] }, {}],
    script: [{ answer: true }, { cast: 'Shock', targets: [['Grizzly Bears']] }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { libraryCount: [0, 19] }, { unsimulated: 0 }],
  },
  // ---- the binding frame (9.0b review): a "that" / "those" / "its controller" / "that spell's mana value" after an
  //      antecedent that binds nothing is bound to the item's targets or iterates the same set — never a silent no-op
  {
    // "Gain control of target creature. Untap that creature. It gains haste until end of turn. Sacrifice it at the beginning of the next end step."
    name: 'Slave of Bolas steals, untaps and hastes the creature (gain-control binds nothing: the target is bound before it)', cr: '608.2h',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Swamp', 'Swamp'], hand: ['Slave of Bolas'] }, { bf: ['Hill Giant'], tapped: ['Hill Giant'] }],
    script: [{ cast: 'Slave of Bolas', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ control: ['Hill Giant', 0] }, { tapped: ['Hill Giant', false] }, { keywords: ['Hill Giant', ['haste']] }, { zone: ['Hill Giant', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    name: 'Slave of Bolas: the stolen creature is sacrificed at the beginning of the next end step', cr: '603.7',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Swamp', 'Swamp'], hand: ['Slave of Bolas'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Slave of Bolas', targets: [['Hill Giant']] }, { resolve: true }, { passUntil: 'end' }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { graveyardCount: [1, 1] }, { unsimulated: 0 }],
  },
  {
    // "Put a +1/+1 counter on target creature you control. It gains hexproof until end of turn."
    name: 'Snakeskin Veil puts the counter and grants hexproof (counters binds nothing: the target is bound before it)', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Forest'], hand: ['Snakeskin Veil'] }, {}],
    script: [{ cast: 'Snakeskin Veil', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 1 }] }, { pt: ['Grizzly Bears', 3, 3] }, { keywords: ['Grizzly Bears', ['hexproof']] }, { unsimulated: 0 }],
  },
  {
    // "Untap target creature. It gets +2/+4 and gains reach until end of turn."
    name: 'Spidery Grasp untaps and pumps the same creature', cr: '608.2h',
    seats: [{ bf: ['Grizzly Bears', 'Forest', 'Forest', 'Forest'], tapped: ['Grizzly Bears'], hand: ['Spidery Grasp'] }, {}],
    script: [{ cast: 'Spidery Grasp', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ tapped: ['Grizzly Bears', false] }, { pt: ['Grizzly Bears', 4, 6] }, { keywords: ['Grizzly Bears', ['reach']] }, { unsimulated: 0 }],
  },
  {
    // "Creatures you control get +1/+2 until end of turn. Untap those creatures."
    name: 'Gleam of Resistance pumps and untaps the creatures you control ("those creatures" iterates the set)', cr: '608.2f',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains'], tapped: ['Grizzly Bears', 'Hill Giant'], hand: ['Gleam of Resistance'] }, { bf: ['Grizzly Bears'], tapped: ['Grizzly Bears'] }],
    script: [{ cast: 'Gleam of Resistance' }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 3, 4] }, { pt: ['Hill Giant', 4, 5] }, { tapped: ['Grizzly Bears', false] }, { tapped: ['Hill Giant', false] }, { unsimulated: 0 }],
  },
  {
    // "Creatures you control get +1/+1 until end of turn. If this spell was kicked, those creatures get +2/+1 until end of turn instead."
    name: 'Dauntless Unity kicked gives +2/+1 (the set folded into the else branch still names "those creatures")', cr: '608.2f',
    seats: [{ bf: ['Grizzly Bears', 'Plains', 'Plains', 'Plains', 'Plains'], hand: ['Dauntless Unity'] }, {}],
    script: [{ cast: 'Dauntless Unity', kicked: true }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 4, 3] }, { unsimulated: 0 }],
  },
  {
    name: 'Dauntless Unity unkicked gives +1/+1', cr: '702.33',
    seats: [{ bf: ['Grizzly Bears', 'Plains', 'Plains', 'Plains', 'Plains'], hand: ['Dauntless Unity'] }, {}],
    script: [{ cast: 'Dauntless Unity', kicked: false }, { resolve: true }],
    expect: [{ pt: ['Grizzly Bears', 3, 3] }, { unsimulated: 0 }],
  },
  {
    // "Creatures you control gain first strike until end of turn. If this spell was kicked, they get +1/+1 until end of turn."
    name: 'Savage Offensive kicked grants first strike and +1/+1 ("they" after a grant iterates the set)', cr: '608.2f',
    seats: [{ bf: ['Grizzly Bears', 'Mountain', 'Mountain', 'Forest'], hand: ['Savage Offensive'] }, {}],
    script: [{ cast: 'Savage Offensive', kicked: true }, { resolve: true }],
    expect: [{ keywords: ['Grizzly Bears', ['first strike']] }, { pt: ['Grizzly Bears', 3, 3] }, { unsimulated: 0 }],
  },
  // (Dream Fracture "Counter target spell. Its controller draws a card." and Access Denied "… where X is that spell's mana
  //  value" are unparsed until `counter` binds the countered spell — a spell target is a stack ref the engine's `bind`
  //  cannot take; docs/HANDOFF.md item 23.)
  // ---- the anthem "… you control have <keywords>" templates (9.0b review): filter words the vocabulary makes expressible
  {
    // "Attacking creatures you control have double strike."
    name: 'Blade Historian gives an attacking creature double strike', cr: '613.1e',
    seats: [{ bf: ['Blade Historian', 'Grizzly Bears'] }, {}],
    script: [{ attack: ['Grizzly Bears'] }],
    expect: [{ life: [1, 16] }, { unsimulated: 0 }],
  },
  {
    // "Artifacts you control have hexproof."
    name: 'Padeem, Consul of Innovation gives a noncreature artifact hexproof', cr: '613.1e',
    seats: [{ bf: ['Padeem, Consul of Innovation', 'Sol Ring'] }, {}],
    script: [{ sba: true }],
    expect: [{ keywords: ['Sol Ring', ['hexproof']] }],
  },
  {
    // "Whenever you cast an instant or sorcery spell, this creature gets +1/+1 until end of turn. Untap it." — "it" is Blistercoil Weird
    name: 'Blistercoil Weird untaps itself (not the spell) when an instant is cast', cr: '603.2',
    seats: [{ bf: ['Blistercoil Weird', 'Mountain'], tapped: ['Blistercoil Weird'], hand: ['Lightning Bolt'] }, { life: 20 }],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }, { resolve: true }],
    expect: [{ tapped: ['Blistercoil Weird', false] }, { pt: ['Blistercoil Weird', 2, 2] }, { life: [1, 17] }, { unsimulated: 0 }],
  },
];
