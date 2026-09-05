# Planeswalkers and emblems (Phase 9.1)

The vocabulary the cards that print a loyalty cost need beyond the ordinary ops: the **emblems** a walker's ultimate
hands out (CR 114), the **loyalty counters** it puts on *other* planeswalkers (CR 121), the **timing permission** one
of those emblems grants (CR 606.3), the **poison shortfall** Vraska's ultimate closes (CR 122), and **compleated**
(CR 107.4f). The loyalty *ability* itself is not here: `ActivatedAbility.loyalty` is core, `legal.ts` already offers
one loyalty activation a turn at sorcery speed and `game.ts` already pays the counters as the cost.

Engine module `src/engine/ops/planeswalker.ts`, zod schema `src/engine/ops/planeswalker.schema.ts`, parser rules
`src/cards/rules/planeswalker.ts`, scenarios `test/scenarios/planeswalker.ts`. Rule numbers refer to the
Comprehensive Rules bundled in `data/rules/cr.json`.

| what | discriminator | slot |
|---|---|---|
| `emblem` | `op` | effect |
| `loyalty` | `op` | effect |
| `poison-to-total` | `op` | effect |
| `loyalty-any-time` | `kind` | static ability |
| `compleated` | `kind` | as-enters replacement |

---

## 1. `emblem` — CR 114

```ts
{ op: 'emblem'; abilities: Ability[]; text: string }
```

| field | meaning |
|---|---|
| `abilities` | what the emblem **has** (CR 114.3: an emblem has no characteristics other than its abilities) |
| `text` | the printed quote, used by the log and by the round-trip renderer |

**Semantics.** The op creates a new object in the controller's **command zone** (CR 114.4) whose `CardDef` has no
name the game can see, no types, no mana cost — only `abilities`. It is marked `o.ext.emblem = true`, recorded on
`pl.ext.emblems` as `{ id, source, text }` (JSON-plain, so `clone.ts` deep-copies it and `serialize.ts` round-trips
it), and announced with the family's own `emblem` event.

An emblem is **not a permanent** (CR 114.5): nothing destroys, exiles, bounces, counts or targets it, and it survives
the planeswalker that made it — both of which the scenarios pin.

Its **triggered** abilities are live: `FamilyModule.triggerSources` widens `Game.queueTriggers`' scan (and the
trigger-kind gate in front of it) beyond `allPermanents`, so an emblem is asked about every event exactly as a
permanent is.

### What an emblem cannot do yet

Its **static** abilities do not apply. `characteristics.ts:computeStaticMods` collects its sources from
`staticSources(s)`, which filters `allPermanents(s)` and has no registry fold beside it — the static half of the
`triggerSources` seam does not exist. The op still builds the emblem with those abilities on it (the AST is right,
the object is right, the renderer round-trips it), and it starts working the moment the core gains the fold; until
then "You get an emblem with 'Creatures you control get +2/+2.'" creates an emblem that sits in the command zone
doing nothing. The three-line patch is in this wave's `coreChangeNeeded`, and this is the one thing to read before
scripting a card whose emblem is an anthem.

The family reads emblem statics itself where it can: `loyalty-any-time` below is answered from `legalActions`, which
scans the command zone directly and therefore does not depend on that fold.

### Example scripts

```json
{ "kind": "activated", "cost": {}, "loyalty": -6, "oncePerTurn": true, "sorcerySpeed": true,
  "effects": [{ "op": "emblem", "text": "Creatures you control get +2/+2.",
    "abilities": [{ "kind": "static", "text": "Creatures you control get +2/+2.",
      "effect": { "kind": "anthem", "power": 2, "toughness": 2, "filter": { "types": ["Creature"] }, "scope": "you-control" } }] }],
  "text": "-6: You get an emblem with \"Creatures you control get +2/+2.\"" }
```

