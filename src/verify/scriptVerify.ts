// The seven-stage mechanical gate for card scripts (plan 2.2). `scripts/scripts-verify.ts` is the CLI around it;
// `test/scripts-verify.test.ts` drives `verifyCards` directly over fixture scripts in a temp directory.
//
// A failure at any stage RECORDS A PROBLEM AND CONTINUES, so one run tells the author everything that is wrong with
// the script rather than the first thing. Schema is the exception: nothing downstream can be trusted about a file
// that does not parse, so a schema failure stops that card.
//
//   1 SCHEMA      `CardScriptChecked` (strict zod + the covers refinement + the composition nesting limits)
//   2 FRESHNESS   oracleHash vs the card's text today; parserVersion / registryHash / scriptHash vs the last run
//   3 REGISTRY    every op / kind / on / count is in a core union or a family registry; no `unknown` outside a
//                 `generated` script; `applyScript(def).fullyParsed` — the line-claim accounting really finishes
//   4 LINT        src/cards/lint.ts (counters, subtypes, keywords, target kinds, amount counts, covers, ignore,
//                 impossible triggers, aiHints.role)
//   5 SANDBOX     src/verify/sandbox.ts `trialCard` at 2 and 4 seats, then src/verify/probes.ts per-ability
//                 reachability. An unreached ability is a WARNING for the blind-scenario author, never a failure.
//   6 ROUND-TRIP  src/cards/render.ts: the rendering of the ability that claims a line against the line itself
//   7 WRITE-BACK  the `verification` block into the script file (minus `scenarios` / `judge`, which are other
//                 slices' to write), and the batch report data/scripts/reports/<batch>.json
import fs from 'node:fs';
import path from 'node:path';
import { CardDB } from '../cards/db.js';
import { lintScript } from '../cards/lint.js';
import { PARSER_VERSION, parseCard } from '../cards/parse.js';
import { tierOf, type PoolTier } from '../cards/pool.js';
import { scoreCard, type LineScore } from '../cards/render.js';
import { CardScriptChecked } from '../cards/schema.js';
import {
  applyScript, DEFAULT_SCRIPTS_DIR, hasUnknown, oracleHash, ScriptStore, scriptHash, secondFaceOf, secondFaceUnclaimed,
  type CardScript, type ScriptFace, type Verification,
} from '../cards/scripts.js';
import { EFFECT_OP_VOCAB, TRIGGER_VOCAB, CONDITION_VOCAB, STATIC_VOCAB, AS_ENTERS_VOCAB, COST_MODIFIER_VOCAB, TARGET_KIND_VOCAB, AMOUNT_COUNT_VOCAB } from '../cards/lint.js';
import type { CardDef } from '../cards/types.js';
import { registryHash } from '../engine/ops/_registry.js';
import { probeAbilities, unreachable, type AbilityProbe } from './probes.js';
import { trialCard, type Seats, type Verdict } from './sandbox.js';

/** The round-trip score a card must reach to be called `verified` (plan 2.2 stage 6). */
export const ROUND_TRIP_PASS = 0.55;
/** A line below this is listed in `verification.roundTrip.lowest` for the judge and the scenario author. */
export const ROUND_TRIP_LOW = 0.4;

export interface VerifyOptions {
  /** Scripts directory (a temp dir in tests); defaults to data/scripts. */
  dir?: string;
  /** An open CardDB to reuse; one is opened (and left open) otherwise. */
  cards?: CardDB;
  /** Seat counts the sandbox trials, in order. Default [2, 4]. */
  seats?: Seats[];
  /**
   * Skip stage 5 entirely (the tests that only care about schema / round-trip, and `--no-sandbox` on the CLI). The
   * skip is RECORDED as a problem, so a card whose sandbox never ran can never come out `verified`.
   */
  skipSandbox?: boolean;
  /** Write the `verification` block back into the script file. Default true. */
  write?: boolean;
  /** Batch name for the report (`data/scripts/reports/<batch>.json`); no report is written without it. */
  batch?: string;
  /** Where the report goes; defaults to `<dir>/reports/<batch>.json`. */
  reportPath?: string;
  /**
   * The sandbox trial to run. Only the tests pass one — it is how `test/scripts-verify.test.ts` reaches the
   * `sandbox: 'throws'` branch without an engine bug to reproduce.
   */
  trial?: typeof trialCard;
}

