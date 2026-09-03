# Master File Audit

Audited 2026-09-03T06:27:55.840Z | printings 117621 | oracle cards 38630 | rulings 78949 | sets 1049

| ID | Status | Check | Count |
|---|---|---|---|
| A1 | PASS | Bulk file sizes matched Scryfall-declared compressed_size |  |
| A2 | PASS | Row counts: printings / oracle / rulings / sets loaded into SQLite |  |
| A3 | PASS | No duplicate printing ids | 0 |
| A4 | PASS | No duplicate oracle ids | 0 |
| B1 | PASS | Every Scryfall set with card_count>0 is present in the master | 0 |
| B2 | WARN | Per-set printing counts equal Scryfall set.card_count | 1 |
| B3 | PASS | No printings reference a set absent from /sets | 0 |
| B4 | PASS | Grand total vs sum of set.card_count |  |
| B5 | PASS | Every printing maps to a known oracle card | 0 |
| B6 | PASS | Every printing carries an oracle_id | 0 |
| B7 | PASS | Every oracle card has at least one printing | 0 |
| B8 | INFO | Language distribution (non-English rows are cards that were never printed in English) |  |
| B9 | INFO | Cross-check vs MTGJSON 5.3.0+20260902: set codes |  |
| B10 | PASS | Cross-check vs MTGJSON: per-set card counts (differences >10 listed) |  |
| C1 | PASS | Every mana symbol is a known pip | 0 |
| C2 | WARN | Mana value recomputed from mana cost equals Scryfall cmc (CR 202.3, 709.4, 712.8, 715.4) | 4 |
| C3 | PASS | Card colours agree with mana cost + colour indicator | 0 |
| C4 | PASS | Colour identity is a superset of colours (tokens excluded: Scryfall leaves token identity empty; Fallaji Wayfarer excluded per official ruling) | 0 |
| C5 | WARN | Card types are in the Scryfall card-types catalog (or known non-traditional types) | 21 |
| C6 | PASS | Supertypes are in the supertypes catalog | 0 |
| C7 | WARN | Subtypes are in the subtype catalogs | 108 |
| C8 | WARN | Keywords are in the keyword/ability-word catalogs | 581 |
| C9 | PASS | Power/toughness values parse | 0 |
| C10 | WARN | Non-vanilla, non-basic cards have oracle text | 5 |
| C11 | PASS | Multi-face card names equal "Face A // Face B" | 0 |
| C12 | PASS | Rarity vocabulary | 0 |
| C13 | PASS | Release dates are ISO dates | 0 |
| C14 | INFO | Layout distribution across oracle cards |  |
| C15 | INFO | Card type distribution |  |
| D1 | PASS | Reserved List size (Wizards list has 571 cards) | 571 |
| D2 | PASS | Power Nine present with Alpha (lea) printings |  |
| D3 | PASS | Spot checks of well-known cards against hand-verified values | 0 |
| D4 | PASS | Alpha released 1993-08-05 |  |
| D5 | INFO | Most recent sets in master (should be current/upcoming releases) |  |
| D6 | PASS | Every ruling attaches to a known oracle card | 0 |
| D7 | INFO | Legal-card counts per format |  |
| D8 | INFO | Distinct card names vs oracle ids (names repeat only for reprints with changed oracle ids, e.g. Un-set variants, tokens) |  |
| D9 | INFO | Printings whose only version is non-English (sample) | 2645 |
| E1 | INFO | Scope: default_cards = every card object Scryfall has, one language per printing; all_cards (every language) is ~10x larger and adds no new cards, only translations |  |

## Details

### A1 Bulk file sizes matched Scryfall-declared compressed_size — PASS
```json
{
 "files": {
  "oracle_cards": {
   "file": "oracle_cards.jsonl.gz",
   "bytes": 24533446,
   "updated_at": "2026-09-02T21:02:00.637+00:00",
   "source": "https://data.scryfall.io/oracle-cards/oracle-cards-20260902210200.jsonl.gz"
  },
  "default_cards": {
   "file": "default_cards.jsonl.gz",
   "bytes": 78052259,
   "updated_at": "2026-09-02T21:05:32.258+00:00",
   "source": "https://data.scryfall.io/default-cards/default-cards-20260902210532.jsonl.gz"
  },
  "rulings": {
   "file": "rulings.jsonl.gz",
   "bytes": 5366171,
   "updated_at": "2026-09-02T21:00:34.029+00:00",
   "source": "https://data.scryfall.io/rulings/rulings-20260902210034.jsonl.gz"
  },
  "sets": {
   "file": "sets.json",
   "count": 1049,
   "expected_cards": 117620
  },
  "catalogs": {
   "file": "catalogs.json",
   "keys": [
    "card-types",
    "supertypes",
    "creature-types",
    "planeswalker-types",
    "artifact-types",
    "enchantment-types",
    "land-types",
    "spell-types",
    "keyword-abilities",
    "keyword-actions",
    "ability-words",
    "battle-types"
   ]
  }
 }
}
```

