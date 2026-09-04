// RFC-4180 CSV reading for collection files: quoted fields, "" escapes, commas and newlines inside quotes, CRLF/LF, BOM.
// `parseCountNameCsv` turns a sheet into count/name rows, sniffing an optional header (plain "count,name", Moxfield,
// Archidekt, Deckbox, ManaBox exports all map onto the same five columns).

export interface CountNameRow { count: number; name: string; line: number; set?: string; number?: string; finish?: string }
export interface CsvError { line: number; text: string; reason: string }
export interface CountNameSheet { rows: CountNameRow[]; errors: CsvError[]; header: string[] | null; dialect: 'plain' | 'moxfield' | 'archidekt' | 'deckbox' | 'manabox' | 'generic' }

/** Parse CSV text into rows of fields. Each row remembers the 1-based line it started on. */
export function parseCsv(text: string): { fields: string[]; line: number }[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: { fields: string[]; line: number }[] = [];
  let fields: string[] = []; let field = ''; let quoted = false; let line = 1; let rowLine = 1; let i = 0;
  const endField = () => { fields.push(field); field = ''; };
  const endRow = () => { endField(); rows.push({ fields, line: rowLine }); fields = []; rowLine = line; };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { line++; endRow(); rowLine = line; i++; continue; }
    field += c; i++;
  }
  if (field.length || fields.length) endRow();
  // drop rows that are entirely blank
  return rows.filter(r => r.fields.some(f => f.trim() !== ''));
}

const COUNT_KEYS = ['count', 'qty', 'quantity', 'amount', 'copies', 'tradelist count', 'reg qty'];
const NAME_KEYS = ['name', 'card name', 'card', 'cardname'];
const SET_KEYS = ['set code', 'edition code', 'set', 'edition', 'setcode', 'code'];
const NUMBER_KEYS = ['collector number', 'collector_number', 'number', 'card number', 'collectornumber'];
const FINISH_KEYS = ['finish', 'foil', 'printing'];

function findCol(header: string[], keys: string[]): number {
  const h = header.map(x => x.trim().toLowerCase());
  for (const k of keys) { const i = h.indexOf(k); if (i >= 0) return i; }
  return -1;
}

const isCount = (s: string) => /^\s*\d+\s*x?\s*$/i.test(s);

/** Interpret a sheet as count/name rows. Without a header the first two columns are count,name (or name,count). */
export function parseCountNameCsv(text: string): CountNameSheet {
  const rows = parseCsv(text);
  const errors: CsvError[] = [];
  if (!rows.length) return { rows: [], errors, header: null, dialect: 'plain' };
  const first = rows[0].fields;
  const looksLikeHeader = !first.some(isCount) && first.some(f => [...COUNT_KEYS, ...NAME_KEYS].includes(f.trim().toLowerCase()));
  let countCol = 0, nameCol = 1, setCol = -1, numberCol = -1, finishCol = -1;
  let header: string[] | null = null;
  let dialect: CountNameSheet['dialect'] = 'plain';
  let start = 0;
  if (looksLikeHeader) {
    header = first; start = 1;
    countCol = findCol(first, COUNT_KEYS); nameCol = findCol(first, NAME_KEYS);
    setCol = findCol(first, SET_KEYS); numberCol = findCol(first, NUMBER_KEYS); finishCol = findCol(first, FINISH_KEYS);
    const h = first.map(x => x.trim().toLowerCase());
    if (h.includes('tradelist count') && h.includes('edition')) dialect = 'moxfield';
    else if (h.includes('edition code') || h.includes('scryfall id') || h.includes('multiverse id')) dialect = 'archidekt';
    else if (h.includes('tradelist count') || h.includes('card number')) dialect = 'deckbox';
    else if (h.includes('scryfall id') || h.includes('manabox id')) dialect = 'manabox';
    else dialect = 'generic';
    if (nameCol < 0) { errors.push({ line: rows[0].line, text: first.join(','), reason: 'no name column in the header' }); return { rows: [], errors, header, dialect }; }
    if (countCol < 0) countCol = -2; // every row is one copy
  } else if (first.length >= 2 && !isCount(first[0]) && isCount(first[1])) { countCol = 1; nameCol = 0; }
  const out: CountNameRow[] = [];
  for (let r = start; r < rows.length; r++) {
    const { fields, line } = rows[r];
    const text = fields.join(',');
    if (fields.length === 1) {
      // a bare name, or "3 Name" written without a comma
      const m = fields[0].trim().match(/^(\d+)\s*x?\s+(.+)$/i);
      if (m) out.push({ count: Number(m[1]), name: m[2].trim(), line });
      else if (fields[0].trim()) out.push({ count: 1, name: fields[0].trim(), line });
      continue;
    }
    const rawCount = countCol === -2 ? '1' : (fields[countCol] ?? '');
    const name = (fields[nameCol] ?? '').trim();
    if (!name) { errors.push({ line, text, reason: 'empty name' }); continue; }
    const countText = String(rawCount).trim().replace(/^(\d+)\s*x$/i, '$1');
    const count = /^\d+$/.test(countText) ? Number(countText) : NaN;
    if (!Number.isInteger(count) || count < 0) { errors.push({ line, text, reason: `bad count "${rawCount}"` }); continue; }
    if (count === 0) continue;
    const row: CountNameRow = { count, name, line };
    const set = setCol >= 0 ? fields[setCol]?.trim() : ''; if (set && /^[A-Za-z0-9]{2,6}$/.test(set)) row.set = set.toLowerCase();
    const num = numberCol >= 0 ? fields[numberCol]?.trim() : ''; if (num) row.number = num;
    const fin = finishCol >= 0 ? fields[finishCol]?.trim().toLowerCase() : '';
    if (fin) row.finish = fin === 'foil' || fin === 'true' || fin === 'yes' ? 'foil' : fin === 'etched' ? 'etched' : 'nonfoil';
    out.push(row);
  }
  return { rows: out, errors, header, dialect };
}

/** Serialise rows back to the simple `count,name` sheet (names quoted when needed). */
export function toCountNameCsv(rows: { count: number; name: string }[]): string {
  const q = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return rows.map(r => `${r.count},${q(r.name)}`).join('\n') + '\n';
}
