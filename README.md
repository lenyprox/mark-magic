# Vault — every Magic card, rendered, built and played

Three things in one repo:

1. **A master file of every Magic: The Gathering card** (Scryfall bulk data → JSONL + SQLite, 39-check audit with an MTGJSON cross-check). See [`data/master/README.md`](data/master/README.md).
2. **A rules engine and a reactive AI opponent** that parses real oracle text into an effect AST, plays a redacted (non-cheating) game over sampled worlds, and explains its decisions.
3. **A local web app (`apps/web`, Next.js 16)**: browse all 117k printings as WebGL foil/relief cards, build and persist decks, assemble opponent decks from live tournament data, and play the AI with a live analysis panel whose every number carries a derivation (exact hypergeometrics, seeded Monte Carlo with Wilson intervals, exact block enumeration).

## Quick start

```bash
npm install
npm run data:all        # Scryfall bulk download (~110 MB), master build (~40 s), audit
npm run web:index       # browse/search index inside master.db (~15 s)
npm run data:mana       # mana + set icon sprites (from Scryfall)
npm run dev             # http://localhost:3000  (webpack mode; see below)
```

Optional:

```bash
cp .env.example .env.local           # add TOPDECK_API_KEY (free at topdeck.gg) for live metagame data
npm run meta:sync -- --format Modern --days 30
npm run images:prefetch -- --deck decks/mono-red-burn.txt --sizes normal,large
npm run collection:import -- "decks/*.csv" --as-decks   # register your collection (count,name CSVs) and save each as a Commander deck
npm run sim:batch -- --deck mono-red-burn --deck "Varina" --games 500   # whole-game batch: win rates with intervals, reproducible by seed
npm run bench:games                  # games/s benchmark -> data/bench/latest.json
npm run play                         # the original terminal client
```

`/api/health` (and a banner on the landing page) reports which of these steps are still missing.

## What the app does

