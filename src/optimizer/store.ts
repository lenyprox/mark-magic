// Persistence for optimiser runs (user.db, migration 3): runs with progress/checkpoint/report, candidate lists,
// and every game record so any number in a report can be traced back to the games behind it.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { GameRecordLite } from '../sim/types.js';
import type { Candidate, OptimizerCheckpoint, OptimizerProgress, OptimizerReport, OptimizerRun, OptimizerSpec, OptimizerStatus, StoredGame } from './types.js';

const now = () => new Date().toISOString();

export function initialProgress(spec: OptimizerSpec): OptimizerProgress {
  return { status: 'queued', iteration: 0, maxIterations: spec.budget.maxIterations, gamesSimulated: 0, gamesReused: 0, gamesBudget: spec.budget.games, bestWinRate: null, baselineWinRate: null, accepted: 0, message: 'queued', heartbeat: now(), pid: null, startedAt: null, etaSeconds: null };
}

export class OptimizerStore {
  constructor(readonly db: Database.Database) {}

  create(spec: OptimizerSpec, opts: { deckId: string; commander: string | null; id?: string }): OptimizerRun {
    const id = opts.id ?? randomUUID(); const t = now();
    this.db.prepare('INSERT INTO optimizer_runs (id, name, status, deck_id, commander, spec, seed, progress, checkpoint, report, error, created_at, updated_at, finished_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,NULL)')
      .run(id, spec.name, 'queued', opts.deckId, opts.commander, JSON.stringify(spec), spec.seed, JSON.stringify(initialProgress(spec)), t, t);
    return this.get(id)!;
  }

