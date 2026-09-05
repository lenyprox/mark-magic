# Composition core (Phase 9.0)

The generic verbs a per-card script composes with. About 9,500 unscripted cards fail on lines like "for each
creature you control, …", "when you do, …", "each opponent sacrifices a creature, then draws a card", "unless that
player pays {2}", "put it onto the battlefield tapped under your control" and "gets +X/+X where X is the difference
between …". Nothing here is a new mechanic: it is the glue between the ops the engine already has, plus the four
primitives those lines need and no family should own (a general zone move, base P/T, ability loss, exchanges).

Everything below is evaluated in `Game.applyEffect` (src/engine/game.ts) next to `conditional` / `optional-then`,
resolves its references through src/engine/refs.ts, and is validated by src/cards/schema.ts. The scenario suite
test/scenarios/composition.ts has at least one scenario per op, per Ref, per amount form, per delayed-trigger point
and per `who` word; test/composition.test.ts covers the resolver, the arithmetic and the round-trips.

Rule numbers refer to the Comprehensive Rules bundled in data/rules/cr.json.

---

## 1. The binding frame: Ref, ScopeWho, and what "it" means

A resolving spell or ability carries one **binding frame** on its stack item:

| field | set by | read as |
|---|---|---|
| `item.affected` | every op that touches objects (`noteAffected`), a `for-each` iteration, a `bind`, a delayed trigger's `bind` | `that` (the first entry), `those` (all of them) |
| `item.targetsByEffect` | the targets chosen on cast / activation / trigger | `target:<i>`, `target-player` |
| `item.triggeringId` / `item.triggeringPlayer` | the trigger that created the item | `triggering`, `that-player` |
| `item.sacrificed` | `payCost` (a `sacrifice` or `sacrificeSelf` cost part) | `sacrificed` |
| `item.actor` | a running `scoped` block (or `unless-pays`' `otherwise`) | `you` |
| `source.exiledWith` | delve, imprint (`exile-from-hand` with `imprint`), families | `exiled-with` |

### `Ref`

```ts
type Ref = 'self' | 'that' | 'those' | 'triggering' | `target:${number}` | 'enchanted' | 'equipped' | 'sacrificed' | 'exiled-with';
```

| Ref | resolves to | notes |
|---|---|---|
| `self` | the source of the ability, wherever it now is | the same object every op's `'self'` word meant before |
| `that` | the first object of the current binding | inside a `for-each`, exactly the iterated object |
| `those` | every object of the current binding | after a `move`, what moved; after a `for-each`, what was iterated |
| `triggering` | the object the trigger was about (the spell cast, the creature that died, the card drawn …) | empty for a spell |
| `target:<i>` | the i-th target of the whole item in printed order — every target group, `multi` parts included, nested containers between their neighbours | `target:0` is the first thing the card says "target" about |
| `enchanted` / `equipped` | the permanent the source is attached to | the same lookup; use the word the card uses |
| `sacrificed` | the objects sacrificed to pay this item's cost | "sacrifice ~" counts as the source itself |
| `exiled-with` | the cards exiled with the source | imprint, delve, "exile … until ~ leaves" |

An effect whose `target` is a Ref (see §4, "existing ops that take a Ref") acts on the objects the Ref resolves to and
needs no target chosen on cast.

**Objects that changed zones (CR 400.7).** A binding records the zone the object was bound in
(`affected[].lastKnown.zone`). `resolveRef` returns the object wherever it now is; each op decides whether the
binding survived:

* `move` acts on a bound object anywhere public — exile, graveyard, battlefield, stack — because the same ability
  is allowed to find what it moved (CR 610.3, 603.7c: "Exile target creature. Return it …"); a bound object that has
  since gone to a **hidden zone** (hand, library) is a new object and is skipped.
* `set-pt`, `lose-abilities`, `exchange` (control) and every existing op that acts on permanents ignore a bound
  object that is no longer on the battlefield.
* `prop` amounts read the **last known** power / toughness / mana value of an object that has left the battlefield
  (CR 608.2h: "the sacrificed creature's power") — the values it had while it existed, a base P/T a `set-pt` gave it
  included: `moveTo` takes the snapshot before the new-object reset (CR 400.7) strips `setPT` / `lost` / face-down.

### `ScopeWho`

```ts
type ScopeWho = 'you' | 'each-player' | 'each-opponent' | 'target-player' | 'that-player' | 'controller-of-that';
```

| word | player(s) |
|---|---|
| `you` | the acting player: the item's controller, or the player a `scoped` block is running as |
| `each-player` | every player still in the game, **APNAP order** — the active player first, then turn order (CR 101.4, 608.2f) |
| `each-opponent` | the acting player's opponents, in the same order |
| `target-player` | the first player among the effect's own targets, else the first player target of the item |
| `that-player` | the player the trigger was about (`item.triggeringPlayer`), else the controller of `that`, else the first player target — the fallbacks the older `draw` / `mill` / `poison` ops use |
| `controller-of-that` | the controller of `that` (its current controller while it is on the battlefield, else the controller it had when bound) |

Eliminated players are never in the list.

---

## 2. Amounts

```ts
type Amount = number | 'X' | AmountExpr;
interface AmountExpr {
  count?: AmountCount | 'objects'; filter?: Filter; zone?: SetZone; who?: ScopeWho; plus?: number; times?: number; counter?: string; half?: 'up' | 'down';
  max?: number | Amount[];                  // with `count`: a cap; on its own (a list): the largest of the listed amounts
  diff?: [Amount, Amount]; sum?: Amount[]; min?: Amount[];
  prop?: 'power' | 'toughness' | 'mv' | 'life' | 'cards-in-hand'; of?: Ref | 'you' | 'that-player' | 'target-player';
}
```

One object type carries every form (the parser and the engine read `a.count` / `a.plus` / `a.filter` on one shape);
the schema and the structural gate require **exactly one** of `count`, `diff`, `sum`, `max`-as-a-list, `min`, `prop`.

| form | value | rule |
|---|---|---|
| `count: <name>` | the named count as before (`creatures-you-control`, `opponents`, …) | |
| `count: 'objects'` | objects matching `filter` in `zone` (default `battlefield`) of `who` (default **every player**) — note the default differs from the named counts, which are about you | 608.2h: counted once, as the effect applies |
| **any** form is then | `× times`, `+ plus`, halved (`half: 'up'` rounds up, `'down'` rounds down), capped at a numeric `max`, **in that order** — on a count, a `diff`, a `sum`, a `max` / `min` list or a `prop` alike (`{ prop: 'power', of: 'that', half: 'down' }` is "half its power, rounded down") | 107.1a |
| `diff: [a, b]` | `a − b`, never below 0 | 107.1b |
| `sum: [...]` / `max: [...]` / `min: [...]` | over the listed amounts (an empty list is 0) | |
| `prop: 'power' \| 'toughness' \| 'mv'`, `of: <Ref>` | the characteristic of the Ref's first object; last known values once it has left the battlefield | 608.2h |
| `prop: 'life' \| 'cards-in-hand'`, `of: 'you' \| 'that-player' \| 'target-player' \| 'self'` | the player's life total / hand size (`self` = the source's controller) | |

