// The KEYWORD-ACTION family (Phase 9.1): the printed verbs of CR 701 that are not keyword abilities but *actions* a
// spell or ability performs — investigate, adapt, bolster, support, manifest (and manifest dread), populate, goad,
// incubate, connive, learn, discover, forage, clash, monstrosity, exert, collect evidence, cloak, endure, harness,
// suspect, behold, villainous choice — plus the one keyword ability whose whole substance is a keyword action,
// exploit (CR 702.110).
//
// Everything here is built on the vocabulary the engine already has: an op that is *defined* as a shorthand
// ("investigate" = "create a Clue token", CR 701.20a) recurses into the core op through `c.apply` rather than
// re-implementing token creation, so the event stream, the token-doubling statics and the `that` binding are the
// core's, not a second copy of them. Only the actions the core has no words for (the least-toughness choice of
// bolster, the face-down puts of manifest / cloak, the top-card comparison of clash) do their own work, and they do
// it through the `Game` primitives.
//
// Family state lives in `ext` and is all PUBLIC information: `monstrous`, `harnessed`, `suspected`, `manifested`,
// `cloaked`, `clashWon`, `goadedBy` / `goadedTurn` are every one of them things every player may see (a face-down
// manifested creature's *identity* is hidden by the core's own face-down handling, not by anything here), so the
// family registers no `redact` hook. Nothing in the bag is anything but a boolean or a number.
//
// The bag belongs to the OBJECT, not the card: the `leave` hook wipes every key in `PERMANENT_EXT` when a permanent
// leaves the battlefield, because CR 400.7 makes the thing that comes back a new object with no memory of any of it.
//
// Rules that are approximations rather than the printed thing are listed in docs/vocabulary/keyword-action.md under
// "Known gaps"; each one is also a line in the family's report. The two that matter most: goad records the state and
// raises the event but cannot *force* the attack (the engine's attack requirement is read off printed statics), and
// discover's free cast is a window for the turn rather than a cast during its own resolution — the card is still
// never lost, because CR 701.56a's other half (put it into your hand) is offered up front and an unused window hands
// the card over at `cleanup-end`.
import type { Amount, CardType, Effect, Filter, ManaCost, Ref, TargetSpec } from '../../cards/types.js';
import type { FamilyModule, Game, GameObject, GameState, OpCtx, PlayerId, StackItem, TokenSpec } from './types.js';
import { extDel, extGet, extGetOr, extPush, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/** CR 701.20a — "investigate": create `amount` Clue tokens. */
export interface KaInvestigate { op: 'investigate'; amount: Amount }
/** CR 701.34a — "bolster N": put N +1/+1 counters on the creature you control with the least toughness (you choose among ties). */
export interface KaBolster { op: 'bolster'; amount: Amount }
/** CR 701.33a — "support N": put a +1/+1 counter on each of up to N target creatures (`other` when the source is a creature). */
export interface KaSupport { op: 'support'; amount: number; target: TargetSpec }
/** CR 701.42a — "adapt N": if this has no +1/+1 counters, put N on it. */
export interface KaAdapt { op: 'adapt'; amount: Amount }
/** CR 701.31a — "monstrosity N": if this is not monstrous, put N +1/+1 counters on it and it becomes monstrous. */
export interface KaMonstrosity { op: 'monstrosity'; amount: Amount }
/** CR 701.36a — "manifest": put the top `amount` cards of your library onto the battlefield face down as 2/2 creatures. */
export interface KaManifest { op: 'manifest'; amount: Amount }
/** CR 701.59a — "manifest dread": look at the top two cards, manifest one and put the other into your graveyard. */
export interface KaManifestDread { op: 'manifest-dread' }
/** CR 701.58a — "cloak": manifest the top card of your library; the permanent is also marked cloaked. */
export interface KaCloak { op: 'cloak' }
/** CR 701.29a — "populate": choose a creature token you control and create a copy of it. */
export interface KaPopulate { op: 'populate' }
/** CR 701.39a — "goad": until your next turn, that creature attacks a player other than you if able. */
export interface KaGoad { op: 'goad'; target: TargetSpec | Ref }
/** CR 701.54a — "incubate N": create `count` Incubator tokens with N +1/+1 counters on each. */
export interface KaIncubate { op: 'incubate'; amount: Amount; count?: Amount }
/** CR 701.48a — "connives": draw N, discard N, then a +1/+1 counter for each nonland card discarded this way. */
export interface KaConnive { op: 'connive'; amount: Amount; target: TargetSpec | Ref }
/** CR 701.50a — "learn": you may discard a card, then draw a card (the Lesson sideboard is out of scope). */
export interface KaLearn { op: 'learn' }
/** CR 701.56a — "discover N": exile from the top until a nonland card with mana value N or less; you may play it. */
export interface KaDiscover { op: 'discover'; amount: Amount }
/** CR 701.57a — "forage": exile three cards from your graveyard, or sacrifice a Food. */
export interface KaForage { op: 'forage' }
/** CR 701.19a — "clash with an opponent": both reveal the top card and keep it on top or put it on the bottom. */
export interface KaClash { op: 'clash' }
/** CR 701.38a — "exert": it doesn't untap during your next untap step. */
export interface KaExert { op: 'exert'; target: TargetSpec | Ref }
/** CR 701.62a — "collect evidence N": exile cards with total mana value N or greater from your graveyard. */
export interface KaCollectEvidence { op: 'collect-evidence'; amount: Amount }
/** CR 701.64a — "endures N": its controller chooses N +1/+1 counters on it, or an N/N white Spirit token. */
export interface KaEndure { op: 'endure'; amount: Amount; target: TargetSpec | Ref }
/** CR 701.61a — "suspect": it has menace and can't block for as long as it is suspected. */
export interface KaSuspect { op: 'suspect'; target: TargetSpec | Ref }
/** CR 701.63a — "behold a <filter>": reveal one from your hand or choose one you control. */
export interface KaBehold { op: 'behold'; what: Filter }
/** CR 701.52a — "faces a villainous choice": that player chooses one of the two modes; the modes run as written. */
export interface KaVillainousChoice { op: 'villainous-choice'; who: 'each-opponent' | 'that-player' | 'target'; target?: TargetSpec; modes: Effect[][] }
/** CR 702.110a — the exploit trigger's own action: you may sacrifice a creature; if you do, this "exploits" it. */
export interface KaExploit { op: 'exploit' }
/** Marvel's Infinity Stones: "harness" turns the permanent's ∞ ability on. */
export interface KaHarness { op: 'harness'; target: TargetSpec | Ref }

export interface KaMonstrousCond { kind: 'monstrous' }
export interface KaHarnessedCond { kind: 'harnessed' }
export interface KaSuspectedCond { kind: 'suspected' }
/** "Clash with an opponent. If you win, …" — the flag the immediately preceding `clash` left on the source. */
export interface KaClashWonCond { kind: 'clash-won' }

export interface KaExploitsTrig { on: 'exploits'; self: boolean }
export interface KaClashTrig { on: 'clash' }
export interface KaConnivesTrig { on: 'connives'; self: boolean }
export interface KaExertsTrig { on: 'exerts' }
export interface KaDiscoversTrig { on: 'discovers' }
export interface KaForagesTrig { on: 'forages' }
export interface KaMonstrousTrig { on: 'monstrous'; self: boolean }

export interface KaExploitsEvent { type: 'exploits'; id: number; name: string; sacrificed: string; player: PlayerId }
export interface KaClashEvent { type: 'clash'; player: PlayerId; opponent: PlayerId; yours: string; theirs: string; won: boolean }
export interface KaKeywordActionEvent { type: 'keyword-action'; action: string; id?: number; name?: string; player: PlayerId; amount?: number }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry {
    kaInvestigate: KaInvestigate; kaBolster: KaBolster; kaSupport: KaSupport; kaAdapt: KaAdapt; kaMonstrosity: KaMonstrosity;
    kaManifest: KaManifest; kaManifestDread: KaManifestDread; kaCloak: KaCloak; kaPopulate: KaPopulate; kaGoad: KaGoad;
    kaIncubate: KaIncubate; kaConnive: KaConnive; kaLearn: KaLearn; kaDiscover: KaDiscover; kaForage: KaForage;
    kaClash: KaClash; kaExert: KaExert; kaCollectEvidence: KaCollectEvidence; kaEndure: KaEndure; kaSuspect: KaSuspect;
    kaBehold: KaBehold; kaVillainousChoice: KaVillainousChoice; kaExploit: KaExploit; kaHarness: KaHarness;
  }
  interface ConditionRegistry { kaMonstrous: KaMonstrousCond; kaHarnessed: KaHarnessedCond; kaSuspected: KaSuspectedCond; kaClashWon: KaClashWonCond }
  interface TriggerRegistry {
    kaExploits: KaExploitsTrig; kaClash: KaClashTrig; kaConnives: KaConnivesTrig; kaExerts: KaExertsTrig;
    kaDiscovers: KaDiscoversTrig; kaForages: KaForagesTrig; kaMonstrous: KaMonstrousTrig;
  }
  interface AmountCountRegistry { 'counters-on-source-any': true }
  interface AbilityCostExt {
    /** "Collect evidence N" as a cost (CR 701.62a). */ collectEvidence?: number;
    /** "Forage" as a cost (CR 701.57a). */ forage?: boolean;
    /** "Behold a Dragon" as an additional cost (CR 701.63a). */ beholdWhat?: Filter;
    /** "{T}, Exert this creature:" (CR 701.38b). */ exertSelf?: boolean;
  }
}
declare module '../events.js' {
  interface EventRegistry { kaExploits: KaExploitsEvent; kaClash: KaClashEvent; kaKeywordAction: KaKeywordActionEvent }
}

