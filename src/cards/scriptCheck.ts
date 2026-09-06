// The structural check of ONE script against its card — what `scripts:check` runs per id, factored out so that
// `scripts:promote` can run the same check on every card it promotes and REFUSE one that fails (8c-1 B-4). The
// two tools used to disagree: `scripts:verify` wrote `verified` for a card whose printed line stayed unclaimed and
// `scripts:check` then rejected the file (Deflecting Swat, Multiversal Passage — quarantined in fbf6f97). Every
// message here is exactly what scripts:check printed before the split; the CLI keeps its id selection and printing.
//
// The checks, in order: LF-only bytes and parseable JSON; the strict schema (typed `covers` entries included); the
// oracleId matches the file name and the file sits in its shard; oracle-hash freshness; every ability carrying a
// SUBSTANTIVE effect and naming no more lines than it has substantive effects, no line claimed twice; every `covers`
// entry naming a declaration its face really has, a line of that face and the VALUE that declaration prints; every
// `ignore` line matching a line `scriptableLines(def)` names and a reason its whitelist entry allows for this
// card's pool tier; no `unknown` anywhere; and EVERY face with playable text ending up fully simulated. A script that
// declares nothing and an ability whose text names no oracle line are WARNings; verification staleness is INFO.
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from './db.js';
import { parseCard } from './parse.js';
import { tierOf } from './pool.js';
import { CardScriptChecked } from './schema.js';
import {
  applyScript, coverProblems, faceClaimProblems, faceScriptableLines, hasUnknown, ignoreLineProblem, oracleHash,
  scriptableLines, scriptHash, ScriptStore, secondFaceLines, secondFaceOf, secondFaceUnclaimed, unmatchedAbilityTexts,
  type CardScript, type ScriptFace,
} from './scripts.js';

/** Every field a `ScriptFace` may declare — used to tell "this face says nothing" from "this face says something". */
const FACE_FIELDS = [
  'keywords', 'abilities', 'altCosts', 'asEnters', 'costModifiers', 'additionalCosts', 'kicker', 'cycling',
  'cyclingSearch', 'entersTapped', 'morph', 'cascade', 'storm', 'rebound', 'dredge', 'graveyardReplacement',
  'protectionFrom', 'wardCost', 'toxic', 'bushido', 'rampage', 'landwalk', 'firebending', 'covers',
] as const satisfies readonly (keyof ScriptFace)[];

export interface CheckContext { store: ScriptStore; cards: CardDB }
export interface CheckResult { oracleId: string; problems: string[]; warnings: string[]; info: string[] }

/** The structural check of one script. `problems` non-empty means scripts:check would exit 1 on this id. */
export function checkScript(id: string, ctx: CheckContext): CheckResult {
  const { store, cards } = ctx;
  const dir = store.dir;
  const problems: string[] = [];
  const warn: string[] = [];
  const info: string[] = [];
  const out: CheckResult = { oracleId: id, problems, warnings: warn, info };

  const file = store.fileOf(id);
  if (!file) { problems.push(`${id}: no script file under ${dir}`); return out; }

  // 0. raw bytes: LF only, parseable JSON
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes('\r')) { problems.push(`${id}: file contains CR — scripts must be LF only (${path.relative(process.cwd(), file)})`); return out; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { problems.push(`${id}: not valid JSON (${(e as Error).message})`); return out; }

  // 1. schema, strict, before anything else
  const res = CardScriptChecked.safeParse(parsed);
  if (!res.success) {
    for (const iss of res.error.issues.slice(0, 6)) problems.push(`${id}: schema — ${iss.path.join('.') || '(root)'}: ${iss.message}`);
    return out;
  }
  const script: CardScript = res.data;

  if (script.oracleId !== id) problems.push(`${id}: oracleId ${script.oracleId} does not match the file name`);
  if (path.basename(path.dirname(file)) !== 'scripts' && path.basename(path.dirname(file)) !== id.slice(0, 2).toLowerCase())
    problems.push(`${id}: lives in shard ${path.basename(path.dirname(file))} but belongs in ${id.slice(0, 2).toLowerCase()} (run npm run scripts:shard)`);

  const row = cards.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(id) as { json: string } | undefined;
  if (!row) { problems.push(`${id}: no such card in master.db`); return out; }
  const rawRow = JSON.parse(row.json);
  const def = parseCard({ ...rawRow, representative_id: rawRow.representative_id ?? rawRow.id ?? null });

  // 2. freshness of the script itself
  const fresh = oracleHash(def.oracleText);
  if (script.oracleHash !== fresh) problems.push(`${id} (${script.name}): stale — oracle text changed (hash ${fresh})`);

  // 3. every ability must CARRY BEHAVIOUR and stay inside its LINE BUDGET: an ability with no substantive effect
  //    claims no line (it would otherwise be a card with the right texts and nothing behind them — including one
  //    whose effects are all zero-magnitude, reported as "effect has zero magnitude: draw 0"), and an ability
  //    may name at most one line per substantive effect, so a single `draw` cannot finish a three-line spell. The
  //    same pass reports a line two declarations both claim. `faceClaimProblems` owns the rule; `applyScript`
  //    enforces the identical one at runtime through `abilityClaimLines`.
  const faceNames = [
    ['abilities', script as ScriptFace, def.name],
    ['backFace', script.backFace, def.backFace?.name ?? def.name],
    ['secondFace', script.secondFace, secondFaceOf(def)?.name ?? def.name],
  ] as const;
  for (const [where, face, cardName] of faceNames) {
    for (const why of faceClaimProblems(face, cardName)) problems.push(`${id} (${script.name}): ${where}: ${why}`);
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
  return out;
}

/** `checkScript` over many ids, in order, with the counts the CLI prints. */
export function checkIds(ids: readonly string[], ctx: CheckContext): { ok: number; problems: string[]; warnings: string[]; info: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  let ok = 0;
  for (const id of ids) {
    const r = checkScript(id, ctx);
    problems.push(...r.problems); warnings.push(...r.warnings); info.push(...r.info);
    // scripts:check counted a script as "checked" once it got past the byte / schema / master.db stops
    if (!r.problems.some(p => /: (no script file under|file contains CR|not valid JSON|schema — |no such card in master\.db)/.test(p))) ok++;
  }
  return { ok, problems, warnings, info };
}
