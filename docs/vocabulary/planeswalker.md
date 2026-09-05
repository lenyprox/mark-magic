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

> **These five names are NOT yet writable in a per-card script.** `scripts:check` and stage 1 of `scripts:verify`
> validate against the hand-written core zod barrel in `src/cards/schema.ts`, and the generated `src/cards/_schemas.ts`
> that folds `src/engine/ops/<family>.schema.ts` into `CardScriptChecked` does not exist yet (HANDOFF open issue 26 —
> this family is the first op family, so it is the first to hit it). Every AST block below is therefore documentation
> of the shape the PARSER writes and the engine executes, not a script an author may submit: a script naming `emblem`,
> `loyalty`, `poison-to-total`, `loyalty-any-time` or `compleated` fails schema validation with
> `No matching discriminator`. `src/engine/ops/planeswalker.schema.ts` is written and waiting for that composer.

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

### What an emblem cannot do yet, and what the parser therefore refuses

Its **static** abilities do not apply. `characteristics.ts:computeStaticMods` collects its sources from
`staticSources(s)`, which filters `allPermanents(s)` and has no registry fold beside it — the static half of the
`triggerSources` seam does not exist. The three-line patch is in this wave's `coreChangeNeeded`.

Because of that, the parser claims **exactly one** emblem wording: Teferi, Temporal Archmage's
`loyalty-any-time`, which is not a characteristic of any object and is answered by the family's own `legalActions`.
Every anthem or keyword-granting emblem — Elspeth, Sun's Champion, Gideon, Ally of Zendikar, Sorin, Lord of
Innistrad, Ajani Resolute, Vivien Reid, Garruk, Cursed Huntsman, Domri Rade and Nissa, Who Shakes the World — stays
**unparsed**, so the ability is not offered as a legal action at all. Claiming it would spend the loyalty, log
"you get an emblem with …" and change nothing: an invisible wrong outcome in place of a visible gap, which is the one
thing this family's rules must never do. Those nine lines come back the moment the core gains the fold.

A **script** can still write an anthem emblem (the AST is right and the object is right), and when one resolves the
log says `"…" is a static ability of an emblem, which the engine does not apply yet` — pinned by a scenario, so the
no-op is never silent.

### Example ASTs (see the banner: not yet scriptable)

The first is what an anthem emblem WOULD look like; the parser does not write it and the engine does not apply it.

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
| `target` | a chosen target ("target Gideon planeswalker"), any `Ref` (resolved through `src/engine/refs.ts`, so `triggering` / `target:<i>` / `enchanted` / `sacrificed` / `exiled-with` mean what composition.md says they mean), or one of the two scope words |
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

### Example ASTs (see the banner: not yet scriptable)

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

### Example ASTs (see the banner: not yet scriptable)

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
they stay available at sorcery timing through the core, where `legal.ts` chooses their targets and refuses the
activation outright when a required one has no legal option (CR 601.2c / 602.2b).

Missing a target here is not a missed offer but an **illegal activation**: `game.ts:activateAbility` does not
re-check the action against `legalActions`, and `assignTargets` accepts an empty pick when the option list is empty
too, so an ability wrongly offered without a target either pays its loyalty cost and resolves having targeted
nothing, or is rejected by `performAction` after the AI/UI was told it was legal. `needsTarget` therefore mirrors
every shape `legal.ts:ownTargetSpecs` reads — an object-valued `target`, the **boolean** one `return-from-graveyard`
writes, `move`'s `what`, `exchange`'s `a`/`b`, `reveal-hand-discard`, and the `target-player` / `target-opponent`
words anywhere in the effects — and is wider than it in two directions, because a false positive costs one offer
while a false negative breaks the rules: the printed text is checked for the word "target" first (CR 115.1), which
also catches an ability whose target clause the parser dropped, and a `target` **string** ('creatures-you-control',
'that') is read as the scope word it is rather than as a target. Measured over all 34,513 playable cards: of the 493
loyalty abilities the window could offer, `needsTarget` and `ownTargetSpecs` now disagree on **none** in the unsafe
direction (13 before this pass, all of them `return-from-graveyard` / `exchange` shapes) and on 23 in the cautious
direction.

### Example ASTs (see the banner: not yet scriptable)

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

