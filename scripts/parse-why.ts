// parse:why — the failure-cause histogram: WHY the parser leaves a line unparsed, ranked by the innermost fragment the
// recursive parser could not claim (src/cards/parse.ts `beginParseTrace`), not by the wording of the whole line.
// coverage:pool's whole-line list is the wrong queue for a parser wave: the 3,700 unparsed lines of the 10.1 queue
// are 3,400 distinct wordings, but a few hundred sub-clauses account for most of them.
//
//   npm run parse:why -- --tier paper --select "edhrec<=5000 commander:legal pool:paper" --top 60 --out data/master/parse-why.json --md data/master/parse-why.md
//   npm run parse:why -- --tier paper --top 60 --out <scratch>/parse-why-pool.json          (the whole paper pool)
//
// Options: --tier paper|digital|un|ante|all (default paper; overrides the selection's pool: term), --select "<terms>"
//          (scripts-queue.ts's mini-language), --top N (60), --out <json>, --md <markdown>, --ids <a,b,c | @file>
//          (restrict to those cards), --nested (let a registry rule's sub-parse failure be a line's cause), --exclude-stage
//          <a,b> (stages left out of `constructs`; default keyword,second-face; "" for none), --min-cards N (1).
//
// Per (card, line) EVERY independent failure is a cause (`lineCauses`): registry-pass records when any exist (that
// pass tries strictly more); the trigger head, the intervening clause and each failing cost part are one each, and
// every outermost sentence that failed is one — its innermost record by the bucket order trigger-head → intervening
// → cost → condition(partial) → sentence(partial, deepest) → condition → sentence(depth 0) → static → keyword, or
// each failing sibling part when another part of the sentence parsed. The line's PRIMARY cause (`chooseCause`, the
// first bucket over the whole line) comes first. A failure the trace proves but did not record — the effect half of
// a conditional whose condition failed (the probe says so), the body of a head that is not `partial` when nothing of
// that body is on record — is counted, not keyed. A card FINISHES on a construct when it has exactly one unparsed
// line and that line has exactly one cause: fix the construct and the card is fully parsed. `weight` = finishes +
// 0.5 × the other cards.
//
// Two keys per cause: `key` = stage + the fragment under coverage:pool's normalisation (digits → #, mana → {}), the
// exact construct a rule is written for; `shape` = the same with numbers, subtypes, object nouns, colours, zones,
// players, counters and keywords replaced by placeholders, the family of constructs one rule template covers.
// No timestamp anywhere: two runs on the same tree produce identical bytes (scripts/parse-wave-briefs.ts reads it).
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { CardDB } from '../src/cards/db.js';
import { beginParseTrace, drainParseTrace, endParseTrace, PARSER_VERSION, type ParseTraceRecord } from '../src/cards/parse.js';
import { rulesHash } from '../src/cards/rules/_registry.js';
import { PLAYABLE_SQL, poolRows, useCardDb, type PoolRowDef } from '../src/cards/scriptState.js';
import { tierOf, type PoolTier } from '../src/cards/pool.js';
import { familyOfLine } from '../src/cards/taxonomy.js';
import { ScriptStore, secondFaceLines } from '../src/cards/scripts.js';
import { isSubtypeWord } from '../src/cards/subtypes.js';
import { KEYWORDS } from '../src/cards/schema-core.js';
import { parseSelection, selected, selectionIndex, unparsedLines, type Selection } from './scripts-queue.js';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type Stage = ParseTraceRecord['stage'] | 'second-face' | 'untraced';

/** coverage:pool's normalisation without its 90-character cut: the exact construct. */
export function norm1(fragment: string): string {
  return fragment.trim().replace(/\.$/, '').replace(/\d+/g, '#').replace(/\{[^}]+\}/g, '{}');
}

