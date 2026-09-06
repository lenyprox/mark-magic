# combat restrictions and requirements (Phase 9.1, `combat-restr`)

The vocabulary for the lines that change **who may attack, who may block, and what a blocked attacker's damage
does**: "~ must be blocked if able", "All creatures able to block ~ do so", "~ can't be blocked except by three or
more creatures", "Creatures with power less than ~'s power can't block it", "~ can't block creatures with power 3 or
greater", "Enchanted creature can block only creatures with flying", "~ can't attack or block alone", "Creatures
without flying can't block this turn", "You may have ~ assign its combat damage as though it weren't blocked" and
"After this phase, there is an additional combat phase". 599 paper cards carry one of these lines.

| half | file |
|---|---|
| engine (statics, ops, combat hooks, renderers) | `src/engine/ops/combat-restr.ts` |
| zod variants a card script is validated against | `src/engine/ops/combat-restr.schema.ts` |
| oracle-text wordings | `src/cards/rules/combat-restr.ts` |
| behavioural scenarios | `test/scenarios/combat-restr.ts` |

Rule numbers refer to the Comprehensive Rules bundled in `data/rules/cr.json`.

---

## 1. The two halves of a combat declaration (CR 509.1)

The rules split everything here into two kinds of continuous effect, and the engine follows the split exactly:

| | what it says | when the engine can judge it | where it lives |
|---|---|---|---|
| **restriction** | a block (or an attack) that **may not** happen | some from the pair alone, some only from the whole declaration | `keywordHooks.canBlock` / `keywordHooks.canAttack`, and `keywordHooks.blockFixup` for the rest |
| **requirement** | a block that **must** happen if it can | only from the whole declaration | `keywordHooks.blockFixup` |

CR 509.1c is the rule that ties them together: the defending player's declaration must satisfy the **maximum
possible number of requirements** without violating a single restriction. `blockFixup` is one pass over a defending
player's declared blocks, run once per defending player by `Game.applyBlockFixups` right after the core's own menace
pass, and it works in that order:

1. **lure requirements** — every creature that can block a lured attacker is added to its blockers. A creature that
   is unable *only* because it already declared a block elsewhere is **moved**: blocking the lured attacker is a
   requirement and blocking anything else is not, so the move meets strictly more requirements (CR 509.1c). If the
   move turns out to be illegal the old blocks are put back. The whole requirement is skipped when fewer creatures
   are able to block the attacker than `leastBlockers` demands (below): it cannot be met legally, so it is not met.
2. **"must be blocked if able"** — blockers are added until the attacker has `leastBlockers` of them (one, unless a
   count restriction demands more), and the same move-a-blocker rule applies, idle creatures first: a creature is
   pulled off another attacker only when nothing idle can meet the requirement, and nothing is pulled at all when
   the requirement cannot be met legally.
3. **"blocks this turn if able"** — an idle creature carrying the marker is given the first attacker it can block
   **alone**; when there is no such attacker it is paired up on one it can block **together with partners**, and the
   partners (idle creatures first, one pulled off another attacker only when nothing idle is left) are added with it.
   CR 509.1c judges "able" over the whole declaration, not over one creature: "Grizzly Bears and Walking Corpse both
   block the menace attacker" meets one requirement and breaks no restriction, so it beats "nobody blocks", which
   meets none — even though neither creature could have done it on its own. Nothing is forced when the count cannot
   be reached at all. The partners are not themselves required to block, so their log line says
   `joins the forced block` rather than `blocks if able`.
4. **"except by N or more creatures"** — an attacker blocked by fewer than N creatures loses every block.
5. **"can't block alone"** — a creature that ended up as its controller's only blocker loses its block.

Steps 4 and 5 run last on purpose: a requirement is never met by breaking a restriction, so a forced block that turns
out illegal is thrown away again rather than kept.

### `leastBlockers`: menace is a CORE restriction this family has to count

`Game.applyBlockFixups` runs the core's own `menace` pass (CR 702.110b) **before** `BLOCK_FIXUPS` and never looks
again, so a block this family adds afterwards is unchecked by it. Every pass above therefore asks `leastBlockers`,
which is the larger of

* `2` when `chars.hasKeyword(s, attacker, 'menace')` — the core keyword, on ~1,400 printed cards, and
* the largest `least` among this family's own `cant-be-blocked-except-by` statics on that attacker,

