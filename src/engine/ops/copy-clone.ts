// The copy / clone family (Phase 9.1; docs/vocabulary/copy-clone.md).
//
// Everything CR 707 ("Copying Objects"), CR 706 ("Copying Spells and Abilities" — 706 is the object rule, 707.10 the
// spell/ability one) and CR 115.7 ("changing targets") ask for that the core does not already do:
//
//   copy-permanent   "Create a token that's a copy of target creature you control, except it's a 4/4 black Zombie"
//   copy-stack       "Copy target instant or sorcery spell" / "copy that spell" / "Copy target activated ability"
//   change-targets   "You may choose new targets for target spell or ability" / "Change the target of ..."
//   become-copy      "~ becomes a copy of target creature until end of turn"
//   enter-as-copy    "You may have ~ enter as a copy of any creature on the battlefield" (an as-enters replacement)
//   cant-be-copied   "~ can't be copied" (a static; the copy ops consult it)
//   spell-or-ability / single-target-spell-or-ability   the two stack target kinds CR 115.7 needs
//
// The core already has the two *unmodified* forms (`token-copy`, `copy-spell`); this family is the modified ones —
// exceptions (CR 707.9a), a copy count, Refs instead of a target spec, copies of ABILITIES, and retargeting.
//
// Two representation choices carry most of the fidelity:
//
//   * a token copy is a real object whose `def` is the *derived* CardDef (the copiable values of what was copied, CR
//     707.2, with the exception applied) and whose `token` TokenSpec mirrors it, so every reader in the engine —
//     `types` / `subtypes` / `colors` / power / toughness / `keywords` / `abilitiesOf` (a token's abilities are its
//     `grantedAbilities`) / the legend rule (`o.def.supertypes`) / toxic N (`o.def.toxic`) — answers about the copy;
//   * a copy of a SPELL is a fresh stack item whose source is a fresh object flagged `token`. That one flag is CR
//     707.10a exactly: when the copy finishes resolving, `finishSpell` either sends an instant/sorcery copy to the
//     graveyard — where `moveTo`'s token branch makes it cease to exist — or, for a permanent spell, calls
//     `enterBattlefield`, whose token branch puts it onto the battlefield as a token. No core change either way.
//
// A copy of an ABILITY keeps the original's source object (CR 707.10: the copy has the same source), so nothing is
// minted for it. `ext` holds nothing but two JSON-plain markers (`ccCopyUntilTurn`, `ccSpellCopy`).
import type { CardType, Color, Ref } from '../../cards/types.js';
import type {
  Ability, Amount, CardDef, FamilyModule, Filter, Game, GameObject, GameState, Keyword, OpCtx,
  PlayerId, StackItem, TargetRef, TargetSpec, TokenSpec,
} from './types.js';
import { extDel, extGet, extSet } from './ext.js';
import { chars } from './chars.js';

// ------------------------------------------------------------------ 1. the AST

/**
 * The "except ..." clause of a copy effect (CR 707.9a: the copiable values are the original's, modified by this).
 * A field that *replaces* (`power`, `colors`, `subtypes`, `types`) is the "except it's a 4/4 black Zombie" reading;
 * an `add*` field is the "in addition to its other types" reading. `keywords` and `abilities` are always additive
 * ("except it has haste and \"When this token leaves the battlefield, ...\"").
 */
export interface CopyException {
  /** "except it's 1/1" / "except it's a 4/4 black Zombie". */
  power?: number; toughness?: number;
  /** "except it's black": the copy's colours are exactly these (CR 707.9a). */ colors?: Color[];
  /** "except its name is ...". */ name?: string;
  /** Card types, replaced. */ types?: CardType[];
  /** "except it's an artifact in addition to its other types". */ addTypes?: CardType[];
  /** Subtypes, replaced ("a 4/4 black Zombie" is a Zombie and nothing else). */ subtypes?: string[];
  /** "except it's a Spirit in addition to its other types". */ addSubtypes?: string[];
  /** "except it has haste". */ keywords?: Keyword[];
  /** The N of "has toxic N" (the engine reads the keyword's parameter off the def). */ toxic?: number;
  /** "except it isn't legendary" (CR 205.4, so the legend rule leaves it alone). */ notLegendary?: boolean;
  /** "except it has no abilities". */ loseAbilities?: boolean;
  /** 'except it has "At the beginning of the end step, sacrifice this token."' */ abilities?: Ability[];
}

