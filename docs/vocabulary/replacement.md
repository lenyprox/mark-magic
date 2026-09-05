# Replacement effects and prevention shields (Phase 9.1)

CR 614 (replacement effects) and CR 615 (prevention effects) as one family: *"if <this> would <happen>, <that>
instead"*, the shields a spell hands out, the damage and counter doublers, "Players can't gain life.", "Skip your
draw step.", "Lands you control enter untapped." and the "as ~ enters, choose …" half of CR 614.12.

793 paper cards carry one of these lines. Nothing here is a new mechanic: every op below is one of the engine's own
`replacements.*` folds (`game.ts:dealDamage` / `moveTo` / `draw` / `gainLife` / `replaceCounters`) driven by data, so
the family adds no core edits at all.

Engine: `src/engine/ops/replacement.ts` · schema: `src/engine/ops/replacement.schema.ts` · parser wordings:
`src/cards/rules/replacement.ts` · scenarios: `test/scenarios/replacement.ts` (34, one per op, per static kind, per
as-enters kind and per keyword parameter). Rule numbers refer to the Comprehensive Rules in `data/rules/cr.json`.

---

## 1. The two shared sub-shapes

Almost every op below describes a damage event with the same two objects. Both are pure restrictions: an absent
field restricts nothing, and an absent (or empty) `DamageSource` / `DamageRecipient` matches everything.

### `DamageSource` — which source the effect answers for (CR 609.7)

| field | meaning |
|---|---|
| `chosen?: true` | "a source of your choice": one source is chosen **as the shield is created** (CR 615.10) and bound by id. The decision offers every permanent and every spell on the stack that passes `filter` / `who`, ordered stack-first, then another player's permanents, then your own — so an agent that takes the first option picks the spell it is responding to. |
| `self?: true` | the source of the ability itself ("… that would be dealt **by ~**") |
| `attached?: true` | the permanent the source is attached to ("… dealt by **enchanted creature**") |
| `filter?: Filter` | characteristics the source must have — "a **blue** source", "**creatures**", "**another red** source" |
| `who?: 'you' \| 'opponent' \| 'any'` | whose source, relative to the ability's controller |
| `combat?: 'combat' \| 'noncombat'` | only combat damage (CR 510.2) or only noncombat damage |

### `DamageRecipient` — what is being damaged (CR 615.1)

| field | meaning |
|---|---|
| `players?: 'you' \| 'each-opponent' \| 'any'` | the player half |
| `self?: true` | the source of the ability itself ("prevent all damage that would be dealt **to ~**") |
| `attached?: true` | the permanent the source is attached to |
| `filter?: Filter` + `who?` | the permanent half: permanents matching `filter` controlled per `who` |

A damage event matches when **either** half says so, which is how "to you **and** planeswalkers you control" is one
recipient: `{ players: 'you', filter: { types: ['Planeswalker'] }, who: 'you' }`. With every field absent the
recipient is every player and every permanent.

### `PreventFollowUp` — the "if damage is prevented this way, …" rider

`{ mode: 'gain-life' }` · `{ mode: 'damage-source' }` · `{ mode: 'damage-source-controller' }` ·
`{ mode: 'damage-targets' }` · `{ mode: 'counters', counter }`. It runs with the amount **actually prevented**, not
the size of the shield.

### Ordering (CR 616.1)

CR 616.1 lets the affected object's controller choose the order when several replacement or prevention effects apply
to one event. The engine has no decision point there, so this family applies a fixed, documented order per damage
event: the CR 614.1a modifiers first (`plus` / `times` / `counters` / `none`, in battlefield order), then the
CR 615.6 gate, then prevention (`minus` reductions, the continuous shields, and finally the one-shot shields oldest
first). That is the order a player almost always picks, and it is deterministic — which the fuzzer and the goldens
need.

---

## 2. Effects

### `prevent` — hand out a prevention shield (CR 615.1, 615.7, 615.10)

```ts
{ op: 'prevent', amount: Amount | 'all' | 'next', from?: DamageSource, to: DamageRecipient,
  duration: 'eot', rider?: PreventFollowUp }
```

