// Deck persistence in user.db.
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DeckBoard, DeckList } from '../cards/db.js';

export type DeckRole = 'mine' | 'opponent';
export interface DeckCard { board: DeckBoard; oracleId: string; name: string; printingId: string | null; count: number; position: number }
export interface DeckRecord {
  id: string; name: string; format: string; role: DeckRole; source: string; sourceRef: string | null; archetype: string | null; notes: string | null;
  coverPrintingId: string | null; createdAt: string; updatedAt: string; cards: DeckCard[];
}
export interface DeckSummary extends Omit<DeckRecord, 'cards'> { mainCount: number; sideCount: number; colors: string[] }

export interface DeckInput { name: string; format?: string; role?: DeckRole; source?: string; sourceRef?: string | null; archetype?: string | null; notes?: string | null; coverPrintingId?: string | null; cards?: DeckCard[] }

const now = () => new Date().toISOString();

export class DeckStore {
  constructor(private db: Database.Database) {}

  list(role?: DeckRole): DeckSummary[] {
    const rows = this.db.prepare(`SELECT d.*, (SELECT coalesce(sum(count),0) FROM deck_cards c WHERE c.deck_id = d.id AND c.board IN ('main','commander')) AS main_count,
      (SELECT coalesce(sum(count),0) FROM deck_cards c WHERE c.deck_id = d.id AND c.board = 'side') AS side_count
      FROM decks d ${role ? 'WHERE d.role = ?' : ''} ORDER BY d.updated_at DESC`).all(...(role ? [role] : [])) as Record<string, unknown>[];
    return rows.map(r => ({ ...this.rowToDeck(r), mainCount: r.main_count as number, sideCount: r.side_count as number, colors: [] }));
  }

