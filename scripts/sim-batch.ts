// Play whole games between decks and report win rates with Wilson intervals. Deterministic for a given seed.
//   npm run sim:batch -- --deck mono-red-burn --deck mono-green-stompy [--games 200] [--seed 1] [--agent rollout|ai]
//                        [--ai-sims 30] [--workers N] [--max-turns 30] [--mulligans none|lands] [--seating rotate|fixed]
//                        [--format commander] [--out data/bench/run.json] [--log] [--verify <result.json>]
// A deck is a decks/*.txt or *.csv file, a saved deck id or a saved deck name. `--verify` replays the games of a
// saved result and reports whether the win counts reproduce.
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { DATA_DIR, USER_DB } from '../src/config/paths.js';
import { runMatches, verifyRerun } from '../src/sim/batch.js';
import { BatchPool, defaultBatchPoolSize } from '../src/sim/batchPool.js';
import { resolveDeckRef } from '../src/sim/deckRef.js';
import { nodeBatchWorker } from '../src/sim/nodeWorker.js';
import type { BatchAgent, MatchResult, MatchSpec, MulliganPolicy, SeatingMode } from '../src/sim/types.js';
import { openUserDb } from '../src/user/db.js';
import os from 'node:os';

const args = process.argv.slice(2);
const opts = (k: string) => { const out: string[] = []; for (let i = 0; i < args.length; i++) if (args[i] === k && args[i + 1] !== undefined) out.push(args[++i]); return out; };
const opt = (k: string, d?: string) => opts(k)[0] ?? d;
const flag = (k: string) => args.includes(k);

const verify = opt('--verify');
const deckRefs = opts('--deck');
if (!verify && deckRefs.length < 2) { console.error('usage: npm run sim:batch -- --deck A --deck B [--games 200] [--seed 1] [--agent rollout|ai] [--workers N] [--out file.json]'); process.exit(2); }

const cards = CardDB.shared();
const userDb = fs.existsSync(USER_DB()) ? openUserDb() : null;

const games = Number(opt('--games', '200')); const seed = Number(opt('--seed', '1'));
const workers = Number(opt('--workers', String(defaultBatchPoolSize(os.cpus().length))));
const agent = (opt('--agent', 'rollout') as BatchAgent);
const spec0: Omit<MatchSpec, 'decks' | 'id'> = {
  games, baseSeed: seed, seating: (opt('--seating', 'rotate') as SeatingMode), agent, aiSims: Number(opt('--ai-sims', '30')),
  format: opt('--format') === 'commander' ? 'commander' : 'freeform', maxTurns: Number(opt('--max-turns', '0')), mulligans: (opt('--mulligans', 'lands') as MulliganPolicy), record: flag('--log') ? 'events' : 'summary',
};

function table(r: MatchResult) {
  const a = r.aggregate;
  console.log(`\n${a.games} games in ${(a.ms / 1000).toFixed(1)} s (${a.gamesPerSecond} games/s), ${a.decided} decided, ${a.draws} draws${a.errors ? `, ${a.errors} errors` : ''}, avg ${a.avgTurns} turns, unsimulated text ${a.unsimulated}`);
  const w = Math.max(...a.byDeck.map(d => d.name.length), 4);
  console.log(`${'deck'.padEnd(w)}  win%   95% CI          W/L/D        play   draw   mull%  ${spec0.format === 'commander' ? 'cmdr≤3 cmdr≤5' : ''}`);
  for (const d of a.byDeck) {
    const ci = d.winRate.ci95 ?? [0, 1];
    console.log(`${d.name.padEnd(w)}  ${(d.winRate.value * 100).toFixed(1).padStart(5)}  [${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]`.padEnd(w + 30) + `  ${`${d.wins}/${d.losses}/${d.draws}`.padEnd(12)} ${`${d.onThePlay.wins}/${d.onThePlay.games}`.padEnd(6)} ${`${d.onTheDraw.wins}/${d.onTheDraw.games}`.padEnd(6)} ${(d.mulliganRate * 100).toFixed(0).padStart(4)}  ${d.commanderCastTurn ? `${(d.commanderCastTurn.byTurn3 * 100).toFixed(0)}%   ${(d.commanderCastTurn.byTurn5 * 100).toFixed(0)}%` : ''}`);
  }
  if (r.best !== null) console.log(`best: ${a.byDeck[r.best].name} (its interval clears every other deck's)`); else console.log('no deck is ahead beyond the 95% intervals');
}

async function main() {
  if (verify) {
    const saved = JSON.parse(fs.readFileSync(verify, 'utf8')) as MatchResult & { deckRefs?: string[] };
    const refs = saved.deckRefs ?? deckRefs;
    if (refs.length < 2) throw new Error('the saved result has no deck references; pass --deck for each deck in order');
    const decks = refs.map(r => resolveDeckRef(r, cards, userDb).payload);
    const ref = saved.derivation.sim!;
    const t0 = Date.now();
    const v = await verifyRerun(ref, decks);
    console.log(`${v.identical ? 'identical' : 'DIFFERENT'}: ${v.successes} successes over ${v.result.aggregate.byDeck[ref.deck].games} games (saved ${ref.successes} / ${ref.n}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(v.identical ? 0 : 1);
  }
  const resolved = deckRefs.map(r => resolveDeckRef(r, cards, userDb));
  for (const r of resolved) { const p = r.payload; if (p.missing.length) console.error(`${p.name}: ${p.missing.length} card(s) not found: ${p.missing.slice(0, 5).join(', ')}`); if (p.partial.length) console.error(`${p.name}: ${p.partial.length} card(s) partially simulated`); }
  const format = spec0.format === 'commander' || resolved.some(r => r.payload.commander.length) ? 'commander' : 'freeform';
  // a turn is one player's turn: pods need proportionally more of them
  if (!spec0.maxTurns) spec0.maxTurns = Math.round((format === 'commander' ? 40 : 30) * resolved.length / 2);
  const spec: MatchSpec = { ...spec0, format, id: `cli-${seed}-${resolved.map(r => r.payload.name.replace(/\W+/g, '-').toLowerCase()).join('-vs-')}`, decks: resolved.map(r => r.payload) };
  console.log(`${spec.decks.map(d => d.name).join(' vs ')}: ${games} games, seed ${seed}, ${agent}, ${workers} worker(s), ${format}`);
  let result: MatchResult;
  const t0 = Date.now();
  let lastLine = '';
  const progress = (done: number, total: number) => { const line = `  ${done}/${total} games, ${((Date.now() - t0) / 1000).toFixed(0)} s`; if (line !== lastLine) { process.stdout.write(`\r${line}`); lastLine = line; } };
  if (workers <= 1) result = await runMatches(spec, { onProgress: (_, done, total) => progress(done, total), yieldEvery: 50 });
  else {
    const pool = new BatchPool(nodeBatchWorker, workers);
    await pool.ready();
    try { result = await pool.run(spec, { onProgress: p => progress(p.done, p.total) }).result; } finally { pool.dispose(); }
  }
  process.stdout.write('\r');
  table(result);
  const out = opt('--out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...result, deckRefs }, null, 1));
    console.log(`written ${out} (${result.games.length} game records; verify with --verify ${out})`);
  }
  if (!out && flag('--json')) console.log(JSON.stringify(result.aggregate, null, 1));
  if (fs.existsSync(path.join(DATA_DIR(), 'bench')) === false) fs.mkdirSync(path.join(DATA_DIR(), 'bench'), { recursive: true });
}

main().catch(e => { console.error(e); process.exit(1); });
