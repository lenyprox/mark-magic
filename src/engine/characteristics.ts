// Derived characteristics: power/toughness/keywords after counters, until-end-of-turn effects,
// auras, equipment and static anthems (a simplified version of the CR 613 layer system).
import type { Ability, Amount, CardDef, CardType, Color, Filter, Keyword, StaticEffect } from '../cards/types.js';
import type { GameObject, GameState, PlayerId } from './state.js';
import { opponentsOf } from './players.js';

export function allPermanents(s: GameState): GameObject[] { return s.players.length === 2 ? [...s.players[0].battlefield, ...s.players[1].battlefield] : s.players.flatMap(p => p.battlefield); }
export function findObject(s: GameState, id: number): GameObject | undefined {
  for (const p of s.players) for (const z of [p.battlefield, p.hand, p.graveyard, p.exile, p.library, p.command]) { const o = z.find(x => x.id === id); if (o) return o; }
  for (const it of s.stack) if (it.source.id === id) return it.source;
  return undefined;
}

/** The card definition currently in effect for an object: the back face while a double-faced card is flipped. */
export function defOf(o: GameObject): CardDef { return o.activeFace === 1 && o.def.backFace ? o.def.backFace : o.def; }
/** The object's abilities: its (active face's) printed abilities followed by any granted ones (Saga chapters). */
export function abilitiesOf(o: GameObject): Ability[] {
  if (o.token) return o.grantedAbilities ?? EMPTY_ABILITIES; // a token's def is only its creator's card; its own text is in the TokenSpec
  const g = o.grantedAbilities; const d = defOf(o).abilities; return g && g.length ? [...d, ...g] : d;
}
const EMPTY_ABILITIES: Ability[] = [];

export function types(o: GameObject): CardType[] {
  const base = o.token ? (o.token.types as CardType[]) : defOf(o).types;
  if (o.eotFlags.crewed || o.eotFlags.saddled) return base.includes('Creature') ? base : [...base, 'Creature'];
  if (o.counters.time && o.def.altCosts?.some(a => a.id === 'impending')) return base.filter(t => t !== 'Creature'); // impending: not a creature while it has time counters
  return base;
}
export function subtypes(o: GameObject): string[] { return o.token ? o.token.subtypes : defOf(o).subtypes; }
export function colors(o: GameObject): Color[] { return o.token ? o.token.colors : defOf(o).colors; }
export function isCreature(o: GameObject): boolean { return types(o).includes('Creature'); }
export function isLand(o: GameObject): boolean { return types(o).includes('Land'); }
export function isType(o: GameObject, t: CardType): boolean { return types(o).includes(t); }
export function name(o: GameObject): string { return o.token ? o.token.name : defOf(o).name; }
export function manaValueOf(o: GameObject): number { return o.token ? 0 : defOf(o).manaValue; }

function baseP(o: GameObject): number { if (o.token) return o.token.power + (o.token.dynamicPT ? dynamicPT(o) : 0); return numOrStar(defOf(o).power); }
function baseT(o: GameObject): number { if (o.token) return o.token.toughness + (o.token.dynamicPT ? dynamicPT(o) : 0); return numOrStar(defOf(o).toughness); }
let dynamicState: GameState | null = null;
function dynamicPT(o: GameObject): number { return dynamicState && o.token?.dynamicPT ? evalAmount(dynamicState, o.token.dynamicPT, o.controller, 0, o) : 0; }
function numOrStar(s: string | null): number { if (s == null) return 0; const n = Number(s); return Number.isFinite(n) ? n : 0; }

/** Extra context for amounts that refer to "that" object or to how the spell was cast. */
export interface AmountCtx { that?: { power: number; manaValue: number }; colorsSpent?: number }

