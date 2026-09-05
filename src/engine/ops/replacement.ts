// Replacement effects and prevention shields (Phase 9.1; docs/vocabulary/replacement.md).
//
// The whole of CR 614 (replacement effects) and CR 615 (prevention effects) as one family: "if <this> would <happen>,
// <that> instead", the prevention shields a spell hands out, the counter and damage doublers, the "enters untapped"
// / "as ~ enters, choose …" half of CR 614.12, and the two "can't be prevented" shapes that switch prevention off.
//
// 793 paper cards carry one of these lines. Nothing here is a new *mechanic*: every one of them is the engine's own
// `replacements.*` fold (game.ts:dealDamage / moveTo / draw / gainLife / replaceCounters) driven by data.
//
// ------------------------------------------------------------------ the shape of the family
//
//   three effect ops      `prevent`                     a shield, on the resolving spell's controller's terms
//                         `prevent-rider`               "if damage is prevented this way, ..." (the same replacement)
//                         `damage-cant-be-prevented`    CR 615.6, for a turn
//   eight static kinds    `prevention-shield`           a shield a permanent hands out continuously
//                         `unpreventable-damage`        CR 615.6 printed on a permanent (matched on the source, in any
//                                                       zone, and folded into Mods.flags so it can also be granted)
//                         `damage-replacement`          CR 614.1a on damage: plus / times / minus / as counters
//                         `zone-replacement`            "if it would die, exile it instead"
//                         `counter-replacement`         CR 614.1c generalised: none / plus / minus / times
//                         `cant-gain-life`              CR 614.1b on life gain
//                         `draw-replacement`            "skip your draw step", "draw two cards instead"
//                         `enters-untapped`             CR 614.12 the other way round
//   one as-enters kind    `choose-type`                 "as ~ enters, choose a basic land type"
//
// ------------------------------------------------------------------ where the state lives (all JSON-plain, `ext`)
//
//   s.ext.replShields      ShieldState[]  the one-shot / this-turn shields `prevent` created; cleared in cleanup
//   s.ext.replNoPrevent    NoPrevent[]    the `damage-cant-be-prevented` effects in force this turn
//   s.ext.replShieldSeq    number         id counter for shields (a stable handle across a clone)
//   s.ext.replUntapPending number[]       permanents that have just entered and owe an `enters-untapped` check
//   s.ext.replDrawApplied  string[]       the draw replacements already applied on the way down to this draw (CR 614.5)
//   s.ext.replDrawStepSeen "<turn>:<p>"   that draw step's turn-based draw window is over (CR 504.1); see `drawHook`
//   s.ext.replRiderActive  number[]       shields whose "if damage is prevented this way" rider is running (CR 614.5)
//   o.ext.chosenLandType   string         what `choose-type` chose (the layers family reads it for "is the chosen type")
//
// `clone.ts` deep-copies those bags with `plainCopy` and `serialize.ts` round-trips them; nothing here is hidden from
// any seat (a chosen source and a shield are announced, CR 615.10), so the family registers no `redact` hook.
//
// ------------------------------------------------------------------ ordering (CR 616.1)
//
// CR 616.1 lets the affected object's controller (or the affected player) choose the order when several replacement
// or prevention effects apply to the same event. The engine has no decision point there, so this family applies a
// fixed, documented order per damage event: damage *replacements* first (plus / times / minus / as counters, in
// battlefield order), then *prevention* (statics before one-shot shields, oldest shield first). That is the order a
// player almost always picks — a doubler then a shield gives the shield the doubled damage to eat — and it is
// deterministic, which the fuzzer and the goldens need.
//
// That order holds for every shield this family owns, including one it adopts from the core `prevent-damage` op (see
// the `prevent-rider` effect). It does NOT hold for a core shield nothing adopted: `Game.dealDamage` spends
// `o.eotFlags.preventDamage` — and `dealDamageToPlayer` the Fog flag — before `REPLACEMENTS.damage` is folded at all,
// so a doubler is applied after that shield rather than before it. Fixing that is a core reorder; it is written up in
// docs/vocabulary/replacement.md §6 and as `coreChangeNeeded` in the Phase 9.1 report. `sweepCoreShields` below is
// the half of the problem a family CAN reach (CR 615.6).
import type { Amount, Filter, FamilyModule, Game, GameObject, GameState, Json, PlayerId, TargetSpec, Zone } from './types.js';
import type { MoveZone } from '../../cards/types.js';
import { extDel, extGet, extGetOr, extPush, extSet } from './ext.js';
import { chars } from './chars.js';

// ---------------------------------------------------------------------------------------------------------------
// 1. Shared sub-shapes
// ---------------------------------------------------------------------------------------------------------------

/**
 * Which *source* of damage a shield or a damage replacement answers for (CR 609.7 decides what a source is).
 * Every field is a further restriction; an empty (or absent) `DamageSource` matches every source.
 */
export interface DamageSource {
  /** "a source of your choice": one source is chosen as the shield is created and bound by id (CR 615.10). */
  chosen?: boolean;
  /** The source of the ability itself ("… that would be dealt by ~"). */
  self?: boolean;
  /** The permanent the source is attached to ("… dealt by enchanted creature"). */
  attached?: boolean;
  /** Characteristics the source must have — "a blue source", "creatures", "another red source". */
  filter?: Filter;
  /** Whose source it must be, relative to the ability's controller. */
  who?: 'you' | 'opponent' | 'any';
  /** Only combat damage (CR 510.2) or only noncombat damage. */
  combat?: 'combat' | 'noncombat';
}

/**
 * What is being damaged. A damage event matches when EITHER the player half (`players`) or the object half
 * (`self` / `attached` / `filter`+`who`) says so, which is how "to you and planeswalkers you control" is one
 * recipient. All fields absent = every player and every permanent ("prevent all damage that would be dealt this turn").
 */
export interface DamageRecipient {
  /** Players: the ability's controller, every opponent of it, or anyone. */
  players?: 'you' | 'each-opponent' | 'any';
  /** The source of the ability itself ("prevent all damage that would be dealt to ~"). */
  self?: boolean;
  /** The permanent the source is attached to ("… to enchanted creature"). */
  attached?: boolean;
  /** Permanents matching this filter … */
  filter?: Filter;
  /** … controlled by whom, relative to the ability's controller. */
  who?: 'you' | 'opponent' | 'any';
}

/** "If damage is prevented this way, …" — the small closed set of follow-ups the printed cards actually use. */
export type PreventFollowUp =
  /** "You gain life equal to the damage prevented this way." */
  | { mode: 'gain-life' }
  /** "… ~ deals that much damage to that source." (Comeuppance's creature half) */
  | { mode: 'damage-source' }
  /** "… ~ deals that much damage to that source's controller." (Deflecting Palm) */
  | { mode: 'damage-source-controller' }
  /** "… ~ deals that much damage to any target." — the targets chosen for this effect. */
  | { mode: 'damage-targets' }
  /** "For each 1 damage prevented this way, put a +1/+1 counter on that creature." */
  | { mode: 'counters'; counter: string };

