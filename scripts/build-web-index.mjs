// Augments data/master/master.db with the tables the web app needs: a browse/search index over oracle cards
// (card_index + card_fts), per-printing extras pulled out of the JSON blob (printing_meta, printing_images)
// and a few indexes on the existing tables. Idempotent: re-run after `npm run data:build`.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NON_PLAYABLE_LAYOUTS, NON_PLAYABLE_TYPE_PREFIXES } from './lib.mjs';

const t0 = Date.now();
const OUT = path.resolve('data/master');
const dbPath = path.join(OUT, 'master.db');
if (!fs.existsSync(dbPath)) { console.error('master.db not found; run npm run data:all first'); process.exit(1); }
const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));

const db = new Database(dbPath);
db.pragma('journal_mode = OFF'); db.pragma('synchronous = OFF'); db.pragma('cache_size = -262144');

const COLOR_BIT = { W: 1, U: 2, B: 4, R: 8, G: 16 };
const RARITY_BIT = { common: 1, uncommon: 2, rare: 4, mythic: 8, special: 16, bonus: 32 };
const mask = (arr, table) => (arr ?? []).reduce((m, c) => m | (table[c] ?? 0), 0);
const normName = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 /]+/g, ' ').replace(/\s+/g, ' ').trim();
const isPlayable = (layout, typeLine) => !NON_PLAYABLE_LAYOUTS.includes(layout) && !NON_PLAYABLE_TYPE_PREFIXES.some(p => (typeLine ?? '').startsWith(p));

console.log('dropping old index tables');
db.exec(`
DROP TABLE IF EXISTS card_fts; DROP TABLE IF EXISTS card_index; DROP TABLE IF EXISTS printing_meta; DROP TABLE IF EXISTS printing_images;
CREATE TABLE card_index (
  id INTEGER PRIMARY KEY, oracle_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_norm TEXT NOT NULL,
  layout TEXT NOT NULL, playable INTEGER NOT NULL, type_line TEXT, oracle_text TEXT, mana_cost TEXT, mana_value REAL NOT NULL DEFAULT 0,
  color_mask INTEGER NOT NULL, color_count INTEGER NOT NULL, identity_mask INTEGER NOT NULL,
  supertypes TEXT, types TEXT, subtypes TEXT, power TEXT, toughness TEXT, loyalty TEXT, keywords TEXT,
  reserved INTEGER NOT NULL DEFAULT 0, first_printed TEXT, latest_printed TEXT, printing_count INTEGER NOT NULL,
  edhrec_rank INTEGER, price_usd REAL, rep_printing_id TEXT NOT NULL, rarity_mask INTEGER NOT NULL, has_back INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE printing_meta (
  printing_id TEXT PRIMARY KEY, price_usd REAL, price_usd_foil REAL, price_usd_etched REAL, price_eur REAL, price_tix REAL,
  finishes TEXT, has_foil INTEGER NOT NULL, has_nonfoil INTEGER NOT NULL, frame TEXT, frame_effects TEXT, border_color TEXT, security_stamp TEXT,
  full_art INTEGER, textless INTEGER, promo_types TEXT, games TEXT, arena_id INTEGER, mtgo_id INTEGER, tcgplayer_id INTEGER, scryfall_uri TEXT,
  flavor_text TEXT, edhrec_rank INTEGER, booster INTEGER, variation INTEGER, has_back INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE printing_images (printing_id TEXT NOT NULL, face INTEGER NOT NULL, url TEXT NOT NULL, PRIMARY KEY (printing_id, face));
`);

