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
npm run play                         # the original terminal client
```

`/api/health` (and a banner on the landing page) reports which of these steps are still missing.

## What the app does

- **Cards** (`/cards`, `/cards/[id]`, `/sets`): full-text search (`o:` rules text, `t:` type, `n:` name), colour/type/set/rarity/format/mana-value/price filters in the URL, virtualised grid, quick-look dialog, printings carousel with live art swap. Every card is a `Card3D`: one shared WebGL2 context per layer draws the hovered/hero cards with a per-pixel relief derived from the card's own image (frame lines and art highlights become ridges), a foil iridescence that tracks the pointer, and an etched grating for etched printings. Static thumbnails upgrade to live rendering on hover, so a 100-card grid stays at 60 fps. Card images are fetched from Scryfall on first view and cached under `data/images/` (never hotlinked).
- **Decks** (`/decks`): builder with picker, groups by type/mana value/colour, printing picker per row, mana curve, colour pie, mana-source check, format legality, undo/redo, import (plain / Arena / Moxfield text) and export. Opponent decks can be imported from TopDeck.gg tournament lists or sampled from a clustered archetype.
- **Play** (`/play`): the engine and AI run in a Web Worker; the page only ever receives a redacted view. Targeting mode, attack/block declaration, stops per phase, log with engine notes. The **analysis panel** lists candidate plays with win probability (Monte Carlo, `n` and seed shown, re-runnable to verify), risks (counterspell / removal / sweeper / crack-back odds), "what could they have" (hypergeometric over the opponent's list or archetype card frequencies), draw odds and race clocks. Each estimate expands into its formula, inputs and steps.
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
src/user                 user.db (decks, games, caches, metagame tables)
src/play                 worker protocol, redacted ViewState, deck payloads, targeting state machine
src/images               Scryfall image cache
apps/web                 Next.js 16 app: app/ (routes + API), components/ (ui kit, card renderer, browse, detail,
                         deck, play, analysis, shell), lib/ (db singletons, gl renderer, stores), workers/
test/                    node:test suites (engine, parser, AI, analysis, meta, query, play)
decks/                   four bundled, fully simulated sample decks
```

## Development notes

- The engine (`src/`) is Node-ESM with `./x.js` imports and TypeScript 7; the web app uses TypeScript 5.9 with bundler resolution. Next.js must run in **webpack** mode (`next dev --webpack`, wired into `npm run dev`) because Turbopack cannot map those `.js` imports to `.ts` files.
- `npm test` runs every `test/*.test.ts` with `node:test` (about 90 tests, ~30 s; the DB-backed ones skip when `master.db` is absent). `npm run analysis:selftest` pins the hypergeometric values and Monte Carlo reproducibility. `npm run typecheck:all` checks both projects. `npm run test:e2e` runs the Playwright smoke (needs `npx playwright install chromium` once).
- `npm run web:index` drops and recreates its tables; do not run it while the app or tests are using `master.db`.
- Parser coverage of the whole pool is reported in `data/master/parser-coverage.json` (`npm run coverage:pool`; about 25% of playable cards fully simulated). Coverage against real tournament decklists (about 48% of non-land main-deck copies in Modern and 60% in Legacy) is in `data/master/meta-coverage.json` (`npm run coverage:meta`, after `npm run meta:sync` for each format; `--fixture test/fixtures/meta/topdeck-modern.json --format Modern` runs it offline). Cards with unparsed clauses still load with everything the parser understood; those clauses are inert and flagged in the deck builder, the play log and the analysis panel.

## Verifiable odds, briefly

- Hypergeometric estimates are computed exactly with BigInt combinations and list every `C(n, k)` used.
- Monte Carlo estimates use common random numbers across candidates (trial *i* uses `hashSeed(baseSeed, i)` for every candidate), report `n`, the seed and a Wilson 95% interval, and can be re-run from the panel; a re-run that reproduces the same win count is marked identical.
- Combat outcomes are exact enumerations of legal block assignments (menace-aware), degrading to "heuristic" only when truncated.
- The AI never reads hidden cards in the app: it receives a redacted state and averages over sampled completions; "AI may peek" is an explicit setting.
