// forge:diff — Forge's card scripts as a cross-check oracle (docs/plans/forge-oracle.md): the structural facts of
// every card on this side (the trigger event, targets and "up to", "you may", "unless … pays", tokens, literal
// magnitudes, modes, keywords) against the same facts read off Forge's script for the card, one finding per
// disagreement. A finding is a claim to verify against the printed text, never a verdict.
//
//   npm run forge:diff -- --tier paper --claimed --out data/master/forge-diff.json --md data/master/forge-diff.md   (calibration)
//   npm run forge:diff -- --scripted --md data/master/forge-scripted.md                                          (every scripted card)
//   npm run forge:diff -- --changed                                                                              (the per-merge gate)
//   npm run forge:diff -- --ids <a,b | @file> --scripted                                                         (a judge's batch)
//
// Options: --tier paper|digital|un|ante|all (default paper), --select "<terms>" (scripts-queue's mini-language),
//          --ids <a,b | @file>, --claimed (only cards the PARSER ALONE fully parses — the calibration set),
//          --scripted (only cards with a fresh script, compared on the SCRIPTED def through CardDB),
//          --changed (only cards whose parser-alone hash differs from data/master/parse-snapshot.json — computed
//          in-process the way parse:diff does; `--snapshot <file>` points it at another snapshot), --category <a,b>,
//          --top N (examples per category in the markdown, default 5), --out <json>, --md <markdown>.
// Parser-alone is the default mode (`useBareParses` as scripts/parse-snapshot.ts does): no script is applied unless
// `--scripted`. No timestamp anywhere: two runs on the same tree and checkout produce identical bytes.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { CardDB } from '../src/cards/db.js';
import { forgeCardFor, loadForge, type ForgeCard, type ForgeIndex } from '../src/cards/forge/loader.js';
import { CATEGORIES, compareCard, type Category, type Finding } from '../src/cards/forge/compare.js';
import { forgeShapes, ourShapes, type AbilityShape } from '../src/cards/forge/shape.js';
import { tierOf, type PoolTier } from '../src/cards/pool.js';
import { PLAYABLE_SQL, poolRows, useCardDb } from '../src/cards/scriptState.js';
import { ScriptStore, secondFaceLines, useScriptStore, type CardScript } from '../src/cards/scripts.js';
import type { CardDef } from '../src/cards/types.js';
import { projectRoot } from '../src/config/paths.js';
import { parseSelection, selected, selectionIndex } from './scripts-queue.js';

// ---------------------------------------------------------------------------
// The parser-alone hash, as scripts/parse-snapshot.ts computes it
// ---------------------------------------------------------------------------

