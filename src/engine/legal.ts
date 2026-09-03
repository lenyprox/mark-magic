// Enumerates legal actions for a player with priority, and legal targets for a target spec.
import type { Effect, TargetSpec } from '../cards/types.js';
import { manaValue } from '../cards/parse.js';
import { allPermanents, isCreature, isLand, isType, matchesFilter, name, protectedFrom, hasKeyword } from './characteristics.js';
import { findPayment } from './mana.js';
import type { Game } from './game.js';
import { opponentOf, type GameObject, type LegalAction, type PlayerId, type TargetRef } from './state.js';

/** Which effects of a spell/ability take targets, with their spec. */
export function targetingEffects(effects: Effect[]): { index: number; spec: TargetSpec }[] {
  const out: { index: number; spec: TargetSpec }[] = [];
  effects.forEach((e, index) => {
    const t = (e as { target?: unknown }).target;
    if (t && typeof t === 'object' && !(t as TargetSpec).self) out.push({ index, spec: t as TargetSpec });
    if (e.op === 'draw' && e.who === 'target-player') out.push({ index, spec: { kind: 'player' } });
    if ((e.op === 'discard' || e.op === 'lose-life' || e.op === 'gain-life' || e.op === 'mill' || e.op === 'sacrifice') && e.who === 'target-player') out.push({ index, spec: { kind: 'player' } });
    if (e.op === 'fight' && !e.self) { /* two targets: first is own creature */ out.unshift({ index, spec: { kind: 'creature', controller: 'you' } }); }
  });
  return out;
}

export function targetOptionsFor(g: Game, controller: PlayerId, spec: TargetSpec, source: GameObject): TargetRef[] {
  const s = g.state; const opp = opponentOf(controller);
  const out: TargetRef[] = [];
  const perms = allPermanents(s);
  const ctlOk = (o: GameObject) => !spec.controller || (spec.controller === 'you' ? o.controller === controller : o.controller === opp);
  const targetable = (o: GameObject) => {
    if (o.zone !== 'battlefield') return false;
    if (!ctlOk(o)) return false;
    if (hasKeyword(s, o, 'shroud')) return false;
    if (hasKeyword(s, o, 'hexproof') && o.controller !== controller) return false;
    if (protectedFrom(s, o, source)) return false;
    if (spec.filter && !matchesFilter(s, o, spec.filter, source)) return false;
    return true;
  };
  const addObjs = (pred: (o: GameObject) => boolean) => { for (const o of perms) if (targetable(o) && pred(o)) out.push({ kind: 'object', id: o.id }); };
  const addPlayers = (ids: PlayerId[]) => { for (const id of ids) out.push({ kind: 'player', id }); };
  switch (spec.kind) {
    case 'creature': addObjs(isCreature); break;
    case 'tapped-creature': addObjs(o => isCreature(o) && o.tapped); break;
    case 'attacking-creature': addObjs(o => isCreature(o) && (o.attacking !== null || o.blocking.length > 0)); break;
    case 'blocking-creature': addObjs(o => isCreature(o) && o.blocking.length > 0); break;
    case 'planeswalker': addObjs(o => isType(o, 'Planeswalker')); break;
    case 'artifact': addObjs(o => isType(o, 'Artifact')); break;
    case 'enchantment': addObjs(o => isType(o, 'Enchantment')); break;
    case 'land': addObjs(isLand); break;
    case 'permanent': addObjs(() => true); break;
    case 'nonland-permanent': addObjs(o => !isLand(o)); break;
    case 'artifact-or-enchantment': addObjs(o => isType(o, 'Artifact') || isType(o, 'Enchantment')); break;
    case 'player': addPlayers([0, 1]); break;
    case 'opponent': addPlayers([opp]); break;
    case 'any': addObjs(o => isCreature(o) || isType(o, 'Planeswalker')); addPlayers([0, 1]); break;
    case 'creature-or-player': addObjs(isCreature); addPlayers([0, 1]); break;
    case 'creature-or-planeswalker': addObjs(o => isCreature(o) || isType(o, 'Planeswalker')); break;
    case 'spell': case 'creature-spell': case 'noncreature-spell':
      for (const it of s.stack) {
        if (it.kind !== 'spell') continue;
        const cr = it.source.def.types.includes('Creature');
        if (spec.kind === 'creature-spell' && !cr) continue; if (spec.kind === 'noncreature-spell' && cr) continue;
        if (spec.filter && !matchesFilter(s, it.source, spec.filter)) continue;
        out.push({ kind: 'stack', id: it.id });
      }
      break;
  }
  return out;
}

