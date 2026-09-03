// Pure helpers over a deck draft plus the per-card details the builder fetches: grouping, curve, pips, sources, legality.
import type { CardDetail } from '@cards/query';
import type { DeckBoard } from '@cards/db';
import type { DeckCard } from '@user/decks';
import { splitCost } from '@/lib/text/tokenize';
import { formatInfo } from './formats';

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAME: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

export interface Entry { card: DeckCard; info: CardDetail | undefined }
export type GroupMode = 'type' | 'mv' | 'color';

const TYPE_ORDER = ['Commander', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];

export function isLand(typeLine: string | undefined): boolean { return !!typeLine && /\bLand\b/.test(typeLine.split('//')[0]); }
export function isBasic(typeLine: string | undefined): boolean { return !!typeLine && /\bBasic\b/.test(typeLine.split('//')[0]); }

export function primaryType(typeLine: string | undefined): string {
  const t = (typeLine ?? '').split('//')[0];
  if (!t) return 'Other';
  if (/\bLand\b/.test(t)) return 'Land';
  for (const k of ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment']) if (new RegExp(`\\b${k}\\b`).test(t)) return k;
  return 'Other';
}

/** Type line without the em-dash subtypes, for compact rows. */
export function shortType(typeLine: string | undefined): string {
  return (typeLine ?? '').split('//')[0].split('—')[0].trim();
}

export function boardCards(cards: DeckCard[], board: DeckBoard): DeckCard[] { return cards.filter(c => c.board === board); }
export function countOf(cards: DeckCard[], board?: DeckBoard): number { return cards.filter(c => !board || c.board === board).reduce((a, c) => a + c.count, 0); }
export const MAIN_BOARDS: DeckBoard[] = ['main', 'commander', 'companion'];
export function mainCount(cards: DeckCard[]): number { return cards.filter(c => MAIN_BOARDS.includes(c.board)).reduce((a, c) => a + c.count, 0); }

export function entriesOf(cards: DeckCard[], info: Map<string, CardDetail>): Entry[] {
  return cards.map(card => ({ card, info: info.get(card.oracleId) }));
}

export interface Group { key: string; label: string; count: number; entries: Entry[] }

function colorGroupKey(e: Entry): string {
  const t = e.info?.typeLine;
  if (isLand(t)) return 'Land';
  const cs = e.info?.colors ?? [];
  if (cs.length === 0) return 'Colorless';
  if (cs.length > 1) return 'Multicolour';
  return COLOR_NAME[cs[0]] ?? cs[0];
}
const COLOR_GROUP_ORDER = ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolour', 'Colorless', 'Land'];

export function groupEntries(entries: Entry[], mode: GroupMode): Group[] {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    let key: string;
    if (e.card.board === 'commander') key = 'Commander';
    else if (mode === 'type') key = primaryType(e.info?.typeLine);
    else if (mode === 'color') key = colorGroupKey(e);
    else key = isLand(e.info?.typeLine) ? 'Land' : e.info ? String(Math.min(7, Math.floor(e.info.manaValue))) : '?';
    (map.get(key) ?? map.set(key, []).get(key)!).push(e);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (mode === 'type') return TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b);
    if (mode === 'color') return COLOR_GROUP_ORDER.indexOf(a) - COLOR_GROUP_ORDER.indexOf(b);
    const na = a === 'Land' ? 99 : a === '?' ? 98 : Number(a); const nb = b === 'Land' ? 99 : b === '?' ? 98 : Number(b);
    return na - nb;
  });
  return keys.map(key => {
    const list = map.get(key)!.slice().sort((x, y) => {
      const mx = x.info?.manaValue ?? 0, my = y.info?.manaValue ?? 0;
      return mx - my || x.card.name.localeCompare(y.card.name);
    });
    const label = mode === 'mv' && key !== 'Land' && key !== '?' ? (key === '7' ? 'Mana value 7+' : `Mana value ${key}`) : key === '?' ? 'Unknown' : key;
    return { key, label, count: list.reduce((a, e) => a + e.card.count, 0), entries: list };
  });
}

// ------------------------------------------------------------------ numbers
export function averageMv(entries: Entry[]): number | null {
  let n = 0, sum = 0;
  for (const e of entries) { if (!e.info || isLand(e.info.typeLine)) continue; n += e.card.count; sum += e.info.manaValue * e.card.count; }
  return n ? sum / n : null;
}
export function landCount(entries: Entry[]): number { return entries.filter(e => isLand(e.info?.typeLine)).reduce((a, e) => a + e.card.count, 0); }

export function colorIdentity(entries: Entry[]): Color[] {
  const set = new Set<string>();
  for (const e of entries) for (const c of e.info?.colorIdentity ?? []) set.add(c);
  return COLOR_ORDER.filter(c => set.has(c));
}

/** Mana curve buckets 0..7+ for non-land cards. */
export function manaCurve(entries: Entry[]): number[] {
  const out = Array(8).fill(0) as number[];
  for (const e of entries) { if (!e.info || isLand(e.info.typeLine)) continue; out[Math.min(7, Math.max(0, Math.floor(e.info.manaValue)))] += e.card.count; }
  return out;
}

/** Coloured pips in mana costs of non-land cards (hybrid counts each half at 0.5, phyrexian and twobrid count the colour). */
export function pipCounts(entries: Entry[]): Record<Color, number> {
  const out: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const e of entries) {
    if (!e.info || isLand(e.info.typeLine)) continue;
    for (const sym of splitCost(e.info.manaCost)) {
      const inner = sym.slice(1, -1).toUpperCase();
      const colors = inner.split('/').filter(p => (COLOR_ORDER as string[]).includes(p)) as Color[];
      if (!colors.length) continue;
      const w = colors.length > 1 && !inner.includes('P') && !/\d/.test(inner) ? 1 / colors.length : 1;
      for (const c of colors) out[c] += w * e.card.count;
    }
  }
  return out;
}