### A2 Row counts: printings / oracle / rulings / sets loaded into SQLite — PASS
```json
{
 "printings": 117621,
 "oracle": 38630,
 "rulings": 78949,
 "sets": 1049
}
```

### A3 No duplicate printing ids — PASS
```json
{
 "count": 0
}
```

### A4 No duplicate oracle ids — PASS
```json
{
 "count": 0
}
```

### B1 Every Scryfall set with card_count>0 is present in the master — PASS
```json
{
 "count": 0
}
```

### B2 Per-set printing counts equal Scryfall set.card_count — WARN
```json
{
 "count": 1,
 "note": "Small deltas are expected: card_count on /sets is computed separately from bulk exports and both are refreshed on different schedules."
}
```
Samples:
```json
[
 {
  "code": "fra",
  "name": "Reality Fracture",
  "expected": 45,
  "have": 46,
  "delta": 1
 }
]
```

### B3 No printings reference a set absent from /sets — PASS
```json
{
 "count": 0
}
```

### B4 Grand total vs sum of set.card_count — PASS
```json
{
 "printings": 117621,
 "sum_of_set_counts": 117620,
 "delta": 1
}
```

### B5 Every printing maps to a known oracle card — PASS
```json
{
 "count": 0
}
```

### B6 Every printing carries an oracle_id — PASS
```json
{
 "count": 0
}
```

### B7 Every oracle card has at least one printing — PASS
```json
{
 "count": 0
}
```

### B8 Language distribution (non-English rows are cards that were never printed in English) — INFO
```json
{
 "langs": [
  {
   "lang": "en",
   "c": 114976
  },
  {
   "lang": "es",
   "c": 1207
  },
  {
   "lang": "ja",
   "c": 662
  },
  {
   "lang": "fr",
   "c": 430
  },
  {
   "lang": "it",
   "c": 194
  },
  {
   "lang": "zhs",
   "c": 62
  },
  {
   "lang": "ph",
   "c": 49
  },
  {
   "lang": "de",
   "c": 9
  },
  {
   "lang": "qya",
   "c": 7
  },
  {
   "lang": "ru",
   "c": 5
  },
  {
   "lang": "dw",
   "c": 5
  },
  {
   "lang": "zht",
   "c": 4
  },
  {
   "lang": "pt",
   "c": 3
  },
  {
   "lang": "grc",
   "c": 3
  },
  {
   "lang": "sa",
   "c": 1
  },
  {
   "lang": "la",
   "c": 1
  },
  {
   "lang": "ko",
   "c": 1
  },
  {
   "lang": "he",
   "c": 1
  },
  {
   "lang": "ar",
   "c": 1
  }
 ]
}
```

### B9 Cross-check vs MTGJSON 5.3.0+20260902: set codes — INFO
```json
{
 "mtgjson_sets": 869,
 "scryfall_sets": 1049,
 "only_in_mtgjson": [
  "dd3",
  "fwb",
  "mb1",
  "q01",
  "q02",
  "q03",
  "q04",
  "q05",
  "q08"
 ],
 "only_in_scryfall_count": 189,
 "only_in_scryfall_by_type": {
  "token": 189
 }
}
```
Samples:
```json
[
 {
  "code": "ttrk",
  "name": "Star Trek Tokens",
  "set_type": "token",
  "count": 1
 },
 {
  "code": "tfra",
  "name": "Reality Fracture Tokens",
  "set_type": "token",
  "count": 1
 },
 {
  "code": "thob",
  "name": "The Hobbit Tokens",
  "set_type": "token",
  "count": 15
 },
 {
  "code": "tmsh",
  "name": "Marvel Super Heroes Tokens",
  "set_type": "token",
  "count": 27
 },
 {
  "code": "tmsc",
  "name": "Marvel Super Heroes Commander Tokens",
  "set_type": "token",
  "count": 32
 },
 {
  "code": "tsos",
  "name": "Secrets of Strixhaven Tokens",
  "set_type": "token",
  "count": 14
 },
 {
  "code": "tsoc",
  "name": "Secrets of Strixhaven Commander Tokens",
  "set_type": "token",
  "count": 30
 },
 {
  "code": "ttmc",
  "name": "Teenage Mutant Ninja Turtles Eternal Tokens",
  "set_type": "token",
  "count": 31
 },
 {
  "code": "ttmt",
  "name": "Teenage Mutant Ninja Turtles Tokens",
  "set_type": "token",
  "count": 10
 },
 {
  "code": "tecc",
  "name": "Lorwyn Eclipsed Commander Tokens",
  "set_type": "token",
  "count": 13
 },
 {
  "code": "tecl",
  "name": "Lorwyn Eclipsed Tokens",
  "set_type": "token",
  "count": 13
 },
 {
  "code": "ttle",
  "name": "Avatar: The Last Airbender Eternal Tokens",
  "set_type": "token",
  "count": 2
 },
 {
  "code": "ttla",
  "name": "Avatar: The Last Airbender Tokens",
  "set_type": "token",
  "count": 22
 },
 {
  "code": "tspm",
  "name": "Marvel's Spider-Man Tokens",
  "set_type": "token",
  "count": 7
 },
 {
  "code": "teoe",
  "name": "Edge of Eternities Tokens",
  "set_type": "token",
  "count": 12
 }
]
```

