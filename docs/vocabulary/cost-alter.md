# cost-alter (Phase 9.1)

What a spell **costs**, and **where** it may be cast from: cost-adjustment statics that take an `Amount` and a
`Condition`, cast-from-zone permissions, free casts, "rather than pay" alternative costs, and the cost parts those
alternative costs are built out of (exile the source, sacrifice / return / exile *N* matching cards).

* engine: `src/engine/ops/cost-alter.ts` — zod mirror: `src/engine/ops/cost-alter.schema.ts`
* parser rules: `src/cards/rules/cost-alter.ts`
* scenarios: `test/scenarios/cost-alter.ts` (29, one per op / static / cost part / amount / target kind and per
  keyword parameter)

Rule numbers refer to the Comprehensive Rules bundled in `data/rules/cr.json`.

---

## 1. Where a cost alteration is applied

The total cost of a spell is locked in at CR 601.2f: the mana cost (or the alternative cost that replaced it, CR
118.9), plus additional costs, plus every **increase**, minus every **reduction**, in that order — and a cost is
never reduced below zero coloured requirements. The engine computes the generic-mana part of that in
`cost.ts:costAdjust`, which the family answers through the registry's `costMod` hook; `legal.ts:castActionsFor`
enumerates the payment plans through the same function, so a discount is visible in the *legal action* as well as in
what `castSpell` charges.

Two consequences worth stating, because they are what the shapes below are designed around:

* an alteration is read **while the card is still in its old zone** — the hook is handed the card, the player and the
  `CastZone`, never a permanent on the battlefield — which is why the card's own "~ costs {2} less to cast …" line is
  a `self` alteration rather than a static that only works from the battlefield;
* the engine determines the cost **before** targets are chosen, so "costs {2} less if it targets a tapped creature"
  is not expressible today (see §8).

---

## 2. The `cost-alter` static

```ts
{ kind: 'cost-alter';
  amount: Amount;                        // how much generic mana the cost changes by
  more?: true;                           // the alteration is an increase (a tax), not a reduction
  self?: true;                           // only the card that carries this ability, wherever it is cast from
  who?: 'you' | 'opponent' | 'any';      // whose spells (default 'any'); ignored when `self` is set
  filter?: Filter;                       // which spells (matched against the card being cast)
  from?: CastZone | 'non-hand';          // only spells cast from that zone
  condition?: Condition;                 // only while this holds
  nthSpellEachTurn?: number;             // "the second spell you cast each turn": 2 = the caster has cast 1 before
}
```

| field | semantics | CR |
|---|---|---|
| `amount` | evaluated as the cost is determined, with the ability's source as the source object and the caster as the controller — so `{ count: 'party' }`, `{ prop: 'power', agg: 'max', over: … }` and every other composition amount work here | 601.2f, 608.2h |
| `more` | the amount is added instead of subtracted. Increases are applied after reductions; the engine folds both into one signed number, which is the same arithmetic for a single alteration and for any set of them | 601.2f |
| `self` | the ability is read off the card being cast (`defOf(card).abilities`), not off the battlefield. A `self` alteration ignores `who`, and its `condition` is evaluated about the card being cast with the caster as its controller, exactly as `castSpell` evaluates an alternative cost's condition | 601.2f |
| `who` | `you` = the source's controller is the caster, `opponent` = it is not, `any` = either | 601.2f |
| `filter` | the ordinary `matchesFilter` vocabulary, applied to the card on its way to the stack | 601.2f |
| `from` | `'hand'` / `'graveyard'` / `'exile'` / `'command'`, or `'non-hand'` for "spells you cast from anywhere other than your hand" | 601.2 |
| `condition` | any `Condition`; the family adds none of its own — "if a creature died this turn" is `morbid`, "if you control a Wizard" is `controls`, "if you've cast another spell this turn" is `spells-cast-this-turn-ge` | 601.2f |
| `nthSpellEachTurn` | true only while the caster's `spellsCastThisTurn` is exactly `n − 1`, i.e. the spell being cast is their *n*-th this turn | 601.2f |

Only the generic part of a cost is altered: a reduction never removes a coloured pip, and `{B}` more is not
expressible (see §8).

