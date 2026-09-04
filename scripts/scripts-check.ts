// Validate every script under data/scripts: JSON shape, oracle hash freshness (stale after a Scryfall refresh),
// no `unknown` effects in reviewed/hand scripts, and that the scripted card resolves in master.db.
// Exit 1 on problems.   npm run scripts:check
import { CardDB } from '../src/cards/db.js';
import { applyScript, oracleHash, ScriptStore } from '../src/cards/scripts.js';
import { parseCard } from '../src/cards/parse.js';

const cards = CardDB.shared();
const store = new ScriptStore();
let ok = 0; const problems: string[] = [];
for (const id of store.ids()) {
  const script = store.get(id);
  if (!script) { problems.push(`${id}: not valid JSON`); continue; }
  if (script.oracleId !== id) problems.push(`${id}: oracleId ${script.oracleId} does not match the file name`);
  const row = cards.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(id) as { json: string } | undefined;
  if (!row) { problems.push(`${id}: no such card in master.db`); continue; }
  const raw = JSON.parse(row.json);
  const def = parseCard({ ...raw, representative_id: raw.representative_id ?? raw.id ?? null });
  if (script.oracleHash !== oracleHash(def.oracleText)) problems.push(`${id} (${script.name}): stale — oracle text changed (hash ${oracleHash(def.oracleText)})`);
  const applied = applyScript(def, script);
  const unknowns = applied.abilities.flatMap(a => 'effects' in a ? a.effects.filter(e => e.op === 'unknown') : []);
  if (script.source !== 'generated' && unknowns.length) problems.push(`${id} (${script.name}): ${script.source} script still has ${unknowns.length} unknown effect(s)`);
  if (script.source !== 'generated' && !applied.fullyParsed) problems.push(`${id} (${script.name}): ${script.source} script does not make the card fully simulated`);
  ok++;
}
console.log(`${ok} script(s) checked, ${problems.length} problem(s)`);
for (const p of problems) console.log('  ' + p);
cards.close();
process.exit(problems.length ? 1 : 0);
