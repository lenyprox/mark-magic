// The rules engine. Implements the turn structure (CR 500), priority & the stack (CR 117, 608),
// combat (CR 506-510), state-based actions (CR 704), triggered abilities (CR 603) and a broad set of effects.
import type { Ability, AbilityCost, ActivatedAbility, CardDef, Color, Effect, Keyword, ManaCost, ManaSymbol, TargetSpec, TriggeredAbility } from '../cards/types.js';
import { manaValue } from '../cards/parse.js';
import { abilitiesOf, allPermanents, canAttack, canBlock, colors, conditionHolds, defOf, evalAmount, findObject, hasKeyword, isCreature, isLand, isType, manaValueOf, matchesFilter, name, power, protectedFrom, subtypes, toughness, types, flags, type AmountCtx } from './characteristics.js';
import { FAST_MANA_LIMIT, MANA_COMBO_LIMIT, findPayment as findPaymentFull, manaSources, type ManaSourceOptions, type Payment } from './mana.js';
import { costAdjust, exileWindowOpen, extraManaSources, hasModifier, nonManaCostPayable, pickCrew, pickDelve, pickEscapeExile, spellManaCost, ZERO_COST } from './cost.js';
import { makeKnowledge, makeObject, makePlayer, opponentOf, STEPS, type Agent, type AttackDeclaration, type BlockDeclaration, type CastZone, type Decision, type DelayedTrigger, type GameObject, type GameState, type LegalAction, type Player, type PlayerAction, type PlayerId, type StackItem, type Step, type TargetRef } from './state.js';
import { legalActions, targetOptionsFor, targetingEffects } from './legal.js';
import { redact } from './view.js';

export class Rng {
  private s: number;
  constructor(seed = 12345) { this.s = seed >>> 0 || 1; }
  next(): number { // mulberry32
    this.s = (this.s + 0x6D2B79F5) >>> 0; let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number) { return Math.floor(this.next() * n); }
  shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}

export interface TriggerCtx { obj?: GameObject; player?: PlayerId; played?: boolean; stepDraw?: boolean }

export interface GameOptions {
  seed?: number; startingLife?: number; maxTurns?: number; quiet?: boolean; mulligans?: boolean;
  /** Cap mana-payment enumeration (rollouts): trades exotic multi-colour payments for speed. */
  fastMana?: boolean;
}

export class Game {
  state: GameState;
  agents: [Agent, Agent];
  rng: Rng;
  opts: GameOptions;
  private pendingTriggers: { ability: TriggeredAbility; source: GameObject; controller: PlayerId; triggerCtx?: TriggerCtx; affected?: StackItem['affected'] }[] = [];
  private stackCounter = 0;

  constructor(decks: [CardDef[], CardDef[]], agents: [Agent, Agent], opts: GameOptions = {}) {
    this.opts = opts; this.rng = new Rng(opts.seed ?? 42); this.agents = agents;
    this.state = { turn: 0, activePlayer: 0, step: 'untap', priority: 0, players: [makePlayer(0, agents[0].name), makePlayer(1, agents[1].name)], stack: [], nextId: 1, log: [], winner: null, attackers: [], extraTurns: [], passesInRow: 0, knowledge: makeKnowledge() };
    decks.forEach((deck, i) => {
      const p = this.state.players[i];
      p.life = opts.startingLife ?? 20;
      for (const def of deck) p.library.push(makeObject(this.state.nextId++, def, i as PlayerId, 'library', 0));
      this.shuffle(p.id);
    });
  }

  /** Build a Game around an existing (cloned) state; used for AI simulations. */
  static fromState(state: GameState, agents: [Agent, Agent], opts: GameOptions = {}): Game {
    const g = Object.create(Game.prototype) as Game;
    g.state = state; g.agents = agents; g.opts = opts; g.rng = new Rng(opts.seed ?? 1);
    if (!state.knowledge) state.knowledge = makeKnowledge();
    (g as unknown as { pendingTriggers: unknown[] }).pendingTriggers = []; (g as unknown as { stackCounter: number }).stackCounter = 100000;
    return g;
  }

  /** Mana-payment enumeration cap in force for this game (see GameOptions.fastMana). */
  get manaLimit(): number { return this.opts.fastMana ? FAST_MANA_LIMIT : MANA_COMBO_LIMIT; }
  private findPayment(pl: Player, cost: ManaCost, x = 0, reduction = 0, opts?: ManaSourceOptions): Payment | null { return findPaymentFull(this.state, pl, cost, x, reduction, this.manaLimit, opts); }

  // ------------------------------------------------------------------ public knowledge of hidden zones
  /** Shuffle a library: whatever was known about its order is forgotten. */
  shuffle(p: PlayerId) { this.rng.shuffle(this.state.players[p].library); this.state.knowledge.knownTop[p] = []; }
  private forgetTop(id: number) { for (const kt of this.state.knowledge.knownTop) { const i = kt.indexOf(id); if (i >= 0) kt.splice(i, 1); } }
  private forgetInHand(id: number) { const k = this.state.knowledge.knownInHand; const i = k.indexOf(id); if (i >= 0) k.splice(i, 1); }
  private reveal(id: number) { const k = this.state.knowledge.revealed; if (!k.includes(id)) k.push(id); }
  /** After a scry/surveil: `kept` (in order) is now the known top of p's library, above whatever was known before. */
  private noteTop(p: PlayerId, kept: number[], looked: number) { const k = this.state.knowledge.knownTop; k[p] = [...kept, ...k[p].filter(id => !kept.includes(id)).slice(Math.max(0, looked - kept.length))]; }

  /** Resolve everything on the stack with both players passing (simulation helper). */
  async resolveStackFully() {
    let guard = 0;
    while (this.state.winner === null && guard++ < 100) {
      this.checkSBA(); if (this.state.winner !== null) return;
      this.putTriggersOnStack();
      if (!this.state.stack.length) return;
      await this.resolveTop();
    }
  }

  /** Simulation helper: declare the given attackers and blocks, then run both damage steps and SBAs. */
  async simulateCombat(attackerIds: number[], blocks: { blocker: number; attacker: number }[]) {
    const s = this.state; const dp = opponentOf(s.activePlayer);
    s.attackers = [];
    for (const id of attackerIds) { const o = findObject(s, id); if (!o || o.zone !== 'battlefield') continue; o.attacking = dp; if (!hasKeyword(s, o, 'vigilance')) o.tapped = true; s.attackers.push(id); }
    for (const b of blocks) { const bl = findObject(s, b.blocker), at = findObject(s, b.attacker); if (!bl || !at || bl.blocking.length) continue; bl.blocking.push(at.id); at.blockedBy.push(bl.id); }
    s.step = 'declare-blockers';
    for (const id of s.attackers) this.queueTriggers('attacks', { obj: findObject(s, id), player: s.activePlayer });
    await this.resolveStackFully();
    const needFirst = allPermanents(s).some(o => (o.attacking !== null || o.blocking.length) && (hasKeyword(s, o, 'first strike') || hasKeyword(s, o, 'double strike')));
    if (needFirst) { s.step = 'first-strike-damage'; await this.combatDamage(true); this.checkSBA(); }
    if (s.winner === null) { s.step = 'combat-damage'; await this.combatDamage(false); this.checkSBA(); }
    await this.resolveStackFully();
    for (const o of allPermanents(s)) { o.attacking = null; o.blocking = []; o.blockedBy = []; }
  }

  /** Simulation helper: with attackers (and possibly blockers) already declared, run the damage steps. */
  async simulateRemainingCombat() {
    const s = this.state;
    if (!s.attackers.length) return;
    await this.resolveStackFully();
    const needFirst = allPermanents(s).some(o => (o.attacking !== null || o.blocking.length) && (hasKeyword(s, o, 'first strike') || hasKeyword(s, o, 'double strike')));
    if (needFirst) { s.step = 'first-strike-damage'; await this.combatDamage(true); this.checkSBA(); }
    if (s.winner === null) { s.step = 'combat-damage'; await this.combatDamage(false); this.checkSBA(); }
    await this.resolveStackFully();
    for (const o of allPermanents(s)) { o.attacking = null; o.blocking = []; o.blockedBy = []; }
    s.attackers = [];
  }

  // ------------------------------------------------------------------ logging
  log(line: string) { this.state.log.push(line); if (!this.opts.quiet) for (const a of this.agents) a.onLog?.(line); }
  private pname(p: PlayerId) { return this.state.players[p].name; }

  // ------------------------------------------------------------------ game loop
  async play(): Promise<PlayerId | null> {
    const s = this.state;
    s.activePlayer = this.rng.int(2) as PlayerId;
    for (const p of s.players) {
      let mulls = 0;
      for (;;) {
        for (let i = 0; i < 7; i++) await this.draw(p.id, true);
        if (this.opts.mulligans === false || mulls >= 3) break;
        const again = await this.ask(p.id, { kind: 'yes-no', prompt: `Mulligan this hand? (${p.hand.map(c => c.def.name).join(', ')})` });
        if (!again) break;
        mulls++; this.log(`${p.name} mulligans.`);
        for (const c of [...p.hand]) this.moveTo(c, 'library'); this.shuffle(p.id);
      }
      if (mulls > 0) { const ids = await this.ask(p.id, { kind: 'choose-cards', from: p.hand.map(c => c.id), count: mulls, reason: `Put ${mulls} card(s) on the bottom of your library`, exact: true }) as number[]; for (const id of ids) { const c = p.hand.find(x => x.id === id); if (c) this.moveTo(c, 'library', 'bottom'); } }
    }
    this.log(`${this.pname(s.activePlayer)} goes first.`);
    while (s.winner === null) {
      s.turn++;
      if (this.opts.maxTurns && s.turn > this.opts.maxTurns) { this.log('Turn limit reached: draw.'); return null; }
      await this.runTurn();
      if (s.winner !== null) break;
      if (s.extraTurns.length) s.activePlayer = s.extraTurns.shift()!; else s.activePlayer = opponentOf(s.activePlayer);
    }
    this.log(`${this.pname(s.winner!)} wins the game.`);
    return s.winner;
  }

  private async runTurn() {
    const s = this.state;
    this.log(`\n=== Turn ${s.turn}: ${this.pname(s.activePlayer)} ===`);
    for (const p of s.players) { p.landsPlayedThisTurn = 0; p.attackedThisTurn = false; p.lifeLostThisTurn = 0; p.creaturesDiedThisTurn = 0; p.spellsCastThisTurn = 0; p.permanentsLeftThisTurn = 0; p.cardsDrawnThisTurn = 0; p.lifeGainedThisTurn = 0; for (const o of p.battlefield) o.activatedThisTurn.clear(); }
    s.players[s.activePlayer].turnsTaken = (s.players[s.activePlayer].turnsTaken ?? 0) + 1;
    await this.runTurnFrom('untap');
  }

  /**
   * Finish the current turn from the current step (simulation helper). The current step's entry actions (draw,
   * declarations, triggers) are assumed done; its priority round continues from the current priority holder, then
   * the remaining steps run in full. Mid-combat states run the remaining combat steps with the declared attackers/blocks.
   */
  async resumeTurn(): Promise<void> {
    if (this.state.turn === 0) { this.state.turn = 1; await this.runTurn(); return; }
    await this.runTurnFrom(this.state.step, true);
  }

  /** Play `n` further complete turns (after the current one), stopping early on a winner or the turn limit. */
  async playTurns(n: number): Promise<PlayerId | null> {
    const s = this.state;
    for (let i = 0; i < n && s.winner === null; i++) {
      if (s.extraTurns.length) s.activePlayer = s.extraTurns.shift()!; else s.activePlayer = opponentOf(s.activePlayer);
      s.turn++;
      if (this.opts.maxTurns && s.turn > this.opts.maxTurns) { this.log('Turn limit reached: draw.'); return null; }
      await this.runTurn();
    }
    return s.winner;
  }

