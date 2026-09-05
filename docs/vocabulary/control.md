# Control (Phase 9.1)

Who controls a permanent, and for how long. The engine already had one control verb — the core `gain-control` op,
which is permanent or until end of turn, always steals for the item's controller and always takes exactly what the
effect targets — and one exchange, the composition core's `exchange what: 'control'`, which is permanent and names
its two permanents individually. The 460 paper cards that carry this family in their unparsed lines print five things
that neither can say:

| the printed English | what it needs |
|---|---|
| "for as long as you control ~", "… ~ remains on the battlefield", "… ~ remains tapped" | a **duration that is a condition** (CR 611.2b), including the rule that a duration already over never starts the effect |
| "until the end of your next turn", "until end of combat" | two more **time-based durations** |
| "Target opponent gains control of ~", "the player with the most life gains control of ~" | a **gainer who is not the item's controller** |
| "Gain control of all Dragons", "Gain control of all artifacts your opponents control until end of turn" | a **group** control change with no target |
| "Each player gains control of all creatures they own" | **giving everything back** — not the end of a duration, an effect of its own |

Everything below lives in `src/engine/ops/control.ts` (behaviour), `src/engine/ops/control.schema.ts` (the zod mirror
per-card scripts are validated against), `src/cards/rules/control.ts` (the oracle-text wordings) and
`test/scenarios/control.ts` (one scenario per op, per duration and per keyword parameter). Rule numbers refer to the
Comprehensive Rules bundled in `data/rules/cr.json`.

---

## 1. Durations

```ts
type ControlDuration =
  | 'permanent' | 'eot' | 'end-of-combat' | 'your-next-turn'
  | 'while-source-on-battlefield' | 'while-you-control-source' | 'while-source-tapped'
  | 'while-you-control-source-and-tapped' | 'while-counter';
```

| value | the English | ends | rule |
|---|---|---|---|
| `permanent` (the default) | "Gain control of target creature." | never | 611.2 — a continuous effect with no duration lasts indefinitely |
| `eot` | "… until end of turn" | in the cleanup step of the turn it started | 514.2 |
| `end-of-combat` | "… until end of combat" | as the combat phase ends | 511.3 |
| `your-next-turn` | "… until the end of your next turn" | in the cleanup step of the **gaining player's** next turn — a theft on your own turn therefore survives that turn's cleanup | 611.2 |
| `while-source-on-battlefield` | "for as long as ~ remains on the battlefield" | the moment the source is not on the battlefield | 611.2b |
| `while-you-control-source` | "for as long as you control ~" | the moment the gaining player does not control the source (including the source leaving) | 611.2b |
| `while-source-tapped` | "for as long as ~ remains tapped" | the moment the source is untapped or gone | 611.2b |
| `while-you-control-source-and-tapped` | "for as long as you control ~ and ~ remains tapped" (Helm of Possession, Rubinia Soulsinger, Willow Satyr) | either half fails | 611.2b |
| `while-counter` | "for as long as it has a shield counter on it" (Shield Broker) — the counter kind is the op's `counter` field | the counter is gone | 611.2b |

**A duration that is already over never starts the effect** (CR 611.2b). A `while-*` control change first asks its
own question: Sower of Temptation that died in response to its own enter trigger takes nothing, and a
`while-counter` gain on a permanent that has no such counter does nothing at all rather than stealing it forever.

**Where each one ends, in the engine.** Control is a field on the object, not a continuous effect the layer pass
recomputes, so the family ends its own effects:

* `eot` and `your-next-turn` — the `cleanup` step hook, which runs in the cleanup step just before the core's
  end-of-turn wipe;
* `end-of-combat` — the `combat-end` step hook;
* every `while-*` — the `sba` hook, i.e. the state-based-action loop, which runs after every action and every
  resolution. That is the engine's polling point, not a claim that this is a state-based action.

**The bookkeeping.** A stolen permanent carries `o.ext.controlReturn`, JSON-plain and never hidden (nothing here is
secret — every player can see who controls what — so the family registers no `redact` hook):

```ts
{ to: PlayerId; by: PlayerId; until: ControlDuration; src: number; turn: number; counter: string }
```

