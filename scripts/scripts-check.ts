// Validate the scripts under data/scripts: schema (strict), LF-only bytes, oracle-hash freshness (stale after a
// Scryfall refresh), no `unknown` effects in llm/reviewed/hand scripts, every `covers`/`ignore` line matching a real
// oracle line, ignore reasons that do not hide a simulable verb, and that the scripted card resolves in master.db.
// Verification staleness is reported as INFO, never as a problem. Exit 1 on problems.
//
//   npm run scripts:check                 # every script (default)
//   npm run scripts:check -- --changed    # only files git reports as modified/untracked under data/scripts
//   npm run scripts:check -- --ids a,b,c
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CardDB } from '../src/cards/db.js';
import { parseCard } from '../src/cards/parse.js';
import { CardScriptChecked } from '../src/cards/schema.js';
import {
  applyScript, DEFAULT_SCRIPTS_DIR, normalizeOracleLines, oracleHash, scriptHash, ScriptStore, type CardScript,
} from '../src/cards/scripts.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const mode = args.includes('--ids') ? 'ids' : args.includes('--changed') ? 'changed' : 'all';

/** A line an author claims is unsimulable must not contain a verb the engine can already model. */
const SIMULABLE_VERB = /\b(deal|deals|dealt|draw|draws|drawn|destroy|destroys|exile|exiles|exiled|counter|counters|create|creates|sacrifice|sacrifices|gain|gains|lose|loses|put|puts|return|returns|search|searches|tap|taps|untap|untaps|discard|discards|mill|mills)\b/i;

const store = new ScriptStore();
const dir = DEFAULT_SCRIPTS_DIR();

/** Oracle ids to check, per --all / --changed / --ids. */
function selectIds(): string[] {
  if (mode === 'ids') return (opt('--ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (mode === 'all') return store.ids();
  // --changed: git's view of data/scripts, untracked directories expanded
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain', '--', 'data/scripts'], { encoding: 'utf8' }); }
  catch { console.log('--changed: git is unavailable here; falling back to --all'); return store.ids(); }
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    const p = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!p) continue;
    if (p.endsWith('/')) { walk(p, files); continue; }
    if (p.endsWith('.json')) files.add(p);
  }
  const ids: string[] = [];
  for (const f of files) { const id = path.basename(f, '.json'); if (store.fileOf(id)) ids.push(id); }
  return ids;
}

function walk(rel: string, into: Set<string>) {
  if (!fs.existsSync(rel)) return;
  for (const e of fs.readdirSync(rel, { withFileTypes: true })) {
    const p = path.posix.join(rel.replace(/\\/g, '/').replace(/\/$/, ''), e.name);
    if (e.isDirectory()) walk(p, into); else if (e.name.endsWith('.json')) into.add(p);
  }
}

const cards = CardDB.shared();
const ids = selectIds();
let ok = 0;
const problems: string[] = [];
const info: string[] = [];

for (const id of ids) {
  const file = store.fileOf(id);
  if (!file) { problems.push(`${id}: no script file under ${dir}`); continue; }

  // 0. raw bytes: LF only, parseable JSON
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes('\r')) { problems.push(`${id}: file contains CR — scripts must be LF only (${path.relative(process.cwd(), file)})`); continue; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { problems.push(`${id}: not valid JSON (${(e as Error).message})`); continue; }

  // 1. schema, strict, before anything else
  const res = CardScriptChecked.safeParse(parsed);
  if (!res.success) {
    for (const iss of res.error.issues.slice(0, 6)) problems.push(`${id}: schema — ${iss.path.join('.') || '(root)'}: ${iss.message}`);
    continue;
  }
  const script: CardScript = res.data;

  if (script.oracleId !== id) problems.push(`${id}: oracleId ${script.oracleId} does not match the file name`);
  if (path.basename(path.dirname(file)) !== 'scripts' && path.basename(path.dirname(file)) !== id.slice(0, 2).toLowerCase())
    problems.push(`${id}: lives in shard ${path.basename(path.dirname(file))} but belongs in ${id.slice(0, 2).toLowerCase()} (run npm run scripts:shard)`);

  const row = cards.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(id) as { json: string } | undefined;
  if (!row) { problems.push(`${id}: no such card in master.db`); continue; }
  const rawRow = JSON.parse(row.json);
  const def = parseCard({ ...rawRow, representative_id: rawRow.representative_id ?? rawRow.id ?? null });

  // 2. freshness of the script itself
  const fresh = oracleHash(def.oracleText);
  if (script.oracleHash !== fresh) problems.push(`${id} (${script.name}): stale — oracle text changed (hash ${fresh})`);

  // 3. covers / ignore must name real oracle lines
  const lines = new Set([...normalizeOracleLines(def), ...def.unparsed.map(u => u.trim())]);
  const claimed = [
    ...(script.covers ?? []).map(l => ['covers', l] as const),
    ...(script.backFace?.covers ?? []).map(l => ['backFace.covers', l] as const),
    ...(script.ignore ?? []).map(i => ['ignore', i.line] as const),
  ];
  for (const [where, line] of claimed) {
    if (line === '*') continue;   // the schema already restricts '*' to mode 'replace'
    if (!lines.has(line.trim())) problems.push(`${id} (${script.name}): ${where} line does not match any oracle line: ${JSON.stringify(line)}`);
  }
  for (const ig of script.ignore ?? []) {
    const m = ig.line.match(SIMULABLE_VERB);
    if (m) problems.push(`${id} (${script.name}): ignore[${ig.reason}] hides a simulable verb "${m[0]}" — script the line instead: ${JSON.stringify(ig.line)}`);
  }

  // 4. the script must actually finish the card (generated drafts are exempt)
  const applied = applyScript(def, script);
  const unknowns = applied.abilities.flatMap(a => 'effects' in a ? a.effects.filter(e => e.op === 'unknown') : []);
  const authored = script.source !== 'generated';
  if (authored && unknowns.length) problems.push(`${id} (${script.name}): ${script.source} script still has ${unknowns.length} unknown effect(s)`);
  if (authored && !applied.fullyParsed) problems.push(`${id} (${script.name}): ${script.source} script does not make the card fully simulated (unparsed: ${applied.unparsed.slice(0, 3).join(' | ')})`);

  // 5. verification freshness — informational only
  if (script.verification) {
    const v = script.verification;
    if (v.scriptHash !== scriptHash(script)) info.push(`${id} (${script.name}): verification is stale — the script changed since it was verified`);
    else if (v.oracleHash !== fresh) info.push(`${id} (${script.name}): verification is stale — the oracle text changed since it was verified`);
  }
  ok++;
}

console.log(`${ok} script(s) checked${mode === 'all' ? '' : ` (--${mode})`}, ${problems.length} problem(s)`);
for (const p of problems) console.log('  ' + p);
for (const i of info) console.log('  INFO ' + i);
cards.close();
process.exit(problems.length ? 1 : 0);
