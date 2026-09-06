// Piles, votes and choices somebody other than the controller makes (Phase 9.1; docs/vocabulary/piles-choices.md).
//
// Five shapes of "somebody chooses" that the core AST has no verb for:
//
//   * modal choices the core `choose-mode` cannot express — "Choose three", "Choose X", "You may choose the same mode
//     more than once" (CR 700.2d), "choose one that hasn't been chosen this turn", "An opponent chooses one" (CR
//     700.2e) and the pawprint budget "Choose up to five {P} worth of modes" (CR 700.2i);
//   * votes (CR 701.38) — will of the council (the majority wins) and council's dilemma (every vote counts), plus
//     "While voting, you may vote an additional time" (CR 701.38d);
//   * piles (CR 700.3) — one player separates a set of objects into piles, another chooses one of them;
//   * "an opponent chooses N of those cards" and "for each player, you choose …" (CR 608.2f, 101.4), with the
//     chosen / unchosen split acted on afterwards;
//   * Class levels (CR 716.2) — a level is a designation on the permanent, NOT a counter (716.4), so it lives in
//     `o.ext.pcLevel` and a permanent with no level reads as level 1 (716.2d).
//
// Everything the family remembers is public information — piles of revealed cards, the modes a permanent has already
// chosen, a Class's level, who was chosen — so no `redact` hook is needed; the `ext` bag is JSON-plain throughout.
// "Public" is a claim the family has to MAKE, not assume: a card in a library or a hand is blanked by `redact`
// (src/engine/view.ts) for every hidden-information agent unless its id is on `state.knowledge`, and the shipped
// human/UI agent is one (`DeferredAgent.hidden`). So `reveal-cards` and `separate-piles` record the set they show as
// publicly known (CR 701.20a), which is what lets the opponent Fact or Fiction asks to split the pile see it.
//
// Cross-effect state. `separate-piles` / `choose-objects` / `choose-for-each-player` record their result on the
// SOURCE (`src.ext.pcPiles` / `pcChosen` / `pcUnchosen`) as well as binding `those`, because the printed English puts
// the choice and its consequence in different sentences ("An opponent chooses one of those piles. Put that pile into
// your hand and the other into your graveyard.") and the parser reaches each sentence separately. `chosen-fate` is
// the verb that reads that record. The record is cleared when the source leaves the battlefield (`leave`) and, for a
// spell, is on the card that is already on its way to the graveyard.
//
// Two rules keep that record honest, because an `ext` bag outlives a single resolution: Unesh and Sphinx of Uthuun
// trigger again on the SAME permanent, and a card recast from the graveyard (Yawgmoth's Will, Underworld Breach)
// keeps its bag across the zone change.
//
//   * every recorder REPLACES the whole record when it runs, the empty-pool path included — a resolution that found
//     nothing must never leave the previous resolution's chosen set for the next `chosen-fate` to act on (CR 400.7);
//   * `choose-pile` / `chosen-fate` with NO record at all are a claimed sentence whose antecedent did not parse (a
//     parser rule sees one sentence at a time and cannot look at its neighbours — src/cards/rules/types.ts). They
//     emit the `unsimulated` event `game.ts` emits for an `unknown` op instead of resolving as a silent no-op, so a
//     line this family claims but cannot act on stays visible to the fidelity metric.
import type { Amount, Effect, Filter, FamilyModule, GameObject, GameState, OpCtx, PlayerId, StackItem } from './types.js';
import type { MoveZone, SetZone } from '../../cards/types.js';
import { extDel, extGetOr, extHas, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST this family adds

/**
 * Who makes a choice. Every word but `an-opponent` is the core `ScopeWho` vocabulary (src/engine/refs.ts resolves it
 * against the item's binding frame); `an-opponent` is "an opponent" with no target — the acting player picks which
 * one when there is more than one (the multiplayer reading of CR 700.2e, applied to every choice this family makes).
 */
export type ChoiceWho = 'you' | 'an-opponent' | 'target-player' | 'target-opponent' | 'that-player' | 'each-player' | 'each-opponent' | 'controller-of-that' | 'owner-of-that';

/** Where a set of objects comes from: the current binding, or a filter in a zone of some player(s). `top` takes the first N of each library instead of the whole zone. */
export interface ChoiceSet { filter?: Filter; zone?: SetZone; who?: ChoiceWho; top?: Amount }

/** What happens to a chosen (or unchosen) set: a zone move, a sacrifice by its controller (CR 701.16) or a destroy (CR 701.7). */
export interface PileFate { how: 'move' | 'sacrifice' | 'destroy'; to?: MoveZone; pos?: 'top' | 'bottom'; tapped?: boolean; controller?: 'you' | 'owner' }

/** "Choose three. You may choose the same mode more than once.", "choose one that hasn't been chosen this turn —", "An opponent chooses one —". */
export interface ChooseModesEffect {
  op: 'choose-modes'; modes: Effect[][];
  /** How many modes to choose; with `weights` this is the pawprint budget instead (CR 700.2i). */ count: Amount;
  labels?: string[]; upTo?: boolean; repeat?: boolean; notChosen?: 'this-turn' | 'ever'; chooser?: ChoiceWho; weights?: number[];
}
/** CR 701.38: each player votes for one of the options, starting with the acting player and proceeding in turn order. */
export interface VoteEffect {
  op: 'vote'; options: { label: string; effects: Effect[] }[];
  /** `majority` = the option with the most votes happens (will of the council); `per-vote` = each option happens once per vote it got (council's dilemma). */
  resolve: 'majority' | 'per-vote';
  /** How a `majority` tie is broken: every tied option happens (`all`), or the earliest-listed one (`first`, the default). */
  tie?: 'all' | 'first';
}
/**
 * CR 701.20a: show a set of cards to every player. Their identities become public knowledge for good (the engine's
 * `knowledge.revealed`), and `those` binds them — this is the "Reveal the top N cards of your library" sentence,
 * which the parser emits after the built-in `look-top` that binds the frame.
 */
export interface RevealCardsEffect { op: 'reveal-cards'; what: 'those' | ChoiceSet }
/** CR 700.3: group a set of objects into piles. The piles are recorded on the source; nothing moves zone. */
export interface SeparatePilesEffect { op: 'separate-piles'; from: 'those' | ChoiceSet; piles: number; separator?: ChoiceWho; reveal?: boolean }
/** CR 700.3: a player chooses one of the piles the source holds. Binds `those` to it and records the chosen / unchosen split. */
export interface ChoosePileEffect { op: 'choose-pile'; chooser: ChoiceWho }
/** "An opponent chooses two of those cards", "Target opponent chooses a creature they control." Binds `those` to the chosen and records the split. */
export interface ChooseObjectsEffect { op: 'choose-objects'; chooser: ChoiceWho; from: 'those' | ChoiceSet; count: Amount; upTo?: boolean }
/** "For each player, you choose from among the permanents that player controls an artifact, a creature, …" (CR 608.2f, 101.4). */
export interface ChooseForEachPlayerEffect { op: 'choose-for-each-player'; chooser: ChoiceWho; picks: Filter[]; from?: Filter }
/** What happens to the chosen and/or the unchosen objects the last choice recorded. */
export interface ChosenFateEffect {
  op: 'chosen-fate'; chosen?: PileFate; other?: PileFate;
  /** Narrows the unchosen set ("all other NONLAND PERMANENTS they control"). */ among?: Filter;
  /** Winnowing: an unchosen object that shares a creature type with one of its own controller's chosen objects is spared. */ excludeSharing?: 'creature-type';
}
/** CR 716.2a: "[Cost]: Level N". A level is a designation, not a counter (716.4). */
export interface SetLevelEffect { op: 'set-level'; to: number; /** Set the level whatever it is now; without it the level only becomes N from N-1, which is the activation restriction of CR 716.2a. */ anyLevel?: boolean }

/** CR 716.2a/716.2d: the source's level ("As long as this Class is level N or greater"); a permanent with no level is level 1. */
export interface SelfLevelCondition { kind: 'self-level'; atLeast?: number; exactly?: number }
/** CR 716.2a: "When this Class becomes level N, …". */
export interface BecameLevelTrigger { on: 'became-level'; level: number }
/** CR 701.38d: "While voting, you may vote an additional time." */
export interface ExtraVotesStatic { kind: 'extra-votes'; amount: number }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry {
    pcChooseModes: ChooseModesEffect; pcVote: VoteEffect; pcRevealCards: RevealCardsEffect; pcSeparatePiles: SeparatePilesEffect; pcChoosePile: ChoosePileEffect;
    pcChooseObjects: ChooseObjectsEffect; pcChooseForEachPlayer: ChooseForEachPlayerEffect; pcChosenFate: ChosenFateEffect; pcSetLevel: SetLevelEffect;
  }
  interface ConditionRegistry { pcSelfLevel: SelfLevelCondition }
  interface TriggerRegistry { pcBecameLevel: BecameLevelTrigger }
  interface StaticRegistry { pcExtraVotes: ExtraVotesStatic }
}