export function evalAmount(s: GameState, a: Amount, ctrl: PlayerId, x = 0, source?: GameObject, ctx?: AmountCtx): number {
  if (typeof a === 'number') return a;
  if (a === 'X') return x;
  const me = s.players[ctrl];
  let n = 0;
  switch (a.count) {
    case 'creatures-you-control': n = me.battlefield.filter(o => isCreature(o) && (!a.filter || matchesFilter(s, o, a.filter, source))).length; break;
    case 'permanents-you-control': n = me.battlefield.filter(o => !a.filter || matchesFilter(s, o, a.filter, source)).length; break;
    case 'cards-in-hand': n = me.hand.length; break;
    case 'lands-you-control': n = me.battlefield.filter(isLand).length; break;
    case 'power-of-source': n = source ? power(s, source) : 0; break;
    case 'creatures-attacking': n = me.battlefield.filter(o => o.attacking !== null).length; break;
    case 'opponent-creatures': n = opponentsOf(s, ctrl).reduce((a, q) => a + s.players[q].battlefield.filter(isCreature).length, 0); break;
    case 'life-lost-this-turn': n = opponentsOf(s, ctrl).reduce((a, q) => a + s.players[q].lifeLostThisTurn, 0); break;
    case 'domain': n = new Set(me.battlefield.filter(isLand).flatMap(o => subtypes(o)).filter(t => BASIC_TYPES.has(t))).size; break;
    case 'exiled-with': n = (source?.exiledWith ?? []).map(id => findObject(s, id)).filter(o => o && (!a.filter || matchesFilter(s, o, a.filter, source))).length; break;
    case 'cards-in-graveyard': n = me.graveyard.filter(o => !a.filter || matchesFilter(s, o, a.filter, source)).length; break;
    case 'card-types-in-graveyard': n = new Set(me.graveyard.flatMap(o => o.def.types.filter(t => t !== 'Kindred' && t !== 'Tribal'))).size; break;
    case 'card-types-in-all-graveyards': n = new Set(s.players.flatMap(p => p.graveyard).flatMap(o => o.def.types.filter(t => t !== 'Kindred' && t !== 'Tribal'))).size; break;
    case 'counters-on-source': n = source?.counters[a.counter ?? '+1/+1'] ?? 0; break;
    case 'power-of-that': n = ctx?.that?.power ?? 0; break;
    case 'mv-of-that': n = ctx?.that?.manaValue ?? 0; break;
    case 'colors-spent': n = ctx?.colorsSpent ?? source?.castWith?.colorsSpent ?? 0; break;
  }
  return n * (a.times ?? 1) + (a.plus ?? 0);
}
const BASIC_TYPES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);

export function matchesFilter(s: GameState, o: GameObject, f: Filter | undefined, source?: GameObject): boolean {
  if (!f) return true;
  const ts = types(o), sts = subtypes(o), cs = colors(o);
  if (f.types && !f.types.some(t => ts.includes(t))) return false;
  if (f.notTypes && f.notTypes.some(t => ts.includes(t))) return false;
  if (f.subtypes && !f.subtypes.some(t => sts.includes(t) || (t === 'Creature' && ts.includes('Creature')))) return false;
  if (f.colors && !f.colors.some(c => cs.includes(c))) return false;
  if (f.notColors && f.notColors.some(c => cs.includes(c))) return false;
  if (f.colorless && cs.length) return false;
  if (f.tapped && !o.tapped) return false;
  if (f.untapped && o.tapped) return false;
  if (f.token && !o.token) return false;
  if (f.nontoken && o.token) return false;
  if (f.attacking && o.attacking === null) return false;
  if (f.blocking && !o.blocking.length) return false;
  if (f.flying && !hasKeyword(s, o, 'flying')) return false;
  if (f.nonbasic && defOf(o).supertypes.includes('Basic')) return false;
  if (f.basic && !defOf(o).supertypes.includes('Basic')) return false;
  if (f.other && source && o.id === source.id) return false;
  if (f.powerGE != null && power(s, o) < f.powerGE) return false;
  if (f.powerLE != null && power(s, o) > f.powerLE) return false;
  if (f.toughnessLE != null && toughness(s, o) > f.toughnessLE) return false;
  if (f.mvLE != null && manaValueOf(o) > (typeof f.mvLE === 'number' ? f.mvLE : evalAmount(s, f.mvLE, source?.controller ?? o.controller, 0, source))) return false;
  if (f.mvGE != null && manaValueOf(o) < f.mvGE) return false;
  if (f.mvEQ != null && manaValueOf(o) !== (typeof f.mvEQ === 'number' ? f.mvEQ : evalAmount(s, f.mvEQ, source?.controller ?? o.controller, 0, source))) return false;
  return true;
}

