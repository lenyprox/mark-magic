// Validate the scripts under data/scripts: schema (strict, including typed `covers` entries), LF-only bytes,
// oracle-hash freshness (stale after a Scryfall refresh), every ability carrying behaviour, every `covers` entry
// naming a declaration its face really has and a line of that face, every `ignore` line matching a line
// `scriptableLines(def)` names, every `ignore` reason matching its whitelist entry for this card's pool tier, no
// `unknown` anywhere, and that EVERY face with playable text (front, `backFace` for a transform / modal DFC,
// `secondFace` for a split / adventure / flip card) ends up fully simulated — for EVERY source, `generated` included: the
// drafts directory is gitignored and unindexed, so the only generated script this can reach is one someone promoted
// into a shard, which is exactly the case worth catching. A script that declares nothing and an ability whose text
// names no oracle line are WARNings; verification staleness is INFO. Exit 1 on problems.
//
//   npm run scripts:check                 # every script (default)
//   npm run scripts:check -- --changed    # only files git reports as modified/untracked under data/scripts
//   npm run scripts:check -- --ids a,b,c
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CardDB } from '../src/cards/db.js';
import { parseCard } from '../src/cards/parse.js';
import { tierOf } from '../src/cards/pool.js';
import { CardScriptChecked } from '../src/cards/schema.js';
import {
  abilityIsSubstantive, applyScript, coverProblems, DEFAULT_SCRIPTS_DIR, faceScriptableLines, hasUnknown,
  ignoreLineProblem, oracleHash, scriptableLines, scriptHash, ScriptStore, secondFaceLines, secondFaceUnclaimed,
  unmatchedAbilityTexts, type CardScript, type ScriptFace,
} from '../src/cards/scripts.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const mode = args.includes('--ids') ? 'ids' : args.includes('--changed') ? 'changed' : 'all';

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

/** Every field a `ScriptFace` may declare — used to tell "this face says nothing" from "this face says something". */
const FACE_FIELDS = [
  'keywords', 'abilities', 'altCosts', 'asEnters', 'costModifiers', 'additionalCosts', 'kicker', 'cycling',
  'cyclingSearch', 'entersTapped', 'morph', 'cascade', 'storm', 'rebound', 'dredge', 'graveyardReplacement',
  'protectionFrom', 'wardCost', 'toxic', 'bushido', 'rampage', 'landwalk', 'firebending', 'covers',
] as const satisfies readonly (keyof ScriptFace)[];

