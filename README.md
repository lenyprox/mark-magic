# mtg-master-sim

Two things in one repo:

1. **A master file of every Magic: The Gathering card**, built from Scryfall bulk data, normalised into JSONL + SQLite, and put through a 39-check audit (including an independent cross-check against MTGJSON). See [`data/master/README.md`](data/master/README.md).
2. **A rules engine and reactive AI opponent** you can play against from the terminal. The engine parses real oracle text into an effect AST; the AI simulates every legal action (and every way to target it) on a cloned game and explains what it is reacting to.

## Quick start

```bash
npm install
npm run data:all        # download Scryfall bulk data (~110 MB), build the master file (~40 s), run the audit
npm test                # engine / parser / AI tests
npm run play            # you (mono-red burn) vs the AI (mono-green stompy)
npm run play -- --deck decks/wu-fliers.txt --ai-deck decks/ub-control.txt --seed 11
npm run play -- --ai-vs-ai      # watch two AIs play, with their reasoning
npx tsx scripts/parser-coverage.ts   # how much of the whole card pool the engine fully simulates
```

Deck files are plain text (`4 Lightning Bolt`). Any card in the master file can be used; cards whose text the parser does not fully understand are flagged when the deck loads and their unsupported clauses are simply inert (shown in the log when they would apply). The four bundled decks are 100 % simulated.

## In-game commands

```
a            list what you can do right now, then type the number
play <name>  play a land          cast <name>   cast a spell        act <text>  activate an ability
<enter>      pass priority        b  board      h  hand      stack      c <name|#id>  read a card
```

The AI narrates its decisions, e.g. `[AI thinks] responds to Lightning Bolt with cast Giant Growth → Steel Leaf Champion#71 (eval 13.4 vs 9.2 if it resolves)`.

## What the engine implements

* Turn structure (untap, upkeep, draw, main, full combat with first-strike step, second main, end, cleanup), London mulligan, priority passing, the stack, APNAP trigger ordering, state-based actions (lethal damage, 0 toughness, deathtouch, 0 loyalty, legend rule, unattached auras, counter annihilation, life/poison/decking).
* Mana: pool, auto-tapping with colour solving (hybrid, Phyrexian, `{X}`), cost reduction statics, treasure.
* Combat: evasion (flying/reach, menace, fear, intimidate, skulk, unblockable, "can't be blocked by power ≥ N"), first/double strike, trample, deathtouch, lifelink, vigilance, protection, regeneration, damage prevention, summoning sickness, haste.
* Effects: damage (incl. divided and sweepers), destroy/exile/bounce (targeted and mass), counterspells (incl. "unless pays"), draw/discard/mill/loot/scry/surveil, life gain/loss, pump and keyword grants, tokens, +1/+1 and −1/−1 counters, tap/untap, sacrifice, fight/bite, land search, mana abilities, control change, extra turns, modal spells, kicker, cycling, equipment, auras, anthems, planeswalker loyalty abilities, ETB/dies/attack/upkeep/end-step/cast/landfall triggers, conditional statics (ferocious, metalcraft, threshold, …).
* Not implemented (cards using them load as partially simulated): most named keyword mechanics (Crew, Convoke, Flashback, Morph, Suspend, Storm, …), copy effects, replacement effects beyond prevention, planeswalker attacks, layer-perfect timestamps.

Parser coverage over the whole pool is reported in `data/master/parser-coverage.json`; at the time of writing 19 % of the 34.5 k playable oracle cards are fully simulated (including most vanilla/French-vanilla creatures, burn, removal, counters, pump, tokens, auras, equipment, mana creatures and lands), and every other card still loads with its keywords, P/T, cost and any clauses the parser did understand.

## Layout

```
scripts/fetch-bulk.mjs      download Scryfall bulk data + sets + catalogs (+ MTGJSON set list for the audit)
scripts/build-master.mjs    normalise every printing into JSONL + SQLite
scripts/audit-master.mjs    39-check audit -> data/master/audit.json, AUDIT.md
scripts/parser-coverage.ts  parser coverage report
src/cards/types.ts          card + ability AST
src/cards/parse.ts          oracle text -> AST
src/cards/db.ts             SQLite access, deck lists
src/engine/state.ts         game state types, decisions, agent interface
src/engine/characteristics.ts  P/T, keywords, filters, block legality (simplified CR 613 layers)
src/engine/mana.ts          mana sources + payment solver
src/engine/legal.ts         legal actions and targets
src/engine/game.ts          the rules engine
src/ai/ai.ts                evaluation, simulation, reactive AI
src/cli/play.ts             terminal client
test/engine.test.ts         tests
decks/                      four fully-simulated sample decks
```