### B10 Cross-check vs MTGJSON: per-set card counts (differences >10 listed) — PASS
```json
{
 "sets_compared": 860,
 "sets_differing": 73,
 "sets_differing_by_more_than_10": 12,
 "note": "MTGJSON counts tokens/promos/art-series differently from Scryfall; large deltas are almost always those."
}
```
Samples:
```json
[
 {
  "code": "plst",
  "name": "The List",
  "master": 5584,
  "mtgjson_totalSetSize": 5509,
  "mtgjson_baseSetSize": 5075
 },
 {
  "code": "sld",
  "name": "Secret Lair Drop",
  "master": 2754,
  "mtgjson_totalSetSize": 2686,
  "mtgjson_baseSetSize": 1
 },
 {
  "code": "snc",
  "name": "Streets of New Capenna",
  "master": 513,
  "mtgjson_totalSetSize": 469,
  "mtgjson_baseSetSize": 281
 },
 {
  "code": "hbg",
  "name": "Alchemy Horizons: Baldur's Gate",
  "master": 436,
  "mtgjson_totalSetSize": 408,
  "mtgjson_baseSetSize": 456
 },
 {
  "code": "afr",
  "name": "Adventures in the Forgotten Realms",
  "master": 424,
  "mtgjson_totalSetSize": 402,
  "mtgjson_baseSetSize": 281
 },
 {
  "code": "khm",
  "name": "Kaldheim",
  "master": 425,
  "mtgjson_totalSetSize": 407,
  "mtgjson_baseSetSize": 285
 },
 {
  "code": "dmu",
  "name": "Dominaria United",
  "master": 453,
  "mtgjson_totalSetSize": 436,
  "mtgjson_baseSetSize": 281
 },
 {
  "code": "neo",
  "name": "Kamigawa: Neon Dynasty",
  "master": 531,
  "mtgjson_totalSetSize": 514,
  "mtgjson_baseSetSize": 302
 },
 {
  "code": "znr",
  "name": "Zendikar Rising",
  "master": 407,
  "mtgjson_totalSetSize": 392,
  "mtgjson_baseSetSize": 280
 },
 {
  "code": "bro",
  "name": "The Brothers' War",
  "master": 399,
  "mtgjson_totalSetSize": 387,
  "mtgjson_baseSetSize": 287
 },
 {
  "code": "vow",
  "name": "Innistrad: Crimson Vow",
  "master": 423,
  "mtgjson_totalSetSize": 412,
  "mtgjson_baseSetSize": 277
 },
 {
  "code": "wc99",
  "name": "World Championship Decks 1999",
  "master": 111,
  "mtgjson_totalSetSize": 100,
  "mtgjson_baseSetSize": 111
 }
]
```

### C1 Every mana symbol is a known pip — PASS
```json
{
 "count": 0
}
```

### C2 Mana value recomputed from mana cost equals Scryfall cmc (CR 202.3, 709.4, 712.8, 715.4) — WARN
```json
{
 "count": 4,
 "note": "Remaining: B.F.M. (two-card Un-set creature, MV 15 by ruling), Un-set/playtest oddities, and adventure cards whose adventure face is the more expensive half."
}
```
Samples:
```json
[
 {
  "name": "The Faction Dragon",
  "layout": "normal",
  "scryfall_cmc": 3,
  "computed": 0
 },
 {
  "name": "Land Station",
  "layout": "normal",
  "scryfall_cmc": 3,
  "computed": 2
 },
 {
  "name": "Keeper of the Crown // Coronation of the Wilds",
  "layout": "adventure",
  "scryfall_cmc": 3,
  "computed": 2
 },
 {
  "name": "B.F.M. (Big Furry Monster)",
  "layout": "normal",
  "scryfall_cmc": 15,
  "computed": 0
 }
]
```

### C3 Card colours agree with mana cost + colour indicator — PASS
```json
{
 "count": 0
}
```

### C4 Colour identity is a superset of colours (tokens excluded: Scryfall leaves token identity empty; Fallaji Wayfarer excluded per official ruling) — PASS
```json
{
 "count": 0
}
```

