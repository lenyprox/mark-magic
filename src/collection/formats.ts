// Detects what kind of collection file a text is (CSV sheet vs. Arena/Moxfield/plain deck text) and reads it into rows.
import { parseDeckText } from '../decks/format.js';
import { parseCountNameCsv, type CountNameRow, type CsvError } from './csv.js';

export type CollectionFormat = 'csv' | 'moxfield' | 'archidekt' | 'deckbox' | 'manabox' | 'arena' | 'text';
export interface CollectionRows { format: CollectionFormat; rows: CountNameRow[]; errors: CsvError[]; skipped: string[] }

const CSV_LINE = /^\s*"?\d+"?\s*,/;

export function detectCollectionFormat(text: string, filename?: string): CollectionFormat {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const head = (lines[0] ?? '').toLowerCase();
  const csvish = (filename ?? '').toLowerCase().endsWith('.csv') || lines.slice(0, 5).filter(l => CSV_LINE.test(l)).length >= Math.min(2, lines.length);
  if (csvish || (head.includes(',') && /(count|qty|quantity|name)/.test(head))) {
    if (head.includes('tradelist count') && head.includes('edition')) return 'moxfield';
    if (head.includes('edition code') || head.includes('scryfall id')) return 'archidekt';
    if (head.includes('card number') && head.includes('tradelist')) return 'deckbox';
    if (head.includes('manabox')) return 'manabox';
    return 'csv';
  }
  if (/^(deck|commander|sideboard|companion)\s*$/im.test(text) || /\(\w{2,6}\)\s*\d+/.test(text)) return 'arena';
  return 'text';
}

/** Read any supported collection text into count/name rows. Deck text keeps every board except the maybeboard. */
export function parseCollectionText(text: string, filename?: string): CollectionRows {
  const format = detectCollectionFormat(text, filename);
  if (format === 'arena' || format === 'text') {
    const parsed = parseDeckText(text);
    const rows: CountNameRow[] = [];
    let line = 0;
    for (const c of parsed.cards) { line++; if (c.board === 'maybe') continue; rows.push({ count: c.count, name: c.name, line, set: c.set, number: c.number }); }
    return { format, rows, errors: [], skipped: parsed.unknownLines };
  }
  const sheet = parseCountNameCsv(text);
  return { format, rows: sheet.rows, errors: sheet.errors, skipped: [] };
}
