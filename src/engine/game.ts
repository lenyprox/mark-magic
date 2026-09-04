// The rules engine. Implements the turn structure (CR 500), priority & the stack (CR 117, 608),
// combat (CR 506-510), state-based actions (CR 704), triggered abilities (CR 603) and a broad set of effects.
import type { Ability, AbilityCost, ActivatedAbility, CardDef, Color, Effect, Keyword, ManaCost, ManaSymbol, TargetSpec, TriggeredAbility } from '../cards/types.js';
import { manaValue } from '../cards/parse.js';
import { abilitiesOf, allPermanents, canAttack, canBlock, colors, conditionHolds, defOf, evalAmount, findObject, hasKeyword, isCreature, isLand, isType, manaValueOf, matchesFilter, name, power, protectedFrom, subtypes, toughness, types, flags, type AmountCtx, damageByToughness } from './characteristics.js';
import { FAST_MANA_LIMIT, MANA_COMBO_LIMIT, findPayment as findPaymentFull, manaSources, type ManaSourceOptions, type Payment } from './mana.js';
import { costAdjust, exileWindowOpen, extraManaSources, hasModifier, nonManaCostPayable, pickCrew, pickDelve, pickEscapeExile, spellManaCost, ZERO_COST } from './cost.js';
import { makeKnowledge, makeObject, makePlayer, opponentOf, STEPS, type Agent, type AttackDeclaration, type AttackTarget, type BlockDeclaration, type CastZone, type Decision, type DelayedTrigger, type GameObject, type GameState, type LegalAction, type Player, type PlayerAction, type PlayerId, type StackItem, type Step, type TargetRef } from './state.js';
import { illegalReasons, legalActions, targetOptionsFor, targetingEffects } from './legal.js';
import { redact } from './view.js';
import { citation, LOGGED, renderEvent, type EventMode, type GameEvent, type GameEventBody, type ZoneChangeReason } from './events.js';
import { alive, apnapOrder, nextInTurnOrder, opponentsOf, primaryOpponent } from './players.js';

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

export interface TriggerCtx { obj?: GameObject; player?: PlayerId; played?: boolean; stepDraw?: boolean; /** The spell or permanent whose targeting caused a 'targeted' event. */ by?: GameObject }

export interface GameOptions {
  seed?: number; startingLife?: number; maxTurns?: number; quiet?: boolean; mulligans?: boolean;
  /** Cap mana-payment enumeration (rollouts): trades exotic multi-colour payments for speed. */
  fastMana?: boolean;
  /** Event recording: 'counts' (default) keeps per-type counts, 'full' keeps the typed stream in state.events. */
  events?: EventMode;
  /** Format rules: 'commander' = 40 life, command zone, tax, 21 commander damage, commander zone replacement. */
  format?: 'freeform' | 'commander' | 'brawl';
  /** Per seat: the cards that start in the command zone (Commander / Brawl). */
  commanders?: CardDef[][];
  /** The first mulligan costs nothing (CR 103.5c multiplayer; default: commander games with three or more players). */
  freeFirstMulligan?: boolean;
}

export class Game {
  state: GameState;
  agents: Agent[];
  rng: Rng;
  opts: GameOptions;
  private pendingTriggers: { ability: TriggeredAbility; source: GameObject; controller: PlayerId; triggerCtx?: TriggerCtx; affected?: StackItem['affected'] }[] = [];
  private stackCounter = 0;

  constructor(decks: CardDef[][], agents: Agent[], opts: GameOptions = {}) {
    if (decks.length !== agents.length) throw new Error(`Game: ${decks.length} decks but ${agents.length} agents`);
    if (decks.length < 2 || decks.length > 4) throw new Error(`Game: ${decks.length} seats (2 to 4 supported)`);
    this.opts = opts; this.rng = new Rng(opts.seed ?? 42); this.agents = agents;
    this.state = { turn: 0, activePlayer: 0, step: 'untap', priority: 0, players: agents.map((a, i) => makePlayer(i, a.name)), turnOrder: agents.map((_, i) => i), stack: [], nextId: 1, log: [], winner: null, attackers: [], extraTurns: [], passesInRow: 0, knowledge: makeKnowledge(agents.length), version: 0, eventCounts: {} };
    if ((opts.events ?? 'counts') === 'full') this.state.events = [];
    if (opts.events === 'none') delete this.state.eventCounts;
    const startingLife = opts.startingLife ?? (opts.format === 'commander' ? 40 : opts.format === 'brawl' ? 25 : 20);
    decks.forEach((deck, i) => {
      const p = this.state.players[i];
      p.life = startingLife;
      for (const def of deck) p.library.push(makeObject(this.state.nextId++, def, i as PlayerId, 'library', 0));
      this.shuffle(p.id);
      for (const def of opts.commanders?.[i] ?? []) { const o = makeObject(this.state.nextId++, def, i as PlayerId, 'command', 0); o.commander = true; p.command.push(o); p.commanders.push(o.id); }
    });
  }
  /** Whether Commander rules (command zone, tax, 21 damage, zone replacement) are in force. */
  get commanderRules(): boolean { return this.opts.format === 'commander' || this.opts.format === 'brawl' || this.state.players.some(p => p.commanders?.length); }

