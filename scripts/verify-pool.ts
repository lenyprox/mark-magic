// Pool sandbox (B10c): every fully parsed card is put in hand (or on the battlefield) in a two-player sandbox with
// plenty of mana, every legal action for it is tried and resolved, state-based actions run, and the state is checked
// against invariants. Cards that throw or break an invariant are listed so engine bugs surface before a real game
// hits them. Writes data/master/verify-pool.json.   npm run verify:pool [-- --limit N --name "Card"]
import fs from 'node:fs';
import { CardDB } from '../src/cards/db.js';
import type { CardDef } from '../src/cards/types.js';
import { Game } from '../src/engine/game.js';
import { legalActions } from '../src/engine/legal.js';
import { makeObject, type Agent, type Decision, type GameState, type PlayerId } from '../src/engine/state.js';
import { defaultAnswer } from '../src/engine/agents/defaults.js';
import { allPermanents, findObject } from '../src/engine/characteristics.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const limit = Number(opt('--limit') ?? '0'); const only = opt('--name');

class Sandbox implements Agent {
  name: string; constructor(name: string) { this.name = name; }
  async decide(s: GameState, me: PlayerId, d: Decision): Promise<unknown> {
    if (d.kind === 'choose-cards') return d.from.slice(0, d.count);
    if (d.kind === 'yes-no') return d.tag === 'mulligan' ? false : true;
    return defaultAnswer(s, me, d);
  }
}

type Verdict = 'sandbox-ok' | 'sandbox-throws' | 'invariant-violation' | 'unreachable' | 'skipped';
interface Row { name: string; oracleId: string; verdict: Verdict; detail?: string; actions: number }

function invariants(s: GameState): string | null {
  const ids = new Set<number>();
  for (const p of s.players) for (const z of [p.hand, p.library, p.graveyard, p.exile, p.battlefield, p.command]) for (const o of z) { if (ids.has(o.id)) return `object ${o.id} in two zones`; ids.add(o.id); }
  for (const p of s.players) for (const o of p.battlefield) if (o.zone !== 'battlefield') return `${o.def.name} on battlefield list with zone ${o.zone}`;
  for (const p of s.players) for (const o of p.hand) if (o.zone !== 'hand') return `${o.def.name} in hand list with zone ${o.zone}`;
  for (const o of allPermanents(s)) { if (o.attachedTo != null && !findObject(s, o.attachedTo)) return `${o.def.name} attached to a missing object`; for (const [k, v] of Object.entries(o.counters)) if (v < 0) return `${o.def.name} has ${v} ${k} counters`; }
  for (const p of s.players) if (!Number.isFinite(p.life)) return `${p.name} life is ${p.life}`;
  for (const it of s.stack) if (!it.source) return 'stack item without a source';
  return null;
}