```json
{ "kind": "static", "effect": { "kind": "cost-alter", "amount": 3, "self": true, "condition": { "kind": "morbid" } }, "text": "This spell costs {3} less to cast if a creature died this turn." }
```
```json
{ "kind": "static", "effect": { "kind": "cost-alter", "amount": 1, "who": "you", "from": "graveyard" }, "text": "Spells you cast from your graveyard cost {1} less to cast." }
```

## 3. The `cast-from` static

```ts
{ kind: 'cast-from'; zone: 'graveyard' | 'exile'; filter?: Filter; free?: true }
```

Permission to cast cards from a zone other than the hand (CR 601.2, and CR 118.9b when `free` is set). The family
answers it in three places: `legalActions` offers the cast, `castFrom` lets `castSpell` take the card out of that
zone, and `freeCast` makes the mana cost nothing at all. Lands are never offered (a land is *played*, not cast, CR
305.1), timing is the ordinary sorcery-speed rule unless the card is an instant or has flash, and the mana cost is
still paid unless `free` is set — through the family's own alterations, so "cast it from your graveyard" and "spells
you cast from your graveyard cost {1} less" stack the way they read.

**Only spells with no targets are offered** as a legal action. `legalActions` is synchronous and a family may not
import `legal.ts` at module scope (the barrel would be a cycle), so the hook cannot compute the target options an
agent would answer with, and an action with no options is an action that can only be rejected. A conservative walk
over the spell's effects decides: anything that looks like a target requirement means "not offered". Scripts and the
scenario DSL may still cast a targeting spell from the zone — `castSpell` itself is gated only by `castFrom` — and
the fix is the core change in §8.

```json
{ "kind": "static", "effect": { "kind": "cast-from", "zone": "graveyard", "filter": { "types": ["Creature"] } }, "text": "You may cast creature spells from your graveyard." }
```
```json
{ "kind": "static", "effect": { "kind": "cast-from", "zone": "exile", "free": true }, "text": "You may cast spells from among the cards you own in exile without paying their mana costs." }
```

## 4. `cast-free` — cast a card now, without paying its mana cost

```ts
{ op: 'cast-free';
  from: 'hand' | 'graveyard' | 'exile' | 'exiled-with';
  filter?: Filter;
  mvLE?: Amount;        // "with mana value X or less" — evaluated in the resolving item's frame
  optional?: true;      // "you may": a `may` decision first
}
```

The cast happens **during this resolution** (CR 608.2f): the chosen card goes on the stack above the spell or ability
that cast it and resolves first. Nothing is paid (CR 118.9b) — the family marks the card, and its `freeCast` hook
answers `castSpell`. `from: 'exiled-with'` means the cards exiled *with the source* (`GameObject.exiledWith`, what
Hideaway and every "exile … you may play that card" line fill in), wherever they are in exile; the other three words
are plain zones of the acting player.

* candidates are the non-land cards in that zone matching `filter` and, with `mvLE`, of at most that mana value; a
  land among them is skipped, because the engine has no play-land-from-exile action (§8);
* with no candidate the effect does nothing at all (no decision is asked);
* with `optional`, a `{ kind: 'may' }` decision is asked first — the parser does not set it, because parse.ts already
  wraps a sentence that began with "You may" in a `may` container;
* the card is chosen by a `choose-cards` decision, and the spell's own targets are picked the way a triggered
  ability's are (hostile spells at an opponent, helpful ones at the caster) — `castSpell` re-checks every pick against
  the requirement it answered (CR 601.2c).

```json
{ "op": "cast-free", "from": "hand", "mvLE": "X" }
```
```json
{ "op": "cast-free", "from": "exiled-with", "filter": { "types": ["Instant"] }, "optional": true }
```

## 5. `hideaway` — Hideaway N (CR 702.75)

```ts
{ op: 'hideaway'; count: number }
```

