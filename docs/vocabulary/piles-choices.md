# piles-choices (Phase 9.1)

Choices somebody makes that the core AST has no verb for: **modal choices** beyond `choose-mode`, **votes**,
**piles**, "**an opponent chooses** N of those", "**for each player, you choose** …" and **Class levels**.

Engine: `src/engine/ops/piles-choices.ts` · zod: `src/engine/ops/piles-choices.schema.ts` · parser rules:
`src/cards/rules/piles-choices.ts` · scenarios: `test/scenarios/piles-choices.ts`. Rule numbers refer to the
Comprehensive Rules bundled in `data/rules/cr.json`.

Everything the family stores is **public information** — the piles of a revealed set, the modes a permanent has
already chosen, a Class's level, which permanents were chosen — so no `redact` hook is needed. All of it is
JSON-plain, in the `ext` bag of the **source** object, and `clone.ts` deep-copies it automatically.

That is a claim the family has to **make**, not one it may assume. Who may see a card is `state.knowledge`
(`knownTop` / `knownInHand` / `revealed`), and `redact` (`src/engine/view.ts`) replaces every library card and every
opposing hand card that is not listed there with `__hidden__` before `Game.ask` hands the state to a
hidden-information agent — which the shipped `DeferredAgent` (the UI, and a human) is. So `reveal-cards` and
`separate-piles` **record the set they show as publicly known** (CR 701.20a). Without that record the opponent Fact
or Fiction asks to separate the piles would be splitting five cards it cannot see.

---

## 1. The shared vocabulary

### `ChoiceWho` — who makes the choice

```ts
type ChoiceWho = 'you' | 'an-opponent' | 'target-player' | 'target-opponent' | 'that-player'
               | 'each-player' | 'each-opponent' | 'controller-of-that' | 'owner-of-that';
```

Every word but `an-opponent` is the core `ScopeWho` vocabulary (`docs/vocabulary/composition.md` §1), resolved
against the item's binding frame by `src/engine/refs.ts`; `you` is the acting player (the item's controller, or the
player a `scoped` block is running as). `an-opponent` is the printed words "an opponent" with **no target**: the
acting player picks which opponent when there is more than one (the multiplayer reading of CR 700.2e, applied to
every choice this family makes). Where a word names several players, the **first** of them chooses.

### `ChoiceSet` — where a set of objects comes from

```ts
type From = 'those' | { filter?: Filter; zone?: SetZone; who?: ChoiceWho; top?: Amount };
```

* `'those'` is the current binding (CR 608.2h) — only usable where an earlier effect bound something.
* the object form takes every object matching `filter` in `zone` (default `battlefield`, or `library` when `top`
  is given) of each player `who` names (default `you`); `top` takes the first `top` cards of each named library.

### `PileFate` — what happens to a chosen (or unchosen) set

```ts
type PileFate = { how: 'move'; to: MoveZone; pos?: 'top' | 'bottom'; tapped?: boolean; controller?: 'you' | 'owner' }
              | { how: 'sacrifice' }        // CR 701.16, by each object's own controller
              | { how: 'destroy' };         // CR 701.7
```

A `move` to the battlefield goes through `enterBattlefield` (every as-enters replacement applies); everything else
goes through `moveTo` (commander redirects and family zone-move replacements apply). An object already in the
destination zone is left alone, and a token outside the battlefield has ceased to exist (CR 111.7) and is skipped.

### The chosen / unchosen record

