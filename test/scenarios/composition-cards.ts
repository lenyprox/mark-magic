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
    name: 'Slave of Bolas steals, untaps and hastes the creature (gain-control binds what it stole)', cr: '608.2h',
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
  // ================================================================== 9.0c: cards the engine bindings, scopes, filter fields, amounts and LKI made fully parsed
  {
    // "Counter target spell. Its controller draws a card. / Draw a card."
    name: 'Dream Fracture counters the spell and its controller draws (the countered spell is bound with its stack-time controller)', cr: '608.2h',
    seats: [{ bf: ['Island', 'Island', 'Island'], hand: ['Dream Fracture'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Dream Fracture', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { handCount: [1, 1] }, { handCount: [0, 1] }, { unsimulated: 0 }],
  },
  {
    // "Counter target spell. Create X 1/1 colorless Thopter artifact creature tokens with flying, where X is that spell's mana value."
    name: "Access Denied makes as many Thopters as the countered spell's mana value", cr: '202.3',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Island', 'Island'], hand: ['Access Denied'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Access Denied', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { zoneCount: [0, 'battlefield', 9] }, { events: { type: 'create-token', min: 1 } }, { unsimulated: 0 }],
  },
  {
    // "Counter target spell. Its controller loses 3 life and you gain 3 life."
    name: "Punish Ignorance: the countered spell's controller loses 3 and you gain 3", cr: '608.2h',
    seats: [{ bf: ['Plains', 'Island', 'Island', 'Swamp'], hand: ['Punish Ignorance'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Punish Ignorance', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { life: [1, 17] }, { life: [0, 23] }, { unsimulated: 0 }],
  },
  {
    // "Counter target noncreature spell. Its controller creates two Treasure tokens."
    name: "An Offer You Can't Refuse gives the countered spell's controller two Treasures", cr: '608.2h',
    seats: [{ bf: ['Island'], hand: ["An Offer You Can't Refuse"] }, { bf: ['Mountain'], hand: ['Shock'] }],
    script: [{ cast: 'Shock', by: 1, targets: [['P0']] }, { cast: "An Offer You Can't Refuse", targets: [['Shock']] }, { resolve: true }],
    expect: [{ zone: ['Shock', 'graveyard'] }, { life: [0, 20] }, { zoneCount: [1, 'battlefield', 3] }, { unsimulated: 0 }],
  },
  {
    // "Counter target spell. Its controller loses 3 life."
    name: 'Undermine: the countered spell\'s controller loses 3 life', cr: '608.2h',
    seats: [{ bf: ['Island', 'Island', 'Swamp'], hand: ['Undermine'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Undermine', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { life: [1, 17] }, { unsimulated: 0 }],
  },
  {
    // "Counter target spell. That spell's controller may draw a card."
    name: "Vex: that spell's controller may draw a card (the default agent does)", cr: '608.2h',
    seats: [{ bf: ['Island', 'Island', 'Island'], hand: ['Vex'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Vex', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { handCount: [1, 1] }, { unsimulated: 0 }],
  },
  {
    // "Counter target artifact, creature, or planeswalker spell. Its controller creates a 2/2 blue Bird creature token with flying."
    name: 'Strix Serenade counters a creature spell through the comma-list filter and gives its controller a Bird', cr: '115.1',
    seats: [{ bf: ['Island'], hand: ['Strix Serenade'] }, { bf: ['Plains', 'Plains', 'Plains', 'Plains'], hand: ['Restoration Angel'] }],
    script: [{ cast: 'Restoration Angel', by: 1 }, { cast: 'Strix Serenade', targets: [['Restoration Angel']] }, { resolve: true }],
    expect: [{ zone: ['Restoration Angel', 'graveyard'] }, { zoneCount: [1, 'battlefield', 5] }, { unsimulated: 0 }],
  },
  {
    // "When this creature enters, sacrifice another creature. You gain X life and draw X cards, where X is that creature's power."
    name: "Disciple of Bolas: the sacrifice op binds the sacrificed creature, whose power is the X (last known information)", cr: '608.2h',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Hill Giant'], hand: ['Disciple of Bolas'] }, {}],
    script: [{ cast: 'Disciple of Bolas' }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [0, 23] }, { handCount: [0, 3] }, { unsimulated: 0 }],
  },
  {
    // "When this creature enters, you may sacrifice another creature. When you do, this creature deals damage equal to that creature's power to any target."
    name: "Heart-Piercer Manticore: the reflexive trigger reads the sacrificed creature's power", cr: '603.12',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Hill Giant'], hand: ['Heart-Piercer Manticore'] }, {}],
    script: [{ answer: true }, { cast: 'Heart-Piercer Manticore' }, { resolve: true }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [1, 17] }],
  },
  {
    // "{W/U}, {Q}: Look at the top card of your library. You may exile that card."
    name: 'Puresight Merrow: look-top binds the looked-at card, which is then exiled', cr: '400.7',
    seats: [{ bf: ['Puresight Merrow', 'Plains'], tapped: ['Puresight Merrow'], libraryTop: ['Wind Drake'] }, {}],
    script: [{ answer: true }, { activate: 'Puresight Merrow' }, { resolve: true }],
    expect: [{ zone: ['Wind Drake', 'exile'] }, { tapped: ['Puresight Merrow', false] }, { unsimulated: 0 }],
  },
  {
    // "+2: Untap all creatures you control. Those creatures get +1/+1 until end of turn."
    name: 'Gideon, Martial Paragon +2 untaps the creatures and pumps that set (the untapped objects are "those")', cr: '608.2h',
    seats: [{ bf: ['Gideon, Martial Paragon', 'Hill Giant', 'Mountain'], tapped: ['Hill Giant', 'Mountain'] }, {}],
    script: [{ activate: 'Gideon, Martial Paragon', ability: 0 }, { resolve: true }],
    expect: [{ tapped: ['Hill Giant', false] }, { pt: ['Hill Giant', 4, 4] }, { tapped: ['Mountain', true] }],
  },
  {
    // "When this creature enters, target opponent draws a card and you draw three cards."
    name: 'Sphinx of Enlightenment: target opponent draws one, you draw three (the opponent-only scope)', cr: '115.1',
    seats: [{ bf: ['Island', 'Island', 'Island', 'Island', 'Island', 'Island'], hand: ['Sphinx of Enlightenment'] }, {}],
    script: [{ cast: 'Sphinx of Enlightenment' }, { resolve: true }, { resolve: true }],
    expect: [{ handCount: [1, 1] }, { handCount: [0, 3] }, { unsimulated: 0 }],
  },
  {
    // "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}."
    name: "Rhystic Study: the opponent cannot pay, so its controller draws (otherwiseAs 'controller')", cr: '118.12',
    seats: [{ bf: ['Rhystic Study'] }, { bf: ['Mountain'], hand: ['Shock'] }],
    script: [{ cast: 'Shock', by: 1, targets: [['P0']] }, { resolve: true }],
    expect: [{ handCount: [0, 1] }, { handCount: [1, 0] }, { life: [0, 18] }, { unsimulated: 0 }],
  },
  {
    // "When this creature enters, you may exile target non-Angel creature you control, then return that card to the battlefield under your control."
    name: 'Restoration Angel blinks a non-Angel creature (its counters are gone) and never offers itself', cr: '400.7',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Grizzly Bears'], hand: ['Restoration Angel'], counters: { 'Grizzly Bears': { '+1/+1': 1 } } }, {}],
    script: [{ answer: true }, { cast: 'Restoration Angel' }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { counters: ['Grizzly Bears', { '+1/+1': 0 }] }, { zone: ['Restoration Angel', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    // "Target creature gets -X/-X until end of turn."
    name: 'Death Wind with X = 3 kills a 3/3 (the "-X" sign is kept)', cr: '107.3',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['Death Wind'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Death Wind', x: 3, targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    // "Return up to three target land cards from your graveyard to your hand."
    name: 'Life from the Loam returns up to three land cards from the graveyard', cr: '601.2c',
    seats: [{ bf: ['Forest', 'Forest'], hand: ['Life from the Loam'], graveyard: ['Mountain', 'Mountain', 'Plains', 'Island'] }, {}],
    script: [{ cast: 'Life from the Loam', targets: [['Mountain', 'Plains', 'Island']] }, { resolve: true }],
    expect: [{ handCount: [0, 3] }, { graveyardCount: [0, 2] }, { zone: ['Plains', 'hand'] }, { zone: ['Island', 'hand'] }, { unsimulated: 0 }],
  },
  {
    // "Enchanted creature has base power and toughness 9/9 and has flying, first strike, trample, and haste."
    name: 'Super State sets the enchanted creature\'s base P/T to 9/9 and grants its keywords (layer 7b static)', cr: '613.4b',
    seats: [{ bf: ['Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Plains', 'Grizzly Bears'], hand: ['Super State'], counters: { 'Grizzly Bears': { '+1/+1': 1 } } }, {}],
    script: [{ cast: 'Super State', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ attachedTo: ['Super State', 'Grizzly Bears'] }, { pt: ['Grizzly Bears', 10, 10] }, { keywords: ['Grizzly Bears', ['flying', 'first strike', 'trample', 'haste']] }],
  },
  {
    // "Torrent of Fire deals damage to any target equal to the greatest mana value among permanents you control."
    name: 'Torrent of Fire deals damage equal to the greatest mana value among your permanents (an aggregate amount)', cr: '107.1',
    seats: [{ bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain', 'Mountain', 'Hill Giant'], hand: ['Torrent of Fire'] }, {}],
    script: [{ cast: 'Torrent of Fire', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 16] }, { unsimulated: 0 }],
  },
  {
    // "Whenever this creature attacks, it gets +2/+0 until end of turn. / When this creature dies, target player loses life equal to its power."
    name: 'Mortis Dogs: the death trigger reads last known information — the pumped 4 power, not the printed 2', cr: '608.2h',
    seats: [{ bf: ['Mortis Dogs'] }, { bf: ['Hill Giant'] }],
    script: [{ attack: ['Mortis Dogs'], blocks: [['Hill Giant', 'Mortis Dogs']] }, { resolve: true }],
    expect: [{ zone: ['Mortis Dogs', 'graveyard'] }, { zone: ['Hill Giant', 'graveyard'] }, { life: [1, 16] }, { unsimulated: 0 }],
  },
  {
    // "Whenever a creature you control enters, target opponent loses life equal to the difference between that creature's power and its toughness."
    name: 'Jaws of Defeat fires on your own creature entering (the "you control" trigger template) for the power/toughness difference', cr: '603.2',
    seats: [{ bf: ['Jaws of Defeat', 'Mountain', 'Mountain'], hand: ['Goblin Piker'] }, {}],
    script: [{ cast: 'Goblin Piker' }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Goblin Piker', 'battlefield'] }, { life: [1, 19] }, { unsimulated: 0 }],
  },
  {
    // "Destroy target creature and target land."
    name: 'Spiteful Blow destroys a creature and a land: two instances of "target", two parts', cr: '115.3',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp'], hand: ['Spiteful Blow'] }, { bf: ['Hill Giant', 'Reliquary Tower'] }],
    script: [{ cast: 'Spiteful Blow', targets: [['Hill Giant'], ['Reliquary Tower']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zone: ['Reliquary Tower', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    // "Whenever a creature an opponent controls dies, you gain 1 life." (and the rest of the card)
    name: "The Meathook Massacre gains life when an opponent's creature dies", cr: '603.2',
    seats: [{ bf: ['The Meathook Massacre', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [0, 21] }, { unsimulated: 0 }],
  },
  {
    // "Chainsword — Whenever a creature an opponent controls dies, that player loses 2 life."
    name: 'Assault Intercessor: that player (the dead creature\'s controller) loses 2 life', cr: '603.2',
    seats: [{ bf: ['Assault Intercessor', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { life: [1, 18] }, { unsimulated: 0 }],
  },
  {
    // "{1}, {T}: Target 1/1 creature gets +1/+2 until end of turn."
    name: 'Aegis of the Meek targets a 1/1 (the exact P/T filter)', cr: '115.1',
    seats: [{ bf: ['Aegis of the Meek', 'Mountain', "Mons's Goblin Raiders"] }, {}],
    script: [{ activate: 'Aegis of the Meek', targets: [["Mons's Goblin Raiders"]] }, { resolve: true }],
    expect: [{ pt: ["Mons's Goblin Raiders", 2, 3] }, { unsimulated: 0 }],
  },
  {
    // "{T}: This creature deals 1 damage to target creature. / Whenever a creature dealt damage by this creature this turn dies, put a +1/+1 counter on this creature."
    name: 'Blood Cultist grows when a creature it damaged this turn dies (the per-turn damage record)', cr: '120.3',
    seats: [{ bf: ['Blood Cultist', 'Mountain'], hand: ['Shock'] }, { bf: ['Hill Giant'] }],
    script: [{ activate: 'Blood Cultist', targets: [['Hill Giant']] }, { resolve: true }, { cast: 'Shock', targets: [['Hill Giant']] }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { counters: ['Blood Cultist', { '+1/+1': 1 }] }, { unsimulated: 0 }],
  },
  {
    // 'All creatures have "At the beginning of your upkeep, sacrifice this creature unless you pay {1}."'
    name: "Pendrell Mists: every creature carries the upkeep tax — the opponent's creature with no mana is sacrificed at their upkeep", cr: '613.1f',
    seats: [{ bf: ['Pendrell Mists'] }, { bf: ['Hill Giant'] }],
    script: [{ turns: 1 }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { zone: ['Pendrell Mists', 'battlefield'] }],
  },
  {
    // "When this creature dies, target opponent puts a card from their hand on top of their library."
    name: 'Chimney Imp: target opponent puts a card from their hand on top of their library', cr: '115.1',
    seats: [{ bf: ['Chimney Imp', 'Mountain'], hand: ['Lightning Bolt'] }, { hand: ['Shock'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Chimney Imp']] }, { resolve: true }, { resolve: true }],
    expect: [{ zone: ['Chimney Imp', 'graveyard'] }, { handCount: [1, 0] }, { libraryCount: [1, 21] }, { unsimulated: 0 }],
  },
  {
    // "{G}: This creature gets +1/+1 until end of turn. Target opponent creates a 1/1 green Hippo creature token."
    name: 'Questing Phelddagrif: the Hippo goes to the targeted opponent', cr: '115.1',
    seats: [{ bf: ['Questing Phelddagrif', 'Forest'] }, {}],
    script: [{ activate: 'Questing Phelddagrif', ability: 0, targets: [['P1']] }, { resolve: true }],
    expect: [{ pt: ['Questing Phelddagrif', 5, 5] }, { zoneCount: [1, 'battlefield', 1] }, { zoneCount: [0, 'battlefield', 2] }],
  },
  // ------------------------------------------------------------------ 9.0c review fixes: each pins a finding of the review
  {
    // "Whenever an opponent casts a noncreature spell, you may draw a card unless that player pays {4}."
    name: 'Mystic Remora: an opponent\'s noncreature spell draws its controller a card when the opponent cannot pay', cr: '603.2',
    seats: [{ bf: ['Mystic Remora'] }, { bf: ['Mountain'], hand: ['Shock'] }],
    script: [{ cast: 'Shock', by: 1, targets: [['P0']] }, { resolve: true }],
    expect: [{ handCount: [0, 1] }, { handCount: [1, 0] }, { life: [0, 18] }, { unsimulated: 0 }],
  },
  {
    name: 'Mystic Remora: a creature spell is not a noncreature spell (no trigger)', cr: '603.2',
    seats: [{ bf: ['Mystic Remora'] }, { bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }],
    active: 1,
    script: [{ cast: 'Grizzly Bears', by: 1 }, { resolve: true }],
    expect: [{ handCount: [0, 0] }, { zone: ['Grizzly Bears', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    // "Whenever equipped creature dies, draw two cards." — the creature it is attached to (CR 702.6a), matched before the Equipment comes off (CR 603.10a)
    name: 'Skullclamp draws two when the creature it equips dies', cr: '702.6a',
    seats: [{ bf: ['Skullclamp', 'Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    script: [{ activate: 'Skullclamp', targets: [['Grizzly Bears']] }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { handCount: [0, 2] }, { unsimulated: 0 }],
  },
  {
    name: 'Skullclamp does not draw for an opponent\'s equipped creature dying', cr: '702.6a',
    seats: [{ bf: ['Skullclamp', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Short Sword', 'Raging Goblin', 'Forest'] }],
    active: 1,
    script: [{ activate: 'Short Sword', by: 1, targets: [['Raging Goblin']] }, { resolve: true }, { passUntil: 'end' }, { cast: 'Lightning Bolt', by: 0, targets: [['Raging Goblin']] }, { resolve: true }, { sba: true }, { resolve: true }],
    expect: [{ zone: ['Raging Goblin', 'graveyard'] }, { attachedTo: ['Short Sword', null] }, { handCount: [0, 0] }],
  },
  {
    name: 'Skullclamp does not draw for an unequipped creature of its controller dying', cr: '702.6a',
    seats: [{ bf: ['Skullclamp', 'Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { handCount: [0, 0] }],
  },
  {
    // "Whenever this creature deals damage, you gain that much life." — damage to a player is damage (CR 120.3)
    name: 'Exalted Angel: combat damage to a player gains that much life', cr: '120.3',
    seats: [{ bf: ['Exalted Angel'] }, {}],
    script: [{ attack: ['Exalted Angel'] }, { resolve: true }],
    expect: [{ life: [1, 16] }, { life: [0, 24] }, { unsimulated: 0 }],
  },
  {
    // "Whenever an opponent loses life, you gain that much life."
    name: 'Exquisite Blood gains the life the opponent lost', cr: '119.3',
    seats: [{ bf: ['Exquisite Blood', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 17] }, { life: [0, 23] }, { unsimulated: 0 }],
  },
  {
    // "Whenever an opponent loses life, that player mills that many cards."
    name: 'Mindcrank mills the opponent for the life they lost', cr: '119.3',
    seats: [{ bf: ['Mindcrank', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 17] }, { libraryCount: [1, 17] }, { unsimulated: 0 }],
  },
  {
    // Infect damage to a player is poison counters instead of life loss (CR 120.3c), so "whenever an opponent loses life" never fires.
    name: 'Exquisite Blood does not trigger on infect damage: the opponent got poison counters, not life loss', cr: '120.3c',
    seats: [{ bf: ['Exquisite Blood', 'Glistener Elf'] }, {}],
    script: [{ attack: ['Glistener Elf'] }, { resolve: true }],
    expect: [{ playerCounters: [1, { poison: 1 }] }, { life: [1, 20] }, { life: [0, 20] }, { unsimulated: 0 }],
  },
  {
    name: 'Mindcrank does not mill for infect damage: no life was lost', cr: '120.3c',
    seats: [{ bf: ['Mindcrank', 'Glistener Elf'] }, {}],
    script: [{ attack: ['Glistener Elf'] }, { resolve: true }],
    expect: [{ playerCounters: [1, { poison: 1 }] }, { life: [1, 20] }, { libraryCount: [1, 20] }, { unsimulated: 0 }],
  },
  {
    // "Whenever a creature dealt damage by this creature this turn dies, you gain life equal to that creature's toughness."
    name: 'Abattoir Ghoul gains the dead creature\'s toughness (Wall of Wood: 3), not its own power', cr: '608.2h',
    seats: [{ bf: ['Abattoir Ghoul'] }, { bf: ['Wall of Wood'] }],
    script: [{ attack: ['Abattoir Ghoul'], blocks: [['Wall of Wood', 'Abattoir Ghoul']] }, { resolve: true }, { sba: true }, { resolve: true }],
    expect: [{ zone: ['Wall of Wood', 'graveyard'] }, { life: [0, 23] }, { unsimulated: 0 }],
  },
  {
    // "Target player sacrifices a creature of their choice, then gains life equal to that creature's toughness."
    name: 'Devour Flesh: the sacrificing player gains the sacrificed creature\'s toughness', cr: '608.2h',
    seats: [{ bf: ['Swamp', 'Swamp'], hand: ['Devour Flesh'] }, { bf: ['Wall of Wood'] }],
    script: [{ cast: 'Devour Flesh', targets: [['P1']] }, { resolve: true }],
    expect: [{ zone: ['Wall of Wood', 'graveyard'] }, { life: [1, 23] }, { life: [0, 20] }, { unsimulated: 0 }],
  },
  {
    // "Whenever a creature dealt damage by this creature this turn dies, create a tapped 2/2 black Zombie creature token and exile that card."
    name: 'Wight: the Zombie token stays and the dead creature card is exiled (a token is not "that card")', cr: '111.1',
    seats: [{ bf: ['Wight'] }, { bf: ['Raging Goblin'] }],
    script: [{ attack: ['Wight'], blocks: [['Raging Goblin', 'Wight']] }, { resolve: true }, { sba: true }, { resolve: true }],
    expect: [{ zone: ['Raging Goblin', 'exile'] }, { zoneCount: [0, 'battlefield', 2] }, { unsimulated: 0 }],
  },
  {
    // "Whenever a creature you control deals combat damage to a player, put that many +1/+1 counters on it."
    name: 'Necropolis Regent: the counters go on the creature that dealt the damage, not on the Regent', cr: '603.2',
    seats: [{ bf: ['Necropolis Regent', 'Grizzly Bears'] }, {}],
    script: [{ attack: ['Grizzly Bears'] }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 2 }] }, { counters: ['Necropolis Regent', { '+1/+1': 0 }] }, { unsimulated: 0 }],
  },
  {
    // "Return up to two target creature cards from your graveyard to your hand."
    name: 'Morbid Plunder returns exactly the two cards it targeted, never a fresh pick', cr: '115.1',
    seats: [{ bf: ['Swamp', 'Swamp', 'Swamp'], hand: ['Morbid Plunder'], graveyard: ['Grizzly Bears', 'Hill Giant', 'Raging Goblin'] }, {}],
    script: [{ cast: 'Morbid Plunder', targets: [['Hill Giant', 'Raging Goblin']] }, { resolve: true }],
    expect: [{ zone: ['Hill Giant', 'hand'] }, { zone: ['Raging Goblin', 'hand'] }, { zone: ['Grizzly Bears', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    // "{2}, {T}, Remove all charge counters from this artifact: It deals that much damage to target creature."
    name: 'Relic Amulet removes all its charge counters and deals that much damage', cr: '608.2',
    seats: [{ bf: ['Relic Amulet', 'Mountain', 'Mountain'], counters: { 'Relic Amulet': { charge: 3 } } }, { bf: ['Hill Giant'] }],
    script: [{ activate: 'Relic Amulet', ability: 1, targets: [['Hill Giant']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Hill Giant', 'graveyard'] }, { counters: ['Relic Amulet', { charge: 0 }] }, { unsimulated: 0 }],
  },
  {
    // "Return up to three target land cards from your graveyard to the battlefield tapped. Create that many 4/2 green Plant Warrior creature tokens with reach."
    name: 'Vengeful Regrowth: that many tokens is the number of lands returned', cr: '608.2',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Vengeful Regrowth'], graveyard: ['Mountain', 'Plains', 'Grizzly Bears'] }, {}],
    script: [{ cast: 'Vengeful Regrowth', targets: [['Mountain', 'Plains']] }, { resolve: true }],
    expect: [{ zone: ['Mountain', 'battlefield'] }, { tapped: ['Mountain', true] }, { zoneCount: [0, 'battlefield', 10] }, { unsimulated: 0 }],
  },
  {
    // "~ gets +1/+0 for each other snow permanent you control." — 0/4 printed; two Snow-Covered Forests, itself not counted
    name: 'Spirit of the Aldergard counts other snow permanents of any type, not itself', cr: '205.4',
    seats: [{ bf: ['Spirit of the Aldergard', 'Snow-Covered Forest', 'Snow-Covered Forest', 'Forest'] }, {}],
    script: [{ sba: true }],
    expect: [{ pt: ['Spirit of the Aldergard', 2, 4] }, { unsimulated: 0 }],
  },
  {
    // "Return up to two target permanent cards from your graveyard to your hand." — an instant in the graveyard is not a legal target
    name: 'Regenesis returns a permanent card and cannot target an instant card in the graveyard', cr: '110.4c',
    seats: [{ bf: ['Forest', 'Forest', 'Forest', 'Forest', 'Forest'], hand: ['Regenesis'], graveyard: ['Grizzly Bears', 'Lightning Bolt'] }, {}],
    script: [{ cast: 'Regenesis', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ zone: ['Grizzly Bears', 'hand'] }, { zone: ['Lightning Bolt', 'graveyard'] }],
  },
];
