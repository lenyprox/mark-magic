// Metagame parser coverage: how much of the cards in real tournament decklists the oracle-text parser fully simulates.
// Pure computation over decklists + a parse lookup; the CLI (scripts/meta-coverage.ts) supplies both.
import type { MetaBoard } from './types.js';
import type { CardDB } from '../cards/db.js';
import { NameResolver } from './normalize.js';

export interface CoverageDeck {
  id: string; archetype: string | null; archetypeId: string | null;
  cards: { name: string; oracleId: string | null; count: number; board: MetaBoard | string }[];
}

/** What the parser knows about one card name. `resolved=false` means the name is not in the master file. */
export interface CardParseInfo { name: string; oracleId: string | null; resolved: boolean; isLand: boolean; fullyParsed: boolean; unparsed: string[] }
export type ParseLookup = (name: string, oracleId: string | null) => CardParseInfo;

export interface Ratio { n: number; full: number; pct: number }
export interface ArchetypeCoverage { id: string; name: string; decks: number; copiesNonland: Ratio; decksFullySimulated: Ratio; topUnparsed: { name: string; decks: number }[] }
export interface FormatCoverage {
  format: string; decks: number; distinctCards: number; unresolvedNames: string[];
  distinct: { all: Ratio; nonland: Ratio };
  /** Main-deck copies (every board except the sideboard). */
  copies: { all: Ratio; nonland: Ratio };
  decksFullySimulated: Ratio;
  /** Decks whose main deck holds at most two distinct partially simulated cards. */
  decksAtMost2Partial: Ratio;
  archetypes: ArchetypeCoverage[];
  note?: string;
}
export interface UnparsedCard { name: string; oracleId: string | null; weight: number; isLand: boolean; byFormat: Record<string, { decks: number; deckPct: number; copies: number }>; unparsed: string[] }
export interface UnparsedClause { pattern: string; weight: number; cards: string[] }
export interface MetaCoverageReport {
  generated_at: string; source: 'user.db' | 'fixture'; window_days: number | null;
  formats: Record<string, FormatCoverage>;
  /** Ranked by weight = mean over formats-with-data of (decks containing the card / decks in the format). */
  top_unparsed_cards: UnparsedCard[];
  top_unparsed_clauses: UnparsedClause[];
}

export interface CoverageOptions { topCards?: number; topClauses?: number; windowDays?: number | null; source?: 'user.db' | 'fixture'; now?: Date }

/** Same normalisation as scripts/parser-coverage.ts so the two reports group clauses identically. */
export function normaliseClause(u: string): string {
  return u.replace(/\d+/g, '#').replace(/\{[^}]+\}/g, '{}').slice(0, 90);
}

/** Parse lookup backed by master.db: indexed name resolution (NameResolver), cached parses (CardDB.getByOracleId). */
export function masterLookup(cards: CardDB): ParseLookup {
  const resolver = new NameResolver(cards);
  return (name, oracleId) => {
    const r = oracleId ? { name, oracleId, isLand: resolver.isLand(name) } : resolver.resolve(name);
    const def = r.oracleId ? cards.getByOracleId(r.oracleId) : null;
    if (!def) return { name: r.name || name, oracleId: r.oracleId, resolved: false, isLand: r.isLand, fullyParsed: false, unparsed: [] };
    return { name: def.name, oracleId: def.oracleId, resolved: true, isLand: r.isLand, fullyParsed: def.fullyParsed, unparsed: def.unparsed };
  };
}

const ratio = (n: number, full: number): Ratio => ({ n, full, pct: n ? +(100 * full / n).toFixed(1) : 0 });
const isMain = (board: string) => board !== 'side';

