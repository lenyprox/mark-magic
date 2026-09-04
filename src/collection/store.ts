// The registered card collection in user.db: sources (one per imported file), per-source card rows, and the owned view.
// The source is the unit of change: re-importing the same file replaces its rows; different files add up.
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { CardDB } from '../cards/db.js';
import { NameResolver } from '../meta/normalize.js';
import { getSetting, setSetting } from '../user/db.js';
import { DeckStore, type DeckCard, type DeckRecord, type DeckRole } from '../user/decks.js';
import type { CountNameRow } from './csv.js';
import { parseCollectionText, type CollectionFormat } from './formats.js';
import { deckNameFromFile, inferCommander, type CommanderInference } from './names.js';

export type SourceKind = 'csv' | 'moxfield' | 'archidekt' | 'deckbox' | 'manabox' | 'arena' | 'text' | 'manual';
export interface SourceRecord { id: string; kind: SourceKind; ref: string; label: string | null; deckId: string | null; rows: number; copies: number; unresolved: CountNameRow[]; importedAt: string; contentHash: string }
export interface OwnedEntry { oracleId: string; name: string; count: number; sources: number }
export interface OwnedDetail { oracleId: string; name: string; count: number; sources: { id: string; label: string | null; ref: string; count: number }[]; decks: { id: string; name: string; board: string; count: number }[] }
export interface CoverageReport { owned: number; total: number; pct: number; missing: { oracleId: string; name: string; need: number; have: number }[] }
export interface CollectionStats {
  distinct: number; copies: number; sources: number; decks: number; updatedAt: string | null; valueUsd: number | null;
  byIdentity: { identity: string; distinct: number; copies: number }[]; byType: { type: string; distinct: number; copies: number }[];
}
export interface ImportOptions { kind?: SourceKind; ref?: string; label?: string; mode?: 'replace' | 'merge'; asDeck?: { format?: string; role?: DeckRole; commander?: string | null } | null }
export interface ImportResult { source: SourceRecord; resolved: number; copies: number; unresolved: CountNameRow[]; skipped: boolean; deck: DeckRecord | null; commander: CommanderInference | null; format: CollectionFormat | 'manual' }

const now = () => new Date().toISOString();
const VERSION_KEY = 'collection_version';
const MANUAL_SOURCE = 'manual';

export class CollectionStore {
  private resolver: NameResolver;
  private decks: DeckStore;
  private ownedCache: { version: number; map: Map<string, number> } | null = null;

  constructor(private db: Database.Database, private cards: CardDB) {
    this.resolver = new NameResolver(cards);
    this.decks = new DeckStore(db);
  }

  version(): number { return getSetting<number>(this.db, VERSION_KEY, 0); }
  private bump() { setSetting(this.db, VERSION_KEY, this.version() + 1); this.ownedCache = null; }

