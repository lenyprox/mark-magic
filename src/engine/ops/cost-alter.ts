// cost-alter — cost alteration (Phase 9.1): what a spell or ability *costs*, and where it may be cast from.
//
//   * `cost-alter` static — "~ costs {2} less to cast if you control a Wizard", "Spells you cast from your graveyard
//     cost {1} less to cast", "The second spell you cast each turn costs {2} less" (CR 601.2f, 118.7). An `Amount`,
//     a `Condition` and a `from` zone, which the core's fixed-`amount` `cost-adjust` static cannot express; it reaches
//     the engine through the registry's `costMod` hook, so it is part of every payment plan `legal.ts` enumerates.
//   * `cast-from` static — "you may cast <filter> spells from your graveyard [without paying their mana cost]"
//     (CR 601.2, 118.9): a legal action, a `castFrom` gate and a `freeCast` answer.
//   * `cast-free` effect — "you may cast a spell with mana value X or less from your hand without paying its mana
//     cost" (Electrodominance): the cast happens *now*, inside the resolution (CR 608.2f, 601.2).
//   * `hideaway` effect — Hideaway N (CR 702.75): look at the top N, exile one linked to the source, the rest go to
//     the bottom in a random order; the card is played later through `exiled-with` / the `exiled-with-card` target.
//   * cost parts — `exileSelf` ("Exile this artifact:", "Exile this card from your graveyard:"), `sacrificeMany`
//     ("Sacrifice two creatures"), `returnToHandMany` ("return two Islands you control to their owner's hand") and
//     `exileFromGraveyardMatching` ("Exile three creature cards from your graveyard"), which the core's count-only
//     `exileFromGraveyard` cannot filter.
//   * `party` amount (CR 700.7) — "costs {1} less to cast for each creature in your party".
//
// Rules of the contract (src/engine/ops/types.ts): no `node:` imports, only type imports from the core at module
// scope (`chars` is the sanctioned leaf), every observable change through a `Game` primitive, `ext` JSON-plain.
import type { Amount, CastZone, FamilyModule, Filter, Game, GameObject, GameState, LegalAction, PlayerId, TargetRef } from './types.js';
import type { Condition } from '../../cards/types.js';
import { extDel, extGet, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/**
 * Where a `cast-free` may take the card from. `exiled-with` is the cards exiled with the source (hideaway, "the
 * exiled card"), which live in exile but are picked by their link, not by the zone. `library-top` is deliberately
 * absent: `CastZone` has no `library`, so a cast from the top of the library is not expressible (see the family doc).
 */
export type AlterZone = 'hand' | 'graveyard' | 'exile' | 'exiled-with';

/**
 * A cost alteration (CR 118.7). `amount` is how much *generic* mana the cost changes by, positive = cheaper unless
 * `more` is set. `self` reads the ability off the card being cast itself ("~ costs {1} less to cast for each creature
 * in your party"), which is why it works while the card is still in hand; without it the ability is a static on a
 * permanent and applies to every spell that matches (`who` / `filter` / `from`).
 */
export interface CostAlterStatic {
  kind: 'cost-alter';
  amount: Amount;
  /** The alteration is a tax, not a discount ("Spells your opponents cast cost {2} more to cast"). */
  more?: true;
  /** Only the card that carries this ability, wherever it is cast from (a printed "~ costs …" line). */
  self?: true;
  /** Whose spells (default `any`); ignored by a `self` alteration. */
  who?: 'you' | 'opponent' | 'any';
  /** Which spells (matched against the card being cast, with this ability's source as the source object). */
  filter?: Filter;
  /** Only spells cast from this zone, or from anywhere but the hand. */
  from?: CastZone | 'non-hand';
  /** Only while this holds (evaluated with the source; for a `self` alteration, with the card being cast). */
  condition?: Condition;
  /** "The second spell you cast each turn costs {2} less to cast": 2 = the caster has cast exactly 1 before. */
  nthSpellEachTurn?: number;
}

/** Permission to cast cards from a zone other than the hand (CR 601.2), optionally without paying the mana cost. */
export interface CastFromStatic {
  kind: 'cast-from';
  zone: 'graveyard' | 'exile';
  /** Which cards; a spell that does not match is not offered (default: any nonland card). */
  filter?: Filter;
  /** Cast it without paying its mana cost (CR 118.9b). */
  free?: true;
}

/** "You may cast a spell with mana value X or less from your hand without paying its mana cost" — cast it now. */
export interface CastFreeEffect {
  op: 'cast-free';
  from: AlterZone;
  filter?: Filter;
  /** "with mana value X or less" — evaluated in the resolving item's frame, so `'X'` is the spell's X. */
  mvLE?: Amount;
  /** "You may …" (a `may` decision before the choice). */
  optional?: true;
}

/** Hideaway N (CR 702.75): look at the top N, exile one linked to the source, the rest to the bottom at random. */
export interface HideawayEffect { op: 'hideaway'; count: number }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry { costAlterCastFree: CastFreeEffect; costAlterHideaway: HideawayEffect }
  interface StaticRegistry { costAlterAdjust: CostAlterStatic; costAlterCastFrom: CastFromStatic }
  interface AmountCountRegistry { 'party': true }
  interface TargetKindRegistry { 'exiled-with-card': true }
  interface AltCostIdRegistry { 'free-cast': true }
  interface AbilityCostExt {
    /** "Exile this artifact:" / "Exile this card from your graveyard:" — the source pays for itself (CR 118.3). */
    exileSelf?: boolean;
    /** "Sacrifice two creatures" — the core `sacrifice` part is exactly one permanent. */
    sacrificeMany?: { filter: Filter; count: number };
    /** "Return two Islands you control to their owner's hand" — the core `returnToHand` part is exactly one. */
    returnToHandMany?: { filter: Filter; count: number };
    /** "Exile three creature cards from your graveyard" — the core `exileFromGraveyard` part cannot filter. */
    exileFromGraveyardMatching?: { count: number; filter?: Filter };
  }
}

