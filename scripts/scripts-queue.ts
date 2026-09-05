// Build the batch files a script wave is fanned out over (plan 2.8). Derive every card's state from files, drop the
// ones no author should see, group by the rarest family the card touches, sub-group by card type, order by EDHREC
// rank, and write batches of at most `--size` cards.
//
//   npm run scripts:queue -- --wave 10.0 --select "decks:owner"
//   npm run scripts:queue -- --wave 10.1 --select "edhrec<=5000 commander:legal pool:paper" --only-unlocked --size 30
//   npm run scripts:queue -- --wave 10.2 --select "pool:paper" --out data/scripts/batches/10.2 --limit 3000
//
// Selection terms (space separated, all must hold):
//   decks:owner        the distinct cards of every decks/*.csv and decks/*.txt (read the way src/sim/deckRef.ts does)
//   pool:<tier>        paper (default) | digital | un | ante | all — src/cards/pool.ts
//   commander:legal    master.db's `legalities` table, format 'commander', status 'legal'
//   edhrec<=N / >=N    printing_meta.edhrec_rank of the card's representative printing (unranked cards fail both)
//
// Options: --only-unlocked (drop cards whose blocked note still names a family that does not exist)
//          --size 30, --limit N (cap the cards queued), --out <dir>, --created-at <iso> (or MTG_QUEUE_NOW).
//
// Output per wave directory: `<NNN>.json` (the author's batch), `<NNN>.blind.json` (the same cards with the parser
// draft, the example scripts and the vocabulary excerpt REMOVED — what a blind scenario author receives, plus the
// card's rulings) and `manifest.json`. Nothing in a file name depends on the clock, and `createdAt` is overridable,
// so two runs on the same tree produce byte-identical output.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { CardDB, parseDeckList } from '../src/cards/db.js';
import { parseCollectionText } from '../src/collection/formats.js';
import { projectRoot } from '../src/config/paths.js';
import { tierOf, type PoolTier } from '../src/cards/pool.js';
import {
  defaultSources, emptyHistogram, poolRows, stateOf,
  type PoolRowDef, type ScriptState, type ScriptStateInfo,
} from '../src/cards/scriptState.js';
import { DEFAULT_SCRIPTS_DIR, normalizeOracleLine, oracleHash, ScriptStore, type CardScript } from '../src/cards/scripts.js';
import {
  addToHistogram, emptyFamilyHistogram, familiesOf, histogramRows, type Family, type TaxonomyResult,
} from '../src/cards/taxonomy.js';
import type { CardDef } from '../src/cards/types.js';
import { draftScript } from './scripts-draft.js';
import { dslCheatSheet, vocabularyExcerpt } from './vocab-doc.js';

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface Selection { ownerDecks: boolean; tier: PoolTier | 'all'; commanderLegal: boolean; edhrecMax?: number; edhrecMin?: number; raw: string }

/** Parse the `--select` mini-language. Unknown terms are an error, never silently ignored. */
export function parseSelection(text: string): Selection {
  const sel: Selection = { ownerDecks: false, tier: 'paper', commanderLegal: false, raw: text.trim() };
  for (const term of text.split(/[\s,]+/).filter(Boolean)) {
    let m: RegExpMatchArray | null;
    if (term === 'decks:owner') { sel.ownerDecks = true; continue; }
    if ((m = term.match(/^pool:(paper|digital|un|ante|all)$/))) { sel.tier = m[1] as PoolTier | 'all'; continue; }
    if (term === 'commander:legal') { sel.commanderLegal = true; continue; }
    if ((m = term.match(/^edhrec<=(\d+)$/))) { sel.edhrecMax = Number(m[1]); continue; }
    if ((m = term.match(/^edhrec>=(\d+)$/))) { sel.edhrecMin = Number(m[1]); continue; }
    throw new Error(`scripts:queue: unknown selection term ${JSON.stringify(term)} (decks:owner | pool:<tier> | commander:legal | edhrec<=N | edhrec>=N)`);
  }
  return sel;
}

