// Builds the DeckPayload the worker needs (parsed CardDefs, one per distinct card/printing) from a deck list. Node-side.
import type { CardDB, DeckList } from '../cards/db.js';
import type { CardDef } from '../cards/types.js';
import type { DeckPayload } from './protocol.js';

export interface PayloadOptions { deckId?: string | null; name?: string; /** chosen printing per card name (deck builder) */ printings?: Record<string, string | null>; archetype?: DeckPayload['archetype'] }

export function buildDeckPayload(db: CardDB, list: DeckList, opts: PayloadOptions = {}): DeckPayload {
  const defs: Record<string, CardDef> = {};
  const main: { key: string; count: number }[] = []; const commander: { key: string; count: number }[] = [];
  const missing: string[] = []; const partial = new Map<string, string[]>();
  for (const entry of list.cards) {
    const board = entry.board ?? 'main';
    if (board !== 'main' && board !== 'commander') continue;
    const base = db.get(entry.name);
    if (!base) { missing.push(entry.name); continue; }
    const printingId = opts.printings?.[entry.name] ?? opts.printings?.[base.name] ?? null;
    const key = printingId ? `${base.name}@${printingId}` : base.name;
    if (!defs[key]) defs[key] = printingId ? { ...base, printingId } : base;
    if (!base.fullyParsed) partial.set(base.name, base.unparsed);
    (board === 'commander' ? commander : main).push({ key, count: entry.count });
  }
  return { deckId: opts.deckId ?? null, name: opts.name ?? list.name, defs, main, commander, missing, partial: [...partial].map(([name, unparsed]) => ({ name, unparsed })), list, archetype: opts.archetype ?? null };
}

/** Expand a payload into the flat CardDef[] the engine takes, commanders shuffled in (freeform games). */
export function expandPayload(p: DeckPayload): CardDef[] {
  const out: CardDef[] = [];
  for (const e of [...p.commander, ...p.main]) { const d = p.defs[e.key]; if (!d) continue; for (let i = 0; i < e.count; i++) out.push(d); }
  return out;
}

/** Library and command-zone cards separately (Commander games). */
export function splitPayload(p: DeckPayload): { library: CardDef[]; commanders: CardDef[] } {
  const library: CardDef[] = []; const commanders: CardDef[] = [];
  for (const e of p.main) { const d = p.defs[e.key]; if (!d) continue; for (let i = 0; i < e.count; i++) library.push(d); }
  for (const e of p.commander) { const d = p.defs[e.key]; if (!d) continue; for (let i = 0; i < e.count; i++) commanders.push(d); }
  return { library, commanders };
}

/** Whether a game between these payloads should use Commander rules. */
export function isCommanderMatch(decks: DeckPayload[], format?: string | null): boolean {
  if (format) return /^(commander|edh|cedh|brawl)$/i.test(format);
  return decks.some(d => d.commander.length > 0);
}
