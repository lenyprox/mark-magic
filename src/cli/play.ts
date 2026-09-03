// Terminal client: play a game against the AI.
// Usage: npm run play -- [--deck decks/mono-red.txt] [--ai-deck decks/mono-green.txt] [--seed 42] [--life 20] [--ai-vs-ai]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CardDB, loadDeck, parseDeckList } from '../cards/db.js';
import { Game } from '../engine/game.js';
import { AiAgent } from '../ai/ai.js';
import { findObject, hasKeyword, isCreature, isLand, keywords, name, power, toughness } from '../engine/characteristics.js';
import type { Agent, AttackDeclaration, BlockDeclaration, Decision, GameState, LegalAction, PlayerAction, PlayerId, TargetRef } from '../engine/state.js';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k: string) => args.includes(k);
const deckPath = opt('--deck', 'decks/mono-red-burn.txt')!;
const aiDeckPath = opt('--ai-deck', 'decks/mono-green-stompy.txt')!;
const seed = Number(opt('--seed', String(Date.now() % 100000)));
const life = Number(opt('--life', '20'));
const aiVsAi = flag('--ai-vs-ai');

const db = new CardDB();
function load(p: string) {
  const list = parseDeckList(fs.readFileSync(p, 'utf8'), path.basename(p, '.txt'));
  const { cards, missing, partial } = loadDeck(db, list);
  if (missing.length) { console.error(`Unknown cards in ${p}: ${missing.join(', ')}`); process.exit(1); }
  if (partial.length) console.log(`Note: ${partial.length} card(s) in ${list.name} have text the engine only partly simulates: ${partial.map(c => c.name).join(', ')}`);
  if (cards.length < 40) console.log(`Warning: ${list.name} has only ${cards.length} cards.`);
  return { name: list.name, cards };
}
const human = load(deckPath), ai = load(aiDeckPath);

