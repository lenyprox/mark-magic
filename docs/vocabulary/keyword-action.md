# Keyword actions (Phase 9.1)

The verbs of CR 701 that a spell or ability *performs*: investigate, adapt, bolster, support, manifest, manifest
dread, cloak, populate, goad, incubate, connive, learn, discover, forage, clash, monstrosity, exert, collect
evidence, endure, suspect, behold, villainous choice and harness — plus **exploit** (CR 702.110), the one keyword
ability whose whole substance is a keyword action.

| file | what it holds |
|---|---|
| `src/engine/ops/keyword-action.ts` | the ops, conditions, triggers, cost parts, the amount form, the step hook, the combat hooks and the Incubator token ability |
| `src/engine/ops/keyword-action.schema.ts` | the zod variants a per-card script is validated against (tooling only) |
| `src/cards/rules/keyword-action.ts` | the printed wordings that produce them |
| `test/scenarios/keyword-action.ts` | one scenario per op, condition, trigger, amount and cost part |

Two things run through the whole family:

* **Everything defined as a shorthand recurses into the core.** "Investigate" *is* "create a Clue token"
  (CR 701.20a), so the op calls `token`; endure's token half calls `token`; populate calls `token` with the chosen
  token's own copiable values; discover's "you may play it" calls `play-exiled`. The core keeps ownership of the
  event stream, the token-doubling statics and the `that` binding.
* **Family state is public.** `monstrous`, `harnessed`, `suspected`, `manifested`, `cloaked`, `clashWon`,
  `goadedBy` / `goadedTurn` are booleans and numbers in the object's `ext` bag, every one of them information all
  players have (a manifested card's *identity* is hidden by the core's own face-down handling), so the family
  registers no `redact` hook.

Every op below binds what it touched as `that` / `those`, so the sentence after it can read the frame
(`docs/vocabulary/composition.md` §Refs): `manifest`, `manifest-dread` and `cloak` bind the face-down permanent
("… then attach ~ to that creature"), `bolster` binds the chosen creature, `support` / `suspect` / `goad` / `exert`
/ `harness` bind their targets, `incubate` binds the Incubator tokens, and `exploit` binds the sacrificed creature.

---

## Effects

### `investigate` — CR 701.20a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | how many times to investigate (one Clue token each) |

Creates `amount` Clue tokens through the core `token` op, so Clue's built-in "{2}, Sacrifice: draw a card" and any
token-doubling static apply. `parse.ts` owns the bare `Investigate.`; the family's rule owns `Investigate twice` and
`Investigate N times`.

```json
{ "op": "investigate", "amount": 2 }
{ "op": "investigate", "amount": { "count": "opponents" } }
```

### `bolster` — CR 701.34a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | how many +1/+1 counters |

Chooses a creature you control with the **least toughness** among creatures you control — you choose among ties —
and puts `amount` +1/+1 counters on it. Does nothing when you control no creatures.

```json
{ "op": "bolster", "amount": 1 }
{ "op": "bolster", "amount": { "count": "creatures-you-control" } }
```

### `support` — CR 701.33a

| field | type | meaning |
|---|---|---|
| `amount` | `number` | the printed N (rendering only — the count lives on the spec) |
| `target` | `TargetSpec` | "up to N other target creatures" |

Puts one +1/+1 counter on each chosen target. `filter.other` is written unconditionally: on a creature source it is
CR 701.33a's own word, and on a noncreature source it excludes nothing (the source was never a legal "target
creature" anyway).

```json
{ "op": "support", "amount": 2, "target": { "kind": "creature", "count": 2, "optional": true, "filter": { "other": true } } }
{ "op": "support", "amount": 3, "target": { "kind": "creature", "count": 3, "optional": true, "controller": "you", "filter": { "other": true } } }
```

### `adapt` — CR 701.42a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | how many +1/+1 counters |

If the source has **no** +1/+1 counters, put `amount` on it; otherwise nothing (and a log line saying so).
`parse.ts` has owned `Adapt N` since before this family with a faithful `conditional` spelling, so only `Adapt X`
reaches the family's rule — the op is what a per-card script writes.

```json
{ "op": "adapt", "amount": 4 }
{ "op": "adapt", "amount": "X" }
```

### `monstrosity` — CR 701.31a-b

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | how many +1/+1 counters |