  get(id: string): DeckRecord | null {
    const r = this.db.prepare('SELECT * FROM decks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { ...this.rowToDeck(r), cards: this.cardsOf(id) };
  }

  cardsOf(id: string): DeckCard[] {
    return (this.db.prepare('SELECT board, oracle_id, name, printing_id, count, position FROM deck_cards WHERE deck_id = ? ORDER BY board, position, name').all(id) as Record<string, unknown>[])
      .map(c => ({ board: c.board as DeckBoard, oracleId: c.oracle_id as string, name: c.name as string, printingId: (c.printing_id as string) ?? null, count: c.count as number, position: c.position as number }));
  }

  create(input: DeckInput): DeckRecord {
    const id = randomUUID(); const t = now();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO decks (id, name, format, role, source, source_ref, archetype, notes, cover_printing_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.name, input.format ?? 'casual', input.role ?? 'mine', input.source ?? 'manual', input.sourceRef ?? null, input.archetype ?? null, input.notes ?? null, input.coverPrintingId ?? null, t, t);
      if (input.cards) this.replaceCards(id, input.cards);
    })();
    return this.get(id)!;
  }

  update(id: string, patch: Partial<DeckInput>): DeckRecord | null {
    if (!this.get(id)) return null;
    this.db.transaction(() => {
      const sets: string[] = []; const params: unknown[] = [];
      const map: Record<string, string> = { name: 'name', format: 'format', role: 'role', source: 'source', sourceRef: 'source_ref', archetype: 'archetype', notes: 'notes', coverPrintingId: 'cover_printing_id' };
      for (const [k, col] of Object.entries(map)) if (k in patch) { sets.push(`${col} = ?`); params.push((patch as Record<string, unknown>)[k] ?? null); }
      sets.push('updated_at = ?'); params.push(now());
      this.db.prepare(`UPDATE decks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      if (patch.cards) this.replaceCards(id, patch.cards);
    })();
    return this.get(id);
  }

  private replaceCards(id: string, cards: DeckCard[]) {
    this.db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(id);
    const ins = this.db.prepare('INSERT INTO deck_cards (deck_id, board, oracle_id, name, printing_id, count, position) VALUES (?,?,?,?,?,?,?) ON CONFLICT(deck_id, board, oracle_id) DO UPDATE SET count = count + excluded.count');
    cards.forEach((c, i) => { if (c.count > 0) ins.run(id, c.board, c.oracleId, c.name, c.printingId ?? null, c.count, c.position ?? i); });
  }

  remove(id: string): boolean { return this.db.prepare('DELETE FROM decks WHERE id = ?').run(id).changes > 0; }

  duplicate(id: string, overrides: Partial<DeckInput> = {}): DeckRecord | null {
    const d = this.get(id); if (!d) return null;
    return this.create({ name: overrides.name ?? `${d.name} (copy)`, format: d.format, role: overrides.role ?? d.role, source: d.source, sourceRef: d.sourceRef, archetype: d.archetype, notes: d.notes, coverPrintingId: d.coverPrintingId, cards: d.cards, ...overrides });
  }

  /** The deck as a plain deck list (for the engine's loadDeck). */
  toDeckList(id: string): DeckList | null {
    const d = this.get(id); if (!d) return null;
    return { name: d.name, cards: d.cards.map(c => ({ name: c.name, count: c.count, board: c.board })) };
  }

  private rowToDeck(r: Record<string, unknown>): Omit<DeckRecord, 'cards'> {
    return { id: r.id as string, name: r.name as string, format: r.format as string, role: r.role as DeckRole, source: r.source as string, sourceRef: (r.source_ref as string) ?? null, archetype: (r.archetype as string) ?? null, notes: (r.notes as string) ?? null, coverPrintingId: (r.cover_printing_id as string) ?? null, createdAt: r.created_at as string, updatedAt: r.updated_at as string };
  }
}

export interface GameRecordInput { id?: string; seed: number; myDeckId?: string | null; oppDeckId?: string | null; myDeckName?: string; oppDeckName?: string; myDeckSnapshot: DeckList; oppDeckSnapshot: DeckList; options: unknown; startedAt?: string; finishedAt?: string | null; winner?: number | null; turns?: number | null; log?: string[]; actions?: unknown; reasoning?: unknown }
export interface GameRecord { id: string; seed: number; myDeckId: string | null; oppDeckId: string | null; myDeckName: string | null; oppDeckName: string | null; startedAt: string; finishedAt: string | null; winner: number | null; turns: number | null }

export class GameStore {
  constructor(private db: Database.Database) {}
  save(g: GameRecordInput): string {
    const id = g.id ?? randomUUID();
    this.db.prepare(`INSERT INTO games (id, seed, my_deck_id, opp_deck_id, my_deck_name, opp_deck_name, my_deck_snapshot, opp_deck_snapshot, options, started_at, finished_at, winner, turns, log, actions, reasoning)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, winner = excluded.winner, turns = excluded.turns, log = excluded.log, actions = excluded.actions, reasoning = excluded.reasoning`)
      .run(id, g.seed, g.myDeckId ?? null, g.oppDeckId ?? null, g.myDeckName ?? null, g.oppDeckName ?? null, JSON.stringify(g.myDeckSnapshot), JSON.stringify(g.oppDeckSnapshot), JSON.stringify(g.options ?? {}), g.startedAt ?? now(), g.finishedAt ?? null, g.winner ?? null, g.turns ?? null, g.log ? g.log.join('\n') : null, g.actions ? JSON.stringify(g.actions) : null, g.reasoning ? JSON.stringify(g.reasoning) : null);
    return id;
  }
  list(limit = 50): GameRecord[] {
    return (this.db.prepare('SELECT id, seed, my_deck_id, opp_deck_id, my_deck_name, opp_deck_name, started_at, finished_at, winner, turns FROM games ORDER BY started_at DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map(r => ({ id: r.id as string, seed: r.seed as number, myDeckId: (r.my_deck_id as string) ?? null, oppDeckId: (r.opp_deck_id as string) ?? null, myDeckName: (r.my_deck_name as string) ?? null, oppDeckName: (r.opp_deck_name as string) ?? null, startedAt: r.started_at as string, finishedAt: (r.finished_at as string) ?? null, winner: (r.winner as number) ?? null, turns: (r.turns as number) ?? null }));
  }
  get(id: string): (GameRecord & { myDeckSnapshot: DeckList; oppDeckSnapshot: DeckList; options: unknown; log: string[]; actions: unknown; reasoning: unknown }) | null {
    const r = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { id: r.id as string, seed: r.seed as number, myDeckId: (r.my_deck_id as string) ?? null, oppDeckId: (r.opp_deck_id as string) ?? null, myDeckName: (r.my_deck_name as string) ?? null, oppDeckName: (r.opp_deck_name as string) ?? null, startedAt: r.started_at as string, finishedAt: (r.finished_at as string) ?? null, winner: (r.winner as number) ?? null, turns: (r.turns as number) ?? null,
      myDeckSnapshot: JSON.parse(r.my_deck_snapshot as string), oppDeckSnapshot: JSON.parse(r.opp_deck_snapshot as string), options: JSON.parse((r.options as string) ?? '{}'), log: ((r.log as string) ?? '').split('\n').filter(Boolean), actions: r.actions ? JSON.parse(r.actions as string) : null, reasoning: r.reasoning ? JSON.parse(r.reasoning as string) : null };
  }
  remove(id: string): boolean { return this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes > 0; }
}