// ---- pass 1: printings → printing_meta, printing_images, per-oracle aggregates
console.log('pass 1: printings');
const insMeta = db.prepare(`INSERT INTO printing_meta VALUES (${'?,'.repeat(25)}?)`);
const insImg = db.prepare('INSERT OR REPLACE INTO printing_images VALUES (?,?,?)');
const agg = new Map(); // oracle_id -> { rarity, latest, price, rep:{score,released,id}, hasBack, edhrec }
const HAS_BACK_LAYOUTS = new Set(['transform', 'modal_dfc', 'double_faced_token', 'reversible_card', 'meld', 'art_series']);
let n = 0;
db.exec('BEGIN');
const pageP = db.prepare('SELECT rowid AS rid, id, oracle_id, released_at, lang, digital, promo, rarity, set_type, image, layout, json FROM printings WHERE rowid > ? ORDER BY rowid LIMIT 5000');
for (let last = 0; ;) {
  const rows = pageP.all(last); if (!rows.length) break; last = rows[rows.length - 1].rid;
  for (const row of rows) {
  const c = JSON.parse(row.json);
  const prices = c.prices ?? {};
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const finishes = c.finishes ?? [];
  const front = c.image ?? c.faces?.[0]?.image ?? null;
  const back = c.faces?.[1]?.image ?? null;
  const hasBack = !!back && HAS_BACK_LAYOUTS.has(row.layout);
  insMeta.run(row.id, num(prices.usd), num(prices.usd_foil), num(prices.usd_etched), num(prices.eur), num(prices.tix),
    JSON.stringify(finishes), finishes.includes('foil') ? 1 : 0, finishes.includes('nonfoil') ? 1 : 0,
    c.frame ?? null, JSON.stringify(c.frame_effects ?? []), c.border_color ?? null, c.security_stamp ?? null,
    c.full_art ? 1 : 0, c.textless ? 1 : 0, JSON.stringify(c.promo_types ?? []), JSON.stringify(c.games ?? []),
    c.ids?.arena ?? null, c.ids?.mtgo ?? null, c.ids?.tcgplayer ?? null, c.scryfall_uri ?? null,
    c.flavor_text ?? c.faces?.[0]?.flavor_text ?? null, c.edhrec_rank ?? null, c.booster ? 1 : 0, c.variation ? 1 : 0, hasBack ? 1 : 0);
  if (front) insImg.run(row.id, 0, front);
  if (hasBack) insImg.run(row.id, 1, back);
  if (row.oracle_id) {
    const a = agg.get(row.oracle_id) ?? { rarity: 0, latest: '', price: null, rep: null, hasBack: false, edhrec: null };
    a.rarity |= RARITY_BIT[row.rarity] ?? 0;
    if ((row.released_at ?? '') > a.latest) a.latest = row.released_at;
    const paper = (c.games ?? []).includes('paper');
    const usd = num(prices.usd) ?? num(prices.usd_foil);
    if (paper && row.lang === 'en' && usd != null && (a.price == null || usd < a.price)) a.price = usd;
    if (hasBack) a.hasBack = true;
    if (c.edhrec_rank != null) a.edhrec = c.edhrec_rank;
    // representative printing: english, paper, has image, not promo/variation/textless, newest
    let score = 0;
    if (row.lang !== 'en') score += 100; if (!paper) score += 50; if (!front) score += 1000;
    if (HAS_BACK_LAYOUTS.has(row.layout) && !hasBack) score += 500;
    if (row.promo) score += 5; if (c.variation) score += 3; if (c.textless) score += 10; if (c.full_art) score += 1;
    if (['promo', 'memorabilia', 'funny', 'minigame'].includes(row.set_type)) score += 4;
    if (!c.booster) score += 1; if (c.set === 'plst' || c.set === 'plist' || row.set_type === 'masterpiece') score += 3; // prefer a real booster printing over The List / masterpieces
    if (row.released_at && row.released_at > new Date().toISOString().slice(0, 10)) score += 2; // not yet released
    if ((c.frame_effects ?? []).length) score += 2; if (c.border_color === 'borderless') score += 2;
    if (!a.rep || score < a.rep.score || (score === a.rep.score && (row.released_at ?? '') > a.rep.released)) a.rep = { score, released: row.released_at ?? '', id: row.id };
    agg.set(row.oracle_id, a);
  }
  if (++n % 20000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); console.log(`  printings ${n}`); }
  }
}
db.exec('COMMIT');