  /** Run the turn's steps from `from` onwards; with `resume`, `from` itself only gets its remaining priority round. */
  private async runTurnFrom(from: Step, resume = false) {
    const s = this.state; const ap = s.activePlayer;
    const at = STEPS.indexOf(from);
    const reach = (st: Step) => STEPS.indexOf(st) >= at;                 // step is part of this run
    const enter = (st: Step) => STEPS.indexOf(st) > at || !resume;       // run the step's entry actions (not when resuming into it)
    const round = async (st: Step) => { await this.priorityRound(resume && st === from); return s.winner !== null; };
    if (reach('untap')) {
      await this.setStep('untap');
      for (const o of s.players[ap].battlefield) {
        const f = flags(s, o);
        if (o.noUntapNext) { o.noUntapNext = false; continue; }
        if (f.doesntUntap) continue;
        o.tapped = false;
      }
    }
    if (reach('upkeep')) { if (enter('upkeep')) { await this.setStep('upkeep'); this.queueTriggers('upkeep', { player: ap }); this.flushDelayed('next-upkeep'); } if (await round('upkeep')) return; }
    if (reach('draw')) {
      // Draw (skip on first turn of the game for the starting player)
      if (enter('draw')) {
        await this.setStep('draw');
        // rebound windows that were not used during the upkeep close now
        for (const o of s.players[ap].exile) if (o.castableFromExile?.free && o.castableFromExile.upkeepOnly === ap && o.castableFromExile.afterTurn < s.turn) delete o.castableFromExile;
        if (s.turn > 1) await this.draw(ap, false, true);
        this.queueTriggers('draw-step', { player: ap });
      }
      if (await round('draw')) return;
    }
    if (reach('main1')) {
      if (enter('main1')) {
        await this.setStep('main1');
        // Sagas: add a lore counter as the precombat main phase begins (CR 714.2b)
        for (const o of s.players[ap].battlefield) if (subtypes(o).includes('Saga') && o.def.finalChapter) { o.counters.lore = (o.counters.lore ?? 0) + 1; this.queueTriggers('chapter', { obj: o, player: ap }); }
      }
      if (await round('main1')) return;
    }
    if (reach('combat-end')) { await this.combatFrom(from, resume); if (s.winner !== null) return; }
    if (reach('main2')) { if (enter('main2')) await this.setStep('main2'); if (await round('main2')) return; }
    if (reach('end')) {
      if (enter('end')) {
        await this.setStep('end'); this.queueTriggers('end-step', { player: ap });
        this.flushDelayed('next-end-step'); this.flushDelayed('your-next-end-step', ap);
        for (const o of [...s.players[ap].battlefield]) {
          if (o.warpExileTurn === s.turn) { delete o.warpExileTurn; this.moveTo(o, 'exile'); o.castableFromExile = { afterTurn: s.turn, free: false }; this.log(`${name(o)} is exiled (warp); it may be cast from exile on a later turn.`); continue; }
          if (o.counters.time && o.def.altCosts?.some(a => a.id === 'impending')) { o.counters.time--; if (!o.counters.time) { delete o.counters.time; this.log(`${name(o)} loses its last time counter and is a creature.`); } }
        }
      }
      if (await round('end')) return;
    }
    await this.setStep('cleanup');
    // discard to hand size
    const p = s.players[ap];
    if (p.hand.length > 7) {
      const n = p.hand.length - 7;
      const chosen = await this.ask(ap, { kind: 'choose-cards', from: p.hand.map(c => c.id), count: n, reason: `Discard down to seven (${n})`, exact: true }) as number[];
      for (const id of chosen) this.discard(ap, id);
    }
    // end-of-turn effects wear off, damage removed
    for (const pl of s.players) for (const o of pl.battlefield) { o.damage = 0; o.eotPower = 0; o.eotToughness = 0; o.eotKeywords = []; o.eotFlags = {}; }
    // temporary control effects end
    for (const pl of s.players) for (const o of [...pl.battlefield]) { const back = (o as GameObject & { controlUntilEot?: PlayerId }).controlUntilEot; if (back !== undefined) { delete (o as GameObject & { controlUntilEot?: PlayerId }).controlUntilEot; this.changeControl(o, back); } }
    this.checkSBA();
  }

  private async setStep(step: Step) { this.state.step = step; this.state.players.forEach(p => { p.manaPool = []; }); }

  // ------------------------------------------------------------------ priority & the stack
  /** Both players receive priority until they pass in succession with an empty stack (CR 117.4). */
  private async priorityRound(resume = false) {
    const s = this.state;
    if (!resume) { s.priority = s.activePlayer; s.passesInRow = 0; }
    while (s.winner === null) {
      this.checkSBA(); if (s.winner !== null) return;
      this.putTriggersOnStack();
      const legal = legalActions(this, s.priority);
      const action = await this.ask(s.priority, { kind: 'priority', legal }) as PlayerAction;
      if (action.type === 'pass') {
        s.passesInRow++;
        if (s.passesInRow >= 2) {
          if (s.stack.length === 0) return;
          await this.resolveTop(); s.passesInRow = 0; s.priority = s.activePlayer; continue;
        }
        s.priority = opponentOf(s.priority); continue;
      }
      s.passesInRow = 0;
      await this.performAction(s.priority, action, legal);
      // after an action the same player retains priority (CR 117.3c)
    }
  }

  async performAction(p: PlayerId, action: PlayerAction, legal?: LegalAction[]): Promise<boolean> {
    const s = this.state;
    switch (action.type) {
      case 'pass': return true;
      case 'concede': { s.players[p].lost = true; s.players[p].lossReason = 'conceded'; s.winner = opponentOf(p); this.log(`${this.pname(p)} concedes.`); return true; }
      case 'play-land': {
        const card = s.players[p].hand.find(c => c.id === action.cardId); if (!card) return false;
        const face = action.face ?? 0;
        if (!(legal ?? legalActions(this, p)).some(l => l.action.type === 'play-land' && l.action.cardId === card.id && (l.action.face ?? 0) === face)) return false;
        card.activeFace = face;
        s.players[p].landsPlayedThisTurn++;
        await this.enterBattlefield(card, { controller: p, via: 'land-drop' });
        this.log(`${this.pname(p)} plays ${name(card)}${card.tapped ? ' (tapped)' : ''}.`);
        return true;
      }
      case 'cast': return this.castSpell(p, action);
      case 'activate': return this.activateAbility(p, action);
    }
  }

  /** Cast a spell: pay costs, put it on the stack with its targets (CR 601). Handles alternative costs, delve/convoke, cast from graveyard/exile. */
  private async castSpell(p: PlayerId, a: Extract<PlayerAction, { type: 'cast' }>): Promise<boolean> {
    const s = this.state; const pl = s.players[p];
    const from: CastZone = a.from ?? 'hand';
    const card = pl[from].find(c => c.id === a.cardId); if (!card) return false;
    const def = card.def;
    const alt = a.alt ? def.altCosts?.find(x => x.id === a.alt) : undefined;
    if (a.alt && !alt) return false;
    if (alt && alt.from !== from) return false;
    const window = card.castableFromExile;
    if (!alt && from !== 'hand' && !(from === 'exile' && window && exileWindowOpen(s, p, window))) return false;
    if (alt?.condition && !conditionHolds(s, { ...card, controller: p }, alt.condition)) return false;
    const spellAb = def.abilities.find(ab => ab.kind === 'spell');
    const effects = spellAb ? spellAb.effects : [];
    const x = a.x ?? 0;
    const free = from === 'exile' && !alt && !!window?.free;
    if (!free && !alt && !def.manaCost) return false;
    const cost = free ? ZERO_COST : spellManaCost(def, alt, a.kicked);
    const adjust = costAdjust(s, p, card, from);
    const genericNeeded = Math.max(0, cost.generic + cost.x * x - adjust);
    const gy = pl.graveyard.filter(o => o.id !== card.id);
    const regular = manaSources(s, pl, { forSpell: card });
    const extras = extraManaSources(s, pl, def, regular);
    // payment plan: explicit choices first, else plain -> delve -> convoke/improvise
    let delveIds: number[] = [];
    let pay: Payment | null = null;
    if (a.pay?.delve?.length) { delveIds = a.pay.delve.filter(id => gy.some(o => o.id === id)); pay = this.findPayment(pl, cost, x, adjust + delveIds.length, { forSpell: card, extraSources: a.pay.useExtras ? extras : [], extrasFirst: !!a.pay.useExtras }); }
    else if (a.pay?.useExtras) pay = this.findPayment(pl, cost, x, adjust, { forSpell: card, extraSources: extras, extrasFirst: true });
    else {
      pay = this.findPayment(pl, cost, x, adjust, { forSpell: card });
      if (!pay && hasModifier(def, 'delve') && gy.length && genericNeeded > 0) { delveIds = pickDelve(s, pl, card, Math.min(gy.length, genericNeeded)); pay = this.findPayment(pl, cost, x, adjust + delveIds.length, { forSpell: card }); }
      if (!pay && extras.length) pay = this.findPayment(pl, cost, x, adjust + delveIds.length, { forSpell: card, extraSources: extras, extrasFirst: true });
    }
    if (!pay) return false;
    if (alt && !nonManaCostPayable(s, pl, alt.cost, card)) return false;
    for (const ac of def.additionalCosts ?? []) if (!nonManaCostPayable(s, pl, ac, card)) return false;
    // targets
    const item = this.makeStackItem('spell', card, p, effects, def.name, x, a.modes, spellAb?.text ?? def.oracleText);
    item.kicked = !!a.kicked; item.castFrom = from; item.alt = alt?.id;
    let targets = a.targets;
    if (def.subtypes.includes('Aura')) {
      const auraSpec = (def.abilities.find(ab => ab.kind === 'static' && ab.effect.kind === 'aura') as { effect: { enchant: TargetSpec } } | undefined)?.effect.enchant ?? { kind: 'creature' as const };
      const pick = targets?.[0] ?? [];
      const opts = targetOptionsFor(this, p, auraSpec, card);
      if (pick.length !== 1 || !opts.some(o => o.kind === pick[0].kind && o.id === pick[0].id)) return false;
      item.targetsByEffect.set(-1, pick); (item as StackItem & { auraSpec?: TargetSpec }).auraSpec = auraSpec;
      targets = targets?.slice(1);
    }
    if (!this.assignTargets(item, targets)) return false;
    // the spell moves to the stack (CR 601.2a), then costs are paid (CR 601.2h)
    card.zone = 'stack'; pl[from].splice(pl[from].indexOf(card), 1); if (from === 'hand') this.forgetInHand(card.id);
    delete card.castableFromExile;
    s.stack.push(item);
    this.payMana(pl, pay);
    for (const c of cost.phyrexian) if (!pay.pool.includes(c) && !pay.taps.some(t => t.option.includes(c))) this.loseLife(p, 2, 'Phyrexian mana');
    if (alt) await this.payCost(p, alt.cost, card, alt.label, item);
    for (const ac of def.additionalCosts ?? []) await this.payCost(p, ac, card, `${def.name} (additional cost)`, item);
    for (const id of delveIds) { const o = findObject(s, id); if (o && o.zone === 'graveyard') this.moveTo(o, 'exile'); }
    if (delveIds.length) card.exiledWith = [...(card.exiledWith ?? []), ...delveIds];
    const colorsSpent = new Set([...pay.pool, ...pay.taps.flatMap(t => t.option)].filter(c => c !== 'C')).size;
    card.castWith = { alt: alt?.id, from, kicked: !!a.kicked, x, delved: delveIds.length, colorsSpent };
    pl.spellsCastThisTurn++;
    const how = [alt ? alt.label : '', from === 'graveyard' && !alt ? 'from graveyard' : from === 'exile' ? 'from exile' : '', delveIds.length ? `delve ${delveIds.length}` : '', a.kicked ? 'kicked' : ''].filter(Boolean);
    this.log(`${this.pname(p)} casts ${def.name}${this.describeTargets(item)}${x ? ` (X=${x})` : ''}${how.length ? ` (${how.join(', ')})` : ''}.`);
    this.queueTriggers('cast', { obj: card, player: p });
    // prowess-style keyword
    for (const o of pl.battlefield) if (isCreature(o) && hasKeyword(s, o, 'prowess') && !isCreature(card)) { o.eotPower++; o.eotToughness++; }
    return true;
  }