`to` is the controller to hand it back to, `by` the player who gained control (the "you" of "for as long as you
control ~"), `src` the source object's id (the "~"), `turn` the turn the effect started. A **second** theft over a
live one keeps the original `to`, so the permanent eventually goes home rather than to the first thief, and a
`permanent` gain deletes the entry (the newest effect never gives it back — the engine's stand-in for CR 613.7
timestamp order, which it does not model for control). A permanent that leaves the battlefield is a new object
(CR 400.7): `moveTo` has already handed it to its owner and the family's `leave` hook drops the entry.

---

## 2. The ops

### `control-gain` — "Gain control of …"

```ts
{ op: 'control-gain';
  target?: TargetSpec | Ref;          // exactly one of `target` / `all`
  all?: { all: Filter; who?: 'you' | 'each-player' | 'each-opponent' | 'that-player' };
  who?: 'you' | 'that-player' | 'controller-of-that' | 'owner-of-that' | 'leader';   // default 'you'
  duration?: ControlDuration;         // default 'permanent'
  counter?: string;                   // with duration 'while-counter'
  leader?: { of: 'life' | 'cards-in-hand' | 'permanents'; filter?: Filter; extreme: 'most' | 'least' };
  untap?: boolean; haste?: boolean }
```

* `target` is chosen on cast (`legal.ts:ownTargetSpecs` reads a `TargetSpec` off the `target` field by name) or reads
  the binding frame (a `Ref` — `'self'`, `'that'`, `'enchanted'` for an Aura's own host). Objects that are no longer
  on the battlefield are dropped (CR 400.7).
* `all` is the untargeted group form: every permanent matching the filter on the battlefields of `who` (default:
  every player, APNAP). Nothing is chosen on cast.
* `who` is the single player who gains control. **There is deliberately no `target-player` / `target-opponent`
  here.** `legal.ts` emits a player requirement only for the ops it knows by name, so a `who` that named a target
  would ask for nobody on cast and resolve to nobody — a silent no-op. "Target opponent gains control of ~" is the
  composition core's `scoped`, which does emit the requirement and rebinds `you`:
  `{ op: 'scoped', who: 'target-opponent', do: [{ op: 'control-gain', target: 'self' }] }`. That is what the parser
  rules emit, and it is the shape a script should use.
* `who: 'leader'` is "the player with the most life / the most cards in hand / the most creatures gains control of
  ~" (Wild Dogs, Ghazbán Ogre, Wild Mammoth, Sokenzan Renegade, Thoughtbound Primoc). A tie means **nobody**: CR
  104.2 knows no such player, and every printed card guards the clause with "if a player has more … than each other
  player" anyway (the `control-leader` condition below).
* `untap` untaps what was taken, through `Game.setTapped`, so the untap is on the event stream. `haste` delegates to
  the core `grant-keyword` op with the same target, so "It gains haste until end of turn" is one shape everywhere;
  it needs `target` (the core op has no group form) and is ignored with `all`. Together they are a Threaten.
* A permanent under a `control-cant-change` static is skipped, and a controller that already controls the permanent
  is a no-op (nothing is recorded, so nothing is handed back later).
* Every permanent whose controller really changed raises the `control-gained` trigger event.

```json
{ "op": "control-gain", "target": { "kind": "creature" }, "duration": "while-source-on-battlefield" }
```
```json
{ "op": "control-gain", "target": { "kind": "creature", "controller": "opponent" }, "duration": "eot", "untap": true, "haste": true }
```

### `control-return` — "Each player gains control of all permanents they own"

```ts
{ op: 'control-return'; who?: 'each-player' | 'each-opponent' | 'you' | 'that-player'; filter?: Filter }
```

Each named player (default `each-player`, APNAP) gains control of every permanent they **own** and do not control,
matching `filter` (absent = all of them). Homeward Path, Brooding Saurian ("all nontoken permanents they own"),
Trostani Discordant, Alicia Masters, The Fall of Lord Konda. It clears any `controlReturn` entry it undoes, so a
duration that was running does not later hand the permanent somewhere else, and it raises `control-gained` too.
Like `who` above, it takes no target word — wrap it in a `scoped` if a card ever needs one.

```json
{ "op": "control-return" }
```
```json
{ "op": "control-return", "filter": { "types": ["Creature"] } }
```

### `control-exchange` — "Exchange control of …" (CR 701.12)

```ts
{ op: 'control-exchange'; target: TargetSpec; self?: boolean; share?: 'card-type'; duration?: ControlDuration }
```

The two permanents arrive as **one** requirement, on the `target` field, so `legal.ts` finds it: either a `multi`
spec of two parts ("exchange control of target artifact and target creature") or one spec with `count: 2`
("Exchange control of two target permanents that share a card type"). With `self`, the first side is the source and
the spec names the other ("exchange control of ~ and target creature an opponent controls", Gilded Drake).

Nothing happens when a side is off the battlefield, when both are already controlled by the same player, when a side
is under a `control-cant-change` static, or when `share: 'card-type'` is set and the two share no card type
(CR 701.12b). Unlike the composition core's `exchange`, it takes a `duration`, so the swap can be temporary.
Controllers are swapped through `Game.changeControl`, so summoning sickness restarts (CR 302.6) and an Equipment
attached to a permanent its controller no longer controls falls off by state-based action.

**One approximation.** "…that share a card type" is a *targeting* restriction (CR 601.2c): the two picks must share
a type as they are chosen. `legal.ts` chooses each part of a spec independently and has no cross-target predicate,
so `share` is checked as the effect **resolves** and the exchange simply does not happen when the picks do not
share a type. A scenario pins both branches.

```json
{ "op": "control-exchange", "target": { "kind": "multi", "specs": [{ "kind": "creature", "controller": "you" }, { "kind": "creature", "controller": "opponent" }] }, "share": "card-type" }
```
```json
{ "op": "control-exchange", "target": { "kind": "creature", "controller": "opponent", "count": 1, "optional": true }, "self": true }
```

---

## 3. The condition, the static, the trigger and the target kind

### `control-leader` (condition)

```ts
{ kind: 'control-leader'; of: 'life' | 'cards-in-hand' | 'permanents'; filter?: Filter; extreme: 'most' | 'least' }
```

True only when **exactly one** player still in the game is strictly at the extreme — "if a player has more life than
each other player", "if a player controls more creatures than each other player", "if a player controls more Wizards
than each other player". A tie is false, which is what the printed cards mean and what makes `who: 'leader'` safe.

```json
{ "kind": "control-leader", "of": "life", "extreme": "most" }
```
```json
{ "kind": "control-leader", "of": "permanents", "filter": { "subtypes": ["Wizard"] }, "extreme": "most" }
```

### `control-cant-change` (static)

```ts
{ kind: 'control-cant-change'; scope: 'self' | 'you-control' | 'all'; filter?: Filter; condition?: Condition }
```

Folds `Mods.flags.cantChangeControl` onto the permanents in scope (`self`, every permanent its controller controls
that matches `filter`, or every permanent that matches it), optionally only while `condition` holds ("As long as ~ is
untapped …", Guardian Beast). **Only this family's ops honour it** — the core `gain-control` and the composition
core's `exchange` do not read the flag, because a family cannot reach their code. No parser rule produces it (the
wordings that carry it, Guardian Beast's among them, are compound lines the family declines); it is here for
per-card scripts, and a scenario proves it.

```json
{ "kind": "control-cant-change", "scope": "self" }
```
```json
{ "kind": "control-cant-change", "scope": "you-control", "filter": { "types": ["Artifact"] }, "condition": { "kind": "self-untapped" } }
```

### `control-gained` (trigger)

```ts
{ on: 'control-gained'; self?: boolean; who?: 'you' | 'any' }
```

Fires for each permanent whose controller this family's ops really changed (`self` defaults to true: the permanent
carrying the trigger is the one that moved; `who: 'you'` narrows it to "when **you** gain control of ~"). It is
raised by `control-gain`, `control-return` and `control-exchange` and by nothing else: the core `gain-control` and
`exchange` do not raise it, and there is no core hook that would let a family observe `Game.changeControl`. A card
whose trigger keys off it must therefore have its control change come from this family — which is what the parser
rules produce for the wordings the trigger appears on (Risky Move).

```json
{ "on": "control-gained", "self": true, "who": "you" }
```
```json
{ "on": "control-gained", "self": true }
```

### `permanent-you-own-not-control` (target kind)

Every permanent the choosing player owns and another player controls — "target permanent you own but don't control"
(Coveted Falcon).

```json
{ "op": "control-gain", "target": { "kind": "permanent-you-own-not-control" } }
```

---

## 4. Parser wordings (`src/cards/rules/control.ts`)

Every rule is consulted only after every built-in stage of `src/cards/parse.ts` has declined the text (the registry
contract in `src/cards/rules/types.ts`), and every one is anchored on the words "control" / "exchange control". The
built-in table knows exactly three shapes — "gain control of *target*", the same "until end of turn", and one
spelling of the Threaten package — so what follows is everything the pool prints around them.

| wording | what it becomes |
|---|---|
| "Gain control of *target* for as long as you control ~ / ~ remains on the battlefield / ~ remains tapped / you control ~ and ~ remains tapped" | `control-gain` with the matching `while-*` duration |
| "Gain control of *target* until the end of your next turn / until end of combat" | `control-gain` with `your-next-turn` / `end-of-combat` |
| "Gain control of enchanted creature / permanent / land [until end of turn / for as long as …]" | `control-gain` on the `enchanted` Ref (an Aura's own host — no target) |
| "Gain control of *target* until end of turn. Untap it / them / that permanent / those creatures[. It / they / that creature / those creatures gain(s) haste until end of turn]" | `control-gain` `eot` with `untap` and `haste` |
| "Untap *target* and gain control of it until end of turn[. That creature / It gains haste until end of turn]" | the same, in the other printed order (Threaten, Blind with Anger, Overtaker, Ray of Command, Word of Seizing) |
| "Target opponent / player gains control of ~ [until end of turn]" | `scoped` `target-opponent` / `target-player` around `control-gain` on `self` |
| "Target player gains control of *target* [until end of turn]" | the same `scoped`, with the spec inside (Donate, Bazaar Trader, Harmless Offering, Zedruu the Greathearted) |
| "That player gains control of ~" | `control-gain` `who: 'that-player'` (Risky Move, Drooling Ogre, Kain) |
| "The player with / who has / who controls the most / highest / lowest / fewest *metric* gains control of ~" | `control-gain` `who: 'leader'` |
| "Gain control of all *filter* [you control / your opponents control] [until end of turn / until the end of your next turn / for as long as …]" | `control-gain` with `all` (Karrthus, Broadcast Takeover, Varchild, Homeward Path's neighbours) |
| "Each player gains control of all *filter* they own" | `control-return` |
| "Exchange control of two target *filter* [that share a card / permanent type]" | `control-exchange` with `count: 2` and `share` |
| "Exchange control of ~ and *target*" | `control-exchange` with `self` |
| "if a player has / controls more *metric* than each other player" (a condition) | the `control-leader` condition |
| "When you / a player gain(s) control of ~ [from another player]" (a trigger head) | the `control-gained` trigger |

The filter and target phrases go through the same guards the composition family uses: every word must be one the
shared vocabulary knows, a subtype the sub-parse minted that the text does not name makes the rule decline, and an
"or" list is only claimable when it names types and colours alone. One extra guard is this family's own: the
built-in target parser reads a spec's `kind` off the first type word it sees, so "target **non**creature artifact"
comes back as `kind: 'creature'` with `notTypes: ['Creature']` — a requirement nothing can satisfy. That spec is
declined rather than handed to the engine.

### Declines (what stays unparsed, and why)

* **"for as long as that creature is enchanted"** (Rootwater Matriarch) and **"for as long as that Aura is attached
  to it"** (Eriette, the Beguiler): the duration is about the *stolen* permanent's attachments, which the entry does
  not record. Two cards.
* **"Gain control of all lands target player controls"** (Gilt-Leaf Archdruid) and any group whose scope names a
  target: the group form takes no targets, and `legal.ts` would ask for no player (§2, `who`).
* **"If two or more players are tied for lowest life total, you choose one of them"** (Loxodon Peacekeeper): a tie
  is nobody, and the family has no decision for "you choose one of them".
* **"An opponent gains control of it"** (Akroan Horse, Rainbow Vale) — a choice, not a target, and the engine has no
  "choose an opponent" for a control change.
* **"Exchange control of two target creatures controlled by different players"** (Kitsune, Modify Memory) and
  **"…that shares one of those types with it"** (Legerdemain, Gauntlets of Chaos, Daring Thief): relational target
  restrictions between two picks, which `legal.ts` cannot express (`share: 'card-type'` is the one approximation the
  family makes, and only for the symmetric "two target … that share a card type" form).
* **"When you lose control of that Equipment, unattach it"** (Ogre Geargrabber) and every other "when you lose
  control" trigger: the family raises `control-gained`, not a loss event, and a loss caused by the core ops could
  not be seen anyway.
* Every card whose control clause is one sentence of a longer line the rest of which is still unparsed — Merieke Ri
  Berit, Possession Engine, Coveted Falcon, Yes Man, Humble Defector and about forty more. The control sentence is
  now a real op inside a partially-parsed line, which is what `parse:diff`'s "(same unparsed lines)" group shows.

---

## 5. What is deliberately not here

* **Timestamps for control (CR 613.7).** Two live control effects on one permanent are approximated: the newest
  wins, and the oldest recorded `to` is where the permanent goes home. The engine has no timestamp order.
* **A hook on `Game.changeControl`.** `control-gained` sees this family's own control changes only, and
  `control-cant-change` binds this family's own ops only. Both would need a core change (`FamilyModule` has no
  control hook); the family is honest about the boundary rather than pretending to be universal.
* **"Gains control" as a cost or a targeting restriction** ("can't gain control of" as a target legality rule rather
  than a resolution-time skip).
* **Control of a player** ("you gain control of target opponent during that player's next turn", Emrakul): the
  engine has no notion of controlling a player's turn.
