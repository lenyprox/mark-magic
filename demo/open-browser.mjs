// Waits for the local server to answer, then opens the default browser once. Used by the demo launchers.
import { spawn } from 'node:child_process';
const port = process.argv[2] || '3000';
const url = `http://localhost:${port}/`;
const started = Date.now();
async function ready() {
  try { const r = await fetch(url, { redirect: 'manual' }); return r.status < 500; } catch { return false; }
}
while (!(await ready())) {
  if (Date.now() - started > 180_000) { console.error(`[demo] server did not answer on ${url} within 3 minutes`); process.exit(1); }
  await new Promise(r => setTimeout(r, 1000));
}
const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
console.log(`[demo] opened ${url}`);