If the source is not already monstrous, put `amount` +1/+1 counters on it, mark it monstrous (`ext.monstrous`) and
raise the `monstrous` event, which the `{ on: 'monstrous' }` trigger keys off. A second monstrosity does nothing.

```json
{ "op": "monstrosity", "amount": 3 }
{ "op": "monstrosity", "amount": "X" }
```

### `manifest` — CR 701.36a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | how many cards off the top of your library |

Puts the top `amount` cards onto the battlefield face down as 2/2 creatures (`ext.manifested`). The core's own
face-down handling gives them no name, no abilities and no types but Creature (CR 708.2).

```json
{ "op": "manifest", "amount": 1 }
{ "op": "manifest", "amount": 2 }
```

### `manifest-dread` — CR 701.59a

No fields. Look at the top two cards of your library, manifest one (you choose) and put the other into your
graveyard. With one card left in the library, that card is manifested and nothing is discarded.

```json
{ "op": "manifest-dread" }
[{ "op": "manifest-dread" }, { "op": "attach-to-that" }]
```

### `cloak` — CR 701.58a

No fields. Manifest the top card of your library and mark it `ext.cloaked`. **Gap:** the ward {2} a cloaked
permanent has is not simulated (see *Known gaps*).

```json
{ "op": "cloak" }
[{ "op": "cloak" }, { "op": "attach-to-that" }]
```

### `populate` — CR 701.29a

No fields. Choose a creature **token** you control and create a token that is a copy of it. The copy is built from
the chosen token's own `TokenSpec` (its copiable values, CR 707.2), so counters are not copied.

```json
{ "op": "populate" }
[{ "op": "token", "count": 1, "power": 3, "toughness": 3, "colors": ["G"], "types": ["Creature"], "subtypes": ["Centaur"], "keywords": [] }, { "op": "populate" }]
```

### `goad` — CR 701.39a

| field | type | meaning |
|---|---|---|
| `target` | `TargetSpec \| Ref` | the creature to goad |

