# Master card file

Built by `npm run data:all` from Scryfall bulk data. Files in this directory (git-ignored because of size):

| File | Contents |
|---|---|
| `printings.jsonl` | One line per printing: every card object Scryfall has (all sets, all layouts, tokens, emblems, art series, oversized, digital), one language per printing (English when it exists). |
| `oracle.jsonl` | One line per distinct card (oracle id), with Scryfall's representative printing, first-printed date, printing count, legalities and all rulings. |
| `master.db` | SQLite: `printings`, `oracle_cards`, `faces`, `rulings`, `legalities`, `sets`. Indexed by name, oracle id, set. |
| `summary.json` | Row counts, build time, source manifest (bulk file names, sizes, Scryfall update timestamps). |
| `audit.json`, `AUDIT.md` | Output of the audit (`npm run data:audit`): 39 checks with samples. |
| `parser-coverage.json` | How much of the card pool the simulator's oracle-text parser fully understands. |

## Schema (printing / oracle record)

```
id, oracle_id, name, lang, layout, released_at, set, set_name, set_type, collector_number, rarity,
mana_cost, mana_value, type_line, supertypes[], types[], subtypes[], oracle_text,
colors[], color_identity[], color_indicator[], produced_mana[],
power, toughness, loyalty, defense, hand_modifier, life_modifier,
keywords[], legalities{format: status}, games[], finishes[],
reserved, reprint, digital, promo, oversized, variation, full_art, textless, booster, promo_types[],
frame, frame_effects[], border_color, security_stamp, artist, artist_ids[], illustration_id,
flavor_text, flavor_name, watermark, image (URL), ids{multiverse[], mtgo, mtgo_foil, arena, tcgplayer, cardmarket},
edhrec_rank, penny_rank, prices{}, all_parts[], faces[{name, oracle_id, mana_cost, mana_value, type_line, oracle_text,
colors, color_indicator, power, toughness, loyalty, defense, flavor_text, artist, illustration_id, image, watermark}],
scryfall_uri
```

Oracle records additionally carry `first_printed`, `printing_count`, `representative_id`, `rulings[{source, published_at, comment}]`.
Multi-face cards (split, adventure, transform, modal DFC, flip, meld, prototype, battles) keep every face in `faces[]`;
top-level `mana_cost`, `power`, `toughness`, `loyalty`, `defense` fall back to the front face when Scryfall stores them only per face.

## What the audit checks

* **A. Integrity**: bulk file sizes vs. Scryfall's declared sizes, row counts, no duplicate ids.
* **B. Coverage**: every set in `/sets` is present; per-set counts vs. `card_count`; every printing maps to an oracle card and vice versa; independent cross-check of set codes and per-set counts against MTGJSON `SetList.json`.
* **C. Field validation over all oracle cards**: every mana symbol is known; mana value recomputed from the cost equals Scryfall's `cmc` under CR 202.3 / 709.4 / 712.8 / 715.4; colours match cost + colour indicator; colour identity ⊇ colours; card types, supertypes, subtypes and keywords are checked against Scryfall's catalogs; P/T formats; multi-face names; rarity and date vocabularies.
* **D. Ground truth**: Reserved List has exactly 571 cards; the Power Nine exist with Alpha printings; hand-verified values for a dozen well-known cards; Alpha release date; rulings all attach to known cards.

Remaining WARN items are documented in `AUDIT.md`; each is a genuine Scryfall quirk (Un-set types, acorn subtypes, Alchemy ability names tagged as keywords, meld back faces with no cost) rather than missing or corrupt data.

## Scope

"Every card" here means every card object Scryfall tracks in `default_cards`: 117,621 printings covering 38,630 distinct cards across 1,049 sets as of the build date. Non-English translations of cards that also have an English printing are not included (Scryfall's `all_cards` adds ~10× more rows but no new cards); the fetch script can be pointed at it if translations are needed.
