// Project-root-relative paths. Next.js runs with cwd = apps/web, CLI scripts run from the repo root,
// so every file path is resolved from the repo root found by walking up to package.json#name === 'mtg-master-sim'.
import fs from 'node:fs';
import path from 'node:path';

let cachedRoot: string | null = null;

export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;
  const env = process.env.MTG_ROOT;
  if (env && fs.existsSync(path.join(env, 'package.json'))) return (cachedRoot = path.resolve(env));
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try { const j = JSON.parse(fs.readFileSync(pkg, 'utf8')); if (j.name === 'mtg-master-sim') return (cachedRoot = dir); } catch { /* ignore */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedRoot = process.cwd());
}

export const MASTER_DB = () => path.join(projectRoot(), 'data', 'master', 'master.db');
export const USER_DB = () => path.join(projectRoot(), 'data', 'user.db');
export const IMAGE_DIR = () => path.join(projectRoot(), 'data', 'images');
export const DATA_DIR = () => path.join(projectRoot(), 'data');