/**
 * The distinct cards of every decks/*.csv and decks/*.txt. A CSV is a collection sheet and a .txt an Arena/plain
 * deck list, exactly as `src/sim/deckRef.ts` decides; the commander inference that file does only moves a card
 * between boards, so the DISTINCT set is the same and is not re-run here. Maybeboard entries are excluded.
 */
export function ownerDeckIds(db: CardDB, dir = path.join(projectRoot(), 'decks')): { ids: string[]; missing: string[] } {
  const names = new Set<string>();
  if (!fs.existsSync(dir)) return { ids: [], missing: [] };
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/\.(csv|txt)$/i.test(f)) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f.toLowerCase().endsWith('.csv')) for (const r of parseCollectionText(text, f).rows) names.add(r.name);
    else for (const c of parseDeckList(text, f).cards) if (c.board !== 'maybe') names.add(c.name);
  }
  const ids = new Set<string>(); const missing: string[] = [];
  for (const n of [...names].sort()) { const d = db.get(n); if (d) ids.add(d.oracleId); else missing.push(n); }
  return { ids: [...ids].sort(), missing };
}

// ---------------------------------------------------------------------------
// Card facts
// ---------------------------------------------------------------------------

export interface BatchCardFacts {
  oracleId: string;
  name: string;
  typeLine: string;
  /** "2/3" for a creature, null otherwise. */
  pt: string | null;
  loyalty: number | null;
  layout: string;
  /** Back face of a transform / modal DFC (the face `parse.ts` builds a `def.backFace` for). */
  backFace?: { name: string; typeLine: string; oracleText: string };
  /** Second half of a split / adventure / flip card — text no `CardDef` holds but a script must still claim. */
  secondFace?: { name: string; typeLine: string; oracleText: string };
  oracleText: string;
  oracleHash: string;
  unparsedLines: string[];
  scryfallKeywords: string[];
  families: Family[];
  primaryFamily: Family;
  edhrecRank: number | null;
  state: ScriptState;
  /** Why the card is in that state — the author sees whether they are starting fresh or fixing a rejection. */
  stateWhy: string;
  /** Op families the card's blocked note still waits for (empty for a clean card). */
  openNeeds: string[];
}

export interface BatchCard extends BatchCardFacts {
  /** The parser's own draft (scripts/scripts-draft.ts `draftScript`) — the author's starting point. */
  parserDraft: CardScript;
  /** Up to three nearest JUDGED scripts by token-Jaccard over normalised clauses (empty until a wave is judged). */
  examples: { oracleId: string; name: string; similarity: number; script: CardScript }[];
}

/** The blind copy: the same facts with every AST removed, plus the card's rulings (plan Part 4). */
export interface BlindCard extends BatchCardFacts { rulings: { published_at: string; comment: string }[] }

const PT = (d: CardDef) => (d.power !== null || d.toughness !== null ? `${d.power ?? ''}/${d.toughness ?? ''}` : null);

/** The lines a script must claim, front face and back face (back-face lines carry the parser's `// ` marker). */
function unparsedLines(def: CardDef): string[] {
  const out = [...def.unparsed];
  for (const u of def.backFace?.unparsed ?? []) out.push('// ' + u);
  return out;
}

const SECOND_FACE_LAYOUTS = new Set(['split', 'adventure', 'flip']);

function facts(row: PoolRowDef, st: ScriptStateInfo, tax: TaxonomyResult, rank: number | null): BatchCardFacts {
  const def = row.def;
  const raw = row.raw as { keywords?: unknown; faces?: { name: string; type_line: string; oracle_text: string }[] };
  const f: BatchCardFacts = {
    oracleId: def.oracleId, name: def.name, typeLine: def.typeLine, pt: PT(def), loyalty: def.loyalty, layout: def.layout,
    oracleText: def.oracleText, oracleHash: oracleHash(def.oracleText), unparsedLines: unparsedLines(def),
    scryfallKeywords: Array.isArray(raw.keywords) ? (raw.keywords as string[]).map(String).sort() : [],
    families: tax.families, primaryFamily: tax.primary, edhrecRank: rank, state: st.state, stateWhy: st.why, openNeeds: st.openNeeds,
  };
  if (def.backFace) f.backFace = { name: def.backFace.name, typeLine: def.backFace.typeLine, oracleText: def.backFace.oracleText };
  const second = SECOND_FACE_LAYOUTS.has(def.layout) ? raw.faces?.[1] : undefined;
  if (second) f.secondFace = { name: second.name, typeLine: second.type_line, oracleText: second.oracle_text ?? '' };
  return f;
}

