# dice-coin — flipping coins and rolling dice (Phase 9.1)

Engine: `src/engine/ops/dice-coin.ts` · schema: `src/engine/ops/dice-coin.schema.ts` · parser rules:
`src/cards/rules/dice-coin.ts` · scenarios: `test/scenarios/dice-coin.ts`

Two random events on the game's own RNG — **flipping a coin** (CR 705) and **rolling a die** (CR 706) — plus the
vocabulary a card needs to talk about what came up: the "if you win the flip" branch, the `1—9 |` results table,
"the result", "the other result", "for each flip you won", and the "whenever you roll one or more dice" /
"whenever you win a coin flip" triggers.

134 paper cards in the pool carry this family in their unparsed lines.

---

## The one design decision

**This family owns only the randomness.** Everything that happens *because* of it is a core `conditional`:

| oracle text | AST |
|---|---|
| `Flip a coin. If you win the flip, X.` | `[{ op: 'flip-coin' }, { op: 'conditional', condition: { kind: 'coin-flip', outcome: 'won' }, then: [X] }]` |
| `Roll a d20.` `1—9 \| X` `10—19 \| Y` `20 \| Z` | `[{ op: 'roll-die', sides: 20 }, { op: 'conditional', condition: { kind: 'roll-result', least: 1, most: 9 }, then: [X] }, …]` |
| `… equal to the result` | `{ count: 'roll-result' }` |

There is no `table` field on `roll-die`, and no `win` / `lose` list on `flip-coin`. That is deliberate, and it is not
only about having less vocabulary:

* `conditional` is a container the core **descends** when it works out which effects target
  (`src/engine/legal.ts:sharedLists`), so a branch may say "target creature" and its picks are keyed apart from
  every other branch's (CR 115.1). A list nested inside a *family* op is invisible to that pass, so a targeted
  effect inside one would never be given a target.
* CR 706.3b says the roll, the modifiers printed with it, the instructions based on the result and the results
  table are **all one ability** — which is exactly one effect list.
* the round-trip renderer prints the striations itself, because they are core nodes.

---

## Where the result lives

One JSON-plain record on the game's `ext` bag, `s.ext.diceCoin`, rewritten by each roll or flip:

```ts
{ kind: 'roll' | 'coin', srcId: number, result: number, other: number, heads: number, tails: number, naturals: number[] }
```

* `srcId` is the object that rolled or flipped. A condition or amount evaluated for a **different** source reads as
  nothing (`false` / `0`) rather than as somebody else's dice, so one permanent can never see another's roll.
* a `cleanup-end` step hook drops the record at end of turn — nothing should read a roll a turn later.
* nothing in it is hidden information (CR 705.1 flips and CR 706.1 rolls happen in the open), so the family
  registers **no** `redact` / `redactPlayer` / `redactState` hook. `clone.ts` deep-copies the bag and `serialize.ts`
  round-trips it, both automatically.

`item.lastAmount` is also set — to the result of a roll, and to the number of flips won — so a following
`{ count: 'that-many' }` ("… then draw that many cards") reads it the way it reads every other amount.

**The coin.** CR 705.2 lets the flipping player call heads or tails before the flip; on a fair coin the call is
immaterial, so this family always calls heads. "Wins the flip" and "comes up heads" are therefore the same event
here — which is what every printed card that uses both wordings assumes.

**The RNG.** `g.rng` is the game's seeded mulberry32 stream, the same one that shuffles libraries, so a game replays
identically from its seed and an AI rollout of a coin-flip card is as reproducible as any other. Both ops are bounded
(64 dice, 64 flips) so a runaway `count` or a long "until you lose" streak can never hang a rollout.

---

## Effects

### `roll-die`

```ts
{ op: 'roll-die'; sides: number; count?: Amount; keep?: 'sum' | 'choose-one' | 'highest' | 'lowest'; plus?: Amount }
```

| field | meaning | CR |
|---|---|---|
| `sides` | the N of "dN": N equally likely outcomes, 1..N | 706.1a |
| `count` | how many dice (default 1) | 706.1 |
| `keep` | what the *result* of several dice is: `sum` (default) adds them up, `choose-one` asks the roller (the shipped agent takes the highest), `highest` / `lowest` ignore the rest | 706.4, 706.6 |
| `plus` | a modifier added to the natural result | 706.2 |