### C5 Card types are in the Scryfall card-types catalog (or known non-traditional types) — WARN
```json
{
 "count": 21,
 "unique": {
  "Dragon": 3,
  "Elemental": 1,
  "Licid": 1,
  "Legend": 1,
  "instant": 1,
  "Knights": 1,
  "Phenome-nom": 1,
  "Universewalker": 1,
  "Jaguar": 1,
  "pLAnE": 1,
  "Tribal": 2,
  "Goblin": 1,
  "Scariest": 1,
  "You'll": 1,
  "Ever": 1,
  "See": 1,
  "Poly": 1,
  "Wolf": 1
 },
 "note": "Remaining hits are pre-Oracle \"Summon X\" printings (playtest/promo curiosities), Un-set jokes and Mystery Booster playtest cards; all are genuine Scryfall type lines."
}
```
Samples:
```json
[
 {
  "name": "Prismatic Dragon",
  "type": "Dragon",
  "type_line": "Summon Dragon"
 },
 {
  "name": "Trial and Error",
  "type": "Elemental",
  "type_line": "Elemental Instant — Fire"
 },
 {
  "name": "Shichifukujin Dragon",
  "type": "Dragon",
  "type_line": "Summon Dragon"
 },
 {
  "name": "Flanking Licid",
  "type": "Licid",
  "type_line": "Summon Licid"
 },
 {
  "name": "1996 World Champion",
  "type": "Legend",
  "type_line": "Summon Legend"
 },
 {
  "name": "Faerie Dragon",
  "type": "Dragon",
  "type_line": "Summon Dragon"
 },
 {
  "name": "capital offense",
  "type": "instant",
  "type_line": "instant"
 },
 {
  "name": "Rainbow Knights",
  "type": "Knights",
  "type_line": "Summon Knights"
 },
 {
  "name": "That's Enough Slices",
  "type": "Phenome-nom",
  "type_line": "Phenome-nom"
 },
 {
  "name": "Byode, Inverse Sun",
  "type": "Universewalker",
  "type_line": "Legendary Universewalker — Byode"
 },
 {
  "name": "Aswan Jaguar",
  "type": "Jaguar",
  "type_line": "Summon Jaguar"
 },
 {
  "name": "sAnS mERcY",
  "type": "pLAnE",
  "type_line": "pLAnE — sECreT LaIR"
 },
 {
  "name": "Sarah's Wings",
  "type": "Tribal",
  "type_line": "Tribal Instant — Angel"
 },
 {
  "name": "Goblin Polka Band",
  "type": "Goblin",
  "type_line": "Summon Goblin"
 },
 {
  "name": "B.F.M. (Big Furry Monster)",
  "type": "Scariest",
  "type_line": "Scariest Creature You'll Ever See"
 }
]
```

### C6 Supertypes are in the supertypes catalog — PASS
```json
{
 "count": 0,
 "unique": {}
}
```

### C7 Subtypes are in the subtype catalogs — WARN
```json
{
 "count": 108,
 "unique": {
  "Cow": 3,
  "Cyborg": 18,
  "Clamfolk": 4,
  "Townsfolk": 2,
  "Vampyre": 1,
  "Waiter": 1,
  "Spuzzem": 1,
  "Athlete": 5,
  "Omenpath": 1,
  "Ship": 1,
  "Fire": 1,
  "Judge": 2,
  "Vibranium": 1,
  "Killbot": 4,
  "Paratrooper": 1,
  "Human?": 1,
  "Autobot": 2,
  "Chef": 2,
  "Mutagen": 1,
  "Barnyard": 1,
  "Artist": 3,
  "Tree": 1,
  "Lady": 1,
  "Proper": 1,
  "Etiquette": 1,
  "Donkey": 6,
  "Zonian": 1,
  "Realm": 1,
  "Bureaucrat": 2,
  "Hatificer": 2,
  "Mummy": 1,
  "Wrestler": 1,
  "Pony": 2,
  "Art": 1,
  "Mime": 2,
  "Quest": 1,
  "The": 1,
  "Biggest,": 1,
  "Baddest,": 1,
  "Nastiest,": 1,
  "Control": 2,
  "Point": 2,
  "Cephalid": 1,
  "Key": 1,
  "Koala": 1,
  "Lander": 2,
  "Elemental?": 1,
  "Hawk": 1,
  "Champion": 1,
  "Armored": 1,
  "Mammoth": 1,
  "Chameleon": 1,
  "Ulamog's": 1,
  "Deer": 1,
  "Boxer": 1,
  "Grandchild": 1,
  "Gus": 1,
  "Alicorn": 2,
  "Elves": 1,
  "Designer": 1
 },
 "note": "Scryfall catalogs cover sanctioned (black-border) types only; remaining hits are acorn/Un-set and playtest subtypes."
}
```
Samples:
```json
[
 {
  "name": "Dairy Cow",
  "subtype": "Cow",
  "type_line": "Creature — Cow"
 },
 {
  "name": "Aerial Toastmaster",
  "subtype": "Cyborg",
  "type_line": "Artifact Creature — Cyborg Rigger"
 },
 {
  "name": "Rules Lawyer",
  "subtype": "Cyborg",
  "type_line": "Artifact Creature — Cyborg Advisor"
 },
 {
  "name": "Clambassadors",
  "subtype": "Clamfolk",
  "type_line": "Creature — Clamfolk"
 },
 {
  "name": "Bosom Buddy",
  "subtype": "Townsfolk",
  "type_line": "Creature — Elephant Townsfolk"
 },
 {
  "name": "Old-Fashioned Vampire",
  "subtype": "Vampyre",
  "type_line": "Creature — Vampyre"
 },
 {
  "name": "Mons's Goblin Waiters",
  "subtype": "Waiter",
  "type_line": "Creature — Goblin Waiter"
 },
 {
  "name": "Spuzzem Strategist",
  "subtype": "Spuzzem",
  "type_line": "Creature — Spuzzem Advisor"
 },
 {
  "name": "Terry Pin, Turboturtle",
  "subtype": "Athlete",
  "type_line": "Legendary Creature — Turtle Athlete"
 },
 {
  "name": "Omenpath to Naya",
  "subtype": "Omenpath",
  "type_line": "Land — Omenpath"
 },
 {
  "name": "Toy Boat",
  "subtype": "Ship",
  "type_line": "Artifact Creature — Ship"
 },
 {
  "name": "Knight of the Widget",
  "subtype": "Cyborg",
  "type_line": "Artifact Creature — Cyborg Knight"
 },
 {
  "name": "Trial and Error",
  "subtype": "Fire",
  "type_line": "Elemental Instant — Fire"
 },
 {
  "name": "The Policy Maker",
  "subtype": "Judge",
  "type_line": "Legendary Creature — Human Judge"
 },
 {
  "name": "Knight of the Kitchen Sink",
  "subtype": "Cyborg",
  "type_line": "Artifact Creature — Cyborg Knight"
 }
]
```

