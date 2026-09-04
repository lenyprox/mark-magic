// Create and run a deck optimisation from the command line (inline, with worker threads).
//   npm run optimize -- --deck "Varina" --field "Doran" [--field "Azula"] [--preset quick|standard|deep] [--seed 1]
//                       [--players 2|4] [--pool owned|owned+bulk] [--max-unowned 5] [--lock "Sol Ring"] [--ban "X"]
//                       [--workers N] [--games N] [--iterations N] [--name "..."] [--apply new|update]
// Decks are saved-deck ids or names (see sim:batch). The report is printed and kept in user.db (see /optimize).
import os from 'node:os';
import { CardDB } from '../src/cards/db.js';
import { CardQueryDB } from '../src/cards/query.js';
import { USER_DB } from '../src/config/paths.js';
import { runOptimizer } from '../src/optimizer/runner.js';
import { OptimizerStore } from '../src/optimizer/store.js';
import { PRESETS, type OptimizerSpec } from '../src/optimizer/types.js';
import { resolveDeckRef } from '../src/sim/deckRef.js';
import { BatchPool, defaultBatchPoolSize } from '../src/sim/batchPool.js';
import { nodeBatchWorker } from '../src/sim/nodeWorker.js';
import { openUserDb } from '../src/user/db.js';
import { DeckStore } from '../src/user/decks.js';

const args = process.argv.slice(2);
const opts = (k: string) => { const out: string[] = []; for (let i = 0; i < args.length; i++) if (args[i] === k && args[i + 1] !== undefined) out.push(args[++i]); return out; };
const opt = (k: string, d?: string) => opts(k)[0] ?? d;

const deckRef = opt('--deck'); const fieldRefs = opts('--field');
if (!deckRef || !fieldRefs.length) { console.error('usage: npm run optimize -- --deck <saved deck> --field <saved deck> [...]'); process.exit(2); }

const cards = CardDB.shared();
const db = openUserDb(USER_DB());
const decks = new DeckStore(db);
const seed = resolveDeckRef(deckRef, cards, db);
const seedDeckId = seed.payload.deckId; if (!seedDeckId) { console.error('the seed deck must be a saved deck (import it first)'); process.exit(2); }
const field = fieldRefs.map(r => { const p = resolveDeckRef(r, cards, db).payload; if (!p.deckId) throw new Error(`field deck ${r} must be a saved deck`); return { kind: 'deck' as const, deckId: p.deckId, name: p.name, weight: 1 }; });
const preset = (opt('--preset', 'quick') as keyof typeof PRESETS);
const budget = { ...PRESETS[preset] };
if (opt('--games')) budget.games = Number(opt('--games')); if (opt('--iterations')) budget.maxIterations = Number(opt('--iterations'));
const deckRecord = decks.get(seedDeckId)!;
const format: OptimizerSpec['format'] = /^(commander|edh|cedh|brawl)$/i.test(deckRecord.format) || seed.payload.commander.length ? 'commander' : 'freeform';
const players = Number(opt('--players', '2')) as 2 | 3 | 4;
const spec: OptimizerSpec = {
  name: opt('--name') ?? `${deckRecord.name} vs ${field.map(f => f.name).join(', ')}`, seed: Number(opt('--seed', '1')), commander: seed.payload.commander.length ? seed.payload.defs[seed.payload.commander[0].key]?.name ?? null : null,
  seedDeckId, format, pool: (opt('--pool', 'owned') as OptimizerSpec['pool']), maxUnowned: Number(opt('--max-unowned', '5')), field, players, agent: 'rollout',
  maxTurns: Number(opt('--max-turns', String(Math.round((format === 'commander' ? 60 : 30) * players / 2)))), mulligans: 'lands', budget: { ...budget, validateWithAi: false },
  constraints: { lands: opt('--lands') ? Number(opt('--lands')) : null, lockIn: opts('--lock'), ban: opts('--ban'), onlyFullyParsedSwapIns: args.includes('--parsed-only') },
};
const store = new OptimizerStore(db);
const run = store.create(spec, { deckId: seedDeckId, commander: spec.commander });
const workers = Number(opt('--workers', String(defaultBatchPoolSize(os.cpus().length))));
console.log(`run ${run.id}: ${spec.name} (${preset}: ${budget.games} games, ${budget.maxIterations} iterations, block ${budget.blockSize}), ${workers} worker(s)`);