export function computeCoverage(decksByFormat: Record<string, CoverageDeck[]>, lookup: ParseLookup, opts: CoverageOptions = {}): MetaCoverageReport {
  const memo = new Map<string, CardParseInfo>();
  const info = (name: string, oracleId: string | null): CardParseInfo => {
    const key = name.toLowerCase();
    let v = memo.get(key);
    if (!v) { v = lookup(name, oracleId); memo.set(key, v); }
    return v;
  };
  // per card, per format: decks containing + copies
  const perCard = new Map<string, { info: CardParseInfo; byFormat: Record<string, { decks: number; copies: number }> }>();
  const formats: Record<string, FormatCoverage> = {};
  const formatsWithData: string[] = [];

  for (const [format, decks] of Object.entries(decksByFormat)) {
    if (!decks.length) {
      formats[format] = {
        format, decks: 0, distinctCards: 0, unresolvedNames: [], distinct: { all: ratio(0, 0), nonland: ratio(0, 0) }, copies: { all: ratio(0, 0), nonland: ratio(0, 0) },
        decksFullySimulated: ratio(0, 0), decksAtMost2Partial: ratio(0, 0), archetypes: [], note: `no decklists synced; run npm run meta:sync -- --format ${format} --days 90`,
      };
      continue;
    }
    formatsWithData.push(format);
    const distinct = new Map<string, CardParseInfo>();
    const unresolved = new Set<string>();
    let copiesAll = 0, copiesAllFull = 0, copiesNonland = 0, copiesNonlandFull = 0, fullDecks = 0, atMost2 = 0;
    const archetypes = new Map<string, { id: string; name: string; decks: number; copies: number; copiesFull: number; full: number; unparsed: Map<string, number> }>();
    for (const d of decks) {
      const seenInDeck = new Set<string>();
      let partial = 0, deckCopies = 0, deckCopiesFull = 0;
      const deckUnparsed: string[] = [];
      for (const c of d.cards) {
        if (!isMain(c.board) || c.count <= 0) continue;
        const ci = info(c.name, c.oracleId);
        if (!ci.resolved) { unresolved.add(c.name); continue; }
        const key = ci.name.toLowerCase();
        distinct.set(key, ci);
        copiesAll += c.count; if (ci.fullyParsed) copiesAllFull += c.count;
        if (!ci.isLand) { copiesNonland += c.count; deckCopies += c.count; if (ci.fullyParsed) { copiesNonlandFull += c.count; deckCopiesFull += c.count; } }
        if (!seenInDeck.has(key)) {
          seenInDeck.add(key);
          if (!ci.fullyParsed) { partial++; deckUnparsed.push(ci.name); }
          const pc = perCard.get(key) ?? { info: ci, byFormat: {} };
          const bf = pc.byFormat[format] ?? { decks: 0, copies: 0 };
          bf.decks++; pc.byFormat[format] = bf; perCard.set(key, pc);
        }
        perCard.get(key)!.byFormat[format].copies += c.count;
      }
      if (partial === 0) fullDecks++;
      if (partial <= 2) atMost2++;
      const aid = d.archetypeId ?? (d.archetype ? `name:${d.archetype}` : null);
      if (aid) {
        const a = archetypes.get(aid) ?? { id: aid, name: d.archetype ?? aid, decks: 0, copies: 0, copiesFull: 0, full: 0, unparsed: new Map() };
        a.decks++; a.copies += deckCopies; a.copiesFull += deckCopiesFull; if (partial === 0) a.full++;
        for (const n of deckUnparsed) a.unparsed.set(n, (a.unparsed.get(n) ?? 0) + 1);
        archetypes.set(aid, a);
      }
    }
    const dv = [...distinct.values()];
    const dn = dv.filter(c => !c.isLand);
    formats[format] = {
      format, decks: decks.length, distinctCards: dv.length, unresolvedNames: [...unresolved].sort(),
      distinct: { all: ratio(dv.length, dv.filter(c => c.fullyParsed).length), nonland: ratio(dn.length, dn.filter(c => c.fullyParsed).length) },
      copies: { all: ratio(copiesAll, copiesAllFull), nonland: ratio(copiesNonland, copiesNonlandFull) },
      decksFullySimulated: ratio(decks.length, fullDecks), decksAtMost2Partial: ratio(decks.length, atMost2),
      archetypes: [...archetypes.values()].sort((a, b) => b.decks - a.decks).map(a => ({
        id: a.id, name: a.name, decks: a.decks, copiesNonland: ratio(a.copies, a.copiesFull), decksFullySimulated: ratio(a.decks, a.full),
        topUnparsed: [...a.unparsed.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([name, decks]) => ({ name, decks })),
      })),
    };
  }

  const nFormats = formatsWithData.length || 1;
  const cards: UnparsedCard[] = [];
  for (const { info: ci, byFormat } of perCard.values()) {
    if (ci.fullyParsed) continue;
    let weight = 0;
    const bf: UnparsedCard['byFormat'] = {};
    for (const f of formatsWithData) {
      const v = byFormat[f]; if (!v) continue;
      const deckPct = +(100 * v.decks / formats[f].decks).toFixed(1);
      bf[f] = { decks: v.decks, deckPct, copies: v.copies };
      weight += v.decks / formats[f].decks;
    }
    cards.push({ name: ci.name, oracleId: ci.oracleId, weight: +(weight / nFormats).toFixed(4), isLand: ci.isLand, byFormat: bf, unparsed: ci.unparsed });
  }
  cards.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const clauseMap = new Map<string, { weight: number; cards: string[] }>();
  for (const c of cards) for (const u of new Set(c.unparsed.map(normaliseClause))) {
    const e = clauseMap.get(u) ?? { weight: 0, cards: [] };
    e.weight += c.weight; e.cards.push(c.name); clauseMap.set(u, e);
  }
  const clauses: UnparsedClause[] = [...clauseMap.entries()].map(([pattern, e]) => ({ pattern, weight: +e.weight.toFixed(4), cards: e.cards }))
    .sort((a, b) => b.weight - a.weight || a.pattern.localeCompare(b.pattern));

  return {
    generated_at: (opts.now ?? new Date()).toISOString(), source: opts.source ?? 'user.db', window_days: opts.windowDays ?? null,
    formats, top_unparsed_cards: cards.slice(0, opts.topCards ?? 60), top_unparsed_clauses: clauses.slice(0, opts.topClauses ?? 60),
  };
}

