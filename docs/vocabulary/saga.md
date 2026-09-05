# Saga (Phase 9.1)

Chapter abilities and the lore-counter track: what the engine's built-in Saga skeleton could not say.

180 paper cards carry this family in their unparsed lines. Nothing here re-implements a Saga from scratch — the core
already enters one with a lore counter, adds one as its controller's precombat main phase begins, dispatches
`{ on: 'chapter' }` triggered abilities and sacrifices the permanent once the final chapter has left the stack
(`src/engine/game.ts` lines 747, 420, 2184 and 2081). What the core has no words for is everything printed *about*
that track:

| what the cards say | what the core did | what this family adds |
|---|---|---|
| "Put two lore counters on target Saga you control" (Storyweave) | one `chapter` event per counter, matched against the *total* — a two-counter jump skips a chapter | `saga-lore`, which queues one event per **crossed** chapter number (CR 714.2b) |
| "Read ahead" (11 cards) | the keyword line was recorded as unparsed and the Saga started at chapter I | the `read-ahead` as-enters kind + a counter replacement (CR 714.4b) |
| "Whenever you put a lore counter on a Saga you control" (Sigurd) | nothing | the `lore-counter-put` trigger |
| "Whenever the final chapter ability of a Saga you control triggers / resolves" (Historian's Boon, Narci, Tom Bombadil) | nothing | the `saga-final-chapter` trigger, both timings |
| "target Saga you control" (Keldon Warcaller, Satsuki, Clash of the Eikons, …) | no such target kind | the `saga` target kind |
| "as long as there are four or more lore counters among Sagas you control" (Tom Bombadil) | nothing | the `saga-lore-ge` condition |
| "I, II, III — Pain — You draw a card and you lose 1 life." | the chapter numerals were eaten before the chapter branch saw them; the card got a *static* ability and no `finalChapter` | two parser rules (§5) |

Everything else a chapter says is ordinary vocabulary: a chapter body goes through `parseEffects` like any other
triggered ability's, so the composition ops (`for-each`, `scoped`, `may`, `move`, `unless-pays`, …) compose chapters
with no help from here.

Files: `src/engine/ops/saga.ts` (behaviour), `src/engine/ops/saga.schema.ts` (zod variants for the script tooling),
`src/cards/rules/saga.ts` (wordings), `test/scenarios/saga.ts` (16 scenarios: one per op, trigger, condition,
as-enters kind, target kind and per keyword parameter of each). Rule numbers refer to the Comprehensive Rules
bundled in `data/rules/cr.json`.

---

## 1. The lore track, and what triggers on it

CR 714.2a puts the chapter numbers on the *abilities*; the counters live on the permanent. CR 714.2b is the rule the
core could not express:

> A chapter ability triggers when one or more lore counters are put onto the Saga such that the number of lore
> counters on it was less than the ability's chapter number and became greater than or equal to it.

So the abilities that trigger are the ones whose number the total **crossed**, not the one it landed on. Putting two
counters on a fresh Saga triggers chapter I and chapter II, in that order. Removing counters never triggers anything.

The family owns the `chapter` dispatch to say this:

```ts
chapter: (ev, perm, ctx, _s, event) => {
  if (event !== 'chapter' || ctx.obj !== perm) return false;
  return ctx.amount !== undefined ? ev.chapters.includes(ctx.amount) : crossedAny(ev.chapters, crossed(perm));
},
```

`TriggerCtx.amount` is the crossed chapter number, and `saga-lore` sets it. The core's two queues (a Saga entering
the battlefield, and the precombat-main lore counter) carry no amount, and the crossing is then read from
`o.ext.sagaLoreFrom` — the lore total `replacements.counters` recorded a moment before `addCounters` applied the
delta. Reading the *total* instead (which is what the core's own `case 'chapter'` does) is only right when the delta
was exactly one: with a counter multiplier in play (Doubling Season, CR 614.1c) the precombat-main counter takes a
Saga from II straight to IV, no ability lists chapter 4, chapter III never triggers at all and CR 714.4 then
sacrifices the Saga with a chapter unrun.

**Resolution order.** A crossing is queued **highest first**, because `putTriggersOnStack` pushes the queue onto the
stack in order and a stack resolves top-down: the last one pushed resolves first. Chapter I therefore resolves before
chapter II, which is what this document promises and the only order whose board is right — the token chapter II
makes has to exist before chapter III pumps it (CR 611.2c fixes the affected set at resolution). CR 603.3b makes the
order the controller's choice, so this is the family's default rather than a rule.

> **Cost.** A permanent carrying a registry trigger makes `queueTriggers` scan every event (`triggerKinds` adds
> `'*'`). Every Saga carries `on: 'chapter'`, so a battlefield with a Saga on it pays the full permanents-by-abilities
> scan on every event rather than only on `chapter`. That is the price of correct chapter crossing, and it is paid
> only while a Saga is in play.
>
> The obvious alternative — have `saga-lore` add its counters one at a time and let the core matcher read the running
> total — does **not** work: CR 614.1c applies a counter multiplier to each event, so under Doubling Season one-at-a-time
> gives running totals 0, 2, 4 and chapter I is never the total at all. The crossing has to be computed from a delta,
> and a delta is only knowable after the replacements have run.

---

## 2. The ops

### `saga-lore` — "Put a lore counter on target Saga you control"

```ts
{ op: 'saga-lore'; target: TargetSpec | 'each-saga-you-control'; amount: Amount; remove?: boolean }
```

| field | meaning |
|---|---|
| `target` | the Sagas: a spec (normally `{ kind: 'saga', controller: 'you' }`, §4), or every Saga the resolving player controls |
| `amount` | how many counters — never negative; use `remove` for the other direction |
| `remove` | take the counters off instead. A removal never triggers a chapter ability (CR 714.2b) and never raises `lore-counter-put` |

Non-Sagas among the chosen objects are skipped, and so is anything that has left the battlefield since the targets
were chosen (CR 400.7). For each Saga that actually gained counters the op raises one `lore-counter-put` event and
then one `chapter` event per crossed number, highest first so that chapter I *resolves* first (§1).

Renderer, one line per target shape the parser rule can produce:

| spec | English |
|---|---|
| `{ kind: 'saga', controller: 'you' }` | `Put a lore counter on target Saga you control` |
| `{ ..., count: 1, optional: true }` | `Put a lore counter on up to one target Saga you control` |
| `{ ..., count: 99, optional: true }` | `Put a lore counter on any number of target Sagas you control` |
| `{ ..., count: 2 }` | `Put a lore counter on two target Sagas you control` |
| `'each-saga-you-control'` | `Put a lore counter on each Saga you control` |

(The round trip is the *meaning*, not the printed characters: Chong and Lily prints "on each of any number of target
Sagas you control", which names the same set.)

```json
{ "op": "saga-lore", "target": { "kind": "saga", "controller": "you" }, "amount": 1 }
```
```json
{ "op": "saga-lore", "target": "each-saga-you-control", "amount": 1 }
```

Two more shapes the printed cards use:

```json
{ "op": "saga-lore", "target": { "kind": "saga", "controller": "you" }, "amount": 1, "remove": true }
```
```json
{ "op": "saga-lore", "target": { "kind": "saga", "controller": "you", "count": 99, "optional": true }, "amount": 1 }
```

---

## 3. Conditions, triggers and as-enters

### `saga-lore-ge` (condition) — "as long as there are N or more lore counters among Sagas you control"

```ts
{ kind: 'saga-lore-ge'; who: 'you' | 'opponent' | 'any'; value: number }
```

Sums the lore counters on the Sagas one side controls (`opponent` / `any` take the largest single opponent's total,
the way the core's `life-le` / `controls` conditions read a side). Phasing-aware: it goes through
`chars.battlefieldOf`, so a phased-out Saga contributes nothing (CR 702.26e).

```json
{ "kind": "static", "effect": { "kind": "self-keywords", "keywords": ["hexproof", "indestructible"], "condition": { "kind": "saga-lore-ge", "who": "you", "value": 4 } }, "text": "…" }
```
```json
{ "op": "conditional", "condition": { "kind": "saga-lore-ge", "who": "you", "value": 1 }, "then": [{ "op": "draw", "amount": 1, "who": "you" }] }
```

### `lore-counter-put` (trigger) — "Whenever you put a lore counter on a Saga you control"

```ts
{ on: 'lore-counter-put'; who: 'you' | 'any' }
```

Fires once per Saga that gained one or more lore counters, however many landed (CR 714.2b speaks of "one or more").
`who: 'you'` restricts it to Sagas the trigger's controller controls. It answers **both** paths: the family's own
event, and the core's amount-less `chapter` queue — which is exactly one per lore counter the core adds (a Saga
entering, and the precombat-main counter), so each core addition counts once and never twice.

```json
{ "kind": "triggered", "event": { "on": "lore-counter-put", "who": "you" }, "effects": [{ "op": "counters", "target": { "kind": "creature", "optional": true, "count": 1, "filter": { "other": true } }, "counter": "+1/+1", "amount": 1 }], "text": "…" }
```
```json
{ "kind": "triggered", "event": { "on": "lore-counter-put", "who": "any" }, "effects": [{ "op": "gain-life", "amount": 1, "who": "you" }], "text": "…" }
```

### `saga-final-chapter` (trigger) — "Whenever the final chapter ability of a Saga you control …"

```ts
{ on: 'saga-final-chapter'; who: 'you' | 'any'; when: 'triggers' | 'resolves' }
```

`when: 'triggers'` reads the `chapter` event whose number is the Saga's `finalChapter`.
`when: 'resolves'` is raised from the `leave` hook: CR 714.4 sacrifices the Saga as a state-based action once the
final chapter ability has left the stack, so a Saga on its way to the graveyard with a full lore track *is* that
moment. (The approximation: a Saga destroyed by removal while it already had a full track and its final chapter was
still on the stack would also raise it. Nothing short of a "an ability finished resolving" core hook can tell those
apart — see §7.)

```json
{ "kind": "triggered", "event": { "on": "saga-final-chapter", "who": "you", "when": "triggers" }, "effects": [{ "op": "token", "count": 1, "power": 4, "toughness": 4, "colors": ["W"], "types": ["Creature"], "subtypes": ["Angel"], "keywords": ["flying", "vigilance"] }], "text": "…" }
```
```json
{ "kind": "triggered", "event": { "on": "saga-final-chapter", "who": "you", "when": "resolves" }, "effects": [{ "op": "draw", "amount": 2, "who": "you" }], "text": "…" }
```

### `read-ahead` (as-enters) — CR 714.4b

```ts
{ kind: 'read-ahead' }
```

> Read ahead (As this Saga enters, choose a chapter and start with that many lore counters. Add one after your draw
> step. Skipped chapters don't trigger.)

Two halves, because a counter replacement is synchronous and could not ask anybody:

* the **as-enters hook** asks the controller for a chapter (a core `choose-number` decision, `min: 1`, `max:
  finalChapter`, so every shipped agent and the UI already answer it — `defaultAnswer` returns `min`, which is the
  whole Saga) and stores it in `o.ext.sagaReadAhead`;
* the **counter replacement** (`replacements.counters`) turns the core's `setCounters(o, 'lore', 1)` into that many
  (CR 614.1c). It replaces the counters the Saga *enters with*, which happens exactly once, and `o.ext.
  sagaReadAheadDone` is what makes it once. "The total is already at least the chosen chapter" is **not** a one-shot
  guard: this same family prints `saga-lore { remove: true }` (Clash of the Eikons), and a track emptied back to zero
  would have the next single lore counter replaced by the chosen chapter all over again — the Saga would jump back
  up its own track and re-run a chapter it had already run.

Skipped chapters fall out of the crossing: the replacement records `sagaLoreFrom = chapter - 1`, so the amount-less
core `chapter` event crosses the chosen chapter and nothing below it.

```json
{ "asEnters": [{ "kind": "read-ahead" }] }
```
```json
{ "asEnters": [{ "kind": "read-ahead" }, { "kind": "tapped" }] }
```

### ext state

| key | on | value | cleared |
|---|---|---|---|
| `sagaReadAhead` | the Saga | the chapter read ahead chose | when the permanent leaves the battlefield (`leave`) |
| `sagaReadAheadDone` | the Saga | `true` once the counter replacement has fired | `leave` |
| `sagaLoreFrom` | the Saga | the lore total before the delta being applied | the `sba` sweep, i.e. before the next dispatch |
| `sagaLoreMarks` | the game state | `true` while any `sagaLoreFrom` is outstanding | the same sweep |

All JSON-plain, so `clone.ts` deep-copies them and `serialize.ts` round-trips them. Nothing is redacted: CR 714.4b
makes the read-ahead choice as the Saga enters, face up, so it is public information, and a lore total is public.

`sagaLoreMarks` on the state is what keeps the sweep O(1) on every board where no lore counter moved. The sweep is
registered as an `sba` hook only because `checkSBA` is the one thing the core runs before every trigger dispatch and
every priority round; it returns `false` and changes nothing an SBA loop re-checks.

---

## 4. The `saga` target kind

`{ kind: 'saga', controller?: 'you' | 'opponent', count?, optional?, filter? }` — every Saga on the battlefield, put
through the same gate as every core kind: shroud, hexproof from another controller, protection from the source, and
the spec's own `filter` and `controller`. `count: 99` with `optional: true` is "any number of target Sagas you
control" (the shape the built-in target parser uses for "any number of").

Because `legal.ts:ownTargetSpecs` reads a `target` field generically and `targetStillLegal` re-runs
`targetOptionsFor`, the kind works on cast, on resolution and in the AI's legal-action enumeration with no core
change.

---

## 5. Parser wordings (`src/cards/rules/saga.ts`)

Consulted only after every built-in stage of `parse.ts` declined (the registry contract in
`src/cards/rules/types.ts`).

| wording | what it becomes |
|---|---|
| "Read ahead" (line; only on a card whose type line has the Saga subtype) | `asEnters: [{ kind: 'read-ahead' }]` — claimed at line hook 1, inside the keyword bail-out, because "read ahead" is a keyword `parse.ts` knows *of* and would otherwise record as unparsed before the ladder below it |
| "Put a / two / X lore counter(s) on target Saga you control / each Saga you control / each of any number of target Sagas you control" | `saga-lore` |
| "Remove a lore counter from target Saga you control" | `saga-lore` with `remove: true` |
| "*Name* — *sentence*" (a named chapter: "Gungnir — Destroy target creature an opponent controls") | the name is dropped and the tail re-parsed; the rule declines unless the remainder parses completely, so it can only ever turn an `unknown` into something |
| "Whenever you put a lore counter on a Saga you control" / "Whenever a lore counter is put on a Saga (you control)" / "… on ~" | `{ on: 'lore-counter-put', who }` |
| "Whenever the final chapter ability of a Saga (you control) resolves / triggers" | `{ on: 'saga-final-chapter', who, when }` |
| "there are N or more lore counters among Sagas you control / your opponents control" (a condition clause) | `{ kind: 'saga-lore-ge', who, value }` |
| "I, II, III — …" (a whole line) | the chapter triggered ability the built-in branch could not build (see below), plus `def.finalChapter` |

### Why the chapter-line rule exists

`parse.ts`'s line loop strips an ability-word / "Name — " prefix before its saga branch runs, and the guard on that
strip is only `(?![IVX]+ — )`. A **multi-chapter** head is not `[IVX]+ — ` — the commas — so "I, II, III — Pain — You
draw a card and you lose 1 life." is stripped down to "Pain — You draw a card …", the chapter branch never matches,
and the card ends up with a *static* ability, no chapter trigger and no `finalChapter` (so CR 714.4 never sacrifices
it). Line rules are handed the untouched `rawLine`, so the numerals are still there to read; the rule rebuilds
exactly what the built-in branch would have built, strips an optional chapter *name*, and records the raw line as
unparsed when the body still holds an `unknown`.

That last part is the only reason `npm run parse:diff` shows entries under "NO LONGER parses" for this family: the
unparsed text of a chapter line whose body the vocabulary still cannot express moves from the stripped form
("Each player secretly votes for up to one creature …") to the printed one ("II, III — Each player secretly votes
…"). All 48 of them are chapter lines, no previously fully-parsed card regressed, and 20 became fully parsed.

---

## 6. Scenarios

`test/scenarios/saga.ts`, 21 of them, each pinned to a rule:

| scenario | pins |
|---|---|
| Keldon Warcaller puts a lore counter on target Saga | `saga-lore`, the `saga` target kind, CR 714.2b |
| a Saga an opponent controls is not a legal target | `controller: 'you'` on the target kind, CR 115.4 |
| two lore counters trigger both chapters they cross | the crossing rule, CR 714.2b |
| removing a lore counter triggers nothing | `remove`, CR 714.2b |
| a lore counter on each Saga you control | `each-saga-you-control` |
| read ahead starts on the chosen chapter and skips the ones below | `read-ahead`, CR 714.4b |
| read ahead with chapter I chosen | the `min` answer, CR 714.4b |
| Sigurd sees the counter Keldon Warcaller put on | `lore-counter-put`, `who: 'you'` |
| a "lore counter is put on a Saga" trigger sees an opponent's Saga | `who: 'any'` |
| Historian's Boon sees the final chapter trigger | `saga-final-chapter`, `when: 'triggers'` |
| a non-final chapter fires no such trigger | the negative control |
| the final chapter resolving sacrifices the Saga | `when: 'resolves'`, CR 714.4 |
| Tom Bombadil at four lore counters | `saga-lore-ge` true |
| Tom Bombadil at three | `saga-lore-ge` false (he is a legal Lightning Bolt target) |
| Summon: Anima I, II, III | the multi-chapter line rule |
| Summon: Anima IV — Oblivion | the named final chapter, CR 714.4 |
| read ahead is a one-shot, not "whenever the track is empty" | `sagaReadAheadDone`, CR 614.1c |
| two crossed chapters resolve lowest first | the queue order, CR 603.3b / 611.2c |
| a counter multiplier does not make a chapter vanish | the crossing from `sagaLoreFrom`, CR 714.2b |
| a final chapter a multiplier overshoots still counts as triggering | `saga-final-chapter` on a crossing, CR 714.2b |
| Summon: Shiva stuns the creature it tapped, not itself | the chapter-body pronoun re-bind, CR 122.1d |

---

## 7. What is deliberately not here

* **"Sagas you control have read ahead" (Barbara Wright).** Read ahead is chosen as the Saga enters, and the only
  as-enters hook a family can reach is keyed off an `AsEnters` entry on the card's own `CardDef`. A Saga that *gained*
  the ability from another permanent never reaches it, and the counter replacement that could see the grant is
  synchronous and cannot ask for the chapter. It needs a core as-enters point for abilities gained from elsewhere.
* **"Put a lore counter on target Saga you control or remove one from it" (Sigurd's boast).** A choice between two
  effects on one target; `choose-mode` chooses before targets are picked, so the two modes would each ask for their
  own Saga.
* **"Whenever the final chapter ability of a Saga you control resolves"** is raised from the state-based sacrifice
  rather than from the ability leaving the stack (§3). A Saga removed while its final chapter was still on the stack
  would raise it early.
* **"Put a lore counter on each Saga you control" as printed (Satsuki, the Living Lore).** A built-in effect template
  claims that sentence first, as `{ op: 'counters', target: 'creatures-you-control', counter: 'lore', filter: {
  subtypes: ['Saga'] } }` — and that op's `creatures-you-control` list is filtered by `isCreature`, so on a
  non-creature Saga it does nothing while the card counts as fully parsed. A family rule is never offered the
  sentence. Fixing it is a core edit to that template.
* **"Choose one at random —" as a chapter body** (Summon: Magus Sisters). `choose-mode` has no random flag, and
  modelling a random choice as a free one would be a silent fidelity loss.
* **"for each lore counter among Sagas you control"** (Chong and Lily) — the amount already exists
  (`{ count: 'counters-on-permanents', counter: 'lore', filter: { subtypes: ['Saga'] } }`); what is missing is the
  composition family's "for each …" phrase for it.

### Known gaps that need a core change (raised as `coreChangeNeeded`, not worked around here)

* **The zod mirror.** `src/cards/schema.ts` is a fixed discriminated union and nothing folds `saga.schema.ts` into
  it, so `AsEntersSchema` rejects `{ kind: 'read-ahead' }` and the `Equals<>` pins in `test/schema-types.test.ts`
  break on the widened `Effect` / `Condition` / `TriggerEvent` / `AsEnters` / `TargetSpec['kind']`. `npm test` and
  `npm run typecheck:schema` stay red until the schema-composer slice (or the equivalent hand edit) lands;
  `schema.ts` is on this wave's do-not-edit list, so the patch is reported rather than applied.
* **A multi-number chapter crossed more than once on a core queue triggers once, not once per number.** "I, II — E"
  is two abilities (CR 714.2c), so a Saga entering with two lore counters under Doubling Season must trigger both.
  The family's own `saga-lore` path does exactly that (it queues one event per crossed number), but the two core
  queues raise a single amount-less event and a trigger predicate can only answer fires / does not fire. The fix is
  to move the Saga chapter dispatch into `Game.addCounters`, the only place that knows the post-replacement delta
  *and* runs before `checkSBA`.
* **Proliferate advances a lore track silently.** `game.ts`'s `case 'proliferate'` calls `addCounters(o, 'lore', 1)`
  and queues nothing, so no chapter triggers and `lore-counter-put` never fires (CR 122.6, 701.27, 714.2b). The same
  `addCounters` change fixes it — and every other route a lore counter can take — at once. A family cannot: the only
  hook it is offered around a counter change runs *before* the delta is applied, and the `sba` sweep runs after the
  core's own Saga-sacrifice state-based action, too late to save a crossing that reaches the final chapter.
* **"Choose one or more —" is modelled as choose-exactly-one.** `parse.ts` collapses "one or both" / "one or more" /
  "any number" to `count: 1`, and `choose-mode` carries a single `count` with no room for a range, so `legalActions`
  never offers two modes (CR 700.2d). It is a core template this family did not touch and ~90 cards were already
  fully parsed with it before this wave; what the family did is promote one more card into that set (Clash of the
  Eikons), by teaching two of its three bullets to parse.