/** What a damage replacement does instead (CR 614.1a). */
export type DamageInstead =
  | { mode: 'plus'; amount: number }        // "deals that much damage plus 1 … instead"
  | { mode: 'times'; factor: number }       // "deals double that damage instead"
  | { mode: 'minus'; amount: number }       // "prevent 1 of that damage"
  | { mode: 'counters'; counter: string }   // "put that many -1/-1 counters on that creature instead"
  | { mode: 'none' };                       // "that damage isn't dealt"

/** What a counter replacement does instead (CR 614.1c, generalised past the core's double / plus-one). */
export type CounterInstead =
  | { mode: 'none' }                        // Solemnity: "that counter isn't put on it"
  | { mode: 'plus'; amount: number }        // "that many plus one … instead"
  | { mode: 'minus'; amount: number }       // Vizier of Remedies: "that many minus one … instead"
  | { mode: 'times'; factor: number };      // Doubling Season on an arbitrary counter kind

// ---------------------------------------------------------------------------------------------------------------
// 2. The AST this family adds
// ---------------------------------------------------------------------------------------------------------------

/** CR 615.1 / 615.10: hand out a prevention shield until end of turn. */
export interface PreventEffect {
  op: 'prevent';
  /** How much: a number of damage points, `'all'` (an unlimited shield), or `'next'` (the whole next matching event). */
  amount: Amount | 'all' | 'next';
  from?: DamageSource;
  to: DamageRecipient;
  /** The only duration a shield has: it ends in the cleanup step (CR 514.2). */
  duration: 'eot';
  /** "If damage is prevented this way, …" */
  rider?: PreventFollowUp;
}

/**
 * The rider a shield's own card prints as a second sentence: "If damage is prevented this way, …" / "You gain life
 * equal to the damage prevented this way." One replacement effect on the card (CR 615.1), two sentences in the
 * oracle text and therefore two effects in the AST — this one attaches to every shield the same source has just
 * created that does not carry a rider yet, so it is a no-op unless a `prevent` ran before it in the same resolution.
 */
export interface PreventRiderEffect { op: 'prevent-rider'; rider: PreventFollowUp; target?: TargetSpec }

/** CR 615.6: "Damage can't be prevented this turn." */
export interface UnpreventableEffect { op: 'damage-cant-be-prevented'; match?: DamageSource; duration: 'eot' }

/** A prevention shield a permanent hands out for as long as it is on the battlefield (CR 615.1). */
export interface PreventionShieldStatic { kind: 'prevention-shield'; from?: DamageSource; to: DamageRecipient }

/** CR 615.6 printed on a permanent: "Combat damage that would be dealt by creatures you control can't be prevented." */
export interface UnpreventableStatic {
  kind: 'unpreventable-damage';
  /** Which of the controller's sources it speaks for (absent = every permanent). */
  filter?: Filter;
  who?: 'you' | 'opponent' | 'any';
  combat?: 'combat' | 'noncombat';
}

/** CR 614.1a on damage: "If <source> would deal damage to <recipient>, <instead>." */
export interface DamageReplacementStatic { kind: 'damage-replacement'; from?: DamageSource; to?: DamageRecipient; instead: DamageInstead }

/** CR 614.1a on a zone change: "If <object> would be put into <zone>, <instead>." */
export interface ZoneReplacementStatic {
  kind: 'zone-replacement';
  would: {
    /** The source itself ("if ~ would die"). */
    self?: boolean;
    filter?: Filter;
    who?: 'you' | 'opponent' | 'any';
    /** Where it is headed. */
    to: 'graveyard' | 'exile' | 'hand' | 'library';
    /** Only from the battlefield ("would die", CR 700.4), only from the stack, or from anywhere. */
    from?: 'battlefield' | 'stack' | 'any';
  };
  instead: { zone: MoveZone; pos?: 'top' | 'bottom' };
}

/** CR 614.1c: "If one or more counters would be put on <filter>, <instead>." */
export interface CounterReplacementStatic {
  kind: 'counter-replacement';
  /** Which counter kind ("+1/+1", "-1/-1", "charge"); absent = every kind. */
  counter?: string;
  filter?: Filter;
  who?: 'you' | 'opponent' | 'any';
  instead: CounterInstead;
}

/** CR 614.1b on life gain: "Players can't gain life." */
export interface CantGainLifeStatic { kind: 'cant-gain-life'; who: 'you' | 'opponent' | 'all' }

/** "Skip your draw step." / "If you would draw a card …, draw two cards instead." (CR 121.6, 614.1) */
export interface DrawReplacementStatic {
  kind: 'draw-replacement';
  who: 'you' | 'opponent' | 'all';
  /** `'skip'` = no card is drawn; a number = that many cards are drawn instead of the one. */
  instead: 'skip' | number;
  /** Only the draw taken as the draw step's turn-based action ("Skip your draw step"). */
  drawStepOnly?: boolean;
  /** "… except the first one you draw in each of your draw steps". */
  exceptFirstInDrawStep?: boolean;
}

/** CR 614.12 the other way round: "Lands you control enter untapped." */
export interface EntersUntappedStatic { kind: 'enters-untapped'; filter: Filter; who: 'you' | 'all' }

/** CR 614.12: "As ~ enters, choose a basic land type." (the core's `choose` covers colour and creature type). */
export interface ChooseTypeAsEnters { kind: 'choose-type'; what: 'basic-land-type' }

declare module '../../cards/types.js' {
  interface EffectRegistry { replPrevent: PreventEffect; replPreventRider: PreventRiderEffect; replUnpreventable: UnpreventableEffect }
  interface StaticRegistry {
    replPreventionShield: PreventionShieldStatic; replUnpreventable: UnpreventableStatic;
    replDamage: DamageReplacementStatic; replZone: ZoneReplacementStatic; replCounters: CounterReplacementStatic;
    replCantGainLife: CantGainLifeStatic; replDraw: DrawReplacementStatic; replEntersUntapped: EntersUntappedStatic;
  }
  interface AsEntersRegistry { replChooseType: ChooseTypeAsEnters }
}

/** Every static this family owns (the union the battlefield scan narrows on). */
type ReplStatic = PreventionShieldStatic | UnpreventableStatic | DamageReplacementStatic | ZoneReplacementStatic
  | CounterReplacementStatic | CantGainLifeStatic | DrawReplacementStatic | EntersUntappedStatic;

// ---------------------------------------------------------------------------------------------------------------
// 3. Shield state (JSON-plain, in `s.ext`)
// ---------------------------------------------------------------------------------------------------------------

