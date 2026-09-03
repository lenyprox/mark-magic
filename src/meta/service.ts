// MetaService: the one entry point the routes and the CLI use. Owns the store and the polite HTTP client; wires the
// source adapters, normalisation and clustering together and converts stored archetypes into ArchetypeProfiles.
import type Database from 'better-sqlite3';
import type { CardDB } from '../cards/db.js';
import type { DeckCard, DeckRecord, DeckStore } from '../user/decks.js';
import type { DeckBoard } from '../cards/db.js';
import { clusterDecks, mulberry32, type ClusterDeck } from './cluster.js';
import { fetchGoldfishMetagame } from './goldfish.js';
import { DAY_MS, HttpClient } from './http.js';
import { NameResolver, normalizeCards } from './normalize.js';
import { fetchCardRatings, type SeventeenLandsFormat } from './seventeenlands.js';
import { MetaStore } from './store.js';
import { fetchTopdeck } from './topdeck.js';
import type { ArchetypeProfile, ArchetypeSummary, CardRating, DecklistRecord, GoldfishArchetype, MetaFormat, MetaSource, SourceReport, SyncReport } from './types.js';

export interface MetaServiceOptions {
  user: Database.Database;
  /** Master card DB for name resolution and land detection; null degrades to name-only mode (tests without master.db). */
  cards: CardDB | null;
  http?: HttpClient;
  fetchImpl?: typeof fetch;
  /** Injectable sleep for the rate limiter (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface RefreshOptions { windowDays?: number; force?: boolean; sources?: MetaSource[]; log?: (msg: string) => void }

const BASIC_LAND = /\b(Plains|Island|Swamp|Mountain|Forest|Wastes)\b/;
const LAND_WORDS = /\b(Tarn|Strand|Mesa|Foothills|Delta|Mire|Rainforest|Catacombs|Vents|Foundry|Pool|Garden|Tomb|Shrine|Crypt|Grove|Glade|Marsh|Hollow|Cavern|Canal|Vantage|Clearing|Nexus|Saga|Turf|Chamber|Garrison|Hideaway|Land|Lands|Colonnade|Citadel|Tower|Vale|Wastes|Boseiju|Otawara|Sokenzan|Takenuma|Eiganjo|Valakut|Karakas|Tolaria|Urza's Mine|Urza's Tower|Urza's Power Plant|Command Tower|Reflecting Pool)\b/;

export class MetaService {
  readonly store: MetaStore;
  readonly http: HttpClient;
  readonly cards: CardDB | null;
  private env: Record<string, string | undefined>;
  private now: () => number;
  private landCache = new Map<string, boolean>();
  private resolver: NameResolver | null;

  constructor(opts: MetaServiceOptions) {
    this.store = new MetaStore(opts.user);
    this.cards = opts.cards;
    this.resolver = opts.cards ? new NameResolver(opts.cards) : null;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());
    this.http = opts.http ?? new HttpClient({ db: opts.user, fetchImpl: opts.fetchImpl, sleep: opts.sleep, now: this.now });
  }

  apiKey(): string | null { const k = this.env.TOPDECK_API_KEY?.trim(); return k ? k : null; }
  configured(): boolean { return !!this.apiKey(); }
  goldfishEnabled(): boolean { const v = (this.env.META_GOLDFISH_ENABLED ?? '').trim().toLowerCase(); return v === '1' || v === 'true' || v === 'yes'; }

  isLand(name: string): boolean {
    let v = this.landCache.get(name);
    if (v != null) return v;
    if (this.resolver) v = this.resolver.isLand(name);
    else v = BASIC_LAND.test(name) || LAND_WORDS.test(name);
    this.landCache.set(name, v);
    return v;
  }

  resolve = (cards: { name: string; count: number; board: string }[]) => (this.resolver ? this.resolver.normalize(cards) : normalizeCards(null, cards));
  private oracleIdOf(name: string): string | null { return this.resolver ? this.resolver.resolve(name).oracleId : null; }

  // --- sync -------------------------------------------------------------------------------------------------------------

  /** Pull TopDeck (and Goldfish when enabled) for a format, then recluster. Skips when the last successful pull is < 24 h old. */
  async refresh(format: MetaFormat, opts: RefreshOptions = {}): Promise<SyncReport> {
    const windowDays = opts.windowDays ?? 30;
    const sources = opts.sources ?? ['topdeck', 'goldfish'];
    const log = opts.log ?? (() => {});
    const reports: SourceReport[] = [];
    this.http.prune();
    let changed = false;

    if (sources.includes('topdeck')) {
      const last = this.store.lastSync('topdeck', format);
      if (!opts.force && last && this.now() - Date.parse(last.finishedAt) < DAY_MS) {
        reports.push({ source: 'topdeck', format, ok: true, skipped: true, message: `skipped: refreshed ${last.finishedAt}`, counts: {} });
      } else {
        const startedAt = new Date(this.now()).toISOString(); const before = this.http.requests;
        try {
          const key = this.apiKey();
          if (!key) throw new Error('TOPDECK_API_KEY is not set (add it to .env.local)');
          const r = await fetchTopdeck(format, { http: this.http, apiKey: key, days: windowDays, force: opts.force, resolve: this.resolve });
          const events = this.store.upsertEvents(r.events);
          const { inserted, updated } = this.store.upsertDecklists(r.decklists);
          changed = true;
          const counts = { events, decklists: r.decklists.length, skippedUrlOnly: r.skippedUrlOnly, skippedEmpty: r.skippedEmpty, requests: this.http.requests - before };
          const message = `${r.tournaments} tournaments, ${events} events, ${r.decklists.length} decklists (${inserted} new, ${updated} updated), skipped ${r.skippedUrlOnly} url-only / ${r.skippedEmpty} empty${r.fromCache ? ' [cache]' : ''}`;
          log(`topdeck ${format}: ${message}`);
          this.store.logSync({ source: 'topdeck', format, startedAt, finishedAt: new Date(this.now()).toISOString(), ok: true, message });
          reports.push({ source: 'topdeck', format, ok: true, message, counts });
        } catch (e) {
          const message = (e as Error).message;
          this.store.logSync({ source: 'topdeck', format, startedAt, finishedAt: new Date(this.now()).toISOString(), ok: false, message });
          reports.push({ source: 'topdeck', format, ok: false, message, counts: { requests: this.http.requests - before } });
          log(`topdeck ${format}: FAILED ${message}`);
        }
      }
    }

    let goldfish: GoldfishArchetype[] = [];
    if (sources.includes('goldfish')) {
      const startedAt = new Date(this.now()).toISOString();
      const r = await fetchGoldfishMetagame(format, { http: this.http, enabled: this.goldfishEnabled(), force: opts.force });
      goldfish = r.archetypes;
      const message = r.available ? `${r.archetypes.length} archetypes (${r.archetypes.filter(a => a.sampleList).length} with sample lists)` : r.reason ?? 'unavailable';
      if (this.goldfishEnabled()) this.store.logSync({ source: 'goldfish', format, startedAt, finishedAt: new Date(this.now()).toISOString(), ok: r.available, message });
      reports.push({ source: 'goldfish', format, ok: r.available, skipped: !this.goldfishEnabled(), message, counts: { goldfishArchetypes: r.archetypes.length, requests: r.requests } });
      log(`goldfish ${format}: ${message}`);
      if (r.available) changed = true;
    }

    if (changed || opts.force || !this.store.archetypes(format).length) reports.push(this.recluster(format, windowDays, goldfish));
    return { format, ok: reports.every(r => r.ok || r.skipped), reports };
  }

