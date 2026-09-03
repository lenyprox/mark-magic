// Downloads Scryfall bulk data (oracle_cards, default_cards, rulings) + the full set list.
// Scryfall asks for a descriptive User-Agent and <=10 req/s. We make ~6 requests total.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const UA = 'mtg-master-sim/0.1 (local research tool)';
const RAW = path.resolve('data/raw');
fs.mkdirSync(RAW, { recursive: true });

const WANT = ['oracle_cards', 'default_cards', 'rulings'];
const headers = { 'User-Agent': UA, Accept: 'application/json' };

async function getJSON(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok || !r.body) throw new Error(`${url} -> ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0);
  let seen = 0, lastPct = -1;
  const counter = new (await import('node:stream')).Transform({
    transform(chunk, _e, cb) {
      seen += chunk.length;
      if (total) { const pct = Math.floor(seen * 100 / total); if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`  ${path.basename(dest)} ${pct}%\n`); } }
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(r.body), counter, fs.createWriteStream(dest));
  return seen;
}

const manifest = { fetched_at: new Date().toISOString(), files: {} };

// 1. bulk-data index
const bulk = await getJSON('https://api.scryfall.com/bulk-data');
for (const b of bulk.data) {
  if (!WANT.includes(b.type)) continue;
  const uri = b.jsonl_download_uri || b.download_uri;
  const ext = uri.endsWith('.gz') ? '.jsonl.gz' : '.json';
  const dest = path.join(RAW, `${b.type}${ext}`);
  console.log(`Downloading ${b.type} (${(b.compressed_size / 1e6).toFixed(1)} MB compressed, updated ${b.updated_at})`);
  const bytes = await download(uri, dest);
  if (b.compressed_size && bytes !== b.compressed_size) throw new Error(`size mismatch for ${b.type}: got ${bytes}, expected ${b.compressed_size}`);
  manifest.files[b.type] = { file: path.basename(dest), bytes, updated_at: b.updated_at, source: uri };
}

// 2. sets (paginated, currently a single page)
let sets = [], url = 'https://api.scryfall.com/sets';
while (url) { const j = await getJSON(url); sets.push(...j.data); url = j.has_more ? j.next_page : null; }
fs.writeFileSync(path.join(RAW, 'sets.json'), JSON.stringify(sets));
manifest.files.sets = { file: 'sets.json', count: sets.length, expected_cards: sets.reduce((a, s) => a + s.card_count, 0) };

// 3. catalogs used by the audit (types, keywords)
const catalogs = {};
for (const c of ['card-types', 'supertypes', 'creature-types', 'planeswalker-types', 'artifact-types', 'enchantment-types', 'land-types', 'spell-types', 'keyword-abilities', 'keyword-actions', 'ability-words', 'battle-types']) {
  catalogs[c] = (await getJSON(`https://api.scryfall.com/catalog/${c}`)).data;
  await new Promise(r => setTimeout(r, 120));
}
fs.writeFileSync(path.join(RAW, 'catalogs.json'), JSON.stringify(catalogs));
manifest.files.catalogs = { file: 'catalogs.json', keys: Object.keys(catalogs) };

fs.writeFileSync(path.join(RAW, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Manifest written:', JSON.stringify(manifest, null, 2));