// ------------------------------------------------------------------ 3. shared helpers

/** One binding-frame entry, built the way `Game.affectedEntry` builds it (it is private, and the shape is pinned by state.ts). */
function entry(s: GameState, o: GameObject): NonNullable<StackItem['affected']>[number] {
  return { id: o.id, lastKnown: { power: chars.power(s, o), toughness: chars.toughness(s, o), controller: o.controller, manaValue: chars.manaValueOf(o), zone: o.zone, owner: o.owner } };
}
/** Bind `list` as this item's `that` / `those` (CR 608.2h) so "…, then attach ~ to that creature" reads it. */
function bind(c: OpCtx, list: GameObject[]): void { c.item.affected = list.map(o => entry(c.s, o)); }

/** The objects an op's `target` denotes: a Ref through the binding frame, `self`, or this effect's chosen targets. */
async function objectsOf(c: OpCtx, t: TargetSpec | Ref): Promise<GameObject[]> {
  if (typeof t === 'string') { const { resolveRef } = await import('../refs.js'); return resolveRef({ s: c.s, item: c.item, p: c.p, src: c.src }, t); }
  if (t.self) return [c.src];
  return c.objs();
}

/**
 * The same list, but for the keyword actions whose *player-facing* half survives the permanent (CR 701.48a connive:
 * the controller still draws and discards, only the counters are lost; CR 701.64a endure: the controller may still
 * take the Spirit). An object that left the battlefield in response keeps its `lastKnown` snapshot, so it still names
 * a controller (CR 608.2g); an object that was never on the battlefield at all is dropped.
 */
async function objectsOrLastKnown(c: OpCtx, t: TargetSpec | Ref): Promise<GameObject[]> {
  return (await objectsOf(c, t)).filter(o => o.zone === 'battlefield' || o.lastKnown !== undefined);
}
/** Who a keyword action's draws and choices belong to: the permanent's controller, or the one it last had. */
const ownerOf = (o: GameObject): PlayerId => o.zone === 'battlefield' ? o.controller : (o.lastKnown?.controller ?? o.owner);

/** A family log line plus the typed event behind it — one place, so every keyword action is greppable in the stream. */
function announce(g: Game, p: PlayerId, action: string, text: string, o?: GameObject, amount?: number): void {
  g.emit({ type: 'keyword-action', action, player: p, ...(o ? { id: o.id, name: chars.name(o) } : {}), ...(amount === undefined ? {} : { amount }) }, text);
}

/** Ask a player to pick exactly `n` of `from` (no question when there is nothing to decide). */
async function pick(g: Game, p: PlayerId, from: GameObject[], n: number, reason: string): Promise<GameObject[]> {
  if (n <= 0 || !from.length) return [];
  if (n >= from.length) return [...from];
  const ids = await g.ask(p, { kind: 'choose-cards', from: from.map(o => o.id), count: n, reason, exact: true }) as number[];
  const out: GameObject[] = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, n)) { const o = from.find(x => x.id === id); if (o) out.push(o); }
  return out.length ? out : from.slice(0, n);
}