Records `ext.goadedBy` (the goading player) and `ext.goadedTurn`, and clears them at the start of that player's next
turn (the family's `turn-start` step hook). **Gap:** the attack *requirement* is not enforced (see *Known gaps*).

```json
{ "op": "goad", "target": { "kind": "creature", "controller": "opponent" } }
{ "op": "goad", "target": "that" }
```

### `incubate` — CR 701.54a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | +1/+1 counters on each Incubator token |
| `count` | `Amount?` | how many times to incubate (default 1) |

Creates `count` Incubator tokens (colorless artifacts) with `amount` +1/+1 counters on each. Each carries the
family's built-in "{2}: Transform this artifact", which turns it into a 0/0 Phyrexian artifact creature keeping its
counters.

```json
{ "op": "incubate", "amount": 4 }
{ "op": "incubate", "amount": 1, "count": { "count": "lands-you-control" } }
```

### `connive` — CR 701.48a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | how many cards to draw and discard |
| `target` | `TargetSpec \| Ref` | the creature that connives |

Its controller draws `amount`, discards `amount`, and the creature gets a +1/+1 counter for each **nonland** card
discarded this way. Raises `connives`.

```json
{ "op": "connive", "amount": 1, "target": "self" }
{ "op": "connive", "amount": 2, "target": { "kind": "creature", "controller": "you", "optional": true } }
```

### `learn` — CR 701.50a

No fields. "You may discard a card. If you do, draw a card." (the Lesson sideboard is outside a one-game engine, so
that half of the choice is not offered).

```json
{ "op": "learn" }
[{ "op": "search", "filter": { "types": ["Land"], "basic": true }, "to": "battlefield", "count": 1, "tapped": true }, { "op": "learn" }]
```

### `discover` — CR 701.56a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | the mana-value ceiling |

Exiles cards from the top of your library until a nonland card with mana value ≤ `amount` is exiled, opens a
free-play window on it for the turn (the core `play-exiled` op, `free: true`) and puts the rest on the bottom in a
random order. Raises `discovers`. **Gap:** the real thing casts it during its own resolution (see *Known gaps*).

```json
{ "op": "discover", "amount": 4 }
{ "op": "discover", "amount": { "count": "mv-of-that" } }
```

### `forage` — CR 701.57a

No fields. Exile three cards from your graveyard, **or** sacrifice a Food; you choose when both are open. When
neither is, nothing happens and **no event is emitted**, so a `reflexive` ("When you do, …") after it correctly does
not fire (CR 603.12).

```json
{ "op": "forage" }
[{ "op": "may", "effects": [{ "op": "forage" }] }, { "op": "reflexive", "when": "you-do", "effects": [{ "op": "draw", "amount": 1, "who": "you" }] }]
```

### `clash` — CR 701.19a-b

No fields. You and an opponent each reveal the top card of your library and choose to leave it there or put it on
the bottom; you win if your card had the greater mana value. The result is left on the **source** as
`ext.clashWon`, which the `clash-won` condition reads — that is how "If you win, …" is expressed. Raises `clash`.

```json
[{ "op": "clash" }, { "op": "conditional", "condition": { "kind": "clash-won" }, "then": [{ "op": "counters", "target": "self", "counter": "+1/+1", "amount": 1 }] }]
[{ "op": "clash" }, { "op": "conditional", "condition": { "kind": "clash-won" }, "then": [{ "op": "bounce", "target": "self", "to": "hand" }] }]
```

### `exert` — CR 701.38a

| field | type | meaning |
|---|---|---|
| `target` | `TargetSpec \| Ref` | what is exerted |

The creature won't untap during its controller's next untap step. Raises `exerts`. The printed "You may exert ~ as
it attacks" becomes an **optional** `attacks` trigger whose body is this op (plus a `reflexive` for "When you do,
…"); "Exert this creature" as a *cost* is the `exertSelf` cost part below.

```json
{ "op": "exert", "target": "self" }
{ "op": "exert", "target": { "kind": "creature", "controller": "you" } }
```

### `collect-evidence` — CR 701.62a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | the total mana value to reach |

Exiles cards from your graveyard with total mana value ≥ `amount` (the smallest such set is offered; a chosen set
that does not reach the number falls back to it). Nothing happens — and nothing is emitted — when the graveyard
cannot reach it.

```json
{ "op": "collect-evidence", "amount": 6 }
{ "op": "collect-evidence", "amount": "X" }
```

### `endure` — CR 701.64a

| field | type | meaning |
|---|---|---|
| `amount` | `Amount` | N |
| `target` | `TargetSpec \| Ref` | the creature that endures |

Its controller chooses: N +1/+1 counters on it, **or** an N/N white Spirit creature token.

```json
{ "op": "endure", "amount": 3, "target": "self" }
{ "op": "endure", "amount": { "count": "counters-on-source-any" }, "target": "triggering" }
```

### `suspect` — CR 701.61a

| field | type | meaning |
|---|---|---|
| `target` | `TargetSpec \| Ref` | what becomes suspected |

Marks `ext.suspected`. A suspected creature **can't block** (the family's `canBlock` hook) and has **menace** (its
`blockFixup` hook, which is where the core judges menace too — CR 702.110b, only a finished declaration can).

```json
{ "op": "suspect", "target": { "kind": "creature", "controller": "opponent" } }
{ "op": "suspect", "target": "enchanted" }
```

### `behold` — CR 701.63a

| field | type | meaning |
|---|---|---|
| `what` | `Filter` | what must be beheld ("a Dragon") |

Reveal a matching card from your hand or choose a matching permanent you control. Emits nothing when you have
neither, so a following `reflexive` does not fire. Most printed beholds are an additional **cost** — that is the
`beholdWhat` cost part below.

```json
{ "op": "behold", "what": { "subtypes": ["Dragon"] } }
[{ "op": "may", "effects": [{ "op": "behold", "what": { "subtypes": ["Elf"] } }] }, { "op": "reflexive", "when": "you-do", "effects": [{ "op": "untap", "target": "that" }] }]
```

### `villainous-choice` — CR 701.52a

| field | type | meaning |
|---|---|---|
| `who` | `'each-opponent' \| 'that-player' \| 'target'` | who faces the choice |
| `target` | `TargetSpec?` | with `who: 'target'`, the player spec |
| `modes` | `[Effect[], Effect[]]` | the two options, in printed order |

Each named player, in APNAP order, chooses one of the two modes; the chosen list then runs with **that player** as
`that-player`, so a mode written from the source controller's side ("That player sacrifices a creature, or you
create a token") is spelled with `scoped`.

