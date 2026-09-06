// Build the batch files a script wave is fanned out over (plan 2.8). Derive every card's state from files, drop the
// ones no author should see, group by the rarest family the card touches, sub-group by card type, order by EDHREC
// rank, and pack whole families into batches of at most `--size` cards.
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
//          --size 30, --max-families 8, --limit N (cap the cards queued), --out <dir>,
//          --created-at <iso> (or MTG_QUEUE_NOW).
//
// Output per wave directory: `<NNN>.json` (the author's batch), `<NNN>.blind.json` (the same cards with the parser
// draft, the example scripts and the vocabulary excerpt REMOVED — what a blind scenario author receives, plus the
// card's rulings) and `manifest.json`. Nothing in a file name depends on the clock, and `createdAt` is overridable,
// so two runs on the same tree produce byte-identical output. `buildWave` below is the whole tool: `main` only
// writes what it returns, which is what lets `test/scripts-queue-output.test.ts` gate the batch shapes themselves.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { CardDB } from '../src/cards/db.js';
import { projectRoot } from '../src/config/paths.js';
import { tierOf, type PoolTier } from '../src/cards/pool.js';
import {
  defaultSources, emptyHistogram, poolRows, SCRIPT_STATE_TABLE, stateOf,
  type PoolRowDef, type ScriptState, type ScriptStateInfo, type StateSources,
} from '../src/cards/scriptState.js';
import { ownerDeckIds } from '../src/cards/waveScope.js';
import { DEFAULT_SCRIPTS_DIR, normalizeOracleLine, oracleHash, ScriptStore, type CardScript } from '../src/cards/scripts.js';
import {
  addToHistogram, emptyFamilyHistogram, familiesOf, histogramRows, type Family, type TaxonomyResult,
} from '../src/cards/taxonomy.js';
import type { CardDef } from '../src/cards/types.js';
import { draftScript } from './scripts-draft.js';
import { dslCheatSheet, vocabularyFor } from './vocab-doc.js';

/** `decks:owner` lives in src/cards/waveScope.ts now (the judge rule needs it too); re-exported for the CLIs. */
export { ownerDeckIds } from '../src/cards/waveScope.js';

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

/** The per-card facts a selection reads, preloaded: one query each beats 34,513 point lookups. */
export interface SelectionIndex { commanderLegal: Set<string>; edhrec: Map<string, number> }

export function selectionIndex(db: CardDB): SelectionIndex {
  const commanderLegal = new Set<string>(
    (db.db.prepare("SELECT oracle_id FROM legalities WHERE format = 'commander' AND status = 'legal'").all() as { oracle_id: string }[]).map(r => r.oracle_id),
  );
  const edhrec = new Map<string, number>();
  for (const r of db.db.prepare('SELECT o.oracle_id AS id, m.edhrec_rank AS rank FROM oracle_cards o JOIN printing_meta m ON m.printing_id = o.representative_id WHERE m.edhrec_rank IS NOT NULL').all() as { id: string; rank: number }[]) {
    edhrec.set(r.id, r.rank);
  }
  return { commanderLegal, edhrec };
}

