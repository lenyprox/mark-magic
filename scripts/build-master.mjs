// Builds the master card file from raw Scryfall data.
// Outputs: data/master/printings.jsonl (every printing), data/master/oracle.jsonl (every distinct card),
//          data/master/master.db (SQLite), data/master/summary.json
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readJsonl, manaValueOf, splitTypeLine } from './lib.mjs';

const RAW = path.resolve('data/raw'), OUT = path.resolve('data/master');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();

// ---- rulings keyed by oracle_id
const rulings = new Map();
for await (const r of readJsonl(path.join(RAW, 'rulings.jsonl.gz'))) {
  if (!rulings.has(r.oracle_id)) rulings.set(r.oracle_id, []);
  rulings.get(r.oracle_id).push({ source: r.source, published_at: r.published_at, comment: r.comment });
}
console.log(`rulings: ${rulings.size} oracle ids`);

// ---- sets
const sets = JSON.parse(fs.readFileSync(path.join(RAW, 'sets.json'), 'utf8'));

// ---- normalise one Scryfall card object (any layout) into our schema
function faceOf(f, parent) {
  return {
    name: f.name,
    oracle_id: f.oracle_id ?? parent.oracle_id ?? null,
    mana_cost: f.mana_cost ?? null,
    mana_value: f.mana_cost ? manaValueOf(f.mana_cost) : (f.cmc ?? null),
    type_line: f.type_line ?? null,
    oracle_text: f.oracle_text ?? null,
    colors: f.colors ?? parent.colors ?? [],
    color_indicator: f.color_indicator ?? null,
    power: f.power ?? null, toughness: f.toughness ?? null,
    loyalty: f.loyalty ?? null, defense: f.defense ?? null,
    flavor_text: f.flavor_text ?? null, artist: f.artist ?? null,
    illustration_id: f.illustration_id ?? null,
    image: f.image_uris?.normal ?? null,
    watermark: f.watermark ?? null,
  };
}

export function normalise(c) {
  const faces = (c.card_faces?.length ? c.card_faces : [c]).map(f => faceOf(f, c));
  const types = splitTypeLine(c.type_line ?? faces[0].type_line ?? '');
  return {
    id: c.id,
    // reversible_card layouts carry oracle_id on faces rather than the top level
    oracle_id: c.oracle_id ?? c.card_faces?.[0]?.oracle_id ?? null,
    name: c.name, lang: c.lang, layout: c.layout,
    released_at: c.released_at,
    set: c.set, set_name: c.set_name, set_type: c.set_type, collector_number: c.collector_number,
    rarity: c.rarity,
    mana_cost: c.mana_cost ?? faces[0].mana_cost ?? null, mana_value: c.cmc,
    type_line: c.type_line ?? null, ...types,
    oracle_text: c.oracle_text ?? (c.card_faces?.length ? c.card_faces.map(f => f.oracle_text ?? '').join('\n//\n') : null),
    colors: c.colors ?? null, color_identity: c.color_identity ?? [],
    color_indicator: c.color_indicator ?? null,
    produced_mana: c.produced_mana ?? null,
    power: c.power ?? faces[0].power ?? null, toughness: c.toughness ?? faces[0].toughness ?? null, loyalty: c.loyalty ?? faces[0].loyalty ?? null, defense: c.defense ?? faces[0].defense ?? null,
    hand_modifier: c.hand_modifier ?? null, life_modifier: c.life_modifier ?? null,
    keywords: c.keywords ?? [],
    legalities: c.legalities ?? {},
    games: c.games ?? [], finishes: c.finishes ?? [],
    reserved: !!c.reserved, reprint: !!c.reprint, digital: !!c.digital, promo: !!c.promo, oversized: !!c.oversized,
    variation: !!c.variation, full_art: !!c.full_art, textless: !!c.textless, booster: !!c.booster,
    promo_types: c.promo_types ?? null, frame: c.frame ?? null, frame_effects: c.frame_effects ?? null,
    border_color: c.border_color ?? null, security_stamp: c.security_stamp ?? null,
    artist: c.artist ?? null, artist_ids: c.artist_ids ?? null, illustration_id: c.illustration_id ?? null,
    flavor_text: c.flavor_text ?? null, flavor_name: c.flavor_name ?? null, watermark: c.watermark ?? null,
    image: c.image_uris?.normal ?? null,
    ids: { multiverse: c.multiverse_ids ?? [], mtgo: c.mtgo_id ?? null, mtgo_foil: c.mtgo_foil_id ?? null, arena: c.arena_id ?? null, tcgplayer: c.tcgplayer_id ?? null, cardmarket: c.cardmarket_id ?? null },
    edhrec_rank: c.edhrec_rank ?? null, penny_rank: c.penny_rank ?? null,
    prices: c.prices ?? null,
    all_parts: c.all_parts?.map(p => ({ id: p.id, component: p.component, name: p.name, type_line: p.type_line })) ?? null,
    faces,
    scryfall_uri: c.scryfall_uri,
  };
}

