// MTGGoldfish metagame pages: an OPT-IN (META_GOLDFISH_ENABLED=1) polite scraper. 1 req/s, 24 h cache, robots.txt honoured,
// all markup assumptions isolated in GOLDFISH_SELECTORS so drift is a one-object fix. Any failure degrades to { available: false }.
import { canonicalArchetypeName, cleanCardName, normalizeBoard } from './normalize.js';
import { DAY_MS, USER_AGENT, type HttpClient } from './http.js';
import type { GoldfishArchetype, MetaBoard, MetaFormat } from './types.js';

export const GOLDFISH_ORIGIN = 'https://www.mtggoldfish.com';
export const GOLDFISH_FORMAT_SLUGS: Record<MetaFormat, string> = { Standard: 'standard', Modern: 'modern', Pioneer: 'pioneer', Legacy: 'legacy', Vintage: 'vintage', Pauper: 'pauper', EDH: 'commander' };

/** Every markup assumption lives here. */
export const GOLDFISH_SELECTORS = {
  /** One archetype tile on /metagame/<format>/full. */
  tileSplit: /class="archetype-tile(?:\s|")/,
  /** Archetype link inside a tile (path + visible name). */
  archetypeLink: /href="(\/archetype\/[^"#?]+)(?:[#?][^"]*)?"[^>]*>\s*([^<]+?)\s*<\/a>/,
  /** Meta share percentage inside a tile. */
  share: /(\d+(?:\.\d+)?)\s*%/,
  /** Deck count in parentheses next to the share. */
  count: /\((\d+)\)/,
  /** Fallback when tiles are absent: any archetype link followed by a percentage in the same table row. */
  rowFallback: /<tr[\s\S]*?href="(\/archetype\/[^"#?]+)(?:[#?][^"]*)?"[^>]*>\s*([^<]+?)\s*<\/a>[\s\S]*?(\d+(?:\.\d+)?)\s*%[\s\S]*?<\/tr>/g,
  /** Deck table rows on /archetype/<slug>: section headers and qty/card cells. */
  deckRow: /<td[^>]*class="[^"]*deck-header[^"]*"[^>]*>\s*([^<]+?)\s*<|<td[^>]*class="[^"]*deck-col-qty[^"]*"[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*class="[^"]*deck-col-card[^"]*"[^>]*>\s*(?:<a[^>]*>)?\s*([^<]+?)\s*(?:<\/a>)?\s*<\/td>/g,
  /** Section headers that switch the board. */
  sideboardHeader: /^sideboard/i,
  commanderHeader: /^commander/i,
};

export function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Parse the metagame overview page into archetype name/share/link rows. */
export function parseGoldfishMetagame(html: string): GoldfishArchetype[] {
  const out: GoldfishArchetype[] = [];
  const seen = new Set<string>();
  const push = (path: string, rawName: string, share: number | null, count: number | null) => {
    const slug = path.replace(/^\/archetype\//, '');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push({ name: canonicalArchetypeName(decodeEntities(rawName)), slug, url: `${GOLDFISH_ORIGIN}${path}#paper`, share: share == null ? null : share / 100, deckCount: count });
  };
  const tiles = html.split(GOLDFISH_SELECTORS.tileSplit).slice(1);
  for (const tile of tiles) {
    const link = tile.match(GOLDFISH_SELECTORS.archetypeLink);
    if (!link) continue;
    const share = tile.match(GOLDFISH_SELECTORS.share);
    const count = tile.match(GOLDFISH_SELECTORS.count);
    push(link[1], link[2], share ? Number(share[1]) : null, count ? Number(count[1]) : null);
  }
  if (!out.length) {
    for (const m of html.matchAll(GOLDFISH_SELECTORS.rowFallback)) push(m[1], m[2], Number(m[3]), null);
  }
  return out;
}

/** Parse the visible deck table on an archetype page into a sample list (main/side/commander). */
export function parseGoldfishArchetypePage(html: string): { name: string; count: number; board: MetaBoard }[] {
  const cards: { name: string; count: number; board: MetaBoard }[] = [];
  let board: MetaBoard = 'main';
  for (const m of html.matchAll(GOLDFISH_SELECTORS.deckRow)) {
    if (m[1] != null) {
      const h = decodeEntities(m[1]).trim();
      if (GOLDFISH_SELECTORS.sideboardHeader.test(h)) board = 'side';
      else if (GOLDFISH_SELECTORS.commanderHeader.test(h)) board = 'commander';
      else if (board !== 'main' && !/^(sideboard|commander)/i.test(h)) board = board === 'commander' ? 'main' : board;
      continue;
    }
    const count = Number(m[2]); const name = cleanCardName(decodeEntities(m[3]));
    if (count > 0 && name) cards.push({ name, count, board: normalizeBoard(board) });
  }
  return cards;
}

// --- robots.txt -------------------------------------------------------------------------------------------------------

export interface RobotsRules { allow: string[]; disallow: string[] }

/** Rules for our user agent: the most specific matching group (product token first, then `*`). */
export function parseRobots(txt: string, userAgent = USER_AGENT): RobotsRules {
  const token = userAgent.split('/')[0].toLowerCase();
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let cur: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else if (cur && (key === 'allow' || key === 'disallow')) {
      if (val) cur[key].push(val); lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const exact = groups.find(g => g.agents.some(a => a === token || (a !== '*' && token.startsWith(a))));
  const star = groups.find(g => g.agents.includes('*'));
  const g = exact ?? star;
  return g ? { allow: g.allow, disallow: g.disallow } : { allow: [], disallow: [] };
}

function robotsMatch(rule: string, path: string): number {
  // Supports the `*` wildcard and `$` end anchor; returns the rule length for longest-match precedence, or -1.
  const anchored = rule.endsWith('$');
  const pattern = (anchored ? rule.slice(0, -1) : rule).split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const re = new RegExp('^' + pattern + (anchored ? '$' : ''));
  return re.test(path) ? rule.length : -1;
}

export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let best = 0; let allowed = true;
  for (const r of rules.disallow) { const l = robotsMatch(r, path); if (l > best) { best = l; allowed = false; } }
  for (const r of rules.allow) { const l = robotsMatch(r, path); if (l >= best && l >= 0) { best = l; allowed = true; } }
  return allowed;
}

// --- fetching ---------------------------------------------------------------------------------------------------------

export interface GoldfishFetchOptions { http: HttpClient; enabled: boolean; fetchSamples?: boolean; maxSamples?: number; force?: boolean }
export interface GoldfishResult { available: boolean; reason?: string; archetypes: GoldfishArchetype[]; requests: number }

/** Names/shares for a format, plus a visible sample list per archetype (top N). Never throws; unavailable sources report a reason. */
export async function fetchGoldfishMetagame(format: MetaFormat, opts: GoldfishFetchOptions): Promise<GoldfishResult> {
  if (!opts.enabled) return { available: false, reason: 'MTGGoldfish scraping is disabled (set META_GOLDFISH_ENABLED=1 to opt in)', archetypes: [], requests: 0 };
  const start = opts.http.requests;
  const slug = GOLDFISH_FORMAT_SLUGS[format];
  try {
    const robotsRes = await opts.http.fetch(`${GOLDFISH_ORIGIN}/robots.txt`, { ttlMs: DAY_MS, force: opts.force });
    const rules = robotsRes.status === 200 ? parseRobots(robotsRes.body) : { allow: [], disallow: [] };
    const metaPath = `/metagame/${slug}/full`;
    if (!robotsAllows(rules, metaPath)) return { available: false, reason: `robots.txt disallows ${metaPath}`, archetypes: [], requests: opts.http.requests - start };
    const page = await opts.http.fetch(`${GOLDFISH_ORIGIN}${metaPath}`, { ttlMs: DAY_MS, force: opts.force });
    if (page.status !== 200) return { available: false, reason: `HTTP ${page.status} for ${metaPath}`, archetypes: [], requests: opts.http.requests - start };
    const archetypes = parseGoldfishMetagame(page.body);
    if (!archetypes.length) return { available: false, reason: 'no archetypes found on the metagame page (markup changed?)', archetypes: [], requests: opts.http.requests - start };
    if (opts.fetchSamples !== false) {
      for (const a of archetypes.slice(0, opts.maxSamples ?? 20)) {
        const path = `/archetype/${a.slug}`;
        if (!robotsAllows(rules, path)) continue;
        try {
          const res = await opts.http.fetch(`${GOLDFISH_ORIGIN}${path}`, { ttlMs: DAY_MS, force: opts.force });
          if (res.status === 200) { const list = parseGoldfishArchetypePage(res.body); if (list.length) a.sampleList = list; }
        } catch { /* a single archetype page failing must not fail the source */ }
      }
    }
    return { available: true, archetypes, requests: opts.http.requests - start };
  } catch (e) {
    return { available: false, reason: `source unavailable: ${(e as Error).message}`, archetypes: [], requests: opts.http.requests - start };
  }
}