// ------------------------------------------------------------------ 3. helpers

/** The party classes, CR 700.7. */
const PARTY = ['Cleric', 'Rogue', 'Warrior', 'Wizard'];

/**
 * Your party's size (CR 700.7): the largest set of creatures you control that can be assigned one each to Cleric,
 * Rogue, Warrior and Wizard. A creature with several of those classes fills only one slot, so this is a maximum
 * bipartite matching — over four roles, an exhaustive search is both exact and cheap.
 */
function partySize(s: GameState, p: PlayerId): number {
  const mine = chars.battlefieldOf(s, p).filter(o => chars.isCreature(o));
  const cand = PARTY.map(role => mine.filter(o => chars.subtypes(o).includes(role)).map(o => o.id));
  const used: number[] = [];
  const walk = (i: number): number => {
    if (i === cand.length) return 0;
    let best = walk(i + 1);
    for (const id of cand[i]) {
      if (used.includes(id)) continue;
      used.push(id);
      best = Math.max(best, 1 + walk(i + 1));
      used.pop();
    }
    return best;
  };
  return walk(0);
}

/** Does this cost alteration apply to `card` being cast from `from` by `p`? `src` is the object that carries it. */
function alterApplies(e: CostAlterStatic, s: GameState, p: PlayerId, card: GameObject, from: CastZone, src: GameObject): boolean {
  if (!e.self) {
    const mine = src.controller === p;
    if ((e.who ?? 'any') === 'you' && !mine) return false;
    if (e.who === 'opponent' && mine) return false;
  }
  if (e.from === 'non-hand') { if (from === 'hand') return false; } else if (e.from !== undefined && e.from !== from) return false;
  if (e.filter && !chars.matchesFilter(s, card, e.filter, src)) return false;
  if (e.nthSpellEachTurn !== undefined && s.players[p].spellsCastThisTurn !== e.nthSpellEachTurn - 1) return false;
  // a `self` alteration reads its condition about the card being cast, which is not on the battlefield: give the
  // condition a controller the way castSpell does for an alternative cost's condition (CR 601.2f).
  if (e.condition && !chars.conditionHolds(s, e.self ? { ...card, controller: p } : src, e.condition)) return false;
  return true;
}

