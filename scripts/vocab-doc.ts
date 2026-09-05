// Generate data/scripts/VOCABULARY.md — the ONE document a script-author agent is allowed to write ops from
// (plan 2.8 / Part 4: "use only ops in data/scripts/VOCABULARY.md"). Nothing here is hand-written: the vocabulary
// comes from the strict zod barrel (src/cards/schema.ts — the same schema `scripts:check` validates against, so the
// document can never promise an op the checker rejects), the family names from the registry barrel
// (src/engine/ops/_registry.ts), the prose from docs/vocabulary/<family>.md, and the examples from the judged
// scripts in the store (falling back to data/scripts/_example*.json.txt while no wave has been judged).
//
//   npm run vocab:doc            # write data/scripts/VOCABULARY.md
//   npm run vocab:doc -- --check # print nothing, exit 1 if the file on disk is not what would be written
//
// The output carries NO timestamp and no absolute path, so running it twice produces no diff;
// `test/vocab-doc.test.ts` regenerates it into a string and compares, which is what keeps the tracked file honest.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { projectRoot } from '../src/config/paths.js';
import { MODULES } from '../src/engine/ops/_registry.js';
import {
  AbilityCostSchema, ALT_COST_FROM, ALT_COST_IDS, AMOUNT_COUNTS, AMOUNT_PROPS, CARD_TYPES, CONDITION_VARIANTS,
  DELAYED_AT, EFFECT_VARIANTS, KEYWORDS, MOVE_ZONES, REFS, SCOPE_WHO, SET_ZONES, STATIC_VARIANTS, TARGET_KINDS,
  TRIGGER_VARIANTS,
} from '../src/cards/schema.js';
import { COVER_KINDS, DEFAULT_SCRIPTS_DIR, IGNORE_REASONS, ScriptStore } from '../src/cards/scripts.js';
import { defaultSources, stateOf } from '../src/cards/scriptState.js';
import { BASE_FAMILIES, isNamedKeyword, type Family } from '../src/cards/taxonomy.js';

export const VOCAB_FILE = (): string => path.join(DEFAULT_SCRIPTS_DIR(), 'VOCABULARY.md');

// ---------------------------------------------------------------------------
// Reading the zod barrel
// ---------------------------------------------------------------------------

/** One variant of a discriminated union: its literal and the fields it accepts (optional ones marked `?`). */
export interface VariantDoc { literal: string; fields: string[] }

interface ZodLike { _zod?: { def?: { type?: string } }; shape?: Record<string, ZodLike & { value?: unknown }>; value?: unknown }

const isOptional = (f: ZodLike | undefined): boolean => {
  const t = f?._zod?.def?.type;
  return t === 'optional' || t === 'default' || t === 'nullable';
};

/** Read `[{ op: z.literal('draw'), amount: … }]` into `{ literal: 'draw', fields: ['amount'] }`. */
export function variantDocs(variants: readonly unknown[], key: string): VariantDoc[] {
  const out: VariantDoc[] = [];
  for (const v of variants) {
    const shape = (v as ZodLike).shape ?? {};
    const literal = shape[key]?.value;
    if (typeof literal !== 'string') continue;
    const fields = Object.keys(shape).filter(k => k !== key).map(k => (isOptional(shape[k]) ? `${k}?` : k));
    out.push({ literal, fields });
  }
  return out.sort((a, b) => (a.literal < b.literal ? -1 : a.literal > b.literal ? 1 : 0));
}