`separate-piles`, `choose-pile`, `choose-objects` and `choose-for-each-player` write their result on the **source**
(`src.ext.pcPiles`, `src.ext.pcChosen`, `src.ext.pcUnchosen`) as well as binding `that` / `those` to the chosen
objects. The record is why `chosen-fate` can be a **separate effect**: printed English puts the choice and its
consequence in different sentences ("An opponent chooses one of those piles. Put that pile into your hand and the
other into your graveyard."), and the parser reaches each sentence on its own. The record is cleared when the source
leaves the battlefield (CR 400.7).

Two rules keep the record honest, because an `ext` bag outlives a single resolution — Unesh, Criosphinx Sovereign and
Sphinx of Uthuun trigger again on the SAME permanent, and a card recast from the graveyard (Yawgmoth's Will,
Underworld Breach) keeps its bag across the zone change:

* **A recorder replaces the whole record, including on the empty-pool path.** `separate-piles` with nothing to
  separate writes an empty record rather than returning early; otherwise the next `chosen-fate` would re-apply the
  *previous* resolution's split and move objects this resolution never chose (CR 400.7).
* **A reader with no record at all reports `unsimulated`.** A parser rule sees one sentence at a time and cannot look
  at its neighbours (`src/cards/rules/types.ts`), so `chosen-fate` / `choose-pile` really do get claimed on cards
  whose *producing* sentence is still `unknown` — Bringer of the Last Gift, Gifts Ungiven, Epiphany at the
  Drownyard, Riddles in the Dark and eleven more. Rather than resolving as a no-op nobody can see, those ops emit the
  same `unsimulated` event `game.ts` emits for an `unknown` op, so the missing clause stays visible to the fidelity
  metric. An *empty* record (the recorder ran and found nothing) is a genuine no-op and emits nothing.

---

## 2. The ops

### `choose-modes` — modal choices `choose-mode` cannot express (CR 700.2)

```ts
{ op: 'choose-modes'; modes: Effect[][]; count: Amount;
  labels?: string[];                       // one printed label per mode (what the chooser is offered, and what the log says)
  upTo?: boolean;                          // "Choose up to three"
  repeat?: boolean;                        // "You may choose the same mode more than once" (CR 700.2d)
  notChosen?: 'this-turn' | 'ever';        // "choose one that hasn't been chosen [this turn]"
  chooser?: ChoiceWho;                     // "An opponent chooses one —" (CR 700.2e); default `you`
  weights?: number[] }                     // pawprints: `count` is a BUDGET, `weights[i]` is mode i's cost (CR 700.2i)
```

The chooser is asked once per pick, from the modes that are still legal: a mode already chosen is out unless
`repeat`, a mode in the source's `notChosen` record is out, and with `weights` a mode whose cost would take the total
past the budget is out. With `upTo` (or a budget, which need not be spent) a trailing **"(no more modes)"** option
stops the loop. The chosen modes' effects are then applied in the order they were chosen.

**Differences from the core `choose-mode`.** The core op's modes are chosen when the spell is cast (CR 601.2b) and
its nested effects can take targets; `choose-modes` chooses as it **resolves** and its modes may not take targets
(`legal.ts:nestedLists` does not descend into a family's lists). Use the core op for a modal spell with targets and
this one for the wordings it cannot say.

```json
{ "op": "choose-modes", "count": 1, "notChosen": "this-turn", "labels": ["Draw a card.", "Create a Treasure token.", "Each opponent loses 3 life."],
  "modes": [[{ "op": "draw", "amount": 1, "who": "you" }], [{ "op": "token", "count": 1, "power": 0, "toughness": 0, "colors": [], "types": ["Artifact"], "subtypes": ["Treasure"], "keywords": [], "treasure": true }], [{ "op": "lose-life", "amount": 3, "who": "each-opponent" }]] }
```
```json
{ "op": "choose-modes", "count": 5, "repeat": true, "weights": [1, 2, 3], "labels": ["{P} — Each player sacrifices a creature of their choice.", "{P}{P} — Draw a card for each creature that died under your control this turn.", "{P}{P}{P} — Each opponent loses X life."],
  "modes": [[{ "op": "sacrifice", "who": "each-player", "what": { "types": ["Creature"] }, "amount": 1 }], [{ "op": "draw", "amount": { "count": "creatures-died-this-turn" }, "who": "you" }], [{ "op": "lose-life", "amount": { "count": "cards-in-graveyard", "filter": { "types": ["Creature"] }, "who": "you" }, "who": "each-opponent" }]] }
```

### `vote` — CR 701.38

```ts
{ op: 'vote'; options: { label: string; effects: Effect[] }[];
  resolve: 'majority' | 'per-vote';        // will of the council / council's dilemma
  tie?: 'all' | 'first' }                  // how a `majority` tie is broken (default `first`)
```

Starting with the acting player and proceeding in turn order (CR 701.38a), every player still in the game votes for
one option. A player whose permanents carry the `extra-votes` static votes that many extra times, at the same time
(CR 701.38d). `majority` runs the option with the most votes (`tie: 'all'` runs every tied option, `'first'` the
earliest-listed); `per-vote` runs each option's effects once per vote it received. Every vote is logged.

```json
{ "op": "vote", "resolve": "majority", "options": [{ "label": "carnage", "effects": [{ "op": "destroy", "target": "all-creatures" }] }, { "label": "homage", "effects": [{ "op": "gain-life", "amount": 5, "who": "you" }] }] }
```
```json
{ "op": "vote", "resolve": "per-vote", "options": [{ "label": "time", "effects": [{ "op": "counters", "target": "self", "counter": "+1/+1", "amount": 1 }] }, { "label": "money", "effects": [{ "op": "token", "count": 1, "power": 0, "toughness": 0, "colors": [], "types": ["Artifact"], "subtypes": ["Treasure"], "keywords": [], "treasure": true }] }] }
```

### `reveal-cards` — CR 701.20a

```ts
{ op: 'reveal-cards'; what: From }
```

Shows a set of cards to **every** player: each card in a hidden zone (a library, a hand) is added to
`state.knowledge.revealed`, so `redact` stops blanking it, and the reveal is announced with the core `library`
event — the same one `dig` and `explore` emit, rendering as `P0 reveals A, B, C.` (one event per owner). `those`
binds to the revealed cards.

This is the half a **look** does not do: CR 701.20e shows the cards to one player, CR 701.20a to all of them, and
the built-in `look-top` is a look. The parser therefore emits the two together for "Reveal the top N cards of your
library" — see §4.

```json
{ "op": "reveal-cards", "what": { "zone": "library", "who": "you", "top": 5 } }
```
```json
{ "op": "scoped", "who": "you", "do": [{ "op": "look-top", "who": "you", "amount": 5 }, { "op": "reveal-cards", "what": "those" }] }
```

### `separate-piles` — CR 700.3

```ts
{ op: 'separate-piles'; from: From; piles: number; separator?: ChoiceWho; reveal?: boolean }
```

Groups the objects `from` names into `piles` piles and records them on the source. Nothing changes zone (CR 700.3c),
and a pile may be empty (CR 700.3d).

**The separator chooses the sizes as well as the contents** (CR 700.3a) — 5/0 and 4/1 are legal splits of a five-card
pool, and that free choice is the whole strategic content of Fact or Fiction and Steam Augury. It costs no new
decision kind: for each pile but the last, the separator is asked a `choose-option` for the size (`"0 cards"`,
`"1 card"`, …) and then a `choose-cards` for the contents. **The even split is offered first**, so an agent that
answers `options[0]` — which is what `src/engine/agents/defaults.ts` does — still makes the balanced split, while a
real agent reaches every other partition.

The pool becomes **public knowledge** (as `reveal-cards` above) whether or not `reveal` is set: the piles this family
makes are public — face-down piles are declined, see §5 — and a separator that cannot see the cards cannot make the
choice CR 700.3a gives it. `reveal` decides only whether the reveal is *announced* (the printed word "Reveal").

```json
{ "op": "separate-piles", "from": { "zone": "library", "who": "you", "top": 5 }, "piles": 2, "separator": "you", "reveal": true }
```
```json
{ "op": "separate-piles", "from": "those", "piles": 2, "separator": "an-opponent" }
```

### `choose-pile` — CR 700.3

```ts
{ op: 'choose-pile'; chooser: ChoiceWho }
```

The chooser picks one of the piles the source holds. Binds `that` / `those` to that pile and records the chosen /
unchosen split for a following `chosen-fate`. With **no** pile record on the source (no `separate-piles` ever ran,
because that sentence did not parse) the op reports the line as `unsimulated` — see "The chosen / unchosen record".

```json
{ "op": "choose-pile", "chooser": "an-opponent" }
```
```json
{ "op": "scoped", "who": "you", "do": [{ "op": "choose-pile", "chooser": "you" }, { "op": "chosen-fate", "chosen": { "how": "move", "to": "hand" }, "other": { "how": "move", "to": "graveyard" } }] }
```

### `choose-objects` — "an opponent chooses N of those"

```ts
{ op: 'choose-objects'; chooser: ChoiceWho; from: From; count: Amount; upTo?: boolean }
```

The chooser picks `count` objects (or up to `count` with `upTo`) from the set. A set no larger than the count needs
no decision. Binds `those` to the chosen objects and records the split. CR 608.2f (the choice is made as the effect
applies), CR 608.2h (the set is read once).

```json
[{ "op": "look-top", "who": "you", "amount": 3 }, { "op": "choose-objects", "chooser": "an-opponent", "from": "those", "count": 1 }, { "op": "chosen-fate", "chosen": { "how": "move", "to": "graveyard" }, "other": { "how": "move", "to": "hand" } }]
```
```json
[{ "op": "choose-objects", "chooser": "target-opponent", "from": { "filter": { "types": ["Creature"] }, "who": "target-opponent" }, "count": 1 }, { "op": "chosen-fate", "chosen": { "how": "destroy" } }]
```

### `choose-for-each-player` — "For each player, you choose …" (CR 608.2f, 101.4)

```ts
{ op: 'choose-for-each-player'; chooser: ChoiceWho; picks: Filter[]; from?: Filter }
```

Players are visited in APNAP order (CR 101.4). For each of them the chooser picks, from the permanents that player
controls matching `from` (default: any permanent), **one permanent per entry of `picks`**, each matching its own
filter; a pick with no legal permanent is skipped. Every choice is made before anything happens. Binds `those` to
every chosen permanent and records the split (the pool is the union of the per-player `from` sets).

```json
[{ "op": "choose-for-each-player", "chooser": "you", "picks": [{ "types": ["Artifact"] }, { "types": ["Creature"] }, { "types": ["Enchantment"] }, { "types": ["Planeswalker"] }] }, { "op": "chosen-fate", "other": { "how": "sacrifice" }, "among": { "notTypes": ["Land"] } }]
```
```json
[{ "op": "choose-for-each-player", "chooser": "you", "picks": [{ "types": ["Creature"] }], "from": { "types": ["Creature"] } }, { "op": "chosen-fate", "other": { "how": "sacrifice" }, "excludeSharing": "creature-type" }]
```

### `chosen-fate` — what happens to the chosen and the unchosen

```ts
{ op: 'chosen-fate'; chosen?: PileFate; other?: PileFate;
  among?: Filter;                          // narrows the UNCHOSEN set ("all other NONLAND PERMANENTS they control")
  excludeSharing?: 'creature-type' }       // spare an unchosen permanent that shares a creature type with one of ITS OWN controller's chosen ones
```

Reads the chosen / unchosen record the last choice op wrote. At least one of `chosen` / `other` must be present.
Binds `those` to everything it acted on. With **no** record on the source — the antecedent sentence did not parse —
the op reports the line as `unsimulated` instead of doing nothing; see "The chosen / unchosen record".

```json
{ "op": "chosen-fate", "chosen": { "how": "move", "to": "hand" }, "other": { "how": "move", "to": "graveyard" } }
```
```json
{ "op": "chosen-fate", "other": { "how": "sacrifice" }, "among": { "types": ["Creature"] }, "excludeSharing": "creature-type" }
```

### `set-level` — Class levels (CR 716.2a)

```ts
{ op: 'set-level'; to: number; anyLevel?: boolean }
```

"[Cost]: Level N" means "This Class's level becomes N. Activate only if this Class is level N-1 and only as a
sorcery" (CR 716.2a). A level is a **designation**, not a counter (CR 716.4): it lives in `o.ext.pcLevel`, and a
permanent with no level is level 1 (CR 716.2d). Without `anyLevel` the op only raises the level from exactly `to - 1`
— the activation restriction, enforced at resolution because a parsed "{cost}: Level N" line reaches the engine as a
plain activated ability (see §5). Raising the level queues the `became-level` event and is a `note` in the log.

```json
{ "kind": "activated", "cost": { "mana": { "generic": 0, "x": 0, "pips": ["G"], "hybrid": [], "phyrexian": [], "raw": "{G}" } }, "sorcerySpeed": true, "activateOnlyIf": { "kind": "self-level", "exactly": 1 }, "effects": [{ "op": "set-level", "to": 2 }], "text": "{G}: Level 2" }
```
```json
{ "kind": "triggered", "event": { "on": "became-level", "level": 2 }, "effects": [{ "op": "token-copy", "target": { "kind": "permanent", "controller": "you", "filter": { "token": true } }, "count": 1 }], "text": "When this Class becomes level 2, create a token that's a copy of target token you control." }
```

---

## 3. Condition, trigger and static

### `self-level` (condition) — CR 716.2a, 716.2d

```ts
{ kind: 'self-level'; atLeast?: number; exactly?: number }
```

The source's level; a permanent with no level reads as level 1. At least one of `atLeast` / `exactly` is required.
This is how a level-gated ability is written: `activateOnlyIf` on an activated ability, `condition` on a triggered
one, `condition` on an `anthem` / `self-keywords` / `self-pt` static.

```json
{ "kind": "activated", "cost": {}, "activateOnlyIf": { "kind": "self-level", "exactly": 2 }, "effects": [{ "op": "set-level", "to": 3 }], "text": "{3}{G}: Level 3" }
```
```json
{ "kind": "static", "effect": { "kind": "anthem", "power": 2, "toughness": 2, "filter": { "types": ["Creature"], "token": true }, "scope": "you-control", "condition": { "kind": "self-level", "atLeast": 3 } }, "text": "Creature tokens you control get +2/+2." }
```

### `became-level` (trigger) — CR 716.2a

```ts
{ on: 'became-level'; level: number }
```

Fires when `set-level` raises **this permanent** to exactly `level`.

```json
{ "kind": "triggered", "event": { "on": "became-level", "level": 2 }, "effects": [{ "op": "draw", "amount": 2, "who": "you" }], "text": "When this Class becomes level 2, draw two cards." }
```
```json
{ "kind": "triggered", "event": { "on": "became-level", "level": 3 }, "effects": [{ "op": "counters", "target": "self", "counter": "+1/+1", "amount": 3 }], "text": "When this Class becomes level 3, put three +1/+1 counters on it." }
```

### `extra-votes` (static) — CR 701.38d

```ts
{ kind: 'extra-votes'; amount: number }
```

"While voting, you may vote an additional time." Its controller casts `amount` extra votes in every `vote`, at the
same time as their first (CR 701.38d). It folds into `Mods.flags` (the number rides in the flag key, because
`Mods.flags` is boolean-valued) and the `vote` op reads it off the permanents each voter controls.

```json
{ "kind": "static", "effect": { "kind": "extra-votes", "amount": 1 }, "text": "While voting, you may vote an additional time." }
```
```json
{ "kind": "static", "effect": { "kind": "extra-votes", "amount": 2 }, "text": "While voting, you may vote two additional times." }
```

---

## 4. Parser wordings (`src/cards/rules/piles-choices.ts`)

An instant or sorcery never reaches parse.ts's line hook (its spell-text branch claims the line first), and the pile
and "for each player" cards are all instants and sorceries — so they are read **sentence by sentence**, which is
exactly what the chosen / unchosen record on the source is for. A rule never emits `that` / `those` unless the
sentence really follows a *binding* antecedent, because parse.ts's `bindAntecedent` declines a frame-reading sentence
whose antecedent does not bind and a family's ops are not in its `BINDING_OPS` list.

| wording | op |
|---|---|
| "Reveal the top N cards of your library and separate them into two piles" | `separate-piles` from the library top, separator `you`, `reveal` |
| "Reveal the top N cards of your library" | a `scoped you` block: the built-in `look-top`, then `reveal-cards` (see below) |
| "An opponent separates those cards into two piles" | `separate-piles` `from: 'those'`, separator `an-opponent` |
| "An opponent chooses one of those piles" | `choose-pile` with `chooser: 'an-opponent'` |
| "Put that pile into your hand and the other into your graveyard" | `chosen-fate` |
| "Put one pile into your hand and the other into your graveyard / on the bottom of your library in any order" | a `scoped you` block: `choose-pile` (you) then `chosen-fate` |
| "An opponent chooses N of those cards"; "Put the chosen cards into your graveyard and the rest into your hand" (and the mirror) | `choose-objects` `from: 'those'`; `chosen-fate` |
| "For each player, you choose from among the permanents that player controls an artifact, a creature, …" | `choose-for-each-player` with one `{ types: [T] }` pick per listed article |
| "For each player, you choose a creature that player controls" | `choose-for-each-player` with `from` narrowed to the same type |
| "[Then] each player sacrifices all other nonland permanents / permanents / creatures they control" | `chosen-fate` `other: sacrifice`, `among` from the words |
| "… all other creatures they control that don't share a creature type with the chosen creature they control" | the same with `excludeSharing: 'creature-type'` |
| "When this Class becomes level N, …" (a trigger head) | the `became-level` event |

**"Reveal the top N cards of your library" is two ops in a `scoped you` container**, `look-top` then
`reveal-cards`. `look-top` has to be there and has to be first: it is the only op in the sentence that parse.ts
counts as *binding* the cards it read (`BINDING_OPS` is core, and no family op is in it), and the next sentence
— "An opponent separates **those cards** into two piles." — is declined outright if nothing before it binds. The
container is transparent to that judgement: `bindsFrame` walks a `do` list. `reveal-cards` then does the half
`look-top` does not, making the cards public (CR 701.20a vs 701.20e).

Reading the sentence as `look-top` **alone** was the first cut, and it was wrong in a way the log did not show: the
cards stayed unknown to everybody, so under any hidden-information agent — the UI, a human, anything with
`agent.hidden` — the opponent asked to separate the piles was splitting five `__hidden__` cards, which is the entire
decision Fact or Fiction is made of. The rule moves 46 cards whose *unparsed lines are unchanged* (their next
sentence is still unknown) and makes four pile cards parse in full; `npm run parse:diff` shows 0 previously
fully-parsed cards moved and 0 cards with more unparsed lines than before.

### Declines

* **"Choose three —", "choose one that hasn't been chosen —", "An opponent chooses one —" and every other modal
  header.** parse.ts's `• ` line branch appends a bullet only to a preceding core `choose-mode`, and it runs above
  both line hooks — so a family op cannot collect the bullets, and the modes would be lost. `choose-modes` is
  reachable from a per-card script, not from the parser. See §5.
* **"{cost}: Level N".** parse.ts's built-in activated-ability branch claims the line before any line rule (its cost
  parses), so the family cannot set `sorcerySpeed` or the "level N-1" `activateOnlyIf` there. `set-level` enforces
  the level half at resolution; a script sets the timing half.
* **Votes.** No printed vote is a single sentence the family can claim: the options are bullets, which the `• `
  branch owns (as above). `vote` is script-only.
* **"Target opponent chooses a creature they control. Other creatures they control can't block this turn."** The
  second sentence needs the *unchosen* set of the first, and expressing it needs a frame word the first sentence's
  op cannot bind at parse time.
* **"Each player secretly chooses a number 0 or greater…"** (Menacing Ogre): simultaneous hidden numeric choices have
  no decision kind here.
* **Planechase's "each player votes for planeswalk or chaos"**: planes and planar decks are not modelled.

---

## 5. What is deliberately not here

* **Modes with targets.** `legal.ts:nestedLists` is a hardcoded switch, so the effects inside `choose-modes` /
  `vote` are never offered a target at cast time. A modal spell whose modes target must use the core `choose-mode`.
* **A single-decision partition.** `separate-piles` *does* let the separator choose the sizes (CR 700.3a), but it
  spends two decisions per pile — a `choose-option` for the size, then a `choose-cards` for the contents — instead of
  one partition decision, so that every shipped agent, the UI and the replay keep working on the core decision kinds
  alone (`choose-cards`, `choose-option`, `choose-player`). The cost of that is a default agent that answers
  `options[0]`: the size list puts the even split first for exactly this reason, and a search agent that wants 5/0
  has to walk the option list rather than being handed a set of partitions.
* **Gating a parser rule on its antecedent.** `EffectRule.make` is handed one normalised sentence and the shared
  sub-parsers (`src/cards/rules/types.ts`) — never the sibling effects — so a rule cannot decline "Put that pile into
  your hand and the other into your graveyard." because the sentence before it failed to parse. The runtime
  `unsimulated` report above is the substitute; a real fix belongs in `parse.ts`'s `bindAntecedent`, whose
  `BINDING_OPS` list is core.
* **Face-down piles** (CR 700.3, Atris, Curator of Destinies): the family always keeps piles public — `separate-piles`
  records its whole pool as publicly known, so a face-down pile would need a knowledge model this does not have.
* **Un-revealing.** `knowledge.revealed` is append-only here, as it is in the core (`dig` with `reveal`, `explore`
  never take an id back off it). CR 701.20d ends a reveal when the library is shuffled or reordered, so a pile put
  back on the bottom of a library stays publicly known when the rules say it should not. Fixing it belongs with
  `Game.shuffle` / `moveTo`, which are core.
* **A look that the looker can see.** `look-top` records nothing at all, so a player who looks at the top of their
  own library still gets `__hidden__` back from `redact` (CR 701.20e wants `knowledge.knownTop`). That is core
  (`src/engine/game.ts`); this family only fixes the *reveal* half, for the sentences it claims.
* **Revealing what a choice is made from.** `choose-objects` and `choose-for-each-player` do not reveal their pool:
  every printed card that reaches them chooses among permanents, or among cards an earlier sentence already
  revealed. A script that points `choose-objects` at a library or a hand should put a `reveal-cards` in front of it.
* **Level-gated statics whose kind has no `condition` field** (`cost-adjust`, `counters-replacement`,
  `grant-ability`, …). `anthem`, `self-keywords` and `self-pt` carry one; the rest would need `Ability.atLevel`,
  a core change.
* **Sorcery timing on a parsed level bar** — see the Declines above.