- **Cards** (`/cards`, `/cards/[id]`, `/sets`): full-text search (`o:` rules text, `t:` type, `n:` name), colour/type/set/rarity/format/mana-value/price filters in the URL, virtualised grid, quick-look dialog, printings carousel with live art swap. Every card is a `Card3D`: one shared WebGL2 context per layer draws the hovered/hero cards with a per-pixel relief derived from the card's own image (frame lines and art highlights become ridges), a foil iridescence that tracks the pointer, and an etched grating for etched printings. Static thumbnails upgrade to live rendering on hover, so a 100-card grid stays at 60 fps. Card images are fetched from Scryfall on first view and cached under `data/images/` (never hotlinked).
- **Decks** (`/decks`): builder with picker, groups by type/mana value/colour, printing picker per row, mana curve, colour pie, mana-source check, format legality, undo/redo, import (plain / Arena / Moxfield text) and export. Opponent decks can be imported from TopDeck.gg tournament lists or sampled from a clustered archetype.
- **Collection** (`/collection`): the cards you actually own, imported from `count,name` CSVs (one per deck), Moxfield/Archidekt exports or Arena lists; each file is a source that can be replaced or removed, and can also be registered as a Commander deck (the commander is guessed from the file name and can be changed in the builder). Ownership shows everywhere a card appears: an `×n` tag in the grid, an Owned column in the list, an "Owned only" filter (`?own=1`), a Collection row on the card page with +/- for cards you find in your bulk, per-row "not owned" hints and a coverage callout in the deck builder, and an "Owned" quick filter in the picker. `/collection?missing=<deckId>` lists what a deck still needs so you can search your bulk and tick cards off.
- **Play** (`/play`): drag a card from your hand onto the battlefield to play or cast it (a spell that needs targets waits in a casting slot with a tether until you drop it on the target), drag creatures up onto the opponent to attack and blockers onto attackers to block; illegal drops snap back with the rule that forbids them ("you already played a land this turn (CR 305.2)"). Every action is still reachable from the actions popover and the number keys. The engine and AI run in a Web Worker; the page only ever receives a redacted view. Targeting mode, attack/block declaration, stops per phase, log with engine notes. The **analysis panel** lists candidate plays with win probability (Monte Carlo, `n` and seed shown, re-runnable to verify), risks (counterspell / removal / sweeper / crack-back odds), "what could they have" (hypergeometric over the opponent's list or archetype card frequencies), draw odds and race clocks. Each estimate expands into its formula, inputs and steps.
- **Simulate** (deck page, `src/sim`): "Simulate N games vs deck X" plays whole games between the draft and any saved or bundled deck in the batch workers (one per spare core). Game *i* uses seed `hashSeed(baseSeed, i)` and a Latin seat rotation, so a run is reproducible and "Replay to verify" re-plays the same games and compares the win count. Results: win rate with a Wilson 95% interval, play/draw and seat splits, mulligan rate, commander cast-by-turn, draws at the turn limit, unsimulated-text hits, and the derivation. The same runner is `npm run sim:batch` on the command line (`--verify result.json` replays a saved run) and feeds the deck optimiser.
- **Optimise** (`/optimize`, `src/optimizer`): a seeded local search over single-card swaps of a saved deck, restricted to the cards you own (optionally plus popular unregistered cards in the commander's colour identity, flagged "check your bulk"). Every candidate is evaluated with whole games against a field of your other decks on paired seeds (game *i* always uses the same seed, seating and opponent); a child list inherits every parent game in which the swapped-out card was never seen, so a swap costs a fraction of a full batch. Swaps race on the first games of a block, survivors play the whole block, and a swap is accepted only when its paired gain clears a 95% interval; blocks rotate to avoid overfitting one set of shuffles. Runs execute in a detached worker process (`scripts/optimizer-daemon.ts`), heartbeat into `user.db`, checkpoint after every iteration and resume from the checkpoint. The report shows baseline vs best (paired), every swap tried with its interval, card contributions (with/without, correlational), opening-hand keep rates, winning patterns, coverage caveats and the bulk list; every number opens its derivation. `npm run optimize -- --deck A --field B [--preset quick|standard|deep]` is the CLI.
- **Metagame** (`src/meta`): TopDeck.gg official API (primary), opt-in polite MTGGoldfish scraper (`META_GOLDFISH_ENABLED=1`, 1 req/s, 24 h cache, robots.txt honoured), 17lands card ratings. Lists are normalised against the master DB and clustered into archetypes (TF-IDF + average-linkage) with per-card inclusion statistics.

## Layout

```
scripts/                 data pipeline: fetch-bulk, build-master, audit-master, build-web-index, build-mana-sprite,
                         prefetch-images, meta-sync, analysis-selftest, parser-coverage
src/cards                types, oracle-text parser, SQLite access (CardDB), web query layer (CardQueryDB)
src/engine               rules engine, legal actions, mana solver, characteristics, cloning/serialisation,
                         hidden-information view (redact), DeferredAgent
src/ai                   evaluation + search, combat search, the AiAgent (cheat: false = redacted + determinized)
src/analysis             hypergeometrics, determinization, rollout policy, Monte Carlo, block enumeration,
                         race math, card classification, "what could they have", analyzer, worker protocol + pool
src/meta                 metagame sources, normalisation, clustering, store, service, sync
src/user                 user.db (decks, games, caches, metagame tables, collection)
src/optimizer            deck optimiser: candidate pool/neighbours, paired evaluator with game reuse, racing search, insights, store, runner
src/collection           collection importer: RFC-4180 CSV reader, format detection, deck-name/commander inference, CollectionStore
src/play                 worker protocol, redacted ViewState, deck payloads, targeting state machine
src/sim                  batch game runner: MatchSpec/GameRecordLite types, seat rotation, instrumentation, worker
                         protocol + pool (browser Worker or Node worker_threads), CLI deck references
src/images               Scryfall image cache
apps/web                 Next.js 16 app: app/ (routes + API), components/ (ui kit, card renderer, browse, detail,
                         deck, play, analysis, shell), lib/ (db singletons, gl renderer, stores), workers/
test/                    node:test suites (engine, parser, AI, analysis, meta, query, play, collection, sim)
decks/                   four bundled, fully simulated sample decks (.txt) and the owner's Commander decks (.csv, the collection)
```

## Development notes

- **Commander.** `GameOptions.format: 'commander'` (the play worker and `sim:batch` switch it on whenever a deck has a commander): 40 life, commanders start in the command zone and are cast from it with the tax ({2} per earlier cast, CR 903.8), a commander that would go to the graveyard, exile, hand or library goes to the command zone instead (903.9a-b), 21 combat damage from one commander loses (704.6c), and the first mulligan is free in pods (103.5c). `src/decks/validate.ts` checks commander legality, partner pairs, colour identity, singleton and size (the deck builder's legality callout uses it). The command zone shows on the player plate; drag-and-drop from it arrives with the seats milestone.
- **Seats.** The engine plays two to four players (`new Game(decks[], agents[])`): priority goes around the table in turn order, triggers stack in APNAP order, attackers name a defending player each (`AttackDeclaration.targets`) and every defender is asked for blocks, a player who loses in a pod leaves the game with their permanents (CR 800.4a) and the last player standing wins. `src/engine/players.ts` (`alive`, `opponentsOf`, `primaryOpponent`, `nextInTurnOrder`, `apnapOrder`) replaces every "the opponent" assumption; `test/lint-nplayer.test.ts` keeps them out of the engine, AI, sim and play code. `npm run sim:batch` accepts three or four `--deck`s (turn limits scale with the seat count; a draw counts 1/n of a win). The table UI still shows two seats (the pod layout is a later milestone).
- The engine (`src/`) is Node-ESM with `./x.js` imports and TypeScript 7; the web app uses TypeScript 5.9 with bundler resolution. Next.js must run in **webpack** mode (`next dev --webpack`, wired into `npm run dev`) because Turbopack cannot map those `.js` imports to `.ts` files.
- `npm test` runs every `test/*.test.ts` with `node:test` (about 90 tests, ~30 s; the DB-backed ones skip when `master.db` is absent). `npm run analysis:selftest` pins the hypergeometric values and Monte Carlo reproducibility. `npm run typecheck:all` checks both projects. `npm run test:e2e` runs the Playwright smoke (needs `npx playwright install chromium` once).
- `npm run web:index` drops and recreates its tables; do not run it while the app or tests are using `master.db`.
- The collection lives in `user.db` (`collection_sources`, `collection_cards`, view `collection_owned`; migration 2). The web query layer attaches `user.db` read-only to the master connection so searches can join ownership (`CardQueryDB.attachUser`); `settings.collection_version` is bumped on every write and keys the search count cache. Re-importing an unchanged file is a no-op, a changed file replaces only its own source, and different files add up (a card in two decks is owned twice). `npm run collection:import -- <files> [--as-decks] [--dry-run] [--commander "file=Card"]` is the CLI; `POST /api/collection/import` the web route (`{ files, preview, asDecks, commanders }`, multipart or JSON, `bundled: true` reads `decks/*.csv`).
- **Events.** Every observable change in the engine goes through `Game.emit` (`src/engine/events.ts`: a typed `GameEvent` union with `seq/turn/step`, a CR citation and the log line it renders). `GameOptions.events` is `'counts'` by default (per-type tallies in `state.eventCounts`, no per-event allocation), `'full'` keeps the stream in `state.events` (the play worker uses it and ships redacted events with every decision/view message), `'none'` disables both. Mutations go through primitives (`moveTo`, `setTapped`, `addCounters`, `addMana`, `gainLife`/`loseLife`, `dealDamage`, `note`); `test/lint-direct-writes.test.ts` pins ceilings on direct writes in `game.ts` so the stream stays complete. `state.version` bumps on every event.
- **Scenarios.** `test/scenarios/*.ts` hold typed behavioural scenarios (board, script, expectations, CR citation) run by `npm run verify:scenarios` (`test/scenarios/dsl.ts` is the vocabulary: cast/activate/playLand/attack+block/resolve/sba, expect zone/life/pt/keywords/counters/tapped/control/events/log/unsimulated/winner).
- `npm run bench:games` plays 100 games between the bundled 60-card decks (and the first two saved Commander decks) single-threaded and writes `data/bench/latest.json`; it exits 1 below 20 games/s (8 for Commander). `npm run sim:batch` distributes games over `worker_threads` (`src/sim/nodeWorker.boot.mjs` registers tsx's loader inside each thread because loader hooks are not inherited).
- `npm run demo:pack` (after `npm run web:build`) zips a self-contained demo into `dist/`: source, `node_modules`, the production build, `master.db`, a clean copy of `user.db`, the image cache, and the launchers from `demo/` (`Start Vault Demo.cmd` / `start-demo.sh`, plus `Install Node.cmd` / `install-node.sh` and `README-DEMO.txt` for the recipient). Raw downloads, `.git` and `.env.local` are never included. The launchers also work from `demo/` inside the checkout.
- Parser coverage of the whole pool is reported in `data/master/parser-coverage.json` (`npm run coverage:pool`; about 25% of playable cards fully simulated). Coverage against real tournament decklists (about 48% of non-land main-deck copies in Modern and 60% in Legacy) is in `data/master/meta-coverage.json` (`npm run coverage:meta`, after `npm run meta:sync` for each format; `--fixture test/fixtures/meta/topdeck-modern.json --format Modern` runs it offline). Cards with unparsed clauses still load with everything the parser understood; those clauses are inert and flagged in the deck builder, the play log and the analysis panel.

## Verifiable odds, briefly

- Hypergeometric estimates are computed exactly with BigInt combinations and list every `C(n, k)` used.
- Monte Carlo estimates use common random numbers across candidates (trial *i* uses `hashSeed(baseSeed, i)` for every candidate), report `n`, the seed and a Wilson 95% interval, and can be re-run from the panel; a re-run that reproduces the same win count is marked identical.
- Combat outcomes are exact enumerations of legal block assignments (menace-aware), degrading to "heuristic" only when truncated.
- The AI never reads hidden cards in the app: it receives a redacted state and averages over sampled completions; "AI may peek" is an explicit setting.
