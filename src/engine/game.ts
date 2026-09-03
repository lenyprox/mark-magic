// The rules engine. Implements the turn structure (CR 500), priority & the stack (CR 117, 608),
// combat (CR 506-510), state-based actions (CR 704), triggered abilities (CR 603) and a broad set of effects.
import type { Ability, ActivatedAbility, CardDef, Effect, Keyword, ManaCost, ManaSymbol, TargetSpec, TriggeredAbility } from '../cards/types.js';
import { manaValue } from '../cards/parse.js';
import { allPermanents, canAttack, canBlock, colors, conditionHolds, evalAmount, findObject, hasKeyword, isCreature, isLand, isType, matchesFilter, name, power, protectedFrom, subtypes, toughness, types, flags } from './characteristics.js';
import { findPayment, manaSources, type Payment } from './mana.js';
import { makeObject, makePlayer, opponentOf, type Agent, type AttackDeclaration, type BlockDeclaration, type Decision, type GameObject, type GameState, type LegalAction, type PlayerAction, type PlayerId, type StackItem, type Step, type TargetRef } from './state.js';
import { legalActions, targetOptionsFor, targetingEffects } from './legal.js';

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

export interface GameOptions { seed?: number; startingLife?: number; maxTurns?: number; quiet?: boolean; mulligans?: boolean }

export class Game {
  state: GameState;
  agents: [Agent, Agent];
  rng: Rng;
  opts: GameOptions;
  private pendingTriggers: { ability: TriggeredAbility; source: GameObject; controller: PlayerId; triggerCtx?: { obj?: GameObject; player?: PlayerId } }[] = [];
  private stackCounter = 0;

  constructor(decks: [CardDef[], CardDef[]], agents: [Agent, Agent], opts: GameOptions = {}) {
    this.opts = opts; this.rng = new Rng(opts.seed ?? 42); this.agents = agents;
    this.state = { turn: 0, activePlayer: 0, step: 'untap', priority: 0, players: [makePlayer(0, agents[0].name), makePlayer(1, agents[1].name)], stack: [], nextId: 1, log: [], winner: null, attackers: [], extraTurns: [], passesInRow: 0 };
    decks.forEach((deck, i) => {
      const p = this.state.players[i];
      p.life = opts.startingLife ?? 20;
      for (const def of deck) p.library.push(makeObject(this.state.nextId++, def, i as PlayerId, 'library', 0));
      this.rng.shuffle(p.library);
    });
  }