/** "Create N token(s) that's a copy of X[, except ...]" (CR 707.2, 111.1). */
export interface CopyPermanentEffect {
  op: 'copy-permanent';
  /** What is copied: a target spec chosen on cast, or a Ref the frame already binds ("a copy of it"). */
  target: TargetSpec | Ref;
  /** How many tokens per copied object (default 1). */ count?: Amount;
  except?: CopyException;
  tapped?: boolean;
  /** "and that's attacking": `'each-other-opponent'` spreads them (myriad-style). */
  attacking?: 'each-other-opponent' | boolean;
}

/** "Copy target instant or sorcery spell" / "copy that spell" / "Copy target activated or triggered ability" (CR 707.10). */
export interface CopyStackEffect {
  op: 'copy-stack';
  /** The spell or ability copied: a stack target spec, or a Ref resolving to a spell's card ('triggering', 'that'). */
  target: TargetSpec | Ref;
  /** How many copies (default 1) — "copy it for each time you've cast your commander". */ count?: Amount;
  /** "You may choose new targets for the copy" (CR 707.10c / 115.7). */ newTargets?: 'may';
}

/** "You may choose new targets for target spell or ability" / "Change the target of target spell or ability" (CR 115.7). */
export interface ChangeTargetsEffect {
  op: 'change-targets';
  /**
   * The spell or ability retargeted: a stack target spec (`spell-or-ability` / `single-target-spell-or-ability`), or
   * the word `'the-copies'` — "You may choose new targets for the copy", the sentence that always follows a
   * `copy-stack` in the same ability and names the copies it just put on the stack (CR 707.10c).
   */
  target: TargetSpec | 'the-copies';
  /** `'choose-new'`: every target may be changed or kept (115.7b). `'change-one'`: the single target is changed (115.7). */
  how: 'choose-new' | 'change-one';
  /** Ask first ("you may ..."); the parser gets this from parse.ts's own `may` wrapper instead. */ optional?: boolean;
}

/** "~ becomes a copy of target creature until end of turn" (CR 706.2, 613.2 — the copy is applied in layer 1). */
export interface BecomeCopyEffect {
  op: 'become-copy';
  /** What is copied. */ target: TargetSpec | Ref;
  /** Which permanent becomes the copy (default the source). */ becomes?: Ref;
  duration: 'eot' | 'permanent';
  except?: CopyException;
}

/** "You may have ~ enter as a copy of any creature on the battlefield" (CR 706.9, a copy replacement effect). */
export interface EnterAsCopyAsEnters {
  kind: 'enter-as-copy';
  /** What may be copied (default: any creature). */ filter?: Filter;
  /** `'you'` = "a creature you control"; default: any permanent on the battlefield. */ who?: 'you' | 'any';
  /** "You may have ..." — declining means it enters as itself. */ optional?: boolean;
  except?: CopyException;
}

/** "~ can't be copied." (CR 706.2 does not forbid it; a card ability does.) */
export interface CantBeCopiedStatic { kind: 'cant-be-copied'; scope: 'self' | 'you-control'; filter?: Filter }

// ------------------------------------------------------------------ 2. declaration merging (never edit types.ts)
declare module '../../cards/types.js' {
  interface EffectRegistry {
    copyPermanent: CopyPermanentEffect;
    copyStack: CopyStackEffect;
    changeTargets: ChangeTargetsEffect;
    becomeCopy: BecomeCopyEffect;
  }
  interface AsEntersRegistry { enterAsCopy: EnterAsCopyAsEnters }
  interface StaticRegistry { cantBeCopied: CantBeCopiedStatic }
  interface TargetKindRegistry { 'spell-or-ability': true; 'single-target-spell-or-ability': true; 'single-target-spell': true }
}