// ------------------------------------------------------------------ 3. shared helpers

/** `Mods.flags` key for "this permanent's controller votes N extra times" (Mods.flags is boolean-valued, so the number rides in the key). */
const VOTE_FLAG = 'pc-extra-votes-';
/** The permanent's Class level (CR 716.2d: no level = level 1). */
const levelOf = (o: GameObject): number => extGetOr<number>(o, 'pcLevel', 1);
const nameOf = (o: GameObject): string => chars.name(o);
const idsOf = (list: GameObject[]): number[] => list.map(o => o.id);
/** The objects of `ids` that still exist, in the recorded order. */
function objectsOf(s: GameState, ids: number[]): GameObject[] {
  const out: GameObject[] = [];
  for (const id of ids) { const o = chars.findObject(s, id); if (o) out.push(o); }
  return out;
}

/** Bind `that` / `those` to `list` (the binding frame every composition Ref reads; CR 608.2h values are taken now). */
function bindThose(c: OpCtx, list: GameObject[]): void {
  const entries: NonNullable<StackItem['affected']> = list.map(o => ({
    id: o.id,
    lastKnown: { power: chars.power(c.s, o), toughness: chars.toughness(c.s, o), controller: o.controller, manaValue: chars.manaValueOf(o), zone: o.zone, owner: o.owner },
  }));
  c.item.affected = entries;
}

