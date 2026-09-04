// The verification dashboard data (data/master/verification.json, written by `npm run verify:dashboard`).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@config/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const file = path.join(DATA_DIR(), 'master', 'verification.json');
  if (!fs.existsSync(file)) return Response.json({ error: 'Run npm run verify:dashboard first' }, { status: 404 });
  return new Response(fs.readFileSync(file, 'utf8'), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}