**Which cards the parser claims.** Only the walkers whose Phyrexian pips are MONO-COLOURED: Vraska, Betrayal's
Sting `{B/P}`, Jace, the Perfected Mind `{U/P}`, Nissa, Ascended Animist `{G/P}{G/P}`. `parseManaCost` has a case for
those (the pip lands in `manaCost.phyrexian`, so removing it really does make the alternative cost 2 mana cheaper)
and **no case at all** for the hybrid `{G/W/P}`, which it silently drops. For Tamiyo, Compleated Sage, Ajani, Sleeper
Agent, Lukka, Bound to Ruin and Nahiri, the Unforgiving the printed cost the engine carries therefore has nothing to
remove, and a "compleated" alternative cost would be the SAME mana plus 2 life and 2 loyalty — strictly dominated,
never right to take, and one more action for the AI to enumerate. The line stays unparsed for those four until
`parseManaCost` learns the symbol; the patch is in this wave's `coreChangeNeeded`.

**How "life was paid" is known.** The engine already pays 2 life for a Phyrexian pip it cannot produce (`castSpell`,
right after `payMana`) but records nothing about having done so, and there is no seam a family can hang on that
branch. The parser therefore writes the life route as the card's own **alternative cost** — the printed cost with its
Phyrexian symbols removed, plus 2 life for each — with the core id `life`. `castWith.alt` records the choice, the AI
enumerates it as a real cast variant, and this hook keys off it.

That leaves one divergence, and it is **not** small: on a board that can pay the printed cost in mana the plain cast
is offered beside the alternative one, and `game.ts` charges the plain cast NEITHER mana NOR life for the Phyrexian
pip (`castSpell` tests `pay.taps.some(t => t.option.includes(c))`, which any land that could have produced the colour
already satisfies). The plain cast is therefore strictly better than the compleated one, and the AI takes it — so the
as-enters only fires on boards where the printed cost is unpayable, which is what the two scenarios pin. Charging the
pip properly is a core fix and is in this wave's `coreChangeNeeded`; until it lands, "compleated" is right when it
happens and unreachable when the mana is there.

### Example ASTs (see the banner: not yet scriptable)

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
| `Compleated` (the keyword line) | the `life` alt cost above plus `{ kind: 'compleated', fewer: 2 × pips }` — only when every printed `/P` symbol is one `parseManaCost` carries (mono-coloured) |
| `You get an emblem with "<text>"` | `emblem` — **only** for Teferi's `loyalty-any-time` sentence (below); a trailing sentence in the same clause is sub-parsed and kept beside it |
| `Put N loyalty counters on target <X> planeswalker` | `loyalty` with a target spec |
| `Put N loyalty counters on each [other] planeswalker you control` | `loyalty` with a scope word |
| `Put N <c> counters on each creature you control and a loyalty counter on each other planeswalker you control` | both, in a `scoped` block (the built-in `" and "` split would leave the second half without a verb) |
| `If target player has fewer than N poison counters, they get a number of poison counters equal to the difference` | `poison-to-total` |
| `Search your library for any number of <X> cards, put them onto the battlefield [tapped], then shuffle` | `search` with `count: 99, optional: true` (CR 701.19: "any number" is a free choice from zero) |
| `Untap it` | `untap` on the `that` binding — the pronoun the composition family's ref rule does not list |
| `It becomes a P/T <Subtype> creature with <keywords> that's still a <type>` | `animate` on `that` (CR 613.1b layer 4: `animate` **adds** types, which is what "that's still a land" says) |
| `Put N <c> counters on [each of] [up to n] target <X>` | `counters` through a guarded target parser (a bare subtype names the permanent type it belongs to) |

The guarded target parser has one job beyond the vocabulary check: the built-in reads a *negated* type word as a
CREATURE target carrying the real type as a filter ("noncreature land", "noncreature artifacts"), which is a kind
`targetOptionsFor` can never satisfy. The single type noun the phrase names — plural included — decides the kind; a
phrase naming SEVERAL ("artifact, creature, or land") is a union the built-in already spelled as an any-of `types`
filter, so its kind widens to `permanent` rather than collapsing onto one of the three; and anything still
unsatisfiable (a kind whose own type the filter excludes) makes the rule decline. Three scenarios pin those.