  /** Build a Game around an existing (cloned) state; used for AI simulations. */
  static fromState(state: GameState, agents: Agent[], opts: GameOptions = {}): Game {
    const g = Object.create(Game.prototype) as Game;
    g.state = state; g.agents = agents; g.opts = opts; g.rng = new Rng(opts.seed ?? 1);
    if (!state.knowledge) state.knowledge = makeKnowledge(state.players.length);
    if (!state.turnOrder) state.turnOrder = state.players.map(p => p.id);
    if (state.version === undefined) state.version = 0;
    if ((opts.events ?? 'counts') === 'full' && !state.events) state.events = [];
    (g as unknown as { pendingTriggers: unknown[] }).pendingTriggers = []; (g as unknown as { stackCounter: number }).stackCounter = 100000; (g as unknown as { seq: number }).seq = state.events?.length ?? 0;
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
  async simulateCombat(attackerIds: number[], blocks: { blocker: number; attacker: number }[], targets?: Record<number, AttackTarget>) {
    const s = this.state; const dp = primaryOpponent(s, s.activePlayer);
    s.attackers = [];
    for (const id of attackerIds) {
      const o = findObject(s, id); if (!o || o.zone !== 'battlefield') continue;
      const want = targets?.[id]; delete o.attackingPlaneswalker;
      if (typeof want === 'object' && want) { const pw = findObject(s, want.planeswalker); o.attacking = pw?.controller ?? dp; if (pw) o.attackingPlaneswalker = pw.id; }
      else o.attacking = typeof want === 'number' ? want : dp;
      if (!hasKeyword(s, o, 'vigilance')) this.setTapped(o, true, 'attack'); s.attackers.push(id);
    }
    for (const b of blocks) { const bl = findObject(s, b.blocker), at = findObject(s, b.attacker); if (!bl || !at || bl.blocking.length || !canBlock(s, bl, at)) continue; bl.blocking.push(at.id); at.blockedBy.push(bl.id); }
    s.step = 'declare-blockers';
    // silent events: simulations keep the string log clean but replay/analysis still see the declarations
    if (s.attackers.length) this.emit({ type: 'attack', player: s.activePlayer, target: dp, attackers: s.attackers.map(id => ({ id, name: name(findObject(s, id)!) })) }, '');
    this.emit({ type: 'block', player: dp, blocks: s.attackers.flatMap(id => { const a = findObject(s, id)!; return a.blockedBy.map(bid => ({ blocker: bid, blockerName: name(findObject(s, bid)!), attacker: id, attackerName: name(a) })); }) }, '');
    for (const id of s.attackers) this.queueTriggers('attacks', { obj: findObject(s, id), player: s.activePlayer });
    if (s.attackers.length) this.queueTriggers('you-attack', { player: s.activePlayer });
    for (const id of s.attackers) { const a = findObject(s, id)!; if (a.blockedBy.length) { this.queueTriggers('becomes-blocked', { obj: a }); for (const bid of a.blockedBy) this.queueTriggers('blocks', { obj: findObject(s, bid) }); } }
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

  // ------------------------------------------------------------------ events & logging
  /** Called with every event as it happens (UI / instrumentation hook). */
  onEvent?: (ev: GameEvent) => void;
  private seq = 0;
  /**
   * The mutation funnel's output: every observable change is announced here. `text` overrides the rendered log line
   * ('' keeps the event silent); events in LOGGED render into state.log so the string log stays what it was.
   */
  emit(body: GameEventBody, text?: string): GameEvent | undefined {
    const s = this.state;
    s.version++;
    const mode = this.opts.events ?? 'counts';
    if (mode !== 'none') { const c = (s.eventCounts ??= {}); c[body.type] = (c[body.type] ?? 0) + 1; }
    const line = text ?? (LOGGED.has(body.type) ? renderEvent(body, p => this.pname(p)) : '');
    if (line) this.log(line);
    if (!s.events && !this.onEvent) return undefined; // counts mode: no per-event allocation
    const ev = { seq: ++this.seq, turn: s.turn, step: s.step, text: line, ...body } as GameEvent;
    const cr = citation(body); if (cr) ev.cr = cr;
    if (s.events) s.events.push(ev);
    this.onEvent?.(ev);
    return ev;
  }
  /** Append a line to the string log (legacy lines and notes; typed events arrive here through `emit`). */
  log(line: string) { this.state.log.push(line); if (!this.opts.quiet) for (const a of this.agents) a.onLog?.(line); }
  /** A free-text event (the string log's escape hatch). */
  note(text: string, tag?: 'manual' | 'engine') { return this.emit({ type: 'note', text, tag }); }
  private pname(p: PlayerId) { return this.state.players[p].name; }

  // ------------------------------------------------------------------ mutation primitives (the only writers of these fields)
  setTapped(o: GameObject, tapped: boolean, reason?: Extract<GameEventBody, { type: 'tap' }>['reason']) {
    if (o.tapped === tapped) return;
    o.tapped = tapped;
    this.emit({ type: 'tap', id: o.id, name: name(o), tapped, reason });
  }
  /** Doubling Season / Kami of Whispered Hopes: how many counters actually land (CR 614.1c replacement). Loyalty costs are never modified. */
  private replaceCounters(o: GameObject, counter: string, delta: number): number {
    if (delta <= 0 || o.zone !== 'battlefield' || counter === 'loyalty') return delta;
    let n = delta;
    for (const src of this.state.players[o.controller].battlefield) for (const ab of abilitiesOf(src)) {
      if (ab.kind !== 'static' || ab.effect.kind !== 'counters-replacement') continue;
      const e = ab.effect;
      if (e.counter && e.counter !== counter) continue;
      if (e.filter && !matchesFilter(this.state, o, e.filter, src)) continue;
      n = e.mode === 'double' ? n * 2 : n + 1;
    }
    return n;
  }
  addCounters(o: GameObject, counter: string, delta: number) {
    delta = this.replaceCounters(o, counter, delta);
    if (!delta) return;
    const total = (o.counters[counter] ?? 0) + delta;
    if (total <= 0) delete o.counters[counter]; else o.counters[counter] = total;
    this.emit({ type: 'counter', id: o.id, name: name(o), counter, delta, total: Math.max(0, total) });
  }
  setCounters(o: GameObject, counter: string, total: number) { this.addCounters(o, counter, total - (o.counters[counter] ?? 0)); }
  addMana(p: PlayerId, mana: ManaSymbol[], source?: string, sticky = false) {
    if (!mana.length) return;
    if (sticky) (this.state.players[p].stickyMana ??= []).push(...mana); else this.state.players[p].manaPool.push(...mana);
    this.emit({ type: 'mana', player: p, added: [...mana], source });
  }
  /** Put the top `n` cards of p's library into the graveyard. */
  mill(p: PlayerId, n: number): GameObject[] {
    const pl = this.state.players[p]; const out: GameObject[] = [];
    for (let i = 0; i < n; i++) { const c = pl.library[0]; if (!c) break; this.moveTo(c, 'graveyard', 'top', 'mill'); out.push(c); }
    return out;
  }
  /** Attach an aura/equipment to a host (null detaches). */
  attach(o: GameObject, host: GameObject | null) {
    const to = host ? host.id : null;
    if (o.attachedTo === to) return;
    o.attachedTo = to;
    this.emit({ type: 'attach', id: o.id, name: name(o), to, toName: host ? name(host) : undefined }, '');
  }
  private targetNames(item: StackItem): string[] { const parts: string[] = []; for (const refs of item.targetsByEffect.values()) for (const r of refs) parts.push(this.refName(r)); return parts; }

  // ------------------------------------------------------------------ game loop
  async play(): Promise<PlayerId | null> {
    const s = this.state;
    s.activePlayer = s.turnOrder[this.rng.int(s.turnOrder.length)];
    const freeMulligan = this.opts.freeFirstMulligan ?? (this.commanderRules && s.players.length > 2);
    for (const p of s.players) {
      let mulls = 0;
      for (;;) {
        for (let i = 0; i < 7; i++) await this.draw(p.id, true);
        if (this.opts.mulligans === false || mulls >= 3) break;
        const again = await this.ask(p.id, { kind: 'yes-no', prompt: `Mulligan this hand? (${p.hand.map(c => c.def.name).join(', ')})` });
        if (!again) break;
        mulls++; this.emit({ type: 'mulligan', player: p.id, count: mulls });
        for (const c of [...p.hand]) this.moveTo(c, 'library', 'top', 'mulligan'); this.shuffle(p.id);
      }
      const bottom = Math.max(0, mulls - (freeMulligan ? 1 : 0));
      if (bottom > 0) { const ids = await this.ask(p.id, { kind: 'choose-cards', from: p.hand.map(c => c.id), count: bottom, reason: `Put ${bottom} card(s) on the bottom of your library`, exact: true }) as number[]; for (const id of ids) { const c = p.hand.find(x => x.id === id); if (c) this.moveTo(c, 'library', 'bottom'); } }
    }
    this.emit({ type: 'game-start', first: s.activePlayer, players: s.players.map(p => p.name) });
    while (s.winner === null) {
      s.turn++;
      if (this.opts.maxTurns && s.turn > this.opts.maxTurns) { this.emit({ type: 'game-over', winner: null, reason: 'Turn limit reached: draw.' }); return null; }
      await this.runTurn();
      if (s.winner !== null) break;
      if (s.extraTurns.length) s.activePlayer = s.extraTurns.shift()!; else s.activePlayer = nextInTurnOrder(s, s.activePlayer);
    }
    this.emit({ type: 'game-over', winner: s.winner, reason: s.players.filter(p => p.id !== s.winner && p.lossReason).map(p => p.lossReason).join(', ') || 'opponents lost' });
    return s.winner;
  }

  private async runTurn() {
    const s = this.state;
    this.emit({ type: 'turn', player: s.activePlayer, number: s.turn });
    for (const p of s.players) { p.spellsCastLastTurn = p.spellsCastThisTurn; p.descendedThisTurn = false; p.landsPlayedThisTurn = 0; p.attackedThisTurn = false; p.attackedWithThisTurn = 0; p.lifeLostThisTurn = 0; p.creaturesDiedThisTurn = 0; p.spellsCastThisTurn = 0; p.permanentsLeftThisTurn = 0; p.cardsDrawnThisTurn = 0; p.lifeGainedThisTurn = 0; for (const o of p.battlefield) { o.activatedThisTurn.clear(); o.triggeredThisTurn?.clear(); } }
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
      if (s.extraTurns.length) s.activePlayer = s.extraTurns.shift()!; else s.activePlayer = nextInTurnOrder(s, s.activePlayer);
      s.turn++;
      if (this.opts.maxTurns && s.turn > this.opts.maxTurns) { this.emit({ type: 'game-over', winner: null, reason: 'Turn limit reached: draw.' }); return null; }
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
    const round = async (st: Step) => { if (s.players[ap].lost) return true; await this.priorityRound(resume && st === from); return s.winner !== null || s.players[ap].lost; };
    if (reach('untap')) {
      await this.setStep('untap');
      for (const o of s.players[ap].battlefield) {
        const f = flags(s, o);
        if (o.noUntapNext) { o.noUntapNext = false; continue; }
        if (f.doesntUntap) continue;
        this.setTapped(o, false, 'untap-step');
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
        for (const o of s.players[ap].battlefield) if (subtypes(o).includes('Saga') && o.def.finalChapter) { this.addCounters(o, 'lore', 1); this.queueTriggers('chapter', { obj: o, player: ap }); }
      }
      if (await round('main1')) return;
    }
    if (reach('combat-end')) { await this.combatFrom(from, resume); if (s.winner !== null) return; }
    if (reach('main2')) { if (enter('main2')) await this.setStep('main2'); if (await round('main2')) return; }
    if (reach('end')) {
      if (enter('end')) {
        await this.setStep('end'); this.queueTriggers('end-step', { player: ap });
        if (s.monarch === ap) { await this.draw(ap); this.note(`${this.pname(ap)} draws for being the monarch.`); }
        this.flushDelayed('next-end-step'); this.flushDelayed('your-next-end-step', ap);
        for (const o of [...s.players[ap].battlefield]) {
          if (o.warpExileTurn === s.turn) { delete o.warpExileTurn; this.moveTo(o, 'exile', 'top', 'exile'); o.castableFromExile = { afterTurn: s.turn, free: false }; this.note(`${name(o)} is exiled (warp); it may be cast from exile on a later turn.`); continue; }
          if (o.counters.time && o.def.altCosts?.some(a => a.id === 'impending')) { this.addCounters(o, 'time', -1); if (!o.counters.time) this.note(`${name(o)} loses its last time counter and is a creature.`); }
        }
      }
      if (await round('end')) return;
    }
    await this.setStep('cleanup');
    // discard to hand size
    const p = s.players[ap];
    const noMax = p.battlefield.some(o => abilitiesOf(o).some(ab => ab.kind === 'static' && ab.effect.kind === 'no-max-hand-size'));
    if (p.hand.length > 7 && !noMax) {
      const n = p.hand.length - 7;
      const chosen = await this.ask(ap, { kind: 'choose-cards', from: p.hand.map(c => c.id), count: n, reason: `Discard down to seven (${n})`, exact: true }) as number[];
      for (const id of chosen) this.discard(ap, id);
    }
    // end-of-turn effects wear off, damage removed
    for (const pl of s.players) for (const o of pl.battlefield) { o.damage = 0; o.eotPower = 0; o.eotToughness = 0; o.eotKeywords = []; o.eotFlags = {}; if (o.animated?.untilTurn !== undefined) delete o.animated; }
    // temporary control effects end
    for (const pl of s.players) for (const o of [...pl.battlefield]) { const back = (o as GameObject & { controlUntilEot?: PlayerId }).controlUntilEot; if (back !== undefined) { delete (o as GameObject & { controlUntilEot?: PlayerId }).controlUntilEot; this.changeControl(o, back); } }
    this.checkSBA();
  }

  private async setStep(step: Step) {
    this.state.step = step;
    this.state.players.forEach(p => {
      if (p.manaPool.length && p.battlefield.some(o => abilitiesOf(o).some(ab => ab.kind === 'static' && ab.effect.kind === 'unspent-mana-becomes-red'))) (p.stickyMana ??= []).push(...p.manaPool.map(() => 'R' as ManaSymbol));
      p.manaPool = [];
      if (step === 'cleanup') p.stickyMana = [];
    }); this.emit({ type: 'step', player: this.state.activePlayer, to: step }); }

  // ------------------------------------------------------------------ priority & the stack
  /** Both players receive priority until they pass in succession with an empty stack (CR 117.4). */
  private async priorityRound(resume = false) {
    const s = this.state;
    if (!resume) { s.priority = s.activePlayer; s.passesInRow = 0; }
    while (s.winner === null) {
      this.checkSBA(); if (s.winner !== null) return;
      this.putTriggersOnStack();
      const legal = legalActions(this, s.priority);
      const decision: Decision = this.agents[s.priority]?.wantsHints ? { kind: 'priority', legal, illegal: illegalReasons(this, s.priority, legal) } : { kind: 'priority', legal };
      const action = await this.ask(s.priority, decision) as PlayerAction;
      if (action.type === 'pass') {
        s.passesInRow++;
        if (s.passesInRow >= alive(s).length) {
          if (s.stack.length === 0) return;
          await this.resolveTop(); s.passesInRow = 0; s.priority = s.players[s.activePlayer].lost ? nextInTurnOrder(s, s.activePlayer) : s.activePlayer; continue;
        }
        s.priority = nextInTurnOrder(s, s.priority); continue;
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
      case 'concede': { this.eliminate(p, 'conceded', `${this.pname(p)} concedes.`); return true; }
      case 'play-land': {
        const zone = action.from === 'graveyard' ? s.players[p].graveyard : action.from === 'library' ? s.players[p].library.slice(0, 1) : s.players[p].hand;
        const card = zone.find(c => c.id === action.cardId); if (!card) return false;
        const face = action.face ?? 0;
        if (!(legal ?? legalActions(this, p)).some(l => l.action.type === 'play-land' && l.action.cardId === card.id && (l.action.face ?? 0) === face)) return false;
        card.activeFace = face;
        s.players[p].landsPlayedThisTurn++;
        await this.enterBattlefield(card, { controller: p, via: 'land-drop' });
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
    if (!alt && from !== 'hand' && from !== 'command' && !(from === 'exile' && window && exileWindowOpen(s, p, window))) return false;
    if (alt?.condition && !conditionHolds(s, { ...card, controller: p }, alt.condition)) return false;
    const spellAb = def.abilities.find(ab => ab.kind === 'spell');
    const effects = spellAb ? spellAb.effects : [];
    const x = a.x ?? 0;
    const free = from === 'exile' && !alt && !!window?.free;
    if (!free && !alt && !def.manaCost) return false;
    const cost = free ? ZERO_COST : spellManaCost(def, alt, a.kicked);
    const tax = from === 'command' ? 2 * (pl.commanderCasts[card.id] ?? 0) : 0;
    const adjust = costAdjust(s, p, card, from) - tax;
    const genericNeeded = Math.max(0, cost.generic + cost.x * x - adjust);
    const gy = pl.graveyard.filter(o => o.id !== card.id);
    const regular = manaSources(s, pl, { forSpell: card });
    const extras = extraManaSources(s, pl, def, regular);
    // payment plan: explicit choices first, else plain -> delve -> convoke/improvise
    let delveIds: number[] = [];
    let pay: Payment | null = null;
    if (a.pay?.sources?.length) pay = this.findPayment(pl, cost, x, adjust, { forSpell: card, onlyIds: a.pay.sources, preferIds: a.pay.sources }) ?? this.findPayment(pl, cost, x, adjust, { forSpell: card, preferIds: a.pay.sources });
    if (!pay && a.pay?.delve?.length) { delveIds = a.pay.delve.filter(id => gy.some(o => o.id === id)); pay = this.findPayment(pl, cost, x, adjust + delveIds.length, { forSpell: card, extraSources: a.pay.useExtras ? extras : [], extrasFirst: !!a.pay.useExtras }); }
    else if (!pay && a.pay?.useExtras) pay = this.findPayment(pl, cost, x, adjust, { forSpell: card, extraSources: extras, extrasFirst: true });
    else if (!pay) {
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
    for (const refs of item.targetsByEffect.values()) for (const r of refs) if (r.kind === 'object') { const t = findObject(s, r.id); if (t) this.queueTriggers('targeted', { obj: t, player: p, by: card }); }
    // the spell moves to the stack (CR 601.2a), then costs are paid (CR 601.2h)
    const fromZone = card.zone;
    card.zone = 'stack'; pl[from].splice(pl[from].indexOf(card), 1); if (from === 'hand') this.forgetInHand(card.id);
    delete card.castableFromExile;
    s.stack.push(item);
    this.emit({ type: 'zone-change', id: card.id, name: def.name, owner: card.owner, controller: p, from: fromZone, to: 'stack', reason: 'cast', token: false, public: true }, '');
    this.payMana(pl, pay);
    for (const c of cost.phyrexian) if (!pay.pool.includes(c) && !pay.taps.some(t => t.option.includes(c))) this.loseLife(p, 2, 'Phyrexian mana');
    if (alt) await this.payCost(p, alt.cost, card, alt.label, item);
    for (const ac of def.additionalCosts ?? []) await this.payCost(p, ac, card, `${def.name} (additional cost)`, item);
    for (const id of delveIds) { const o = findObject(s, id); if (o && o.zone === 'graveyard') this.moveTo(o, 'exile'); }
    if (delveIds.length) card.exiledWith = [...(card.exiledWith ?? []), ...delveIds];
    const colorsSpent = new Set([...pay.pool, ...pay.taps.flatMap(t => t.option)].filter(c => c !== 'C')).size;
    card.castWith = { alt: alt?.id, from, kicked: !!a.kicked, x, delved: delveIds.length, colorsSpent };
    pl.spellsCastThisTurn++;
    if (from === 'command') pl.commanderCasts[card.id] = (pl.commanderCasts[card.id] ?? 0) + 1;
    const how = [alt ? alt.label : '', from === 'graveyard' && !alt ? 'from graveyard' : from === 'exile' ? 'from exile' : from === 'command' ? (tax ? `from command zone, tax ${tax}` : 'from command zone') : '', delveIds.length ? `delve ${delveIds.length}` : '', a.kicked ? 'kicked' : ''].filter(Boolean);
    this.emit({ type: 'cast', itemId: item.id, id: card.id, name: def.name, player: p, targets: this.targetNames(item), how, x: x || undefined });
    if (def.storm) this.pendingTriggers.push({ ability: { kind: 'triggered', event: { on: 'cast', filter: {}, who: 'you' }, effects: [{ op: 'storm-copies' }], text: 'Storm' }, source: card, controller: p });
    if (def.cascade) this.pendingTriggers.push({ ability: { kind: 'triggered', event: { on: 'cast', filter: {}, who: 'you' }, effects: [{ op: 'cascade' }], text: 'Cascade' }, source: card, controller: p });
    this.queueTriggers('cast', { obj: card, player: p });
    // prowess-style keyword
    for (const o of pl.battlefield) if (isCreature(o) && hasKeyword(s, o, 'prowess') && !isCreature(card)) { o.eotPower++; o.eotToughness++; }
    return true;
  }

  /** Pay the non-mana parts of a cost for `self` (a spell on the stack or a permanent whose ability is activated). */
  async payCost(p: PlayerId, cost: AbilityCost, self: GameObject, label: string, item?: StackItem): Promise<boolean> {
    const s = this.state; const pl = s.players[p];
    const others = (zone: GameObject[]) => zone.filter(o => o.id !== self.id);
    if (cost.tap) this.setTapped(self, true, 'cost');
    if (cost.untap) this.setTapped(self, false, 'cost');
    if (cost.payLife) this.loseLife(p, cost.payLife, label);
    if (cost.energy) { pl.energy = Math.max(0, (pl.energy ?? 0) - cost.energy); this.note(`${this.pname(p)} pays ${cost.energy} energy (${pl.energy} left).`); }
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
      for (const id of ids.slice(0, cost.exileFromHand.count)) { const o = findObject(s, id); if (o) { this.moveTo(o, 'exile', 'top', 'cost'); this.note(`${this.pname(p)} exiles ${o.def.name} from hand.`); } }
    }
    if (cost.returnToHand) {
      const opts = pl.battlefield.filter(o => matchesFilter(s, o, cost.returnToHand, self)); if (!opts.length) return false;
      const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: `Return to hand for ${label}`, exact: true }) as number[];
      const o = findObject(s, id) ?? opts[0]; this.moveTo(o, 'hand', 'top', 'cost'); this.note(`${this.pname(p)} returns ${name(o)} to hand.`);
    }
    if (cost.removeCounters) this.addCounters(self, cost.removeCounters.counter, -cost.removeCounters.amount);
    if (cost.exileFromGraveyard) { const gy = others(pl.graveyard); for (let i = 0; i < cost.exileFromGraveyard && i < gy.length; i++) this.moveTo(gy[i], 'exile', 'top', 'cost'); }
    if (cost.exileOtherFromGraveyard) {
      const ids = pickEscapeExile(others(pl.graveyard), cost.exileOtherFromGraveyard.count, cost.exileOtherFromGraveyard.minCardTypes); if (!ids) return false;
      for (const id of ids) { const o = findObject(s, id); if (o) this.moveTo(o, 'exile', 'top', 'cost'); }
      if (ids.length) { self.exiledWith = [...(self.exiledWith ?? []), ...ids]; this.note(`${this.pname(p)} exiles ${ids.length} card(s) from graveyard for ${label}.`); }
    }
    if (cost.tapUntappedCreature) { const opts = pl.battlefield.filter(o => !o.tapped && matchesFilter(s, o, cost.tapUntappedCreature, self)); if (!opts.length) return false; this.setTapped(opts[0], true, 'cost'); }
    if (cost.tapCreaturesTotalPower) {
      const crew = pickCrew(s, pl, self, cost.tapCreaturesTotalPower.power, !!cost.tapCreaturesTotalPower.other); if (!crew) return false;
      for (const o of crew) this.setTapped(o, true, 'cost');
      this.note(`${this.pname(p)} taps ${crew.map(o => name(o)).join(', ')} for ${label}.`);
    }
    if (cost.sacrificeSelf) this.moveTo(self, 'graveyard', 'top', 'cost');
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
      if (!pick || !opts.includes(pick)) { o.controller = p; this.moveTo(o, 'graveyard', 'top', 'effect'); this.emit({ type: 'replaced', what: 'mox-diamond', id: o.id, name: def.name }); return false; }
      this.discard(p, pick.id);
    }
    o.controller = p;
    const fromZone = o.token ? 'none' : o.zone;
    if (o.token) { o.zone = 'battlefield'; o.enteredTurn = s.turn; pl.battlefield.push(o); this.bfGen++; } else this.moveTo(o, 'battlefield', 'top', 'enter');
    o.damage = 0;
    if (o.castWith?.alt === 'dash') {
      o.eotKeywords.push('haste');
      (s.delayed ??= []).push({ id: ++this.stackCounter, at: 'next-end-step', controller: p, sourceId: o.id, sourceName: def.name, effects: [{ op: 'bounce', target: 'self', to: 'hand' }], createdTurn: s.turn });
    }
    let tapped = !!ctx.tapped || (typeof def.entersTapped === 'object' ? !conditionHolds(s, o, def.entersTapped.unless) : !!def.entersTapped);
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
        case 'counters': { if (a.condition && !conditionHolds(s, o, a.condition)) break; const n = evalAmount(s, a.amount, p, ctx.item?.x ?? o.castWith?.x ?? 0, o); if (n > 0) { this.addCounters(o, a.counter, n); this.note(`${def.name} enters with ${n} ${a.counter} counter${n > 1 ? 's' : ''}.`); } break; }
        case 'choose': {
          if (a.what === 'color') { const c = ctx.sync ? 'G' : await this.ask(p, { kind: 'choose-color', reason: def.name }) as Color; o.chosen = { ...o.chosen, color: c }; this.note(`${def.name}: ${this.pname(p)} chooses ${c}.`); }
          else { const options = this.creatureTypeOptions(p); const pick = ctx.sync ? options[0] : await this.ask(p, { kind: 'choose-option', options, reason: `${def.name}: choose a creature type` }) as string; const t = options.includes(pick) ? pick : options[0]; o.chosen = { ...o.chosen, creatureType: t }; this.note(`${def.name}: ${this.pname(p)} chooses ${t}.`); }
          break;
        }
      }
    }
    if (isCreature(o) && opponentsOf(s, p).some(q => s.players[q].battlefield.some(x => abilitiesOf(x).some(ab => ab.kind === 'static' && ab.effect.kind === 'opponent-creatures-etb-tapped')))) tapped = true;
    o.tapped = tapped;
    const reason: ZoneChangeReason = ctx.via === 'cast' ? 'resolve' : ctx.via === 'land-drop' ? 'play' : ctx.via === 'token' ? 'token' : ctx.sync ? 'return' : 'effect';
    this.emit({ type: 'zone-change', id: o.id, name: name(o), owner: o.owner, controller: p, from: fromZone, to: 'battlefield', reason, token: !!o.token, public: true, tapped });
    if (o.castWith?.alt === 'impending') { const alt = o.def.altCosts?.find(x => x.id === 'impending'); if (alt?.timeCounters) this.setCounters(o, 'time', alt.timeCounters); }
    if (o.castWith?.alt === 'warp') o.warpExileTurn = s.turn;
    if (subtypes(o).includes('Saga') && def.finalChapter) { this.setCounters(o, 'lore', 1); this.queueTriggers('chapter', { obj: o, player: p }); }
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
      this.addMana(p, [color], 'Treasure'); this.moveTo(obj, 'graveyard', 'top', 'sacrifice'); return true;
    }
    if (obj.token?.spawn && a.abilityIndex === -1) { this.addMana(p, ['C'], name(obj)); this.moveTo(obj, 'graveyard', 'top', 'sacrifice'); return true; }
    if (obj.token?.clue && a.abilityIndex === -6) { // Clue: {2}, sacrifice: draw a card
      const pay = this.findPayment(pl, { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' }); if (!pay) return false; this.payMana(pl, pay);
      this.sacrifice(obj); const item = this.makeStackItem('ability', obj, p, [{ op: 'draw', amount: 1, who: 'you' }], 'Clue: draw a card', 0, undefined, '{2}, Sacrifice: Draw a card.'); s.stack.push(item);
      this.emit({ type: 'activate', itemId: item.id, id: obj.id, name: 'Clue', player: p, ability: 'draw a card', targets: [] }, `${this.pname(p)} sacrifices a Clue.`); return true;
    }
    if (obj.token?.food && a.abilityIndex === -7) { // Food: {2}, {T}, sacrifice: gain 3 life
      if (obj.tapped) return false;
      const pay = this.findPayment(pl, { generic: 2, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{2}' }); if (!pay) return false; this.payMana(pl, pay);
      this.setTapped(obj, true, 'cost'); this.sacrifice(obj); const item = this.makeStackItem('ability', obj, p, [{ op: 'gain-life', amount: 3, who: 'you' }], 'Food: gain 3 life', 0, undefined, '{2}, {T}, Sacrifice: You gain 3 life.'); s.stack.push(item);
      this.emit({ type: 'activate', itemId: item.id, id: obj.id, name: 'Food', player: p, ability: 'gain 3 life', targets: [] }, `${this.pname(p)} sacrifices a Food.`); return true;
    }
    if (obj.zone === 'hand' && obj.def.cycling && a.abilityIndex === -2) {
      const pay = this.findPayment(pl, obj.def.cycling); if (!pay) return false; this.payMana(pl, pay);
      this.discard(p, obj.id); this.note(`${this.pname(p)} cycles ${obj.def.name}.`);
      if (obj.def.cyclingSearch) { // typecycling: search instead of drawing
        const opts = pl.library.filter(c => matchesFilter(s, c, obj.def.cyclingSearch, obj));
        if (opts.length) { const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: `Search for ${describeFilter(obj.def.cyclingSearch)}`, exact: false }) as number[]; const c = opts.find(o => o.id === id); if (c) { this.moveTo(c, 'hand', 'top', 'search'); this.note(`${this.pname(p)} finds ${c.def.name}.`); } }
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
      this.emit({ type: 'activate', itemId: item.id, id: obj.id, name: name(obj), player: p, ability: 'Equip', targets: [`${name(host)}#${host.id}`] }, `${this.pname(p)} equips ${name(host)}#${host.id} with ${name(obj)}.`);
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
        if (Array.isArray(e.mana)) this.addMana(p, e.mana, name(obj));
        else if (e.options === 'chosen-color') { this.addMana(p, Array(e.amount ?? 1).fill(obj.chosen?.color ?? 'G') as ManaSymbol[], name(obj)); }
        else { const opts = e.options === 'exiled-with-colors' ? undefined : e.options; const c = (await this.ask(p, { kind: 'choose-color', reason: obj.def.name })) as ManaSymbol; const pick = opts && !opts.includes(c) ? opts[0] : c; this.addMana(p, Array(e.amount ?? 1).fill(pick) as ManaSymbol[], name(obj)); }
      } else this.manaSideEffect(obj, e);
      return true;
    }
    const item = this.makeStackItem('ability', obj, p, ab.effects, `${name(obj)}: ${ab.text}`, x, a.modes, ab.text);
    item.ability = ab; item.abilityIndex = a.abilityIndex;
    if (!this.assignTargets(item, a.targets)) return false;
    for (const refs of item.targetsByEffect.values()) for (const r of refs) if (r.kind === 'object') { const t = findObject(s, r.id); if (t) this.queueTriggers('targeted', { obj: t, player: p, by: obj }); }
    // pay costs
    this.payMana(pl, pay);
    if (!(await this.payCost(p, { ...ab.cost, mana: undefined }, obj, name(obj)))) return false;
    if (ab.loyalty !== undefined) this.addCounters(obj, 'loyalty', ab.loyalty);
    obj.activatedThisTurn.add(a.abilityIndex);
    s.stack.push(item);
    this.emit({ type: 'activate', itemId: item.id, id: obj.id, name: name(obj), player: p, ability: ab.text, targets: this.targetNames(item) });
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
    for (const m of pay.pool) { const i = pl.manaPool.indexOf(m); if (i >= 0) { pl.manaPool.splice(i, 1); continue; } const j = pl.stickyMana?.indexOf(m) ?? -1; if (j >= 0) pl.stickyMana!.splice(j, 1); }
    for (const t of pay.taps) {
      const o = t.source.obj; this.setTapped(o, true, 'mana');
      if (o.token?.treasure || o.token?.spawn) { this.moveTo(o, 'graveyard', 'top', 'sacrifice'); continue; }
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
    if (auraSpec) { const ref = item.targetsByEffect.get(-1)?.[0]; if (!ref || !this.targetStillLegal(ref, auraSpec, item)) { this.emit({ type: 'fizzle', itemId: item.id, name: item.name, reason: 'enchant-target-illegal' }); item.countered = true; await this.finishSpell(item); return; } }
    if (reqs.length) {
      let anyLegal = false, anyTargets = false;
      for (const { index, spec } of reqs) {
        const refs = item.targetsByEffect.get(index) ?? [];
        const legal = refs.filter(r => this.targetStillLegal(r, spec, item));
        if (refs.length) anyTargets = true; if (legal.length) anyLegal = true;
        item.targetsByEffect.set(index, legal);
      }
      if (anyTargets && !anyLegal) { this.emit({ type: 'fizzle', itemId: item.id, name: item.name, reason: 'all-targets-illegal' }); await this.finishSpell(item); return; }
    }
    this.emit({ type: 'resolve', itemId: item.id, name: item.name, kind: item.kind });
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
      const altSpec = item.alt ? def.altCosts?.find(a => a.id === item.alt) : undefined;
      if (altSpec?.returnToHand && !item.countered) { this.moveTo(card, 'hand', 'top', 'bounce'); this.note(`${def.name} returns to its owner's hand (${item.alt}).`); return; }
      const altExile = altSpec?.exileAfter;
      if (altExile) { this.moveTo(card, 'exile', 'top', 'exile'); this.note(`${def.name} is exiled (${item.alt}).`); return; }
      if (def.rebound && item.castFrom === 'hand' && !item.countered && !def.types.includes('Creature')) {
        this.moveTo(card, 'exile', 'top', 'exile'); card.castableFromExile = { afterTurn: s.turn, free: true, upkeepOnly: item.controller };
        this.emit({ type: 'replaced', what: 'rebound', id: card.id, name: def.name }, `${def.name} is exiled (rebound); it may be cast for free during ${this.pname(item.controller)}'s next upkeep.`);
        return;
      }
      this.moveTo(card, 'graveyard', 'top', item.countered ? 'countered' : 'resolve'); return;
    }
    // permanent spell: enters the battlefield under its controller's control
    if (!(await this.enterBattlefield(card, { controller: item.controller, via: 'cast', item }))) return;
    // Auras attach to their target
    if (def.subtypes.includes('Aura')) {
      const ref = item.targetsByEffect.get(-1)?.[0];
      if (ref && ref.kind === 'object') { const host = findObject(s, ref.id); this.attach(card, host ?? null); const ctl = def.abilities.find(a => a.kind === 'static' && a.effect.kind === 'aura' && a.effect.controlEnchanted); if (host && ctl) this.changeControl(host, item.controller); }
    }
    if (def.kicker && item.kicked) (card as GameObject & { kicked?: boolean }).kicked = true;
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
    const s = this.state; const p = item.controller; const opp = primaryOpponent(s, p); const opps = opponentsOf(s, p); const everyone = alive(s); const src = item.source;
    this.curSource = src;
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
          if (target.kind === 'spell' && target.source.def.abilities.some(a => a.kind === 'static' && a.effect.kind === 'cant-be-countered')) { this.note(`${target.name} can't be countered.`); continue; }
          if (e.unlessPay != null) {
            const pl = s.players[target.controller];
            const pay = this.findPayment(pl, { generic: e.unlessPay, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '' });
            if (pay && await this.ask(target.controller, { kind: 'yes-no', prompt: `Pay {${e.unlessPay}} to keep ${target.name} from being countered?`, tag: 'unless-pay' })) { this.payMana(pl, pay); this.emit({ type: 'countered', itemId: target.id, name: target.name, by: item.name, unlessPaid: true }, `${this.pname(target.controller)} pays {${e.unlessPay}}.`); continue; }
          }
          target.countered = true; s.stack.splice(s.stack.indexOf(target), 1); this.emit({ type: 'countered', itemId: target.id, name: target.name, by: item.name }); await this.finishSpell(target);
          if (e.toExile && target.kind === 'spell' && target.source.zone === 'graveyard') { this.moveTo(target.source, 'exile', 'top', 'exile'); this.emit({ type: 'replaced', what: 'exile-instead', id: target.source.id, name: target.name }, `${target.name} is exiled instead.`); }
        }
        break;
      }
      case 'draw': { const n = amt(e.amount); const who = e.who === 'you' || e.who === 'controller' ? [p] : e.who === 'opponent' ? [opp] : e.who === 'each-player' ? everyone : this.players(T); for (const w of who) for (let i = 0; i < n; i++) await this.draw(w); break; }
      case 'loot': {
        const pl = s.players[p];
        if (e.discardFirst) {
          if (!pl.hand.length) break;
          if (e.optional && !(await this.ask(p, { kind: 'yes-no', prompt: `${item.name}: discard a card to draw a card?`, tag: 'optional' }))) break;
          const ids = await this.ask(p, { kind: 'choose-cards', from: pl.hand.map(c => c.id), count: Math.min(e.discard, pl.hand.length), reason: 'Discard', exact: true }) as number[];
          for (const id of ids) this.discard(p, id);
          for (let i = 0; i < e.draw; i++) await this.draw(p);
          break;
        }
        for (let i = 0; i < e.draw; i++) await this.draw(p);
        const ids = await this.ask(p, { kind: 'choose-cards', from: pl.hand.map(c => c.id), count: Math.min(e.discard, pl.hand.length), reason: 'Discard', exact: true }) as number[]; for (const id of ids) this.discard(p, id); break;
      }
      case 'dig': {
        const pl = s.players[p]; const n = amt(e.look); const top = pl.library.slice(0, n); if (!top.length) break;
        if (e.reveal) { for (const c of top) this.reveal(c.id); this.emit({ type: 'library', player: p, action: 'reveal', cards: top.map(c => c.def.name) }); }
        const take = e.altTake && conditionHolds(s, src, e.altTake.condition) ? e.altTake.take : e.take;
        const eligible = e.filter ? top.filter(c => matchesFilter(s, c, e.filter, src)) : top;
        let taken: GameObject[] = [];
        if (take > 0 && eligible.length) {
          const want = Math.min(take, eligible.length);
          const ids = await this.ask(p, { kind: 'choose-cards', from: eligible.map(c => c.id), count: want, reason: `${item.name}: keep ${want} in hand`, exact: !e.optional }) as number[];
          taken = ids.slice(0, want).map(id => top.find(c => c.id === id)!).filter(Boolean);
        }
        pl.library.splice(0, top.length);
        for (const c of taken) { this.forgetTop(c.id); c.zone = 'hand'; pl.hand.push(c); if (e.reveal) s.knowledge.knownInHand.push(c.id); this.emit({ type: 'zone-change', id: c.id, name: c.def.name, owner: c.owner, controller: c.controller, from: 'library', to: 'hand', reason: 'dig', token: false, public: !!e.reveal }, ''); }
        let rest = top.filter(c => !taken.includes(c));
        if (rest.length) {
          if (e.rest === 'graveyard') { for (const c of rest) { this.forgetTop(c.id); c.zone = 'graveyard'; pl.graveyard.push(c); this.emit({ type: 'zone-change', id: c.id, name: c.def.name, owner: c.owner, controller: c.controller, from: 'library', to: 'graveyard', reason: 'dig', token: false, public: true }, ''); } }
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
        this.emit({ type: 'library', player: p, action: 'dig', count: n, found: taken.map(c => c.def.name) });
        break;
      }
      case 'put-from-hand': {
        const who = e.who === 'each-player' ? everyone : [p];
        for (const w of who) {
          const pl = s.players[w]; const opts = pl.hand.filter(c => !e.filter || matchesFilter(s, c, e.filter, src)); const n = Math.min(amt(e.amount), opts.length); if (!n) continue;
          const reason = e.to === 'battlefield' ? `${item.name}: put onto the battlefield` : e.to === 'library-top' ? `${item.name}: put back on top (first = top)` : `${item.name}: put on the bottom`;
          const ids = await this.ask(w, { kind: 'choose-cards', from: opts.map(c => c.id), count: n, reason, exact: !e.optional }) as number[];
          const cards = ids.slice(0, n).map(id => opts.find(c => c.id === id)!).filter(Boolean);
          if (e.to === 'battlefield') { for (const c of cards) { await this.enterBattlefield(c, { controller: w, via: 'effect', tapped: e.tapped }); this.note(`${this.pname(w)} puts ${c.def.name} onto the battlefield${e.tapped ? ' tapped' : ''}.`); } }
          else if (e.to === 'library-top') { for (const c of [...cards].reverse()) this.moveTo(c, 'library', 'top', 'tuck'); this.note(`${this.pname(w)} puts ${cards.length} card(s) on top of their library.`); }
          else { for (const c of cards) this.moveTo(c, 'library', 'bottom', 'tuck'); this.note(`${this.pname(w)} puts ${cards.length} card(s) on the bottom of their library.`); }
        }
        break;
      }
      case 'shuffle': { const w: PlayerId = e.who === 'target-player' ? (this.players(T)[0] ?? p) : e.who === 'that-player' ? (this.players(T)[0] ?? item.affected?.[0]?.lastKnown.controller ?? p) : p; if (!e.optional || await this.ask(w, { kind: 'yes-no', prompt: 'Shuffle your library?', tag: 'optional' })) { this.shuffle(w); this.emit({ type: 'library', player: w, action: 'shuffle' }); } break; }
      case 'reveal-hand': { const w = this.players(T)[0] ?? opp; const pl = s.players[w]; for (const c of pl.hand) if (!s.knowledge.knownInHand.includes(c.id)) s.knowledge.knownInHand.push(c.id); this.note(`${this.pname(w)} reveals their hand: ${pl.hand.map(c => c.def.name).join(', ') || 'nothing'}.`); break; }
      case 'become-monarch': this.setMonarch(p); break;
      case 'optional-then': {
        if (!(await this.ask(p, { kind: 'yes-no', prompt: `${item.name}: ${e.first.map(f => f.op).join(', ')}?`, tag: 'optional' }))) break;
        for (let i = 0; i < e.first.length; i++) await this.applyEffect(item, e.first[i], idx, all);
        for (let i = 0; i < e.then.length; i++) await this.applyEffect(item, e.then[i], idx, all);
        break;
      }
      case 'impulse': {
        const pl = s.players[p];
        for (let i = 0; i < e.count; i++) {
          const c = pl.library[0]; if (!c) break;
          this.moveTo(c, 'exile', 'top', 'exile'); this.reveal(c.id);
          c.castableFromExile = { afterTurn: s.turn - 1, free: false, untilTurn: e.until === 'eot' ? s.turn : s.turn + s.players.length, by: p };
          this.note(`${this.pname(p)} exiles ${c.def.name} and may play it ${e.until === 'eot' ? 'this turn' : 'until the end of their next turn'}.`);
        }
        break;
      }
      case 'optional-pay': {
        const pl = s.players[p]; const pay = this.findPayment(pl, e.mana);
        if (pay && await this.ask(p, { kind: 'yes-no', prompt: `${item.name}: pay ${e.mana.raw}?`, tag: 'unless-pay' })) { this.payMana(pl, pay); this.note(`${this.pname(p)} pays ${e.mana.raw} for ${item.name}.`); for (let i = 0; i < e.then.length; i++) await this.applyEffect(item, e.then[i], idx, all); }
        break;
      }
      case 'return-self-to-battlefield': {
        if (src.zone !== 'graveyard') break;
        await this.enterBattlefield(src, { controller: src.owner, via: 'effect' });
        if (e.counters) this.addCounters(src, e.counters.counter, e.counters.amount);
        this.note(`${name(src)} returns to the battlefield${e.counters ? ` with a ${e.counters.counter} counter` : ''}.`);
        break;
      }
      case 'evolve': {
        const t = item.triggeringId != null ? findObject(s, item.triggeringId) : undefined;
        if (t && src.zone === 'battlefield' && t.zone === 'battlefield' && (power(s, t) > power(s, src) || toughness(s, t) > toughness(s, src))) { this.addCounters(src, '+1/+1', 1); this.note(`${name(src)} evolves.`); }
        break;
      }
      case 'move-counters': { const n = src.lastKnown?.counters?.[e.counter] ?? src.counters[e.counter] ?? 0; const t = this.objs(T)[0]; if (t && n > 0 && t.zone === 'battlefield') { this.addCounters(t, e.counter, n); this.note(`${n} ${e.counter} counter${n > 1 ? 's' : ''} moved to ${name(t)}.`); } break; }
      case 'renown': { if (src.zone === 'battlefield' && !src.renowned) { src.renowned = true; this.addCounters(src, '+1/+1', e.amount); this.note(`${name(src)} becomes renowned.`); } break; }
      case 'sacrifice-unless-pay': if (e.perCounter) {
        const upl = s.players[p];
        const age = src.counters[e.perCounter] ?? 0;
        const scaled: ManaCost = { ...e.mana, generic: e.mana.generic * age, pips: Array.from({ length: age }, () => e.mana.pips).flat(), raw: `${e.mana.raw} x${age}` };
        const pay = age > 0 ? this.findPayment(upl, scaled) : null;
        if (age > 0 && pay && await this.ask(p, { kind: 'yes-no', prompt: `${item.name}: pay ${scaled.raw}?`, tag: 'unless-pay' })) { this.payMana(upl, pay); this.note(`${this.pname(p)} pays cumulative upkeep (${age}).`); }
        else { this.note(`${this.pname(p)} does not pay cumulative upkeep.`); this.sacrifice(src); }
        break;
      } else {
        if (src.zone !== 'battlefield') break;
        if (e.once === 'echo') { if (src.echoPaid) break; src.echoPaid = true; }
        const pl = s.players[p]; const pay = this.findPayment(pl, e.mana);
        if (pay && await this.ask(p, { kind: 'yes-no', prompt: `Pay ${e.mana.raw} to keep ${name(src)}?`, tag: 'unless-pay' })) { this.payMana(pl, pay); this.note(`${this.pname(p)} pays ${e.mana.raw} for ${name(src)}.`); }
        else this.sacrifice(src);
        break;
      }
      case 'unearth': {
        if (src.zone !== 'graveyard') break;
        await this.enterBattlefield(src, { controller: p, via: 'effect' });
        src.eotKeywords.push('haste'); src.exileIfLeaves = true;
        (s.delayed ??= []).push({ id: ++this.stackCounter, at: 'next-end-step', controller: p, sourceId: src.id, sourceName: name(src), effects: [{ op: 'exile', target: { kind: 'creature', self: true } }], createdTurn: s.turn });
        this.note(`${name(src)} returns to the battlefield (unearth): it has haste and will be exiled at the next end step.`);
        break;
      }
      case 'cascade': {
        const pl = s.players[p]; const exiled: GameObject[] = []; let hit: GameObject | undefined;
        while (pl.library.length) { const c = pl.library[0]; this.moveTo(c, 'exile', 'top', 'exile'); exiled.push(c); if (!isLand(c) && c.def.manaValue < src.def.manaValue) { hit = c; break; } }
        if (hit) {
          const spellAb = hit.def.abilities.find(ab => ab.kind === 'spell'); const effects = spellAb ? spellAb.effects : [];
          const cast = this.makeStackItem('spell', hit, p, effects, hit.def.name, 0, undefined, spellAb?.text ?? hit.def.oracleText);
          cast.castFrom = 'exile';
          for (const { index, spec } of targetingEffects(this.effectiveEffects(cast))) cast.targetsByEffect.set(index, this.autoPickTargets(cast, spec, targetOptionsFor(this, p, spec, hit)));
          pl.exile.splice(pl.exile.indexOf(hit), 1); hit.zone = 'stack'; s.stack.push(cast);
          hit.castWith = { from: 'exile', x: 0 };
          this.emit({ type: 'cast', itemId: cast.id, id: hit.id, name: hit.def.name, player: p, targets: this.targetNames(cast), how: ['cascade, free'] });
          this.queueTriggers('cast', { obj: hit, player: p });
        }
        const rest = exiled.filter(c => c !== hit); this.rng.shuffle(rest);
        for (const c of rest) this.moveTo(c, 'library', 'bottom', 'tuck');
        this.note(`Cascade: ${this.pname(p)} exiles ${exiled.length} card${exiled.length === 1 ? '' : 's'}${hit ? ` and casts ${hit.def.name}` : ''}; the rest go to the bottom.`);
        break;
      }
      case 'energy': { const n = amt(e.amount); if (n > 0) { s.players[p].energy = (s.players[p].energy ?? 0) + n; this.note(`${this.pname(p)} gets ${n} energy (${s.players[p].energy}).`); } break; }
      case 'poison': { const who = e.who === 'each-opponent' ? opps : this.players(T); const n = amt(e.amount); for (const w of who) this.addPoison(w, n, item.name); break; }
      case 'shuffle-self-into-library': { if (src.zone === 'stack' || src.zone === 'battlefield' || src.zone === 'graveyard') { this.moveTo(src, 'library', 'top', 'tuck'); this.shuffle(src.owner); this.note(`${name(src)} is shuffled into its owner's library.`); } break; }
      case 'reveal-hand-discard': {
        const w = this.players(T)[0] ?? opp; const pl = s.players[w];
        for (const c of pl.hand) if (!s.knowledge.knownInHand.includes(c.id)) s.knowledge.knownInHand.push(c.id);
        this.note(`${this.pname(w)} reveals their hand: ${pl.hand.map(c => c.def.name).join(', ') || 'nothing'}.`);
        const eligible = pl.hand.filter(c => matchesFilter(s, c, e.filter, src)); if (!eligible.length) break;
        const [id] = await this.ask(p, { kind: 'choose-cards', from: eligible.map(c => c.id), count: 1, reason: `${item.name}: choose a card from their hand to discard`, exact: true }) as number[];
        const chosen = eligible.find(c => c.id === id) ?? eligible[0];
        if (e.count === 'all-named') { for (const c of [...pl.hand]) if (c.def.name === chosen.def.name) this.discard(w, c.id); } else this.discard(w, chosen.id);
        break;
      }
      case 'look-top': { const w = e.who === 'you' ? p : (this.players(T)[0] ?? opp); const c = s.players[w].library[0]; this.emit({ type: 'library', player: w, action: 'look', cards: c ? [c.def.name] : [] }, `${this.pname(p)} looks at the top card of ${this.pname(w)}'s library${c ? ` (${c.def.name})` : ''}.`); break; }
      case 'search': {
        const who = e.who === 'that-controller' ? (item.affected?.[0]?.lastKnown.controller ?? p) : p; const pl = s.players[who];
        if (e.optional && who !== p && !(await this.ask(who, { kind: 'yes-no', prompt: `${item.name}: search your library?`, tag: 'optional' }))) break;
        const f = { ...e.filter, ...(e.mvLE != null ? { mvLE: typeof e.mvLE === 'number' ? e.mvLE : evalAmount(s, e.mvLE, p, item.x, src, actx) } : {}) };
        const opts = pl.library.filter(c => matchesFilter(s, c, f, src));
        if (!opts.length) { this.shuffle(who); this.emit({ type: 'library', player: who, action: 'search', found: [] }); break; }
        const ids = await this.ask(who, { kind: 'choose-cards', from: opts.map(o => o.id), count: Math.min(e.count, opts.length), reason: `Search for ${describeFilter(e.filter)}`, exact: !e.optional }) as number[];
        const found = ids.slice(0, e.count).map(id => opts.find(o => o.id === id)).filter((c): c is GameObject => !!c);
        for (let k = 0; k < found.length; k++) {
          const c = found[k];
          const dest = e.split === 'one-battlefield-rest-hand' ? (k === 0 ? 'battlefield' : 'hand') : e.to;
          if (dest === 'battlefield') { await this.enterBattlefield(c, { controller: who, via: 'effect', tapped: e.tapped }); this.note(`${this.pname(who)} puts ${c.def.name} onto the battlefield${c.tapped ? ' tapped' : ''}.`); }
          else if (dest === 'top') { const lib = pl.library; lib.splice(lib.indexOf(c), 1); this.shuffle(who); lib.unshift(c); this.emit({ type: 'library', player: who, action: 'search', found: [c.def.name] }); this.note(`${this.pname(who)} puts ${c.def.name} on top of their library.`); }
          else if (dest === 'graveyard') { this.moveTo(c, 'graveyard', 'top', 'search'); this.note(`${this.pname(who)} puts ${c.def.name} into their graveyard.`); }
          else { this.moveTo(c, 'hand', 'top', 'search'); this.emit({ type: 'library', player: who, action: 'search', found: [c.def.name] }); }
        }
        this.noteAffected(item, found);
        if (e.to !== 'top') this.shuffle(who);
        break;
      }
      case 'delayed-trigger': { (s.delayed ??= []).push({ id: ++this.stackCounter, at: e.at, controller: p, sourceId: src.id, sourceName: name(src), effects: e.effects, affected: e.bind === 'that' ? item.affected : undefined, createdTurn: s.turn }); break; }
      case 'return-to-battlefield': {
        for (const a of item.affected ?? []) {
          const o = findObject(s, a.id); if (!o || o.zone !== 'exile') continue; const ctl = e.underControlOf === 'you' ? p : o.owner;
          await this.enterBattlefield(o, { controller: ctl, via: 'effect' }); this.note(`${name(o)} returns to the battlefield under ${this.pname(ctl)}'s control.`);
          if (e.counterIfYours && ctl === p) { const tgt = e.counterIfYours === 'self' ? src : o; if (tgt.zone === 'battlefield') this.addCounters(tgt, '+1/+1', 1); }
        }
        break;
      }
      case 'exile-from-hand': {
        const pl = s.players[p]; const opts = pl.hand.filter(c => matchesFilter(s, c, e.filter, src)); if (!opts.length) break;
        const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(c => c.id), count: 1, reason: `${item.name}: exile a card from your hand`, exact: false }) as number[];
        const c = ids.length ? opts.find(o => o.id === ids[0]) : undefined; if (!c) break;
        this.moveTo(c, 'exile', 'top', 'exile'); this.reveal(c.id); if (e.imprint) src.exiledWith = [...(src.exiledWith ?? []), c.id];
        this.note(`${this.pname(p)} exiles ${c.def.name} from hand${e.imprint ? ` (imprinted on ${name(src)})` : ''}.`);
        break;
      }
      case 'exile-graveyard': {
        const who = e.who === 'each-opponent' ? opps : e.who === 'each-player' ? everyone : this.players(T);
        for (const w of who) { const gy = [...s.players[w].graveyard]; for (const o of gy) this.moveTo(o, 'exile', 'top', 'exile'); this.note(`${this.pname(w)}'s graveyard (${gy.length} cards) is exiled.`); }
        break;
      }
      case 'attach-to-that': { const a = item.affected?.[0]; const o = a ? findObject(s, a.id) : undefined; if (o && o.zone === 'battlefield' && src.zone === 'battlefield' && isCreature(o)) { this.attach(src, o); this.note(`${name(src)} is attached to ${name(o)}.`); } break; }
      case 'counter-triggering': {
        const target = item.triggeringId != null ? s.stack.find(i => i.source.id === item.triggeringId && i.kind === 'spell') : undefined; if (!target) break;
        if (target.source.def.abilities.some(a => a.kind === 'static' && a.effect.kind === 'cant-be-countered')) { this.note(`${target.name} can't be countered.`); break; }
        target.countered = true; s.stack.splice(s.stack.indexOf(target), 1); this.emit({ type: 'countered', itemId: target.id, name: target.name, by: item.name }); await this.finishSpell(target);
        break;
      }
      case 'amass': {
        const pl = s.players[p]; let army = pl.battlefield.find(o => isCreature(o) && subtypes(o).includes('Army'));
        if (!army) { army = makeObject(s.nextId++, src.def, p, 'battlefield', s.turn); army.token = { name: 'Army', power: 0, toughness: 0, colors: ['B'], types: ['Creature'], subtypes: ['Army'], keywords: [] }; await this.enterBattlefield(army, { controller: p, via: 'token' }); this.emit({ type: 'create-token', id: army.id, name: 'Army', controller: p, power: 0, toughness: 0 }, `${this.pname(p)} creates a 0/0 Army token.`); }
        const n = amt(e.amount); this.addCounters(army, '+1/+1', n); if (army.token && !army.token.subtypes.includes(e.subtype)) army.token.subtypes.push(e.subtype);
        this.note(`${this.pname(p)} amasses ${n}.`);
        break;
      }
      case 'gain-ability': { if (src.zone === 'battlefield') { this.bfGen++; (src.grantedAbilities ??= []).push(e.ability); this.note(`${name(src)} gains "${e.ability.text}".`); } break; }
      case 'crew-self': if (src.zone === 'battlefield') { src.eotFlags.crewed = true; this.note(`${name(src)} becomes an artifact creature until end of turn.`); } break;
      case 'saddle-self': if (src.zone === 'battlefield') { src.eotFlags.saddled = true; this.note(`${name(src)} is saddled until end of turn.`); } break;
      case 'damage-you': this.dealDamageToPlayer(src, p, amt(e.amount)); break;
      case 'discard': {
        const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? opps : e.who === 'each-player' ? everyone : this.players(T);
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
        const who = e.who === 'you' ? [p] : e.who === 'each-player' ? everyone : this.players(T); for (const w of who) this.gainLife(w, amt(e.amount)); break;
      }
      case 'lose-life': {
        if (e.who === 'that-controller') { for (const a of item.affected ?? []) this.loseLife(a.lastKnown.controller, evalAmount(s, e.amount, p, item.x, src, { that: a.lastKnown }), item.name); break; }
        const who = e.who === 'you' ? [p] : e.who === 'opponent' ? [opp] : e.who === 'each-opponent' ? opps : e.who === 'each-player' ? everyone : e.who === 'defending-player' ? [src.attacking ?? opp] : this.players(T); for (const w of who) this.loseLife(w, amt(e.amount), item.name); break;
      }
      case 'set-life': { const who = e.who === 'you' ? [p] : everyone; for (const w of who) { const delta = e.amount - s.players[w].life; s.players[w].life = e.amount; this.emit({ type: 'life', player: w, delta, total: e.amount, reason: item.name }, `${this.pname(w)}'s life becomes ${e.amount}.`); } break; }
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
        for (const r of T) if (r.kind === 'stack') { const it = s.stack.find(i => i.id === r.id); if (it && it.kind === 'spell') { s.stack.splice(s.stack.indexOf(it), 1); it.countered = true; list.push(it.source); this.note(`${it.name} is returned to its owner's hand.`); } }
        this.noteAffected(item, list);
        for (const o of list) { if (o.token) { this.moveTo(o, 'exile', 'top', 'bounce'); continue; } if (e.to === 'hand') this.moveTo(o, 'hand', 'top', 'bounce'); else { this.moveTo(o, 'library', e.to === 'library-top' ? 'top' : 'bottom', 'bounce'); } }
        break;
      }
      case 'token': {
        let n = amt(e.count); const made: GameObject[] = [];
        for (const src2 of s.players[p].battlefield) for (const ab of abilitiesOf(src2)) if (ab.kind === 'static' && ab.effect.kind === 'tokens-replacement') n *= 2;
        for (let i = 0; i < n; i++) {
          const tok = makeObject(s.nextId++, src.def, p, 'battlefield', s.turn);
          tok.controller = p; tok.owner = p;
          tok.token = { name: e.name ?? (e.treasure ? 'Treasure' : `${e.subtypes.join(' ')} token`), power: e.power, toughness: e.toughness, colors: e.colors, types: e.types, subtypes: e.subtypes, keywords: e.keywords, treasure: e.treasure, clue: e.clue, spawn: e.spawn, food: e.food, dynamicPT: e.dynamicPT };
          await this.enterBattlefield(tok, { controller: p, via: 'token', tapped: e.tapped });
          if (e.attacking && s.step === 'declare-attackers') { this.setTapped(tok, true, 'attack'); tok.attacking = opp; s.attackers.push(tok.id); }
          made.push(tok);
        }
        this.noteAffected(item, made);
        if (made.length) this.emit({ type: 'create-token', id: made[0].id, name: e.name ?? e.subtypes.join(' '), controller: p, power: e.power, toughness: e.toughness, count: n });
        break;
      }
      case 'counters': {
        if (e.optional && !(await this.ask(p, { kind: 'yes-no', prompt: `${item.name}: put the counter(s)?`, tag: 'optional' }))) break;
        const list = e.target === 'self' ? [src] : e.target === 'creatures-you-control' ? s.players[p].battlefield.filter(isCreature) : e.target === 'each-other-creature-you-control' ? s.players[p].battlefield.filter(o => isCreature(o) && o !== src) : this.objs(T);
        for (const o of list) { if (o.zone !== 'battlefield') continue; this.addCounters(o, e.counter, amt(e.amount)); }
        break;
      }
      case 'tap': { const list = e.target === 'self' ? (src.zone === 'battlefield' ? [src] : []) : typeof e.target === 'string' ? this.groupTargets(e.target, p).objects : this.objs(T); this.noteAffected(item, list); for (const o of list) { this.setTapped(o, true, 'effect'); if (e.noUntap) o.noUntapNext = true; } break; }
      case 'no-untap-that': { for (const a of item.affected ?? []) { const o = findObject(s, a.id); if (o && o.zone === 'battlefield') o.noUntapNext = true; } break; }
      case 'no-untap-self': { if (src.zone === 'battlefield') src.noUntapNext = true; break; }
      case 'cant-block': { for (const o of this.objs(T)) o.eotFlags.cantBlock = true; break; }
      case 'return-own': {
        const opts = s.players[p].battlefield.filter(o => matchesFilter(s, o, e.filter, src)); if (!opts.length) break;
        const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: Math.min(e.count, opts.length), reason: `${item.name}: return to hand`, exact: true }) as number[];
        for (const id of ids.slice(0, e.count)) { const o = findObject(s, id); if (o) { this.moveTo(o, 'hand', 'top', 'bounce'); this.note(`${this.pname(p)} returns ${name(o)} to hand.`); } }
        break;
      }
      case 'explore': {
        const pl = s.players[p]; const c = pl.library[0]; if (!c) break;
        this.reveal(c.id); this.emit({ type: 'library', player: p, action: 'reveal', cards: [c.def.name] });
        if (isLand(c)) { this.moveTo(c, 'hand', 'top', 'search'); this.note(`${name(src)} explores: ${c.def.name} goes to hand.`); }
        else {
          if (src.zone === 'battlefield') this.addCounters(src, '+1/+1', 1);
          const toGy = await this.ask(p, { kind: 'yes-no', prompt: `Explore: put ${c.def.name} into your graveyard?`, tag: 'optional' });
          if (toGy) { this.moveTo(c, 'graveyard', 'top', 'mill'); this.note(`${name(src)} explores: ${c.def.name} goes to the graveyard.`); } else this.note(`${name(src)} explores: ${c.def.name} stays on top.`);
        }
        break;
      }
      case 'untap': { const list = e.target === 'self' ? [src] : e.target === 'all-you-control' ? s.players[p].battlefield : e.target === 'lands-you-control' ? s.players[p].battlefield.filter(isLand) : e.target === 'that' ? (item.affected ?? []).map(a => findObject(s, a.id)).filter((o): o is GameObject => !!o) : e.target === 'enchanted' ? this.groupTargets('enchanted', p).objects : this.objs(T); for (const o of list) this.setTapped(o, false, 'effect'); break; }
      case 'sacrifice': {
        const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? opps : e.who === 'each-player' ? everyone : this.players(T);
        for (const w of who) {
          const opts = s.players[w].battlefield.filter(o => matchesFilter(s, o, e.what, src));
          const n = Math.min(e.amount, opts.length); if (!n) continue;
          const ids = await this.ask(w, { kind: 'choose-cards', from: opts.map(o => o.id), count: n, reason: `Sacrifice ${n}`, exact: true }) as number[];
          for (const id of ids) { const o = findObject(s, id); if (o) this.sacrifice(o); }
        }
        break;
      }
      case 'sacrifice-self': if (src.zone === 'battlefield') this.sacrifice(src); break;
      case 'mill': { const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? opps : this.players(T); for (const w of who) this.mill(w, amt(e.amount)); break; }
      case 'scry': { const pl = s.players[p]; const top = pl.library.slice(0, e.amount); if (!top.length) break; const keep = await this.ask(p, { kind: 'choose-cards', from: top.map(c => c.id), count: top.length, reason: `Scry ${e.amount}: choose cards to keep on top`, exact: false }) as number[]; const bottom = top.filter(c => !keep.includes(c.id)); const kept = top.filter(c => keep.includes(c.id)); pl.library.splice(0, top.length); pl.library.unshift(...kept); pl.library.push(...bottom); this.noteTop(p, kept.map(c => c.id), top.length); for (const c of bottom) this.forgetTop(c.id); this.emit({ type: 'library', player: p, action: 'scry', count: top.length }, ''); break; }
      case 'surveil': { const pl = s.players[p]; const top = pl.library.slice(0, e.amount); if (!top.length) break; const keep = await this.ask(p, { kind: 'choose-cards', from: top.map(c => c.id), count: top.length, reason: `Surveil ${e.amount}: choose cards to keep on top`, exact: false }) as number[]; const gy = top.filter(c => !keep.includes(c.id)); const kept = top.filter(c => keep.includes(c.id)); pl.library.splice(0, top.length); pl.library.unshift(...kept); this.noteTop(p, kept.map(c => c.id), top.length); for (const c of gy) { this.forgetTop(c.id); c.zone = 'graveyard'; pl.graveyard.push(c); this.emit({ type: 'zone-change', id: c.id, name: c.def.name, owner: c.owner, controller: c.controller, from: 'library', to: 'graveyard', reason: 'mill', token: false, public: true }, ''); } this.emit({ type: 'library', player: p, action: 'surveil', count: top.length }, ''); break; }
      case 'search-land': {
        const pl = s.players[p];
        const opts = pl.library.filter(c => isLand(c) && (!e.basic || c.def.supertypes.includes('Basic')) && (!e.subtypes || e.subtypes.some(st => c.def.subtypes.includes(st))));
        if (!opts.length) { this.shuffle(p); break; }
        const ids = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: Math.min(e.count, opts.length), reason: 'Search for land', exact: false }) as number[];
        for (const id of ids) { const c = findObject(s, id)!; if (e.toBattlefield) { await this.enterBattlefield(c, { controller: p, via: 'effect', tapped: e.tapped }); this.note(`${this.pname(p)} puts ${c.def.name} onto the battlefield${c.tapped ? ' tapped' : ''}.`); } else this.moveTo(c, 'hand', 'top', 'search'); }
        this.shuffle(p);
        break;
      }
      case 'add-mana': { if (Array.isArray(e.mana)) this.addMana(p, e.mana, item.name, e.sticky); else { const c = (await this.ask(p, { kind: 'choose-color', reason: item.name })) as ManaSymbol; this.addMana(p, Array(e.amount ?? 1).fill(c) as ManaSymbol[], item.name); } break; }
      case 'return-from-graveyard': {
        const pool = e.anyGraveyard ? s.players.flatMap(q => q.graveyard) : s.players[p].graveyard;
        const opts = pool.filter(o => matchesFilter(s, o, e.what, src));
        if (!opts.length) break;
        const [id] = await this.ask(p, { kind: 'choose-cards', from: opts.map(o => o.id), count: 1, reason: 'Return from graveyard', exact: false }) as number[];
        const o = opts.find(x => x.id === id);
        if (o) { this.noteAffected(item, [o]); if (e.to === 'battlefield') { await this.enterBattlefield(o, { controller: p, via: 'effect', tapped: e.tapped }); this.note(`${name(o)} returns to the battlefield.`); } else this.moveTo(o, 'hand', 'top', 'return'); }
        break;
      }
      case 'fight': { const [a] = e.self ? [src] : this.objs(T.slice(0, 1)); const b = this.objs(T)[e.self ? 0 : 1]; if (a && b && a.zone === 'battlefield' && b.zone === 'battlefield') { const pa = power(s, a), pb = power(s, b); this.dealDamage(a, b, pa); this.dealDamage(b, a, pb); } break; }
      case 'bite': { const b = this.objs(T)[0]; const a = src.zone === 'battlefield' ? src : this.objs(T)[1]; if (a && b) this.dealDamage(a, b, power(s, a)); break; }
      case 'gain-control': { for (const o of this.objs(T)) { if (e.duration === 'eot') { (o as GameObject & { controlUntilEot?: PlayerId }).controlUntilEot = o.controller; } this.changeControl(o, p); if (e.untapHaste) { this.setTapped(o, false, 'effect'); o.eotKeywords.push('haste'); } } break; }
      case 'regenerate': { const list = e.target === 'self' ? [src] : this.objs(T); for (const o of list) o.eotFlags.regenerationShield = (o.eotFlags.regenerationShield ?? 0) + 1; break; }
      case 'prevent-damage': { const list = e.target === 'you' ? [] : e.target === 'self' ? [src] : this.objs(T); for (const o of list) o.eotFlags.preventDamage = e.amount === 'all' ? 'all' : amt(e.amount); if (e.target === 'you') (s as GameState & { fog?: number }).fog = s.turn; break; }
      case 'cant-attack-or-block': for (const o of this.objs(T)) o.eotFlags.cantAttackOrBlock = true; break;
      case 'extra-turn': s.extraTurns.push(p); this.emit({ type: 'extra-turn', player: p }); break;
      case 'transform-self': {
        if (!src.def.backFace || src.zone !== 'battlefield') break;
        src.activeFace = src.activeFace === 1 ? 0 : 1; src.transformed = src.activeFace === 1; this.bfGen++;
        if (e.viaExile) { src.enteredTurn = s.turn; src.tapped = false; src.damage = 0; src.counters = {}; }
        const d = defOf(src);
        this.emit({ type: 'transform', id: src.id, name: src.def.name, into: d.name, face: src.activeFace });
        if (d.types.includes('Planeswalker') && d.loyalty != null) this.setCounters(src, 'loyalty', d.loyalty);
        if (e.viaExile) this.queueTriggers('etb', { obj: src, player: p });
        break;
      }
      case 'copy-spell': {
        const t = T[0]; const orig = typeof t === 'number' ? s.stack.find(x => x.id === t) : undefined;
        if (!orig || orig.kind !== 'spell') break;
        const copy: StackItem = { ...orig, id: ++this.stackCounter, controller: p, targetsByEffect: new Map(orig.targetsByEffect), targets: [...orig.targets], isCopy: true } as StackItem;
        s.stack.push(copy);
        this.note(`${this.pname(p)} copies ${orig.name}.`);
        break;
      }
      case 'earthbend': {
        const o = this.objs(T)[0]; if (!o || o.zone !== 'battlefield') break;
        o.animated = { power: 0, toughness: 0, colors: [], types: ['Creature'], subtypes: ['Elemental'], keywords: ['haste'] }; o.earthbent = true;
        this.addCounters(o, '+1/+1', amt(e.amount));
        this.noteAffected(item, [o]);
        this.note(`${name(o)} is earthbent: a 0/0 Elemental creature with haste that's still a land.`);
        break;
      }
      case 'animate': {
        const o = e.target === 'self' ? src : this.objs(T)[0]; if (!o || o.zone !== 'battlefield') break;
        o.animated = { power: e.power, toughness: e.toughness, colors: e.colors, types: e.types, subtypes: e.subtypes, keywords: e.keywords, ...(e.duration === 'eot' ? { untilTurn: s.turn } : {}) };
        this.noteAffected(item, [o]);
        this.note(`${name(o)} becomes a ${e.power}/${e.toughness} ${[...e.subtypes, ...e.types].join(' ')}${e.duration === 'eot' ? ' until end of turn' : ''}.`);
        break;
      }
      case 'double-power': { const o = this.objs(T)[0]; if (!o || o.zone !== 'battlefield') break; const pw = power(s, o); o.eotPower += pw; this.note(`${name(o)}'s power is doubled to ${power(s, o)} until end of turn.`); break; }
      case 'shuffle-into-library': { for (const o of this.objs(T)) { if (o.zone !== 'battlefield') continue; const owner = o.owner; this.moveTo(o, 'library', 'top', 'effect'); this.shuffle(owner); this.note(`${name(o)} is shuffled into its owner's library.`); } break; }
      case 'untap-choose': {
        const cands = s.players[p].battlefield.filter(o => o.tapped && matchesFilter(s, o, e.filter, src)); if (!cands.length) break;
        const ids = await this.ask(p, { kind: 'choose-cards', from: cands.map(o => o.id), count: Math.min(e.count, cands.length), reason: `${item.name}: untap up to ${e.count}`, exact: false }) as number[];
        for (const id of ids.slice(0, e.count)) { const o = cands.find(c => c.id === id); if (o) this.setTapped(o, false, 'effect'); }
        break;
      }
      case 'multi-counters': { for (const o of this.objs(T)) { if (o.zone !== 'battlefield') continue; for (const c of e.counters) this.addCounters(o, c, 1); this.note(`${name(o)} gets ${e.counters.map(c => `a ${c} counter`).join(', ')}.`); } break; }
      case 'token-copy': {
        const thatIds = (item.affected ?? []).map(a => a.id).concat(item.affected?.length ? [] : (item.triggeringId !== undefined ? [item.triggeringId] : []));
        const sources = e.target === 'self' ? [src] : e.target === 'that' ? thatIds.map(id => findObject(s, id)).filter((o): o is GameObject => !!o) : this.objs(T);
        const made: GameObject[] = [];
        for (const orig of sources) {
          const d = defOf(orig);
          for (let i = 0; i < amt(e.count); i++) {
            const tok = makeObject(s.nextId++, d, p, 'battlefield', s.turn);
            tok.controller = p; tok.owner = p;
            tok.token = {
              name: d.name, power: Number(d.power ?? 0) || 0, toughness: Number(d.toughness ?? 0) || 0,
              colors: [...d.colors], types: [...new Set([...d.types, ...(e.extraTypes ?? [])])],
              subtypes: [...new Set([...d.subtypes, ...(e.extraSubtypes ?? [])])],
              keywords: [...new Set([...d.keywords, ...(e.extraKeywords ?? [])])],
            };
            tok.grantedAbilities = [...d.abilities];
            await this.enterBattlefield(tok, { controller: p, via: 'token', tapped: e.tapped || !!e.attacking });
            if (e.attacking && s.step === 'declare-attackers') {
              const others = opponentsOf(s, p).filter(q => q !== src.attacking);
              const target = e.attacking === 'each-other-opponent' ? others[i % Math.max(1, others.length)] : (src.attacking ?? others[0]);
              if (target !== undefined) { tok.attacking = target; s.attackers.push(tok.id); }
            }
            made.push(tok);
            this.note(`${this.pname(p)} creates a token copy of ${d.name}.`);
          }
        }
        this.noteAffected(item, made);
        if (made.length) this.emit({ type: 'create-token', id: made[0].id, name: name(made[0]), controller: p, power: made[0].token!.power, toughness: made[0].token!.toughness, count: made.length });
        break;
      }
      case 'storm-copies': {
        const orig = s.stack.find(i => i.kind === 'spell' && i.source.id === src.id);
        if (!orig) break;
        const n = Math.max(0, (s.players[p].spellsCastThisTurn ?? 1) - 1);
        for (let i = 0; i < n; i++) s.stack.push({ ...orig, id: ++this.stackCounter, targetsByEffect: new Map(orig.targetsByEffect), targets: [...orig.targets], isCopy: true } as StackItem);
        if (n) this.note(`Storm: ${this.pname(p)} copies ${orig.name} ${n} time${n > 1 ? 's' : ''}.`);
        break;
      }
      case 'proliferate': {
        const chosen: string[] = [];
        for (const o of allPermanents(s)) {
          const kinds = Object.keys(o.counters).filter(k => o.counters[k] > 0);
          if (!kinds.length) continue;
          const mine = o.controller === p;
          const good = kinds.filter(k => mine ? k !== '-1/-1' : k === '-1/-1');
          if (!good.length) continue;
          for (const k of good) this.addCounters(o, k, 1);
          chosen.push(name(o));
        }
        for (const q of s.players) {
          if (q.id === p) { for (const k of Object.keys(q.counters ?? {})) if ((q.counters![k] ?? 0) > 0) { q.counters![k]++; chosen.push(`${q.name}'s ${k}`); } }
          else if (q.poison > 0) { this.addPoison(q.id, 1, item.name); chosen.push(`${q.name}'s poison`); }
        }
        this.note(chosen.length ? `${this.pname(p)} proliferates: ${chosen.join(', ')}.` : `${this.pname(p)} proliferates (nothing to add).`);
        break;
      }
      case 'player-counter': {
        const who = e.who === 'you' ? [p] : e.who === 'each-opponent' ? opps : this.players(T);
        const n = amt(e.amount);
        for (const w of who) { const pl2 = s.players[w]; (pl2.counters ??= {})[e.counter] = (pl2.counters[e.counter] ?? 0) + n; this.note(`${pl2.name} gets ${n} ${e.counter} counter${n > 1 ? 's' : ''} (${pl2.counters[e.counter]}).`); }
        break;
      }
      case 'fold-new-targets': break;
      case 'remove-those': {
        for (const a of item.affected ?? []) { const o = findObject(s, a.id); if (!o || o.zone !== 'battlefield') continue; if (e.how === 'exile') this.moveTo(o, 'exile', 'top', 'exile'); else this.sacrifice(o); }
        break;
      }
      case 'each-self-damage': { for (const o of allPermanents(s).filter(isCreature)) { const pw = power(s, o); if (pw > 0) this.dealDamage(o, o, pw); } break; }
      case 'untap-all': { for (const o of s.players[p].battlefield) if (o.tapped && matchesFilter(s, o, e.filter, src)) this.setTapped(o, false, 'effect'); break; }
      case 'attach-self': { const o = this.objs(T)[0]; if (o && src.zone === 'battlefield') this.attach(src, o); break; }
      case 'choose-mode': break; // expanded earlier
      case 'conditional': { if (conditionHolds(s, src, e.condition)) for (let i = 0; i < e.then.length; i++) await this.applyEffect(item, e.then[i], idx, all); else if (e.else) for (let i = 0; i < e.else.length; i++) await this.applyEffect(item, e.else[i], idx, all); break; }
      case 'unknown': this.emit({ type: 'unsimulated', id: src.id, name: name(src), clause: e.text }); break;
    }
  }

  private groupTargets(g: string, p: PlayerId, filter?: import('../cards/types.js').Filter): { objects: GameObject[]; players: PlayerId[] } {
    if (g === 'you') return { objects: [], players: [p] };
    const s = this.state; const opps = opponentsOf(s, p);
    const all = allPermanents(s), mine = s.players[p].battlefield, theirs = opps.flatMap(q => s.players[q].battlefield);
    const f = (l: GameObject[]) => filter ? l.filter(o => matchesFilter(s, o, filter)) : l;
    switch (g) {
      case 'enchanted': { const host = this.curSource?.attachedTo != null ? findObject(s, this.curSource.attachedTo) : undefined; return { objects: host && host.zone === 'battlefield' ? [host] : [], players: [] }; }
      case 'each-opponent': return { objects: [], players: opps };
      case 'each-player': return { objects: [], players: alive(s) };
      case 'each-creature': case 'all-creatures': return { objects: f(all.filter(isCreature)), players: [] };
      case 'each-other-creature': return { objects: all.filter(isCreature), players: [] };
      case 'each-opponent-creature': case 'all-opponent-creatures': case 'each-creature-you-dont-control': return { objects: theirs.filter(isCreature), players: [] };
      case 'each-creature-and-player': return { objects: all.filter(isCreature), players: alive(s) };
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
  private curSource: GameObject | null = null;
  private pumpTargets(t: unknown, p: PlayerId, src: GameObject, T: TargetRef[]): GameObject[] {
    const s = this.state;
    if (t === 'self') return src.zone === 'battlefield' ? [src] : [];
    if (t === 'enchanted') return this.groupTargets('enchanted', p).objects;
    if (t === 'creatures-you-control') return s.players[p].battlefield.filter(isCreature);
    if (t === 'permanents-you-control') return [...s.players[p].battlefield];
    if (t === 'other-creatures-you-control') return s.players[p].battlefield.filter(o => isCreature(o) && o !== src);
    if (t === 'all-creatures') return allPermanents(s).filter(isCreature);
    if (t === 'attacking-creatures') return s.players[p].battlefield.filter(o => o.attacking !== null);
    if (t === 'other-attacking-creatures') return s.players[p].battlefield.filter(o => o.attacking !== null && o !== src);
    if (t === 'all-opponent-creatures') return opponentsOf(s, p).flatMap(q => s.players[q].battlefield.filter(isCreature));
    return this.objs(T);
  }

  // ------------------------------------------------------------------ primitives
  /** Draw a card; `stepDraw` marks the turn's draw-step draw (Bowmasters). Dredge may replace a non-silent draw. */
  async draw(p: PlayerId, silent = false, stepDraw = false) {
    const pl = this.state.players[p];
    if (!silent) {
      const dredger = pl.graveyard.find(c => c.def.dredge && pl.library.length >= c.def.dredge);
      if (dredger && await this.ask(p, { kind: 'yes-no', prompt: `Dredge ${dredger.def.dredge}: return ${dredger.def.name} from your graveyard instead of drawing?`, tag: 'dredge' })) {
        this.mill(p, dredger.def.dredge!);
        this.moveTo(dredger, 'hand', 'top', 'dredge'); this.emit({ type: 'replaced', what: 'dredge', id: dredger.id, name: dredger.def.name }, `${pl.name} dredges ${dredger.def.name} (mills ${dredger.def.dredge}).`);
        return;
      }
    }
    const c = pl.library.shift();
    if (!c) { this.eliminate(p, 'drew from an empty library', `${pl.name} tries to draw from an empty library and loses.`); return; }
    c.zone = 'hand'; pl.hand.push(c);
    this.forgetTop(c.id); const known = this.state.knowledge.revealed.includes(c.id); if (known) this.state.knowledge.knownInHand.push(c.id); // a publicly known top card is publicly drawn
    pl.cardsDrawnThisTurn = (pl.cardsDrawnThisTurn ?? 0) + 1;
    this.emit({ type: 'draw', player: p, id: c.id, name: c.def.name, public: known, stepDraw }, silent ? '' : undefined);
    if (!silent) this.queueTriggers('draw', { player: p, obj: c, stepDraw });
  }
  discard(p: PlayerId, id: number) { const pl = this.state.players[p]; const c = pl.hand.find(x => x.id === id); if (!c) return; this.moveTo(c, 'graveyard', 'top', 'discard'); this.queueTriggers('discard', { player: p, obj: c }); }
  gainLife(p: PlayerId, n: number) { if (n <= 0) return; const pl = this.state.players[p]; const mult = pl.battlefield.some(o => abilitiesOf(o).some(a => a.kind === 'static' && a.effect.kind === 'lifegain-multiplier')) ? 2 : 1; pl.life += n * mult; pl.lifeGainedThisTurn = (pl.lifeGainedThisTurn ?? 0) + n * mult; this.emit({ type: 'life', player: p, delta: n * mult, total: pl.life, reason: 'gain' }); this.queueTriggers('life-gain', { player: p }); }
  loseLife(p: PlayerId, n: number, why: string) { if (n <= 0) return; const pl = this.state.players[p]; pl.life -= n; pl.lifeLostThisTurn += n; this.emit({ type: 'life', player: p, delta: -n, total: pl.life, reason: why }); this.queueTriggers('life-loss-opponent', { player: p }); }

  dealDamageToPlayer(src: GameObject, p: PlayerId, n: number) {
    if (n <= 0) return;
    if ((this.state as GameState & { fog?: number }).fog === this.state.turn && this.state.step.includes('combat')) { this.emit({ type: 'prevented', player: p, amount: n, by: 'fog' }, ''); return; }
    const pl = this.state.players[p];
    const combat = this.state.step === 'combat-damage' || this.state.step === 'first-strike-damage';
    if (hasKeyword(this.state, src, 'infect')) { this.addPoison(p, n, name(src)); if (hasKeyword(this.state, src, 'lifelink')) this.gainLife(src.controller, n); this.queueTriggers('life-loss-opponent', { player: p }); return; }
    pl.life -= n; pl.lifeLostThisTurn += n;
    if (combat && src.commander) pl.commanderDamage[src.id] = (pl.commanderDamage[src.id] ?? 0) + n;
    this.emit({ type: 'damage', sourceId: src.id, source: name(src), player: p, amount: n, combat, total: pl.life });
    if (combat && src.def.toxic && hasKeyword(this.state, src, 'toxic')) this.addPoison(p, src.def.toxic, `${name(src)} (toxic)`);
    if (combat && this.state.monarch === p && src.controller !== p) this.setMonarch(src.controller);
    if (hasKeyword(this.state, src, 'lifelink')) this.gainLife(src.controller, n);
    this.queueTriggers('life-loss-opponent', { player: p });
  }
  dealDamage(src: GameObject, o: GameObject, n: number) {
    if (n <= 0 || o.zone !== 'battlefield') return;
    if (protectedFrom(this.state, o, src)) { this.emit({ type: 'replaced', what: 'protection', id: o.id, name: name(o) }); return; }
    if (o.eotFlags.preventDamage === 'all') { this.emit({ type: 'prevented', id: o.id, name: name(o), amount: 'all', by: 'prevention shield' }); return; }
    if (typeof o.eotFlags.preventDamage === 'number' && o.eotFlags.preventDamage > 0) { const prev = Math.min(o.eotFlags.preventDamage, n); o.eotFlags.preventDamage -= prev; n -= prev; this.emit({ type: 'prevented', id: o.id, name: name(o), amount: prev, by: 'prevention shield' }, ''); if (n <= 0) return; }
    const combat = this.state.step === 'combat-damage' || this.state.step === 'first-strike-damage';
    if (isType(o, 'Planeswalker')) { const total = (o.counters.loyalty ?? 0) - n; if (total <= 0) delete o.counters.loyalty; else o.counters.loyalty = total; this.emit({ type: 'damage', sourceId: src.id, source: name(src), targetId: o.id, target: name(o), amount: n, combat, total, loyalty: true }); }
    else if (hasKeyword(this.state, src, 'infect') || hasKeyword(this.state, src, 'wither')) { this.emit({ type: 'damage', sourceId: src.id, source: name(src), targetId: o.id, target: name(o), amount: n, combat, total: o.damage }, `${name(src)} deals ${n} damage to ${name(o)}#${o.id} as -1/-1 counters.`); this.addCounters(o, '-1/-1', n); if (hasKeyword(this.state, src, 'deathtouch')) (o as GameObject & { deathtouched?: boolean }).deathtouched = true; }
    else { o.damage += n; if (hasKeyword(this.state, src, 'deathtouch')) (o as GameObject & { deathtouched?: boolean }).deathtouched = true; this.emit({ type: 'damage', sourceId: src.id, source: name(src), targetId: o.id, target: name(o), amount: n, combat, total: o.damage }); }
    if (hasKeyword(this.state, src, 'lifelink')) this.gainLife(src.controller, n);
    this.queueTriggers('deals-damage', { obj: src });
  }

  addPoison(p: PlayerId, n: number, why: string) { if (n <= 0) return; const pl = this.state.players[p]; pl.poison += n; this.note(`${pl.name} gets ${n} poison counter${n > 1 ? 's' : ''} (${pl.poison}) — ${why}.`); }
  setMonarch(p: PlayerId) { if (this.state.monarch === p) return; this.state.monarch = p; this.note(`${this.pname(p)} becomes the monarch.`); }

  destroy(o: GameObject, noRegen = false) {
    if (o.zone !== 'battlefield') return;
    if (hasKeyword(this.state, o, 'indestructible')) { this.emit({ type: 'replaced', what: 'indestructible', id: o.id, name: name(o) }); return; }
    if (!noRegen && o.eotFlags.regenerationShield) { o.eotFlags.regenerationShield--; o.tapped = true; o.damage = 0; o.attacking = null; o.blocking = []; this.emit({ type: 'replaced', what: 'regenerate', id: o.id, name: name(o) }); return; }
    this.moveTo(o, 'graveyard', 'top', 'destroy');
  }
  sacrifice(o: GameObject) { if (o.zone !== 'battlefield') return; const ctl = o.controller; this.moveTo(o, 'graveyard', 'top', 'sacrifice'); this.queueTriggers('sacrifice', { obj: o, player: ctl }); }

  changeControl(o: GameObject, to: PlayerId) {
    if (o.controller === to) return;
    const from = this.state.players[o.controller]; from.battlefield.splice(from.battlefield.indexOf(o), 1);
    const was = o.controller;
    o.controller = to; o.enteredTurn = this.state.turn; this.state.players[to].battlefield.push(o);
    this.emit({ type: 'control', id: o.id, name: name(o), from: was, to });
  }

  /** Move an object between zones, handling leave-the-battlefield bookkeeping. */
  moveTo(o: GameObject, zone: import('./state.js').Zone, libraryPos: 'top' | 'bottom' = 'top', reason: ZoneChangeReason = 'effect') {
    if (o.earthbent && o.zone === 'battlefield' && zone === 'graveyard') { this.note(`${name(o)} would die and returns to its owner's hand instead.`); zone = 'hand'; }
    if (o.zone === 'battlefield' && zone !== 'battlefield') { delete o.animated; delete o.earthbent; }
    const s = this.state;
    this.bfGen++;
    const removeFrom = (arr: GameObject[]) => { const i = arr.indexOf(o); if (i >= 0) arr.splice(i, 1); };
    for (const p of s.players) { removeFrom(p.hand); removeFrom(p.battlefield); removeFrom(p.graveyard); removeFrom(p.exile); removeFrom(p.library); removeFrom(p.command); }
    // CR 903.9a-b: a commander headed for the graveyard, exile, hand or library goes to the command zone instead
    let redirected = false;
    let replacedBy: 'exile-instead' | 'shuffle-instead' | null = null;
    if (zone === 'graveyard' && !o.token && o.def.graveyardReplacement) { if (o.def.graveyardReplacement === 'exile') { zone = 'exile'; replacedBy = 'exile-instead'; } else { zone = 'library'; libraryPos = 'bottom'; replacedBy = 'shuffle-instead'; } }
    if (o.commander && !o.token && (zone === 'graveyard' || zone === 'exile' || zone === 'library' || zone === 'hand')) { zone = 'command'; redirected = true; }
    const wasOnBattlefield = o.zone === 'battlefield';
    const fromZone: import('./events.js').ZoneRef = o.zone; const wasController = o.controller;
    if (wasOnBattlefield) {
      o.lastKnown = { power: power(s, o), toughness: toughness(s, o), controller: o.controller, counters: { ...o.counters } };
      if (o.exileIfLeaves && zone !== 'exile') { zone = 'exile'; delete o.exileIfLeaves; }
      const creature = isCreature(o);
      const ctl = o.controller;
      // detach attachments; auras go to graveyard (SBA), equipment stays
      for (const other of allPermanents(s)) if (other.attachedTo === o.id) this.attach(other, null);
      if (zone === 'graveyard' && creature) { s.players[ctl].creaturesDiedThisTurn++; this.queueTriggers('dies', { obj: o, player: ctl }); }
      this.queueTriggers('ltb', { obj: o, player: ctl });
      const ex = (o as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves;
      if (ex) { for (const id of ex) { const back = findObject(s, id); if (back && back.zone === 'exile') { void this.enterBattlefield(back, { controller: back.owner, via: 'effect', sync: true }); this.note(`${name(back)} returns to the battlefield.`); } } delete (o as GameObject & { exiledUntilLeaves?: number[] }).exiledUntilLeaves; }
      const idx = s.attackers.indexOf(o.id); if (idx >= 0) s.attackers.splice(idx, 1);
      for (const a of allPermanents(s)) { const bi = a.blockedBy.indexOf(o.id); if (bi >= 0) a.blockedBy.splice(bi, 1); }
      s.players[ctl].permanentsLeftThisTurn = (s.players[ctl].permanentsLeftThisTurn ?? 0) + 1;
      delete o.grantedAbilities; delete o.chosen; delete o.warpExileTurn; if (o.activeFace) o.activeFace = 0;
    }
    if (zone === 'graveyard' && !o.token && defOf(o).types.some(t => t === 'Artifact' || t === 'Creature' || t === 'Enchantment' || t === 'Land' || t === 'Planeswalker' || t === 'Battle')) s.players[o.owner].descendedThisTurn = true;
    if (o.zone === 'graveyard' && zone !== 'graveyard' && !o.token) this.queueTriggers('leaves-graveyard', { obj: o, player: o.owner });
    // public knowledge: cards leaving a hidden zone are forgotten there; cards entering one from a public zone stay known
    const fromPublic = o.zone !== 'hand' && o.zone !== 'library';
    if (o.zone === 'hand') this.forgetInHand(o.id);
    if (o.zone === 'library') this.forgetTop(o.id);
    if (!o.token && (fromPublic || o.zone === 'library') && zone === 'hand') { this.state.knowledge.knownInHand.push(o.id); if (o.zone === 'library') this.reveal(o.id); } // from library = fetched by a search (revealed)
    if (!o.token && fromPublic && zone === 'library') { this.reveal(o.id); if (libraryPos === 'top') this.state.knowledge.knownTop[o.owner].unshift(o.id); }
    o.zone = zone; o.tapped = false; o.damage = 0; o.attachedTo = null; o.attacking = null; o.blocking = []; o.blockedBy = []; o.eotPower = 0; o.eotToughness = 0; o.eotKeywords = []; o.eotFlags = {}; o.noUntapNext = false;
    if (zone !== 'battlefield') { o.counters = {}; o.controller = o.owner; }
    const isPublic = zone === 'battlefield' || zone === 'graveyard' || zone === 'exile' || (fromPublic && zone !== 'library') || (zone === 'library' && fromPublic && libraryPos === 'top');
    if (o.token && zone !== 'battlefield') { this.emit({ type: 'zone-change', id: o.id, name: name(o), owner: o.owner, controller: wasController, from: fromZone, to: 'none', reason, token: true, public: true }, zone === 'graveyard' && (reason === 'destroy' || reason === 'sacrifice' || reason === 'sba') ? undefined : ''); return; } // tokens cease to exist
    const owner = s.players[zone === 'battlefield' ? o.controller : o.owner];
    if (zone === 'library') { if (libraryPos === 'top') owner.library.unshift(o); else owner.library.push(o); }
    else if (zone === 'battlefield') { o.enteredTurn = s.turn; owner.battlefield.push(o); if (isType(o, 'Planeswalker') && defOf(o).loyalty != null) o.counters.loyalty = defOf(o).loyalty!; }
    else if (zone === 'hand' || zone === 'graveyard' || zone === 'exile' || zone === 'command') owner[zone].push(o);
    // the battlefield entry event is emitted by enterBattlefield once the tapped state and counters are known
    if (zone !== 'battlefield') this.emit({ type: 'zone-change', id: o.id, name: name(o), owner: o.owner, controller: wasController, from: fromZone, to: zone, reason, token: false, public: isPublic || zone === 'command', libraryPos: zone === 'library' ? libraryPos : undefined });
    if (redirected) this.emit({ type: 'replaced', what: 'commander-zone', id: o.id, name: name(o) });
    if (replacedBy) { this.emit({ type: 'replaced', what: replacedBy, id: o.id, name: name(o) }, replacedBy === 'exile-instead' ? `${name(o)} is exiled instead of going to the graveyard.` : `${name(o)} is shuffled into its owner's library instead of going to the graveyard.`); if (replacedBy === 'shuffle-instead') this.shuffle(o.owner); }
  }

  // ------------------------------------------------------------------ leaving the game (CR 104, 800.4)
  /** A player loses now: emit, and either end the game or clean up their objects (multiplayer). */
  eliminate(p: PlayerId, reason: string, text?: string) {
    const s = this.state; const pl = s.players[p];
    if (pl.lost) return;
    pl.lost = true; pl.lossReason = reason;
    this.emit({ type: 'player-eliminated', player: p, reason }, text);
    const live = alive(s);
    if (live.length === 1) { s.winner = live[0]; return; }
    if (live.length === 0) { s.winner = null; return; }
    this.leaveGame(p);
  }
  /** Players who just lost through state-based actions; returns true when the game is over. */
  private settleEliminations(lost: Player[]): boolean {
    const s = this.state; const live = alive(s);
    if (live.length === 0) {
      for (const p of lost) this.emit({ type: 'player-eliminated', player: p.id, reason: p.lossReason ?? 'lost' }, '');
      s.winner = null; this.emit({ type: 'game-over', winner: null, reason: s.players.length === 2 ? 'Both players lose: draw.' : 'Every remaining player loses: draw.' });
      return true;
    }
    for (const p of lost) this.emit({ type: 'player-eliminated', player: p.id, reason: p.lossReason ?? 'lost' });
    if (live.length === 1) { s.winner = live[0]; return true; }
    for (const p of lost) this.leaveGame(p.id);
    return false;
  }
  /** CR 800.4a: everything the player owns leaves the game; what they controlled goes back; their stack items vanish. */
  private leaveGame(p: PlayerId) {
    const s = this.state;
    for (const q of s.players) for (const o of [...q.battlefield]) { if (o.owner === p) this.moveTo(o, 'exile', 'top', 'effect'); else if (o.controller === p) this.changeControl(o, o.owner); }
    for (const it of [...s.stack]) if (it.controller === p) { s.stack.splice(s.stack.indexOf(it), 1); it.countered = true; if (it.kind === 'spell' && it.source.zone === 'stack') this.moveTo(it.source, 'exile', 'top', 'effect'); }
    this.pendingTriggers = this.pendingTriggers.filter(t => t.controller !== p);
    if (s.priority === p) s.priority = nextInTurnOrder(s, p);
    this.note(`${this.pname(p)} leaves the game.`);
  }

  // ------------------------------------------------------------------ state-based actions (CR 704)
  checkSBA() {
    const s = this.state; let again = true; let guard = 0;
    while (again && guard++ < 50) {
      again = false;
      const lostNow: Player[] = [];
      for (const p of s.players) if (p.life <= 0 && !p.lost) { p.lost = true; p.lossReason = 'life total 0 or less'; this.emit({ type: 'sba', kind: 'life', player: p.id }, ''); lostNow.push(p); }
      for (const p of s.players) if (p.poison >= 10 && !p.lost) { p.lost = true; p.lossReason = 'ten poison counters'; this.emit({ type: 'sba', kind: 'poison', player: p.id }, ''); lostNow.push(p); }
      for (const p of s.players) if (!p.lost) { const [cid] = Object.entries(p.commanderDamage ?? {}).find(([, d]) => d >= 21) ?? []; if (cid !== undefined) { p.lost = true; p.lossReason = '21 combat damage from a commander'; this.emit({ type: 'sba', kind: 'commander-damage', player: p.id, id: Number(cid), name: findObject(s, Number(cid)) ? name(findObject(s, Number(cid))!) : 'a commander' }); lostNow.push(p); } }
      if (lostNow.length && this.settleEliminations(lostNow)) return;
      if (s.winner !== null) return;
      for (const o of allPermanents(s)) {
        if (isCreature(o)) {
          const t = toughness(s, o);
          if (t <= 0) { this.emit({ type: 'sba', kind: 'zero-toughness', id: o.id, name: name(o), detail: String(t) }); this.moveTo(o, 'graveyard', 'top', 'sba'); again = true; continue; }
          if (o.damage >= t || (o as GameObject & { deathtouched?: boolean }).deathtouched) { delete (o as GameObject & { deathtouched?: boolean }).deathtouched; this.emit({ type: 'sba', kind: 'lethal-damage', id: o.id, name: name(o) }, ''); this.destroy(o); again = true; continue; }
        }
        if (isType(o, 'Planeswalker') && (o.counters.loyalty ?? 0) <= 0) { this.emit({ type: 'sba', kind: 'zero-loyalty', id: o.id, name: name(o) }); this.moveTo(o, 'graveyard', 'top', 'sba'); again = true; continue; }
        if (subtypes(o).includes('Aura') && o.zone === 'battlefield') {
          const host = o.attachedTo != null ? findObject(s, o.attachedTo) : undefined;
          if (!host || host.zone !== 'battlefield') { this.emit({ type: 'sba', kind: 'aura-unattached', id: o.id, name: name(o) }); this.moveTo(o, 'graveyard', 'top', 'sba'); again = true; continue; }
        }
        if (subtypes(o).includes('Equipment') && o.attachedTo != null) { const host = findObject(s, o.attachedTo); if (!host || host.zone !== 'battlefield' || host.controller !== o.controller) this.attach(o, null); }
        // Saga: sacrificed once its final chapter has resolved (CR 714.4)
        if (o.def.finalChapter && subtypes(o).includes('Saga') && (o.counters.lore ?? 0) >= o.def.finalChapter && !s.stack.some(it => it.source.id === o.id && it.kind === 'trigger') && !this.pendingTriggers.some(t => t.source.id === o.id)) { this.emit({ type: 'sba', kind: 'saga-final', id: o.id, name: name(o) }); this.moveTo(o, 'graveyard', 'top', 'sba'); again = true; continue; }
        if ((o.counters['+1/+1'] ?? 0) > 0 && (o.counters['-1/-1'] ?? 0) > 0) { const m = Math.min(o.counters['+1/+1'], o.counters['-1/-1']); this.addCounters(o, '+1/+1', -m); this.addCounters(o, '-1/-1', -m); this.emit({ type: 'sba', kind: 'counters-cancel', id: o.id, name: name(o), detail: String(m) }, ''); }
      }
      // legend rule
      for (const p of s.players) {
        const legends = p.battlefield.filter(o => o.def.supertypes.includes('Legendary'));
        const seen = new Map<string, GameObject>();
        for (const o of legends) { const n = name(o); if (seen.has(n)) { const older = seen.get(n)!; this.emit({ type: 'sba', kind: 'legend-rule', id: older.id, name: n }); this.moveTo(older, 'graveyard', 'top', 'sba'); again = true; } seen.set(n, o); }
      }
    }
  }

  // ------------------------------------------------------------------ triggers (CR 603)
  private triggerKindsCache: { gen: number; count: number; kinds: Set<string> } | null = null;
  /** Bumped whenever the set of abilities on the battlefield can change (zone moves, granted abilities, transforms). */
  private bfGen = 0;
  /** Trigger event names present on any permanent (memoised on the battlefield generation + permanent count). */
  private triggerKinds(): Set<string> {
    const s = this.state; const perms = allPermanents(s);
    const c = this.triggerKindsCache;
    if (c && c.gen === this.bfGen && c.count === perms.length) return c.kinds;
    const kinds = new Set<string>();
    for (const perm of perms) for (const ab of abilitiesOf(perm)) if (ab.kind === 'triggered') { const evs = ab.event.on === 'or' ? ab.event.events : [ab.event]; for (const ev of evs) kinds.add(ev.on); }
    this.triggerKindsCache = { gen: this.bfGen, count: perms.length, kinds };
    return kinds;
  }

  /** Wizard's Staff / Ancient Greenwarden / Drivnod: how many extra times a trigger of `perm` fires. */
  private triggerExtraTimes(perm: GameObject, event: string, ctx: TriggerCtx): number {
    const s = this.state; let extra = 0;
    for (const src of s.players[perm.controller].battlefield) for (const ab of abilitiesOf(src)) {
      if (ab.kind !== 'static' || ab.effect.kind !== 'trigger-twice') continue;
      const e = ab.effect;
      if (e.equipped) { if (src.attachedTo === perm.id) extra++; continue; }
      if (e.event === 'land-etb') { if (event === 'etb' && ctx.obj && isLand(ctx.obj)) extra++; continue; }
      if (e.event) { if (event === e.event && (!e.filter || (ctx.obj && matchesFilter(s, ctx.obj, e.filter, src)))) extra++; continue; }
      if (e.filter && perm.id !== src.id && matchesFilter(s, perm, e.filter, src)) extra++;
    }
    return extra;
  }
  queueTriggers(event: string, ctx: TriggerCtx) {
    const s = this.state;
    const selfLeaving = (event === 'dies' || event === 'ltb') && !!ctx.obj;
    if (!this.triggerKinds().has(event) && !selfLeaving) return;
    if (this.triggerKinds().has(event)) for (const perm of allPermanents(s)) {
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
            case 'combat-damage-player': fires = ev.self || !ev.filter ? ctx.obj === perm : (!!ctx.obj && ctx.obj.controller === perm.controller && matchesFilter(s, ctx.obj, ev.filter, perm)); break;
            case 'blocks': case 'becomes-blocked': case 'deals-damage': case 'tapped': fires = ctx.obj === perm; break;
            case 'targeted': fires = ev.filter ? (!!ctx.obj && ctx.obj.controller === perm.controller && matchesFilter(s, ctx.obj, ev.filter, perm)) : ctx.obj === perm && (!ev.bySpellYouCast || (ctx.player === perm.controller && !!ctx.by && ctx.by.zone !== 'battlefield')); break;
            case 'upkeep': case 'end-step': fires = ev.whose === 'each' || (ev.whose === 'your' && ctx.player === perm.controller) || (ev.whose === 'opponent' && ctx.player !== perm.controller); break;
            case 'draw-step': case 'combat-begin': case 'you-attack': fires = ctx.player === perm.controller; break;
            case 'cast': fires = !!ctx.obj && matchesFilter(s, ctx.obj, ev.filter) && (ev.who === 'any' || (ev.who === 'you') === (ctx.player === perm.controller)) && (!ev.nth || (ctx.player !== undefined && s.players[ctx.player].spellsCastThisTurn === ev.nth))
              && (!ev.mvEqualsCounter || (perm.counters[ev.mvEqualsCounter] ?? 0) === ctx.obj.def.manaValue + (ctx.obj.def.manaCost?.x ?? 0) * (ctx.obj.castWith?.x ?? 0)); break;
            case 'landfall': fires = ctx.player === perm.controller && (!ev.played || !!ctx.played) && (!ev.other || ctx.obj !== perm); break;
            case 'life-gain': case 'discard': { const evf = (ev as { filter?: import('../cards/types.js').Filter }).filter; fires = (ctx.player === perm.controller) && (!evf || (!!ctx.obj && matchesFilter(s, ctx.obj, evf, perm))); break; } break;
            case 'life-loss-opponent': fires = ctx.player !== perm.controller; break;
            case 'sacrifice': fires = ctx.player === perm.controller && (!ev.filter || (!!ctx.obj && matchesFilter(s, ctx.obj, ev.filter))); break;
            case 'draw': fires = ctx.player !== undefined && (ev.who === 'opponent') === (ctx.player !== perm.controller) && !(ev.exceptFirstInDrawStep && ctx.stepDraw) && (!ev.nth || (s.players[ctx.player].cardsDrawnThisTurn ?? 0) === ev.nth); break;
            case 'chapter': fires = ctx.obj === perm && ev.chapters.includes(perm.counters.lore ?? 0); break;
            case 'leaves-graveyard': fires = ctx.player === perm.controller && !!ctx.obj && matchesFilter(s, ctx.obj, ev.filter, perm); break;
          }
          if (fires) break;
        }
        if (fires && ab.oncePerTurn) { if (perm.triggeredThisTurn?.has(ab.text)) fires = false; else (perm.triggeredThisTurn ??= new Set()).add(ab.text); }
        if (fires) { const times = 1 + this.triggerExtraTimes(perm, event, ctx); for (let k = 0; k < times; k++) this.pendingTriggers.push({ ability: ab, source: perm, controller: perm.controller, triggerCtx: ctx }); }
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
    const order = apnapOrder(s);
    list.sort((a, b) => order.indexOf(a.controller) - order.indexOf(b.controller));
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
      this.emit({ type: 'trigger', itemId: item.id, id: t.source.id, name: name(t.source), player: t.controller, ability: t.ability.text, targets: [] });
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
      if ([...item.targetsByEffect.values()].length) this.note(`  ${item.name}${this.describeTargets(item)}`);
    }
  }
  /** Simple heuristic target choice for triggered abilities (hostile effects at opponent, helpful at self). */
  private autoPickTargets(item: StackItem, spec: TargetSpec, opts: TargetRef[]): TargetRef[] {
    if (!opts.length) return [];
    const s = this.state; const me = item.controller; const opps = opponentsOf(s, me);
    const eff = this.effectiveEffects(item);
    const hostile = eff.some(e => ['damage', 'destroy', 'exile', 'bounce', 'tap', 'lose-life', 'discard', 'mill', 'counter', 'cant-attack-or-block', 'fight', 'bite'].includes(e.op) || (e.op === 'pump' && typeof e.power === 'number' && e.power < 0) || (e.op === 'counters' && e.counter === '-1/-1'));
    const score = (r: TargetRef) => {
      if (r.kind === 'player') return opps.includes(r.id) ? (hostile ? 5 : -5) : (hostile ? -5 : 5);
      if (r.kind === 'stack') return 1;
      const o = findObject(s, r.id)!; const val = isCreature(o) ? power(s, o) + toughness(s, o) : 3;
      return opps.includes(o.controller) === hostile ? val : -val;
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
    const s = this.state; const ap = s.activePlayer; const defenders = opponentsOf(s, ap); const dp = defenders[0] ?? primaryOpponent(s, ap);
    const at = STEPS.indexOf(from);
    const reach = (st: Step) => STEPS.indexOf(st) >= at;
    const enter = (st: Step) => STEPS.indexOf(st) > at || !resume;
    const round = async (st: Step) => { if (s.players[ap].lost) return true; await this.priorityRound(resume && st === from); return s.winner !== null || s.players[ap].lost; };
    if (reach('combat-begin')) { if (enter('combat-begin')) { await this.setStep('combat-begin'); this.queueTriggers('combat-begin', { player: ap }); } if (await round('combat-begin')) return; }
    if (reach('declare-attackers') && enter('declare-attackers')) {
      await this.setStep('declare-attackers');
      const candidates = s.players[ap].battlefield.filter(o => canAttack(s, o));
      const mustAttack = candidates.filter(o => o.def.abilities.some(a => a.kind === 'static' && (a.effect as unknown as { mustAttack?: boolean }).mustAttack)).map(o => o.id);
      s.attackers = [];
      const planeswalkers = defenders.flatMap(d => s.players[d].battlefield.filter(o => isType(o, 'Planeswalker')).map(o => ({ id: o.id, controller: d })));
      if (candidates.length) {
        const decl = await this.ask(ap, { kind: 'attackers', candidates: candidates.map(o => o.id), mustAttack, defenders, planeswalkers }) as AttackDeclaration;
        for (const id of new Set([...decl.attackers, ...mustAttack])) {
          const o = candidates.find(c => c.id === id); if (!o) continue;
          const want = decl.targets?.[id];
          delete o.attackingPlaneswalker;
          if (typeof want === 'object' && want && planeswalkers.some(w => w.id === want.planeswalker)) { o.attacking = planeswalkers.find(w => w.id === want.planeswalker)!.controller; o.attackingPlaneswalker = want.planeswalker; }
          else o.attacking = typeof want === 'number' && defenders.includes(want) ? want : dp;
          if (!hasKeyword(s, o, 'vigilance')) this.setTapped(o, true, 'attack'); s.attackers.push(o.id);
        }
      }
      if (s.attackers.length) {
        s.players[ap].attackedThisTurn = true; s.players[ap].attackedWithThisTurn = s.attackers.length;
        this.emit({ type: 'attack', player: ap, target: dp, attackers: s.attackers.map(id => ({ id, name: name(findObject(s, id)!) })), targets: Object.fromEntries(s.attackers.map(id => { const o = findObject(s, id)!; return [id, o.attackingPlaneswalker != null ? { planeswalker: o.attackingPlaneswalker } : (o.attacking ?? dp)]; })) });
        // exalted (CR 702.83): a creature attacking alone gets +1/+1 per exalted instance you control
        if (s.attackers.length === 1) { const ex = s.players[ap].battlefield.filter(o => hasKeyword(s, o, 'exalted')).length; if (ex) { const a = findObject(s, s.attackers[0])!; a.eotPower += ex; a.eotToughness += ex; this.note(`${name(a)} gets +${ex}/+${ex} until end of turn (exalted).`); } }
        for (const id of s.attackers) this.queueTriggers('attacks', { obj: findObject(s, id), player: ap });
        if (s.attackers.length) this.queueTriggers('you-attack', { player: ap });
      }
    }
    if (at <= STEPS.indexOf('combat-damage') && s.attackers.length) {
      if (enter('declare-attackers') || from === 'declare-attackers') { if (await round('declare-attackers')) return; }
      if (reach('declare-blockers')) {
        if (enter('declare-blockers')) {
          await this.setStep('declare-blockers');
          const allAttackers = s.attackers.map(id => findObject(s, id)!).filter(o => o && o.zone === 'battlefield');
          for (const d of defenders) {
            const attackers = allAttackers.filter(a => a.attacking === d);
            const blockers = s.players[d].battlefield.filter(o => isCreature(o) && !o.tapped);
            if (!attackers.length || !blockers.length) continue;
            const decl = await this.ask(d, { kind: 'blockers', attackers: attackers.map(a => a.id), candidates: blockers.map(b => b.id) }) as BlockDeclaration;
            for (const b of decl.blocks) {
              const blocker = blockers.find(o => o.id === b.blocker), attacker = attackers.find(o => o.id === b.attacker);
              if (!blocker || !attacker || !canBlock(s, blocker, attacker)) continue;
              const extra = abilitiesOf(blocker).reduce((n, ab) => n + (ab.kind === 'static' && ab.effect.kind === 'extra-blocks' ? ab.effect.amount : 0), 0);
              if (blocker.blocking.length > extra) continue;
              if (attacker.blockedBy.length >= 1 && abilitiesOf(attacker).some(ab => ab.kind === 'static' && ab.effect.kind === 'cant-be-blocked-by-more-than-one')) continue;
              blocker.blocking.push(attacker.id); attacker.blockedBy.push(blocker.id);
            }
            // menace: needs 2+ blockers
            for (const a of attackers) if (hasKeyword(s, a, 'menace') && a.blockedBy.length === 1) { const b = findObject(s, a.blockedBy[0])!; b.blocking = []; a.blockedBy = []; this.note(`${name(b)} can't block ${name(a)} alone (menace).`); }
            this.emit({ type: 'block', player: d, blocks: attackers.flatMap(a => a.blockedBy.map(id => ({ blocker: id, blockerName: name(findObject(s, id)!), attacker: a.id, attackerName: name(a) }))) });
            // flanking (702.25), bushido (702.46), rampage (702.23)
            for (const a of attackers) {
              const bls = a.blockedBy.map(id => findObject(s, id)!).filter(Boolean);
              if (!bls.length) continue;
              if (hasKeyword(s, a, 'flanking')) for (const b of bls) if (!hasKeyword(s, b, 'flanking')) { b.eotPower -= 1; b.eotToughness -= 1; this.note(`${name(b)} gets -1/-1 until end of turn (flanking).`); }
              if (a.def.bushido && hasKeyword(s, a, 'bushido')) { a.eotPower += a.def.bushido; a.eotToughness += a.def.bushido; this.note(`${name(a)} gets +${a.def.bushido}/+${a.def.bushido} until end of turn (bushido).`); }
              if (a.def.rampage && hasKeyword(s, a, 'rampage') && bls.length > 1) { const k = a.def.rampage * (bls.length - 1); a.eotPower += k; a.eotToughness += k; this.note(`${name(a)} gets +${k}/+${k} until end of turn (rampage).`); }
              for (const b of bls) if (b.def.bushido && hasKeyword(s, b, 'bushido')) { b.eotPower += b.def.bushido; b.eotToughness += b.def.bushido; this.note(`${name(b)} gets +${b.def.bushido}/+${b.def.bushido} until end of turn (bushido).`); }
            }
            this.checkSBA();
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
    if (enter('combat-end')) { await this.setStep('combat-end'); this.flushDelayed('end-of-combat'); }
    await round('combat-end');
    for (const o of allPermanents(s)) { o.attacking = null; delete o.attackingPlaneswalker; o.blocking = []; o.blockedBy = []; }
    s.attackers = [];
  }

  private async combatDamage(firstStrikeStep: boolean) {
    const s = this.state; const ap = s.activePlayer;
    const dealsNow = (o: GameObject) => { const fs = hasKeyword(s, o, 'first strike'), ds = hasKeyword(s, o, 'double strike'); return firstStrikeStep ? (fs || ds) : (ds || !fs); };
    const damage: { src: GameObject; to: GameObject | PlayerId; n: number }[] = [];
    for (const id of s.attackers) {
      const a = findObject(s, id); if (!a || a.zone !== 'battlefield' || a.attacking === null || !dealsNow(a)) continue;
      let p = damageByToughness(s, a) ? toughness(s, a) : power(s, a); if (p <= 0) continue;
      const blockers = a.blockedBy.map(b => findObject(s, b)!).filter(b => b && b.zone === 'battlefield');
      const pw = a.attackingPlaneswalker != null ? findObject(s, a.attackingPlaneswalker) : undefined;
      const defender: GameObject | PlayerId = pw && pw.zone === 'battlefield' ? pw : a.attacking;
      if (!blockers.length) { if (a.blockedBy.length === 0 && !(a as GameObject & { wasBlocked?: boolean }).wasBlocked) damage.push({ src: a, to: defender, n: p }); continue; }
      const dt = hasKeyword(s, a, 'deathtouch'), trample = hasKeyword(s, a, 'trample');
      for (const b of blockers) {
        const lethal = dt ? 1 : Math.max(0, toughness(s, b) - b.damage);
        const assign = Math.min(p, lethal); if (assign > 0) damage.push({ src: a, to: b, n: assign }); p -= assign;
        if (p <= 0) break;
      }
      if (p > 0) { if (trample) damage.push({ src: a, to: defender, n: p }); else damage[damage.length - 1].n += p; }
    }
    for (const q of s.players) for (const o of q.battlefield) {
      if (q.id === ap || !o.blocking.length || !dealsNow(o)) continue;
      const p = power(s, o); if (p <= 0) continue;
      const a = findObject(s, o.blocking[0]); if (a && a.zone === 'battlefield') damage.push({ src: o, to: a, n: p });
    }
    for (const d of damage) { if (typeof d.to === 'number') { this.dealDamageToPlayer(d.src, d.to, d.n); if (d.n > 0) this.queueTriggers('combat-damage-player', { obj: d.src, player: d.to }); } else this.dealDamage(d.src, d.to, d.n); }
    for (const id of s.attackers) { const a = findObject(s, id); if (a && a.blockedBy.length) (a as GameObject & { wasBlocked?: boolean }).wasBlocked = true; }
  }

  // ------------------------------------------------------------------ agent interface
  async ask(p: PlayerId, d: Decision): Promise<unknown> {
    const agent = this.agents[p];
    if ((this.opts.events ?? 'counts') !== 'none') this.emit({ type: 'decision', player: p, kind: d.kind }, '');
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
