# layers-lite (Phase 9.1)

The CR 613 layers printed cards actually use, as far as this engine models them: **layer 4** (card types and
subtypes), **layer 5** (colours), **layer 6** (the keywords a layer grants) and **layer 7b** (base power and
toughness). Layer 6's *removal* half and the base-P/T **op** already belong to the composition core
([composition.md](composition.md)): `lose-abilities` and `set-pt`. This family is the type / subtype / colour half,
plus "is every creature type", plus the choices those layers read.

Engine: `src/engine/ops/layers.ts` · schemas: `src/engine/ops/layers.schema.ts` · parser rules:
`src/cards/rules/layers.ts` · scenarios: `test/scenarios/layers.ts`.

| what | name | discriminator |
|---|---|---|
| effect | `become` | `op` |
| effect | `choose-type` | `op` |
| effect | `exchange-life-toughness` | `op` |
| static | `type-change` | `kind` |
| condition | `attached-is` | `kind` |
| as-enters | `choose-type` | `kind` |

---

## How a layer reaches the rules

`characteristics.ts` reads types, subtypes, colours and base P/T from exactly one mutable slot on the object,
`o.animated` — the slot the core's own `animate` and `earthbend` ops write. `Mods` (what `computeStaticMods`
collects) has **no** type or colour term, so a family cannot add one from a static hook. This family therefore keeps
its layers as data and *projects* them into that slot:

| where | what |
|---|---|
| `o.ext.layers` | the one-shot layers a `become` applied, oldest first (timestamp order, CR 613.7) |
| `o.ext.layersBase` | a foreign `o.animated` (the core `animate` / `earthbend`) folded in as layer 0 |
| `o.ext.layersProj` | the JSON of the overlay this family last wrote, so a foreign write is detectable |
| `o.ext.chosenLandType` | the basic land type chosen for this permanent (`o.chosen` has no slot for one) |
| `s.ext.layersActive` | some permanent carries a one-shot layer — the cheap gate for the projection pass |

The **one-shot** half is projected the instant the `become` op applies, so the effects after it in the same
resolution already see the new types. The **static** half (`type-change`) is a continuous effect, recomputed by a
projection pass that runs at the three points its inputs can have changed since anything last looked:

* the `sba` hook — `checkSBA` runs after every resolution, every zone change and every priority round (CR 704.3);
* the `legalActions` hook — before a player is offered anything, so a permanent that just became an artifact is a
  legal target for the Shatter in their hand;
