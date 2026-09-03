// Persistence for the metagame layer: meta_events, meta_decklists(+cards), meta_archetypes(+cards), meta_card_stats, meta_sync_log.
import type Database from 'better-sqlite3';
import type { ComputedArchetype } from './cluster.js';
import type { ArchetypeCardStat, ArchetypeSummary, CardRating, DecklistRecord, MetaBoard, MetaSource, NormalizedCard, NormalizedDecklist, NormalizedEvent } from './types.js';

const now = () => new Date().toISOString();
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export const eventRowId = (source: MetaSource, sourceId: string) => `${source}:${sourceId}`;
export const decklistRowId = (source: MetaSource, sourceId: string) => `${source}:${sourceId}`;

export interface SyncLogEntry { source: MetaSource | 'cluster'; format: string; startedAt: string; finishedAt: string; ok: boolean; message: string }

export class MetaStore {
  constructor(readonly db: Database.Database) {}

  // --- events & decklists ---------------------------------------------------------------------------------------------

  upsertEvents(events: NormalizedEvent[]): number {
    const stmt = this.db.prepare(`INSERT INTO meta_events (id, source, source_id, name, format, date, players, url, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source, source_id) DO UPDATE SET name = excluded.name, format = excluded.format, date = excluded.date, players = excluded.players, url = excluded.url, fetched_at = excluded.fetched_at`);
    const t = now();
    return this.db.transaction(() => { let n = 0; for (const e of events) { stmt.run(eventRowId(e.source, e.sourceId), e.source, e.sourceId, e.name, e.format, e.date, e.players, e.url, t); n++; } return n; })();
  }

  /** Insert or replace decklists (and their cards) in one transaction. Existing archetype assignments are preserved. */
  upsertDecklists(lists: NormalizedDecklist[]): { inserted: number; updated: number } {
    const exists = this.db.prepare('SELECT 1 FROM meta_decklists WHERE id = ?');
    const ins = this.db.prepare(`INSERT INTO meta_decklists (id, event_id, source, source_id, archetype, archetype_id, format, player, placement, wins, losses, draws, deck_size, date, url, fetched_at)
      VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source, source_id) DO UPDATE SET event_id = excluded.event_id, archetype = coalesce(excluded.archetype, meta_decklists.archetype), format = excluded.format, player = excluded.player,
        placement = excluded.placement, wins = excluded.wins, losses = excluded.losses, draws = excluded.draws, deck_size = excluded.deck_size, date = excluded.date, url = excluded.url, fetched_at = excluded.fetched_at`);
    const delCards = this.db.prepare('DELETE FROM meta_decklist_cards WHERE decklist_id = ?');
    const insCard = this.db.prepare('INSERT INTO meta_decklist_cards (decklist_id, board, name, oracle_id, count) VALUES (?,?,?,?,?) ON CONFLICT(decklist_id, board, name) DO UPDATE SET count = meta_decklist_cards.count + excluded.count, oracle_id = coalesce(excluded.oracle_id, meta_decklist_cards.oracle_id)');
    const t = now();
    return this.db.transaction(() => {
      let inserted = 0, updated = 0;
      for (const d of lists) {
        const id = decklistRowId(d.source, d.sourceId);
        if (exists.get(id)) updated++; else inserted++;
        const eventId = d.eventSourceId ? eventRowId(d.source, d.eventSourceId) : null;
        ins.run(id, eventId, d.source, d.sourceId, d.archetype, d.format, d.player, d.placement, d.wins, d.losses, d.draws, d.deckSize, d.date, d.url, t);
        delCards.run(id);
        for (const c of d.cards) insCard.run(id, c.board, c.name, c.oracleId, c.count);
      }
      return { inserted, updated };
    })();
  }

  private rowToDecklist(r: Record<string, unknown>, cards: NormalizedCard[]): DecklistRecord {
    return {
      id: r.id as string, eventId: asStr(r.event_id), eventName: asStr(r.event_name), source: r.source as MetaSource, sourceId: (r.source_id as string) ?? '', archetype: asStr(r.archetype), archetypeId: asStr(r.archetype_id),
      format: r.format as string, player: asStr(r.player), placement: asNum(r.placement), wins: asNum(r.wins), losses: asNum(r.losses), draws: asNum(r.draws),
      deckSize: asNum(r.deck_size) ?? cards.filter(c => c.board !== 'side').reduce((a, c) => a + c.count, 0), date: asStr(r.date), url: asStr(r.url), fetchedAt: r.fetched_at as string, cards,
    };
  }

  cardsOf(decklistId: string): NormalizedCard[] {
    return (this.db.prepare('SELECT board, name, oracle_id, count FROM meta_decklist_cards WHERE decklist_id = ? ORDER BY board, name').all(decklistId) as Record<string, unknown>[])
      .map(c => ({ board: c.board as MetaBoard, name: c.name as string, oracleId: asStr(c.oracle_id), count: c.count as number }));
  }