/** Does the card pass every term of the selection? `tier` is `tierOf(row.raw)`; an unranked card fails both EDHREC terms. */
export function selected(sel: Selection, idx: SelectionIndex, id: string, tier: PoolTier): boolean {
  if (sel.tier !== 'all' && tier !== sel.tier) return false;
  if (sel.commanderLegal && !idx.commanderLegal.has(id)) return false;
  const rank = idx.edhrec.get(id) ?? null;
  if (sel.edhrecMax !== undefined && (rank === null || rank > sel.edhrecMax)) return false;
  if (sel.edhrecMin !== undefined && (rank === null || rank < sel.edhrecMin)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Card facts
// ---------------------------------------------------------------------------

export interface BatchCardFacts {
  oracleId: string;
  name: string;
  typeLine: string;
  /** The printed mana cost ("{1}{R}"), null for a land — the blind scenario author needs it to seed the right lands. */
  manaCost: string | null;
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

/** Keys a BLIND card must never carry: they would show the scenario author the very AST they are testing blind. */
export const BLIND_FORBIDDEN_KEYS = ['parserDraft', 'examples', 'script', 'abilities', 'vocabulary'] as const;

const PT = (d: CardDef) => (d.power !== null || d.toughness !== null ? `${d.power ?? ''}/${d.toughness ?? ''}` : null);

/**
 * The lines a script must claim, front face and back face (back-face lines carry the parser's `// ` marker).
 *
 * `parse.ts` ALREADY appends the back face's unparsed lines to `def.unparsed`, prefixed with `// `, for modal_dfc
 * and transform layouts. Appending them again here printed every back-face line TWICE in both the author batch and
 * the blind batch; an author who claims each printed line once then wrote two abilities for one line, which
 * `scripts:check`'s face accounting rejects. `familiesOf` has always deduped the same way.
 */
export function unparsedLines(def: Pick<CardDef, 'unparsed' | 'backFace'>): string[] {
  const out = [...def.unparsed];
  for (const u of def.backFace?.unparsed ?? []) { const line = '// ' + u; if (!out.includes(line)) out.push(line); }
  return out;
}

const SECOND_FACE_LAYOUTS = new Set(['split', 'adventure', 'flip']);

function facts(row: PoolRowDef, st: ScriptStateInfo, tax: TaxonomyResult, rank: number | null): BatchCardFacts {
  const def = row.def;
  const raw = row.raw as { keywords?: unknown; faces?: { name: string; type_line: string; oracle_text: string }[] };
  const f: BatchCardFacts = {
    oracleId: def.oracleId, name: def.name, typeLine: def.typeLine, manaCost: def.manaCost?.raw ?? null, pt: PT(def), loyalty: def.loyalty, layout: def.layout,
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

/** Every judged (or human-reviewed) script in the store, with its clause tokens. Empty until a wave is promoted. */
function judgedExamples(store: ScriptStore, sources: StateSources): JudgedExample[] {
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

export interface Queued { row: PoolRowDef; state: ScriptStateInfo; tax: TaxonomyResult; rank: number | null; type: string }

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

/** How many distinct families one batch may mix before a new batch is started (`--max-families`). */
export const DEFAULT_MAX_FAMILIES = 8;

/**
 * Pack whole families into batches. `groups` arrives rarest-family-first; a family is never split across two
 * batches unless it is bigger than `size` (then it fills batches of its own), and a batch mixes at most
 * `maxFamilies` of them.
 *
 * The first cut of 8k concatenated every family and cut the wave into `size`-sized slices AFTERWARDS, which swept
 * every singleton family into batch 001 — twenty unrelated cards in the one batch, the opposite of taxonomy.ts's
 * stated intent ("an author sees thirty cards that need the same thinking").
 */
export function packFamilies<T>(groups: { family: Family; cards: T[] }[], size: number, maxFamilies = DEFAULT_MAX_FAMILIES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let curFamilies = 0;
  const flush = () => { if (cur.length) { out.push(cur); cur = []; curFamilies = 0; } };
  for (const g of groups) {
    if (!g.cards.length) continue;
    if (g.cards.length >= size) {                       // big enough for batches of its own
      flush();
      for (let i = 0; i < g.cards.length; i += size) out.push(g.cards.slice(i, i + size));
      continue;
    }
    if (cur.length + g.cards.length > size || curFamilies >= maxFamilies) flush();
    cur.push(...g.cards);
    curFamilies++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// buildWave — everything the CLI does except writing files
// ---------------------------------------------------------------------------

export interface WaveOptions {
  wave: string;
  selection: Selection;
  db: CardDB;
  /** Where the files WOULD be written; only the manifest's `file` paths depend on it. */
  outDir: string;
  size?: number;
  maxFamilies?: number;
  limit?: number;
  onlyUnlocked?: boolean;
  createdAt?: string;
  /** Overrides for the file sources every state is derived from (the tests point these at a temp tree). */
  sources?: Partial<StateSources>;
  /** Restrict the pool to these ids (the tests do; the CLI never does). */
  ids?: string[];
}

export interface BuiltBatch {
  batch: string;
  file: string;
  family: string;
  families: Family[];
  cards: number;
  types: string[];
  /** What `<NNN>.json` holds. */
  full: { manifest: { wave: string; batch: string; family: string; createdAt: string }; cards: BatchCard[]; vocabulary: string; dsl: string };
  /** What `<NNN>.blind.json` holds — no AST, no examples, no vocabulary. */
  blind: { manifest: { wave: string; batch: string; family: string; createdAt: string }; cards: BlindCard[]; dsl: string };
}

export interface BuiltWave {
  batches: BuiltBatch[];
  manifest: Record<string, unknown>;
  states: Record<ScriptState, number>;
  /** Scripts that claim `source: 'hand' | 'reviewed'` with no review note under data/scripts/reviewed/. */
  unearnedHumanSource: { oracleId: string; name: string }[];
  missingDeckNames: string[];
}

export function buildWave(opts: WaveOptions): BuiltWave {
  const { wave, selection: sel, db, outDir } = opts;
  const size = Math.max(1, opts.size ?? 30);
  const maxFamilies = Math.max(1, opts.maxFamilies ?? DEFAULT_MAX_FAMILIES);
  const limit = opts.limit ?? Infinity;
  const onlyUnlocked = !!opts.onlyUnlocked;
  const createdAt = opts.createdAt ?? new Date().toISOString();

  const store = opts.sources?.scripts ?? new ScriptStore();
  // `judges` is deliberately NOT set here: `defaultSources` installs the per-CARD rule (two judges for the owner's
  // decks, one elsewhere — process rule 5), so the queue and every other reader agree card by card.
  const sources = defaultSources({ ...opts.sources, scripts: store });

  // legality and EDHREC rank, preloaded (shared with scripts/parse-why.ts, which selects the same way)
  const idx = selectionIndex(db);

  let ids: string[] | undefined = opts.ids;
  let missingDeckNames: string[] = [];
  if (sel.ownerDecks && !ids) { const o = ownerDeckIds(db); ids = o.ids; missingDeckNames = o.missing; }

  const histogram = emptyHistogram();
  const famHist = emptyFamilyHistogram();
  const queued: Queued[] = [];
  const unearned: { oracleId: string; name: string }[] = [];
  let considered = 0, droppedState = 0, droppedSelect = 0, droppedNeeds = 0;

  for (const row of poolRows({ ids })) {
    considered++;
    const tier = tierOf(row.raw as Parameters<typeof tierOf>[0]);
    const rank = idx.edhrec.get(row.def.oracleId) ?? null;
    if (!selected(sel, idx, row.def.oracleId, tier)) { droppedSelect++; continue; }
    const state = stateOf(row.def.oracleId, { ...sources, def: row.def });
    histogram[state.state]++;
    if (state.unearnedHumanSource) unearned.push({ oracleId: state.oracleId, name: state.name });
    // plan 2.8: judged / reviewed / blocked / parsed are never re-issued — the table in scriptState.ts decides,
    // so a state that stops being queueable there stops being queued here
    if (!SCRIPT_STATE_TABLE[state.state].queueable) { droppedState++; continue; }
    if (onlyUnlocked && state.openNeeds.length) { droppedNeeds++; continue; }
    const tax = familiesOf(taxDefOf(row));
    addToHistogram(famHist, tax);
    queued.push({ row, state, tax, rank, type: typeBucket(row.def) });
  }

  // primary family, re-decided against the MEASURED rarity of this selection (the rarest family a card touches wins)
  const freq = new Map<string, number>(famHist.cards);
  for (const q of queued) q.tax = familiesOf(taxDefOf(q.row), { frequencies: freq });

  // Families ordered rarest first, so the exotic work is authored while the wave is fresh, and packed whole.
  const byFamily = new Map<Family, Queued[]>();
  for (const q of queued) { const k = q.tax.primary; (byFamily.get(k) ?? byFamily.set(k, []).get(k)!).push(q); }
  const groups = [...byFamily.keys()]
    .sort((a, b) => (byFamily.get(a)!.length - byFamily.get(b)!.length) || (a < b ? -1 : 1))
    .map(family => ({ family, cards: byFamily.get(family)!.sort(queueOrder) }));

  // `--limit` caps the CARDS queued, family by family, before anything is packed
  let left = limit;
  const capped: typeof groups = [];
  for (const g of groups) {
    if (left <= 0) break;
    capped.push(g.cards.length <= left ? g : { family: g.family, cards: g.cards.slice(0, left) });
    left -= Math.min(left, g.cards.length);
  }

  const examples = judgedExamples(store, sources);
  const cheatSheet = dslCheatSheet();
  const batches: BuiltBatch[] = [];
  for (const slice of packFamilies(capped, size, maxFamilies)) {
    const id = String(batches.length + 1).padStart(3, '0');
    const fams = [...new Set(slice.map(q => q.tax.primary))];
    // a readable label; the full list stays in `families`
    const family = fams.length === 1 ? fams[0] : `mixed (${fams.slice(0, 3).join(', ')}${fams.length > 3 ? `, +${fams.length - 3} more` : ''})`;
    const manifest = { wave, batch: id, family, createdAt };
    batches.push({
      batch: id,
      file: path.join(outDir, `${id}.json`),
      family,
      families: fams,
      cards: slice.length,
      types: [...new Set(slice.map(s => s.type))].sort(),
      full: {
        manifest,
        cards: slice.map(q => {
          const f = facts(q.row, q.state, q.tax, q.rank);
          return { ...f, parserDraft: draftScript(q.row.def), examples: nearestJudged(clauseTokens(f.unparsedLines), examples) } satisfies BatchCard;
        }),
        // the core vocabulary ONCE plus a section per family this batch spans
        vocabulary: vocabularyFor(fams),
        dsl: cheatSheet,
      },
      blind: {
        manifest,
        cards: slice.map(q => ({ ...facts(q.row, q.state, q.tax, q.rank), rulings: db.rulings(q.row.def.oracleId).slice(0, 6) } satisfies BlindCard)),
        dsl: cheatSheet,
      },
    });
  }

  const manifest = {
    wave, createdAt, selection: sel.raw, size, maxFamilies, onlyUnlocked,
    counts: { considered, queued: batches.reduce((a, b) => a + b.cards, 0), batches: batches.length, droppedByState: droppedState, droppedBySelection: droppedSelect, droppedByOpenNeeds: droppedNeeds },
    states: histogram,
    families: histogramRows(famHist),
    batches: batches.map(w => ({ batch: w.batch, file: repoPath(w.file), family: w.family, families: w.families, cards: w.cards, types: w.types })),
    ...(unearned.length ? { unearnedHumanSource: unearned } : {}),
    ...(missingDeckNames.length ? { deckNamesNotInMasterDb: missingDeckNames } : {}),
  };

  return { batches, manifest, states: histogram, unearnedHumanSource: unearned, missingDeckNames };
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
  const outDir = path.resolve(opt('--out') ?? path.join(DEFAULT_SCRIPTS_DIR(), 'batches', wave));
  const db = CardDB.shared();

  const built = buildWave({
    wave,
    selection: parseSelection(select),
    db,
    outDir,
    size: Math.max(1, Number(opt('--size') ?? '30')),
    maxFamilies: Math.max(1, Number(opt('--max-families') ?? String(DEFAULT_MAX_FAMILIES))),
    limit: opt('--limit') ? Number(opt('--limit')) : Infinity,
    onlyUnlocked: flag('--only-unlocked'),
    createdAt: opt('--created-at') ?? process.env.MTG_QUEUE_NOW ?? new Date().toISOString(),
  });

  fs.mkdirSync(outDir, { recursive: true });
  for (const b of built.batches) {
    writeJson(path.join(outDir, `${b.batch}.json`), b.full);
    writeJson(path.join(outDir, `${b.batch}.blind.json`), b.blind);
  }
  writeJson(path.join(outDir, 'manifest.json'), built.manifest);

  const counts = built.manifest.counts as Record<string, number>;
  console.log(`wave ${wave}: ${counts.queued} card(s) in ${built.batches.length} batch(es) of <= ${built.manifest.size} -> ${repoPath(outDir)}`);
  console.log(`  considered ${counts.considered}; dropped ${counts.droppedBySelection} by selection, ${counts.droppedByState} by state${built.manifest.onlyUnlocked ? `, ${counts.droppedByOpenNeeds} with open needs` : ''}`);
  console.log('  states: ' + Object.entries(built.states).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('  families: ' + (built.manifest.families as { family: string; cards: number }[]).slice(0, 8).map(r => `${r.family} ${r.cards}`).join(', '));
  if (built.unearnedHumanSource.length) {
    console.log(`  WARN ${built.unearnedHumanSource.length} script(s) claim source 'hand'/'reviewed' with no review note under data/scripts/reviewed/ —`);
    console.log('       the claim is ignored (they are ranked by their verification alone). Re-author them, or sign them off with');
    console.log(`       npm run scripts:promote -- --human --by "<person>" --ids ${built.unearnedHumanSource.slice(0, 3).map(u => u.oracleId).join(',')}`);
  }
  if (built.missingDeckNames.length) console.log(`  WARN ${built.missingDeckNames.length} deck name(s) not in master.db: ${built.missingDeckNames.slice(0, 5).join(', ')}`);
  db.close();
}

/** LF only, trailing newline — the same bytes `scripts:check` demands of a script. */
function writeJson(file: string, value: unknown) { fs.writeFileSync(file, JSON.stringify(value, null, 2).replace(/\r\n/g, '\n') + '\n'); }

/** A repo-relative POSIX path, or the absolute one when `--out` points outside the checkout (a scratch directory). */
function repoPath(file: string): string {
  const rel = path.relative(projectRoot(), file).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : file.split(path.sep).join('/');
}

// run only as a CLI: the tests import `buildWave` / `parseSelection` / `packFamilies` / `jaccard` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