Every sub-amount may itself be any form: `{ sum: [{ diff: [{ prop: 'life', of: 'you' }, 'X'] }, { min: [1, 2] }] }`.
`X` is the item's X. Existing amounts (`number`, `'X'`, `{ count, filter, plus, times, counter }`) are unchanged.

**Amounts with no binding frame.** A token's `dynamicPT`, a `self-pt` static, a `costModifiers.reduce`, a mana
ability's `perEach`, a filter's `mvLE` / `mvEQ` and an as-enters `counters` amount are evaluated outside any
resolving item. There `count: 'objects'` answers `who` from the evaluating player alone — `you`, `each-player` and
`each-opponent` resolve, and the frame-bound words (`target-player`, `that-player`, `controller-of-that`) name
nobody, so the count is 0 rather than every player's objects; a `prop` of anything but `self` / `you` is 0 for the
same reason. Use the frame-bound words only in an effect list.

```json
{ "op": "pump", "target": "that", "power": { "prop": "toughness", "of": "that" }, "toughness": { "prop": "toughness", "of": "that" }, "duration": "eot" }
```
```json
{ "op": "gain-life", "amount": { "diff": [{ "count": "opponent-creatures" }, { "count": "creatures-you-control" }] }, "who": "you" }
```

---

## 3. Targets: `multi`

```ts
interface TargetSpec { kind: CoreTargetKind | 'multi' | …; specs?: TargetSpec[]; /* … */ }
```

