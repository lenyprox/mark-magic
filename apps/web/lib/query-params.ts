// Parse URL search params into a CardQuery (shared by the /cards page and /api/cards).
import type { CardQuery, ColorMode, Rarity, SortKey } from '@cards/query';
import type { Color } from '@cards/types';

export type SearchParamsLike = Record<string, string | string[] | undefined> | URLSearchParams;

function get(sp: SearchParamsLike, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key]; return Array.isArray(v) ? v[0] : v;
}
function list(sp: SearchParamsLike, key: string): string[] {
  const v = get(sp, key); return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
}
function num(sp: SearchParamsLike, key: string): number | undefined {
  const v = get(sp, key); if (v == null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined;
}

const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);
const RARITIES = new Set(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']);
const SORTS = new Set<SortKey>(['name', 'released', 'edhrec', 'price', 'mv', 'collector', 'relevance']);
const MODES = new Set<ColorMode>(['any', 'exact', 'subset', 'superset', 'identity']);

export function parseCardQuery(sp: SearchParamsLike): CardQuery {
  const q: CardQuery = {};
  const text = get(sp, 'q')?.trim(); if (text) q.q = text.slice(0, 200);
  const colors = list(sp, 'c').map(c => c.toUpperCase()).filter(c => COLORS.has(c)) as Color[];
  if (colors.length) q.colors = colors;
  const cm = get(sp, 'cm') as ColorMode | undefined; if (cm && MODES.has(cm)) q.colorMode = cm;
  if (get(sp, 'colorless') === '1') q.colorless = true;
  const types = list(sp, 't'); if (types.length) q.types = types.slice(0, 6);
  const subtypes = list(sp, 'st'); if (subtypes.length) q.subtypes = subtypes.slice(0, 6);
  const supertypes = list(sp, 'sup'); if (supertypes.length) q.supertypes = supertypes.slice(0, 3);
  const set = get(sp, 'set'); if (set) q.set = set.toLowerCase();
  const rarity = list(sp, 'r').filter(r => RARITIES.has(r)) as Rarity[]; if (rarity.length) q.rarity = rarity;
  const format = get(sp, 'f'); if (format) q.format = format.toLowerCase();
  const legality = get(sp, 'leg'); if (legality === 'legal' || legality === 'restricted' || legality === 'banned') q.legality = legality;
  q.mvMin = num(sp, 'mvmin'); q.mvMax = num(sp, 'mvmax'); q.priceMin = num(sp, 'pmin'); q.priceMax = num(sp, 'pmax');
  const sort = get(sp, 'sort') as SortKey | undefined; if (sort && SORTS.has(sort)) q.sort = sort;
  const dir = get(sp, 'dir'); if (dir === 'asc' || dir === 'desc') q.dir = dir;
  const mode = get(sp, 'mode'); if (mode === 'printing' || mode === 'oracle') q.mode = mode;
  const lang = get(sp, 'lang'); if (lang) q.lang = lang.toLowerCase().slice(0, 3);
  if (get(sp, 'all') === '1') q.playable = false;
  if (get(sp, 'img') === '1') q.hasImage = true;
  q.page = Math.max(1, num(sp, 'page') ?? 1);
  q.pageSize = Math.min(120, Math.max(1, num(sp, 'ps') ?? 60));
  for (const k of Object.keys(q) as (keyof CardQuery)[]) if (q[k] === undefined) delete q[k];
  return q;
}

/** Inverse of parseCardQuery for building links. */
export function cardQueryToParams(q: CardQuery): URLSearchParams {
  const sp = new URLSearchParams();
  if (q.q) sp.set('q', q.q);
  if (q.colors?.length) sp.set('c', q.colors.join(','));
  if (q.colorMode && q.colorMode !== 'any') sp.set('cm', q.colorMode);
  if (q.colorless) sp.set('colorless', '1');
  if (q.types?.length) sp.set('t', q.types.join(','));
  if (q.subtypes?.length) sp.set('st', q.subtypes.join(','));
  if (q.supertypes?.length) sp.set('sup', q.supertypes.join(','));
  if (q.set) sp.set('set', q.set);
  if (q.rarity?.length) sp.set('r', q.rarity.join(','));
  if (q.format) sp.set('f', q.format);
  if (q.legality && q.legality !== 'legal') sp.set('leg', q.legality);
  if (q.mvMin != null) sp.set('mvmin', String(q.mvMin));
  if (q.mvMax != null) sp.set('mvmax', String(q.mvMax));
  if (q.priceMin != null) sp.set('pmin', String(q.priceMin));
  if (q.priceMax != null) sp.set('pmax', String(q.priceMax));
  if (q.sort) sp.set('sort', q.sort);
  if (q.dir) sp.set('dir', q.dir);
  if (q.mode === 'printing') sp.set('mode', 'printing');
  if (q.lang) sp.set('lang', q.lang);
  if (q.playable === false) sp.set('all', '1');
  if (q.hasImage) sp.set('img', '1');
  if (q.page && q.page > 1) sp.set('page', String(q.page));
  if (q.pageSize && q.pageSize !== 60) sp.set('ps', String(q.pageSize));
  return sp;
}