/**
 * The family's statics on the battlefield, collected in one pass and memoised per state — `legalActions` and
 * `costAdjust` are the two hottest loops in the engine, and both ask this question for every card they consider, so
 * a per-call scan of every permanent's abilities is a measurable share of a whole game (the same reason
 * `legal.ts:castGates` caches). The key is the state object plus `version` (bumped on every event) and `bfGen`
 * (bumped whenever permanents enter, leave or change abilities), so a stale answer cannot outlive either.
 */
interface BoardStatics { alters: { e: CostAlterStatic; src: GameObject }[]; perms: { e: CastFromStatic; ctl: PlayerId }[] }
let cache: { s: GameState; version: number; bfGen: number; v: BoardStatics } | null = null;
function boardStatics(s: GameState): BoardStatics {
  const bfGen = s.bfGen ?? 0;
  if (cache && cache.s === s && cache.version === s.version && cache.bfGen === bfGen) return cache.v;
  const v: BoardStatics = { alters: [], perms: [] };
  for (const o of chars.allPermanents(s)) for (const ab of chars.abilitiesOf(o)) {
    if (ab.kind !== 'static') continue;
    if (ab.effect.kind === 'cost-alter' && !ab.effect.self) v.alters.push({ e: ab.effect, src: o });
    else if (ab.effect.kind === 'cast-from') v.perms.push({ e: ab.effect, ctl: o.controller });
  }
  cache = { s, version: s.version, bfGen, v };
  return v;
}

/** The permission that lets `p` cast `card` from `zone` right now, or undefined. */
function permissionFor(s: GameState, p: PlayerId, card: GameObject, zone: 'graveyard' | 'exile'): CastFromStatic | undefined {
  const perms = boardStatics(s).perms;
  if (!perms.length) return undefined;
  if (chars.isLand(card)) return undefined;                             // a land is played, not cast (CR 305.1)
  for (const { e, ctl } of perms) {
    if (ctl !== p || e.zone !== zone) continue;
    if (e.filter && !chars.matchesFilter(s, card, e.filter, card)) continue;
    return e;
  }
  return undefined;
}

/**
 * Does anything in these effects ask for a target? `legal.ts:targetingEffects` is the real answer, but a `legalActions`
 * hook is synchronous and may not import legal.ts at module scope (the barrel cycle), so this walk is deliberately
 * conservative: any nested object under a target-ish key, and any `target: true`, counts. A spell it is unsure about
 * is simply not offered — an offered cast with no `targetOptions` for an agent to answer would always be rejected.
 */
function needsTargets(v: unknown, key = ''): boolean {
  if (Array.isArray(v)) return v.some(x => needsTargets(x, key));
  if (v !== null && typeof v === 'object') {
    if (TARGET_KEYS.has(key)) return true;
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => (TARGET_KEYS.has(k) && x === true) || needsTargets(x, k));
  }
  return false;
}
const TARGET_KEYS = new Set(['target', 'targets', 'a', 'b', 'what', 'enchant', 'specs']);

/** Everything this family takes off (or adds to) the cost of casting `card` from `from`. Positive = cheaper. */
function alterTotal(s: GameState, p: PlayerId, card: GameObject, from: CastZone): number {
  let r = 0;
  // the card's own "~ costs {N} less/more to cast …" line, read wherever it is being cast from
  for (const ab of chars.defOf(card).abilities) {   // a printed card has a handful of abilities; no scan of the board

    if (ab.kind !== 'static' || ab.effect.kind !== 'cost-alter' || !ab.effect.self) continue;
    const e = ab.effect;
    if (alterApplies(e, s, p, card, from, card)) r += (e.more ? -1 : 1) * chars.evalAmount(s, e.amount, p, 0, card);
  }
  // and every alteration a permanent on the battlefield applies to this spell
  for (const { e, src } of boardStatics(s).alters) {
    if (alterApplies(e, s, p, card, from, src)) r += (e.more ? -1 : 1) * chars.evalAmount(s, e.amount, p, 0, src);
  }
  return r;
}

/** The ops that make a spell hostile, so its targets are aimed at an opponent (game.ts:autoPickTargets uses the same list). */
const HOSTILE = new Set(['damage', 'destroy', 'exile', 'bounce', 'tap', 'lose-life', 'discard', 'mill', 'counter', 'cant-attack-or-block', 'fight', 'bite']);

