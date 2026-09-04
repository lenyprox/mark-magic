// Read-only query layer over master.db (plus the tables added by scripts/build-web-index.mjs) for the web app:
// paginated browse/search, card detail, autocomplete, sets. Everything returned is plain JSON.
import type Database from 'better-sqlite3';
import { parseCard, type OracleRow } from './parse.js';
import type { CardDef, Color } from './types.js';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus';
export type ColorMode = 'any' | 'exact' | 'subset' | 'superset' | 'identity';
export type SortKey = 'name' | 'released' | 'edhrec' | 'price' | 'mv' | 'collector' | 'relevance';

export interface CardQuery {
  q?: string;
  colors?: Color[]; colorMode?: ColorMode; colorless?: boolean;
  types?: string[]; subtypes?: string[]; supertypes?: string[];
  set?: string; rarity?: Rarity[];
  format?: string; legality?: 'legal' | 'restricted' | 'banned';
  mvMin?: number; mvMax?: number; priceMin?: number; priceMax?: number;
  sort?: SortKey; dir?: 'asc' | 'desc';
  mode?: 'oracle' | 'printing';
  lang?: string;
  playable?: boolean;   // default true (excludes tokens, emblems, art cards, ...)
  hasImage?: boolean;
  /** Only cards in the registered collection (needs user.db attached via attachUser). */
  owned?: boolean;
  page?: number; pageSize?: number;
}

export interface CardSummary {
  oracleId: string; printingId: string; name: string; typeLine: string; manaCost: string | null; manaValue: number;
  colors: Color[]; colorIdentity: Color[]; rarity: Rarity; setCode: string; setName: string; collectorNumber: string;
  releasedAt: string | null; edhrecRank: number | null; priceUsd: number | null; layout: string; hasBack: boolean;
  frame: string | null; frameEffects: string[]; finishes: string[]; fullArt: boolean; borderColor: string | null; artist: string | null;
  /** Copies in the registered collection; null when no collection database is attached. */
  owned: number | null;
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

export interface PrintingDetail {
  id: string; oracleId: string; name: string; setCode: string; setName: string; setType: string; collectorNumber: string; releasedAt: string | null;
  rarity: Rarity; artist: string | null; lang: string; layout: string; digital: boolean; promo: boolean; reprint: boolean;
  finishes: string[]; frame: string | null; frameEffects: string[]; borderColor: string | null; securityStamp: string | null;
  fullArt: boolean; textless: boolean; promoTypes: string[]; games: string[]; booster: boolean; variation: boolean;
  prices: { usd: number | null; usdFoil: number | null; usdEtched: number | null; eur: number | null; tix: number | null };
  flavorText: string | null; scryfallUri: string | null; hasBack: boolean; hasImage: boolean;
  ids: { arena: number | null; mtgo: number | null; tcgplayer: number | null };
  faces: { name: string; manaCost: string | null; typeLine: string | null; oracleText: string | null; power: string | null; toughness: string | null; loyalty: string | null; defense: string | null; colors: Color[]; flavorText: string | null; artist: string | null }[];
}

export interface CardDetail {
  oracleId: string; name: string; layout: string; typeLine: string; manaCost: string | null; manaValue: number;
  colors: Color[]; colorIdentity: Color[]; oracleText: string; power: string | null; toughness: string | null; loyalty: string | null; defense: string | null;
  keywords: string[]; reserved: boolean; edhrecRank: number | null; firstPrinted: string | null; printingCount: number;
  representativePrintingId: string; hasBack: boolean;
  /** Copies in the registered collection; null when no collection database is attached. */
  owned: number | null;
  def: CardDef;
  printings: PrintingDetail[];
  rulings: { publishedAt: string; comment: string }[];
  legalities: Record<string, string>;
}

export interface SetSummary { code: string; name: string; setType: string; releasedAt: string | null; cardCount: number; parentSetCode: string | null; digital: boolean; block: string | null }

const COLOR_BIT: Record<string, number> = { W: 1, U: 2, B: 4, R: 8, G: 16 };
const RARITY_BIT: Record<string, number> = { common: 1, uncommon: 2, rare: 4, mythic: 8, special: 16, bonus: 32 };
const maskOf = (cs: Color[]) => cs.reduce((m, c) => m | (COLOR_BIT[c] ?? 0), 0);
const colorsOfMask = (m: number): Color[] => (['W', 'U', 'B', 'R', 'G'] as Color[]).filter(c => m & COLOR_BIT[c]);
const j = <T>(s: string | null | undefined, d: T): T => { if (!s) return d; try { return JSON.parse(s) as T; } catch { return d; } };

/** Turn a free-text query into an FTS5 MATCH expression. Supports `o:text`, `t:type`, `n:name` prefixes and quoted phrases. */
export function ftsExpression(q: string): string | null {
  const tokens = q.match(/(?:[ont]:)?"[^"]+"|\S+/g) ?? [];
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    let col: string | null = null;
    const m = tok.match(/^([ont]):(.+)$/);
    if (m) { col = { o: 'oracle_text', t: 'type_line', n: 'name' }[m[1]]!; tok = m[2]; }
    const phrase = tok.startsWith('"') && tok.endsWith('"') && tok.length > 1;
    const words = tok.replace(/"/g, '').split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}\-+/']/gu, '')).filter(Boolean);
    if (!words.length) continue;
    const last = i === tokens.length - 1 && !phrase;
    const body = phrase ? `"${words.join(' ')}"` : words.map((w, k) => `"${w}"${last && k === words.length - 1 && w.length >= 2 ? '*' : ''}`).join(' ');
    parts.push(col ? `${col}:(${body})` : `(${body})`);
  }
  return parts.length ? parts.join(' AND ') : null;
}

export class CardQueryDB {
  private countCache = new Map<string, number>();
  private setsCache: SetSummary[] | null = null;
  private userAttached = false;
  constructor(readonly db: Database.Database) {}