// ---------------------------------------------------------------------------
// Nearest judged scripts
// ---------------------------------------------------------------------------

/** Words of a card's normalised clauses, numbers and mana symbols folded, for a cheap similarity measure. */
export function clauseTokens(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    for (const w of normalizeOracleLine(l).toLowerCase().replace(/\{[^}]*\}/g, ' {} ').replace(/\d+/g, '#').split(/[^a-z#{}~+/-]+/)) {
      if (w.length > 1) out.add(w);
    }
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / (a.size + b.size - hit);
}

interface JudgedExample { oracleId: string; name: string; tokens: Set<string>; script: CardScript }

/** Every judged script in the store, with its clause tokens. Empty until a wave has been promoted. */
function judgedExamples(store: ScriptStore, sources: ReturnType<typeof defaultSources>): JudgedExample[] {
  const out: JudgedExample[] = [];
  for (const id of store.ids().sort()) {
    const script = store.get(id);
    if (!script) continue;
    let st: ScriptStateInfo;
    try { st = stateOf(id, { ...sources, script }); } catch { continue; }
    if (st.state !== 'judged' && st.state !== 'reviewed') continue;
    const lines = (script.abilities ?? []).map(a => a.text).filter((t): t is string => !!t);
    out.push({ oracleId: id, name: script.name, tokens: clauseTokens(lines), script });
  }
  return out;
}

function nearestJudged(tokens: Set<string>, pool: JudgedExample[], n = 3): BatchCard['examples'] {
  return pool
    .map(e => ({ oracleId: e.oracleId, name: e.name, similarity: +jaccard(tokens, e.tokens).toFixed(4), script: e.script }))
    .filter(e => e.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || (a.oracleId < b.oracleId ? -1 : 1))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** The card-type bucket a batch sub-groups by: Creature wins, then the first printed type. */
export function typeBucket(def: CardDef): string {
  return def.types.includes('Creature') ? 'Creature' : def.types[0] ?? 'Other';
}

interface Queued { row: PoolRowDef; state: ScriptStateInfo; tax: TaxonomyResult; rank: number | null; type: string }

/** The taxonomy's view of one row: the unparsed lines of both faces plus Scryfall's own keyword list. */
function taxDefOf(row: PoolRowDef) {
  const kw = (row.raw as { keywords?: unknown }).keywords;
  return { unparsed: row.def.unparsed, backFace: row.def.backFace ?? null, scryfallKeywords: Array.isArray(kw) ? (kw as unknown[]).map(String) : [] };
}

/** Order inside a family: card type (alphabetical), then EDHREC rank (unranked last), then name, then id. */
function queueOrder(a: Queued, b: Queued): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const ar = a.rank ?? Number.MAX_SAFE_INTEGER, br = b.rank ?? Number.MAX_SAFE_INTEGER;
  if (ar !== br) return ar - br;
  if (a.row.def.name !== b.row.def.name) return a.row.def.name < b.row.def.name ? -1 : 1;
  return a.row.def.oracleId < b.row.def.oracleId ? -1 : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const flag = (k: string) => args.includes(k);

  const wave = opt('--wave') ?? '';
  if (!wave) { console.error('scripts:queue: --wave <name> is required (e.g. --wave 10.0)'); process.exit(1); }
  const select = opt('--select') ?? 'pool:paper';
  const size = Math.max(1, Number(opt('--size') ?? '30'));
  const limit = opt('--limit') ? Number(opt('--limit')) : Infinity;
  const onlyUnlocked = flag('--only-unlocked');
  const outDir = path.resolve(opt('--out') ?? path.join(DEFAULT_SCRIPTS_DIR(), 'batches', wave));
  const createdAt = opt('--created-at') ?? process.env.MTG_QUEUE_NOW ?? new Date().toISOString();

  const sel = parseSelection(select);
  const db = CardDB.shared();
  const store = new ScriptStore();
  const sources = defaultSources({ scripts: store, judges: wave === '10.0' || sel.ownerDecks ? 2 : 1 });

  // legality and EDHREC rank, preloaded: one query each beats 34,513 point lookups
  const commanderLegal = new Set<string>(
    (db.db.prepare("SELECT oracle_id FROM legalities WHERE format = 'commander' AND status = 'legal'").all() as { oracle_id: string }[]).map(r => r.oracle_id),
  );
  const edhrec = new Map<string, number>();
  for (const r of db.db.prepare('SELECT o.oracle_id AS id, m.edhrec_rank AS rank FROM oracle_cards o JOIN printing_meta m ON m.printing_id = o.representative_id WHERE m.edhrec_rank IS NOT NULL').all() as { id: string; rank: number }[]) {
    edhrec.set(r.id, r.rank);
  }

  let ids: string[] | undefined;
  let missingDeckNames: string[] = [];
  if (sel.ownerDecks) { const o = ownerDeckIds(db); ids = o.ids; missingDeckNames = o.missing; }

  const histogram = emptyHistogram();
  const famHist = emptyFamilyHistogram();
  const queued: Queued[] = [];
  let considered = 0, droppedState = 0, droppedSelect = 0, droppedNeeds = 0;

  for (const row of poolRows({ ids })) {
    considered++;
    const tier = tierOf(row.raw as Parameters<typeof tierOf>[0]);
    const rank = edhrec.get(row.def.oracleId) ?? null;
    if (sel.tier !== 'all' && tier !== sel.tier) { droppedSelect++; continue; }
    if (sel.commanderLegal && !commanderLegal.has(row.def.oracleId)) { droppedSelect++; continue; }
    if (sel.edhrecMax !== undefined && (rank === null || rank > sel.edhrecMax)) { droppedSelect++; continue; }
    if (sel.edhrecMin !== undefined && (rank === null || rank < sel.edhrecMin)) { droppedSelect++; continue; }
    const state = stateOf(row.def.oracleId, { ...sources, def: row.def });
    histogram[state.state]++;
    if (!(state.state === 'todo' || state.state === 'scripted' || state.state === 'verified' || state.state === 'tested' || state.state === 'stale')) { droppedState++; continue; }
    if (onlyUnlocked && state.openNeeds.length) { droppedNeeds++; continue; }
    const tax = familiesOf(taxDefOf(row));
    addToHistogram(famHist, tax);
    queued.push({ row, state, tax, rank, type: typeBucket(row.def) });
  }

  // primary family, re-decided against the MEASURED rarity of this selection (the rarest family a card touches wins)
  const freq = new Map<string, number>(famHist.cards);
  for (const q of queued) {
    q.tax = familiesOf(taxDefOf(q.row), { frequencies: freq });
  }

  // Families ordered rarest first, so the exotic work is authored while the wave is fresh; cards of one family stay
  // ADJACENT and the wave is cut into batches of `size` afterwards. Chunking after the sort rather than per family is
  // what keeps a wave at the plan's batch count — per-family chunking gives a two-card batch for every rare keyword.
  const byFamily = new Map<Family, Queued[]>();
  for (const q of queued) { const k = q.tax.primary; (byFamily.get(k) ?? byFamily.set(k, []).get(k)!).push(q); }
  const families = [...byFamily.keys()].sort((a, b) => (byFamily.get(a)!.length - byFamily.get(b)!.length) || (a < b ? -1 : 1));
  const ordered: Queued[] = [];
  for (const fam of families) for (const q of byFamily.get(fam)!.sort(queueOrder)) ordered.push(q);

  const examples = judgedExamples(store, sources);
  const cheatSheet = dslCheatSheet();

  fs.mkdirSync(outDir, { recursive: true });
  const written: { batch: string; file: string; family: string; families: Family[]; cards: number; types: string[] }[] = [];
  const capped = Number.isFinite(limit) ? ordered.slice(0, limit) : ordered;
  for (let i = 0; i < capped.length; i += size) {
    const slice = capped.slice(i, i + size);
    const id = String(written.length + 1).padStart(3, '0');
    const fams = [...new Set(slice.map(q => q.tax.primary))];
    // a readable label; the full list stays in `families` (a wave's tail can span twenty singleton keywords)
    const family = fams.length === 1 ? fams[0] : `mixed (${fams.slice(0, 3).join(', ')}${fams.length > 3 ? `, +${fams.length - 3} more` : ''})`;
    const manifest = { wave, batch: id, family, createdAt };
    const full = {
      manifest,
      cards: slice.map(q => {
        const f = facts(q.row, q.state, q.tax, q.rank);
        return { ...f, parserDraft: draftScript(q.row.def), examples: nearestJudged(clauseTokens(f.unparsedLines), examples) } satisfies BatchCard;
      }),
      vocabulary: [...new Set(fams.map(f => vocabularyExcerpt(f)))].join('\n\n'),
      dsl: cheatSheet,
    };
    const blind = {
      manifest,
      cards: slice.map(q => ({ ...facts(q.row, q.state, q.tax, q.rank), rulings: db.rulings(q.row.def.oracleId).slice(0, 6) } satisfies BlindCard)),
      dsl: cheatSheet,
    };
    writeJson(path.join(outDir, `${id}.json`), full);
    writeJson(path.join(outDir, `${id}.blind.json`), blind);
    written.push({ batch: id, file: path.join(outDir, `${id}.json`), family, families: fams, cards: slice.length, types: [...new Set(slice.map(s => s.type))].sort() });
  }

  const manifest = {
    wave, createdAt, selection: sel.raw, size, onlyUnlocked,
    counts: { considered, queued: written.reduce((a, b) => a + b.cards, 0), batches: written.length, droppedByState: droppedState, droppedBySelection: droppedSelect, droppedByOpenNeeds: droppedNeeds },
    states: histogram,
    families: histogramRows(famHist),
    batches: written.map(w => ({ batch: w.batch, file: repoPath(w.file), family: w.family, families: w.families, cards: w.cards, types: w.types })),
    ...(missingDeckNames.length ? { deckNamesNotInMasterDb: missingDeckNames } : {}),
  };
  writeJson(path.join(outDir, 'manifest.json'), manifest);

  console.log(`wave ${wave}: ${manifest.counts.queued} card(s) in ${written.length} batch(es) of <= ${size} -> ${repoPath(outDir)}`);
  console.log(`  considered ${considered}; dropped ${droppedSelect} by selection, ${droppedState} by state${onlyUnlocked ? `, ${droppedNeeds} with open needs` : ''}`);
  console.log('  states: ' + Object.entries(histogram).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('  families: ' + histogramRows(famHist).slice(0, 8).map(r => `${r.family} ${r.cards}`).join(', '));
  if (missingDeckNames.length) console.log(`  WARN ${missingDeckNames.length} deck name(s) not in master.db: ${missingDeckNames.slice(0, 5).join(', ')}`);
  db.close();
}

/** LF only, trailing newline — the same bytes `scripts:check` demands of a script. */
function writeJson(file: string, value: unknown) { fs.writeFileSync(file, JSON.stringify(value, null, 2).replace(/\r\n/g, '\n') + '\n'); }

/** A repo-relative POSIX path, or the absolute one when `--out` points outside the checkout (a scratch directory). */
function repoPath(file: string): string {
  const rel = path.relative(projectRoot(), file).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : file.split(path.sep).join('/');
}

// run only as a CLI: the tests import `parseSelection` / `ownerDeckIds` / `jaccard` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