/** What the lands produce, per colour (a dual counts for each colour it makes). */
export function manaSources(entries: Entry[]): Record<Color, number> & { total: number } {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0, total: 0 };
  for (const e of entries) {
    if (!e.info || !isLand(e.info.typeLine)) continue;
    out.total += e.card.count;
    const produces = new Set(e.info.def?.producesMana ?? []);
    if (!produces.size && isBasic(e.info.typeLine)) {
      const basic: Record<string, Color> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
      for (const [name, c] of Object.entries(basic)) if (e.info.typeLine.includes(name)) produces.add(c);
    }
    for (const c of produces) if ((COLOR_ORDER as string[]).includes(c)) out[c as Color] += e.card.count;
  }
  return out;
}

export interface SourceRow { color: Color; pips: number; pipShare: number; sources: number; sourceShare: number; status: 'ok' | 'light' | 'short' }
/** Karsten-flavoured but simple: a colour's share of sources should not trail its share of pips by more than 10 points, and any colour with pips wants at least 6 sources in 60 cards. */
export function sourceCheck(entries: Entry[]): SourceRow[] {
  const pips = pipCounts(entries); const src = manaSources(entries);
  const totalPips = COLOR_ORDER.reduce((a, c) => a + pips[c], 0);
  const totalSrc = COLOR_ORDER.reduce((a, c) => a + src[c], 0);
  const deckSize = Math.max(40, mainCount(entries.map(e => e.card)));
  return COLOR_ORDER.filter(c => pips[c] > 0 || src[c] > 0).map(c => {
    const pipShare = totalPips ? pips[c] / totalPips : 0;
    const sourceShare = totalSrc ? src[c] / totalSrc : 0;
    const minSources = pips[c] > 0 ? Math.round(6 * deckSize / 60) : 0;
    const status: SourceRow['status'] = pips[c] === 0 ? 'ok' : src[c] < Math.max(1, minSources * 0.6) ? 'short' : sourceShare + 0.1 < pipShare || src[c] < minSources ? 'light' : 'ok';
    return { color: c, pips: Math.round(pips[c] * 10) / 10, pipShare, sources: src[c], sourceShare, status };
  });
}

// ------------------------------------------------------------------ legality
export interface LegalityIssue { kind: 'illegal' | 'copies' | 'size' | 'missing'; message: string; cards: { name: string; oracleId: string; printingId: string | null }[] }

export function legalityIssues(format: string, cards: DeckCard[], info: Map<string, CardDetail>): LegalityIssue[] {
  const f = formatInfo(format);
  const issues: LegalityIssue[] = [];
  const counted = cards.filter(c => c.board !== 'maybe');
  // per-format legality
  if (f.legality) {
    const bad = counted.filter(c => { const d = info.get(c.oracleId); if (!d) return false; const s = d.legalities[f.legality!]; return s !== 'legal' && s !== 'restricted'; });
    const uniq = dedupe(bad);
    if (uniq.length) issues.push({ kind: 'illegal', message: `${uniq.length} card${uniq.length === 1 ? '' : 's'} not legal in ${f.label}`, cards: uniq });
  }
  // copy limit (basics and "any number" cards exempt; restricted cards limited to 1 in Vintage)
  const totals = new Map<string, number>();
  for (const c of counted) totals.set(c.oracleId, (totals.get(c.oracleId) ?? 0) + c.count);
  const over: DeckCard[] = [];
  for (const [oid, n] of totals) {
    const d = info.get(oid); if (!d) continue;
    if (isBasic(d.typeLine) || /any number of cards named/i.test(d.oracleText)) continue;
    const limit = f.legality && d.legalities[f.legality] === 'restricted' ? 1 : f.copies;
    if (n > limit) over.push(counted.find(c => c.oracleId === oid)!);
  }
  if (over.length) issues.push({ kind: 'copies', message: `More than ${f.copies === 1 ? 'one copy' : `${f.copies} copies`}`, cards: dedupe(over) });
  // deck size
  const main = mainCount(counted);
  if (f.exactSize && main !== f.exactSize) issues.push({ kind: 'size', message: `${f.label} decks are exactly ${f.exactSize} cards (this one has ${main})`, cards: [] });
  else if (!f.exactSize && main < f.minSize) issues.push({ kind: 'size', message: `Main deck has ${main} of the ${f.minSize} cards required`, cards: [] });
  return issues;
}

function dedupe(cards: DeckCard[]): { name: string; oracleId: string; printingId: string | null }[] {
  const seen = new Set<string>(); const out: { name: string; oracleId: string; printingId: string | null }[] = [];
  for (const c of cards) if (!seen.has(c.oracleId)) { seen.add(c.oracleId); out.push({ name: c.name, oracleId: c.oracleId, printingId: c.printingId }); }
  return out;
}

// ------------------------------------------------------------------ text
const BOARD_HEADER: Record<DeckBoard, string> = { commander: 'Commander', companion: 'Companion', main: 'Deck', side: 'Sideboard', maybe: 'Maybeboard' };
/** Plain text export of a draft (used for the clipboard while the save is still in flight). */
export function draftToText(cards: DeckCard[]): string {
  const order: DeckBoard[] = ['commander', 'companion', 'main', 'side', 'maybe'];
  const lines: string[] = [];
  for (const b of order) {
    const list = cards.filter(c => c.board === b && c.count > 0);
    if (!list.length) continue;
    if (lines.length) lines.push('');
    lines.push(BOARD_HEADER[b]);
    for (const c of list) lines.push(`${c.count} ${c.name}`);
  }
  return lines.join('\n');
}
