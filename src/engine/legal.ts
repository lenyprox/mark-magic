// Enumerates legal actions for a player with priority, and legal targets for a target spec.
import type { AltCost, Effect, ManaCost, TargetSpec } from '../cards/types.js';
import { manaValue } from '../cards/parse.js';
import { abilitiesOf, allPermanents, castForbiddenBy, conditionHolds, defOf, flashFor, isCreature, isLand, isType, matchesFilter, name, protectedFrom, hasKeyword } from './characteristics.js';
import { findPayment as findPaymentFull, manaSources, type ManaSourceOptions, type Payment } from './mana.js';
import { costAdjust, exileWindowOpen, extraManaSources, hasModifier, nonManaCostPayable, pickDelve, spellManaCost, ZERO_COST } from './cost.js';
import type { Game } from './game.js';
import { type CastZone, type GameObject, type IllegalHint, type LegalAction, type PlayerAction, type PlayerId, type TargetRef } from './state.js';
import { alive, opponentsOf } from './players.js';

/** Which effects of a spell/ability take targets, with their spec. */
export function targetingEffects(effects: Effect[]): { index: number; spec: TargetSpec }[] {
  const out: { index: number; spec: TargetSpec }[] = [];
  effects.forEach((e, index) => {
    const t = (e as { target?: unknown }).target;
    if (t && typeof t === 'object' && !(t as TargetSpec).self) out.push({ index, spec: t as TargetSpec });
    if (e.op === 'draw' && e.who === 'target-player') out.push({ index, spec: { kind: 'player' } });
    if ((e.op === 'discard' || e.op === 'lose-life' || e.op === 'gain-life' || e.op === 'mill' || e.op === 'sacrifice' || e.op === 'look-top' || e.op === 'exile-graveyard') && e.who === 'target-player') out.push({ index, spec: { kind: 'player' } });
    if (e.op === 'reveal-hand-discard') out.push({ index, spec: { kind: e.who === 'target-opponent' ? 'opponent' : 'player' } });
    if (e.op === 'fight' && !e.self) { /* two targets: first is own creature */ out.unshift({ index, spec: { kind: 'creature', controller: 'you' } }); }
  });
  return out;
}

