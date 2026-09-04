// Spell costs beyond a single mana cost: alternative costs (pitch, evoke, flashback, ...), cost adjustments
// (Thalia taxes, affinity, domain), delve / convoke / improvise contributions and the non-mana cost checks shared by
// activated abilities and spells. Pure helpers; paying happens in Game.
import type { AbilityCost, AltCost, CardDef, ManaCost, ManaSymbol } from '../cards/types.js';
import { abilitiesOf, colors, evalAmount, isCreature, isType, matchesFilter, power } from './characteristics.js';
import type { ManaSource } from './mana.js';
import type { CastZone, GameObject, GameState, Player, PlayerId } from './state.js';

export const ZERO_COST: ManaCost = { generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '' };

/** Whether an exiled card's cast-from-exile window (warp, rebound) is open for player p right now. */
export function exileWindowOpen(s: GameState, p: PlayerId, w: NonNullable<GameObject['castableFromExile']>): boolean {
  if (s.turn <= w.afterTurn) return false;
  if (w.untilTurn !== undefined && s.turn > w.untilTurn) return false;
  if (w.by !== undefined && w.by !== p) return false;
  if (w.free) return s.activePlayer === p && s.step === 'upkeep' && (w.upkeepOnly === undefined || w.upkeepOnly === p);
  return true;
}

/** Net generic-mana reduction for casting `card` (positive = cheaper): cost-adjust statics on both battlefields plus the card's own reduce modifiers. */
export function costAdjust(s: GameState, p: PlayerId, card: GameObject, from: CastZone = 'hand'): number {
  let r = 0;
  for (const pl of s.players) for (const o of pl.battlefield) for (const ab of abilitiesOf(o)) {
    if (ab.kind !== 'static' || ab.effect.kind !== 'cost-adjust') continue;
    const e = ab.effect; const mine = o.controller === p;
    if (e.who === 'you' && !mine) continue;
    if (e.who === 'opponent' && mine) continue;
    if (e.from === 'non-hand' && from === 'hand') continue;
    if (!matchesFilter(s, card, e.filter, o)) continue;
    r += e.amount;
  }
  for (const m of card.def.costModifiers ?? []) if (m.kind === 'reduce') r += evalAmount(s, m.amount, p, 0, card);
  return r;
}

/** The mana cost actually paid for a cast: the alternative cost's mana (or nothing) instead of the printed cost, plus kicker. */
export function spellManaCost(def: CardDef, alt?: AltCost, kicked?: boolean): ManaCost {
  const base = alt ? (alt.cost.mana ?? ZERO_COST) : (def.manaCost ?? ZERO_COST);
  if (!kicked || !def.kicker) return base;
  const k = def.kicker;
  return { ...base, generic: base.generic + k.generic, pips: [...base.pips, ...k.pips], hybrid: [...base.hybrid, ...k.hybrid], phyrexian: [...base.phyrexian, ...k.phyrexian] };
}

export function hasModifier(def: CardDef, kind: 'delve' | 'convoke' | 'improvise'): boolean { return !!def.costModifiers?.some(m => m.kind === kind); }

/** Convoke / improvise: creatures (any, even summoning sick) and non-creature artifacts the caster may tap as mana. Excludes objects that already are mana sources. */
export function extraManaSources(s: GameState, pl: Player, def: CardDef, regular: ManaSource[]): ManaSource[] {
  const out: ManaSource[] = [];
  const taken = new Set(regular.map(r => r.obj.id));
  if (hasModifier(def, 'convoke')) for (const o of pl.battlefield) {
    if (o.tapped || !isCreature(o) || taken.has(o.id)) continue;
    out.push({ obj: o, abilityIndex: -4, options: [['C'], ...colors(o).map(c => [c] as ManaSymbol[])] });
  }
  if (hasModifier(def, 'improvise')) for (const o of pl.battlefield) {
    if (o.tapped || isCreature(o) || !isType(o, 'Artifact') || taken.has(o.id)) continue;
    out.push({ obj: o, abilityIndex: -5, options: [['C']] });
  }
  return out;
}

/** Graveyard cards to exile for delve, most expendable first (or the ones the card wants to count, e.g. Murktide's instants and sorceries). */
export function pickDelve(s: GameState, pl: Player, card: GameObject, n: number): number[] {
  if (n <= 0) return [];
  const wants = card.def.asEnters?.find(a => a.kind === 'counters' && typeof a.amount === 'object' && a.amount.count === 'exiled-with');
  const wantFilter = wants && wants.kind === 'counters' && typeof wants.amount === 'object' ? wants.amount.filter : undefined;
  const value = (o: GameObject) => (wantFilter && matchesFilter(s, o, wantFilter, card) ? -100 : 0) + (isType(o, 'Land') ? 0 : o.def.manaValue) + (o.def.altCosts?.some(a => a.from === 'graveyard') ? 50 : 0);
  return [...pl.graveyard].filter(o => o.id !== card.id).sort((a, b) => value(a) - value(b)).slice(0, n).map(o => o.id);
}

