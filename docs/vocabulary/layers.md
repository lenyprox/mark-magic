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
| `o.ext.layersTs` | a static source's CR 613.7 timestamp: when the pass first saw it, i.e. when it entered |
| `s.ext.layersClock` | the game's timestamp counter, bumped by every layer this family creates |
| `s.ext.layersActive` | some permanent carries a one-shot layer — the cheap gate for the projection pass |
| `s.ext.layersOn` | some permanent currently **carries** a projection — the gate that lets the pass take one back |

The **one-shot** half is projected the instant the `become` op applies, so the effects after it in the same
resolution already see the new types. The **static** half (`type-change`) is a continuous effect, recomputed by a
projection pass that runs at the two points its inputs can have changed since anything last looked:

* the `sba` hook — `checkSBA` runs after every resolution, every zone change and every priority round (CR 704.3),
  which is also where a permanent that just became an artifact becomes a legal target for the Shatter in hand;
* the `canAttack` hook — the first question combat asks, so blockers are declared against an up-to-date
  battlefield (landwalk reads the **defender's** land subtypes, and does so before any family `canBlock` hook).

Both are gated on three cheap tests, and the third is not optional: "a live `type-change` source" (a scan cached per
battlefield generation), "some permanent carries a one-shot layer" (`s.ext.layersActive`) **or** "something is
currently projected" (`s.ext.layersOn`). A static's continuous effect exists only while its source is on the
battlefield (CR 611.2b) and ends the moment the source stops existing (CR 613.6), and this loop is the only code that
can take a projection back — so gating it on live sources alone welded every overlay on for the rest of the game
the instant the last source was destroyed. With `layersOn` the pass runs once more with no sources, clears what it
finds and drops the flag, after which the cheap short-circuit is back. A game with no layers still pays one load.

## What this model does not do

These are the honest limits; the parser rules **decline** every wording that needs them rather than half-claiming it.

1. **No removal.** `types()` and `subtypes()` UNION `o.animated` with the printed values, so
   "becomes an artifact **and loses all other card types**" and CR 305.7's "the land loses its old land types"
   cannot be expressed: a layer only ever adds. `REMOVES` in the parser rules declines every wording that says so.
2. **No basic land type from the parser at all** (CR 305.6 + CR 305.7). A layer that grants `Plains` / `Island` /
   `Swamp` / `Mountain` / `Forest` carries two rules with no shape here: the intrinsic `{T}: Add {B}` that comes with
   the type (parse.ts builds that ability once, from the **printed** subtypes) and, unless the sentence says "in
   addition", the loss of the land's old land types and their mana abilities. Claiming the wording would mark Urborg,
   Tomb of Yawgmoth, Blanket of Night, Evil Presence, Spreading Seas, Sea's Claim, Lingering Mirage, Tainted Well,
   Convincing Mirage, Phantasmal Terrain, Multiversal Passage, Thran Portal, Tidal Warrior and the rest `fullyParsed`
   while every one of them is a no-op except for switching landwalk on — so a single choke point
   (`grantsBasicLandType`, read by `typeChange()` and `becomeRule()` in `src/cards/rules/layers.ts`) declines them,
   and the cards keep their line in `unparsed`. The **engine** still applies such a layer for a hand-written script:
   the layer is real, it just does not bring the mana ability, which is why `subtypes: 'chosen-basic-land-type'`
   still exists. Scenario: *the printed basic-land-type wordings are DECLINED, so Urborg does nothing at all*.
3. **No keyword removal from a static** (CR 613.1f layer 6 in the negative): "creatures your opponents control lose
   deathtouch and can't have or gain deathtouch" has no shape here — `Mods.kw` only grows.
4. **Timestamps** (CR 613.7) are a per-game counter, `s.ext.layersClock`. A one-shot is stamped as it is applied; a
   `type-change` source is stamped the first time the projection pass sees it — the sba immediately after it
   entered the battlefield, and so before any later `become` can be applied. Layers are folded in stamp order, so a
   `become` resolving now really does beat a static already in play (scenario: *CR 613.7 timestamps*). Still
   approximated: two sources that entered between the same pair of passes keep battlefield order rather than their
   true relative timestamps, and a layer's timestamp does not move when its permanent changes controller (CR 613.7c).
5. **`everyCreatureType` is materialised** as the full creature-type list of the pool (~280 subtypes) in
   `o.animated.subtypes`. That is CR-correct for every filter, and costs a set-union per `subtypes()` read of that
   one permanent.
6. **A dynamic base P/T is re-evaluated on every projection.** A token whose base P/T is "0/0 plus a count"
   (`token.dynamicPT`, Urza's Saga's Construct) has that count folded into the overlay, because `baseP` / `baseT`
   add it only on the branch where nothing is projected — writing the printed 0/0 instead would kill the token
   under any layer at all (CR 704.5f). The folded value is a snapshot refreshed by every pass, and the pass runs
   whenever the count it reads can have moved.

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

That first example is a **script-only** shape: the engine applies it, but no parser rule will ever produce it, because
a basic land type on its own is not what the printed cards mean (limit 2 below). Write it only where the card's whole
function really is "this land also matches Swamp" — landwalk, a `Swamp` filter, domain.
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
* `chosen-creature-type` / `chosen-basic-land-type` / `'chosen'` read the choice recorded on the **source** — and
  which of the two subtype slots a wording means is decided by the noun it names ("Enchanted **land** is the chosen
  type" is a basic land type, "Equipped **creature** is the chosen type" is a creature type), because the two are
  stored in different places (`o.chosen.creatureType` and `o.ext.chosenLandType`) (see
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
| "Each creature is an artifact in addition to its other types." | `type-change`, `scope: 'all'` |
| "Enchanted creature is a Demon in addition to its other types." | `type-change`, `scope: 'enchanted'` |
| "Enchanted creature gets +2/+2, has flying, and is a Demon in addition to its other types." | an `aura` static **and** a `type-change` |
| "Enchanted land is the chosen color." / "~ is the chosen type [in addition to its other types]." | `type-change` with `colors: 'chosen'` / `subtypes: 'chosen-…'` |
| "~ is every creature type." | `type-change` with `everyCreatureType` |

**Declined on purpose** (they reach `unknown`, and the card is not `fullyParsed`):

| oracle text | why |
|---|---|
| "Each land is a Swamp in addition to its other land types." (Urborg, Blanket of Night) | CR 305.6: no intrinsic mana ability comes with the type, which is the whole card |
| "Enchanted land is a Swamp / an Island." (Evil Presence, Spreading Seas, Sea's Claim, Lingering Mirage, Tainted Well) | CR 305.6 **and** CR 305.7: the land also keeps its old types and its old `{T}: Add {G}` |
| "Target land becomes an Island until end of turn." (Tidal Warrior, Dreamwinder) | the same, for the one-shot half |
| "Enchanted land is the chosen type." / "~ is the chosen type." on a land (Convincing Mirage, Phantasmal Terrain, Multiversal Passage, Thran Portal) | the same; the noun in the line is what says the choice is a **basic land type**, not a creature type |
| anything matching `REMOVES` — "loses all abilities", "loses all other card types", "is no longer …" | limit 1 above (Turn to Frog, Kenrith's Transformation, Song of the Dryads) |

Two things about those rules are worth knowing before editing them:

* **The same wordings are registered twice.** `parseStatic`'s built-in Aura branch matches "Enchanted <type> …" and
  returns `null` from *inside* that branch, above the registry hook at the end of the function — so on an Aura card a
  static rule is never offered "Enchanted creature is a Demon." The wordings are therefore also a **line** rule,
  which parse.ts consults at its last stop before `unknown(def, line)`. The static entries still fire on a non-Aura
  source such as Mistform Ultimus.
* **An Aura's "Enchant <type>" line is not what tells the engine what it enchants**: `legal.ts` reads the `enchant`
  spec off the card's `aura` static and defaults to "creature". The built-in template writes that static as a side
  effect of parsing "Enchanted creature gets +1/+1"; a card whose only Aura line is one of this family's would
  otherwise be an Aura castable only on a creature, so the line rule adds the 0/0 carrier static itself.