interface Mods { p: number; t: number; kw: Keyword[]; flags: { cantAttack?: boolean; cantBlock?: boolean; cantAttackOrBlock?: boolean; doesntUntap?: boolean } }

/** Collect static modifications applying to `o` from all permanents on the battlefield. */
function staticMods(s: GameState, o: GameObject): Mods {
  const m: Mods = { p: 0, t: 0, kw: [], flags: {} };
  for (const src of allPermanents(s)) {
    // aura / equipment attached to o
    if (src.attachedTo === o.id) {
      for (const ab of abilitiesOf(src)) if (ab.kind === 'static') {
        const e = ab.effect;
        if (e.kind === 'aura' || e.kind === 'equipment') {
          m.p += e.power; m.t += e.toughness; if (e.keywords) m.kw.push(...e.keywords);
          if (e.kind === 'aura') { if (e.cantAttackOrBlock) m.flags.cantAttackOrBlock = true; if (e.cantAttack) m.flags.cantAttack = true; if (e.cantBlock) m.flags.cantBlock = true; if (e.doesntUntap) m.flags.doesntUntap = true; }
        }
      }
    }
    for (const ab of abilitiesOf(src)) if (ab.kind === 'static') {
      const e = ab.effect as StaticEffect & { opponentsOnly?: boolean; condition?: unknown };
      if (e.kind === 'anthem') {
        if (!isCreature(o)) continue;
        const sameCtl = src.controller === o.controller;
        if (e.scope === 'you-control' && !sameCtl) continue;
        if (e.scope === 'other-you-control' && (!sameCtl || src.id === o.id)) continue;
        if (e.opponentsOnly && sameCtl) continue;
        if (!matchesFilter(s, o, e.filter, src)) continue;
        m.p += e.power; m.t += e.toughness; if (e.keywords) m.kw.push(...e.keywords);
      }
      if (src.id === o.id) {
        if (e.kind === 'self-pt' && conditionHolds(s, src, (e as { condition?: unknown }).condition)) { m.p += evalAmount(s, e.power, src.controller, 0, src); m.t += evalAmount(s, e.toughness, src.controller, 0, src); }
        if (e.kind === 'self-keywords' && conditionHolds(s, src, e.condition)) {
          m.kw.push(...e.keywords);
          const ex = e as unknown as { mustAttack?: boolean; doesntUntap?: boolean };
          if (ex.doesntUntap) m.flags.doesntUntap = true;
        }
      }
    }
  }
  return m;
}

