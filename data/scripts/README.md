# Card scripts

One JSON file per oracle id (`<oracle_id>.json`), the canonical description of a card's abilities for the rules
engine. The oracle-text parser (`src/cards/parse.ts`) produces the first draft of every card; a script here
overrides (`mode: "replace"`, the default) or completes (`mode: "extend"`, with `covers` listing the oracle lines it
accounts for) what the parser understood. Scripts are applied by `CardDB` through `src/cards/scripts.ts`.

- `oracleHash` is the fnv-1a hash of the card's oracle text at the time the script was written
  (`oracleHash(text)` in `src/cards/scripts.ts`). After a Scryfall refresh changes the text the script is **stale**
  and is not applied; the coverage report lists stale scripts so they can be re-checked.
- `source`: `generated` (written by the parser/generator, may be overwritten), `reviewed` (a person checked it),
  `hand` (written by a person). Generated scripts never overwrite reviewed or hand ones.
- `scenarios`: names of scenarios in `test/scenarios/` that verify the script behaviourally.
- `aiHints` (optional): `role`, `value`, `timing` for the AI.

The ability vocabulary is the engine AST in `src/cards/types.ts` (`Ability`, `Effect`, `TriggerEvent`, `Condition`,
`StaticEffect`, `AbilityCost`). `_example.json.txt` shows the shape; rename such a file to `<oracle_id>.json` to
activate it.