/** Put the top card of `p`'s library onto the battlefield face down as a 2/2 (CR 701.36a); returns it, or undefined. */
async function manifestTop(c: OpCtx, p: PlayerId, card?: GameObject): Promise<GameObject | undefined> {
  const o = card ?? c.s.players[p].library[0];
  if (!o) return undefined;
  o.faceDown = true;                                     // exactly what `Game.opMove`'s `e.faceDown` branch does
  if (!(await c.g.enterBattlefield(o, { controller: p, via: 'effect', item: c.item }))) { delete o.faceDown; return undefined; }
  extSet(o, 'manifested', true);
  return o;
}

/** Total mana value of `list` (CR 202.3: a card's mana value in a graveyard is its printed one). */
const totalMv = (list: GameObject[]): number => list.reduce((n, o) => n + chars.manaValueOf(o), 0);

/** The cheapest set of `list` whose total mana value reaches `n`, taking the largest first; empty when it cannot. */
function evidenceSet(list: GameObject[], n: number): GameObject[] {
  const sorted = [...list].sort((a, b) => chars.manaValueOf(b) - chars.manaValueOf(a));
  const out: GameObject[] = [];
  for (const o of sorted) { if (totalMv(out) >= n) break; out.push(o); }
  return totalMv(out) >= n ? out : [];
}

/** Pay "collect evidence N" (CR 701.62a): exile a chosen set from your graveyard with total mana value ≥ N. */
async function collectEvidence(g: Game, p: PlayerId, n: number, label: string): Promise<boolean> {
  const yard = g.state.players[p].graveyard;
  const need = evidenceSet(yard, n);
  if (!need.length) return false;
  const chosen = await pick(g, p, yard, need.length, `${label}: collect evidence ${n}`);
  const use = totalMv(chosen) >= n ? chosen : need;
  for (const o of use) g.moveTo(o, 'exile', 'top', 'exile');
  announce(g, p, 'collect-evidence', `${g.pname(p)} collects evidence ${n} (exiles ${use.map(o => chars.name(o)).join(', ')}).`, undefined, n);
  return true;
}

/** Can "forage" (CR 701.57a) be done right now: three cards in your graveyard, or a Food to sacrifice? */
function forageOptions(s: GameState, p: PlayerId): { yard: boolean; food: GameObject | undefined } {
  const pl = s.players[p];
  return { yard: pl.graveyard.length >= 3, food: chars.battlefieldOf(s, p).find(o => o.token?.food === true) };
}
/** Pay "forage": exile three cards from your graveyard, or sacrifice a Food (you choose when both are open). */
async function forage(g: Game, p: PlayerId, label: string): Promise<boolean> {
  const { yard, food } = forageOptions(g.state, p);
  if (!yard && !food) return false;
  let useFood = !yard;
  if (yard && food) useFood = (await g.ask(p, { kind: 'choose-option', options: ['exile three cards from your graveyard', 'sacrifice a Food'], reason: `${label}: forage` })) === 'sacrifice a Food';
  if (useFood && food) g.sacrifice(food);
  else { const three = await pick(g, p, g.state.players[p].graveyard, 3, `${label}: forage (exile three cards)`); for (const o of three) g.moveTo(o, 'exile', 'top', 'exile'); }
  announce(g, p, 'forage', `${g.pname(p)} forages.`);
  g.queueTriggers('forages', { player: p });
  return true;
}

/** The cards a "behold a <filter>" (CR 701.63a) may be paid with: matching cards in hand, matching permanents you control. */
function beholdOptions(s: GameState, p: PlayerId, what: Filter, src: GameObject): GameObject[] {
  return [...s.players[p].hand, ...chars.battlefieldOf(s, p)].filter(o => chars.matchesFilter(s, o, what, src));
}
/** Pay "behold": reveal a matching card from your hand or choose a matching permanent you control. */
async function behold(g: Game, p: PlayerId, what: Filter, src: GameObject, label: string): Promise<boolean> {
  const opts = beholdOptions(g.state, p, what, src);
  if (!opts.length) return false;
  const [o] = await pick(g, p, opts, 1, `${label}: behold`);
  if (!o) return false;
  if (o.zone === 'hand') g.emit({ type: 'library', player: p, action: 'reveal', cards: [chars.name(o)] }, `${g.pname(p)} beholds ${chars.name(o)} from their hand.`);
  else announce(g, p, 'behold', `${g.pname(p)} beholds ${chars.name(o)}.`, o);
  return true;
}

/**
 * Every `ext` key this family writes on a PERMANENT. CR 400.7: an object that leaves the battlefield becomes a *new*
 * object that remembers nothing about the old one, so the `leave` hook below deletes every one of them — the same
 * reset the core does two lines above its own `LEAVE_HOOKS` call for `setPT`, `lost`, `damagedBy` and `counters`.
 * Without it a bounced-and-recast creature stays monstrous (CR 701.31b: it could never become monstrous again),
 * suspected (CR 701.61a: it could never block again and would keep menace forever), harnessed, cloaked, manifested
 * or goaded.
 */
const PERMANENT_EXT = ['monstrous', 'suspected', 'harnessed', 'goadedBy', 'goadedTurn', 'manifested', 'cloaked', 'clashWon'] as const;

/**
 * CR 701.56a: a discovered card is CAST for free or PUT INTO YOUR HAND — it is never left behind in exile. The cast
 * half is a free-play window (an op cannot cast during its own resolution the way the core's `cascade` does), and a
 * window nobody used would strand the card, so the card is remembered here and the family's `cleanup-end` step puts
 * it into its owner's hand when the turn it was discovered on ends: the other outcome CR 701.56a allows, never a
 * card lost to exile. `{ id, turn }` is JSON-plain, so it clones and serializes like any other ext value.
 */
interface DiscoverPending { [k: string]: number; id: number; turn: number }
const DISCOVER_PENDING = 'kaDiscoverPending';