```json
{ "kind": "activated", "cost": {}, "loyalty": -8, "oncePerTurn": true, "sorcerySpeed": true,
  "effects": [{ "op": "emblem", "text": "At the beginning of your upkeep, draw a card.",
    "abilities": [{ "kind": "triggered", "event": { "on": "upkeep", "whose": "your" },
      "effects": [{ "op": "draw", "amount": 1, "who": "you" }],
      "text": "At the beginning of your upkeep, draw a card." }] }],
  "text": "-8: You get an emblem with \"At the beginning of your upkeep, draw a card.\"" }
```

---

## 2. `loyalty` — CR 121.1, 121.3, 306.5b

```ts
{ op: 'loyalty';
  target: TargetSpec | Ref | 'each-planeswalker-you-control' | 'each-other-planeswalker-you-control';
  amount: Amount }
```

| field | meaning |
|---|---|
| `target` | a chosen target ("target Gideon planeswalker"), a `Ref` the item has already bound, or one of the two scope words |
| `amount` | how many loyalty counters; **negative removes them** (CR 121.3) |

**Semantics.** Loyalty counters that are *not* an activation cost. `each-other-planeswalker-you-control` excludes the
ability's own source, which is what "each **other** planeswalker you control" means when a walker is the source;
`each-planeswalker-you-control` includes it. Both are limited to the controller's own battlefield (CR 306.1), and an
object that has left the battlefield since the targets were chosen is skipped. The counters go on through
`Game.addCounters`, so the doubling statics see them exactly as the core does — that is, they do not: `replaceCounters`
exempts `loyalty` (CR 121.4 is about counters put on *permanents you control* by an effect, and the engine's
doubling statics are deliberately narrower).

Use the core `counters` op for anything that is not loyalty; use this one for loyalty so the renderer prints the
right words and the scope words exist.

### Example scripts

```json
{ "kind": "activated", "cost": { "mana": { "generic": 3, "x": 0, "pips": ["W"], "hybrid": [], "phyrexian": [], "raw": "{3}{W}" } },
  "effects": [{ "op": "loyalty", "amount": 1, "target": { "kind": "planeswalker", "filter": { "subtypes": ["Gideon"] } } }],
  "text": "{3}{W}: Put a loyalty counter on target Gideon planeswalker." }
```

```json
{ "kind": "activated", "cost": {}, "loyalty": -2, "oncePerTurn": true, "sorcerySpeed": true,
  "effects": [
    { "op": "counters", "target": "creatures-you-control", "counter": "+1/+1", "amount": 1 },
    { "op": "loyalty", "target": "each-other-planeswalker-you-control", "amount": 1 }],
  "text": "-2: Put a +1/+1 counter on each creature you control and a loyalty counter on each other planeswalker you control." }
```

---

## 3. `poison-to-total` — CR 122.1

```ts
{ op: 'poison-to-total'; target: TargetSpec; total: Amount }
```

| field | meaning |
|---|---|
| `target` | the player (a `{ kind: 'player' }` spec: a real target, chosen on activation and re-checked on resolution) |
| `total` | the number of poison counters the player is brought **up to** |

**Semantics.** "If target player has fewer than nine poison counters, they get a number of poison counters equal to
the difference." The shortfall is measured when the ability resolves (CR 608.2h) and is never negative (CR 107.1b):
a player already at or past `total` gets nothing. Ten poison counters still lose the game the usual way (CR 704.5c),
through the ordinary state-based action.

The core has no amount form for a *player's* poison count and `ownTargetSpecs` gives no player target to a `poison`
op, so this is one op rather than a `conditional` over an amount — the op carries its own `target`, which is the one
shape `legal.ts` picks up for any effect.

### Example scripts

```json
{ "kind": "activated", "cost": {}, "loyalty": -9, "oncePerTurn": true, "sorcerySpeed": true,
  "effects": [{ "op": "poison-to-total", "target": { "kind": "player" }, "total": 9 }],
  "text": "-9: If target player has fewer than nine poison counters, they get a number of poison counters equal to the difference." }
```