/** The players a `ChoiceWho` names, in APNAP order for the `each-*` words (CR 101.4). `an-opponent` asks the acting player which one (CR 700.2e). */
async function whoList(c: OpCtx, who: ChoiceWho | undefined): Promise<PlayerId[]> {
  const w = who ?? 'you';
  const actor = c.item.actor ?? c.p;
  if (w === 'an-opponent') {
    const { opponentsOf } = await import('../players.js');
    const opps = opponentsOf(c.s, actor);
    if (opps.length <= 1) return opps;
    const pick = await c.g.ask(actor, { kind: 'choose-player', options: opps, reason: `${c.item.name}: choose an opponent` }) as PlayerId;
    return [opps.includes(pick) ? pick : opps[0]];
  }
  const { resolveWho } = await import('../refs.js');
  return resolveWho({ s: c.s, item: c.item, p: actor, src: c.src }, w, c.T);
}
/** The single player a chooser word names (the acting player when the word resolves to nobody). */
async function chooser(c: OpCtx, who: ChoiceWho | undefined): Promise<PlayerId> {
  const list = await whoList(c, who);
  return list[0] ?? c.item.actor ?? c.p;
}

/** The objects a `ChoiceSet` / `'those'` names. `top` reads the first N cards of each named player's library. */
async function gather(c: OpCtx, from: 'those' | ChoiceSet): Promise<GameObject[]> {
  if (from === 'those') {
    const { resolveRef } = await import('../refs.js');
    return resolveRef({ s: c.s, item: c.item, p: c.item.actor ?? c.p, src: c.src }, 'those');
  }
  const players = await whoList(c, from.who ?? 'you');
  const zone: SetZone = from.zone ?? (from.top !== undefined ? 'library' : 'battlefield');
  const out: GameObject[] = [];
  for (const w of players) {
    const pl = c.s.players[w];
    const pool = zone === 'battlefield' ? chars.battlefieldOf(c.s, w) : pl[zone];
    const slice = from.top !== undefined ? pool.slice(0, Math.max(0, c.amt(from.top))) : pool;
    for (const o of slice) if (chars.matchesFilter(c.s, o, from.filter, c.src)) out.push(o);
  }
  return out;
}

/**
 * CR 701.20a: reveal `list` — every player may see those cards from now on.
 *
 * Who may see what is `state.knowledge`, not the log: `redact` (src/engine/view.ts) blanks every library and opposing
 * hand card whose id is not in `knownTop` / `knownInHand` / `revealed`, and `Game.ask` hands a hidden-information
 * agent that redacted state (the shipped `DeferredAgent` — the UI and the human — is one). A pile of library cards
 * nobody recorded is therefore a pile its separator and its chooser cannot see, which is the whole decision on Fact
 * or Fiction. `Game.reveal` is private, so this records the reveal exactly the way `game.ts` does for `dig` with
 * `reveal` and for `explore`: the id goes onto `knowledge.revealed`, and the reveal is announced with the core
 * `library` event (its renderer is the "P0 reveals A, B." log line, one event per owner in seat order).
 *
 * Only a card in a hidden zone needs the entry — a permanent, a graveyard card or a stack object is public already
 * (CR 400.2). The list is append-only, as in the core: CR 701.20d ends a reveal when the library is reordered, and
 * neither `game.ts` nor this family models that (see the doc's §5).
 */
function revealPublic(c: OpCtx, list: GameObject[], announce: boolean): void {
  const known = c.s.knowledge.revealed;
  for (const o of list) if ((o.zone === 'library' || o.zone === 'hand') && !known.includes(o.id)) known.push(o.id);
  if (!announce || !list.length) return;
  for (const pl of c.s.players) {
    const mine = list.filter(o => o.owner === pl.id);
    if (mine.length) c.g.emit({ type: 'library', player: pl.id, action: 'reveal', cards: mine.map(nameOf) });
  }
}

