// Deck text formats: parse (plain / Arena / Moxfield / MTGO) and export, plus resolution against the master DB.
import { parseDeckList, type CardDB, type DeckBoard, type DeckList } from '../cards/db.js';
import type { CardQueryDB } from '../cards/query.js';
import type { DeckCard } from '../user/decks.js';

export interface ParsedDeck { name?: string; format?: string; cards: { name: string; count: number; board: DeckBoard; set?: string; number?: string }[]; unknownLines: string[] }

/** Parse any common deck text. A leading "// Name" or "Name: ..." line becomes the deck name. */
export function parseDeckText(text: string): ParsedDeck {
  let name: string | undefined; let format: string | undefined;
  const lines = text.split(/\r?\n/);
  const m = lines[0]?.match(/^\s*(?:\/\/|#)\s*(.+)$/) ?? lines[0]?.match(/^\s*(?:Name|Deck name):\s*(.+)$/i);
  if (m) name = m[1].trim();
  const fm = text.match(/^\s*(?:\/\/|#)?\s*Format:\s*(\w+)/im); if (fm) format = fm[1].toLowerCase();
  const list = parseDeckList(text, name ?? 'deck');
  const unknownLines = lines.filter(l => l.trim() && !/^\s*(\/\/|#)/.test(l) && !/^\s*\d+x?\s+/.test(l) && !/^(deck|main|mainboard|maindeck|sideboard|side|commander|commanders|companion|maybeboard|maybe|considering)\s*:?\s*(\(\d+\))?\s*$/i.test(l.trim())).map(l => l.trim());
  return { name, format, cards: list.cards.map(c => ({ name: c.name, count: c.count, board: c.board, set: c.set, number: c.number })), unknownLines };
}

export function toPlainText(cards: { name: string; count: number; board: DeckBoard }[], name?: string): string {
  const out: string[] = []; if (name) out.push(`// ${name}`);
  const order: DeckBoard[] = ['commander', 'companion', 'main', 'side', 'maybe'];
  for (const b of order) {
    const rows = cards.filter(c => c.board === b); if (!rows.length) continue;
    if (b !== 'main' || out.length > 1) out.push(b === 'main' ? 'Deck' : b[0].toUpperCase() + b.slice(1));
    for (const c of rows) out.push(`${c.count} ${c.name}`);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

export function toArenaText(cards: { name: string; count: number; board: DeckBoard; set?: string | null; number?: string | null }[]): string {
  const out: string[] = [];
  const order: [DeckBoard, string][] = [['commander', 'Commander'], ['companion', 'Companion'], ['main', 'Deck'], ['side', 'Sideboard']];
  for (const [b, header] of order) {
    const rows = cards.filter(c => c.board === b); if (!rows.length) continue;
    out.push(header);
    for (const c of rows) out.push(`${c.count} ${c.name}${c.set ? ` (${c.set.toUpperCase()})${c.number ? ' ' + c.number : ''}` : ''}`);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

/** Resolve parsed entries to oracle ids (and printing ids when a set/number was given). */
export function resolveDeck(cards: CardDB, query: CardQueryDB | null, parsed: ParsedDeck): { cards: DeckCard[]; missing: string[] } {
  const out: DeckCard[] = []; const missing: string[] = [];
  parsed.cards.forEach((c, i) => {
    const def = cards.get(c.name);
    if (!def) { missing.push(c.name); return; }
    let printingId: string | null = null;
    if (c.set && c.number && query) printingId = query.printingIdBySetNumber(c.set, c.number);
    const existing = out.find(x => x.board === c.board && x.oracleId === def.oracleId);
    if (existing) existing.count += c.count;
    else out.push({ board: c.board, oracleId: def.oracleId, name: def.name, printingId, count: c.count, position: i });
  });
  return { cards: out, missing };
}

export function deckListFromCards(cards: DeckCard[], name: string): DeckList {
  return { name, cards: cards.map(c => ({ name: c.name, count: c.count, board: c.board })) };
}