export function conditionHolds(s: GameState, src: GameObject, c: unknown): boolean {
  if (!c) return true;
  const cond = c as import('../cards/types.js').Condition;
  const me = s.players[src.controller]; const opps = opponentsOf(s, src.controller).map(q => s.players[q]);
  const side = (who: string | undefined, pred: (pl: typeof me) => boolean) => who === 'you' ? pred(me) : opps.some(pred);
  switch (cond.kind) {
    case 'life-le': return cond.who === 'any' ? [me, ...opps].some(pl => pl.life <= cond.value) : side(cond.who, pl => pl.life <= cond.value);
    case 'opponents-ge': return opps.length >= cond.value;
    case 'controls': return side(cond.who, pl => pl.battlefield.filter(o => matchesFilter(s, o, cond.filter, src)).length >= cond.atLeast);
    case 'cards-in-hand-ge': return side(cond.who, pl => pl.hand.length >= cond.value);
    case 'threshold': return me.graveyard.length >= 7;
    case 'metalcraft': return me.battlefield.filter(o => isType(o, 'Artifact')).length >= 3;
    case 'hellbent': return me.hand.length === 0;
    case 'ferocious': return me.battlefield.some(o => isCreature(o) && power(s, o) >= 4);
    case 'formidable': return me.battlefield.filter(isCreature).reduce((a, o) => a + power(s, o), 0) >= 8;
    case 'raid': return me.attackedThisTurn;
    case 'morbid': return s.players.some(p => p.creaturesDiedThisTurn > 0);
    case 'delirium': return evalAmount(s, { count: 'card-types-in-graveyard' }, src.controller) >= 4;
    case 'domain-ge': return evalAmount(s, { count: 'domain' }, src.controller) >= cond.value;
    case 'kicked': return !!src.castWith?.kicked;
    case 'revolt': return (me.permanentsLeftThisTurn ?? 0) > 0;
    case 'not-your-turn': return s.activePlayer !== src.controller;
    case 'your-turn': return s.activePlayer === src.controller;
    case 'lands-le': return me.battlefield.filter(o => isLand(o) && (!cond.other || o.id !== src.id)).length <= cond.value;
    case 'lands-ge': return me.battlefield.filter(o => isLand(o) && (!cond.other || o.id !== src.id)).length >= cond.value;
    case 'turn-le': return (me.turnsTaken ?? 0) <= cond.value;
    case 'escaped': return src.castWith?.alt === 'escape';
    case 'evoked': return src.castWith?.alt === 'evoke';
    case 'cast-from-hand': return (src.castWith?.from ?? 'hand') === 'hand';
    case 'graveyard-has-each': return cond.filters.every(f => me.graveyard.some(o => matchesFilter(s, o, f, src)));
    case 'controls-each': return cond.filters.every(f => me.battlefield.some(o => matchesFilter(s, o, f, src)));
    case 'self-no-counters': { const c = src.zone !== 'battlefield' && src.lastKnown?.counters ? src.lastKnown.counters : src.counters; return !(c[cond.counter] > 0); }
    case 'self-not-renowned': return !src.renowned;
    case 'self-attacking': return src.attacking !== null;
    case 'opponent-lost-life-this-turn': return opps.some(pl => pl.lifeLostThisTurn > 0);
    case 'life-gained-this-turn': return (me.lifeGainedThisTurn ?? 0) > 0;
    default: return false;
  }
}

export function power(s: GameState, o: GameObject): number {
  const m = staticMods(s, o); dynamicState = s;
  return baseP(o) + (o.counters['+1/+1'] ?? 0) - (o.counters['-1/-1'] ?? 0) + o.eotPower + m.p;
}
export function toughness(s: GameState, o: GameObject): number {
  const m = staticMods(s, o); dynamicState = s;
  return baseT(o) + (o.counters['+1/+1'] ?? 0) - (o.counters['-1/-1'] ?? 0) + o.eotToughness + m.t;
}
export function keywords(s: GameState, o: GameObject): Keyword[] {
  const base = o.token ? o.token.keywords : defOf(o).keywords;
  return [...new Set([...base, ...o.eotKeywords, ...staticMods(s, o).kw])];
}
export function hasKeyword(s: GameState, o: GameObject, k: Keyword): boolean { return keywords(s, o).includes(k); }
export function flags(s: GameState, o: GameObject) { const f = staticMods(s, o).flags; if (o.eotFlags.cantAttackOrBlock) f.cantAttackOrBlock = true; if (o.eotFlags.cantBlock) f.cantBlock = true; return f; }