and a requirement that cannot reach that count is left unmet (CR 509.1c: a requirement is never met by violating a
restriction) — while a requirement that CAN reach it is met with as many creatures as the restriction demands, which
for pass 3 means recruiting partners the requirement does not itself name. Lure on a menace creature with one able
blocker is therefore no block at all rather than an illegal one; with two able blockers, both block; and a
"blocks this turn if able" creature facing nothing but a menace attacker brings a partner along or blocks nothing.
The nine scenarios under "requirements weighed against menace" in `test/scenarios/combat-restr.ts` pin both
directions for all three requirement passes.

Every block the pass adds is a real declaration: it fires `blocks` and `becomes-blocked` triggers, because
`combatFrom` queues those *after* `applyBlockFixups`.

### Performance

`canBlock` runs once for every (blocker, attacker) pair of every simulated combat the AI plays out, so every static
in this family also folds a boolean into `Mods.flags` for the creature it speaks about. The pair hooks test that
memoised flag (one static pass, cached per battlefield generation) and only then scan the battlefield for the static
that set it. A board with none of these cards pays one property read per pair.

---

## 2. The scope every static carries

```ts
scope: 'self' | 'enchanted' | 'equipped' | 'filter'
filter?: Filter          // scope 'filter' only: which creatures the ability speaks about
side?: 'you' | 'opponents' | 'all'    // scope 'filter' only, relative to the permanent that carries it (default 'all')
```

* `self` — the permanent that carries the ability ("~ must be blocked if able").
* `enchanted` / `equipped` — whatever it is attached to ("Enchanted creature can block only creatures with flying").
  Both read `src.attachedTo`, so the wording of the card decides which one a script writes.