Rolling emits a logged `die-roll` event, sets the record, sets `item.lastAmount`, and raises `dice-rolled` **once for
the instruction**, however many dice it named (CR 706.1).

```jsonc
// Herald of Hadar — "{5}{B}: Roll a d20." + the three striations
[{ "op": "roll-die", "sides": 20 },
 { "op": "conditional", "condition": { "kind": "roll-result", "least": 1, "most": 9 },  "then": [{ "op": "lose-life", "amount": 2, "who": "each-opponent" }] },
 { "op": "conditional", "condition": { "kind": "roll-result", "least": 10, "most": 19 }, "then": [{ "op": "lose-life", "amount": 2, "who": "each-opponent" }, { "op": "gain-life", "amount": 2, "who": "you" }] },
 { "op": "conditional", "condition": { "kind": "roll-result", "least": 20 },             "then": [{ "op": "lose-life", "amount": 2, "who": "each-opponent" }, { "op": "gain-life", "amount": 2, "who": "you" }] }]

// Diviner's Portent — "Roll a d20 and add the number of cards in your hand."
[{ "op": "roll-die", "sides": 20, "plus": { "count": "cards-in-hand" } },
 { "op": "conditional", "condition": { "kind": "roll-result", "most": 14 }, "then": [{ "op": "draw", "amount": { "count": "roll-result" }, "who": "you" }] }]
```

### `flip-coin`

```ts
{ op: 'flip-coin'; count?: Amount; until?: 'lose' }
```

| field | meaning | CR |
|---|---|---|
| `count` | how many coins (default 1); each is flipped separately | 705.1 |
| `until: 'lose'` | keep flipping while the flips are won and stop on the first loss | 705.2 |

Each flip emits a logged `coin-flip` event and raises `coin-flipped` with `ctx.amount` = 1 for a win and 0 for a
loss. Afterwards `item.lastAmount` is the number of flips won.

```jsonc
// Mana Crypt — "At the beginning of your upkeep, flip a coin. If you lose the flip, ~ deals 3 damage to you."
[{ "op": "flip-coin" },
 { "op": "conditional", "condition": { "kind": "coin-flip", "outcome": "lost" }, "then": [{ "op": "damage-you", "amount": 3 }] }]

// Crazed Firecat — "flip a coin until you lose a flip. Put a +1/+1 counter on ~ for each flip you won."
[{ "op": "flip-coin", "until": "lose" },
 { "op": "counters", "target": "self", "counter": "+1/+1", "amount": { "count": "flips-won" } }]
```

---

## Conditions

### `coin-flip`

```ts
{ kind: 'coin-flip'; outcome: 'won' | 'lost' | 'heads' | 'tails'; least?: number }
```

True when at least `least` (default 1) of the flips this ability made came up that way. `won` and `heads` are the
same test, as are `lost` and `tails` (CR 705.2). False when the ability flipped nothing.

* `"If you win the flip, …"` → `{ kind: 'coin-flip', outcome: 'won' }`
* `"If you win two or more flips, …"` → `{ kind: 'coin-flip', outcome: 'won', least: 2 }`
* `"If it comes up tails, …"` → `{ kind: 'coin-flip', outcome: 'tails' }`

### `roll-result`

```ts
{ kind: 'roll-result'; least?: number; most?: number }
```

True when this ability's roll result is within the bounds — the striation of a results table (CR 706.3a) and the
prose form ("if the result is 15 or more"). `least` alone is the open-ended `N+` form; `least === most` is the
single-number form. False when the ability rolled nothing.

---

## Amount counts

| count | meaning | CR |
|---|---|---|
| `roll-result` | the result of this ability's roll, modifiers included — "the result", "that result", "the total of those results", and the `X` of a results-table striation | 706.2, 706.3a |
| `roll-other-result` | the result *not* chosen by a "roll two dice and choose one result" (the ignored one for `highest` / `lowest`); 0 when there is no other | 706.4 |
| `flips-won` | how many of this ability's flips were won — "for each flip you won", "the number of coins that came up heads" | 705.2 |

All three read 0 when the ability made no roll / no flip, and when the record belongs to another source.

---

## Triggers

```ts
{ on: 'dice-rolled'; who: 'you' | 'any' }
{ on: 'coin-flipped'; who: 'you' | 'any'; outcome?: 'won' | 'lost' }
```

* `dice-rolled` fires **once per roll instruction**, not once per die (CR 706.1): "Whenever you roll one or more
  dice" on Brazen Dwarf triggers once for a roll of three dice.