* the `canAttack` hook — the first question combat asks, so blockers are declared against an up-to-date
  battlefield (landwalk reads the **defender's** land subtypes, and does so before any family `canBlock` hook).

All three are gated on "some permanent carries a one-shot layer" or "some permanent has a `type-change` static" (a
scan cached per battlefield generation), so a game with neither pays one property load per call.

## What this model does not do

These are the honest limits; the parser rules **decline** every wording that needs them rather than half-claiming it.

1. **No removal.** `types()` and `subtypes()` UNION `o.animated` with the printed values, so
   "becomes an artifact **and loses all other card types**" and CR 305.7's "the land loses its old land types"
   cannot be expressed: a layer only ever adds. Urborg makes a Forest a `Forest Swamp`, not a `Swamp`. In practice
   the difference shows only where a card asks whether the permanent is *still* its old type.
2. **No intrinsic mana ability with a granted basic land type** (CR 305.6). A land Urborg makes a Swamp matches the
   "Swamp" filter and turns swampwalk on, but still taps for what it printed.
3. **No keyword removal from a static** (CR 613.1f layer 6 in the negative): "creatures your opponents control lose
   deathtouch and can't have or gain deathtouch" has no shape here — `Mods.kw` only grows.
4. **Timestamps are application order** within one projection pass, as everywhere else in this engine (CR 613.7 is
   approximated, not implemented).
5. **`everyCreatureType` is materialised** as the full creature-type list of the pool (~280 subtypes) in
   `o.animated.subtypes`. That is CR-correct for every filter, and costs a set-union per `subtypes()` read of that
   one permanent.

---

## `become` — the one-shot layer (CR 613.1c–e, 613.4b)

```ts
{ op: 'become';
  target: TargetSpec | Ref | 'creatures-you-control' | 'lands-you-control' | 'permanents-you-control'
        | 'all-creatures' | 'all-lands';
  types?: CardType[];          // gained, in addition to the printed ones (CR 205.1b)
  subtypes?: string[];         // gained (CR 205.3)
  colors?: Color[];            // the permanent's new colours — layer 5 REPLACES (CR 105.2, 613.1e)
  power?: Amount; toughness?: Amount;   // base P/T, layer 7b (CR 613.4b); both or neither
  keywords?: Keyword[];        // layer 6
  everyCreatureType?: true;    // changeling (CR 702.73a)
  duration: 'eot' | 'permanent' }
```

* `target` takes a `TargetSpec`, any composition-core `Ref` (`self`, `that`, `those`, `enchanted`, `equipped`,
  `target:<i>`, …) or one of the group words. Objects not on the battlefield are skipped.
* `power` / `toughness` are `Amount`s evaluated once, as the effect applies (CR 608.2h). Give both or neither: with
  neither, the permanent keeps its printed base P/T (a land stays 0/0 — and stays a land, so nothing kills it, but a
  land that gains `Creature` **without** a P/T is a 0/0 creature and dies to CR 704.5f, which is what the rules say).
* `colors` replaces; an empty list says nothing at all.
* `duration: 'eot'` records the turn; the cleanup wipe (CR 514.2) drops the layer and the projection is rebuilt from
  whatever is left. Every layer ends when the permanent leaves the battlefield (CR 400.7).
* A layer this op applies **does not** bind `that` for a following effect — put a `bind` or a `pump` before it if a
  later clause needs the binding.

```json
{ "op": "become", "target": { "kind": "land" }, "subtypes": ["Swamp"], "duration": "eot" }
```
```json
{ "op": "become", "target": "self", "types": ["Artifact", "Creature"], "subtypes": ["Golem"], "power": 4, "toughness": 4, "keywords": ["haste"], "duration": "eot" }
```

## `choose-type` (effect) — "Choose a creature type." (CR 700.4)

```ts
{ op: 'choose-type'; what: 'creature-type' | 'color' | 'basic-land-type' }
```

The choice is recorded **on the source of the effect**: `creature-type` and `color` go to the core's `o.chosen`
(so `Filter.chosenType` reads them), `basic-land-type` to `o.ext.chosenLandType`. A `type-change` static on the same
permanent then reads it through `subtypes: 'chosen-creature-type'` / `'chosen-basic-land-type'` / `colors: 'chosen'`.
The creature-type options are the types the chooser can see among their own hand, battlefield and graveyard, most
frequent first — the same list `game.ts` builds for the core `choose` as-enters.

```json
{ "op": "choose-type", "what": "creature-type" }
```
```json
{ "op": "choose-type", "what": "basic-land-type" }
```

## `exchange-life-toughness` — Tree of Perdition (CR 701.12, 613.4b)

```ts
{ op: 'exchange-life-toughness'; target: TargetSpec; permanent?: Ref }
```

`target` names the player (a `player` / `opponent` spec); `permanent` names the permanent, defaulting to the source.
The player's life total is set to the permanent's current toughness through `gainLife` / `loseLife` (so life-gain
replacements and life triggers all see it), and the permanent's **base** toughness (`o.ext.setPT`, layer 7b) is set
to the player's old life total — counters and anthems still apply on top of it, and the entry ends when the permanent
leaves the battlefield.

```json
{ "op": "exchange-life-toughness", "target": { "kind": "opponent" } }
```
```json
{ "op": "exchange-life-toughness", "target": { "kind": "opponent" }, "permanent": "that" }
```

## `type-change` — the static layer (CR 613.1d layer 4, 613.1e layer 5)

```ts
{ kind: 'type-change';
  scope: 'self' | 'enchanted' | 'equipped' | 'you-control' | 'all';
  filter?: Filter;                 // 'you-control' / 'all' only
  types?: CardType[];
  subtypes?: string[] | 'chosen-creature-type' | 'chosen-basic-land-type';
  colors?: Color[] | 'chosen';
  everyCreatureType?: true;
  condition?: Condition }          // "As long as …" (CR 611.2c)
```

* `self` is the source, `enchanted` / `equipped` the permanent it is attached to, `you-control` / `all` every
  permanent the `filter` matches (with `you-control` also requiring the same controller).
* `chosen-creature-type` / `chosen-basic-land-type` / `'chosen'` read the choice recorded on the **source** (see
  `choose-type` above, and the core `{ kind: 'choose', what: 'creature-type' | 'color' }` as-enters); until a choice
  is made the static contributes nothing.
* `condition` is re-evaluated on every projection pass, so an "as long as" layer turns itself on and off.

```json
{ "kind": "type-change", "scope": "all", "filter": { "types": ["Land"] }, "subtypes": ["Swamp"] }
```
```json
{ "kind": "type-change", "scope": "enchanted", "everyCreatureType": true, "condition": { "kind": "attached-is", "filter": { "subtypes": ["Bear"] } } }
```

## `attached-is` — "As long as enchanted land is a basic Mountain, …" (CR 611.2c)

```ts
{ kind: 'attached-is'; of?: 'attached' | 'self'; filter: Filter }
```

Does the permanent this Aura / Equipment is attached to (`of: 'attached'`, the default) — or the source itself
(`of: 'self'`) — match `filter`? False when the source is attached to nothing, or the host has left the battlefield.

```json
{ "kind": "attached-is", "filter": { "subtypes": ["Mountain"], "basic": true } }
```
```json
{ "kind": "attached-is", "of": "self", "filter": { "subtypes": ["Vehicle"] } }
```

## `choose-type` (as-enters) — "As ~ enters, choose a basic land type."

```ts
{ kind: 'choose-type'; what: 'basic-land-type' }
```

The core's `{ kind: 'choose', what: 'creature-type' | 'color' }` already covers the other two; this is the basic land
type, written to `o.ext.chosenLandType` for a `subtypes: 'chosen-basic-land-type'` static on the same permanent.

```json
{ "kind": "choose-type", "what": "basic-land-type" }
```
```json
[{ "kind": "choose-type", "what": "basic-land-type" }, { "kind": "tapped" }]
```

---

## Parser wordings

| oracle text | shape |
|---|---|
| "Target land becomes a Swamp until end of turn", "~ becomes an artifact creature", "Until end of turn, target artifact or creature becomes an artifact creature with base power and toughness 4/5", "Target creature becomes a 3/3 Elemental with haste until end of turn" | `become` |
| "It's still a land." | an empty `scoped` — under an additive layer model the land never stopped being one |
| "Choose a creature type." / "Choose a color." / "Choose a basic land type." | `choose-type` |
| "Exchange target opponent's life total with ~'s toughness." | `exchange-life-toughness` |
| "Each land is a Swamp in addition to its other land types." | `type-change`, `scope: 'all'` |
| "Enchanted land is a Swamp." / "Enchanted creature is a Demon in addition to its other types." | `type-change`, `scope: 'enchanted'` |
| "Enchanted creature gets +2/+2, has flying, and is a Demon in addition to its other types." | an `aura` static **and** a `type-change` |
| "Enchanted land is the chosen color." / "~ is the chosen type [in addition to its other types]." | `type-change` with `colors: 'chosen'` / `subtypes: 'chosen-…'` |
| "~ is every creature type." | `type-change` with `everyCreatureType` |

Two things about those rules are worth knowing before editing them:

* **The same wordings are registered twice.** `parseStatic`'s built-in Aura branch matches "Enchanted <type> …" and
  returns `null` from *inside* that branch, above the registry hook at the end of the function — so on an Aura card a
  static rule is never offered "Enchanted land is a Swamp." The wordings are therefore also a **line** rule, which
  parse.ts consults at its last stop before `unknown(def, line)`. The static entries still fire on a non-Aura source
  such as Urborg.
* **An Aura's "Enchant <type>" line is not what tells the engine what it enchants**: `legal.ts` reads the `enchant`
  spec off the card's `aura` static and defaults to "creature". The built-in template writes that static as a side
  effect of parsing "Enchanted creature gets +1/+1"; a card whose only Aura line is one of this family's would
  otherwise be an Aura castable only on a creature, so the line rule adds the 0/0 carrier static itself.
