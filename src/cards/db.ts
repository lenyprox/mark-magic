// Card database access: loads oracle cards from data/master/master.db and parses them into CardDefs.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { parseCard, type OracleRow } from './parse.js';
import type { CardDef } from './types.js';

export class CardDB {
  private db: Database.Database;
  private cache = new Map<string, CardDef | null>();
  constructor(dbPath = path.resolve('data/master/master.db')) {
    if (!fs.existsSync(dbPath)) throw new Error(`Master database not found at ${dbPath}. Run: npm run data:all`);
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  private rowToOracle(json: string): OracleRow {
    const o = JSON.parse(json);
    return {
      name: o.name, oracle_id: o.oracle_id, mana_cost: o.mana_cost, mana_value: o.mana_value, colors: o.colors, color_identity: o.color_identity,
      types: o.types, supertypes: o.supertypes, subtypes: o.subtypes, type_line: o.type_line, oracle_text: o.oracle_text, power: o.power, toughness: o.toughness,
      loyalty: o.loyalty, keywords: o.keywords, layout: o.layout, produced_mana: o.produced_mana, image: o.image,
      faces: o.faces?.map((f: OracleRow['faces'] extends (infer T)[] | undefined ? T : never) => ({ name: f.name, type_line: f.type_line, oracle_text: f.oracle_text, power: f.power, toughness: f.toughness, mana_cost: f.mana_cost })),
    };
  }

  /** Exact (case-insensitive) name lookup; also matches the front face name of multi-face cards. */
  get(name: string): CardDef | null {
    const key = name.trim().toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    let row = this.db.prepare('SELECT json FROM oracle_cards WHERE name = ? COLLATE NOCASE AND layout NOT IN (\'art_series\',\'token\',\'double_faced_token\',\'emblem\') ORDER BY first_printed LIMIT 1').get(name.trim()) as { json: string } | undefined;
    if (!row) row = this.db.prepare("SELECT json FROM oracle_cards WHERE name LIKE ? COLLATE NOCASE AND layout NOT IN ('art_series','token','double_faced_token','emblem') ORDER BY first_printed LIMIT 1").get(name.trim() + ' // %') as { json: string } | undefined;
    const def = row ? parseCard(this.rowToOracle(row.json)) : null;
    this.cache.set(key, def);
    return def;
  }

  search(pattern: string, limit = 20): { name: string; type_line: string; mana_cost: string | null }[] {
    return this.db.prepare("SELECT name, type_line, mana_cost FROM oracle_cards WHERE name LIKE ? COLLATE NOCASE AND layout NOT IN ('art_series','token','double_faced_token','emblem') ORDER BY name LIMIT ?").all(`%${pattern}%`, limit) as { name: string; type_line: string; mana_cost: string | null }[];
  }

  /** Iterate every playable oracle card (used by the coverage report). */
  *all(): Generator<CardDef> {
    const stmt = this.db.prepare("SELECT json FROM oracle_cards WHERE layout NOT IN ('art_series','token','double_faced_token','emblem','vanguard','planar','scheme','front_card') AND type_line NOT LIKE 'Card%' AND type_line NOT LIKE 'Stickers%' AND type_line NOT LIKE 'Dungeon%' AND type_line NOT LIKE 'Phenomenon%' AND type_line NOT LIKE 'Conspiracy%'");
    for (const r of stmt.iterate() as Iterable<{ json: string }>) yield parseCard(this.rowToOracle(r.json));
  }

  rulings(oracleId: string): { published_at: string; comment: string }[] {
    return this.db.prepare('SELECT published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at').all(oracleId) as { published_at: string; comment: string }[];
  }

  close() { this.db.close(); }
}

export interface DeckList { name: string; cards: { name: string; count: number }[] }

/** Parse a text deck list: lines of "4 Lightning Bolt" or "4x Lightning Bolt"; "//" comments; blank lines ignored. */
export function parseDeckList(text: string, name = 'deck'): DeckList {
  const cards: { name: string; count: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line || /^(sideboard|deck|main)/i.test(line)) continue;
    const m = line.match(/^(\d+)x?\s+(.+?)(?:\s+\([A-Za-z0-9]+\)\s*\d*)?$/);
    if (m) cards.push({ name: m[2].trim(), count: Number(m[1]) });
    else cards.push({ name: line, count: 1 });
  }
  return { name, cards };
}

export function loadDeck(db: CardDB, list: DeckList): { cards: CardDef[]; missing: string[]; partial: CardDef[] } {
  const cards: CardDef[] = []; const missing: string[] = []; const partial: CardDef[] = [];
  for (const { name, count } of list.cards) {
    const def = db.get(name);
    if (!def) { missing.push(name); continue; }
    if (!def.fullyParsed && !partial.includes(def)) partial.push(def);
    for (let i = 0; i < count; i++) cards.push(def);
  }
  return { cards, missing, partial };
}