  /** Import rows under one source. Same (kind, ref) with the same content is a no-op; changed content replaces the source. */
  importRows(rows: CountNameRow[], opts: ImportOptions = {}): ImportResult {
    const kind = opts.kind ?? 'csv'; const ref = opts.ref ?? 'import'; const label = opts.label ?? deckNameFromFile(ref);
    const resolved: { row: CountNameRow; oracleId: string; name: string }[] = []; const unresolved: CountNameRow[] = [];
    for (const r of rows) {
      const res = this.resolver.resolve(r.name);
      if (res.oracleId) resolved.push({ row: r, oracleId: res.oracleId, name: res.name }); else unresolved.push(r);
    }
    const merged = new Map<string, { oracleId: string; name: string; count: number; printingId: string; finish: string; line: number }>();
    for (const r of resolved) {
      const printingId = ''; const finish = r.row.finish ?? '';
      const key = `${r.oracleId}|${printingId}|${finish}`;
      const prev = merged.get(key);
      if (prev) prev.count += r.row.count; else merged.set(key, { oracleId: r.oracleId, name: r.name, count: r.row.count, printingId, finish, line: r.row.line });
    }
    const hash = createHash('sha1').update([...merged.values()].map(m => `${m.count}\t${m.oracleId}\t${m.finish}`).sort().join('\n')).digest('hex');
    const existing = this.db.prepare('SELECT * FROM collection_sources WHERE kind = ? AND ref = ?').get(kind, ref) as Record<string, unknown> | undefined;
    const copies = [...merged.values()].reduce((a, m) => a + m.count, 0);
    const t = now();
    let sourceId = existing ? (existing.id as string) : randomUUID();
    let skipped = false;
    this.db.transaction(() => {
      if (existing && existing.content_hash === hash && opts.mode !== 'merge') { skipped = true; return; }
      if (existing) {
        if (opts.mode !== 'merge') this.db.prepare('DELETE FROM collection_cards WHERE source_id = ?').run(sourceId);
        this.db.prepare('UPDATE collection_sources SET label = ?, content_hash = ?, rows = ?, copies = ?, unresolved = ?, imported_at = ? WHERE id = ?')
          .run(label, hash, rows.length, copies, JSON.stringify(unresolved), t, sourceId);
      } else {
        this.db.prepare('INSERT INTO collection_sources (id, kind, ref, label, deck_id, content_hash, rows, copies, unresolved, imported_at) VALUES (?,?,?,?,NULL,?,?,?,?,?)')
          .run(sourceId, kind, ref, label, hash, rows.length, copies, JSON.stringify(unresolved), t);
      }
      const ins = this.db.prepare(`INSERT INTO collection_cards (oracle_id, source_id, name, printing_id, finish, count, first_seen, updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(oracle_id, source_id, printing_id, finish) DO UPDATE SET count = count + excluded.count, name = excluded.name, updated_at = excluded.updated_at`);
      for (const m of merged.values()) ins.run(m.oracleId, sourceId, m.name, m.printingId, m.finish, m.count, t, t);
      this.bump();
    })();
    const source = this.source(sourceId)!;
    let deck: DeckRecord | null = null; let commander: CommanderInference | null = null;
    if (opts.asDeck !== undefined && opts.asDeck !== null) {
      commander = this.inferCommanderFor(label, [...merged.values()].map(m => m.oracleId));
      const pickId = opts.asDeck.commander === undefined ? (commander.pick?.oracleId ?? null) : opts.asDeck.commander;
      deck = this.registerDeck(source, [...merged.values()], { format: opts.asDeck.format ?? 'commander', role: opts.asDeck.role ?? 'mine', commander: pickId });
    } else if (existing?.deck_id) {
      deck = this.decks.get(existing.deck_id as string);
      if (deck && !skipped) deck = this.registerDeck(source, [...merged.values()], { format: deck.format, role: deck.role, commander: deck.cards.find(c => c.board === 'commander')?.oracleId ?? null });
    }
    return { source: this.source(sourceId)!, resolved: resolved.length, copies, unresolved, skipped, deck, commander, format: kind };
  }

  /** Resolve a file without writing anything: what would import, what would not, and the commander guess. */
  previewText(text: string, filename: string): { format: CollectionFormat; label: string; rows: number; copies: number; resolved: number; unresolved: CountNameRow[]; errors: { line: number; text: string; reason: string }[]; skippedLines: string[]; commander: CommanderInference; existing: SourceRecord | null } {
    const parsed = parseCollectionText(text, filename);
    const base = filename.replace(/\\/g, '/').split('/').pop()!;
    const label = deckNameFromFile(base);
    const ids: string[] = []; const unresolved: CountNameRow[] = []; let copies = 0;
    for (const r of parsed.rows) { const res = this.resolver.resolve(r.name); copies += r.count; if (res.oracleId) ids.push(res.oracleId); else unresolved.push(r); }
    const existing = this.db.prepare('SELECT * FROM collection_sources WHERE kind = ? AND ref = ?').get(parsed.format, base) as Record<string, unknown> | undefined;
    return { format: parsed.format, label, rows: parsed.rows.length, copies, resolved: ids.length, unresolved, errors: parsed.errors, skippedLines: parsed.skipped, commander: this.inferCommanderFor(label, [...new Set(ids)]), existing: existing ? this.rowToSource(existing) : null };
  }

  /** Cheap headline numbers for banners and health checks. */
  summary(): { distinct: number; copies: number; sources: number; decks: number; updatedAt: string | null } {
    const head = this.db.prepare('SELECT count(*) AS distinct_n, coalesce(sum(count),0) AS copies FROM collection_owned').get() as { distinct_n: number; copies: number };
    const s = this.db.prepare('SELECT count(*) AS n, max(imported_at) AS t, sum(deck_id IS NOT NULL) AS d FROM collection_sources').get() as { n: number; t: string | null; d: number | null };
    return { distinct: head.distinct_n, copies: head.copies, sources: s.n, decks: s.d ?? 0, updatedAt: s.t };
  }

