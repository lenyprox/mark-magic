# transform (Phase 9.1)

Transforming double-faced permanents and everything printed around them: the `transforms` trigger nothing in the
engine used to raise, the day/night cycle (CR 731) with daybound / nightbound, descend (CR 207.2c), "if it entered
from your graveyard", turning a face-down permanent face up outside its morph cost, the "at the beginning of your
first main phase" trigger head every werewolf-style "pay {R} to transform" hangs off, and the prepare keyword
action's `prepared` state.

Engine: `src/engine/ops/transform.ts` (+ `transform.schema.ts`). Parser: `src/cards/rules/transform.ts`.
Scenarios: `test/scenarios/transform.ts`. Rule numbers refer to the Comprehensive Rules in `data/rules/cr.json`
(version August 7, 2026) and every one of them was looked up there. Four numbers that read plausibly for this family
are somebody else's rule and appear nowhere here: **701.28 is Convert** (transform is 701.27), **726 is The
Initiative** (day and night is 731), **702.146 is Disturb** (daybound *and* nightbound are both 702.145) and
**701.51 is Open an Attraction** (descend is the ability word of 207.2c over the permanent cards of 110.4a).

---

## 1. How a transformation is observed

The core already flips a permanent (`{ op: 'transform-self' }`, `game.ts:applyEffect`), but it announces the flip
only as a `transform` **event** — no trigger event is queued, so before this family "Whenever this creature
transforms into …" could never fire on any card.

The family observes it twice over, and the two halves cover different flips.