* `coin-flipped` fires once per flip. With no `outcome` it is "whenever you flip a coin"; `outcome: 'won'` is
  "whenever you win a coin flip" (CR 705.2), and the two halves partition every flip between them.
* `who: 'you'` compares the roller/flipper with the trigger source's controller; `who: 'any'` matches every player.

---

## Events

| type | logged | CR | line |
|---|---|---|---|
| `die-roll` | yes | 706.1 | `P0 rolls 2 d6 for Grizzly Bears: 1, 2 (result 2).` |
| `coin-flip` | yes | 705.2 | `P0 flips a coin for Mana Crypt: heads (wins the flip).` |

---

## Parser wordings

Sentence rules (`roll-die` / `flip-coin`):

```
Roll a d20.                                   Roll two d4 and choose one result.
Roll two six-sided dice.                      Roll X six-sided dice.
Roll a d20 and add <amount>.                  Roll two d20 and ignore the lower roll.
Flip a coin.                                  Flip five coins.
Flip a coin until you lose a flip.
```

Condition rules, which the parser's own `If <condition>, <effects>` split then turns into a `conditional`:

```
you win the flip / you lose the flip / you win two or more flips
it comes up heads / the coin comes up tails / it's heads
the result is 15 or more / the result is 3 or less / the result is 20
```

Trigger rules:

```
Whenever you roll one or more dice / Whenever a player rolls a die
Whenever you win a coin flip / Whenever you lose a coin flip / Whenever a player flips a coin
```

Amount phrases — the same six sentence shapes `src/cards/rules/composition.ts` carries for the amounts *it* knows
(those rules are consulted first and decline on a dice phrase):

```
…, where X is the result            …deals damage to <target> equal to the result
…put a number of <k> counters on <target> equal to the result
…create a number of <spec> tokens equal to that result
…draw cards equal to the result     …you gain life equal to the result
```

Line rule — a results-table striation (CR 706.3a), appended to the ability the previous line built as one more
`conditional` on the roll result:

```
1—9 | <effects>          20 | <effects>          15+ | <effects>
```

Every `X` inside a striation is rewritten to `{ count: 'roll-result' }` (CR 706.3a: the striation is read against
the result).

---

## What is not parsed

Wordings this family deliberately leaves unparsed rather than fake (recorded so the next wave can pick them up):

| clause | why |
|---|---|
| a results table on an **instant or sorcery** ("Diviner's Portent", 17 cards) | the spell-text branch of `parse.ts` runs above the line hooks and hands the registry one *sentence* at a time, so a two-sentence striation would arrive cut in half and its tail would run unconditionally. A striation is therefore claimed only as a whole **line**, which spells never reach. Needs a paragraph-level rule hook, or `isSpell` on `EffectCtx`. |
| "flip a coin for each creature … Destroy each creature whose coin comes up tails" (Rakdos, the Showstopper) | per-object flips need the flipped objects bound as `that`, and a sentence whose frame nothing binds is rejected by `parse.ts`'s antecedent check. A whole-line rule could do it; one card. |
| "If you would roll one or more dice, instead roll that many dice plus one and ignore the lowest roll" (Pixie Guide, Barbarian Class, Wyll) and Krark's Thumb / Pokey / Two-Headed Coin | replacement effects on the roll itself. They need a static kind the roll op consults, which in turn needs a `statics` registration for `scripts:verify`'s registry stage; ~6 cards. |
| "For each result of 3, …" / "For each odd result, …" / "if they roll doubles" | per-die iteration over the naturals, which no amount count can express (CR 706.5). |
| "~ has trample as long as you've rolled three or more dice this turn" | a per-turn count of roll instructions; one card. |
| "Flip that many coins" | needs an unfed `that many` (the preceding "choose a number" is itself unparsed). |

---

## Renderer limits

`FamilyModule.render` is handed only its own node — `src/cards/render.ts` is tooling-only (it imports the registry
barrel, and it pulls in zod through `src/cards/schema.ts`), so a family cannot call `renderEffect` on a child without
a module cycle and without zod reaching the web worker. It does not matter here, because the striations are core
`conditional`s that the core renderer prints, but a family whose op really does own a nested effect list has no way to
render it. See `coreChangeNeeded` in this wave's report: widening `render` to `(e, sub) => string`, where `sub`
carries `effects` / `effect` / `amount` / `filter` / `target`, would close it.