| field | meaning |
|---|---|
| `amount` | a number of damage points ("prevent the next 3 damage"), `'all'` (an unlimited shield), or `'next'` ("the next time … would deal damage …, prevent that damage" — the whole event, CR 615.10) |
| `from` / `to` | which damage the shield answers for |
| `duration` | always `'eot'`: a shield ends in the cleanup step (CR 514.2) |
| `rider` | the "if damage is prevented this way, …" half, when the card prints it in the same sentence |

A numeric shield is spent point by point and the rest of the damage event is still dealt (CR 615.7); an `'all'`
shield never runs out; a `'next'` shield is spent on the first matching event. Shields are consulted oldest first.

```jsonc
// Cho-Manno-style: "Prevent all damage that would be dealt to ~ this turn."
{ "op": "prevent", "amount": "all", "to": { "self": true }, "duration": "eot" }
```
```jsonc
// Deflecting Palm: "The next time a source of your choice would deal damage to you this turn, prevent that damage.
//                   If damage is prevented this way, ~ deals that much damage to that source's controller."
{ "op": "prevent", "amount": "next", "from": { "chosen": true }, "to": { "players": "you" },
  "duration": "eot", "rider": { "mode": "damage-source-controller" } }
```

### `prevent-rider` — the second sentence of the same replacement effect (CR 615.1)

```ts
{ op: 'prevent-rider', rider: PreventFollowUp, target?: TargetSpec }
```

Cards print "…, prevent that damage." and "If damage is prevented this way, …" as two sentences, and the parser
splits a line into sentences before any rule sees it, so the rider is its own effect. It attaches to every shield
**this same source** created that does not carry a rider yet, which in practice means the `prevent` that ran
immediately before it in the same resolution. `target` is only needed for `{ mode: 'damage-targets' }`.

> **Limitation.** The rider can only attach to a shield of *this* family. The core `prevent-damage` op (which
> `parse.ts` produces for "prevent the next N damage that would be dealt to **target** … this turn") stores its
> counter in `o.eotFlags.preventDamage`, and `Game.dealDamage` consumes that before any family replacement is
> consulted. When a rider finds no shield of its own it therefore emits an `unsimulated` event naming the clause,
> so the skip is counted by `verify:pool`, the fidelity ratchet and a scenario's `unsimulated` expectation instead
> of vanishing. Test of Faith, Temper and Brace for Impact are the printed cards in that position today; the fix is
> a core change that routes `prevent-damage` through this family.

```jsonc
// Cho-Arrim Alchemist's second sentence: "You gain life equal to the damage prevented this way."
{ "op": "prevent-rider", "rider": { "mode": "gain-life" } }
```
```jsonc
// Refraction Trap-style: "If damage is prevented this way, ~ deals that much damage to any target."
{ "op": "prevent-rider", "rider": { "mode": "damage-targets" }, "target": { "kind": "any" } }
```

### `damage-cant-be-prevented` — switch prevention off for a turn (CR 615.6)

```ts
{ op: 'damage-cant-be-prevented', match?: DamageSource, duration: 'eot' }
```

Every prevention effect of this family simply does not apply to matching damage for the rest of the turn. `match`
narrows it ("combat damage dealt by creatures you control can't be prevented this turn"); with no `match` it is all
damage.

```jsonc
// Skullcrack / Flaring Pain: "Damage can't be prevented this turn."
{ "op": "damage-cant-be-prevented", "duration": "eot" }
```
```jsonc
// "Combat damage that would be dealt by creatures you control can't be prevented this turn."
{ "op": "damage-cant-be-prevented", "match": { "filter": { "types": ["Creature"] }, "who": "you", "combat": "combat" },
  "duration": "eot" }
```

---

## 3. Static abilities

### `prevention-shield` — a shield a permanent hands out continuously (CR 615.1)

```ts
{ kind: 'prevention-shield', from?: DamageSource, to: DamageRecipient }
```

Unlimited and permanent while the source is on the battlefield: it prevents every matching damage event. A card that
prevents damage in both directions ("to and dealt by enchanted creature") is **two** of these.

```jsonc
// Cho-Manno, Revolutionary: "Prevent all damage that would be dealt to ~."
{ "kind": "prevention-shield", "to": { "self": true } }
```
```jsonc
// Fog Bank's second half: "…and dealt by ~" (combat damage only)
{ "kind": "prevention-shield", "from": { "self": true, "combat": "combat" }, "to": {} }
```