  get(id: string): OptimizerRun | null {
    const r = this.db.prepare('SELECT * FROM optimizer_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }

  list(): OptimizerRun[] {
    return (this.db.prepare('SELECT * FROM optimizer_runs ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(r => this.row(r));
  }

  private row(r: Record<string, unknown>): OptimizerRun {
    const j = <T>(v: unknown): T | null => (typeof v === 'string' && v ? JSON.parse(v) as T : null);
    return { id: r.id as string, name: r.name as string, status: r.status as OptimizerStatus, deckId: r.deck_id as string, commander: (r.commander as string) ?? null, spec: j<OptimizerSpec>(r.spec)!, seed: r.seed as number, progress: j<OptimizerProgress>(r.progress)!, checkpoint: j<OptimizerCheckpoint>(r.checkpoint), report: j<OptimizerReport>(r.report), error: (r.error as string) ?? null, createdAt: r.created_at as string, updatedAt: r.updated_at as string, finishedAt: (r.finished_at as string) ?? null };
  }

  setStatus(id: string, status: OptimizerStatus, error: string | null = null) {
    const finished = status === 'done' || status === 'cancelled' || status === 'failed';
    this.db.prepare('UPDATE optimizer_runs SET status = ?, error = ?, updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?').run(status, error, now(), finished ? 1 : 0, now(), id);
    this.db.prepare("UPDATE optimizer_runs SET progress = json_set(progress, '$.status', ?) WHERE id = ?").run(status, id);
  }
  status(id: string): OptimizerStatus | null { const r = this.db.prepare('SELECT status FROM optimizer_runs WHERE id = ?').get(id) as { status: OptimizerStatus } | undefined; return r?.status ?? null; }

  saveProgress(id: string, progress: OptimizerProgress) { this.db.prepare('UPDATE optimizer_runs SET progress = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(progress), now(), id); }
  saveCheckpoint(id: string, checkpoint: OptimizerCheckpoint) { this.db.prepare('UPDATE optimizer_runs SET checkpoint = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(checkpoint), now(), id); }
  saveReport(id: string, report: OptimizerReport) { this.db.prepare('UPDATE optimizer_runs SET report = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(report), now(), id); }
  remove(id: string): boolean { return this.db.prepare('DELETE FROM optimizer_runs WHERE id = ?').run(id).changes > 0; }

  // ---- candidates
  saveCandidate(runId: string, c: Candidate) {
    this.db.prepare('INSERT INTO optimizer_candidates (run_id, id, list_hash, list, parent_id, swap_out, swap_in, "order", block, iteration, status, games, wins, draws, bulk) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id, id) DO UPDATE SET status = excluded.status, games = excluded.games, wins = excluded.wins, draws = excluded.draws, block = excluded.block')
      .run(runId, c.id, c.listHash, JSON.stringify(c.list), c.parentId, c.swapOut, c.swapIn, JSON.stringify(c.order), c.block, c.iteration, c.status, c.games, c.wins, c.draws, c.bulk ? 1 : 0);
  }
  candidate(runId: string, id: string): Candidate | null {
    const r = this.db.prepare('SELECT * FROM optimizer_candidates WHERE run_id = ? AND id = ?').get(runId, id) as Record<string, unknown> | undefined;
    return r ? this.candidateRow(r) : null;
  }
  candidates(runId: string): Candidate[] {
    return (this.db.prepare('SELECT * FROM optimizer_candidates WHERE run_id = ? ORDER BY iteration, rowid').all(runId) as Record<string, unknown>[]).map(r => this.candidateRow(r));
  }
  private candidateRow(r: Record<string, unknown>): Candidate {
    return { id: r.id as string, list: JSON.parse(r.list as string), listHash: r.list_hash as string, parentId: (r.parent_id as string) ?? null, swapOut: (r.swap_out as string) ?? null, swapIn: (r.swap_in as string) ?? null, order: JSON.parse(r.order as string), block: r.block as number, iteration: r.iteration as number, status: r.status as Candidate['status'], games: r.games as number, wins: r.wins as number, draws: r.draws as number, bulk: !!(r.bulk as number) };
  }

  // ---- games
  saveGames(runId: string, candidateId: string, games: (GameRecordLite & { opponent: string; reusedFrom: string | null })[]) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO optimizer_games (run_id, candidate_id, game_index, seed, seat_order, opponent, winner, first_seat, turns, mulligans, opening_hand, seen, first_commander_cast_turn, loss_reason, unsimulated, reused_from, error, ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    this.db.transaction(() => {
      for (const g of games) ins.run(runId, candidateId, g.index, g.seed, JSON.stringify(g.seatOrder), g.opponent, g.winner, g.firstSeat, g.turns, JSON.stringify(g.mulligans), JSON.stringify(g.openingHand), JSON.stringify(g.seen), JSON.stringify(g.firstCommanderCastTurn), JSON.stringify(g.lossReason), g.unsimulated, g.reusedFrom, g.error ?? null, g.ms);
    })();
  }
  games(runId: string, candidateId: string): StoredGame[] {
    return (this.db.prepare('SELECT * FROM optimizer_games WHERE run_id = ? AND candidate_id = ? ORDER BY game_index').all(runId, candidateId) as Record<string, unknown>[]).map(r => ({
      candidateId: r.candidate_id as string, index: r.game_index as number, seed: r.seed as number, seatOrder: JSON.parse(r.seat_order as string), opponent: r.opponent as string, winner: (r.winner as number) ?? null, firstSeat: r.first_seat as number, turns: r.turns as number,
      mulligans: JSON.parse(r.mulligans as string), openingHand: JSON.parse(r.opening_hand as string), seen: JSON.parse(r.seen as string), firstCommanderCastTurn: JSON.parse(r.first_commander_cast_turn as string), lossReason: JSON.parse(r.loss_reason as string),
      unsimulated: r.unsimulated as number, reusedFrom: (r.reused_from as string) ?? null, error: (r.error as string) ?? undefined, ms: r.ms as number,
    }));
  }
  gameCount(runId: string): { simulated: number; reused: number } {
    const r = this.db.prepare('SELECT sum(CASE WHEN reused_from IS NULL THEN 1 ELSE 0 END) AS s, sum(CASE WHEN reused_from IS NULL THEN 0 ELSE 1 END) AS r FROM optimizer_games WHERE run_id = ?').get(runId) as { s: number | null; r: number | null };
    return { simulated: r.s ?? 0, reused: r.r ?? 0 };
  }
}
