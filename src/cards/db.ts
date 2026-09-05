// Card database access: loads oracle cards from data/master/master.db and parses them into CardDefs.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { MASTER_DB } from '../config/paths.js';
import { parseCard, type OracleRow } from './parse.js';
import { tierFilter, tierOf, type PoolRow, type PoolTier } from './pool.js';
import { applyScript, scriptStore } from './scripts.js';
import type { CardDef } from './types.js';

const NON_PLAYABLE = "layout NOT IN ('art_series','token','double_faced_token','emblem','vanguard','planar','scheme','front_card') AND type_line NOT LIKE 'Card%' AND type_line NOT LIKE 'Stickers%' AND type_line NOT LIKE 'Dungeon%' AND type_line NOT LIKE 'Phenomenon%' AND type_line NOT LIKE 'Conspiracy%'";

const PLAYABLE_LAYOUT = "layout NOT IN ('art_series','token','double_faced_token','emblem')";

/** `CardDB.all()` options: pool tier(s) ('all' = no filter) and/or a rowid window (used to shard the scan across worker threads). */
export type ScanTier = PoolTier | 'all';
export interface ScanOptions { from?: number; to?: number; tier?: ScanTier | ScanTier[] }
function scanTierFilter(t: ScanTier | ScanTier[] | undefined): Set<PoolTier> | null { if (t === undefined) return null; const list = Array.isArray(t) ? t : [t]; if (list.includes('all')) return null; return tierFilter(list as PoolTier[]); }

export class CardDB {
  readonly db: Database.Database;
  private cache = new Map<string, CardDef | null>();
  private static instance: CardDB | null = null;

