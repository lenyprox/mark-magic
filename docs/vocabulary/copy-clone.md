# Copy / clone (Phase 9.1)

Copies of permanents, copies of spells and abilities, permanents that *become* copies, permanents that *enter* as
copies, and the two clauses that move a spell's targets around. Engine: `src/engine/ops/copy-clone.ts`; zod:
`src/engine/ops/copy-clone.schema.ts`; parser wordings: `src/cards/rules/copy-clone.ts`; scenarios:
`test/scenarios/copy-clone.ts`. Rule numbers refer to the Comprehensive Rules bundled in `data/rules/cr.json`.

The core already had the two *unmodified* forms — `token-copy` ("create a token that's a copy of that creature") and
`copy-spell` ("copy target spell") — and this family is everything they cannot say: an "except …" clause, a copy
count, a `Ref` instead of a target spec, copies of **abilities**, a permanent-spell copy that becomes a token, and
retargeting. Nothing here replaces the core ops; a script that only needs the plain form should keep using them.

---

## 1. What a copy is (CR 707.2)

A copy takes the **copiable values** of what it copies: the printed characteristics of the card, as modified by other
copy effects and by "as it enters" choices — never counters, never `+N/+N`, never until-end-of-turn effects, never
damage, never who controls it. This family reads them off `defOf(o)`, and for a **token** off the token itself
(CR 111.4 / 707.2: a token's copiable values are the values the token was created with), then applies the exception.

Three representations, chosen so that every existing reader in the engine answers about the copy without a core
change:

| what is made | how it is represented |
|---|---|
| a **token copy** (`copy-permanent`) | a real object whose `def` is the derived `CardDef` and whose `token` `TokenSpec` mirrors it, with `grantedAbilities` = the copied abilities. `types` / `subtypes` / `colors` / power / toughness / `keywords` / `abilitiesOf` / the legend rule (`o.def.supertypes`) / toxic N (`o.def.toxic`) all read the copy |
| a **copy of a spell** (`copy-stack`) | a fresh stack item whose source is a fresh object flagged `token`. CR 707.10a falls out of that one flag: an instant/sorcery copy is sent to the graveyard by `finishSpell` and `moveTo`'s token branch makes it cease to exist; a **permanent**-spell copy goes through `enterBattlefield`, whose token branch puts it onto the battlefield as a token |
| a **copy of an ability** (`copy-stack`) | a fresh stack item with the **same source object** (CR 707.10: the copy has the same source), the same targets and the same modes |
| a permanent that **becomes**/**enters as** a copy (`become-copy`, `enter-as-copy`) | `Game.setCopyDef(o, derivedDef)` — the def rides on the object, so `clone` shares it and `serialize` carries it (CR 613.2: the copy is applied in layer 1) |

`ext` holds three JSON-plain markers and nothing else: `ccCopyUntilTurn` (the turn an until-end-of-turn
`become-copy` ends), `ccSpellCopy` (this stack object is a spell copy) and `ccCopies` (the ids of the copies the
resolving item just made, so the sentence after it can retarget them). All three are public information — the stack
and the battlefield are public zones — so the family registers no `redact` hook.

---

## 2. The "except …" clause (CR 707.9a)

Every copy op takes an optional `except`, and the fields split deliberately into **replacing** and **adding**, which
is exactly the distinction the cards print:

```ts
interface CopyException {
  power?: number; toughness?: number;   // "except it's a 4/4 …" / "except it's 1/1 and has toxic 1"
  colors?: Color[];                     // "except it's black" — the copy's colours are exactly these
  name?: string;
  types?: CardType[];                   // card types, replaced
  addTypes?: CardType[];                // "except it's an artifact IN ADDITION TO its other types"
  subtypes?: string[];                  // subtypes, replaced ("a 4/4 black Zombie" is a Zombie and nothing else)
  addSubtypes?: string[];               // "except it's a Spirit in addition to its other types"
  keywords?: Keyword[];                 // "except it has haste"  (always additive)
  toxic?: number;                       // the N of "has toxic N" (a keyword parameter, read off the def)
  notLegendary?: boolean;               // "except it isn't legendary" — the legend rule then leaves it alone
  loseAbilities?: boolean;              // "except it has no abilities"
  abilities?: Ability[];                // 'except it has "At the beginning of the end step, sacrifice this token."'
}
```

An `except` with no fields is a schema error (it changes nothing — drop it). The parser produces every field above
except `abilities`, `name` and `loseAbilities`; a printed exception that quotes an ability is left unparsed rather
than guessed at, because an effect rule is handed no trigger parser (see §6).

---

## 3. `copy-permanent` — "Create a token that's a copy of …"

```ts
{ op: 'copy-permanent';
  target: TargetSpec | Ref;                 // WHAT IS COPIED (a target chosen on cast, or the frame's binding)
  count?: Amount;                           // tokens per copied object (default 1)
  except?: CopyException;
  tapped?: boolean;
  attacking?: boolean | 'each-other-opponent' }
```

* `target` is the thing being copied — the same convention in every op of this family. A `TargetSpec` is a real
  target requirement (`legal.ts:ownTargetSpecs` finds it through the op's `target` field); a `Ref` reads the binding
  frame, so "Create a token that's a copy of it" after an `exile` copies what was exiled (CR 608.2h).
* Each token is created through `enterBattlefield` with `via: 'token'`, so the copied card's own as-enters
  replacements, ETB triggers, landfall and the legend rule all apply (CR 707.2).
* `attacking` puts the token into combat during the declare-attackers step; `'each-other-opponent'` spreads several
  tokens over the other opponents, the way myriad does.
* Binding: `those` / `that` = the tokens made, with the values they have now.
* A permanent whose controller has given it "can't be copied" (§7) is skipped with a log line; the spell still
  resolves, because that ability restricts the copy effect, not targeting.

```json
{ "op": "copy-permanent", "target": { "kind": "creature", "controller": "you" } }
```
```json
{ "op": "copy-permanent", "target": "that", "except": { "power": 4, "toughness": 4, "colors": ["B"], "subtypes": ["Zombie"] } }
```

---

## 4. `copy-stack` — "Copy target instant or sorcery spell" (CR 707.10)

```ts
{ op: 'copy-stack';
  target: TargetSpec | Ref;                 // the spell or ability copied
  count?: Amount;                           // "copy it twice" / "for each …" (default 1)
  newTargets?: 'may' }                      // "You may choose new targets for the copy" in the SAME sentence
```

* `target` may be a stack target spec (`spell`, `creature-spell`, `ability`, or this family's `spell-or-ability`) or
  a `Ref` that resolves to a spell's card — `'triggering'` for "Whenever you cast a spell …, copy that spell",
  `'that'` for a bound one.
* The copy is **created on the stack and is not cast** (CR 707.10): no cast triggers, no cost, no storm count. It
  keeps the original's targets, modes, X, kicker and `castFrom`, and its controller is the copy effect's controller.
* Copies are pushed in order, so they resolve **before** the original.
* `newTargets: 'may'` retargets each copy as it is made (CR 707.10c) — see §5 for how the choice is offered. The
  printed clause usually sits in its own sentence instead; the parser produces `change-targets` on `'the-copies'`
  for that, not this field.
* An object whose printed text says it can't be copied is skipped with a log line.

```json
{ "op": "copy-stack", "target": { "kind": "spell", "filter": { "types": ["Instant", "Sorcery"] } } }
```
```json
{ "op": "copy-stack", "target": "triggering", "count": { "count": "commander-casts" }, "newTargets": "may" }
```

---

## 5. `change-targets` — "You may choose new targets …" / "Change the target …" (CR 115.7)

```ts
{ op: 'change-targets';
  target: TargetSpec | 'the-copies';        // a stack object, or the copies this same item just made
  how: 'choose-new' | 'change-one';
  optional?: boolean }
```

* `how: 'choose-new'` (CR 115.7b) offers **every** target of the object; each may be changed or kept.
  `how: 'change-one'` is "Change the target of target spell or ability with a single target": the target **must**
  move, and only to another legal target — if none exists, nothing happens (CR 115.7c).
* Only legal targets are offered, checked against the requirement the pick answered and from the point of view of
  the **original** object's controller (CR 115.7b), and within one requirement the same object is never chosen twice
  (CR 115.3). A `multi` requirement is left alone: its parts are not interchangeable.
* `target: 'the-copies'` is the printed sentence "You may choose new targets for the copy", which always follows a
  `copy-stack` in the same ability. The `copy-stack` records what it made on its source, keyed by the resolving
  item, so a later resolution can never retarget a stale copy.
* **What a shipped agent answers.** The options are ordered so the first one is the play the card is bought for: for
  `change-one`, any legal target other than the current one, preferring one the chooser does not control; for
  `choose-new`, the current target *stays* first when it is already pointed away from the chooser and goes last when
  it is pointed at the chooser or at something they control. So "copy a bolt aimed at the opponent" keeps its
  target, and "redirect a bolt aimed at me" moves it. A UI or a search agent picks from the same list.
* `optional` asks a `may` decision first; the parser does not need it, because parse.ts already wraps a sentence
  beginning "You may …" in a `may` container.

```json
{ "op": "change-targets", "target": { "kind": "single-target-spell-or-ability" }, "how": "change-one" }
```
```json
{ "op": "change-targets", "target": "the-copies", "how": "choose-new" }
```

---

## 6. `become-copy` — "~ becomes a copy of target creature" (CR 706.2)

```ts
{ op: 'become-copy';
  target: TargetSpec | Ref;                 // what is copied
  becomes?: Ref;                            // which permanent becomes the copy (default 'self')
  duration: 'eot' | 'permanent';
  except?: CopyException }
```

* The copy is applied in **layer 1** (CR 613.2), so counters, `+N/+N`, anthems and until-end-of-turn effects all
  still apply on top of the copied printed values.
* `duration: 'eot'` ends in the cleanup step (CR 514.2); every copy ends when the permanent leaves the battlefield,
  because what comes back is a new object (CR 400.7).
* Nothing happens when the permanent that would become a copy is not on the battlefield, when it is the object being
  copied, or when the copied permanent says it can't be copied.
* Binding: `that` = the permanent that became a copy.

```json
{ "op": "become-copy", "target": { "kind": "creature" }, "duration": "eot" }
```
```json
{ "op": "become-copy", "target": "triggering", "becomes": "self", "duration": "permanent", "except": { "addSubtypes": ["Shapeshifter"] } }
```

---

## 7. `enter-as-copy` (as-enters) and `cant-be-copied` (static)

```ts
{ kind: 'enter-as-copy'; filter?: Filter; who?: 'you' | 'any'; optional?: boolean; except?: CopyException }
```

A **copy replacement effect** (CR 706.9): it is applied as the permanent enters, so a 0/0 Clone is never on the
battlefield as a 0/0 and never dies to the state-based action. `filter` defaults to `{ types: ['Creature'] }`;
`who: 'you'` is "a creature you control". `optional` is the printed "You may have ~ enter as …" — declining leaves
it as itself. The entering-tapped question is re-answered from the **copied** def, so a Clone of a permanent that
enters tapped enters tapped.

```json
{ "kind": "enter-as-copy", "filter": { "types": ["Creature"] }, "optional": true }
```
```json
{ "kind": "enter-as-copy", "filter": { "types": ["Artifact", "Creature"] }, "optional": true, "except": { "addTypes": ["Artifact"] } }
```

```ts
{ kind: 'cant-be-copied'; scope: 'self' | 'you-control'; filter?: Filter }
```

"~ can't be copied." Folded into the string-indexed `Mods.flags.cantBeCopied`, which `copy-permanent`,
`become-copy` and `enter-as-copy` consult; a spell on the stack is checked against its own printed statics instead,
because the layer pass only scans the battlefield.

```json
{ "kind": "cant-be-copied", "scope": "self" }
```
```json
{ "kind": "cant-be-copied", "scope": "you-control", "filter": { "types": ["Creature"], "subtypes": ["Zombie"] } }
```

---

## 8. Target kinds

| kind | offers |
|---|---|
| `spell-or-ability` | every spell and every activated / triggered ability on the stack. `filter` is matched against a **spell's** card ("instant spell, sorcery spell, activated ability, or triggered ability"); an ability has no card characteristics, so a filter never rejects one |
| `single-target-spell-or-ability` | the same, restricted to objects with exactly **one** target (CR 115.7) |
| `single-target-spell` | "target spell with a single target": spells only |

`controller: 'you'` / `'opponent'` restrict by the stack object's controller. A spell never offers *itself*: targets
are chosen before it is put on the stack (CR 601.2a-c), and at resolution it has already been popped.

---

## 9. Parser wordings (`src/cards/rules/copy-clone.ts`)

Consulted only after every built-in stage of `parse.ts` declined the text, so the built-in `token-copy` /
`copy-spell` templates keep every card they already claim.

| wording | op |
|---|---|
| "Create a token that's a copy of *target …*[, except *…*]" (also "N tokens", "a tapped token", and "a copy of it / that creature / those creatures / ~ / the exiled card") | `copy-permanent` |
| "Copy *target instant or sorcery spell* / *target spell* / *target creature spell* / *target permanent spell* / *target activated or triggered ability* / *target spell or ability*[ you control]", "copy it", "copy that spell" | `copy-stack` |
| "Change the target of *target spell / target spell or ability* with a single target" | `change-targets`, `how: 'change-one'` |
| "You may choose new targets for *target spell / target spell or ability*" | `may` around `change-targets`, `how: 'choose-new'` |
| "You may choose new targets for the copy / the copies / that copy" | `change-targets` on `'the-copies'` |
| "[You may have] ~ enters as a copy of *any creature on the battlefield* / *a creature you control* / *any artifact or creature on the battlefield*[, except *…*]" (a line rule: it is a replacement effect, not an ability) | `enter-as-copy` |
| "~ can't be copied" (a permanent's static line) | `cant-be-copied` |
| "except it's a 4/4 black Zombie", "except it's 1/1 and has toxic 1", "except it's a Spirit / an artifact in addition to its other types", "except it isn't legendary", "except it has haste", "except it has no abilities" | `CopyException` |

### Declines

A rule never claims what it cannot express: every word of a target phrase and of an "except …" clause is checked
against a known vocabulary (card types, colours, the pool's subtype list) before the lossy built-in filter parser
sees it, and one unknown word declines the whole sentence. A wrong copy is worse than an unparsed line, because it
silently plays a different card. Specifically declined:

* an exception that quotes an ability — `'except it has "When this token leaves the battlefield, …"'` (Hofri
  Ghostforge, Minion Reflector). An effect rule is handed no trigger parser. The op carries `except.abilities`, so a
  per-card script expresses those cards.
* "This spell can't be copied" on an instant or sorcery: an instant's lines never reach the static or line hooks
  (they go to the spell-text branch above them), so only a permanent's "~ can't be copied" is claimed.
* "Change the target of target activated ability with a single target" (Reroute): "with a single target" is only
  offered for a spell or for "spell or ability".
* target phrases with an "or" list ("target artifact or creature you control"), with a `non-<Subtype>` word, or with
  any word outside the vocabulary above.
* "copy *that spell* an additional time", "copy it for each …" as a printed sentence (the count phrase is not read),
  and every wording whose surrounding clause belongs to another family (`cost-alter`'s "you may cast the copy
  without paying its mana cost", `piles-choices`' "for each creature attacking you …").

---

## 10. Scenarios

`test/scenarios/copy-clone.ts` — one per op, per as-enters kind, per static, per target kind and per exception
field, each written so that it fails if the op did nothing. Real printed cards where the parser rules of this slice
make them parse (Cackling Counterpart, The Scarab God, Reverberate, Lithoform Engine, Swerve, Redirect, Untimely
Malfunction, Deflecting Swat, Clone); a scripted ability on Grizzly Bears for `become-copy` and `cant-be-copied`,
which no printed card parses into yet.
