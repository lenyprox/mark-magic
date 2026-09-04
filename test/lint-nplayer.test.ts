// Two-player leftovers may not creep back into the engine, the AI or the batch runner: everything goes through
// players.ts (alive / opponentsOf / primaryOpponent / nextInTurnOrder / apnapOrder). The analysis layer still uses
// opponentOf for the 2-player analysis panel; its count is pinned so it can only go down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function files(dir: string): string[] { return fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => path.join(dir, f)); }
// `=== 0 ? 1 : 0` is the hand-rolled "the other seat": correct only with two players (it put the wrong seat's
// blockers into a three-player scenario once). Use primaryOpponent / opponentsOf.
const re = /opponentOf\(|players\[[01]\]|\[0, 1\] as PlayerId|\[Player, Player\]|\[Agent, Agent\]|=== 0 \? 1 : 0/g;
const count = (f: string) => (fs.readFileSync(f, 'utf8').match(re) ?? []).length;

test('engine, AI, sim, play and verify code have no two-player assumptions', () => {
  const offenders: string[] = [];
  for (const f of [...files('src/engine'), ...files('src/engine/agents'), ...files('src/ai'), ...files('src/sim'), ...files('src/play'), ...files('src/verify')]) {
    if (f.endsWith('state.ts') || f.endsWith('characteristics.ts')) continue; // the deprecated definition and the 2-seat fast path
    const n = count(f); if (n) offenders.push(`${f}: ${n}`);
  }
  assert.deepEqual(offenders, []);
});

test('analysis layer two-player sites only go down (ratchet)', () => {
  const total = files('src/analysis').reduce((a, f) => a + count(f), 0);
  assert.ok(total <= 12, `analysis two-player sites: ${total} (ceiling 12)`);
});