/** One live prevention shield. `left` counts down; `'all'` never runs out and `'next'` is spent on the first hit. */
interface ShieldState {
  id: number;
  controller: PlayerId;
  sourceId: number;
  sourceName: string;
  left: number | 'all' | 'next';
  from?: DamageSource;
  to: DamageRecipient;
  /**
   * Instead of `to`: exactly these object ids. Only a shield ADOPTED from the core `prevent-damage` op uses it (see
   * the `prevent-rider` effect) — that shield is a counter parked on one object, not a description of a recipient.
   */
  toIds?: number[];
  /** The source chosen for a `from.chosen` shield (CR 615.10); `-1` = there was no legal source, so it binds nothing. */
  chosenSourceId?: number;
  /** The objects / players this effect targeted, for a `damage-targets` follow-up. */
  targetIds?: number[];
  targetPlayers?: PlayerId[];
  rider?: PreventFollowUp;
}

const shields = (s: GameState): ShieldState[] => extGetOr<Json[]>(s as never, 'replShields', []) as unknown as ShieldState[];
/** The `damage-cant-be-prevented` effects in force this turn (CR 615.6). */
const noPrevent = (s: GameState): { match?: DamageSource; controller: PlayerId }[] =>
  extGetOr<Json[]>(s as never, 'replNoPrevent', []) as unknown as { match?: DamageSource; controller: PlayerId }[];

// ---------------------------------------------------------------------------------------------------------------
// 4. Matching
// ---------------------------------------------------------------------------------------------------------------

/**
 * Would this effect list deal damage at all? Used only to rank the sources a `from.chosen` shield offers (CR 615.10):
 * a burn spell already on the stack is the source these cards are cast in response to. The walk is over the item's
 * own `Effect[]`, which is card data (plain JSON, no cycles), and every damage op is named `damage*`.
 */
const dealsDamage = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(dealsDamage);
  if (v === null || typeof v !== 'object') return false;
  const op = (v as { op?: unknown }).op;
  if (typeof op === 'string' && op.startsWith('damage')) return true;
  return Object.values(v as Record<string, unknown>).some(dealsDamage);
};

/** Does `who` (a controller word read relative to `ctrl`) accept the controller of `o`? */
function whoOk(who: 'you' | 'opponent' | 'any' | undefined, ctrl: PlayerId, of: PlayerId): boolean {
  return who === undefined || who === 'any' ? true : who === 'you' ? of === ctrl : of !== ctrl;
}

/** Does this damage event's SOURCE match? `self` is the object the ability came from (for `filter.other` / `chosen`). */
function sourceMatches(s: GameState, m: DamageSource | undefined, src: GameObject, ctrl: PlayerId, combat: boolean, self: GameObject, chosenId?: number): boolean {
  if (!m) return true;
  if (m.combat === 'combat' && !combat) return false;
  if (m.combat === 'noncombat' && combat) return false;
  if (m.self && src.id !== self.id) return false;
  if (m.attached && !(self.attachedTo !== null && src.id === self.attachedTo)) return false;
  if (!whoOk(m.who, ctrl, src.controller)) return false;
  if (m.chosen && chosenId !== undefined && src.id !== chosenId) return false;
  if (m.filter && !chars.matchesFilter(s, src, m.filter, self)) return false;
  return true;
}

/** Does this damage event's RECIPIENT match? `target` is a player id or the permanent being dealt damage. */
function recipientMatches(s: GameState, r: DamageRecipient, target: GameObject | PlayerId, ctrl: PlayerId, self: GameObject): boolean {
  const objectHalf = r.self === true || r.attached === true || r.filter !== undefined;
  if (typeof target === 'number') {
    if (r.players === undefined) return !objectHalf;                    // "prevent all damage this turn" has neither half
    return r.players === 'any' ? true : r.players === 'you' ? target === ctrl : target !== ctrl;
  }
  if (!objectHalf) return r.players === undefined;
  if (r.self && target.id === self.id) return true;
  if (r.attached && self.attachedTo !== null && target.id === self.attachedTo) return true;
  if (r.filter && whoOk(r.who, ctrl, target.controller) && chars.matchesFilter(s, target, r.filter, self)) return true;
  return false;
}

/**
 * Every static of one kind on the battlefield, with the permanent that carries it (battlefield order, CR 613.7).
 * `key` names the *effect* — "<object id>:<ability index>" — which is what CR 614.5 needs to say "this one has
 * already applied on the way here" without confusing it with another copy of the same card.
 */
function staticsOf<K extends ReplStatic['kind']>(s: GameState, kind: K): { src: GameObject; e: Extract<ReplStatic, { kind: K }>; key: string }[] {
  const out: { src: GameObject; e: Extract<ReplStatic, { kind: K }>; key: string }[] = [];
  for (const o of chars.allPermanents(s)) {
    const abs = chars.abilitiesOf(o);
    for (let i = 0; i < abs.length; i++) {
      const ab = abs[i];
      if (ab.kind === 'static' && (ab.effect as { kind: string }).kind === kind) out.push({ src: o, e: ab.effect as Extract<ReplStatic, { kind: K }>, key: `${o.id}:${i}` });
    }
  }
  return out;
}

/**
 * Can this damage be prevented at all (CR 615.6)? Two sources say no: the `damage-cant-be-prevented` effects in force
 * this turn, and the `unpreventable-damage` statics.
 *
 * Those statics are read TWICE on purpose. `Mods.flags` is a per-permanent layer computation, so it only ever reaches
 * a source that is itself a battlefield permanent — and CR 609.7 lets any object be a source of damage. Leyline of
 * Punishment is printed to beat a Circle of Protection against a *Lightning Bolt*, so the statics are also matched
 * directly against the source here, which `chars.matchesFilter` does in any zone. The flag path stays because it is
 * how another family can GRANT "damage it deals can't be prevented" to one permanent.
 */
function preventable(s: GameState, src: GameObject, combat: boolean): boolean {
  const list = noPrevent(s);
  for (const n of list) if (sourceMatches(s, n.match, src, n.controller, combat, src)) return false;
  for (const { src: self, e } of staticsOf(s, 'unpreventable-damage')) {
    if (e.combat === 'combat' && !combat) continue;
    if (e.combat === 'noncombat' && combat) continue;
    if (!whoOk(e.who, self.controller, src.controller)) continue;
    if (e.filter && !chars.matchesFilter(s, src, e.filter, self)) continue;
    return false;
  }
  if (src.zone === 'battlefield') {
    const f = chars.flags(s, src);
    if (f.replUnpreventableDamage) return false;
    if (combat && f.replUnpreventableCombatDamage) return false;
    if (!combat && f.replUnpreventableNoncombatDamage) return false;
  }
  return true;
}

