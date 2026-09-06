// Replacement effects and prevention shields (Phase 9.1, docs/vocabulary/replacement.md): one scenario per op, per
// static kind, per as-enters kind and per keyword parameter that changes what the family does.
//
// Most of these use REAL printed cards, because the parser rules in src/cards/rules/replacement.ts landed with the
// engine half: Fog Bank, Cho-Manno, Corpsejack Menace, Soul-Scar Mage, Deflecting Palm, Test of Faith, Stone of
// Erech, Furnace of Rath, Guardian Seraph and the rest parse into these ops as printed. The three shapes no printed
// card parses into yet (`counter-replacement` with `instead: none`, a `prevent` whose rider deals damage to a chosen
// target, and a `damage-replacement` that simply deletes the damage) go through the DSL's `scripts` field.
//
// Every scenario asserts the change the effect makes, and would fail if the op did nothing: the creature would die,
// the life total would move, the counters would be one instead of two, the card would be in the graveyard.
import type { Effect, StaticEffect } from '../../src/cards/types.js';
import { attackWith, type Scenario, type ScenarioScript } from './dsl.js';

/** Grizzly Bears gains "{T}: <effects>" (the printed vanilla body stays). */
const bears = (effects: Effect[], text = 'replacement'): Record<string, ScenarioScript> =>
  ({ 'Grizzly Bears': { abilities: [{ kind: 'activated', cost: { tap: true }, effects, text }] } });
/** Runeclaw Bear gains a static ability (the vanilla body stays), so a static kind can be exercised with no printed card. */
const staticOn = (name: string, effect: StaticEffect, text = 'replacement'): Record<string, ScenarioScript> =>
  ({ [name]: { abilities: [{ kind: 'static', effect, text }] } });