/** Record the chosen / unchosen split on the source so a later `chosen-fate` (a later SENTENCE of the same card) can read it. */
function recordSplit(c: OpCtx, chosen: GameObject[], pool: GameObject[]): void {
  const picked = idsOf(chosen);
  extSet(c.src, 'pcChosen', picked);
  extSet(c.src, 'pcUnchosen', idsOf(pool).filter(id => !picked.includes(id)));
}

/**
 * Forget every pile / chosen record on `o`. Called at the START of a recorder (CR 400.7): a second resolution of the
 * same source never inherits the first one's split, not even when it finds nothing of its own to record.
 */
function clearRecord(o: GameObject): void { extDel(o, 'pcPiles'); extDel(o, 'pcChosen'); extDel(o, 'pcUnchosen'); }

/** Record an EMPTY split: the recorder ran and found nothing, so the sentences that read it are genuine no-ops. */
function recordEmpty(c: OpCtx): void { extSet(c.src, 'pcChosen', []); extSet(c.src, 'pcUnchosen', []); }

/**
 * Report a sentence this family claimed but cannot simulate — the same `unsimulated` event `game.ts` emits for an
 * `unknown` op, so a `chosen-fate` whose antecedent sentence never parsed stays visible to the fidelity metric
 * instead of resolving as a no-op nobody can see (CR 608.2f: the effect needs the set the earlier sentence chose).
 */
function unsimulated(c: OpCtx, clause: string): void {
  c.g.emit({ type: 'unsimulated', id: c.src.id, name: nameOf(c.src), clause });
}

/**
 * CR 700.3a: how many of the `left` objects the separator puts into this pile while `remaining` piles are still to be
 * filled. ANY size from 0 to `left` is legal — Fact or Fiction is the card it is because 5/0 and 4/1 are on the table
 * — so the size is asked as a `choose-option`, the core decision kind every shipped agent already answers. The even
 * split is offered FIRST so an agent that answers `options[0]` (src/engine/agents/defaults.ts) still makes the
 * balanced split, while a smarter agent reaches every other size without this family adding a decision kind.
 */
async function pileSize(c: OpCtx, who: PlayerId, left: number, remaining: number, label: number): Promise<number> {
  if (left <= 0) return 0;
  const even = Math.floor(left / remaining);
  const sizes = [even, ...Array.from({ length: left + 1 }, (_, i) => i).filter(i => i !== even)];
  if (sizes.length === 1) return even;
  const options = sizes.map(n => `${n} card${n === 1 ? '' : 's'}`);
  const answer = await c.g.ask(who, { kind: 'choose-option', options, reason: `${c.item.name}: how many cards go into pile ${label}?` }) as string;
  const at = options.indexOf(answer);
  return sizes[at < 0 ? 0 : at];
}

/** The two renderings the ops reuse as the `clause` of an `unsimulated` event (the printed sentence, near enough). */
const renderChoosePile = (e: ChoosePileEffect): string => `${whoWord(e.chooser)} chooses one of those piles.`;
const renderChosenFate = (e: ChosenFateEffect): string => {
  const parts = [e.chosen ? fatePhrase(e.chosen, 'the chosen cards') : '', e.other ? fatePhrase(e.other, 'the rest') : ''].filter(Boolean).join(' and ');
  return `${parts.charAt(0).toUpperCase()}${parts.slice(1)}.`;
};

/** Ask `p` to pick `count` of `pool` (`exact` unless `upTo`); a pool no larger than the count needs no decision. */
async function pickObjects(c: OpCtx, p: PlayerId, pool: GameObject[], count: number, reason: string, upTo = false): Promise<GameObject[]> {
  if (count <= 0 || pool.length === 0) return [];
  if (!upTo && pool.length <= count) return [...pool];
  const ids = await c.g.ask(p, { kind: 'choose-cards', from: idsOf(pool), count: Math.min(count, pool.length), reason, exact: !upTo }) as number[];
  const set = Array.isArray(ids) ? ids : [];
  return pool.filter(o => set.includes(o.id)).slice(0, count);
}

/** Move / sacrifice / destroy one set. Objects that have already left the zone they were bound in are skipped (CR 400.7). */
async function applyFate(c: OpCtx, list: GameObject[], fate: PileFate): Promise<void> {
  for (const o of list) {
    if (fate.how === 'sacrifice') { c.g.sacrifice(o); continue; }
    if (fate.how === 'destroy') { if (o.zone === 'battlefield') c.g.destroy(o); continue; }
    const to = fate.to ?? 'graveyard';
    if (o.zone === to && !fate.pos) continue;                                  // same zone, no position: nothing to do — but 'the rest on the bottom of your library' is a move within the library
    if (to === 'battlefield') {
      if (o.token) continue;                                       // a token outside the battlefield has ceased to exist (CR 111.7)
      const ctl = fate.controller === 'you' ? (c.item.actor ?? c.p) : o.owner;
      await c.g.enterBattlefield(o, { controller: ctl, via: 'effect', item: c.item, tapped: fate.tapped });
    } else {
      c.g.moveTo(o, to, fate.pos ?? 'top', 'effect');
    }
  }
}