  /** Recompute archetypes for a format from the stored decklists inside the window. */
  recluster(format: MetaFormat | string, windowDays = 30, goldfish: GoldfishArchetype[] = []): SourceReport {
    const startedAt = new Date(this.now()).toISOString();
    try {
      const lists = this.store.decklists(format, { sinceDays: windowDays, withCards: true });
      const decks: ClusterDeck[] = lists.map(d => ({ id: d.id, cards: d.cards, wins: d.wins, losses: d.losses, draws: d.draws, deckSize: d.deckSize }));
      const result = clusterDecks(decks, { format, isLand: n => this.isLand(n), previous: this.store.previousSignatures(format), goldfish });
      this.store.replaceArchetypes(format, result.archetypes, result.assignment, windowDays);
      const named = result.archetypes.filter(a => !a.isOther).length;
      const message = `${lists.length} decklists -> ${named} archetypes${result.archetypes.some(a => a.isOther) ? ' + Other' : ''} (${result.archetypes.filter(a => a.goldfishName).length} named by Goldfish)`;
      this.store.logSync({ source: 'cluster', format, startedAt, finishedAt: new Date(this.now()).toISOString(), ok: true, message });
      return { source: 'cluster', format, ok: true, message, counts: { decklists: lists.length, archetypes: named } };
    } catch (e) {
      const message = (e as Error).message;
      this.store.logSync({ source: 'cluster', format, startedAt, finishedAt: new Date(this.now()).toISOString(), ok: false, message });
      return { source: 'cluster', format, ok: false, message, counts: {} };
    }
  }

  async cardRatings(set: string, opts: { force?: boolean; format?: SeventeenLandsFormat } = {}): Promise<{ ratings: CardRating[]; fetchedAt: string | null; fromCache: boolean }> {
    const fmt = opts.format ?? 'PremierDraft';
    const cached = this.store.cardStats('17lands', fmt, set);
    if (!opts.force && cached.fetchedAt && this.now() - Date.parse(cached.fetchedAt) < DAY_MS && cached.ratings.length) return { ...cached, fromCache: true };
    const startedAt = new Date(this.now()).toISOString();
    try {
      const r = await fetchCardRatings(set, { http: this.http, format: fmt, force: opts.force });
      for (const rating of r.ratings) rating.oracleId = this.oracleIdOf(rating.name);
      const n = this.store.upsertCardStats('17lands', fmt, set, r.ratings);
      this.store.logSync({ source: '17lands', format: `${fmt}:${set.toUpperCase()}`, startedAt, finishedAt: new Date(this.now()).toISOString(), ok: true, message: `${n} card ratings` });
      return { ratings: r.ratings, fetchedAt: new Date(this.now()).toISOString(), fromCache: r.fromCache };
    } catch (e) {
      this.store.logSync({ source: '17lands', format: `${fmt}:${set.toUpperCase()}`, startedAt, finishedAt: new Date(this.now()).toISOString(), ok: false, message: (e as Error).message });
      if (cached.ratings.length) return { ...cached, fromCache: true };
      throw e;
    }
  }