/** One card's row in the batch report — exactly the shape plan 2.2 stage 7 names. */
export interface CardReport {
  oracleId: string;
  name: string;
  status: Verification['status'] | 'stale' | 'missing';
  schema: 'ok' | 'fail';
  lint: 'ok' | 'warn' | 'fail';
  sandbox: Verification['sandbox'];
  roundTrip: { score: number; lowest: LineScore[] };
  problems: string[];
  warnings: string[];
  /** ops the renderer has no template for — a family that shipped ops without a `render` entry. */
  rendererGaps: string[];
  ms: number;
}

export interface VerifyReport {
  batch: string;
  at: string;
  parserVersion: number;
  registryHash: string;
  cards: CardReport[];
  summary: { total: number; verified: number; scripted: number; stale: number; missing: number; problems: number; unreached: number; ms: number };
}

const EMPTY_SANDBOX: Verification['sandbox'] = { seats2: 'unreachable', seats4: 'unreachable', abilities: [] };

/** `trialCard`'s verdict as the `verification.sandbox` enum (`skipped` counts as unreachable: nothing ran). */
function sandboxVerdict(v: Verdict): Verification['sandbox']['seats2'] {
  return v === 'sandbox-ok' ? 'ok' : v === 'sandbox-throws' ? 'throws' : v === 'invariant-violation' ? 'invariant' : 'unreachable';
}

/** Walk every object in a value (the registry stage's vocabulary sweep). */
function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) { for (const v of value) walk(v, visit); return; }
  if (!value || typeof value !== 'object') return;
  visit(value as Record<string, unknown>);
  for (const v of Object.values(value as Record<string, unknown>)) walk(v, visit);
}

const ABILITY_KINDS = new Set(['triggered', 'activated', 'static', 'spell']);

/**
 * Stage 3: every discriminator the script uses is one the ENGINE can dispatch on. The zod schema already rejects an
 * op it has never heard of — the composed schema (src/cards/schema.ts) knows every family's `<family>.schema.ts`
 * — but a family's schema and its engine module are two files, and a family registered at run time only
 * (`registerFamily`) has no schema at all, so the registries are consulted here as well: this is the stage that
 * tells a script written against a family whose engine half is not installed on this machine from one that is.
 */
function registryProblems(script: CardScript): string[] {
  const out: string[] = [];
  const faces: [string, ScriptFace | undefined][] = [['', script], ['backFace: ', script.backFace], ['secondFace: ', script.secondFace]];
  for (const [where, face] of faces) {
    if (!face) continue;
    walk(face, node => {
      const op = typeof node.op === 'string' ? node.op : undefined;
      const on = typeof node.on === 'string' ? node.on : undefined;
      const kind = typeof node.kind === 'string' ? node.kind : undefined;
      if (op && !EFFECT_OP_VOCAB.has(op)) out.push(`${where}no engine op '${op}' is registered`);
      if (on && !TRIGGER_VOCAB.has(on)) out.push(`${where}no trigger event '${on}' is registered`);
      if (kind && !CONDITION_VOCAB.has(kind) && !STATIC_VOCAB.has(kind) && !AS_ENTERS_VOCAB.has(kind)
        && !COST_MODIFIER_VOCAB.has(kind) && !TARGET_KIND_VOCAB.has(kind) && !ABILITY_KINDS.has(kind)) {
        out.push(`${where}no condition / static / as-enters / cost modifier / target kind '${kind}' is registered`);
      }
      if (typeof node.count === 'string' && node.filter === undefined && !AMOUNT_COUNT_VOCAB.has(node.count)) out.push(`${where}no amount count '${node.count}' is registered`);
    });
  }
  return out;
}

/** The oracle row and the PARSER-ONLY def for one oracle id — never a whole-pool scan, however many ids there are. */
function loadCard(cards: CardDB, oracleId: string): { row: Record<string, unknown>; def: CardDef; tier: PoolTier } | null {
  const row = cards.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as { json: string } | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.json) as Record<string, unknown>;
  const def = parseCard({ ...raw, representative_id: raw.representative_id ?? raw.id ?? null } as never);
  return { row: raw, def, tier: tierOf(raw as never) };
}

/**
 * Run the seven stages over `ids` and return the batch report. Nothing is written unless `opts.write !== false`
 * (the `verification` block) and `opts.batch` is set (the report file).
 */