  /** Detect the file format, parse it and import it under (kind = detected format, ref = file name). */
  importText(text: string, filename: string, opts: Omit<ImportOptions, 'kind' | 'ref'> & { ref?: string } = {}): ImportResult & { errors: { line: number; text: string; reason: string }[]; skippedLines: string[] } {
    const parsed = parseCollectionText(text, filename);
    const r = this.importRows(parsed.rows, { ...opts, kind: parsed.format, ref: opts.ref ?? filename.replace(/\\/g, '/').split('/').pop()! });
    return { ...r, format: parsed.format, errors: parsed.errors, skippedLines: parsed.skipped };
  }

  /**
   * Adjust copies by hand. A positive delta lands in the "Added by hand" source ("found one in my bulk"); a negative delta
   * drains that source first and then the newest imported sources, so removing a copy always takes effect.
   */
  upsert(oracleId: string, delta: number, name?: string): OwnedEntry | null {
    const t = now();
    const def = name ? null : this.cards.getByOracleId(oracleId);
    const nm = name ?? def?.name; if (!nm) return null;
    const refreshSource = this.db.prepare(`UPDATE collection_sources SET copies = (SELECT coalesce(sum(count),0) FROM collection_cards WHERE source_id = ?), rows = (SELECT count(*) FROM collection_cards WHERE source_id = ?) WHERE id = ?`);
    this.db.transaction(() => {
      if (delta > 0) {
        this.db.prepare(`INSERT INTO collection_sources (id, kind, ref, label, deck_id, content_hash, rows, copies, unresolved, imported_at) VALUES (?,?,?,?,NULL,'',0,0,'[]',?) ON CONFLICT(kind, ref) DO NOTHING`).run(MANUAL_SOURCE, 'manual', MANUAL_SOURCE, 'Added by hand', t);
        this.db.prepare(`INSERT INTO collection_cards (oracle_id, source_id, name, printing_id, finish, count, first_seen, updated_at) VALUES (?,?,?,'','',?,?,?) ON CONFLICT(oracle_id, source_id, printing_id, finish) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at`).run(oracleId, MANUAL_SOURCE, nm, delta, t, t);
        refreshSource.run(MANUAL_SOURCE, MANUAL_SOURCE, MANUAL_SOURCE);
        this.db.prepare('UPDATE collection_sources SET imported_at = ? WHERE id = ?').run(t, MANUAL_SOURCE);
      } else {
        let left = -delta;
        const rows = this.db.prepare(`SELECT c.rowid AS rid, c.source_id, c.count FROM collection_cards c JOIN collection_sources s ON s.id = c.source_id WHERE c.oracle_id = ? ORDER BY (c.source_id = ?) DESC, s.imported_at DESC, c.rowid DESC`).all(oracleId, MANUAL_SOURCE) as { rid: number; source_id: string; count: number }[];
        for (const r of rows) {
          if (left <= 0) break;
          const take = Math.min(left, r.count); left -= take;
          if (take >= r.count) this.db.prepare('DELETE FROM collection_cards WHERE rowid = ?').run(r.rid);
          else this.db.prepare('UPDATE collection_cards SET count = count - ?, updated_at = ? WHERE rowid = ?').run(take, t, r.rid);
          refreshSource.run(r.source_id, r.source_id, r.source_id);
        }
      }
      this.bump();
    })();
    return this.owned(oracleId);
  }

  ownedMap(): Map<string, number> {
    const v = this.version();
    if (this.ownedCache && this.ownedCache.version === v) return this.ownedCache.map;
    const map = new Map<string, number>();
    for (const r of this.db.prepare('SELECT oracle_id, count FROM collection_owned').all() as { oracle_id: string; count: number }[]) map.set(r.oracle_id, r.count);
    this.ownedCache = { version: v, map };
    return map;
  }
  isOwned(oracleId: string): number { return this.ownedMap().get(oracleId) ?? 0; }

  owned(oracleId: string): OwnedEntry | null {
    const r = this.db.prepare('SELECT oracle_id, name, count, sources FROM collection_owned WHERE oracle_id = ?').get(oracleId) as { oracle_id: string; name: string; count: number; sources: number } | undefined;
    return r ? { oracleId: r.oracle_id, name: r.name, count: r.count, sources: r.sources } : null;
  }

