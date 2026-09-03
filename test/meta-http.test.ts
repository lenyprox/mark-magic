// HttpClient: http_cache TTL, per-host token bucket, Retry-After backoff, request budget. Uses a fake clock and sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openUserDb } from '../src/user/db.js';
import { HttpClient, HttpError, RequestBudgetExceeded, retryAfterMs, USER_AGENT } from '../src/meta/http.js';

function harness(responder: (url: string, n: number) => Response | Promise<Response>, opts: { rates?: Record<string, number>; maxRequests?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-http-'));
  const db = openUserDb(path.join(dir, 'user.db'));
  let clock = Date.parse('2026-09-03T12:00:00Z');
  const sleeps: number[] = [];
  let n = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => { calls.push({ url: String(url), headers: init!.headers as Record<string, string> }); return responder(String(url), n++); };
  const http = new HttpClient({ db, fetchImpl, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, rates: opts.rates, maxRequests: opts.maxRequests });
  return { http, db, sleeps, calls, advance: (ms: number) => { clock += ms; }, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('cache: a fresh entry is served from http_cache until it expires; force bypasses it; POST keys include the body', async () => {
  const h = harness(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const a = await h.http.fetch('https://example.test/a', { ttlMs: 60_000 });
    const b = await h.http.fetch('https://example.test/a', { ttlMs: 60_000 });
    assert.equal(a.fromCache, false); assert.equal(b.fromCache, true); assert.equal(b.body, '{"ok":true}'); assert.equal(b.contentType, 'application/json');
    assert.equal(h.calls.length, 1); assert.equal(h.http.cacheHits, 1);
    assert.equal(h.calls[0].headers['User-Agent'], USER_AGENT);
    h.advance(61_000);
    const c = await h.http.fetch('https://example.test/a', { ttlMs: 60_000 });
    assert.equal(c.fromCache, false); assert.equal(h.calls.length, 2);
    await h.http.fetch('https://example.test/a', { ttlMs: 60_000, force: true });
    assert.equal(h.calls.length, 3);
    assert.equal((h.db.prepare('SELECT count(*) AS n FROM http_cache').get() as { n: number }).n, 1);
    await h.http.fetch('https://example.test/p', { method: 'POST', body: '{"x":1}' });
    await h.http.fetch('https://example.test/p', { method: 'POST', body: '{"x":2}' });
    await h.http.fetch('https://example.test/p', { method: 'POST', body: '{"x":1}' });
    assert.equal(h.calls.length, 5, 'two distinct POST bodies, the third is a cache hit');
    assert.ok(h.http.peek('https://example.test/p', { method: 'POST', body: '{"x":2}' }));
    const { data } = await h.http.json<{ ok: boolean }>('https://example.test/a');
    assert.equal(data.ok, true);
  } finally { h.cleanup(); }
});

test('rate limiting: the per-host token bucket sleeps between requests at the configured rate', async () => {
  const h = harness(() => new Response('x', { status: 200 }), { rates: { 'slow.test': 2, 'fast.test': 100 } });
  try {
    for (let i = 0; i < 3; i++) await h.http.fetch(`https://slow.test/${i}`, { ttlMs: 0 });
    assert.equal(h.calls.length, 3);
    assert.equal(h.sleeps.length, 2, 'first request is free, the next two wait');
    assert.ok(h.sleeps.every(ms => ms >= 450 && ms <= 500), `sleeps ${h.sleeps}`);
    h.sleeps.length = 0;
    await h.http.fetch('https://fast.test/1', { ttlMs: 0 });
    assert.equal(h.sleeps.length, 0, 'other hosts have their own bucket');
    h.advance(2000);
    await h.http.fetch('https://slow.test/x', { ttlMs: 0 });
    assert.equal(h.sleeps.length, 0, 'tokens refill with time');
  } finally { h.cleanup(); }
});

test('backoff: 429 honours Retry-After then succeeds; 5xx throws HttpError; the request budget is enforced', async () => {
  const h = harness((url, n) => {
    if (url.endsWith('/limited')) return n === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : new Response('ok', { status: 200 });
    if (url.endsWith('/broken')) return new Response('boom', { status: 500 });
    return new Response('fine', { status: 200 });
  }, { rates: { 'example.test': 1000 }, maxRequests: 5 });
  try {
    const r = await h.http.fetch('https://example.test/limited', { ttlMs: 0 });
    assert.equal(r.status, 200); assert.equal(r.body, 'ok');
    assert.ok(h.sleeps.includes(2000), `expected a 2000 ms Retry-After sleep, got ${h.sleeps}`);
    assert.equal(h.http.requests, 2);
    await assert.rejects(() => h.http.fetch('https://example.test/broken', { ttlMs: 0 }), (e: unknown) => e instanceof HttpError && e.status === 500);
    await h.http.fetch('https://example.test/a', { ttlMs: 0 }); await h.http.fetch('https://example.test/b', { ttlMs: 0 });
    assert.equal(h.http.requests, 5);
    await assert.rejects(() => h.http.fetch('https://example.test/c', { ttlMs: 0 }), (e: unknown) => e instanceof RequestBudgetExceeded);
    h.http.resetBudget();
    await h.http.fetch('https://example.test/c', { ttlMs: 0 });
    assert.equal(h.http.requests, 1);
  } finally { h.cleanup(); }
  const now = Date.parse('2026-09-03T12:00:00Z');
  assert.equal(retryAfterMs('3', now, 0), 3000);
  assert.equal(retryAfterMs(new Date(now + 5000).toUTCString(), now, 0), 5000);
  assert.equal(retryAfterMs(null, now, 2), 4000);
  assert.equal(retryAfterMs('999999', now, 0), 60_000);
});