// ------------------------------------------------------------------ 4. the module

const PILES_CHOICES: FamilyModule = {
  name: 'piles-choices',

  effects: {
    // ---- CR 700.2: modal choices the core `choose-mode` cannot express ------------------------------------------
    'choose-modes': async (e: ChooseModesEffect, c) => {
      const who = await chooser(c, e.chooser);
      const budget = Math.max(0, c.amt(e.count));
      const weights = e.weights;
      // CR 700.2i: a pawprint cost is at least {P}. A zero or negative weight would let `repeat` re-offer the same
      // mode forever (`spent` never grows, and every shipped agent answers `choose-option` with `options[0]`, never
      // the trailing "(no more modes)"), so a weight reads as at least 1 here; the zod mirror rejects one outright.
      const weightOf = (i: number): number => Math.max(1, Math.floor(weights?.[i] ?? 1));
      // CR 700.2a: a mode already chosen (this turn, or ever) is off the list — the record lives on the source
      const bannedKey = e.notChosen === 'this-turn' ? 'pcModesTurn' : 'pcModesEver';
      const banned = e.notChosen ? extGetOr<number[]>(c.src, bannedKey, []) : [];
      const label = (i: number): string => e.labels?.[i] ?? `mode ${i + 1}`;
      const picked: number[] = [];
      let spent = 0;
      for (;;) {
        const legal: number[] = [];
        for (let i = 0; i < e.modes.length; i++) {
          if (banned.includes(i)) continue;                                     // "that hasn't been chosen"
          if (!e.repeat && picked.includes(i)) continue;                        // CR 700.2d: normally not twice
          if (weights ? spent + weightOf(i) > budget : picked.length >= budget) continue;
          legal.push(i);
        }
        if (!legal.length) break;
        const optional = e.upTo === true || weights !== undefined;              // a budget need not be spent (CR 700.2i)
        const options = [...legal.map(i => label(i)), ...(optional ? ['(no more modes)'] : [])];
        const answer = await c.g.ask(who, { kind: 'choose-option', options, reason: `${c.item.name}: choose a mode` }) as string;
        const at = options.indexOf(answer);
        // an answer nobody offered takes the first legal mode (a mode must be chosen, CR 700.2a); the trailing
        // "(no more modes)" entry — offered only for an `upTo` count or a pawprint budget — stops the loop
        const pick = at < 0 ? 0 : at;
        if (pick >= legal.length) break;
        const mode = legal[pick];
        picked.push(mode); spent += weights ? weightOf(mode) : 1;
        if (!weights && picked.length >= budget) break;
      }
      if (!picked.length) { c.g.note(`${nameOf(c.src)}: no mode is chosen.`); return; }
      if (e.notChosen) extSet(c.src, bannedKey, [...banned, ...picked.filter(i => !banned.includes(i))]);
      c.g.note(`${c.g.pname(who)} chooses ${picked.map(i => label(i)).join(', ')} (${nameOf(c.src)}).`);
      for (const i of picked) for (const eff of e.modes[i] ?? []) await c.apply(eff);
    },

    // ---- CR 701.38: vote ---------------------------------------------------------------------------------------
    vote: async (e: VoteEffect, c) => {
      const { apnapOrder, alive } = await import('../players.js');
      const start = c.item.actor ?? c.p;
      // CR 701.38a: starting with the acting player, then in turn order
      const order = apnapOrder(c.s);
      const at = order.indexOf(start);
      const voters = (at < 0 ? order : [...order.slice(at), ...order.slice(0, at)]).filter(p => alive(c.s).includes(p));
      const labels = e.options.map(o => o.label);
      const tally = e.options.map(() => 0);
      for (const v of voters) {
        for (let k = 0; k < 1 + extraVotes(c.s, v); k++) {           // CR 701.38d: extra votes happen at the same time
          const answer = await c.g.ask(v, { kind: 'choose-option', options: labels, reason: `${c.item.name}: vote` }) as string;
          const i = Math.max(0, labels.indexOf(answer));
          tally[i]++;
          c.g.note(`${c.g.pname(v)} votes for ${labels[i]}.`);
        }
      }
      c.g.note(`${nameOf(c.src)}: ${labels.map((l, i) => `${l} ${tally[i]}`).join(', ')}.`);
      if (e.resolve === 'per-vote') {
        for (let i = 0; i < e.options.length; i++) for (let k = 0; k < tally[i]; k++) for (const eff of e.options[i].effects) await c.apply(eff);
        return;
      }
      const best = Math.max(...tally);
      if (best <= 0) return;
      const winners = e.options.map((_, i) => i).filter(i => tally[i] === best);
      for (const i of (e.tie === 'all' ? winners : [winners[0]])) for (const eff of e.options[i].effects) await c.apply(eff);
    },

    // ---- CR 701.20a: reveal ------------------------------------------------------------------------------------
    // "Reveal the top five cards of your library." The built-in `look-top` in front of it (the parser emits the two
    // together, because only a core op binds the frame — see src/cards/rules/piles-choices.ts) shows the cards to
    // their owner alone (CR 701.20e); this is the half that makes them public.
    'reveal-cards': async (e: RevealCardsEffect, c) => {
      const list = await gather(c, e.what);
      revealPublic(c, list, true);
      bindThose(c, list);
    },

    // ---- CR 700.3: piles ---------------------------------------------------------------------------------------
    'separate-piles': async (e: SeparatePilesEffect, c) => {
      const pool = await gather(c, e.from);
      clearRecord(c.src);                                          // a new separation replaces the old record, empty pool included
      if (!pool.length) { extSet(c.src, 'pcPiles', []); recordEmpty(c); return; }
      const who = await chooser(c, e.separator ?? 'you');
      // The piles this family makes are public (face-down piles are declined — see the doc's §5), so the pool is
      // recorded as known whether or not the printed sentence says "Reveal"; the word only decides whether the
      // reveal is ANNOUNCED. Without the record a hidden-information separator would split cards it cannot see.
      revealPublic(c, pool, e.reveal === true);
      // CR 700.3a: every object goes into exactly one pile, and the separator chooses the SIZES as well as the
      // contents (see `pileSize` — 5/0 and 4/1 are legal splits of a five-card pool).
      const piles: number[][] = [];
      let rest = [...pool];
      for (let k = 0; k < e.piles - 1; k++) {
        const size = await pileSize(c, who, rest.length, e.piles - k, k + 1);
        const take = await pickObjects(c, who, rest, size, `${c.item.name}: put ${size} into pile ${k + 1}`);
        piles.push(idsOf(take));
        rest = rest.filter(o => !take.includes(o));
      }
      piles.push(idsOf(rest));
      extSet(c.src, 'pcPiles', piles);
      c.g.note(`${c.g.pname(who)} separates ${pool.length} card${pool.length === 1 ? '' : 's'} into ${piles.map((pile, i) => `pile ${i + 1} (${pile.length ? objectsOf(c.s, pile).map(nameOf).join(', ') : 'empty'})`).join(' and ')}.`);
    },

    'choose-pile': async (e: ChoosePileEffect, c) => {
      // No `separate-piles` ever ran on this source, so the sentence that made the piles did not parse: this line is
      // text the engine did not simulate, not a no-op nobody can see.
      if (!extHas(c.src, 'pcPiles')) { unsimulated(c, renderChoosePile(e)); return; }
      const piles = extGetOr<number[][]>(c.src, 'pcPiles', []);
      if (!piles.length) { recordEmpty(c); bindThose(c, []); return; }
      const who = await chooser(c, e.chooser);
      const labels = piles.map((pile, i) => `pile ${i + 1} (${pile.length ? objectsOf(c.s, pile).map(nameOf).join(', ') : 'empty'})`);
      const answer = await c.g.ask(who, { kind: 'choose-option', options: labels, reason: `${c.item.name}: choose a pile` }) as string;
      const at = Math.max(0, labels.indexOf(answer));
      const chosen = objectsOf(c.s, piles[at]);
      const others = piles.flatMap((pile, i) => (i === at ? [] : pile));
      extSet(c.src, 'pcChosen', idsOf(chosen));
      extSet(c.src, 'pcUnchosen', idsOf(objectsOf(c.s, others)));
      bindThose(c, chosen);
      c.g.note(`${c.g.pname(who)} chooses ${labels[at]}.`);
    },

    // ---- "an opponent chooses N of those cards" ------------------------------------------------------------------
    'choose-objects': async (e: ChooseObjectsEffect, c) => {
      const pool = await gather(c, e.from);
      extDel(c.src, 'pcPiles');                                    // a fresh choice replaces any pile record too
      if (!pool.length) { recordSplit(c, [], pool); bindThose(c, []); return; }
      const who = await chooser(c, e.chooser);
      const n = Math.max(0, c.amt(e.count));
      const chosen = await pickObjects(c, who, pool, n, `${c.item.name}: choose ${e.upTo ? 'up to ' : ''}${n}`, e.upTo === true);
      recordSplit(c, chosen, pool);
      bindThose(c, chosen);
      c.g.note(`${c.g.pname(who)} chooses ${chosen.length ? chosen.map(nameOf).join(', ') : 'nothing'}.`);
    },

    // ---- "For each player, you choose …" (CR 608.2f, 101.4) ------------------------------------------------------
    'choose-for-each-player': async (e: ChooseForEachPlayerEffect, c) => {
      const { apnapOrder, alive } = await import('../players.js');
      const who = await chooser(c, e.chooser);
      extDel(c.src, 'pcPiles');                                    // a fresh choice replaces any pile record too
      const live = alive(c.s);
      const chosen: GameObject[] = []; const pool: GameObject[] = [];
      for (const owner of apnapOrder(c.s).filter(p => live.includes(p))) {
        const theirs = chars.battlefieldOf(c.s, owner).filter(o => chars.matchesFilter(c.s, o, e.from, c.src));
        pool.push(...theirs);
        for (const pick of e.picks) {
          const eligible = theirs.filter(o => chars.matchesFilter(c.s, o, pick, c.src) && !chosen.includes(o));
          const [got] = await pickObjects(c, who, eligible, 1, `${c.item.name}: choose one of ${c.g.pname(owner)}'s permanents`);
          if (got) chosen.push(got);
        }
      }
      recordSplit(c, chosen, pool);
      bindThose(c, chosen);
      c.g.note(`${c.g.pname(who)} chooses ${chosen.length ? chosen.map(nameOf).join(', ') : 'nothing'}.`);
    },

    // ---- what happens to the chosen and the unchosen ------------------------------------------------------------
    'chosen-fate': async (e: ChosenFateEffect, c) => {
      // Nothing on this source recorded a chosen / unchosen split, so the antecedent sentence ("An opponent chooses
      // two of those cards", "For each player, you choose ...") did not parse. Say so instead of doing nothing.
      if (!extHas(c.src, 'pcChosen') && !extHas(c.src, 'pcUnchosen')) { unsimulated(c, renderChosenFate(e)); return; }
      const chosenIds = extGetOr<number[]>(c.src, 'pcChosen', []);
      const chosen = objectsOf(c.s, chosenIds);
      let other = objectsOf(c.s, extGetOr<number[]>(c.src, 'pcUnchosen', []));
      if (e.among) other = other.filter(o => chars.matchesFilter(c.s, o, e.among, c.src));
      if (e.excludeSharing === 'creature-type') {
        // Winnowing: an unchosen permanent that shares a creature type with one of ITS OWN controller's chosen ones is spared
        other = other.filter(o => {
          const mine = chars.subtypes(o);
          return !chosen.some(k => k.controller === o.controller && chars.subtypes(k).some(t => mine.includes(t)));
        });
      }
      const acted: GameObject[] = [];
      if (e.chosen) { await applyFate(c, chosen, e.chosen); acted.push(...chosen); }
      if (e.other) { await applyFate(c, other, e.other); acted.push(...other); }
      bindThose(c, acted);
    },

    // ---- CR 716.2a: Class levels --------------------------------------------------------------------------------
    'set-level': (e: SetLevelEffect, c) => {
      const now = levelOf(c.src);
      // CR 716.2a: "Activate only if this Class is level N-1" — the level bar's activation restriction, enforced here
      // because a parsed "{cost}: Level N" line reaches the engine as a plain activated ability.
      if (!e.anyLevel && now !== e.to - 1) return;
      if (now === e.to) return;
      extSet(c.src, 'pcLevel', e.to);
      c.s.version++;
      c.g.note(`${nameOf(c.src)} becomes level ${e.to}.`);
      c.g.queueTriggers('became-level', { obj: c.src, player: c.src.controller, amount: e.to });
    },
  },

  conditions: {
    'self-level': (cond: SelfLevelCondition, _s, src) => {
      const lv = levelOf(src);
      return (cond.atLeast === undefined || lv >= cond.atLeast) && (cond.exactly === undefined || lv === cond.exactly);
    },
  },

  triggers: {
    'became-level': (ev: BecameLevelTrigger, perm, ctx, _s, event) => event === 'became-level' && ctx.obj === perm && ctx.amount === ev.level,
  },

  statics: {
    // CR 701.38d. Mods.flags is boolean-valued, so the number of extra votes rides in the key; the `vote` op reads it.
    'extra-votes': (e: ExtraVotesStatic, src, o, _s, m) => { if (o.id === src.id && e.amount > 0) m.flags[VOTE_FLAG + e.amount] = true; },
  },

  /** A per-turn "hasn't been chosen this turn" record dies with the turn (CR 514.2). */
  cleanupEot: (_g, o) => extDel(o, 'pcModesTurn'),

  /** CR 400.7: a permanent that leaves the battlefield is a new object — its level, its mode record and its piles go. */
  leave: (_g, o) => {
    extDel(o, 'pcLevel'); extDel(o, 'pcModesEver'); extDel(o, 'pcModesTurn');
    clearRecord(o);
  },

  render: {
    'choose-modes': (e: ChooseModesEffect) => {
      const n = typeof e.count === 'number' ? ['zero', 'one', 'two', 'three', 'four', 'five'][e.count] ?? String(e.count) : 'X';
      const head = e.chooser && e.chooser !== 'you' ? `${whoWord(e.chooser)} chooses ${n}` : `Choose ${e.upTo ? 'up to ' : ''}${n}`;
      const budget = e.weights ? ` {P} worth of modes` : '';
      const notChosen = e.notChosen === 'this-turn' ? " that hasn't been chosen this turn" : e.notChosen === 'ever' ? " that hasn't been chosen" : '';
      return `${head}${budget}${notChosen} —${e.repeat ? ' You may choose the same mode more than once.' : ''}`;
    },
    vote: (e: VoteEffect) => `Starting with you, each player votes for ${e.options.map(o => o.label).join(' or ')}.`,
    'separate-piles': (e: SeparatePilesEffect) => `${e.reveal ? 'Reveal and separate' : 'Separate'} ${e.from === 'those' ? 'those cards' : describeSet(e.from)} into ${countWord(e.piles)} piles.`,
    'choose-pile': (e: ChoosePileEffect) => renderChoosePile(e),
    'choose-objects': (e: ChooseObjectsEffect) => `${whoWord(e.chooser)} chooses ${e.upTo ? 'up to ' : ''}${typeof e.count === 'number' ? countWord(e.count) : 'X'} of ${e.from === 'those' ? 'those cards' : describeSet(e.from)}.`,
    'choose-for-each-player': (e: ChooseForEachPlayerEffect) => `For each player, ${e.chooser === 'you' ? 'you choose' : `${whoWord(e.chooser).toLowerCase()} chooses`} from among the permanents that player controls ${e.picks.map(describeFilterShort).join(', ')}.`,
    'chosen-fate': (e: ChosenFateEffect) => renderChosenFate(e),
    'set-level': (e: SetLevelEffect) => `Level ${e.to}`,
  },
};