  constructor(dbPath = MASTER_DB()) {
    if (!fs.existsSync(dbPath)) throw new Error(`Master database not found at ${dbPath}. Run: npm run data:all`);
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  /** Process-wide shared instance (the DB is read-only, so sharing is safe). */
  static shared(dbPath?: string): CardDB {
    if (!CardDB.instance) CardDB.instance = new CardDB(dbPath);
    return CardDB.instance;
  }

  private rowToOracle(json: string): OracleRow { return this.oracleOf(JSON.parse(json)); }

  private oracleOf(o: Record<string, any>): OracleRow {
    return {
      name: o.name, oracle_id: o.oracle_id, mana_cost: o.mana_cost, mana_value: o.mana_value, colors: o.colors, color_identity: o.color_identity,
      types: o.types, supertypes: o.supertypes, subtypes: o.subtypes, type_line: o.type_line, oracle_text: o.oracle_text, power: o.power, toughness: o.toughness,
      loyalty: o.loyalty, keywords: o.keywords, layout: o.layout, produced_mana: o.produced_mana, image: o.image, representative_id: o.representative_id ?? o.id ?? null,
      faces: o.faces?.map((f: NonNullable<OracleRow['faces']>[number]) => ({ name: f.name, type_line: f.type_line, oracle_text: f.oracle_text, power: f.power, toughness: f.toughness, mana_cost: f.mana_cost, image: f.image ?? null })),
    };
  }

  /** Exact (case-insensitive) name lookup; also matches the front face name of multi-face cards. */
  get(name: string): CardDef | null {
    const key = name.trim().toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    const trimmed = name.trim();
    // Exact first: `name = ?` uses idx_o_name, while COLLATE NOCASE forces a full scan (60 ms a card on this data set).
    let row = this.stmt('exact', `SELECT json FROM oracle_cards WHERE name = ? AND ${PLAYABLE_LAYOUT} ORDER BY first_printed LIMIT 1`).get(trimmed) as { json: string } | undefined;
    if (!row) row = this.stmt('nocase', `SELECT json FROM oracle_cards WHERE name = ? COLLATE NOCASE AND ${PLAYABLE_LAYOUT} ORDER BY first_printed LIMIT 1`).get(trimmed) as { json: string } | undefined;
    if (!row) row = this.stmt('front', `SELECT json FROM oracle_cards WHERE name LIKE ? COLLATE NOCASE AND ${PLAYABLE_LAYOUT} ORDER BY first_printed LIMIT 1`).get(trimmed + ' // %') as { json: string } | undefined;
    const def = row ? this.parse(this.rowToOracle(row.json)) : null;
    this.cache.set(key, def);
    return def;
  }

  /** Prepared statements are reused: preparing costs more than the lookup once the index is used. */
  private stmts = new Map<string, import('better-sqlite3').Statement>();
  private stmt(key: string, sql: string) { let st = this.stmts.get(key); if (!st) { st = this.db.prepare(sql); this.stmts.set(key, st); } return st; }


  /** Parse a row and apply its script (data/scripts/<oracle_id>.json) when one exists and is not stale. */
  private parse(o: OracleRow): CardDef { const def = parseCard(o); const s = scriptStore().get(o.oracle_id); return s ? applyScript(def, s, this.tierOf(o.oracle_id) ?? 'paper') : def; }

  /** Lookup by oracle id. `oracle_id` is the primary key and the statement is reused: a sharded scan calls this often. */
  getByOracleId(oracleId: string): CardDef | null {
    const key = 'oid:' + oracleId;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const row = this.stmt('oid', 'SELECT json FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as { json: string } | undefined;
    const def = row ? this.parse(this.rowToOracle(row.json)) : null;
    this.cache.set(key, def);
    return def;
  }

  search(pattern: string, limit = 20): { name: string; type_line: string; mana_cost: string | null }[] {
    return this.db.prepare("SELECT name, type_line, mana_cost FROM oracle_cards WHERE name LIKE ? COLLATE NOCASE AND layout NOT IN ('art_series','token','double_faced_token','emblem') ORDER BY name LIMIT ?").all(`%${pattern}%`, limit) as { name: string; type_line: string; mana_cost: string | null }[];
  }

  /**
   * Iterate playable oracle cards (the coverage report, the pool sandbox, the fuzzer). `tier` narrows the pool to one
   * or more pool tiers from src/cards/pool.ts ('all' or undefined = every playable card); `from`/`to` restrict the
   * scan to a rowid window, which is how the pool sandbox splits it over worker threads — the windows partition the
   * table, so together they yield exactly the unwindowed scan. Tiers are decided on the parsed row's own fields.
   */
  *all(opts: ScanOptions = {}): Generator<CardDef> {
    for (const { def } of this.allWithTier(opts)) yield def;
  }

  /** Same as `all()` but also reports each card's pool tier (the coverage report groups by it). */
  *allWithTier(opts: ScanOptions = {}): Generator<{ def: CardDef; tier: PoolTier }> {
    const want = scanTierFilter(opts.tier);
    const windowed = opts.from !== undefined || opts.to !== undefined;
    const sql = `SELECT json FROM oracle_cards WHERE ${NON_PLAYABLE}${windowed ? ' AND rowid BETWEEN ? AND ?' : ''}`;
    const stmt = this.stmt(`all:${windowed}`, sql);
    const rows = (windowed ? stmt.iterate(opts.from ?? 0, opts.to ?? Number.MAX_SAFE_INTEGER) : stmt.iterate()) as Iterable<{ json: string }>;
    for (const r of rows) {
      const raw = JSON.parse(r.json) as PoolRow & Record<string, unknown>;
      const tier = tierOf(raw);
      if (want && !want.has(tier)) continue;
      yield { def: this.parse(this.oracleOf(raw)), tier };
    }
  }

  /** The rowid bounds of the playable rows, so a caller can cut `all()` into equal windows. */
  rowIdBounds(): { min: number; max: number } {
    const r = this.stmt('bounds', `SELECT MIN(rowid) AS min, MAX(rowid) AS max FROM oracle_cards WHERE ${NON_PLAYABLE}`).get() as { min: number | null; max: number | null };
    return { min: r.min ?? 1, max: r.max ?? 0 };
  }

  /** The pool tier of one oracle card, or null when master.db has no such row. */
  tierOf(oracleId: string): PoolTier | null {
    const row = this.stmt('tier', 'SELECT json FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as { json: string } | undefined;
    return row ? tierOf(JSON.parse(row.json) as PoolRow) : null;
  }

  rulings(oracleId: string): { published_at: string; comment: string }[] {
    return this.db.prepare('SELECT published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at').all(oracleId) as { published_at: string; comment: string }[];
  }

  /** Drop parsed defs (after scripts change). */
  clearCache() { this.cache.clear(); }

  close() { this.db.close(); if (CardDB.instance === this) CardDB.instance = null; }
}

export type DeckBoard = 'main' | 'side' | 'commander' | 'companion' | 'maybe';
export interface DeckListEntry { name: string; count: number; board: DeckBoard; set?: string; number?: string }
export interface DeckList { name: string; cards: DeckListEntry[] }

const BOARD_HEADERS: Record<string, DeckBoard> = { deck: 'main', main: 'main', mainboard: 'main', maindeck: 'main', sideboard: 'side', side: 'side', commander: 'commander', commanders: 'commander', companion: 'companion', maybeboard: 'maybe', maybe: 'maybe', considering: 'maybe' };

/**
 * Parse a text deck list. Accepts plain ("4 Lightning Bolt"), Arena ("4 Lightning Bolt (M10) 146" with Deck/Sideboard/Commander headers)
 * and Moxfield/MTGO exports ("SIDEBOARD:"). Lines starting with "//" or "#" are comments; "Fire // Ice" style names are preserved.
 */
export function parseDeckList(text: string, name = 'deck'): DeckList {
  const cards: DeckListEntry[] = [];
  let board: DeckBoard = 'main';
  let blankRun = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(\/\/|#).*$/, '').trim();
    if (!line) { blankRun++; continue; }
    const header = line.replace(/[:\s]+$/, '').replace(/\s*\(\d+\)$/, '').toLowerCase();
    if (header in BOARD_HEADERS) { board = BOARD_HEADERS[header]; blankRun = 0; continue; }
    // MTGO/plain exports separate the sideboard with a blank line after the main deck; we only honour explicit headers.
    blankRun = 0;
    const m = line.match(/^(\d+)x?\s+(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9★†-]*))?\s*$/);
    if (m) {
      const entry: DeckListEntry = { name: m[2].trim(), count: Number(m[1]), board };
      if (m[3]) { entry.set = m[3].toLowerCase(); if (m[4]) entry.number = m[4]; }
      cards.push(entry);
    } else cards.push({ name: line, count: 1, board });
  }
  return { name, cards };
}

/** Serialise a deck list back to the plain text format used by decks/*.txt. */
export function formatDeckList(list: DeckList): string {
  const out: string[] = [];
  const boards: DeckBoard[] = ['commander', 'main', 'side'];
  for (const b of boards) {
    const rows = list.cards.filter(c => c.board === b);
    if (!rows.length) continue;
    if (b !== 'main' || out.length) out.push(b === 'main' ? 'Deck' : b === 'side' ? 'Sideboard' : 'Commander');
    for (const c of rows) out.push(`${c.count} ${c.name}${c.set ? ` (${c.set.toUpperCase()})${c.number ? ' ' + c.number : ''}` : ''}`);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

/** Resolve a deck list to CardDefs (main deck + commander only; sideboard is not part of the played 60). */
export function loadDeck(db: CardDB, list: DeckList, opts: { boards?: DeckBoard[] } = {}): { cards: CardDef[]; missing: string[]; partial: CardDef[] } {
  const boards = new Set(opts.boards ?? ['main', 'commander']);
  const cards: CardDef[] = []; const missing: string[] = []; const partial: CardDef[] = [];
  for (const { name, count, board } of list.cards) {
    if (!boards.has(board ?? 'main')) continue;
    const def = db.get(name);
    if (!def) { missing.push(name); continue; }
    if (!def.fullyParsed && !partial.includes(def)) partial.push(def);
    for (let i = 0; i < count; i++) cards.push(def);
  }
  return { cards, missing, partial };
}