async function main() {
  let query: CardQueryDB | null = null;
  try { const q = new CardQueryDB(cards.db); if (q.hasWebIndex()) { q.attachUser(USER_DB()); query = q; } } catch { query = null; }
  const pool = workers > 1 ? new BatchPool(nodeBatchWorker, workers) : null; if (pool) await pool.ready();
  let lastLine = '';
  const t0 = Date.now();
  try {
    const report = await runOptimizer({ db, cards, query, pool, pid: process.pid, log: m => { process.stdout.write(`\r${' '.repeat(lastLine.length)}\r${m}\n`); lastLine = ''; }, onProgress: p => { const line = `  it ${p.iteration}/${p.maxIterations} · ${p.gamesSimulated} sim + ${p.gamesReused} reused · best ${p.bestWinRate === null ? '–' : (p.bestWinRate * 100).toFixed(1) + '%'} · ${p.message}`; if (line !== lastLine) { process.stdout.write(`\r${' '.repeat(lastLine.length)}\r${line}`); lastLine = line; } } }, run.id);
    process.stdout.write('\n');
    if (!report) { console.log('stopped'); return; }
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    console.log(`\nbaseline ${pct(report.baseline.winRate.value)} [${report.baseline.winRate.ci95?.map(pct).join(', ')}] over ${report.baseline.games} games`);
    console.log(`best     ${pct(report.best.winRate.value)} [${report.best.winRate.ci95?.map(pct).join(', ')}] over ${report.best.games} games${report.best.paired ? ` · paired delta ${pct(report.best.paired.delta)} [${report.best.paired.ci95.map(pct).join(', ')}] on ${report.best.paired.n} games` : ''}`);
    if (report.best.changes.length) { console.log('changes:'); for (const c of report.best.changes) console.log(`  − ${c.out}  → + ${c.in}${c.bulk ? '   (check your bulk)' : ''}`); } else console.log('no swap improved the deck beyond noise');
    console.log(`swaps tried ${report.swaps.length}, accepted ${report.swaps.filter(s => s.comparison.accepted).length}; ${report.budget.gamesSimulated} games simulated, ${report.budget.gamesReused} reused, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (report.keepGuidance.length) { console.log('keep guidance:'); for (const k of report.keepGuidance.slice(0, 6)) console.log(`  ${k.description}: ${pct(k.winRate.value)} over ${k.games}`); }
    if (report.winningPatterns.length) { console.log('patterns:'); for (const p of report.winningPatterns.slice(0, 6)) console.log(`  ${p.description}: lift ${pct(p.lift)} [${p.ci95.map(pct).join(', ')}] (${p.games} games)`); }
    if (report.bulkCheck.length) { console.log('check your bulk for:'); for (const b of report.bulkCheck) console.log(`  ${b.name} (${b.reason})`); }
    const apply = opt('--apply');
    if (apply && report.best.changes.length) {
      const cardsOut = report.best.list.map((e, i) => ({ board: 'main' as const, oracleId: cards.get(e.name)!.oracleId, name: e.name, printingId: null, count: e.count, position: i }));
      if (spec.commander) cardsOut.push({ board: 'commander' as unknown as 'main', oracleId: cards.get(spec.commander)!.oracleId, name: spec.commander, printingId: null, count: 1, position: 0 });
      if (apply === 'update') { decks.update(seedDeckId!, { cards: cardsOut }); console.log(`updated deck ${deckRecord.name}`); }
      else { const d = decks.create({ name: `${deckRecord.name} (optimised)`, format: deckRecord.format, role: deckRecord.role, source: 'optimizer', sourceRef: run.id, cards: cardsOut }); console.log(`saved as ${d.name} (${d.id})`); }
    }
  } finally { pool?.dispose(); db.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });
