// Behavioural scenarios for the generic-when-enchanted-dies parser family (Phase 9.1p).
//
// The family registers exactly one rule kind — a `TriggerRule` for the head "When enchanted creature dies" — so what
// there is to prove is that the head really fires, on printed Auras, and that it fires for the creature THIS Aura
// enchants and no other. Every one of these fails with src/cards/rules/generic-when-enchanted-dies.ts reverted: the
// head is then `{ on: 'unknown' }`, the ability never triggers, and nothing on the board moves — checked by moving the
// rule file aside, regenerating the registry and re-running this suite (all four fail; 13 families instead of 14). A
// scenario in which nothing was meant to happen anyway cannot carry that, which is why the last one below kills BOTH
// creatures and counts the cards: the count fails on a reverted rule and on a widened filter alike.
//
// Written from the printed cards and the rules (test/scenarios/README.md): the Aura is cast on a creature, the
// creature is killed with a Lightning Bolt, and the expectations are the ones the card text promises.
import type { Scenario } from './dsl.js';

export const genericWhenEnchantedDies: Scenario[] = [
  {
    // Bequeathal: "Enchant creature / When enchanted creature dies, you draw two cards."
    // CR 700.4 defines "dies"; CR 603.10a is why the Aura's trigger still sees the creature it enchanted even though
    // the Aura is itself on its way to the graveyard (CR 704.5m) by the time the trigger is put on the stack.
    name: 'Bequeathal draws two cards when the creature it enchants dies', cr: '700.4',
    ruling: 'A permanent "dies" when it is put into a graveyard from the battlefield; the Aura\'s leave-the-battlefield trigger looks back at the game state before the event, so it sees the creature it was attached to.',
    seats: [
      { bf: ['Forest', 'Grizzly Bears'], hand: ['Bequeathal'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [
      { cast: 'Bequeathal', targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] }, { resolve: true },
    ],
    expect: [
      { zone: ['Grizzly Bears', 'graveyard'] },
      { zone: ['Bequeathal', 'graveyard'] },            // CR 704.5m: an Aura attached to nothing is put into its owner's graveyard
      { handCount: [0, 2] },
      { libraryCount: [0, 18] },
      { unsimulated: 0 },
    ],
  },
  {
    // Demonic Vigor: "Enchanted creature gets +1/+1. / When enchanted creature dies, return that card to its owner's
    // hand." "That card" is the object the trigger was about — the creature that died — not the Aura (CR 608.2f).
    name: "Demonic Vigor returns the dead creature's card to its owner's hand", cr: '603.10a',
    ruling: '"That card" in the trigger\'s effect is the creature the ability triggered on, found in the graveyard it was put into.',
    seats: [
      { bf: ['Swamp', 'Grizzly Bears'], hand: ['Demonic Vigor'] },
      { bf: ['Mountain'], hand: ['Lightning Bolt'] },
    ],
    script: [
      { cast: 'Demonic Vigor', targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] }, { resolve: true },
    ],
    expect: [
      { zone: ['Grizzly Bears', 'hand'] },
      { zone: ['Demonic Vigor', 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    // Minion's Return: "Enchant creature / When enchanted creature dies, return that card to the battlefield under
    // your control." The Aura may enchant a creature an opponent controls — which is why the trigger head carries no
    // controller restriction at all (`controller: 'any'`).
    name: "Minion's Return reanimates an opponent's creature under its controller's control", cr: '303.4a',
    ruling: '"Enchanted creature" is the permanent the Aura is attached to, whoever controls it; the returning effect puts the card onto the battlefield under the Aura controller\'s control.',
    seats: [
      { bf: ['Swamp', 'Swamp', 'Swamp', 'Mountain'], hand: ["Minion's Return", 'Lightning Bolt'] },
      { bf: ['Grizzly Bears'] },
    ],
    script: [
      { cast: "Minion's Return", targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true },
    ],
    expect: [
      { zone: ['Grizzly Bears', 'battlefield'] },
      { control: ['Grizzly Bears', 0] },
      { zone: ["Minion's Return", 'graveyard'] },
      { unsimulated: 0 },
    ],
  },
  {
    // The other half of the claim: `attachedToSource` means THIS Aura's host, not "a creature". Two creatures die in
    // one script — first the one Bequeathal does NOT enchant, then the one it does — and the seat ends with exactly
    // two cards drawn. That single number pins the filter in both directions, which a script that only kills the
    // bystander cannot do (with the rule reverted the head is { on: 'unknown' } and *nothing* is drawn either way, so
    // a bystander-only script is a pure negative control that passes without the rule):
    //   - rule reverted, no trigger at all  -> 0 cards, fails;
    //   - filter widened to any creature    -> Hill Giant's death draws too, 4 cards, fails;
    //   - filter as claimed                 -> only the Grizzly Bears death draws, 2 cards.
    name: 'Bequeathal draws only for the creature it enchants, not for one dying beside it', cr: '303.4a',
    ruling: '"Enchanted creature" refers only to the permanent this Aura is attached to, so a second creature dying under the same controller triggers nothing.',
    seats: [
      { bf: ['Forest', 'Grizzly Bears', 'Hill Giant'], hand: ['Bequeathal'] },
      { bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt', 'Lightning Bolt'] },
    ],
    script: [
      { cast: 'Bequeathal', targets: [['Grizzly Bears']] }, { resolve: true },
      { cast: 'Lightning Bolt', by: 1, targets: [['Hill Giant']] }, { resolve: true },       // not enchanted: no trigger
      { cast: 'Lightning Bolt', by: 1, targets: [['Grizzly Bears']] }, { resolve: true },    // enchanted: draws two
    ],
    expect: [
      { zone: ['Hill Giant', 'graveyard'] },
      { zone: ['Grizzly Bears', 'graveyard'] },
      { zone: ['Bequeathal', 'graveyard'] },            // CR 704.5m, once its host has gone
      { handCount: [0, 2] },                            // two, not four: Hill Giant's death drew nothing
      { libraryCount: [0, 18] },
      { unsimulated: 0 },
    ],
  },
];
