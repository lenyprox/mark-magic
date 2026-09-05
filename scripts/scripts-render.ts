// The round-trip renderer, for a human and for the judge (plan 2.8): per card, every oracle line an ability claims,
// the English `src/cards/render.ts` renders that ability back into, and the score between the two. This is the tool
// an author uses to see WHY `scripts:verify` scored a card 0.31, and the tool a judge is shown next to the oracle
// text.
//
//   npm run scripts:render -- --ids a,b,c        # the scripted form (the script under data/scripts is applied)
//   npm run scripts:render -- --ids a,b,c --parsed   # the PARSER's own AST, script ignored — the baseline
//   npm run scripts:render -- --names "Llanowar Elves,Shock"
//
// Exit 1 when a named card or oracle id does not exist, 2 when the arguments are wrong.
import { CardDB } from '../src/cards/db.js';
import { parseCard } from '../src/cards/parse.js';
import { ROUND_TRIP_LOW, ROUND_TRIP_PASS } from '../src/verify/scriptVerify.js';
import { scorableClaims, scoreClaimedLine } from '../src/cards/render.js';
import { scriptStore, secondFaceOf } from '../src/cards/scripts.js';
import type { CardDef } from '../src/cards/types.js';

const args = process.argv.slice(2);
const usage = 'usage: scripts:render -- (--ids a,b,c | --names "A,B") [--parsed]';
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const parsedOnly = args.includes('--parsed');
const ids = (opt('--ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const names = (opt('--names') ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (!ids.length && !names.length) { console.error('name at least one card with --ids or --names'); console.error(usage); process.exit(2); }

const cards = CardDB.shared();
let missing = 0;

/** The def to render: the parser's own output with `--parsed`, otherwise the scripted card `CardDB` serves. */
function defOf(oracleId: string): CardDef | null {
  if (!parsedOnly) return cards.getByOracleId(oracleId);
  const row = cards.db.prepare('SELECT json FROM oracle_cards WHERE oracle_id = ?').get(oracleId) as { json: string } | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.json) as Record<string, unknown>;
  return parseCard({ ...raw, representative_id: raw.representative_id ?? raw.id ?? null } as never);
}

const targets: string[] = [...ids];
for (const n of names) {
  const d = cards.get(n);
  if (!d) { console.log(`no card named ${JSON.stringify(n)}`); missing++; continue; }
  targets.push(d.oracleId);
}

for (const oracleId of targets) {
  const def = defOf(oracleId);
  if (!def) { console.log(`no card with oracle id ${oracleId}`); missing++; continue; }
  const script = parsedOnly ? null : scriptStore().get(oracleId);
  console.log(`\n${def.name}  [${oracleId}]${script ? `  script: ${script.source}${def.script?.applied ? '' : ' (NOT applied)'}` : parsedOnly ? '  (parser output)' : '  (no script)'}`);
  const faces: [string, Parameters<typeof scorableClaims>[0], readonly typeof def.abilities[number][], string][] = [
    ['', { ...def, covers: script?.covers }, def.abilities, def.name],
  ];
  if (def.backFace) faces.push(['// ', { ...def.backFace, covers: script?.backFace?.covers }, def.backFace.abilities, def.backFace.name]);
  // the SECOND face of a split / adventure / flip card has no `CardDef`; only `script.secondFace` claims its lines,
  // and stage 6 scores it, so this tool has to show it too
  const second = secondFaceOf(def);
  if (second && script?.secondFace) faces.push(['/ ', script.secondFace, script.secondFace.abilities ?? [], second.name]);
  let worst = 1;
  for (const [prefix, face, abilities, cardName] of faces) {
    for (const [ability, lines] of scorableClaims(face, abilities, cardName)) {
      // `scoreClaimedLine` is the SAME function stage 6 of `scripts:verify` scores with. This tool exists to explain
      // that gate's number, so it may not compute one of its own: scoring each effect through
      // `renderAbility({ ...ability, effects: [e] })` (which re-prints the trigger or the cost in front of every
      // part) disagreed with the gate on 2.6% of the pool and printed "FAILS the 0.55 gate" for cards it passes.
      for (const line of lines) {
        const best = scoreClaimedLine(ability, line);
        worst = Math.min(worst, best.score);
        const mark = best.score < ROUND_TRIP_LOW ? 'LOW ' : best.score < ROUND_TRIP_PASS ? 'weak' : '    ';
        console.log(`  ${mark} ${best.score.toFixed(2)}  ${prefix}${line}`);
        console.log(`             -> ${best.rendered}`);
        if (best.why) console.log(`                (${best.why})`);
      }
    }
  }
  console.log(`  card score ${worst.toFixed(2)} (${worst >= ROUND_TRIP_PASS ? 'passes' : 'FAILS'} the ${ROUND_TRIP_PASS} gate)`);
}

cards.close();
process.exit(missing ? 1 : 0);
