// One Comprehensive Rules paragraph by number. Served from data/rules/cr.json (built by `npm run data:cr`) with the
// bundled excerpt (apps/web/lib/rules/cr-excerpts.json) as the fallback when the full file is absent.
// The rules text is © Wizards of the Coast LLC, used under the Wizards of the Coast Fan Content Policy.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@config/paths';
import { lookupExcerpt } from '@/lib/rules/excerpts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Full { version: string; rules: Record<string, string> }
const g = globalThis as unknown as { __cr?: Full | null };

function full(): Full | null {
  if (g.__cr !== undefined) return g.__cr;
  try {
    const file = path.join(DATA_DIR(), 'rules', 'cr.json');
    g.__cr = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Full) : null;
  } catch { g.__cr = null; }
  return g.__cr;
}

export async function GET(_req: Request, ctx: { params: Promise<{ num: string }> }) {
  const { num } = await ctx.params;
  const n = decodeURIComponent(num).trim();
  if (!/^\d{3}\.\d+[a-z]?$/.test(n)) return Response.json({ error: 'not a rule number' }, { status: 400 });
  const f = full();
  if (f) {
    const hit = f.rules[n] ?? f.rules[n.replace(/[a-z]$/, '')];
    if (hit) return Response.json({ num: n, text: hit, version: f.version, source: 'full', exact: !!f.rules[n] }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  }
  const ex = lookupExcerpt(n);
  if (ex) return Response.json({ num: n, text: ex.text, version: ex.version, source: 'excerpt', exact: ex.exact }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  return Response.json({ error: `rule ${n} not found${f ? '' : ' (run npm run data:cr for the full rules)'}` }, { status: 404 });
}