// ------------------------------------------------------------------ 3. copiable values (CR 707.2) and exceptions

/**
 * The CardDef a copy effect copies (CR 707.2: the printed values as modified by other copy effects, and nothing
 * else — counters, +N/+N and until-end-of-turn effects are not copiable). `defOf` already answers "as modified by
 * other copy effects"; a TOKEN's copiable values are the values in the token itself (CR 111.4 / 707.2), which live
 * in its `TokenSpec` and its `grantedAbilities`, so they are folded back onto the def here.
 */
function copiableDef(o: GameObject): CardDef {
  const d = chars.defOf(o);
  const t = o.token;
  if (!t) return d;
  return {
    ...d, name: t.name, power: String(t.power), toughness: String(t.toughness), colors: [...t.colors],
    types: [...t.types] as CardType[], subtypes: [...t.subtypes], keywords: [...t.keywords],
    abilities: [...(o.grantedAbilities ?? [])],
  };
}

/** `d` with the copy effect's "except ..." clause applied (CR 707.9a). Returns `d` untouched when there is none. */
function withException(d: CardDef, ex: CopyException | undefined): CardDef {
  if (!ex) return d;
  const out: CardDef = { ...d };
  if (ex.name !== undefined) out.name = ex.name;
  if (ex.power !== undefined) out.power = String(ex.power);
  if (ex.toughness !== undefined) out.toughness = String(ex.toughness);
  if (ex.colors !== undefined) out.colors = [...ex.colors];
  if (ex.types !== undefined) out.types = [...ex.types];
  if (ex.addTypes !== undefined) out.types = [...new Set([...out.types, ...ex.addTypes])];
  if (ex.subtypes !== undefined) out.subtypes = [...ex.subtypes];
  if (ex.addSubtypes !== undefined) out.subtypes = [...new Set([...out.subtypes, ...ex.addSubtypes])];
  if (ex.notLegendary) out.supertypes = out.supertypes.filter(t => t !== 'Legendary');
  if (ex.loseAbilities) { out.abilities = []; out.keywords = []; }
  if (ex.keywords !== undefined) out.keywords = [...new Set([...out.keywords, ...ex.keywords])];
  if (ex.toxic !== undefined) out.toxic = ex.toxic;
  if (ex.abilities !== undefined) out.abilities = [...out.abilities, ...ex.abilities];
  // the type line is cosmetic but is what the UI prints, so keep it honest
  out.typeLine = [...out.supertypes, ...out.types].join(' ') + (out.subtypes.length ? ` — ${out.subtypes.join(' ')}` : '');
  return out;
}

/** The `TokenSpec` mirroring a derived def — what every characteristic reader consults for a token. */
function tokenSpecOf(d: CardDef): TokenSpec {
  return {
    name: d.name, power: Number(d.power ?? 0) || 0, toughness: Number(d.toughness ?? 0) || 0,
    colors: [...d.colors], types: [...d.types], subtypes: [...d.subtypes], keywords: [...d.keywords],
  };
}

/** "~ can't be copied": consulted by every copy op (a permanent only — a spell's own static is not in the layer pass). */
function cantCopy(s: GameState, o: GameObject): boolean {
  return o.zone === 'battlefield' && chars.flags(s, o).cantBeCopied === true;
}
/** The same question for a spell or ability on the stack: its own printed static ("This spell can't be copied"). */
function stackCantCopy(it: StackItem): boolean {
  return chars.abilitiesOf(it.source).some(a => a.kind === 'static' && (a.effect as { kind: string }).kind === 'cant-be-copied');
}

// ------------------------------------------------------------------ 4. frame plumbing

