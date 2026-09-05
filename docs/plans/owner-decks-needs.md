# Owner's decks — what the 178 unscripted cards need (measured 2026-09-05)

Measured on `main` bf20f51 with the repo's CSV collection reader over the six `decks/*.csv` Commander lists
(444 distinct cards; 178 not fully parsed; 317 unparsed oracle lines). The four `decks/*.txt` test decks add one
more card (wu-fliers). A regex heuristic tagged each unparsed line with the plan's Part 3 taxonomy; the 8k
classifier (`scripts:queue`) replaces this heuristic — treat the numbers as orientation, not accounting.

| Family (per plan Part 3) | Lines | Cards touching |
|---|---|---|
| generic composition (destroy/pump/counters/draw/tokens/damage/life/library/tap/mana) | 157 | 106 |
| named keywords (gift, backup, retrace, spree, prepared, station …) | 51 | 41 |
| unmatched by the heuristic (chosen colour, opening-hand leylines, "stations", "prepared" …) | 28 | 23 |
| copy / clone (copy spell, choose new targets) | 17 | 12 |
| control change / "you control gain … until end of turn" (heuristic over-tags this) | 11 | 11 |
| keyword actions (mill, discover, surveil …) | 9 | 9 |
| piles / choices / "choose one that hasn't been chosen" | 9 | 7 |
| replacement / prevention / "instead" | 8 | 5 |
| planeswalker loyalty abilities | 8 | 4 |
| cost alteration / free cast / "rather than pay" | 7 | 6 |
| combat restrictions | 5 | 5 |
| layers (base P/T, land becomes Swamp, becomes a creature) | 5 | 5 |
| transform / descend | 2 | 2 |

**Cards whose unparsed lines are all generic: 68** — these are what Phase 9.0 (composition core) should make
expressible on its own. Named keywords (9.2) are the next largest unlock for these decks; copy/clone,
planeswalkers, cost alteration and control (all 9.1 families) follow. 10.0's `needs.json` output decides the 9.1
order; this table is the prior.