### `unpreventable-damage` — CR 615.6 printed on a permanent

```ts
{ kind: 'unpreventable-damage', filter?: Filter, who?: 'you' | 'opponent' | 'any', combat?: 'combat' | 'noncombat' }
```

The only static in this family that is a *characteristic of another permanent*: it folds a flag into `Mods.flags` for
each permanent that matches `filter` / `who`, and the damage fold reads that flag off the damage source. Damage from
a matching source is not prevented by anything in this family.

```jsonc
// Questing Beast: "Combat damage that would be dealt by creatures you control can't be prevented."
{ "kind": "unpreventable-damage", "filter": { "types": ["Creature"] }, "who": "you", "combat": "combat" }
```
```jsonc
// Everlasting Torment: "Damage can't be prevented."
{ "kind": "unpreventable-damage" }
```

### `damage-replacement` — CR 614.1a on damage

```ts
{ kind: 'damage-replacement', from?: DamageSource, to?: DamageRecipient, instead: DamageInstead }
```

`instead` is one of `{ mode: 'plus', amount }`, `{ mode: 'times', factor }`, `{ mode: 'minus', amount }`,
`{ mode: 'counters', counter }` or `{ mode: 'none' }`. `counters` replaces the damage **entirely** — none is dealt,
so nothing is marked and no lifelink or "deals damage" trigger sees it — and it only applies when the recipient is a
permanent. `minus` is a prevention effect (CR 615.2), so it is switched off by `unpreventable-damage` and by
`damage-cant-be-prevented`; the other modes are not.

```jsonc
// Furnace of Rath: "If a source would deal damage to a permanent or player, it deals double that damage … instead."
{ "kind": "damage-replacement", "instead": { "mode": "times", "factor": 2 } }
```
```jsonc
// Soul-Scar Mage: "If a source you control would deal noncombat damage to a creature an opponent controls,
//                  put that many -1/-1 counters on that creature instead."
{ "kind": "damage-replacement", "from": { "who": "you", "combat": "noncombat" },
  "to": { "filter": { "types": ["Creature"] }, "who": "opponent" },
  "instead": { "mode": "counters", "counter": "-1/-1" } }
```

### `zone-replacement` — CR 614.1a on a zone change

```ts
{ kind: 'zone-replacement',
  would: { self?: true, filter?: Filter, who?: 'you'|'opponent'|'any', to: 'graveyard'|'exile'|'hand'|'library', from?: 'battlefield'|'stack'|'any' },
  instead: { zone: MoveZone, pos?: 'top'|'bottom' } }
```

`would.to` is the zone the object is headed for and `would.from` where it is coming from — `'battlefield'` is what
"would **die**" means (CR 700.4). The move is redirected through `Game.moveTo`'s own replacement fold, so the object
never touches the zone it was headed for.

```jsonc
// Possessed Skaab: "If ~ would die, exile it instead."
{ "kind": "zone-replacement", "would": { "self": true, "to": "graveyard", "from": "battlefield" },
  "instead": { "zone": "exile" } }
```
```jsonc
// Stone of Erech: "If a creature an opponent controls would die, exile it instead."
{ "kind": "zone-replacement",
  "would": { "filter": { "types": ["Creature"] }, "who": "opponent", "to": "graveyard", "from": "battlefield" },
  "instead": { "zone": "exile" } }
```

### `counter-replacement` — CR 614.1c on counters

```ts
{ kind: 'counter-replacement', counter?: string, filter?: Filter, who?: 'you'|'opponent'|'any', instead: CounterInstead }
```

`instead` is `{ mode: 'none' }`, `{ mode: 'plus', amount }`, `{ mode: 'minus', amount }` or
`{ mode: 'times', factor }`. Same scope as the core's `counters-replacement` (CR 614.1c, 121.4): counters being
**put on** a permanent on the battlefield, never loyalty, never a removal. Several of them stack in battlefield
order. It generalises the core static, which only knows `double` and `plus-one`.

