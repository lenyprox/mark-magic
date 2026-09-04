// Node-side: turn a deck reference from the command line into a DeckPayload. Accepts a decks/*.txt or *.csv file
// (a CSV is a collection sheet: the commander is inferred from the file name), a saved deck id, a saved deck name
// (case-insensitive; a prefix or substring is accepted when it matches exactly one deck) or a bundled deck name.
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parseDeckList, type CardDB, type DeckList } from '../cards/db.js';
import { parseCollectionText } from '../collection/formats.js';
import { deckNameFromFile, inferCommander, type CommanderCandidate } from '../collection/names.js';
import { projectRoot } from '../config/paths.js';
import { buildDeckPayload } from '../play/payload.js';
import type { DeckPayload } from '../play/protocol.js';
import { DeckStore } from '../user/decks.js';

export interface ResolvedDeck { payload: DeckPayload; source: string }

function csvToList(cards: CardDB, file: string, text: string): DeckList {
  const parsed = parseCollectionText(text, path.basename(file));
  const name = deckNameFromFile(path.basename(file));
  const candidates: CommanderCandidate[] = [];
  for (const r of parsed.rows) { const d = cards.get(r.name); if (d) candidates.push({ oracleId: d.name, name: d.name, typeLine: d.typeLine, oracleText: d.oracleText }); }
  const inf = inferCommander(name, candidates);
  const commander = inf.pick?.name ?? null;
  const list: DeckList = { name, cards: [] };
  for (const r of parsed.rows) {
    if (commander && r.name === commander) { list.cards.push({ name: r.name, count: 1, board: 'commander' }); if (r.count > 1) list.cards.push({ name: r.name, count: r.count - 1, board: 'main' }); }
    else list.cards.push({ name: r.name, count: r.count, board: 'main' });
  }
  return list;
}

export function resolveDeckRef(ref: string, cards: CardDB, userDb?: Database.Database | null): ResolvedDeck {
  const root = projectRoot();
  const tryFile = (f: string) => fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
  const file = tryFile(ref) ?? tryFile(path.join(root, ref)) ?? tryFile(path.join(root, 'decks', ref)) ?? tryFile(path.join(root, 'decks', `${ref}.txt`)) ?? tryFile(path.join(root, 'decks', `${ref}.csv`));
  if (file) {
    const text = fs.readFileSync(file, 'utf8');
    const list = file.toLowerCase().endsWith('.csv') ? csvToList(cards, file, text) : parseDeckList(text, path.basename(file).replace(/\.\w+$/, ''));
    return { payload: buildDeckPayload(cards, list, { name: list.name }), source: path.relative(root, file) };
  }
  if (userDb) {
    const decks = new DeckStore(userDb);
    const all = decks.list();
    const byId = all.find(d => d.id === ref) ?? all.find(d => d.id.startsWith(ref) && ref.length >= 6);
    const lc = ref.toLowerCase();
    const unique = (pred: (n: string) => boolean) => { const m = all.filter(d => pred(d.name.toLowerCase())); return m.length === 1 ? m[0] : undefined; };
    const byName = byId ?? all.find(d => d.name.toLowerCase() === lc) ?? unique(n => n.startsWith(lc)) ?? unique(n => n.includes(lc));
    if (byName) {
      const d = decks.get(byName.id)!;
      const printings: Record<string, string | null> = {};
      for (const c of d.cards) if (c.printingId) printings[c.name] = c.printingId;
      return { payload: buildDeckPayload(cards, decks.toDeckList(d.id)!, { deckId: d.id, name: d.name, printings }), source: `saved deck ${d.id}` };
    }
  }
  throw new Error(`deck not found: ${ref} (a decks/ file, a saved deck id or name)`);
}
