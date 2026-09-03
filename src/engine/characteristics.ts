// Derived characteristics: power/toughness/keywords after counters, until-end-of-turn effects,
// auras, equipment and static anthems (a simplified version of the CR 613 layer system).
import type { Amount, CardType, Color, Filter, Keyword, StaticEffect } from '../cards/types.js';
import type { GameObject, GameState, PlayerId } from './state.js';

export function allPermanents(s: GameState): GameObject[] { return [...s.players[0].battlefield, ...s.players[1].battlefield]; }
export function findObject(s: GameState, id: number): GameObject | undefined {
  for (const p of s.players) for (const z of [p.battlefield, p.hand, p.graveyard, p.exile, p.library]) { const o = z.find(x => x.id === id); if (o) return o; }
  for (const it of s.stack) if (it.source.id === id) return it.source;
  return undefined;
}

export function types(o: GameObject): CardType[] { return o.token ? (o.token.types as CardType[]) : o.def.types; }
export function subtypes(o: GameObject): string[] { return o.token ? o.token.subtypes : o.def.subtypes; }
export function colors(o: GameObject): Color[] { return o.token ? o.token.colors : o.def.colors; }
export function isCreature(o: GameObject): boolean { return types(o).includes('Creature'); }
export function isLand(o: GameObject): boolean { return types(o).includes('Land'); }
export function isType(o: GameObject, t: CardType): boolean { return types(o).includes(t); }
export function name(o: GameObject): string { return o.token ? o.token.name : o.def.name; }

function baseP(o: GameObject): number { if (o.token) return o.token.power; return numOrStar(o.def.power); }
function baseT(o: GameObject): number { if (o.token) return o.token.toughness; return numOrStar(o.def.toughness); }
function numOrStar(s: string | null): number { if (s == null) return 0; const n = Number(s); return Number.isFinite(n) ? n : 0; }

export function evalAmount(s: GameState, a: Amount, ctrl: PlayerId, x = 0, source?: GameObject): number {
  if (typeof a === 'number') return a;
  if (a === 'X') return x;
  const me = s.players[ctrl];
  let n = 0;
  switch (a.count) {
    case 'creatures-you-control': n = me.battlefield.filter(o => isCreature(o) && (!a.filter || matchesFilter(s, o, a.filter, source))).length; break;
    case 'cards-in-hand': n = me.hand.length; break;
    case 'lands-you-control': n = me.battlefield.filter(isLand).length; break;
    case 'power-of-source': n = source ? power(s, source) : 0; break;
    case 'creatures-attacking': n = me.battlefield.filter(o => o.attacking !== null).length; break;
    case 'opponent-creatures': n = s.players[ctrl === 0 ? 1 : 0].battlefield.filter(isCreature).length; break;
    case 'life-lost-this-turn': n = s.players[ctrl === 0 ? 1 : 0].lifeLostThisTurn; break;
  }
  return n + (a.plus ?? 0);
}

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
  if (f.nonbasic && o.def.supertypes.includes('Basic')) return false;
  if (f.other && source && o.id === source.id) return false;
  if (f.powerGE != null && power(s, o) < f.powerGE) return false;
  if (f.powerLE != null && power(s, o) > f.powerLE) return false;
  if (f.toughnessLE != null && toughness(s, o) > f.toughnessLE) return false;
  if (f.mvLE != null && (o.token ? 0 : o.def.manaValue) > f.mvLE) return false;
  if (f.mvGE != null && (o.token ? 0 : o.def.manaValue) < f.mvGE) return false;
  return true;
}

interface Mods { p: number; t: number; kw: Keyword[]; flags: { cantAttack?: boolean; cantBlock?: boolean; cantAttackOrBlock?: boolean; doesntUntap?: boolean } }