The emblem's quoted text is turned into abilities for exactly one shape, the `loyalty-any-time` sentence. An emblem
with an **anthem or keyword-granting static** declines because the engine would never apply it (above); one with a
**triggered** or **activated** ability declines because `EffectCtx` hands an effect rule no trigger parser and no
activated-line parser. Either way the wording stays unparsed rather than producing an emblem that silently does less
than it says.

---

## 7. Scenarios

`test/scenarios/planeswalker.ts`, nineteen of them: one per op, per scope word and per keyword parameter, plus one per
review fix, each written so it fails if the op did nothing.

| scenario | CR | what fails without the op |
|---|---|---|
| emblem's triggered ability fires from the command zone | 114.2 | the caster stays at 20 life |
| an emblem outlives the source that made it | 114.5 | the second spell triggers nothing |
| an emblem's static ability says so in the log | 114.3 | a silent no-op instead of a stated one |
| loyalty counters on a target planeswalker | 121.1 | loyalty stays at 4 |
| `each-other-planeswalker-you-control` skips the source | 121.1 | the source gains a counter too |
| `each-planeswalker-you-control` includes the source | 121.1 | the source gains nothing |
| a negative amount removes loyalty counters | 121.3 | loyalty stays at 4 |
| `loyalty` on the `triggering` Ref | 400.7 | the walker that entered gains nothing |
| `poison-to-total` fills the shortfall and never overshoots | 122.1 | 0 poison, or 14 after the second application |
| compleated cast for life | 107.4f | 6 loyalty and 20 life |
| compleated cast for mana keeps its printed loyalty | 107.4f | the as-enters would have fired unconditionally |
| `loyalty-any-time` from a battlefield static | 606.3 | no legal activation in the end step |
| `loyalty-any-time` from an emblem | 606.3 | the same, through the command zone |
| the window skips a targeted ability with no legal target | 601.2c | the `-2` is activated instead of the `+1`: 2 loyalty paid, nothing returned |
| …and skips it when a legal target does exist | 602.2b | the offered activation is refused by `performAction` |
| the targeted ability still works at sorcery timing | 606.3 | the fix would have made it unusable, not sorcery-only |
| "artifact, creature, or land" offers the creature | 115.1 | the cast is refused (only a land could be chosen) |
| the same target offers the artifact | 115.1 | the same |
| "noncreature artifacts" is an artifact target | 115.4 | no legal target, and the trigger resolves doing nothing |

---

## 8. What this family does NOT fix (read before scoring its coverage)

* **Nissa, Who Shakes the World's `+1` is inert, and the family cannot reach it.** "Put three +1/+1 counters on up to
  one target noncreature land you control" is claimed by a **built-in** stage of `parse.ts`, which produces the same
  unsatisfiable `{ kind: 'creature', filter: { notTypes: ['Creature'], types: ['Land'] } }` this family's own
  `target()` exists to prevent — and built-ins run first at every dispatch point, so no rule here is ever offered the
  sentence. The `Untap it` / `becomes a … that's still a land` rules then complete the paragraph correctly, which is
  why the card looked "fully parsed" in the first review. It no longer is (its `-8` is an anthem emblem, which now
  declines), but the `+1` still binds nothing. The one-line built-in fix is in `coreChangeNeeded`.
* **An emblem breaks `undo` in the web app.** `apps/web/workers/game.worker.ts:undo()` rebuilds its def table from the
  deck payloads alone, and an emblem is the first object in the engine with a `CardDef` that is not derivable from a
  deck (`"<Source> emblem"`), so `deserializeState` throws and the undo is reported as "Could not restore". The
  analysis pool is safe because `src/analysis/pool.ts` posts `collectDefs(state)` before each request — the same
  idiom the patch gives `takeSnapshot`, so the snapshot carries the defs its own state needs and `undo()` merges them
  over the deck table. The four-line patch is in `coreChangeNeeded` (applied locally it compiles under
  `npm run web:typecheck` and the serialize round-trip keeps the command zone and `ext.emblems`); nothing a family
  file can do reaches it — giving the emblem a deck-derivable `def` would put a castable planeswalker card in the
  command zone, because `legal.ts:castActionsFor` reads `c.def`, not `defOf(c)`.
