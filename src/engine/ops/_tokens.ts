// Built-in abilities of the predefined tokens (Treasure, Eldrazi Spawn, Clue, Food). These used to be hardcoded in
// `Game.activateAbility` and `legalActions`; they now live in the `TOKEN_ABILITIES` registry so a family can add a
// token (Blood, Map, Powerstone, ...) without touching either. The leading underscore keeps the file out of the
// generated barrel's family scan; `_registry.ts` seeds `TOKEN_ABILITIES` from `BUILTIN_TOKEN_ABILITIES`.
//
// Behaviour is byte-identical to the hardcoded versions: same negative ability indexes, same labels, same order.
import type { ManaCost, ManaSymbol } from '../../cards/types.js';
import type { GameObject, TokenAbility } from './types.js';

/** {2} — Clue and Food both cost exactly this; a fresh object per call, as the hardcoded versions built one. */
function two(): ManaCost { return { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' }; }

export const BUILTIN_TOKEN_ABILITIES: Record<string, TokenAbility> = {
  // Treasure: {T}, Sacrifice: add one mana of any colour.
  Treasure: {
    index: -1, flag: 'treasure',
    legal: (_g, _p, o) => o.tapped ? null : { action: { type: 'activate', objectId: o.id, abilityIndex: -1 }, label: 'sacrifice Treasure for mana' },
    async activate(g, p, o) {
      const color = (await g.ask(p, { kind: 'choose-color', reason: 'Treasure' })) as ManaSymbol;
      g.addMana(p, [color], 'Treasure'); g.moveTo(o, 'graveyard', 'top', 'sacrifice'); return true;
    },
  },
  // Eldrazi Spawn and friends: "Sacrifice this token: add {C}". The mana solver taps it directly (mana.ts), so it
  // surfaces no explicit legal action — exactly as before.
  Spawn: {
    index: -1, flag: 'spawn',
    legal: () => null,
    async activate(g, p, o) { g.addMana(p, ['C'], o.token?.name ?? 'token'); g.moveTo(o, 'graveyard', 'top', 'sacrifice'); return true; },
  },
  // Clue: {2}, Sacrifice: draw a card.
  Clue: {
    index: -6, flag: 'clue',
    legal: (g, p, o) => g.findPayment(g.state.players[p], two()) ? { action: { type: 'activate', objectId: o.id, abilityIndex: -6 }, label: 'sacrifice Clue: draw a card', manaValue: 2 } : null,
    async activate(g, p, o) {
      const pl = g.state.players[p];
      const pay = g.findPayment(pl, two()); if (!pay) return false; g.payMana(pl, pay);
      g.sacrifice(o);
      const item = g.makeStackItem('ability', o, p, [{ op: 'draw', amount: 1, who: 'you' }], 'Clue: draw a card', 0, undefined, '{2}, Sacrifice: Draw a card.');
      g.state.stack.push(item);
      g.emit({ type: 'activate', itemId: item.id, id: o.id, name: 'Clue', player: p, ability: 'draw a card', targets: [] }, `${g.pname(p)} sacrifices a Clue.`);
      return true;
    },
  },
  // Food: {2}, {T}, Sacrifice: you gain 3 life.
  Food: {
    index: -7, flag: 'food',
    legal: (g, p, o) => !o.tapped && g.findPayment(g.state.players[p], two()) ? { action: { type: 'activate', objectId: o.id, abilityIndex: -7 }, label: 'sacrifice Food: gain 3 life', manaValue: 2 } : null,
    async activate(g, p, o) {
      if (o.tapped) return false;
      const pl = g.state.players[p];
      const pay = g.findPayment(pl, two()); if (!pay) return false; g.payMana(pl, pay);
      g.setTapped(o, true, 'cost'); g.sacrifice(o);
      const item = g.makeStackItem('ability', o, p, [{ op: 'gain-life', amount: 3, who: 'you' }], 'Food: gain 3 life', 0, undefined, '{2}, {T}, Sacrifice: You gain 3 life.');
      g.state.stack.push(item);
      g.emit({ type: 'activate', itemId: item.id, id: o.id, name: 'Food', player: p, ability: 'gain 3 life', targets: [] }, `${g.pname(p)} sacrifices a Food.`);
      return true;
    },
  },
};

/** One registered token ability with the token name it was registered under. */
export interface TokenAbilityEntry { name: string; ab: TokenAbility }

/**
 * The token ability of `o`, or undefined. A family token names its entry in `o.ext.tokenAbility` (no core `TokenSpec`
 * flag needed); the four built-ins are matched on their `TokenSpec` flag, exactly as the hardcoded checks were.
 */
export function tokenAbilityIn(entries: TokenAbilityEntry[], o: GameObject): TokenAbility | undefined {
  const tok = o.token; if (tok === null) return undefined;
  const ext = o.ext;
  if (ext !== undefined && typeof ext.tokenAbility === 'string') { const named = ext.tokenAbility; for (const e of entries) if (e.name === named) return e.ab; }
  for (const e of entries) if (e.ab.flag !== undefined && (tok as unknown as Record<string, unknown>)[e.ab.flag] === true) return e.ab;
  return undefined;
}