export const replacement: Scenario[] = [
  // ---------------------------------------------------------------- prevention-shield (static, CR 615.1)
  {
    name: 'Cho-Manno, Revolutionary prevents all damage dealt to it (Lightning Bolt does nothing)', cr: '615.1',
    ruling: 'A prevention shield replaces the damage event before any damage is marked, so the creature is never dealt lethal damage.',
    seats: [{ bf: ['Cho-Manno, Revolutionary'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['Cho-Manno, Revolutionary']] }, { resolve: true }],
    expect: [{ zone: ['Cho-Manno, Revolutionary', 'battlefield'] }, { events: { type: 'prevented', min: 1 } }, { noLog: 'Cho-Manno, Revolutionary is destroyed' }, { unsimulated: 0 }],
  },
  {
    name: 'Fog Bank prevents the combat damage it would deal and the combat damage dealt to it', cr: '615.1',
    ruling: 'Two shields, one for each direction; neither creature is dealt any combat damage (CR 510.2).',
    seats: [{ bf: ['Hill Giant'] }, { bf: ['Fog Bank'] }],
    script: [attackWith(['Hill Giant'], [['Fog Bank', 'Hill Giant']])],
    expect: [{ zone: ['Fog Bank', 'battlefield'] }, { zone: ['Hill Giant', 'battlefield'] }, { life: [1, 20] }, { events: { type: 'prevented', min: 1 } }, { unsimulated: 0 }],
  },
  {
    name: "Uncle Istvan's shield stops a blocker's combat damage but not Lightning Bolt (`from.filter` is checked)", cr: '615.1',
    ruling: 'The shield only answers for damage dealt by creatures, so a noncreature source still deals its damage.',
    seats: [{ bf: ['Uncle Istvan'] }, { bf: ['Hill Giant', 'Mountain'], hand: ['Lightning Bolt'] }],
    script: [attackWith(['Uncle Istvan'], [['Hill Giant', 'Uncle Istvan']]), { cast: 'Lightning Bolt', by: 1, targets: [['Uncle Istvan']] }, { resolve: true }, { sba: true }],
    // Uncle Istvan is 1/3: the blocker's 3 combat damage is prevented, the bolt's 3 is not and kills it
    expect: [{ zone: ['Uncle Istvan', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    name: 'Gaseous Form prevents all combat damage to and by the enchanted creature (`from.attached`)', cr: '615.1',
    ruling: 'The Aura speaks for the permanent it is attached to, not for its own object.',
    seats: [{ bf: ['Hill Giant', 'Island', 'Island', 'Island'], hand: ['Gaseous Form'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Gaseous Form', targets: [['Hill Giant']] }, { resolve: true }, attackWith(['Hill Giant'], [['Grizzly Bears', 'Hill Giant']])],
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Hill Giant', 'battlefield'] }, { events: { type: 'prevented', min: 1 } }],
  },

  // ---------------------------------------------------------------- prevent (effect, CR 615.1 / 615.10)
  {
    name: 'Trained Pronghorn prevents all damage that would be dealt to it this turn', cr: '615.1',
    seats: [{ bf: ['Trained Pronghorn'], hand: ['Plains'] }, { bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }],
    script: [{ activate: 'Trained Pronghorn' }, { resolve: true }, { cast: 'Lightning Bolt', by: 1, targets: [['Trained Pronghorn']] }, { resolve: true }, { cast: 'Shock', by: 1, targets: [['Trained Pronghorn']] }, { resolve: true }, { sba: true }],
    // an 'all' shield never runs out: both burn spells are prevented
    expect: [{ zone: ['Trained Pronghorn', 'battlefield'] }, { handCount: [0, 0] }, { events: { type: 'prevented', min: 2 } }, { unsimulated: 0 }],
  },
  {
    name: 'Conservator prevents only the next 2 damage dealt to you — the third point still gets through', cr: '615.1',
    ruling: 'A shield of N is used up N damage at a time; the rest of the damage event is dealt (CR 615.7).',
    seats: [{ bf: ['Conservator', 'Plains', 'Plains', 'Plains'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ activate: 'Conservator' }, { resolve: true }, { cast: 'Lightning Bolt', by: 1, targets: [['P0']] }, { resolve: true }],
    expect: [{ life: [0, 19] }, { events: { type: 'prevented', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'Deflecting Palm prevents the chosen source\'s damage and sends it back at its controller', cr: '615.10',
    ruling: 'The source is chosen as the shield is created; the rider is part of the same replacement effect.',
    seats: [{ bf: ['Plains', 'Mountain'], hand: ['Deflecting Palm'] }, { bf: ['Hill Giant'] }],
    active: 1,
    script: [{ cast: 'Deflecting Palm', by: 0 }, { resolve: true }, attackWith(['Hill Giant'])],
    // the attacker's 3 combat damage to seat 0 is prevented and dealt to seat 1 instead
    expect: [{ life: [0, 20] }, { life: [1, 17] }, { events: { type: 'prevented', min: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'Circle of Protection: Red binds the red source that is already on the stack', cr: '615.10',
    ruling: 'The source is chosen as the shield is created, and a spell on the stack is a legal choice (CR 609.7).',
    seats: [{ bf: ['Circle of Protection: Red', 'Plains', 'Plains'] }, { bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['P0']] }, { activate: 'Circle of Protection: Red' }, { resolve: true }, { cast: 'Shock', by: 1, targets: [['P0']] }, { resolve: true }],
    // the bound Bolt is prevented in full; Shock is a different source and is not
    expect: [{ life: [0, 18] }, { events: { type: 'prevented', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'Deflecting Palm binds the attacker, not the first of two permanents the opponent controls', cr: '615.10',
    ruling: 'CR 615.10 lets the player choose; the candidates are offered most-threatening first, so an agent that takes the first option gets the source that is about to deal the damage — here the bigger of two idle creatures, one of which is about to attack.',
    seats: [{ bf: ['Plains', 'Mountain'], hand: ['Deflecting Palm'] }, { bf: ['Grizzly Bears', 'Hill Giant'] }],
    active: 1,
    script: [{ cast: 'Deflecting Palm', by: 0 }, { resolve: true }, attackWith(['Hill Giant'])],
    // Grizzly Bears has the lower object id: an order that only sorted by id would bind it and prevent nothing
    expect: [{ life: [0, 20] }, { life: [1, 17] }, { events: { type: 'prevented', min: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'a shield that must choose a source takes the creature that is attacking over a bigger idle one', cr: '615.10',
    ruling: 'A source that is already attacking or blocking is about to deal damage; that outranks a larger permanent doing nothing.',
    seats: [{ bf: ['Grizzly Bears'] }, { bf: ['Serra Angel', 'Hill Giant'] }],
    active: 1,
    scripts: {
      'Grizzly Bears': { abilities: [{ kind: 'triggered', event: { on: 'blocks', self: true }, effects: [
        { op: 'prevent', amount: 'all', from: { chosen: true, filter: { types: ['Creature'] }, who: 'opponent' }, to: { filter: { types: ['Creature'] }, who: 'you' }, duration: 'eot' },
      ], text: 'replacement' }] },
    },
    script: [attackWith(['Hill Giant'], [['Grizzly Bears', 'Hill Giant']]), { sba: true }],
    // Serra Angel is both the lower id and the bigger creature; only "is it attacking?" picks the Hill Giant that
    // the 2/2 blocker is about to be dealt 3 damage by
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Hill Giant', 'battlefield'] }, { events: { type: 'prevented', min: 1 } }],
  },
  {
    name: 'Circle of Protection: Red activated with no red source to choose prevents nothing at all', cr: '615.10',
    ruling: 'A shield that must name a source and cannot is bound to no source, so no damage ever matches it. Leaving it unbound would make it better than the printed card.',
    seats: [{ bf: ['Circle of Protection: Red', 'Plains', 'Plains'] }, { bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }],
    script: [{ activate: 'Circle of Protection: Red' }, { resolve: true }, { cast: 'Lightning Bolt', by: 1, targets: [['P0']] }, { resolve: true }, { cast: 'Shock', by: 1, targets: [['P0']] }, { resolve: true }],
    expect: [{ life: [0, 15] }, { events: { type: 'prevented', max: 0 } }, { log: 'no source of damage to choose' }, { unsimulated: 0 }],
  },
  {
    name: 'Cho-Arrim Alchemist gains life equal to the damage its shield prevented', cr: '615.1',
    ruling: 'The source is chosen as the shield is created (CR 615.10), so the shield goes up in response to the spell it is meant to stop.',
    seats: [{ bf: ['Cho-Arrim Alchemist', 'Plains', 'Plains', 'Plains'], hand: ['Island'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['P0']] }, { activate: 'Cho-Arrim Alchemist' }, { resolve: true }],
    expect: [{ life: [0, 23] }, { events: { type: 'prevented', min: 1 } }, { unsimulated: 0 }],
  },
  {
    name: 'a shield whose rider counts the damage prevented turns it into +1/+1 counters', cr: '615.1',
    ruling: 'The rider counts the damage actually prevented, not the size of the shield.',
    seats: [{ bf: ['Grizzly Bears', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Mountain'], hand: ['Shock'] }],
    scripts: {
      'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects: [
        { op: 'prevent', amount: 3, to: { filter: { types: ['Creature'] }, who: 'you' }, duration: 'eot' },
        { op: 'prevent-rider', rider: { mode: 'counters', counter: '+1/+1' } },
      ], text: 'replacement' }] },
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }, { cast: 'Shock', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }],
    // Shock's 2 damage is prevented by the 3-point shield, so exactly two +1/+1 counters are placed
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 2 }] }, { pt: ['Grizzly Bears', 4, 4] }],
  },
  {
    name: "Test of Faith's rider adopts the core prevention shield and turns what it prevents into +1/+1 counters", cr: '615.1',
    ruling: "One replacement effect printed as two sentences (CR 615.1). The shield half is the core `prevent-damage` op; `dealDamage` applies that core shield before the family fold runs (the core's shield-first policy under CR 616.1e, 9.1x item 5), so the rider adopts the counter as it resolves and turns what the shield prevents into +1/+1 counters.",
    seats: [{ bf: ['Grizzly Bears', 'Plains', 'Plains'], hand: ['Test of Faith'] }, { bf: ['Mountain'], hand: ['Shock'] }],
    script: [{ cast: 'Test of Faith', targets: [['Grizzly Bears']] }, { resolve: true }, { cast: 'Shock', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }],
    // Shock's 2 damage is prevented by the adopted 3-point shield, so exactly two +1/+1 counters are placed
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 2 }] }, { pt: ['Grizzly Bears', 4, 4] }, { zone: ['Grizzly Bears', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    name: "a rider does not adopt the prevention shield ANOTHER spell put on the creature it targets", cr: '615.1',
    ruling: "The rider is half of its own card's replacement effect (CR 615.1), so it may only take over the core shield the same resolution created. Divine Deflection's shield sentence is unparsed, so it has none — and Healing Salve's shield goes on protecting the creature both spells named.",
    seats: [{ bf: ['Grizzly Bears', 'Plains', 'Plains', 'Plains', 'Plains'], hand: ['Healing Salve', 'Divine Deflection'] }, { bf: ['Mountain', 'Mountain'], hand: ['Shock'] }],
    script: [{ cast: 'Healing Salve', modes: [1], targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Divine Deflection', x: 2, targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Shock', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }],
    // Healing Salve's 3-point shield absorbs Shock in full; a rider that had stolen it would have deleted it and
    // then dealt the 2 it "prevented" straight back into the 2/2 it was protecting
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { noLog: 'Divine Deflection deals' }, { life: [0, 20] }, { unsimulated: 2 }],
  },
  {
    name: 'a rider with no shield of any kind to attach to still reports the clause as unsimulated', cr: '615.1',
    ruling: 'The rider is a no-op on its own; rather than let the clause vanish it goes out through the engine\'s "skipped a clause" channel.',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, {}],
    scripts: {
      'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects: [{ op: 'prevent-rider', rider: { mode: 'gain-life' } }], text: 'replacement' }] },
    },
    script: [{ cast: 'Lightning Bolt' }, { resolve: true }],
    expect: [{ life: [0, 20] }, { unsimulated: 1 }],
  },
  {
    name: 'Furnace of Rath doubles the damage BEFORE a shield eats it, so 3 of the 6 still gets through', cr: '616.1',
    ruling: 'CR 614.1a modifications are applied before CR 615 prevention, which is the order this family fixes for a damage event (CR 616.1 would let the affected player choose).',
    seats: [{ bf: ['Furnace of Rath', 'Mountain', 'Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears', 'Plains', 'Plains'], hand: ['Test of Faith'] }],
    script: [{ cast: 'Test of Faith', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }, { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }],
    // 3 doubled to 6; the 3-point shield eats 3 and 3 is dealt (a shield read first would have absorbed all of it)
    expect: [{ log: 'deals 3 damage to Grizzly Bears' }, { counters: ['Grizzly Bears', { '+1/+1': 3 }] }, { pt: ['Grizzly Bears', 5, 5] }, { zone: ['Grizzly Bears', 'battlefield'] }],
  },
  {
    name: 'a shield whose rider deals the prevented damage to a chosen target hits that target', cr: '615.1',
    ruling: 'The rider effect chooses its own target when the spell is cast (CR 601.2c).',
    seats: [{ bf: ['Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant', 'Mountain'], hand: ['Shock'] }],
    scripts: {
      'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects: [
        { op: 'prevent', amount: 'next', to: { players: 'you' }, duration: 'eot' },
        { op: 'prevent-rider', rider: { mode: 'damage-targets' }, target: { kind: 'any' } },
      ], text: 'replacement' }] },
    },
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { cast: 'Shock', by: 1, targets: [['P0']] }, { resolve: true }, { sba: true }],
    // Shock's 2 damage to seat 0 is prevented and dealt to Hill Giant instead
    expect: [{ life: [0, 20] }, { zone: ['Hill Giant', 'battlefield'] }, { log: 'deals 2 damage to Hill Giant' }],
  },

  {
    name: "a shield does not prevent the damage its own rider deals to something it protects", cr: '614.5',
    ruling: 'The shield and its rider are one replacement effect (CR 615.1), and a replacement effect does not apply to the events it creates itself (CR 614.5) — without that, the rider prevents its own damage and the fold recurses forever.',
    seats: [{ bf: ['Grizzly Bears', 'Hill Giant', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Mountain'], hand: ['Shock'] }],
    scripts: {
      'Lightning Bolt': { mode: 'replace', abilities: [{ kind: 'spell', effects: [
        { op: 'prevent', amount: 'all', to: { filter: { types: ['Creature'] }, who: 'you' }, duration: 'eot' },
        { op: 'prevent-rider', rider: { mode: 'damage-targets' }, target: { kind: 'creature' } },
      ], text: 'replacement' }] },
    },
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { cast: 'Shock', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }],
    // Shock's 2 damage to the Bears is prevented (once); the 2 the rider deals to the Hill Giant the same shield
    // also covers is dealt, not prevented a second time
    expect: [{ zone: ['Grizzly Bears', 'battlefield'] }, { zone: ['Hill Giant', 'battlefield'] }, { log: 'deals 2 damage to Hill Giant' }, { events: { type: 'prevented', min: 1, max: 1 } }],
  },

  // ---------------------------------------------------------------- damage-cant-be-prevented / unpreventable-damage (CR 615.6)
  {
    name: "Flaring Pain switches prevention off: Cho-Manno's shield no longer saves it", cr: '615.6',
    ruling: 'A prevention effect simply does not apply while damage cannot be prevented.',
    seats: [{ bf: ['Cho-Manno, Revolutionary'] }, { bf: ['Mountain', 'Mountain', 'Mountain'], hand: ['Flaring Pain', 'Lightning Bolt'] }],
    script: [{ cast: 'Flaring Pain', by: 1 }, { resolve: true }, { cast: 'Lightning Bolt', by: 1, targets: [['Cho-Manno, Revolutionary']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Cho-Manno, Revolutionary', 'graveyard'] }, { unsimulated: 0 }],
  },
  {
    name: "Leyline of Punishment switches prevention off for an INSTANT's damage, not just a permanent's", cr: '615.6',
    ruling: 'CR 609.7: any object can be a source of damage, so "Damage can\'t be prevented" has to be read off a spell on the stack as well as off a permanent — which is the case the card is printed for.',
    seats: [{ bf: ['Cho-Manno, Revolutionary'] }, { bf: ['Leyline of Punishment', 'Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['Cho-Manno, Revolutionary']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Cho-Manno, Revolutionary', 'graveyard'] }, { events: { type: 'prevented', max: 0 } }],
  },
  {
    name: "Flaring Pain switches off a CORE prevention shield too (Healing Salve's)", cr: '615.6',
    ruling: 'The shield the core `prevent-damage` op parks on the creature lasts exactly this turn, and so does "damage can\'t be prevented this turn", so it is taken away rather than left to fire.',
    seats: [{ bf: ['Grizzly Bears', 'Plains', 'Plains'], hand: ['Healing Salve'] }, { bf: ['Mountain', 'Mountain', 'Mountain', 'Mountain'], hand: ['Flaring Pain', 'Lightning Bolt'] }],
    script: [{ cast: 'Healing Salve', modes: [1], targets: [['Grizzly Bears']] }, { resolve: true }, { cast: 'Flaring Pain', by: 1 }, { resolve: true }, { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { log: 'prevention shield does not apply' }, { unsimulated: 0 }],
  },
  {
    name: 'Flaring Pain switches off a Fog', cr: '615.6',
    ruling: "Fog is a prevention effect (CR 615.1); \"damage can't be prevented this turn\" means it simply does not apply.",
    seats: [{ bf: ['Hill Giant', 'Mountain', 'Mountain'], hand: ['Flaring Pain'] }, { bf: ['Forest'], hand: ['Fog'] }],
    script: [{ cast: 'Fog', by: 1 }, { resolve: true }, { cast: 'Flaring Pain' }, { resolve: true }, attackWith(['Hill Giant'])],
    expect: [{ life: [1, 17] }, { log: 'fog does not apply' }, { unsimulated: 0 }],
  },
  {
    name: 'Questing Beast makes every creature you control deal unpreventable combat damage', cr: '615.6',
    ruling: "The static speaks for combat damage dealt by any creature its controller controls, so Cho-Manno's own shield does not apply to it.",
    seats: [{ bf: ['Questing Beast', 'Hill Giant'] }, { bf: ['Cho-Manno, Revolutionary'] }],
    script: [attackWith(['Hill Giant'], [['Cho-Manno, Revolutionary', 'Hill Giant']])],
    // Cho-Manno (2/2) prevents all damage dealt to it - except that Questing Beast switches prevention off for it
    expect: [{ zone: ['Cho-Manno, Revolutionary', 'graveyard'] }, { zone: ['Hill Giant', 'battlefield'] }],
  },

  // ---------------------------------------------------------------- damage-replacement (CR 614.1a / 615.2)
  {
    name: 'Furnace of Rath doubles the damage every source deals', cr: '614.1a',
    seats: [{ bf: ['Furnace of Rath', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }],
    expect: [{ life: [1, 14] }, { unsimulated: 0 }],
  },
  {
    name: 'Embermaw Hellion adds 1 to the damage another red source you control deals — but not to its own', cr: '614.1a',
    ruling: '"Another" excludes the permanent whose ability it is (CR 109.5).',
    seats: [{ bf: ['Embermaw Hellion', 'Mountain'], hand: ['Lightning Bolt'] }, {}],
    script: [{ cast: 'Lightning Bolt', targets: [['P1']] }, { resolve: true }, attackWith(['Embermaw Hellion'])],
    // 3 + 1 from the bolt, then Embermaw Hellion's own 4 combat damage unmodified: 20 - 4 - 4 = 12
    expect: [{ life: [1, 12] }, { unsimulated: 0 }],
  },
  {
    name: 'Guardian Seraph prevents 1 of the damage an opponent\'s source would deal you', cr: '615.2',
    seats: [{ bf: ['Guardian Seraph'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['P0']] }, { resolve: true }],
    expect: [{ life: [0, 18] }, { events: { type: 'prevented', min: 1, max: 1 } }, { unsimulated: 0 }],
  },
  {
    name: "Soul-Scar Mage turns your sources' noncombat damage into -1/-1 counters", cr: '614.1a',
    ruling: 'The damage is replaced entirely: none is dealt, so nothing is marked and no lifelink or damage trigger sees it.',
    seats: [{ bf: ['Soul-Scar Mage', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Serra Angel'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Serra Angel']] }, { resolve: true }, { sba: true }],
    expect: [{ counters: ['Serra Angel', { '-1/-1': 3 }] }, { pt: ['Serra Angel', 1, 1] }, { zone: ['Serra Angel', 'battlefield'] }, { unsimulated: 0 }],
  },
  {
    name: 'a damage replacement with `instead: none` deletes the damage event entirely', cr: '614.1a',
    seats: [{ bf: ['Runeclaw Bear', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Hill Giant'] }],
    scripts: staticOn('Runeclaw Bear', { kind: 'damage-replacement', to: { filter: { types: ['Creature'] }, who: 'opponent' }, instead: { mode: 'none' } }),
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Hill Giant', 'battlefield'] }, { pt: ['Hill Giant', 3, 3] }, { log: 'the damage .* would deal is not dealt' }],
  },

  // ---------------------------------------------------------------- zone-replacement (CR 614.1a)
  {
    name: 'Possessed Skaab is exiled instead of dying', cr: '614.1a',
    seats: [{ bf: ['Possessed Skaab'] }, { bf: ['Mountain'], hand: ['Lightning Bolt'] }],
    script: [{ cast: 'Lightning Bolt', by: 1, targets: [['Possessed Skaab']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Possessed Skaab', 'exile'] }, { graveyardCount: [0, 0] }, { log: 'is put into the exile instead' }],
  },
  {
    name: "Stone of Erech exiles an opponent's dying creature but leaves your own in the graveyard", cr: '614.1a',
    ruling: 'The replacement is written with a controller restriction, so it must not answer for the controller\'s own creatures.',
    seats: [{ bf: ['Stone of Erech', 'Grizzly Bears', 'Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Shock'] }, { bf: ['Hill Giant'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Hill Giant']] }, { resolve: true }, { sba: true }, { cast: 'Shock', targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }],
    expect: [{ zone: ['Hill Giant', 'exile'] }, { zone: ['Grizzly Bears', 'graveyard'] }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- counter-replacement (CR 614.1c)
  {
    name: 'Corpsejack Menace doubles the +1/+1 counters put on your creatures, not on your opponent\'s', cr: '614.1c',
    seats: [{ bf: ['Corpsejack Menace', 'Grizzly Bears'] }, { bf: ['Hill Giant'] }],
    scripts: bears([{ op: 'counters', target: { kind: 'creature' }, counter: '+1/+1', amount: 1 }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ counters: ['Hill Giant', { '+1/+1': 1 }] }, { pt: ['Hill Giant', 4, 4] }],
  },
  {
    name: 'Corpsejack Menace doubles a +1/+1 counter put on a creature you control', cr: '614.1c',
    seats: [{ bf: ['Corpsejack Menace', 'Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: bears([{ op: 'counters', target: { kind: 'creature', controller: 'you' }, counter: '+1/+1', amount: 1 }]),
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ counters: ['Hill Giant', { '+1/+1': 2 }] }, { pt: ['Hill Giant', 5, 5] }],
  },
  {
    name: 'Benevolent Hydra adds one to every +1/+1 counter put on another creature you control', cr: '614.1c',
    ruling: 'The replacement excludes the Hydra itself, so the counter it removes as a cost is untouched.',
    seats: [{ bf: ['Benevolent Hydra', 'Grizzly Bears'], counters: { 'Benevolent Hydra': { '+1/+1': 3 } } }, {}],
    script: [{ activate: 'Benevolent Hydra', targets: [['Grizzly Bears']] }, { resolve: true }],
    expect: [{ counters: ['Grizzly Bears', { '+1/+1': 2 }] }, { pt: ['Grizzly Bears', 4, 4] }, { pt: ['Benevolent Hydra', 3, 3] }, { unsimulated: 0 }],
  },
  {
    name: "a counter replacement with `instead: none` stops the counter being put on at all", cr: '614.1c',
    seats: [{ bf: ['Runeclaw Bear', 'Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      ...bears([{ op: 'counters', target: { kind: 'creature', controller: 'you' }, counter: '+1/+1', amount: 2 }]),
      ...staticOn('Runeclaw Bear', { kind: 'counter-replacement', counter: '+1/+1', instead: { mode: 'none' } }),
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ counters: ['Hill Giant', { '+1/+1': 0 }] }, { pt: ['Hill Giant', 3, 3] }, { log: 'counters are not put on' }],
  },
  {
    name: 'a counter replacement with `instead: minus` reduces the counters put on', cr: '614.1c',
    seats: [{ bf: ['Runeclaw Bear', 'Grizzly Bears', 'Hill Giant'] }, {}],
    scripts: {
      ...bears([{ op: 'counters', target: { kind: 'creature', controller: 'you' }, counter: '-1/-1', amount: 2 }]),
      ...staticOn('Runeclaw Bear', { kind: 'counter-replacement', counter: '-1/-1', instead: { mode: 'minus', amount: 1 } }),
    },
    script: [{ activate: 'Grizzly Bears', targets: [['Hill Giant']] }, { resolve: true }],
    expect: [{ counters: ['Hill Giant', { '-1/-1': 1 }] }, { pt: ['Hill Giant', 2, 2] }],
  },

  // ---------------------------------------------------------------- cant-gain-life (CR 614.1b)
  {
    name: "Giant Cindermaw stops every player gaining life", cr: '614.1b',
    seats: [{ bf: ['Giant Cindermaw', 'Grizzly Bears'] }, { life: 20 }],
    scripts: bears([{ op: 'gain-life', amount: 4, who: 'you' }]),
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }],
    expect: [{ life: [0, 20] }, { log: "can't gain life" }, { unsimulated: 0 }],
  },
  {
    name: "Knight of Dusk's Shadow stops only its controller's opponents gaining life", cr: '614.1b',
    seats: [{ bf: ["Knight of Dusk's Shadow", 'Grizzly Bears'] }, { bf: ['Runeclaw Bear'] }],
    scripts: {
      ...bears([{ op: 'gain-life', amount: 3, who: 'you' }]),
      'Runeclaw Bear': { abilities: [{ kind: 'activated', cost: { tap: true }, effects: [{ op: 'gain-life', amount: 3, who: 'you' }], text: 'replacement' }] },
    },
    script: [{ activate: 'Grizzly Bears' }, { resolve: true }, { activate: 'Runeclaw Bear', by: 1 }, { resolve: true }],
    expect: [{ life: [0, 23] }, { life: [1, 20] }],
  },

  // ---------------------------------------------------------------- draw-replacement (CR 121.6 / 614.1)
  {
    name: 'Dragon Appeasement skips its controller\'s draw step but not their other draws', cr: '121.6',
    ruling: 'Only the draw taken as the draw step\'s turn-based action is replaced (CR 504.1).',
    seats: [{ bf: ['Dragon Appeasement', 'Island', 'Island', 'Island'], hand: ['Divination'] }, {}],
    step: 'upkeep',
    script: [{ passUntil: 'main1' }, { cast: 'Divination' }, { resolve: true }],
    // the draw step draws nothing; Divination still draws two (20 - 2 = 18 left)
    expect: [{ libraryCount: [0, 18] }, { handCount: [0, 2] }, { log: 'skips the draw' }, { unsimulated: 0 }],
  },
  {
    name: "Yawgmoth's Bargain draws during its controller's own draw step (only the turn-based draw is skipped)", cr: '504.1',
    ruling: '"Skip your draw step" replaces the draw the step takes as its turn-based action (CR 504.1), not every draw that happens while the step is going on — an ability activated in that step still draws.',
    seats: [{ bf: ["Yawgmoth's Bargain", 'Swamp', 'Swamp'] }, {}],
    step: 'upkeep',
    script: [{ passUntil: 'draw' }, { resolve: true }, { activate: "Yawgmoth's Bargain" }, { resolve: true }],
    // the turn-based draw is skipped; the 1-life activation in the same step draws its card
    expect: [{ handCount: [0, 1] }, { libraryCount: [0, 19] }, { life: [0, 19] }, { log: 'skips the draw' }],
  },
  {
    name: 'on the first turn, where the draw step draws nothing at all, an activated draw is still not skipped', cr: '504.1',
    ruling: "The starting player's first draw step takes no turn-based draw (CR 103.7a), so there is nothing for \"skip your draw step\" to replace; the family's `draw` step hook closes the window even though no draw event happened.",
    seats: [{ bf: ["Yawgmoth's Bargain", 'Swamp', 'Swamp'] }, {}],
    turn: 1, step: 'upkeep',
    script: [{ passUntil: 'draw' }, { resolve: true }, { activate: "Yawgmoth's Bargain" }, { resolve: true }],
    expect: [{ handCount: [0, 1] }, { libraryCount: [0, 19] }, { noLog: 'skips the draw' }],
  },
  {
    name: 'Thought Reflection draws two cards for every card you would draw', cr: '614.1',
    seats: [{ bf: ['Thought Reflection', 'Island', 'Island', 'Island'], hand: ['Divination'] }, {}],
    script: [{ cast: 'Divination' }, { resolve: true }],
    expect: [{ handCount: [0, 4] }, { libraryCount: [0, 16] }, { unsimulated: 0 }],
  },
  {
    name: 'two draw doublers each apply to the draws the other creates (four cards a draw)', cr: '614.5',
    ruling: 'CR 614.5: a replacement effect does not apply to the events it creates itself, but a different one still does — so the second doubler applies to each of the two draws the first made.',
    seats: [{ bf: ['Thought Reflection', "Alhammarret's Archive", 'Island', 'Island', 'Island'], hand: ['Divination'] }, {}],
    script: [{ cast: 'Divination' }, { resolve: true }],
    // Divination's two draws are doubled twice: 8 cards, 20 - 8 = 12 left
    expect: [{ handCount: [0, 8] }, { libraryCount: [0, 12] }, { unsimulated: 0 }],
  },
  {
    name: "an upkeep draw does not spend Teferi's Ageless Insight's draw-step exemption", cr: '614.1',
    ruling: '"The first one you draw in each of your draw steps" is decided by the draw step, not by the turn\'s draw count: the upkeep draw is doubled and the draw-step draw is still the exempt one.',
    seats: [{ bf: ["Teferi's Ageless Insight", 'Runeclaw Bear', 'Island', 'Island', 'Island'] }, {}],
    step: 'untap',
    scripts: {
      'Runeclaw Bear': { abilities: [{ kind: 'triggered', event: { on: 'upkeep', whose: 'your' }, effects: [{ op: 'draw', amount: 1, who: 'you' }], text: 'At the beginning of your upkeep, draw a card.' }] },
    },
    script: [{ passUntil: 'main1' }],
    // upkeep: 1 draw doubled to 2; draw step: the exempt turn-based draw, 1 card. 3 in hand, 20 - 3 = 17 left
    expect: [{ handCount: [0, 3] }, { libraryCount: [0, 17] }, { unsimulated: 0 }],
  },
  {
    name: "Teferi's Ageless Insight leaves the first draw of your draw step alone", cr: '614.1',
    ruling: 'The exception is written into the replacement, so the turn-based draw is a single card.',
    seats: [{ bf: ["Teferi's Ageless Insight", 'Island', 'Island', 'Island'], hand: ['Divination'] }, {}],
    step: 'upkeep',
    script: [{ passUntil: 'main1' }, { cast: 'Divination' }, { resolve: true }],
    // the draw step draws exactly 1; Divination's two draws become four: 20 - 1 - 4 = 15 left
    expect: [{ libraryCount: [0, 15] }, { handCount: [0, 5] }, { unsimulated: 0 }],
  },

  // ---------------------------------------------------------------- enters-untapped (CR 614.12)
  {
    name: 'Horizon Explorer makes a land that would enter tapped enter untapped instead', cr: '614.12',
    seats: [{ bf: ['Horizon Explorer'], hand: ['Azorius Guildgate'] }, {}],
    script: [{ playLand: 'Azorius Guildgate' }, { sba: true }],
    expect: [{ tapped: ['Azorius Guildgate', false] }, { log: 'enters untapped' }],
  },
  {
    name: "a land an opponent plays is unaffected by Horizon Explorer's `who: you`", cr: '614.12',
    seats: [{ bf: ['Horizon Explorer'] }, { hand: ['Azorius Guildgate'] }],
    active: 1,
    script: [{ playLand: 'Azorius Guildgate', by: 1 }, { sba: true }],
    expect: [{ tapped: ['Azorius Guildgate', true] }, { noLog: 'Azorius Guildgate enters untapped' }],
  },

  // ---------------------------------------------------------------- choose-type (as-enters, CR 614.12)
  {
    name: 'Multiversal Passage asks for a basic land type as it enters, then for the 2 life', cr: '614.12',
    ruling: 'Both halves are as-enters replacements applied in the order the card prints them.',
    seats: [{ hand: ['Multiversal Passage'] }, {}],
    script: [{ answer: 'Forest' }, { answer: true }, { playLand: 'Multiversal Passage' }],
    expect: [{ ext: ['Multiversal Passage', 'chosenLandType', 'Forest'] }, { tapped: ['Multiversal Passage', false] }, { life: [0, 18] }],
  },
  {
    name: 'Multiversal Passage enters tapped when its controller declines the 2 life', cr: '614.12',
    seats: [{ hand: ['Multiversal Passage'] }, {}],
    script: [{ answer: 'Island' }, { answer: false }, { playLand: 'Multiversal Passage' }],
    expect: [{ ext: ['Multiversal Passage', 'chosenLandType', 'Island'] }, { tapped: ['Multiversal Passage', true] }, { life: [0, 20] }],
  },
];
