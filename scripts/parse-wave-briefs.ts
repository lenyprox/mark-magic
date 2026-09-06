// Build the brief file a parser wave (docs/workflows/parse-wave.js) is fanned out over, from the parse:why histogram
// (scripts/parse-why.ts). One item per CONSTRUCT GROUP — the constructs one rule template would cover — ranked by
// weight; the first `--max` are the wave's items, the rest `residual` for the next wave.
//
//   npx tsx scripts/parse-wave-briefs.ts --in data/master/parse-why.json --wave 9.1p --base <commit> --max 16 --out data/scripts/batches/parse-wave-1.json
//
// Deterministic: no clock, no randomness, stable sorts — two runs on the same input are byte-identical. Grouping:
// the `keyword` and `second-face` stages and every construct under 3 cards are dropped; the group key is the stage
// plus the first four shape tokens (trigger-head / cost / condition: the head or phrase opener is the template) or
// the whole shape (sentence / static: the whole shape is the template). `weight` / `cards` / `finishes` / `lines`
// are summed over the members, `clauses` are the member keys with counts (≤ 40), `cardIds` the union of the members'
// examples by EDHREC rank (≤ 12). Names are `generic-<slug>` (the first three content tokens of the shape), unique
// within the file and against the families already under src/cards/rules (gen-registry.mjs `ruleFamilyFiles`); the
// orchestrator may fix names and titles by hand, which is the only manual step.
//
// `suggestedHome` is `core` when the construct cannot be done from a worktree's registry file: a trigger head with a
// comma inside it (the built-in first-comma split in parse.ts's line loop decides the head before any rule runs),
// fragments that start with an unrewritten pronoun (parse.ts rewrites "it" / "that creature" before the templates),
// or a dominant `builtin` pass (the failing sub-parse ran with useRegistry=false — parseStatic, a paragraph slot —
// where no registry rule is consulted). Everything else is `registry`.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { ruleFamilyFiles } from './gen-registry.mjs';
import type { Construct, Report, Stage } from './parse-why.js';

export interface BriefItem {
  name: string;
  title: string;
  stage: Stage;
  cards: number;
  finishes: number;
  lines: number;
  weight: number;
  families: { family: string; lines: number }[];
  /** The member construct keys (stage|norm) with their line counts — the exact wordings the rule is for. */
  clauses: { n: number; clause: string }[];
  cardIds: string[];
  /** The members' sample cards by EDHREC rank; `finishes` marks the ones this item alone would fully parse — the scenario candidates. */
  examples: { name: string; line: string; finishes: boolean }[];
  notes: string;
  suggestedHome: 'registry' | 'core';
  /** The group's shape key, so a reader can see why the members were grouped. */
  group: string;
}

export interface Brief { wave: string; base: string; generatedFrom: Report['generatedFrom'] & { file: string; constructs: number }; items: BriefItem[]; residual: BriefItem[] }

const HEAD_STAGES = new Set<Stage>(['trigger-head', 'cost', 'condition']);
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'you', 'your', 'its', 'it', 'that', 'this', 'for', 'each', 'with', 'on', 'in', 'from', 'at', 'is', 'are', 'or', 'and', 'be', 'all', 'any', 'may', 'then', 'into', 'onto', 'by', 'as', 'if', 'have', 'has', 'get', 'gets', 'their', 'they', 'them', 'those', 'who', 'until', "it's", "you've", 'do', 'does', 'was', 'were', 'not', 'no', 'other', 'another', 'than', 'up', 'own', 'under', 'control', 'controls']);

/** The group key of a construct: the stage plus the template-sized part of its shape. */
export function groupKeyOf(c: Pick<Construct, 'stage' | 'shape'>): string {
  const tokens = c.shape.split(' ');
  return `${c.stage}|${HEAD_STAGES.has(c.stage) ? tokens.slice(0, 4).join(' ') : c.shape}`;
}

/**
 * `generic-<three content tokens>` of the text: placeholders, numbers and symbols skipped, stopwords too unless that
 * leaves fewer than two words ("you do" stays "you-do"); the stage when nothing at all is left.
 */