```jsonc
// Corpsejack Menace: "If one or more +1/+1 counters would be put on a creature you control,
//                     twice that many +1/+1 counters are put on it instead."
{ "kind": "counter-replacement", "counter": "+1/+1", "filter": { "types": ["Creature"] }, "who": "you",
  "instead": { "mode": "times", "factor": 2 } }
```
```jsonc
// Vizier of Remedies: "If one or more -1/-1 counters would be put on a creature you control,
//                      that many minus one -1/-1 counters are put on it instead."
{ "kind": "counter-replacement", "counter": "-1/-1", "filter": { "types": ["Creature"] }, "who": "you",
  "instead": { "mode": "minus", "amount": 1 } }
```

### `cant-gain-life` — CR 614.1b on life gain

```ts
{ kind: 'cant-gain-life', who: 'you' | 'opponent' | 'all' }
```

`who` is read relative to the static's controller. The life gain is replaced with nothing, so no "whenever you gain
life" trigger fires.

```jsonc
// Rampaging Ferocidon / Giant Cindermaw: "Players can't gain life."
{ "kind": "cant-gain-life", "who": "all" }
```
```jsonc
// Knight of Dusk's Shadow: "Your opponents can't gain life."
{ "kind": "cant-gain-life", "who": "opponent" }
```

### `draw-replacement` — CR 121.6 / 614.1 on draws

```ts
{ kind: 'draw-replacement', who: 'you'|'opponent'|'all', instead: 'skip' | number,
  drawStepOnly?: true, exceptFirstInDrawStep?: true }
```

`instead: 'skip'` replaces the draw with nothing; a number draws that many cards instead of the one.
`drawStepOnly` limits it to the draw taken as the draw step's turn-based action (CR 504.1), which is what "Skip your
draw step." means; `exceptFirstInDrawStep` is the opposite exception. A replacement that draws does not replace its
own draws.

> **Limitation.** `Game.draw` awaits only in its dredge branch, so the recursive draws are synchronous. A numeric
> replacement therefore stands down (the single printed draw happens) when that player has a dredge card in their
> graveyard, rather than leaving a floating promise.

```jsonc
// Dragon Appeasement / Yawgmoth's Bargain: "Skip your draw step."
{ "kind": "draw-replacement", "who": "you", "instead": "skip", "drawStepOnly": true }
```
```jsonc
// Teferi's Ageless Insight: "If you would draw a card except the first one you draw in each of your draw steps,
//                            draw two cards instead."
{ "kind": "draw-replacement", "who": "you", "instead": 2, "exceptFirstInDrawStep": true }
```

### `enters-untapped` — CR 614.12 the other way round

```ts
{ kind: 'enters-untapped', filter: Filter, who: 'you' | 'all' }
```

A matching permanent that would enter tapped enters untapped instead. The engine decides `o.tapped` after every
zone-move replacement has run, so the permanent is *marked* as it enters and untapped in the state-based-action pass
that follows — which is before any player receives priority (CR 117.5), and the mark is consumed there, so a land
tapped for mana later that turn is never touched.

```jsonc
// Horizon Explorer / Spelunking: "Lands you control enter untapped."
{ "kind": "enters-untapped", "filter": { "types": ["Land"] }, "who": "you" }
```
```jsonc
// "Creatures enter untapped." (every player's)
{ "kind": "enters-untapped", "filter": { "types": ["Creature"] }, "who": "all" }
```

---

## 4. As-enters

### `choose-type` — CR 614.12

```ts
{ kind: 'choose-type', what: 'basic-land-type' }
```

"As ~ enters, choose a basic land type." The core's `choose` as-enters kind already covers a colour and a creature
type, which are the two slots `GameObject.chosen` has; a basic land type is stored as `o.ext.chosenLandType`, which is
what a type-changing static ("~ is the chosen type") reads.

It composes with the core as-enters kinds in printed order, so the shockland clause on the same line is the core's
own `pay-life-or-tapped`:

```jsonc
// Multiversal Passage: "As ~ enters, choose a basic land type. Then you may pay 2 life. If you don't, it enters tapped."
"asEnters": [ { "kind": "choose-type", "what": "basic-land-type" }, { "kind": "pay-life-or-tapped", "life": 2 } ]
```
```jsonc
// the choice on its own
"asEnters": [ { "kind": "choose-type", "what": "basic-land-type" } ]
```

