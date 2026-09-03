// Race arithmetic: how many turns each side needs to deal lethal, unopposed and through the best simple blocks, and
// whether the opponent's swing back next turn is lethal. Exact under the stated assumptions (no tricks, no new cards).
import { canBlock, hasKeyword, isCreature, power } from '../engine/characteristics.js';
import { opponentOf, type GameObject, type GameState, type PlayerId } from '../engine/state.js';
import { nextId } from './hypergeom.js';
import type { Clock, Derivation, RaceReport } from './types.js';

/** Creatures that will be able to attack on their controller's next turn (summoning sickness and tapping wear off). */
function futureAttackers(s: GameState, p: PlayerId): GameObject[] {
  return s.players[p].battlefield.filter(o => isCreature(o) && !hasKeyword(s, o, 'defender') && !hasKeyword(s, o, 'cant attack') && power(s, o) > 0);
}

/** Damage that gets through when each blocker absorbs the biggest attacker it can block (trample excess ignored). */
export function damageThrough(s: GameState, attackers: GameObject[], blockers: GameObject[]): { through: number; blocked: number[] } {
  const sorted = [...attackers].sort((a, b) => power(s, b) - power(s, a));
  const free = [...blockers]; const blockedIds: number[] = []; let through = 0;
  for (const a of sorted) {
    const i = free.findIndex(b => canBlock(s, b, a));
    if (i >= 0) { free.splice(i, 1); blockedIds.push(a.id); } else through += power(s, a);
  }
  return { through, blocked: blockedIds };
}

function clock(life: number, dpt: number, label: string): Clock {
  const turns = dpt > 0 ? Math.ceil(life / dpt) : null;
  return { turns, damagePerTurn: dpt, text: turns === null ? `${label}: no damage` : `${label}: ${dpt} per turn, lethal in ${turns} turn${turns === 1 ? '' : 's'}` };
}

/** Would `attacker`'s creatures swinging next turn be lethal against `defender`'s currently untapped blockers? */
export function crackback(s: GameState, defender: PlayerId): { lethal: boolean; damageThrough: number; life: number; text: string } {
  const att = futureAttackers(s, opponentOf(defender));
  const blockers = s.players[defender].battlefield.filter(o => isCreature(o) && !o.tapped);
  const { through } = damageThrough(s, att, blockers);
  const life = s.players[defender].life;
  return { lethal: through >= life && through > 0, damageThrough: through, life, text: `${through} damage would get through ${blockers.length} untapped blocker${blockers.length === 1 ? '' : 's'} against ${life} life` };
}

export function raceReport(s: GameState, viewer: PlayerId): RaceReport {
  const opp = opponentOf(viewer);
  const side = (p: PlayerId) => {
    const att = futureAttackers(s, p); const def = opponentOf(p);
    const blockers = s.players[def].battlefield.filter(isCreature); // they untap before they need to block
    const dpt = att.reduce((a, o) => a + power(s, o), 0);
    const { through } = damageThrough(s, att, blockers);
    return { unopposed: clock(s.players[def].life, dpt, 'unopposed'), blocked: clock(s.players[def].life, through, 'through blocks') };
  };
  const mine = side(viewer), theirs = side(opp);
  const cb = crackback(s, viewer);
  const id = nextId('race');
  const assumptions = ['every creature attacks every turn with its current power', 'each blocker absorbs the largest attacker it can legally block; trample excess and combat tricks are ignored', 'no new creatures, removal or life gain'];
  const derivation: Derivation = {
    id, method: 'exact', title: 'Race clocks', formula: 'turns = ceil(life / damage per turn)',
    inputs: [{ name: 'my life', value: s.players[viewer].life }, { name: 'their life', value: s.players[opp].life }, { name: 'my power', value: mine.unopposed.damagePerTurn }, { name: 'their power', value: theirs.unopposed.damagePerTurn }],
    steps: [{ text: `me: ${mine.unopposed.text}; ${mine.blocked.text}` }, { text: `them: ${theirs.unopposed.text}; ${theirs.blocked.text}` }, { text: `crack-back: ${cb.text}`, value: cb.lethal ? 1 : 0 }],
    result: mine.blocked.turns ?? -1, assumptions,
  };
  return { viewer, mine, theirs, crackback: cb, method: 'exact', assumptions, derivationId: id, derivation };
}