/** The objects a `TargetSpec | Ref` names for a copy op: the effect's targets, or what the binding frame holds. */
async function copySources(c: OpCtx, t: TargetSpec | Ref): Promise<GameObject[]> {
  if (typeof t === 'object') return c.objs();
  const { resolveRef } = await import('../refs.js');
  return resolveRef({ s: c.s, item: c.item, p: c.p, src: c.src }, t);
}

/** Bind `that` / `those` to what this effect just made, with the values they have now (CR 608.2h) — `noteAffected`'s job. */
function bind(c: OpCtx, list: GameObject[]): void {
  c.item.affected = list.map(o => ({
    id: o.id,
    lastKnown: {
      power: chars.power(c.s, o), toughness: chars.toughness(c.s, o), controller: o.controller,
      manaValue: chars.manaValueOf(o), zone: o.zone, owner: o.owner,
    },
  }));
}

const sameRef = (a: TargetRef, b: TargetRef): boolean => a.kind === b.kind && a.id === b.id;
/** Is this target the player `p` themselves, or something they control? (What the default retargeting order sorts on.) */
function ownedBy(g: Game, r: TargetRef, p: PlayerId): boolean {
  if (r.kind === 'player') return r.id === p;
  if (r.kind === 'stack') return g.state.stack.find(x => x.id === r.id)?.controller === p;
  return chars.findObject(g.state, r.id)?.controller === p;
}

/** A human label for one target ref, used in the `choose-option` sheet the retargeting decision shows. */
function refLabel(g: Game, r: TargetRef): string {
  if (r.kind === 'player') return g.pname(r.id);
  const it = g.state.stack.find(x => x.id === r.id);
  if (r.kind === 'stack') return it ? `${it.name} #${r.id}` : `#${r.id}`;
  const o = chars.findObject(g.state, r.id);
  return o ? `${chars.name(o)} #${o.id}` : `#${r.id}`;
}

/**
 * CR 115.7: choose new targets for `item`. Every requirement of the item is offered to `chooser` in turn; a pick may
 * be kept (`choose-new`) or must move (`change-one`, CR 115.7 "change the target"). Only legal targets are offered
 * (115.7b), and within one requirement the same object is never chosen twice (115.3). The option list is ordered
 * with the *different* targets first, so an agent that takes the first option actually redirects — the whole point
 * of every card that prints this clause. Returns true when at least one target really moved.
 */
async function retarget(g: Game, item: StackItem, chooser: PlayerId, how: 'choose-new' | 'change-one'): Promise<boolean> {
  const { targetingEffects, targetOptionsFor } = await import('../legal.js');
  const reqs = targetingEffects(g.effectiveEffects(item));
  let moved = false;
  for (const [index, refs] of [...item.targetsByEffect.entries()]) {
    if (index < 0 || !refs.length) continue;                       // -1 is the aura's enchant spec, not a target of an effect
    const req = reqs.find(r => r.index === index); if (!req) continue;
    if ((item.targetParts?.[index]?.length ?? 1) > 1) continue;    // a `multi` requirement: its parts are not interchangeable
    const opts = targetOptionsFor(g, item.controller, req.spec, item.source);
    const next: TargetRef[] = [];
    for (const cur of refs) {
      const free = opts.filter(o => !next.some(x => sameRef(x, o)));
      const others = free.filter(o => !sameRef(o, cur)).sort((a, b) => Number(ownedBy(g, a, chooser)) - Number(ownedBy(g, b, chooser)));
      const keep = free.filter(o => sameRef(o, cur));
      // "Change the target" must move it (CR 115.7). "You may choose new targets" keeps a target already pointed
      // away from the chooser and moves one pointed at them - the play every card printing that clause is bought for.
      const choices = how === 'change-one' ? others : ownedBy(g, cur, chooser) ? [...others, ...keep] : [...keep, ...others];
      if (!choices.length) { next.push(cur); continue; }           // nothing else is legal: the target does not change
      const labels = choices.map(o => refLabel(g, o));
      const pick = await g.ask(chooser, { kind: 'choose-option', options: labels, reason: `${item.name}: new target` }) as string;
      const k = labels.indexOf(pick); const chosen = choices[k < 0 ? 0 : k];
      next.push(chosen);
      if (!sameRef(chosen, cur)) moved = true;
    }
    item.targetsByEffect.set(index, next);
  }
  return moved;
}

