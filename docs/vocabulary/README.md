# Adding a mechanic family to the engine

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
5. **Test.** `npm run verify:quick` (typecheck + lints + registry test + scripts check), then scenarios (below), then
   `npm run verify:all` before the merge.

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
| `replacements.counters` | `game.ts:replaceCounters` | return the new delta |
| `replacements.lifeGain` | `game.ts:gainLife` | return the new amount |
| `leave` | `game.ts:moveTo`, where "exile until this leaves" is handled | a permanent left the battlefield |
| `steps` | `game.ts:runTurn` / `runTurnFrom` / `combatFrom` | every `Step` plus `'turn-start'` (before untap) and `'cleanup-end'` (after the end-of-turn wipe) |
| `cleanupEot` | `game.ts:runTurnFrom` end-of-turn wipe loop | per permanent, alongside the damage/eot reset |
| `sba` | `game.ts:checkSBA` loop | extra state-based actions; return `true` when something changed |
| `legalActions` | `legal.ts:legalActions`, before `return out` | extra legal actions |
| `actions` | `game.ts:performAction` `default:` | perform them |
| `decisions` | `agents/defaults.ts:defaultAnswer` `default:` | what a shipped agent answers for a decision it has never seen |
| `targetKinds` | `legal.ts:targetOptionsFor` `default:` | non-core `TargetSpec.kind`s |
| `tokenAbilities` | `legal.ts:legalActions` + `game.ts:activateAbility` | built-in abilities of predefined tokens (Treasure, Clue, Food and Eldrazi Spawn already live here, in `_tokens.ts`) |
| `castFrom` / `freeCast` | `game.ts:castSpell` | allow a cast from a new zone; cast it without paying its mana cost |
| `events` | `events.ts` `LOGGED` / `citation` / `renderEvent` | `logged`, `cr` and `render` for the family's own event types |
| `redact` / `redactPlayer` / `redactState` | `view.ts:redact` | scrub state a viewer must not see, from an object's, a seat's and the game's `ext` bag |
| `modeCost` | `cost.ts:spellManaCost` | what the chosen modes add to the cost actually paid (entwine, escalate, spree, multikicker) |
| `costMod` | `cost.ts:costAdjust` | cost alteration the core's fixed-`amount` `cost-adjust` static cannot express (positive = cheaper, negative = a tax) |
| `render` | script verification pipeline | round-trip English per op |

Three mechanics are state, not hooks:

* **Extra combat phases.** `extBump(s, 'extraCombats', 1)` and `runTurnFrom` re-runs `combatFrom` and then main 2. The
  cleanup step clears the counter, so one nobody reached cannot be spent by the next turn (or by an AI clone of it).
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

## Parser rules

A family's *wordings* are a separate registry: `src/cards/rules/<family>.ts` with a generated
`src/cards/rules/_registry.ts`, consulted by `parse.ts` **after** its built-ins so every existing parse stays
byte-identical. **The parser rule registry lands in 8a-2.** Until then a family is reached through per-card scripts,
which emit its ops directly, and `npm run coverage:pool` does not move when a family lands.

---

## Commands

| command | what it does |
|---|---|
| `npm run gen:registry` | regenerate `src/engine/ops/_registry.ts` from the directory listing |
| `npm run typecheck:example` | typecheck `_example.ts` on its own (it is excluded from the main program) |
| `npm run verify:quick` | typecheck + `lint-*` + `registry` + `scripts` tests + `scripts:check` |
| `npm run verify:scenarios` | the behavioural scenario suite |
| `npm run coverage:ops` | the op-coverage ratchet report: uncovered ops with exemplar cards to write scenarios with |
| `npm run verify:all` | typecheck:all, full test suite, scripts check, `coverage:pool`, `verify:pool`, `bench:games` |
| `npm run bench:games` | the performance gate: ≥ 45 games/s 60-card, ≥ 4.8 games/s Commander |
