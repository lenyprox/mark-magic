// Ratchet: direct writes to observable state outside the mutation primitives may not grow. Every field listed here
// has a primitive on Game (setTapped, addCounters/setCounters, addMana, gainLife/loseLife/dealDamage*, moveTo,
// emit/note); new code must go through them so the event stream stays complete. Lower a ceiling when you migrate a site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync('src/engine/game.ts', 'utf8');
const count = (re: RegExp) => (src.match(re) ?? []).length;

const CEILINGS: { name: string; re: RegExp; max: number }[] = [
  { name: 'this.log( calls (only emit may write the string log)', re: /this\.log\(/g, max: 1 },
  { name: '.tapped = assignments', re: /\.tapped = /g, max: 5 },
  { name: 'life assignments', re: /\.life (\+=|-=|=) /g, max: 5 },
  { name: 'counter assignments', re: /\.counters(\[[^\]]+\]|\.[a-zA-Z]+) = /g, max: 3 },
  { name: 'manaPool.push', re: /manaPool\.push/g, max: 1 },
  { name: 'graveyard.push (moveTo owns zone moves)', re: /graveyard\.push\(/g, max: 3 },
  { name: 'hand.push', re: /hand\.push\(/g, max: 2 },
];

test('direct state writes in game.ts stay at or below the pinned ceilings', () => {
  const report: string[] = [];
  for (const c of CEILINGS) { const n = count(c.re); report.push(`${c.name}: ${n}/${c.max}`); assert.ok(n <= c.max, `${c.name}: ${n} > ${c.max} — route the new write through a Game primitive`); }
  assert.ok(report.length);
});

// Mechanic families are new code: they get no allowance at all. Every observable change an op makes must go through a
// Game primitive (setTapped / addCounters / gainLife / loseLife / dealDamage* / moveTo / enterBattlefield / addMana /
// attach / changeControl / emit), so the typed event stream stays complete for the UI, the replay and the analysis layer.
const OPS_DIR = 'src/engine/ops';
function opsSources(): { file: string; src: string }[] {
  return fs.readdirSync(OPS_DIR).filter(f => f.endsWith('.ts')).map(f => ({ file: path.join(OPS_DIR, f), src: fs.readFileSync(path.join(OPS_DIR, f), 'utf8') }));
}

test('src/engine/ops does no direct writes to observable state (ceiling 0)', () => {
  const offenders: string[] = [];
  for (const { file, src: s } of opsSources()) {
    for (const c of CEILINGS) { const hits = s.match(c.re) ?? []; for (const h of hits) offenders.push(`${file}: ${c.name} — ${h.trim()}`); }
  }
  assert.deepEqual(offenders, [], 'ops must route every observable change through a Game primitive');
});