  hasWebIndex(): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_index'").get();
  }

  /**
   * Attach user.db (read-only) so searches can join the collection. The WAL/-shm files must already exist, which is
   * the case whenever the read-write connection has been opened first. Returns whether the join is available.
   */
  attachUser(dbPath: string): boolean {
    if (this.userAttached) return true;
    try {
      this.db.exec(`ATTACH DATABASE '${dbPath.replace(/'/g, "''")}' AS user`);
      this.userAttached = !!this.db.prepare("SELECT 1 FROM user.sqlite_master WHERE type='view' AND name='collection_owned'").get();
      if (!this.userAttached) this.db.exec('DETACH DATABASE user');
    } catch { this.userAttached = false; }
    if (this.userAttached) this.countCache.clear();
    return this.userAttached;
  }
  hasUser(): boolean { return this.userAttached; }
  /** Bumped by every collection write; part of the count-cache key for owned-filtered searches. */
  ownedVersion(): number {
    if (!this.userAttached) return 0;
    try { const r = this.db.prepare("SELECT value FROM user.settings WHERE key = 'collection_version'").get() as { value: string } | undefined; return r ? Number(JSON.parse(r.value)) || 0 : 0; } catch { return 0; }
  }
  private ownedJoin(): string { return this.userAttached ? ' LEFT JOIN user.collection_owned co ON co.oracle_id = ci.oracle_id' : ''; }
  private ownedSelect(): string { return this.userAttached ? ', co.count AS owned' : ''; }

