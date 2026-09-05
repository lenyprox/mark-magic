// Planeswalkers and emblems (Phase 9.1 — docs/vocabulary/planeswalker.md).
//
// What the family owns, and why each piece lives where it does:
//
//   emblem            CR 114. "You get an emblem with '<text>'." An emblem is an object in the command zone with no
//                     characteristics but its abilities (CR 114.3), owned by nobody's battlefield: it is not a
//                     permanent, so it is never destroyed, exiled, counted or targeted. The engine already has the
//                     seam for the half of that which matters most — `FamilyModule.triggerSources` widens
//                     `queueTriggers`' scan beyond `allPermanents`, so an emblem's TRIGGERED abilities fire. Its
//                     STATIC abilities do not apply yet: `characteristics.ts:staticSources` still scans the
//                     battlefield alone and there is no registry fold beside it (see the family doc, "What an emblem
//                     cannot do yet", and the `coreChangeNeeded` patch that adds one). Because of that the PARSER
//                     claims only Teferi's `loyalty-any-time` emblem; a script that writes any other static gets a
//                     log line saying it is not applied, so the gap is never silent.
//   loyalty           CR 121 / 306.5b. Loyalty counters put on (or, with a negative amount, removed from) a
//                     planeswalker that is not the source's own activation cost — "Put a loyalty counter on target
//                     Gideon planeswalker", "… and a loyalty counter on each other planeswalker you control".
//   poison-to-total   CR 122.1 / 704.5c. "If target player has fewer than N poison counters, they get a number of
//                     poison counters equal to the difference" (Vraska, Betrayal's Sting): the difference is taken
//                     when the ability resolves, so it is one op rather than a conditional over an amount the core
//                     has no player-poison form for.
//   loyalty-any-time  CR 606.3 read against 117.1a. "You may activate loyalty abilities of planeswalkers you control
//                     on any player's turn any time you could cast an instant" (Teferi, Temporal Archmage's emblem).
//                     A timing permission is not a characteristic, so the static hook only marks its own source and
//                     the work is done by `legalActions`, which is also where an emblem in the command zone can be
//                     consulted at all.
//   compleated        CR 107.4f. "{B/P} can be paid with {B} or 2 life. If life was paid, this planeswalker enters
//                     with two fewer loyalty counters." The life route is modelled as the card's `life` alternative
//                     cost (the parser writes it), so the choice is one the AI actually makes and `castWith.alt`
//                     records it; this as-enters replacement (CR 614.1c) then removes the counters.
//
// The four family rules: no `node:` imports, only type imports from the core at module scope (`./chars.js` is the
// sanctioned exception, and `await import('../state.js')` inside a hook body is how a value is reached), every
// observable change through a `Game` primitive, and `ext` stays JSON-plain.
import type { Ability, Amount, CardDef, FamilyModule, GameObject, GameState, LegalAction, Mods, OpCtx, PlayerId, TargetSpec } from './types.js';
import type { Ref } from '../../cards/types.js';
import { extGet, extPush, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST

/** CR 114.1: "You get an emblem with '<text>'." `abilities` is what the emblem HAS; `text` is the printed quote. */
export interface PwEmblemEffect { op: 'emblem'; abilities: Ability[]; text: string }
/** CR 121.1: put (or, with a negative amount, remove — CR 121.3) loyalty counters on planeswalkers. */
export interface PwLoyaltyEffect {
  op: 'loyalty';
  target: TargetSpec | Ref | 'each-planeswalker-you-control' | 'each-other-planeswalker-you-control';
  amount: Amount;
}
/** CR 122.1: "If target player has fewer than N poison counters, they get a number equal to the difference." */
export interface PwPoisonToTotal { op: 'poison-to-total'; target: TargetSpec; total: Amount }
/** CR 606.3: loyalty abilities of the controller's planeswalkers may be activated any time they could cast an instant. */
export interface PwLoyaltyAnyTime { kind: 'loyalty-any-time' }
/** CR 107.4f: this planeswalker enters with `fewer` fewer loyalty counters when its Phyrexian pips were paid with life. */
export interface PwCompleated { kind: 'compleated'; fewer: number }
/** The family's own event: an emblem was created (CR 114.2 — an effect, not a permanent, so no zone event says it). */
export interface PwEmblemEvent { type: 'emblem'; player: PlayerId; id: number; source: string; text: string }

// ------------------------------------------------------------------ 2. declaration merging (never edit a core type)
declare module '../../cards/types.js' {
  interface EffectRegistry { pwEmblem: PwEmblemEffect; pwLoyalty: PwLoyaltyEffect; pwPoisonToTotal: PwPoisonToTotal }
  interface StaticRegistry { pwLoyaltyAnyTime: PwLoyaltyAnyTime }
  interface AsEntersRegistry { pwCompleated: PwCompleated }
}
declare module '../events.js' {
  interface EventRegistry { pwEmblem: PwEmblemEvent }
}

// ------------------------------------------------------------------ 3. helpers

const NO_OBJECTS: GameObject[] = [];

/**
 * The CardDef an emblem object carries. CR 114.3: an emblem has no characteristics other than its abilities — no
 * name of its own that any effect can see, no types, no mana cost — so every field but `abilities` is the empty
 * value. The name is only how the log and `serialize.defKey` speak about it; two emblems from the same source share
 * it, which is right, because they carry the same abilities.
 */
function emblemDef(source: string, text: string, abilities: Ability[]): CardDef {
  return {
    name: `${source} emblem`, oracleId: `emblem:${source}`, manaCost: null, manaValue: 0, colors: [], colorIdentity: [],
    types: [], supertypes: [], subtypes: [], typeLine: 'Emblem', oracleText: text, power: null, toughness: null,
    loyalty: null, keywords: [], abilities, fullyParsed: true, unparsed: [], layout: 'emblem', producesMana: [],
  };
}

/** Every emblem `p` controls, cheapest-first: one property load per seat when nobody has one. */
function emblemsOf(s: GameState, p?: PlayerId): GameObject[] {
  let out: GameObject[] | null = null;
  for (const pl of s.players) {
    if (p !== undefined && pl.id !== p) continue;
    if (pl.ext === undefined || pl.ext.emblems === undefined) continue;
    for (const o of pl.command) if (o.ext !== undefined && o.ext.emblem === true) (out ??= []).push(o);
  }
  return out ?? NO_OBJECTS;
}

/** The planeswalkers the `loyalty` op's scope words denote (CR 306.1: planeswalkers on the battlefield). */
function walkersFor(c: OpCtx, scope: 'each-planeswalker-you-control' | 'each-other-planeswalker-you-control'): GameObject[] {
  const out: GameObject[] = [];
  for (const o of chars.battlefieldOf(c.s, c.p)) {
    if (!chars.isType(o, 'Planeswalker')) continue;
    if (scope === 'each-other-planeswalker-you-control' && o.id === c.src.id) continue;
    out.push(o);
  }
  return out;
}

/**
 * Does an ability need a target chosen for it? A `legalActions` hook is synchronous and may not import legal.ts, so
 * it cannot build the `targetOptions` an activation with targets needs — the instant-speed loyalty activations below
 * are therefore offered only for abilities that take none. Deliberately over-cautious: any nested `target` object and
 * any `target-player` / `target-opponent` word anywhere in the effects counts.
 */
function needsTarget(v: unknown): boolean {
  if (typeof v === 'string') return v === 'target-player' || v === 'target-opponent';
  if (Array.isArray(v)) return v.some(needsTarget);
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.target !== undefined && typeof o.target === 'object' && o.target !== null) return true;
  for (const k in o) if (needsTarget(o[k])) return true;
  return false;
}