/** Compact stdout table: one row per format, then the top unparsed cards with per-format deck shares. */
export function formatCoverageTable(r: MetaCoverageReport, topCards = 25): string {
  const lines: string[] = [];
  const pad = (s: string | number, n: number, right = false) => { const t = String(s); return right ? t.padStart(n) : t.padEnd(n); };
  lines.push(`${pad('format', 10)}${pad('decks', 7, true)}${pad('distinct', 10, true)}  ${pad('distinct% (nonland)', 22)}${pad('copies% (nonland)', 20)}${pad('decks-full', 12)}${pad('decks<=2partial', 17)}archetypes`);
  for (const f of Object.values(r.formats)) {
    if (!f.decks) { lines.push(`${pad(f.format, 10)}${pad(0, 7, true)}  ${f.note ?? ''}`); continue; }
    lines.push(`${pad(f.format, 10)}${pad(f.decks, 7, true)}${pad(f.distinctCards, 10, true)}  ${pad(`${f.distinct.all.pct} (${f.distinct.nonland.pct})`, 22)}${pad(`${f.copies.all.pct} (${f.copies.nonland.pct})`, 20)}${pad(`${f.decksFullySimulated.full} (${f.decksFullySimulated.pct}%)`, 12)}${pad(`${f.decksAtMost2Partial.full} (${f.decksAtMost2Partial.pct}%)`, 17)}${f.archetypes.length}`);
  }
  const fmts = Object.keys(r.formats).filter(k => r.formats[k].decks > 0);
  if (r.top_unparsed_cards.length) {
    lines.push('');
    lines.push(`${pad('#', 4)}${pad('weight', 8)}${pad('card', 34)}${fmts.map(f => pad(f.slice(0, 3), 6)).join('')}clause`);
    r.top_unparsed_cards.slice(0, topCards).forEach((c, i) => {
      const cells = fmts.map(f => pad(c.byFormat[f] ? `${Math.round(c.byFormat[f].deckPct)}%` : '-', 6)).join('');
      lines.push(`${pad(i + 1, 4)}${pad(c.weight.toFixed(2), 8)}${pad((c.isLand ? '(L) ' : '') + c.name.slice(0, 32), 34)}${cells}${(c.unparsed[0] ?? '').slice(0, 60)}`);
    });
  }
  return lines.join('\n');
}
