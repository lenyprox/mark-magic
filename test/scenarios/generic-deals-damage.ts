// generic-deals-damage (Phase 9.1p, src/cards/rules/generic-deals-damage.ts): the punisher trigger whose body says
// "~ deals N damage to that player".
//
// Every scenario here is on a PRINTED card of the construct, with no `scripts` override, so each one fails outright
// with the rule file reverted: without it the body is `{ op: 'unknown' }`, the card is not fully parsed, no damage is
// dealt and `{ unsimulated: 0 }` breaks.
//
// What the scenarios have to separate, and why each board is shaped the way it is:
//
//   * "that player" is ONE player — the player the trigger was about (CR 608.2, the ability reads the event that
//     caused it) — not "each opponent". A two-seat board cannot tell the two apart, so the first scenario runs three
//     seats and asserts the untouched opponent's life as hard as the damaged one's.
//   * it is DAMAGE from the source (CR 120.3), not life loss: the log line names the source, and a damage event fires.
//   * the source is the enchantment / creature, so the damage goes to the opponent and never to its controller.
import type { Scenario } from './dsl.js';

export const genericDealsDamage: Scenario[] = [
  {
    // Underworld Dreams: "Whenever an opponent draws a card, this enchantment deals 1 damage to that player."
    // Three seats: seat 1 takes its draw-step draw, so seat 1 — and only seat 1 — is dealt 1 damage.
    name: 'Underworld Dreams damages the opponent who drew, and only that opponent', cr: '608.2',
    ruling: 'The ability refers back to the player the triggering event was about; the other opponent drew nothing and is not dealt damage.',
    seats: [{ bf: ['Underworld Dreams'] }, {}, {}],
    script: [{ passUntil: 'draw' }, { resolve: true }],
    expect: [
      { life: [0, 20] }, { life: [1, 19] }, { life: [2, 20] },
      { log: 'Underworld Dreams deals 1 damage' },
      { events: { type: 'damage', min: 1, max: 1 } },
      { unsimulated: 0 },
    ],
  },
  {
    // Aether Sting: "Whenever an opponent casts a creature spell, this enchantment deals 1 damage to that player."
    // The trigger is about the caster, and the caster is the seat that loses the life.
    name: 'Aether Sting damages the opponent who cast the creature spell', cr: '120.3',
    ruling: 'Damage is dealt by the source named in the ability, so it is damage and not life loss, and it is dealt to the player who cast the spell.',
    active: 1,
    seats: [{ bf: ['Aether Sting'] }, { bf: ['Forest', 'Forest'], hand: ['Grizzly Bears'] }],
    script: [{ cast: 'Grizzly Bears', by: 1 }, { resolve: true }],
    expect: [
      { life: [0, 20] }, { life: [1, 19] },
      { zone: ['Grizzly Bears', 'battlefield'] },
      { log: 'Aether Sting deals 1 damage' },
      { unsimulated: 0 },
    ],
  },
  {
    // Shriek, Treblemaker: "Whenever a creature an opponent controls dies, this creature deals 1 damage to that
    // player." Here "that player" is the controller of the dead creature, which the engine carries as the trigger's
    // player — the same `that-player` word, a different event.
    name: "Shriek, Treblemaker damages the controller of the opponent's creature that died", cr: '603.10',
    ruling: 'A leaves-the-battlefield trigger looks back in time: the player it is about is the one who controlled the creature as it died.',
    seats: [{ bf: ['Shriek, Treblemaker', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
    script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }, { sba: true }, { resolve: true }],
    expect: [
      { life: [0, 20] }, { life: [1, 19] },
      { zone: ['Grizzly Bears', 'graveyard'] },
      { log: 'Shriek, Treblemaker deals 1 damage' },
      { unsimulated: 0 },
    ],
  },
];
