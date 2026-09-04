// Game fuzzer (Phase 8f): play whole seeded games between randomly generated decks, check src/engine/invariants.ts
// after every turn, bucket whatever throws or violates an invariant by signature, and shrink each bucket's first
// game with ddmin down to the handful of cards that still reproduce it. The trial lives in src/verify/fuzz.ts, the
// decks in src/verify/fuzzDecks.ts and the worker pool in src/verify/fuzzWorker.ts; this script owns the command
// line and the report (data/master/fuzz-failures.json).
//
//   npm run fuzz [-- --games N] [--seed S] [--seats 2|4] [--pool parsed|all] [--format freeform|commander]
//                   [--workers W] [--tier all|paper] [--max-turns N] [--shrink-runs N] [--out FILE]
//   npm run fuzz -- --repro <bucketId>     replay the bucket's minimal deck with full events and print the tail
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { parseTier, POOL_TIERS } from '../src/cards/tiers.js';
import { buildDecks, runDecks, type FuzzOptions, type FuzzSeats } from '../src/verify/fuzz.js';
import { parseDeckList, type FuzzFormat, type FuzzPool } from '../src/verify/fuzzDecks.js';
import { runFuzz, type FuzzReport } from '../src/verify/fuzzWorker.js';
import { defaultPoolWorkers } from '../src/verify/poolWorker.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg: string): never => { console.error(msg); process.exit(2); };

/** A numeric flag. An unvalidated `Number(...)` is NaN for a typo, and a NaN worker count builds an empty pool. */
function num(k: string, dflt: number, min = 0): number {
  const raw = opt(k);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) die(`${k} must be a whole number >= ${min} (got ${raw})`);
  return n;
}
function pick<T extends string>(k: string, dflt: T, allowed: readonly T[]): T {
  const raw = opt(k); if (raw === undefined) return dflt;
  if (!(allowed as readonly string[]).includes(raw)) die(`${k} must be one of ${allowed.join(', ')} (got ${raw})`);
  return raw as T;
}

const games = num('--games', 200, 1);
const seed = num('--seed', 1);
const seats = num('--seats', 2, 2) as FuzzSeats;
if (seats !== 2 && seats !== 4) die(`--seats must be 2 or 4 (got ${seats})`);
const pool = pick<FuzzPool>('--pool', 'parsed', ['parsed', 'all']);
const format = pick<FuzzFormat>('--format', 'freeform', ['freeform', 'commander']);
const workers = num('--workers', defaultPoolWorkers(os.cpus().length), 1);
const maxTurns = num('--max-turns', 0) || undefined;
const shrinkRuns = num('--shrink-runs', 200, 1);
const tier = parseTier(opt('--tier')) ?? die(`--tier must be one of ${POOL_TIERS.join(', ')} (got ${opt('--tier')})`);
const out = opt('--out') ?? 'data/master/fuzz-failures.json';
const repro = opt('--repro');

const cfg: FuzzOptions = { seed, seats, format, pool, tier, ...(maxTurns ? { maxTurns } : {}) };

/** Replay one bucket's minimal deck with `events: 'full'` and print the tail of the log plus the failure. */
async function reproduce(bucketId: string) {
  if (!fs.existsSync(out)) die(`--repro: no report at ${out} (run the fuzzer first)`);
  const report = JSON.parse(fs.readFileSync(out, 'utf8')) as FuzzReport;
  const b = report.buckets.find(x => x.id === bucketId) ?? die(`--repro: no bucket ${bucketId} in ${out} (have: ${report.buckets.map(x => x.id).join(', ') || 'none'})`);
  const cards = CardDB.shared();
  // the report's own run settings, not this invocation's flags: the deck only reproduces inside the table it came from
  const opts: FuzzOptions = { seed: report.seed, seats: report.seats, format: report.format, pool: report.pool, tier, ...(maxTurns ? { maxTurns } : {}) };
  const decks = buildDecks(cards, opts, b.first.game);
  decks[b.first.seat] = { ...decks[b.first.seat], cards: parseDeckList(cards, b.minimalDeck) };
  console.log(`bucket ${b.id}  ${b.signature}`);
  console.log(`  game ${b.first.game}, seat ${b.first.seat}, seed ${b.first.seed}, ${report.seats} seats, ${report.format}, pool ${report.pool}`);
  if (b.commander) console.log(`  commander: ${b.commander}`);
  console.log(`  deck: ${b.minimalDeck.join(', ')}`);
  const outcome = await runDecks(decks, opts, b.first.game, { record: 'full' });
  for (const line of (outcome.log ?? []).slice(-40)) console.log(`    | ${line}`);
  if (!outcome.failure) { console.log(`  NO LONGER REPRODUCES (${outcome.turns} turns, winner ${outcome.winner})`); return; }
  console.log(`  ${outcome.failure.kind} on turn ${outcome.failure.turn}: ${outcome.failure.message}`);
  for (const f of outcome.failure.frames) console.log(`    at ${f}`);
  console.log(`  bucket ${outcome.failure.bucket}${outcome.failure.bucket === b.id ? '' : ` (DIFFERENT from ${b.id})`}`);
}

async function main() {
  if (repro) return reproduce(repro);
  const t0 = Date.now();
  let last = 0;
  const report = await runFuzz({ ...cfg, games, at: new Date().toISOString() }, {
    workers, shrinkRuns,
    onProgress: (done, failures) => { if (done - last >= 25) { last = done; process.stdout.write(`\r  ${done}/${games} games, ${failures} failures, ${((Date.now() - t0) / 1000).toFixed(0)} s`); } },
  });
  process.stdout.write('\n');
  const dir = path.dirname(out); if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  const total = report.buckets.reduce((a, b) => a + b.n, 0);
  console.log(`${games} games, ${seats} seats, ${format}, pool ${pool}, seed ${seed}, ${workers} worker(s), ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`${total} failing game(s) in ${report.buckets.length} bucket(s) -> ${out}`);
  for (const b of report.buckets) {
    console.log(`\n  [${b.id}] n=${b.n}  ${b.signature}`);
    console.log(`    first: game ${b.first.game}, seat ${b.first.seat}${b.commander ? `, commander ${b.commander}` : ''}`);
    console.log(`    minimal deck (${b.shrinkRuns} shrink runs${b.shrinkCapped ? ', capped' : ''}): ${b.minimalDeck.join(', ')}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