```json
{ "op": "villainous-choice", "who": "each-opponent", "modes": [[{ "op": "scoped", "who": "that-player", "do": [{ "op": "sacrifice", "who": "you", "what": { "types": ["Creature"] }, "amount": 1 }] }], [{ "op": "draw", "amount": 1, "who": "you" }]] }
{ "op": "villainous-choice", "who": "that-player", "modes": [[{ "op": "scoped", "who": "that-player", "do": [{ "op": "lose-life", "amount": 3, "who": "you" }] }], [{ "op": "scoped", "who": "that-player", "do": [{ "op": "discard", "amount": 1, "who": "you" }] }]] }
```

### `exploit` — CR 702.110a

No fields. "You may sacrifice a creature." If you do, the source **exploits** it: the sacrificed creature is bound
as `that`, and the `exploits` event fires. The printed keyword line `Exploit` becomes an ETB trigger carrying this
op, so `When ~ exploits a creature, …` is a separate `{ on: 'exploits', self: true }` ability, exactly as printed.

```json
{ "op": "exploit" }
[{ "op": "exploit" }, { "op": "reflexive", "when": "you-do", "effects": [{ "op": "draw", "amount": 1, "who": "you" }] }]
```

### `harness` — Marvel Infinity Stones

| field | type | meaning |
|---|---|---|
| `target` | `TargetSpec \| Ref` | the permanent to harness |

Marks `ext.harnessed`, which the `harnessed` condition reads. The printed `∞ — <trigger>` line becomes that trigger
with `intervening: { kind: 'harnessed' }`, so the ability is inert until the permanent has been harnessed.

```json
{ "op": "harness", "target": "self" }
{ "op": "harness", "target": { "kind": "permanent", "controller": "you" } }
```

---

## Conditions

| kind | true when |
|---|---|
| `monstrous` | the source is monstrous (CR 701.31b) |
| `harnessed` | the source has been harnessed |
| `suspected` | the source is suspected (CR 701.61a) |
| `clash-won` | the source's most recent `clash` was won (CR 701.19b, the "If you win" clause) |

```json
{ "op": "conditional", "condition": { "kind": "monstrous" }, "then": [{ "op": "grant-keyword", "target": "self", "keywords": ["trample"], "duration": "permanent" }] }
{ "op": "conditional", "condition": { "kind": "clash-won" }, "then": [{ "op": "draw", "amount": 1, "who": "you" }] }
```

## Triggers

| event | printed head |
|---|---|
| `{ on: 'exploits', self }` | "When ~ exploits a creature" / "Whenever a creature you control exploits a creature" |
| `{ on: 'clash' }` | "Whenever you clash" |
| `{ on: 'connives', self }` | "Whenever a creature you control connives" |
| `{ on: 'exerts' }` | "Whenever you exert a creature" |
| `{ on: 'discovers' }` | "Whenever you discover" |
| `{ on: 'forages' }` | "Whenever you forage" |
| `{ on: 'monstrous', self }` | "When ~ becomes monstrous" |

## Amounts

`{ "count": "counters-on-source-any" }` — every counter on the source, of every kind. The core's
`counters-on-source` needs a counter name; "the number of counters on ~" does not have one.

## Cost parts

| key | value | pays |
|---|---|---|
| `collectEvidence` | `number` | CR 701.62a — exile cards with that total mana value from your graveyard |
| `forage` | `true` | CR 701.57a — exile three cards from your graveyard, or sacrifice a Food |
| `beholdWhat` | `Filter` | CR 701.63a — reveal one from hand or choose one you control |
| `exertSelf` | `true` | CR 701.38b — the source won't untap during your next untap step |

```json
{ "kind": "activated", "cost": { "mana": { "generic": 1, "x": 0, "pips": ["W"], "hybrid": [], "phyrexian": [], "raw": "{1}{W}" }, "collectEvidence": 3 }, "effects": [{ "op": "draw", "amount": 1, "who": "you" }], "text": "…" }
{ "kind": "activated", "cost": { "tap": true, "exertSelf": true }, "effects": [{ "op": "untap", "target": { "kind": "land", "count": 2, "controller": "you" } }], "text": "…" }
```

---

## Parser wordings