  private cardsFor(ids: string[]): Map<string, NormalizedCard[]> {
    const out = new Map<string, NormalizedCard[]>();
    if (!ids.length) return out;
    const stmt = this.db.prepare('SELECT decklist_id, board, name, oracle_id, count FROM meta_decklist_cards WHERE decklist_id IN (SELECT value FROM json_each(?)) ORDER BY decklist_id, board, name');
    for (const c of stmt.all(JSON.stringify(ids)) as Record<string, unknown>[]) {
      const id = c.decklist_id as string;
      let arr = out.get(id); if (!arr) { arr = []; out.set(id, arr); }
      arr.push({ board: c.board as MetaBoard, name: c.name as string, oracleId: asStr(c.oracle_id), count: c.count as number });
    }
    return out;
  }

  private selectDecklists(where: string, params: unknown[], order: string, limit: number, withCards: boolean): DecklistRecord[] {
    const rows = this.db.prepare(`SELECT d.*, e.name AS event_name FROM meta_decklists d LEFT JOIN meta_events e ON e.id = d.event_id WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
    const cards = withCards ? this.cardsFor(rows.map(r => r.id as string)) : new Map<string, NormalizedCard[]>();
    return rows.map(r => this.rowToDecklist(r, cards.get(r.id as string) ?? []));
  }

  decklist(id: string): DecklistRecord | null {
    return this.selectDecklists('d.id = ?', [id], 'd.date DESC', 1, true)[0] ?? null;
  }

  /** Decklists of a format, newest first; `sinceDays` filters by event date (undated lists are kept). */
  decklists(format: string, opts: { sinceDays?: number; limit?: number; withCards?: boolean } = {}): DecklistRecord[] {
    const params: unknown[] = [format];
    let where = 'd.format = ?';
    if (opts.sinceDays != null) { const since = new Date(Date.now() - opts.sinceDays * 86400000).toISOString().slice(0, 10); where += ' AND (d.date IS NULL OR d.date >= ?)'; params.push(since); }
    return this.selectDecklists(where, params, 'd.date DESC, d.placement ASC', opts.limit ?? 5000, opts.withCards ?? true);
  }

  memberDecks(archetypeId: string, limit = 20): DecklistRecord[] {
    return this.selectDecklists('d.archetype_id = ?', [archetypeId], 'coalesce(d.wins, 0) DESC, d.placement ASC, d.date DESC', limit, true);
  }

  distinctCardNames(format: string): { name: string; oracleId: string | null }[] {
    return (this.db.prepare('SELECT c.name, min(c.oracle_id) AS oracle_id FROM meta_decklist_cards c JOIN meta_decklists d ON d.id = c.decklist_id WHERE d.format = ? GROUP BY c.name').all(format) as Record<string, unknown>[])
      .map(r => ({ name: r.name as string, oracleId: asStr(r.oracle_id) }));
  }

  // --- archetypes -----------------------------------------------------------------------------------------------------

  /** Replace every archetype of a format and reassign its decklists, in one transaction. */
  replaceArchetypes(format: string, archetypes: ComputedArchetype[], assignment: Map<string, string>, windowDays: number | null): void {
    const t = now();
    const insA = this.db.prepare(`INSERT INTO meta_archetypes (id, format, name, signature, share, deck_count, wins, losses, deck_size, goldfish_name, goldfish_share, url, window_days, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insC = this.db.prepare('INSERT INTO meta_archetype_cards (archetype_id, board, name, oracle_id, p_in_deck, mean_count, count_hist) VALUES (?,?,?,?,?,?,?) ON CONFLICT(archetype_id, board, name) DO UPDATE SET oracle_id = excluded.oracle_id, p_in_deck = excluded.p_in_deck, mean_count = excluded.mean_count, count_hist = excluded.count_hist');
    const assign = this.db.prepare('UPDATE meta_decklists SET archetype_id = ?, archetype = ? WHERE id = ?');
    this.db.transaction(() => {
      this.db.prepare('UPDATE meta_decklists SET archetype_id = NULL WHERE format = ?').run(format);
      this.db.prepare('DELETE FROM meta_archetypes WHERE format = ?').run(format);
      for (const a of archetypes) {
        insA.run(a.id, format, a.name, JSON.stringify(a.signature), a.share, a.deckCount, a.wins, a.losses, a.deckSize, a.goldfishName, a.goldfishShare, a.url, windowDays, t);
        for (const c of a.cards) insC.run(a.id, c.board, c.name, c.oracleId, c.pIn, c.expectedCount, JSON.stringify(c.countDist));
      }
      const nameOf = new Map(archetypes.map(a => [a.id, a.name]));
      for (const [deckId, archId] of assignment) assign.run(archId, nameOf.get(archId) ?? null, deckId);
    })();
  }

  private rowToArchetype(r: Record<string, unknown>): ArchetypeSummary {
    const wins = asNum(r.wins) ?? 0, losses = asNum(r.losses) ?? 0;
    return {
      id: r.id as string, format: r.format as string, name: r.name as string, signature: JSON.parse((r.signature as string) || '[]'), share: asNum(r.share) ?? 0, deckCount: asNum(r.deck_count) ?? 0,
      wins, losses, winRate: wins + losses > 0 ? wins / (wins + losses) : null, deckSize: (asNum(r.deck_size) ?? 60) >= 90 ? 100 : 60,
      goldfishName: asStr(r.goldfish_name), goldfishShare: asNum(r.goldfish_share), url: asStr(r.url), windowDays: asNum(r.window_days), computedAt: r.computed_at as string,
    };
  }

  archetypes(format: string): ArchetypeSummary[] {
    return (this.db.prepare("SELECT * FROM meta_archetypes WHERE format = ? ORDER BY (name = 'Other') ASC, share DESC, name ASC").all(format) as Record<string, unknown>[]).map(r => this.rowToArchetype(r));
  }

  archetype(id: string): ArchetypeSummary | null {
    const r = this.db.prepare('SELECT * FROM meta_archetypes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToArchetype(r) : null;
  }

  archetypeCards(id: string): ArchetypeCardStat[] {
    return (this.db.prepare('SELECT board, name, oracle_id, p_in_deck, mean_count, count_hist FROM meta_archetype_cards WHERE archetype_id = ? ORDER BY board, p_in_deck DESC, mean_count DESC, name').all(id) as Record<string, unknown>[])
      .map(r => ({ board: r.board as MetaBoard, name: r.name as string, oracleId: asStr(r.oracle_id), pIn: r.p_in_deck as number, expectedCount: r.mean_count as number, countDist: JSON.parse(r.count_hist as string) }));
  }

  previousSignatures(format: string): { id: string; signature: string[] }[] {
    return (this.db.prepare('SELECT id, signature FROM meta_archetypes WHERE format = ?').all(format) as { id: string; signature: string }[]).map(r => ({ id: r.id, signature: JSON.parse(r.signature || '[]') }));
  }

  // --- card stats (17lands) --------------------------------------------------------------------------------------------

  upsertCardStats(source: MetaSource, format: string, set: string, ratings: CardRating[]): number {
    const stmt = this.db.prepare('INSERT INTO meta_card_stats (source, format, set_code, name, oracle_id, stats, fetched_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source, format, set_code, name) DO UPDATE SET oracle_id = excluded.oracle_id, stats = excluded.stats, fetched_at = excluded.fetched_at');
    const t = now();
    return this.db.transaction(() => { let n = 0; for (const r of ratings) { stmt.run(source, format, set.toUpperCase(), r.name, r.oracleId, JSON.stringify(r), t); n++; } return n; })();
  }

  cardStats(source: MetaSource, format: string, set: string): { ratings: CardRating[]; fetchedAt: string | null } {
    const rows = this.db.prepare('SELECT stats, fetched_at FROM meta_card_stats WHERE source = ? AND format = ? AND set_code = ? ORDER BY name').all(source, format, set.toUpperCase()) as { stats: string; fetched_at: string }[];
    return { ratings: rows.map(r => JSON.parse(r.stats) as CardRating), fetchedAt: rows[0]?.fetched_at ?? null };
  }

  // --- sync log ----------------------------------------------------------------------------------------------------------

  logSync(e: SyncLogEntry): void {
    this.db.prepare('INSERT INTO meta_sync_log (source, format, started_at, finished_at, ok, message) VALUES (?,?,?,?,?,?)').run(e.source, e.format, e.startedAt, e.finishedAt, e.ok ? 1 : 0, e.message);
  }

  lastSync(source: MetaSource | 'cluster', format: string, onlyOk = true): { finishedAt: string; ok: boolean; message: string } | null {
    const r = this.db.prepare(`SELECT finished_at, ok, message FROM meta_sync_log WHERE source = ? AND format = ? ${onlyOk ? 'AND ok = 1' : ''} ORDER BY id DESC LIMIT 1`).get(source, format) as { finished_at: string; ok: number; message: string } | undefined;
    return r ? { finishedAt: r.finished_at, ok: !!r.ok, message: r.message } : null;
  }

  syncLog(limit = 20): (SyncLogEntry & { id: number })[] {
    return (this.db.prepare('SELECT * FROM meta_sync_log ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map(r => ({ id: r.id as number, source: r.source as MetaSource, format: r.format as string, startedAt: r.started_at as string, finishedAt: r.finished_at as string, ok: !!r.ok, message: (r.message as string) ?? '' }));
  }
}