/** The stack item a copy / retarget op is about: a `stack` target ref, or a Ref resolving to a spell's card. */
async function stackItemFor(c: OpCtx, t: TargetSpec | Ref | 'the-copies'): Promise<StackItem | undefined> {
  const s = c.s;
  if (t === 'the-copies') return undefined;
  if (typeof t === 'object') { const r = c.T[0]; return r && r.kind === 'stack' ? s.stack.find(x => x.id === r.id) : undefined; }
  const { resolveRef } = await import('../refs.js');
  const o = resolveRef({ s, item: c.item, p: c.p, src: c.src }, t)[0];
  return o ? s.stack.find(x => x.source.id === o.id) : undefined;
}

// ------------------------------------------------------------------ 5. the module

const COPY_CLONE: FamilyModule = {
  name: 'copy-clone',

  effects: {
    // "Create a token that's a copy of target creature you control, except it's a 4/4 black Zombie." (CR 707.2, 111.1)
    'copy-permanent': async (e: CopyPermanentEffect, c) => {
      const { g, s, p, src } = c;
      const { makeObject } = await import('../state.js');
      const { opponentsOf } = await import('../players.js');
      const n = Math.max(0, e.count === undefined ? 1 : c.amt(e.count));
      const made: GameObject[] = [];
      for (const orig of await copySources(c, e.target)) {
        if (cantCopy(s, orig)) { g.note(`${chars.name(orig)} can't be copied.`); continue; }
        const d = withException(copiableDef(orig), e.except);
        for (let i = 0; i < n; i++) {
          const tok = makeObject(s.nextId++, d, p, 'battlefield', s.turn);
          tok.controller = p; tok.owner = p;
          tok.token = tokenSpecOf(d);
          tok.grantedAbilities = [...d.abilities];
          await g.enterBattlefield(tok, { controller: p, via: 'token', tapped: e.tapped || !!e.attacking });
          if (e.attacking && s.step === 'declare-attackers') {
            const others = opponentsOf(s, p).filter(q => q !== src.attacking);
            const at = e.attacking === 'each-other-opponent' ? others[i % Math.max(1, others.length)] : (src.attacking ?? others[0]);
            if (at !== undefined) { tok.attacking = at; s.attackers.push(tok.id); }
          }
          made.push(tok);
          g.note(`${g.pname(p)} creates a token copy of ${d.name}.`);
        }
      }
      bind(c, made);
      if (made.length) g.emit({ type: 'create-token', id: made[0].id, name: chars.name(made[0]), controller: p, power: made[0].token!.power, toughness: made[0].token!.toughness, count: made.length });
    },

    // "Copy target instant or sorcery spell." / "copy that spell" / "Copy target activated or triggered ability." (CR 707.10)
    'copy-stack': async (e: CopyStackEffect, c) => {
      const { g, s, p } = c;
      const orig = await stackItemFor(c, e.target);
      if (!orig) return;
      if (stackCantCopy(orig)) { g.note(`${orig.name} can't be copied.`); return; }
      const { makeObject } = await import('../state.js');
      const n = Math.max(0, e.count === undefined ? 1 : c.amt(e.count));
      const made: number[] = [];
      for (let i = 0; i < n; i++) {
        let source = orig.source;
        if (orig.kind === 'spell') {
          // CR 707.10a: the copy of a spell is a new object with the copiable values of the original, and it is a
          // TOKEN — so it ceases to exist when it leaves the stack, and a permanent-spell copy enters as a token.
          const d = copiableDef(orig.source);
          source = makeObject(s.nextId++, d, p, 'stack', s.turn);
          source.controller = p;
          source.token = tokenSpecOf(d);
          source.grantedAbilities = [...d.abilities];
          if (orig.source.castWith) source.castWith = { ...orig.source.castWith };
          extSet(source, 'ccSpellCopy', true);
        }
        const copy = g.makeStackItem(orig.kind, source, p, orig.effects, orig.name, orig.x, orig.modes, orig.text);
        copy.targetsByEffect = new Map(orig.targetsByEffect);
        copy.targets = [...orig.targets];
        if (orig.targetParts) copy.targetParts = { ...orig.targetParts };
        if (orig.ability) copy.ability = orig.ability;
        if (orig.abilityIndex !== undefined) copy.abilityIndex = orig.abilityIndex;
        if (orig.kicked) copy.kicked = orig.kicked;
        if (orig.castFrom) copy.castFrom = orig.castFrom;
        if (orig.alt) copy.alt = orig.alt;
        if (orig.triggeringId !== undefined) copy.triggeringId = orig.triggeringId;
        if (orig.triggeringPlayer !== undefined) copy.triggeringPlayer = orig.triggeringPlayer;
        if (orig.affected) copy.affected = orig.affected.map(a => ({ id: a.id, lastKnown: { ...a.lastKnown } }));
        if (orig.sacrificed) copy.sacrificed = [...orig.sacrificed];
        s.stack.push(copy);
        made.push(copy.id);
        g.note(`${g.pname(p)} copies ${orig.name}.`);
        if (e.newTargets === 'may') await retarget(g, copy, p, 'choose-new');
      }
      // "You may choose new targets for the copy" is its own printed sentence; record what this item copied so that
      // sentence (a `change-targets` on 'the-copies') finds them. Keyed by the item, so a later resolution of the
      // same source can never retarget a stale copy.
      if (made.length) extSet(c.src, 'ccCopies', { item: c.item.id, ids: made });
    },

    // "You may choose new targets for target spell or ability." / "Change the target of target spell or ability
    // with a single target." (CR 115.7)
    'change-targets': async (e: ChangeTargetsEffect, c) => {
      const { g, s, p } = c;
      const items: StackItem[] = [];
      if (e.target === 'the-copies') {
        const rec = extGet<{ item: number; ids: number[] }>(c.src, 'ccCopies');
        if (!rec || rec.item !== c.item.id) return;
        extDel(c.src, 'ccCopies');
        for (const id of rec.ids) { const it = s.stack.find(x => x.id === id); if (it) items.push(it); }
      } else {
        const it = await stackItemFor(c, e.target);
        if (it) items.push(it);
      }
      if (!items.length) return;
      if (e.optional && !(await g.ask(p, { kind: 'may', prompt: `Choose new targets for ${items[0].name}?`, source: c.item.name }))) return;
      for (const it of items) {
        const moved = await retarget(g, it, p, e.how);
        g.note(moved ? `${g.pname(p)} chooses new targets for ${it.name}.` : `${it.name} keeps its targets.`);
      }
    },

    // "~ becomes a copy of target creature until end of turn." (CR 706.2, applied in layer 1, CR 613.2)
    'become-copy': async (e: BecomeCopyEffect, c) => {
      const { g, s } = c;
      const orig = (await copySources(c, e.target))[0];
      if (!orig) return;
      const { resolveRef } = await import('../refs.js');
      const dst = resolveRef({ s, item: c.item, p: c.p, src: c.src }, e.becomes ?? 'self')[0];
      if (!dst || dst.zone !== 'battlefield' || dst.id === orig.id) return;
      if (cantCopy(s, orig)) { g.note(`${chars.name(orig)} can't be copied.`); return; }
      const d = withException(copiableDef(orig), e.except);
      g.setCopyDef(dst, d);
      if (e.duration === 'eot') extSet(dst, 'ccCopyUntilTurn', s.turn); else extDel(dst, 'ccCopyUntilTurn');
      bind(c, [dst]);
      g.note(`${chars.name(dst)} becomes a copy of ${d.name}${e.duration === 'eot' ? ' until end of turn' : ''}.`);
    },
  },

  // "~ can't be copied." Folded into the string-indexed flags every copy op above reads through `chars.flags`.
  statics: {
    'cant-be-copied': (e: CantBeCopiedStatic, src, o, s, m) => {
      if (e.scope === 'self' ? src.id === o.id : o.controller === src.controller && chars.matchesFilter(s, o, e.filter, src)) m.flags.cantBeCopied = true;
    },
  },

  // "You may have ~ enter as a copy of any creature on the battlefield" (CR 706.9): a copy replacement effect, so it
  // is applied as the permanent enters and the *new* def decides whether it enters tapped.
  asEnters: {
    'enter-as-copy': async (a: EnterAsCopyAsEnters, o, ctx, g) => {
      const s = g.state;
      const cands = chars.allPermanents(s).filter(x =>
        x.id !== o.id && (a.who !== 'you' || x.controller === ctx.controller)
        && chars.matchesFilter(s, x, a.filter ?? { types: ['Creature'] }, o) && !cantCopy(s, x));
      if (!cands.length) return;
      if (a.optional && !ctx.sync && !(await g.ask(ctx.controller, { kind: 'may', prompt: `Have ${o.def.name} enter as a copy?`, source: o.def.name }))) return;
      const ids = ctx.sync ? [cands[0].id]
        : await g.ask(ctx.controller, { kind: 'choose-cards', from: cands.map(x => x.id), count: 1, reason: `${o.def.name}: choose a permanent to copy`, exact: true }) as number[];
      const pick = cands.find(x => x.id === ids[0]) ?? cands[0];
      const d = withException(copiableDef(pick), a.except);
      g.setCopyDef(o, d);
      // the entering-tapped question was answered from the printed def a moment ago; re-answer it from the copy
      if (d.entersTapped === true || (d.asEnters ?? []).some(x => x.kind === 'tapped')) ctx.entersTapped = true;
      g.note(`${o.def.name} enters the battlefield as a copy of ${d.name}.`);
    },
  },

  // CR 115.7 target kinds. A spell is matched against `spec.filter` ("target instant or sorcery spell"); an ability
  // on the stack has no card characteristics of its own, so a filter never excludes one.
  targetKinds: {
    'spell-or-ability': (g, controller, _src, spec) => stackTargets(g.state, controller, spec, false, false),
    'single-target-spell-or-ability': (g, controller, _src, spec) => stackTargets(g.state, controller, spec, true, false),
    'single-target-spell': (g, controller, _src, spec) => stackTargets(g.state, controller, spec, true, true),
  },

  // A copy that lasts until end of turn ends in the cleanup step (CR 514.2); every copy ends when the permanent
  // leaves the battlefield, because what comes back is a new object (CR 400.7).
  cleanupEot: (g, o) => {
    if (extGet<number>(o, 'ccCopyUntilTurn') === undefined) return;
    extDel(o, 'ccCopyUntilTurn');
    g.setCopyDef(o, null);
  },
  leave: (g, o) => {
    extDel(o, 'ccCopyUntilTurn');
    if (o.copyDef !== undefined) g.setCopyDef(o, null);
  },

  // Round-trip English (what scripts:verify diffs against the oracle text).
  render: {
    'copy-permanent': (e: CopyPermanentEffect) => {
      const n = typeof e.count === 'number' && e.count > 1 ? `${e.count} tokens that are copies` : "a token that's a copy";
      return `Create ${n} of ${renderSource(e.target)}${e.tapped ? ' tapped' : ''}${e.attacking ? " that's attacking" : ''}${renderExcept(e.except)}`;
    },
    'copy-stack': (e: CopyStackEffect) => `Copy ${renderSource(e.target)}${typeof e.count === 'number' && e.count > 1 ? ` ${e.count} times` : ''}${e.newTargets === 'may' ? '. You may choose new targets for the copy' : ''}`,
    'change-targets': (e: ChangeTargetsEffect) => e.how === 'change-one'
      ? `Change the target of ${renderSource(e.target)}`
      : `${e.optional ? 'You may choose' : 'Choose'} new targets for ${renderSource(e.target)}`,
    'become-copy': (e: BecomeCopyEffect) => `${e.becomes === undefined || e.becomes === 'self' ? '~' : 'That permanent'} becomes a copy of ${renderSource(e.target)}${e.duration === 'eot' ? ' until end of turn' : ''}${renderExcept(e.except)}`,
  },
};