```json
{ "kind": "spell",
  "effects": [{ "op": "poison-to-total", "target": { "kind": "opponent" }, "total": 5 }],
  "text": "If target opponent has fewer than five poison counters, they get a number of poison counters equal to the difference." }
```

---

## 4. `loyalty-any-time` (static) — CR 606.3, 117.1a

```ts
{ kind: 'loyalty-any-time' }
```

**Semantics.** "You may activate loyalty abilities of planeswalkers you control on any player's turn any time you
could cast an instant." (Teferi, Temporal Archmage's emblem.) A timing permission is not a characteristic of any
object, so the `statics` hook only marks its own source (`Mods.flags.loyaltyAnyTime`) and the work is done in
`legalActions`: when the acting player is **not** at sorcery timing and either an emblem in their command zone or a
permanent they control carries the permission, every loyalty ability of their planeswalkers is offered.

The one-loyalty-ability-a-turn restriction still applies (CR 606.3 only lifts the timing half), and the cost must
still be payable — a `-7` on a walker at 4 loyalty is not offered.

**Limitation.** A `legalActions` hook is synchronous and may not import `legal.ts` (the core imports the registry,
so a value import at module scope is an evaluation cycle), which means it cannot build the `targetOptions` an
activation with targets needs. Loyalty abilities that take a target are therefore **not** offered at instant speed;
they stay available at sorcery timing through the core. `needsTarget` in the family file is deliberately
over-cautious: any nested `target` object and any `target-player` / `target-opponent` word anywhere in the ability's
effects makes it skip.

### Example scripts

```json
{ "kind": "activated", "cost": {}, "loyalty": -10, "oncePerTurn": true, "sorcerySpeed": true,
  "effects": [{ "op": "emblem",
    "text": "You may activate loyalty abilities of planeswalkers you control on any player's turn any time you could cast an instant.",
    "abilities": [{ "kind": "static", "effect": { "kind": "loyalty-any-time" },
      "text": "You may activate loyalty abilities of planeswalkers you control on any player's turn any time you could cast an instant." }] }],
  "text": "-10: You get an emblem with \"You may activate loyalty abilities of planeswalkers you control on any player's turn any time you could cast an instant.\"" }
```

```json
{ "kind": "static", "effect": { "kind": "loyalty-any-time" },
  "text": "You may activate loyalty abilities of planeswalkers you control any time you could cast an instant." }
```

---

## 5. `compleated` (as-enters) — CR 107.4f, 614.1c

```ts
{ kind: 'compleated'; fewer: number }
```

| field | meaning |
|---|---|
| `fewer` | how many loyalty counters fewer it enters with — **two for each Phyrexian pip** the printed cost carries |

**Semantics.** "Compleated ({B/P} can be paid with {B} or 2 life. If life was paid, this planeswalker enters with
two fewer loyalty counters.)" `moveTo` puts the printed loyalty on as the walker enters the battlefield; this
as-enters replacement (CR 614.1c) then takes `fewer` of them off, never below zero, and only when the permanent was
cast paying life.

**How "life was paid" is known.** The engine already pays 2 life for a Phyrexian pip it cannot produce (`castSpell`,
right after `payMana`) but records nothing about having done so, and there is no seam a family can hang on that
branch. The parser therefore writes the life route as the card's own **alternative cost** — the printed cost with its
Phyrexian symbols removed, plus 2 life for each — with the core id `life`. `castWith.alt` records the choice, the AI
enumerates it as a real cast variant, and this hook keys off it.

That leaves one divergence, which is deliberate and small: a *plain* cast that the mana solver happens to pay with
life (because the caster has no source of that colour) enters with full loyalty. The explicit "compleated" cast is
the one that reduces it. See the open issues in the wave report.

### Example scripts