  /** Pay the non-mana parts of a cost for `self` (a spell on the stack or a permanent whose ability is activated). */
  async payCost(p: PlayerId, cost: AbilityCost, self: GameObject, label: string, item?: StackItem): Promise<boolean> {
    const s = this.state; const pl = s.players[p];
    const others = (zone: GameObject[]) => zone.filter(o => o.id !== self.id);
    if (cost.tap) self.tapped = true;
    if (cost.untap) self.tapped = false;
    if (cost.payLife) this.loseLife(p, cost.payLife, label);
    if (cost.discardHand) for (const c of others(pl.hand)) this.discard(p, c.id);
    if (cost.discardSelf && self.zone === 'hand') this.discard(p, self.id);
    if (cost.sacrifice) {
      const opts = pl.battlefield.filter(o => o.id !== self.id && matchesFilter(s, o, cost.sacrifice, self)); if (!opts.length) return false;
      const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: `Sacrifice for ${label}`, exact: true }) as number[];
      const o = findObject(s, id) ?? opts[0];
      if (item) this.noteAffected(item, [o]); // "the sacrificed creature's power" (Fling)
      this.sacrifice(o);
    }
    if (cost.discard) {
      const opts = others(pl.hand); if (opts.length < cost.discard) return false;
      const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: cost.discard, reason: `Discard for ${label}`, exact: true }) as number[];
      for (const id of ids.slice(0, cost.discard)) this.discard(p, id);
    }
    if (cost.exileFromHand) {
      const opts = others(pl.hand).filter(o => matchesFilter(s, o, cost.exileFromHand!.filter, self)); if (opts.length < cost.exileFromHand.count) return false;
      const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: cost.exileFromHand.count, reason: `Exile from hand for ${label}`, exact: true }) as number[];
      for (const id of ids.slice(0, cost.exileFromHand.count)) { const o = findObject(s, id); if (o) { this.moveTo(o, 'exile'); this.log(`${this.pname(p)} exiles ${o.def.name} from hand.`); } }
    }
    if (cost.returnToHand) {
      const opts = pl.battlefield.filter(o => matchesFilter(s, o, cost.returnToHand, self)); if (!opts.length) return false;
      const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: `Return to hand for ${label}`, exact: true }) as number[];
      const o = findObject(s, id) ?? opts[0]; this.moveTo(o, 'hand'); this.log(`${this.pname(p)} returns ${name(o)} to hand.`);
    }
    if (cost.removeCounters) self.counters[cost.removeCounters.counter] = (self.counters[cost.removeCounters.counter] ?? 0) - cost.removeCounters.amount;
    if (cost.exileFromGraveyard) { const gy = others(pl.graveyard); for (let i = 0; i < cost.exileFromGraveyard && i < gy.length; i++) this.moveTo(gy[i], 'exile'); }
    if (cost.exileOtherFromGraveyard) {
      const ids = pickEscapeExile(others(pl.graveyard), cost.exileOtherFromGraveyard.count, cost.exileOtherFromGraveyard.minCardTypes); if (!ids) return false;
      for (const id of ids) { const o = findObject(s, id); if (o) this.moveTo(o, 'exile'); }
      if (ids.length) { self.exiledWith = [...(self.exiledWith ?? []), ...ids]; this.log(`${this.pname(p)} exiles ${ids.length} card(s) from graveyard for ${label}.`); }
    }
    if (cost.tapUntappedCreature) { const opts = pl.battlefield.filter(o => !o.tapped && matchesFilter(s, o, cost.tapUntappedCreature, self)); if (!opts.length) return false; opts[0].tapped = true; }
    if (cost.tapCreaturesTotalPower) {
      const crew = pickCrew(s, pl, self, cost.tapCreaturesTotalPower.power, !!cost.tapCreaturesTotalPower.other); if (!crew) return false;
      for (const o of crew) o.tapped = true;
      this.log(`${this.pname(p)} taps ${crew.map(o => name(o)).join(', ')} for ${label}.`);
    }
    if (cost.sacrificeSelf) this.moveTo(self, 'graveyard');
    return true;
  }

  /**
   * Put a permanent onto the battlefield through every as-enters / replacement effect (CR 614.1c): Mox Diamond's
   * discard, enters-tapped clauses, shocklands, enters-with counters, "choose a creature type", impending/warp
   * bookkeeping, Saga lore, landfall and ETB triggers. Returns false when a replacement sent it elsewhere.
   * `sync` (only from moveTo's exile-return path) skips every decision.
   */
  async enterBattlefield(o: GameObject, ctx: { controller: PlayerId; via: 'cast' | 'land-drop' | 'token' | 'effect'; item?: StackItem; tapped?: boolean; sync?: boolean }): Promise<boolean> {
    const s = this.state; const p = ctx.controller; const pl = s.players[p];
    const def = defOf(o);
    const disc = def.asEnters?.find(a => a.kind === 'discard-or-graveyard');
    if (disc && disc.kind === 'discard-or-graveyard') {
      const opts = ctx.sync ? [] : pl.hand.filter(c => c.id !== o.id && matchesFilter(s, c, disc.filter, o));
      const ids = opts.length ? await this.ask(p, { kind: 'choose-cards', from: opts.map(c => c.id), count: 1, reason: `${def.name}: discard a land card (or it goes to the graveyard)`, exact: false }) as number[] : [];
      const pick = ids.length ? findObject(s, ids[0]) : undefined;
      if (!pick || !opts.includes(pick)) { o.controller = p; this.moveTo(o, 'graveyard'); this.log(`${def.name} is put into its owner's graveyard instead of entering.`); return false; }
      this.discard(p, pick.id);
    }
    o.controller = p;
    if (o.token) { o.zone = 'battlefield'; o.enteredTurn = s.turn; pl.battlefield.push(o); } else this.moveTo(o, 'battlefield');
    o.damage = 0;
    let tapped = !!ctx.tapped || !!def.entersTapped;
    for (const a of def.asEnters ?? []) {
      switch (a.kind) {
        case 'tapped': tapped = true; break;
        case 'tapped-unless': if (!conditionHolds(s, o, a.condition)) tapped = true; break;
        case 'pay-life-or-tapped': {
          const can = pl.life > a.life && !ctx.sync;
          const pay = can && await this.ask(p, { kind: 'yes-no', prompt: `Pay ${a.life} life to have ${def.name} enter untapped?`, tag: 'shock' });
          if (pay) this.loseLife(p, a.life, def.name); else tapped = true;
          break;
        }
        case 'counters': { const n = evalAmount(s, a.amount, p, ctx.item?.x ?? o.castWith?.x ?? 0, o); if (n > 0) { o.counters[a.counter] = (o.counters[a.counter] ?? 0) + n; this.log(`${def.name} enters with ${n} ${a.counter} counter${n > 1 ? 's' : ''}.`); } break; }
        case 'choose': {
          if (a.what === 'color') { const c = ctx.sync ? 'G' : await this.ask(p, { kind: 'choose-color', reason: def.name }) as Color; o.chosen = { ...o.chosen, color: c }; this.log(`${def.name}: ${this.pname(p)} chooses ${c}.`); }
          else { const options = this.creatureTypeOptions(p); const pick = ctx.sync ? options[0] : await this.ask(p, { kind: 'choose-option', options, reason: `${def.name}: choose a creature type` }) as string; const t = options.includes(pick) ? pick : options[0]; o.chosen = { ...o.chosen, creatureType: t }; this.log(`${def.name}: ${this.pname(p)} chooses ${t}.`); }
          break;
        }
      }
    }
    if (isCreature(o) && s.players[opponentOf(p)].battlefield.some(x => abilitiesOf(x).some(ab => ab.kind === 'static' && ab.effect.kind === 'opponent-creatures-etb-tapped'))) tapped = true;
    o.tapped = tapped;
    if (o.castWith?.alt === 'impending') { const alt = o.def.altCosts?.find(x => x.id === 'impending'); if (alt?.timeCounters) o.counters.time = alt.timeCounters; }
    if (o.castWith?.alt === 'warp') o.warpExileTurn = s.turn;
    if (subtypes(o).includes('Saga') && def.finalChapter) { o.counters.lore = 1; this.queueTriggers('chapter', { obj: o, player: p }); }
    if (isLand(o)) this.queueTriggers('landfall', { player: p, obj: o, played: ctx.via === 'land-drop' });
    if (o.castWith?.alt === 'evoke') this.pendingTriggers.push({ ability: { kind: 'triggered', event: { on: 'etb', self: true }, effects: [{ op: 'sacrifice-self' }], text: 'Evoke — sacrifice it' }, source: o, controller: p });
    this.queueTriggers('etb', { obj: o, player: p });
    return true;
  }

  /** Creature types a player could sensibly name (Cavern of Souls): those among their creature cards, most common first. */
  private creatureTypeOptions(p: PlayerId): string[] {
    const pl = this.state.players[p]; const freq = new Map<string, number>();
    for (const c of [...pl.hand, ...pl.battlefield, ...pl.graveyard]) if (c.def.types.includes('Creature')) for (const st of c.def.subtypes) freq.set(st, (freq.get(st) ?? 0) + 1);
    const out = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    return out.length ? out : ['Human'];
  }

  /** Delayed triggers (CR 603.7): fire the ones due at this point of the turn. */
  private flushDelayed(at: DelayedTrigger['at'], only?: PlayerId) {
    const s = this.state; if (!s.delayed?.length) return;
    const keep: DelayedTrigger[] = [];
    for (const d of s.delayed) {
      if (d.at !== at || (only !== undefined && d.controller !== only)) { keep.push(d); continue; }
      const src = findObject(s, d.sourceId);
      if (!src) continue;
      this.pendingTriggers.push({ ability: { kind: 'triggered', event: { on: 'end-of-turn' }, effects: d.effects, text: `${d.sourceName} (delayed)` }, source: src, controller: d.controller, affected: d.affected });
    }
    s.delayed = keep;
  }

  private async activateAbility(p: PlayerId, a: Extract<PlayerAction, { type: 'activate' }>): Promise<boolean> {
    const s = this.state; const pl = s.players[p];
    const obj = pl.battlefield.find(o => o.id === a.objectId) ?? pl.graveyard.find(o => o.id === a.objectId) ?? pl.hand.find(o => o.id === a.objectId);
    if (!obj) return false;
    if (obj.token?.treasure && a.abilityIndex === -1) { // Treasure: {T}, sacrifice: add one mana of any colour
      const color = (await this.ask(p, { kind: 'choose-color', reason: 'Treasure' })) as ManaSymbol;
      pl.manaPool.push(color); this.moveTo(obj, 'graveyard'); return true;
    }
    if (obj.token?.spawn && a.abilityIndex === -1) { pl.manaPool.push('C'); this.moveTo(obj, 'graveyard'); return true; }
    if (obj.token?.clue && a.abilityIndex === -6) { // Clue: {2}, sacrifice: draw a card
      const pay = this.findPayment(pl, { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' }); if (!pay) return false; this.payMana(pl, pay);
      this.sacrifice(obj); const item = this.makeStackItem('ability', obj, p, [{ op: 'draw', amount: 1, who: 'you' }], 'Clue: draw a card', 0, undefined, '{2}, Sacrifice: Draw a card.'); s.stack.push(item);
      this.log(`${this.pname(p)} sacrifices a Clue.`); return true;
    }
    if (obj.zone === 'hand' && obj.def.cycling && a.abilityIndex === -2) {
      const pay = this.findPayment(pl, obj.def.cycling); if (!pay) return false; this.payMana(pl, pay);
      this.discard(p, obj.id); this.log(`${this.pname(p)} cycles ${obj.def.name}.`);
      if (obj.def.cyclingSearch) { // typecycling: search instead of drawing
        const opts = pl.library.filter(c => matchesFilter(s, c, obj.def.cyclingSearch, obj));
        if (opts.length) { const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: `Search for ${describeFilter(obj.def.cyclingSearch)}`, exact: false }) as number[]; const c = opts.find(o => o.id === id); if (c) { this.moveTo(c, 'hand'); this.log(`${this.pname(p)} finds ${c.def.name}.`); } }
        this.shuffle(p);
      } else await this.draw(p);
      return true;
    }
    if (a.abilityIndex === -3) { // equip
      const eq = obj.def.abilities.find(x => x.kind === 'static' && x.effect.kind === 'equipment') as { effect: { equipCost: ManaCost } } | undefined; if (!eq) return false;
      const pay = this.findPayment(pl, eq.effect.equipCost); if (!pay) return false;
      const pick = a.targets?.[0]?.[0]; if (!pick || pick.kind !== 'object') return false;
      const host = pl.battlefield.find(o => o.id === pick.id && isCreature(o)); if (!host) return false;
      this.payMana(pl, pay);
      const item = this.makeStackItem('ability', obj, p, [{ op: 'attach-self', target: { kind: 'creature', controller: 'you' } }], `Equip ${name(obj)}`, 0, undefined, 'Equip');
      item.targetsByEffect.set(0, [pick]); s.stack.push(item);
      this.log(`${this.pname(p)} equips ${name(host)}#${host.id} with ${name(obj)}.`);
      return true;
    }
    const ab = abilitiesOf(obj)[a.abilityIndex] as ActivatedAbility | undefined; if (!ab || ab.kind !== 'activated') return false;
    const x = a.x ?? 0;
    const pay = ab.cost.mana ? this.findPayment(pl, ab.cost.mana, x) : { pool: [], taps: [] };
    if (!pay) return false;
    if (ab.cost.tap && (obj.tapped || (isCreature(obj) && obj.enteredTurn === s.turn && !hasKeyword(s, obj, 'haste')))) return false;
    if (ab.activateOnlyIf && !conditionHolds(s, obj, ab.activateOnlyIf)) return false;
    if (!nonManaCostPayable(s, pl, ab.cost, obj)) return false;
    if (ab.manaAbility) { // resolve immediately (CR 605)
      this.payMana(pl, pay);
      await this.payCost(p, { ...ab.cost, mana: undefined }, obj, name(obj));
      for (const e of ab.effects) if (e.op === 'add-mana') {
        if (Array.isArray(e.mana)) pl.manaPool.push(...e.mana);
        else { const opts = e.options === 'exiled-with-colors' ? undefined : e.options; const c = (await this.ask(p, { kind: 'choose-color', reason: obj.def.name })) as ManaSymbol; const pick = opts && !opts.includes(c) ? opts[0] : c; for (let i = 0; i < (e.amount ?? 1); i++) pl.manaPool.push(pick); }
      } else this.manaSideEffect(obj, e);
      return true;
    }
    const item = this.makeStackItem('ability', obj, p, ab.effects, `${name(obj)}: ${ab.text}`, x, a.modes, ab.text);
    item.ability = ab; item.abilityIndex = a.abilityIndex;
    if (!this.assignTargets(item, a.targets)) return false;
    // pay costs
    this.payMana(pl, pay);
    if (!(await this.payCost(p, { ...ab.cost, mana: undefined }, obj, name(obj)))) return false;
    if (ab.loyalty !== undefined) { obj.counters.loyalty = (obj.counters.loyalty ?? 0) + ab.loyalty; }
    obj.activatedThisTurn.add(a.abilityIndex);
    s.stack.push(item);
    this.log(`${this.pname(p)} activates ${name(obj)}: ${ab.text}${this.describeTargets(item)}.`);
    return true;
  }

  private makeStackItem(kind: StackItem['kind'], source: GameObject, controller: PlayerId, effects: Effect[], label: string, x: number, modes: number[] | undefined, text: string): StackItem {
    return { id: ++this.stackCounter, kind, name: label, source, controller, effects, targets: [], targetsByEffect: new Map(), x, modes, text };
  }

  /** Validate and attach targets chosen by the player for every targeting effect of the item. */
  private assignTargets(item: StackItem, chosen: TargetRef[][] | undefined): boolean {
    const effs = this.effectiveEffects(item);
    const reqs = targetingEffects(effs);
    let ci = 0;
    for (const { index, spec } of reqs) {
      const opts = targetOptionsFor(this, item.controller, spec, item.source);
      const pick = chosen?.[ci++] ?? [];
      const needed = spec.count ?? 1;
      if (!spec.optional && pick.length < Math.min(needed, opts.length)) { if (opts.length === 0) return false; if (pick.length === 0) return false; }
      for (const t of pick) if (!opts.some(o => o.kind === t.kind && o.id === t.id)) return false;
      item.targetsByEffect.set(index, pick);
    }
    return true;
  }

  /** Effects that will actually run for this item (resolving chosen modes). */
  effectiveEffects(item: StackItem): Effect[] {
    const out: Effect[] = [];
    for (const e of item.effects) {
      if (e.op === 'choose-mode') { const modes = item.modes ?? [0]; for (const mi of modes) out.push(...(e.modes[mi] ?? [])); }
      else out.push(e);
    }
    return out;
  }

  describeTargets(item: StackItem): string {
    const parts: string[] = [];
    for (const refs of item.targetsByEffect.values()) for (const r of refs) parts.push(this.refName(r));
    return parts.length ? ` targeting ${parts.join(', ')}` : '';
  }
  refName(r: TargetRef): string {
    if (r.kind === 'player') return this.pname(r.id);
    if (r.kind === 'stack') return this.state.stack.find(i => i.id === r.id)?.name ?? '?';
    const o = findObject(this.state, r.id); return o ? `${name(o)}#${o.id}` : '?';
  }

  payMana(pl: import('./state.js').Player, pay: Payment) {
    for (const m of pay.pool) { const i = pl.manaPool.indexOf(m); if (i >= 0) pl.manaPool.splice(i, 1); }
    for (const t of pay.taps) {
      const o = t.source.obj; o.tapped = true;
      if (o.token?.treasure || o.token?.spawn) { this.moveTo(o, 'graveyard'); continue; }
      if (t.source.abilityIndex >= 0) { const ab = abilitiesOf(o)[t.source.abilityIndex]; if (ab?.kind === 'activated') for (const e of ab.effects) if (e.op !== 'add-mana') this.manaSideEffect(o, e); }
    }
  }

  /** Side effects of mana abilities that also do something else (Ancient Tomb's damage, City of Brass-style life loss). */
  private manaSideEffect(o: GameObject, e: Effect) {
    const p = o.controller;
    switch (e.op) {
      case 'damage-you': this.dealDamageToPlayer(o, p, evalAmount(this.state, e.amount, p, 0, o)); break;
      case 'lose-life': if (e.who === 'you') this.loseLife(p, evalAmount(this.state, e.amount, p, 0, o), name(o)); break;
      case 'gain-life': if (e.who === 'you') this.gainLife(p, evalAmount(this.state, e.amount, p, 0, o)); break;
    }
  }

  /** Resolve the top of the stack (CR 608). */
  private async resolveTop() {
    const s = this.state; const item = s.stack.pop()!;
    if (item.countered) return;
    // check targets still legal; if all illegal the spell/ability doesn't resolve (CR 608.2b)
    const effs = this.effectiveEffects(item);
    const reqs = targetingEffects(effs);
    const auraSpec = (item as StackItem & { auraSpec?: TargetSpec }).auraSpec;
    if (auraSpec) { const ref = item.targetsByEffect.get(-1)?.[0]; if (!ref || !this.targetStillLegal(ref, auraSpec, item)) { this.log(`${item.name} fizzles (enchant target illegal).`); item.countered = true; await this.finishSpell(item); return; } }
    if (reqs.length) {
      let anyLegal = false, anyTargets = false;
      for (const { index, spec } of reqs) {
        const refs = item.targetsByEffect.get(index) ?? [];
        const legal = refs.filter(r => this.targetStillLegal(r, spec, item));
        if (refs.length) anyTargets = true; if (legal.length) anyLegal = true;
        item.targetsByEffect.set(index, legal);
      }
      if (anyTargets && !anyLegal) { this.log(`${item.name} fizzles (all targets illegal).`); await this.finishSpell(item); return; }
    }
    this.log(`${item.name} resolves.`);
    for (let i = 0; i < effs.length; i++) await this.applyEffect(item, effs[i], i, effs);
    await this.finishSpell(item);
    this.checkSBA();
  }
  private async finishSpell(item: StackItem) {
    if (item.kind !== 'spell') return;
    const card = item.source; const def = card.def;
    if (card.zone !== 'stack') return; // already moved away by its own effect (shuffled into the library)
    const s = this.state;
    if (def.types.includes('Instant') || def.types.includes('Sorcery') || item.countered) {
      const altExile = item.alt && def.altCosts?.find(a => a.id === item.alt)?.exileAfter;
      if (altExile) { this.moveTo(card, 'exile'); this.log(`${def.name} is exiled (${item.alt}).`); return; }
      if (def.rebound && item.castFrom === 'hand' && !item.countered && !def.types.includes('Creature')) {
        this.moveTo(card, 'exile'); card.castableFromExile = { afterTurn: s.turn, free: true, upkeepOnly: item.controller };
        this.log(`${def.name} is exiled (rebound); it may be cast for free during ${this.pname(item.controller)}'s next upkeep.`);
        return;
      }
      card.zone = 'graveyard'; s.players[card.owner].graveyard.push(card); return;
    }
    // permanent spell: enters the battlefield under its controller's control
    if (!(await this.enterBattlefield(card, { controller: item.controller, via: 'cast', item }))) return;
    // Auras attach to their target
    if (def.subtypes.includes('Aura')) {
      const ref = item.targetsByEffect.get(-1)?.[0];
      if (ref && ref.kind === 'object') { card.attachedTo = ref.id; const host = findObject(s, ref.id); const ctl = def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'aura' && a.effect.controlEnchanted); if (host && ctl) this.changeControl(host, item.controller); }
    }
    if (def.kicker && item.kicked) (card as GameObject & { kicked?: boolean }).kicked = true;
    this.log(`${def.name} enters the battlefield under ${this.pname(item.controller)}'s control${card.tapped ? ' tapped' : ''}.`);
  }

  /** Remember the objects an effect touched ("that creature's controller", "that card's mana value"). */
  private noteAffected(item: StackItem, list: GameObject[]) {
    const s = this.state;
    item.affected = list.map(o => ({ id: o.id, lastKnown: { power: power(s, o), toughness: toughness(s, o), controller: o.controller, manaValue: manaValueOf(o) } }));
  }

  targetStillLegal(r: TargetRef, spec: TargetSpec, item: StackItem): boolean {
    return targetOptionsFor(this, item.controller, spec, item.source).some(o => o.kind === r.kind && o.id === r.id);
  }

  // ------------------------------------------------------------------ effects
  private targetsOf(item: StackItem, idx: number): TargetRef[] { return item.targetsByEffect.get(idx) ?? []; }
  private objs(refs: TargetRef[]): GameObject[] { return refs.filter(r => r.kind === 'object').map(r => findObject(this.state, r.id)!).filter(Boolean); }
  private players(refs: TargetRef[]): PlayerId[] { return refs.filter(r => r.kind === 'player').map(r => r.id as PlayerId); }

  async applyEffect(item: StackItem, e: Effect, idx: number, all: Effect[]) {
    const s = this.state; const p = item.controller; const opp = opponentOf(p); const src = item.source;
    const actx: AmountCtx = { that: item.affected?.[0]?.lastKnown, colorsSpent: src.castWith?.colorsSpent };
    const amt = (a: import('../cards/types.js').Amount) => evalAmount(s, a, p, item.x, src, actx);
    const T = this.targetsOf(item, idx);
    const ifTargetFilter = (x: { ifTarget?: import('../cards/types.js').Filter; ifTargetAlt?: { condition: import('../cards/types.js').Condition; filter: import('../cards/types.js').Filter } }) => x.ifTargetAlt && conditionHolds(s, src, x.ifTargetAlt.condition) ? x.ifTargetAlt.filter : x.ifTarget;
    switch (e.op) {
      case 'damage': {
        const n = amt(item.kicked && e.kickedAmount != null ? e.kickedAmount : e.amount);
        if (typeof e.target === 'string') {
          const group = this.groupTargets(e.target, p);
          for (const o of group.objects) this.dealDamage(src, o, n);
          for (const pl of group.players) this.dealDamageToPlayer(src, pl, n);
        } else if (e.divided && T.length) {
          const per = Math.floor(n / T.length); let extra = n - per * T.length;
          for (const r of T) { const d = per + (extra > 0 ? 1 : 0); if (extra > 0) extra--; if (r.kind === 'player') this.dealDamageToPlayer(src, r.id, d); else { const o = findObject(s, r.id); if (o) this.dealDamage(src, o, d); } }
        } else {
          for (const r of T) { if (r.kind === 'player') this.dealDamageToPlayer(src, r.id, n); else { const o = findObject(s, r.id); if (o) this.dealDamage(src, o, n); } }
        }
        break;
      }
      case 'destroy': {
        const f = ifTargetFilter(e);
        const list = (typeof e.target === 'string' ? this.groupTargets(e.target, p, e.filter).objects : this.objs(T)).filter(o => !f || matchesFilter(s, o, f, src));
        this.noteAffected(item, list);
        for (const o of list) this.destroy(o, e.noRegenerate);
        break;
      }
      case 'exile': {
        const f = ifTargetFilter(e);
        const list = (typeof e.target === 'string' ? this.groupTargets(e.target, p).objects : (e.target.self ? [src] : this.objs(T))).filter(o => !f || matchesFilter(s, o, f, src));
        this.noteAffected(item, list);
        for (const o of list) { this.moveTo(o, 'exile'); if (e.until === 'leaves') (src as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves = [...((src as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves ?? []), o.id]; }
        break;
      }
      case 'counter': {
        for (const r of T) if (r.kind === 'stack') {
          const target = s.stack.find(i => i.id === r.id); if (!target) continue;
          if (target.kind === 'spell' && target.source.def.abilities.some(a => a.kind === 'static' && a.effect.kind === 'cant-be-countered')) { this.log(`${target.name} can't be countered.`); continue; }
          if (e.unlessPay != null) {
            const pl = s.players[target.controller];
            const pay = this.findPayment(pl, { generic: e.unlessPay, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '' });
            if (pay && await this.ask(target.controller, { kind: 'yes-no', prompt: `Pay {${e.unlessPay}} to keep ${target.name} from being countered?`, tag: 'unless-pay' })) { this.payMana(pl, pay); this.log(`${this.pname(target.controller)} pays {${e.unlessPay}}.`); continue; }
          }
          target.countered = true; s.stack.splice(s.stack.indexOf(target), 1); this.log(`${target.name} is countered.`); await this.finishSpell(target);
          if (e.toExile && target.kind === 'spell' && target.source.zone === 'graveyard') { this.moveTo(target.source, 'exile'); this.log(`${target.name} is exiled instead.`); }
        }
        break;
      }
      case 'draw': { const n = amt(e.amount); const who = e.who === 'you' || e.who === 'controller' ? [p] : e.who === 'opponent' ? [opp] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T); for (const w of who) for (let i = 0; i < n; i++) await this.draw(w); break; }
      case 'loot': { for (let i = 0; i < e.draw; i++) await this.draw(p); const pl = s.players[p]; const ids = await this.ask(p, { kind: 'choose-cards', from: pl.hand.map(c => c.id), count: Math.min(e.discard, pl.hand.length), reason: 'Discard', exact: true }) as number[]; for (const id of ids) this.discard(p, id); break; }
      case 'dig': {
        const pl = s.players[p]; const n = amt(e.look); const top = pl.library.slice(0, n); if (!top.length) break;
        if (e.reveal) { for (const c of top) this.reveal(c.id); this.log(`${this.pname(p)} reveals ${top.map(c => c.def.name).join(', ')}.`); }
        const take = e.altTake && conditionHolds(s, src, e.altTake.condition) ? e.altTake.take : e.take;
        const eligible = e.filter ? top.filter(c => matchesFilter(s, c, e.filter, src)) : top;
        let taken: GameObject[] = [];
        if (take > 0 && eligible.length) {
          const want = Math.min(take, eligible.length);
          const ids = await this.ask(p, { kind: 'choose-cards', from: eligible.map(c => c.id), count: want, reason: `${item.name}: keep ${want} in hand`, exact: !e.optional }) as number[];
          taken = ids.slice(0, want).map(id => top.find(c => c.id === id)!).filter(Boolean);
        }
        pl.library.splice(0, top.length);
        for (const c of taken) { this.forgetTop(c.id); c.zone = 'hand'; pl.hand.push(c); if (e.reveal) s.knowledge.knownInHand.push(c.id); }
        let rest = top.filter(c => !taken.includes(c));
        if (rest.length) {
          if (e.rest === 'graveyard') { for (const c of rest) { this.forgetTop(c.id); c.zone = 'graveyard'; pl.graveyard.push(c); } }
          else {
            if (e.order === 'random') this.rng.shuffle(rest);
            else if (rest.length > 1) {
              const ids = await this.ask(p, { kind: 'choose-cards', from: rest.map(c => c.id), count: rest.length, reason: e.rest === 'top' ? `${item.name}: order on top (first = top)` : `${item.name}: order on the bottom (first = bottom)`, exact: true }) as number[];
              const ordered = ids.map(id => rest.find(c => c.id === id)!).filter(Boolean); rest = [...ordered, ...rest.filter(c => !ordered.includes(c))];
            }
            if (e.rest === 'top') { pl.library.unshift(...rest); this.noteTop(p, rest.map(c => c.id), top.length); }
            else { pl.library.push(...rest); for (const c of rest) this.forgetTop(c.id); }
          }
        }
        this.log(`${this.pname(p)} looks at the top ${n} card${n > 1 ? 's' : ''}${taken.length ? ` and takes ${taken.length}` : ''}.`);
        break;
      }
      case 'put-from-hand': {
        const who = e.who === 'each-player' ? [0, 1] as PlayerId[] : [p];
        for (const w of who) {
          const pl = s.players[w]; const opts = pl.hand.filter(c => !e.filter || matchesFilter(s, c, e.filter, src)); const n = Math.min(amt(e.amount), opts.length); if (!n) continue;
          const reason = e.to === 'battlefield' ? `${item.name}: put onto the battlefield` : e.to === 'library-top' ? `${item.name}: put back on top (first = top)` : `${item.name}: put on the bottom`;
          const ids = await this.ask(w, { kind: 'choose-cards', from: opts.map(c => c.id), count: n, reason, exact: !e.optional }) as number[];
          const cards = ids.slice(0, n).map(id => opts.find(c => c.id === id)!).filter(Boolean);
          if (e.to === 'battlefield') { for (const c of cards) { await this.enterBattlefield(c, { controller: w, via: 'effect' }); this.log(`${this.pname(w)} puts ${c.def.name} onto the battlefield.`); } }
          else if (e.to === 'library-top') { for (const c of [...cards].reverse()) this.moveTo(c, 'library', 'top'); this.log(`${this.pname(w)} puts ${cards.length} card(s) on top of their library.`); }
          else { for (const c of cards) this.moveTo(c, 'library', 'bottom'); this.log(`${this.pname(w)} puts ${cards.length} card(s) on the bottom of their library.`); }
        }
        break;
      }
      case 'shuffle': { if (!e.optional || await this.ask(p, { kind: 'yes-no', prompt: 'Shuffle your library?', tag: 'optional' })) { this.shuffle(p); this.log(`${this.pname(p)} shuffles.`); } break; }
      case 'shuffle-self-into-library': { if (src.zone === 'stack' || src.zone === 'battlefield' || src.zone === 'graveyard') { this.moveTo(src, 'library'); this.shuffle(src.owner); this.log(`${name(src)} is shuffled into its owner's library.`); } break; }
      case 'reveal-hand-discard': {
        const w = this.players(T)[0] ?? opp; const pl = s.players[w];
        for (const c of pl.hand) if (!s.knowledge.knownInHand.includes(c.id)) s.knowledge.knownInHand.push(c.id);
        this.log(`${this.pname(w)} reveals their hand: ${pl.hand.map(c => c.def.name).join(', ') || 'nothing'}.`);
        const eligible = pl.hand.filter(c => matchesFilter(s, c, e.filter, src)); if (!eligible.length) break;
        const [id] = await this.ask(p, { kind: 'choose-cards', from: eligible.map(c => c.id), count: 1, reason: `${item.name}: choose a card from their hand to discard`, exact: true }) as number[];
        const chosen = eligible.find(c => c.id === id) ?? eligible[0];
        if (e.count === 'all-named') { for (const c of [...pl.hand]) if (c.def.name === chosen.def.name) this.discard(w, c.id); } else this.discard(w, chosen.id);
        break;
      }
      case 'look-top': { const w = e.who === 'you' ? p : (this.players(T)[0] ?? opp); const c = s.players[w].library[0]; this.log(`${this.pname(p)} looks at the top card of ${this.pname(w)}'s library${c ? ` (${c.def.name})` : ''}.`); break; }
      case 'search': {
        const who = e.who === 'that-controller' ? (item.affected?.[0]?.lastKnown.controller ?? p) : p; const pl = s.players[who];
        if (e.optional && who !== p && !(await this.ask(who, { kind: 'yes-no', prompt: `${item.name}: search your library?`, tag: 'optional' }))) break;
        const f = { ...e.filter, ...(e.mvLE != null ? { mvLE: typeof e.mvLE === 'number' ? e.mvLE : evalAmount(s, e.mvLE, p, item.x, src, actx) } : {}) };
        const opts = pl.library.filter(c => matchesFilter(s, c, f, src));
        if (!opts.length) { this.shuffle(who); this.log(`${this.pname(who)} searches and finds nothing.`); break; }
        const ids = await this.ask(who, { kind: 'choose-cards', from: opts.map(o => o.id), count: Math.min(e.count, opts.length), reason: `Search for ${describeFilter(e.filter)}`, exact: !e.optional }) as number[];
        for (const id of ids.slice(0, e.count)) { const c = opts.find(o => o.id === id); if (!c) continue; if (e.to === 'battlefield') { await this.enterBattlefield(c, { controller: who, via: 'effect', tapped: e.tapped }); this.log(`${this.pname(who)} puts ${c.def.name} onto the battlefield${c.tapped ? ' tapped' : ''}.`); } else { this.moveTo(c, 'hand'); this.log(`${this.pname(who)} searches for ${c.def.name}.`); } }
        this.shuffle(who);
        break;
      }
      case 'delayed-trigger': { (s.delayed ??= []).push({ id: ++this.stackCounter, at: e.at, controller: p, sourceId: src.id, sourceName: name(src), effects: e.effects, affected: e.bind === 'that' ? item.affected : undefined, createdTurn: s.turn }); break; }
      case 'return-to-battlefield': {
        for (const a of item.affected ?? []) {
          const o = findObject(s, a.id); if (!o || o.zone !== 'exile') continue; const ctl = e.underControlOf === 'you' ? p : o.owner;
          await this.enterBattlefield(o, { controller: ctl, via: 'effect' }); this.log(`${name(o)} returns to the battlefield under ${this.pname(ctl)}'s control.`);
          if (e.counterIfYours && ctl === p) { const tgt = e.counterIfYours === 'self' ? src : o; if (tgt.zone === 'battlefield') tgt.counters['+1/+1'] = (tgt.counters['+1/+1'] ?? 0) + 1; }
        }
        break;
      }
      case 'exile-from-hand': {
        const pl = s.players[p]; const opts = pl.hand.filter(c => matchesFilter(s, c, e.filter, src)); if (!opts.length) break;
        const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(c => c.id), count: 1, reason: `${item.name}: exile a card from your hand`, exact: false }) as number[];
        const c = ids.length ? opts.find(o => o.id === ids[0]) : undefined; if (!c) break;
        this.moveTo(c, 'exile'); this.reveal(c.id); if (e.imprint) src.exiledWith = [...(src.exiledWith ?? []), c.id];
        this.log(`${this.pname(p)} exiles ${c.def.name} from hand${e.imprint ? ` (imprinted on ${name(src)})` : ''}.`);
        break;
      }
      case 'exile-graveyard': {
        const who = e.who === 'each-opponent' ? [opp] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T);
        for (const w of who) { const gy = [...s.players[w].graveyard]; for (const o of gy) this.moveTo(o, 'exile'); this.log(`${this.pname(w)}'s graveyard (${gy.length} cards) is exiled.`); }
        break;
      }
      case 'attach-to-that': { const a = item.affected?.[0]; const o = a ? findObject(s, a.id) : undefined; if (o && o.zone === 'battlefield' && src.zone === 'battlefield' && isCreature(o)) { src.attachedTo = o.id; this.log(`${name(src)} is attached to ${name(o)}.`); } break; }
      case 'counter-triggering': {
        const target = item.triggeringId != null ? s.stack.find(i => i.source.id === item.triggeringId && i.kind === 'spell') : undefined; if (!target) break;
        if (target.source.def.abilities.some(a => a.kind === 'static' && a.effect.kind === 'cant-be-countered')) { this.log(`${target.name} can't be countered.`); break; }
        target.countered = true; s.stack.splice(s.stack.indexOf(target), 1); this.log(`${target.name} is countered.`); await this.finishSpell(target);
        break;
      }
      case 'amass': {
        const pl = s.players[p]; let army = pl.battlefield.find(o => isCreature(o) && subtypes(o).includes('Army'));
        if (!army) { army = makeObject(s.nextId++, src.def, p, 'battlefield', s.turn); army.token = { name: 'Army', power: 0, toughness: 0, colors: ['B'], types: ['Creature'], subtypes: ['Army'], keywords: [] }; await this.enterBattlefield(army, { controller: p, via: 'token' }); this.log(`${this.pname(p)} creates a 0/0 Army token.`); }
        const n = amt(e.amount); army.counters['+1/+1'] = (army.counters['+1/+1'] ?? 0) + n; if (army.token && !army.token.subtypes.includes(e.subtype)) army.token.subtypes.push(e.subtype);
        this.log(`${this.pname(p)} amasses ${n}.`);
        break;
      }
      case 'gain-ability': { if (src.zone === 'battlefield') { (src.grantedAbilities ??= []).push(e.ability); this.log(`${name(src)} gains "${e.ability.text}".`); } break; }
      case 'crew-self': if (src.zone === 'battlefield') { src.eotFlags.crewed = true; this.log(`${name(src)} becomes an artifact creature until end of turn.`); } break;
      case 'saddle-self': if (src.zone === 'battlefield') { src.eotFlags.saddled = true; this.log(`${name(src)} is saddled until end of turn.`); } break;
      case 'damage-you': this.dealDamageToPlayer(src, p, amt(e.amount)); break;
      case 'discard': {
        const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? [opp] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T);
        for (const w of who) {
          const pl = s.players[w];
          if (e.amount === 'hand') { for (const c of [...pl.hand]) this.discard(w, c.id); continue; }
          const n = Math.min(amt(e.amount), pl.hand.length); if (!n) continue;
          if (e.random) { for (let i = 0; i < n; i++) { const c = pl.hand[this.rng.int(pl.hand.length)]; this.discard(w, c.id); } }
          else { const ids = await this.ask(w, { kind: 'choose-cards', from: pl.hand.map(c => c.id), count: n, reason: `Discard ${n}`, exact: true }) as number[]; for (const id of ids) this.discard(w, id); }
        }
        break;
      }
      case 'gain-life': {
        if (e.who === 'that-controller') { for (const a of item.affected ?? []) this.gainLife(a.lastKnown.controller, evalAmount(s, e.amount, p, item.x, src, { that: a.lastKnown })); break; }
        const who = e.who === 'you' ? [p] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T); for (const w of who) this.gainLife(w, amt(e.amount)); break;
      }
      case 'lose-life': {
        if (e.who === 'that-controller') { for (const a of item.affected ?? []) this.loseLife(a.lastKnown.controller, evalAmount(s, e.amount, p, item.x, src, { that: a.lastKnown }), item.name); break; }
        const who = e.who === 'you' ? [p] : e.who === 'opponent' || e.who === 'each-opponent' ? [opp] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T); for (const w of who) this.loseLife(w, amt(e.amount), item.name); break;
      }
      case 'set-life': { const who = e.who === 'you' ? [p] : [0, 1] as PlayerId[]; for (const w of who) { s.players[w].life = e.amount; this.log(`${this.pname(w)}'s life becomes ${e.amount}.`); } break; }
      case 'pump': case 'grant-keyword': {
        const list = this.pumpTargets(e.target, p, src, T);
        for (const o of list) {
          if (e.op === 'pump') { o.eotPower += amt(e.power); o.eotToughness += amt(e.toughness); if (e.keywords) o.eotKeywords.push(...e.keywords); }
          else o.eotKeywords.push(...e.keywords);
        }
        break;
      }
      case 'bounce': {
        const list = e.target === 'self' ? [src] : typeof e.target === 'string' ? this.groupTargets(e.target, p).objects : this.objs(T);
        // a targeted spell on the stack is bounced too (Sink into Stupor)
        for (const r of T) if (r.kind === 'stack') { const it = s.stack.find(i => i.id === r.id); if (it && it.kind === 'spell') { s.stack.splice(s.stack.indexOf(it), 1); it.countered = true; list.push(it.source); this.log(`${it.name} is returned to its owner's hand.`); } }
        this.noteAffected(item, list);
        for (const o of list) { if (o.token) { this.moveTo(o, 'exile'); continue; } if (e.to === 'hand') this.moveTo(o, 'hand'); else { this.moveTo(o, 'library', e.to === 'library-top' ? 'top' : 'bottom'); } }
        break;
      }
      case 'token': {
        const n = amt(e.count); const made: GameObject[] = [];
        for (let i = 0; i < n; i++) {
          const tok = makeObject(s.nextId++, src.def, p, 'battlefield', s.turn);
          tok.controller = p; tok.owner = p;
          tok.token = { name: e.name ?? (e.treasure ? 'Treasure' : `${e.subtypes.join(' ')} token`), power: e.power, toughness: e.toughness, colors: e.colors, types: e.types, subtypes: e.subtypes, keywords: e.keywords, treasure: e.treasure, clue: e.clue, spawn: e.spawn, dynamicPT: e.dynamicPT };
          await this.enterBattlefield(tok, { controller: p, via: 'token', tapped: e.tapped });
          if (e.attacking && s.step === 'declare-attackers') { tok.tapped = true; tok.attacking = opp; s.attackers.push(tok.id); }
          made.push(tok);
        }
        this.noteAffected(item, made);
        this.log(`${this.pname(p)} creates ${n} ${e.power}/${e.toughness} ${e.name ?? e.subtypes.join(' ')} token${n > 1 ? 's' : ''}.`);
        break;
      }
      case 'counters': {
        if (e.optional && !(await this.ask(p, { kind: 'yes-no', prompt: `${item.name}: put the counter(s)?`, tag: 'optional' }))) break;
        const list = e.target === 'self' ? [src] : e.target === 'creatures-you-control' ? s.players[p].battlefield.filter(isCreature) : e.target === 'each-other-creature-you-control' ? s.players[p].battlefield.filter(o => isCreature(o) && o !== src) : this.objs(T);
        for (const o of list) { if (o.zone !== 'battlefield') continue; o.counters[e.counter] = (o.counters[e.counter] ?? 0) + amt(e.amount); }
        break;
      }
      case 'tap': { const list = typeof e.target === 'string' ? this.groupTargets(e.target, p).objects : this.objs(T); for (const o of list) { o.tapped = true; if (e.noUntap) o.noUntapNext = true; } break; }
      case 'untap': { const list = e.target === 'self' ? [src] : e.target === 'all-you-control' ? s.players[p].battlefield : e.target === 'lands-you-control' ? s.players[p].battlefield.filter(isLand) : this.objs(T); for (const o of list) o.tapped = false; break; }
      case 'sacrifice': {
        const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? [opp] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T);
        for (const w of who) {
          const opts = s.players[w].battlefield.filter(o => matchesFilter(s, o, e.what, src));
          const n = Math.min(e.amount, opts.length); if (!n) continue;
          const ids = await this.ask(w, { kind: 'choose-cards', from: opts.map(o => o.id), count: n, reason: `Sacrifice ${n}`, exact: true }) as number[];
          for (const id of ids) { const o = findObject(s, id); if (o) this.sacrifice(o); }
        }
        break;
      }
      case 'sacrifice-self': if (src.zone === 'battlefield') this.sacrifice(src); break;
      case 'mill': { const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? [opp] : this.players(T); for (const w of who) for (let i = 0; i < amt(e.amount); i++) { const c = s.players[w].library.shift(); if (c) { this.forgetTop(c.id); c.zone = 'graveyard'; s.players[w].graveyard.push(c); } } break; }
      case 'scry': { const pl = s.players[p]; const top = pl.library.slice(0, e.amount); if (!top.length) break; const keep = await this.ask(p, { kind: 'choose-cards', from: top.map(c => c.id), count: top.length, reason: `Scry ${e.amount}: choose cards to keep on top`, exact: false }) as number[]; const bottom = top.filter(c => !keep.includes(c.id)); const kept = top.filter(c => keep.includes(c.id)); pl.library.splice(0, top.length); pl.library.unshift(...kept); pl.library.push(...bottom); this.noteTop(p, kept.map(c => c.id), top.length); for (const c of bottom) this.forgetTop(c.id); break; }
      case 'surveil': { const pl = s.players[p]; const top = pl.library.slice(0, e.amount); if (!top.length) break; const keep = await this.ask(p, { kind: 'choose-cards', from: top.map(c => c.id), count: top.length, reason: `Surveil ${e.amount}: choose cards to keep on top`, exact: false }) as number[]; const gy = top.filter(c => !keep.includes(c.id)); const kept = top.filter(c => keep.includes(c.id)); pl.library.splice(0, top.length); pl.library.unshift(...kept); this.noteTop(p, kept.map(c => c.id), top.length); for (const c of gy) { this.forgetTop(c.id); c.zone = 'graveyard'; pl.graveyard.push(c); } break; }
      case 'search-land': {
        const pl = s.players[p];
        const opts = pl.library.filter(c => isLand(c) && (!e.basic || c.def.supertypes.includes('Basic')) && (!e.subtypes || e.subtypes.some(st => c.def.subtypes.includes(st))));
        if (!opts.length) { this.shuffle(p); break; }
        const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: Math.min(e.count, opts.length), reason: 'Search for land', exact: false }) as number[];
        for (const id of ids) { const c = findObject(s, id)!; if (e.toBattlefield) { await this.enterBattlefield(c, { controller: p, via: 'effect', tapped: e.tapped }); this.log(`${this.pname(p)} puts ${c.def.name} onto the battlefield${c.tapped ? ' tapped' : ''}.`); } else this.moveTo(c, 'hand'); }
        this.shuffle(p);
        break;
      }
      case 'add-mana': { const pl = s.players[p]; if (Array.isArray(e.mana)) pl.manaPool.push(...e.mana); else { const c = (await this.ask(p, { kind: 'choose-color', reason: item.name })) as ManaSymbol; for (let i = 0; i < (e.amount ?? 1); i++) pl.manaPool.push(c); } break; }
      case 'return-from-graveyard': {
        const pool = e.anyGraveyard ? [...s.players[0].graveyard, ...s.players[1].graveyard] : s.players[p].graveyard;
        const opts = pool.filter(o => matchesFilter(s, o, e.what, src));
        if (!opts.length) break;
        const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: 'Return from graveyard', exact: false }) as number[];
        const o = opts.find(x => x.id === id);
        if (o) { this.noteAffected(item, [o]); if (e.to === 'battlefield') { await this.enterBattlefield(o, { controller: p, via: 'effect' }); this.log(`${name(o)} returns to the battlefield.`); } else this.moveTo(o, 'hand'); }
        break;
      }
      case 'fight': { const [a] = e.self ? [src] : this.objs(T.slice(0, 1)); const b = this.objs(T)[e.self ? 0 : 1]; if (a && b && a.zone === 'battlefield' && b.zone === 'battlefield') { const pa = power(s, a), pb = power(s, b); this.dealDamage(a, b, pa); this.dealDamage(b, a, pb); } break; }
      case 'bite': { const b = this.objs(T)[0]; const a = src.zone === 'battlefield' ? src : this.objs(T)[1]; if (a && b) this.dealDamage(a, b, power(s, a)); break; }
      case 'gain-control': { for (const o of this.objs(T)) { if (e.duration === 'eot') { (o as GameObject & { controlUntilEot?: PlayerId }).controlUntilEot = o.controller; } this.changeControl(o, p); if (e.untapHaste) { o.tapped = false; o.eotKeywords.push('haste'); } } break; }
      case 'regenerate': { const list = e.target === 'self' ? [src] : this.objs(T); for (const o of list) o.eotFlags.regenerationShield = (o.eotFlags.regenerationShield ?? 0) + 1; break; }
      case 'prevent-damage': { const list = e.target === 'you' ? [] : e.target === 'self' ? [src] : this.objs(T); for (const o of list) o.eotFlags.preventDamage = e.amount === 'all' ? 'all' : amt(e.amount); if (e.target === 'you') (s as GameState & { fog?: number }).fog = s.turn; break; }
      case 'cant-attack-or-block': for (const o of this.objs(T)) o.eotFlags.cantAttackOrBlock = true; break;
      case 'extra-turn': s.extraTurns.push(p); this.log(`${this.pname(p)} will take an extra turn.`); break;
      case 'transform-self': {
        if (!src.def.backFace || src.zone !== 'battlefield') break;
        src.activeFace = src.activeFace === 1 ? 0 : 1; src.transformed = src.activeFace === 1;
        if (e.viaExile) { src.enteredTurn = s.turn; src.tapped = false; src.damage = 0; src.counters = {}; }
        const d = defOf(src); if (d.types.includes('Planeswalker') && d.loyalty != null) src.counters.loyalty = d.loyalty;
        this.log(`${src.def.name} transforms into ${d.name}.`);
        if (e.viaExile) this.queueTriggers('etb', { obj: src, player: p });
        break;
      }
      case 'copy-spell': break;
      case 'attach-self': { const o = this.objs(T)[0]; if (o && src.zone === 'battlefield') src.attachedTo = o.id; break; }
      case 'choose-mode': break; // expanded earlier
      case 'conditional': { if (conditionHolds(s, src, e.condition)) for (let i = 0; i < e.then.length; i++) await this.applyEffect(item, e.then[i], idx, all); else if (e.else) for (let i = 0; i < e.else.length; i++) await this.applyEffect(item, e.else[i], idx, all); break; }
      case 'unknown': this.log(`  (unsimulated text: "${e.text}")`); break;
    }
  }

  private groupTargets(g: string, p: PlayerId, filter?: import('../cards/types.js').Filter): { objects: GameObject[]; players: PlayerId[] } {
    if (g === 'you') return { objects: [], players: [p] };
    const s = this.state, opp = opponentOf(p);
    const all = allPermanents(s), mine = s.players[p].battlefield, theirs = s.players[opp].battlefield;
    const f = (l: GameObject[]) => filter ? l.filter(o => matchesFilter(s, o, filter)) : l;
    switch (g) {
      case 'each-opponent': return { objects: [], players: [opp] };
      case 'each-player': return { objects: [], players: [0, 1] };
      case 'each-creature': case 'all-creatures': return { objects: f(all.filter(isCreature)), players: [] };
      case 'each-other-creature': return { objects: all.filter(isCreature), players: [] };
      case 'each-opponent-creature': case 'all-opponent-creatures': case 'each-creature-you-dont-control': return { objects: theirs.filter(isCreature), players: [] };
      case 'each-creature-and-player': return { objects: all.filter(isCreature), players: [0, 1] };
      case 'each-flying-creature': return { objects: all.filter(o => isCreature(o) && hasKeyword(s, o, 'flying')), players: [] };
      case 'each-nonflying-creature': return { objects: all.filter(o => isCreature(o) && !hasKeyword(s, o, 'flying')), players: [] };
      case 'all-artifacts': return { objects: all.filter(o => isType(o, 'Artifact')), players: [] };
      case 'all-enchantments': return { objects: all.filter(o => isType(o, 'Enchantment')), players: [] };
      case 'all-lands': return { objects: all.filter(isLand), players: [] };
      case 'all-nonland': return { objects: all.filter(o => !isLand(o)), players: [] };
      case 'all-tapped-creatures': return { objects: all.filter(o => isCreature(o) && o.tapped), players: [] };
      case 'all-creatures': return { objects: all.filter(isCreature), players: [] };
      default: return { objects: [], players: [] };
    }
  }
  private pumpTargets(t: unknown, p: PlayerId, src: GameObject, T: TargetRef[]): GameObject[] {
    const s = this.state;
    if (t === 'self') return src.zone === 'battlefield' ? [src] : [];
    if (t === 'creatures-you-control') return s.players[p].battlefield.filter(isCreature);
    if (t === 'permanents-you-control') return [...s.players[p].battlefield];
    if (t === 'other-creatures-you-control') return s.players[p].battlefield.filter(o => isCreature(o) && o !== src);
    if (t === 'all-creatures') return allPermanents(s).filter(isCreature);
    if (t === 'attacking-creatures') return s.players[p].battlefield.filter(o => o.attacking !== null);
    return this.objs(T);
  }

  // ------------------------------------------------------------------ primitives
  /** Draw a card; `stepDraw` marks the turn's draw-step draw (Bowmasters). Dredge may replace a non-silent draw. */
  async draw(p: PlayerId, silent = false, stepDraw = false) {
    const pl = this.state.players[p];
    if (!silent) {
      const dredger = pl.graveyard.find(c => c.def.dredge && pl.library.length >= c.def.dredge);
      if (dredger && await this.ask(p, { kind: 'yes-no', prompt: `Dredge ${dredger.def.dredge}: return ${dredger.def.name} from your graveyard instead of drawing?`, tag: 'dredge' })) {
        for (let i = 0; i < dredger.def.dredge!; i++) { const c = pl.library.shift()!; this.forgetTop(c.id); c.zone = 'graveyard'; pl.graveyard.push(c); }
        this.moveTo(dredger, 'hand'); this.log(`${pl.name} dredges ${dredger.def.name} (mills ${dredger.def.dredge}).`);
        return;
      }
    }
    const c = pl.library.shift();
    if (!c) { pl.lost = true; pl.lossReason = 'drew from an empty library'; this.state.winner = opponentOf(p); this.log(`${pl.name} tries to draw from an empty library and loses.`); return; }
    c.zone = 'hand'; pl.hand.push(c);
    this.forgetTop(c.id); if (this.state.knowledge.revealed.includes(c.id)) this.state.knowledge.knownInHand.push(c.id); // a publicly known top card is publicly drawn
    pl.cardsDrawnThisTurn = (pl.cardsDrawnThisTurn ?? 0) + 1;
    if (!silent) { this.log(`${pl.name} draws a card.`); this.queueTriggers('draw', { player: p, obj: c, stepDraw }); }
  }
  discard(p: PlayerId, id: number) { const pl = this.state.players[p]; const c = pl.hand.find(x => x.id === id); if (!c) return; this.moveTo(c, 'graveyard'); this.log(`${pl.name} discards ${c.def.name}.`); this.queueTriggers('discard', { player: p, obj: c }); }
  gainLife(p: PlayerId, n: number) { if (n <= 0) return; const pl = this.state.players[p]; const mult = pl.battlefield.some(o => abilitiesOf(o).some(a => a.kind === 'static' && a.effect.kind === 'lifegain-multiplier')) ? 2 : 1; pl.life += n * mult; pl.lifeGainedThisTurn = (pl.lifeGainedThisTurn ?? 0) + n * mult; this.log(`${pl.name} gains ${n * mult} life (${pl.life}).`); this.queueTriggers('life-gain', { player: p }); }
  loseLife(p: PlayerId, n: number, why: string) { if (n <= 0) return; const pl = this.state.players[p]; pl.life -= n; pl.lifeLostThisTurn += n; this.log(`${pl.name} loses ${n} life (${pl.life}) — ${why}.`); this.queueTriggers('life-loss-opponent', { player: p }); }

  dealDamageToPlayer(src: GameObject, p: PlayerId, n: number) {
    if (n <= 0) return;
    if ((this.state as GameState & { fog?: number }).fog === this.state.turn && this.state.step.includes('combat')) return;
    const pl = this.state.players[p];
    pl.life -= n; pl.lifeLostThisTurn += n;
    this.log(`${name(src)} deals ${n} damage to ${pl.name} (${pl.life}).`);
    if (hasKeyword(this.state, src, 'lifelink')) this.gainLife(src.controller, n);
    this.queueTriggers('life-loss-opponent', { player: p });
  }
  dealDamage(src: GameObject, o: GameObject, n: number) {
    if (n <= 0 || o.zone !== 'battlefield') return;
    if (protectedFrom(this.state, o, src)) { this.log(`${name(o)} has protection; damage prevented.`); return; }
    if (o.eotFlags.preventDamage === 'all') { this.log(`Damage to ${name(o)} prevented.`); return; }
    if (typeof o.eotFlags.preventDamage === 'number' && o.eotFlags.preventDamage > 0) { const prev = Math.min(o.eotFlags.preventDamage, n); o.eotFlags.preventDamage -= prev; n -= prev; if (n <= 0) return; }
    if (isType(o, 'Planeswalker')) { o.counters.loyalty = (o.counters.loyalty ?? 0) - n; this.log(`${name(src)} deals ${n} damage to ${name(o)} (loyalty ${o.counters.loyalty}).`); }
    else { o.damage += n; if (hasKeyword(this.state, src, 'deathtouch')) (o as GameObject & { deathtouched?: boolean }).deathtouched = true; this.log(`${name(src)} deals ${n} damage to ${name(o)}#${o.id}.`); }
    if (hasKeyword(this.state, src, 'lifelink')) this.gainLife(src.controller, n);
    this.queueTriggers('deals-damage', { obj: src });
  }

  destroy(o: GameObject, noRegen = false) {
    if (o.zone !== 'battlefield') return;
    if (hasKeyword(this.state, o, 'indestructible')) { this.log(`${name(o)} is indestructible.`); return; }
    if (!noRegen && o.eotFlags.regenerationShield) { o.eotFlags.regenerationShield--; o.tapped = true; o.damage = 0; o.attacking = null; o.blocking = []; this.log(`${name(o)} regenerates.`); return; }
    this.log(`${name(o)}#${o.id} is destroyed.`);
    this.moveTo(o, 'graveyard');
  }
  sacrifice(o: GameObject) { if (o.zone !== 'battlefield') return; this.log(`${this.pname(o.controller)} sacrifices ${name(o)}#${o.id}.`); const ctl = o.controller; this.moveTo(o, 'graveyard'); this.queueTriggers('sacrifice', { obj: o, player: ctl }); }

  changeControl(o: GameObject, to: PlayerId) {
    if (o.controller === to) return;
    const from = this.state.players[o.controller]; from.battlefield.splice(from.battlefield.indexOf(o), 1);
    o.controller = to; o.enteredTurn = this.state.turn; this.state.players[to].battlefield.push(o);
    this.log(`${this.pname(to)} gains control of ${name(o)}.`);
  }

  /** Move an object between zones, handling leave-the-battlefield bookkeeping. */
  moveTo(o: GameObject, zone: import('./state.js').Zone, libraryPos: 'top' | 'bottom' = 'top') {
    const s = this.state;
    const removeFrom = (arr: GameObject[]) => { const i = arr.indexOf(o); if (i >= 0) arr.splice(i, 1); };
    for (const p of s.players) { removeFrom(p.hand); removeFrom(p.battlefield); removeFrom(p.graveyard); removeFrom(p.exile); removeFrom(p.library); }
    const wasOnBattlefield = o.zone === 'battlefield';
    if (wasOnBattlefield) {
      o.lastKnown = { power: power(s, o), toughness: toughness(s, o), controller: o.controller };
      const creature = isCreature(o);
      const ctl = o.controller;
      // detach attachments; auras go to graveyard (SBA), equipment stays
      for (const other of allPermanents(s)) if (other.attachedTo === o.id) { other.attachedTo = null; }
      if (zone === 'graveyard' && creature) { s.players[ctl].creaturesDiedThisTurn++; this.queueTriggers('dies', { obj: o, player: ctl }); }
      this.queueTriggers('ltb', { obj: o, player: ctl });
      const ex = (o as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves;
      if (ex) { for (const id of ex) { const back = findObject(s, id); if (back && back.zone === 'exile') { void this.enterBattlefield(back, { controller: back.owner, via: 'effect', sync: true }); this.log(`${name(back)} returns to the battlefield.`); } } delete (o as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves; }
      const idx = s.attackers.indexOf(o.id); if (idx >= 0) s.attackers.splice(idx, 1);
      for (const a of allPermanents(s)) { const bi = a.blockedBy.indexOf(o.id); if (bi >= 0) a.blockedBy.splice(bi, 1); }
      s.players[ctl].permanentsLeftThisTurn = (s.players[ctl].permanentsLeftThisTurn ?? 0) + 1;
      delete o.grantedAbilities; delete o.chosen; delete o.warpExileTurn; if (o.activeFace) o.activeFace = 0;
    }
    if (o.zone === 'graveyard' && zone !== 'graveyard' && !o.token) this.queueTriggers('leaves-graveyard', { obj: o, player: o.owner });
    // public knowledge: cards leaving a hidden zone are forgotten there; cards entering one from a public zone stay known
    const fromPublic = o.zone !== 'hand' && o.zone !== 'library';
    if (o.zone === 'hand') this.forgetInHand(o.id);
    if (o.zone === 'library') this.forgetTop(o.id);
    if (!o.token && (fromPublic || o.zone === 'library') && zone === 'hand') { this.state.knowledge.knownInHand.push(o.id); if (o.zone === 'library') this.reveal(o.id); } // from library = fetched by a search (revealed)
    if (!o.token && fromPublic && zone === 'library') { this.reveal(o.id); if (libraryPos === 'top') this.state.knowledge.knownTop[o.owner].unshift(o.id); }
    o.zone = zone; o.tapped = false; o.damage = 0; o.attachedTo = null; o.attacking = null; o.blocking = []; o.blockedBy = []; o.eotPower = 0; o.eotToughness = 0; o.eotKeywords = []; o.eotFlags = {}; o.noUntapNext = false;
    if (zone !== 'battlefield') { o.counters = {}; o.controller = o.owner; }
    if (o.token && zone !== 'battlefield') return; // tokens cease to exist
    const owner = s.players[zone === 'battlefield' ? o.controller : o.owner];
    if (zone === 'library') { if (libraryPos === 'top') owner.library.unshift(o); else owner.library.push(o); }
    else if (zone === 'battlefield') { o.enteredTurn = s.turn; owner.battlefield.push(o); if (isType(o, 'Planeswalker') && defOf(o).loyalty != null) o.counters.loyalty = defOf(o).loyalty!; }
    else if (zone === 'hand' || zone === 'graveyard' || zone === 'exile') owner[zone].push(o);
  }

  // ------------------------------------------------------------------ state-based actions (CR 704)
  checkSBA() {
    const s = this.state; let again = true; let guard = 0;
    while (again && guard++ < 50) {
      again = false;
      for (const p of s.players) if (p.life <= 0 && !p.lost) { p.lost = true; p.lossReason = 'life total 0 or less'; }
      for (const p of s.players) if (p.poison >= 10 && !p.lost) { p.lost = true; p.lossReason = 'ten poison counters'; }
      if (s.players[0].lost && s.players[1].lost) { s.winner = null; this.log('Both players lose: draw.'); return; }
      if (s.players[0].lost) { s.winner = 1; this.log(`${s.players[0].name} loses (${s.players[0].lossReason}).`); return; }
      if (s.players[1].lost) { s.winner = 0; this.log(`${s.players[1].name} loses (${s.players[1].lossReason}).`); return; }
      for (const o of allPermanents(s)) {
        if (isCreature(o)) {
          const t = toughness(s, o);
          if (t <= 0) { this.log(`${name(o)}#${o.id} has toughness ${t} and is put into the graveyard.`); this.moveTo(o, 'graveyard'); again = true; continue; }
          if (o.damage >= t || (o as GameObject & { deathtouched?: boolean }).deathtouched) { delete (o as GameObject & { deathtouched?: boolean }).deathtouched; this.destroy(o); again = true; continue; }
        }
        if (isType(o, 'Planeswalker') && (o.counters.loyalty ?? 0) <= 0) { this.log(`${name(o)} has 0 loyalty.`); this.moveTo(o, 'graveyard'); again = true; continue; }
        if (subtypes(o).includes('Aura') && o.zone === 'battlefield') {
          const host = o.attachedTo != null ? findObject(s, o.attachedTo) : undefined;
          if (!host || host.zone !== 'battlefield') { this.log(`${name(o)} is put into the graveyard (not attached).`); this.moveTo(o, 'graveyard'); again = true; continue; }
        }
        if (subtypes(o).includes('Equipment') && o.attachedTo != null) { const host = findObject(s, o.attachedTo); if (!host || host.zone !== 'battlefield' || host.controller !== o.controller) o.attachedTo = null; }
        // Saga: sacrificed once its final chapter has resolved (CR 714.4)
        if (o.def.finalChapter && subtypes(o).includes('Saga') && (o.counters.lore ?? 0) >= o.def.finalChapter && !s.stack.some(it => it.source.id === o.id && it.kind === 'trigger') && !this.pendingTriggers.some(t => t.source.id === o.id)) { this.log(`${name(o)} is sacrificed (final chapter).`); this.moveTo(o, 'graveyard'); again = true; continue; }
        if ((o.counters['+1/+1'] ?? 0) > 0 && (o.counters['-1/-1'] ?? 0) > 0) { const m = Math.min(o.counters['+1/+1'], o.counters['-1/-1']); o.counters['+1/+1'] -= m; o.counters['-1/-1'] -= m; }
      }
      // legend rule
      for (const p of s.players) {
        const legends = p.battlefield.filter(o => o.def.supertypes.includes('Legendary'));
        const seen = new Map<string, GameObject>();
        for (const o of legends) { const n = name(o); if (seen.has(n)) { const older = seen.get(n)!; this.log(`Legend rule: ${n}#${older.id} is put into the graveyard.`); this.moveTo(older, 'graveyard'); again = true; } seen.set(n, o); }
      }
    }
  }

  // ------------------------------------------------------------------ triggers (CR 603)
  queueTriggers(event: string, ctx: TriggerCtx) {
    const s = this.state;
    for (const perm of allPermanents(s)) {
      for (const ab of abilitiesOf(perm)) {
        if (ab.kind !== 'triggered') continue;
        const events = ab.event.on === 'or' ? ab.event.events : [ab.event];
        let fires = false;
        for (const ev of events) {
          if (ev.on !== event) continue;
          switch (ev.on) {
            case 'etb': fires = ev.self ? ctx.obj === perm : !!ctx.obj && ctx.obj !== perm && matchesFilter(s, ctx.obj, ev.filter, perm) && (ev.controller !== 'you' || ctx.obj.controller === perm.controller); break;
            case 'dies': fires = ev.self ? ctx.obj === perm : !!ctx.obj && matchesFilter(s, ctx.obj, ev.filter, perm) && (ev.controller !== 'you' || ctx.player === perm.controller); break;
            case 'ltb': fires = ctx.obj === perm; break;
            case 'attacks': fires = ev.self ? ctx.obj === perm : (!ev.filter || (!!ctx.obj && matchesFilter(s, ctx.obj, ev.filter, perm))) && ctx.player === perm.controller; break;
            case 'blocks': case 'becomes-blocked': case 'combat-damage-player': case 'deals-damage': case 'tapped': fires = ctx.obj === perm; break;
            case 'upkeep': case 'end-step': fires = ev.whose === 'each' || (ev.whose === 'your' && ctx.player === perm.controller) || (ev.whose === 'opponent' && ctx.player !== perm.controller); break;
            case 'draw-step': case 'combat-begin': fires = ctx.player === perm.controller; break;
            case 'cast': fires = !!ctx.obj && matchesFilter(s, ctx.obj, ev.filter) && (ev.who === 'any' || (ev.who === 'you') === (ctx.player === perm.controller)) && (!ev.nth || (ctx.player !== undefined && s.players[ctx.player].spellsCastThisTurn === ev.nth))
              && (!ev.mvEqualsCounter || (perm.counters[ev.mvEqualsCounter] ?? 0) === ctx.obj.def.manaValue + (ctx.obj.def.manaCost?.x ?? 0) * (ctx.obj.castWith?.x ?? 0)); break;
            case 'landfall': fires = ctx.player === perm.controller && (!ev.played || !!ctx.played) && (!ev.other || ctx.obj !== perm); break;
            case 'life-gain': case 'discard': fires = ctx.player === perm.controller; break;
            case 'life-loss-opponent': fires = ctx.player !== perm.controller; break;
            case 'sacrifice': fires = ctx.player === perm.controller && (!ev.filter || (!!ctx.obj && matchesFilter(s, ctx.obj, ev.filter))); break;
            case 'draw': fires = ctx.player !== undefined && (ev.who === 'opponent') === (ctx.player !== perm.controller) && !(ev.exceptFirstInDrawStep && ctx.stepDraw) && (!ev.nth || (s.players[ctx.player].cardsDrawnThisTurn ?? 0) === ev.nth); break;
            case 'chapter': fires = ctx.obj === perm && ev.chapters.includes(perm.counters.lore ?? 0); break;
            case 'leaves-graveyard': fires = ctx.player === perm.controller && !!ctx.obj && matchesFilter(s, ctx.obj, ev.filter, perm); break;
          }
          if (fires) break;
        }
        if (fires) this.pendingTriggers.push({ ability: ab, source: perm, controller: perm.controller, triggerCtx: ctx });
      }
    }
    // dies triggers of the object itself (it has already left the battlefield when this is called)
    if ((event === 'dies' || event === 'ltb') && ctx.obj) {
      for (const ab of ctx.obj.def.abilities) if (ab.kind === 'triggered' && ab.event.on === event && (ab.event as { self?: boolean }).self) this.pendingTriggers.push({ ability: ab, source: ctx.obj, controller: ctx.player ?? ctx.obj.controller, triggerCtx: ctx });
    }
  }

  private putTriggersOnStack() {
    if (!this.pendingTriggers.length) return;
    const s = this.state;
    // APNAP order: active player's triggers first (they resolve last)
    const list = [...this.pendingTriggers]; this.pendingTriggers = [];
    list.sort((a, b) => (a.controller === s.activePlayer ? 0 : 1) - (b.controller === s.activePlayer ? 0 : 1));
    for (const t of list) {
      if (t.ability.intervening && !conditionHolds(s, t.source, t.ability.intervening)) continue;
      const item = this.makeStackItem('trigger', t.source, t.controller, t.ability.effects, `${name(t.source)} trigger: ${t.ability.text}`, 0, undefined, t.ability.text);
      item.ability = t.ability; if (t.affected) item.affected = t.affected; if (t.triggerCtx?.obj) item.triggeringId = t.triggerCtx.obj.id;
      // auto-choose targets for triggers: ask the controller
      const reqs = targetingEffects(this.effectiveEffects(item));
      const chosen: TargetRef[][] = [];
      for (const { spec } of reqs) {
        const opts = targetOptionsFor(this, t.controller, spec, t.source);
        if (!opts.length) { chosen.push([]); continue; }
        chosen.push([]); // filled below synchronously by AI/agent pick handled in triggerTargets
      }
      (item as StackItem & { needsTargets?: { specs: TargetSpec[] } }).needsTargets = { specs: reqs.map(r => r.spec) };
      s.stack.push(item);
      this.log(`Trigger: ${item.name}`);
    }
    // choose targets for queued triggers (async not available here; deferred to resolveTriggerTargets before priority)
    this.resolveTriggerTargetsSync();
  }

  private resolveTriggerTargetsSync() {
    for (const item of this.state.stack) {
      const nt = (item as StackItem & { needsTargets?: { specs: TargetSpec[] } }).needsTargets; if (!nt) continue;
      delete (item as StackItem & { needsTargets?: unknown }).needsTargets;
      const reqs = targetingEffects(this.effectiveEffects(item));
      const modal = item.effects.find(e => e.op === 'choose-mode');
      if (modal && modal.op === 'choose-mode' && !item.modes) item.modes = [this.autoPickMode(item, modal.modes)];
      for (const { index, spec } of targetingEffects(this.effectiveEffects(item))) {
        const opts = targetOptionsFor(this, item.controller, spec, item.source);
        const pick = this.autoPickTargets(item, spec, opts);
        item.targetsByEffect.set(index, pick);
      }
      void reqs;
      if ([...item.targetsByEffect.values()].length) this.log(`  ${item.name}${this.describeTargets(item)}`);
    }
  }
  /** Simple heuristic target choice for triggered abilities (hostile effects at opponent, helpful at self). */
  private autoPickTargets(item: StackItem, spec: TargetSpec, opts: TargetRef[]): TargetRef[] {
    if (!opts.length) return [];
    const s = this.state; const me = item.controller; const opp = opponentOf(me);
    const eff = this.effectiveEffects(item);
    const hostile = eff.some(e => ['damage', 'destroy', 'exile', 'bounce', 'tap', 'lose-life', 'discard', 'mill', 'counter', 'cant-attack-or-block', 'fight', 'bite'].includes(e.op) || (e.op === 'pump' && typeof e.power === 'number' && e.power < 0) || (e.op === 'counters' && e.counter === '-1/-1'));
    const score = (r: TargetRef) => {
      if (r.kind === 'player') return r.id === opp ? (hostile ? 5 : -5) : (hostile ? -5 : 5);
      if (r.kind === 'stack') return 1;
      const o = findObject(s, r.id)!; const val = isCreature(o) ? power(s, o) + toughness(s, o) : 3;
      return (o.controller === opp) === hostile ? val : -val;
    };
    const sorted = [...opts].sort((a, b) => score(b) - score(a));
    const n = spec.count ?? 1;
    const pick = sorted.slice(0, n).filter(r => !spec.optional || score(r) > 0);
    return pick.length || spec.optional ? pick : sorted.slice(0, 1);
  }
  private autoPickMode(item: StackItem, modes: Effect[][]): number {
    let best = 0, bestScore = -Infinity;
    modes.forEach((m, i) => { const sc = m.reduce((a, e) => a + (e.op === 'unknown' ? -10 : 1), 0); if (sc > bestScore) { bestScore = sc; best = i; } });
    return best;
  }

  // ------------------------------------------------------------------ combat (CR 506-511)
  /** The combat phase from step `from` (see runTurnFrom for the resume semantics). */
  private async combatFrom(from: Step, resume: boolean) {
    const s = this.state; const ap = s.activePlayer; const dp = opponentOf(ap);
    const at = STEPS.indexOf(from);
    const reach = (st: Step) => STEPS.indexOf(st) >= at;
    const enter = (st: Step) => STEPS.indexOf(st) > at || !resume;
    const round = async (st: Step) => { await this.priorityRound(resume && st === from); return s.winner !== null; };
    if (reach('combat-begin')) { if (enter('combat-begin')) { await this.setStep('combat-begin'); this.queueTriggers('combat-begin', { player: ap }); } if (await round('combat-begin')) return; }
    if (reach('declare-attackers') && enter('declare-attackers')) {
      await this.setStep('declare-attackers');
      const candidates = s.players[ap].battlefield.filter(o => canAttack(s, o));
      const mustAttack = candidates.filter(o => o.def.abilities.some(a => a.kind === 'static' && (a.effect as unknown as { mustAttack?: boolean }).mustAttack)).map(o => o.id);
      s.attackers = [];
      if (candidates.length) {
        const decl = await this.ask(ap, { kind: 'attackers', candidates: candidates.map(o => o.id), mustAttack }) as AttackDeclaration;
        for (const id of new Set([...decl.attackers, ...mustAttack])) {
          const o = candidates.find(c => c.id === id); if (!o) continue;
          o.attacking = dp; if (!hasKeyword(s, o, 'vigilance')) o.tapped = true; s.attackers.push(o.id);
        }
      }
      if (s.attackers.length) {
        s.players[ap].attackedThisTurn = true;
        this.log(`${this.pname(ap)} attacks with ${s.attackers.map(id => `${name(findObject(s, id)!)}#${id}`).join(', ')}.`);
        for (const id of s.attackers) this.queueTriggers('attacks', { obj: findObject(s, id), player: ap });
      }
    }
    if (at <= STEPS.indexOf('combat-damage') && s.attackers.length) {
      if (enter('declare-attackers') || from === 'declare-attackers') { if (await round('declare-attackers')) return; }
      if (reach('declare-blockers')) {
        if (enter('declare-blockers')) {
          await this.setStep('declare-blockers');
          const attackers = s.attackers.map(id => findObject(s, id)!).filter(o => o && o.zone === 'battlefield');
          const blockers = s.players[dp].battlefield.filter(o => isCreature(o) && !o.tapped);
          if (attackers.length && blockers.length) {
            const decl = await this.ask(dp, { kind: 'blockers', attackers: attackers.map(a => a.id), candidates: blockers.map(b => b.id) }) as BlockDeclaration;
            const counts = new Map<number, number>();
            for (const b of decl.blocks) {
              const blocker = blockers.find(o => o.id === b.blocker), attacker = attackers.find(o => o.id === b.attacker);
              if (!blocker || !attacker || blocker.blocking.length || !canBlock(s, blocker, attacker)) continue;
              blocker.blocking.push(attacker.id); attacker.blockedBy.push(blocker.id); counts.set(attacker.id, (counts.get(attacker.id) ?? 0) + 1);
            }
            // menace: needs 2+ blockers
            for (const a of attackers) if (hasKeyword(s, a, 'menace') && a.blockedBy.length === 1) { const b = findObject(s, a.blockedBy[0])!; b.blocking = []; a.blockedBy = []; this.log(`${name(b)} can't block ${name(a)} alone (menace).`); }
            const blocksDesc = attackers.filter(a => a.blockedBy.length).map(a => `${name(a)}#${a.id} blocked by ${a.blockedBy.map(id => `${name(findObject(s, id)!)}#${id}`).join(' + ')}`);
            this.log(blocksDesc.length ? `${this.pname(dp)} blocks: ${blocksDesc.join('; ')}.` : `${this.pname(dp)} declares no blocks.`);
            for (const a of attackers) { if (a.blockedBy.length) this.queueTriggers('becomes-blocked', { obj: a }); for (const id of a.blockedBy) this.queueTriggers('blocks', { obj: findObject(s, id) }); }
          }
        }
        if (await round('declare-blockers')) return;
      }
      // Damage
      const needFirst = allPermanents(s).some(o => (o.attacking !== null || o.blocking.length) && (hasKeyword(s, o, 'first strike') || hasKeyword(s, o, 'double strike')));
      if (reach('first-strike-damage') && (needFirst || from === 'first-strike-damage')) {
        if (enter('first-strike-damage')) { await this.setStep('first-strike-damage'); await this.combatDamage(true); this.checkSBA(); if (s.winner !== null) return; }
        if (await round('first-strike-damage')) return;
      }
      if (reach('combat-damage')) {
        if (enter('combat-damage')) { await this.setStep('combat-damage'); await this.combatDamage(false); this.checkSBA(); if (s.winner !== null) return; }
        if (await round('combat-damage')) return;
      }
    }
    if (enter('combat-end')) await this.setStep('combat-end');
    await round('combat-end');
    for (const o of allPermanents(s)) { o.attacking = null; o.blocking = []; o.blockedBy = []; }
    s.attackers = [];
  }

  private async combatDamage(firstStrikeStep: boolean) {
    const s = this.state; const ap = s.activePlayer; const dp = opponentOf(ap);
    const dealsNow = (o: GameObject) => { const fs = hasKeyword(s, o, 'first strike'), ds = hasKeyword(s, o, 'double strike'); return firstStrikeStep ? (fs || ds) : (ds || !fs); };
    const damage: { src: GameObject; to: GameObject | PlayerId; n: number }[] = [];
    for (const id of s.attackers) {
      const a = findObject(s, id); if (!a || a.zone !== 'battlefield' || a.attacking === null || !dealsNow(a)) continue;
      let p = power(s, a); if (p <= 0) continue;
      const blockers = a.blockedBy.map(b => findObject(s, b)!).filter(b => b && b.zone === 'battlefield');
      if (!blockers.length) { if (a.blockedBy.length === 0 && !(a as GameObject & { wasBlocked?: boolean }).wasBlocked) damage.push({ src: a, to: dp, n: p }); continue; }
      const dt = hasKeyword(s, a, 'deathtouch'), trample = hasKeyword(s, a, 'trample');
      for (const b of blockers) {
        const lethal = dt ? 1 : Math.max(0, toughness(s, b) - b.damage);
        const assign = Math.min(p, lethal); if (assign > 0) damage.push({ src: a, to: b, n: assign }); p -= assign;
        if (p <= 0) break;
      }
      if (p > 0) { if (trample) damage.push({ src: a, to: dp, n: p }); else damage[damage.length - 1].n += p; }
    }
    for (const o of s.players[dp].battlefield) {
      if (!o.blocking.length || !dealsNow(o)) continue;
      const p = power(s, o); if (p <= 0) continue;
      const a = findObject(s, o.blocking[0]); if (a && a.zone === 'battlefield') damage.push({ src: o, to: a, n: p });
    }
    for (const d of damage) { if (typeof d.to === 'number') { this.dealDamageToPlayer(d.src, d.to, d.n); if (d.n > 0) this.queueTriggers('combat-damage-player', { obj: d.src, player: d.to }); } else this.dealDamage(d.src, d.to, d.n); }
    for (const id of s.attackers) { const a = findObject(s, id); if (a && a.blockedBy.length) (a as GameObject & { wasBlocked?: boolean }).wasBlocked = true; }
  }

  // ------------------------------------------------------------------ agent interface
  async ask(p: PlayerId, d: Decision): Promise<unknown> {
    const agent = this.agents[p];
    return agent.decide(agent.hidden ? redact(this.state, p) : this.state, p, d);
  }
}

/** Short human description of a card filter ("basic land card", "artifact card with mana value 1 or less"). */
export function describeFilter(f: import('../cards/types.js').Filter): string {
  const parts: string[] = [];
  if (f.basic) parts.push('basic');
  if (f.colors) parts.push(f.colors.map(c => ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' })[c]).join(' or '));
  if (f.subtypes) parts.push(f.subtypes.join(' or '));
  if (f.types) parts.push(f.types.map(t => t.toLowerCase()).join(' or '));
  if (f.notTypes) parts.push('non' + f.notTypes.map(t => t.toLowerCase()).join(', non'));
  let out = `${parts.join(' ') || 'a'} card`;
  if (typeof f.mvLE === 'number') out += ` with mana value ${f.mvLE} or less`;
  return out;
}