| wording | produces |
|---|---|
| `Investigate twice` / `Investigate N times` | `investigate` |
| `Bolster N` / `Support N` / `Monstrosity N` / `Adapt X` | `bolster` / `support` / `monstrosity` / `adapt` |
| `Manifest dread` / `Manifest the top card of your library` / `Cloak the top card of your library` | `manifest-dread` / `manifest` / `cloak` |
| `Populate` / `Forage` / `Clash with an opponent` | `populate` / `forage` / `clash` |
| `Goad <target>` / `Goad it` | `goad` |
| `Incubate N` / `Incubate N twice` | `incubate` |
| `~ connives` / `<target> connives` | `connive` |
| `Discover N` / `Collect evidence N` | `discover` / `collect-evidence` |
| `~ endures N` / `<target> endures N` | `endure` |
| `Suspect <target>` / `Suspect it` / `Suspect enchanted creature` | `suspect` |
| `Behold a <Subtype>` (sentence and cost phrase) | `behold` / `beholdWhat` |
| `Harness ~` | `harness` |
| `Exploit` (whole line) | an ETB trigger carrying `exploit` |
| `You may exert ~ as it attacks[. When you do, …]` (whole line) | an optional `attacks` trigger carrying `exert` |
| `∞ — <trigger>` (whole line) | that trigger, gated on `harnessed` |
| `Exert ~` / `Exert this creature` (cost phrase) | `exertSelf` |
| `Collect evidence N` / `Forage` (cost phrases) | `collectEvidence` / `forage` |
| `If you win` (condition) | `clash-won` |
| `~ is monstrous` / `it's suspected` / `it's harnessed` (conditions) | `monstrous` / `suspected` / `harnessed` |

---

## Known gaps

These are the clauses the family deliberately does **not** claim to simulate exactly. Each is a line in the family's
report; none of them is silent — the behaviour is either absent or logged as an approximation.

1. **Goad does not force the attack.** `Game.combatFrom` reads its attack requirement off printed `mustAttack`
   statics on `o.def.abilities`, which no hook can extend, so a goaded creature is recorded, logged and readable
   (`ext.goadedBy`, the `goaded` log line, the `suspected`-style condition surface) but its controller is still free
   not to attack with it. Fixing it needs a `FamilyModule` hook in that computation (reported as `coreChangeNeeded`).
2. **Discover casts nothing during its own resolution.** CR 701.56b casts the exiled card as part of the discover;
   the engine's cast entry points (`makeStackItem` + `autoPickTargets` + `putTargets`) are private, so the family
   opens a free-play window for the turn instead (the core `play-exiled` op with `free: true`). The card is exiled
   either way, and the player may still play it for free — a turn later at worst.
3. **A cloaked permanent has no ward {2}.** Ward is a printed keyword with a cost the engine reads off the card;
   there is no way to grant a *valued* ward to a permanent from a family hook.
4. **Nothing turns a manifested or cloaked creature face up.** The core's `turn-face-up` action is gated on
   `def.morph`. The permanent stays a face-down 2/2 (which is what most manifest cards are played for).
5. **A face-down manifested permanent still applies its card's as-enters replacements.** `enterBattlefield` runs
   `def.asEnters` before the family sees the object; CR 708.2 says a face-down permanent has none.
6. **"Learn" never fetches a Lesson from outside the game**; only the discard-then-draw half is offered.
7. **A keyword-action line that opens an instant or sorcery is still unparsed.** `parse.ts`'s keyword bail-out
   claims a line beginning with `Learn`, `Populate`, `Support`, `Manifest dread`, `Discover`, `Forage`, `Endure`,
   `Behold`, `Goad`, `Exert`, `Connive`, `Adapt` or `Monstrosity` before the spell-text branch, and a `LineRule`
   cannot contribute to a spell's effect list (there is no `addSpellEffects` on `LineCtx`). Those same wordings
   parse everywhere else — inside a trigger body, an activated body or a permanent's line.
8. **`villainous-choice` has no parser rule and its modes cannot contain targets.** The printed wordings are one
   long em-dashed sentence per card with no shared shape worth a regex, so the op is script-only; and the mode
   lists are not one of `legal.ts`'s `nestedLists`, so a target inside one would never be chosen — a script must
   keep the modes targetless.