export function slugOf(stage: Stage, text: string): string {
  const raw = wordsOf(text);
  const content = raw.filter(w => !STOP.has(w));
  const picked: string[] = [];
  for (const w of content.length >= 2 ? content : raw) { if (!picked.includes(w)) picked.push(w); if (picked.length === 3) break; }
  return 'generic-' + (picked.length ? picked.join('-') : stage);
}
const wordsOf = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9<>{}#~' -]/g, ' ').split(/\s+/)
  .filter(w => w && !/^[<{#~]/.test(w) && /^[a-z]/.test(w)).map(w => w.replace(/'s$/, '').replace(/[^a-z0-9-]/g, '')).filter(Boolean);
/** How many words of the text are neither placeholders nor stopwords — whether it can name an item on its own. */
export const contentWords = (text: string): number => wordsOf(text).filter(w => !STOP.has(w)).length;

const PRONOUN_HEAD = /^(?:it|its|they|them|their|those|that (?:creature|permanent|player|card|spell|token|object))\b/i;

export function buildBrief(report: Report, opts: { wave: string; base: string; max: number; file: string; existing: readonly string[] }): Brief {
  const groups = new Map<string, Construct[]>();
  for (const c of report.constructs) {
    if (c.stage === 'keyword' || c.stage === 'second-face' || c.stage === 'untraced' || c.cards < 3) continue;
    const k = groupKeyOf(c);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const taken = new Set(opts.existing.map(f => f.replace(/\.ts$/, '')));
  const unique = (base: string): string => { let name = base; for (let i = 2; taken.has(name); i++) name = `${base}-${i}`; taken.add(name); return name; };
  const items: BriefItem[] = [...groups.entries()].map(([group, members]): BriefItem => {
    const stage = members[0].stage;
    const sum = (f: (c: Construct) => number) => members.reduce((a, c) => a + f(c), 0);
    const fam = new Map<string, number>();
    for (const c of members) for (const f of c.families) fam.set(f.family, (fam.get(f.family) ?? 0) + f.lines);
    const examples = members.flatMap(c => c.examples).sort((a, b) => (a.edhrec ?? Infinity) - (b.edhrec ?? Infinity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.oracleId < b.oracleId ? -1 : 1));
    const cardIds: string[] = []; const shown: { name: string; line: string; finishes: boolean }[] = [];
    for (const e of examples) { if (cardIds.includes(e.oracleId)) continue; cardIds.push(e.oracleId); shown.push({ name: e.name, line: e.line, finishes: e.finishes }); if (cardIds.length === 12) break; }
    const commaHeads = sum(c => c.hints.commaHeads), pronouns = sum(c => c.hints.pronounStarts) + members.filter(c => PRONOUN_HEAD.test(c.norm)).length;
    const builtin = sum(c => c.passes.builtin), registry = sum(c => c.passes.registry);
    const lines = sum(c => c.lines);
    const why: string[] = [];
    if (stage === 'trigger-head' && commaHeads * 2 >= lines) why.push(`${commaHeads}/${lines} trigger lines carry a comma inside the head: the built-in first-comma split (parse.ts line loop) decides the head before any trigger rule runs`);
    if (pronouns) why.push(`${pronouns} fragment(s) start with an unrewritten pronoun: parse.ts rewrites "it" / "that creature" before the templates, a registry rule never sees the antecedent`);
    if (builtin > registry) why.push(`the dominant pass is builtin (${builtin} vs ${registry}): the failing sub-parse ran with useRegistry=false (parseStatic, a paragraph slot), where no registry rule is consulted`);
    const shape = group.slice(stage.length + 1);
    // the group shape names the item when it has two content words ("whenever equipped <obj> attacks"); a bare head
    // opener ("at the beginning of") is named by its biggest member instead
    return {
      name: slugOf(stage, contentWords(shape) >= 2 ? shape : members[0].norm), title: `${stage}: ${shape}`, stage,
      cards: sum(c => c.cards), finishes: sum(c => c.finishes), lines, weight: Math.round(sum(c => c.weight) * 100) / 100,
      families: [...fam.entries()].map(([family, n]) => ({ family, lines: n })).sort((a, b) => b.lines - a.lines || (a.family < b.family ? -1 : 1)),
      clauses: members.flatMap(c => [{ n: c.lines, clause: c.key }]).sort((a, b) => b.n - a.n || (a.clause < b.clause ? -1 : 1)).slice(0, 40),
      cardIds, examples: shown,
      notes: `${members.length} construct(s); passes builtin ${builtin} / registry ${registry}; scripted cards ${sum(c => c.scripted)}.` + (why.length ? ' Core: ' + why.join('; ') + '.' : ''),
      suggestedHome: why.length ? 'core' : 'registry',
      group,
    };
  }).sort((a, b) => b.weight - a.weight || b.cards - a.cards || b.lines - a.lines || (a.group < b.group ? -1 : 1));
  // names are made unique in rank order, so the first 16 keep the plain slug
  for (const it of items) it.name = unique(it.name);
  return { wave: opts.wave, base: opts.base, generatedFrom: { ...report.generatedFrom, file: opts.file, constructs: report.constructs.length }, items: items.slice(0, opts.max), residual: items.slice(opts.max) };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const file = opt('--in') ?? 'data/master/parse-why.json';
  const wave = opt('--wave') ?? '9.1p';
  const base = opt('--base');
  if (!base) { console.error('parse-wave-briefs: --base <commit> is required (the commit every worktree resets to)'); process.exit(1); }
  const max = Math.max(1, Number(opt('--max') ?? '16'));
  const out = opt('--out') ?? `data/scripts/batches/parse-wave-${wave}.json`;
  const report = JSON.parse(fs.readFileSync(file, 'utf8')) as Report;
  const brief = buildBrief(report, { wave, base, max, file: file.split(path.sep).join('/'), existing: ruleFamilyFiles() as string[] });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(brief, null, 2).replace(/\r\n/g, '\n') + '\n');
  console.log(`parse-wave-briefs — ${brief.items.length} item(s) + ${brief.residual.length} residual from ${report.constructs.length} constructs -> ${out}`);
  for (const it of brief.items) console.log(`  ${it.name.padEnd(36)} ${String(it.weight).padStart(6)} w  ${String(it.cards).padStart(4)} cards  ${String(it.finishes).padStart(4)} fin  ${it.suggestedHome.padEnd(8)}  ${it.title.slice(0, 90)}`);
}

// run only as a CLI: the tests import `buildBrief` / `groupKeyOf` / `slugOf` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