/**
 * Cast `card` from `zone` for `p`, choosing this spell's targets the way the engine chooses a triggered ability's
 * (game.ts:autoPickTargets): a hostile spell is aimed at an opponent and their permanents, a helpful one at the
 * caster's own. `castSpell` re-checks every pick against the requirement it answered (CR 601.2c).
 */
async function castCard(g: Game, p: PlayerId, card: GameObject, from: CastZone): Promise<boolean> {
  const { flattenEffects, specCount, targetingEffects, targetOptionsFor } = await import('../legal.js');
  const s = g.state;
  const spell = chars.defOf(card).abilities.find(ab => ab.kind === 'spell');
  const effects = spell ? spell.effects : [];
  const opps = s.players.filter(pl => !pl.lost && pl.id !== p).map(pl => pl.id);
  const hostile = flattenEffects(effects).some(e => HOSTILE.has(e.op)
    || (e.op === 'pump' && typeof e.power === 'number' && e.power < 0)
    || (e.op === 'counters' && e.counter === '-1/-1'));
  const score = (r: TargetRef): number => {
    if (r.kind === 'player') return opps.includes(r.id) === hostile ? 5 : -5;
    if (r.kind === 'stack') return 1;
    const o = chars.findObject(s, r.id); if (!o) return -10;
    const val = chars.isCreature(o) ? chars.power(s, o) + chars.toughness(s, o) : 3;
    return opps.includes(o.controller) === hostile ? val : -val;
  };
  const targets: TargetRef[][] = [];
  for (const r of targetingEffects(effects)) {
    const opts = [...targetOptionsFor(g, p, r.spec, card)].sort((a, b) => score(b) - score(a));
    targets.push(opts.slice(0, specCount(r.spec, 0)));
  }
  return g.performAction(p, { type: 'cast', cardId: card.id, from: from === 'hand' ? undefined : from, targets: targets.length ? targets : undefined });
}

/** Cards `p` may cast with this effect (the mana value cap is already evaluated). Lands are never castable (CR 305.1). */
function candidates(s: GameState, p: PlayerId, src: GameObject, from: AlterZone, filter: Filter | undefined, mvLE: number | undefined): GameObject[] {
  const pl = s.players[p];
  const zone = from === 'hand' ? pl.hand : from === 'graveyard' ? pl.graveyard
    : from === 'exile' ? pl.exile
    : (src.exiledWith ?? []).map(id => chars.findObject(s, id)).filter((o): o is GameObject => !!o && o.zone === 'exile');
  return zone.filter(o => !chars.isLand(o)
    && (mvLE === undefined || chars.manaValueOf(o) <= mvLE)
    && (!filter || chars.matchesFilter(s, o, filter, o)));
}

// ------------------------------------------------------------------ 4. the module