* `filter` — every creature matching `filter`, narrowed by `side` ("Cowards can't block Warriors", "Each creature
  you control with menace can't be blocked except by three or more creatures"). Neither the permanent that carries
  the ability nor its controller has to be involved.

---

## 3. The statics

### `must-be-blocked` — CR 509.1c

```ts
{ kind: 'must-be-blocked'; scope; filter?; side?; all?: boolean }
```

A blocking requirement about the creature the scope names. Without `all` one blocker satisfies it ("~ must be blocked
if able"); with `all: true` **every** creature that can block it must ("All creatures able to block ~ do so" — Lure,
Ochran Assassin, Nemesis Mask). A requirement can never force an illegal block: if the creature also carries
"except by N or more creatures", the pass adds N blockers or none.

```json
{ "kind": "static", "effect": { "kind": "must-be-blocked", "scope": "self" }, "text": "~ must be blocked if able." }
```
```json
{ "kind": "static", "effect": { "kind": "must-be-blocked", "scope": "enchanted", "all": true }, "text": "All creatures able to block enchanted creature do so." }
```

### `cant-be-blocked-except-by` — CR 509.1b

```ts
{ kind: 'cant-be-blocked-except-by'; scope; filter?; side?; by?: Filter; least?: number; power?: 'ge-source' }
```

A restriction on **who may block it**, in the three shapes the oracle prints:

* `by` — only creatures matching the filter may block it ("~ can't be blocked except by black creatures", "…
  except by creatures with flying", "… except by Walls"). Checked in `canBlock`.
* `least` — menace N: the attacker must be blocked by at least that many creatures at once, or by none
  ("~ can't be blocked except by three or more creatures"). Only a finished declaration can judge it, so it is
  applied in `blockFixup`; the core's own `menace` keyword is the N = 2 case and is unchanged.
* `power: 'ge-source'` — the blocker's power must be at least the attacker's, both read as blockers are declared
  ("Creatures with power less than ~'s power can't block it"). Checked in `canBlock`.

Several of them may sit on one card, and several statics may apply to one creature; every one of them must be
satisfied.

```json
{ "kind": "static", "effect": { "kind": "cant-be-blocked-except-by", "scope": "self", "least": 3 }, "text": "~ can't be blocked except by three or more creatures." }
```
```json
{ "kind": "static", "effect": { "kind": "cant-be-blocked-except-by", "scope": "filter", "filter": { "types": ["Creature"], "withKeyword": "menace" }, "side": "you", "least": 3 }, "text": "Each creature you control with menace can't be blocked except by three or more creatures." }
```

### `cant-be-blocked-by` — CR 509.1b

```ts
{ kind: 'cant-be-blocked-by'; scope; filter?; side?; by: Filter }
```

The complementary form: the creatures matching `by` are the ones that may **not** block it ("~ can't be blocked by
Walls", "Enchanted creature can't be blocked by artifact creatures", "~ can't be blocked by non-Wall creatures").
Checked in `canBlock`. Written as its own kind rather than as a negated `cant-be-blocked-except-by` because the two
compose differently when a creature carries both.

```json
{ "kind": "static", "effect": { "kind": "cant-be-blocked-by", "scope": "self", "by": { "subtypes": ["Wall"] } }, "text": "~ can't be blocked by Walls." }
```
```json
{ "kind": "static", "effect": { "kind": "cant-be-blocked-by", "scope": "enchanted", "by": { "types": ["Artifact", "Creature"], "typesAll": true } }, "text": "Enchanted creature can't be blocked by artifact creatures." }
```

### `cant-block-creatures` — CR 509.1b

```ts
{ kind: 'cant-block-creatures'; scope; filter?; side?; what?: Filter; only?: Filter; power?: 'gt-self' }
```

A restriction carried by the **blocker**, read against each attacker it is offered:

* `what` — it may not block an attacker matching the filter ("~ can't block creatures with power 3 or greater",
  "Cowards can't block Warriors", "~ can't block Humans").
* `only` — it may block **nothing but** attackers matching the filter ("Enchanted creature can block only creatures
  with flying"). The core's `blockOnlyFlying` flag is the one printed self-scope case and is unchanged.
* `power: 'gt-self'` — it may not block an attacker whose power is greater than its own ("~ can't block creatures
  with power greater than ~'s power" — Spitfire Handler). Both powers are read as blockers are declared, so a pump
  in response changes the answer.

```json
{ "kind": "static", "effect": { "kind": "cant-block-creatures", "scope": "self", "what": { "types": ["Creature"], "powerGE": 2 } }, "text": "~ can't block creatures with power 2 or greater." }
```
```json
{ "kind": "static", "effect": { "kind": "cant-block-creatures", "scope": "filter", "filter": { "subtypes": ["Coward"] }, "side": "all", "what": { "subtypes": ["Warrior"] } }, "text": "Cowards can't block Warriors." }
```

### `cant-act-alone` — CR 506.4 / 509.1b

```ts
{ kind: 'cant-act-alone'; scope; filter?; side?; attack?: boolean; block?: boolean }
```

`block: true` is exact: the creature loses its block when it ends up as its controller's only blocking creature
(applied in `blockFixup`, so it is judged over the whole declaration).

`attack: true` is a **partial** implementation, and deliberately so. The hook table has no seat for a fixup pass over
the declared attackers, so `canAttack` forbids the attack only in the case it can decide alone: no other creature its
controller controls could possibly attack. When another creature *could* have attacked but did not, the declaration
stands even though CR 506.4 makes it illegal: seat 0 with Mogg Flunkies and an untapped Hill Giant may attack with
the Flunkies alone (still true at this commit — a scratch scenario declaring exactly that deals 3 to the defending
player). Read `attack: true` as "enforced whenever the answer is knowable from this creature alone". The
`attackFixup` hook that closes it is a core change, handed over as a unified diff in `coreChangeNeeded` (see
Declines); it is not applied on this branch, which touches no file outside the family.

**The over-claim this leaves.** The clause parses, so the line counts as understood on 11 printed cards while only
half of its rule is enforced. All 11 are named here so a reader can check them by hand: *can't attack or block
alone* — Loyal Pegasus, Ember Beast, Wojek Bodyguard, Mogg Flunkies, Bonded Horncrest, Jackal Familiar (exact on
the block half, partial on the attack half); *can't attack alone* — Sightless Brawler, Trusty Companion, Raging
Kronch, Bonded Construct, Militia Rallier (partial, full stop). Nine of them are whole cards `applyScript` reports
as fully parsed; Wojek Bodyguard still has `Mentor` unparsed and Sightless Brawler `Bestow {4}{W}` and its
"Enchanted creature gets +3/+2 and can't attack alone" line, so they are not fully-parsed cards for other reasons.
The clause is kept parsed rather than dropped because the half that IS enforced is the half that decides the game
most often — a lone creature that would attack into an empty board never attacks — and an unparsed line enforces
nothing at all; the count is honest only as long as this paragraph is here.

```json
{ "kind": "static", "effect": { "kind": "cant-act-alone", "scope": "self", "attack": true, "block": true }, "text": "~ can't attack or block alone." }
```
```json
{ "kind": "static", "effect": { "kind": "cant-act-alone", "scope": "self", "attack": false, "block": true }, "text": "~ can't block alone." }
```

### `damage-as-though-unblocked` — CR 510.1a

```ts
{ kind: 'damage-as-though-unblocked'; scope; filter?; side? }
```

"You may have ~ assign its combat damage as though it weren't blocked" (Thorn Elemental, Spinebiter, Rhox). The
attacker is still blocked — its blockers deal their damage to it, and "whenever ~ becomes blocked" still triggered —
but every point it was about to assign to its blockers goes to the player or planeswalker it is attacking instead.
Applied in `keywordHooks.combatDamage`, after the core built the assignments and before they are dealt.

The printed "you may" is always taken: the hook is synchronous and cannot ask (Declines, below).

```json
{ "kind": "static", "effect": { "kind": "damage-as-though-unblocked", "scope": "self" }, "text": "You may have ~ assign its combat damage as though it weren't blocked." }
```
```json
{ "kind": "static", "effect": { "kind": "damage-as-though-unblocked", "scope": "equipped" }, "text": "You may have equipped creature assign its combat damage as though it weren't blocked." }
```

---

## 4. The ops

Each is a one-shot effect. The three that mark a permanent write a turn-stamped `ext` marker cleared by
`cleanupEot`, by `leave` (a permanent that leaves the battlefield is a new object, CR 400.7) and by the turn stamp
itself, so a mid-turn state an AI keeps around can never spend one on a later turn.

### `restrict-blocking` — "Creatures … can't block this turn"

```ts
{ op: 'restrict-blocking'; whose: 'all' | 'you' | 'opponents'; filter?: Filter; duration: 'eot' }
```

* `whose` is read from the player the effect resolved for: `you` = that player's creatures, `opponents` = everyone
  else's, `all` = every creature.
* `filter` is evaluated **when blockers are declared**, not when the effect resolves, so a creature that enters or
  loses flying later in the turn is judged as it is then. The ban is recorded once on `s.ext`, never per creature.
* Only `duration: 'eot'` exists; the entry is dropped at the cleanup step and at the start of every turn.

```json
{ "op": "restrict-blocking", "whose": "all", "filter": { "types": ["Creature"], "notKeywords": ["flying"] }, "duration": "eot" }
```
```json
{ "op": "restrict-blocking", "whose": "opponents", "filter": { "types": ["Creature"] }, "duration": "eot" }
```

### `cant-block-source` — "Target creature can't block ~ this turn"

```ts
{ op: 'cant-block-source'; target: TargetSpec | Ref; duration: 'eot' }
```

The restriction names **one attacker**: the source of the ability, recorded by object id, so it survives the source
changing controller or leaving. The targeted creature may still block anything else — which is what separates this op
from the core's blanket `cant-block`.

```json
{ "op": "cant-block-source", "target": { "kind": "creature" }, "duration": "eot" }
```
```json
{ "op": "cant-block-source", "target": "that", "duration": "eot" }
```

### `blocks-if-able` — "Target creature blocks this turn if able"

```ts
{ op: 'blocks-if-able'; target: TargetSpec | Ref; duration: 'eot' }
```

A requirement on the blocker: if it is untapped and can legally block something when blockers are declared, it must.
The engine gives it the first attacker it can legally block on its own, and failing that the first one it can block
with partners recruited to satisfy that attacker's "except by N or more" restriction (menace included) — "able" is a
property of the whole declaration, not of the creature (CR 509.1c). It blocks nothing only when no declaration
containing a block by it is legal.

```json
{ "op": "blocks-if-able", "target": { "kind": "creature" }, "duration": "eot" }
```
```json
{ "op": "blocks-if-able", "target": "those", "duration": "eot" }
```

### `lure` — "All creatures able to block target creature this turn do so"

```ts
{ op: 'lure'; target: TargetSpec | Ref; duration: 'eot' }
```

The one-shot twin of `must-be-blocked` with `all: true`, and it uses the same pass — including the move of a creature
that had declared a block elsewhere.

```json
{ "op": "lure", "target": { "kind": "creature" }, "duration": "eot" }
```
```json
{ "op": "lure", "target": { "kind": "creature", "controller": "you" }, "duration": "eot" }
```

### `extra-combat` — "After this phase, there is an additional combat phase" (CR 505.1, 506.1)

```ts
{ op: 'extra-combat' }
```

Bumps `s.ext.extraCombats`, which `Game.runTurnFrom` spends after the postcombat main phase: another combat phase
and then another main phase, exactly as the oracle's longer spelling ("… followed by an additional main phase")
describes. The counter belongs to the turn that granted it and the core clears it three times over — at the cleanup
step, at the start of every turn, and when the active player leaves the game mid-turn — so one nobody reached can
never be spent by another turn or by an AI clone of it.

```json
{ "op": "extra-combat" }
```
```json
[{ "op": "untap", "target": { "kind": "creature" } }, { "op": "extra-combat" }]
```

---

## 5. Parser wordings

`src/cards/rules/combat-restr.ts` registers **statics**, **effects** and one **line** rule. The line rule exists
because `parseStatic`'s built-in Aura branch matches the whole `enchanted <type> …` shape and returns `null` from
inside itself when none of its own templates fit, so a static rule is never offered "Enchanted creature can block
only creatures with flying" — the line hook just above the final `unknown(def, line)` is.

Filters are parsed by a small **closed** vocabulary (`creatureFilter`): colours and non-colours, `artifact` /
`enchantment` creatures, a subtype or `non-<Subtype>`, `with <keyword>` / `without <keyword>` from a fixed keyword
list, and `with power N or greater|less`. A word outside it makes the rule decline — these rules get no
`parseFilterWords` (a `StaticRule` is handed only the line and the card), and a lossy guess would silently change
which creatures a restriction reaches on hundreds of cards.

| wording | what it produces |
|---|---|
| `~ must be blocked if able` | `must-be-blocked` |
| `All creatures able to block ~ / enchanted creature / equipped creature do so` | `must-be-blocked` + `all` |
| `~ can't be blocked except by <N> or more creatures` | `cant-be-blocked-except-by` + `least` |
| `Each <filter> can't be blocked except by <N> or more creatures` | the same, `scope: 'filter'` |
| `~ can't be blocked except by <filter>` | `cant-be-blocked-except-by` + `by` |
| `Creatures with power less than ~'s power can't block it` | `cant-be-blocked-except-by` + `power: 'ge-source'` |
| `~ can't be blocked by <filter>` | `cant-be-blocked-by` |
| `~ can't block <filter>` / `<filter> can't block <filter>` | `cant-block-creatures` + `what` |
| `~ can block only <filter>` | `cant-block-creatures` + `only` |
| `~ can't block creatures with power greater than ~'s power` | `cant-block-creatures` + `power: 'gt-self'` |
| `~ can't attack alone` / `can't block alone` / `can't attack or block alone` | `cant-act-alone` |
| `You may have ~ assign its combat damage as though it weren't blocked` | `damage-as-though-unblocked` |
| `~ can't block and can't be blocked` | the CORE statics `self-keywords` (`unblockable`, `cantBlock`) — no family op |
| `Enchanted/Equipped creature <any of the above>` | the same statics with `scope: 'enchanted'` / `'equipped'` |
| `Creatures [without flying / your opponents control / …] can't block this turn` | `restrict-blocking` |
| `Target creature can't block ~ this turn` | `cant-block-source` |
| `Target creature blocks this turn if able` / `They block this turn if able` | `blocks-if-able` |
| `All creatures able to block target creature this turn do so` | `lure` |
| `After this [main] phase, there is an additional combat phase [followed by an additional main phase]` | `extra-combat` |

`npm run coverage:pool` moved from 12,200 to **12,317** fully parsed cards overall (35.35 % → 35.69 %) and from
12,065 to **12,182** on the paper tier (37.61 % → 37.97 %). `npm run parse:diff` reports `rulesHash f93a8a16 ->
d038db86`, `registryHash 811c9dc5 -> 904ba86c` and **205 changed, 0 added, 0 removed**, in 87 groups — every one of
them a wording in the table above. The count is large because those rows fan out over colours, subtypes and power
thresholds (`~ can't be blocked by <filter>` alone is 20 groups), and because every "creatures ... can't block this
turn" spell reaches `restrict-blocking` through a different sentence: behind a condition (Barrage of Boulders,
Demoralize), as a mode (Gruul Charm, Temur Charm), as an ETB trigger (Seismic Elemental, Mournwillow), as an attack
trigger (Hero of Oxid Ridge, Goblin Locksmith) and as a second sentence (Fire of Orthanc, Tectonic Rift).

Re-derived from `data/master/parse-snapshot.json` with parse-snapshot.ts's own canonical hash, over all 205:

| | cards |
|---|---|
| newly fully parsed | **117** |
| previously fully parsed that lost a parse | **0** |
| previously fully parsed whose shape changed | **0** |
| still incomplete, but an ability inside them now parses | 88 (21 with byte-identical unparsed lines) |

The 21 are the extra-combat attack triggers (Aurelia, the Warleader, Najeela, Karlach, ...): the family gave the
"After this phase ..." sentence a real op inside a line whose trigger head the parser still does not know. The +117
matches `coverage:pool`'s +117 exactly (the two totals differ by the 43 per-card scripts parse:diff ignores).

---

## 6. Declines — what this family deliberately does not express

Each of these needs a core change; none was made in the family's worktree.

* **"attacks each combat if able" other than on the creature itself.** `Game.combatFrom` builds its `mustAttack`
  list from `o.def.abilities`, so the core's own `self-keywords.mustAttack` covers the printed self case and nothing
  else. "Enchanted creature attacks each combat if able", "All creatures attack each combat if able" and "Target
  creature attacks this turn if able" would all work from a `Mods.flags.mustAttack` read at that site; the patch is
  in the wave's `coreChangeNeeded`. Until it lands there is no `must-attack` op here, because an op nothing enforces
  is worse than a clause a script author can see is missing.
* **"can't attack alone" in the partial case.** See `cant-act-alone` above: the declaration is only refused when no
  other creature could have attacked. The `attackFixup` patch handed over in `coreChangeNeeded` closes it — a
  `keywordHooks` seat handed the CHOSEN ATTACKER IDS (`Set<number>`) to mutate, called from `combatFrom` between the
  `attackers` decision and the loop that applies it, and from `simulateCombat` between its argument and the same
  loop. Both call sites run **before** anything is tapped, before the attack event is emitted and before an
  `attacks` trigger is queued, so a creature the hook removes leaves no trace at all and `Game` has nothing to undo.
  The family half is five lines (`chosen.size !== 1` is every legal declaration; otherwise drop the lone attacker
  and note it), and the scenario that pins it is in the patch. It is not in this commit, and no part of it is: the
  family contract forbids editing `src/engine/game.ts`, `types.ts` and the generated registry.
* **A family's zod variants reaching `CardScriptChecked`.** `src/engine/ops/combat-restr.schema.ts` is written and
  imported by nothing: `src/cards/schema.ts` has no composer yet, so `npm run typecheck:schema` fails on the
  `Equals<>` pins (declaration merging widened `Effect` and `StaticEffect`; the zod side could not follow) and the
  pool half of `test/schema-types.test.ts` rejects `{"op": "lure"}`. The composer is three hunks and is in
  `coreChangeNeeded`; with it applied, `typecheck:schema`, the whole 954-test suite and `scripts:check` are green.
  This file is already written for it: `z.lazy` forward references make the import cycle safe, and `as const
  satisfies FamilySchema` keeps each variant's own inferred type, which is what the `Equals<>` pins are made of.
* **"~ can attack as though it didn't have defender."** `canAttack` returns false on `defender` before the family
  fold runs, and the fold can only forbid, never allow. A static cannot remove a keyword either: `Mods` has no
  "keywords lost" term (only `ext.lost`, which one-shot ops write).
* **"Creatures can't attack you unless their controller pays {2} for each …"** (Propaganda, Ghostly Prison, Norn's
  Annex). The cost is part of declaring attackers (CR 508.1g); the only hook after that point is the
  `declare-attackers` step hook, which runs after the attack event was emitted and the `attacks` triggers were
  queued. Removing an attacker there would be visibly wrong, so nothing is emitted for it.
* **The "you may" of `damage-as-though-unblocked`.** `keywordHooks.combatDamage` is synchronous and cannot `ask`,
  so the choice is always taken. It is the right choice whenever the attacker would rather hit the player, which is
  the reason the card is played, but it is not a choice.
* **"That creature can't block this turn"** as the second sentence of a spell. `parseEffectSentence` rewrites a
  leading "that creature" to `~` unless the verb is one of `gains` / `gets` / `has base power` / `loses`, so the
  clause reaches a rule already pointing at the wrong object. Left unparsed rather than parsed wrongly.
* **"Target creature can't be blocked by Walls this turn"** (Tower of Coireall) and the other one-shot forms of the
  blocker-set restrictions. They need a fourth marker op; only a handful of cards print them.
* **Rendering a family STATIC.** `src/cards/render.ts` consults the registry's `RENDERERS` from `renderEffect`'s
  `default:` branch but not from `renderStatic`'s, so the static renderers this family exports (they are keyed by
  `kind` alongside the effect renderers keyed by `op`) are not reached yet. The two-line patch is in
  `coreChangeNeeded`; until then a family static renders as its kind in words.
