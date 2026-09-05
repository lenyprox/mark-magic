// Emit data/scripts/schema.json — the JSON Schema for a card script v2, generated from `CardScriptChecked`, the
// schema `scripts:check` really validates against, so every rule JSON Schema can carry is in the file an editor
// sees: a claimed line is a non-empty string that is not the old `'*'` wildcard (emitted as a `pattern`), a `covers`
// entry is `{ line, by }` with `by` from the `CoverKind` enum, and a `spell` / `triggered` / `activated` ability
// declares at least one effect (`minItems: 1`).
//
// Three rules cannot be expressed in JSON Schema:
//   1. `covers` VALIDITY — the declaration `by` names must really be on that face and the line must have the shape
//      that declaration produces (JSON Schema cannot relate two fields of the same object). `CardScriptChecked`
//      enforces it with a refinement, so it is caught by every consumer, not only by the tool;
//   2. every `covers` / `ignore` line must be one `scriptableLines(def)` names, and belong to the face that claims
//      it (needs the card, so `scripts:check`);
//   3. an `ignore` reason must match its whitelist regex and the card's pool tier (needs the card).
//
// It is committed: editors validate scripts against it and the script-authoring prompts embed it.
//   npm run scripts:schema
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CardScriptChecked } from '../src/cards/schema.js';
import { DEFAULT_SCRIPTS_DIR } from '../src/cards/scripts.js';

const json = z.toJSONSchema(CardScriptChecked, {
  io: 'input',
  target: 'draft-2020-12',
  reused: 'ref',   // Filter/Amount/Effect appear in dozens of places; emit them once under $defs
  // The only `z.custom` in the schema is NUMX: a slot types.ts declares `number` that parse.ts may fill with 'X'.
  // It has no JSON-Schema form of its own, so spell it out here instead of letting zod give up.
  unrepresentable: 'any',
  override: ctx => {
    if (ctx.zodSchema._zod.def.type === 'custom') {
      Object.assign(ctx.jsonSchema, { anyOf: [{ type: 'number' }, { const: 'X' }], description: 'a number, or the parser literal "X"' });
    }
  },
});
const out = path.join(DEFAULT_SCRIPTS_DIR(), 'schema.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ $id: 'https://mark-magic.local/schemas/card-script-v2.json', title: 'Card script (v2)', ...json }, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(1)} kB)`);