// ---- SQLite schema
const dbPath = path.join(OUT, 'master.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);
db.pragma('journal_mode = OFF'); db.pragma('synchronous = OFF');
db.exec(`
CREATE TABLE sets (code TEXT PRIMARY KEY, name TEXT, set_type TEXT, released_at TEXT, card_count INTEGER, parent_set_code TEXT, digital INTEGER, block TEXT);
CREATE TABLE printings (id TEXT PRIMARY KEY, oracle_id TEXT, name TEXT, lang TEXT, layout TEXT, released_at TEXT, set_code TEXT, set_name TEXT, set_type TEXT, collector_number TEXT, rarity TEXT, mana_cost TEXT, mana_value REAL, type_line TEXT, oracle_text TEXT, colors TEXT, color_identity TEXT, power TEXT, toughness TEXT, loyalty TEXT, defense TEXT, keywords TEXT, reserved INTEGER, reprint INTEGER, digital INTEGER, promo INTEGER, artist TEXT, image TEXT, json TEXT);
CREATE TABLE oracle_cards (oracle_id TEXT PRIMARY KEY, name TEXT, layout TEXT, mana_cost TEXT, mana_value REAL, type_line TEXT, supertypes TEXT, types TEXT, subtypes TEXT, oracle_text TEXT, colors TEXT, color_identity TEXT, power TEXT, toughness TEXT, loyalty TEXT, defense TEXT, keywords TEXT, reserved INTEGER, first_printed TEXT, printing_count INTEGER, representative_id TEXT, json TEXT);
CREATE TABLE faces (printing_id TEXT, face_index INTEGER, name TEXT, mana_cost TEXT, type_line TEXT, oracle_text TEXT, power TEXT, toughness TEXT, loyalty TEXT, PRIMARY KEY (printing_id, face_index));
CREATE TABLE rulings (oracle_id TEXT, published_at TEXT, source TEXT, comment TEXT);
CREATE TABLE legalities (oracle_id TEXT, format TEXT, status TEXT, PRIMARY KEY (oracle_id, format));
`);
const insSet = db.prepare('INSERT INTO sets VALUES (?,?,?,?,?,?,?,?)');
for (const s of sets) insSet.run(s.code, s.name, s.set_type, s.released_at ?? null, s.card_count, s.parent_set_code ?? null, s.digital ? 1 : 0, s.block ?? null);

const insP = db.prepare(`INSERT INTO printings VALUES (${'?,'.repeat(28)}?)`);
const insF = db.prepare('INSERT INTO faces VALUES (?,?,?,?,?,?,?,?,?)');
const insR = db.prepare('INSERT INTO rulings VALUES (?,?,?,?)');
const insL = db.prepare('INSERT OR REPLACE INTO legalities VALUES (?,?,?)');
const insO = db.prepare(`INSERT INTO oracle_cards VALUES (${'?,'.repeat(21)}?)`);

// ---- stream printings
const printingsOut = fs.createWriteStream(path.join(OUT, 'printings.jsonl'));
const oracleAgg = new Map(); // oracle_id -> {first_printed, count}
let n = 0;
db.exec('BEGIN');
for await (const raw of readJsonl(path.join(RAW, 'default_cards.jsonl.gz'))) {
  const c = normalise(raw);
  if (!printingsOut.write(JSON.stringify(c) + '\n')) await new Promise(r => printingsOut.once('drain', r));
  insP.run(c.id, c.oracle_id, c.name, c.lang, c.layout, c.released_at, c.set, c.set_name, c.set_type, c.collector_number, c.rarity, c.mana_cost, c.mana_value, c.type_line, c.oracle_text, JSON.stringify(c.colors), JSON.stringify(c.color_identity), c.power, c.toughness, c.loyalty, c.defense, JSON.stringify(c.keywords), +c.reserved, +c.reprint, +c.digital, +c.promo, c.artist, c.image, JSON.stringify(c));
  c.faces.forEach((f, i) => insF.run(c.id, i, f.name, f.mana_cost, f.type_line, f.oracle_text, f.power, f.toughness, f.loyalty));
  if (c.oracle_id) {
    const a = oracleAgg.get(c.oracle_id) ?? { first_printed: c.released_at, count: 0 };
    a.count++; if (c.released_at < a.first_printed) a.first_printed = c.released_at;
    oracleAgg.set(c.oracle_id, a);
  }
  if (++n % 20000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); console.log(`  printings ${n}`); }
}
db.exec('COMMIT');
await new Promise(r => printingsOut.end(r));
console.log(`printings: ${n}`);

