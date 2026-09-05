# transform (Phase 9.1)

Transforming double-faced permanents and everything printed around them: the `transforms` trigger nothing in the
engine used to raise, the day/night cycle (CR 726) with daybound / nightbound, descend (CR 701.51), "if it entered
from your graveyard", turning a face-down permanent face up outside its morph cost, the "at the beginning of your
first main phase" trigger head every werewolf-style "pay {R} to transform" hangs off, and the prepare keyword
action's `prepared` state.

Engine: `src/engine/ops/transform.ts` (+ `transform.schema.ts`). Parser: `src/cards/rules/transform.ts`.
Scenarios: `test/scenarios/transform.ts`. Rule numbers refer to the Comprehensive Rules in `data/rules/cr.json`.

---

## 1. How a transformation is observed

The core already flips a permanent (`{ op: 'transform-self' }`, `game.ts:applyEffect`), but it announces the flip
only as a `transform` **event** — no trigger event is queued, so before this family "Whenever this creature
transforms into …" could never fire on any card.

Routing every flip through this family's own op would not have fixed that: a card that already parses into
`transform-self` would still be silent. So the family **watches** instead. An `sba` hook compares every
double-faced permanent's `activeFace` with the last face it reported and queues a `transforms` event when they
differ. `checkSBA` runs at the top of every priority round and after every resolution (`game.ts:priorityRound`,
`resolveStackFully`), which is exactly where triggers wait to be put on the stack (CR 603.3), so the watcher catches

* the core `transform-self` op,
* this family's `transform` op,
* the automatic daybound / nightbound flips of a day/night change.

Two consequences worth knowing before you write a script:

* **A permanent seen for the first time is only recorded, never reported.** Entering the battlefield with the back
  face up (disturb, "return it transformed") is not a transformation — CR 701.28c: a permanent that is not
  double-faced, or that is not on the battlefield, cannot transform.
* **Two flips inside one resolution are one net change.** "Transform it, then transform it again" leaves the face
  where it started and raises nothing, which is what a state-based observation can see. No printed card does this;
  a script that wants both halves observed must split them across two abilities.

The ability that triggers is the one on the face **that is now up** (CR 701.28a). A "Whenever this creature
transforms into Ulrich, Uncontested Alpha" printed on the back face fires when the permanent turns *into* the back
face; the front face's own trigger fires on the way back. That falls out of `abilitiesOf`, which answers for the
active face, and the scenario `a "whenever this transforms" trigger fires when the permanent turns over to the face
that carries it` pins it.

---

## 2. Effects

### `transform` — CR 701.28

```ts
{ op: 'transform'; target?: TargetSpec | Ref | 'self'; to?: 'front' | 'back'; untap?: boolean }
```

| field | meaning |
|---|---|
| `target` | what to turn over: a chosen `TargetSpec`, a `Ref` (`self`, `that`, `target:0`, `equipped`, …) or the word `self` (the default) |
| `to` | force a face rather than toggling: `'back'` and `'front'` are no-ops when that face is already up (so "transform it" twice with `to: 'back'` flips once) |
| `untap` | untap each permanent that actually turned over ("Transform ~, then untap it") |

A permanent whose card has one face, or that is not on the battlefield, or that is face down, is skipped
(CR 701.28b). A planeswalker face is given that face's starting loyalty (CR 712.4a). The permanents that turned over
are bound as `that` / `those` for the effects after it.

```json
{ "op": "transform", "target": "self", "untap": true }
```
```json
{ "op": "transform", "target": { "kind": "creature", "controller": "you" }, "to": "back" }
```

### `set-day-night` — CR 726.2

```ts
{ op: 'set-day-night'; to: 'day' | 'night' | 'neither' }
```

Sets the game's day/night state (it starts as **neither**, CR 726.1a). A change transforms every daybound permanent
to its back face when it becomes night and every nightbound permanent to its front face when it becomes day
(CR 702.145e / 702.146d), and then queues the `day-night` trigger — but **only for a switch between day and night**:
becoming day out of "neither" does not trigger "whenever day becomes night or night becomes day" (CR 726.2c). Setting
the state it is already in does nothing at all.

```json
{ "op": "set-day-night", "to": "night" }
```
```json
{ "op": "conditional", "condition": { "kind": "day-night", "is": "neither" }, "then": [{ "op": "set-day-night", "to": "day" }] }
```

### `turn-face-up` — CR 713.2