/** Is a loyalty ability of `p`'s planeswalkers activatable at instant speed right now (CR 606.3, Teferi's emblem)? */
function loyaltyAnyTime(s: GameState, p: PlayerId, walkers: GameObject[]): boolean {
  for (const e of emblemsOf(s, p)) for (const ab of chars.abilitiesOf(e)) if (ab.kind === 'static' && ab.effect.kind === 'loyalty-any-time') return true;
  // a printed (battlefield) source marks itself through the statics hook below
  for (const o of chars.battlefieldOf(s, p)) if (chars.flags(s, o).loyaltyAnyTime === true) return true;
  void walkers;
  return false;
}

// ------------------------------------------------------------------ 4. the module

const PLANESWALKER: FamilyModule = {
  name: 'planeswalker',

  effects: {
    // CR 114.1-114.5: the emblem is created in its controller's command zone. `moveTo` is the primitive that puts an
    // object into a zone (the emblem is made there, so the move is a no-op that still bumps the battlefield
    // generation, which is what invalidates the trigger-kind cache the emblem has just widened).
    'emblem': async (e: PwEmblemEffect, c: OpCtx) => {
      const { makeObject } = await import('../state.js');
      const source = chars.name(c.src);
      const o = makeObject(c.s.nextId++, emblemDef(source, e.text, [...e.abilities]), c.p, 'command', c.s.turn);
      extSet(o, 'emblem', true);
      c.g.moveTo(o, 'command', 'top', 'effect');
      extPush(c.s.players[c.p], 'emblems', { id: o.id, source, text: e.text });
      c.g.emit({ type: 'emblem', player: c.p, id: o.id, source, text: e.text }, `${c.g.pname(c.p)} gets an emblem with "${e.text}".`);
      // Never a SILENT no-op. An emblem's triggered abilities fire (`triggerSources` below) and `loyalty-any-time` is
      // answered by `legalActions`; every other static is collected by `characteristics.ts:staticSources`, which
      // filters `allPermanents` and therefore never sees the command zone. The parser refuses those wordings outright
      // (src/cards/rules/planeswalker.ts), so only a hand-written script can reach this branch — and when it does the
      // log says so rather than leaving an emblem that reads as an anthem and is not one.
      for (const ab of e.abilities) {
        if (ab.kind !== 'static' || ab.effect.kind === 'loyalty-any-time') continue;
        c.g.note(`${source} emblem: "${ab.text ?? ab.effect.kind}" is a static ability of an emblem, which the engine does not apply yet.`);
      }
    },

    // CR 121.1 / 306.5b: loyalty counters that are not an activation cost.
    'loyalty': async (e: PwLoyaltyEffect, c: OpCtx) => {
      const n = c.amt(e.amount);
      if (n === 0) return;
      const list = typeof e.target !== 'string' ? c.objs()
        : e.target === 'each-planeswalker-you-control' || e.target === 'each-other-planeswalker-you-control' ? walkersFor(c, e.target)
        : await refObjects(c, e.target);
      for (const o of list) if (o.zone === 'battlefield') c.g.addCounters(o, 'loyalty', n);
    },

    // CR 122.1: the shortfall is measured as the ability resolves (CR 608.2h), so nothing is chosen on announcement.
    'poison-to-total': (e: PwPoisonToTotal, c: OpCtx) => {
      const want = c.amt(e.total);
      for (const w of c.players()) {
        const short = want - c.s.players[w].poison;
        if (short > 0) c.g.addPoison(w, short, `${chars.name(c.src)} (up to ${want} poison counters)`);
      }
    },
  },

  // The timing permission itself is read by `legalActions`; folding a flag onto the source is what lets a PRINTED
  // (battlefield) source be found without a second ability scan. An emblem never reaches this hook: `staticSources`
  // scans the battlefield only — see the family doc.
  statics: {
    'loyalty-any-time': (_e: PwLoyaltyAnyTime, src: GameObject, o: GameObject, _s: GameState, m: Mods) => {
      if (src.id === o.id) m.flags.loyaltyAnyTime = true;
    },
  },

  // CR 107.4f + 614.1c: the loyalty counters `moveTo` just put on are reduced as it enters, before ETB triggers.
  asEnters: {
    'compleated': (a: PwCompleated, o, _ctx, g) => {
      if (o.castWith?.alt !== 'life') return;                                    // the mana route was taken; full loyalty
      const n = Math.min(a.fewer, o.counters.loyalty ?? 0);
      if (n <= 0) return;
      g.addCounters(o, 'loyalty', -n);
      g.note(`${chars.name(o)} enters with ${n} fewer loyalty counters (compleated).`);
    },
  },

  // CR 114.2: an emblem's triggered abilities work from the command zone, so `queueTriggers` has to see it.
  triggerSources: (s: GameState) => emblemsOf(s),

  // CR 606.3: with Teferi's emblem out, a loyalty ability may be activated whenever its controller could cast an
  // instant. The core offers loyalty activations only at sorcery timing, so this adds the rest of the window.
  legalActions: (g, p: PlayerId, out: LegalAction[], sorceryTiming: boolean) => {
    if (sorceryTiming) return;                                     // already offered by legal.ts
    const s = g.state;
    const walkers: GameObject[] = [];
    for (const o of chars.battlefieldOf(s, p)) if (chars.isType(o, 'Planeswalker')) walkers.push(o);
    if (!walkers.length || !loyaltyAnyTime(s, p, walkers)) return;
    const pl = s.players[p];
    for (const o of walkers) {
      if (o.activatedThisTurn.size > 0) continue;                  // CR 606.3: still only one loyalty ability a turn
      chars.abilitiesOf(o).forEach((ab, i) => {
        if (ab.kind !== 'activated' || ab.loyalty === undefined) return;
        if ((o.counters.loyalty ?? 0) + ab.loyalty < 0) return;    // CR 118.4: the cost must be payable
        if (ab.effects.every(x => x.op === 'unknown')) return;
        if (needsTarget(ab.effects)) return;                       // no way to enumerate targets from here (see needsTarget)
        if (ab.cost.mana && !g.findPayment(pl, ab.cost.mana)) return;
        out.push({ action: { type: 'activate', objectId: o.id, abilityIndex: i }, label: `${chars.name(o)}#${o.id}: ${ab.text}`, manaValue: 0 });
      });
    }
  },

  events: {
    'emblem': { logged: true, cr: '114.1', render: (ev) => `${(ev as PwEmblemEvent).source} emblem: "${(ev as PwEmblemEvent).text}"` },
  },

  // Round-trip English (what scripts:verify diffs against the oracle line).
  render: {
    'emblem': (e: PwEmblemEffect) => `you get an emblem with "${e.text}"`,
    'loyalty': (e: PwLoyaltyEffect) => {
      const who = e.target === 'each-planeswalker-you-control' ? 'each planeswalker you control'
        : e.target === 'each-other-planeswalker-you-control' ? 'each other planeswalker you control'
        : typeof e.target === 'string' ? 'it' : renderWalkerTarget(e.target);
      const n = typeof e.amount === 'number' ? e.amount : 1;
      return n < 0 ? `remove ${-n} loyalty ${-n === 1 ? 'counter' : 'counters'} from ${who}`
        : `put ${n === 1 ? 'a' : n} loyalty ${n === 1 ? 'counter' : 'counters'} on ${who}`;
    },
    'poison-to-total': (e: PwPoisonToTotal) => {
      const n = typeof e.total === 'number' ? e.total : 'that many';
      return `if target player has fewer than ${n} poison counters, they get a number of poison counters equal to the difference`;
    },
  },
};