### C8 Keywords are in the keyword/ability-word catalogs — WARN
```json
{
 "count": 581,
 "unique": {
  "Animal May-Ham": 1,
  "Shrieking Gargoyles": 1,
  "Phalanx Commander": 1,
  "Rulebreaker": 12,
  "Feed": 1,
  "Friends": 1,
  "Starfall": 1,
  "Crash Landing": 2,
  "Medicus Ministorum": 1,
  "Combine Powers!": 1,
  "Defense!": 1,
  "Sonic Booster": 1,
  "Blow Up": 1,
  "Disarm": 1,
  "Detonate": 1,
  "Avoidance": 1,
  "Chaos Control": 1,
  "The Allagan Eye": 1,
  "Mama's Coming": 1,
  "Alluring Eyes": 1,
  "A Test of Your Reflexes!": 1,
  "History Teacher": 1,
  "Keen Sight": 1,
  "Scavenge the Dead": 1,
  "The Most Important Punch in History": 1,
  "Wild Shape": 1,
  "Secrets of the Soul": 1,
  "Golden Rule": 1,
  "Leap Strike": 1,
  "Rope Dart": 1,
  "Synapse Creature": 1,
  "Top of the Food Chain": 1,
  "Rites of Banishment": 1,
  "Nosh": 1,
  "Share": 1,
  "Sensational Save": 1,
  "Take 59 Flights of Stairs": 1,
  "Take the Elevator": 1,
  "The Last Centurion": 1,
  "Wild Card": 1,
  "From the Future": 1,
  "ED-E My Love": 1,
  "Targeting Relay": 1,
  "Pray": 1,
  "Sonic Attack": 1,
  "Sec": 1,
  "Caan": 1,
  "Jast": 1,
  "Thay": 1,
  "Sorcerous Elixir": 1,
  "Check Map": 1,
  "Pick a Perk": 1,
  "Sort Inventory": 1,
  "Prismatic Gallery": 1,
  "Horrific Symbiosis": 1,
  "Sonic Blaster": 1,
  "Beeeeeeep, Beeeeeeep, Beeeeeeep": 1,
  "Eternity Gate": 1,
  "Tunnel Snakes Rule!": 1,
  "Sense the Good": 1,
  "Blood Chalice": 1,
  "Midnight Entity": 1,
  "Rapacious Hunger": 1,
  "Devouring Monster": 1,
  "Gather Your Courage": 1,
  "Run and Hide": 1,
  "Field Reprogramming": 1,
  "Allons-y!": 1,
  "Timey-Wimey": 1,
  "Symphony of Pain": 1,
  "Parallel Universe": 1,
  "Martyrdom": 1,
  "Mantle of Inspiration": 1,
  "Science": 1,
  "Cosplay": 1,
  "Trance": 2,
  "Two-Headed Coin": 1,
  "Gatling Blaster": 1,
  "Void Shields": 1,
  "Distract the Horde": 1,
  "Ceremorphosis": 1,
  "Neurotraumal Rod": 1,
  "Relentless March": 1,
  "Rule Zero": 1,
  "Play Games": 1,
  "See a Show": 1,
  "Buffet": 1,
  "Go to Sleep": 2,
  "Blessing of Light": 1,
  "Puff Piece": 1,
  "Investigative Journalism": 1,
  "It's Probably Nothing": 1,
  "That Could Actually Be Dangerous": 1,
  "Bad Wolf": 1,
  "Frenzied Rampage": 1,
  "Sketch and Lore": 1,
  "Wave Cannon": 1,
  "Lucky Slots": 1,
  "Jump": 16,
  "No Mercy": 1,
  "Berzerker": 1,
  "Sigil of Corruption": 1,
  "The Betrayer": 1,
  "Lord of the Pyrrhian Legions": 1,
  "Density Control": 1,
  "Technopathy": 1,
  "Solar Beam": 1,
  "Science Teacher": 1,
  "Bigby's Hand": 1,
  "Gift of Tiamat": 1,
  "Street Justice": 1,
  "Legal Justice": 1,
  "Sleight of Hand": 1,
  "Prince of Chaos": 1,
  "Lord of Torment": 1,
  "Team TARDIS": 1,
  "Low Gravity": 1,
  "Fear Gas": 1,
  "Seismic Takedown": 1,
  "Flare Star": 1,
  "Origami-Fu": 1,
  "Coruscating Flames": 1,
  "Echo of the Lost": 1,
  "Crushing Teeth": 1,
  "Chainsword": 1,
  "Immune": 1,
  "Vanguard Species": 1,
  "Sage Project": 1,
  "Pheromone Trail": 1,
  "Negative": 1,
  "Affirmative": 1,
  "Meet in Reverse": 1,
  "Spoilers": 1,
  "Insatiable Hunger": 1,
  "Polymorphine": 1,
  "Phaeron": 1,
  "Grand Strategist": 1,
  "Patrol Night": 1,
  "Date Night": 1,
  "Shiva's Aid": 1,
  "Synaptic Disintegrator": 1,
  "Heavy Power Hammer": 1,
  "Leap of Faith": 1,
  "Allure of Slaanesh": 1,
  "Smear Campaign": 1,
  "Gust of Wind": 1,
  "Lizard Formula": 1,
  "Mine Vibranium": 1,
  "Survey the Realm": 1,
  "Time Lord's Prerogative": 1,
  "Dragonfire Dive": 1,
  "Conjure Elemental": 1,
  "Inquisition Agents": 1,
  "Mono Eminence": 5,
  "Sarcophagus": 1,
  "Strategic Coordinator": 1,
  "Dualcast": 1,
  "Diana": 1,
  "Hive Mind": 1,
  "Still Point in Time": 1,
  "Nitro-9": 1,
  "Particle Beam": 1,
  "Dynastic Codes": 1,
  "Command Section": 1,
  "Bring it Down!": 1,
  "Impossible Girl": 1,
  "Trace Aether": 1,
  "Advanced Species": 1,
  "Shieldwall": 1,
  "Vibro-Shock Gauntlets": 1,
  "Sonic Blast": 1,
  "Full Party": 1,
  "Light Party": 1,
  "Stagger": 1,
  "Primarch of the Death Guard": 1,
  "Harbinger of Despair": 1,
  "Look to t
```
Samples:
```json
[
 {
  "name": "Spider-Ham, Peter Porker",
  "keyword": "Animal May-Ham"
 },
 {
  "name": "Tyranid Harridan",
  "keyword": "Shrieking Gargoyles"
 },
 {
  "name": "Royal Warden",
  "keyword": "Phalanx Commander"
 },
 {
  "name": "Hadran, Naya Sunseeder",
  "keyword": "Rulebreaker"
 },
 {
  "name": "Astarion, the Decadent",
  "keyword": "Feed"
 },
 {
  "name": "Astarion, the Decadent",
  "keyword": "Friends"
 },
 {
  "name": "The Emperor of Palamecia // The Lord Master of Hell",
  "keyword": "Starfall"
 },
 {
  "name": "Baldur's Gate Wilderness",
  "keyword": "Crash Landing"
 },
 {
  "name": "Sister Hospitaller",
  "keyword": "Medicus Ministorum"
 },
 {
  "name": "Summon: Magus Sisters",
  "keyword": "Combine Powers!"
 },
 {
  "name": "Summon: Magus Sisters",
  "keyword": "Defense!"
 },
 {
  "name": "Nyssa of Traken",
  "keyword": "Sonic Booster"
 },
 {
  "name": "Blazing Bomb",
  "keyword": "Blow Up"
 },
 {
  "name": "Megaton's Fate",
  "keyword": "Disarm"
 },
 {
  "name": "Megaton's Fate",
  "keyword": "Detonate"
 }
]
```