/** Whether the non-mana parts of a cost can be paid right now. `self` is the object being cast/activated (excluded from "other" choices). */
export function nonManaCostPayable(s: GameState, pl: Player, cost: AbilityCost, self: GameObject): boolean {
  if (cost.energy && (pl.energy ?? 0) < cost.energy) return false;
  const others = (zone: GameObject[]) => zone.filter(o => o.id !== self.id);
  if (cost.sacrifice && !pl.battlefield.some(o => o.id !== self.id && matchesFilter(s, o, cost.sacrifice, self))) return false;
  if (cost.discard && others(pl.hand).length < cost.discard) return false;
  if (cost.payLife && pl.life <= cost.payLife) return false;
  if (cost.removeCounters && (self.counters[cost.removeCounters.counter] ?? 0) < cost.removeCounters.amount) return false;
  if (cost.exileFromGraveyard && others(pl.graveyard).length < cost.exileFromGraveyard) return false;
  if (cost.exileOtherFromGraveyard) {
    const gy = others(pl.graveyard);
    if (cost.exileOtherFromGraveyard.count !== 'any' && gy.length < cost.exileOtherFromGraveyard.count) return false;
    if (cost.exileOtherFromGraveyard.minCardTypes && new Set(gy.flatMap(o => o.def.types.filter(t => t !== 'Kindred' && t !== 'Tribal'))).size < cost.exileOtherFromGraveyard.minCardTypes) return false;
  }
  if (cost.exileFromHand && others(pl.hand).filter(o => matchesFilter(s, o, cost.exileFromHand!.filter, self)).length < cost.exileFromHand.count) return false;
  if (cost.returnToHand && !pl.battlefield.some(o => matchesFilter(s, o, cost.returnToHand, self))) return false;
  if (cost.tapUntappedCreature && !pl.battlefield.some(o => !o.tapped && matchesFilter(s, o, cost.tapUntappedCreature, self))) return false;
  if (cost.tapCreaturesTotalPower) {
    const crew = pl.battlefield.filter(o => !o.tapped && isCreature(o) && (!cost.tapCreaturesTotalPower!.other || o.id !== self.id));
    if (crew.reduce((a, o) => a + Math.max(0, power(s, o)), 0) < cost.tapCreaturesTotalPower.power) return false;
  }
  return true;
}

/** Smallest set of untapped creatures whose total power reaches `need` (fewest creatures, then least total power wasted). */
export function pickCrew(s: GameState, pl: Player, self: GameObject, need: number, other: boolean): GameObject[] | null {
  const pool = pl.battlefield.filter(o => !o.tapped && isCreature(o) && (!other || o.id !== self.id)).map(o => ({ o, p: Math.max(0, power(s, o)) })).sort((a, b) => b.p - a.p);
  // greedy: biggest first until enough, then drop any creature that is not needed
  const chosen: { o: GameObject; p: number }[] = []; let total = 0;
  for (const c of pool) { if (total >= need) break; chosen.push(c); total += c.p; }
  if (total < need) return null;
  for (let i = chosen.length - 1; i >= 0; i--) if (total - chosen[i].p >= need) { total -= chosen[i].p; chosen.splice(i, 1); }
  return chosen.map(c => c.o);
}

/** Smallest subset of `gy` covering `minTypes` distinct card types (Escape). Greedy by rarest type first; null when impossible. */
export function pickEscapeExile(gy: GameObject[], count: number | 'any', minTypes: number | undefined): number[] | null {
  const typesOf = (o: GameObject) => o.def.types.filter(t => t !== 'Kindred' && t !== 'Tribal');
  if (count !== 'any') { if (gy.length < count) return null; return gy.slice(0, count).map(o => o.id); }
  if (!minTypes) return [];
  const chosen: GameObject[] = []; const covered = new Set<string>();
  const rest = [...gy];
  while (covered.size < minTypes) {
    let best: GameObject | null = null, gain = 0;
    for (const o of rest) { const g = typesOf(o).filter(t => !covered.has(t)).length; if (g > gain) { gain = g; best = o; } }
    if (!best) return null;
    chosen.push(best); for (const t of typesOf(best)) covered.add(t); rest.splice(rest.indexOf(best), 1);
  }
  return chosen.map(o => o.id);
}