```ts
{ op: 'turn-face-up'; target?: TargetSpec | Ref | 'self'; onlyIf?: 'creature-card' }
```

Turns a face-down permanent face up **without paying anything** — the effect-driven half of CR 713.2, as opposed to
the special action a morph cost buys (`game.ts:turnFaceUp`). `onlyIf: 'creature-card'` skips a face-down permanent
whose card is not a creature ("If it's a creature card, you may turn it face up"). It raises `turned-face-up`, so a
morph / megamorph / disguise trigger fires from it exactly as it does from the paid version. No `+1/+1` counter is
added: nothing was megamorphed.

```json
{ "op": "turn-face-up", "target": { "kind": "face-down-permanent", "controller": "you" } }
```
```json
{ "op": "may", "effects": [{ "op": "turn-face-up", "target": "that", "onlyIf": "creature-card" }] }
```

### `become-prepared` — the prepare keyword action

```ts
{ op: 'become-prepared'; target?: TargetSpec | Ref | 'self'; on?: false }
```

Marks a permanent prepared (`on: false` clears the mark). The marker is public, survives clone and serialize, and is
dropped when the permanent leaves the battlefield (CR 400.7). **What being prepared lets you do — cast a copy of the
card's second face — is not implemented; see "Open issues".**

```json
{ "op": "become-prepared", "target": "self" }
```
```json
{ "op": "become-prepared", "target": "that", "on": false }
```

---

## 3. Conditions

| condition | holds when | rule |
|---|---|---|
| `{ kind: 'day-night', is: 'day' \| 'night' \| 'neither' }` | the game is in that state | 726.1 |
| `{ kind: 'descend', count, among: 'cards' \| 'permanent-cards' \| 'permanent-types' }` | your graveyard holds `count` or more of them | 701.51 |
| `{ kind: 'entered-from', zone, who?: 'you' \| 'any' }` | the source entered the battlefield from that zone; `who: 'you'` also requires it to be its owner's own zone | 400.7 |
| `{ kind: 'prepared' }` | the source is prepared | — |

`descend` covers all three printings: "descend 8" is `among: 'cards'` (CR 701.51b), "descend N" for N of 4–7 is
`among: 'permanent-cards'` (CR 701.51a — artifact, battle, creature, enchantment, land and planeswalker cards), and
"four or more permanent types among cards in your graveyard" is `among: 'permanent-types'`.

`entered-from` is answered from a marker the family records in its `zoneMove` replacement hook — the one moment
`o.zone` still names where the permanent is coming from. Only battlefield arrivals are recorded, and the marker is
deleted the moment the permanent leaves, so a card that dies and comes back is judged on its latest arrival. A token
was never anywhere else, so `entered-from` is false for one.

```json
{ "op": "conditional", "condition": { "kind": "descend", "count": 8, "among": "cards" }, "then": [{ "op": "transform", "target": "self" }] }
```
```json
{ "kind": "triggered", "event": { "on": "etb", "self": true }, "effects": [{ "op": "conditional", "condition": { "kind": "entered-from", "zone": "graveyard", "who": "you" }, "then": [{ "op": "counters", "target": "self", "counter": "+1/+1", "amount": 2 }] }], "text": "…" }
```

---

## 4. Amounts

| count | value | rule |
|---|---|---|
| `permanent-cards-in-graveyard` | permanent cards in your graveyard (fathomless descend) | 110.4c, 701.51a |
| `permanent-types-in-graveyard` | distinct permanent types among the cards in your graveyard | 110.4c |

Both take the usual `plus` / `times` / `half` / `max` modifiers of the shared `AmountExpr`.

```json
{ "op": "gain-life", "amount": { "count": "permanent-cards-in-graveyard" }, "who": "you" }
```
```json
{ "op": "pump", "target": "self", "power": { "count": "permanent-types-in-graveyard" }, "toughness": 0, "duration": "eot" }
```

---

## 5. Triggers