// ---------------------------------------------------------------------------
// Human agent (readline)
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input, output });
class HumanAgent implements Agent {
  name = 'Player';
  game!: Game;
  onLog(line: string) { console.log(line); }
  private async prompt(q: string): Promise<string> { return (await rl.question(q)).trim(); }

  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    switch (d.kind) {
      case 'priority': return this.priority(s, me, d.legal);
      case 'attackers': return this.attackers(s, me, d.candidates, d.mustAttack);
      case 'blockers': return this.blockers(s, me, d.attackers, d.candidates);
      case 'choose-cards': return this.chooseCards(s, d.from, d.count, d.reason, d.exact);
      case 'yes-no': { const a = await this.prompt(`${d.prompt} (y/n) `); return /^y/i.test(a); }
      case 'choose-mode': { const a = await this.prompt(`Choose mode ${d.modes.map((m, i) => `[${i + 1}] ${m}`).join('  ')}: `); return [Math.max(0, Number(a) - 1)]; }
      case 'choose-color': { const a = (await this.prompt(`Choose a colour for ${d.reason} (W/U/B/R/G): `)).toUpperCase(); return 'WUBRG'.includes(a) && a ? a : 'G'; }
      case 'order-blockers': return d.blockers;
    }
  }

  private async priority(s: GameState, me: PlayerId, legal: LegalAction[]): Promise<PlayerAction> {
    const opp = me === 0 ? 1 : 0;
    const actionable = legal.filter(l => l.action.type !== 'pass');
    const top = s.stack[s.stack.length - 1];
    const ctx = `[T${s.turn} ${s.activePlayer === me ? 'your' : "AI's"} turn, ${s.step}${top ? `, stack top: ${top.name}${this.game.describeTargets(top)}` : ''}]`;
    // Auto-pass when nothing is possible, or outside the default stops (own main phases, blocker declaration on either turn,
    // the opponent's attack declaration and end step), unless something is on the stack.
    if (!actionable.length && !top) return { type: 'pass' };
    const myTurn = s.activePlayer === me;
    const stop = !!top || (myTurn && (s.step === 'main1' || s.step === 'main2' || s.step === 'declare-blockers')) || (!myTurn && (s.step === 'declare-attackers' || s.step === 'declare-blockers' || s.step === 'end'));
    if (!stop) return { type: 'pass' };
    for (;;) {
      const line = await this.prompt(`${ctx} > `);
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(' ');
      if (!cmd || cmd === 'pass' || cmd === 'p' || cmd === 'ok' || cmd === '') return { type: 'pass' };
      if (cmd === 'help' || cmd === '?') { printHelp(); continue; }
      if (cmd === 'board' || cmd === 'b') { printBoard(s, me); continue; }
      if (cmd === 'hand' || cmd === 'h') { printHand(s, me); continue; }
      if (cmd === 'stack') { for (const it of [...s.stack].reverse()) console.log(`  ${it.name}${this.game.describeTargets(it)} (${s.players[it.controller].name})`); if (!s.stack.length) console.log('  (empty)'); continue; }
      if (cmd === 'actions' || cmd === 'a') { actionable.forEach((l, i) => console.log(`  ${i + 1}. ${l.label}${l.targetOptions?.length ? '  [targets: ' + l.targetOptions.map(t => t.spec).join('; ') + ']' : ''}`)); if (!actionable.length) console.log('  (nothing castable right now)'); continue; }
      if (cmd === 'card' || cmd === 'c') { showCard(s, arg); continue; }
      if (cmd === 'log') { console.log(s.log.slice(-25).join('\n')); continue; }
      if (cmd === 'gy') { for (const p of s.players) console.log(`${p.name} graveyard: ${p.graveyard.map(o => o.def.name).join(', ') || '-'}`); continue; }
      if (cmd === 'concede') return { type: 'concede' };
      // number => action index; or "cast <name>", "play <name>", "act <perm#> <n>"
      let chosen: LegalAction | undefined;
      if (/^\d+$/.test(cmd)) chosen = actionable[Number(cmd) - 1];
      else if (cmd === 'play' || cmd === 'cast' || cmd === 'x') {
        const q = arg.toLowerCase();
        const matches = actionable.filter(l => (l.action.type === 'play-land' || l.action.type === 'cast') && l.label.toLowerCase().includes(q));
        if (matches.length === 1) chosen = matches[0];
        else if (matches.length > 1) { console.log('Ambiguous:'); matches.forEach(m => console.log('  ' + m.label + '  (#' + (actionable.indexOf(m) + 1) + ')')); continue; }
      }
      else if (cmd === 'act' || cmd === 'use') {
        const q = arg.toLowerCase();
        const matches = actionable.filter(l => l.action.type === 'activate' && l.label.toLowerCase().includes(q));
        if (matches.length === 1) chosen = matches[0];
        else if (matches.length > 1) { console.log('Ambiguous:'); matches.forEach(m => console.log('  ' + m.label + '  (#' + (actionable.indexOf(m) + 1) + ')')); continue; }
      }
      if (!chosen) { console.log("Unknown command or no such action. Type 'a' to list actions, '?' for help."); continue; }
      // gather targets
      const targets: TargetRef[][] = [];
      let aborted = false;
      for (const req of chosen.targetOptions ?? []) {
        if (!req.options.length) { targets.push([]); continue; }
        console.log(`  Choose ${req.spec}${req.optional ? ' (optional, enter to skip)' : ''}:`);
        req.options.forEach((o, i) => console.log(`    ${i + 1}. ${this.game.refName(o)}${o.kind === 'object' ? '  ' + shortDesc(s, o.id) : ''}`));
        const picks: TargetRef[] = [];
        for (let k = 0; k < req.count; k++) {
          const a = await this.prompt(`    target ${k + 1}/${req.count}${k > 0 || req.optional ? ' (enter to stop)' : ''}: `);
          if (!a) { if (k === 0 && !req.optional) { aborted = true; } break; }
          const idx = Number(a) - 1; if (!req.options[idx]) { console.log('    invalid'); k--; continue; }
          picks.push(req.options[idx]);
        }
        if (aborted) break;
        targets.push(picks);
      }
      if (aborted) { console.log('  cancelled'); continue; }
      let x: number | undefined = chosen.action.type === 'cast' ? chosen.action.x : undefined;
      if (x !== undefined) { const a = await this.prompt(`  X = (max ${x}): `); x = Math.min(x, Math.max(0, Number(a) || 0)); }
      const action = { ...chosen.action, targets, ...(x !== undefined ? { x } : {}) } as PlayerAction;
      void opp;
      return action;
    }
  }

  private async attackers(s: GameState, me: PlayerId, candidates: number[], mustAttack: number[]): Promise<AttackDeclaration> {
    console.log('Declare attackers. Candidates:');
    candidates.forEach((id, i) => console.log(`  ${i + 1}. ${shortDesc(s, id)}${mustAttack.includes(id) ? ' (must attack)' : ''}`));
    const a = await this.prompt('Attack with (numbers separated by spaces, "all", or enter for none): ');
    if (a === 'all') return { attackers: candidates };
    const ids = a.split(/\s+/).filter(Boolean).map(n => candidates[Number(n) - 1]).filter(Boolean);
    return { attackers: ids };
  }

  private async blockers(s: GameState, me: PlayerId, attackers: number[], candidates: number[]): Promise<BlockDeclaration> {
    console.log('Declare blockers. Attackers:');
    attackers.forEach((id, i) => console.log(`  A${i + 1}. ${shortDesc(s, id)}`));
    console.log('Your untapped creatures:');
    candidates.forEach((id, i) => console.log(`  B${i + 1}. ${shortDesc(s, id)}`));
    const a = await this.prompt('Blocks as "B1=A2 B3=A2" (enter for no blocks): ');
    const blocks: { blocker: number; attacker: number }[] = [];
    for (const tok of a.split(/\s+/).filter(Boolean)) {
      const m = tok.match(/^b?(\d+)=a?(\d+)$/i); if (!m) continue;
      const blocker = candidates[Number(m[1]) - 1], attacker = attackers[Number(m[2]) - 1];
      if (blocker && attacker) blocks.push({ blocker, attacker });
    }
    return { blocks };
  }

  private async chooseCards(s: GameState, from: number[], count: number, reason: string, exact: boolean): Promise<number[]> {
    console.log(`${reason}:`);
    from.forEach((id, i) => console.log(`  ${i + 1}. ${shortDesc(s, id)}`));
    for (;;) {
      const a = await this.prompt(`Choose ${exact ? 'exactly' : 'up to'} ${count} (numbers): `);
      const ids = [...new Set(a.split(/\s+/).filter(Boolean).map(n => from[Number(n) - 1]).filter(Boolean))];
      if (exact && ids.length !== Math.min(count, from.length)) { console.log(`need ${Math.min(count, from.length)}`); continue; }
      if (ids.length > count) { console.log('too many'); continue; }
      return ids;
    }
  }
}

