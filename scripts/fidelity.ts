// Fidelity ratchet: how much card text the engine still plays inert. Fixed pairings of the owner's Commander decks
// are replayed with per-clause tracking; the metric is hits per game, and test/fixtures/fidelity.json holds a ceiling
// per pairing. `check` fails when a pairing drifts more than 10% above its ceiling (a regression: newly inert text);
// `accept` ratchets the ceilings down to what was just measured and never raises one unless --force says so.
// Minutes, not seconds — this is a verify:deep step, not part of npm test.
//   npm run fidelity:check [-- --games 60]
//   npm run fidelity:accept [-- --force]
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../src/cards/db.js';
import { projectRoot, USER_DB } from '../src/config/paths.js';
import { runMatches } from '../src/sim/batch.js';
import { resolveDeckRef } from '../src/sim/deckRef.js';
import type { MatchAggregate, MatchSpec } from '../src/sim/types.js';
import { openUserDb } from '../src/user/db.js';
import { DeckStore } from '../src/user/decks.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const accept = args.includes('--accept');
const force = args.includes('--force');
const games = Number(opt('--games', '60'));
/** A pairing may sit 10% above its ceiling before it counts as a regression (games are seeded, so this is slack for deck edits). */
const TOLERANCE = 1.10;
/** The bench's Commander turn cap (bench-games.ts), so a fidelity run and the benchmark see the same games. */
const MAX_TURNS = 40;

interface Clause { card: string; clause: string; hits: number; games: number }
interface Pairing { name: string; decks: string[]; seed: number; games: number; hitsPerGame: number; ceiling: number; topClauses: Clause[] }
interface Fixture { pairings: Pairing[] }

const FIXTURE = () => path.join(projectRoot(), 'test', 'fixtures', 'fidelity.json');
const round = (x: number) => Math.round(x * 1000) / 1000;

/** The fixed pairings: six Commander decks by name in three pairs, plus a pod of the first four. Seeds 21..24. */
function pairings(names: string[]): { name: string; decks: string[]; seed: number }[] {
  const out: { name: string; decks: string[]; seed: number }[] = [];
  for (let i = 0; i + 1 < 6 && i + 1 < names.length; i += 2) out.push({ name: `${names[i]} vs ${names[i + 1]}`, decks: [names[i], names[i + 1]], seed: 21 + i / 2 });
  if (names.length >= 4) out.push({ name: `pod: ${names.slice(0, 4).join(', ')}`, decks: names.slice(0, 4), seed: 24 });
  return out;
}

function show(p: Pairing, verdict: string) {
  console.log(`${p.name}\n  ${p.hitsPerGame} hits/game over ${p.games} games (ceiling ${p.ceiling}) — ${verdict}`);
  for (const c of p.topClauses.slice(0, 5)) console.log(`    ${String(c.hits).padStart(5)} hits ${String(c.games).padStart(3)} games  ${c.card}: ${c.clause.length > 80 ? `${c.clause.slice(0, 77)}...` : c.clause}`);
}

async function main() {
  if (!fs.existsSync(USER_DB())) { console.log('fidelity: skipped — no user.db'); return; }
  const userDb = openUserDb();
  const decks = new DeckStore(userDb).list().filter(d => d.format === 'commander' && d.role === 'mine').sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (decks.length < 2) { console.log(`fidelity: skipped — user.db has ${decks.length} Commander deck(s) of my own (need at least two)`); return; }
  if (decks.length !== 6) console.log(`note: expected six Commander decks, found ${decks.length} — pairing what is there`);
  const cards = CardDB.shared();
  const saved: Fixture = fs.existsSync(FIXTURE()) ? (JSON.parse(fs.readFileSync(FIXTURE(), 'utf8')) as Fixture) : { pairings: [] };
  const out: Pairing[] = []; const failures: string[] = [];

  for (const p of pairings(decks.map(d => d.name))) {
    const payloads = p.decks.map(n => resolveDeckRef(decks.find(d => d.name === n)!.id, cards, userDb).payload);
    const spec: MatchSpec = { id: `fidelity-${p.seed}`, decks: payloads, games, baseSeed: p.seed, seating: 'rotate', agent: 'rollout', format: 'commander', maxTurns: MAX_TURNS, mulligans: 'lands', record: 'summary', trackUnsimulated: true };
    const t0 = Date.now();
    const a: MatchAggregate = (await runMatches(spec, { yieldEvery: 1000 })).aggregate;
    const hitsPerGame = round(a.unsimulated / Math.max(1, a.games));
    const was = saved.pairings.find(x => x.name === p.name);
    const ceiling = was?.ceiling ?? hitsPerGame;
    const row: Pairing = { name: p.name, decks: p.decks, seed: p.seed, games: a.games, hitsPerGame, ceiling, topClauses: a.topUnsimulated.slice(0, 15) };
    const over = hitsPerGame > ceiling * TOLERANCE;
    if (accept) {
      row.ceiling = force ? hitsPerGame : Math.min(ceiling, hitsPerGame);
      show(row, `${was ? `ceiling ${ceiling} -> ${row.ceiling}` : 'new pairing'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    } else {
      if (over) failures.push(`${p.name}: ${hitsPerGame} hits/game > ceiling ${ceiling} x ${TOLERANCE}`);
      show(row, `${over ? 'REGRESSED' : was ? 'ok' : 'no ceiling yet (run fidelity:accept)'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    out.push(row);
  }

  if (accept) {
    fs.mkdirSync(path.dirname(FIXTURE()), { recursive: true });
    fs.writeFileSync(FIXTURE(), `${JSON.stringify({ pairings: out } satisfies Fixture, null, 1)}\n`);
    console.log(`\nwritten ${path.relative(projectRoot(), FIXTURE())} — ceilings ${force ? 'set to the measured values (--force)' : 'lowered where the run improved; never raised'}`);
    return;
  }
  console.log(`\n${out.length} pairing(s), ${failures.length} over ceiling`);
  for (const f of failures) console.log(`  ${f}`);
  if (failures.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