/** Collect static modifications applying to `o` from all permanents on the battlefield. */
function staticMods(s: GameState, o: GameObject): Mods {
  const m: Mods = { p: 0, t: 0, kw: [], flags: {} };
  for (const src of allPermanents(s)) {
    // aura / equipment attached to o
    if (src.attachedTo === o.id) {
      for (const ab of src.def.abilities) if (ab.kind === 'static') {
        const e = ab.effect;
        if (e.kind === 'aura' || e.kind === 'equipment') {
          m.p += e.power; m.t += e.toughness; if (e.keywords) m.kw.push(...e.keywords);
          if (e.kind === 'aura') { if (e.cantAttackOrBlock) m.flags.cantAttackOrBlock = true; if (e.cantAttack) m.flags.cantAttack = true; if (e.cantBlock) m.flags.cantBlock = true; if (e.doesntUntap) m.flags.doesntUntap = true; }
        }
      }
    }
    for (const ab of src.def.abilities) if (ab.kind === 'static') {
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
  const me = s.players[src.controller], opp = s.players[src.controller === 0 ? 1 : 0];
  switch (cond.kind) {
    case 'life-le': return (cond.who === 'you' ? me : opp).life <= cond.value;
    case 'controls': return (cond.who === 'you' ? me : opp).battlefield.filter(o => matchesFilter(s, o, cond.filter, src)).length >= cond.atLeast;
    case 'cards-in-hand-ge': return (cond.who === 'you' ? me : opp).hand.length >= cond.value;
    case 'threshold': return me.graveyard.length >= 7;
    case 'metalcraft': return me.battlefield.filter(o => isType(o, 'Artifact')).length >= 3;
    case 'hellbent': return me.hand.length === 0;
    case 'ferocious': return me.battlefield.some(o => isCreature(o) && power(s, o) >= 4);
    case 'formidable': return me.battlefield.filter(isCreature).reduce((a, o) => a + power(s, o), 0) >= 8;
    case 'raid': return me.attackedThisTurn;
    case 'morbid': return s.players[0].creaturesDiedThisTurn + s.players[1].creaturesDiedThisTurn > 0;
    case 'delirium': return new Set(me.graveyard.flatMap(o => o.def.types)).size >= 4;
    case 'domain-ge': return new Set(me.battlefield.filter(isLand).flatMap(o => subtypes(o))).size >= cond.value;
    case 'kicked': return false;
    default: return false;
  }
}

export function power(s: GameState, o: GameObject): number {
  const m = staticMods(s, o);
  return baseP(o) + (o.counters['+1/+1'] ?? 0) - (o.counters['-1/-1'] ?? 0) + o.eotPower + m.p;
}
export function toughness(s: GameState, o: GameObject): number {
  const m = staticMods(s, o);
  return baseT(o) + (o.counters['+1/+1'] ?? 0) - (o.counters['-1/-1'] ?? 0) + o.eotToughness + m.t;
}
export function keywords(s: GameState, o: GameObject): Keyword[] {
  const base = o.token ? o.token.keywords : o.def.keywords;
  return [...new Set([...base, ...o.eotKeywords, ...staticMods(s, o).kw])];
}
export function hasKeyword(s: GameState, o: GameObject, k: Keyword): boolean { return keywords(s, o).includes(k); }
export function flags(s: GameState, o: GameObject) { const f = staticMods(s, o).flags; if (o.eotFlags.cantAttackOrBlock) f.cantAttackOrBlock = true; return f; }

export function canAttack(s: GameState, o: GameObject): boolean {
  if (!isCreature(o) || o.tapped) return false;
  if (o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste')) return false;
  if (hasKeyword(s, o, 'defender') || hasKeyword(s, o, 'cant attack')) return false;
  const f = flags(s, o); if (f.cantAttack || f.cantAttackOrBlock) return false;
  return true;
}
export function canBlock(s: GameState, blocker: GameObject, attacker: GameObject): boolean {
  if (!isCreature(blocker) || blocker.tapped) return false;
  if (hasKeyword(s, blocker, 'cant block')) return false;
  const f = flags(s, blocker); if (f.cantBlock || f.cantAttackOrBlock) return false;
  const ak = keywords(s, attacker), bk = keywords(s, blocker);
  if (ak.includes('unblockable')) return false;
  if (ak.includes('flying') && !bk.includes('flying') && !bk.includes('reach')) return false;
  if (ak.includes('fear') && !(colors(blocker).includes('B') || isType(blocker, 'Artifact'))) return false;
  if (ak.includes('intimidate') && !(isType(blocker, 'Artifact') || colors(attacker).some(c => colors(blocker).includes(c)))) return false;
  if (ak.includes('skulk') && power(s, blocker) > power(s, attacker)) return false;
  const ev = (attacker.def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'self-keywords' && (a.effect as unknown as { evasion?: Filter }).evasion) as { effect: { evasion: Filter } } | undefined)?.effect.evasion;
  if (ev) { if (ev.powerLE != null && power(s, blocker) > ev.powerLE) return false; if (ev.powerGE != null && power(s, blocker) < ev.powerGE) return false; if (ev.notColors && ev.notColors.some(c => colors(blocker).includes(c))) return false; }
  const bo = (blocker.def.abilities.find(a => a.kind === 'static' && (a.effect as unknown as { blockOnlyFlying?: boolean }).blockOnlyFlying)) ? true : false;
  if (bo && !ak.includes('flying')) return false;
  if (attacker.def.protectionFrom?.some(p => colors(blocker).some(c => colorName(c) === p) || (p === 'creatures') || (p === 'artifacts' && isType(blocker, 'Artifact')))) return false;
  return true;
}
export function colorName(c: Color): string { return { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' }[c]; }

/** Protection check: can `source` (spell/permanent) target/damage `o`? */
export function protectedFrom(s: GameState, o: GameObject, source: GameObject): boolean {
  const prot = o.def.protectionFrom; if (!prot) return false;
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
