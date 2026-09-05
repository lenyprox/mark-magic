// Project-root-relative paths. Next.js runs with cwd = apps/web, CLI scripts run from the repo root,
// so every file path is resolved from the repo root found by walking up to package.json#name === 'mtg-master-sim'.
// Data (master.db, user.db, images, bench) is gitignored, so a linked git worktree has none of it: when the root has
// no data/master/master.db and `.git` is a file ("gitdir: <main>/.git/worktrees/<name>"), the main checkout's data
// directory is used. Never junction or symlink data/ into a worktree (`git worktree remove` follows the link).
import fs from 'node:fs';
import path from 'node:path';

let cachedRoot: string | null = null;
let cachedData: string | null = null;

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

/** The main checkout behind a linked worktree (the parent of git's common dir), or null when `root` is not a linked worktree. */
export function mainCheckoutOf(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    if (!fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(root, m[1].trim());                 // <main>/.git/worktrees/<name>
    const commonFile = path.join(gitdir, 'commondir');
    const commonDir = fs.existsSync(commonFile) ? path.resolve(gitdir, fs.readFileSync(commonFile, 'utf8').trim()) : path.dirname(path.dirname(gitdir));
    return path.dirname(commonDir);
  } catch { return null; }
}

/** The data directory: MTG_DATA_DIR, else <root>/data, else (linked worktree without a database) the main checkout's data. */
export const DATA_DIR = (): string => {
  if (cachedData) return cachedData;
  const env = process.env.MTG_DATA_DIR;
  if (env && fs.existsSync(env)) return (cachedData = path.resolve(env));
  const local = path.join(projectRoot(), 'data');
  if (fs.existsSync(path.join(local, 'master', 'master.db'))) return (cachedData = local);
  const main = mainCheckoutOf(projectRoot());
  if (main && fs.existsSync(path.join(main, 'data', 'master', 'master.db'))) return (cachedData = path.join(main, 'data'));
  return (cachedData = local);
};
export const MASTER_DB = () => path.join(DATA_DIR(), 'master', 'master.db');
export const USER_DB = () => path.join(DATA_DIR(), 'user.db');
export const IMAGE_DIR = () => path.join(DATA_DIR(), 'images');
/** 2.5D scene packs written by tools/scene/analyze.py: <SCENE_DIR>/<id[0:2]>/<id>-<face>/{scene.json,...}. */
export const SCENE_DIR = () => path.join(DATA_DIR(), 'scene');
