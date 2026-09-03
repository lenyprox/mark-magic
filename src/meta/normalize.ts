// Card-name and archetype-name normalisation for scraped/synced decklists.
import type { CardDB } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import type { MetaBoard, NormalizedCard } from './types.js';

/** Strip Arena/Moxfield decorations from a card name: "4 Name (SET) 123 *F*", "A-Name" (Alchemy rebalance), "Name /// Back". */
export function cleanCardName(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\d+x?\s+/, '');                                       // leading count
  s = s.replace(/\s*\*[A-Za-z]\*\s*$/, '');                             // *F* foil markers
  s = s.replace(/\s+\(([A-Za-z0-9]{2,6})\)\s*[A-Za-z0-9★†-]*\s*$/, ''); // (SET) 123
  s = s.replace(/\s+<[^>]+>\s*$/, '');                                  // <set:number> style
  s = s.replace(/^A-(?=[A-Z])/, '');                                    // Alchemy "A-" prefix
  s = s.replace(/\s*\/\/\/\s*/g, ' // ');                               // triple slash separators
  s = s.replace(/\s*\/\/\s*/g, ' // ');                                 // normalise " // "
  s = s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  return s.trim();
}

export interface ResolvedName { name: string; oracleId: string | null; def: CardDef | null }

/** Resolve a (possibly decorated, possibly front-face) card name to its canonical oracle name and id. */
export function resolveCardName(db: CardDB, raw: string): ResolvedName {
  const name = cleanCardName(raw);
  if (!name) return { name, oracleId: null, def: null };
  let def = db.get(name);
  if (!def && name.includes(' // ')) def = db.get(name.split(' // ')[0]);
  if (!def && name.includes(' / ')) def = db.get(name.split(' / ')[0].trim());
  return { name: def?.name ?? name, oracleId: def?.oracleId ?? null, def };
}

export function isLandDef(def: CardDef | null): boolean {
  if (!def) return false;
  const types = def.types as string[];
  return types.includes('Land') && !types.includes('Creature');
}

/** Resolve and merge a raw card list (name/count/board) into normalised cards keyed by board+name. */
export function normalizeCards(db: CardDB | null, cards: { name: string; count: number; board?: MetaBoard | string }[]): NormalizedCard[] {
  const out = new Map<string, NormalizedCard>();
  for (const c of cards) {
    const count = Math.max(0, Math.floor(Number(c.count) || 0));
    if (!count) continue;
    const board = normalizeBoard(c.board);
    const r = db ? resolveCardName(db, c.name) : { name: cleanCardName(c.name), oracleId: null };
    if (!r.name) continue;
    const key = `${board} ${r.name.toLowerCase()}`;
    const prev = out.get(key);
    if (prev) prev.count += count; else out.set(key, { name: r.name, oracleId: r.oracleId, count, board });
  }
  return [...out.values()];
}

export interface ResolvedCard { name: string; oracleId: string | null; isLand: boolean }

/**
 * Fast name resolution for bulk decklist imports. `CardDB.get` is case-insensitive, which bypasses idx_o_name and costs
 * ~70 ms per lookup on the 884 MB master file; this tries an exact indexed match and an indexed front-face range scan first
 * and only falls back to CardDB.get for case-variant names. Results are memoised per cleaned name.
 */
export class NameResolver {
  private cache = new Map<string, ResolvedCard>();
  private exact;
  private prefix;
  constructor(private db: CardDB) {
    const filter = "layout NOT IN ('art_series','token','double_faced_token','emblem')";
    this.exact = db.db.prepare(`SELECT name, oracle_id, type_line FROM oracle_cards WHERE name = ? AND ${filter} ORDER BY first_printed LIMIT 1`);
    this.prefix = db.db.prepare(`SELECT name, oracle_id, type_line FROM oracle_cards WHERE name >= ? AND name < ? AND ${filter} ORDER BY first_printed LIMIT 1`);
  }

  resolve(raw: string): ResolvedCard {
    const name = cleanCardName(raw);
    const key = name.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    let row = this.exact.get(name) as { name: string; oracle_id: string; type_line: string | null } | undefined;
    if (!row) { const p = `${name.includes(' // ') ? name.split(' // ')[0] : name} // `; row = this.prefix.get(p, p + '￿') as typeof row; }
    let out: ResolvedCard;
    if (row) out = { name: row.name, oracleId: row.oracle_id, isLand: isLandTypeLine(row.type_line) };
    else { const def = this.db.get(name); out = def ? { name: def.name, oracleId: def.oracleId, isLand: isLandDef(def) } : { name, oracleId: null, isLand: false }; }
    this.cache.set(key, out);
    return out;
  }

  isLand(name: string): boolean { return this.resolve(name).isLand; }

  /** Same contract as normalizeCards (merge by board + canonical name). */
  normalize(cards: { name: string; count: number; board?: MetaBoard | string }[]): NormalizedCard[] {
    const out = new Map<string, NormalizedCard>();
    for (const c of cards) {
      const count = Math.max(0, Math.floor(Number(c.count) || 0));
      if (!count) continue;
      const board = normalizeBoard(c.board);
      const r = this.resolve(c.name);
      if (!r.name) continue;
      const key = `${board} ${r.name.toLowerCase()}`;
      const prev = out.get(key);
      if (prev) prev.count += count; else out.set(key, { name: r.name, oracleId: r.oracleId, count, board });
    }
    return [...out.values()];
  }
}

/** Land test on a type line; multi-face cards use the front face ("Sorcery // Land" is a spell). */
export function isLandTypeLine(typeLine: string | null): boolean {
  const front = (typeLine ?? '').split(' // ')[0];
  return /\bLand\b/.test(front) && !/\bCreature\b/.test(front);
}

export function normalizeBoard(b: string | undefined): MetaBoard {
  const k = (b ?? 'main').toLowerCase();
  if (k.startsWith('side')) return 'side';
  if (k.startsWith('command')) return 'commander';
  return 'main';
}

/** Canonical archetype name: whitespace-collapsed, punctuation-normalised, common suffixes removed. */
export function canonicalArchetypeName(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/[’‘]/g, "'");
  s = s.replace(/\s*\((?:paper|online|arena)\)\s*$/i, '');
  s = s.replace(/\s+decks?$/i, '');
  s = s.replace(/^mono[\s-]+/i, 'Mono-');
  s = s.replace(/\b([WUBRG])\s*\/\s*([WUBRG])\b/g, '$1$2');
  return s.trim();
}

/** Lookup key for an archetype name (case/punctuation-insensitive). */
export function archetypeKey(name: string): string {
  return canonicalArchetypeName(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
