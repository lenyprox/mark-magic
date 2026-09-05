// Draft per-card scripts (B7 generator, first step): for cards the parser does not fully simulate, write a
// `generated` script under data/scripts/drafts/ carrying everything the parser understood plus the unparsed clauses
// as `unknown` effects, so a person (or an LLM pass verified by scenarios and the sandbox) can complete it and move
// it to data/scripts/<oracle_id>.json as `reviewed`. Never overwrites reviewed/hand scripts.
//   npm run scripts:draft -- [--limit N] [--name "Card"] [--format modern|commander] [--min-plays N] [--out dir]
//
// `draftScript(def)` is the generator itself, exported so `scripts:queue` can put the same draft into a batch file
// without writing anything to disk (plan 2.8: "parser draft" is one of the facts an author receives). Everything
// below the `main()` guard is the CLI.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { CardDB } from '../src/cards/db.js';
// data/scripts is TRACKED, so it is resolved from this checkout (DEFAULT_SCRIPTS_DIR) and never through DATA_DIR(),
// which falls back to the main checkout for the gitignored databases.
import { DEFAULT_SCRIPTS_DIR, oracleHash, ScriptStore, type CardScript } from '../src/cards/scripts.js';
import type { CardDef } from '../src/cards/types.js';

/**
 * The parser's draft of one card: everything it understood, plus each unparsed clause as an `unknown` spell ability
 * so a reader sees exactly what is missing and where. `mode: 'replace'` and `confidence: 0.3` mark it as a draft —
 * `ScriptStore.put()` lets any other source overwrite a `generated` script.
 */
export function draftScript(def: CardDef): CardScript {
  const script: CardScript = {
    oracleId: def.oracleId, name: def.name, oracleHash: oracleHash(def.oracleText), source: 'generated', confidence: 0.3, mode: 'replace',
    keywords: def.keywords, abilities: def.abilities, altCosts: def.altCosts, asEnters: def.asEnters, costModifiers: def.costModifiers,
    covers: [], notes: `DRAFT — unparsed: ${def.unparsed.join(' | ')}`,
  };
  // the unparsed lines stay visible as unknown spell effects so a reviewer sees exactly what is missing
  script.abilities = [...(script.abilities ?? []), ...def.unparsed.map(u => ({ kind: 'spell' as const, effects: [{ op: 'unknown' as const, text: u }], text: u }))];
  return script;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const limit = Number(opt('--limit') ?? '200'); const only = opt('--name');
  const outDir = opt('--out') ?? path.join(DEFAULT_SCRIPTS_DIR(), 'drafts');
  const canonical = new ScriptStore();
  fs.mkdirSync(outDir, { recursive: true });

  const cards = CardDB.shared();
  let n = 0, skipped = 0;
  for (const def of cards.all()) {
    if (only && def.name !== only) continue;
    if (def.fullyParsed) continue;
    if (canonical.get(def.oracleId) && canonical.get(def.oracleId)!.source !== 'generated') { skipped++; continue; }
    if (n >= limit) break;
    const script = draftScript(def);
    fs.writeFileSync(path.join(outDir, `${def.oracleId}.json`), JSON.stringify({ ...script, oracleText: def.oracleText, typeLine: def.typeLine }, null, 2) + '\n');
    n++;
  }
  console.log(`wrote ${n} draft script(s) to ${outDir}${skipped ? `, skipped ${skipped} with reviewed/hand scripts` : ''}`);
  cards.close();
}

// run only as a CLI: `scripts:queue` imports `draftScript` and must not draft the whole pool as a side effect
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) main();
