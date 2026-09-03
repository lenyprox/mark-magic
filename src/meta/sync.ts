// Sync orchestrator shared by scripts/meta-sync.ts and POST /api/meta/sync.
import type Database from 'better-sqlite3';
import type { CardDB } from '../cards/db.js';
import { MetaService } from './service.js';
import { canonicalFormat, type MetaFormat, type MetaSource, type SourceReport, type SyncReport } from './types.js';

export interface SyncOptions {
  user: Database.Database;
  cards: CardDB | null;
  format: MetaFormat | string;
  sources?: MetaSource[];
  days?: number;
  /** Set code for 17lands ratings (required when sources include '17lands'). */
  set?: string;
  force?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  service?: MetaService;
  log?: (msg: string) => void;
}

export const ALL_SOURCES: readonly MetaSource[] = ['topdeck', 'goldfish', '17lands'];

export function parseSources(input: string | string[] | undefined): MetaSource[] {
  const raw = Array.isArray(input) ? input : (input ?? 'topdeck,goldfish').split(',');
  const out: MetaSource[] = [];
  for (const s of raw.map(x => x.trim().toLowerCase()).filter(Boolean)) {
    const k = s === 'seventeenlands' || s === '17' ? '17lands' : s === 'mtggoldfish' ? 'goldfish' : s;
    if (!ALL_SOURCES.includes(k as MetaSource)) throw new Error(`unknown source "${s}" (expected ${ALL_SOURCES.join(', ')})`);
    if (!out.includes(k as MetaSource)) out.push(k as MetaSource);
  }
  return out;
}

export async function runSync(opts: SyncOptions): Promise<SyncReport> {
  const format = canonicalFormat(String(opts.format));
  if (!format) throw new Error(`unknown format "${opts.format}" (expected Standard, Modern, Pioneer, Legacy, Vintage, Pauper or EDH)`);
  const sources = opts.sources ?? ['topdeck', 'goldfish'];
  const service = opts.service ?? new MetaService({ user: opts.user, cards: opts.cards, env: opts.env, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
  const log = opts.log ?? (() => {});
  const reports: SourceReport[] = [];
  const decklistSources = sources.filter(s => s !== '17lands');
  if (decklistSources.length) {
    const r = await service.refresh(format, { windowDays: opts.days ?? 30, force: opts.force, sources: decklistSources, log });
    reports.push(...r.reports);
  }
  if (sources.includes('17lands')) {
    if (!opts.set) reports.push({ source: '17lands', format, ok: false, message: '--set <code> is required for 17lands ratings', counts: {} });
    else {
      try {
        const r = await service.cardRatings(opts.set, { force: opts.force });
        const message = `${r.ratings.length} card ratings for ${opts.set.toUpperCase()}${r.fromCache ? ' [cache]' : ''}`;
        log(`17lands ${opts.set.toUpperCase()}: ${message}`);
        reports.push({ source: '17lands', format, ok: true, message, counts: { cardRatings: r.ratings.length } });
      } catch (e) {
        reports.push({ source: '17lands', format, ok: false, message: (e as Error).message, counts: {} });
        log(`17lands ${opts.set.toUpperCase()}: FAILED ${(e as Error).message}`);
      }
    }
  }
  return { format, ok: reports.every(r => r.ok || r.skipped), reports };
}