export function targetOptionsFor(g: Game, controller: PlayerId, spec: TargetSpec, source: GameObject): TargetRef[] {
  const s = g.state; const opps = opponentsOf(s, controller); const everyone = alive(s);
  const out: TargetRef[] = [];
  const perms = allPermanents(s);
  const ctlOk = (o: GameObject) => !spec.controller || (spec.controller === 'you' ? o.controller === controller : opps.includes(o.controller));
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
    case 'artifact-enchantment-or-nonbasic-land': addObjs(o => isType(o, 'Artifact') || isType(o, 'Enchantment') || (isLand(o) && !defOf(o).supertypes.includes('Basic'))); break;
    case 'spell-or-nonland-permanent': addObjs(o => !isLand(o)); for (const it of s.stack) if (it.kind === 'spell' && (!spec.controller || (spec.controller === 'you') === (it.controller === controller))) out.push({ kind: 'stack', id: it.id }); break;
    case 'graveyard-card': for (const pl of s.players) for (const o of pl.graveyard) if (!spec.filter || matchesFilter(s, o, spec.filter, source)) out.push({ kind: 'object', id: o.id }); break;
    case 'player': addPlayers(everyone); break;
    case 'opponent': addPlayers(opps); break;
    case 'any': addObjs(o => isCreature(o) || isType(o, 'Planeswalker')); addPlayers(everyone); break;
    case 'creature-or-player': addObjs(isCreature); addPlayers(everyone); break;
    case 'creature-or-planeswalker': addObjs(o => isCreature(o) || isType(o, 'Planeswalker')); break;
    case 'ability': for (const it of s.stack) if (it.kind !== 'spell') out.push({ kind: 'stack', id: it.id }); break;
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
  const findPayment = (cost: ManaCost, x = 0, reduction = 0, opts?: ManaSourceOptions) => findPaymentFull(s, pl, cost, x, reduction, g.manaLimit, opts);
  const out: LegalAction[] = [{ action: { type: 'pass' }, label: 'pass' }];
  const sorceryTiming = s.activePlayer === p && (s.step === 'main1' || s.step === 'main2') && s.stack.length === 0;
  const extraLands = pl.battlefield.reduce((a, o) => a + abilitiesOf(o).reduce((b, ab) => b + (ab.kind === 'static' && ab.effect.kind === 'extra-land' ? ab.effect.amount : 0), 0), 0);
  const landDrop = sorceryTiming && pl.landsPlayedThisTurn < 1 + extraLands;
  if (landDrop) {
    const zones = new Set(pl.battlefield.flatMap(o => abilitiesOf(o).flatMap(ab => ab.kind === 'static' && ab.effect.kind === 'play-lands-from' ? [ab.effect.zone] : [])));
    if (zones.has('graveyard')) for (const c of pl.graveyard) if (c.def.types.includes('Land')) out.push({ action: { type: 'play-land', cardId: c.id, from: 'graveyard' }, label: `play land ${c.def.name} from graveyard` });
    if (zones.has('library-top') && pl.library[0]?.def.types.includes('Land')) out.push({ action: { type: 'play-land', cardId: pl.library[0].id, from: 'library' }, label: `play land ${pl.library[0].def.name} from the top of the library` });
  }
  for (const c of pl.hand) {
    const d = c.def;
    if (d.types.includes('Land')) { if (landDrop) out.push({ action: { type: 'play-land', cardId: c.id }, label: `play land ${d.name}` }); }
    else castActionsFor(g, p, c, 'hand', sorceryTiming, out);
    if (landDrop && d.layout === 'modal_dfc' && d.backFace?.types.includes('Land')) out.push({ action: { type: 'play-land', cardId: c.id, face: 1 }, label: `play land ${d.backFace.name}` });
    if (d.cycling && findPayment(d.cycling)) out.push({ action: { type: 'activate', objectId: c.id, abilityIndex: -2 }, label: `cycle ${d.name}` });
    // abilities activated from hand ("Channel — {1}{G}, Discard this card: ...")
    d.abilities.forEach((ab, i) => {
      if (ab.kind !== 'activated' || !ab.cost.discardSelf) return;
      if (ab.sorcerySpeed && !sorceryTiming) return;
      if (ab.cost.mana && !findPayment(ab.cost.mana)) return;
      if (!nonManaCostPayable(s, pl, ab.cost, c)) return;
      if (ab.effects.every(e => e.op === 'unknown')) return;
      const reqs = targetingEffects(ab.effects);
      const targetOptions = reqs.map(r => ({ spec: describeSpec(r.spec), options: targetOptionsFor(g, p, r.spec, c), optional: !!r.spec.optional, count: r.spec.count ?? 1 }));
      if (targetOptions.some(t => !t.optional && t.options.length === 0)) return;
      out.push({ action: { type: 'activate', objectId: c.id, abilityIndex: i }, label: `${d.name}: ${ab.text}`, targetOptions, manaValue: ab.cost.mana ? manaValue(ab.cost.mana) : 0 });
    });
  }
  for (const c of pl.graveyard) if (c.def.altCosts?.some(a => a.from === 'graveyard')) castActionsFor(g, p, c, 'graveyard', sorceryTiming, out);
  // abilities activated from the graveyard (unearth)
  for (const c of pl.graveyard) c.def.abilities.forEach((ab, i) => {
    if (ab.kind !== 'activated' || !ab.fromGraveyard) return;
    if (ab.sorcerySpeed && !sorceryTiming) return;
    if (ab.cost.mana && !findPayment(ab.cost.mana)) return;
    out.push({ action: { type: 'activate', objectId: c.id, abilityIndex: i }, label: `${c.def.name}: ${ab.text}`, manaValue: ab.cost.mana ? manaValue(ab.cost.mana) : 0 });
  });
  for (const c of pl.exile) if (c.castableFromExile && exileWindowOpen(s, p, c.castableFromExile)) castActionsFor(g, p, c, 'exile', sorceryTiming, out);
  for (const c of pl.command ?? []) castActionsFor(g, p, c, 'command', sorceryTiming, out);
  // activated abilities of permanents
  for (const o of pl.battlefield) {
    if (o.token?.treasure && !o.tapped) { out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: -1 }, label: `sacrifice Treasure for mana` }); continue; }
    if (o.token?.clue) { if (findPayment({ generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' })) out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: -6 }, label: `sacrifice Clue: draw a card`, manaValue: 2 }); continue; }
    if (o.token?.food) { if (!o.tapped && findPayment({ generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' })) out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: -7 }, label: `sacrifice Food: gain 3 life`, manaValue: 2 }); continue; }
    abilitiesOf(o).forEach((ab, i) => {
      if (ab.kind !== 'activated') return;
      // tap-only mana abilities are used implicitly by auto-payment; ones with other costs (Lotus Petal, Lion's Eye Diamond) are explicit actions
      if (ab.manaAbility && !ab.cost.sacrificeSelf && !ab.cost.discardHand && !ab.cost.mana) return;
      if (ab.sorcerySpeed && !sorceryTiming) return;
      if (ab.oncePerTurn && o.activatedThisTurn.has(i)) return;
      if (ab.loyalty !== undefined && ([...o.activatedThisTurn].length > 0 || (o.counters.loyalty ?? 0) + ab.loyalty < 0)) return;
      if (ab.cost.tap && (o.tapped || (isCreature(o) && o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste')))) return;
      if (ab.cost.untap && !o.tapped) return;
      if (ab.cost.mana && !findPayment(ab.cost.mana)) return;
      if (ab.activateOnlyIf && !conditionHolds(s, o, ab.activateOnlyIf)) return;
      if (!nonManaCostPayable(s, pl, ab.cost, o)) return;
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
    const eq = abilitiesOf(o).find(a => a.kind === 'static' && a.effect.kind === 'equipment');
    if (eq && eq.kind === 'static' && eq.effect.kind === 'equipment' && sorceryTiming && findPayment(eq.effect.equipCost)) {
      const options = pl.battlefield.filter(x => isCreature(x) && x.id !== o.attachedTo).map(x => ({ kind: 'object', id: x.id } as TargetRef));
      if (options.length) out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: -3 }, label: `equip ${name(o)}#${o.id}`, targetOptions: [{ spec: 'target creature you control', options, optional: false, count: 1 }], manaValue: manaValue(eq.effect.equipCost) });
    }
  }
  return out;
}

/**
 * Cast actions for one card from a zone: the plain cast, the kicked cast, each affordable alternative cost, and delve /
 * convoke variants only when they change what is affordable (or grow a Murktide). One action per variant keeps the
 * AI's branching small; the engine picks the concrete cards to exile/tap.
 */
function castActionsFor(g: Game, p: PlayerId, c: GameObject, from: CastZone, sorceryTiming: boolean, out: LegalAction[]) {
  const s = g.state; const pl = s.players[p]; const d = c.def;
  if (d.types.includes('Land')) return;
  const instantSpeed = d.types.includes('Instant') || d.keywords.includes('flash') || flashFor(s, p, c);
  if (castForbiddenBy(s, p, c)) return [];
  const free = from === 'exile' && !!c.castableFromExile?.free; // rebound: cast during the upkeep, timing permissions aside (CR 702.88a)
  if (!instantSpeed && !sorceryTiming && !free) return;
  const spell = d.abilities.find(a => a.kind === 'spell');
  const effects = spell ? spell.effects : [];
  const auraSpec: TargetSpec | null = d.subtypes.includes('Aura') ? (d.abilities.find(a => a.kind === 'static' && a.effect.kind === 'aura') as { effect: { enchant: TargetSpec } } | undefined)?.effect.enchant ?? { kind: 'creature' } : null;
  const modal = effects.find(e => e.op === 'choose-mode');
  const modeSets: (number[] | undefined)[] = modal && modal.op === 'choose-mode' ? modeCombos(modal.modes.length, modal.count) : [undefined];
  // commander tax (CR 903.8): {2} more for each time it was cast from the command zone before
  const tax = from === 'command' ? 2 * (pl.commanderCasts?.[c.id] ?? 0) : 0;
  const adjust = costAdjust(s, p, c, from) - tax;
  const regular = manaSources(s, pl, { forSpell: c });
  const extras = extraManaSources(s, pl, d, regular);
  const gy = pl.graveyard.filter(o => o.id !== c.id).length;
  const delve = hasModifier(d, 'delve');
  const countsExiled = !!d.asEnters?.some(a => a.kind === 'counters' && typeof a.amount === 'object' && a.amount.count === 'exiled-with');
  const wantsXRange = !!d.asEnters?.some(a => a.kind === 'counters' && a.amount === 'X');
  const tryPay = (cost: ManaCost, x: number, delveN: number, useExtras: boolean) => findPaymentFull(s, pl, cost, x, adjust + delveN, g.manaLimit, { forSpell: c, extraSources: useExtras ? extras : [], extrasFirst: useExtras });

  interface Variant { alt?: AltCost; kicked?: boolean; x?: number; pay?: { delve?: number[]; useExtras?: boolean }; how: string[]; mv: number; plan?: Payment | null; cost?: ManaCost }
  const variants: Variant[] = [];
  const consider = (alt: AltCost | undefined, kicked: boolean) => {
    if (alt && alt.from !== from) return;
    if (!alt && from === 'graveyard') return;
    if (alt?.condition && !conditionHolds(s, { ...c, controller: p }, alt.condition)) return;
    if (alt && !nonManaCostPayable(s, pl, alt.cost, c)) return;
    if (!free && !alt && !d.manaCost) return;
    const cost = free ? ZERO_COST : spellManaCost(d, alt, kicked);
    let maxX = 0;
    if (cost.x) { while (maxX < 20 && (tryPay(cost, maxX + 1, 0, false) || (delve && gy > 0 && tryPay(cost, maxX + 1, Math.min(gy, cost.generic + cost.x * (maxX + 1)), false)))) maxX++; }
    const xs: (number | undefined)[] = cost.x ? (wantsXRange ? Array.from({ length: Math.min(maxX, 4) + 1 }, (_, i) => i) : [maxX]) : [undefined];
    for (const x of xs) {
      const xn = x ?? 0;
      const genericNeeded = Math.max(0, cost.generic + cost.x * xn - adjust);
      const how: string[] = [alt ? alt.label : '', from === 'graveyard' && !alt ? 'from graveyard' : from === 'exile' ? 'from exile' : from === 'command' ? (tax ? `from command zone, tax ${tax}` : 'from command zone') : '', kicked ? 'kicked' : ''].filter(Boolean);
      const mv = alt && !alt.cost.mana ? 0 : manaValue(cost, xn);
      const plan = tryPay(cost, xn, 0, false);
      if (plan) {
        variants.push({ alt, kicked, x, how, mv, plan, cost });
        if (delve && countsExiled && gy > 0 && genericNeeded > 0) { const n = Math.min(gy, genericNeeded); variants.push({ alt, kicked, x, pay: { delve: pickDelve(s, pl, c, n) }, how: [...how, `delve ${n}`], mv }); }
        continue;
      }
      if (delve && gy > 0 && genericNeeded > 0) { const n = Math.min(gy, genericNeeded); if (tryPay(cost, xn, n, false)) { variants.push({ alt, kicked, x, pay: { delve: pickDelve(s, pl, c, n) }, how: [...how, `delve ${n}`], mv }); continue; } }
      if (extras.length && tryPay(cost, xn, 0, true)) variants.push({ alt, kicked, x, pay: { useExtras: true }, how: [...how, hasModifier(d, 'convoke') ? 'convoke' : 'improvise'], mv });
    }
  };
  consider(undefined, false);
  if (d.kicker && from === 'hand') consider(undefined, true);
  for (const alt of d.altCosts ?? []) consider(alt, false);

  for (const v of variants) for (const modes of modeSets) {
    const eff = expandModes(effects, modes);
    const reqs = targetingEffects(eff);
    const targetOptions = reqs.map(r => ({ spec: describeSpec(r.spec), options: targetOptionsFor(g, p, r.spec, c), optional: !!r.spec.optional, count: r.spec.count ?? 1 }));
    if (auraSpec) targetOptions.unshift({ spec: describeSpec(auraSpec), options: targetOptionsFor(g, p, auraSpec, c), optional: false, count: 1 });
    if (targetOptions.some(t => !t.optional && t.options.length === 0)) continue;
    const modeLabel = modes ? ` [mode ${modes.map(m => m + 1).join('+')}]` : '';
    const label = `cast ${d.name}${v.how.length ? ` (${v.how.join(', ')})` : ''}${modeLabel}`;
    const action: PlayerAction = { type: 'cast', cardId: c.id, modes, x: v.x, kicked: v.kicked || undefined, alt: v.alt?.id, from: from !== 'hand' ? from : undefined, pay: v.pay };
    const pay = v.plan ? { cost: v.cost?.raw ?? '', taps: v.plan.taps.map(t => ({ id: t.source.obj.id, name: name(t.source.obj), mana: t.option })), pool: [...v.plan.pool] } : undefined;
    out.push({ action, label, targetOptions, manaValue: v.mv, ...(pay ? { pay } : {}) });
  }
}

/**
 * Why each hand card and permanent with abilities has no legal action right now (a cheap sibling pass over the
 * same predicates legalActions uses), for the table's "why not?" affordances. CR numbers cite the rule involved.
 */
export function illegalReasons(g: Game, p: PlayerId, legal: LegalAction[]): IllegalHint[] {
  const s = g.state; const pl = s.players[p]; const out: IllegalHint[] = [];
  const actionable = new Set<number>();
  for (const l of legal) { if (l.action.type === 'play-land' || l.action.type === 'cast') actionable.add(l.action.cardId); else if (l.action.type === 'activate') actionable.add(l.action.objectId); }
  const myTurn = s.activePlayer === p; const mainStep = s.step === 'main1' || s.step === 'main2'; const stackEmpty = s.stack.length === 0;
  const sorceryTiming = myTurn && mainStep && stackEmpty;
  const extraLands = pl.battlefield.reduce((a, o) => a + abilitiesOf(o).reduce((b, ab) => b + (ab.kind === 'static' && ab.effect.kind === 'extra-land' ? ab.effect.amount : 0), 0), 0);
  const timing = (): IllegalHint['reasons'][number] => !myTurn ? { code: 'not-your-turn', rule: '505.1a', text: "It isn't your turn" } : !mainStep ? { code: 'sorcery-timing', rule: '307.1', text: 'Only during your main phase' } : { code: 'stack-not-empty', rule: '117.1a', text: 'The stack must be empty' };
  for (const c of pl.hand) {
    if (actionable.has(c.id)) continue;
    const d = c.def; const reasons: IllegalHint['reasons'] = [];
    if (d.types.includes('Land')) {
      if (!sorceryTiming) { const t = timing(); reasons.push({ ...t, rule: t.code === 'not-your-turn' ? '305.1' : t.rule }); }
      else if (pl.landsPlayedThisTurn >= 1 + extraLands) reasons.push({ code: 'land-drop-used', rule: '305.2', text: 'You already played a land this turn' });
    } else {
      const instant = d.types.includes('Instant') || d.keywords.includes('flash');
      if (!instant && !sorceryTiming) reasons.push(timing());
      else if (!d.manaCost && !d.altCosts?.length) reasons.push({ code: 'no-action', rule: '601.2', text: 'No cost the engine can pay for this card' });
      else reasons.push({ code: 'cant-pay', rule: '601.2g', text: `Can't pay ${d.manaCost?.raw ?? 'its cost'} with the mana available` });
    }
    if (reasons.length) out.push({ id: c.id, reasons });
  }
  for (const o of pl.battlefield) {
    if (actionable.has(o.id)) continue;
    const abs = abilitiesOf(o).filter((ab): ab is Extract<typeof ab, { kind: 'activated' }> => ab.kind === 'activated' && !(ab.manaAbility && !ab.cost.sacrificeSelf && !ab.cost.discardHand && !ab.cost.mana));
    if (!abs.length) continue;
    const reasons: IllegalHint['reasons'] = [];
    const needsTap = abs.every(ab => ab.cost.tap);
    if (needsTap && o.tapped) reasons.push({ code: 'tapped', rule: '602.5a', text: 'It is already tapped' });
    else if (needsTap && isCreature(o) && o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste')) reasons.push({ code: 'summoning-sick', rule: '302.6', text: 'It came under your control this turn (summoning sickness)' });
    else if (abs.every(ab => ab.sorcerySpeed) && !sorceryTiming) reasons.push(timing());
    else if (abs.every(ab => ab.oncePerTurn) && abs.every((_, i) => o.activatedThisTurn.has(i))) reasons.push({ code: 'once-per-turn', rule: '602.2', text: 'Already activated this turn' });
    else reasons.push({ code: 'cant-pay', rule: '602.2b', text: "Can't pay the ability's cost right now" });
    out.push({ id: o.id, reasons });
  }
  return out;
}

export function expandModes(effects: Effect[], modes: number[] | undefined): Effect[] {
  const out: Effect[] = [];
  for (const e of effects) { if (e.op === 'choose-mode') { for (const mi of modes ?? [0]) out.push(...(e.modes[mi] ?? [])); } else out.push(e); }
  return out;
}
export function modeCombos(n: number, k: number): number[][] {
  if (k === 1) return Array.from({ length: n }, (_, i) => [i]);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}