**`flip` announces its own transformation** (`src/engine/ops/transform.ts`). Every face change the family performs —
this family's `transform` op, and the automatic daybound / nightbound flips of a day/night change — queues the
`transforms` event at the instant the face changes, and marks the face as already reported. CR 603.2 makes an ability
trigger when the **event** happens, and nothing requires the object to still be there afterwards (CR 603.10a's
look-back covers leaves-the-battlefield triggers only). That matters constantly, because **a transformation can kill
the permanent that transformed**: every werewolf shrinks when it flips back at dawn (Graveyard Glutton 4/4 →
Graveyard Trespasser 3/3, Tovolar's Packleader 6/6 → 4/4, Ulrich 6/6 → 4/4), so a damaged one is destroyed by the
state-based-action pass that follows the flip. `SBA_HOOKS` run *after* the lethal-damage loop of the same `checkSBA`
pass, so a watcher scanning the battlefield afterwards would find the permanent already in the graveyard and lose the
trigger — which is exactly what happened before this half existed. The scenario *a transforms trigger fires even when
the transformation kills the permanent that transformed* pins the werewolf case and *a self transforms trigger fires
when the flip shrinks the permanent to lethal damage* pins the op's own.

**An `sba` hook is the backstop** for the one flip the family cannot reach: the core `{ op: 'transform-self' }`, which
`game.ts:applyEffect` performs without going through `flip`. It compares every double-faced permanent's `activeFace`
with the last face reported and queues a `transforms` event when they differ. `checkSBA` runs at the top of every
priority round and after every resolution (`game.ts:priorityRound`, `resolveStackFully`), which is where triggers wait
to be put on the stack (CR 603.3).

Three consequences worth knowing before you write a script:

* **A permanent seen for the first time is only recorded, never reported.** Entering the battlefield with the back
  face up is not a transformation: CR 712.14a ("put onto the battlefield transformed" — it *enters* with its back
  face up) and CR 702.145b ("if it is night … it enters transformed") are replacement effects, and CR 701.27a only
  ever transforms a double-faced permanent that is already on the battlefield.
* **Two `transform-self` flips inside one resolution are one net change.** Only the backstop half is a state-based
  observation, so "`transform-self`, then `transform-self` again" leaves the face where it started and raises
  nothing. This family's own op does not have that limit — each of its flips announces itself, so two of them raise
  two events, which is what CR 603.2 asks for. No printed card does either.
* **A core `transform-self` flip that kills the permanent is never reported.** The backstop only sees permanents
  that survive the state-based check, so a shrinking flip whose new toughness is 0 or less (Ulrich of the
  Krallenhorde with four -1/-1 counters turning back, Lambholt Elder // Silverpelt Werewolf) puts the permanent into
  the graveyard without a `transforms` event, and a "whenever another creature you control transforms" watcher
  (Neglected Heirloom) misses it. CR 603.2 says it should trigger; the fix is the core op raising the event itself
  (9.1x). The family's own `flip` announces the transformation before the check, so daybound / nightbound and the
  family's `transform` op are not affected.

The ability that triggers is the one on the face **that is now up** (CR 701.27a). A "Whenever this creature
transforms into Ulrich, Uncontested Alpha" printed on the back face fires when the permanent turns *into* the back
face; the front face's own trigger fires on the way back. That falls out of `abilitiesOf`, which answers for the
active face, and the scenario `a "whenever this transforms" trigger fires when the permanent turns over to the face
that carries it` pins it.

---

## 2. Effects

### `transform` — CR 701.27

```ts
{ op: 'transform'; target?: TargetSpec | Ref | 'self'; to?: 'front' | 'back'; untap?: boolean; asItEnters?: true }
```

| field | meaning |
|---|---|
| `target` | what to turn over: a chosen `TargetSpec`, a `Ref` (`self`, `that`, `target:0`, `equipped`, …) or the word `self` (the default) |
| `to` | force a face rather than toggling: `'back'` and `'front'` are no-ops when that face is already up (so "transform it" twice with `to: 'back'` flips once) |
| `untap` | untap each permanent that actually turned over ("Transform ~, then untap it") |
| `asItEnters` | the subject is **not on the battlefield**: record the face it will arrive with instead of transforming anything (CR 712.14a). `to` says which face; `'back'` is the default |

A permanent whose card has one face, or that is not on the battlefield, or that is face down, is skipped
(CR 701.27c: "nothing happens"). A permanent that is now a planeswalker face is given that face's printed loyalty in
counters (CR 306.5b). The permanents that turned over are bound as `that` / `those` for the effects after it.

**A daybound or nightbound permanent cannot be transformed by this op at all.** The last static ability of each
keyword is "This permanent can't transform except due to its daybound ability" (CR 702.145b) / "… its nightbound
ability" (CR 702.145e), so a generic "transform target creature you control" leaves a werewolf alone and raises no
event. Only the day/night machinery (`set-day-night`, and the continuous CR 702.145c / 702.145f check in the `sba`
hook) is allowed to turn one over.

`asItEnters` is the "return it to the battlefield **transformed**" clause of the four Ojer / Aclazotz gods. It is
*not* a transformation: CR 712.14a makes the card enter with its back face up, so the front face's own
enters-the-battlefield abilities never trigger, no other permanent's "whenever a creature you control enters" sees a
creature (Ojer Axonil returns as *Temple of Power*, a land), and no `transform` event is raised. The op records the
face on the card while it is still in the graveyard and the family's `zoneMove` hook applies it in the instant before
the permanent enters, which is the only moment early enough. Put it **before** the `move` in the list.

```json
{ "op": "transform", "target": "self", "untap": true }
```
```json
{ "op": "transform", "target": { "kind": "creature", "controller": "you" }, "to": "back" }
```
```json
{ "op": "scoped", "who": "you", "do": [
  { "op": "transform", "target": "self", "to": "back", "asItEnters": true },
  { "op": "move", "what": "self", "to": "battlefield", "controller": "owner", "tapped": true }
] }
```

### `set-day-night` — CR 731.1

```ts
{ op: 'set-day-night'; to: 'day' | 'night' | 'neither' }
```

Sets the game's day/night state (it starts as **neither**, CR 731.1). A change transforms every daybound permanent
to its back face when it becomes night and every nightbound permanent to its front face when it becomes day
(CR 702.145b / 702.145e), and then queues the `day-night` trigger — but **only for a switch between day and night**:
becoming day out of "neither" does not trigger "whenever day becomes night or night becomes day" (CR 731.1a). Setting
the state it is already in does nothing at all.

```json
{ "op": "set-day-night", "to": "night" }
```
```json
{ "op": "conditional", "condition": { "kind": "day-night", "is": "neither" }, "then": [{ "op": "set-day-night", "to": "day" }] }
```

### `turn-face-up` — CR 708.7

```ts
{ op: 'turn-face-up'; target?: TargetSpec | Ref | 'self'; onlyIf?: 'creature-card' }
```

Turns a face-down permanent face up **without paying anything** — the effect-driven half of CR 708.7 ("the ability
or rules that allow a permanent to be face down may also allow the permanent's controller to turn it face up"), as
opposed to the morph special action of CR 702.37e (`game.ts:turnFaceUp`). CR 708.8: its copiable values revert. `onlyIf: 'creature-card'` skips a face-down permanent
whose card is not a creature ("If it's a creature card, you may turn it face up"). It raises `turned-face-up`, so a
morph / megamorph / disguise trigger fires from it exactly as it does from the paid version. No `+1/+1` counter is
added: nothing was megamorphed.

```json
{ "op": "turn-face-up", "target": { "kind": "face-down-permanent", "controller": "you" } }
```
```json
{ "op": "may", "effects": [{ "op": "turn-face-up", "target": "that", "onlyIf": "creature-card" }] }
```

### `become-prepared` — the prepare keyword action, CR 722.3a / 722.3b

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
| `{ kind: 'day-night', is: 'day' \| 'night' \| 'neither' }` | the game is in that state | 731.1 |
| `{ kind: 'descend', count, among: 'cards' \| 'permanent-cards' \| 'permanent-types' }` | your graveyard holds `count` or more of them | 207.2c, 110.4a |
| `{ kind: 'entered-from', zone, who?: 'you' \| 'any' }` | the source entered the battlefield from that zone; `who: 'you'` also requires it to be its owner's own zone | 400.7 |
| `{ kind: 'prepared' }` | the source is prepared | 722.3a |

`descend` covers all three printings. Descend is an **ability word** (CR 207.2c): it has no rules meaning of its own,
so what the condition really counts is spelled out by the reminder text. "Descend 8" is `among: 'cards'`, "descend N"
for N of 4–7 is `among: 'permanent-cards'` (CR 110.4a — artifact, battle, creature, enchantment, land and planeswalker
cards), and "four or more permanent types among cards in your graveyard" is `among: 'permanent-types'`. It is *not*
CR 700.11's "descended this turn", a different question the core already answers.

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
| `permanent-cards-in-graveyard` | permanent cards in your graveyard (fathomless descent) | 110.4a |
| `permanent-types-in-graveyard` | distinct permanent types among the cards in your graveyard | 110.4 |

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
| `{ on: 'transforms', self?, into?, orEnters?, attached?, filter?, controller? }` | the permanent turned over (see §1) | 603.2, 701.27e |
| `{ on: 'day-night', to?: 'day' \| 'night' }` | day became night or night became day; `to` narrows it to one direction | 731.1a |
| `{ on: 'first-main-phase', whose: 'your' \| 'each' }` | the precombat main phase begins (`'each'` = every player's) | 505.1 |
| `{ on: 'turned-face-up', self }` | **core variant, newly live** — a face-down permanent was turned face up | 702.37e, 708.7 |

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

### `first-main-phase` and inert bodies

`first-main-phase` is the only head this family adds that fires **every turn, on every permanent that carries it**,
and the parser contract cannot gate it: `TriggerRule.make` is handed the trigger head alone, never the body. Across
the pool the head sits on 56 abilities, and only 19 of them have a body the engine can actually play.

* **33 hold an `unknown` clause** (Ripples of Undeath, Advanced Reconstruction, Sab-Sunen, Coalition Relic, …).
  Claiming the head on those would put an ability on the stack once a turn for the rest of the game whose only
  observable effect is an `unsimulated` event: strictly worse than the pre-9.1 reading, where the head parsed as
  `{ on: 'unknown' }` and the ability never fired at all. Two of the four `fidelity:check` pairings failed that way.
* **4 hold no `unknown` at all and still parse to something the engine reads wrong** — Static Prison, Electrozoa,
  Black Market, Altar of Shadows. See "Open issues": both root causes are core defects, and both existed before this
  family. `unknown` cannot find them, so a second predicate (`misparsed`) names the two shapes explicitly.

So the family's discipline — *decline rather than claim what you cannot express* — is applied one hop later, in the
engine: **the trigger fires only for an ability whose whole body (and intervening-if) the engine can play**
(`bodySimulable`, `src/engine/ops/transform.ts`). The 19 complete cards behave as written; the other 37 keep exactly
their pre-9.1 behaviour and come alive by themselves the moment the missing clause or the core fix lands. A script
you write by hand is never affected by the first gate (it may not contain an `unknown` at all) and is affected by the
second only if it writes one of the two broken shapes, which it should not.

---

## 6. Statics: daybound and nightbound

```ts
{ kind: 'daybound' } | { kind: 'nightbound' }
```

Both are CR 702.145 (702.145b defines daybound, 702.145e nightbound; 702.146 is Disturb). They are keywords on the
card but they are carried as **statics**, not through
`KeywordRegistry`: the op-coverage vocabulary (`src/verify/opCoverage.ts`) derives the keyword list from the
`CoreKeyword` union alone, so a family keyword would be scored as a discriminator the vocabulary does not list, while
a registered static is enumerated, ratcheted and scenario-covered like every other hook.

Neither adds anything to `Mods`. They are markers, read off the face that is currently up — the front face has
daybound, the back face nightbound — by `set-day-night`, by the continuous check in the `sba` hook and by the
`transform` op's can't-transform gate.

**Daybound is three static abilities and all three are implemented** (CR 702.145b), nightbound the mirror two
(CR 702.145e):

| ability | where it lives |
|---|---|
| "If it is night and this permanent is represented by a double-faced card, it enters transformed" | the `day-night-enters` as-enters, §7 — a replacement (CR 614.1), so the **back** face's enter triggers are the ones that fire and no `transform` event is raised |
| "As it becomes night, if this permanent is front face up, transform it" (and the nightbound mirror at dawn) | `set-day-night` |
| "This permanent can't transform except due to its daybound ability" | the `transform` op's gate, §2 |

On top of those, CR 702.145c and CR 702.145f are **continuous** ("any time … this happens immediately and isn't a
state-based action"): a front-face-up daybound permanent while it is night, or a back-face-up nightbound permanent
while it is day, is put back on the right face. The SBA loop is the only continuous check the engine has, so both run
from the family's `sba` hook, which returns `true` when it corrected a face so the loop runs again. That is also the
safety net for the one flip the family cannot gate — the **core** `{ op: 'transform-self' }` op, which does not go
through this family's `flip` (see "Open issues").

The line rule that claims the printed `Daybound` / `Nightbound` line also adds
`{ kind: 'day-night-enters', to: 'day' | 'night' }`, which carries CR 702.145d / 702.145g as well as 702.145b.

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
| `{ kind: 'day-night-enters', to: 'day' \| 'night' }` | if it is neither day nor night, it becomes that as the permanent enters; and, on a **daybound** permanent, it enters transformed when it is already night | 731.1, 702.145b, 702.145d, 702.145g |
| `{ kind: 'prepared' }` | the permanent enters prepared | 722.3a |

```json
{ "asEnters": [{ "kind": "day-night-enters", "to": "day" }] }
```
```json
{ "asEnters": [{ "kind": "prepared" }] }
```

---

## 8. Target kinds

`{ kind: 'face-down-permanent', controller?: 'you' | 'opponent', filter?: Filter }` — every face-down permanent on
the battlefield (CR 708.2), optionally narrowed to one side. "Reveal target face-down permanent", "Turn target
face-down creature you control face up" (Ixidor, Skirk Alarmist, Expose the Culprit).

The kind repeats the whole targetability gate itself, and a family kind must. `legal.ts:targetOptionsFor` applies
shroud (CR 702.18a), hexproof (CR 702.11b), protection (CR 702.16e) and `spec.filter` (CR 115.4) in a `targetable()`
closure that is private to that function's own `switch` cases; a registry kind is reached from the `default:` branch
and is handed nothing but the raw `spec`. A face-down permanent has no characteristics of its own (CR 708.2a: a 2/2
creature with no text, name or subtypes), so everything the gate can match is something an *external* effect gave it
— Lightning Greaves' shroud, an Aura, a granted keyword — which is exactly the case that leaked before this was
fixed. Two scenarios pin it, one per half.

---

## 9. Step hooks and the day/night cycle

* `'turn-start'` runs CR 731.2a / 731.2b as a turn begins (CR 731.2 puts the check in the untap step): if it is **day** and the previous turn's active player cast
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
| `transformPrepared` | GameObject | the prepare marker (CR 722.3a) |
| `transformOnEnter` | GameObject | the face this card will arrive with (`asItEnters`, CR 712.14a); consumed by the `zoneMove` hook |
| `dayNight` | GameState | `'day'` / `'night'`; absent means neither (CR 731.1) |
| `transformPrevAP` | GameState | the previous turn's active player (CR 731.2a / 731.2b) |

The four object keys are deleted when the permanent leaves the battlefield (CR 400.7: it is a new object).

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
| `return it to the battlefield [tapped and] transformed under its owner's control` | `scoped [transform to back asItEnters, move → battlefield]` (CR 712.14a: it *enters* transformed) |
| `Turn it face up` / `Turn target face-down creature [you control] face up` | `{ op: 'turn-face-up', … }` |
| `If it's a creature card, you may turn it face up` | `{ op: 'may', effects: [turn-face-up onlyIf creature-card] }` |
| `<N> or more cards / permanent cards / permanent types … in your graveyard` | `{ kind: 'descend', count, among }` |
| `it's day` / `it's night` / `it's neither day nor night` | `{ kind: 'day-night', is }` |
| `it entered from your graveyard` | `{ kind: 'entered-from', zone: 'graveyard', who: 'you' }` |

The `first-main-phase` head is deliberately the widest rule here: it is the head of this family's own "At the
beginning of your first main phase, you may pay {R}. If you do, transform ~." clauses and of ~50 more cards across
the pool. Those cards keep the unparsed lines they had — only the trigger event changed shape — and
`npm run parse:diff` groups them under "(same unparsed lines)". A card whose body is still partly `unknown`, or whose
body parses into one of the two shapes the engine reads wrong, also keeps its *behaviour*: the engine-side gate in §5
stops the ability firing until the body is complete and playable.

---

## 12. Open issues

* **Meld (CR 701.42) is not implemented.** "Exile them, then meld them into Hanweir, the Writhing Township" needs the
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
* **The core `{ op: 'transform-self' }` is not gated by daybound's "can't transform" ability.** This family's own
  `transform` op refuses to flip a daybound / nightbound permanent (CR 702.145b / 702.145e), but `transform-self` is
  a core op applied in `game.ts:applyEffect` and a family cannot intercept it. In practice the continuous CR 702.145c
  / 702.145f check in the `sba` hook puts the face straight back whenever it is day or night — the scenario
  *a daybound permanent forced onto its night face while it is day is transformed straight back* pins exactly that —
  so the only window it stays wrong in is "neither day nor night", where no printed card can reach it. Closing it
  properly is a two-line core change (see `coreChangeNeeded` in the 9.1 review).
* **Wolf Strike counts as parsed but its damage clause deals 0.** The family's `it's night` condition finished the
  card, so it now reads `fullyParsed` — but its second clause, "Then it deals damage equal to its power to target
  creature you don't control", was *already* being mis-parsed by a built-in rule (`parse.ts:256`,
  `^~ deals damage equal to its power to <target>$` → `{ count: 'power-of-source' }`). In a spell's text "it" is the
  creature the first clause pumped, not the spell; `power-of-source` reads the spell, whose power is 0, so the card
  kills nothing. **Do not count Wolf Strike as a coverage gain**: the pump half works and is what the family's own
  scenario asserts, the damage half needs the core parser fix reported with the 9.1 review. Nothing in this family
  can reach it — a built-in sentence rule claims that clause before any registry rule is offered it.
* **`{E}` in a printed cost parses as a free MANA cost, so "unless you pay {E}" is auto-paid.** Energy is CR 118.12:
  an energy counter is paid from the player's own pool, not with mana. The mana-cost parser drops the symbol and
  leaves `{ generic: 0, x: 0, pips: [], hybrid: [], phyrexian: [], raw: '{E}' }` — a cost of nothing — which the
  engine pays for free and logs as "pays {E}". Under this family's `first-main-phase` head that hits **Static
  Prison** (never sacrificed) and **Electrozoa** (never tapped), and it is *not* new: **Lathnu Hellion** carries the
  same shape under the core `end-step` head and is already live at base, and three such abilities exist in the pool.
  The engine gate in §5 now declines the two under this family's head, restoring the pre-9.1 silence, but the parse
  itself is still wrong, so **do not count Static Prison or Electrozoa as a coverage gain**. The fix is in
  `src/cards/cost.ts` / the mana-cost parser and is reported in the 9.1 review's `coreChangeNeeded`.
* **`{ op: 'add-mana' }`'s `perEach` is never read.** `game.ts`'s `case 'add-mana'` looks at `e.mana` and `e.amount`
  only, so `{ op: 'add-mana', mana: ['B'], perEach: { count: 'counters-on-source', counter: 'charge' } }` adds
  exactly one {B} however many charge counters are on the permanent. Under this family's head that is **Black
  Market** and **Altar of Shadows**; a CardDB sweep finds **51 more** abilities with the same unread field outside it
  (Everflowing Chalice, Rofellos, Magus of the Coffers, …), so it is a pre-existing core defect, not a 9.1 one. As
  above, the §5 gate declines the two in reach and **neither card counts as a coverage gain**; the patch is in the
  9.1 review's `coreChangeNeeded`.
* **`bodySimulable` can only decline shapes it is told about.** The `unknown` half of the gate is general; the
  `misparsed` half is a hand-written list of two known-wrong shapes, found by sweeping every `first-main-phase` body
  in the CardDB. A third mis-parse of the same kind would slip through until someone adds it. There is no general
  test for "this AST is well-formed but semantically wrong", which is why the two entries above are also filed as
  core fixes rather than left to the gate.
* **The family's zod variants reach no schema.** `src/engine/ops/transform.schema.ts` exports the `FamilySchema` the
  §1.5 schema composer is meant to fold into `EffectSchema` / `ConditionSchema` / `TriggerEventSchema` /
  `AsEntersSchema` / `StaticEffectSchema` and the `TARGET_KINDS` / `AMOUNT_COUNTS` enums, but that composer does not
  exist yet, so `src/cards/schema.ts` rejects this family's AST and both halves of `test/schema-types.test.ts` (the
  `Equals<>` pins under `typecheck:schema`, and the "every ability of every 10th playable card validates" runtime
  test) are red. Every 9.1 family hits it; the patch is in `coreChangeNeeded` and touches only `src/cards/schema.ts`,
  which this family is not allowed to edit.