const NUMBER_WORDS = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fifteen|twenty|x)\b/g;
const COLORS = /\b(?:white|blue|black|red|green|colorless|multicolored|monocolored)\b/g;
const ZONES = /\b(?:battlefield|graveyards?|library|libraries|hands?|(?<=\b(?:in|from|into|to) )exile|stack|command zone)\b/g;   // "exile" is the zone only after in / from / into / to; elsewhere it is the verb
const PLAYERS = /\b(?:opponents?|players?|controllers?|owners?)\b/g;
const OBJECTS = /\b(?:creatures?|permanents?|cards?|tokens?|spells?|artifacts?|enchantments?|lands?|planeswalkers?|battles?|auras?|equipment|abilit(?:y|ies)|sources?)\b/g;
const COUNTERS = /(?<!\S)(?!(?:a|an|each|that|the|another|those|all|any|of|more|no|or) )(?:[+-]#\/[+-]#|[a-z]+) (counters?)\b/g;   // "+1/+1 counters", "loyalty counter" — not "a counter"
const KEYWORD_RE = new RegExp(`\\b(?:${[...KEYWORDS].map(String).sort((a, b) => b.length - a.length).map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\b`, 'g');

/** The coarse key: what a rule template would cover. Subtypes are read before lowercasing (oracle text capitalises them). */
export function shape(fragment: string): string {
  const words = norm1(fragment).split(/(\s+)/).map(w => /^[A-Z][a-z]+s?$/.test(w) && isSubtypeWord(w) ? '<subtype>' : w).join('');
  return words.toLowerCase()
    .replace(/\{\}/g, '{m}')
    .replace(NUMBER_WORDS, '#')
    .replace(COUNTERS, '<counter> $1')
    .replace(KEYWORD_RE, '<kw>')
    .replace(COLORS, '<color>')
    .replace(ZONES, '<zone>')
    .replace(PLAYERS, '<player>')
    .replace(OBJECTS, '<obj>')
    .replace(/\s+/g, ' ').trim();
}

/** The first `n` tokens of a shape (`~` and placeholders count as tokens). */
export function prefixOf(sh: string, n: number): string { return sh.split(' ').slice(0, n).join(' '); }

// ---------------------------------------------------------------------------
// Cause selection
// ---------------------------------------------------------------------------

const BUCKETS: ((r: ParseTraceRecord) => boolean)[] = [
  r => r.stage === 'trigger-head',
  r => r.stage === 'intervening',
  r => r.stage === 'cost',
  r => r.stage === 'condition' && r.partial,
  r => r.stage === 'sentence' && r.partial,
  r => r.stage === 'condition',
  r => r.stage === 'sentence' && r.depth === 0,
  r => r.stage === 'static',
  r => r.stage === 'keyword',
];

/**
 * A `cost` record from parseActivatedLine's cost/effect split of a line that is not an activated ability at all
 * ('Enchanted creature has "{T}: Add {G}."' hands it `Enchanted creature has "{T}` as the cost) is noise, not a cost
 * construct: a real cost phrase is short, never quotes, and is either partial (another part parsed) or looks like one.
 */
function plausibleCost(r: ParseTraceRecord): boolean {
  if (r.stage !== 'cost') return true;
  if (r.fragment.includes('"') || r.fragment.length > 80) return false;
  return r.partial || /^(?:\{|sacrifice|discard|pay|remove|exile|return|tap|untap|put|reveal|mill|forage|collect|choose|unattach|attach|shuffle|crew|gift|cycle|bounce|~)/i.test(r.fragment);
}

/** The one record that is the line's cause, or null when the line has none (second face, a registry line rule's markUnparsed). */
export function chooseCause(records: ParseTraceRecord[], nested: boolean): ParseTraceRecord | null {
  let cands = records.filter(r => (nested || r.nested === 0) && plausibleCost(r));
  if (cands.some(r => r.pass === 'registry')) cands = cands.filter(r => r.pass === 'registry');
  for (const b of BUCKETS) {
    const hits = cands.filter(b);
    if (!hits.length) continue;
    // sentence(partial): the deepest fragment is the innermost; otherwise the first recorded
    return hits.reduce((best, r) => (b === BUCKETS[4] && r.depth > best.depth ? r : best), hits[0]);
  }
  return null;
}

const HEAD_STAGES = new Set<ParseTraceRecord['stage']>(['trigger-head', 'intervening']);
const LADDER_STAGES = new Set<ParseTraceRecord['stage']>(['sentence', 'condition']);
const bucketOf = (r: ParseTraceRecord) => BUCKETS.findIndex(b => b(r));

/**
 * Every independent failure of one line, the line's cause (`chooseCause`) first, and the count a "finish" rests on:
 * `units.length` plus the failures the trace proves but has no fragment for. Units: each head / intervening / cost
 * record; per outermost sentence (records grouped by `sentence`) its innermost record, or — when the innermost is a
 * partial sentence part — every failing part no other failing part sits inside (two sibling parts that both failed
 * beside a part that parsed are two constructs). Unrecorded: a condition that is not `partial` (the probe ran the
 * effect half and it failed too); a head or intervening clause that is not `partial` when it is the line's only
 * unit (the body failed and left no record). The whole-line static / keyword record is the unit only when the line
 * has no inner one. Nested records (`--nested`) are the primary only; they sit inside a unit of their own line.
 */
export function lineCauses(records: ParseTraceRecord[], nested: boolean): { units: ParseTraceRecord[]; count: number } {
  const primary = chooseCause(records, nested);
  if (!primary) return { units: [], count: 0 };
  let cands = records.filter(r => r.nested === 0 && plausibleCost(r));
  if (cands.some(r => r.pass === 'registry')) cands = cands.filter(r => r.pass === 'registry');
  const units = cands.filter(r => HEAD_STAGES.has(r.stage) || r.stage === 'cost');
  let unrecorded = 0;
  const groups = new Map<string, ParseTraceRecord[]>();
  for (const r of cands) if (LADDER_STAGES.has(r.stage)) { const k = r.sentence ?? `\0${r.fragment}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  for (const g of groups.values()) {
    const inner = chooseCause(g, false)!;
    if (inner.stage === 'sentence' && inner.partial) {
      const partials = g.filter(r => r.stage === 'sentence' && r.partial);
      for (const r of partials) if (!partials.some(o => o.fragment !== r.fragment && r.fragment.includes(o.fragment)) && !units.some(u => u.fragment === r.fragment)) units.push(r);
    } else { units.push(inner); if (inner.stage === 'condition' && !inner.partial) unrecorded++; }
  }
  if (units.length === 1 && HEAD_STAGES.has(units[0].stage) && !units[0].partial) unrecorded++;
  if (!units.length) { const whole = cands.find(r => r.stage === 'static') ?? cands.find(r => r.stage === 'keyword'); if (whole) units.push(whole); }
  // the bucket order, the deepest partial sentence first, then the record order: `chooseCause`'s choice leads
  units.sort((a, b) => bucketOf(a) - bucketOf(b) || (bucketOf(a) === 4 ? b.depth - a.depth : 0) || cands.indexOf(a) - cands.indexOf(b));
  if (primary.nested > 0) units.splice(0, 1, primary); else if (!units.includes(primary)) units.unshift(primary);
  return { units, count: units.length + unrecorded };
}

/** The records of one unparsed line: by line text (back faces carry the `// ` marker), else by sentence / fragment for a spell's sentence entry or a mode bullet. */
function recordsOfLine(u: string, recs: ParseTraceRecord[]): { recs: ParseTraceRecord[]; via: 'line' | 'sentence' | 'mode' | 'none' } {
  const isBack = u.startsWith('// ');
  const text = isBack ? u.slice(3) : u;
  const byLine = recs.filter(r => r.line === text && r.face === (isBack ? 'back' : 'front'));
  if (byLine.length) return { recs: byLine, via: 'line' };
  const bySentence = recs.filter(r => r.face === (isBack ? 'back' : 'front') && (r.sentence === text || r.fragment === text));
  if (bySentence.length) return { recs: bySentence, via: 'sentence' };
  if (text.startsWith('• ')) {
    // a mode entry is one failing effect's text (parse.ts noteUnknownMode): its own sentence's records first — the
    // modal line's other sentences have entries of their own — and the whole modal line only when nothing matches
    const mode = text.slice(2); const bare = mode.replace(/\.$/, '');
    const face = isBack ? 'back' : 'front';
    const bySent = recs.filter(r => r.face === face && (r.sentence === mode || r.sentence === bare || r.fragment === mode || r.fragment === bare));
    if (bySent.length) return { recs: bySent, via: 'mode' };
    const byMode = recs.filter(r => r.face === face && r.line.includes(bare));
    if (byMode.length) return { recs: byMode, via: 'mode' };
  }
  return { recs: [], via: 'none' };
}

export interface LineCause { line: string; stage: Stage; key: string; shape: string; fragment: string; pass: ParseTraceRecord['pass'] | null; family: string; /** Independent failures on this line (`lineCauses`), this one included: 1 is what a finish needs. */ causes: number }

/**
 * The causes of every unparsed line of the card, a line's primary cause first. A spell's failing SENTENCES are pushed
 * to `unparsed` beside the whole multi-sentence line (parse.ts's spell fold), so that line is on record twice over:
 * the sentence entries carry the causes and the whole-line entry they cover is dropped. A one-sentence line has no
 * such duplicate. A line with no record (a split card's second half, a registry line rule's markUnparsed) is one
 * cause of its own stage.
 */
export function causesOf(def: PoolRowDef['def'], recs: ParseTraceRecord[], nested: boolean): LineCause[] {
  const lines = unparsedLines(def);
  const second = new Set(secondFaceLines(def));
  const matched = lines.map(u => ({ u, ...recordsOfLine(u, recs) }));
  const covered = new Set<string>();
  for (const m of matched) if (m.via === 'sentence') for (const r of m.recs) { const entry = (r.face === 'back' ? '// ' : '') + r.line; if (entry !== m.u && lines.includes(entry)) covered.add(entry); }
  const out: LineCause[] = [];
  for (const { u, recs: mine } of matched) {
    if (covered.has(u)) continue;
    const family = familyOfLine(u)?.family ?? 'other';
    const { units, count } = mine.length ? lineCauses(mine, nested) : { units: [], count: 0 };
    if (!units.length) { const stage: Stage = second.has(u) ? 'second-face' : 'untraced'; out.push({ line: u, stage, key: `${stage}|${norm1(u)}`, shape: `${stage}|${shape(u)}`, fragment: u, pass: null, family, causes: 1 }); continue; }
    for (const cause of units) out.push({ line: u, stage: cause.stage, key: `${cause.stage}|${norm1(cause.fragment)}`, shape: `${cause.stage}|${shape(cause.fragment)}`, fragment: cause.fragment, pass: cause.pass, family, causes: count });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Example { oracleId: string; name: string; edhrec: number | null; line: string; /** This construct is the card's only unparsed cause. */ finishes: boolean }
export interface Construct {
  key: string; stage: Stage; norm: string; shape: string;
  lines: number; cards: number; finishes: number; scripted: number; weight: number;
  passes: { builtin: number; registry: number };
  /** Hints for scripts/parse-wave-briefs.ts's `suggestedHome`: trigger lines with a comma inside the head region, fragments starting with an unrewritten pronoun. */
  hints: { commaHeads: number; pronounStarts: number };
  families: { family: string; lines: number }[];
  examples: Example[];
  rawFragments: { n: number; fragment: string }[];
}
export interface ShapeRow { shape: string; stage: Stage; keys: number; lines: number; cards: number; finishes: number; weight: number; example: string }
export interface PrefixRow { prefix: string; stage: Stage; keys: number; cards: number; finishes: number; weight: number }
export interface NestedRow { key: string; stage: Stage; lines: number; cards: number; example: string }
export interface Report {
  generatedFrom: { tier: PoolTier | 'all'; selection: string; ids: number | null; nested: boolean; excludeStages: Stage[]; minCards: number; top: number; parserVersion: number; rulesHash: string };
  /** `lines` = unparsed lines accounted, `lineCauses` = their (line, cause) entries (a line with two independent failures is two), `oneLineCards` = cards one line short, `finishCards` = those whose line has one cause (the number a rule can move), `causes` = distinct keys; `byStage.lines` counts entries. */
  totals: { cards: number; unparsedCards: number; oneLineCards: number; finishCards: number; lines: number; lineCauses: number; causes: number; byStage: Record<string, { lines: number; cards: number; finishes: number }> };
  constructs: Construct[];
  shapes: ShapeRow[];
  prefixes: PrefixRow[];
  nestedCauses: NestedRow[];
}

interface Acc { stage: Stage; norm: string; shape: string; lines: number; cards: Set<string>; finishes: Set<string>; scripted: Set<string>; passes: { builtin: number; registry: number }; hints: { commaHeads: number; pronounStarts: number }; families: Map<string, number>; examples: Example[]; raw: Map<string, number> }

const PRONOUN_START = /^(?:it|its|they|them|their|those|that (?:creature|permanent|player|card|spell|token|object))\b/i;
/** A trigger line whose head runs past the first comma ("Whenever ~ attacks, blocks, or becomes blocked, …"): a short comma-part then "or" / "and" — a body ("…, draw a card, then …") never reads so. */
const COMMA_HEAD = /^(?:When|Whenever|At) [^,]+, (?:[^,]{0,40}, )?(?:or|and) /;
const byEdhrec = (a: Example, b: Example) => (a.edhrec ?? Infinity) - (b.edhrec ?? Infinity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.oracleId < b.oracleId ? -1 : 1);
const round = (n: number) => Math.round(n * 100) / 100;

export interface AnalyzeOptions { tier: PoolTier | 'all'; selection: Selection; ids?: string[]; nested: boolean; excludeStages: Stage[]; minCards: number; top: number; scripted: ReadonlySet<string>; edhrec: ReadonlyMap<string, number> }

/** The histogram over `rows` (each with the trace records its parse produced). */
export function analyze(rows: Iterable<{ row: PoolRowDef; recs: ParseTraceRecord[] }>, opts: AnalyzeOptions): Report {
  const acc = new Map<string, Acc>();
  const nestedAcc = new Map<string, { stage: Stage; lines: number; cards: Set<string>; example: string }>();
  const byStage: Record<string, { lines: number; cards: Set<string>; finishes: number }> = {};
  let cards = 0, unparsedCards = 0, oneLineCards = 0, finishCards = 0, lines = 0, lineCauses = 0;
  for (const { row, recs } of rows) {
    cards++;
    const id = row.def.oracleId;
    const causes = causesOf(row.def, recs, opts.nested);
    if (!causes.length) continue;
    unparsedCards++;
    const lineCount = new Set(causes.map(c => c.line)).size;
    lines += lineCount; lineCauses += causes.length;
    if (lineCount === 1) oneLineCards++;
    // one line, one cause (the line's other failures counted whether keyed or not), and one a rule can be written for
    const finishes = causes.length === 1 && causes[0].causes === 1 && causes[0].stage !== 'untraced' && causes[0].stage !== 'second-face';
    if (finishes) finishCards++;
    const seenKeys = new Set<string>();
    for (const c of causes) {
      const st = (byStage[c.stage] ??= { lines: 0, cards: new Set(), finishes: 0 });
      st.lines++; st.cards.add(id); if (finishes) st.finishes++;
      const a = acc.get(c.key) ?? { stage: c.stage, norm: c.key.slice(c.stage.length + 1), shape: c.shape.slice(c.stage.length + 1), lines: 0, cards: new Set<string>(), finishes: new Set<string>(), scripted: new Set<string>(), passes: { builtin: 0, registry: 0 }, hints: { commaHeads: 0, pronounStarts: 0 }, families: new Map<string, number>(), examples: [], raw: new Map<string, number>() };
      acc.set(c.key, a);
      a.lines++; a.cards.add(id); if (finishes) a.finishes.add(id); if (opts.scripted.has(id)) a.scripted.add(id);
      if (c.pass) a.passes[c.pass]++;
      if (c.stage === 'trigger-head' && COMMA_HEAD.test(c.line)) a.hints.commaHeads++;
      if (PRONOUN_START.test(c.fragment)) a.hints.pronounStarts++;
      a.families.set(c.family, (a.families.get(c.family) ?? 0) + 1);
      a.raw.set(c.fragment, (a.raw.get(c.fragment) ?? 0) + 1);
      if (!seenKeys.has(c.key)) { seenKeys.add(c.key); a.examples.push({ oracleId: id, name: row.def.name, edhrec: opts.edhrec.get(id) ?? null, line: c.line, finishes }); }
    }
    // what a registry rule's own sub-parse could not claim (nested > 0): not a line's cause unless --nested, listed apart
    for (const r of recs) {
      if (r.nested === 0 || r.stage !== 'sentence' || r.pass !== 'registry' || !r.partial) continue;
      const key = `${r.stage}|${norm1(r.fragment)}`;
      const n = nestedAcc.get(key) ?? { stage: r.stage, lines: 0, cards: new Set<string>(), example: row.def.name };
      nestedAcc.set(key, n); n.lines++; n.cards.add(id);
    }
  }
  const constructs: Construct[] = [...acc.entries()]
    .map(([key, a]) => ({
      key, stage: a.stage, norm: a.norm, shape: a.shape, lines: a.lines, cards: a.cards.size, finishes: a.finishes.size, scripted: a.scripted.size,
      weight: round(a.finishes.size + 0.5 * (a.cards.size - a.finishes.size)), passes: a.passes, hints: a.hints,
      families: [...a.families.entries()].map(([family, n]) => ({ family, lines: n })).sort((x, y) => y.lines - x.lines || (x.family < y.family ? -1 : 1)),
      examples: a.examples.sort(byEdhrec).slice(0, 12),
      rawFragments: [...a.raw.entries()].map(([fragment, n]) => ({ n, fragment })).sort((x, y) => y.n - x.n || (x.fragment < y.fragment ? -1 : 1)).slice(0, 8),
    }))
    .filter(c => !opts.excludeStages.includes(c.stage) && c.cards >= opts.minCards)
    .sort((x, y) => y.weight - x.weight || y.cards - x.cards || y.lines - x.lines || (x.key < y.key ? -1 : 1));
  const shapes = new Map<string, ShapeRow & { cardSet: Set<string>; finishSet: Set<string> }>();
  const prefixes = new Map<string, PrefixRow & { cardSet: Set<string>; finishSet: Set<string> }>();
  for (const [key, a] of acc) {
    if (opts.excludeStages.includes(a.stage)) continue;
    const sk = `${a.stage}|${a.shape}`;
    const s = shapes.get(sk) ?? { shape: a.shape, stage: a.stage, keys: 0, lines: 0, cards: 0, finishes: 0, weight: 0, example: key.slice(a.stage.length + 1), cardSet: new Set<string>(), finishSet: new Set<string>() };
    shapes.set(sk, s); s.keys++; s.lines += a.lines; for (const id of a.cards) s.cardSet.add(id); for (const id of a.finishes) s.finishSet.add(id);
    const pk = `${a.stage}|${prefixOf(a.shape, a.stage === 'trigger-head' || a.stage === 'cost' ? 4 : 3)}`;
    const p = prefixes.get(pk) ?? { prefix: pk.slice(a.stage.length + 1), stage: a.stage, keys: 0, cards: 0, finishes: 0, weight: 0, cardSet: new Set<string>(), finishSet: new Set<string>() };
    prefixes.set(pk, p); p.keys++; for (const id of a.cards) p.cardSet.add(id); for (const id of a.finishes) p.finishSet.add(id);
  }
  const finish = <T extends { cardSet: Set<string>; finishSet: Set<string>; cards: number; finishes: number; weight: number }>(r: T) => { r.cards = r.cardSet.size; r.finishes = r.finishSet.size; r.weight = round(r.finishes + 0.5 * (r.cards - r.finishes)); const { cardSet: _c, finishSet: _f, ...rest } = r; void _c; void _f; return rest; };
  const rank = <T extends { weight: number; cards: number }>(a: T, b: T, ka: string, kb: string) => b.weight - a.weight || b.cards - a.cards || (ka < kb ? -1 : 1);
  return {
    generatedFrom: { tier: opts.tier, selection: opts.selection.raw, ids: opts.ids ? opts.ids.length : null, nested: opts.nested, excludeStages: opts.excludeStages, minCards: opts.minCards, top: opts.top, parserVersion: PARSER_VERSION, rulesHash: rulesHash() },
    totals: {
      cards, unparsedCards, oneLineCards, finishCards, lines, lineCauses, causes: acc.size,
      byStage: Object.fromEntries(Object.entries(byStage).sort((a, b) => b[1].lines - a[1].lines).map(([k, v]) => [k, { lines: v.lines, cards: v.cards.size, finishes: v.finishes }])),
    },
    constructs: constructs.slice(0, opts.top),
    shapes: [...shapes.values()].map(finish).sort((a, b) => rank(a, b, a.shape, b.shape)).slice(0, opts.top),
    prefixes: [...prefixes.values()].map(finish).sort((a, b) => rank(a, b, a.prefix, b.prefix)).slice(0, opts.top),
    nestedCauses: [...nestedAcc.entries()].map(([key, n]) => ({ key, stage: n.stage, lines: n.lines, cards: n.cards.size, example: n.example })).sort((a, b) => b.cards - a.cards || b.lines - a.lines || (a.key < b.key ? -1 : 1)).slice(0, opts.top),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function markdown(r: Report): string {
  const t = r.totals;
  const out: string[] = [];
  out.push('# parse:why — failure-cause histogram', '');
  out.push(`Selection: \`${r.generatedFrom.selection || 'pool:' + r.generatedFrom.tier}\` (tier ${r.generatedFrom.tier}); parser v${r.generatedFrom.parserVersion}, rules ${r.generatedFrom.rulesHash}.`, '');
  out.push(`${t.cards} cards, ${t.unparsedCards} with unparsed lines (${t.oneLineCards} one line short, ${t.finishCards} of them with one cause on it), ${t.lines} lines carrying ${t.lineCauses} causes, ${t.causes} distinct.`, '');
  out.push('| stage | lines | cards | finishes |', '|---|---:|---:|---:|');
  for (const [k, v] of Object.entries(t.byStage)) out.push(`| ${k} | ${v.lines} | ${v.cards} | ${v.finishes} |`);
  out.push('', `## Top ${r.constructs.length} constructs`, '', 'weight = finishes + 0.5 × other cards; a card finishes when this is its only unparsed line and the only failure on it.', '');
  out.push('| # | weight | cards | finishes | lines | stage | key | shape | e.g. |', '|---:|---:|---:|---:|---:|---|---|---|---|');
  r.constructs.forEach((c, i) => out.push(`| ${i + 1} | ${c.weight} | ${c.cards} | ${c.finishes} | ${c.lines} | ${c.stage} | ${cell(c.norm)} | ${cell(c.shape)} | ${cell(c.examples[0]?.name ?? '')} |`));
  out.push('', `## Top ${r.shapes.length} shapes`, '', '| weight | cards | finishes | keys | stage | shape | e.g. key |', '|---:|---:|---:|---:|---|---|---|');
  for (const s of r.shapes) out.push(`| ${s.weight} | ${s.cards} | ${s.finishes} | ${s.keys} | ${s.stage} | ${cell(s.shape)} | ${cell(s.example)} |`);
  out.push('', `## Top ${r.prefixes.length} prefixes`, '', '| weight | cards | finishes | keys | stage | prefix |', '|---:|---:|---:|---:|---|---|');
  for (const p of r.prefixes) out.push(`| ${p.weight} | ${p.cards} | ${p.finishes} | ${p.keys} | ${p.stage} | ${cell(p.prefix)} |`);
  out.push('', `## Nested causes (what a registry rule's own sub-parse could not claim; not a line's cause without --nested)`, '', '| cards | lines | key | e.g. |', '|---:|---:|---|---|');
  for (const n of r.nestedCauses) out.push(`| ${n.cards} | ${n.lines} | ${cell(n.key)} | ${cell(n.example)} |`);
  return out.join('\n') + '\n';
}
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, "'");

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const select = opt('--select');
  const tierArg = opt('--tier') as PoolTier | 'all' | undefined;
  const selection = parseSelection(select ?? `pool:${tierArg ?? 'paper'}`);
  if (tierArg) selection.tier = tierArg;   // --tier wins over the selection's pool: term
  const tier = selection.tier;
  const top = Math.max(1, Number(opt('--top') ?? '60'));
  const nested = args.includes('--nested');
  const excludeStages = (opt('--exclude-stage') ?? 'keyword,second-face').split(/[\s,]+/).filter(Boolean) as Stage[];
  const minCards = Math.max(1, Number(opt('--min-cards') ?? '1'));
  const idsArg = opt('--ids');
  const only = idsArg ? new Set((idsArg.startsWith('@') ? fs.readFileSync(idsArg.slice(1), 'utf8') : idsArg).split(/[\s,]+/).filter(Boolean)) : null;
  const outFile = opt('--out');
  const mdFile = opt('--md');

  const db = CardDB.shared();
  useCardDb(db);
  const idx = selectionIndex(db);
  // the selection is decided on the raw row (no parse), so `--select edhrec<=5000` parses 5k cards, not 34k
  const ids: string[] = [];
  for (const r of db.db.prepare(`SELECT oracle_id AS id, json FROM oracle_cards WHERE ${PLAYABLE_SQL}`).iterate() as Iterable<{ id: string; json: string }>) {
    if (only && !only.has(r.id)) continue;
    const raw = JSON.parse(r.json) as Record<string, unknown>;
    if (!selected(selection, idx, r.id, tierOf(raw as Parameters<typeof tierOf>[0]))) continue;
    ids.push(r.id);
  }
  const scripted = new Set(new ScriptStore().ids());
  const t0 = Date.now();
  beginParseTrace();
  function* traced(): Generator<{ row: PoolRowDef; recs: ParseTraceRecord[] }> {
    for (const row of poolRows({ ids })) yield { row, recs: drainParseTrace() };
  }
  const report = analyze(traced(), { tier, selection, ids: only ? ids : undefined, nested, excludeStages, minCards, top, scripted, edhrec: idx.edhrec });
  endParseTrace();
  db.close();

  if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n'); }
  if (mdFile) { fs.mkdirSync(path.dirname(mdFile), { recursive: true }); fs.writeFileSync(mdFile, markdown(report)); }
  const t = report.totals;
  console.log(`parse:why — ${t.cards} cards, ${t.unparsedCards} unparsed (${t.oneLineCards} one line short, ${t.finishCards} with one cause), ${t.lines} lines / ${t.lineCauses} causes, ${t.causes} distinct; by stage: ${Object.entries(t.byStage).map(([k, v]) => `${k} ${v.lines}`).join(', ')} (${((Date.now() - t0) / 1000).toFixed(1)}s)${outFile ? ` -> ${outFile}` : ''}`);
  console.log('  weight  cards  fin  stage         key');
  for (const c of report.constructs.slice(0, 25)) console.log(`  ${String(c.weight).padStart(6)}  ${String(c.cards).padStart(5)}  ${String(c.finishes).padStart(3)}  ${c.stage.padEnd(12)}  ${c.norm.slice(0, 100)}`);
}

// run only as a CLI: the tests import `analyze` / `chooseCause` / `norm1` / `shape` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