  // ------------------------------------------------------------------ search
  search(q: CardQuery): Page<CardSummary> {
    const mode = q.mode ?? 'oracle';
    const page = Math.max(1, q.page ?? 1); const pageSize = Math.min(120, Math.max(1, q.pageSize ?? 60));
    const where: string[] = []; const params: unknown[] = [];
    const fts = q.q ? ftsExpression(q.q) : null;
    const useFts = !!fts;
    if (q.playable !== false) where.push('ci.playable = 1');
    // FTS goes into a CTE so MATCH never shares a WHERE with other predicates (SQLite rejects MATCH in some OR/EXISTS contexts)
    const withSql = useFts ? 'WITH m AS (SELECT rowid AS id, bm25(card_fts, 12.0, 1.0, 2.0, 1.0, 1.5) AS rank FROM card_fts WHERE card_fts MATCH ?) ' : '';
    const withParams: unknown[] = useFts ? [fts] : [];
    if (q.colors?.length) {
      const m = maskOf(q.colors); const cm = q.colorMode ?? 'any';
      if (cm === 'exact') { where.push('ci.color_mask = ?'); params.push(m); }
      else if (cm === 'subset') { where.push('(ci.color_mask & ~?) = 0'); params.push(m); }
      else if (cm === 'superset') { where.push('(ci.color_mask & ?) = ?'); params.push(m, m); }
      else if (cm === 'identity') { where.push('(ci.identity_mask & ~?) = 0'); params.push(m); }
      else { where.push('(ci.color_mask & ?) != 0'); params.push(m); }
    }
    if (q.colorless) where.push('ci.color_mask = 0');
    for (const t of q.types ?? []) { where.push("ci.types LIKE ? COLLATE NOCASE"); params.push(`% ${t} %`); }
    for (const t of q.supertypes ?? []) { where.push("ci.supertypes LIKE ? COLLATE NOCASE"); params.push(`% ${t} %`); }
    for (const t of q.subtypes ?? []) { where.push("ci.subtypes LIKE ? COLLATE NOCASE"); params.push(`% ${t} %`); }
    if (q.format) { where.push('EXISTS (SELECT 1 FROM legalities l WHERE l.oracle_id = ci.oracle_id AND l.format = ? AND l.status = ?)'); params.push(q.format.toLowerCase(), q.legality ?? 'legal'); }
    if (q.mvMin != null) { where.push('ci.mana_value >= ?'); params.push(q.mvMin); }
    if (q.mvMax != null) { where.push('ci.mana_value <= ?'); params.push(q.mvMax); }
    if (mode === 'oracle') {
      if (q.set) { where.push('EXISTS (SELECT 1 FROM printings x WHERE x.oracle_id = ci.oracle_id AND x.set_code = ?)'); params.push(q.set.toLowerCase()); }
      if (q.rarity?.length) { where.push('(ci.rarity_mask & ?) != 0'); params.push(q.rarity.reduce((m, r) => m | (RARITY_BIT[r] ?? 0), 0)); }
      if (q.priceMin != null) { where.push('ci.price_usd >= ?'); params.push(q.priceMin); }
      if (q.priceMax != null) { where.push('ci.price_usd <= ?'); params.push(q.priceMax); }
      // no OR here: an OR alongside an FTS MATCH makes SQLite refuse the query ("unable to use function MATCH in the requested context")
      if (q.hasImage) where.push('EXISTS (SELECT 1 FROM printing_images pi WHERE pi.printing_id = p.id)');
    } else {
      where.push('p.lang = ?'); params.push(q.lang ?? 'en');
      if (q.set) { where.push('p.set_code = ?'); params.push(q.set.toLowerCase()); }
      if (q.rarity?.length) { where.push(`p.rarity IN (${q.rarity.map(() => '?').join(',')})`); params.push(...q.rarity); }
      if (q.priceMin != null) { where.push('pm.price_usd >= ?'); params.push(q.priceMin); }
      if (q.priceMax != null) { where.push('pm.price_usd <= ?'); params.push(q.priceMax); }
      if (q.hasImage) where.push('EXISTS (SELECT 1 FROM printing_images pi WHERE pi.printing_id = p.id)');
    }
    if (q.owned) where.push(this.userAttached ? 'co.count > 0' : '0');
    const from = (mode === 'oracle'
      ? `FROM card_index ci ${useFts ? 'JOIN m ON m.id = ci.id ' : ''}JOIN printings p ON p.id = ci.rep_printing_id LEFT JOIN printing_meta pm ON pm.printing_id = p.id`
      : `FROM printings p JOIN card_index ci ON ci.oracle_id = p.oracle_id ${useFts ? 'JOIN m ON m.id = ci.id ' : ''}LEFT JOIN printing_meta pm ON pm.printing_id = p.id`) + this.ownedJoin();
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const dir = (q.dir ?? (q.sort === 'edhrec' || q.sort === 'name' || q.sort === 'collector' || q.sort === 'mv' ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
    const sort = q.sort ?? (useFts ? 'relevance' : 'edhrec');
    const orderBy = {
      relevance: useFts ? `m.rank ASC, ci.name ASC` : `ci.name COLLATE NOCASE ASC`,
      name: `ci.name COLLATE NOCASE ${dir}, p.released_at DESC`,
      released: mode === 'oracle' ? `ci.first_printed ${dir}, ci.name ASC` : `p.released_at ${dir}, p.set_code, CAST(p.collector_number AS INTEGER), p.collector_number`,
      edhrec: `ci.edhrec_rank IS NULL, ci.edhrec_rank ${dir}, ci.name ASC`,
      price: mode === 'oracle' ? `ci.price_usd IS NULL, ci.price_usd ${dir}, ci.name ASC` : `pm.price_usd IS NULL, pm.price_usd ${dir}, ci.name ASC`,
      mv: `ci.mana_value ${dir}, ci.name ASC`,
      collector: `p.set_code ASC, CAST(p.collector_number AS INTEGER) ${dir}, p.collector_number ${dir}`,
    }[sort];
    const select = `SELECT ci.oracle_id, ci.name AS ci_name, ci.type_line AS ci_type_line, ci.mana_cost AS ci_mana_cost, ci.mana_value, ci.color_mask, ci.identity_mask, ci.edhrec_rank, ci.layout AS ci_layout, ci.has_back AS ci_has_back, ci.price_usd AS ci_price,
      p.id AS printing_id, p.rarity, p.set_code, p.set_name, p.collector_number, p.released_at, p.artist, p.layout AS p_layout,
      pm.frame, pm.frame_effects, pm.finishes, pm.full_art, pm.border_color, pm.has_back AS pm_has_back, pm.price_usd AS pm_price${this.ownedSelect()}`;
    const rows = this.db.prepare(`${withSql}${select} ${from} ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...withParams, ...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    const countKey = JSON.stringify([mode, where, withParams, params, q.owned ? this.ownedVersion() : 0]);
    let total = this.countCache.get(countKey);
    if (total === undefined) {
      total = (this.db.prepare(`${withSql}SELECT count(*) AS n ${from} ${whereSql}`).get(...withParams, ...params) as { n: number }).n;
      if (this.countCache.size > 500) this.countCache.clear();
      this.countCache.set(countKey, total);
    }
    return { items: rows.map(r => this.rowToSummary(r, mode)), total, page, pageSize };
  }

  private rowToSummary(r: Record<string, unknown>, mode: 'oracle' | 'printing'): CardSummary {
    return {
      oracleId: r.oracle_id as string, printingId: r.printing_id as string, name: r.ci_name as string, typeLine: (r.ci_type_line as string) ?? '',
      manaCost: (r.ci_mana_cost as string) || null, manaValue: (r.mana_value as number) ?? 0,
      colors: colorsOfMask(r.color_mask as number), colorIdentity: colorsOfMask(r.identity_mask as number),
      rarity: r.rarity as Rarity, setCode: r.set_code as string, setName: r.set_name as string, collectorNumber: r.collector_number as string,
      releasedAt: (r.released_at as string) ?? null, edhrecRank: (r.edhrec_rank as number) ?? null,
      priceUsd: mode === 'oracle' ? ((r.ci_price as number) ?? (r.pm_price as number) ?? null) : ((r.pm_price as number) ?? null),
      layout: (r.p_layout as string) ?? (r.ci_layout as string), hasBack: mode === 'oracle' ? !!(r.ci_has_back || r.pm_has_back) : !!r.pm_has_back,
      frame: (r.frame as string) ?? null, frameEffects: j<string[]>(r.frame_effects as string, []), finishes: j<string[]>(r.finishes as string, []),
      fullArt: !!r.full_art, borderColor: (r.border_color as string) ?? null, artist: (r.artist as string) ?? null,
      owned: this.userAttached ? Number(r.owned ?? 0) : null,
    };
  }

  // ------------------------------------------------------------------ autocomplete
  autocomplete(prefix: string, limit = 12): { name: string; oracleId: string; printingId: string; typeLine: string; manaCost: string | null; owned: number | null }[] {
    const p = prefix.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 /]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!p) return [];
    const rows = this.db.prepare(`SELECT ci.name, ci.oracle_id, ci.rep_printing_id, ci.type_line, ci.mana_cost, (ci.name_norm = ?) AS exact, (ci.name_norm LIKE ?) AS starts${this.ownedSelect()} FROM card_index ci${this.ownedJoin()}
      WHERE ci.playable = 1 AND (ci.name_norm LIKE ? OR ci.name_norm LIKE ?) ORDER BY exact DESC, starts DESC, ci.edhrec_rank IS NULL, ci.edhrec_rank ASC, ci.name ASC LIMIT ?`)
      .all(p, `${p}%`, `${p}%`, `% ${p}%`, limit) as { name: string; oracle_id: string; rep_printing_id: string; type_line: string; mana_cost: string | null; owned?: number | null }[];
    return rows.map(r => ({ name: r.name, oracleId: r.oracle_id, printingId: r.rep_printing_id, typeLine: r.type_line, manaCost: r.mana_cost || null, owned: this.userAttached ? Number(r.owned ?? 0) : null }));
  }

  /** Copies of a card in the registered collection (0 when unowned, null when no collection is attached). */
  ownedCount(oracleId: string): number | null {
    if (!this.userAttached) return null;
    const r = this.db.prepare('SELECT count FROM user.collection_owned WHERE oracle_id = ?').get(oracleId) as { count: number } | undefined;
    return r?.count ?? 0;
  }

  // ------------------------------------------------------------------ detail
  detail(oracleId: string): CardDetail | null {
    const o = this.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as { json: string } | undefined;
    if (!o) return null;
    const oc = JSON.parse(o.json);
    const ci = this.db.prepare('SELECT rep_printing_id, has_back, edhrec_rank FROM card_index WHERE oracle_id = ?').get(oracleId) as { rep_printing_id: string; has_back: number; edhrec_rank: number | null } | undefined;
    const row: OracleRow = {
      name: oc.name, oracle_id: oc.oracle_id, mana_cost: oc.mana_cost, mana_value: oc.mana_value, colors: oc.colors, color_identity: oc.color_identity,
      types: oc.types, supertypes: oc.supertypes, subtypes: oc.subtypes, type_line: oc.type_line, oracle_text: oc.oracle_text, power: oc.power, toughness: oc.toughness,
      loyalty: oc.loyalty, keywords: oc.keywords, layout: oc.layout, produced_mana: oc.produced_mana, image: oc.image, representative_id: ci?.rep_printing_id ?? oc.representative_id,
      faces: oc.faces?.map((f: { name: string; type_line: string | null; oracle_text: string | null; power: string | null; toughness: string | null; mana_cost: string | null; image?: string | null }) => ({ name: f.name, type_line: f.type_line, oracle_text: f.oracle_text, power: f.power, toughness: f.toughness, mana_cost: f.mana_cost, image: f.image ?? null })),
    };
    const def = parseCard(row);
    const printings = this.printingsOf(oracleId);
    const rulings = (this.db.prepare('SELECT published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at').all(oracleId) as { published_at: string; comment: string }[]).map(r => ({ publishedAt: r.published_at, comment: r.comment }));
    const legalities: Record<string, string> = {};
    for (const l of this.db.prepare('SELECT format, status FROM legalities WHERE oracle_id = ?').all(oracleId) as { format: string; status: string }[]) legalities[l.format] = l.status;
    return {
      oracleId, name: oc.name, layout: oc.layout, typeLine: oc.type_line ?? '', manaCost: oc.mana_cost || null, manaValue: oc.mana_value ?? 0,
      colors: oc.colors ?? [], colorIdentity: oc.color_identity ?? [], oracleText: oc.oracle_text ?? '', power: oc.power ?? null, toughness: oc.toughness ?? null,
      loyalty: oc.loyalty ?? null, defense: oc.defense ?? null, keywords: oc.keywords ?? [], reserved: !!oc.reserved, edhrecRank: oc.edhrec_rank ?? ci?.edhrec_rank ?? null,
      firstPrinted: oc.first_printed ?? null, printingCount: oc.printing_count ?? printings.length,
      representativePrintingId: ci?.rep_printing_id ?? oc.representative_id, hasBack: !!ci?.has_back,
      owned: this.ownedCount(oracleId),
      def, printings, rulings, legalities,
    };
  }

  byPrinting(printingId: string): CardDetail | null {
    const r = this.db.prepare('SELECT oracle_id FROM printings WHERE id = ?').get(printingId) as { oracle_id: string } | undefined;
    return r ? this.detail(r.oracle_id) : null;
  }

  printing(printingId: string): PrintingDetail | null {
    const r = this.db.prepare('SELECT p.json, pm.* FROM printings p LEFT JOIN printing_meta pm ON pm.printing_id = p.id WHERE p.id = ?').get(printingId) as (Record<string, unknown> & { json: string }) | undefined;
    return r ? this.rowToPrinting(r) : null;
  }

  printingsOf(oracleId: string): PrintingDetail[] {
    const rows = this.db.prepare('SELECT p.json, pm.* FROM printings p LEFT JOIN printing_meta pm ON pm.printing_id = p.id WHERE p.oracle_id = ? ORDER BY p.released_at DESC, p.set_code, CAST(p.collector_number AS INTEGER)').all(oracleId) as (Record<string, unknown> & { json: string })[];
    return rows.map(r => this.rowToPrinting(r));
  }

  private rowToPrinting(r: Record<string, unknown> & { json: string }): PrintingDetail {
    const c = JSON.parse(r.json);
    const prices = c.prices ?? {};
    const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
    const hasBack = !!r.has_back;
    return {
      id: c.id, oracleId: c.oracle_id, name: c.name, setCode: c.set, setName: c.set_name, setType: c.set_type, collectorNumber: c.collector_number, releasedAt: c.released_at ?? null,
      rarity: c.rarity, artist: c.artist ?? null, lang: c.lang, layout: c.layout, digital: !!c.digital, promo: !!c.promo, reprint: !!c.reprint,
      finishes: c.finishes ?? [], frame: c.frame ?? null, frameEffects: c.frame_effects ?? [], borderColor: c.border_color ?? null, securityStamp: c.security_stamp ?? null,
      fullArt: !!c.full_art, textless: !!c.textless, promoTypes: c.promo_types ?? [], games: c.games ?? [], booster: !!c.booster, variation: !!c.variation,
      prices: { usd: num(prices.usd), usdFoil: num(prices.usd_foil), usdEtched: num(prices.usd_etched), eur: num(prices.eur), tix: num(prices.tix) },
      flavorText: c.flavor_text ?? c.faces?.[0]?.flavor_text ?? null, scryfallUri: c.scryfall_uri ?? null, hasBack, hasImage: !!(c.image ?? c.faces?.[0]?.image),
      ids: { arena: c.ids?.arena ?? null, mtgo: c.ids?.mtgo ?? null, tcgplayer: c.ids?.tcgplayer ?? null },
      faces: (c.faces ?? []).map((f: Record<string, unknown>) => ({ name: f.name as string, manaCost: (f.mana_cost as string) || null, typeLine: (f.type_line as string) ?? null, oracleText: (f.oracle_text as string) ?? null, power: (f.power as string) ?? null, toughness: (f.toughness as string) ?? null, loyalty: (f.loyalty as string) ?? null, defense: (f.defense as string) ?? null, colors: (f.colors as Color[]) ?? [], flavorText: (f.flavor_text as string) ?? null, artist: (f.artist as string) ?? null })),
    };
  }

  // ------------------------------------------------------------------ sets / images / misc
  sets(): SetSummary[] {
    if (!this.setsCache) {
      this.setsCache = (this.db.prepare('SELECT code, name, set_type, released_at, card_count, parent_set_code, digital, block FROM sets ORDER BY released_at DESC').all() as Record<string, unknown>[])
        .map(r => ({ code: r.code as string, name: r.name as string, setType: r.set_type as string, releasedAt: (r.released_at as string) ?? null, cardCount: (r.card_count as number) ?? 0, parentSetCode: (r.parent_set_code as string) ?? null, digital: !!r.digital, block: (r.block as string) ?? null }));
    }
    return this.setsCache;
  }

  set(code: string): SetSummary | null { return this.sets().find(s => s.code === code.toLowerCase()) ?? null; }

  imageSource(printingId: string, face: number): string | null {
    const r = this.db.prepare('SELECT url FROM printing_images WHERE printing_id = ? AND face = ?').get(printingId, face) as { url: string } | undefined;
    return r?.url ?? null;
  }

  /** Random playable cards with an image (landing page / showcase). */
  random(n: number, opts: { seed?: number; rarity?: Rarity[]; frameEffect?: string } = {}): CardSummary[] {
    const where: string[] = ['ci.playable = 1', 'p.lang = ?']; const params: unknown[] = ['en'];
    if (opts.rarity?.length) { where.push(`p.rarity IN (${opts.rarity.map(() => '?').join(',')})`); params.push(...opts.rarity); }
    if (opts.frameEffect) { where.push('pm.frame_effects LIKE ?'); params.push(`%"${opts.frameEffect}"%`); }
    where.push('EXISTS (SELECT 1 FROM printing_images pi WHERE pi.printing_id = p.id)');
    const order = opts.seed != null ? `(CAST(substr(p.id, 1, 8) AS INTEGER) + ${Math.floor(opts.seed)}) % 9973, p.id` : 'random()';
    const rows = this.db.prepare(`SELECT ci.oracle_id, ci.name AS ci_name, ci.type_line AS ci_type_line, ci.mana_cost AS ci_mana_cost, ci.mana_value, ci.color_mask, ci.identity_mask, ci.edhrec_rank, ci.layout AS ci_layout, ci.has_back AS ci_has_back, ci.price_usd AS ci_price,
      p.id AS printing_id, p.rarity, p.set_code, p.set_name, p.collector_number, p.released_at, p.artist, p.layout AS p_layout,
      pm.frame, pm.frame_effects, pm.finishes, pm.full_art, pm.border_color, pm.has_back AS pm_has_back, pm.price_usd AS pm_price${this.ownedSelect()}
      FROM printings p JOIN card_index ci ON ci.oracle_id = p.oracle_id LEFT JOIN printing_meta pm ON pm.printing_id = p.id${this.ownedJoin()} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...params, n) as Record<string, unknown>[];
    return rows.map(r => this.rowToSummary(r, 'printing'));
  }

  counts(): { cards: number; printings: number; sets: number } {
    return {
      cards: (this.db.prepare('SELECT count(*) AS n FROM card_index WHERE playable = 1').get() as { n: number }).n,
      printings: (this.db.prepare('SELECT count(*) AS n FROM printings').get() as { n: number }).n,
      sets: (this.db.prepare('SELECT count(*) AS n FROM sets').get() as { n: number }).n,
    };
  }

  /** Resolve a printing by set code + collector number (deck imports). */
  printingIdBySetNumber(set: string, number: string): string | null {
    const r = this.db.prepare("SELECT id FROM printings WHERE set_code = ? AND collector_number = ? AND lang = 'en' LIMIT 1").get(set.toLowerCase(), number) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Vocabulary for filter UIs. */
  catalog(kind: 'types' | 'subtypes' | 'supertypes' | 'keywords', prefix = '', limit = 30): string[] {
    const col = kind;
    const rows = this.db.prepare(`SELECT ${col} AS v FROM card_index WHERE playable = 1 AND ${col} IS NOT NULL`).all() as { v: string }[];
    const counts = new Map<string, number>();
    for (const r of rows) for (const w of r.v.trim().split(' ')) if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    const p = prefix.toLowerCase();
    return [...counts.entries()].filter(([w]) => !p || w.toLowerCase().startsWith(p)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
  }
}
