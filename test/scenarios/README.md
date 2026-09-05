# Scenario DSL reference

This is the complete vocabulary for writing **behavioural scenarios**. A scenario is a small piece of data that
describes a board, a short script of actions and a list of expectations. The harness builds a real game from real
cards, runs the script through the public engine API and checks every expectation.

You are expected to write scenarios **blind**: from the card's printed text and the rules only. Do not read the
engine, the parser or the card scripts. That is the point — a scenario that was written from the implementation
tests the implementation against itself, a scenario written from the card text tests it against Magic.

Two homes, same vocabulary:

* **TypeScript suites** — `test/scenarios/<family>.ts`, exporting one `Scenario[]` (e.g. `basics.ts`,
  `mechanics.ts`, `keywords.ts`, `dsl-extras.ts`). Used for rules themes that span many cards.
* **JSON files** — `data/scenarios/<first two hex digits of the oracle id>/<oracle id>.json`, one file per card:

```json
{
  "oracleId": "4457ed35-7c10-48c8-9776-456485fdf070",
  "name": "Lightning Bolt",
  "scenarios": [ /* … */ ]
}
```

The JSON form is the one to use when you are writing scenarios for a specific card. Everything below is valid in
both; JSON just spells the same objects with quoted keys.

---

## 1. The shape of a scenario

```jsonc
{
  "name": "Lightning Bolt destroys a creature with 3 or less toughness",  // required, unique within the file
  "cr": "704.5g",                       // required: the rule this scenario pins
  "ruling": "Damage marked on a creature is compared with its toughness.", // optional prose, shown on failure
  "format": "freeform",                 // or "commander" (40 life, command zone, commander damage)
  "active": 0,                          // seat whose turn it is (default 0)
  "step": "main1",                      // starting step (default "main1")
  "turn": 5,                            // starting turn number (default 5)
  "seats": [ /* seat setup per player, at least one */ ],
  "script": [ /* what happens, in order */ ],
  "expect": [ /* what must be true at the end */ ]
}
```

Defaults you can rely on: it is **turn 5, seat 0's precombat main phase**, both players are at 20 life (40 in
commander), nothing has been played this turn, each library is 20 Mountains, and hands are empty apart from what
you put in them. Permanents you place are untapped, without summoning sickness and able to attack.

## 2. Seat setup

Each entry of `seats` is one player, seat 0 first. Every field is optional.

| field | meaning |
| --- | --- |
| `bf` | card names to put on the battlefield, untapped and ready to attack |
| `hand` | card names to put in hand |
| `graveyard` | card names to put in the graveyard |
| `exile` | card names to put in exile |
| `libraryTop` | card names to stack on top of the library, first entry drawn first |
| `command` | card names that start in the command zone (use with `"format": "commander"`) |
| `life` | starting life total (default 20, or 40 in commander) |
| `tapped` | names of permanents from `bf` that start tapped (list a name twice to tap two copies of it) |
| `counters` | `{ "Card Name": { "+1/+1": 2 } }` — counters on the first permanent of that name on this seat's `bf` |

```json
"seats": [
  { "bf": ["Mountain", "Mountain"], "hand": ["Lightning Bolt"] },
  { "bf": ["Grizzly Bears"], "life": 3 }
]
```

Cards are looked up **by exact printed name**, and every name is checked before the game starts:

* a name in `hand`, `bf`, `graveyard`, `exile`, `libraryTop` or `command` that is not a real card is an error
  (`scenario: seats[0].hand names Lightnng Bolt but there is no card of that name`) — it is never seeded silently;
* a name in `counters` or `tapped` must also be a permanent **this seat put on its own `bf`**, and `tapped` may not
  name more copies than `bf` holds. Otherwise the scenario would run a board it does not describe: the counters would
  land nowhere, the permanent would be untapped, and the run would pass while testing something else.

Give the seat enough untapped lands of the right colours to pay for everything the script casts — the engine taps them
for you, but it will not invent mana.

### `scripts`: a per-scenario card script (engine vocabulary suites only)

```json
"scripts": { "Grizzly Bears": { "abilities": [{ "kind": "activated", "cost": { "tap": true }, "effects": [ /* … */ ], "text": "…" }] } }
```