### C9 Power/toughness values parse — PASS
```json
{
 "count": 0
}
```

### C10 Non-vanilla, non-basic cards have oracle text — WARN
```json
{
 "count": 5
}
```
Samples:
```json
[
 {
  "name": "Surprise!",
  "layout": "front_card",
  "type_line": "Card"
 },
 {
  "name": "Red Mana",
  "layout": "normal",
  "type_line": "Card"
 },
 {
  "name": "Stalwart",
  "layout": "front_card",
  "type_line": "Card"
 },
 {
  "name": "Sticker sheet",
  "layout": "normal",
  "type_line": "Stickers"
 },
 {
  "name": "Storm Counter",
  "layout": "normal",
  "type_line": "Card"
 }
]
```

### C11 Multi-face card names equal "Face A // Face B" — PASS
```json
{
 "count": 0
}
```

### C12 Rarity vocabulary — PASS
```json
{
 "count": 0,
 "distribution": {
  "rare": 10923,
  "uncommon": 10374,
  "common": 14992,
  "mythic": 2269,
  "special": 63,
  "bonus": 9
 }
}
```

### C13 Release dates are ISO dates — PASS
```json
{
 "count": 0
}
```

### C14 Layout distribution across oracle cards — INFO
```json
{
 "layouts": {
  "normal": 33330,
  "art_series": 2243,
  "token": 911,
  "class": 38,
  "front_card": 291,
  "planar": 207,
  "saga": 194,
  "scheme": 102,
  "double_faced_token": 80,
  "prepare": 55,
  "meld": 21,
  "prototype": 21,
  "vanguard": 107,
  "transform": 401,
  "adventure": 170,
  "emblem": 87,
  "modal_dfc": 100,
  "split": 137,
  "augment": 14,
  "flip": 26,
  "host": 20,
  "mutate": 34,
  "leveler": 26,
  "case": 15
 }
}
```