/** "target Gideon planeswalker" from the spec the parser built, for the renderer's round trip. */
function renderWalkerTarget(t: TargetSpec): string {
  const sub = t.filter?.subtypes?.length ? `${t.filter.subtypes.join(' or ')} ` : '';
  const ctl = t.controller === 'you' ? ' you control' : t.controller === 'opponent' ? ' an opponent controls' : '';
  return `${t.optional ? 'up to one target ' : 'target '}${sub}${t.kind === 'planeswalker' ? 'planeswalker' : String(t.kind)}${ctl}`;
}

/**
 * A `loyalty` op whose target is a `Ref` — every one of them, through the core's own resolver.
 *
 * `src/engine/refs.ts` is the single place that knows what `triggering`, `target:<i>`, `enchanted`, `equipped`,
 * `sacrificed` and `exiled-with` mean (docs/vocabulary/composition.md); reading `item.affected` by hand answers only
 * `that` / `those` and silently returns the wrong objects — a no-op — for the other six, which the zod schema
 * accepts. `refs.js` is a core module, so it is reached the sanctioned way: `await import` inside the hook body,
 * never at module scope (the core imports the registry and the registry imports this file).
 */
async function refObjects(c: OpCtx, r: Ref): Promise<GameObject[]> {
  const { resolveRef } = await import('../refs.js');
  return resolveRef({ s: c.s, item: c.item, p: c.p, src: c.src }, r);
}

export default PLANESWALKER;
