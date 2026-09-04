// Exit 0 when the bundled node_modules are usable on this machine, 1 when the launcher should run `npm ci`.
// Two checks: the platform the bundle was packed on (Next.js ships a per-platform SWC binary) and the SQLite binding.
const fs = require('node:fs'); const path = require('node:path');
try {
  const marker = path.join(__dirname, 'built-on.json');
  const built = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  if (built && (built.platform !== process.platform || built.arch !== process.arch)) {
    console.error(`[demo] bundle was packed on ${built.platform}-${built.arch}, this machine is ${process.platform}-${process.arch}`); process.exit(1);
  }
  require('better-sqlite3');
  process.exit(0);
} catch (e) { console.error('[demo] ' + (e && e.message ? e.message.split('\n')[0] : e)); process.exit(1); }