### C15 Card type distribution — INFO
```json
{
 "types": {
  "Creature": 20017,
  "Artifact": 4084,
  "Enchantment": 3867,
  "Sorcery": 3646,
  "Card": 2676,
  "Instant": 3875,
  "Token": 809,
  "Land": 1194,
  "Kindred": 80,
  "Plane": 184,
  "Boss": 11,
  "Scheme": 102,
  "Planeswalker": 338,
  "Vanguard": 107,
  "Emblem": 88,
  "Hero": 21,
  "Summon": 11,
  "Dragon": 3,
  "Stickers": 50,
  "Dungeon": 5,
  "Event": 14,
  "Conspiracy": 29,
  "Phenomenon": 21,
  "Eaturecray": 1,
  "Battle": 39,
  "Elemental": 1,
  "Licid": 1,
  "Legend": 1,
  "instant": 1,
  "Knights": 1,
  "Phenome-nom": 1,
  "Universewalker": 1,
  "Jaguar": 1,
  "pLAnE": 1,
  "Tribal": 2,
  "Goblin": 1,
  "Scariest": 1,
  "You'll": 1,
  "Ever": 1,
  "See": 1,
  "Poly": 1,
  "Wolf": 1
 }
}
```

### D1 Reserved List size (Wizards list has 571 cards) — PASS
```json
{
 "count": 571,
 "expected": 571
}
```

### D2 Power Nine present with Alpha (lea) printings — PASS
Samples:
```json
[
 {
  "name": "Black Lotus",
  "found": true,
  "lea": true
 },
 {
  "name": "Ancestral Recall",
  "found": true,
  "lea": true
 },
 {
  "name": "Time Walk",
  "found": true,
  "lea": true
 },
 {
  "name": "Mox Pearl",
  "found": true,
  "lea": true
 },
 {
  "name": "Mox Sapphire",
  "found": true,
  "lea": true
 },
 {
  "name": "Mox Jet",
  "found": true,
  "lea": true
 },
 {
  "name": "Mox Ruby",
  "found": true,
  "lea": true
 },
 {
  "name": "Mox Emerald",
  "found": true,
  "lea": true
 },
 {
  "name": "Timetwister",
  "found": true,
  "lea": true
 }
]
```

### D3 Spot checks of well-known cards against hand-verified values — PASS
```json
{
 "count": 0
}
```

### D4 Alpha released 1993-08-05 — PASS
```json
{
 "got": "1993-08-05"
}
```

### D5 Most recent sets in master (should be current/upcoming releases) — INFO
Samples:
```json
[
 {
  "set_code": "pw26",
  "set_name": "Wizards Play Network 2026",
  "d": "2026-11-20"
 },
 {
  "set_code": "pf26",
  "set_name": "MagicFest 2026",
  "d": "2026-11-13"
 },
 {
  "set_code": "purl",
  "set_name": "URL/Convention Promos",
  "d": "2026-11-13"
 },
 {
  "set_code": "sds",
  "set_name": "Stardates",
  "d": "2026-11-13"
 },
 {
  "set_code": "trc",
  "set_name": "Star Trek Commander",
  "d": "2026-11-13"
 }
]
```

### D6 Every ruling attaches to a known oracle card — PASS
```json
{
 "count": 0
}
```