export async function verifyCards(ids: string[], opts: VerifyOptions = {}): Promise<VerifyReport> {
  const t0 = Date.now();
  const dir = opts.dir ?? DEFAULT_SCRIPTS_DIR();
  const store = new ScriptStore(dir);
  const cards = opts.cards ?? CardDB.shared();
  const seats = opts.seats ?? [2, 4];
  const rHash = registryHash();
  const at = new Date().toISOString();
  const rows: CardReport[] = [];

  for (const oracleId of ids) {
    const cardStart = Date.now();
    const problems: string[] = [];
    const warnings: string[] = [];
    const row: CardReport = {
      oracleId, name: oracleId, status: 'missing', schema: 'fail', lint: 'fail',
      sandbox: { ...EMPTY_SANDBOX, abilities: [] }, roundTrip: { score: 0, lowest: [] }, problems, warnings,
      rendererGaps: [], ms: 0,
    };
    rows.push(row);
    const finish = () => { row.ms = Date.now() - cardStart; };

    const file = store.fileOf(oracleId);
    if (!file) { problems.push(`no script file for ${oracleId} under ${dir}`); finish(); continue; }
    const loaded = loadCard(cards, oracleId);
    if (!loaded) { problems.push(`no card with oracle id ${oracleId} in master.db`); finish(); continue; }
    const { def, tier } = loaded;
    row.name = def.name;

    // ---- 1. schema (strict; a failure stops this card) -----------------------------------------------------
    const rawText = fs.readFileSync(file, 'utf8');
    if (rawText.includes('\r')) problems.push('the file contains CR — scripts are LF only');
    let parsed: unknown;
    try { parsed = JSON.parse(rawText); } catch (e) { problems.push(`not valid JSON (${(e as Error).message})`); finish(); continue; }
    const res = CardScriptChecked.safeParse(parsed);
    if (!res.success) {
      for (const iss of res.error.issues.slice(0, 8)) problems.push(`schema — ${iss.path.join('.') || '(root)'}: ${iss.message}`);
      row.status = 'scripted';
      finish();
      continue;
    }
    const script: CardScript = res.data;
    row.schema = 'ok';
    if (script.oracleId !== oracleId) problems.push(`oracleId ${script.oracleId} does not match the file name`);

    // ---- 2. freshness --------------------------------------------------------------------------------------
    const fresh = oracleHash(def.oracleText);
    const stale = script.oracleHash !== fresh;
    if (stale) problems.push(`stale: the oracle text changed since the script was written (hash ${fresh}, script says ${script.oracleHash}) — the script is NOT applied`);
    const prev = script.verification;
    if (prev) {
      if (prev.parserVersion !== PARSER_VERSION) warnings.push(`the last verification ran on parserVersion ${prev.parserVersion} (now ${PARSER_VERSION})`);
      if (prev.registryHash !== rHash) warnings.push(`the last verification ran on registryHash ${prev.registryHash} (now ${rHash})`);
      if (prev.scriptHash !== scriptHash(script)) warnings.push('the script changed since it was last verified');
    }

    // ---- 3. registry ---------------------------------------------------------------------------------------
    for (const why of registryProblems(script)) problems.push(why);
    if (script.source !== 'generated' && (hasUnknown(script as unknown) )) problems.push(`a '${script.source}' script may not contain an unknown effect / static / trigger / condition`);
    const applied = stale ? def : applyScript(def, script, tier);
    if (!applied.fullyParsed) {
      const second = secondFaceUnclaimed(def, script);
      const where = applied.unparsed.length ? `unclaimed: ${applied.unparsed.slice(0, 3).join(' | ')}`
        : applied.backFace && !applied.backFace.fullyParsed ? `back face unclaimed: ${applied.backFace.unparsed.slice(0, 3).join(' | ')}`
        : second.length ? `second face unclaimed: ${second.slice(0, 3).join(' | ')}`
        : 'nothing is unclaimed, but something in the card is still unknown';
      problems.push(`applyScript does not make the card fully simulated (${where})`);
    }

    // ---- 4. lint -------------------------------------------------------------------------------------------
    const lint = lintScript(script, def, tier);
    row.lint = lint.level;
    for (const p of lint.problems) problems.push(`lint: ${p}`);
    for (const w of lint.warnings) warnings.push(`lint: ${w}`);

    // ---- 5. sandbox and per-ability reachability -----------------------------------------------------------
    // A SKIPPED trial is recorded as a PROBLEM, not passed over. `verification.sandbox` has one enum for "the trial
    // ran and reached nothing" and for "no trial ran" (`unreachable`; the enum lives in the schema this slice does
    // not own — see openIssues), and `staleIds` compares only the parser version, the registry hash and the script
    // hash, all of which a `--no-sandbox` run leaves matching. So without this a `--no-sandbox` run minted
    // `status: "verified"` for a card stage 5 never touched and `--stale` never looked at it again.
    if (opts.skipSandbox) problems.push('the sandbox stage was skipped (--no-sandbox): no seat trial and no reachability probe ran, so this card is not verified');
    else for (const n of ([2, 4] as Seats[])) {
      if (!seats.includes(n)) problems.push(`the ${n}-seat sandbox trial was not run (--seats ${seats.join(',')}): 'unreachable' here means "not tried", not "tried and nothing happened"`);
    }
    if (!opts.skipSandbox) {
      const verdicts: Partial<Record<Seats, Verification['sandbox']['seats2']>> = {};
      for (const n of seats) {
        try {
          const trial = await (opts.trial ?? trialCard)(cards, applied, { seats: n });
          verdicts[n] = sandboxVerdict(trial.verdict);
          if (trial.verdict === 'sandbox-throws') problems.push(`sandbox (${n} seats) threw: ${trial.detail ?? ''}`);
          if (trial.verdict === 'invariant-violation') problems.push(`sandbox (${n} seats) broke an invariant: ${trial.detail ?? ''}`);
        } catch (e) {
          verdicts[n] = 'throws';
          problems.push(`sandbox (${n} seats) threw: ${(e as Error).message}`);
        }
      }
      let probes: AbilityProbe[] = [];
      try { probes = await probeAbilities(cards, applied); }
      catch (e) { problems.push(`the reachability probes threw: ${(e as Error).message}`); }
      row.sandbox = { seats2: verdicts[2] ?? 'unreachable', seats4: verdicts[4] ?? 'unreachable', abilities: probes };
      for (const w of unreachable(probes, applied.abilities)) warnings.push(w);
    }

    // ---- 6. round trip -------------------------------------------------------------------------------------
    // EVERY face, `secondFace` included. A split / adventure / flip card's second half has no `CardDef` (the parser
    // records its lines as unparsed and only `script.secondFace` claims them), so it reaches the renderer from the
    // script; without it the numbers hard-gate — the whole point of stage 6 — never saw half of those cards, and a
    // `secondFace` that drew 9 cards for a line printing "Draw a card." verified at 1.00.
    const second = secondFaceOf(def);
    let scored: ReturnType<typeof scoreCard>;
    try {
      scored = scoreCard(
        { ...applied, covers: script.covers },
        second && script.secondFace ? { face: script.secondFace, name: second.name } : null,
      );
    } catch (e) {
      // one unrenderable card is that card's problem, never a dead batch (8c re-review 2)
      problems.push(`the renderer threw: ${(e as Error).message}`);
      scored = { score: 0, lines: [], gaps: ['renderer:threw'] } as unknown as ReturnType<typeof scoreCard>;
    }
    row.roundTrip = { score: scored.score, lowest: scored.lines.filter(l => l.score < ROUND_TRIP_LOW).sort((a, b) => a.score - b.score) };
    row.rendererGaps = scored.gaps;
    if (scored.score < ROUND_TRIP_PASS) problems.push(`round trip ${scored.score.toFixed(2)} < ${ROUND_TRIP_PASS}: ${scored.lines.filter(l => l.score === scored.score).slice(0, 2).map(l => `${JSON.stringify(l.text)} rendered as ${JSON.stringify(l.rendered)}`).join('; ')}`);
    if (scored.gaps.length) warnings.push(`no renderer for ${scored.gaps.join(', ')} — the round-trip score for those lines is a lower bound`);

    // ---- 7. write back -------------------------------------------------------------------------------------
    const passed = problems.length === 0;
    row.status = stale ? 'stale' : passed ? 'verified' : 'scripted';
    const verification: Verification = {
      at, parserVersion: PARSER_VERSION, registryHash: rHash, oracleHash: fresh, scriptHash: scriptHash(script),
      schema: row.schema, lint: row.lint, sandbox: row.sandbox, roundTrip: { score: row.roundTrip.score, lowest: row.roundTrip.lowest.map(l => ({ text: l.text, rendered: l.rendered, score: l.score })) },
      // stage 8d owns `scenarios` and the judge slice owns `judge`: carry whatever is already there, never clear it
      scenarios: prev?.scenarios ?? { file: '', passed: 0, failed: 0, names: [] },
      ...(prev?.judge ? { judge: prev.judge } : {}),
      status: passed && !stale ? 'verified' : 'scripted',
      problems,
    };
    if (opts.write !== false) writeVerification(store, file, verification);
    finish();
  }

  const summary = {
    total: rows.length,
    verified: rows.filter(r => r.status === 'verified').length,
    scripted: rows.filter(r => r.status === 'scripted').length,
    stale: rows.filter(r => r.status === 'stale').length,
    missing: rows.filter(r => r.status === 'missing').length,
    problems: rows.reduce((n, r) => n + r.problems.length, 0),
    unreached: rows.reduce((n, r) => n + r.sandbox.abilities.filter(a => !a.reached).length, 0),
    ms: Date.now() - t0,
  };
  const report: VerifyReport = { batch: opts.batch ?? 'adhoc', at, parserVersion: PARSER_VERSION, registryHash: rHash, cards: rows, summary };
  if (opts.batch) writeReport(report, opts.reportPath ?? path.join(dir, 'reports', `${opts.batch}.json`));
  return report;
}