```json
{ "asEnters": [{ "kind": "compleated", "fewer": 2 }],
  "altCosts": [{ "id": "life", "label": "compleated (2 life)", "from": "hand",
    "cost": { "payLife": 2, "mana": { "generic": 4, "x": 0, "pips": ["B"], "hybrid": [], "phyrexian": [], "raw": "{4}{B}" } } }] }
```

```json
{ "asEnters": [{ "kind": "compleated", "fewer": 4 }],
  "altCosts": [{ "id": "life", "label": "compleated (4 life)", "from": "hand",
    "cost": { "payLife": 4, "mana": { "generic": 2, "x": 0, "pips": [], "hybrid": [], "phyrexian": [], "raw": "{2}" } } }] }
```

---

## 6. Parser wordings

Every rule is offered a line only after every built-in stage of `parse.ts` has declined it, and each one declines
rather than claiming text it cannot express.

| wording | what it produces |
|---|---|
| `Compleated` (the keyword line) | the `life` alt cost above plus `{ kind: 'compleated', fewer: 2 × pips }` |
| `You get an emblem with "<text>"` | `emblem`, with the quoted text turned into abilities (below); a trailing sentence in the same clause is sub-parsed and kept beside it |
| `Put N loyalty counters on target <X> planeswalker` | `loyalty` with a target spec |
| `Put N loyalty counters on each [other] planeswalker you control` | `loyalty` with a scope word |
| `Put N <c> counters on each creature you control and a loyalty counter on each other planeswalker you control` | both, in a `scoped` block (the built-in `" and "` split would leave the second half without a verb) |
| `If target player has fewer than N poison counters, they get a number of poison counters equal to the difference` | `poison-to-total` |
| `Search your library for any number of <X> cards, put them onto the battlefield [tapped], then shuffle` | `search` with `count: 99, optional: true` (CR 701.19: "any number" is a free choice from zero) |
| `Untap it` | `untap` on the `that` binding — the pronoun the composition family's ref rule does not list |
| `It becomes a P/T <Subtype> creature with <keywords> that's still a <type>` | `animate` on `that` (CR 613.1b layer 4: `animate` **adds** types, which is what "that's still a land" says) |
| `Put N <c> counters on [each of] [up to n] target <X>` | `counters` through a guarded target parser (a bare subtype names the permanent type it belongs to) |

The emblem's quoted text is turned into abilities for three shapes: `Creatures you control get +N/+N [and have <kw>]`
(an `anthem`), `<Type>s you control have <kw>` (an `anthem` with `anyPermanent`), and the `loyalty-any-time`
sentence. An emblem with a **triggered** or **activated** ability declines — `EffectCtx` hands an effect rule no
trigger parser and no activated-line parser, so those wordings stay unparsed rather than producing an emblem that
silently does less than it says.

---

## 7. Scenarios

`test/scenarios/planeswalker.ts`, eleven of them: one per op, one per scope word, one per keyword parameter, each
written so it fails if the op did nothing.

| scenario | CR | what fails without the op |
|---|---|---|
| emblem's triggered ability fires from the command zone | 114.2 | the caster stays at 20 life |
| an emblem outlives the source that made it | 114.5 | the second spell triggers nothing |
| loyalty counters on a target planeswalker | 121.1 | loyalty stays at 4 |
| `each-other-planeswalker-you-control` skips the source | 121.1 | the source gains a counter too |
| `each-planeswalker-you-control` includes the source | 121.1 | the source gains nothing |
| a negative amount removes loyalty counters | 121.3 | loyalty stays at 4 |
| `poison-to-total` fills the shortfall and never overshoots | 122.1 | 0 poison, or 14 after the second application |
| compleated cast for life | 107.4f | 6 loyalty and 20 life |
| compleated cast for mana keeps its printed loyalty | 107.4f | the as-enters would have fired unconditionally |
| `loyalty-any-time` from a battlefield static | 606.3 | no legal activation in the end step |
| `loyalty-any-time` from an emblem | 606.3 | the same, through the command zone |