### D7 Legal-card counts per format — INFO
```json
{
 "formats": [
  {
   "format": "commander",
   "c": 31830
  },
  {
   "format": "oathbreaker",
   "c": 31702
  },
  {
   "format": "vintage",
   "c": 31690
  },
  {
   "format": "legacy",
   "c": 31672
  },
  {
   "format": "duel",
   "c": 31635
  },
  {
   "format": "modern",
   "c": 22450
  },
  {
   "format": "tlr",
   "c": 18566
  },
  {
   "format": "gladiator",
   "c": 15787
  },
  {
   "format": "timeless",
   "c": 15753
  },
  {
   "format": "competitivebrawl",
   "c": 15747
  },
  {
   "format": "brawl",
   "c": 15722
  },
  {
   "format": "historic",
   "c": 15680
  },
  {
   "format": "penny",
   "c": 15494
  },
  {
   "format": "pioneer",
   "c": 14817
  },
  {
   "format": "predh",
   "c": 11514
  },
  {
   "format": "paupercommander",
   "c": 10908
  },
  {
   "format": "pauper",
   "c": 10793
  },
  {
   "format": "premodern",
   "c": 5375
  },
  {
   "format": "standardbrawl",
   "c": 4902
  },
  {
   "format": "standard",
   "c": 4887
  },
  {
   "format": "future",
   "c": 4669
  },
  {
   "format": "alchemy",
   "c": 3915
  },
  {
   "format": "oldschool",
   "c": 324
  }
 ]
}
```

### D8 Distinct card names vs oracle ids (names repeat only for reprints with changed oracle ids, e.g. Un-set variants, tokens) — INFO
```json
{
 "distinct_names": 38129,
 "oracle_ids": 38630,
 "delta": 501
}
```
Samples:
```json
[
 {
  "name": "Elemental",
  "c": 31
 },
 {
  "name": "Spirit",
  "c": 23
 },
 {
  "name": "Bird",
  "c": 13
 },
 {
  "name": "Soldier",
  "c": 13
 },
 {
  "name": "Insect",
  "c": 12
 },
 {
  "name": "Golem",
  "c": 11
 },
 {
  "name": "Beast",
  "c": 9
 },
 {
  "name": "Construct",
  "c": 9
 },
 {
  "name": "Cat",
  "c": 8
 },
 {
  "name": "Dragon",
  "c": 8
 },
 {
  "name": "Horror",
  "c": 8
 },
 {
  "name": "Vampire",
  "c": 8
 },
 {
  "name": "Wall",
  "c": 8
 },
 {
  "name": "Zombie",
  "c": 8
 },
 {
  "name": "Illusion",
  "c": 7
 }
]
```

### D9 Printings whose only version is non-English (sample) — INFO
```json
{
 "count": 2645
}
```
Samples:
```json
[
 {
  "name": "Vaevictis Asmadi",
  "lang": "ja",
  "set_code": "bchr"
 },
 {
  "name": "Island",
  "lang": "fr",
  "set_code": "fbb"
 },
 {
  "name": "Fire Elemental",
  "lang": "es",
  "set_code": "4bb"
 },
 {
  "name": "Immaculate Magistrate",
  "lang": "es",
  "set_code": "ps11"
 },
 {
  "name": "Spirit",
  "lang": "ja",
  "set_code": "wmkm"
 },
 {
  "name": "Ghost Ship",
  "lang": "es",
  "set_code": "4bb"
 },
 {
  "name": "Crop Rotation",
  "lang": "ja",
  "set_code": "soa"
 },
 {
  "name": "Urza's Power Plant",
  "lang": "it",
  "set_code": "rin"
 },
 {
  "name": "Twiddle",
  "lang": "es",
  "set_code": "4bb"
 },
 {
  "name": "Zombie Master",
  "lang": "es",
  "set_code": "4bb"
 },
 {
  "name": "Mountain",
  "lang": "ja",
  "set_code": "pmps"
 },
 {
  "name": "Sheoldred's Edict",
  "lang": "ja",
  "set_code": "soa"
 },
 {
  "name": "Blighted Agent",
  "lang": "ph",
  "set_code": "sld"
 },
 {
  "name": "Magma Sliver",
  "lang": "es",
  "set_code": "psal"
 },
 {
  "name": "Caller of the Claw",
  "lang": "es",
  "set_code": "psal"
 }
]
```

### E1 Scope: default_cards = every card object Scryfall has, one language per printing; all_cards (every language) is ~10x larger and adds no new cards, only translations — INFO
```json
{
 "includes": [
  "every paper and digital printing",
  "tokens, emblems, art series, oversized",
  "Un-sets, playtest cards, Alchemy rebalances",
  "Vanguard, Planechase, Archenemy, Conspiracy, Attractions, Stickers"
 ],
 "excludes": [
  "non-English translations of cards that have an English printing (fetch all_cards to add)",
  "card images (URLs are stored; files are not)"
 ]
}
```
