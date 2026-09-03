// Server-only enrichment for the deck library: colour identity and a cover image per deck, straight from the web index.
import 'server-only';
import type { DeckRole, DeckSummary } from '@user/decks';
import { getCards, getDecks } from '@/lib/db';

export interface DeckTileData extends DeckSummary { cover: string | null }

const COLOR_BIT: Record<string, number> = { W: 1, U: 2, B: 4, R: 8, G: 16 };
interface IndexRow { oracle_id: string; type_line: string | null; identity_mask: number; rep_printing_id: string }

export function deckTiles(role?: DeckRole): DeckTileData[] {
  const store = getDecks();
  const decks = store.list(role);
  if (!decks.length) return [];
  let lookup: ((ids: string[]) => IndexRow[]) | null = null;
  try {
    const db = getCards().db;
    lookup = (ids) => {
      const out: IndexRow[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        out.push(...(db.prepare(`SELECT oracle_id, type_line, identity_mask, rep_printing_id FROM card_index WHERE oracle_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as IndexRow[]));
      }
      return out;
    };
  } catch { lookup = null; }
  return decks.map(d => {
    const cards = store.cardsOf(d.id);
    let colors: string[] = d.colors;
    let cover: string | null = d.coverPrintingId;
    if (lookup && cards.length) {
      const rows = new Map(lookup([...new Set(cards.map(c => c.oracleId))]).map(r => [r.oracle_id, r]));
      let mask = 0;
      for (const c of cards) if (c.board !== 'maybe') mask |= rows.get(c.oracleId)?.identity_mask ?? 0;
      colors = Object.keys(COLOR_BIT).filter(k => mask & COLOR_BIT[k]);
      if (!cover) {
        const main = cards.filter(c => c.board === 'commander' || c.board === 'main');
        const creature = main.find(c => /\bCreature\b/.test(rows.get(c.oracleId)?.type_line ?? '')) ?? main.find(c => !/\bLand\b/.test(rows.get(c.oracleId)?.type_line ?? '')) ?? main[0] ?? cards[0];
        cover = creature ? (creature.printingId ?? rows.get(creature.oracleId)?.rep_printing_id ?? null) : null;
      }
    }
    return { ...d, colors, cover };
  });
}
