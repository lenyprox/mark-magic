// Games-per-second benchmark of the engine: whole games between the bundled 60-card decks (and the first two
// registered Commander decks when present), single-threaded, rollout policy. Writes data/bench/latest.json and a
// dated file, and records games/s in user.db settings (`bench_games_per_s`) so the app can estimate run times.
//   npm run bench:games -- [--games 100] [--seed 7] [--agent rollout|ai] [--no-commander] [--budget 20]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { DATA_DIR, USER_DB } from '../src/config/paths.js';
import { runMatches } from '../src/sim/batch.js';
import { resolveDeckRef } from '../src/sim/deckRef.js';
import type { BatchAgent, MatchResult, MatchSpec } from '../src/sim/types.js';
import { openUserDb, setSetting } from '../src/user/db.js';
import { DeckStore } from '../src/user/decks.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const games = Number(opt('--games', '100')); const seed = Number(opt('--seed', '7')); const agent = opt('--agent', 'rollout') as BatchAgent;
const budget = Number(opt('--budget', agent === 'ai' ? '0.2' : '20'));

const cards = CardDB.shared();
const userDb = fs.existsSync(USER_DB()) ? openUserDb() : null;

interface Bench { name: string; decks: string[]; games: number; ms: number; gamesPerSecond: number; avgTurns: number; draws: number; errors: number; unsimulated: number; winRates: number[] }

async function bench(name: string, refs: string[], format: MatchSpec['format']): Promise<Bench> {
  const decks = refs.map(r => resolveDeckRef(r, cards, userDb).payload);
  const spec: MatchSpec = { id: `bench-${name}`, decks, games, baseSeed: seed, seating: 'rotate', agent, aiSims: 30, format, maxTurns: format === 'commander' ? 40 : 30, mulligans: 'lands', record: 'summary' };
  const r: MatchResult = await runMatches(spec, { yieldEvery: 1000 });
  const a = r.aggregate;
  console.log(`${name.padEnd(12)} ${a.games} games ${(a.ms / 1000).toFixed(1)} s  ${String(a.gamesPerSecond).padStart(6)} games/s  avg ${a.avgTurns} turns  draws ${a.draws}  errors ${a.errors}  unsimulated ${a.unsimulated}  win ${a.byDeck.map(d => (d.winRate.value * 100).toFixed(0) + '%').join(' / ')}`);
  return { name, decks: decks.map(d => d.name), games: a.games, ms: a.ms, gamesPerSecond: a.gamesPerSecond, avgTurns: a.avgTurns, draws: a.draws, errors: a.errors, unsimulated: a.unsimulated, winRates: a.byDeck.map(d => d.winRate.value) };
}

async function main() {
  const results: Bench[] = [];
  results.push(await bench('60-card', ['mono-red-burn', 'mono-green-stompy'], 'freeform'));
  if (!args.includes('--no-commander') && userDb) {
    const commander = new DeckStore(userDb).list().filter(d => d.format === 'commander').slice(0, 2);
    if (commander.length === 2) results.push(await bench('commander', commander.map(d => d.id), 'commander'));
    else console.log('commander    skipped (fewer than two saved Commander decks)');
  }
  const record = { at: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, agent, seed, results };
  const dir = path.join(DATA_DIR(), 'bench'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(record, null, 1));
  fs.writeFileSync(path.join(dir, `bench-${record.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(record, null, 1));
  if (userDb && agent === 'rollout') setSetting(userDb, 'bench_games_per_s', results[0].gamesPerSecond);
  // Commander games run ~10x longer (100-card singleton decks, 27 turns, four times the permanents), so they get a
  // proportionate share of the budget: measured 5.5 games/s against 55 for 60-card on this machine.
  const share = (name: string) => (name === 'commander' ? 0.2 : 1);
  const slow = results.filter(r => r.gamesPerSecond < budget * share(r.name));
  if (slow.length) { console.error(`below budget (${budget} games/s for 60-card, 20% of that for Commander): ${slow.map(r => `${r.name} ${r.gamesPerSecond}`).join(', ')}`); process.exit(1); }
  console.log(`written ${path.join('data', 'bench', 'latest.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