function describeSpec(spec: TargetSpec): string {
  const base = spec.kind.replace(/-/g, ' ');
  const ctl = spec.controller === 'you' ? ' you control' : spec.controller === 'opponent' ? ' an opponent controls' : '';
  return `${spec.optional ? 'up to ' : ''}${spec.count && spec.count > 1 ? spec.count + ' ' : ''}target ${base}${ctl}`;
}

/** All legal actions for player p right now (CR 117 timing, CR 302.6 summoning sickness, CR 305 land drops). */
export function legalActions(g: Game, p: PlayerId): LegalAction[] {
  const s = g.state; const pl = s.players[p];
  const out: LegalAction[] = [{ action: { type: 'pass' }, label: 'pass' }];
  const sorceryTiming = s.activePlayer === p && (s.step === 'main1' || s.step === 'main2') && s.stack.length === 0;
  for (const c of pl.hand) {
    const d = c.def;
    if (d.types.includes('Land')) { if (sorceryTiming && pl.landsPlayedThisTurn < 1) out.push({ action: { type: 'play-land', cardId: c.id }, label: `play land ${d.name}` }); continue; }
    const instantSpeed = d.types.includes('Instant') || d.keywords.includes('flash');
    if (!instantSpeed && !sorceryTiming) continue;
    if (!d.manaCost) continue;
    const reduction = costReduction(g, p, c);
    let maxX = 0;
    if (d.manaCost.x) { while (maxX < 20 && findPayment(s, pl, d.manaCost, maxX + 1, reduction)) maxX++; if (!findPayment(s, pl, d.manaCost, 0, reduction)) continue; }
    else if (!findPayment(s, pl, d.manaCost, 0, reduction)) continue;
    const spell = d.abilities.find(a => a.kind === 'spell');
    const effects = spell ? spell.effects : [];
    // Auras target on cast
    const auraSpec: TargetSpec | null = d.subtypes.includes('Aura') ? (d.abilities.find(a => a.kind === 'static' && a.effect.kind === 'aura') as { effect: { enchant: TargetSpec } } | undefined)?.effect.enchant ?? { kind: 'creature' } : null;
    const modal = effects.find(e => e.op === 'choose-mode');
    const modeSets: (number[] | undefined)[] = modal && modal.op === 'choose-mode' ? modeCombos(modal.modes.length, modal.count) : [undefined];
    for (const modes of modeSets) {
      const eff = expandModes(effects, modes);
      const reqs = targetingEffects(eff);
      const targetOptions = reqs.map(r => ({ spec: describeSpec(r.spec), options: targetOptionsFor(g, p, r.spec, c), optional: !!r.spec.optional, count: r.spec.count ?? 1 }));
      if (auraSpec) targetOptions.unshift({ spec: describeSpec(auraSpec), options: targetOptionsFor(g, p, auraSpec, c), optional: false, count: 1 });
      if (targetOptions.some(t => !t.optional && t.options.length === 0)) continue;
      const modeLabel = modes ? ` [mode ${modes.map(m => m + 1).join('+')}]` : '';
      out.push({ action: { type: 'cast', cardId: c.id, modes, x: d.manaCost.x ? maxX : undefined }, label: `cast ${d.name}${modeLabel}`, targetOptions, manaValue: manaValue(d.manaCost, maxX) });
      if (d.kicker && findPayment(s, pl, { ...d.manaCost, generic: d.manaCost.generic + d.kicker.generic, pips: [...d.manaCost.pips, ...d.kicker.pips] }, 0, reduction)) out.push({ action: { type: 'cast', cardId: c.id, modes, kicked: true }, label: `cast ${d.name} (kicked)${modeLabel}`, targetOptions, manaValue: manaValue(d.manaCost) + manaValue(d.kicker) });
    }
    if (d.cycling && findPayment(s, pl, d.cycling)) out.push({ action: { type: 'activate', objectId: c.id, abilityIndex: -2 }, label: `cycle ${d.name}` });
  }
  // activated abilities of permanents
  for (const o of pl.battlefield) {
    if (o.token?.treasure && !o.tapped) { out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: -1 }, label: `sacrifice Treasure for mana` }); continue; }
    o.def.abilities.forEach((ab, i) => {
      if (ab.kind !== 'activated') return;
      if (ab.manaAbility) return; // mana abilities are used implicitly by auto-payment
      if (ab.sorcerySpeed && !sorceryTiming) return;
      if (ab.oncePerTurn && o.activatedThisTurn.has(i)) return;
      if (ab.loyalty !== undefined && ([...o.activatedThisTurn].length > 0 || (o.counters.loyalty ?? 0) + ab.loyalty < 0)) return;
      if (ab.cost.tap && (o.tapped || (isCreature(o) && o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste')))) return;
      if (ab.cost.untap && !o.tapped) return;
      if (ab.cost.mana && !findPayment(s, pl, ab.cost.mana)) return;
      if (ab.cost.sacrifice && !pl.battlefield.some(x => x !== o && matchesFilter(s, x, ab.cost.sacrifice, o))) return;
      if (ab.cost.discard && pl.hand.length < ab.cost.discard) return;
      if (ab.cost.payLife && pl.life <= ab.cost.payLife) return;
      if (ab.cost.removeCounters && (o.counters[ab.cost.removeCounters.counter] ?? 0) < ab.cost.removeCounters.amount) return;
      if (ab.cost.exileFromGraveyard && pl.graveyard.length < ab.cost.exileFromGraveyard) return;
      if (ab.cost.tapUntappedCreature && !pl.battlefield.some(x => !x.tapped && matchesFilter(s, x, ab.cost.tapUntappedCreature, o))) return;
      if (ab.effects.every(e => e.op === 'unknown')) return;
      const modal = ab.effects.find(e => e.op === 'choose-mode');
      const modeSets: (number[] | undefined)[] = modal && modal.op === 'choose-mode' ? modeCombos(modal.modes.length, modal.count) : [undefined];
      for (const modes of modeSets) {
        const eff = expandModes(ab.effects, modes);
        const reqs = targetingEffects(eff);
        const targetOptions = reqs.map(r => ({ spec: describeSpec(r.spec), options: targetOptionsFor(g, p, r.spec, o), optional: !!r.spec.optional, count: r.spec.count ?? 1 }));
        if (targetOptions.some(t => !t.optional && t.options.length === 0)) continue;
        out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: i, modes }, label: `${name(o)}#${o.id}: ${ab.text}`, targetOptions, manaValue: ab.cost.mana ? manaValue(ab.cost.mana) : 0 });
      }
    });
    // equipment: equip ability (sorcery speed)
    const eq = o.def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'equipment');
    if (eq && eq.kind === 'static' && eq.effect.kind === 'equipment' && sorceryTiming && findPayment(s, pl, eq.effect.equipCost)) {
      const options = pl.battlefield.filter(x => isCreature(x) && x.id !== o.attachedTo).map(x => ({ kind: 'object', id: x.id } as TargetRef));
      if (options.length) out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: -3 }, label: `equip ${name(o)}#${o.id}`, targetOptions: [{ spec: 'target creature you control', options, optional: false, count: 1 }], manaValue: manaValue(eq.effect.equipCost) });
    }
  }
  return out;
}

function costReduction(g: Game, p: PlayerId, card: GameObject): number {
  let r = 0;
  for (const o of g.state.players[p].battlefield) for (const ab of o.def.abilities) if (ab.kind === 'static' && ab.effect.kind === 'cost-reduction' && matchesFilter(g.state, card, ab.effect.filter)) r += ab.effect.amount;
  return r;
}

export function expandModes(effects: Effect[], modes: number[] | undefined): Effect[] {
  const out: Effect[] = [];
  for (const e of effects) { if (e.op === 'choose-mode') { for (const mi of modes ?? [0]) out.push(...(e.modes[mi] ?? [])); } else out.push(e); }
  return out;
}
function modeCombos(n: number, k: number): number[][] {
  if (k <= 1) return Array.from({ length: n }, (_, i) => [i]);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}
