# Adding a mechanic family to the engine

Vocabulary documents (one per wave; what script authors and the round-trip renderer read):

| document | contents |
|---|---|
| [composition.md](composition.md) | Phase 9.0 composition core: `Ref` / `ScopeWho` binding rules, the amount forms (`objects`, `diff`, `sum`, `max`, `min`, `prop`), `multi` targets, and the ops `for-each`, `bind`, `reflexive`, `scoped`, `may`, `unless-pays`, `move`, `set-pt`, `lose-abilities`, `exchange`, plus the delayed-trigger points `this-turn:dies` / `this-turn:ltb` / `next-turn:upkeep` / `until-eot:end` |
| this file | how a family module extends the engine, the hook table, the lints, the op-coverage ratchet and the parser rule registry |

The engine is extended through **families**: one file per mechanic, `src/engine/ops/<family>.ts`, whose default export
is a `FamilyModule`. A family adds AST shapes (effects, conditions, triggers, statics, amounts, costs, keywords,
target kinds, decisions, actions, events) and the behaviour behind them **without editing a single core file**.

That is the whole point of this contract: many agents can build families in parallel and the merges do not collide.

---

## The two halves

| | mechanism | where |
|---|---|---|
| **New data shapes** | TypeScript declaration merging into empty registry interfaces | `declare module` blocks in your family file |
| **New behaviour** | hooks on `FamilyModule`, folded into flat lookups by a generated barrel | the default export of your family file |

The core reads the barrel (`src/engine/ops/_registry.ts`) from `default:` branches and length-guarded fold loops, so a
game with no families registered pays one boolean or one `.length` test per hook site.

---

## Step by step

1. **Copy the template.** `src/engine/ops/_example.ts` is a fully commented family showing every hook kind and every
   `declare module` augmentation. Copy it to `src/engine/ops/<family>.ts` (no leading underscore) and delete what you
   do not need. `_example.ts` is excluded from the barrel by its underscore *and* from the main program by
   `tsconfig.json` — `declare module` is global, so a dead template inside the program would add phantom variants to
   `Effect`, `Decision` and friends that no registry could ever handle. `npm run typecheck:example` compiles it on its
   own, so the pattern in it is still known to compile.
2. **Declare your AST.** Give every new variant a literal discriminant (`op` / `kind` / `on` / `type`) so the core's
   switches keep narrowing, then merge it in:

   ```ts
   export interface SuspendEffect { op: 'suspend'; counters: number }
   declare module '../../cards/types.js' { interface EffectRegistry { suspend: SuspendEffect } }
   ```

   The registries are `EffectRegistry`, `ConditionRegistry`, `TriggerRegistry`, `StaticRegistry`, `AsEntersRegistry`,
   `AmountCountRegistry`, `KeywordRegistry`, `AltCostIdRegistry`, `TargetKindRegistry` and `AbilityCostExt` in
   `src/cards/types.ts`; `DecisionRegistry`, `ActionRegistry` and `DelayedAtRegistry` in `src/engine/state.ts`;
   `EventRegistry` in `src/engine/events.ts`. The public names (`Effect`, `Condition`, `TriggerEvent`, …) are unchanged,
   so nothing else in the codebase has to move.
3. **Write the hooks.** See the table below.
4. **Regenerate the barrel.** `npm run gen:registry`. It lists every `src/engine/ops/<name>.ts` that does not start with
   `_`, is not shared plumbing (`types.ts`, `ext.ts`, `chars.ts`) and is not a `<name>.schema.ts`, imports the default
   exports and rebuilds the flat lookups. Duplicate keys across two families are a **hard error naming both files**. The output is deterministic and
   written with LF endings — running it twice produces no diff, and `test/lint-ops.test.ts` asserts the checked-in file
   is up to date. **Never hand-edit `_registry.ts`.**
5. **Test.** `npm run verify:quick` (typecheck + lints + registry and parser-registry tests + scripts check), then
   scenarios (below), then `npm run verify:all` (which includes `parse:diff`) before the merge.

If you need a hook that does not exist, **do not add it**. Stop and report `coreChangeNeeded` with the patch you want;
the orchestrator applies core changes serially on `main`.

---

## Hook table

