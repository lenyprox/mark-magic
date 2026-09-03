// CardDefs for an unsaved deck: either a deck list in the body or one of the bundled decks/*.txt files.
import fs from 'node:fs';
import path from 'node:path';
import { getCards } from '@/lib/db';
import { parseDeckList, type DeckList } from '@cards/db';
import { projectRoot } from '@config/paths';
import { buildDeckPayload } from '@play/payload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json()) as { list?: DeckList; text?: string; bundled?: string; name?: string };
  let list: DeckList | null = null;
  if (body.list) list = body.list;
  else if (body.text) list = parseDeckList(body.text, body.name ?? 'deck');
  else if (body.bundled) {
    const safe = body.bundled.replace(/[^\w.-]/g, '');
    const file = path.join(projectRoot(), 'decks', safe.endsWith('.txt') ? safe : safe + '.txt');
    if (!fs.existsSync(file)) return Response.json({ error: 'unknown bundled deck' }, { status: 404 });
    list = parseDeckList(fs.readFileSync(file, 'utf8'), path.basename(file, '.txt'));
  }
  if (!list) return Response.json({ error: 'list, text or bundled required' }, { status: 400 });
  return Response.json(buildDeckPayload(getCards(), list, { name: body.name ?? list.name }));
}

export function GET() {
  const dir = path.join(projectRoot(), 'decks');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.txt')) : [];
  return Response.json(files.map(f => { const list = parseDeckList(fs.readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.txt$/, '')); return { file: f.replace(/\.txt$/, ''), name: list.name, count: list.cards.filter(c => c.board !== 'side').reduce((a, c) => a + c.count, 0) }; }));
}