| event | fires | rule |
|---|---|---|
| `{ on: 'transforms', self?, into?, orEnters?, attached?, filter?, controller? }` | the permanent turned over (see §1) | 603.2, 701.28 |
| `{ on: 'day-night', to?: 'day' \| 'night' }` | day became night or night became day; `to` narrows it to one direction | 726.2c |
| `{ on: 'first-main-phase', whose: 'your' \| 'each' }` | the precombat main phase begins (`'each'` = every player's) | 505.1 |
| `{ on: 'turned-face-up', self }` | **core variant, newly live** — a face-down permanent was turned face up | 701.34b, 713.2 |

`transforms` fields: `self` (the default, "this permanent"), `attached` (the permanent the source is attached to —
"When equipped creature transforms"), `filter` + `controller` (another permanent), `into` (only when the face that is
now up is the front / back one), and `orEnters` (the same ability also fires on the source's own `etb`, which is how
"Whenever ~ enters or transforms into ~" is one triggered ability with two firing conditions).

`turned-face-up` is a **core** trigger event with a core AST variant; `game.ts:turnFaceUp` has always raised it and
nothing ever dispatched on it, so every morph / megamorph / disguise "When this creature is turned face up" ability
was silently inert. It was recorded under `"deadEvents"` in `test/fixtures/op-allowlist.json`; this family registers
the handler, so the entry is gone from that list.

```json
{ "kind": "triggered", "event": { "on": "transforms", "self": true, "orEnters": true }, "effects": [{ "op": "pump", "target": { "kind": "creature" }, "power": 4, "toughness": 4, "duration": "eot" }], "text": "…" }
```
```json
{ "kind": "triggered", "event": { "on": "first-main-phase", "whose": "your" }, "effects": [{ "op": "optional-pay", "mana": { "generic": 0, "x": 0, "pips": ["R"], "hybrid": [], "phyrexian": [], "raw": "{R}" }, "then": [{ "op": "transform", "target": "self" }] }], "text": "…" }
```

---

## 6. Statics: daybound and nightbound

```ts
{ kind: 'daybound' } | { kind: 'nightbound' }
```

CR 702.145 / 702.146. They are keywords on the card but they are carried as **statics**, not through
`KeywordRegistry`: the op-coverage vocabulary (`src/verify/opCoverage.ts`) derives the keyword list from the
`CoreKeyword` union alone, so a family keyword would be scored as a discriminator the vocabulary does not list, while
a registered static is enumerated, ratcheted and scenario-covered like every other hook.

Neither adds anything to `Mods`. They are markers, read off the face that is currently up — the front face has
daybound, the back face nightbound — by `set-day-night`, which is what makes a werewolf flip one way at dusk and the
other way at dawn. The line rule that claims the printed `Daybound` / `Nightbound` line also adds
`{ kind: 'day-night-enters', to: 'day' | 'night' }`, which is CR 702.145b / 702.146b.

```json
{ "kind": "static", "effect": { "kind": "daybound" }, "text": "Daybound" }
```
```json
{ "kind": "static", "effect": { "kind": "nightbound" }, "text": "Nightbound" }
```

---

## 7. As-enters

| kind | what it does | rule |
|---|---|---|
| `{ kind: 'day-night-enters', to: 'day' \| 'night' }` | if it is neither day nor night, it becomes that as the permanent enters | 726.2a |
| `{ kind: 'prepared' }` | the permanent enters prepared | — |

```json
{ "asEnters": [{ "kind": "day-night-enters", "to": "day" }] }
```
```json
{ "asEnters": [{ "kind": "prepared" }] }
```

---

## 8. Target kinds

`{ kind: 'face-down-permanent', controller?: 'you' | 'opponent' }` — every face-down permanent on the battlefield
(CR 708.2), optionally narrowed to one side. "Reveal target face-down permanent", "Turn target face-down creature
you control face up".

---

## 9. Step hooks and the day/night cycle

* `'turn-start'` runs CR 726.3 / 726.4 as a turn begins: if it is **day** and the previous turn's active player cast
  no spells during that turn it becomes **night**; if it is **night** and they cast two or more it becomes **day**.
  The previous turn's active player is remembered on `s.ext`, so the check is skipped on the first turn the hook ever
  sees (there is no previous turn to judge).
* `'main1'` raises `first-main-phase` after the step's built-in work and before its priority round, so a trigger from
  it is on the stack when the active player first gets priority in the phase.

---

## 10. Family state (`ext`)

All JSON-plain, deep-copied by `clone.ts` and round-tripped by `serialize.ts`. None of it is hidden information, so
the family registers no `redact` hook.

| key | on | meaning |
|---|---|---|
| `transformFaceSeen` | GameObject | the `activeFace` the watcher last reported on |
| `transformCameFrom` | GameObject | the zone the permanent entered the battlefield from (`entered-from`) |
| `transformPrepared` | GameObject | the prepare marker |
| `dayNight` | GameState | `'day'` / `'night'`; absent means neither (CR 726.1a) |
| `transformPrevAP` | GameState | the previous turn's active player (CR 726.3 / 726.4) |

The three object keys are deleted when the permanent leaves the battlefield (CR 400.7: it is a new object).

---

## 11. Parser wordings

| wording | produces |
|---|---|
| `Whenever ~ transforms into ~` | `{ on: 'transforms', self: true }` |
| `Whenever ~ enters or transforms into ~` | `{ on: 'transforms', self: true, orEnters: true }` |
| `When equipped/enchanted creature transforms` | `{ on: 'transforms', attached: true }` |
| `Whenever another creature you control transforms` | `{ on: 'transforms', filter: …, controller: 'you' }` |
| `Whenever ~ transforms into ~ and at the beginning of your first main phase` | `{ on: 'or', events: [transforms, first-main-phase] }` |
| `Whenever day becomes night or night becomes day` (and each half) | `{ on: 'day-night' }` |
| `At the beginning of your \| each player's [first \| precombat] main phase` | `{ on: 'first-main-phase', whose }` |
| `Daybound` / `Nightbound` (whole line) | the static + `day-night-enters` |
| `If it's neither day nor night, it becomes day as ~ enters.` (whole line) | `asEnters: [{ kind: 'day-night-enters', to: 'day' }]` |
| `It becomes day` / `It becomes night` | `{ op: 'set-day-night', to }` |
| `Transform ~, then untap it` | `{ op: 'transform', target: 'self', untap: true }` |
| `Transform target …` | `{ op: 'transform', target: <spec> }` |
| `return it to the battlefield [tapped and] transformed under its owner's control` | `scoped [move → battlefield, transform to back]` |
| `Turn it face up` / `Turn target face-down creature [you control] face up` | `{ op: 'turn-face-up', … }` |
| `If it's a creature card, you may turn it face up` | `{ op: 'may', effects: [turn-face-up onlyIf creature-card] }` |
| `<N> or more cards / permanent cards / permanent types … in your graveyard` | `{ kind: 'descend', count, among }` |
| `it's day` / `it's night` / `it's neither day nor night` | `{ kind: 'day-night', is }` |
| `it entered from your graveyard` | `{ kind: 'entered-from', zone: 'graveyard', who: 'you' }` |

The `first-main-phase` head is deliberately the widest rule here: it is the head of 14 of this family's own unparsed
clauses ("At the beginning of your first main phase, you may pay {R}. If you do, transform ~.") and of ~50 more cards
across the pool whose bodies already parsed while the head read `unknown`. Those cards keep the unparsed lines they
had — only the trigger event changed shape — and `npm run parse:diff` groups them under "(same unparsed lines)".

---

## 12. Open issues

* **Meld (CR 701.37) is not implemented.** "Exile them, then meld them into Hanweir, the Writhing Township" needs the
  melded permanent's own `CardDef`, and the engine has no name → `CardDef` lookup at runtime (`defOf` reads
  `o.copyDef` or `o.def.backFace`, and `parse.ts` builds no back face for the `meld` layout). One paper card in this
  family's brief carries it.
* **`prepared` is a marker only.** The half that matters — "While it's prepared, you may cast a copy of its spell" —
  needs a `CardDef` for the card's SECOND face, which `parse.ts` does not build for the `prepare` layout
  (`SECOND_FACE_LAYOUTS` in `src/cards/oracle-lines.ts` lists split / adventure / flip only, so `secondFaceLines` is
  empty and those lines are not even counted as unparsed). The engine half is here — `become-prepared`, the `prepared`
  as-enters and the `prepared` condition — but the parser deliberately claims **no** prepared wording: claiming
  "~ enters prepared." would make 26 paper cards read `fullyParsed` while doing nothing at all.
* **"Add X mana of any one color, where X is …" is not expressible.** `{ op: 'add-mana' }`'s `amount` is a plain
  `number`, not an `Amount`, so The Core's back face stays unparsed even though the amount it needs
  (`permanent-cards-in-graveyard`) now exists.
* **Wolf Strike now parses fully but its damage clause is weak.** The `it's night` condition rule finished the card;
  its second clause ("Then it deals damage equal to its power") had already been parsed as
  `{ count: 'power-of-source' }`, which reads the spell, not the pumped creature. The scenario for it asserts the
  pump, which is what this family owns.