Look at the top `count` cards of your library, exile one of them, then put the rest on the bottom of your library in a
random order. The exiled card is linked to the source (`exiledWith`), which is what the card's own payoff line — a
`cast-free` with `from: 'exiled-with'`, or the `exiled-with-card` target — reaches later. The engine keeps the exiled
card face **up**: exile is a public zone here and nothing in the engine hides one card of it from one player, so the
"face down" half of Hideaway is cosmetic (the choice of which card was hidden is still the controller's).

Hideaway is printed as a keyword on a permanent, so the parser attaches it as an enters-the-battlefield trigger.

```json
{ "kind": "triggered", "event": { "on": "etb", "self": true }, "effects": [{ "op": "hideaway", "count": 4 }], "text": "Hideaway 4" }
```
```json
{ "kind": "triggered", "event": { "on": "etb", "self": true }, "effects": [{ "op": "hideaway", "count": 5 }], "text": "Hideaway 5" }
```

## 6. Cost parts

Non-mana cost parts are `AbilityCost` keys; `cost.ts:nonManaCostPayable` checks them and `game.ts:payCost` pays them,
in both cases with the source as the object the part is about (CR 118.3). Each of these is a shape the core parts
could not express.

| key | value | meaning | CR |
|---|---|---|---|
| `exileSelf` | `true` | exile the source **from the battlefield** to pay ("Exile this artifact:") | 118.3 |
| `exileSelfFromGraveyard` | `true` | exile the source **from the graveyard** to pay ("Exile this card from your graveyard:", on an ability marked `fromGraveyard`) | 113.6b, 118.3 |
| `sacrificeMany` | `{ filter, count }` | sacrifice exactly `count` permanents you control matching `filter` — the source included; the core `sacrifice` part is exactly one | 118.3, 601.2h |
| `returnToHandMany` | `{ filter, count }` | return `count` matching permanents you control to their owner's hand (the source included) | 118.3 |
| `exileFromGraveyardMatching` | `{ count, filter? }` | exile `count` cards matching `filter` from your graveyard, never the source itself; the core `exileFromGraveyard` part counts but cannot filter | 118.3 |

The last three are zone-keyed too (`zoneAllows`), just not by their key: see "Why the exile part is split by zone"
below.

Each is chosen by the paying player through a `choose-cards` decision, and each refuses to be paid when the zone does
not hold enough — which is what keeps the ability out of `legalActions`.

**Why the exile part is split by zone.** CR 113.6b: an ability that states which zone it functions in functions only
from that zone, and CR 118.4 says a cost is paid from where the ability says. `legal.ts`'s battlefield scan does not
skip `ab.fromGraveyard`, so a single part payable from either zone made every one of these 56 abilities activatable
by the permanent *in play* — it would exile itself from the battlefield to get its graveyard ability's effect. A
part payable only from the graveyard makes `cost.ts:nonManaCostPayable` refuse it there, which is the gate the
battlefield scan is missing.

**How the counted parts are zone-keyed instead.** The same reasoning covers the seven graveyard-only abilities whose
cost is `sacrificeMany` / `returnToHandMany` / `exileFromGraveyardMatching` — "Sacrifice two artifacts: Return ~ from
your graveyard to your hand" (Metalwork Colossus, Salvage Titan, Coffin Puppets, Multani Yavimaya's Avatar, Soul
Shredder, Bin Chicken, Dutiful Griffin), which on the battlefield would sacrifice two artifacts (the source among
them) to return the source from *play* to hand: a repeatable recursion loop that does not exist in Magic. Those three
parts cannot be split into two keys the way `exileSelf` was, because the very same key legitimately pays battlefield
abilities as well (Time Sieve, Flooded Shoreline, Moorland Haunt — 58 of them). Nor can the family mark those
abilities itself: parse.ts's built-in activated retry (parse.ts:1976) claims those lines before any family line rule
is offered them, and sets `fromGraveyard` in `addActivated` (parse.ts:1663). What is left is identity — the value a
cost part is handed *is* the `ab.cost[<key>]` object on the ability being paid for — so `zoneAllows` finds the owning
ability among `chars.abilitiesOf(self)` and refuses the part outside the graveyard when that ability is
`fromGraveyard`. An ability without the flag, and an `AltCost` (whose cost object lives on `def.altCosts`, so the
scan never finds it — Sea Drake), are not gated at all.

The hole itself was older and wider than this family: 131 cards whose graveyard ability has a core-only cost (Eternal
Dragon, Tymaret, every unearth) were offered on the battlefield too. 9.1x item 1 closed those in the core —
`legal.ts:legalActions`'s battlefield scan skips any `fromGraveyard` ability (CR 113.6b; pinned by
`test/core-9-1x.test.ts`) — so the family's own gates above are now belt and braces.