const table = (rows: string[][], head: string[]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');

const codeList = (xs: readonly string[]): string => [...xs].sort().map(x => `\`${x}\``).join(' · ');

function variantTable(variants: readonly unknown[], key: string, what: string): string {
  const docs = variantDocs(variants, key).filter(d => d.literal !== 'unknown');
  return [
    `${docs.length} ${what} (the \`unknown\` marker is deliberately not listed — a finished script may never contain one):`,
    '',
    table(docs.map(d => [`\`${d.literal}\``, d.fields.length ? d.fields.map(f => `\`${f}\``).join(', ') : '—']), [key, 'fields (`?` = optional)']),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Prose and examples
// ---------------------------------------------------------------------------

const VOCAB_DOCS_DIR = (): string => path.join(projectRoot(), 'docs', 'vocabulary');

/** The family prose files, sorted; README.md is the authoring guide, not a family. */
export function proseFiles(dir = VOCAB_DOCS_DIR()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').sort();
}

/** Read a markdown file with its H1 dropped and every remaining heading demoted one level. */
function demoted(file: string): string {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return raw.split('\n').filter(l => !/^# /.test(l)).map(l => (/^#{1,5} /.test(l) ? '#' + l : l)).join('\n').trim();
}

/** Everything between one heading and the next heading of the same or a higher level. */
export function sectionOf(md: string, heading: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(l => l.trim() === heading);
  if (start < 0) return '';
  const level = (heading.match(/^#+/) ?? ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

/**
 * The blind scenario author's cheat sheet: sections 1–6 of test/scenarios/README.md (the shape of a scenario, seat
 * setup, script steps, expectations, safe helper cards, conventions). Section 7 is about running the suites, which
 * a batch agent is told separately.
 */
export function dslCheatSheet(file = path.join(projectRoot(), 'test', 'scenarios', 'README.md')): string {
  if (!fs.existsSync(file)) return '';
  const md = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const from = md.indexOf('\n## 1. ');
  const to = md.indexOf('\n## 7. ');
  if (from < 0) return md.trim();
  return md.slice(from, to < 0 ? undefined : to).trim();
}

/** The generated document's own section heading for one taxonomy family. */
const familyHeading = (f: Family): string => `## Family — ${f}`;

/**
 * The excerpt `scripts:queue` embeds in a batch: the core vocabulary (every op an author may use) plus the family's
 * own section when the document has one. Read from the GENERATED file, so a batch can never quote a vocabulary the
 * checker does not implement; regenerate with `npm run vocab:doc` before queueing a wave.
 */
export function vocabularyExcerpt(family: Family, file = VOCAB_FILE()): string {
  if (!fs.existsSync(file)) return `data/scripts/VOCABULARY.md is missing — run \`npm run vocab:doc\` before queueing.`;
  const md = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const core = sectionOf(md, '## Core vocabulary');
  const fam = sectionOf(md, familyHeading(family)) || (isNamedKeyword(family) ? sectionOf(md, familyHeading('other')) : '');
  return [core, fam].filter(Boolean).join('\n\n');
}

/** Up to `n` judged (or human-reviewed) scripts that use `op`, as pretty JSON. Empty until a wave is judged. */
function judgedExamplesByOp(n = 2): Map<string, { name: string; json: string }[]> {
  const out = new Map<string, { name: string; json: string }[]>();
  const store = new ScriptStore();
  const sources = defaultSources({ scripts: store });
  for (const id of store.ids().sort()) {
    const script = store.get(id);
    if (!script) continue;
    let judged = false;
    try { const st = stateOf(id, { ...sources, script }); judged = st.state === 'judged' || st.state === 'reviewed'; } catch { judged = false; }
    if (!judged) continue;
    const json = JSON.stringify(script, null, 2);
    for (const op of opsUsed(script)) {
      const list = out.get(op) ?? [];
      if (list.length < n) { list.push({ name: script.name, json }); out.set(op, list); }
    }
  }
  return out;
}

/** Every `op` / `kind` / `on` literal that appears anywhere in a script. */
export function opsUsed(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const v of value) opsUsed(v, into); return into; }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of ['op', 'kind', 'on']) if (typeof o[k] === 'string') into.add(o[k] as string);
    for (const v of Object.values(o)) opsUsed(v, into);
  }
  return into;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export function renderVocabulary(): string {
  const effects = variantDocs(EFFECT_VARIANTS, 'op').filter(d => d.literal !== 'unknown');
  const examplesByOp = judgedExamplesByOp();
  const families = MODULES.map(m => m.name).sort();
  const prose = proseFiles();
  const scriptsDir = DEFAULT_SCRIPTS_DIR();

  const out: string[] = [];
  out.push('<!-- GENERATED by scripts/vocab-doc.ts — do not edit. Run `npm run vocab:doc`. -->');
  out.push('# Script vocabulary');
  out.push('');
  out.push('Everything a per-card script may say, generated from the strict schema the checker uses');
  out.push('(`src/cards/schema.ts`), the registered mechanic families (`src/engine/ops/_registry.ts`) and the family');
  out.push('prose under `docs/vocabulary/`. **If an op is not in this file it does not exist**: do not invent one, and');
  out.push('never leave an `unknown` in a finished script — record the gap in `blocked[]` / `needs[]` instead.');
  out.push('');
  out.push('Read `data/scripts/README.md` first: it owns the *accounting* rules (how a line is claimed, the ability');
  out.push('budget, `covers` kinds, `ignore` reasons). This file owns the *vocabulary*.');
  out.push('');

  out.push('## Core vocabulary');
  out.push('');
  out.push('These unions are the core AST (`src/cards/types.ts`, mirrored strictly by `src/cards/schema.ts`). Every');
  out.push('mechanic family adds to them; nothing ever removes from them.');
  out.push('');
  out.push('### Effects (`Effect.op`)');
  out.push('');
  out.push(variantTable(EFFECT_VARIANTS, 'op', 'effect ops'));
  out.push('');
  out.push('### Conditions (`Condition.kind`)');
  out.push('');
  out.push(variantTable(CONDITION_VARIANTS, 'kind', 'conditions'));
  out.push('');
  out.push('### Trigger events (`TriggerEvent.on`)');
  out.push('');
  out.push(variantTable(TRIGGER_VARIANTS, 'on', 'trigger events'));
  out.push('');
  out.push('### Static effects (`StaticEffect.kind`)');
  out.push('');
  out.push(variantTable(STATIC_VARIANTS, 'kind', 'static effects'));
  out.push('');
  out.push('### Enumerations');
  out.push('');
  out.push(table([
    ['`Ability.kind`', codeList(['spell', 'triggered', 'activated', 'static'])],
    ['`Keyword`', codeList(KEYWORDS)],
    ['`TargetSpec.kind`', codeList(TARGET_KINDS)],
    ['`Amount.count`', codeList(AMOUNT_COUNTS)],
    ['`Amount.prop`', codeList(AMOUNT_PROPS)],
    ['`Ref`', codeList([...REFS, 'target:<n>'])],
    ['`ScopeWho`', codeList(SCOPE_WHO)],
    ['`ObjectSet.zone`', codeList(SET_ZONES)],
    ['`move.to`', codeList(MOVE_ZONES)],
    ['`delayed-trigger.at`', codeList(DELAYED_AT)],
    ['`AltCost.id`', codeList(ALT_COST_IDS)],
    ['`AltCost.from`', codeList(ALT_COST_FROM)],
    ['`AbilityCost` keys', codeList(Object.keys(AbilityCostSchema.shape))],
    ['`CardType`', codeList(CARD_TYPES)],
    ['`covers[].by`', codeList(COVER_KINDS)],
    ['`ignore[].reason`', codeList(IGNORE_REASONS)],
  ], ['union', 'values']));
  out.push('');

  out.push('## Mechanic families');
  out.push('');
  if (families.length) {
    out.push('Registered right now (`src/engine/ops/_registry.ts`):');
    out.push('');
    out.push(families.map(f => `- \`${f}\``).join('\n'));
  } else {
    out.push('No mechanic family is registered yet: the whole vocabulary above is the core union (the composition');
    out.push('core of plan 1.4 landed in the core AST rather than in a family file). Phase 9.1+ adds family modules');
    out.push('under `src/engine/ops/<family>.ts`, and each one appears here after `npm run gen:registry`.');
  }
  out.push('');

  out.push('## Examples');
  out.push('');
  const opsWithExamples = effects.filter(e => (examplesByOp.get(e.literal) ?? []).length);
  if (opsWithExamples.length) {
    out.push('Two judged scripts per op (the nearest thing to a style guide there is):');
    out.push('');
    for (const e of opsWithExamples) {
      out.push(`### \`${e.literal}\``);
      out.push('');
      for (const ex of examplesByOp.get(e.literal)!) {
        out.push(`**${ex.name}**`);
        out.push('');
        out.push('```json');
        out.push(ex.json);
        out.push('```');
        out.push('');
      }
    }
  } else {
    out.push('No script has been judged yet, so there are no per-op examples. The two worked examples of the format');
    out.push('are these (they are also on disk as `data/scripts/_example.json.txt` and `_example-split.json.txt`);');
    out.push('the family prose below carries a snippet per op.');
    out.push('');
    for (const f of ['_example.json.txt', '_example-split.json.txt']) {
      const file = path.join(scriptsDir, f);
      if (!fs.existsSync(file)) continue;
      out.push(`### \`${f}\``);
      out.push('');
      out.push('```json');
      out.push(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim());
      out.push('```');
      out.push('');
    }
  }

  // one section per taxonomy family, so `scripts:queue` always finds a heading to excerpt for a batch
  out.push('## Families of the queue');
  out.push('');
  out.push('`scripts:queue` groups a wave by the taxonomy of `src/cards/taxonomy.ts`. Each batch carries the section');
  out.push('for its own family plus the core vocabulary above.');
  out.push('');
  for (const f of [...BASE_FAMILIES].sort()) {
    out.push(familyHeading(f));
    out.push('');
    out.push(FAMILY_NOTES[f]);
    out.push('');
  }

  out.push('## Family prose');
  out.push('');
  if (!prose.length) out.push('_No `docs/vocabulary/<family>.md` yet._');
  for (const f of prose) {
    out.push(`### ${f}`);
    out.push('');
    out.push(demoted(path.join(VOCAB_DOCS_DIR(), f)));
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * What a batch of each taxonomy family is really being asked for. Hand-written prose ABOUT the generated grouping —
 * it is data in this file rather than a doc, so the generated document stays reproducible from source alone.
 */
const FAMILY_NOTES: Record<(typeof BASE_FAMILIES)[number], string> = {
  generic: 'Ordinary composition: destroy / exile / counter / draw / discard / search / tokens / damage / life / counters / tap / mana. Everything here is expressible with the core vocabulary above — if one of these cards seems to need a new op, re-read the effect table before writing a `needs[]` entry.',
  control: 'Control of a permanent changes hands (`exchange` with `what: "control"`, or a `gain-control` clause). Control changes with a DURATION ("until end of turn") are a 9.1 family and are not expressible yet: block those.',
  'cost-alter': 'Cost adjustments and alternative / free casts. `costModifiers` (`delve`, `convoke`, `improvise`, `reduce`) and `altCosts` cover the printed keywords; a static that changes what OTHER spells cost is `cost-adjust`. Permissions to cast from another zone are a 9.1 family.',
  'combat-restr': 'Combat restrictions and requirements: "can\'t be blocked except by", "blocks if able", "attacks each combat if able", extra combats. Only the shapes in the static table exist today; the rest is a 9.1 family.',
  replacement: 'Replacement and prevention ("if … would …, instead", shields, "enters with an additional counter"). The generic `{ would, instead }` form is a 9.1 family; only the specific statics listed above exist today.',
  'keyword-action': 'CR 701 keyword actions (investigate, surveil, explore, proliferate, mill, amass, connive, …). Several already have ops; the rest are the 9.1 keyword-actions bundle.',
  'piles-choices': 'Piles, votes and opponent-made choices. A decision the OPPONENT makes needs a `Decision`, which is 9.1 work; a choice the controller makes is often `choose-mode` or `may` today.',
  'copy-clone': 'Copying spells and permanents, and clones. `token-copy` exists; copying a SPELL on the stack and "you may choose new targets for the copy" are 9.1.',
  layers: 'Type / colour / base-P-T changes and ability loss. `set-pt` and `lose-abilities` exist (composition core); type and colour changes with durations are 9.1 layers-lite.',
  transform: 'Transform / meld / day-night. `transform-self` exists; a trigger that transforms another permanent, and meld, are 9.1.',
  planeswalker: 'Loyalty abilities and emblems. Activated abilities with a loyalty cost and `pl.ext.emblems` are a 9.1 family — most of these cards are blocked today.',
  'dice-coin': 'Die rolls and coin flips on `g.rng`. A 9.1 family: block these and record the need.',
  saga: 'Saga chapters and lore counters. A 9.1 family: block these and record the need.',
  other: 'No classifier rule matched the wording. Read the line carefully: it is usually ordinary composition with an unusual phrasing, and only occasionally a genuinely new mechanic. When it is new, `needs[]` must name the family you would build.',
};

function main() {
  const md = renderVocabulary();
  const file = VOCAB_FILE();
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
    if (have === md) { console.log(`vocab:doc --check: ${path.relative(projectRoot(), file)} is up to date`); return; }
    console.error(`vocab:doc --check: ${path.relative(projectRoot(), file)} is stale — run npm run vocab:doc`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md);
  console.log(`wrote ${path.relative(projectRoot(), file).split(path.sep).join('/')} (${md.split('\n').length} lines)`);
}

// run only as a CLI: `scripts:queue` imports `vocabularyExcerpt` / `dslCheatSheet` from here
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