// ------------------------------------------------------------------ 5. renderer vocabulary

/** How many extra votes `p` gets from `extra-votes` statics on the permanents they control (CR 701.38d). */
function extraVotes(s: GameState, p: PlayerId): number {
  let extra = 0;
  for (const o of chars.battlefieldOf(s, p)) {
    const f = chars.flags(s, o);
    for (const k of Object.keys(f)) if (k.startsWith(VOTE_FLAG) && f[k]) extra += Number(k.slice(VOTE_FLAG.length)) || 0;
  }
  return extra;
}

const WHO_WORDS: Record<ChoiceWho, string> = {
  you: 'You', 'an-opponent': 'An opponent', 'target-player': 'Target player', 'target-opponent': 'Target opponent',
  'that-player': 'That player', 'each-player': 'Each player', 'each-opponent': 'Each opponent',
  'controller-of-that': 'Its controller', 'owner-of-that': 'Its owner',
};
const whoWord = (w: ChoiceWho): string => WHO_WORDS[w] ?? 'You';
const countWord = (n: number): string => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][n] ?? String(n);
/** "put the chosen cards into your hand", "sacrifice the rest" — one clause of a `chosen-fate` rendering. */
const fatePhrase = (f: PileFate, what: string): string =>
  f.how === 'sacrifice' ? `sacrifice ${what}` : f.how === 'destroy' ? `destroy ${what}` : `put ${what} into ${zonePhrase(f)}`;