**Why the source is not excluded from `sacrificeMany` / `returnToHandMany`.** CR 601.2h lets a permanent be
sacrificed to pay for its own activated ability, which is exactly Time Sieve ({T}, Sacrifice five artifacts — and
Time Sieve is an artifact), Kuldotha Forgemaster, Breya, Whisper, Metalwork Colossus and Turntimber Sower. The core
`sacrifice` part excludes the source, but it is a *different* cost ("Sacrifice a creature" alongside "Sacrifice this
creature"), so the convention does not carry over. `exileFromGraveyardMatching` keeps the exclusion: it is paid by
abilities that already exile the source through `exileSelfFromGraveyard`, and a card cannot be exiled twice.

```json
{ "kind": "activated", "cost": { "mana": { "generic": 2, "x": 0, "pips": ["B"], "hybrid": [], "phyrexian": [], "raw": "{2}{B}" }, "exileSelfFromGraveyard": true }, "fromGraveyard": true, "sorcerySpeed": true, "effects": [ ], "text": "{2}{B}, Exile this card from your graveyard: …" }
```
```json
{ "id": "pitch", "label": "free", "from": "hand", "cost": { "sacrificeMany": { "filter": { "subtypes": ["Mountain"] }, "count": 2 } } }
```

## 7. The `party` amount and the `exiled-with-card` target

* `{ "count": "party" }` — your party's size (CR 700.7): the largest assignment of creatures you control to the four
  slots Cleric, Rogue, Warrior and Wizard, one creature per slot and one slot per creature. A creature that is both a
  Rogue and a Cleric fills one slot, so the count is a maximum matching, not "how many of my creatures have a party
  class" — the family computes it exactly (four slots, exhaustive search). Used by `costModifiers: [{ kind: 'reduce',
  amount: { count: 'party' } }]` for "this spell costs {1} less to cast for each creature in your party".
* `{ "kind": "exiled-with-card" }` — a `TargetSpec` kind offering exactly the cards exiled with the source that are
  still in exile ("Choose target card exiled with ~", CR 115.1).

---

## 8. What this family cannot express (and why)

Each of these needs a core change; none of them was made here.

1. **"This spell costs {2} less to cast if it targets a tapped creature"** and "Spells your opponents cast that target
   ~ cost {2} more" — the engine determines the cost before targets are chosen, and `costAdjust` is handed no targets,
   so a targeting condition has nothing to read. CR 601.2f puts target choice (601.2c) before cost determination, so
   the core order is also the rule's order; the fix is to thread the chosen targets into `costAdjust`.
2. **Cost lines on instants and sorceries.** parse.ts's spell-text branch claims every remaining line of an instant or
   sorcery before the registry line hook is reached, so `~ costs {N} less to cast if …` is claimed by the family only
   on permanents. About 110 instants and sorceries in the pool carry that wording, plus the four instants that read
   "If you control a commander, you may cast this spell without paying its mana cost".
3. **Casting from the top of your library** ("You may cast creature spells from the top of your library"): `CastZone`
   is `'hand' | 'graveyard' | 'exile' | 'command'` and is not an augmentable registry, so `library` is not a zone a
   spell can be cast from at all.
4. **Activated-ability cost alteration** ("Equip abilities you activate cost {1} less to activate"): activated ability
   costs are paid straight out of `ab.cost.mana` with no adjustment hook anywhere.
5. **A coloured increase** ("Black spells you cast cost {B} more to cast"): `costAdjust` is a signed number of generic
   mana.
6. **A `cast-from` permission for a spell with targets** is not offered as a legal action — see §3.
7. **A land hidden away** cannot be played from exile: `play-land` accepts `from: 'graveyard' | 'library'` only.
8. **Closed in 9.1x (item 1) — a graveyard ability was offered while its card is on the battlefield** when its cost
   was one the core could pay there. `legal.ts:legalActions`'s battlefield scan now returns early on
   `ab.fromGraveyard` (CR 113.6b), beside its `sorcerySpeed`, `oncePerTurn`, `loyalty`, `tap`, `untap`, mana,
   `activateOnlyIf` and `nonManaCostPayable` checks. The family's own closures — 56 cards with the zone-gated
   `exileSelfFromGraveyard` part and 7 with `zoneAllows` on the counted parts, both above — stay, and the 131 with a
   core-only cost are covered by the core skip.
9. **Closed in 9.1x (item 2) — `freeCast` was not told which alternative cost the cast chose.** `game.ts:castSpell`
   now runs `FREE_CAST_HOOKS` only when no alternative cost was chosen, the same `!alt` guard the `CAST_FROM_HOOKS`
   block has (CR 118.9: "without paying its mana cost" is itself an alternative cost and only one applies), pinned by
   `test/core-9-1x.test.ts`. The family's `freeBlockedByAlt` abstention and the matching `legalActions` skip are now
   redundant under-approximations the family may drop; until it does, both halves still agree. CR 118.9, 601.2f.
10. **`castSpell` does not re-check the "can't cast" lock.** `opponents-cant-cast` is enforced in exactly one place,
   `legal.ts:castActionsFor` (legal.ts:293); `game.ts:castSpell` has no equivalent, for a cast from hand as much as
   for one through this family's permission. The family's `legalActions` provider therefore applies the same check
   itself (`castForbidden`), which restores parity with the core convention but does not make `performAction`
   authoritative. CR 601.2.
11. **A family static has no renderer.** `render.ts:renderStatic` falls back to the words of the `kind` for a static a
   family owns (`RENDERERS` is consulted for effect ops only), so a script whose only ability is a `cost-alter` static
   round-trips as "cost alter".

---

## 9. Parser wordings

The rule family is consulted only after every built-in stage has declined the text (`src/cards/rules/types.ts`).

| wording | what it produces |
|---|---|
| "Pay {W}{U}{B}{R}{G}" / "pay {1}" as a cost phrase | `{ mana }` — the built-in phrase table reads a bare `{2}{G}` but not one with the word "pay" in front, which is how every "You may pay … rather than pay ~'s mana cost" line is spelled |
| "Sacrifice two Mountains", "Sacrifice two creatures" | `sacrificeMany` |
| "Return two Islands you control to their owner's hand" | `returnToHandMany` |
| "Exile ~" | `exileSelf` |
| "Exile three creature cards from your graveyard" | `exileFromGraveyardMatching` |
| "{2}{B}, Exile ~ from your graveyard: … [Activate only as a sorcery.]" | an activated ability with `exileSelfFromGraveyard`, `fromGraveyard` (and `sorcerySpeed`) — the built-in activated branch cannot mark an ability as activatable from the graveyard, so the whole line is claimed here |
| "Hideaway N" | the enters trigger of §5 |
| "~ costs {N} less/more to cast if <condition>" | the `cost-alter` static, `self` |
| "~ costs {N} less to cast for each creature in your party" | `costModifiers: [{ kind: 'reduce', amount: { count: 'party' } }]` |
| "~ costs {X} less to cast, where X is the greatest power among creatures you control" | `costModifiers: [{ kind: 'reduce', amount: { prop: 'power', agg: 'max', over: … } }]` |
| "If <condition>, you may cast ~ without paying its mana cost" | an `AltCost` with an empty cost (`free-cast`) |
| "You may cast ~ from your graveyard by discarding a card in addition to paying its other costs" | an `AltCost` from the graveyard whose cost is the printed mana cost plus the discard |
| "Spells you cast from your graveyard cost {N} less to cast" | the `cost-alter` static, `who: 'you'`, `from: 'graveyard'` |
| "The second spell you cast each turn costs {N} less to cast" | the `cost-alter` static, `nthSpellEachTurn` |
| "You may cast a spell with mana value X or less from your hand without paying its mana cost" | `cast-free` |
| "You may play the exiled card without paying its mana cost" | `cast-free` with `from: 'exiled-with'` |

The cost-phrase rules are the ones with reach: they run inside the built-in "you may … rather than pay ~'s mana
cost" line, inside "As an additional cost to cast ~, …", inside `unless you …` and inside every activated-ability
cost, which is why one small rule moves cards in several groups of `npm run parse:diff`.

**Filters in a cost phrase are deliberately narrow.** `CostRule.make` is handed no sub-parsers at all, so the family
reads only a plural plain type ("creatures", "artifacts", "lands", "permanents") or a plural basic land name
("Mountains", "Islands"); anything else declines rather than inventing a filter the rest of the vocabulary would
disagree with.
