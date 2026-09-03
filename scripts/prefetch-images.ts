// Warm the local image cache. Usage (from the repo root):
//   npx tsx scripts/prefetch-images.ts --deck <deckId|decks/file.txt> [--sizes normal,large]
//   npx tsx scripts/prefetch-images.ts --set lea [--sizes small,normal]
//   npx tsx scripts/prefetch-images.ts --query "t:legendary c:R" [--limit 500]
//   npx tsx scripts/prefetch-images.ts --reps            # every representative printing at `normal` (~38k files, ~3 GB)
import fs from 'node:fs';
import path from 'node:path';
import { CardDB, parseDeckList } from '../src/cards/db.js';
import { CardQueryDB } from '../src/cards/query.js';
import { prefetch, type ImageSize } from '../src/images/cache.js';
import { openUserDb } from '../src/user/db.js';
import { DeckStore } from '../src/user/decks.js';
import { parseCardQuery } from '../apps/web/lib/query-params.js';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const sizes = (opt('--sizes', 'normal') ?? 'normal').split(',') as ImageSize[];
const concurrency = Number(opt('--concurrency', '4'));
const limit = Number(opt('--limit', '2000'));

const cards = CardDB.shared();
const q = new CardQueryDB(cards.db);
if (!q.hasWebIndex()) { console.error('Run npm run web:index first'); process.exit(1); }

const items: { id: string; face: number; size: ImageSize }[] = [];
const add = (id: string, hasBack: boolean) => { for (const size of sizes) { items.push({ id, face: 0, size }); if (hasBack) items.push({ id, face: 1, size }); } };

if (opt('--deck')) {
  const ref = opt('--deck')!;
  let names: string[] = []; const printings = new Map<string, string>();
  if (fs.existsSync(ref)) names = parseDeckList(fs.readFileSync(ref, 'utf8'), path.basename(ref)).cards.map(c => c.name);
  else { const d = new DeckStore(openUserDb()).get(ref); if (!d) { console.error('deck not found'); process.exit(1); } for (const c of d.cards) { names.push(c.name); if (c.printingId) printings.set(c.name, c.printingId); } }
  for (const n of [...new Set(names)]) {
    const def = cards.get(n); if (!def) continue;
    const pid = printings.get(n) ?? def.representativePrintingId; if (!pid) continue;
    const p = q.printing(pid); add(pid, !!p?.hasBack);
  }
} else if (opt('--set')) {
  const r = q.search({ mode: 'printing', set: opt('--set')!, pageSize: 120, sort: 'collector' });
  for (let page = 1; page <= Math.ceil(r.total / 120); page++) for (const c of q.search({ mode: 'printing', set: opt('--set')!, pageSize: 120, sort: 'collector', page }).items) add(c.printingId, c.hasBack);
} else if (opt('--query')) {
  const base = parseCardQuery(new URLSearchParams({ q: opt('--query')! }));
  let got = 0;
  for (let page = 1; got < limit; page++) { const r = q.search({ ...base, page, pageSize: 120 }); if (!r.items.length) break; for (const c of r.items) { add(c.printingId, c.hasBack); if (++got >= limit) break; } }
} else if (args.includes('--reps')) {
  const rows = cards.db.prepare('SELECT rep_printing_id AS id, has_back FROM card_index WHERE playable = 1').all() as { id: string; has_back: number }[];
  for (const r of rows) add(r.id, !!r.has_back);
} else { console.log('nothing to do; see the usage comment at the top of this file'); process.exit(0); }

console.log(`prefetching ${items.length} images (${sizes.join(', ')}) with concurrency ${concurrency}`);
let last = 0;
const res = await prefetch(items, (id, face) => q.imageSource(id, face), { concurrency, onProgress: (done, total, failed) => { if (done - last >= 50 || done === total) { last = done; console.log(`  ${done}/${total} (${failed} failed)`); } } });
console.log(res);
