// Server-only singleton for the metagame service (survives HMR via globalThis), shared by the /api/meta routes.
import 'server-only';
import { getCards, getDecks, getUserDb } from '@/lib/db';
import { MetaService } from '@meta/service';
import { canonicalFormat, type MetaFormat } from '@meta/types';

const g = globalThis as unknown as { __mtgMeta?: MetaService };

export function getMeta(): MetaService {
  if (!g.__mtgMeta) {
    let cards = null;
    try { cards = getCards(); } catch { cards = null; }
    g.__mtgMeta = new MetaService({ user: getUserDb(), cards });
  }
  return g.__mtgMeta;
}

export { getDecks };

export function parseFormat(input: string | null | undefined): MetaFormat | null {
  return input ? canonicalFormat(input) : null;
}

export function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function readJson<T>(req: Request): Promise<T> {
  try { const text = await req.text(); return (text ? JSON.parse(text) : {}) as T; } catch { return {} as T; }
}