`{ kind: 'multi', specs: [A, B, …] }` is several independent instances of the word "target" on one effect ("target
creature and target player", "target creature you control and target creature you don't control"). Each `spec` is
chosen on its own — a legal action, a trigger's automatic pick and the UI all show one group per part — and the picks
land in the effect's target list **in `specs` order**, so `target:0` / `target:1` name them. Within one part the same
object may not be chosen twice (CR 115.3); across parts it may. `targetOptionsFor` on the whole `multi` spec answers
the union of its parts.

An effect keeps **one** target list however many requirements it carries — a `multi` spec's parts, `exchange`'s
second permanent, a `move` whose `what` is a `TargetSpec` and whose `controller` is `'target-player'` ("return target
creature card from a graveyard to the battlefield under target player's control") — and the stack item remembers how
many picks each requirement contributed, in requirement order (`StackItem.targetParts`). On resolution each pick is
checked against **the requirement it answered** (CR 608.2b: a target is illegal if it no longer has the quality that
requirement demanded): "target creature you control and target creature you don't control" drops a creature that
changed sides even though the other part would accept it now, and a pick is never dropped for failing a requirement
it did not answer (the player answering `move`'s `'target-player'` is not measured against the card spec). The spell
fizzles only when every pick is illegal.

```json
{ "op": "damage", "amount": 2, "target": { "kind": "multi", "specs": [{ "kind": "creature" }, { "kind": "player" }] } }
```
```json
{ "op": "exchange", "what": "control", "a": { "kind": "creature", "controller": "you" }, "b": { "kind": "creature", "controller": "opponent" } }
```

**Targets inside containers.** Effects nested in `for-each` / `scoped` / `may` / `unless-pays` may carry their own
`TargetSpec`s: `targetingEffects` (src/engine/legal.ts) descends into them and keys their picks under
`childIndex(parent, k) = parent + (k + 1) / 64^d` (`d` the child's nesting level: one more base-64 digit per level,
exact in binary), the index `applyEffect` hands the child. Up to **six** levels of composition containers and **63**
effects per container list (`NESTING_LIMIT` / `LIST_LIMIT` in src/engine/legal.ts): the script schema rejects a script
past either limit, naming the list, and `childIndex` throws rather than let two effects share one target list
(CR 115.1). The older containers `conditional`, `optional-then` and `optional-pay` do not spend a level:
`targetingEffects` descends into their lists (`sharedLists`) with the container's **own** index — the one `applyEffect`
hands their children — so "if <condition>, you may destroy target creature" asks for its target at cast time, and a
composition container inside them still keys its children apart. Their children therefore share one target list, and
the script schema rejects an older container whose lists hold more than one targeting effect (one effect with several
requirements, a `multi` spec say, is fine): the second would overwrite the first's picks (CR 115.1) — key them apart
with a composition container or split the effect. `delayed-trigger` and `reflexive` are not descended: their effects
become a new stack item that chooses its own targets when it fires (CR 603.7, 603.12).

---

## 4. The ops

Every op below emits the same kind of events / log lines its neighbours do (`zone-change`, `life`, `control`, `note`
…), draws randomness from `g.rng` only, and binds `that` / `those` the way the table says.

### `for-each` — "for each X, …"

```ts
{ op: 'for-each'; over: ObjectSet | 'those' | 'targets'; do: Effect[] }
// ObjectSet = Filter & { zone?: 'battlefield' | 'graveyard' | 'hand' | 'exile' | 'library'; who?: ScopeWho }
```

* `over`: the objects matching the filter in `zone` (default battlefield) of `who` (default every player, APNAP), or
  the current `those`, or every object target of the item.
* The set is a **snapshot** taken before the first iteration (CR 608.2f); an object that has left the zone it was
  found in by the time its turn comes is a new object (CR 400.7) and is skipped, the rest still run.
* Each iteration binds `that` to the iterated object and runs `do`; afterwards `those` is the iterated set (and
  `that` its first object).
* Players: iterate players with `scoped` (§ below), not `for-each`.

```json
{ "op": "for-each", "over": { "types": ["Creature"], "who": "you" }, "do": [{ "op": "counters", "target": "that", "counter": "+1/+1", "amount": 1 }] }
```
```json
{ "op": "for-each", "over": { "types": ["Creature"], "who": "each-opponent" }, "do": [{ "op": "scoped", "who": "controller-of-that", "do": [{ "op": "lose-life", "amount": { "prop": "power", "of": "that" }, "who": "you" }] }] }
```

### `bind` — name the thing later text refers to

```ts
{ op: 'bind'; as: 'that'; from: 'targets' | 'affected' | 'triggering' }
```

* `targets`: `that` / `those` = every object target of the item, in order; if a target is a player, `that-player`
  becomes that player too.
* `triggering`: `that` = the object that caused the trigger.
* `affected`: a no-op (the frame already holds what the last effect touched); it documents intent.

```json
[{ "op": "tap", "target": { "kind": "creature" } }, { "op": "bind", "as": "that", "from": "targets" }, { "op": "damage", "amount": { "prop": "power", "of": "that" }, "target": "that" }]
```
```json
{ "kind": "triggered", "event": { "on": "etb", "self": false, "filter": { "types": ["Creature"] }, "controller": "you" }, "effects": [{ "op": "bind", "as": "that", "from": "triggering" }, { "op": "counters", "target": "that", "counter": "+1/+1", "amount": 1 }], "text": "…" }
```

### `reflexive` — "When you do, …" (CR 603.12)

```ts
{ op: 'reflexive'; when: 'you-do'; effects: Effect[] }
```

Creates a reflexive triggered ability (event `{ on: 'reflexive' }`, engine-synthesised) that goes on the stack after
the current item finishes resolving — **only if the effect immediately before it in the same list actually
happened**. "Happened" is measured: the preceding effect (children included) announced at least one observable
change (any event but a `decision` prompt). A `may` that was declined, a `sacrifice` with nothing to sacrifice, a
`move` that moved nothing all count as "didn't". At the head of a list a `reflexive` never fires. The trigger is
controlled by the item's controller (not a scoped actor), inherits `that` / `those` / `triggering` / `that-player`,
and chooses any targets of its own when it is put on the stack (the controller's automatic pick); the item's X is
not carried.

```json
[{ "op": "may", "effects": [{ "op": "sacrifice", "who": "you", "what": { "types": ["Creature"], "other": true }, "amount": 1 }] }, { "op": "reflexive", "when": "you-do", "effects": [{ "op": "draw", "amount": 2, "who": "you" }] }]
```
```json
[{ "op": "move", "what": { "kind": "creature" }, "to": "exile" }, { "op": "reflexive", "when": "you-do", "effects": [{ "op": "move", "what": "that", "to": "battlefield", "controller": "owner" }] }]
```

### `scoped` — run effects as another player

```ts
{ op: 'scoped'; who: ScopeWho; do: Effect[] }
```

Runs `do` once per named player with `you` rebound to that player (`item.actor`): their `sacrifice who: 'you'`,
their `draw who: 'you'`, their `each-opponent`, their decisions. `each-player` / `each-opponent` run in APNAP order
(CR 101.4; each player's whole block completes before the next player's — the sequential form of 608.2f, which is
what "each opponent sacrifices a creature, then draws a card" needs). Bindings (`that`, targets) are shared with the
enclosing frame.

```json
{ "op": "scoped", "who": "each-opponent", "do": [{ "op": "sacrifice", "who": "you", "what": { "types": ["Creature"] }, "amount": 1 }, { "op": "draw", "amount": 1, "who": "you" }] }
```
```json
{ "op": "scoped", "who": "target-player", "do": [{ "op": "discard", "amount": 1, "who": "you" }] }
```

### `may` — "you may …"

```ts
{ op: 'may'; effects: Effect[]; prompt?: string }
```

A `{ kind: 'may' }` decision to the acting player (shipped agents answer yes: `defaultAnswer`, the AI agents, the
rollout agent; the UI shows a yes/no sheet). Yes runs `effects`; no does nothing and is silent, so a following
`reflexive` sees "didn't".

```json
{ "op": "may", "prompt": "Draw a card?", "effects": [{ "op": "draw", "amount": 1, "who": "you" }] }
```
```json
{ "op": "may", "effects": [{ "op": "move", "what": { "filter": { "types": ["Land"] }, "zone": "hand", "who": "you", "count": 1 }, "to": "battlefield", "controller": "you", "tapped": true }] }
```

### `unless-pays` — "… unless [player] pays [cost]" (CR 118.12)

```ts
{ op: 'unless-pays'; who: ScopeWho; cost: AbilityCost; otherwise: Effect[] }
```

For each named player (APNAP for the `each-*` words): if the cost is payable — mana through the payment planner,
non-mana parts through `nonManaCostPayable` — a `{ kind: 'unless-pays' }` decision asks whether to pay (shipped agents
pay); paying charges the mana and pays the cost parts (`payCost`, with the **source** as the object the parts are
about: `sacrificeSelf` sacrifices the source, `sacrifice` asks that player for one of theirs). A player who does not
or cannot pay gets `otherwise` applied **as `you`** (the same rebinding `scoped` does), so "each opponent discards a
card unless they pay {1}" is `otherwise: [{ op: 'discard', who: 'you', … }]`. `{ mana: <ManaCost> }` is the usual
cost; it is an `AbilityCost` like any other.

```json
{ "op": "unless-pays", "who": "target-player", "cost": { "mana": { "generic": 2, "x": 0, "pips": [], "hybrid": [], "phyrexian": [], "raw": "{2}" } }, "otherwise": [{ "op": "discard", "amount": 1, "who": "you" }] }
```
```json
{ "op": "unless-pays", "who": "each-opponent", "cost": { "sacrifice": { "types": ["Creature"] } }, "otherwise": [{ "op": "lose-life", "amount": 5, "who": "you" }] }
```

### `move` — a general zone move

```ts
{ op: 'move';
  what: TargetSpec | Ref | { filter: Filter; zone: SetZone; who: ScopeWho; count: Amount | 'all'; choose?: 'you' | 'owner' | 'random' };
  to: 'battlefield' | 'graveyard' | 'exile' | 'hand' | 'library' | 'command';
  pos?: 'top' | 'bottom';                                   // library only (default top)
  controller?: 'you' | 'owner' | 'that-player' | 'target-player';   // battlefield only (default owner, CR 610.3c)
  tapped?: boolean; faceDown?: boolean; withCounters?: { counter: string; amount: Amount };
  until?: 'leaves' | 'eot' | 'your-next-end-step' }
```

* `what`: a `TargetSpec` (chosen on cast; the spec's picks are this effect's targets), a Ref, or a **chosen set**:
  `filter` in `zone` of `who`, `count` of them (or `'all'`), chosen by the acting player (`choose: 'you'`, the
  default, a `choose-cards` decision), by each owner among their own (`'owner'`: `count` applies per player, APNAP)
  or at random from `g.rng` (`'random'`). A set that is not larger than `count` needs no decision.
* Objects already in `to` are left alone (a battlefield → battlefield move never "flickers"); a token outside the
  battlefield has ceased to exist and is skipped (CR 111.7); a spell on the stack cannot be put onto the battlefield.
* To the battlefield: `enterBattlefield` with every as-enters replacement, under `controller` (`that-player` /
  `target-player` resolve through the frame), `tapped`, face down (a 2/2 with no abilities, CR 708.2), then
  `withCounters` (through `addCounters`, so counter replacements apply). Elsewhere: `moveTo` (commander redirects,
  "exile instead" and family zone-move replacements all apply; an object a replacement sent elsewhere is not "moved"
  for `until`).
* Binding: `those` = the objects that moved, with the values they had **before** the move (CR 608.2h).
* `until`:
  * `leaves` — only meaningful for `to: 'exile'`: the existing "exile until ~ leaves the battlefield" bookkeeping
    (`exiledUntilLeaves` on the source); the cards return under their owner's control when the source leaves. If
    the source has already left the battlefield when the move would happen, nothing moves (CR 610.3a).
  * `eot` — a delayed trigger at `until-eot:end` (the cleanup step's end-of-turn wipe) returns `those` to the
    battlefield under their owner's control (CR 610.3c); for a move **to** the battlefield it exiles them instead.
  * `your-next-end-step` — the same, at the controller's next end step.
* Log: a note per object put onto the battlefield or onto a library; `moveTo` announces the rest.

```json
{ "op": "move", "what": { "filter": { "types": ["Creature"] }, "zone": "graveyard", "who": "you", "count": 1 }, "to": "battlefield", "controller": "you", "tapped": true, "withCounters": { "counter": "+1/+1", "amount": 1 } }
```
```json
{ "op": "move", "what": { "kind": "creature" }, "to": "exile", "until": "leaves" }
```

### `set-pt` — base power and toughness (layer 7b, CR 613.4b)

```ts
{ op: 'set-pt'; target: TargetSpec | Ref | 'creatures-you-control' | 'all-creatures'; power: Amount; toughness: Amount; base?: true; duration: 'eot' | 'permanent' }
```

Writes `o.ext.setPT = { power, toughness, base?, untilTurn? }` on each targeted permanent on the battlefield;
`computeStaticMods` folds it into `Mods.setPT` **first**, so it replaces the printed / animated base value and
counters, `+N/+N` until-end-of-turn terms and anthems still apply on top (7b before 7c, CR 613.4). A family static that
sets `m.setPT` later in the same pass wins (the closest thing to timestamp order the engine has, CR 613.7). `base` is
recorded (both wordings — "has base power and toughness X/X" and "becomes an X/X" — live in layer 7b). The amounts
are evaluated once, as the effect applies (CR 608.2h). `eot` entries are removed by the cleanup wipe (CR 514.2); every
entry is removed when the object leaves the battlefield (CR 400.7). Not a creature's problem: `set-pt` on a
non-creature is stored and applies the moment it becomes one.

```json
{ "op": "set-pt", "target": "that", "power": 0, "toughness": 1, "base": true, "duration": "eot" }
```
```json
{ "op": "set-pt", "target": "self", "power": { "prop": "life", "of": "you" }, "toughness": { "prop": "life", "of": "you" }, "duration": "permanent" }
```

### `lose-abilities` — layer 6 (CR 613.1f)

```ts
{ op: 'lose-abilities'; target: TargetSpec | Ref | 'creatures-you-control' | 'all-creatures'; keywords?: Keyword[] | 'all'; duration: 'eot' | 'permanent' }
```

Writes `o.ext.lost = { all?, keywords?, untilTurn? }`. With `keywords` absent or `'all'` the object loses **every**
ability: `abilitiesOf` / `printedAbilities` answer nothing (statics, triggers, activated abilities, granted ones),
`keywords` drops the printed, animated and statically granted keywords, `protectedFrom` is off; keyword counters
(CR 122.1) and until-end-of-turn keyword grants are kept — the engine has no timestamps, so later grants are assumed
later (a creature that lost its abilities and then gets a flying counter flies). A `keywords` list removes exactly
those keywords from every source. A later `'all'` loss subsumes an earlier list; a permanent loss is never shortened
by a later `eot` one. `eot` entries end at the cleanup wipe; every entry ends when the object leaves the battlefield.

```json
{ "op": "lose-abilities", "target": { "kind": "creature" }, "keywords": "all", "duration": "eot" }
```
```json
{ "op": "lose-abilities", "target": "all-creatures", "keywords": ["flying"], "duration": "permanent" }
```

### `exchange` — CR 701.12

```ts
{ op: 'exchange'; what: 'life' | 'control'; a: ExchangeSide; b: ExchangeSide }
// ExchangeSide = TargetSpec | Ref | 'you' | 'target-player' | 'that-player' | 'controller-of-that'
```

* `life`: `a` and `b` are players (a `TargetSpec` of kind `player` / `opponent` chosen on cast, a player word, or
  `target:<i>` on a player target). Each player gains or loses the amount needed to reach the other's previous total
  (701.12c) through `gainLife` / `loseLife`, so life-gain replacements, lifelink bookkeeping and life triggers all
  see it. Two `life` events. Nothing happens when both sides are the same player or one has left the game.
* `control`: `a` and `b` are permanents (a `TargetSpec` each — two parts of this effect's targets, in order — or
  Refs). Controllers are swapped through `changeControl` (summoning sickness restarts, CR 302.6; Equipment attached
  to a permanent its controller no longer controls falls off by state-based action; Auras stay). Nothing happens when
  either is off the battlefield or they share a controller (701.12b). Permanent only — control durations are Phase
  9.1 (`o.ext.controlReturn`).

```json
{ "op": "exchange", "what": "life", "a": "you", "b": { "kind": "opponent" } }
```
```json
{ "op": "exchange", "what": "control", "a": "self", "b": { "kind": "creature", "controller": "opponent" } }
```

### `delayed-trigger` — the new firing points (CR 603.7)

```ts
{ op: 'delayed-trigger'; at: DelayedAt; effects: Effect[]; bind?: 'that' | 'those' }
type CoreDelayedAt = 'next-upkeep' | 'next-end-step' | 'your-next-end-step' | 'end-of-combat' | 'this-turn:dies' | 'this-turn:ltb' | 'next-turn:upkeep' | 'until-eot:end';
```

`bind` carries the current binding (`item.affected`) into the trigger (both words bind the whole set; `that` is its
first object).

| at | fires | expires |
|---|---|---|
| `next-upkeep` | the next upkeep step reached — this turn's if it is still ahead | once fired |
| `next-turn:upkeep` | the first upkeep of a **later** turn (`createdTurn < turn`), any player's | once fired |
| `next-end-step` / `your-next-end-step` / `end-of-combat` | as before | once fired |
| `this-turn:dies` | once per bound object that is put into a graveyard from the battlefield this turn (`moveTo`, after replacements: an "exile instead" is not dying), binding **that one object** as `that`; the others stay watched | at this turn's cleanup (CR 603.7b) |
| `this-turn:ltb` | the same for leaving the battlefield by any route | at this turn's cleanup |
| `until-eot:end` | in the cleanup step, right after the end-of-turn wipe (CR 514.2); if it triggers anything, players receive priority and the cleanup step repeats (CR 514.3a) | once fired |

The trigger's source is the item's source; if that source was the resolving spell itself it is still found (the card
is on the stack). A token source that has ceased to exist cannot fire it.

```json
[{ "op": "bind", "as": "that", "from": "targets" }, { "op": "delayed-trigger", "at": "this-turn:dies", "bind": "that", "effects": [{ "op": "move", "what": "that", "to": "exile" }] }, { "op": "damage", "amount": 3, "target": { "kind": "creature" } }]
```
```json
{ "op": "delayed-trigger", "at": "next-turn:upkeep", "effects": [{ "op": "draw", "amount": 1, "who": "you" }] }
```

### Existing ops that take a Ref

So that a bound object can be acted on with the verbs the engine already has, the `target` of these ops accepts a
`Ref` in addition to what it accepted before: `damage`, `destroy`, `exile`, `bounce`, `tap`, `untap`, `pump`,
`grant-keyword`, `counters`, `gain-control`, `regenerate`, `prevent-damage`, `cant-block`, `cant-attack-or-block`,
`remove-from-combat`, `double-power`, `shuffle-into-library`, `multi-counters`, `animate`. The words those ops already
had (`'self'`, `'enchanted'`, `'that'`) mean exactly what the Ref of the same name means. `{ op: 'counters', target:
'that', … }` inside a `for-each` is the idiom for "put a +1/+1 counter on each creature you control".

---

## 5. Decisions

| kind | asked of | answer | shipped default |
|---|---|---|---|
| `{ kind: 'may', prompt, source }` | the acting player | `true` to do it | yes |
| `{ kind: 'unless-pays', prompt, cost, source }` | the player who may pay (only when the cost is payable) | `true` to pay | pay |
| `choose-cards` | `move` with `choose: 'you'` / `'owner'` | as before | first N |

`defaultAnswer`, `AiAgent`, `AutoAgent`, `RolloutAgent`, `ReplayAgent`, the CLI and the web `DecisionSheet` all
handle both; no agent throws on them.

---

## 6. Structural gate (src/cards/scripts.ts)

`for-each`, `bind`, `reflexive`, `scoped`, `may` and `unless-pays` are containers: they count as behaviour only through
what is inside them (`bind` has nothing inside and never counts). `move` with `what.count` `0` and `lose-abilities` with
an empty `keywords` list have zero magnitude; `set-pt` 0/0 does **not** (a 0/0 creature dies), a missing
`power` / `toughness` is a schema error. `exchange` is substantive by nature. See test/scripts.test.ts, "composition
core".

---

## 7. What is deliberately not here

* Control changes with durations (`gain-control` keeps its `eot` flag; `exchange` is permanent) — Phase 9.1.
* Timestamps for layer 6 / 7b ordering — `lose-abilities` and `set-pt` approximate them as documented above.
* Cast-time evaluation of which branch of an older container will run: targets inside `conditional` / `optional-then` / `optional-pay` are asked for (see §3) but are *soft* — an empty option list never refuses the cast, and a pick made for a branch that does not run is simply unused. `then` and `else` still share the container's index (the script schema rejects a script that targets in both; four parser-produced kicker cards do, see HANDOFF §3 item 20).
* `for-each` over players — `scoped` is the player loop.
* Parser rules for the wordings the parser cannot read safely — see §8 "Declines"; scripts and the scenario DSL's
  `scripts` field emit those directly.

---

## 8. Parser wordings (Phase 9.0b, `src/cards/rules/composition.ts`)

The composition rule family teaches `src/cards/parse.ts` the generic wordings above. It is consulted only after every
built-in stage has declined a sentence (the registry contract in `src/cards/rules/types.ts`), so a parse that worked
before 9.0b is byte-identical; `npm run parse:diff` shows what moved. An effect rule is handed the built-in
sub-parsers on an `EffectCtx` (targets, filters, amount phrases, costs, conditions, nested effect lists) and, when the
sentence began with "you may", parse.ts wraps whatever the rule returns in a `may`. Two guards run on every sub-parse
a rule makes: no `unknown` child, and no subtype that the text does not name. Since the 9.0b review every printed
word that becomes a `Filter.subtypes` entry — in the built-in filter parser too — goes through the subtype vocabulary
(`src/cards/subtypes.ts`, generated from the pool by `npm run gen:subtypes` into `src/cards/subtype-vocab.ts`): "Zombies"
→ `Zombie`, "Plains" → `Plains`, "Heroes" → `Hero`, "Locus" → `Locus`, and a word that is no subtype ("you control",
"of their choice", "Target", "non-Angel", "legendary", "snow", "without flying") makes the filter — and the sentence —
unknown rather than a filter no object matches. Wordings are written the way the parser sees them: the card's own
name is `~`.

| wording | op |
|---|---|
| "For each *set*, *effect about it*" (`it`, `that creature`, …) | `for-each` over the set, `do` reads `that` |
| "For each opponent / player, *effect*" | `scoped` `each-opponent` / `each-player` (no target inside: a target cannot be chosen per player) |
| "*effect* for each *set*" (a printed 1 becomes the count, k becomes k × it) | the effect's own amount / count / P&T scaled; `add-mana` gets `perEach` |
| "*Spirits / nonblack creatures / Treefolk and Forests* you control gain *keywords* / get +N/+N until end of turn" | `for-each` over the filter, `grant-keyword` / `pump` on `that` (those ops take no filter) |
| "Each opponent / each player / target player / that player / its controller *verb* …" | `scoped` with the clause rewritten to the second person ("sacrifices a creature, then discards a card" → `sacrifice …`, `discard …` as `you`); a leading "may" is a `may` over the whole block; "… and you *do*" / "…, then you *do*" is the controller's own half and stays outside the block; any other "you" in the clause declines |
| "Each opponent loses half their life, rounded up" and every "*player* loses / gains half their life" | `scoped` around `lose-life` / `gain-life` with `{ prop: 'life', of: 'you', half }` |
| "You may X. When you do, Y" | `may` [X] then `reflexive` [Y] (CR 603.12) |
| "You may X. If you do, Y" | the built-in `optional-then`, whose X / Y slots now accept registry wordings (CR 608.2) |
| "… unless you / they / that player / each opponent pays {2} / pays N life / sacrifices a … / discards a card / returns … / exiles …" | `unless-pays` whose `otherwise` is the clause as the payer; the payer must be the clause's subject (or `you` for an unsubjected clause) |
| "Put / return it / them / that card / those cards / the exiled card(s) onto / to the battlefield [tapped] [under your / its owner's control] [with N counters on it]" | `move` of the Ref (`put` defaults to `controller: 'you'`, `return` to `'owner'`, CR 610.3c) |
| "Put it / them … on top / on the bottom of its owner's library", "… into its owner's graveyard", "return it to its owner's hand", "put it into your hand" | `move` of the Ref |
| "Exile it / that card / those cards until ~ leaves the battlefield"; "exile target … until end of turn" | `move` to exile with `until` |
| "Return all / each *filter* cards from your graveyard to the battlefield / your hand [tapped]"; "put / return up to N *filter* cards from your graveyard onto the battlefield" | `move` of a chosen set (`zone: 'graveyard', who: 'you', count`) |
| "Return [another] target *filter* card [with mana value N or less / X] from your graveyard to the battlefield / your hand"; "put target card from your graveyard on the bottom of your library" | the older `return-from-graveyard` (`target: true`), `mvLE` / `mvEQ` in its filter |
| "Put target *filter* card from a graveyard onto the battlefield under your control" | `move` of a `graveyard-card` target spec |
| "Return ~ from your graveyard to the battlefield [tapped]" | `move` of `self` (parse.ts marks the activated ability `fromGraveyard`) |
| "Destroy / exile / tap / untap / sacrifice that creature / those cards / them / each of them" (after a zone change in the same list; a bare "it" is declined) | `destroy` / `move` / `tap` / `untap` on the Ref; `remove-those` for a sacrifice |
| "Put N *counter* counters on that creature / them / each of them"; "they / those creatures gain *keywords* / get +N/+N until end of turn"; "those creatures don't untap during their controllers' next untap steps" | `counters` / `grant-keyword` / `pump` on `that` / `those`; `no-untap-that` |
| "*sentence with X*, where X is *amount*"; "… deals damage equal to *amount* to …", "… loses / gains life equal to …", "… draws / discards / mills cards equal to …", "put a number of counters on … equal to …", "create a number of … tokens equal to …" | the sentence's X replaced by the amount (a `-X` slot of a pump is negated: the built-in template drops the sign) |
| amounts: "the number of *filter* you control / your opponents control / on the battlefield / in your hand / in your graveyard / in all graveyards / in exile"; "its / that creature's / the sacrificed creature's / the exiled card's / ~'s power / toughness / mana value"; "your life total", "that player's life total"; "the number of cards in your / that player's hand"; "the difference between A and B", "A plus B", "A minus N", "half A, rounded up / down", "twice A", "A plus N" | `count: 'objects'` sets, `prop`, `diff`, `sum`, `half`, `times`, `plus` (built-in named counts are kept where they answer first). "its power" is the source when the sentence is about `~`, the first target when it is about a target, declined when both are in play |
| "Target creature has base power and toughness N/N [until end of turn]", "~ has base power and toughness N/N", "[Until end of turn,] target creature loses all abilities and has base power and toughness N/N" | `set-pt` (`base: true`); the two-effect form is a `scoped` `you` block whose second effect names `target:0` |
| "Target creature loses all abilities [until end of turn]", "~ loses all abilities", "target creature loses *keywords* until end of turn", "all creatures lose all abilities until end of turn" | `lose-abilities` |
| "Exchange life totals with target player / opponent"; "exchange control of target A and target B", "… of two target *X*", "… of ~ and target …" | `exchange` |
| "~ deals N damage to target creature and target player" | one `damage` with a `multi` target spec |
| "Two / three / any number of / up to N target *X* each get +N/+N [and gain …] / each gain … until end of turn"; "destroy / exile / tap / untap any number of target …" | the spec's `count` (`99` + `optional` for "any number") |
| "Exile / destroy / tap / untap target *comma list* …", "… *filter* you don't control with mana value N or less" (the built-in target slot stops at a comma and wants the controller last) | the built-in op through the guarded target parser (an "or" list is claimable when it names types and colours only) |
| "Exile / sacrifice it / them / that creature / those creatures at the beginning of the next end step / your next end step / end of combat"; "return it / them to its owner's hand / to the battlefield … at the beginning of the next end step" | `delayed-trigger` with `bind` and `remove-those` / `move` |
| "When that creature / it dies this turn, …", "when it leaves the battlefield this turn, …", "at the beginning of the next turn's upkeep, …", "at the beginning of the next end step, …", "at the beginning of your next end step, …" | `delayed-trigger` at `this-turn:dies` / `this-turn:ltb` / `next-turn:upkeep` / `next-end-step` / `your-next-end-step` |
| "You may *sentence the family claims*"; "you may A and B" / "you may A, then B" | `may` around the effect(s) (one choice over the whole sentence) |
| "Target creature gains your choice of A or B until end of turn" | `choose-mode` with one `grant-keyword` per mode |
| a few generic wordings on older ops the owner's decks need: "add N mana in any combination of colors", "discard your hand", "draw half X cards, rounded down", "double the power of target … until end of turn", "sacrifice another *filter*", "As long as *condition*, ~ gets +N/+N and can't block" (a line rule) | `add-mana`, `discard`, `draw`, `double-power`, `sacrifice`, `self-pt` + `self-keywords` |

A triggered ability about another object ("Whenever another creature you control enters, ~ deals damage equal to
that creature's power …") gets `{ op: 'bind', as: 'that', from: 'triggering' }` at the head of its effects when the
registry parsed the body and the body reads `that` — the built-ins never see the trigger head and the sentence rule
never does either, so parse.ts adds it (`triggerBody`).

### Declines

The family declines (leaves `unknown`) what the engine has no form for or what it cannot read safely:

* "You may draw a card unless that player pays {4}" (Rhystic Study, Mystic Remora): `unless-pays` runs its
  `otherwise` as the payer, and there is no `ScopeWho` for "the controller of the item" to switch back to.
* an amount that would introduce a target ("draw a card for each tapped creature target opponent controls"), a
  per-player amount under an each-player op ("deals damage to each player equal to half that player's life total"),
  "the greatest power among …", "the total power of …", "that many", a cost or filter with a word the built-in parser
  would drop ("non-Lair land", "nonlegendary"), an "or" list that mixes a type with a subtype or an adjective
  ("creature, Vehicle, or nonbasic land"), a compound subject ("it and Zombies you control gain …").
* a bare "it" under destroy / tap / untap / sacrifice / exile ("… gains indestructible until end of turn. Tap it."):
  too often the source itself, which the frame does not bind.
* "It deals damage equal to its power to each other creature": a leading "it" is rewritten to the source by the
  built-ins, and a damage sourced from a bound creature is not the same effect.
* `scry` / `surveil` with a computed amount (number-only ops), "up to X target …", type changes ("becomes a 0/0
  Elemental creature …" is not a P/T change), "the exiled card's owner", "Exchange target opponent's life total with
  ~'s toughness".
* "destroy / exile / tap / untap target A and target B" never reach the family: the built-in target slot takes the
  whole phrase as one target (a pre-existing lossy parse, docs/HANDOFF.md §3).

### After the 9.0b review (what moved, and why)

* **"target opponent" as a scope is declined.** `ScopeWho` has no opponent-only word and `legal.ts` offers every
  player for `target-player`, so a block scoped that way could be pointed at its own controller (Sphinx of
  Enlightenment drew all four cards itself). "Target opponent draws a card …", "… unless target opponent pays …"
  stay unparsed until the engine has `target-opponent` (docs/HANDOFF.md item 23).
* **"*player* may …" is a `may`.** The clause's leading "may" wraps the block's effects; the built-in sentence path
  does the same for "you may *sentence*" on ops with no `optional` form of their own (`You may mill three cards` →
  `may [mill 3]`; permissions such as "you may play that card this turn" are not actions and are not wrapped).
* **"… and you …" stays yours.** "Its controller loses 2 life and you gain 2 life" is a `scoped controller-of-that`
  block around the loss and a `gain-life` for you after it.
* **A leading "it" / "that creature" after a sentence that named another object is `that`.** "Gain control of
  target creature. Untap that creature. It gains haste until end of turn." grants the haste to the stolen
  creature (`grant-keyword` on `that`), not to the sorcery; with no such antecedent the pronoun is still the
  source (`~`). Only the shapes the family reads (`gains` / `gets` / `has base power` / `loses`) are rewritten; any
  other is honestly unknown.
* **A frame-reading sentence is bound to its antecedent, or unknown — never a silent no-op (9.0b review).** The
  engine fills `item.affected` only after `destroy` / `exile` / `damage` (to an object) / `tap` / `bounce` /
  `token` / `token-copy` / `search` / `return-from-graveyard` / `move` / `for-each` / `bind`, a sacrifice cost or a
  trigger about another object; `pump`, `grant-keyword`, `counters`, `untap`, `gain-control`, `sacrifice` and
  `counter` bind nothing. `parseEffects` therefore checks every paragraph as it assembles it (parse.ts
  `bindAntecedent`): a sentence that reads `that` / `those` / `controller-of-that` / `that-controller` /
  `power-of-that` / `mv-of-that` (or `remove-those` / `no-untap-that` / `attach-to-that`) after a *targeted*
  antecedent that binds nothing gets `{ op: 'bind', as: 'that', from: 'targets' }` put before that antecedent
  (Slave of Bolas, Snakeskin Veil, Spidery Grasp, "Put X +1/+1 counters on target creature, where X is that
  creature's power"; one bind per antecedent, and only when it is the item's only object target so far); after a
  *group* antecedent (`creatures-you-control`, `all-creatures`, `attacking-creatures`, …) every `that` / `those`
  of the sentence becomes a `for-each` over the same set (Gleam of Resistance "Untap those creatures", Dauntless
  Unity's "those creatures get +2/+1 instead" inside the kicked conditional); anything else — an unparsed
  antecedent, a group antecedent with "its controller", a spell target (a stack ref `bind` cannot take: Dream
  Fracture, Access Denied, Undermine) — makes the sentence unknown. A self trigger's "its power / toughness /
  mana value" is the source (`~'s`, `power-of-source`), not the empty frame.
* **Targets by subtype.** "Target Elf you control gets +2/+2 until end of turn", "target Aura", "target Forest": the
  subtype names its permanent type (`subtypeKind`), so the target is a real target spec with a `subtypes` filter —
  never a `for-each` over the words "Target" and "Elf".
* **Costs.** "unless you sacrifice another creature" carries `other: true` (the source cannot pay for itself).
* **Trigger heads.** "Whenever ~ or another Ally you control enters / dies" is an `or` event (self + another with
  `other: true`); "Whenever a creature you control with power 3 or greater enters" keeps the controller out of the
  filter; "you control no Thopters other than ~" is `other: true`; statics' plurals ("All Slivers have …") are the
  vocabulary singular.
* **Restrictions no field carries decline.** "non-Angel creature" (Restoration Angel — an Angel that could target
  itself blinked itself forever, the `verify:pool` hang), "non-Aura enchantment", "legendary / snow creature",
  "creature without flying", "1/1 creature", "creature dealt damage by ~ this turn": the line is unparsed (Phase 10
  script material, or `Filter.notSubtypes` / supertype / `notFlying` fields in 9.1) rather than a wider filter.
