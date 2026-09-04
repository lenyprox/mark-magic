VAULT DEMO
==========

Every Magic: The Gathering card in one local database, a rules engine that plays real
oracle text, an AI opponent that never peeks at hidden cards, and a web app to browse
cards, build decks and play with a live analysis panel.

QUICK START (Windows)
---------------------
1. If you do not have Node.js yet: double-click "Install Node.cmd" and let it finish.
   (It uses winget when available, otherwise downloads the official installer.)
2. Double-click "Start Vault Demo.cmd".
3. Your browser opens at http://localhost:3000 once the server is ready (10-20 seconds).
   Keep the black window open while you use the demo; close it to stop.

QUICK START (macOS / Linux)
---------------------------
1. Open a terminal in this folder.
2. ./install-node.sh        (skip if "node -v" already prints v20 or newer)
3. ./start-demo.sh
   The first start reinstalls the bundled dependencies for your machine (needs internet,
   about a minute) because this package was built on Windows. Ctrl+C stops the demo.

Both launchers accept a port as the first argument, e.g. "start-demo.sh 4000".

WHAT TO TRY
-----------
Cards   http://localhost:3000/cards
        Search like  t:legendary o:"draw a card"  or  n:bolt. Hover a card for the WebGL
        foil/relief render. Open a card for all its printings.
Decks   http://localhost:3000/decks
        Open a bundled deck or import your own (plain text, Arena or Moxfield format).
        Mana curve, colour pie, legality, and a badge showing which cards the engine
        simulates fully.
Play    http://localhost:3000/play
        Pick your deck and an opponent: a bundled deck, a real tournament list, or an
        archetype sampled from recent metagame data. The analysis panel gives win
        probability, risks and draw odds for every candidate play; each number expands
        into its formula and inputs.
Terminal client:  npm run play   (from this folder)

WHAT IS INCLUDED
----------------
- The full card database (about 1 GB, built from Scryfall bulk data) and search index.
- 482 recent tournament decklists (Modern, Legacy, Standard) synced on 2026-09-03,
  clustered into 43 archetypes.
- Four bundled sample decks and an image cache. Card images not in the cache are fetched
  from Scryfall on first view, so an internet connection makes browsing look better.
- Source code and tests (npm test, npm run typecheck:all). See README.md for the layout.

NOTES
-----
- A live metagame re-sync needs a free TopDeck.gg API key in a ".env.local" file (copy
  ".env.example"). The demo does not need one; the bundled decklists are used.
- The engine fully simulates about 48% of non-land main-deck cards in current Modern
  lists and about 60% in Legacy. Cards with unparsed clauses still play; those clauses
  are inert and flagged in the deck builder, the play log and the analysis panel.
- Everything runs locally. Nothing is uploaded anywhere.