const zonePhrase = (f: PileFate): string =>
  f.to === 'hand' ? 'your hand'
  : f.to === 'battlefield' ? `the battlefield${f.tapped ? ' tapped' : ''}${f.controller === 'you' ? ' under your control' : ''}`
  : f.to === 'library' ? `${f.pos === 'bottom' ? 'the bottom' : 'the top'} of your library`
  : f.to === 'exile' ? 'exile' : f.to === 'command' ? 'the command zone' : 'your graveyard';
/** "an artifact", "a creature" — the short article form a `choose-for-each-player` pick reads as. */
function describeFilterShort(f: Filter): string {
  const t = f.types?.[0] ?? f.subtypes?.[0] ?? 'permanent';
  return `${/^[aeiou]/i.test(t) ? 'an' : 'a'} ${t.toLowerCase()}`;
}
function describeSet(f: ChoiceSet): string {
  if (f.top !== undefined) return `the top ${typeof f.top === 'number' ? countWord(f.top) : 'X'} cards of your library`;
  const whose = f.who === undefined || f.who === 'you' ? 'your' : `${whoWord(f.who).toLowerCase()}'s`;
  const zone = f.zone ?? 'battlefield';
  return zone === 'battlefield' ? `the permanents ${whose === 'your' ? 'you control' : `${whose} controls`}` : `the cards in ${whose} ${zone}`;
}

export default PILES_CHOICES;