  /** Build a Game around an existing (cloned) state; used for AI simulations. */
  static fromState(state: GameState, agents: [Agent, Agent], opts: GameOptions = {}): Game {
    const g = Object.create(Game.prototype) as Game;
    g.state = state; g.agents = agents; g.opts = opts; g.rng = new Rng(opts.seed ?? 1);
    (g as unknown as { pendingTriggers: unknown[] }).pendingTriggers = []; (g as unknown as { stackCounter: number }).stackCounter = 100000;
    return g;
  }

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
        for (let i = 0; i < 7; i++) this.draw(p.id, true);
        if (this.opts.mulligans === false || mulls >= 3) break;
        const again = await this.ask(p.id, { kind: 'yes-no', prompt: `Mulligan this hand? (${p.hand.map(c => c.def.name).join(', ')})` });
        if (!again) break;
        mulls++; this.log(`${p.name} mulligans.`);
        for (const c of [...p.hand]) this.moveTo(c, 'library'); this.rng.shuffle(p.library);
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
    const s = this.state; const ap = s.activePlayer;
    this.log(`\n=== Turn ${s.turn}: ${this.pname(ap)} ===`);
    for (const p of s.players) { p.landsPlayedThisTurn = 0; p.attackedThisTurn = false; p.lifeLostThisTurn = 0; p.creaturesDiedThisTurn = 0; p.spellsCastThisTurn = 0; for (const o of p.battlefield) o.activatedThisTurn.clear(); }
    // Untap
    await this.setStep('untap');
    for (const o of s.players[ap].battlefield) {
      const f = flags(s, o);
      if (o.noUntapNext) { o.noUntapNext = false; continue; }
      if (f.doesntUntap) continue;
      o.tapped = false;
    }
    // Upkeep
    await this.setStep('upkeep'); this.queueTriggers('upkeep', { player: ap }); await this.priorityRound();
    if (s.winner !== null) return;
    // Draw (skip on first turn of the game for the starting player)
    await this.setStep('draw');
    if (s.turn > 1) this.draw(ap);
    this.queueTriggers('draw-step', { player: ap }); await this.priorityRound();
    if (s.winner !== null) return;
    await this.setStep('main1'); await this.priorityRound();
    if (s.winner !== null) return;
    await this.combat();
    if (s.winner !== null) return;
    await this.setStep('main2'); await this.priorityRound();
    if (s.winner !== null) return;
    await this.setStep('end'); this.queueTriggers('end-step', { player: ap }); await this.priorityRound();
    if (s.winner !== null) return;
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
  private async priorityRound() {
    const s = this.state;
    s.priority = s.activePlayer; s.passesInRow = 0;
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
        if (!(legal ?? legalActions(this, p)).some(l => l.action.type === 'play-land' && l.action.cardId === card.id)) return false;
        this.moveTo(card, 'battlefield'); s.players[p].landsPlayedThisTurn++;
        if (card.def.entersTapped) card.tapped = true;
        this.log(`${this.pname(p)} plays ${card.def.name}${card.tapped ? ' (tapped)' : ''}.`);
        this.queueTriggers('landfall', { player: p, obj: card }); this.queueTriggers('etb', { obj: card, player: p });
        return true;
      }
      case 'cast': return this.castSpell(p, action);
      case 'activate': return this.activateAbility(p, action);
    }
  }

  /** Cast a spell: pay costs, put it on the stack with its targets (CR 601). */
  private async castSpell(p: PlayerId, a: Extract<PlayerAction, { type: 'cast' }>): Promise<boolean> {
    const s = this.state; const pl = s.players[p];
    const card = pl.hand.find(c => c.id === a.cardId); if (!card) return false;
    const def = card.def;
    const spellAb = def.abilities.find(ab => ab.kind === 'spell');
    const effects = spellAb ? spellAb.effects : [];
    const x = a.x ?? 0;
    const cost = def.manaCost ?? { generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '' };
    const reduction = this.costReduction(p, card);
    const pay = findPayment(s, pl, cost, x, reduction);
    if (!pay) return false;
    let kickPay: Payment | null = null;
    if (a.kicked && def.kicker) { kickPay = findPayment(s, pl, def.kicker, 0); if (!kickPay) return false; }
    // targets
    const item = this.makeStackItem('spell', card, p, effects, def.name, x, a.modes, spellAb?.text ?? def.oracleText);
    item.kicked = !!a.kicked;
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
    this.payMana(pl, pay); if (kickPay) this.payMana(pl, kickPay);
    for (const c of cost.phyrexian) if (!pay.pool.includes(c) && !pay.taps.some(t => t.option.includes(c))) this.loseLife(p, 2, 'Phyrexian mana');
    card.zone = 'stack'; pl.hand.splice(pl.hand.indexOf(card), 1);
    s.stack.push(item); pl.spellsCastThisTurn++;
    this.log(`${this.pname(p)} casts ${def.name}${this.describeTargets(item)}${x ? ` (X=${x})` : ''}${a.kicked ? ' (kicked)' : ''}.`);
    this.queueTriggers('cast', { obj: card, player: p });
    // prowess-style keyword
    for (const o of pl.battlefield) if (isCreature(o) && hasKeyword(s, o, 'prowess') && !isCreature(card)) { o.eotPower++; o.eotToughness++; }
    return true;
  }

  private async activateAbility(p: PlayerId, a: Extract<PlayerAction, { type: 'activate' }>): Promise<boolean> {
    const s = this.state; const pl = s.players[p];
    const obj = pl.battlefield.find(o => o.id === a.objectId) ?? pl.graveyard.find(o => o.id === a.objectId) ?? pl.hand.find(o => o.id === a.objectId);
    if (!obj) return false;
    if (obj.token?.treasure && a.abilityIndex === -1) { // Treasure: {T}, sacrifice: add one mana of any colour
      const color = (await this.ask(p, { kind: 'choose-color', reason: 'Treasure' })) as ManaSymbol;
      pl.manaPool.push(color); this.moveTo(obj, 'graveyard'); return true;
    }
    if (obj.zone === 'hand' && obj.def.cycling && a.abilityIndex === -2) {
      const pay = findPayment(s, pl, obj.def.cycling); if (!pay) return false; this.payMana(pl, pay);
      this.discard(p, obj.id); this.draw(p); this.log(`${this.pname(p)} cycles ${obj.def.name}.`); return true;
    }
    if (a.abilityIndex === -3) { // equip
      const eq = obj.def.abilities.find(x => x.kind === 'static' && x.effect.kind === 'equipment') as { effect: { equipCost: ManaCost } } | undefined; if (!eq) return false;
      const pay = findPayment(s, pl, eq.effect.equipCost); if (!pay) return false;
      const pick = a.targets?.[0]?.[0]; if (!pick || pick.kind !== 'object') return false;
      const host = pl.battlefield.find(o => o.id === pick.id && isCreature(o)); if (!host) return false;
      this.payMana(pl, pay);
      const item = this.makeStackItem('ability', obj, p, [{ op: 'attach-self', target: { kind: 'creature', controller: 'you' } }], `Equip ${name(obj)}`, 0, undefined, 'Equip');
      item.targetsByEffect.set(0, [pick]); s.stack.push(item);
      this.log(`${this.pname(p)} equips ${name(host)}#${host.id} with ${name(obj)}.`);
      return true;
    }
    const ab = obj.def.abilities[a.abilityIndex] as ActivatedAbility | undefined; if (!ab || ab.kind !== 'activated') return false;
    const x = a.x ?? 0;
    const pay = ab.cost.mana ? findPayment(s, pl, ab.cost.mana, x) : { pool: [], taps: [] };
    if (!pay) return false;
    if (ab.cost.tap && (obj.tapped || (isCreature(obj) && obj.enteredTurn === s.turn && !hasKeyword(s, obj, 'haste')))) return false;
    if (ab.manaAbility) { // resolve immediately (CR 605)
      if (ab.cost.tap) obj.tapped = true; if (ab.cost.sacrificeSelf) this.moveTo(obj, 'graveyard');
      this.payMana(pl, pay);
      for (const e of ab.effects) if (e.op === 'add-mana') {
        if (Array.isArray(e.mana)) pl.manaPool.push(...e.mana);
        else { const opts = (e as unknown as { options?: ManaSymbol[] }).options; const c = (await this.ask(p, { kind: 'choose-color', reason: obj.def.name })) as ManaSymbol; const pick = opts && !opts.includes(c) ? opts[0] : c; for (let i = 0; i < (e.amount ?? 1); i++) pl.manaPool.push(pick); }
      }
      return true;
    }
    const item = this.makeStackItem('ability', obj, p, ab.effects, `${name(obj)}: ${ab.text}`, x, a.modes, ab.text);
    item.ability = ab; item.abilityIndex = a.abilityIndex;
    if (!this.assignTargets(item, a.targets)) return false;
    // pay costs
    if (ab.cost.tap) obj.tapped = true;
    if (ab.cost.untap) obj.tapped = false;
    this.payMana(pl, pay);
    if (ab.cost.payLife) this.loseLife(p, ab.cost.payLife, 'cost');
    if (ab.cost.sacrificeSelf) this.moveTo(obj, 'graveyard');
    if (ab.cost.sacrifice) { const opts = pl.battlefield.filter(o => o !== obj && matchesFilter(s, o, ab.cost.sacrifice, obj)); if (!opts.length) return false; const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: 'Sacrifice for ' + name(obj), exact: true }) as number[]; const o = findObject(s, id)!; this.sacrifice(o); }
    if (ab.cost.discard) { const ids = await this.ask(p, { kind: 'choose-cards', from: pl.hand.map(o => o.id), count: ab.cost.discard, reason: 'Discard for ' + name(obj), exact: true }) as number[]; for (const id of ids) this.discard(p, id); }
    if (ab.cost.removeCounters) { obj.counters[ab.cost.removeCounters.counter] = (obj.counters[ab.cost.removeCounters.counter] ?? 0) - ab.cost.removeCounters.amount; }
    if (ab.cost.exileFromGraveyard) { for (let i = 0; i < ab.cost.exileFromGraveyard && pl.graveyard.length; i++) this.moveTo(pl.graveyard[0], 'exile'); }
    if (ab.cost.tapUntappedCreature) { const opts = pl.battlefield.filter(o => !o.tapped && matchesFilter(s, o, ab.cost.tapUntappedCreature, obj)); if (!opts.length) return false; opts[0].tapped = true; }
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

  private costReduction(p: PlayerId, card: GameObject): number {
    let r = 0;
    for (const o of this.state.players[p].battlefield) for (const ab of o.def.abilities) if (ab.kind === 'static' && ab.effect.kind === 'cost-reduction' && matchesFilter(this.state, card, ab.effect.filter)) r += ab.effect.amount;
    return r;
  }

  payMana(pl: import('./state.js').Player, pay: Payment) {
    for (const m of pay.pool) { const i = pl.manaPool.indexOf(m); if (i >= 0) pl.manaPool.splice(i, 1); }
    for (const t of pay.taps) {
      t.source.obj.tapped = true;
      if (t.source.obj.token?.treasure) this.moveTo(t.source.obj, 'graveyard');
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
    if (auraSpec) { const ref = item.targetsByEffect.get(-1)?.[0]; if (!ref || !this.targetStillLegal(ref, auraSpec, item)) { this.log(`${item.name} fizzles (enchant target illegal).`); item.countered = true; this.finishSpell(item); return; } }
    if (reqs.length) {
      let anyLegal = false, anyTargets = false;
      for (const { index, spec } of reqs) {
        const refs = item.targetsByEffect.get(index) ?? [];
        const legal = refs.filter(r => this.targetStillLegal(r, spec, item));
        if (refs.length) anyTargets = true; if (legal.length) anyLegal = true;
        item.targetsByEffect.set(index, legal);
      }
      if (anyTargets && !anyLegal) { this.log(`${item.name} fizzles (all targets illegal).`); this.finishSpell(item); return; }
    }
    this.log(`${item.name} resolves.`);
    for (let i = 0; i < effs.length; i++) await this.applyEffect(item, effs[i], i, effs);
    this.finishSpell(item);
    this.checkSBA();
  }
  private finishSpell(item: StackItem) {
    if (item.kind !== 'spell') return;
    const card = item.source; const def = card.def;
    if (def.types.includes('Instant') || def.types.includes('Sorcery')) { card.zone = 'graveyard'; this.state.players[card.owner].graveyard.push(card); return; }
    if (item.countered) { card.zone = 'graveyard'; this.state.players[card.owner].graveyard.push(card); return; }
    // permanent spell: enters the battlefield under its controller's control
    card.controller = item.controller; card.zone = 'battlefield'; card.enteredTurn = this.state.turn; card.tapped = !!def.entersTapped; card.damage = 0;
    this.state.players[item.controller].battlefield.push(card);
    if (def.types.includes('Planeswalker') && def.loyalty != null) card.counters.loyalty = def.loyalty;
    // Auras attach to their target
    if (def.subtypes.includes('Aura')) {
      const ref = item.targetsByEffect.get(-1)?.[0];
      if (ref && ref.kind === 'object') { card.attachedTo = ref.id; const host = findObject(this.state, ref.id); const ctl = def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'aura' && a.effect.controlEnchanted); if (host && ctl) this.changeControl(host, item.controller); }
    }
    if (def.kicker && item.kicked) (card as GameObject & { kicked?: boolean }).kicked = true;
    this.log(`${def.name} enters the battlefield under ${this.pname(item.controller)}'s control.`);
    this.queueTriggers('etb', { obj: card, player: item.controller });
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
    const amt = (a: import('../cards/types.js').Amount) => evalAmount(s, a, p, item.x, src);
    const T = this.targetsOf(item, idx);
    switch (e.op) {
      case 'damage': {
        const n = amt(e.amount);
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
        const list = typeof e.target === 'string' ? this.groupTargets(e.target, p, e.filter).objects : this.objs(T);
        for (const o of list) this.destroy(o, e.noRegenerate);
        break;
      }
      case 'exile': {
        const list = typeof e.target === 'string' ? this.groupTargets(e.target, p).objects : (e.target.self ? [src] : this.objs(T));
        for (const o of list) { this.moveTo(o, 'exile'); if (e.until === 'leaves') (src as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves = [...((src as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves ?? []), o.id]; }
        break;
      }
      case 'counter': {
        for (const r of T) if (r.kind === 'stack') {
          const target = s.stack.find(i => i.id === r.id); if (!target) continue;
          if (target.source.def.abilities.some(a => a.kind === 'static' && a.effect.kind === 'cant-be-countered')) { this.log(`${target.name} can't be countered.`); continue; }
          if (e.unlessPay != null) {
            const pl = s.players[target.controller];
            const pay = findPayment(s, pl, { generic: e.unlessPay, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '' });
            if (pay && await this.ask(target.controller, { kind: 'yes-no', prompt: `Pay {${e.unlessPay}} to keep ${target.name} from being countered?` })) { this.payMana(pl, pay); this.log(`${this.pname(target.controller)} pays {${e.unlessPay}}.`); continue; }
          }
          target.countered = true; s.stack.splice(s.stack.indexOf(target), 1); this.log(`${target.name} is countered.`); this.finishSpell(target);
        }
        break;
      }
      case 'draw': { const n = amt(e.amount); const who = e.who === 'you' || e.who === 'controller' ? [p] : e.who === 'opponent' ? [opp] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T); for (const w of who) for (let i = 0; i < n; i++) this.draw(w); break; }
      case 'loot': { for (let i = 0; i < e.draw; i++) this.draw(p); const pl = s.players[p]; const ids = await this.ask(p, { kind: 'choose-cards', from: pl.hand.map(c => c.id), count: Math.min(e.discard, pl.hand.length), reason: 'Discard', exact: true }) as number[]; for (const id of ids) this.discard(p, id); break; }
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
      case 'gain-life': { const who = e.who === 'you' ? [p] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T); for (const w of who) this.gainLife(w, amt(e.amount)); break; }
      case 'lose-life': { const who = e.who === 'you' ? [p] : e.who === 'opponent' || e.who === 'each-opponent' ? [opp] : e.who === 'each-player' ? [0, 1] as PlayerId[] : this.players(T); for (const w of who) this.loseLife(w, amt(e.amount), item.name); break; }
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
        for (const o of list) { if (o.token) { this.moveTo(o, 'exile'); continue; } if (e.to === 'hand') this.moveTo(o, 'hand'); else { this.moveTo(o, 'library', e.to === 'library-top' ? 'top' : 'bottom'); } }
        break;
      }
      case 'token': {
        const n = amt(e.count);
        for (let i = 0; i < n; i++) {
          const tok = makeObject(s.nextId++, src.def, p, 'battlefield', s.turn);
          tok.controller = p; tok.owner = p;
          tok.token = { name: e.name ?? (e.treasure ? 'Treasure' : `${e.subtypes.join(' ')} token`), power: e.power, toughness: e.toughness, colors: e.colors, types: e.types, subtypes: e.subtypes, keywords: e.keywords, treasure: e.treasure };
          if (e.tapped) tok.tapped = true;
          if (e.attacking && s.step === 'declare-attackers') { tok.tapped = true; tok.attacking = opp; s.attackers.push(tok.id); }
          s.players[p].battlefield.push(tok);
          this.queueTriggers('etb', { obj: tok, player: p });
        }
        this.log(`${this.pname(p)} creates ${n} ${e.power}/${e.toughness} ${e.name ?? e.subtypes.join(' ')} token${n > 1 ? 's' : ''}.`);
        break;
      }
      case 'counters': {
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
      case 'mill': { const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? [opp] : this.players(T); for (const w of who) for (let i = 0; i < amt(e.amount); i++) { const c = s.players[w].library.shift(); if (c) { c.zone = 'graveyard'; s.players[w].graveyard.push(c); } } break; }
      case 'scry': { const pl = s.players[p]; const top = pl.library.slice(0, e.amount); if (!top.length) break; const keep = await this.ask(p, { kind: 'choose-cards', from: top.map(c => c.id), count: top.length, reason: `Scry ${e.amount}: choose cards to keep on top`, exact: false }) as number[]; const bottom = top.filter(c => !keep.includes(c.id)); pl.library.splice(0, top.length); pl.library.unshift(...top.filter(c => keep.includes(c.id))); pl.library.push(...bottom); break; }
      case 'surveil': { const pl = s.players[p]; const top = pl.library.slice(0, e.amount); if (!top.length) break; const keep = await this.ask(p, { kind: 'choose-cards', from: top.map(c => c.id), count: top.length, reason: `Surveil ${e.amount}: choose cards to keep on top`, exact: false }) as number[]; const gy = top.filter(c => !keep.includes(c.id)); pl.library.splice(0, top.length); pl.library.unshift(...top.filter(c => keep.includes(c.id))); for (const c of gy) { c.zone = 'graveyard'; pl.graveyard.push(c); } break; }
      case 'search-land': {
        const pl = s.players[p];
        const opts = pl.library.filter(c => isLand(c) && (!e.basic || c.def.supertypes.includes('Basic')) && (!e.subtypes || e.subtypes.some(st => c.def.subtypes.includes(st))));
        if (!opts.length) { this.rng.shuffle(pl.library); break; }
        const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: Math.min(e.count, opts.length), reason: 'Search for land', exact: false }) as number[];
        for (const id of ids) { const c = findObject(s, id)!; if (e.toBattlefield) { this.moveTo(c, 'battlefield'); c.tapped = e.tapped; this.queueTriggers('landfall', { player: p, obj: c }); } else this.moveTo(c, 'hand'); }
        this.rng.shuffle(pl.library);
        break;
      }
      case 'add-mana': { const pl = s.players[p]; if (Array.isArray(e.mana)) pl.manaPool.push(...e.mana); else { const c = (await this.ask(p, { kind: 'choose-color', reason: item.name })) as ManaSymbol; for (let i = 0; i < (e.amount ?? 1); i++) pl.manaPool.push(c); } break; }
      case 'return-from-graveyard': {
        const pl = s.players[p]; const opts = pl.graveyard.filter(o => matchesFilter(s, o, e.what, src));
        if (!opts.length) break;
        const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: 'Return from graveyard', exact: false }) as number[];
        const o = findObject(s, id); if (o) { this.moveTo(o, e.to); if (e.to === 'battlefield') this.queueTriggers('etb', { obj: o, player: p }); }
        break;
      }
      case 'fight': { const [a] = e.self ? [src] : this.objs(T.slice(0, 1)); const b = this.objs(T)[e.self ? 0 : 1]; if (a && b && a.zone === 'battlefield' && b.zone === 'battlefield') { const pa = power(s, a), pb = power(s, b); this.dealDamage(a, b, pa); this.dealDamage(b, a, pb); } break; }
      case 'bite': { const b = this.objs(T)[0]; const a = src.zone === 'battlefield' ? src : this.objs(T)[1]; if (a && b) this.dealDamage(a, b, power(s, a)); break; }
      case 'gain-control': { for (const o of this.objs(T)) { if (e.duration === 'eot') { (o as GameObject & { controlUntilEot?: PlayerId }).controlUntilEot = o.controller; } this.changeControl(o, p); if (e.untapHaste) { o.tapped = false; o.eotKeywords.push('haste'); } } break; }
      case 'regenerate': { const list = e.target === 'self' ? [src] : this.objs(T); for (const o of list) o.eotFlags.regenerationShield = (o.eotFlags.regenerationShield ?? 0) + 1; break; }
      case 'prevent-damage': { const list = e.target === 'you' ? [] : e.target === 'self' ? [src] : this.objs(T); for (const o of list) o.eotFlags.preventDamage = e.amount === 'all' ? 'all' : amt(e.amount); if (e.target === 'you') (s as GameState & { fog?: number }).fog = s.turn; break; }
      case 'cant-attack-or-block': for (const o of this.objs(T)) o.eotFlags.cantAttackOrBlock = true; break;
      case 'extra-turn': s.extraTurns.push(p); this.log(`${this.pname(p)} will take an extra turn.`); break;
      case 'transform-self': break;
      case 'copy-spell': break;
      case 'attach-self': { const o = this.objs(T)[0]; if (o && src.zone === 'battlefield') src.attachedTo = o.id; break; }
      case 'choose-mode': break; // expanded earlier
      case 'conditional': { if (conditionHolds(s, src, e.condition)) for (let i = 0; i < e.then.length; i++) await this.applyEffect(item, e.then[i], idx, all); else if (e.else) for (let i = 0; i < e.else.length; i++) await this.applyEffect(item, e.else[i], idx, all); break; }
      case 'unknown': this.log(`  (unsimulated text: "${e.text}")`); break;
    }
  }

  private groupTargets(g: string, p: PlayerId, filter?: import('../cards/types.js').Filter): { objects: GameObject[]; players: PlayerId[] } {
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
    if (t === 'other-creatures-you-control') return s.players[p].battlefield.filter(o => isCreature(o) && o !== src);
    if (t === 'all-creatures') return allPermanents(s).filter(isCreature);
    if (t === 'attacking-creatures') return s.players[p].battlefield.filter(o => o.attacking !== null);
    return this.objs(T);
  }

  // ------------------------------------------------------------------ primitives
  draw(p: PlayerId, silent = false) {
    const pl = this.state.players[p];
    const c = pl.library.shift();
    if (!c) { pl.lost = true; pl.lossReason = 'drew from an empty library'; this.state.winner = opponentOf(p); this.log(`${pl.name} tries to draw from an empty library and loses.`); return; }
    c.zone = 'hand'; pl.hand.push(c);
    if (!silent) this.log(`${pl.name} draws a card.`);
  }
  discard(p: PlayerId, id: number) { const pl = this.state.players[p]; const c = pl.hand.find(x => x.id === id); if (!c) return; this.moveTo(c, 'graveyard'); this.log(`${pl.name} discards ${c.def.name}.`); this.queueTriggers('discard', { player: p, obj: c }); }
  gainLife(p: PlayerId, n: number) { if (n <= 0) return; const pl = this.state.players[p]; const mult = pl.battlefield.some(o => o.def.abilities.some(a => a.kind === 'static' && a.effect.kind === 'lifegain-multiplier')) ? 2 : 1; pl.life += n * mult; this.log(`${pl.name} gains ${n * mult} life (${pl.life}).`); this.queueTriggers('life-gain', { player: p }); }
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
      if (ex) { for (const id of ex) { const back = findObject(s, id); if (back && back.zone === 'exile') { this.moveTo(back, 'battlefield'); this.log(`${name(back)} returns to the battlefield.`); } } delete (o as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves; }
      const idx = s.attackers.indexOf(o.id); if (idx >= 0) s.attackers.splice(idx, 1);
      for (const a of allPermanents(s)) { const bi = a.blockedBy.indexOf(o.id); if (bi >= 0) a.blockedBy.splice(bi, 1); }
    }
    o.zone = zone; o.tapped = false; o.damage = 0; o.attachedTo = null; o.attacking = null; o.blocking = []; o.blockedBy = []; o.eotPower = 0; o.eotToughness = 0; o.eotKeywords = []; o.eotFlags = {}; o.noUntapNext = false;
    if (zone !== 'battlefield') { o.counters = {}; o.controller = o.owner; }
    if (o.token && zone !== 'battlefield') return; // tokens cease to exist
    const owner = s.players[zone === 'battlefield' ? o.controller : o.owner];
    if (zone === 'library') { if (libraryPos === 'top') owner.library.unshift(o); else owner.library.push(o); }
    else if (zone === 'battlefield') { o.enteredTurn = s.turn; owner.battlefield.push(o); if (isType(o, 'Planeswalker') && o.def.loyalty != null) o.counters.loyalty = o.def.loyalty; }
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
  queueTriggers(event: string, ctx: { obj?: GameObject; player?: PlayerId }) {
    const s = this.state;
    for (const perm of allPermanents(s)) {
      for (const ab of perm.def.abilities) {
        if (ab.kind !== 'triggered') continue;
        const ev = ab.event;
        if (ev.on !== event) continue;
        let fires = false;
        switch (ev.on) {
          case 'etb': fires = ev.self ? ctx.obj === perm : !!ctx.obj && ctx.obj !== perm && matchesFilter(s, ctx.obj, ev.filter, perm) && (ev.controller !== 'you' || ctx.obj.controller === perm.controller); break;
          case 'dies': fires = ev.self ? ctx.obj === perm : !!ctx.obj && matchesFilter(s, ctx.obj, ev.filter, perm) && (ev.controller !== 'you' || ctx.player === perm.controller); break;
          case 'ltb': fires = ctx.obj === perm; break;
          case 'attacks': fires = ev.self ? ctx.obj === perm : (!ev.filter || (!!ctx.obj && matchesFilter(s, ctx.obj, ev.filter, perm))) && ctx.player === perm.controller; break;
          case 'blocks': case 'becomes-blocked': case 'combat-damage-player': case 'deals-damage': case 'tapped': fires = ctx.obj === perm; break;
          case 'upkeep': case 'end-step': fires = ev.whose === 'each' || (ev.whose === 'your' && ctx.player === perm.controller) || (ev.whose === 'opponent' && ctx.player !== perm.controller); break;
          case 'draw-step': case 'combat-begin': fires = ctx.player === perm.controller; break;
          case 'cast': fires = !!ctx.obj && matchesFilter(s, ctx.obj, ev.filter) && (ev.who === 'any' || (ev.who === 'you') === (ctx.player === perm.controller)); break;
          case 'landfall': case 'life-gain': case 'discard': fires = ctx.player === perm.controller; break;
          case 'life-loss-opponent': fires = ctx.player !== perm.controller; break;
          case 'sacrifice': fires = ctx.player === perm.controller && (!ev.filter || (!!ctx.obj && matchesFilter(s, ctx.obj, ev.filter))); break;
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
      item.ability = t.ability;
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
  private async combat() {
    const s = this.state; const ap = s.activePlayer; const dp = opponentOf(ap);
    await this.setStep('combat-begin'); this.queueTriggers('combat-begin', { player: ap }); await this.priorityRound(); if (s.winner !== null) return;
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
      await this.priorityRound(); if (s.winner !== null) return;
      // Declare blockers
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
      await this.priorityRound(); if (s.winner !== null) return;
      // Damage
      const needFirst = allPermanents(s).some(o => (o.attacking !== null || o.blocking.length) && (hasKeyword(s, o, 'first strike') || hasKeyword(s, o, 'double strike')));
      if (needFirst) { await this.setStep('first-strike-damage'); await this.combatDamage(true); this.checkSBA(); if (s.winner !== null) return; await this.priorityRound(); if (s.winner !== null) return; }
      await this.setStep('combat-damage'); await this.combatDamage(false); this.checkSBA(); if (s.winner !== null) return; await this.priorityRound(); if (s.winner !== null) return;
    }
    await this.setStep('combat-end'); await this.priorityRound();
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
    return this.agents[p].decide(this.state, p, d);
  }
}
