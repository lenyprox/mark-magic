// Server-only singletons for the master card DB (read-only) and the user DB (read-write).
// Stored on globalThis so they survive Next.js HMR reloads in dev.
import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '@cards/db';
import { CardQueryDB } from '@cards/query';
import { openUserDb } from '@user/db';
import { DeckStore, GameStore } from '@user/decks';
import { CollectionStore } from '@collection/store';
import { DATA_DIR, MASTER_DB, USER_DB, projectRoot } from '@config/paths';
import type Database from 'better-sqlite3';

interface Registry { cards?: CardDB; query?: CardQueryDB; user?: Database.Database; decks?: DeckStore; games?: GameStore; collection?: CollectionStore }
const g = globalThis as unknown as { __mtg?: Registry };
const reg: Registry = (g.__mtg ??= {});

export class DataNotReadyError extends Error {
  constructor(public step: 'master' | 'index', message: string) { super(message); this.name = 'DataNotReadyError'; }
}

export function getCards(): CardDB {
  if (!reg.cards) {
    if (!fs.existsSync(MASTER_DB())) throw new DataNotReadyError('master', `master.db not found at ${MASTER_DB()}. Run: npm run data:all && npm run web:index`);
    reg.cards = CardDB.shared();
    reg.cards.db.pragma('mmap_size = 1073741824');
    reg.cards.db.pragma('cache_size = -65536');
  }
  return reg.cards;
}

export function getQuery(): CardQueryDB {
  if (!reg.query) {
    const q = new CardQueryDB(getCards().db);
    if (!q.hasWebIndex()) throw new DataNotReadyError('index', 'The web index is missing. Run: npm run web:index');
    // Open the read-write user DB first (it creates the WAL files and runs migrations), then attach it for owned joins.
    try { getUserDb(); q.attachUser(USER_DB()); } catch { /* searches simply report owned = null */ }
    reg.query = q;
  }
  return reg.query;
}

export function getUserDb(): Database.Database { return (reg.user ??= openUserDb()); }
export function getDecks(): DeckStore { return (reg.decks ??= new DeckStore(getUserDb())); }
export function getGames(): GameStore { return (reg.games ??= new GameStore(getUserDb())); }
export function getCollection(): CollectionStore { return (reg.collection ??= new CollectionStore(getUserDb(), getCards())); }

export interface CollectionSummary { distinct: number; copies: number; sources: number; decks: number; updatedAt: string | null }

/** Status of the local data pipeline, for /api/health and the setup banner. */
export function dataStatus(): { root: string; master: boolean; index: boolean; indexStale: boolean; masterBuiltAt: string | null; indexBuiltAt: string | null; userDb: boolean; manaSprite: boolean; collection: CollectionSummary | null } {
  const root = projectRoot();
  const master = fs.existsSync(MASTER_DB());
  const summaryPath = path.join(DATA_DIR(), 'master', 'summary.json');
  const indexPath = path.join(DATA_DIR(), 'master', 'web-index.json');
  const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null;
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : null;
  let hasIndex = false;
  try { hasIndex = master && getQuery().hasWebIndex(); } catch { hasIndex = false; }
  let collection: CollectionSummary | null = null;
  try { if (master) collection = getCollection().summary(); } catch { collection = null; }
  return {
    root, master, index: hasIndex, indexStale: !!(summary && index && index.source_built_at !== summary.built_at),
    masterBuiltAt: summary?.built_at ?? null, indexBuiltAt: index?.built_at ?? null,
    userDb: fs.existsSync(path.join(DATA_DIR(), 'user.db')),
    manaSprite: fs.existsSync(path.join(root, 'apps', 'web', 'public', 'mana', 'sprite.svg')),
    collection,
  };
}