export function canAttack(s: GameState, o: GameObject): boolean {
  if (!isCreature(o) || o.tapped) return false;
  if (o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste')) return false;
  if (hasKeyword(s, o, 'defender') || hasKeyword(s, o, 'cant attack')) return false;
  const f = flags(s, o); if (f.cantAttack || f.cantAttackOrBlock) return false;
  for (const ab of abilitiesOf(o)) if (ab.kind === 'static' && ab.effect.kind === 'cant-attack-unless-defender-controls') { const fl = ab.effect.filter; if (!opponentsOf(s, o.controller).some(q => s.players[q].battlefield.some(x => matchesFilter(s, x, fl, o)))) return false; }
  return true;
}
export function canBlock(s: GameState, blocker: GameObject, attacker: GameObject): boolean {
  if (!isCreature(blocker) || blocker.tapped) return false;
  if (hasKeyword(s, blocker, 'cant block')) return false;
  const f = flags(s, blocker); if (f.cantBlock || f.cantAttackOrBlock) return false;
  const ak = keywords(s, attacker), bk = keywords(s, blocker);
  if (ak.includes('unblockable')) return false;
  if (ak.includes('flying') && !bk.includes('flying') && !bk.includes('reach')) return false;
  // shadow and horsemanship: only creatures with the same keyword can block or be blocked (CR 702.28, 702.31)
  if (ak.includes('shadow') !== bk.includes('shadow')) return false;
  if (ak.includes('horsemanship') !== bk.includes('horsemanship')) return false;
  if (ak.includes('landwalk') && attacker.def.landwalk?.some(t => s.players[blocker.controller].battlefield.some(l => isLand(l) && subtypes(l).includes(t)))) return false;
  if (ak.includes('fear') && !(colors(blocker).includes('B') || isType(blocker, 'Artifact'))) return false;
  if (ak.includes('intimidate') && !(isType(blocker, 'Artifact') || colors(attacker).some(c => colors(blocker).includes(c)))) return false;
  if (ak.includes('skulk') && power(s, blocker) > power(s, attacker)) return false;
  const ev = (abilitiesOf(attacker).find(a => a.kind === 'static' && a.effect.kind === 'self-keywords' && (a.effect as unknown as { evasion?: Filter }).evasion) as { effect: { evasion: Filter } } | undefined)?.effect.evasion;
  if (ev) { if (ev.powerLE != null && power(s, blocker) > ev.powerLE) return false; if (ev.powerGE != null && power(s, blocker) < ev.powerGE) return false; if (ev.notColors && ev.notColors.some(c => colors(blocker).includes(c))) return false; }
  const bo = (abilitiesOf(blocker).find(a => a.kind === 'static' && (a.effect as unknown as { blockOnlyFlying?: boolean }).blockOnlyFlying)) ? true : false;
  if (bo && !ak.includes('flying')) return false;
  if (defOf(attacker).protectionFrom?.some(p => colors(blocker).some(c => colorName(c) === p) || (p === 'creatures') || (p === 'artifacts' && isType(blocker, 'Artifact')))) return false;
  return true;
}
export function colorName(c: Color): string { return { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' }[c]; }

/** Protection check: can `source` (spell/permanent) target/damage `o`? */
export function protectedFrom(s: GameState, o: GameObject, source: GameObject): boolean {
  const prot = defOf(o).protectionFrom; if (!prot) return false;
  const sc = colors(source);
  for (const p of prot) {
    if (p === 'everything') return true;
    if (sc.some(c => colorName(c) === p)) return true;
    if (p === 'creatures' && isCreature(source)) return true;
    if (p === 'artifacts' && isType(source, 'Artifact')) return true;
    if (p === 'instants' && isType(source, 'Instant')) return true;
    if (p === 'all colors' && sc.length) return true;
    if (p === 'monocolored' && sc.length === 1) return true;
    if (p === 'multicolored' && sc.length > 1) return true;
  }
  return false;
}