// ------------------------------------------------------------------ 6. small helpers used above

/**
 * The stack objects one of this family's target kinds offers. `single` keeps only items with exactly one target
 * ("... with a single target", CR 115.7); `spellsOnly` drops abilities ("target spell with a single target").
 * `spec.filter` is matched against a spell's card ("target instant or sorcery spell"); an ability on the stack has
 * no card characteristics of its own, so a filter never rejects one - the phrase names it explicitly instead.
 */
function stackTargets(s: GameState, controller: PlayerId, spec: TargetSpec, single: boolean, spellsOnly: boolean): TargetRef[] {
  const out: TargetRef[] = [];
  for (const it of s.stack) {
    if (spellsOnly && it.kind !== 'spell') continue;
    if (spec.controller === 'you' && it.controller !== controller) continue;
    if (spec.controller === 'opponent' && it.controller === controller) continue;
    if (it.kind === 'spell' && spec.filter && !chars.matchesFilter(s, it.source, spec.filter)) continue;
    if (single) { let n = 0; for (const refs of it.targetsByEffect.values()) n += refs.length; if (n !== 1) continue; }
    out.push({ kind: 'stack', id: it.id });
  }
  return out;
}

/** English for the thing a copy op copies (a target spec reads as the card printed it, a Ref as the pronoun). */
function renderSource(t: TargetSpec | Ref | 'the-copies'): string {
  if (t === 'the-copies') return 'the copy';
  if (typeof t !== 'object') return t === 'self' ? '~' : t === 'those' ? 'them' : t === 'triggering' ? 'that spell' : 'it';
  const base = t.kind === 'spell-or-ability' ? 'spell or ability'
    : t.kind === 'single-target-spell-or-ability' ? 'spell or ability with a single target'
    : t.kind === 'single-target-spell' ? 'spell with a single target' : t.kind.replace(/-/g, ' ');
  const ctl = t.controller === 'you' ? ' you control' : t.controller === 'opponent' ? ' an opponent controls' : '';
  return `target ${base}${ctl}`;
}

