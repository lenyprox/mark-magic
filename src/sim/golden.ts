// Golden event streams: a small set of fixed matches whose per-game fingerprint is committed under
// test/fixtures/golden. A fingerprint is deliberately coarse (winner, turns, a hash of the event vector, a hash of
// the log and one hash per turn) so the fixtures stay tiny while still pinning the whole event stream: any engine
// change that moves a single log line changes a turn hash, and the turn hashes say *which* turn moved first.
// The cases and the replay live here (typechecked, importable by the test); scripts/golden.ts is the CLI around them.
import fs from 'node:fs';
import path from 'node:path';
import type { CardDB } from '../cards/db.js';
import { projectRoot } from '../config/paths.js';
import { runMatches } from './batch.js';
import { resolveDeckRef } from './deckRef.js';
import type { GameRecordLite, MatchSpec } from './types.js';

/** FNV-1a over a string, as eight lowercase hex digits. Same mixing as deckHash, kept local so this file stands alone. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface GoldenCase {
  name: string;
  /** Deck references (decks/*.txt), in seat-zero-first order. */
  decks: string[];
  games: number;
  seed: number;
  maxTurns: number;
}

/** The committed cases. Two heads-up pairs plus a three-player pod; all rollout, all `record: 'events'`. */
export const GOLDEN_CASES: GoldenCase[] = [
  { name: 'mono-red-burn-vs-mono-green-stompy', decks: ['mono-red-burn', 'mono-green-stompy'], games: 30, seed: 11, maxTurns: 30 },
  { name: 'ub-control-vs-wu-fliers', decks: ['ub-control', 'wu-fliers'], games: 30, seed: 12, maxTurns: 30 },
  // a turn is one player's turn, so a pod needs proportionally more of them (the sim:batch rule: 30 * seats / 2)
  { name: 'mono-red-burn-vs-mono-green-stompy-vs-ub-control', decks: ['mono-red-burn', 'mono-green-stompy', 'ub-control'], games: 20, seed: 13, maxTurns: 45 },
];

/** One game's fingerprint. `turnHashes[k]` covers turn k's log lines; index 0 is everything before turn 1 (setup). */
export interface GoldenGame { index: number; seed: number; winner: number | null; turns: number; eventVector: string; logHash: string; turnHashes: string[] }
export interface GoldenFixture { case: GoldenCase; games: GoldenGame[] }

export function goldenSpec(c: GoldenCase, cards: CardDB): MatchSpec {
  const decks = c.decks.map(r => resolveDeckRef(r, cards, null).payload);
  return { id: `golden-${c.name}`, decks, games: c.games, baseSeed: c.seed, seating: 'rotate', agent: 'rollout', format: 'freeform', maxTurns: c.maxTurns, mulligans: 'lands', record: 'events' };
}

/**
 * Split a game log into per-turn segments. The engine writes `\n=== Turn N: <player> ===` at every turn, and turn
 * numbers run 1, 2, 3…, so segment k is turn k and segment 0 is the pre-game (shuffle, mulligans, opening draws).
 */
export function turnSegments(log: string[]): { turn: number; lines: string[] }[] {
  const out: { turn: number; lines: string[] }[] = [{ turn: 0, lines: [] }];
  for (const line of log) {
    const m = /^\n?=== Turn (\d+):/.exec(line);
    if (m) out.push({ turn: Number(m[1]), lines: [line] }); else out[out.length - 1].lines.push(line);
  }
  return out;
}

export function fingerprint(rec: GameRecordLite): GoldenGame {
  const counts = Object.entries(rec.eventCounts ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const log = rec.log ?? [];
  return {
    index: rec.index, seed: rec.seed, winner: rec.winner, turns: rec.turns,
    eventVector: fnv1a(counts.map(([k, v]) => `${k}=${v}`).join(',')),
    logHash: fnv1a(log.join('\n')),
    turnHashes: turnSegments(log).map(t => fnv1a(t.lines.join('\n'))),
  };
}

/** Replay a case and return both the fingerprints and the logs (the logs are what a mismatch report quotes). */
export async function replayGolden(c: GoldenCase, cards: CardDB): Promise<{ games: GoldenGame[]; logs: string[][] }> {
  const result = await runMatches(goldenSpec(c, cards), { yieldEvery: 1000 });
  return { games: result.games.map(fingerprint), logs: result.games.map(r => r.log ?? []) };
}

export interface GoldenDiff {
  index: number;
  kind: 'changed' | 'added' | 'removed';
  /** What differs, in fixture-vs-replay form. */
  fields: string[];
  /** The first turn whose log hash differs (0 = pre-game), or null when only non-log fields moved. */
  turn: number | null;
  /** The first ten log lines of that turn in the replay. */
  lines: string[];
}

export function compareGolden(fixture: GoldenGame[], fresh: GoldenGame[], logs: string[][]): GoldenDiff[] {
  const byIndex = new Map(fixture.map(g => [g.index, g]));
  const diffs: GoldenDiff[] = [];
  fresh.forEach((now, k) => {
    const was = byIndex.get(now.index);
    if (!was) { diffs.push({ index: now.index, kind: 'added', fields: ['not in the fixture'], turn: null, lines: [] }); return; }
    byIndex.delete(now.index);
    const fields: string[] = [];
    if (was.winner !== now.winner) fields.push(`winner ${was.winner} -> ${now.winner}`);
    if (was.turns !== now.turns) fields.push(`turns ${was.turns} -> ${now.turns}`);
    if (was.eventVector !== now.eventVector) fields.push(`eventVector ${was.eventVector} -> ${now.eventVector}`);
    if (was.logHash !== now.logHash) fields.push(`logHash ${was.logHash} -> ${now.logHash}`);
    if (!fields.length) return;
    const len = Math.max(was.turnHashes.length, now.turnHashes.length);
    let turn: number | null = null;
    for (let t = 0; t < len; t++) if (was.turnHashes[t] !== now.turnHashes[t]) { turn = t; break; }
    const seg = turn === null ? undefined : turnSegments(logs[k] ?? []).find(s => s.turn === turn);
    diffs.push({ index: now.index, kind: 'changed', fields, turn, lines: (seg?.lines ?? []).slice(0, 10).map(l => l.replace(/^\n/, '')) });
  });
  for (const gone of byIndex.values()) diffs.push({ index: gone.index, kind: 'removed', fields: ['no longer replayed'], turn: null, lines: [] });
  return diffs.sort((a, b) => a.index - b.index);
}

export const GOLDEN_DIR = () => path.join(projectRoot(), 'test', 'fixtures', 'golden');
export const goldenPath = (name: string) => path.join(GOLDEN_DIR(), `${name}.json`);

export function readGolden(name: string): GoldenFixture | null {
  const f = goldenPath(name);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as GoldenFixture) : null;
}

export function writeGolden(c: GoldenCase, games: GoldenGame[]): string {
  const f = goldenPath(c.name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ case: c, games } satisfies GoldenFixture, null, 1)}\n`);
  return f;
}