  /** Where a card sits: per-source counts and the decks that run it. */
  ownedDetail(oracleId: string): OwnedDetail | null {
    const base = this.owned(oracleId);
    const sources = (this.db.prepare('SELECT s.id, s.label, s.ref, sum(c.count) AS count FROM collection_cards c JOIN collection_sources s ON s.id = c.source_id WHERE c.oracle_id = ? GROUP BY s.id ORDER BY s.imported_at').all(oracleId) as { id: string; label: string | null; ref: string; count: number }[]);
    const decks = (this.db.prepare('SELECT d.id, d.name, dc.board, dc.count FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE dc.oracle_id = ? ORDER BY d.updated_at DESC').all(oracleId) as { id: string; name: string; board: string; count: number }[]);
    if (!base && !decks.length) return null;
    return { oracleId, name: base?.name ?? this.cards.getByOracleId(oracleId)?.name ?? oracleId, count: base?.count ?? 0, sources, decks };
  }

  list(opts: { q?: string; limit?: number; offset?: number } = {}): { items: OwnedEntry[]; total: number } {
    const where = opts.q ? 'WHERE name LIKE ? COLLATE NOCASE' : ''; const params = opts.q ? [`%${opts.q}%`] : [];
    const total = (this.db.prepare(`SELECT count(*) AS n FROM collection_owned ${where}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT oracle_id, name, count, sources FROM collection_owned ${where} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, opts.limit ?? 1000, opts.offset ?? 0) as { oracle_id: string; name: string; count: number; sources: number }[];
    return { items: rows.map(r => ({ oracleId: r.oracle_id, name: r.name, count: r.count, sources: r.sources })), total };
  }

  /** How much of a card list the collection covers (a deck, a proposed list, ...). Maybeboards are ignored. */
  coverageOf(cards: { oracleId: string; name: string; count: number; board?: string }[]): CoverageReport {
    const need = new Map<string, { name: string; need: number }>();
    for (const c of cards) { if (c.board === 'maybe') continue; const p = need.get(c.oracleId); if (p) p.need += c.count; else need.set(c.oracleId, { name: c.name, need: c.count }); }
    const owned = this.ownedMap();
    let have = 0, total = 0; const missing: CoverageReport['missing'] = [];
    for (const [oracleId, n] of need) {
      const h = Math.min(n.need, owned.get(oracleId) ?? 0);
      total += n.need; have += h;
      if (h < n.need) missing.push({ oracleId, name: n.name, need: n.need, have: h });
    }
    missing.sort((a, b) => a.name.localeCompare(b.name));
    return { owned: have, total, pct: total ? +(100 * have / total).toFixed(1) : 100, missing };
  }

  sources(): SourceRecord[] {
    return (this.db.prepare('SELECT * FROM collection_sources ORDER BY imported_at').all() as Record<string, unknown>[]).map(r => this.rowToSource(r));
  }
  source(id: string): SourceRecord | null {
    const r = this.db.prepare('SELECT * FROM collection_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.rowToSource(r) : null;
  }
  removeSource(id: string, opts: { deleteDeck?: boolean } = {}): boolean {
    const s = this.source(id); if (!s) return false;
    this.db.transaction(() => {
      if (opts.deleteDeck && s.deckId) this.decks.remove(s.deckId);
      this.db.prepare('DELETE FROM collection_sources WHERE id = ?').run(id);
      this.bump();
    })();
    return true;
  }
  clear(): void { this.db.transaction(() => { this.db.prepare('DELETE FROM collection_sources').run(); this.bump(); })(); }

  stats(): CollectionStats {
    const head = this.db.prepare('SELECT count(*) AS distinct_n, coalesce(sum(count),0) AS copies FROM collection_owned').get() as { distinct_n: number; copies: number };
    const sources = (this.db.prepare('SELECT count(*) AS n, max(imported_at) AS t FROM collection_sources').get() as { n: number; t: string | null });
    const decks = (this.db.prepare('SELECT count(*) AS n FROM collection_sources WHERE deck_id IS NOT NULL').get() as { n: number }).n;
    const owned = [...this.ownedMap().entries()];
    const hasIndex = !!this.cards.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_index'").get();
    const byIdentity = new Map<string, { distinct: number; copies: number }>(); const byType = new Map<string, { distinct: number; copies: number }>();
    let value = 0; let priced = false;
    const meta = hasIndex
      ? this.cards.db.prepare('SELECT oracle_id, type_line, identity_mask, price_usd FROM card_index WHERE oracle_id = ?')
      : this.cards.db.prepare('SELECT oracle_id, type_line, color_identity, NULL AS price_usd FROM oracle_cards WHERE oracle_id = ?');
    const bits: [number, string][] = [[1, 'W'], [2, 'U'], [4, 'B'], [8, 'R'], [16, 'G']];
    for (const [oracleId, count] of owned) {
      const r = meta.get(oracleId) as { type_line: string | null; identity_mask?: number; color_identity?: string; price_usd: number | null } | undefined;
      if (!r) continue;
      const ident = r.identity_mask != null ? bits.filter(([b]) => (r.identity_mask! & b) !== 0).map(([, c]) => c).join('') : (() => { try { return (JSON.parse(r.color_identity ?? '[]') as string[]).join(''); } catch { return ''; } })();
      const ik = ident || 'C';
      const i = byIdentity.get(ik) ?? { distinct: 0, copies: 0 }; i.distinct++; i.copies += count; byIdentity.set(ik, i);
      const front = (r.type_line ?? '').split(' // ')[0];
      const type = /\bLand\b/.test(front) ? 'Land' : ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'].find(t => new RegExp(`\\b${t}\\b`).test(front)) ?? 'Other';
      const ty = byType.get(type) ?? { distinct: 0, copies: 0 }; ty.distinct++; ty.copies += count; byType.set(type, ty);
      if (r.price_usd != null) { value += r.price_usd * count; priced = true; }
    }
    const order = ['W', 'U', 'B', 'R', 'G'];
    const identSort = (a: string, b: string) => a.length - b.length || order.indexOf(a[0]) - order.indexOf(b[0]) || a.localeCompare(b);
    return {
      distinct: head.distinct_n, copies: head.copies, sources: sources.n, decks, updatedAt: sources.t, valueUsd: priced ? Math.round(value * 100) / 100 : null,
      byIdentity: [...byIdentity.entries()].map(([identity, v]) => ({ identity, ...v })).sort((a, b) => b.copies - a.copies || identSort(a.identity, b.identity)),
      byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.copies - a.copies),
    };
  }

  exportText(fmt: 'csv' | 'arena' = 'csv'): string {
    const rows = this.list().items;
    if (fmt === 'arena') return rows.map(r => `${r.count} ${r.name}`).join('\n') + '\n';
    const q = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    return rows.map(r => `${r.count},${q(r.name)}`).join('\n') + '\n';
  }

  /** Commander candidates for a display name over a set of oracle ids (legendary creatures and "can be your commander"). */
  inferCommanderFor(displayName: string, oracleIds: string[]): CommanderInference {
    const q = this.cards.db.prepare('SELECT oracle_id, name, type_line, oracle_text FROM oracle_cards WHERE oracle_id = ?');
    const cands = oracleIds.map(id => q.get(id) as { oracle_id: string; name: string; type_line: string | null; oracle_text: string | null } | undefined).filter((r): r is NonNullable<typeof r> => !!r)
      .map(r => ({ oracleId: r.oracle_id, name: r.name, typeLine: r.type_line ?? '', oracleText: r.oracle_text ?? '' }));
    return inferCommander(displayName, cands);
  }

  /** Create or refresh the deck registered from a source. The commander (if any) goes to the command zone board. */
  registerDeck(source: SourceRecord, cards: { oracleId: string; name: string; count: number; line: number }[], opts: { format: string; role: DeckRole; commander: string | null }): DeckRecord {
    const deckCards: DeckCard[] = cards.slice().sort((a, b) => a.line - b.line).map((c, i) => ({ board: c.oracleId === opts.commander ? 'commander' : 'main', oracleId: c.oracleId, name: c.name, printingId: null, count: c.count, position: i }));
    const notes = opts.commander ? null : 'Commander not identified from the file name; pick one in the builder.';
    let deck = source.deckId ? this.decks.get(source.deckId) : null;
    if (deck) deck = this.decks.update(deck.id, { cards: deckCards, format: opts.format, notes: deck.notes && !notes ? deck.notes : notes })!;
    else {
      deck = this.decks.create({ name: source.label ?? deckNameFromFile(source.ref), format: opts.format, role: opts.role, source: `import:${source.kind}`, sourceRef: source.ref, notes, cards: deckCards });
      this.db.prepare('UPDATE collection_sources SET deck_id = ? WHERE id = ?').run(deck.id, source.id);
    }
    return deck;
  }

  private rowToSource(r: Record<string, unknown>): SourceRecord {
    let unresolved: CountNameRow[] = []; try { unresolved = JSON.parse((r.unresolved as string) || '[]'); } catch { /* ignore */ }
    return { id: r.id as string, kind: r.kind as SourceKind, ref: r.ref as string, label: (r.label as string) ?? null, deckId: (r.deck_id as string) ?? null, rows: r.rows as number, copies: r.copies as number, unresolved, importedAt: r.imported_at as string, contentHash: r.content_hash as string };
  }
}