---

## 5. Parser wordings

`src/cards/rules/replacement.ts` adds ten static rules, five effect rules and one line rule. The filter words a
source or a recipient may use are a **closed vocabulary** (a colour, "source(s)", "creature(s)", "permanent(s)",
optionally "another"), so a wording with one word outside it declines rather than parsing into a filter that means
something else. Every static rule refuses an instant or a sorcery outright, because the static branch of the line
ladder sits above the spell-text branch.

| wording | produces |
|---|---|
| "Prevent all [combat] damage that would be dealt to ~ / enchanted creature [by <sources>]." | `prevention-shield` |
| "Prevent all [combat] damage that would be dealt by ~ / enchanted creature." | `prevention-shield` |
| "Prevent all [combat] damage that would be dealt to and dealt by ~ / enchanted creature." | two `prevention-shield`s |
| "[Combat] damage [that would be dealt by <sources>] can't be prevented." | `unpreventable-damage` |
| "If <source> would deal [combat] damage to <recipient>, it deals that much damage plus N / double that damage instead." | `damage-replacement` (`plus` / `times`) |
| "If <source> would deal damage to <recipient>, prevent N of that damage." | `damage-replacement` (`minus`) |
| "If <source> would deal [noncombat] damage to <recipient>, put that many <counter> counters on that creature instead." | `damage-replacement` (`counters`) |
| "If ~ / a <filter> would die, exile it / return it to its owner's hand / put it on the bottom of its owner's library instead." | `zone-replacement` |
| "If one or more <counter> counters would be put on <filter>, twice that many / that many plus N / that many minus N … instead." | `counter-replacement` |
| "Players / You / Your opponents can't gain life." | `cant-gain-life` |
| "Skip your draw step." / "Each player skips their draw step." | `draw-replacement` |
| "If you would draw a card[ except the first one you draw in each of your draw steps], draw N cards instead." | `draw-replacement` |
| "Lands / creatures / … [you control] enter untapped." | `enters-untapped` |
| "The next time a [colour] source of your choice would deal damage to you / ~ this turn, prevent that damage." | `prevent` (`'next'`) |
| "Prevent all [combat] damage that would be dealt to ~ / you this turn." | `prevent` (`'all'`) |
| "Prevent all [combat] damage that would be dealt this turn by <sources>." | `prevent` (`'all'`) |
| "Prevent the next N [combat] damage that would be dealt to ~ / you this turn." | `prevent` (numeric) |
| "[Combat] damage can't be prevented this turn." | `damage-cant-be-prevented` |
| "You gain life equal to the damage prevented this way." / "If damage is prevented this way, ~ deals that much damage to …" / "For each 1 damage prevented this way, put a <counter> counter on that creature." | `prevent-rider` |
| "As ~ enters, choose a basic land type[. Then you may pay N life. If you don't, it enters tapped]." | `choose-type` (+ the core `pay-life-or-tapped`) |

The built-in tables keep the three shapes they already own — "prevent all damage that would be dealt to **target**
… this turn", "prevent all combat damage that would be dealt this turn" (fog) and "prevent the next N damage that
would be dealt to **target** … this turn" — so those still produce the core `prevent-damage` op. That is the split
the `prevent-rider` limitation above comes from.

---

## 6. What this family does not express yet

* **Comeuppance and Honorable Passage** split the rider by the *kind* of the prevented source ("if damage from a
  creature source is prevented this way … if damage from a noncreature source …"). `PreventFollowUp` has one mode
  per shield, so those lines stay unparsed.
* **"Prevent the next N damage … divided as you choose"** (Awe Strike, Refraction Trap's recipient) — a single
  shield cannot be split across several recipients.
* **"If a player would begin an extra turn, that player skips that turn instead"** and **"Creatures entering don't
  cause abilities to trigger"** have no engine hook to replace (extra turns and trigger creation are core-only).
* **Player counters.** `Game.replaceCounters` is only reached for objects, so "if you would put one or more counters
  on a permanent **or player**" cannot double the player half.
* **"You can't lose the game / your opponents can't win the game."** State-based actions and `Game.eliminate` are
  core; `sba` can add an action but cannot veto one.
