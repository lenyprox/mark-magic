import 'server-only';
// Spawns the detached optimiser daemon for a run (node + tsx loader, output to data/optimizer/<id>.log) and
// detects stale runs (heartbeat older than 30 s while "running") so the UI can offer a resume.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, projectRoot } from '@config/paths';
import type { OptimizerRun } from '@optimizer/types';

export const STALE_MS = 30_000;

export function spawnDaemon(runId: string, workers?: number): { pid: number | null; log: string } {
  const root = projectRoot();
  const logDir = path.join(DATA_DIR(), 'optimizer'); fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${runId}.log`);
  const preflight = path.join(root, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
  const loader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const script = path.join(root, 'scripts', 'optimizer-daemon.ts');
  const args = ['--require', preflight, '--import', 'file:///' + loader.replace(/\\/g, '/'), script, '--run', runId, '--log', log];
  if (workers) args.push('--workers', String(workers));
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  return { pid: child.pid ?? null, log };
}

/** A run that says it is running but whose daemon stopped heartbeating. */
export function isStale(run: OptimizerRun, now = Date.now()): boolean {
  if (run.status !== 'running' && run.status !== 'queued' && run.status !== 'cancelling') return false;
  const hb = Date.parse(run.progress.heartbeat || run.updatedAt);
  return Number.isFinite(hb) && now - hb > STALE_MS;
}

export function logTail(runId: string, lines = 40): string[] {
  const file = path.join(DATA_DIR(), 'optimizer', `${runId}.log`);
  if (!fs.existsSync(file)) return [];
  const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return all.slice(-lines);
}
