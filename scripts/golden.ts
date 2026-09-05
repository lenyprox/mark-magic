// Golden event streams: replay the fixed matches in src/sim/golden.ts and compare each game's fingerprint with the
// committed fixture under test/fixtures/golden. `check` exits 1 on any change and names, per changed game, the first
// turn that differs and its first ten log lines; `accept` rewrites the fixtures and prints a commit-message summary.
//   npm run golden:check [-- --case <name>]
//   npm run golden:accept [-- --case <name>]
import { CardDB } from '../src/cards/db.js';
import { compareGolden, GOLDEN_CASES, readGolden, replayGolden, writeGolden, type GoldenCase, type GoldenDiff } from '../src/sim/golden.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const accept = args.includes('--accept');
const only = opt('--case');
// --case takes an exact name when there is one, else every case whose name contains the argument
const cases: GoldenCase[] = !only ? GOLDEN_CASES : GOLDEN_CASES.some(c => c.name === only) ? GOLDEN_CASES.filter(c => c.name === only) : GOLDEN_CASES.filter(c => c.name.includes(only));
if (!cases.length) { console.error(`no golden case matches "${only}" (have: ${GOLDEN_CASES.map(c => c.name).join(', ')})`); process.exit(2); }

function report(c: GoldenCase, diffs: GoldenDiff[]) {
  for (const d of diffs) {
    if (d.kind !== 'changed') { console.log(`  game ${d.index}: ${d.kind} (${d.fields.join('; ')})`); continue; }
    const where = d.turn === null ? '' : `; first differing turn ${d.turn === 0 ? '0 (pre-game)' : d.turn}`;
    console.log(`  game ${d.index}: ${d.fields.join('; ')}${where}`);
    for (const l of d.lines) console.log(`      | ${l}`);
  }
  if (diffs.length) console.log(`  (replay it with: npm run sim:batch -- ${c.decks.map(d => `--deck ${d}`).join(' ')} --games ${c.games} --seed ${c.seed} --max-turns ${c.maxTurns} --workers 1 --log)`);
}

/** One line per case, in the form a commit message wants. */
function summarize(c: GoldenCase, diffs: GoldenDiff[], total: number): string {
  const flips = diffs.filter(d => d.fields.some(f => f.startsWith('winner'))).length;
  const turns = diffs.map(d => d.turn).filter((t): t is number => t !== null).sort((a, b) => a - b);
  return `${c.name}: ${diffs.length}/${total} games changed${flips ? `, ${flips} flipped winner` : ''}${turns.length ? `, earliest differing turn ${turns[0]}` : ''}`;
}

async function main() {
  const cards = CardDB.shared();
  let changed = 0; let missing = 0;
  const summary: string[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    const { games, logs } = await replayGolden(c, cards);
    const fixture = readGolden(c.name);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!fixture) {
      missing++;
      if (!accept) { console.log(`${c.name}: NO FIXTURE (${c.games} games, seed ${c.seed}) — run npm run golden:accept`); continue; }
      writeGolden(c, games);
      summary.push(`${c.name}: new fixture, ${games.length} games (seed ${c.seed}, ${c.decks.join(' vs ')})`);
      console.log(`${c.name}: written, ${games.length} games in ${secs} s`);
      continue;
    }
    const diffs = compareGolden(fixture.games, games, logs);
    if (!diffs.length) { console.log(`${c.name}: ${games.length} games, 0 changed (${secs} s)`); continue; }
    changed += diffs.length;
    console.log(`${c.name}: ${games.length} games, ${diffs.length} changed (${secs} s)`);
    report(c, diffs);
    if (accept) { writeGolden(c, games); summary.push(summarize(c, diffs, games.length)); }
  }
  if (accept) {
    console.log(`\naccepted — commit message summary:\n${summary.length ? summary.map(s => `  - ${s}`).join('\n') : '  - no golden changed'}`);
    return;
  }
  if (missing) { console.error(`${missing} golden fixture(s) missing; run npm run golden:accept`); process.exit(1); }
  if (changed) { console.error(`${changed} golden game(s) changed; review the diff above, then npm run golden:accept`); process.exit(1); }
  console.log('goldens reproduce exactly');
}

main().catch(e => { console.error(e); process.exit(1); });