async function trial(cards: CardDB, def: CardDef): Promise<Row> {
  const lands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].map(n => cards.get(n)!);
  const filler = Array(10).fill(cards.get('Forest')!);
  const g = new Game([filler, filler], [new Sandbox('A'), new Sandbox('B')], { seed: 1, quiet: true, mulligans: false, events: 'counts', maxTurns: 4 });
  const s = g.state; s.turn = 5; s.activePlayer = 0; s.step = 'main1'; s.priority = 0;
  const put = (pid: PlayerId, d: CardDef, zone: 'hand' | 'battlefield') => { const o = makeObject(s.nextId++, d, pid, zone, 1); o.enteredTurn = 1; s.players[pid][zone].push(o); return o; };
  for (const l of lands) for (let i = 0; i < 3; i++) put(0, l, 'battlefield');
  put(1, cards.get('Grizzly Bears')!, 'battlefield'); put(1, cards.get('Hill Giant')!, 'battlefield');
  const isPermanent = !(def.types.includes('Instant') || def.types.includes('Sorcery'));
  const card = put(0, def, 'hand');
  let actions = 0;
  try {
    const legal = legalActions(g, 0).filter(l => (l.action.type === 'cast' && l.action.cardId === card.id) || (l.action.type === 'play-land' && l.action.cardId === card.id) || (l.action.type === 'activate' && l.action.objectId === card.id));
    for (const l of legal.slice(0, 6)) {
      const g2 = Game.fromState(structuredCloneState(s), [new Sandbox('A'), new Sandbox('B')], { quiet: true, seed: 1, events: 'counts', maxTurns: 4 });
      const concrete = withFirstTargets(l);
      const ok = await g2.performAction(0, concrete);
      if (!ok) continue;
      actions++;
      await g2.resolveStackFully();
      const v = invariants(g2.state); if (v) return { name: def.name, oracleId: def.oracleId, verdict: 'invariant-violation', detail: `after ${l.label}: ${v}`, actions };
      // permanents: try each activated ability once it is on the battlefield, then attack, then a full turn
      const perm = findObject(g2.state, card.id);
      if (perm && perm.zone === 'battlefield') {
        for (const a of legalActions(g2, 0).filter(x => x.action.type === 'activate' && x.action.objectId === card.id).slice(0, 4)) { const ok2 = await g2.performAction(0, withFirstTargets(a)); if (ok2) { actions++; await g2.resolveStackFully(); } }
        const v2 = invariants(g2.state); if (v2) return { name: def.name, oracleId: def.oracleId, verdict: 'invariant-violation', detail: `after abilities: ${v2}`, actions };
        await g2.resumeTurn(); await g2.playTurns(1);
        const v3 = invariants(g2.state); if (v3) return { name: def.name, oracleId: def.oracleId, verdict: 'invariant-violation', detail: `after a turn: ${v3}`, actions };
      }
    }
    if (!actions && isPermanent && !def.types.includes('Land')) {
      // uncastable in the sandbox (alternative costs, X, timing): drop it on the battlefield and run a turn
      const g3 = Game.fromState(structuredCloneState(s), [new Sandbox('A'), new Sandbox('B')], { quiet: true, seed: 1, events: 'counts', maxTurns: 4 });
      const hand = g3.state.players[0].hand.find(o => o.id === card.id)!; g3.state.players[0].hand.splice(g3.state.players[0].hand.indexOf(hand), 1);
      hand.zone = 'battlefield'; hand.enteredTurn = 1; g3.state.players[0].battlefield.push(hand);
      g3.checkSBA(); await g3.resumeTurn(); await g3.playTurns(1);
      const v = invariants(g3.state); if (v) return { name: def.name, oracleId: def.oracleId, verdict: 'invariant-violation', detail: `on battlefield: ${v}`, actions };
      return { name: def.name, oracleId: def.oracleId, verdict: 'unreachable', detail: 'no castable action in the sandbox (played on the battlefield instead)', actions };
    }
    return { name: def.name, oracleId: def.oracleId, verdict: actions ? 'sandbox-ok' : 'unreachable', actions };
  } catch (e) {
    return { name: def.name, oracleId: def.oracleId, verdict: 'sandbox-throws', detail: (e as Error).message, actions };
  }
}

function withFirstTargets(l: ReturnType<typeof legalActions>[number]) {
  const reqs = l.targetOptions ?? [];
  if (!reqs.length) return l.action;
  return { ...l.action, targets: reqs.map(r => r.options.slice(0, r.count)) } as typeof l.action;
}

import { cloneState } from '../src/engine/clone.js';
function structuredCloneState(s: GameState): GameState { return cloneState(s); }

async function main() {
  const cards = CardDB.shared();
  const rows: Row[] = []; let n = 0; const t0 = Date.now();
  for (const def of cards.all()) {
    if (only && def.name !== only) continue;
    if (!def.fullyParsed) continue;
    if (limit && n >= limit) break;
    n++;
    rows.push(await trial(cards, def));
    if (n % 500 === 0) process.stdout.write(`\r  ${n} cards, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  process.stdout.write('\n');
  const counts: Record<string, number> = {}; for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const problems = rows.filter(r => r.verdict === 'sandbox-throws' || r.verdict === 'invariant-violation');
  const byDetail = new Map<string, { n: number; cards: string[] }>();
  for (const r of problems) { const k = (r.detail ?? '').replace(/\d+/g, '#').slice(0, 80); const e = byDetail.get(k) ?? { n: 0, cards: [] }; e.n++; if (e.cards.length < 5) e.cards.push(r.name); byDetail.set(k, e); }
  const report = { generated_at: new Date().toISOString(), cards: rows.length, counts, seconds: Math.round((Date.now() - t0) / 1000), top_problems: [...byDetail].sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([detail, e]) => ({ n: e.n, detail, cards: e.cards })), problems: problems.slice(0, 2000) };
  fs.mkdirSync('data/master', { recursive: true });
  fs.writeFileSync('data/master/verify-pool.json', JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, problems: undefined }, null, 1));
  if (only) for (const r of rows) console.log(r);
}
main().catch(e => { console.error(e); process.exit(1); });