function shortDesc(s: GameState, id: number): string {
  const o = findObject(s, id); if (!o) return '?';
  const n = `${name(o)}#${o.id}`;
  if (o.zone !== 'battlefield') return `${n} ${o.def.manaCost?.raw ?? ''} ${o.def.typeLine}`;
  const bits: string[] = [];
  if (isCreature(o)) bits.push(`${power(s, o)}/${toughness(s, o)}${o.damage ? ` (${o.damage} dmg)` : ''}`);
  if (o.tapped) bits.push('tapped');
  if (isCreature(o) && o.enteredTurn === s.turn && !hasKeyword(s, o, 'haste')) bits.push('summoning sick');
  const kw = isCreature(o) ? keywords(s, o) : [];
  if (kw.length) bits.push(kw.join(', '));
  const ctr = Object.entries(o.counters).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`); if (ctr.length) bits.push(ctr.join(', '));
  if (o.attachedTo != null) bits.push(`attached to #${o.attachedTo}`);
  return `${n} ${bits.join(' · ')}`;
}
function printBoard(s: GameState, me: PlayerId) {
  for (const p of [s.players[me === 0 ? 1 : 0], s.players[me]]) {
    console.log(`\n--- ${p.name}: ${p.life} life, ${p.hand.length} in hand, ${p.library.length} in library, ${p.graveyard.length} in graveyard${p.manaPool.length ? ', pool ' + p.manaPool.join('') : ''}`);
    const lands = p.battlefield.filter(isLand), others = p.battlefield.filter(o => !isLand(o));
    if (lands.length) console.log(`  Lands: ${lands.map(o => `${name(o)}${o.tapped ? '(T)' : ''}`).join(', ')}`);
    for (const o of others) console.log(`  ${shortDesc(s, o.id)}`);
  }
  console.log('');
}
function printHand(s: GameState, me: PlayerId) {
  console.log('Hand:');
  for (const c of s.players[me].hand) console.log(`  ${c.def.name} ${c.def.manaCost?.raw ?? ''} — ${c.def.typeLine}${c.def.power ? ` ${c.def.power}/${c.def.toughness}` : ''}`);
}
function showCard(s: GameState, q: string) {
  const id = Number(q.replace('#', ''));
  const o = Number.isFinite(id) && id > 0 ? findObject(s, id) : undefined;
  const def = o?.def ?? db.get(q);
  if (!def) { console.log('not found'); return; }
  console.log(`${def.name} ${def.manaCost?.raw ?? ''}\n${def.typeLine}${def.power ? ` ${def.power}/${def.toughness}` : ''}${def.loyalty != null ? ` loyalty ${def.loyalty}` : ''}\n${def.oracleText}`);
  if (!def.fullyParsed) console.log(`  (engine does not simulate: ${def.unparsed.join(' | ')})`);
}
function printHelp() {
  console.log(`Commands:
  a / actions        list what you can do now (then type its number)
  play <name>        play a land        cast <name>   cast a spell      act <text>  activate an ability
  <enter> / pass     pass priority (let the stack resolve / move on)
  b / board          show the battlefield   h / hand   show your hand   stack   show the stack
  c <name|#id>       show a card's text     gy         graveyards       log     recent log
  concede            give up`);
}

// ---------------------------------------------------------------------------
const humanAgent = new HumanAgent();
const aiAgent = new AiAgent({ name: 'AI', verbose: true });
const p0: Agent = aiVsAi ? new AiAgent({ name: 'AI-1', verbose: true }) : humanAgent;
const game = new Game([human.cards, ai.cards], [p0, aiAgent], { seed, startingLife: life });
if (p0 instanceof AiAgent) p0.attach(game); else (p0 as HumanAgent).game = game;
aiAgent.attach(game);
if (aiVsAi) (p0 as AiAgent).onLog = (l) => console.log(l);
console.log(`You: ${human.name} (${human.cards.length} cards) vs AI: ${ai.name} (${ai.cards.length} cards). Seed ${seed}. Type ? for help.\n`);
const winner = await game.play();
console.log(winner === null ? 'Draw.' : aiVsAi ? `\n${game.state.players[winner].name} wins.` : winner === 0 ? '\nYou win!' : '\nThe AI wins.');
rl.close(); db.close();