| hook | core call site | what it does |
|---|---|---|
| `effects` | `game.ts:applyEffect` `default:` | new effect ops; gets an `OpCtx` (`g, s, item, p, src, T, idx, amt(), objs(), players(), apply()`) built lazily only for a registry op |
| `conditions` | `characteristics.ts:conditionHolds` `default:` | new `Condition.kind`s |
| `amounts` | `characteristics.ts:evalAmount` `default:` | new `Amount.count`s |
| `triggers` | `game.ts:queueTriggers`, before the core switch | does this permanent's trigger fire? Consulted for **every** event the core queues, with the fired event name as the 5th argument, so a family trigger can key off a core event with an extra condition (dethrone on `attacks`, exploit on `etb`) as well as off an event it queues itself with `g.queueTriggers('<your-event>', ctx)`. Check `event` first and return false fast. |
| `triggerSources` | `game.ts:queueTriggers` | extra objects to scan beyond `allPermanents` (emblems, command-zone statics); they are scanned even when nothing on the battlefield carries the trigger |
| `statics` | `characteristics.ts:computeStaticMods` | fold into `Mods` — including `Mods.setPT` (layer 7b-lite, applied *before* the additive terms) and the string-indexed `Mods.flags` |
| `keywordHooks.canAttack` / `.canBlock` | `characteristics.ts:canAttack` / `canBlock` | `false` forbids, `undefined` abstains |
| `keywordHooks.blockCheck` / `.blockFixup` | `game.ts:combatFrom` | validate one declared block; rewrite a defender's declared blocks (lure, "blocks if able") |
| `keywordHooks.combatDamage` | `game.ts:combatDamage` | rewrite the assignments after they are built and before they are dealt |
| `costParts` | `cost.ts:nonManaCostPayable` + `game.ts:payCost` | non-core `AbilityCost` keys (anything outside `CORE_COST_KEYS`) |
| `asEnters` | `game.ts:enterBattlefield` `default:` | non-core `AsEnters.kind`s; write `ctx.entersTapped` to change whether it enters tapped |
| `replacements.zoneMove` | `game.ts:moveTo`, right after the commander redirect and before anything moves | override `zone` / `pos`, `cancel` the move (the object keeps its zone, its place in that zone's array and its battlefield state), `emit` a line |
| `replacements.damage` | `game.ts:dealDamage` / `dealDamageToPlayer`, after protection and prevention shields | return the new amount |
| `replacements.draw` | `game.ts:draw`, after the dredge block | return `true` when the draw was replaced |
| `replacements.counters` | `game.ts:replaceCounters`, before the core doubling statics | return the new delta. It is the **unguarded** fold: it sees removals (a negative delta), objects in any zone and `loyalty`, so a shield or a "counters are put on it as though" effect can answer for all of them. The core's `counters-replacement` statics run after it and keep their narrower scope (additions, on the battlefield, never loyalty). |
| `replacements.lifeGain` | `game.ts:gainLife` | return the new amount |
| `leave` | `game.ts:moveTo`, where "exile until this leaves" is handled | a permanent left the battlefield |
| `steps` | `game.ts:runTurn` / `runTurnFrom` / `combatFrom` | every `Step` plus `'turn-start'` (before untap) and `'cleanup-end'` (after the end-of-turn wipe) |
| `cleanupEot` | `game.ts:runTurnFrom` end-of-turn wipe loop | per permanent, alongside the damage/eot reset |
| `sba` | `game.ts:checkSBA` loop | extra state-based actions; return `true` when something changed |
| `legalActions` | `legal.ts:legalActions`, before `return out` | extra legal actions |
| `actions` | `game.ts:performAction` `default:` | perform them |
| `decisions` | `agents/defaults.ts:defaultAnswer` `default:` | what a shipped agent answers for a decision it has never seen |
| `targetKinds` | `legal.ts:targetOptionsFor` `default:` | non-core `TargetSpec.kind`s |
| `tokenAbilities` | `legal.ts:legalActions` + `game.ts:activateAbility` | built-in abilities of predefined tokens (Treasure, Clue, Food and Eldrazi Spawn already live here, in `_tokens.ts`). `legal` offers the action; the optional `covers` (default `true`) says whether the ability speaks for the token, so `legalActions` skips the generic activated-ability and equip scan for it — return `false` to fall through to it anyway (a tapped Treasure and every Eldrazi Spawn do) |
| `castFrom` / `freeCast` | `game.ts:castSpell` | allow a cast from a new zone; cast it without paying its mana cost |
| `events` | `events.ts` `LOGGED` / `citation` / `renderEvent` | `logged`, `cr` and `render` for the family's own event types |
| `redact` / `redactPlayer` / `redactState` | `view.ts:redact` | scrub state a viewer must not see, from an object's, a seat's and the game's `ext` bag |
| `modeCost` | `cost.ts:spellManaCost` | what the chosen modes add to the cost actually paid (entwine, escalate, spree, multikicker). `legal.ts:castActionsFor` enumerates the payment plans once per mode set, so the surcharge is in the `pay.cost` of the legal cast as well as in what `castSpell` charges |
| `costMod` | `cost.ts:costAdjust` | cost alteration the core's fixed-`amount` `cost-adjust` static cannot express (positive = cheaper, negative = a tax) |
| `render` | script verification pipeline | round-trip English per op |

Three mechanics are state, not hooks:

* **Extra combat phases.** `extBump(s, 'extraCombats', 1)` and `runTurnFrom` re-runs `combatFrom` and then main 2. The
  counter belongs to the turn that granted it and is cleared three times over, so one nobody reached can never be spent
  by another turn (or by an AI clone of it): at the cleanup step, at the start of every turn, and when the active
  player leaves the game mid-turn (an elimination ends the turn before its cleanup step runs).
* **Phasing.** Set `s.ext.phasing = true` once and `o.ext.phasedOut = true` per permanent; no `s.version++` is needed,
  the gate is read from the state on every call. `allPermanents` and `battlefieldOf(s, p)` are the two accessors every
  battlefield scan in the engine goes through — untap, the attacker candidates, `legalActions`, `computeStaticMods`,
  `evalAmount`, `conditionHolds`, `costAdjust` — so a phased-out permanent is not scanned, untapped, activated,
  counted or asked for statics, and `canAttack` / `canBlock` refuse it. `findObject` still finds it: it exists, it just
  does nothing (CR 702.26e). Use `battlefieldOf` in your own hooks instead of `s.players[p].battlefield`.
* **Copies.** `g.setCopyDef(o, def)` (and `setCopyDef(o, null)` to end it) puts the copied `CardDef` on the object, so
  `defOf(o)` returns it with no state argument, no lookup table and no way for one game's copies to answer for
  another's. `clone` shares the def by reference (CardDefs are immutable) and `serialize` carries it.

`Step` and `Zone` stay central and are **not** augmentable: extra combats re-run `combatFrom`, and foretell/madness use
`exile` plus an `ext` marker.

---

## The four hard rules

1. **No `node:` imports.** Ops are bundled into the browser's web worker. zod schemas for tooling go in
   `<family>.schema.ts`, which the engine never imports.
2. **Only *type* imports from the core at module scope.** The core imports the barrel and the barrel imports your
   family, so a value import of `../legal.js` at the top of your file is a module-evaluation cycle. Take what you need
   from the `Game` you are handed, or `await import('../legal.js')` lazily inside a hook body.
   **Computed characteristics are the exception**: `import { chars } from './chars.js'` is a leaf module the core fills
   in, so `chars.power(s, o)`, `chars.keywords`, `chars.matchesFilter`, `chars.evalAmount`, `chars.allPermanents`, ...
   are available at module scope with no cycle. That is how a *synchronous* hook — conditions, amounts, statics,
   triggers, `canAttack` / `canBlock` / `blockCheck`, `legalActions`, `decisions`, `targetKinds`, none of which can
   `await` — reads a computed characteristic. Call them inside a hook body, never while your module is evaluating.
3. **No direct writes to observable state.** Use the `Game` primitives — `setTapped`, `addCounters` / `setCounters`,
   `gainLife` / `loseLife`, `dealDamage` / `dealDamageToPlayer`, `moveTo`, `enterBattlefield`, `addMana`, `attach`,
   `changeControl`, `emit` / `note` — so the event stream stays complete.
4. **`ext` is JSON-plain.** Family state lives in the `ext` bags on `GameObject`, `Player` and `GameState` through the
   helpers in `src/engine/ops/ext.ts` (`extGet`, `extGetOr`, `extSet`, `extDel`, `extBump`, `extPush`). Primitives,
   arrays and plain objects only: no `Set`, no `Map`, no class instances, no functions. `clone.ts` deep-copies the bag
   with `plainCopy` and `serialize.ts` round-trips it through JSON; `plainCopy` **throws** on anything else rather than
   aliasing it into every simulated state.

### The lints that enforce them

| lint | what it checks |
|---|---|
| `test/lint-ops.test.ts` | no `node:` imports under `src/engine/ops`; no `new`-ed value (Set, Map, Date, any class) anywhere in an `ext` write, in any shape — `x.ext.k = v`, `x.ext = { k: v }`, `extSet(o, 'k', v)`, `extPush(o, 'k', v)` — since the whole assigned expression is scanned; `_registry.ts` matches what `scripts/gen-registry.mjs` produces |
| `test/lint-direct-writes.test.ts` | direct writes to observable state — ceiling **0** for every pattern under `src/engine/ops/**` (the `game.ts` ceilings are a separate ratchet) |
| `test/lint-nplayer.test.ts` | no two-player assumptions (`players[0]`, `opponentOf(`, `[Agent, Agent]`) under `src/engine/ops` |
| `test/registry.test.ts` | every hook kind is reachable: a probe family is registered at runtime and each hook is observed firing in a real game |

---

## Scenarios

Behavioural tests are data, in `test/scenarios/*.ts`: a `Scenario` names real cards, sets up seats, runs a script of
actions and lists expectations, each pinned to a CR number.

```ts
{
  name: 'Lightning Bolt kills Grizzly Bears (lethal damage SBA)', cr: '704.5g',
  seats: [{ bf: ['Mountain', 'Mountain'], hand: ['Lightning Bolt'] }, { bf: ['Grizzly Bears'] }],
  script: [{ cast: 'Lightning Bolt', targets: [['Grizzly Bears']] }, { resolve: true }],
  expect: [{ zone: ['Grizzly Bears', 'graveyard'] }, { events: { type: 'damage', min: 1, max: 1 } }, { unsimulated: 0 }],
}
```

Add a file per family, export its array, and run `npm run verify:scenarios`. Use real cards — the scenario runner
looks names up in `master.db`.

---

## Op coverage ratchet

**Every op, condition, trigger, static, amount, as-enters kind and cost part a family registers must be *executed* by at
least one scenario.** `test/lint-op-coverage.test.ts` enforces it, and neither half is a grep for op names:

* the **vocabulary** is read out of the engine itself — the `case` labels of the switches that dispatch on each
  discriminator (`Game.applyEffect`, `conditionHolds`, `evalAmount`, `Game.queueTriggers`, the as-enters switch), the
  `kind === '…'` tests that apply static effects, every event `queueTriggers('…')` is *called* with, and the live
  registry lookups in `src/engine/ops/_registry.ts`;
* the **exercised** set is measured by running the harness: `src/verify/opProbe.ts` runs every scenario
  (`test/scenarios/*.ts` and `data/scenarios/**`) in-process behind a probe that records `e.op` as `applyEffect`
  executes it, `cond.kind` as `conditionHolds` reads it, a trigger's event as it fires, a cost part as it is paid.
  **Naming a card in a file is not coverage**: most of a played card's AST never runs, and a name in a string literal
  runs nothing at all.

`uncovered = vocabulary \ exercised \ dead` must be a subset of `test/fixtures/op-allowlist.json`, the baseline
generated once in phase 8h. **That list may only shrink**: the lint also fails when an allowlisted name has become
covered and is still listed, or when it names something the engine no longer executes. Never regenerate it to make the
lint pass — `npm run coverage:ops -- --write-allowlist` exists for a reviewed reset, nothing else.

**Dead trigger events** are counted apart, under `"deadEvents"`. An event the engine raises that nothing dispatches on
(`turned-face-up`, raised by `Game.turnFaceUp`, which every morph card's trigger keys off), or a `case` label for an
event the engine never raises (`tapped`), can never fire: no scenario could cover it, and a card whose trigger keys off
it is silently inert. Those are engine defects, so the lint pins the list exactly — a new one fails, and fixing one in
the engine forces its entry out of the allowlist.

Two self-checks keep the two halves honest: the lint fails if the engine dispatches on a discriminator the vocabulary
does not list (that is how the `turned-face-up` hole was found: the tool scored an op it refused to enumerate), and if
any scenario fails while coverage is being measured — coverage read off a red harness, or off a run the probe
perturbed, means nothing.

A key a family registers is by definition not in the allowlist, so **a family that lands without a scenario fails the
lint**. To find out what to write the scenario with, run `npm run coverage:ops`: it prints the per-category counts and,
for every uncovered op, up to five real cards from the whole pool that use it, and writes the same thing to
`data/master/op-coverage.json`.

```
$ npm run coverage:ops
harness: 74 scenarios ran under the probe (8 TS suites, 3 JSON files)

category        vocab  exercised  uncovered
effects            93         32         61
...
dead trigger events (no scenario can ever cover these — they are engine defects):
  turned-face-up — raised but nothing dispatches on it
  tapped — dispatched on but the engine never raises it

uncovered statics:
  tokens-replacement — e.g. Doubling Season, Adrix and Nev, Twincasters, Anointed Procession
```

---

## The parser rule registry

A family has two halves in the *engine* (data shapes and behaviour) and one more in the *parser*: the oracle-text
**wordings** that produce its ops. Those live in their own registry, built exactly like the ops barrel.

### File layout

```
src/cards/rules/types.ts        the contract (EffectRule, LineRule, TriggerRule, ConditionRule, StaticRule, CostRule,
                                LineCtx, RuleFamily) — hand-written, never a family
src/cards/rules/<family>.ts     one file per family; `export default { name, effects?, lines?, triggers?,
                                conditions?, statics?, costs? } satisfies RuleFamily`
src/cards/rules/_registry.ts    GENERATED by `npm run gen:registry` — never hand-edit
```

The generator scans the directory the same way it scans `src/engine/ops`: every `<name>.ts` that does not start with
`_`, is not `types.ts` and is not a `<name>.schema.ts` is a family, sorted by file name so the output is deterministic
and LF-terminated. **Two families with the same `name` are a hard error.** One `npm run gen:registry` writes both
barrels.

### The six rule kinds

| kind | parse.ts dispatch point | signature |
|---|---|---|
| `effects` | `parseEffectSentence`, after the built-in `EFFECT_RULES` table | `{ re, make(m) → Effect \| null }` — `re` is matched against the *normalised* sentence (`~` for the card's own name, no trailing `.`, leading "You may "/"Then " stripped) |
| `lines` | the `parseCard` line loop, at the two points below | `{ name, match(line, ctx) → boolean }` — return `true` to claim the line |
| `triggers` | `parseTrigger`, before it returns `{ on: 'unknown' }` | `{ name?, make(head) → TriggerEvent \| null }` |
| `conditions` | `parseCondition`, before it returns `{ kind: 'unknown' }` | `{ name?, make(text) → Condition \| null }` |
| `statics` | `parseStatic`, before it returns `null` | `{ name?, make(line, card) → StaticEffect \| StaticEffect[] \| null }` |
| `costs` | `parseCostPhrase`, on the `else` that would return `null` | `{ name?, make(phrase) → AbilityCost \| null }` |

Those dispatch points are where a rule is *offered* the text. Four of them are consulted twice — see the next section:
once is not enough, because a sub-parser declining is also how a later built-in stage learns the text is free.

A line rule never imports a parse.ts internal: `LineCtx` hands it the built-in sub-parsers (`parseEffects`,
`parseCost`, `parseCostPhrase`, `parseCondition`, `parseManaCost`, `parseTrigger`), the `CardDef` under construction,
the raw line, the `OracleRow`, Scryfall's own `keywords[]` tags for the card, and the mutators `addAbility`,
`addAltCost`, `addKeyword`, `addAsEnters`, `addCostModifier` and `markUnparsed`. Reuse the sub-parsers — a family that
re-implements filters or targets will disagree with the rest of the vocabulary.

### Built-ins first — and what that does and does not promise

Every dispatch point runs its **built-in table first** and reaches the registry only where the built-ins were about to
give up. That ordering is *per sub-parser*, and on its own it is not enough: a sub-parser returning `unknown` / `null`
is also the signal a **later built-in stage** uses to claim the very same text.

| the sub-parser that declines | the later built-in stage that reads that failure |
|---|---|
| `parseEffectSentence` on a whole sentence | the `", then"` / `" and "` decomposition in `parseSentenceRecursive` |
| `parseTrigger` on the narrow first-comma head | the greedy comma re-split of the same line |
| `parseCostPhrase`, through `parseActivatedLine` | the static branch below it — and, on an instant or sorcery, the spell-text branch below that |
| `parseStatic` | the spell-text branch, on an instant or sorcery |
| `parseActivatedLine` inside `parseGrantedAbility` | the triggered shape of the same quoted text |

So each of those ladders runs a complete **built-ins-only pass first** (a `useRegistry` flag threaded through the
sub-parsers) and only then the same ladder with the registry enabled. Get this wrong and the damage is quiet: a static
rule that fires on a sorcery line still leaves the card `fullyParsed` with an empty spell ability, so `coverage:pool`
shows nothing and only `parse:diff` can see it. `test/parser-registry.test.ts` pins all four orderings with a
deliberately over-wide probe family, each case paired with a positive control so it cannot pass vacuously.

The built-in tables themselves never reach the registry either, not even through a nested sub-parse: the handful of
built-in templates that parse a slot of their own (`PARAGRAPH_RULES`' "You may X. If you do, Y", the two
"... instead if <condition>" effect rules, `parseCondition`'s "A or if B") call the sub-parser with `useRegistry:
false`, because a table is the first stage of *both* passes. That one is not theoretical: before it was fixed, a
catch-all effect family moved Shivan Fire, Burst Lightning and Roil Eruption — three cards that parsed fully without
it — because the kicker paragraph rule could suddenly parse its second slot and claimed the paragraph ahead of the
built-in stage that owns it.

How the invariant is measured: register catch-all families (one rule of each kind, matching everything) and reparse
the whole pool. As *spies* (matching everything, claiming nothing) they must move **0 of 34,513 cards**; as *claimers*
they move a lot of cards, and every one of them must be a card that already had an unparsed line — **0 cards that were
fully parsed may move**, per kind and all six together. `scripts/parse-snapshot.ts` is the same check with the real
(empty) registry: `npm run parse:diff` must print 0 changed.

What is true, then: **a rule only ever sees text that every built-in stage declined.** What does *not* follow is "a
family can never change a parse that already worked" — the shape a rule produces for the line it claims is the
family's own, and a rule wide enough to match text you were not aiming at will move that card. `npm run parse:diff` is
the check, and it is not optional: read every group it prints, not just the count.

The line loop has two hooks, because a line can die in two different places:

1. **Inside the keyword bail-out.** A line naming a keyword the built-ins know *of* but do not implement (`Bestow
   {3}{W}`, `Suspend 4—{1}{U}`) is recorded as unparsed there and never reaches the trigger / activated / static
   ladder. Registered keyword lines are offered inside that `if`, after the built-ins have given up on the line.
2. **Immediately before the final `unknown(def, line)`.** For everything else: every built-in shape — saga chapter,
   mode, keyword, alternative cost, as-enters, loyalty, trigger, activated, static, and spell text on an instant or
   sorcery — has already declined.

Both hooks are guarded by `ANY.line`, so a parse with no families registered never even builds a `LineCtx`. The
registry retries of `parseActivatedLine` and `parseStatic` sit just above hook 2 — below the spell-text branch, in
the same order as the built-in ladder — and are guarded the same way.

### Which second pass runs: the `ANY` flags

A registry pass re-runs a whole **ladder**, and a ladder reaches several rule kinds at once. So each pass is gated on a
derived boolean from `src/cards/rules/_registry.ts` (rebuilt by `registerRules` / `unregisterRules`, the parser twin
of the engine registry's `HAS`), never on one array's `.length`:

| flag | the pass it gates | every array that pass can reach |
|---|---|---|
| `ANY.sentence` | `parseSentenceRecursive`'s second pass | `effects` (the sentence itself) + `conditions` (its "if <condition>" splits) |
| `ANY.activated` | the `parseActivatedLine` retry in the line loop | `costs` (the cost phrases) + `conditions` ("Activate only if ...") |
| `ANY.trigger` | the trigger-head retry in the line loop | `triggers` |
| `ANY.granted` | `parseGrantedAbility`'s second pass | `ANY.activated` + `triggers` + `ANY.sentence` (an unknown effect makes the shape decline there) |
| `ANY.static` | the `parseStatic` retry in the line loop | `statics` + `ANY.granted` + `ANY.sentence` (its "as long as" and quoted-ability slots) |
| `ANY.line` | both line hooks | `lines` |

Gating on a single array is the bug this replaced, and it fails silently: a family that registers **conditions and no
costs** had its conditions consulted nowhere but the built-in branches that ask for one — not from "Activate only if
...", not from a sentence's "... if <condition>", not from a granted ability.
`test/parser-registry.test.ts` registers a conditions-only, a triggers-only and a statics-only family and makes each
fire at every site that can reach it, each with the same card parsed with nothing registered as the control.

### `PARSER_VERSION`

`export const PARSER_VERSION` in `src/cards/parse.ts`. **Bump it whenever a built-in rule or the normalisation above a
rule changes** — anything that can move a card's parsed `CardDef` without a family being added. Adding or changing a
family does *not* bump it; that shows up as a different `rulesHash()` instead.

### `parse:diff` / `parse:accept`

`data/master/parse-snapshot.json` (committed) holds `{ parserVersion, rulesHash, registryHash, cards: { oracleId →
fnv-1a of the canonical CardDef }, unparsed: { oracleId → the card's unparsed lines } }`. The hash is taken over the
canonical JSON (sorted keys) minus `imageUri`, `faceImageUris`, `representativePrintingId` and `script`, so printing
metadata does not move it.

Per-card scripts do not move it either — but *omitting a field is not what buys that*. `CardDB.all()` parses through
`applyScript`, which rewrites `abilities`, `keywords`, `altCosts`, `asEnters`, `costModifiers`, `unparsed` and
`fullyParsed`; a scripted card would hash differently however many bookkeeping keys were dropped. The script is
bypassed instead: `scripts/parse-snapshot.ts` swaps the shared `ScriptStore` for one pointed at a directory that holds
none, so every card is hashed as a bare `parseCard(row)`, and the run prints how many scripts it ignored. Without that,
each Phase 10 script wave would land here as thousands of changed cards and force a blanket `parse:accept` — which is
exactly the window a real parser regression would hide in.

* `npm run parse:diff` — reparse every playable card and compare. It prints the changed cards **grouped by their
  unparsed-line delta** (`now parses:` / `NO LONGER parses:`, with up to 20 example card names per group; the
  `(same unparsed lines)` group is the one to read carefully — an ability that already parsed changed shape) and
  exits 1 if anything moved. Version/hash mismatches are printed as context, not as the failure.
* `npm run parse:accept` — rewrite the snapshot. Do this only once the diff is the change you intended, and commit it
  in the same commit as the parser change.

`npm run verify:all` runs `parse:diff`, so an unaccepted diff is a red gate, not a report nobody reads.

The workflow for a family: take the diff **before** you start (it must be clean), add your rules, then
`npm run parse:diff` again and read every group. A family that only adds wordings should show groups made entirely of
`now parses:` lines.

### Proving a family's rules

`npm run coverage:pool` writes `data/master/parser-coverage.json`: `fully_parsed` out of `playable_oracle_cards`, the
same split by primary type, and the 60 most common unparsed clauses (numbers and mana symbols normalised, so similar
clauses group). That last list is the work queue — pick a clause, write the rules for it, and the number moves. Quote
the before/after `fully_parsed` in your report, and pair it with `npm run parse:diff` so the reader can see that the
cards that moved are exactly the ones you meant to move. `test/parser-registry.test.ts` is the contract test: it
registers a probe family at runtime with one rule of every kind and asserts each one fires and cannot shadow a
built-in.

---

## Commands

| command | what it does |
|---|---|
| `npm run gen:registry` | regenerate `src/engine/ops/_registry.ts` **and** `src/cards/rules/_registry.ts` from the directory listings |
| `npm run parse:diff` | reparse every playable card and diff against `data/master/parse-snapshot.json` (exit 1 on any change) |
| `npm run parse:accept` | re-baseline that snapshot |
| `npm run coverage:pool` | parser coverage: `fully_parsed` and the most common unparsed clauses |
| `npm run typecheck:example` | typecheck `_example.ts` on its own (it is excluded from the main program) |
| `npm run verify:quick` | typecheck + `lint-*` + `registry` + `parser-registry` + `scripts` tests + `scripts:check` (the `parser-registry` test is what catches a stale rules barrel) |
| `npm run verify:scenarios` | the behavioural scenario suite |
| `npm run coverage:ops` | the op-coverage ratchet report: uncovered ops with exemplar cards to write scenarios with |
| `npm run verify:all` | typecheck:all, full test suite, scripts check, `coverage:pool`, `parse:diff`, `verify:pool`, `bench:games` |
| `npm run bench:games` | the performance gate: ≥ 45 games/s 60-card, ≥ 4.8 games/s Commander |