// ---- pass 2: oracle cards → card_index
console.log('pass 2: oracle cards');
const insCI = db.prepare(`INSERT INTO card_index (oracle_id, name, name_norm, layout, playable, type_line, oracle_text, mana_cost, mana_value, color_mask, color_count, identity_mask, supertypes, types, subtypes, power, toughness, loyalty, keywords, reserved, first_printed, latest_printed, printing_count, edhrec_rank, price_usd, rep_printing_id, rarity_mask, has_back) VALUES (${'?,'.repeat(27)}?)`);
let no = 0;
db.exec('BEGIN');
const pageO = db.prepare('SELECT rowid AS rid, json FROM oracle_cards WHERE rowid > ? ORDER BY rowid LIMIT 5000');
for (let last = 0; ;) {
  const rows = pageO.all(last); if (!rows.length) break; last = rows[rows.length - 1].rid;
  for (const row of rows) {
  const o = JSON.parse(row.json);
  const a = agg.get(o.oracle_id) ?? { rarity: 0, latest: o.released_at, price: null, rep: null, hasBack: false, edhrec: o.edhrec_rank ?? null };
  const colors = o.colors ?? [];
  const join = (arr) => (arr && arr.length ? ' ' + arr.join(' ') + ' ' : null);
  insCI.run(o.oracle_id, o.name, normName(o.name), o.layout, isPlayable(o.layout, o.type_line) ? 1 : 0, o.type_line ?? null, o.oracle_text ?? null,
    o.mana_cost ?? null, o.mana_value ?? 0, mask(colors, COLOR_BIT), colors.length, mask(o.color_identity ?? [], COLOR_BIT),
    join(o.supertypes), join(o.types), join(o.subtypes), o.power ?? null, o.toughness ?? null, o.loyalty ?? null, join(o.keywords),
    o.reserved ? 1 : 0, o.first_printed ?? null, a.latest || o.released_at || null, o.printing_count ?? 1, o.edhrec_rank ?? a.edhrec ?? null,
    a.price, a.rep?.id ?? o.representative_id, a.rarity, a.hasBack ? 1 : 0);
  no++;
  }
}
db.exec('COMMIT');

console.log('fts + indexes');
db.exec(`
CREATE VIRTUAL TABLE card_fts USING fts5(name, oracle_text, type_line, subtypes, keywords, content='card_index', content_rowid='id', tokenize="unicode61 remove_diacritics 2 tokenchars '-+/'");
INSERT INTO card_fts(card_fts) VALUES ('rebuild');
CREATE INDEX idx_ci_name_norm ON card_index(name_norm);
CREATE INDEX idx_ci_name ON card_index(name);
CREATE INDEX idx_ci_mv ON card_index(mana_value);
CREATE INDEX idx_ci_edhrec ON card_index(edhrec_rank);
CREATE INDEX idx_ci_first ON card_index(first_printed);
CREATE INDEX idx_ci_latest ON card_index(latest_printed);
CREATE INDEX idx_ci_price ON card_index(price_usd);
CREATE INDEX idx_ci_playable ON card_index(playable);
CREATE INDEX IF NOT EXISTS idx_p_released ON printings(released_at);
CREATE INDEX IF NOT EXISTS idx_p_oracle_set ON printings(oracle_id, set_code);
CREATE INDEX IF NOT EXISTS idx_p_set_rarity ON printings(set_code, rarity);
CREATE INDEX IF NOT EXISTS idx_p_lang ON printings(lang);
CREATE INDEX IF NOT EXISTS idx_p_set_cn ON printings(set_code, collector_number);
CREATE INDEX IF NOT EXISTS idx_l_format_status ON legalities(format, status, oracle_id);
CREATE INDEX IF NOT EXISTS idx_sets_released ON sets(released_at);
ANALYZE;
`);
db.close();

const out = { built_at: new Date().toISOString(), source_built_at: summary.built_at, card_index: no, printings: n, seconds: (Date.now() - t0) / 1000 };
fs.writeFileSync(path.join(OUT, 'web-index.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