// ---- oracle cards (Scryfall's chosen representative printing per oracle id)
const oracleOut = fs.createWriteStream(path.join(OUT, 'oracle.jsonl'));
let no = 0;
db.exec('BEGIN');
for await (const raw of readJsonl(path.join(RAW, 'oracle_cards.jsonl.gz'))) {
  const c = normalise(raw);
  const agg = oracleAgg.get(c.oracle_id) ?? { first_printed: c.released_at, count: 0 };
  const o = { ...c, first_printed: agg.first_printed, printing_count: agg.count, representative_id: c.id, rulings: rulings.get(c.oracle_id) ?? [] };
  delete o.prices; // prices belong to printings
  if (!oracleOut.write(JSON.stringify(o) + '\n')) await new Promise(r => oracleOut.once('drain', r));
  insO.run(o.oracle_id, o.name, o.layout, o.mana_cost, o.mana_value, o.type_line, JSON.stringify(o.supertypes), JSON.stringify(o.types), JSON.stringify(o.subtypes), o.oracle_text, JSON.stringify(o.colors), JSON.stringify(o.color_identity), o.power, o.toughness, o.loyalty, o.defense, JSON.stringify(o.keywords), +o.reserved, o.first_printed, o.printing_count, o.representative_id, JSON.stringify(o));
  for (const [fmt, st] of Object.entries(o.legalities)) insL.run(o.oracle_id, fmt, st);
  for (const r of o.rulings) insR.run(o.oracle_id, r.published_at, r.source, r.comment);
  no++;
}
db.exec('COMMIT');
await new Promise(r => oracleOut.end(r));
db.exec(`CREATE INDEX idx_p_name ON printings(name); CREATE INDEX idx_p_oracle ON printings(oracle_id); CREATE INDEX idx_p_set ON printings(set_code);
CREATE INDEX idx_o_name ON oracle_cards(name); CREATE INDEX idx_r_oracle ON rulings(oracle_id); CREATE INDEX idx_f_name ON faces(name);`);
db.close();

const summary = {
  built_at: new Date().toISOString(), printings: n, oracle_cards: no,
  rulings: [...rulings.values()].reduce((a, b) => a + b.length, 0), sets: sets.length,
  seconds: (Date.now() - t0) / 1000,
  source_manifest: JSON.parse(fs.readFileSync(path.join(RAW, 'manifest.json'), 'utf8')),
};
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, source_manifest: undefined }, null, 2));
