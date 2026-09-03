// nuqs parsers for the browse filters. Keys and encodings mirror lib/query-params.ts exactly so the
// server page (parseCardQuery) and the client (useQueryStates) read the same URL.
import { createParser, createSerializer, parseAsArrayOf, parseAsFloat, parseAsInteger, parseAsString, parseAsStringLiteral, type inferParserType } from 'nuqs';
import type { CardQuery, ColorMode, Rarity, SortKey } from '@cards/query';
import type { Color } from '@cards/types';

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export const RARITIES = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'] as const;
export const SORTS = ['name', 'released', 'edhrec', 'price', 'mv', 'collector', 'relevance'] as const;
export const COLOR_MODES = ['any', 'exact', 'subset', 'superset', 'identity'] as const;
export const FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper', 'alchemy', 'historic', 'timeless', 'brawl', 'oathbreaker', 'penny', 'premodern', 'oldschool', 'paupercommander', 'duel', 'predh'] as const;

/** `1` / absent, matching parseCardQuery (nuqs' own boolean parser writes `true`). */
const flag = createParser<boolean>({ parse: (v) => v === '1' || v === 'true', serialize: (v) => (v ? '1' : '0'), eq: (a, b) => a === b }).withDefault(false);

export const searchParsers = {
  q: parseAsString.withDefault(''),
  c: parseAsArrayOf(parseAsStringLiteral(COLORS)).withDefault([]),
  cm: parseAsStringLiteral(COLOR_MODES).withDefault('any'),
  colorless: flag,
  t: parseAsArrayOf(parseAsString).withDefault([]),
  st: parseAsArrayOf(parseAsString).withDefault([]),
  sup: parseAsArrayOf(parseAsString).withDefault([]),
  set: parseAsString.withDefault(''),
  r: parseAsArrayOf(parseAsStringLiteral(RARITIES)).withDefault([]),
  f: parseAsString.withDefault(''),
  leg: parseAsStringLiteral(['legal', 'restricted', 'banned'] as const).withDefault('legal'),
  mvmin: parseAsFloat,
  mvmax: parseAsFloat,
  pmin: parseAsFloat,
  pmax: parseAsFloat,
  sort: parseAsStringLiteral(SORTS),
  dir: parseAsStringLiteral(['asc', 'desc'] as const),
  mode: parseAsStringLiteral(['oracle', 'printing'] as const).withDefault('oracle'),
  lang: parseAsString,
  all: flag,
  img: flag,
  ps: parseAsInteger,
};

export type SearchState = inferParserType<typeof searchParsers>;

export const serializeSearch = createSerializer(searchParsers);

/** Convert URL state into the CardQuery sent to /api/cards. Mirrors parseCardQuery. */
export function toCardQuery(s: SearchState, pageSize = 60): CardQuery {
  const q: CardQuery = {};
  if (s.q.trim()) q.q = s.q.trim().slice(0, 200);
  if (s.c.length) q.colors = s.c as Color[];
  if (s.cm !== 'any') q.colorMode = s.cm as ColorMode;
  if (s.colorless) q.colorless = true;
  if (s.t.length) q.types = s.t.slice(0, 6);
  if (s.st.length) q.subtypes = s.st.slice(0, 6);
  if (s.sup.length) q.supertypes = s.sup.slice(0, 3);
  if (s.set) q.set = s.set.toLowerCase();
  if (s.r.length) q.rarity = s.r as Rarity[];
  if (s.f) { q.format = s.f.toLowerCase(); q.legality = s.leg; }
  if (s.mvmin != null) q.mvMin = s.mvmin;
  if (s.mvmax != null) q.mvMax = s.mvmax;
  if (s.pmin != null) q.priceMin = s.pmin;
  if (s.pmax != null) q.priceMax = s.pmax;
  if (s.sort) q.sort = s.sort as SortKey;
  if (s.dir) q.dir = s.dir;
  if (s.mode === 'printing') q.mode = 'printing';
  if (s.lang) q.lang = s.lang;
  if (s.all) q.playable = false;
  if (s.img) q.hasImage = true;
  q.page = 1; q.pageSize = s.ps ?? pageSize;
  return q;
}

export const EMPTY_SEARCH: SearchState = {
  q: '', c: [], cm: 'any', colorless: false, t: [], st: [], sup: [], set: '', r: [], f: '', leg: 'legal',
  mvmin: null, mvmax: null, pmin: null, pmax: null, sort: null, dir: null, mode: 'oracle', lang: null, all: false, img: false, ps: null,
};

/** Count of user-facing active filters (for the "clear" summary). */
export function activeFilterCount(s: SearchState): number {
  let n = 0;
  if (s.q.trim()) n++;
  if (s.c.length || s.colorless) n++;
  if (s.t.length) n++; if (s.st.length) n++; if (s.sup.length) n++;
  if (s.set) n++; if (s.r.length) n++; if (s.f) n++;
  if (s.mvmin != null || s.mvmax != null) n++;
  if (s.pmin != null || s.pmax != null) n++;
  return n;
}