const cards = CardDB.shared();
const ids = selectIds();
let ok = 0;
const problems: string[] = [];
const warn: string[] = [];
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

  // 3. every ability must CARRY BEHAVIOUR: an ability with an empty `effects` array claims no line (it would
  //    otherwise be a card with the right texts and nothing behind them). The schema rejects that too; this reports
  //    it by name, and also catches an ability whose only content is an `unknown`.
  for (const [where, face] of [['abilities', script as ScriptFace], ['backFace', script.backFace], ['secondFace', script.secondFace]] as const) {
    for (const a of face?.abilities ?? []) {
      if (abilityIsSubstantive(a)) continue;
      const why = a.kind !== 'static' && (a.effects?.length ?? 0) === 0 ? 'ability declares no effect' : 'ability is nothing but an unknown';
      problems.push(`${id} (${script.name}): ${where}: ${why}, so it claims no line: ${JSON.stringify(a.text)}`);
    }
  }

  // 4. covers / ignore must name real oracle lines OF THE FACE THAT CLAIMS THEM (or a fragment the parser itself
  //    reported — see scriptableLines), and every covers entry must name a declaration the face really has.
  const frontLines = new Set(faceScriptableLines(def));
  const backLines = new Set(def.backFace ? faceScriptableLines(def.backFace) : []);
  const secondLines = new Set(secondFaceLines(def));
  const allLines = new Set(scriptableLines(def));
  const faces = [
    ['covers', script.covers ?? [], frontLines] as const,
    ['backFace.covers', script.backFace?.covers ?? [], backLines] as const,
    ['secondFace.covers', script.secondFace?.covers ?? [], secondLines] as const,
  ];
  for (const [where, entries, own] of faces) {
    for (const c of entries) {
      const line = c.line.trim().replace(/^\/\/ /, '');
      if (!own.has(line)) problems.push(`${id} (${script.name}): ${where} line is not a line of that face: ${JSON.stringify(c.line)}`);
    }
  }
  for (const [where, face] of [['covers', script as ScriptFace], ['backFace.covers', script.backFace], ['secondFace.covers', script.secondFace]] as const) {
    for (const why of coverProblems(face)) problems.push(`${id} (${script.name}): ${where} ${why}`);
  }
  for (const ig of script.ignore ?? []) {
    if (!allLines.has(ig.line.trim())) problems.push(`${id} (${script.name}): ignore line does not match any oracle line: ${JSON.stringify(ig.line)}`);
  }
  const tier = tierOf(rawRow);
  for (const ig of script.ignore ?? []) {
    // ignoreLineProblem (src/cards/scripts.ts) owns the policy: a per-reason whitelist regex, plus the pool tier for
    // the two reasons that are only available to un-set and Alchemy cards. applyScript enforces the same rule at
    // runtime, so an ignore this rejects leaves its line unparsed rather than only failing here.
    const why = ignoreLineProblem(ig.line, ig.reason, tier);
    if (why) problems.push(`${id} (${script.name}): ignore[${ig.reason}] ${why}: ${JSON.stringify(ig.line)}`);
  }

  // 5. the script must actually finish the card — EVERY face with playable text, every source, `generated` included
  const applied = applyScript(def, script, tier);
  if (hasUnknown(applied.abilities) || hasUnknown(applied.backFace?.abilities) || hasUnknown(script.secondFace?.abilities)) {
    problems.push(`${id} (${script.name}): ${script.source} script still has an unknown effect / static / trigger / condition`);
  }
  // the same ignore set applyScript honours: an ignore the whitelist rejects claims nothing on the second face either
  const honoured = (script.ignore ?? []).filter(i => ignoreLineProblem(i.line, i.reason, tier) === null).map(i => i.line.trim());
  const secondUnclaimed = secondFaceUnclaimed(def, script, new Set([...honoured, ...honoured.map(l => l.replace(/^\/\/ /, ''))]));
  if (secondUnclaimed.length) {
    problems.push(`${id} (${script.name}): ${script.source} script leaves the second face (${def.faces?.[1]?.name}) unclaimed — declare it under "secondFace": ${secondUnclaimed.slice(0, 3).join(' | ')}`);
  }
  if (!applied.fullyParsed) {
    const back = applied.backFace && !applied.backFace.fullyParsed ? applied.backFace.unparsed : [];
    const where = applied.unparsed.length ? `unclaimed: ${applied.unparsed.slice(0, 3).join(' | ')}`
      : back.length ? `back face unclaimed: ${back.slice(0, 3).join(' | ')}`
      : secondUnclaimed.length ? `second face unclaimed: ${secondUnclaimed.slice(0, 3).join(' | ')}`
      : 'nothing is unclaimed, but something in the card is still unknown';
    problems.push(`${id} (${script.name}): ${script.source} script does not make the card fully simulated (${where})`);
  }
  const declares = (f: ScriptFace | undefined) => !!f && FACE_FIELDS.some(k => { const v = f[k]; return v !== undefined && (Array.isArray(v) ? v.length > 0 : true); });
  if (!declares(script) && !declares(script.backFace) && !declares(script.secondFace) && !script.ignore?.length)
    warn.push(`${id} (${script.name}): ${script.source} script declares nothing — no abilities, keywords, costs, covers or ignore`);
  for (const text of unmatchedAbilityTexts(def, script))
    warn.push(`${id} (${script.name}): ability text names no oracle line, so it claims none: ${JSON.stringify(text)}`);

  // 6. verification freshness — informational only
  if (script.verification) {
    const v = script.verification;
    if (v.scriptHash !== scriptHash(script)) info.push(`${id} (${script.name}): verification is stale — the script changed since it was verified`);
    else if (v.oracleHash !== fresh) info.push(`${id} (${script.name}): verification is stale — the oracle text changed since it was verified`);
  }
  ok++;
}

console.log(`${ok} script(s) checked${mode === 'all' ? '' : ` (--${mode})`}, ${problems.length} problem(s)${warn.length ? `, ${warn.length} warning(s)` : ''}`);
for (const p of problems) console.log('  ' + p);
for (const w of warn) console.log('  WARN ' + w);
for (const i of info) console.log('  INFO ' + i);
cards.close();
process.exit(problems.length ? 1 : 0);