  // --- reads --------------------------------------------------------------------------------------------------------------

  archetypes(format: string): ArchetypeSummary[] { return this.store.archetypes(format); }
  recentDecklists(format: string, limit = 50): DecklistRecord[] { return this.store.decklists(format, { limit, withCards: false }); }
  decklist(id: string): DecklistRecord | null { return this.store.decklist(id); }
  memberDecks(id: string, limit = 50): DecklistRecord[] { return this.store.memberDecks(id, limit); }
  lastRefresh(format: string): { finishedAt: string; ok: boolean; message: string } | null { return this.store.lastSync('topdeck', format, false); }

  /** The analysis-layer profile: distribution per card plus up to 20 member lists as samples. */
  profile(id: string, sampleLimit = 20): ArchetypeProfile | null {
    const a = this.store.archetype(id); if (!a) return null;
    const cards = this.store.archetypeCards(id);
    const members = this.store.memberDecks(id, sampleLimit);
    return {
      id: a.id, format: a.format, name: a.name, signature: a.signature, metaShare: a.share, winRate: a.winRate, deckCount: a.deckCount, deckSize: a.deckSize,
      cards: cards.map(c => ({ name: c.name, pIn: c.pIn, expectedCount: c.expectedCount, countDist: c.countDist, board: c.board })),
      sampleLists: members.map(m => m.cards.filter(c => c.board !== 'side').map(c => ({ name: c.name, count: c.count }))),
    };
  }

  // --- deck creation ----------------------------------------------------------------------------------------------------

  private toDeckCards(cards: { name: string; count: number; board: string; oracleId: string | null }[]): { cards: DeckCard[]; missing: string[] } {
    const out: DeckCard[] = []; const missing: string[] = [];
    cards.forEach((c, i) => {
      const oracleId = c.oracleId ?? this.oracleIdOf(c.name);
      if (!oracleId) { missing.push(c.name); return; }
      const board: DeckBoard = c.board === 'side' ? 'side' : c.board === 'commander' ? 'commander' : 'main';
      out.push({ board, oracleId, name: c.name, printingId: null, count: c.count, position: i });
    });
    return { cards: out, missing };
  }

  private deckFormat(format: string): string { return format === 'EDH' ? 'commander' : format.toLowerCase(); }

  /** Save a tournament decklist as an opponent deck (source 'meta:topdeck'). Unresolvable names are reported, not saved. */
  importDecklistAsDeck(id: string, decks: DeckStore): { deck: DeckRecord; missing: string[] } | null {
    const d = this.store.decklist(id); if (!d) return null;
    const { cards, missing } = this.toDeckCards(d.cards);
    const who = d.player ? ` - ${d.player}` : ''; const where = d.eventName ? ` (${d.eventName})` : '';
    const deck = decks.create({ name: `${d.archetype ?? 'Tournament deck'}${who}${where}`, format: this.deckFormat(d.format), role: 'opponent', source: `meta:${d.source}`, sourceRef: d.id, archetype: d.archetype, cards });
    return { deck, missing };
  }

  /** Save a concrete list for an archetype: one member list chosen with `seed`, weighted by wins (+1). */
  sampleArchetypeAsDeck(id: string, seed: number, decks: DeckStore): { deck: DeckRecord; sourceDecklistId: string; seed: number; missing: string[] } | null {
    const a = this.store.archetype(id); if (!a) return null;
    const members = this.store.memberDecks(id, 50); if (!members.length) return null;
    const rng = mulberry32(seed);
    const weights = members.map(m => (m.wins ?? 0) + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let r = rng() * total; let pick = members.length - 1;
    for (let i = 0; i < members.length; i++) { r -= weights[i]; if (r <= 0) { pick = i; break; } }
    const chosen = members[pick];
    const { cards, missing } = this.toDeckCards(chosen.cards);
    const deck = decks.create({ name: `${a.name} (sample #${seed})`, format: this.deckFormat(a.format), role: 'opponent', source: 'meta:sample', sourceRef: a.id, archetype: a.name, notes: `Sampled from ${chosen.id} (${chosen.player ?? 'unknown'}, ${chosen.wins ?? 0}-${chosen.losses ?? 0}) with seed ${seed}.`, cards });
    return { deck, sourceDecklistId: chosen.id, seed, missing };
  }
}