A script face (the same shape as a card script's front face: `abilities`, `keywords`, `altCosts`, …) applied to that
card **for this scenario only**, `"mode": "extend"` by default (the printed abilities stay and these are added) or
`"replace"`. It exists so the engine-vocabulary suites under `test/scenarios/` can exercise an op no printed card
parses into yet (the composition core landed before its parser rules). Every name must be a real card some seat
places. **A card's own corpus file must not script the card under test** — those scenarios test the card as printed,
and the validator refuses one that does.

## 3. Script steps

Steps run in order. `by` is a seat index and defaults to the player who currently has priority.

| step | meaning |
| --- | --- |
| `{ "cast": "Name" }` | cast the card from that seat's hand (or graveyard/exile/command, wherever it is) |
| `{ "cast": "Name", "targets": [["Grizzly Bears"], ["P1"]] }` | one group per targeting clause, in printed order; `"P0"`/`"P1"` are players, anything else is a card name (a card name that is on the stack targets the spell) |
| `{ "cast": "Name", "x": 3 }` | choose X |
| `{ "cast": "Name", "modes": [1] }` | choose modes by index (0 = first bullet) |
| `{ "cast": "Name", "alt": "morph" }` | pay an alternative cost: `pitch`, `life`, `evoke`, `warp`, `impending`, `flashback`, `escape`, `jump-start`, `from-graveyard`, `buyback`, `dash`, `morph` |
| `{ "cast": "Name", "by": 1 }` | seat 1 casts it (this is how you respond to a spell on the stack) |
| `{ "activate": "Name" }` | activate an ability of that permanent (or card in a graveyard, for unearth and friends) |
| `{ "activate": "Name", "ability": 1, "targets": [["P1"]] }` | pick the ability by index when a card has several |
| `{ "playLand": "Name" }` | play a land from hand |
| `{ "attack": ["Grizzly Bears", "Hill Giant"] }` | declare attackers and run the whole combat phase |
| `{ "attack": ["Hill Giant"], "blocks": [["Grizzly Bears", "Hill Giant"]] }` | …with blocks, as `[blocker, attacker]` pairs. Only the **defending seat** blocks (CR 509.1a): attackers go at the next seat still in the game after the active one, so in a three-player scenario with `"active": 1` the blockers are seat 2's. Every pair listed here **must** be accepted — if the engine turns one down the scenario fails with `block X → Y was not accepted by the engine (…)` rather than quietly running the unblocked attack |
| `{ "attack": ["Serra Angel"], "refused": [["Grizzly Bears", "Serra Angel"]] }` | the other half: pairs the engine **must** turn down. This is how evasion is tested — the block is really offered, and the scenario fails if it is ever accepted. Use `refused`, not a missing `blocks`, or the test degrades into "nobody blocked" |
| `{ "resolve": true }` | resolve the stack completely (both players pass) |
| `{ "sba": true }` | run state-based actions now |
| `{ "turnFaceUp": "Name" }` | turn a face-down (morph/megamorph/disguise) permanent face up |
| `{ "passUntil": "end" }` | run the game on to that step and stop there, with priority back on the active player, its turn-based actions done and its triggers on the stack but **not resolved** (put a `{ "resolve": true }` after it if you want them to). The step must still be ahead in this turn; if it is not, the next turn is played and the stop happens in *its* copy of that step, so `passUntil` always moves forward. Legal targets: every step except `untap`, in which nobody ever holds priority. If the active player is asked nothing at all in that step (an empty combat has no `declare-blockers`), the scenario fails rather than stopping somewhere else |
| `{ "turns": 2 }` | play out that many *complete* further turns — use this, not `passUntil`, when you only care that time passed |
| `{ "answer": true }` | queue one answer for the next choice the engine asks the player with priority (a yes/no, a colour like `"R"`, a mode list, a card choice) — put it *before* the step that asks |

Blocks always belong on the `attack` step; there is no separate block step. Combat runs to completion (damage,
triggers, end of combat) inside that one step.

Anything a scenario does not script is answered by a default agent: it passes priority, declines optional costs,
takes the first option, and picks `R` when asked for a colour. Use `answer` when the card needs a real choice.

## 4. Expectations

Every entry of `expect` is checked at the end of the script (after a final state-based-action pass). All of them
are checked, so one scenario reports every mismatch at once.

| expectation | example | meaning |
| --- | --- | --- |
| `zone` | `{ "zone": ["Grizzly Bears", "graveyard"] }` | the card is in that zone (`battlefield`, `graveyard`, `exile`, `hand`, `library`, `stack`, `command`) |
| `life` | `{ "life": [1, 17] }` | seat 1 is at 17 life |
| `pt` | `{ "pt": ["Grizzly Bears", 5, 5] }` | the creature's current power and toughness |
| `keywords` | `{ "keywords": ["Grizzly Bears", ["trample"]] }` | the permanent has all of those keywords |
| `counters` | `{ "counters": ["Grizzly Bears", { "+1/+1": 1, "-1/-1": 0 }] }` | counters on a permanent (a `0` asserts there are none) |
| `playerCounters` | `{ "playerCounters": [0, { "experience": 1 }] }` | counters on a *player* (`experience`, `rad`, and also `poison`/`energy`) |
| `tapped` | `{ "tapped": ["Mountain", true] }` | tapped or untapped |
| `control` | `{ "control": ["Grizzly Bears", 0] }` | which seat controls it |
| `attachedTo` | `{ "attachedTo": ["Rancor", "Grizzly Bears"] }` | the host an Aura/Equipment is attached to; `null` = attached to nothing |
| `faceDown` | `{ "faceDown": ["Ainok Survivalist", true] }` | the permanent is face down (CR 708) |
| `stack` | `{ "stack": 2 }` | number of objects on the stack |
| `stackNames` | `{ "stackNames": ["Counterspell", "Lightning Bolt"] }` | exactly these objects on the stack, **top first** |
| `zoneCount` | `{ "zoneCount": [1, "battlefield", 0] }` | how many objects a seat has in a zone (`stack` counts the items that seat controls) |
| `handCount` | `{ "handCount": [0, 2] }` | shorthand for the hand |
| `graveyardCount` | `{ "graveyardCount": [1, 1] }` | shorthand for the graveyard |
| `libraryCount` | `{ "libraryCount": [0, 18] }` | shorthand for the library (each starts at 20) |
| `mana` | `{ "mana": [0, "RW"] }` | unspent mana in a seat's pool, as a string of symbols (`W U B R G C`); order does not matter, `""` means empty |
| `commanderDamage` | `{ "commanderDamage": [1, "Ragavan, Nimble Pilferer", 3] }` | combat damage a seat has taken from that commander (CR 704.6c) |
| `events` | `{ "events": { "type": "damage", "min": 1, "max": 1 } }` | how many typed events fired (`damage`, `countered`, `fizzle`, `sba`, `zone-change`, `create-token`, `library`, `attack`, `block`, `replaced`, …) |
| `log` | `{ "log": "deals 3 damage" }` | some line of the game log matches this regular expression (a string is read as a regex *source*, so escape `/` and `+` as in `"as -1\\/-1 counters"`) |
| `noLog` | `{ "noLog": "Hill Giant is destroyed" }` | **no** log line matches — the way to assert something did not happen |
| `winner` | `{ "winner": 0 }` | the game has been won by that seat (`null` = nobody yet) |
| `unsimulated` | `{ "unsimulated": 0 }` | how many clauses the engine had to skip; `0` proves the card was fully simulated |
| `ext` | `{ "ext": ["Grizzly Bears", "suspended", true] }` | deep-equals one entry of a permanent's engine extension bag |

The log disambiguates permanents by object id — it prints `Hill Giant#43 is destroyed.` — which you cannot predict, so
every line is matched twice: as printed, and with the `#43` removed. `"Hill Giant is destroyed"` therefore means what
it says (and `"Hill Giant#\\d+ is destroyed"` works too). This matters most for `noLog`: a pattern that could never
match would pass no matter what happened, which is worse than having no expectation at all.

### Which object a name means

An expectation names a card, not a seat, so when the same name is on the table twice the harness has to choose. The
rule is one fixed search order, and the **first** match wins: seat 0 before seat 1 before seat 2, and within a seat
`battlefield`, `hand`, `graveyard`, `exile`, `library`, `command`, then the stack. That is why
`{ "zone": ["Lightning Bolt", "graveyard"] }` works after the spell resolved.

Three expectations deserve spelling out:

* **`attachedTo`** — `{ "attachedTo": ["Rancor", "Grizzly Bears"] }` finds the *first* Rancor in that order and reads
  the permanent it is attached to; the host is reported by name, and `null` means it is attached to nothing (which is
  also what a permanent that is not an Aura or Equipment reads as). With two Rancors in play, the expectation is about
  whichever the search reaches first — give the second one a different card if you need to tell them apart.
* **`faceDown`** — `{ "faceDown": ["Ainok Survivalist", true] }` uses the same first match. A face-down permanent
  still knows its real name here, so you name the card, not "Morph".
* **`commanderDamage`** — `{ "commanderDamage": [1, "Ragavan, Nimble Pilferer", 3] }` is read the other way round: the
  seat is the player who **took** the damage, and the commander is the object of that name that has actually dealt
  that seat commander damage, wherever it now is. Two opponents may command the same legend, and a seat's own
  commander never damages it, so the plain search order would find the wrong copy and read 0. When no commander of
  that name has damaged the seat, the first match in the order above is used, so `[i, "Name", 0]` still means
  "that seat has taken nothing from it".

## 5. Safe helper cards

These plain cards are fully simulated and safe to use as scenery. Prefer them over exotic ones so a failure is
about the card under test, not the props.

| card | what it is |
| --- | --- |
| Plains, Island, Swamp, Mountain, Forest | basic lands: `{T}`: add `{W}`/`{U}`/`{B}`/`{R}`/`{G}` |
| Grizzly Bears | `{1}{G}` 2/2 vanilla creature |
| Hill Giant | `{3}{R}` 3/3 vanilla creature |
| Lightning Bolt | `{R}` instant, 3 damage to any target |
| Shock | `{R}` instant, 2 damage to any target |
| Giant Growth | `{G}` instant, target creature gets +3/+3 until end of turn |
| Divination | `{2}{U}` sorcery, draw two cards |
| Counterspell | `{U}{U}` instant, counter target spell |

Three worked examples live in `data/scenarios/` for Lightning Bolt, Giant Growth and Counterspell — read those
before writing your first file.

## 6. Conventions

1. **Every scenario cites a rule.** `cr` is required; the runner rejects a file without it. Cite the rule the
   scenario actually pins (`704.5g` for lethal damage, `608.2b` for a fizzle), not a general one.
2. **One scenario per ability.** A card with three abilities gets three scenarios, each named after the ability
   it exercises. Do not test two unrelated abilities in one script — the failure then does not say which broke.
3. **Expectations must fail if the ability did nothing.** `{ "stack": 0 }` alone is not a test. Assert the change
   the ability makes: the life total, the zone, the counter, the P/T. Add a `noLog` for what must *not* happen and
   an `{ "unsimulated": 0 }` to prove nothing was skipped.
4. **Never weaken an expectation to make it pass.** If the run disagrees with the card, the scenario has found
   either an engine bug or a misreading of the rules. Report it; do not relax `pt` to whatever came out, do not
   delete the failing line, do not swap a `log` for a looser regex.
5. **Keep boards minimal.** Only the permanents the rule needs, plus exactly enough lands. A shorter board makes a
   failure readable and the scenario fast.
6. **Name the scenario after the behaviour**, in plain English, as a sentence a rules judge would recognise:
   "Giant Growth in response saves the creature from Lightning Bolt".
7. **Scenarios are data.** Do not import anything into a JSON file, do not depend on run order, and keep files at
   LF line endings.
8. **This page is the whole vocabulary.** Every key is checked against it before a scenario runs: an unknown or
   misspelled key (`"casts"`, `"lifee"`, a `"target"` where `"targets"` belongs), a value of the wrong shape, two
   step keywords in one entry — each is a hard error naming the entry, never a step that is quietly skipped or an
   expectation that is quietly not checked. If you need something the tables above do not offer, say so in the
   report; do not invent a key.

## 7. Running them

```bash
npm run verify:scenarios                       # every TS suite + every JSON file, sharded over the cores
npm run verify:scenarios -- --workers 1        # same results, one thread (use this when debugging)
npm run verify:scenarios -- --ids 4457ed35-7c10-48c8-9776-456485fdf070,cc187110-1148-4090-bbb8-e205694a39f5
npm run verify:scenarios -- --changed          # only the JSON files you have edited
npm run verify:scenarios -- --family keywords  # one TypeScript suite
npm run verify:scenarios -- --file data/scenarios/44/4457ed35-7c10-48c8-9776-456485fdf070.json
npm run verify:scenarios -- --limit 20         # the first 20 scenarios in report order (a smoke run)
npm run verify:scenarios -- --json data/master/verify-scenarios.json   # where the machine-readable report goes

npm run test:scenarios                         # only the TypeScript suites, through node --test
npm test                                       # the whole test suite, including a sample of the JSON corpus
```

Every value flag also takes the `--flag=value` spelling. The arguments are checked before anything runs, because a
mistyped flag that selects nothing and still exits 0 is the same lie as a scenario that asserts nothing:

* `--workers` and `--limit` must be a whole number of at least 1; anything else prints
  `--workers must be a whole number ≥ 1` and **exits 2**.
* an unknown flag, or a value flag with no value, also **exits 2**.
* `--family` with a name that is not a suite lists the suites that exist and **exits 2** — it never runs zero suites.
* `--changed` when nothing under `data/scenarios/` has been edited prints `no changed scenario files` and **exits 0**:
  asking for the files you changed and having changed none is a no-op, not a failure.
* a scenario that fails, or a corpus file that will not load, **exits 1**.

`npm test` runs a sample of the corpus, not all of it: every card in the owner's decks plus 200 more files drawn with
a fixed seed (`SAMPLE_SEED` in `src/verify/scenarioFiles.ts`), so the fast run stays fast, always covers the cards the
project is gated on, and spreads over the whole corpus instead of the alphabetically first shards. **A file that
passes the sample has not necessarily run** — always check your own card with `--file` or `--changed`.

The runner prints a pass/fail line per file, the five slowest scenarios and the wall time, and exits non-zero if
anything failed. Results are sorted by file then name, so the report does not depend on the worker count.
