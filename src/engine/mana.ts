// Mana: what a player can produce, whether a cost is payable, and how to pay it (auto-tapping).
import type { ManaCost, ManaSymbol, Filter } from '../cards/types.js';
import type { GameObject, GameState, Player, PlayerId } from './state.js';
import { abilitiesOf, colors, conditionHolds, evalAmount, findObject, hasKeyword, isCreature, isLand, matchesFilter } from './characteristics.js';
import { opponentsOf } from './players.js';

export interface ManaSource { obj: GameObject; abilityIndex: number; options: ManaSymbol[][] } // each option = the mana produced

const ALL: ManaSymbol[] = ['W', 'U', 'B', 'R', 'G'];

export interface ManaSourceOptions {
  /** The spell being paid for: restricted sources (Cavern of Souls) only count when it qualifies. */
  forSpell?: GameObject;
  /** Extra sources (convoke creatures, improvise artifacts). */
  extraSources?: ManaSource[];
  /** Try the extra sources before real mana (the "max convoke" plan). */
  extrasFirst?: boolean;
  /** Only these permanents (by id) may be tapped (manual payment); the mana pool is always usable. */
  onlyIds?: number[];
  /** Tap these permanents first when several plans tie (manual preference). */
  preferIds?: number[];
}

/** Untapped permanents with usable mana abilities. */
export function manaSources(s: GameState, p: Player, opts: ManaSourceOptions = {}): ManaSource[] {
  const out: ManaSource[] = [];
  const spell = opts.forSpell;
  for (const o of p.battlefield) {
    if (o.tapped) continue;
    if (isCreature(o) && o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste')) continue; // summoning sick creatures can't {T}
    if (o.token?.treasure) { out.push({ obj: o, abilityIndex: -1, options: ALL.map(c => [c]) }); continue; }
    if (o.token?.spawn) { out.push({ obj: o, abilityIndex: -1, options: [['C']] }); continue; }
    abilitiesOf(o).forEach((ab, i) => {
      if (ab.kind !== 'activated' || !ab.manaAbility || !ab.cost.tap || ab.cost.mana || ab.cost.sacrificeSelf || ab.cost.discardHand) return;
      if (ab.activateOnlyIf && !conditionHolds(s, o, ab.activateOnlyIf)) return;
      const options: ManaSymbol[][] = [];
      for (const e of ab.effects) {
        if (e.op !== 'add-mana') continue;
        if (e.restriction) {
          if (!spell) continue;
          if ((e.restriction === 'creature-spell' || e.restriction === 'chosen-type-creature') && !spell.def.types.includes('Creature')) continue;
          if (e.restriction === 'instant-sorcery' && !spell.def.types.includes('Instant') && !spell.def.types.includes('Sorcery')) continue;
          if (e.restriction === 'colorless-eldrazi' && (spell.def.colors.length || !spell.def.subtypes.includes('Eldrazi'))) continue;
        }
        const per = e.perEach ? evalAmount(s, e.perEach, o.controller, 0, o) : 1;
        if (per <= 0) continue;
        const rep = (m: ManaSymbol[]): ManaSymbol[] => per === 1 ? m : Array.from({ length: per }, () => m).flat();
        if (e.altIf && conditionHolds(s, o, e.altIf.condition)) options.push(e.altIf.mana);
        else if (e.mana === 'commander-identity') { const cs = commanderIdentity(s, o.controller); if (cs.length) options.push(...cs.map(c => rep([c]))); }
        else if (e.mana === 'opponent-lands') { const cs = opponentLandColors(s, o.controller); if (cs.length) options.push(...cs.map(c => rep([c]))); }
        else if (Array.isArray(e.mana)) options.push(rep(e.mana));
        else if (e.mana === 'any') options.push(...ALL.map(c => rep(Array(e.amount ?? 1).fill(c))));
        else if (e.mana === 'any-one') {
          const opts = e.options === 'exiled-with-colors' ? exiledColors(s, o) : e.options === 'chosen-color' ? (o.chosen?.color ? [o.chosen.color] : ALL) : e.options === 'permanent-colors' ? ALL.filter(c => p.battlefield.some(x => (colors(x) as string[]).includes(c))) : e.options;
          options.push(...(opts ?? ALL).map(c => rep(Array(e.amount ?? 1).fill(c))));
        }
      }
      if (options.length) out.push({ obj: o, abilityIndex: i, options: withExtraMana(s, p, o, options) });
    });
  }
  return out;
}

/** Colours in the union of the player's commanders' colour identities (Command Tower, Arcane Signet). */
export function commanderIdentity(s: GameState, p: PlayerId): ManaSymbol[] {
  const cs = new Set<ManaSymbol>();
  for (const id of s.players[p].commanders ?? []) { const c = findObject(s, id); if (!c) continue; for (const x of c.def.colorIdentity ?? c.def.colors) cs.add(x); }
  return ALL.filter(c => cs.has(c));
}
/** Colours a land an opponent controls could produce (Exotic Orchard, Fellwar Stone). */
function opponentLandColors(s: GameState, p: PlayerId): ManaSymbol[] {
  const cs = new Set<ManaSymbol>();
  for (const q of opponentsOf(s, p)) for (const l of s.players[q].battlefield) {
    if (!isLand(l)) continue;
    for (const ab of abilitiesOf(l)) { if (ab.kind !== 'activated' || !ab.manaAbility) continue; for (const e of ab.effects) { if (e.op !== 'add-mana') continue; if (Array.isArray(e.mana)) e.mana.forEach(m => { if (m !== 'C') cs.add(m); }); else if (e.mana === 'any' || e.mana === 'any-one') ALL.forEach(m => cs.add(m)); else if (e.mana === 'commander-identity') commanderIdentity(s, q).forEach(m => cs.add(m)); } }
  }
  return ALL.filter(c => cs.has(c));
}
/** "Whenever you tap a Forest for mana, add an additional {G}" — every option of a matching source grows by the extra mana. */
function withExtraMana(s: GameState, p: Player, o: GameObject, options: ManaSymbol[][]): ManaSymbol[][] {
  let extra: ManaSymbol[] = [];
  for (const src of p.battlefield) for (const ab of abilitiesOf(src)) {
    if (ab.kind !== 'static' || ab.effect.kind !== 'extra-mana-on-tap') continue;
    const e = ab.effect;
    const hit = e.enchanted ? src.attachedTo === o.id : matchesFilter(s, o, e.filter, src);
    if (!hit) continue;
    extra = extra.concat(e.mana === 'chosen-color' ? [src.chosen?.color ?? 'G'] : e.mana);
  }
  return extra.length ? options.map(opt => [...opt, ...extra]) : options;
}

function exiledColors(s: GameState, o: GameObject): ManaSymbol[] {
  const cs = new Set<ManaSymbol>();
  for (const id of o.exiledWith ?? []) { const x = findObject(s, id); if (x) for (const c of colors(x)) cs.add(c); }
  return [...cs];
}

export interface Payment { pool: ManaSymbol[]; taps: { source: ManaSource; option: ManaSymbol[] }[] }

/** Default cap on source-option combinations tried by `findPayment`; rollouts pass `FAST_MANA_LIMIT` (see GameOptions.fastMana). */
export const MANA_COMBO_LIMIT = 5000;
export const FAST_MANA_LIMIT = 48;

/** Try to pay `cost` from the pool plus untapped sources. Returns the plan or null. Generic {X} is given via `x`. */
export function findPayment(s: GameState, p: Player, cost: ManaCost, x = 0, reduction = 0, limit = MANA_COMBO_LIMIT, opts: ManaSourceOptions = {}): Payment | null {
  const generic = Math.max(0, cost.generic + cost.x * x - reduction);
  const needPips: ManaSymbol[] = [...cost.pips];
  const hybrid = cost.hybrid.map(h => h);
  const phyrexian = [...cost.phyrexian]; // paid with life if no mana of that colour
  let regular = manaSources(s, p, opts);
  if (opts.onlyIds) { const only = new Set(opts.onlyIds); regular = regular.filter(r => only.has(r.obj.id)); }
  if (opts.preferIds?.length) { const pref = new Set(opts.preferIds); regular = [...regular.filter(r => pref.has(r.obj.id)), ...regular.filter(r => !pref.has(r.obj.id))]; }
  const extras = opts.extraSources ?? [];
  const sources = extras.length ? (opts.extrasFirst ? [...extras, ...regular] : [...regular, ...extras]) : regular;
  // Enumerate: small search over source options (branching kept low by trying the most-constrained pips first).
  const pool = [...p.manaPool, ...(p.stickyMana ?? [])];
  const best = solve(pool, sources, needPips, hybrid, phyrexian, generic, limit);
  return best;
}

function solve(pool: ManaSymbol[], sources: ManaSource[], pips: ManaSymbol[], hybrid: ManaSymbol[][], phyrexian: ManaSymbol[], generic: number, limit: number): Payment | null {
  // Greedy + backtracking: assign coloured pips first from pool, then sources; then hybrid; then generic.
  const avail: { mana: ManaSymbol; from: 'pool' | number; option?: ManaSymbol[] }[] = pool.map(m => ({ mana: m, from: 'pool' as const }));
  // choose one option per source; try all combos up to a limit (sources are few in practice)
  const combos = enumerateSourceCombos(sources, limit);
  let bestPlan: Payment | null = null;
  for (const combo of combos) {
    const units = [...avail];
    combo.forEach((opt, i) => { for (const m of opt) units.push({ mana: m, from: i, option: opt }); });
    const used = new Array(units.length).fill(false);
    const takeColor = (c: ManaSymbol): boolean => { const i = units.findIndex((u, k) => !used[k] && u.mana === c); if (i < 0) return false; used[i] = true; return true; };
    let ok = true;
    for (const c of pips) if (!takeColor(c)) { ok = false; break; }
    if (!ok) continue;
    for (const h of hybrid) {
      // h like ['W','U'] or ['W','C'] where 'C' means "2 generic" (Reaper King style)
      let done = false;
      for (const c of h) if (c !== 'C' && takeColor(c)) { done = true; break; }
      if (!done) { if (h.includes('C')) { const free = units.filter((_, k) => !used[k]).length; if (free >= 2) { let n = 0; units.forEach((_, k) => { if (n < 2 && !used[k]) { used[k] = true; n++; } }); done = true; } } }
      if (!done) { ok = false; break; }
    }
    if (!ok) continue;
    for (const c of phyrexian) takeColor(c); // else 2 life (handled by caller via life check; we allow)
    let free = units.filter((_, k) => !used[k]).length;
    if (free < generic) continue;
    // mark generic from units, preferring colourless and duplicates
    let g = generic;
    units.forEach((u, k) => { if (g > 0 && !used[k] && u.mana === 'C') { used[k] = true; g--; } });
    units.forEach((_, k) => { if (g > 0 && !used[k]) { used[k] = true; g--; } });
    // Build plan: which sources are actually needed (a source whose units are all unused need not be tapped)
    const taps: Payment['taps'] = [];
    combo.forEach((opt, i) => { const anyUsed = units.some((u, k) => used[k] && u.from === i); if (anyUsed) taps.push({ source: sources[i], option: opt }); });
    const plan: Payment = { pool: units.filter((u, k) => used[k] && u.from === 'pool').map(u => u.mana), taps };
    if (!bestPlan || plan.taps.length < bestPlan.taps.length) bestPlan = plan;
    if (plan.taps.length === 0) break;
  }
  return bestPlan;
}

function enumerateSourceCombos(sources: ManaSource[], limit: number): ManaSymbol[][][] {
  let combos: ManaSymbol[][][] = [[]];
  for (const src of sources) {
    const next: ManaSymbol[][][] = [];
    for (const c of combos) for (const opt of src.options) { next.push([...c, opt]); if (next.length >= limit) break; }
    combos = next;
    if (combos.length >= limit) break;
  }
  return combos;
}

/** Whether tapping helper matches a sacrifice filter etc. (used by cost checks) */
export function hasPermanentMatching(s: GameState, p: Player, f: Filter, exclude?: GameObject): boolean {
  return p.battlefield.some(o => o !== exclude && matchesFilter(s, o, f, exclude));
}