const COST_ALTER: FamilyModule = {
  name: 'cost-alter',

  effects: {
    // "You may cast a spell with mana value X or less from your hand without paying its mana cost." The cast happens
    // during this resolution (CR 608.2f); the spell goes on the stack above this one and resolves after it.
    'cast-free': async (e: CastFreeEffect, c) => {
      const mvLE = e.mvLE === undefined ? undefined : c.amt(e.mvLE);
      const opts = candidates(c.s, c.p, c.src, e.from, e.filter, mvLE);
      if (!opts.length) return;
      if (e.optional && !(await c.g.ask(c.p, { kind: 'may', prompt: `Cast a card ${e.from === 'exiled-with' ? `exiled with ${c.src.def.name}` : `from your ${e.from}`} without paying its mana cost?`, source: c.item.name }))) return;
      const [id] = await c.g.ask(c.p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: `Cast without paying its mana cost (${c.item.name})`, exact: false }) as number[];
      const pick = opts.find(o => o.id === id); if (!pick) return;
      extSet(pick, 'costAlterFree', true);                              // read by the freeCast hook below
      const ok = await castCard(c.g, c.p, pick, e.from === 'exiled-with' ? 'exile' : e.from);
      extDel(pick, 'costAlterFree');
      c.g.note(ok ? `${c.g.pname(c.p)} casts ${pick.def.name} without paying its mana cost.` : `${c.g.pname(c.p)} cannot cast ${pick.def.name}.`);
    },

    // Hideaway N (CR 702.75). The card stays linked to the source (`exiledWith`), which is how the card's own
    // "you may play the exiled card" line finds it later (the `exiled-with` Ref / the `exiled-with-card` target).
    'hideaway': async (e: HideawayEffect, c) => {
      const look = c.s.players[c.p].library.slice(0, e.count);
      if (!look.length) return;
      const [id] = await c.g.ask(c.p, { kind: 'choose-cards', from: look.map(o => o.id), count: 1, reason: `Hideaway ${e.count}`, exact: true }) as number[];
      const pick = look.find(o => o.id === id) ?? look[0];
      c.g.moveTo(pick, 'exile', 'top', 'exile');
      c.src.exiledWith = [...(c.src.exiledWith ?? []), pick.id];        // the link game.ts's delve / escape costs use
      const rest = look.filter(o => o.id !== pick.id);
      c.g.rng.shuffle(rest);
      for (const o of rest) c.g.moveTo(o, 'library', 'bottom', 'tuck');
      c.g.note(`${c.g.pname(c.p)} hides a card away with ${c.src.def.name} and puts ${rest.length} card(s) on the bottom of their library.`);
    },
  },

  amounts: {
    // CR 700.7: up to one Cleric, one Rogue, one Warrior and one Wizard among the creatures you control.
    'party': (_a, s, ctrl) => partySize(s, ctrl),
  },

  // Non-core AbilityCost keys: checked by cost.ts:nonManaCostPayable, paid by game.ts:payCost.
  costParts: {
    // "Exile this artifact:" on the battlefield, "Exile this card from your graveyard:" on an ability with
    // `fromGraveyard` — the same part either way, since the source pays with itself (CR 118.3).
    exileSelf: {
      payable: (v, _s, _pl, self) => v === true && (self.zone === 'battlefield' || self.zone === 'graveyard'),
      async pay(_v, g, _p, self) { if (self.zone !== 'battlefield' && self.zone !== 'graveyard') return false; g.moveTo(self, 'exile', 'top', 'cost'); return true; },
    },
    // "Sacrifice two creatures": the core `sacrifice` part is exactly one permanent (CR 601.2h).
    sacrificeMany: {
      payable: (v, s, pl, self) => { const c = v as { filter: Filter; count: number }; return pl.battlefield.filter(o => o.id !== self.id && chars.matchesFilter(s, o, c.filter, self)).length >= c.count; },
      async pay(v, g, p, self, label, item) {
        const c = v as { filter: Filter; count: number };
        const pl = g.state.players[p];
        const opts = pl.battlefield.filter(o => o.id !== self.id && chars.matchesFilter(g.state, o, c.filter, self));
        if (opts.length < c.count) return false;
        const ids = await g.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: c.count, reason: `Sacrifice for ${label}`, exact: true }) as number[];
        const chosen = ids.slice(0, c.count).map(id => opts.find(o => o.id === id)).filter((o): o is GameObject => !!o);
        for (const o of chosen.length === c.count ? chosen : opts.slice(0, c.count)) { if (item) (item.sacrificed ??= []).push(o.id); g.sacrifice(o); }
        return true;
      },
    },
    // "Return two Islands you control to their owner's hand" (Sea Drake's alternative cost).
    returnToHandMany: {
      payable: (v, s, pl, self) => { const c = v as { filter: Filter; count: number }; return pl.battlefield.filter(o => o.id !== self.id && chars.matchesFilter(s, o, c.filter, self)).length >= c.count; },
      async pay(v, g, p, self, label) {
        const c = v as { filter: Filter; count: number };
        const opts = g.state.players[p].battlefield.filter(o => o.id !== self.id && chars.matchesFilter(g.state, o, c.filter, self));
        if (opts.length < c.count) return false;
        const ids = await g.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: c.count, reason: `Return to hand for ${label}`, exact: true }) as number[];
        const chosen = ids.slice(0, c.count).map(id => opts.find(o => o.id === id)).filter((o): o is GameObject => !!o);
        for (const o of chosen.length === c.count ? chosen : opts.slice(0, c.count)) g.moveTo(o, 'hand', 'top', 'cost');
        return true;
      },
    },
    // "Exile three creature cards from your graveyard" — the core part counts but cannot filter.
    exileFromGraveyardMatching: {
      payable: (v, s, pl, self) => { const c = v as { count: number; filter?: Filter }; return pl.graveyard.filter(o => o.id !== self.id && (!c.filter || chars.matchesFilter(s, o, c.filter, self))).length >= c.count; },
      async pay(v, g, p, self, label) {
        const c = v as { count: number; filter?: Filter };
        const opts = g.state.players[p].graveyard.filter(o => o.id !== self.id && (!c.filter || chars.matchesFilter(g.state, o, c.filter, self)));
        if (opts.length < c.count) return false;
        const ids = await g.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: c.count, reason: `Exile from graveyard for ${label}`, exact: true }) as number[];
        const chosen = ids.slice(0, c.count).map(id => opts.find(o => o.id === id)).filter((o): o is GameObject => !!o);
        for (const o of chosen.length === c.count ? chosen : opts.slice(0, c.count)) g.moveTo(o, 'exile', 'top', 'cost');
        return true;
      },
    },
  },

  // Extra legal actions: a card in a zone a `cast-from` permission opens. The plain cast enumeration in legal.ts only
  // reaches the graveyard through an alternative cost, so the permission needs an action of its own.
  legalActions: (g, p, out, sorceryTiming) => {
    const s = g.state; const pl = s.players[p];
    if (!boardStatics(s).perms.some(x => x.ctl === p)) return;
    for (const zone of ['graveyard', 'exile'] as const) for (const card of pl[zone]) {
      const perm = permissionFor(s, p, card, zone); if (!perm) continue;
      const def = chars.defOf(card);
      const spell = def.abilities.find(ab => ab.kind === 'spell');
      if (needsTargets(spell ? spell.effects : [])) continue;           // see needsTargets: no target options to offer
      if (!(def.types.includes('Instant') || def.keywords.includes('flash')) && !sorceryTiming) continue;
      if (!perm.free && !(def.manaCost && g.findPayment(pl, def.manaCost, 0, alterTotal(s, p, card, zone)))) continue;
      const la: LegalAction = { action: { type: 'cast', cardId: card.id, from: zone }, label: `cast ${def.name} from ${zone}${perm.free ? ' (free)' : ''}`, manaValue: perm.free ? 0 : def.manaValue };
      out.push(la);
    }
  },

  // Non-core TargetSpec kinds: "Choose target card exiled with ~" (Quintorius, Loremaster).
  targetKinds: {
    'exiled-with-card': (g, _controller, source) => (source.exiledWith ?? [])
      .map(id => chars.findObject(g.state, id))
      .filter((o): o is GameObject => !!o && o.zone === 'exile')
      .map(o => ({ kind: 'object' as const, id: o.id })),
  },

  // cost.ts:costAdjust — the whole point of the family. Positive = cheaper.
  costMod: alterTotal,

  // castSpell's `from` gate: a `cast-from` permission, or the card this family is casting itself right now.
  castFrom: (g, p, card, from) => {
    if (extGet<boolean>(card, 'costAlterFree') === true) return true;
    if (from !== 'graveyard' && from !== 'exile') return undefined;
    return permissionFor(g.state, p, card, from) ? true : undefined;
  },

  // castSpell's free-cast computation: the marker `cast-free` / the cast-from action sets, or a `free` permission.
  freeCast: (g, p, card, from) => {
    if (extGet<boolean>(card, 'costAlterFree') === true) return true;
    if (from !== 'graveyard' && from !== 'exile') return undefined;
    return permissionFor(g.state, p, card, from)?.free ? true : undefined;
  },

  // Round-trip English per op (what the script verification pipeline diffs against the oracle text).
  render: {
    'cast-free': (e: CastFreeEffect) => e.from === 'exiled-with'
      ? 'you may play the exiled card without paying its mana cost'
      : `you may cast a ${e.filter?.types?.length ? `${e.filter.types.join(' or ').toLowerCase()} spell` : 'spell'}${e.mvLE === undefined ? '' : ` with mana value ${typeof e.mvLE === 'object' ? 'X' : e.mvLE} or less`} from your ${e.from} without paying its mana cost`,
    'hideaway': (e: HideawayEffect) => `hideaway ${e.count}`,
  },
};

export default COST_ALTER;