// scripts/parse-snapshot.ts runs as a CLI on import, so its `canonical` / `hashDef` cannot be imported: this is the
// same computation (OMIT, key order, fnv-1a, 8 hex chars); test/forge-loader.test.ts pins the copy against the
// committed snapshot so the two cannot drift.
const OMIT = new Set(['imageUri', 'faceImageUris', 'representativePrintingId', 'script']);
function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => !OMIT.has(k) && o[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}
/** fnv-1a over the canonical JSON of a parser-alone def — byte-identical to parse-snapshot.ts's `hashDef`. */
export function snapshotHash(def: CardDef): string {
  const s = canonical(def);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The ids whose parser-alone hash differs from the snapshot (a card new to the pool counts as changed). */
export function changedIds(hashes: ReadonlyMap<string, string>, snapshot: { cards: Record<string, string> }): string[] {
  return [...hashes.keys()].filter(id => snapshot.cards[id] !== hashes.get(id)).sort();
}

/** The `.no-scripts` sentinel store, as parse-snapshot.ts installs it: `applyScript` then never runs. */
function useBareParses(): void {
  const empty = new ScriptStore(path.join(projectRoot(), 'data', 'master', '.no-scripts'));
  if (empty.size() !== 0) throw new Error(`forge-diff: ${empty.dir} must not exist — it is the "no scripts" sentinel directory`);
  useScriptStore(empty);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type CardStatus = 'agree' | 'disagree' | 'no-forge-file';
export interface CardRow { oracleId: string; name: string; status: CardStatus; findings: Finding[] }
export interface Report {
  forge: { head: string; files: number };
  mode: 'parser-alone' | 'claimed' | 'scripted' | 'changed';
  totals: { cards: number; withForgeFile: number; agree: number; disagree: number; skippedSecondFace: number };
  byCategory: Record<string, { cards: number; findings: number; rate: number }>;
  cards: CardRow[];
}

/** data/master/forge-calibration.json: the labelled sample of the calibration run (F-7). */
export interface Calibration { forgeHead: string; sample: { oracleId: string; name: string; category: Category; label: 'parser-wrong' | 'forge-wrong' | 'encoding-difference'; reason: string }[]; precision: Record<string, { n: number; parserWrong: number }> }

const round = (n: number) => Math.round(n * 10000) / 10000;

export function buildReport(idx: ForgeIndex, mode: Report['mode'], rows: CardRow[], skippedSecondFace: number, categories: ReadonlySet<Category> | null): Report {
  const cards = rows.map(r => categories ? { ...r, findings: r.findings.filter(f => categories.has(f.category)), status: r.status === 'no-forge-file' ? r.status : (r.findings.some(f => categories.has(f.category)) ? 'disagree' : 'agree') as CardStatus } : r)
    .sort((a, b) => (a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0));
  const withForgeFile = cards.filter(c => c.status !== 'no-forge-file').length;
  const byCategory: Report['byCategory'] = {};
  for (const cat of CATEGORIES) {
    if (categories && !categories.has(cat)) continue;
    const hit = cards.filter(c => c.findings.some(f => f.category === cat));
    const findings = cards.reduce((n, c) => n + c.findings.filter(f => f.category === cat).length, 0);
    byCategory[cat] = { cards: hit.length, findings, rate: withForgeFile ? round(hit.length / withForgeFile) : 0 };
  }
  return {
    forge: { head: idx.head, files: idx.files }, mode,
    totals: { cards: cards.length, withForgeFile, agree: cards.filter(c => c.status === 'agree').length, disagree: cards.filter(c => c.status === 'disagree').length, skippedSecondFace },
    byCategory, cards,
  };
}

export function totalsLine(r: Report, seconds?: number): string {
  const t = r.totals;
  return `forge:diff — ${t.cards} cards (${r.mode}), ${t.withForgeFile} with a Forge file, ${t.agree} agree / ${t.disagree} disagree, ${t.skippedSecondFace} second face${t.skippedSecondFace === 1 ? '' : 's'} skipped; Forge ${r.forge.head.slice(0, 8)} (${r.forge.files} files)${seconds !== undefined ? ` (${seconds.toFixed(1)}s)` : ''}`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\n/g, ' ');

export function categoryTable(r: Report, cal: Calibration | null): string[] {
  const out = [cal ? '| category | cards | findings | rate | labelled precision |' : '| category | cards | findings | rate |', cal ? '|---|---:|---:|---:|---:|' : '|---|---:|---:|---:|'];
  for (const [cat, v] of Object.entries(r.byCategory)) {
    const p = cal?.precision[cat];
    const prec = !cal ? '' : p && p.n ? ` ${p.parserWrong}/${p.n} parser-wrong |` : ' — |';
    out.push(`| ${cat} | ${v.cards} | ${v.findings} | ${(v.rate * 100).toFixed(1)}% |${prec}`);
  }
  return out;
}

export function markdown(r: Report, cal: Calibration | null, top: number): string {
  const out: string[] = ['# forge:diff — the Forge cross-check', ''];
  out.push(totalsLine(r), '');
  out.push('A finding is a claim to verify against the printed text, never a verdict: Forge is sometimes wrong and its encoding is sometimes just different. Rate = cards with a finding of the category over the cards with a Forge file.' + (cal ? ` Labelled precision = the calibration sample (data/master/forge-calibration.json, Forge ${cal.forgeHead.slice(0, 8)}): how many of the labelled findings were the parser's fault.` : ''), '');
  out.push(...categoryTable(r, cal), '');
  for (const cat of Object.keys(r.byCategory)) {
    const rows = r.cards.flatMap(c => c.findings.filter(f => f.category === cat).map(f => ({ c, f }))).slice(0, top);
    if (!rows.length) continue;
    out.push(`## ${cat}`, '');
    for (const { c, f } of rows) out.push(`- ${cell(c.name)} — ours: ${cell(f.ours)} / forge: ${cell(f.forge)} (${cell(f.ability)})`);
    out.push('');
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// One card
// ---------------------------------------------------------------------------

const SECOND_FACE_MODES = new Set(['Split', 'Adventure', 'Flip', 'Omen', 'Prepare', 'Specialize']);

/**
 * The Forge shapes to compare a def against: the front face, plus the alternate face when our side has it — the
 * `backFace` of a DFC always, the second face of a split / adventure / flip card only when a script's `secondFace`
 * is given (otherwise it is skipped on both sides and counted).
 */
export function forgeShapesFor(card: ForgeCard, def: CardDef, secondFace: boolean): { shapes: AbilityShape[]; skippedSecondFace: boolean } {
  // a name that is one of the file's OTHER faces (a meld result, a card indexed by its back-face name) is that face alone
  const own = card.faces.findIndex(f => f.name === def.name);
  if (own > 0) return { shapes: forgeShapes(card.faces[own]), skippedSecondFace: false };
  const shapes = forgeShapes(card.faces[0]);
  const alt = card.faces[1];
  if (!alt) return { shapes, skippedSecondFace: false };
  const mode = card.faces[0].alternateMode ?? '';
  if (def.backFace && !SECOND_FACE_MODES.has(mode)) return { shapes: [...shapes, ...forgeShapes(alt)], skippedSecondFace: false };
  if (secondFace) return { shapes: [...shapes, ...forgeShapes(alt)], skippedSecondFace: false };
  return { shapes, skippedSecondFace: !def.backFace };
}

export function compareDef(idx: ForgeIndex, def: CardDef, script: CardScript | null, fullyParsed: boolean): { row: CardRow; skippedSecondFace: boolean } {
  const card = forgeCardFor(idx, def.name);
  if (!card) return { row: { oracleId: def.oracleId, name: def.name, status: 'no-forge-file', findings: [] }, skippedSecondFace: false };
  const second = script?.secondFace && secondFaceLines(def).length ? script.secondFace : null;
  const forge = forgeShapesFor(card, def, !!second);
  const res = compareCard(ourShapes(def, second), forge.shapes, { fullyParsed });
  return { row: { oracleId: def.oracleId, name: def.name, status: res.status, findings: res.findings }, skippedSecondFace: forge.skippedSecondFace };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const has = (k: string) => args.includes(k);
  const select = opt('--select');
  const tierArg = opt('--tier') as PoolTier | 'all' | undefined;
  const idsArg = opt('--ids');
  // an explicit id list is compared whatever its tier unless --tier / --select narrows it (a judge's batch may hold any card)
  const selection = parseSelection(select ?? `pool:${tierArg ?? (idsArg ? 'all' : 'paper')}`);
  if (tierArg) selection.tier = tierArg;
  const only = idsArg ? new Set((idsArg.startsWith('@') ? fs.readFileSync(idsArg.slice(1), 'utf8') : idsArg).split(/[\s,]+/).filter(Boolean)) : null;
  const scripted = has('--scripted'), claimed = has('--claimed'), changed = has('--changed');
  if ([scripted, claimed, changed].filter(Boolean).length > 1) throw new Error('forge-diff: --claimed, --scripted and --changed are exclusive');
  const mode: Report['mode'] = scripted ? 'scripted' : claimed ? 'claimed' : changed ? 'changed' : 'parser-alone';
  const catArg = opt('--category');
  const categories = catArg ? new Set(catArg.split(/[\s,]+/).filter(Boolean).map(c => { if (!(CATEGORIES as readonly string[]).includes(c)) throw new Error(`forge-diff: unknown category ${c} (${CATEGORIES.join(', ')})`); return c as Category; })) : null;
  const top = Math.max(1, Number(opt('--top') ?? '5'));
  const outFile = opt('--out'), mdFile = opt('--md');
  const snapshotFile = opt('--snapshot') ?? path.join(projectRoot(), 'data', 'master', 'parse-snapshot.json');

  const t0 = Date.now();
  const db = CardDB.shared();
  useCardDb(db);
  const idx = selectionIndex(db);
  // the selection is decided on the raw row (no parse), like parse:why
  const ids: string[] = [];
  for (const r of db.db.prepare(`SELECT oracle_id AS id, json FROM oracle_cards WHERE ${PLAYABLE_SQL}`).iterate() as Iterable<{ id: string; json: string }>) {
    if (only && !only.has(r.id)) continue;
    if (!selected(selection, idx, r.id, tierOf(JSON.parse(r.json) as Parameters<typeof tierOf>[0]))) continue;
    ids.push(r.id);
  }
  ids.sort();

  const rows: CardRow[] = [];
  let skipped = 0;
  const store = new ScriptStore();
  let forge: ForgeIndex | null = null;
  const forgeIndex = () => (forge ??= loadForge());
  if (scripted) {
    // the SCRIPTED def through CardDB (the shared script store applies fresh scripts); stale scripts are skipped
    const scriptedIds = new Set(store.ids());
    for (const id of ids) {
      if (!scriptedIds.has(id)) continue;
      const def = db.getByOracleId(id);
      if (!def || !def.script?.applied) continue;
      const r = compareDef(forgeIndex(), def, store.get(id), true);
      rows.push(r.row); if (r.skippedSecondFace) skipped++;
    }
  } else {
    useBareParses();
    let wanted: Set<string> | null = null;
    if (changed) {
      if (!fs.existsSync(snapshotFile)) { console.error(`forge:diff — no snapshot at ${path.relative(process.cwd(), snapshotFile)}. Run: npm run parse:accept`); process.exit(1); }
      const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as { cards: Record<string, string> };
      const hashes = new Map<string, string>();
      for (const row of poolRows()) hashes.set(row.def.oracleId, snapshotHash(row.def));
      const inPool = new Set(ids);
      wanted = new Set(changedIds(hashes, snap).filter(id => inPool.has(id)));
      if (!wanted.size) { console.log('forge:diff — 0 changed cards'); db.close(); process.exit(0); }
    }
    for (const row of poolRows({ ids: wanted ? ids.filter(id => wanted!.has(id)) : ids })) {
      const def = row.def;
      if (claimed && !def.fullyParsed) continue;
      const r = compareDef(forgeIndex(), def, null, def.fullyParsed);
      rows.push(r.row); if (r.skippedSecondFace) skipped++;
    }
  }
  db.close();
  const report = buildReport(forgeIndex(), mode, rows, skipped, categories);
  const calFile = path.join(projectRoot(), 'data', 'master', 'forge-calibration.json');
  const cal = fs.existsSync(calFile) ? JSON.parse(fs.readFileSync(calFile, 'utf8')) as Calibration : null;
  if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n'); }
  if (mdFile) { fs.mkdirSync(path.dirname(mdFile), { recursive: true }); fs.writeFileSync(mdFile, markdown(report, cal, top)); }
  console.log(totalsLine(report, (Date.now() - t0) / 1000) + (outFile ? ` -> ${outFile}` : ''));
  for (const line of categoryTable(report, cal)) console.log('  ' + line);
}

// run only as a CLI: the tests import `snapshotHash` / `changedIds` / `buildReport` / `markdown` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
