// Schema for data/user.db (decks, games, caches, metagame). Append new migrations; never edit applied ones.
export const MIGRATIONS: string[] = [
  // 1: initial
  `
CREATE TABLE decks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'casual',
  role TEXT NOT NULL CHECK (role IN ('mine','opponent')), source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT,
  archetype TEXT, notes TEXT, cover_printing_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE deck_cards (
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  board TEXT NOT NULL CHECK (board IN ('main','side','commander','companion','maybe')),
  oracle_id TEXT NOT NULL, name TEXT NOT NULL, printing_id TEXT, count INTEGER NOT NULL CHECK (count > 0), position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deck_id, board, oracle_id)
);
CREATE INDEX idx_deck_cards_deck ON deck_cards(deck_id);
CREATE TABLE games (
  id TEXT PRIMARY KEY, seed INTEGER NOT NULL,
  my_deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL, opp_deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
  my_deck_name TEXT, opp_deck_name TEXT, my_deck_snapshot TEXT NOT NULL, opp_deck_snapshot TEXT NOT NULL,
  options TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, winner INTEGER, turns INTEGER, log TEXT, actions TEXT, reasoning TEXT
);
CREATE INDEX idx_games_started ON games(started_at);
CREATE TABLE analysis_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, computed_at TEXT NOT NULL, expires_at TEXT);
CREATE TABLE http_cache (url TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, content_type TEXT, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE meta_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT, format TEXT NOT NULL,
  date TEXT, players INTEGER, url TEXT, fetched_at TEXT NOT NULL, UNIQUE (source, source_id)
);
CREATE TABLE meta_decklists (
  id TEXT PRIMARY KEY, event_id TEXT REFERENCES meta_events(id) ON DELETE CASCADE, source TEXT NOT NULL, source_id TEXT,
  archetype TEXT, archetype_id TEXT, format TEXT NOT NULL, player TEXT, placement INTEGER, wins INTEGER, losses INTEGER, draws INTEGER,
  deck_size INTEGER, date TEXT, url TEXT, fetched_at TEXT NOT NULL, UNIQUE (source, source_id)
);
CREATE INDEX idx_meta_decklists_fmt_date ON meta_decklists(format, date);
CREATE INDEX idx_meta_decklists_arch ON meta_decklists(archetype_id);
CREATE TABLE meta_decklist_cards (
  decklist_id TEXT NOT NULL REFERENCES meta_decklists(id) ON DELETE CASCADE, board TEXT NOT NULL, name TEXT NOT NULL, oracle_id TEXT, count INTEGER NOT NULL,
  PRIMARY KEY (decklist_id, board, name)
);
CREATE INDEX idx_mdc_oracle ON meta_decklist_cards(oracle_id);
CREATE TABLE meta_archetypes (
  id TEXT PRIMARY KEY, format TEXT NOT NULL, name TEXT NOT NULL, signature TEXT NOT NULL, share REAL, deck_count INTEGER,
  wins INTEGER, losses INTEGER, deck_size INTEGER NOT NULL DEFAULT 60, goldfish_name TEXT, goldfish_share REAL, url TEXT, window_days INTEGER, computed_at TEXT NOT NULL
);
CREATE INDEX idx_meta_archetypes_format ON meta_archetypes(format);
CREATE TABLE meta_archetype_cards (
  archetype_id TEXT NOT NULL REFERENCES meta_archetypes(id) ON DELETE CASCADE, board TEXT NOT NULL, name TEXT NOT NULL, oracle_id TEXT,
  p_in_deck REAL NOT NULL, mean_count REAL NOT NULL, count_hist TEXT NOT NULL, PRIMARY KEY (archetype_id, board, name)
);
CREATE TABLE meta_card_stats (
  source TEXT NOT NULL, format TEXT NOT NULL, set_code TEXT NOT NULL, name TEXT NOT NULL, oracle_id TEXT, stats TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, format, set_code, name)
);
CREATE TABLE meta_sync_log (id INTEGER PRIMARY KEY, source TEXT, format TEXT, started_at TEXT, finished_at TEXT, ok INTEGER, message TEXT);
`,
];