/** English for an "except ..." clause, in the order the cards print it. */
function renderExcept(ex: CopyException | undefined): string {
  if (!ex) return '';
  const parts: string[] = [];
  const pt = ex.power !== undefined && ex.toughness !== undefined ? `${ex.power}/${ex.toughness}` : '';
  const words = [pt, ...(ex.colors ?? []).map(colorWord), ...(ex.subtypes ?? []), ...(ex.types ?? [])].filter(Boolean);
  if (words.length) parts.push(`it's ${/^[aeiou]/i.test(words[0]) ? 'an' : 'a'} ${words.join(' ')}`);
  const added = [...(ex.addSubtypes ?? []), ...(ex.addTypes ?? [])];
  if (added.length) parts.push(`it's ${/^[AEIOU]/.test(added[0]) ? 'an' : 'a'} ${added.join(' ')} in addition to its other types`);
  if (ex.notLegendary) parts.push("it isn't legendary");
  if (ex.loseAbilities) parts.push('it has no abilities');
  const kw = [...(ex.keywords ?? [])].map(k => (k === 'toxic' && ex.toxic !== undefined ? `toxic ${ex.toxic}` : String(k)));
  if (kw.length) parts.push(`it has ${kw.join(' and ')}`);
  if (ex.abilities?.length) parts.push(`it has ${ex.abilities.map(a => `"${a.text}"`).join(' and ')}`);
  return parts.length ? `, except ${parts.join(' and ')}` : '';
}
const COLOR_WORDS: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
const colorWord = (c: Color): string => COLOR_WORDS[c] ?? c;

export default COPY_CLONE;
