import { getGames } from '@/lib/db';
import type { GameRecordInput } from '@user/decks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50) || 50;
  return Response.json(getGames().list(limit));
}

export async function POST(req: Request) {
  const body = (await req.json()) as GameRecordInput;
  if (typeof body?.seed !== 'number' || !body.myDeckSnapshot || !body.oppDeckSnapshot) return Response.json({ error: 'seed and deck snapshots required' }, { status: 400 });
  const id = getGames().save(body);
  return Response.json({ id }, { status: 201 });
}
