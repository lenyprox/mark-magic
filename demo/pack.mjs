// Packs the current checkout into a self-contained demo zip: source, node_modules, the production web build,
// master.db + index, a clean copy of user.db, the image cache, and the launchers from this folder at the root.
// Usage: npm run demo:pack [-- --out <file.zip>]   (run `npm run web:build` first; the TopDeck key is never included)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args[args.indexOf('--out') + 1];
const date = new Date().toISOString().slice(0, 10);
const out = path.resolve(root, outArg && args.includes('--out') ? outArg : path.join('dist', `vault-demo-${date}.zip`));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-demo-'));
const pkgDir = path.join(stage, 'vault-demo');

if (!fs.existsSync(path.join(root, 'apps', 'web', '.next', 'BUILD_ID'))) { console.error('No production build: run `npm run web:build` first.'); process.exit(2); }
if (!fs.existsSync(path.join(root, 'data', 'master', 'master.db'))) { console.error('master.db missing: run `npm run data:all && npm run web:index` first.'); process.exit(2); }

const SKIP_DIRS = new Set(['.git', '.cache', 'test-results', 'playwright-report']);
const SKIP_REL = new Set(['dist', 'data/raw', 'apps/web/.next/dev', 'apps/web/.next/cache', 'apps/web/.next/diagnostics', 'apps/web/.next/trace-build', 'apps/web/.next/trace', 'node_modules/@mtg', 'demo/built-on.json']);
const SKIP_FILE = /^(oracle\.jsonl|printings\.jsonl|user\.db(-wal|-shm)?|\.env\.local|tsconfig\.tsbuildinfo|_events_.*\.json)$/;
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const keep = (src) => {
  const r = rel(src); if (!r) return true;
  const base = path.basename(src);
  if (SKIP_DIRS.has(base) || SKIP_REL.has(r) || SKIP_FILE.test(base)) return false;
  return true;
};

console.log(`staging ${root} -> ${pkgDir}`);
fs.cpSync(root, pkgDir, { recursive: true, filter: keep, dereference: false });

// A single-file, consistent copy of user.db (decks, games, synced metagame), whatever WAL state the live one is in.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const userDb = path.join(root, 'data', 'user.db');
if (fs.existsSync(userDb)) {
  const db = new Database(userDb, { readonly: true });
  db.exec(`VACUUM INTO '${path.join(pkgDir, 'data', 'user.db').split(path.sep).join('/').replace(/'/g, "''")}'`);
  db.close();
}

// Launchers at the package root; helpers stay in demo/. The marker lets the launcher spot a different OS/arch.
for (const f of ['Start Vault Demo.cmd', 'start-demo.sh', 'Install Node.cmd', 'install-node.sh', 'README-DEMO.txt']) {
  fs.copyFileSync(path.join(root, 'demo', f), path.join(pkgDir, f));
  fs.rmSync(path.join(pkgDir, 'demo', f));
}
fs.writeFileSync(path.join(pkgDir, 'demo', 'built-on.json'), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, packedAt: new Date().toISOString() }, null, 2) + '\n');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
console.log(`zipping -> ${out}`);
if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe'), ['-a', '-cf', out, 'vault-demo'], { cwd: stage, stdio: 'inherit' });
else execFileSync('zip', ['-qr', out, 'vault-demo'], { cwd: stage, stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`done: ${out} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