/**
 * Write the `verification` block back into THE FILE THAT WAS READ, LF, keys in a stable order, `verification` last —
 * and NEVER through `ScriptStore.put`, whose source precedence would refuse to overwrite a `hand` script with itself.
 * `scriptHash` excludes `verification`, so this write does not invalidate what it just recorded.
 *
 * The caller passes the path. Addressing the destination by the script's own `oracleId` FIELD instead — which is what
 * this did — is wrong whenever the field and the file name disagree, and they disagree exactly when the author made
 * the copy-paste mistake stage 1 reports: the run either died on an ENOENT for a file that was never opened (taking
 * the whole batch's report with it) or, when a script for the id in the field did exist, wrote THIS card's
 * verification block over THAT card's — silently demoting a verified script to `scripted` with a stranger's
 * problems. Plan 2.4 derives promotion state from these files, so that write is not recoverable by re-running.
 */
export function writeVerification(store: ScriptStore, file: string, verification: Verification): void {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete raw.verification;
  const next = { ...raw, verification };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2).replace(/\r\n/g, '\n') + '\n');
  store.reset();
}

/** The batch report. `data/scripts/reports/` is gitignored, so this is tool output, never a tracked artefact. */
export function writeReport(report: VerifyReport, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2).replace(/\r\n/g, '\n') + '\n');
}