/**
 * CR 615.6 against the shields the CORE owns. `Game.dealDamage` spends `o.eotFlags.preventDamage` — and
 * `dealDamageToPlayer` the Fog flag — BEFORE the `replacements.damage` fold runs, so `preventable()` above never sees
 * those events and a Skullcrack would otherwise lose to a Healing Salve. Both of those flags last exactly one turn
 * and so does an unrestricted "damage can't be prevented this turn", so taking them away IS switching them off: they
 * could not legally have prevented anything for the rest of the turn anyway.
 *
 * It runs as the effect resolves and again in `sba` — which is before any player receives priority (CR 117.5) — so a
 * core shield put up LATER in the turn is switched off too, before it can be used.
 *
 * A *restricted* no-prevent ("damage dealt by creatures you control can't be prevented") is deliberately left alone:
 * those core shields may still legally answer for other sources, and the core carries no way to ask this family
 * per-event. That half is the ordering fix in the 9.1 report's `coreChangeNeeded`; see docs/vocabulary/replacement.md.
 */
function sweepCoreShields(g: Game): boolean {
  const s = g.state;
  const unrestricted = noPrevent(s).some(n => n.match === undefined
    || (n.match.combat === undefined && n.match.filter === undefined && n.match.who === undefined && !n.match.self && !n.match.attached && !n.match.chosen));
  if (!unrestricted) return false;
  let changed = false;
  for (const o of chars.allPermanents(s)) {
    if (o.eotFlags.preventDamage === undefined) continue;
    delete o.eotFlags.preventDamage;
    g.note(`${chars.name(o)}'s prevention shield does not apply: damage can't be prevented this turn.`);
    changed = true;
  }
  const st = s as GameState & { fog?: number };
  if (st.fog === s.turn) { delete st.fog; g.note("The fog does not apply: damage can't be prevented this turn."); changed = true; }
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------
// 5. The damage fold (CR 614.1a + CR 615)
// ---------------------------------------------------------------------------------------------------------------

/** The shields whose rider is running right now — they may not prevent the damage that rider deals (CR 614.5). */
const ridersRunning = (s: GameState): number[] => extGetOr<number[]>(s as never, 'replRiderActive', []);

/**
 * Run a shield's "if damage is prevented this way …" rider with `n` the amount prevented (CR 615.1).
 *
 * CR 614.5: a replacement effect does not apply to the events it creates itself, and the damage a rider deals is one
 * of those events — the rider and the shield are ONE replacement effect (CR 615.1). Without the guard, a rider that
 * deals its damage into an object the same shield protects ("prevent all damage to creatures you control" + "~ deals
 * that much damage to any target", aimed at one of those creatures) prevents its own damage, runs the rider again on
 * what it just prevented, and recurses until the stack overflows. The shield is marked for the length of the
 * follow-up and `damageHook` skips a marked shield; every OTHER shield still applies, which is what CR 614.5 says.
 */
function runFollowUp(g: Game, sh: ShieldState, rider: PreventFollowUp, src: GameObject, target: GameObject | PlayerId, n: number): void {
  const s = g.state;
  const from = chars.findObject(s, sh.sourceId);
  const busy = ridersRunning(s);
  extSet(s as never, 'replRiderActive', [...busy, sh.id] as unknown as Json);
  try {
    switch (rider.mode) {
      case 'gain-life': g.gainLife(sh.controller, n); break;
      case 'damage-source': if (from && src.zone === 'battlefield') g.dealDamage(from, src, n); break;
      case 'damage-source-controller': if (from) g.dealDamageToPlayer(from, src.controller, n); break;
      case 'damage-targets': {
        if (!from) break;
        for (const id of sh.targetIds ?? []) { const o = chars.findObject(s, id); if (o && o.zone === 'battlefield') g.dealDamage(from, o, n); }
        for (const p of sh.targetPlayers ?? []) g.dealDamageToPlayer(from, p, n);
        break;
      }
      case 'counters': if (typeof target !== 'number' && target.zone === 'battlefield') g.addCounters(target, rider.counter, n); break;
    }
  } finally { if (busy.length) extSet(s as never, 'replRiderActive', busy as unknown as Json); else extDel(s as never, 'replRiderActive'); }
}

function damageHook(g: Game, src: GameObject, target: GameObject | PlayerId, n: number, combat: boolean): number {
  const s = g.state;
  let amount = n;

  // The matching `damage-replacement` statics, read once: the modifiers apply now (CR 614.1a) and the "prevent N of
  // that damage" ones are prevention effects (CR 615.2), so they wait for the CR 615.6 gate below.
  const mods = staticsOf(s, 'damage-replacement')
    .filter(({ src: self, e }) => sourceMatches(s, e.from, src, self.controller, combat, self) && (!e.to || recipientMatches(s, e.to, target, self.controller, self)));

  // ---- CR 614.1a: what is dealt, and how much
  for (const { src: self, e } of mods) {
    const ins = e.instead;
    if (ins.mode === 'plus') amount += ins.amount;
    else if (ins.mode === 'times') amount *= ins.factor;
    else if (ins.mode === 'none') { g.note(`${chars.name(self)}: the damage ${chars.name(src)} would deal is not dealt.`); return 0; }
    else if (ins.mode === 'counters') {
      if (typeof target === 'number') continue;                          // "on that creature": a player takes the damage as printed
      g.note(`${chars.name(self)}: ${chars.name(src)}'s ${amount} damage becomes ${amount} ${ins.counter} counters on ${chars.name(target)}.`);
      g.addCounters(target, ins.counter, amount);
      return 0;
    }
  }
  if (amount <= 0) return 0;
  if (!preventable(s, src, combat)) return amount;                       // CR 615.6

  // ---- CR 615.2: "prevent N of that damage" is a prevention effect, so it is switched off by CR 615.6 too
  for (const { src: self, e } of mods) {
    if (e.instead.mode !== 'minus') continue;
    const prevented = Math.min(e.instead.amount, amount);
    if (prevented <= 0) continue;
    amount -= prevented;
    g.emit({ type: 'prevented', ...(typeof target === 'number' ? { player: target } : { id: target.id, name: chars.name(target) }), amount: prevented, by: chars.name(self) });
    if (amount <= 0) return 0;
  }

  // ---- CR 615.1: continuous shields first, then the one-shot shields in creation order
  for (const { src: self, e } of staticsOf(s, 'prevention-shield')) {
    if (!sourceMatches(s, e.from, src, self.controller, combat, self)) continue;
    if (!recipientMatches(s, e.to, target, self.controller, self)) continue;
    g.emit({ type: 'prevented', ...(typeof target === 'number' ? { player: target } : { id: target.id, name: chars.name(target) }), amount, by: chars.name(self) });
    return 0;
  }
  const live = shields(s);
  const busy = ridersRunning(s);
  for (let i = 0; i < live.length && amount > 0; i++) {
    const sh = live[i];
    const self = chars.findObject(s, sh.sourceId);
    if (!self) continue;
    if (busy.includes(sh.id)) continue;                                  // CR 614.5: not to the damage its own rider deals
    if (!sourceMatches(s, sh.from, src, sh.controller, combat, self, sh.chosenSourceId)) continue;
    if (sh.toIds ? typeof target === 'number' || !sh.toIds.includes(target.id) : !recipientMatches(s, sh.to, target, sh.controller, self)) continue;
    const prevented = sh.left === 'all' || sh.left === 'next' ? amount : Math.min(sh.left, amount);
    if (prevented <= 0) continue;
    amount -= prevented;
    if (typeof sh.left === 'number') sh.left -= prevented;
    g.emit({ type: 'prevented', ...(typeof target === 'number' ? { player: target } : { id: target.id, name: chars.name(target) }), amount: prevented, by: sh.sourceName });
    if (sh.left === 'next' || (typeof sh.left === 'number' && sh.left <= 0)) { live.splice(i, 1); i--; }
    if (sh.rider) runFollowUp(g, sh, sh.rider, src, target, prevented);
  }
  return amount;
}

// ---------------------------------------------------------------------------------------------------------------
// 6. The zone-change fold (CR 614.1a) and the enters-untapped marker (CR 614.12)
// ---------------------------------------------------------------------------------------------------------------

function zoneMoveHook(g: Game, o: GameObject, zone: Zone, _pos: 'top' | 'bottom', reason: string): { zone?: Zone; pos?: 'top' | 'bottom'; emit?: string } | null {
  const s = g.state;
  // "Lands you control enter untapped": nothing has moved yet and `o.tapped` is decided *after* this fold, so the
  // permanent is only marked here and the untap itself happens in the state-based-action pass that follows the
  // enter — before any player receives priority, so a land tapped for mana later that turn is never touched.
  if (zone === 'battlefield' && reason === 'enter') {
    for (const { src: self, e } of staticsOf(s, 'enters-untapped')) {
      if (e.who === 'you' && o.controller !== self.controller) continue;
      if (!chars.matchesFilter(s, o, e.filter, self)) continue;
      extPush(s as never, 'replUntapPending', o.id);
      break;
    }
    return null;
  }
  if (zone !== 'graveyard' && zone !== 'exile' && zone !== 'hand' && zone !== 'library') return null;
  for (const { src: self, e } of staticsOf(s, 'zone-replacement')) {
    const w = e.would;
    if (w.to !== zone) continue;
    if (w.from === 'battlefield' && o.zone !== 'battlefield') continue;
    if (w.from === 'stack' && o.zone !== 'stack') continue;
    if (w.self) { if (o.id !== self.id) continue; }
    else {
      if (!whoOk(w.who, self.controller, o.controller)) continue;
      if (w.filter && !chars.matchesFilter(s, o, w.filter, self)) continue;
    }
    return { zone: e.instead.zone, ...(e.instead.pos ? { pos: e.instead.pos } : {}), emit: `${chars.name(o)} is put into ${e.instead.zone === 'library' ? `its owner's library (${e.instead.pos ?? 'top'})` : `the ${e.instead.zone}`} instead (${chars.name(self)}).` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 7. The counter, draw and life-gain folds
// ---------------------------------------------------------------------------------------------------------------

function countersHook(g: Game, o: GameObject, counter: string, delta: number): number {
  // Same scope as the core's `counters-replacement` (CR 614.1c, 121.4): counters being PUT ON a permanent on the
  // battlefield, never loyalty (which is a cost, not a counter being put on).
  if (delta <= 0 || counter === 'loyalty' || o.zone !== 'battlefield') return delta;
  const s = g.state;
  let n = delta;
  for (const { src: self, e } of staticsOf(s, 'counter-replacement')) {
    if (e.counter !== undefined && e.counter !== counter) continue;
    if (!whoOk(e.who, self.controller, o.controller)) continue;
    if (e.filter && !chars.matchesFilter(s, o, e.filter, self)) continue;
    const ins = e.instead;
    if (ins.mode === 'none') { g.note(`${chars.name(self)}: the ${counter} counters are not put on ${chars.name(o)}.`); return 0; }
    n = ins.mode === 'plus' ? n + ins.amount : ins.mode === 'minus' ? Math.max(0, n - ins.amount) : n * ins.factor;
  }
  return n;
}

function drawHook(g: Game, p: PlayerId): boolean {
  const s = g.state;
  const pl = s.players[p];
  // CR 614.5: a replacement effect applies to an event at most once, and it does not apply to the events it creates
  // itself — but a DIFFERENT one still applies to each of those. `replDrawApplied` is the chain of effects already
  // used on the way down to this draw, keyed per effect, so two draw doublers give four cards for one draw (the
  // published ruling for stacking them) instead of the two a single "am I re-entrant?" boolean would allow.
  const applied = extGetOr<string[]>(s as never, 'replDrawApplied', []);
  // CR 121.6 / 504.1: BOTH "skip your draw step" and "except the first one you draw in each of your draw steps" are
  // about one draw — the one the draw step takes as its turn-based action — and not about "any draw while the step
  // happens". An upkeep draw must not spend the exemption, and an activated ability that draws during its
  // controller's own draw step (Yawgmoth's Bargain) is nobody's turn-based draw and must not be skipped.
  //
  // That draw is the first draw EVENT of the active player's draw step: it is taken before any player receives
  // priority (CR 117.5), so nothing else can have drawn yet. The mark is keyed by turn and player; the nested draws a
  // replacement makes carry an `applied` chain and are never "the first one you draw"; and the family's own `draw`
  // step hook sets the mark right after the turn-based draw, which closes the window even on a turn where no
  // turn-based draw happened at all (the starting player's first turn, or a draw step some other effect skipped).
  const stepKey = `${s.turn}:${p}`;
  const turnBased = s.step === 'draw' && s.activePlayer === p && applied.length === 0
    && extGet<string>(s as never, 'replDrawStepSeen') !== stepKey;
  if (turnBased) extSet(s as never, 'replDrawStepSeen', stepKey);
  for (const { src: self, e, key } of staticsOf(s, 'draw-replacement')) {
    if (applied.includes(key)) continue;                                   // CR 614.5: this one has already applied
    if (e.who === 'you' && p !== self.controller) continue;
    if (e.who === 'opponent' && p === self.controller) continue;
    if (e.drawStepOnly && !turnBased) continue;
    if (e.exceptFirstInDrawStep && turnBased) continue;
    if (e.instead === 'skip') { g.note(`${pl.name} skips the draw (${chars.name(self)}).`); return true; }
    // "draw two cards instead": `Game.draw` only ever awaits in its dredge branch, so the recursion below is
    // synchronous as long as this player has no dredge card in the graveyard. When they do, the replacement stands
    // down rather than leaving a floating promise (documented in docs/vocabulary/replacement.md).
    if (pl.graveyard.some(c => c.def.dredge !== undefined && pl.library.length >= c.def.dredge)) continue;
    extSet(s as never, 'replDrawApplied', [...applied, key] as unknown as Json);
    try { for (let i = 0; i < e.instead; i++) void g.draw(p); }
    finally { if (applied.length) extSet(s as never, 'replDrawApplied', applied as unknown as Json); else extDel(s as never, 'replDrawApplied'); }
    g.note(`${pl.name} draws ${e.instead} cards instead of one (${chars.name(self)}).`);
    return true;
  }
  return false;
}

function lifeGainHook(g: Game, p: PlayerId, n: number): number {
  const s = g.state;
  for (const { src: self, e } of staticsOf(s, 'cant-gain-life')) {
    if (e.who === 'you' && p !== self.controller) continue;
    if (e.who === 'opponent' && p === self.controller) continue;
    g.note(`${s.players[p].name} can't gain life (${chars.name(self)}).`);
    return 0;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// 8. Rendering (round-trip English for scripts:verify)
// ---------------------------------------------------------------------------------------------------------------

const filterWords = (f: Filter | undefined, dflt = 'source'): string => {
  if (!f) return dflt;
  const parts: string[] = [];
  if (f.other) parts.push('another');
  if (f.colors?.length) parts.push(f.colors.map(c => ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' })[c] ?? c).join(' and '));
  if (f.types?.length) parts.push(f.types.map(t => t.toLowerCase()).join(' or '));
  if (f.subtypes?.length) parts.push(f.subtypes.join(' or '));
  if (f.powerLE !== undefined) parts.push(`with power ${f.powerLE} or less`);
  if (f.powerGE !== undefined) parts.push(`with power ${f.powerGE} or greater`);
  if (f.dealtDamageBySource) parts.push('dealt damage by ~ this turn');
  return parts.length ? parts.join(' ') : dflt;
};
const controlWords = (who: 'you' | 'opponent' | 'any' | undefined): string => (who === 'you' ? ' you control' : who === 'opponent' ? ' an opponent controls' : '');
const sourceWords = (m: DamageSource | undefined): string => {
  if (!m || (m.filter === undefined && m.who === undefined && !m.chosen && !m.self && !m.attached)) return '';
  const head = m.self ? '~' : m.attached ? 'enchanted creature'
    : m.chosen ? `a ${filterWords(m.filter)} of your choice`
      : `${filterWords(m.filter, 'sources')}${controlWords(m.who)}`;
  return ` by ${head}`;
};
const recipientWords = (r: DamageRecipient): string => {
  const parts: string[] = [];
  if (r.players === 'you') parts.push('you');
  if (r.players === 'each-opponent') parts.push('each opponent');
  if (r.players === 'any') parts.push('any player');
  if (r.self) parts.push('~');
  if (r.attached) parts.push('enchanted permanent');
  if (r.filter) parts.push(`${filterWords(r.filter, 'permanents')}${controlWords(r.who)}`);
  return parts.length ? ` to ${parts.join(' and ')}` : '';
};
const combatWords = (m: DamageSource | undefined): string => (m?.combat === 'combat' ? 'combat damage' : m?.combat === 'noncombat' ? 'noncombat damage' : 'damage');
const insteadWords = (i: DamageInstead): string =>
  i.mode === 'plus' ? `it deals that much damage plus ${i.amount} instead`
    : i.mode === 'times' ? `it deals ${i.factor === 2 ? 'double' : `${i.factor} times`} that damage instead`
      : i.mode === 'minus' ? `prevent ${i.amount} of that damage`
        : i.mode === 'counters' ? `put that many ${i.counter} counters on it instead`
          : 'that damage is not dealt';

// ---------------------------------------------------------------------------------------------------------------
// 9. The module
// ---------------------------------------------------------------------------------------------------------------

const REPLACEMENT: FamilyModule = {
  name: 'replacement',

  effects: {
    // CR 615.1: a shield is created as this resolves, and it is the shield — not this effect — that prevents.
    'prevent': async (e: PreventEffect, c) => {
      const s = c.s;
      const left: number | 'all' | 'next' = e.amount === 'all' || e.amount === 'next' ? e.amount : c.amt(e.amount);
      if (typeof left === 'number' && left <= 0) return;
      let chosenSourceId: number | undefined;
      if (e.from?.chosen) {
        // CR 615.10: the source is chosen as the shield is created. Any permanent or spell on the stack that could
        // deal damage is a legal choice; the shield's own `from.filter` narrows the list.
        //
        // The ORDER of the candidates is what a shipped agent that just takes the first option ends up choosing, so
        // it is the useful order rather than the battlefield's — the source that is actually about to deal the
        // damage this shield answers for, as far as the board says:
        //
        //   0  a spell on the stack that deals damage (what these cards are almost always cast in response to)
        //   1  any other spell on the stack
        //   2  a creature attacking the chooser, 3 one attacking somebody else, 4 one that is blocking
        //   5  any other permanent another player controls, 6 the chooser's own permanents
        //
        // and inside a tier the source that would deal the most damage first (a creature's power), then by id, so
        // the pick is deterministic — the fuzzer and the goldens need that. Nothing legal is removed: the decision
        // still offers every source, and a real agent may take any of them.
        const dmgSpell = new Set(s.stack.filter(it => dealsDamage(it.effects)).map(it => it.source.id));
        const rank = (o: GameObject): number => (o.zone === 'stack' ? (dmgSpell.has(o.id) ? 0 : 1)
          : o.controller !== c.p ? (o.attacking !== null ? (o.attacking === c.p ? 2 : 3) : o.blocking.length ? 4 : 5)
            : 6);
        const threat = (o: GameObject): number => (chars.isCreature(o) ? chars.power(s, o) : 0);
        const cands = [...chars.allPermanents(s), ...s.stack.map(it => it.source)]
          .filter(o => o.id !== c.src.id && (!e.from?.filter || chars.matchesFilter(s, o, e.from.filter, c.src)) && (e.from?.who === undefined || e.from.who === 'any' || (e.from.who === 'you' ? o.controller === c.p : o.controller !== c.p)))
          .sort((a, b) => rank(a) - rank(b) || threat(b) - threat(a) || a.id - b.id);
        if (cands.length) {
          const pick = await c.g.ask(c.p, { kind: 'choose-cards', from: cands.map(o => o.id), count: 1, reason: `${chars.name(c.src)}: choose a source of damage`, exact: false }) as number[];
          const id = Array.isArray(pick) ? pick[0] : undefined;
          chosenSourceId = cands.some(o => o.id === id) ? id : cands[0].id;
        } else {
          // No legal source to choose. The shield still exists, but CR 615.10 binds it to a source and there is none,
          // so it answers for nothing. Leaving the binding `undefined` would make `sourceMatches` accept EVERY source
          // — strictly better than the printed card, and a Circle of Protection activated on an empty board would
          // eat the next burn spell — so it binds an id no object can ever have.
          chosenSourceId = -1;
          c.g.note(`${chars.name(c.src)}: there is no source of damage to choose, so the shield answers for nothing.`);
        }
      }
      const sh: ShieldState = {
        id: (extGetOr<number>(s as never, 'replShieldSeq', 0)) + 1,
        controller: c.p, sourceId: c.src.id, sourceName: chars.name(c.src),
        left, ...(e.from ? { from: e.from } : {}), to: e.to, ...(chosenSourceId !== undefined ? { chosenSourceId } : {}),
        ...(e.rider ? { rider: e.rider } : {}),
      };
      if (e.rider?.mode === 'damage-targets') {
        sh.targetIds = c.T.filter(t => t.kind === 'object').map(t => t.id);
        sh.targetPlayers = c.T.filter(t => t.kind === 'player').map(t => t.id);
      }
      extSet(s as never, 'replShieldSeq', sh.id);
      extPush<Json>(s as never, 'replShields', sh as unknown as Json);
      c.g.note(`${sh.sourceName}: ${left === 'all' ? 'all' : left === 'next' ? 'the next' : left} ${combatWords(e.from)}${recipientWords(e.to)}${sourceWords(e.from)} will be prevented this turn.`);
    },

    // CR 615.1: the "if damage is prevented this way, ..." half of the same replacement effect, printed as its own
    // sentence. It rides on the shields this source has just created and has nothing to do on its own.
    'prevent-rider': (e: PreventRiderEffect, c) => {
      const s = c.s;
      const attach = (sh: ShieldState): void => {
        sh.rider = e.rider;
        if (e.rider.mode === 'damage-targets') {
          sh.targetIds = c.T.filter(t => t.kind === 'object').map(t => t.id);
          sh.targetPlayers = c.T.filter(t => t.kind === 'player').map(t => t.id);
        }
      };
      let n = 0;
      for (const sh of shields(s)) {
        if (sh.sourceId !== c.src.id || sh.rider !== undefined) continue;
        attach(sh);
        n++;
      }
      // No shield of this family's to ride on: the shield half of the same card was claimed by the CORE
      // `prevent-damage` op (parse.ts owns "prevent the next N damage that would be dealt to <target> this turn"),
      // which parks a counter on each target object — and `dealDamage` spends that counter before any family
      // replacement is consulted, so the rider could never see what it prevented.
      //
      // So the rider takes the counter over. CR 615.1: this is ONE replacement effect printed as two sentences, and
      // it makes no difference which half of the engine holds the shield, as long as the half that holds it can run
      // the follow-up. The adopted shield is bound to exactly the objects this resolution targeted (`toIds`), which
      // is what "that creature" in the rider means, and behaves like any other shield from there on.
      //
      // Only a counter THIS resolution parked may be adopted, which is why the objects are read off the sibling
      // `prevent-damage` effect of this very item rather than off every target the item chose. A shield another
      // spell created belongs to that spell's replacement effect (CR 615.1): a Healing Salve's 3 points sitting on
      // the creature a Divine Deflection merely targets are not this card's to take, and adopting them would delete
      // the shield that was doing the protecting and re-arm it with this card's rider. When the shield sentence of
      // this card is the unparsed one, there is no sibling and nothing is adopted — the `unsimulated` path below.
      if (!n) {
        const ids = new Set<number>();
        const effs = c.g.effectiveEffects(c.item);
        for (let i = 0; i < effs.length; i++) {
          const sib = effs[i];
          if (sib.op !== 'prevent-damage') continue;
          if (sib.target === 'self') { ids.add(c.src.id); continue; }
          for (const t of c.item.targetsByEffect.get(i) ?? []) if (t.kind === 'object') ids.add(t.id);
        }
        for (const id of ids) {
          const o = chars.findObject(s, id);
          const left = o?.eotFlags.preventDamage;
          if (!o || left === undefined || (typeof left === 'number' && left <= 0)) continue;
          delete o.eotFlags.preventDamage;
          const sh: ShieldState = {
            id: (extGetOr<number>(s as never, 'replShieldSeq', 0)) + 1,
            controller: c.p, sourceId: c.src.id, sourceName: chars.name(c.src), left, to: {}, toIds: [o.id],
          };
          attach(sh);
          extSet(s as never, 'replShieldSeq', sh.id);
          extPush<Json>(s as never, 'replShields', sh as unknown as Json);
          n++;
        }
      }
      if (n) { c.g.note(`${chars.name(c.src)}: damage prevented this way will not be wasted.`); return; }
      // Nothing at all to ride on (the shield sentence of this card is itself unparsed). Rather than let the clause
      // disappear from a card the coverage report might call fully parsed, it is reported through the engine's own
      // "skipped a clause" channel, which `verify:pool`, the fidelity ratchet and `{ unsimulated: n }` all count.
      c.g.emit({ type: 'unsimulated', id: c.src.id, name: chars.name(c.src), clause: 'if damage is prevented this way, … (no prevention shield of this effect to attach to)' });
    },

    // CR 615.6: prevention shields simply do not apply to matching damage for the rest of the turn.
    'damage-cant-be-prevented': (e: UnpreventableEffect, c) => {
      extPush<Json>(c.s as never, 'replNoPrevent', { ...(e.match ? { match: e.match } : {}), controller: c.p } as unknown as Json);
      c.g.note(`${chars.name(c.src)}: ${combatWords(e.match)}${sourceWords(e.match)} can't be prevented this turn.`);
      sweepCoreShields(c.g);                                               // CR 615.6 against the core's own shields
    },
  },

  // The one static here that really is a characteristic of another permanent: "damage dealt BY <these> can't be
  // prevented" is read off the damage source, so it rides on `Mods.flags` and is cached with every other layer.
  statics: {
    'unpreventable-damage': (e: UnpreventableStatic, src, o, s, m) => {
      if (!whoOk(e.who, src.controller, o.controller)) return;
      if (e.filter && !chars.matchesFilter(s, o, e.filter, src)) return;
      m.flags[e.combat === 'combat' ? 'replUnpreventableCombatDamage' : e.combat === 'noncombat' ? 'replUnpreventableNoncombatDamage' : 'replUnpreventableDamage'] = true;
    },
  },

  // CR 614.12: "As ~ enters, choose a basic land type." The chosen type lives in `ext` (the core `chosen` bag has a
  // slot for a colour and a creature type only); a type-changing static reads `o.ext.chosenLandType`.
  asEnters: {
    'choose-type': async (a: ChooseTypeAsEnters, o, ctx, g) => {
      void a;
      const options = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
      const pick = ctx.sync ? options[0] : await g.ask(ctx.controller, { kind: 'choose-option', options, reason: `${chars.name(o)}: choose a basic land type` }) as string;
      const t = options.includes(pick) ? pick : options[0];
      extSet(o, 'chosenLandType', t);
      g.note(`${chars.name(o)}: ${g.pname(ctx.controller)} chooses ${t}.`);
    },
  },

  replacements: {
    damage: damageHook,
    zoneMove: zoneMoveHook,
    counters: countersHook,
    draw: drawHook,
    lifeGain: lifeGainHook,
  },

  // CR 614.12 finished: a permanent marked as it entered is untapped in the state-based-action pass that follows,
  // which is before any player receives priority (CR 117.5). The mark is removed either way, so the check happens
  // exactly once per enter and a permanent tapped later that turn is never touched.
  sba: (g) => {
    const s = g.state;
    // CR 615.6 first: a core prevention shield created since the last check is switched off before it can be used.
    let changed = sweepCoreShields(g);
    const pending = extGet<number[]>(s as never, 'replUntapPending');
    if (pending === undefined || !pending.length) return changed;
    extDel(s as never, 'replUntapPending');
    for (const id of pending) {
      const o = chars.findObject(s, id);
      if (!o || o.zone !== 'battlefield' || !o.tapped) continue;
      g.setTapped(o, false);
      g.note(`${chars.name(o)} enters untapped.`);
      changed = true;
    }
    return changed;
  },

  steps: {
    // CR 504.1: `game.ts` takes the draw step's turn-based draw and then runs this hook, still before any player
    // receives priority. Once it has fired, every later draw in the step belongs to a spell or an ability, so the
    // window closes here whether or not a turn-based draw actually happened (the starting player's first turn draws
    // nothing at all) — see `drawHook` for the `drawStepOnly` / `exceptFirstInDrawStep` half of the same mark.
    'draw': (g, ap) => { extSet(g.state as never, 'replDrawStepSeen', `${g.state.turn}:${ap}`); },

    // CR 514.2: "this turn" shields and "can't be prevented this turn" effects end as the turn does.
    'cleanup-end': (g) => {
      extDel(g.state as never, 'replShields'); extDel(g.state as never, 'replNoPrevent');
      extDel(g.state as never, 'replUntapPending'); extDel(g.state as never, 'replDrawStepSeen');
    },
  },

  render: {
    'prevent': (e: PreventEffect) => {
      const head = e.amount === 'all' ? `Prevent all ${combatWords(e.from)}`
        : e.amount === 'next' ? `The next time a ${filterWords(e.from?.filter)}${e.from?.chosen ? ' of your choice' : ''}${controlWords(e.from?.who)} would deal ${combatWords(e.from)}${recipientWords(e.to)} this turn, prevent that damage`
          : `Prevent the next ${typeof e.amount === 'number' ? e.amount : 'X'} ${combatWords(e.from)}`;
      const tail = e.amount === 'next' ? '' : ` that would be dealt${recipientWords(e.to)}${sourceWords(e.from)} this turn`;
      const rider = e.rider === undefined ? ''
        : e.rider.mode === 'gain-life' ? '. You gain life equal to the damage prevented this way'
          : e.rider.mode === 'damage-source' ? '. If damage is prevented this way, ~ deals that much damage to that source'
            : e.rider.mode === 'damage-source-controller' ? ". If damage is prevented this way, ~ deals that much damage to that source's controller"
              : e.rider.mode === 'damage-targets' ? '. If damage is prevented this way, ~ deals that much damage to any target'
                : `. For each 1 damage prevented this way, put a ${e.rider.counter} counter on that creature`;
      return `${head}${tail}${rider}`;
    },
    'prevent-rider': (e: PreventRiderEffect) => (e.rider.mode === 'gain-life' ? 'You gain life equal to the damage prevented this way'
      : e.rider.mode === 'damage-source' ? 'If damage is prevented this way, ~ deals that much damage to that source'
        : e.rider.mode === 'damage-source-controller' ? "If damage is prevented this way, ~ deals that much damage to that source's controller"
          : e.rider.mode === 'damage-targets' ? 'If damage is prevented this way, ~ deals that much damage to any target'
            : `For each 1 damage prevented this way, put a ${e.rider.counter} counter on that creature`),
    'damage-cant-be-prevented': (e: UnpreventableEffect) => `${combatWords(e.match)}${sourceWords(e.match)} can't be prevented this turn`,
    'prevention-shield': (e: PreventionShieldStatic) => `Prevent all ${combatWords(e.from)} that would be dealt${recipientWords(e.to)}${sourceWords(e.from)}`,
    'unpreventable-damage': (e: UnpreventableStatic) => `${e.combat === 'combat' ? 'Combat damage' : e.combat === 'noncombat' ? 'Noncombat damage' : 'Damage'}${e.filter || e.who ? ` that would be dealt by ${filterWords(e.filter, 'sources')}${controlWords(e.who)}` : ''} can't be prevented`,
    'damage-replacement': (e: DamageReplacementStatic) => `If ${e.from?.self ? '~' : e.from?.attached ? 'enchanted creature' : `${filterWords(e.from?.filter, 'a source')}${controlWords(e.from?.who)}`} would deal ${combatWords(e.from)}${e.to ? recipientWords(e.to) : ''}, ${insteadWords(e.instead)}`,
    'zone-replacement': (e: ZoneReplacementStatic) => `If ${e.would.self ? '~' : `${filterWords(e.would.filter, 'a permanent')}${controlWords(e.would.who)}`} would ${e.would.to === 'graveyard' && e.would.from === 'battlefield' ? 'die' : `be put into ${e.would.to === 'library' ? "its owner's library" : `a ${e.would.to}`}`}, put it into ${e.instead.zone === 'library' ? `its owner's library (${e.instead.pos ?? 'top'})` : `the ${e.instead.zone}`} instead`,
    'counter-replacement': (e: CounterReplacementStatic) => `If one or more ${e.counter ?? ''} counters would be put on ${filterWords(e.filter, 'a permanent')}${controlWords(e.who)}, ${e.instead.mode === 'none' ? "that counter isn't put on it" : e.instead.mode === 'plus' ? `that many plus ${e.instead.amount} are put on it instead` : e.instead.mode === 'minus' ? `that many minus ${e.instead.amount} are put on it instead` : `${e.instead.factor === 2 ? 'twice' : `${e.instead.factor} times`} that many are put on it instead`}`,
    'cant-gain-life': (e: CantGainLifeStatic) => `${e.who === 'all' ? 'Players' : e.who === 'you' ? 'You' : 'Your opponents'} can't gain life`,
    'draw-replacement': (e: DrawReplacementStatic) => (e.instead === 'skip' && e.drawStepOnly
      ? `${e.who === 'you' ? 'Skip your draw step' : e.who === 'opponent' ? 'Each opponent skips their draw step' : 'Each player skips their draw step'}`
      : e.instead === 'skip' ? `${e.who === 'you' ? 'You' : e.who === 'opponent' ? 'Your opponents' : 'Players'} can't draw cards`
        : `If ${e.who === 'you' ? 'you' : 'a player'} would draw a card${e.exceptFirstInDrawStep ? ' except the first one drawn in each draw step' : ''}, draw ${e.instead} cards instead`),
    'enters-untapped': (e: EntersUntappedStatic) => `${filterWords(e.filter, 'Permanents')}${e.who === 'you' ? ' you control' : ''} enter untapped`,
    'choose-type': () => 'As ~ enters, choose a basic land type',
  },
};

export default REPLACEMENT;