/** The Incubator token (CR 701.54a): a colorless artifact with "{2}: Transform this artifact." */
const INCUBATOR_INDEX = -91;
function two(): ManaCost { return { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' }; }

// ------------------------------------------------------------------ 4. the module

const KEYWORD_ACTION: FamilyModule = {
  name: 'keyword-action',

  effects: {
    // ---- CR 701.20a: "investigate" is defined as "create a Clue token", so it recurses into the core token op.
    'investigate': async (e: KaInvestigate, c) => {
      const n = c.amt(e.amount); if (n <= 0) return;
      await c.apply({ op: 'token', count: n, power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Clue'], keywords: [], name: 'Clue', clue: true });
    },

    // ---- CR 701.34a: the creature you control with the least toughness (you choose among ties) gets the counters.
    'bolster': async (e: KaBolster, c) => {
      const n = c.amt(e.amount); if (n <= 0) return;
      const mine = chars.battlefieldOf(c.s, c.p).filter(o => chars.isCreature(o));
      if (!mine.length) return;
      const least = Math.min(...mine.map(o => chars.toughness(c.s, o)));
      const [o] = await pick(c.g, c.p, mine.filter(x => chars.toughness(c.s, x) === least), 1, `${c.item.name}: bolster ${n}`);
      if (!o) return;
      c.g.addCounters(o, '+1/+1', n);
      bind(c, [o]);
      announce(c.g, c.p, 'bolster', `${c.g.pname(c.p)} bolsters ${n}: ${chars.name(o)} gets ${n} +1/+1 counter${n > 1 ? 's' : ''}.`, o, n);
    },

    // ---- CR 701.33a: a counter on each of up to N (other) target creatures. The count lives on the target spec.
    'support': (e: KaSupport, c) => {
      const list = c.objs().filter(o => o.zone === 'battlefield');
      if (!list.length) return;
      for (const o of list) c.g.addCounters(o, '+1/+1', 1);
      bind(c, list);
      announce(c.g, c.p, 'support', `${c.g.pname(c.p)} supports ${e.amount}: ${list.map(o => chars.name(o)).join(', ')} each get a +1/+1 counter.`, undefined, e.amount);
    },

    // ---- CR 701.42a: adapt does nothing while the creature already has a +1/+1 counter.
    'adapt': (e: KaAdapt, c) => {
      const n = c.amt(e.amount); if (n <= 0 || c.src.zone !== 'battlefield') return;
      if ((c.src.counters['+1/+1'] ?? 0) > 0) { c.g.note(`${chars.name(c.src)} does not adapt (it already has a +1/+1 counter).`); return; }
      c.g.addCounters(c.src, '+1/+1', n);
      announce(c.g, c.p, 'adapt', `${chars.name(c.src)} adapts ${n}.`, c.src, n);
    },

    // ---- CR 701.31a: monstrosity does nothing once the permanent is already monstrous; becoming monstrous triggers.
    'monstrosity': (e: KaMonstrosity, c) => {
      const n = c.amt(e.amount); if (c.src.zone !== 'battlefield') return;
      if (extGet<boolean>(c.src, 'monstrous') === true) { c.g.note(`${chars.name(c.src)} is already monstrous.`); return; }
      if (n > 0) c.g.addCounters(c.src, '+1/+1', n);
      extSet(c.src, 'monstrous', true);
      announce(c.g, c.p, 'monstrosity', `${chars.name(c.src)} becomes monstrous (monstrosity ${n}).`, c.src, n);
      c.g.queueTriggers('monstrous', { obj: c.src, player: c.p, amount: n });
    },

    // ---- CR 701.36a: the top card of your library becomes a face-down 2/2 creature.
    'manifest': async (e: KaManifest, c) => {
      const n = c.amt(e.amount); if (n <= 0) return;
      const made: GameObject[] = [];
      for (let i = 0; i < n; i++) { const o = await manifestTop(c, c.p); if (!o) break; made.push(o); }
      if (!made.length) return;
      bind(c, made);
      announce(c.g, c.p, 'manifest', `${c.g.pname(c.p)} manifests ${made.length} card${made.length > 1 ? 's' : ''}.`, made[0], made.length);
    },

    // ---- CR 701.59a: look at the top two, manifest one, the other goes to the graveyard.
    'manifest-dread': async (_e: KaManifestDread, c) => {
      const lib = c.s.players[c.p].library;
      const top = lib.slice(0, 2); if (!top.length) return;
      c.g.emit({ type: 'library', player: c.p, action: 'look', cards: top.map(o => chars.name(o)) }, `${c.g.pname(c.p)} looks at the top ${top.length} card${top.length > 1 ? 's' : ''} of their library (manifest dread).`);
      const [keep] = await pick(c.g, c.p, top, 1, `${c.item.name}: manifest dread — manifest which card?`);
      if (!keep) return;
      for (const o of top) if (o !== keep) c.g.moveTo(o, 'graveyard', 'top', 'effect');
      const made = await manifestTop(c, c.p, keep);
      if (!made) return;
      bind(c, [made]);
      announce(c.g, c.p, 'manifest-dread', `${c.g.pname(c.p)} manifests dread.`, made);
    },

    // ---- CR 701.58a: cloak is manifest plus the cloaked marker (ward {2} is not simulated — see the family doc).
    'cloak': async (_e: KaCloak, c) => {
      const o = await manifestTop(c, c.p); if (!o) return;
      extSet(o, 'cloaked', true);
      bind(c, [o]);
      announce(c.g, c.p, 'cloak', `${c.g.pname(c.p)} cloaks the top card of their library.`, o);
    },

    // ---- CR 701.29a: copy a creature token you control (a token's copiable values are its own TokenSpec).
    'populate': async (_e: KaPopulate, c) => {
      const toks = chars.battlefieldOf(c.s, c.p).filter(o => o.token !== null && chars.isCreature(o));
      if (!toks.length) return;
      const [o] = await pick(c.g, c.p, toks, 1, `${c.item.name}: populate`);
      const t: TokenSpec | null = o ? o.token : null; if (!t) return;
      await c.apply({
        op: 'token', count: 1, power: t.power, toughness: t.toughness, colors: [...t.colors], types: [...t.types] as CardType[],
        subtypes: [...t.subtypes], keywords: [...t.keywords], name: t.name,
        ...(t.treasure ? { treasure: true } : {}), ...(t.clue ? { clue: true } : {}), ...(t.spawn ? { spawn: true } : {}), ...(t.food ? { food: true } : {}),
        ...(t.dynamicPT === undefined ? {} : { dynamicPT: t.dynamicPT }),
      });
      c.g.note(`${c.g.pname(c.p)} populates (copies ${t.name}).`);
    },

    // ---- CR 701.39a: goad is recorded (and expires at the start of the goader's next turn); see the doc's gaps.
    'goad': async (e: KaGoad, c) => {
      const list = (await objectsOf(c, e.target)).filter(o => o.zone === 'battlefield');
      if (!list.length) return;
      for (const o of list) { extSet(o, 'goadedBy', c.p); extSet(o, 'goadedTurn', c.s.turn); }
      bind(c, list);
      announce(c.g, c.p, 'goad', `${list.map(o => chars.name(o)).join(', ')} ${list.length > 1 ? 'are' : 'is'} goaded by ${c.g.pname(c.p)} until their next turn.`, list[0]);
    },

    // ---- CR 701.54a: Incubator tokens, each with N +1/+1 counters; "{2}: Transform" lives in `tokenAbilities`.
    'incubate': async (e: KaIncubate, c) => {
      const n = c.amt(e.amount); const k = e.count === undefined ? 1 : c.amt(e.count);
      if (k <= 0) return;
      const made: GameObject[] = [];
      for (let i = 0; i < k; i++) {
        await c.apply({ op: 'token', count: 1, power: 0, toughness: 0, colors: [], types: ['Artifact'], subtypes: ['Incubator'], keywords: [], name: 'Incubator' });
        for (const a of c.item.affected ?? []) { const o = chars.findObject(c.s, a.id); if (!o) continue; extSet(o, 'tokenAbility', 'Incubator'); if (n > 0) c.g.addCounters(o, '+1/+1', n); made.push(o); }
      }
      if (!made.length) return;
      bind(c, made);
      announce(c.g, c.p, 'incubate', `${c.g.pname(c.p)} incubates ${n}${k > 1 ? ` ${k} times` : ''}.`, made[0], n);
    },

    // ---- CR 701.48a: draw N, discard N, then a +1/+1 counter for each nonland card discarded this way. The draw and
    // the discard belong to the permanent's controller and happen even when the permanent has already left the
    // battlefield (killed in response to the connive trigger); only the counters are lost with it.
    'connive': async (e: KaConnive, c) => {
      const n = c.amt(e.amount); if (n <= 0) return;
      const list = await objectsOrLastKnown(c, e.target);
      if (!list.length) return;
      for (const o of list) {
        const w = ownerOf(o);
        for (let i = 0; i < n; i++) await c.g.draw(w);
        const hand = c.s.players[w].hand;
        const toss = await pick(c.g, w, hand, Math.min(n, hand.length), `${c.item.name}: connive ${n} — discard`);
        let nonland = 0;
        for (const card of toss) { if (!chars.isLand(card)) nonland++; c.g.discard(w, card.id); }
        const gone = o.zone !== 'battlefield';
        if (nonland > 0 && !gone) c.g.addCounters(o, '+1/+1', nonland);
        announce(c.g, w, 'connive', `${chars.name(o)} connives ${n}: ${gone ? 'it has left the battlefield, so no counters' : `${nonland} +1/+1 counter${nonland === 1 ? '' : 's'}`}.`, o, n);
        c.g.queueTriggers('connives', { obj: o, player: w, amount: nonland });
      }
      bind(c, list);
    },

    // ---- CR 701.50a: "you may discard a card. If you do, draw a card." (the Lesson sideboard is out of scope).
    'learn': async (_e: KaLearn, c) => { await c.apply({ op: 'loot', draw: 1, discard: 1, discardFirst: true, optional: true }); },

    // ---- CR 701.56a: exile from the top until a nonland card with mana value ≤ N, then CAST IT FOR FREE OR PUT IT
    // INTO YOUR HAND (the discovering player chooses; the card is never left in exile), and CR 701.56b: the cards
    // that were not taken go to the BOTTOM IN A RANDOM ORDER, so the bottom of the library does not become known.
    'discover': async (e: KaDiscover, c) => {
      const n = c.amt(e.amount); const pl = c.s.players[c.p];
      const exiled: GameObject[] = []; let hit: GameObject | undefined;
      while (pl.library.length) {
        const card = pl.library[0];
        c.g.moveTo(card, 'exile', 'top', 'exile'); exiled.push(card);
        if (!chars.isLand(card) && chars.manaValueOf(card) <= n) { hit = card; break; }
      }
      if (!exiled.length) return;
      let took = '';
      if (hit) {
        bind(c, [hit]);
        const cast = `cast ${chars.name(hit)} without paying its mana cost`, hand = `put ${chars.name(hit)} into your hand`;
        if (await c.g.ask(c.p, { kind: 'choose-option', options: [cast, hand], reason: `${c.item.name}: discover ${n}` }) === hand) {
          c.g.moveTo(hit, 'hand', 'top', 'effect');
          took = ` and puts ${chars.name(hit)} into their hand`;
        } else {
          // The free cast is a play window for the turn (an op cannot cast during its own resolution); if it goes
          // unused the `cleanup-end` sweep below hands the card to its owner, so nothing is stranded in exile.
          await c.apply({ op: 'play-exiled', until: 'eot', free: true });
          extPush<DiscoverPending>(c.s, DISCOVER_PENDING, { id: hit.id, turn: c.s.turn });
          took = ` and may cast ${chars.name(hit)} for free this turn`;
        }
      }
      const rest = exiled.filter(x => x !== hit);
      c.g.rng.shuffle(rest);                                          // CR 701.56b — exactly what the core's cascade does
      for (const card of rest) c.g.moveTo(card, 'library', 'bottom', 'tuck');
      announce(c.g, c.p, 'discover', `${c.g.pname(c.p)} discovers ${n}: exiles ${exiled.length} card${exiled.length === 1 ? '' : 's'}${took}.`, hit, n);
      c.g.queueTriggers('discovers', { player: c.p, amount: n });
    },

    // ---- CR 701.57a. Nothing is emitted when it cannot be done, so a following `reflexive` correctly does not fire.
    'forage': async (_e: KaForage, c) => { await forage(c.g, c.p, c.item.name); },

    // ---- CR 701.19a: you and an opponent each reveal the top card and keep it there or put it on the bottom.
    'clash': async (_e: KaClash, c) => {
      const { opponentsOf } = await import('../players.js');
      const opps = opponentsOf(c.s, c.p); if (!opps.length) return;
      extDel(c.src, 'clashWon');
      const foe = opps.length === 1 ? opps[0] : await c.g.ask(c.p, { kind: 'choose-player', options: opps, reason: `${c.item.name}: clash with which opponent?` }) as PlayerId;
      const mine = c.s.players[c.p].library[0]; const theirs = c.s.players[foe].library[0];
      c.g.emit({ type: 'library', player: c.p, action: 'reveal', cards: mine ? [chars.name(mine)] : [] });
      c.g.emit({ type: 'library', player: foe, action: 'reveal', cards: theirs ? [chars.name(theirs)] : [] });
      const won = (mine ? chars.manaValueOf(mine) : -1) > (theirs ? chars.manaValueOf(theirs) : -1);
      if (won) extSet(c.src, 'clashWon', true);
      for (const [who, card] of [[c.p, mine], [foe, theirs]] as [PlayerId, GameObject | undefined][]) {
        if (!card) continue;
        if (await c.g.ask(who, { kind: 'yes-no', prompt: `Clash: put ${chars.name(card)} on the bottom of your library?`, tag: 'optional' })) c.g.moveTo(card, 'library', 'bottom', 'tuck');
      }
      c.g.emit({ type: 'clash', player: c.p, opponent: foe, yours: mine ? chars.name(mine) : '(no card)', theirs: theirs ? chars.name(theirs) : '(no card)', won });
      c.g.queueTriggers('clash', { player: c.p, obj: c.src });
    },

    // ---- CR 701.38a: an exerted creature doesn't untap during its controller's next untap step.
    'exert': async (e: KaExert, c) => {
      const list = (await objectsOf(c, e.target)).filter(o => o.zone === 'battlefield');
      if (!list.length) return;
      for (const o of list) o.noUntapNext = true;                    // the field `Game`'s own `tap … noUntap` branch sets
      bind(c, list);
      announce(c.g, c.p, 'exert', `${c.g.pname(c.p)} exerts ${list.map(o => chars.name(o)).join(', ')}.`, list[0]);
      c.g.queueTriggers('exerts', { player: c.p, obj: list[0] });
    },

    // ---- CR 701.62a: exile cards with total mana value N or greater from your graveyard.
    'collect-evidence': async (e: KaCollectEvidence, c) => { await collectEvidence(c.g, c.p, c.amt(e.amount), c.item.name); },

    // ---- CR 701.64a: its controller chooses N +1/+1 counters on it, or an N/N white Spirit token. The choice is the
    // controller's even when the creature has already left the battlefield: the Spirit mode still works, so it is
    // then the only mode left (there is nothing to put the counters on any more).
    'endure': async (e: KaEndure, c) => {
      const n = c.amt(e.amount); if (n <= 0) return;
      const list = await objectsOrLastKnown(c, e.target);
      if (!list.length) return;
      for (const o of list) {
        const w = ownerOf(o); const gone = o.zone !== 'battlefield';
        const counters = `put ${n} +1/+1 counter${n > 1 ? 's' : ''} on ${chars.name(o)}`;
        const token = `create a ${n}/${n} white Spirit creature token`;
        const choice = gone ? token : await c.g.ask(w, { kind: 'choose-option', options: [counters, token], reason: `${c.item.name}: endure ${n}` });
        if (choice === token) await c.apply({ op: 'token', count: 1, power: n, toughness: n, colors: ['W'], types: ['Creature'], subtypes: ['Spirit'], keywords: [], name: 'Spirit' });
        else c.g.addCounters(o, '+1/+1', n);
        announce(c.g, w, 'endure', `${chars.name(o)} endures ${n}${gone ? ' (it has left the battlefield: only the Spirit mode is left)' : ''}.`, o, n);
      }
    },

    // ---- CR 701.61a: a suspected creature has menace and can't block (see keywordHooks below).
    'suspect': async (e: KaSuspect, c) => {
      const list = (await objectsOf(c, e.target)).filter(o => o.zone === 'battlefield');
      if (!list.length) return;
      for (const o of list) extSet(o, 'suspected', true);
      bind(c, list);
      announce(c.g, c.p, 'suspect', `${list.map(o => chars.name(o)).join(', ')} ${list.length > 1 ? 'become' : 'becomes'} suspected.`, list[0]);
    },

    // ---- CR 701.63a: reveal a matching card from your hand, or choose a matching permanent you control.
    'behold': async (e: KaBehold, c) => { await behold(c.g, c.p, e.what, c.src, c.item.name); },

    // ---- CR 701.52a: each named player chooses one of the two modes; the chosen mode runs with them as "that player".
    'villainous-choice': async (e: KaVillainousChoice, c) => {
      const { resolveWho } = await import('../refs.js');
      const rc = { s: c.s, item: c.item, p: c.p, src: c.src };
      const who: PlayerId[] = e.who === 'target' ? c.players() : resolveWho(rc, e.who === 'that-player' ? 'that-player' : 'each-opponent', c.T);
      if (!who.length || e.modes.length < 2) return;
      const labels = e.modes.map((m, i) => `${i === 0 ? 'first' : 'second'}: ${m.map(x => x.op).join(', ')}`);
      const saved = c.item.triggeringPlayer;
      for (const w of who) {
        const answer = await c.g.ask(w, { kind: 'choose-option', options: labels, reason: `${c.item.name}: villainous choice` });
        const k = Math.max(0, labels.indexOf(typeof answer === 'string' ? answer : labels[0]));
        c.item.triggeringPlayer = w;                                  // so `that-player` inside the mode is the chooser
        announce(c.g, w, 'villainous-choice', `${c.g.pname(w)} faces a villainous choice and takes the ${k === 0 ? 'first' : 'second'} option.`);
        for (const eff of e.modes[k]) await c.apply(eff);
      }
      c.item.triggeringPlayer = saved;
    },

    // ---- CR 702.110a: you may sacrifice a creature; if you do, this creature "exploits" it. The exploit trigger is on
    // the stack independently of its source (CR 603.4), so the sacrifice still happens when the exploiting creature
    // has already left the battlefield, and the "when this exploits a creature" half still fires.
    'exploit': async (_e: KaExploit, c) => {
      const mine = chars.battlefieldOf(c.s, c.p).filter(o => chars.isCreature(o));
      if (!mine.length) return;
      if (!(await c.g.ask(c.p, { kind: 'may', prompt: `${chars.name(c.src)}: sacrifice a creature (exploit)?`, source: c.item.name }))) return;
      const [victim] = await pick(c.g, c.p, mine, 1, `${c.item.name}: exploit — sacrifice which creature?`);
      if (!victim) return;
      const gone = entry(c.s, victim); const victimName = chars.name(victim);
      c.g.sacrifice(victim);
      c.item.affected = [gone];                                      // "the exploited creature" for a script that reads it
      c.g.emit({ type: 'exploits', id: c.src.id, name: chars.name(c.src), sacrificed: victimName, player: c.p });
      c.g.queueTriggers('exploits', { obj: c.src, player: c.p });
    },

    // ---- Marvel Infinity Stones: harnessing a permanent turns its ∞ ability on.
    'harness': async (e: KaHarness, c) => {
      const list = (await objectsOf(c, e.target)).filter(o => o.zone === 'battlefield');
      if (!list.length) return;
      for (const o of list) extSet(o, 'harnessed', true);
      bind(c, list);
      announce(c.g, c.p, 'harness', `${list.map(o => chars.name(o)).join(', ')} ${list.length > 1 ? 'are' : 'is'} harnessed.`, list[0]);
    },
  },

  conditions: {
    'monstrous': (_c: KaMonstrousCond, _s, src) => extGet<boolean>(src, 'monstrous') === true,
    'harnessed': (_c: KaHarnessedCond, _s, src) => extGet<boolean>(src, 'harnessed') === true,
    'suspected': (_c: KaSuspectedCond, _s, src) => extGet<boolean>(src, 'suspected') === true,
    'clash-won': (_c: KaClashWonCond, _s, src) => extGet<boolean>(src, 'clashWon') === true,
  },

  amounts: {
    // "endure X, where X is the number of counters on ~" — every counter kind, which `counters-on-source` cannot say.
    'counters-on-source-any': (_a, _s, _ctrl, _x, src) => { let n = 0; if (src) for (const k in src.counters) n += src.counters[k] ?? 0; return n; },
  },

  triggers: {
    'exploits': (ev: KaExploitsTrig, perm, ctx, _s, event) => event === 'exploits' && (ev.self ? ctx.obj === perm : ctx.player === perm.controller),
    'clash': (_ev: KaClashTrig, perm, ctx, _s, event) => event === 'clash' && ctx.player === perm.controller,
    'connives': (ev: KaConnivesTrig, perm, ctx, _s, event) => event === 'connives' && (ev.self ? ctx.obj === perm : ctx.player === perm.controller),
    'exerts': (_ev: KaExertsTrig, perm, ctx, _s, event) => event === 'exerts' && ctx.player === perm.controller,
    'discovers': (_ev: KaDiscoversTrig, perm, ctx, _s, event) => event === 'discovers' && ctx.player === perm.controller,
    'forages': (_ev: KaForagesTrig, perm, ctx, _s, event) => event === 'forages' && ctx.player === perm.controller,
    'monstrous': (ev: KaMonstrousTrig, perm, ctx, _s, event) => event === 'monstrous' && (ev.self ? ctx.obj === perm : ctx.player === perm.controller),
  },

  costParts: {
    // "As an additional cost to cast this spell, collect evidence 6." / "{1}{W}, Collect evidence 3: …"
    collectEvidence: {
      payable: (v, s, pl) => evidenceSet(s.players[pl.id].graveyard, v as number).length > 0,
      pay: async (v, g, p, self, label) => collectEvidence(g, p, v as number, label || chars.name(self)),
    },
    // "{T}, Forage:" / "Kicker—Forage." / "As an additional cost to cast this spell, forage."
    forage: {
      payable: (_v, s, pl) => { const o = forageOptions(s, pl.id); return o.yard || o.food !== undefined; },
      pay: async (_v, g, p, self, label) => forage(g, p, label || chars.name(self)),
    },
    // "As an additional cost to cast this spell, behold a Dragon."
    beholdWhat: {
      payable: (v, s, pl, self) => beholdOptions(s, pl.id, v as Filter, self).length > 0,
      pay: async (v, g, p, self, label) => behold(g, p, v as Filter, self, label || chars.name(self)),
    },
    // "{1}{W}, {T}, Exert this creature: …" (CR 701.38b: exerting is part of the cost, not an effect).
    exertSelf: {
      payable: (_v, _s, _pl, self) => self.zone === 'battlefield' && !self.noUntapNext,
      pay: async (_v, g, p, self) => {
        if (self.zone !== 'battlefield') return false;
        self.noUntapNext = true;
        announce(g, p, 'exert', `${g.pname(p)} exerts ${chars.name(self)}.`, self);
        g.queueTriggers('exerts', { player: p, obj: self });
        return true;
      },
    },
  },

  // CR 400.7: an object that leaves the battlefield is a NEW object with no memory of the old one, so every marker
  // this family wrote on the permanent dies with it - the same reset the core does for `setPT`, `lost`, `damagedBy`
  // and `counters` around this very hook. Without it a bounced, blinked or reanimated creature comes back monstrous
  // (CR 701.31b: monstrosity could never fire again), suspected (CR 701.61a: unable to block and permanently menacing),
  // harnessed (an Infinity Stone's `intervening: harnessed` ability stays switched on), cloaked, manifested or goaded.
  leave: (_g, o, zone) => {
    if (zone === 'battlefield' || o.ext === undefined) return;   // battlefield-to-battlefield is the same object
    for (const k of PERMANENT_EXT) extDel(o, k);
  },

  steps: {
    // Goad lasts "until your next turn" (CR 701.39a): it ends as the goader's next turn begins.
    'turn-start': (g, ap) => {
      for (const o of chars.allPermanents(g.state)) {
        if (extGet<number>(o, 'goadedBy') !== ap) continue;
        if (g.state.turn <= extGetOr<number>(o, 'goadedTurn', g.state.turn)) continue;
        extDel(o, 'goadedBy'); extDel(o, 'goadedTurn');
        g.note(`${chars.name(o)} is no longer goaded.`);
      }
    },
    // CR 701.56a: a discovered card is cast or put into its owner's hand - never left in exile. A free-cast window
    // that expired unused resolves to the other half of that choice as the turn it opened on ends.
    'cleanup-end': (g) => {
      const pending = extGet<DiscoverPending[]>(g.state, DISCOVER_PENDING);
      if (pending === undefined) return;
      const keep: DiscoverPending[] = [];
      for (const d of pending) {
        if (d.turn > g.state.turn) { keep.push(d); continue; }     // a window that has not closed yet (never today)
        const o = chars.findObject(g.state, d.id);
        if (o === undefined || o.zone !== 'exile') continue;        // cast, or moved on by something else
        delete o.castableFromExile;
        g.moveTo(o, 'hand', 'top', 'return');
        g.note(`${chars.name(o)} was discovered and not cast, so it goes to its owner's hand.`);
      }
      if (keep.length) extSet<DiscoverPending[]>(g.state, DISCOVER_PENDING, keep); else extDel(g.state, DISCOVER_PENDING);
    },
  },

  keywordHooks: {
    // CR 701.61a: a suspected creature can't block.
    canBlock: (_s, blocker) => extGet<boolean>(blocker, 'suspected') === true ? false : undefined,
    // …and it has menace, which only a finished declaration can judge (CR 702.110b), exactly as the core does.
    blockFixup: (g, attackers) => {
      for (const a of attackers) {
        if (extGet<boolean>(a, 'suspected') !== true || a.blockedBy.length !== 1) continue;
        const b = chars.findObject(g.state, a.blockedBy[0]);
        a.blockedBy = [];
        if (b) { b.blocking = b.blocking.filter(id => id !== a.id); g.note(`${chars.name(b)} can't block ${chars.name(a)} alone (suspected — menace).`); }
      }
    },
  },

  tokenAbilities: {
    // CR 701.54a: "{2}: Transform this artifact." The Incubator's back face is a 0/0 Phyrexian artifact creature.
    Incubator: {
      index: INCUBATOR_INDEX,
      legal: (g, p, o) => o.token !== null && !o.token.types.includes('Creature') && g.findPayment(g.state.players[p], two())
        ? { action: { type: 'activate', objectId: o.id, abilityIndex: INCUBATOR_INDEX }, label: 'transform Incubator', manaValue: 2 } : null,
      async activate(g, p, o) {
        const t = o.token; if (!t || t.types.includes('Creature')) return false;
        const pay = g.findPayment(g.state.players[p], two()); if (!pay) return false;
        g.payMana(g.state.players[p], pay);
        o.token = { ...t, name: 'Phyrexian', types: ['Artifact', 'Creature'], subtypes: ['Phyrexian'], power: 0, toughness: 0 };
        g.state.bfGen = (g.state.bfGen ?? 0) + 1; g.state.version++;
        announce(g, p, 'incubate-transform', `${g.pname(p)} transforms an Incubator into a Phyrexian artifact creature.`, o);
        return true;
      },
    },
  },

  events: {
    'exploits': { logged: true, cr: '702.110a', render: (ev) => { const e = ev as KaExploitsEvent; return `${e.name} exploits ${e.sacrificed}.`; } },
    'clash': { logged: true, cr: '701.19a', render: (ev, pname) => { const e = ev as KaClashEvent; return `${pname(e.player)} clashes with ${pname(e.opponent)}: ${e.yours} vs ${e.theirs} — ${e.won ? 'won' : 'did not win'}.`; } },
    'keyword-action': { logged: true, cr: '701', render: (ev, pname) => { const e = ev as KaKeywordActionEvent; return `${pname(e.player)}: ${e.action}${e.name ? ` (${e.name})` : ''}${e.amount === undefined ? '' : ` ${e.amount}`}.`; } },
  },

  render: {
    'investigate': (e: KaInvestigate) => e.amount === 1 ? 'Investigate' : e.amount === 2 ? 'Investigate twice' : `Investigate ${amtText(e.amount)} times`,
    'bolster': (e: KaBolster) => `Bolster ${amtText(e.amount)}`,
    'support': (e: KaSupport) => `Support ${e.amount}`,
    'adapt': (e: KaAdapt) => `Adapt ${amtText(e.amount)}`,
    'monstrosity': (e: KaMonstrosity) => `Monstrosity ${amtText(e.amount)}`,
    'manifest': (e: KaManifest) => e.amount === 1 ? 'Manifest the top card of your library' : `Manifest the top ${amtText(e.amount)} cards of your library`,
    'manifest-dread': () => 'Manifest dread',
    'cloak': () => 'Cloak the top card of your library',
    'populate': () => 'Populate',
    'goad': (e: KaGoad) => `Goad ${targetText(e.target)}`,
    'incubate': (e: KaIncubate) => `Incubate ${amtText(e.amount)}${e.count === undefined || e.count === 1 ? '' : ` ${amtText(e.count)} times`}`,
    'connive': (e: KaConnive) => `${targetText(e.target, true)} connives ${amtText(e.amount)}`,
    'learn': () => 'Learn',
    'discover': (e: KaDiscover) => `Discover ${amtText(e.amount)}`,
    'forage': () => 'Forage',
    'clash': () => 'Clash with an opponent',
    'exert': (e: KaExert) => `Exert ${targetText(e.target)}`,
    'collect-evidence': (e: KaCollectEvidence) => `Collect evidence ${amtText(e.amount)}`,
    'endure': (e: KaEndure) => `${targetText(e.target, true)} endures ${amtText(e.amount)}`,
    'suspect': (e: KaSuspect) => `Suspect ${targetText(e.target)}`,
    'behold': (e: KaBehold) => `Behold ${filterText(e.what)}`,
    'villainous-choice': (e: KaVillainousChoice) => `${e.who === 'each-opponent' ? 'Each opponent' : 'That player'} faces a villainous choice`,
    'exploit': () => 'Exploit',
    'harness': (e: KaHarness) => `Harness ${targetText(e.target)}`,
  },
};

/** An Amount as the round-trip renderer prints it ("3", "X", "the number of …" is left as X). */
function amtText(a: Amount): string { return typeof a === 'number' ? String(a) : typeof a === 'string' ? a : 'X'; }
/** A target as the renderer prints it: `self` is "this creature", a Ref is "that creature", a spec is "target …". */
function targetText(t: TargetSpec | Ref, subject = false): string {
  const cap = (x: string) => subject ? x.slice(0, 1).toUpperCase() + x.slice(1) : x;
  if (typeof t === 'string') return cap(t === 'self' ? 'this creature' : 'that creature');
  if (t.self) return cap('this creature');
  const many = typeof t.count === 'number' && t.count > 1;
  const upTo = t.count === undefined ? '' : t.count === 'X' ? 'up to X ' : many ? `up to ${t.count} ` : '';
  return cap(`${upTo}target ${t.filter?.other ? 'other ' : ''}creature${many || t.count === 'X' ? 's' : ''}`);
}
/** A filter as "a Dragon" / "an Elf" — enough for the behold wordings, which always name one subtype. */
function filterText(f: Filter): string {
  const word = f.subtypes?.[0] ?? f.types?.[0] ?? 'permanent';
  return `${/^[AEIOU]/.test(word) ? 'an' : 'a'} ${word}`;
}

export default KEYWORD_ACTION;