// ---------------------------------------------------------------------------
// Id selection (the CLI's four modes)
// ---------------------------------------------------------------------------

/**
 * The oracle ids a batch file names. The 8k queue format is `{ manifest: { wave, batch }, cards: [{ oracleId, … }] }`,
 * but anything whose top level or `cards` / `ids` array carries oracle ids works, so this reads a batch written
 * before 8k lands (a bare array of ids, or of `{ oracleId }` objects) exactly as well.
 */
export function idsInBatch(json: unknown): string[] {
  const out: string[] = [];
  const take = (v: unknown) => {
    if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) { if (!out.includes(v)) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) take(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.oracleId === 'string') take(o.oracleId);
    else if (typeof o.oracle_id === 'string') take(o.oracle_id);
    for (const k of ['cards', 'ids', 'entries', 'items']) if (o[k] !== undefined) take(o[k]);
  };
  take(json);
  return out;
}

/** The batch name a report is filed under: `manifest.batch`, else the file's base name. */
export function batchNameOf(json: unknown, file: string): string {
  const m = (json as { manifest?: { batch?: unknown; wave?: unknown } } | null)?.manifest;
  const parts = [m?.wave, m?.batch].filter(v => typeof v === 'string' || typeof v === 'number').map(String);
  return parts.length ? parts.join('-') : path.basename(file).replace(/\.json$/, '');
}

/** Every script whose verification block is missing or stale (`--stale`). */
export function staleIds(store: ScriptStore, rHash = registryHash()): string[] {
  const out: string[] = [];
  for (const id of store.ids()) {
    const s = store.get(id);
    if (!s) continue;
    const v = s.verification;
    if (!v || v.parserVersion !== PARSER_VERSION || v.registryHash !== rHash || v.scriptHash !== scriptHash(s)) out.push(id);
  }
  return out;
}
