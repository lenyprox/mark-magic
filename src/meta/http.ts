// Polite HTTP client for metagame sources: SQLite-backed response cache (http_cache), per-host token buckets,
// a fixed User-Agent, 429/Retry-After backoff and a per-sync request budget. fetch/clock/sleep are injectable for tests.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export const USER_AGENT = 'mtg-master-sim/0.1 (local desktop tool)';
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Requests per second per host. Unlisted hosts get DEFAULT_RATE. */
export const HOST_RATES: Record<string, number> = { 'topdeck.gg': 1.5, 'www.mtggoldfish.com': 1, 'mtggoldfish.com': 1, 'www.17lands.com': 1 };
const DEFAULT_RATE = 1;

export interface CachedResponse { status: number; body: string; contentType: string | null; fromCache: boolean; fetchedAt: string; url: string }
export interface FetchOptions { ttlMs?: number; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; cacheKey?: string; force?: boolean; maxRetries?: number }

export interface HttpClientOptions {
  db: Database.Database;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on network requests (not cache hits) for the client's lifetime, unless reset. */
  maxRequests?: number;
  rates?: Record<string, number>;
  userAgent?: string;
}

export class HttpError extends Error {
  constructor(public status: number, public url: string, message?: string) { super(message ?? `HTTP ${status} for ${url}`); this.name = 'HttpError'; }
}
export class RequestBudgetExceeded extends Error {
  constructor(public limit: number) { super(`request budget of ${limit} exceeded`); this.name = 'RequestBudgetExceeded'; }
}

interface Bucket { tokens: number; last: number; rate: number; capacity: number }
interface CacheRow { status: number; body: string; content_type: string | null; fetched_at: string; expires_at: string }

export class HttpClient {
  readonly db: Database.Database;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private sleepImpl: (ms: number) => Promise<void>;
  private buckets = new Map<string, Bucket>();
  private rates: Record<string, number>;
  private userAgent: string;
  maxRequests: number;
  /** Network requests made so far (cache hits excluded). */
  requests = 0;
  cacheHits = 0;

  constructor(opts: HttpClientOptions) {
    this.db = opts.db;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleepImpl = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.maxRequests = opts.maxRequests ?? 500;
    this.rates = { ...HOST_RATES, ...(opts.rates ?? {}) };
    this.userAgent = opts.userAgent ?? USER_AGENT;
  }

  resetBudget() { this.requests = 0; this.cacheHits = 0; }

  static cacheKey(url: string, opts: FetchOptions): string {
    if (opts.cacheKey) return opts.cacheKey;
    if ((opts.method ?? 'GET') === 'GET') return url;
    const h = createHash('sha1').update(opts.body ?? '').digest('hex').slice(0, 16);
    return `${opts.method} ${url}#${h}`;
  }

  private readRow(key: string): CacheRow | undefined {
    return this.db.prepare('SELECT status, body, content_type, fetched_at, expires_at FROM http_cache WHERE url = ?').get(key) as CacheRow | undefined;
  }

  /** Cached entry for a key regardless of expiry (for "source unavailable" fallbacks). */
  peek(url: string, opts: FetchOptions = {}): CachedResponse | null {
    const row = this.readRow(HttpClient.cacheKey(url, opts));
    return row ? { status: row.status, body: row.body, contentType: row.content_type, fromCache: true, fetchedAt: row.fetched_at, url } : null;
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<CachedResponse> {
    const key = HttpClient.cacheKey(url, opts);
    const ttl = opts.ttlMs ?? DAY_MS;
    if (!opts.force && ttl > 0) {
      const row = this.readRow(key);
      if (row && Date.parse(row.expires_at) > this.now()) { this.cacheHits++; return { status: row.status, body: row.body, contentType: row.content_type, fromCache: true, fetchedAt: row.fetched_at, url }; }
    }
    const host = new URL(url).host;
    const maxRetries = opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      if (this.requests >= this.maxRequests) throw new RequestBudgetExceeded(this.maxRequests);
      await this.throttle(host);
      this.requests++;
      const headers: Record<string, string> = { 'User-Agent': this.userAgent, Accept: 'application/json, text/html;q=0.9, */*;q=0.5', ...(opts.headers ?? {}) };
      if (opts.method === 'POST' && opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      const res = await this.fetchImpl(url, { method: opts.method ?? 'GET', headers, body: opts.method === 'POST' ? opts.body : undefined });
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        const wait = retryAfterMs(res.headers.get('retry-after'), this.now(), attempt);
        await this.sleepImpl(wait);
        continue;
      }
      const body = await res.text();
      const contentType = res.headers.get('content-type');
      const fetchedAt = new Date(this.now()).toISOString();
      if (res.status >= 500) throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
      if (ttl > 0) {
        const expiresAt = new Date(this.now() + (res.status >= 400 ? Math.min(ttl, 60 * 60 * 1000) : ttl)).toISOString();
        this.db.prepare('INSERT INTO http_cache (url, status, body, content_type, fetched_at, expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET status = excluded.status, body = excluded.body, content_type = excluded.content_type, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at')
          .run(key, res.status, body, contentType, fetchedAt, expiresAt);
      }
      return { status: res.status, body, contentType, fromCache: false, fetchedAt, url };
    }
  }

  /** Convenience: fetch + JSON.parse; throws HttpError on non-2xx. */
  async json<T = unknown>(url: string, opts: FetchOptions = {}): Promise<{ data: T; res: CachedResponse }> {
    const res = await this.fetch(url, opts);
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}: ${res.body.slice(0, 200)}`);
    return { data: JSON.parse(res.body) as T, res };
  }

  private async throttle(host: string) {
    const rate = this.rates[host] ?? DEFAULT_RATE;
    let b = this.buckets.get(host);
    const t = this.now();
    if (!b) { b = { tokens: 1, last: t, rate, capacity: Math.max(1, Math.floor(rate)) }; this.buckets.set(host, b); }
    b.tokens = Math.min(b.capacity, b.tokens + ((t - b.last) / 1000) * b.rate);
    b.last = t;
    if (b.tokens < 1) {
      const wait = Math.ceil(((1 - b.tokens) / b.rate) * 1000);
      await this.sleepImpl(wait);
      b.last = this.now();
      b.tokens = 1;
    }
    b.tokens -= 1;
  }

  /** Delete expired rows (called at the start of a sync). */
  prune(): number { return this.db.prepare('DELETE FROM http_cache WHERE expires_at < ?').run(new Date(this.now()).toISOString()).changes; }
}

/** Retry-After can be seconds or an HTTP date; fall back to exponential backoff (1s, 2s, 4s), capped at 60s. */
export function retryAfterMs(header: string | null, now: number, attempt: number): number {
  const fallback = Math.min(60_000, 1000 * 2 ** attempt);
  if (!header) return fallback;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(60_000, Math.max(250, secs * 1000));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(60_000, Math.max(250, date - now));
  return fallback;
}
