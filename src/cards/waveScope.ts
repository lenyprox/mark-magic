// Which cards the plan holds to the HIGHER bar (plan 2.4: "two judges by majority for the owner's decks and EDHREC
// top-1k, one elsewhere"). That is a property of the CARD, not of the wave that happens to be running: before this
// module `scripts:queue` decided it once per invocation, so the same card was `judged` under one tool and `tested`
// under another, and the "EDHREC top-1k" half was missing entirely.
//
// Everything here is derived from files: `decks/*.csv|*.txt` in the checkout and `printing_meta.edhrec_rank` in
// master.db. `scriptState.defaultSources()` installs `defaultJudgeRule()` so every reader — the queue, the promotion,
// the dashboard — asks the same question of the same card and gets the same answer.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config/paths.js';
import { parseCollectionText } from '../collection/formats.js';
import { CardDB, parseDeckList } from './db.js';

/** Faithful verdicts a card needs before it is `judged`. */
export type Judges = 1 | 2;
/** How many judges THIS card needs. `scriptState.StateSources.judges` accepts one of these or a bare count. */
export type JudgeRule = (oracleId: string) => Judges;

/** Plan 2.4's "EDHREC top-1k": rank 1…1000 of the card's representative printing. */
export const TWO_JUDGE_EDHREC_MAX = 1000;

export const DEFAULT_DECKS_DIR = (): string => path.join(projectRoot(), 'decks');

/**
 * The distinct cards of every decks/*.csv and decks/*.txt. A CSV is a collection sheet and a .txt an Arena/plain
 * deck list, exactly as `src/sim/deckRef.ts` decides; the commander inference that file does only moves a card
 * between boards, so the DISTINCT set is the same and is not re-run here. Maybeboard entries are excluded.
 */
export function ownerDeckIds(db: CardDB, dir = DEFAULT_DECKS_DIR()): { ids: string[]; missing: string[] } {
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

/** Oracle ids whose representative printing is ranked `<= max` on EDHREC. */
export function edhrecTopIds(db: CardDB, max = TWO_JUDGE_EDHREC_MAX): Set<string> {
  const rows = db.db.prepare(
    'SELECT o.oracle_id AS id FROM oracle_cards o JOIN printing_meta m ON m.printing_id = o.representative_id WHERE m.edhrec_rank IS NOT NULL AND m.edhrec_rank <= ?',
  ).all(max) as { id: string }[];
  return new Set(rows.map(r => r.id));
}

/** Every card that needs two faithful verdicts: the owner's decks plus the EDHREC top-`edhrecMax`. */
export function twoJudgeIds(db: CardDB, opts: { decksDir?: string; edhrecMax?: number } = {}): Set<string> {
  const out = edhrecTopIds(db, opts.edhrecMax ?? TWO_JUDGE_EDHREC_MAX);
  for (const id of ownerDeckIds(db, opts.decksDir ?? DEFAULT_DECKS_DIR()).ids) out.add(id);
  return out;
}

/** A rule over an explicit id set — what the unit tests use, and what `defaultJudgeRule` wraps. */
export function judgeRuleOver(twoJudge: ReadonlySet<string>): JudgeRule {
  return (oracleId: string) => (twoJudge.has(oracleId) ? 2 : 1);
}

let cached: { db: CardDB; rule: JudgeRule } | null = null;

/**
 * The real rule, built once per process from the checkout's decks and master.db. Lazy on purpose: a caller that
 * never reaches the judge rung of the ladder (every unit test that works on fixtures alone) never opens the database.
 */
export function defaultJudgeRule(dbOf: () => CardDB): JudgeRule {
  return (oracleId: string) => {
    const db = dbOf();
    if (!cached || cached.db !== db) cached = { db, rule: judgeRuleOver(twoJudgeIds(db)) };
    return cached.rule(oracleId);
  };
}

/** Drop the memoised rule (a test that swaps the database, or a long-lived process after a re-import). */
export function resetJudgeRule(): void { cached = null; }
