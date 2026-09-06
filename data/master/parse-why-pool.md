# parse:why — failure-cause histogram

Selection: `pool:paper` (tier paper); parser v5, rules a7f6b858.

32081 cards, 19244 with unparsed lines (13956 one line short, 10885 of them with one cause on it), 26188 lines carrying 30967 causes, 19643 distinct.

| stage | lines | cards | finishes |
|---|---:|---:|---:|
| sentence | 16068 | 11794 | 5478 |
| static | 5268 | 4476 | 2521 |
| trigger-head | 3761 | 3596 | 1281 |
| condition | 2594 | 2382 | 312 |
| keyword | 1547 | 1541 | 682 |
| intervening | 679 | 659 | 193 |
| cost | 642 | 625 | 418 |
| second-face | 343 | 302 | 0 |
| untraced | 65 | 64 | 0 |

## Top 60 constructs

weight = finishes + 0.5 × other cards; a card finishes when this is its only unparsed line and the only failure on it.

| # | weight | cards | finishes | lines | stage | key | shape | e.g. |
|---:|---:|---:|---:|---:|---|---|---|---|
| 1 | 279.5 | 542 | 17 | 548 | condition | you do | you do | Victimize |
| 2 | 54 | 65 | 43 | 65 | trigger-head | Whenever ~ is dealt damage | whenever ~ is dealt damage | Brash Taunter |
| 3 | 50.5 | 88 | 13 | 90 | trigger-head | When you cast ~ | when you cast ~ | Kozilek, Butcher of Truth |
| 4 | 49.5 | 99 | 0 | 99 | condition | able | able | Bident of Thassa |
| 5 | 46.5 | 80 | 13 | 80 | trigger-head | At the beginning of each player's upkeep | at the beginning of each <player>'s upkeep | Alexios, Deimos of Kosmos |
| 6 | 44.5 | 78 | 11 | 79 | sentence | you may pay {} | you may pay {m} | Electro, Assaulting Battery |
| 7 | 40.5 | 54 | 27 | 54 | trigger-head | When enchanted creature dies | when enchanted <obj> dies | Sticky Fingers |
| 8 | 35.5 | 49 | 22 | 49 | trigger-head | When you cycle ~ | when you cycle ~ | Shark Typhoon |
| 9 | 34.5 | 60 | 9 | 60 | sentence | ~ deals # damage to that player | ~ deals # damage to that <player> | Underworld Dreams |
| 10 | 33 | 66 | 0 | 66 | sentence | It's still a land | it's still a <obj> | Destiny Spinner |
| 11 | 32.5 | 51 | 14 | 51 | trigger-head | Whenever equipped creature attacks | whenever equipped <obj> attacks | Sword of the Animist |
| 12 | 31.5 | 41 | 22 | 41 | static | Start your engines! | start your engines! | Muraganda Raceway |
| 13 | 28.5 | 52 | 5 | 52 | sentence | you may pay {}{} | you may pay {m}{m} | Neyith of the Dire Hunt |
| 14 | 28 | 55 | 1 | 56 | condition | you don't | you don't | Pact of Negation |
| 15 | 27.5 | 30 | 25 | 31 | sentence | ~ costs {} less to cast | ~ costs {m} less to cast | Bolt Bend |
| 16 | 27 | 40 | 14 | 40 | trigger-head | Whenever equipped creature deals combat damage to a player | whenever equipped <obj> deals combat damage to a <player> | Sword of Feast and Famine |
| 17 | 26.5 | 33 | 20 | 33 | sentence | Activate only during your upkeep | activate only during your upkeep | Hell's Caretaker |
| 18 | 24.5 | 36 | 13 | 37 | sentence | you may gain # life | you may gain # life | Soul's Attendant |
| 19 | 24.5 | 26 | 23 | 26 | sentence | Activate only during your turn, before attackers are declared | activate only during your turn, before attackers are declared | Loyal Retainers |
| 20 | 24 | 35 | 13 | 35 | sentence | Activate only during your turn | activate only during your turn | Wishclaw Talisman |
| 21 | 23 | 40 | 6 | 40 | sentence | reveal the top card of your library | reveal the top <obj> of your <zone> | Twilight Prophet |
| 22 | 22.5 | 36 | 9 | 36 | trigger-head | When this Siege enters | when this <subtype> enters | Invasion of Ikoria // Zilortha, Apex of Ikoria |
| 23 | 21.5 | 25 | 18 | 25 | static | ~ enters prepared | ~ enters prepared | Studious First-Year // Rampant Growth |
| 24 | 21.5 | 25 | 18 | 25 | trigger-head | When ~ enters or dies | when ~ enters or dies | Stitcher's Supplier |
| 25 | 21 | 25 | 17 | 25 | trigger-head | Whenever ~ attacks while saddled | whenever ~ attacks while saddled | Ornery Tumblewagg |
| 26 | 20.5 | 38 | 3 | 38 | condition | it's a land card | it's a <obj> <obj> | Archdruid's Charm |
| 27 | 20.5 | 32 | 9 | 32 | static | Choose a Background | choose a <subtype> | Jaheira, Friend of the Forest |
| 28 | 19 | 33 | 5 | 33 | sentence | sacrifice it | sacrifice it | Riveteers Overlook |
| 29 | 18.5 | 32 | 5 | 32 | sentence | Do this only once each turn | do this only once each turn | Terrasymbiosis |
| 30 | 18.5 | 31 | 6 | 31 | trigger-head | Whenever a player casts a spell | whenever a <player> casts a <obj> | Forgotten Ancient |
| 31 | 18 | 23 | 13 | 23 | trigger-head | Whenever ~ becomes untapped | whenever ~ becomes untapped | Key to the City |
| 32 | 18 | 22 | 14 | 22 | trigger-head | Whenever a creature you control attacks alone | whenever a <obj> you control attacks alone | Squall, SeeD Mercenary |
| 33 | 18 | 22 | 14 | 22 | trigger-head | Whenever ~ and at least two other creatures attack | whenever ~ and at least # other <obj> attack | Frontline Medic |
| 34 | 17.5 | 19 | 16 | 19 | sentence | ~ deals # damage to target opponent or planeswalker | ~ deals # damage to target <player> or <obj> | Ral, Storm Conduit |
| 35 | 17 | 34 | 0 | 68 | sentence | Level # | level # | Caretaker's Talent |
| 36 | 17 | 27 | 7 | 30 | sentence | Any player may activate this ability | any <player> may activate this <obj> | Xantcha, Sleeper Agent |
| 37 | 17 | 25 | 9 | 25 | sentence | venture into the dungeon | venture into the dungeon | Nadaar, Selfless Paladin |
| 38 | 16.5 | 31 | 2 | 31 | trigger-head | Whenever ~ attacks and isn't blocked | whenever ~ attacks and isn't blocked | Guiltfeeder |
| 39 | 16.5 | 31 | 2 | 31 | trigger-head | Whenever ~ mutates | whenever ~ mutates | Gemrazer |
| 40 | 16.5 | 25 | 8 | 25 | trigger-head | Whenever ~ deals combat damage to a creature | whenever ~ deals combat damage to a <obj> | Stinkweed Imp |
| 41 | 16 | 27 | 5 | 27 | static | Doctor's companion | doctor's companion | K-9, Mark I |
| 42 | 16 | 26 | 6 | 26 | sentence | It gains haste | it gains <kw> | Whip of Erebos |
| 43 | 16 | 23 | 9 | 23 | sentence | ~ becomes prepared | ~ becomes prepared | Grave Researcher // Reanimate |
| 44 | 16 | 18 | 14 | 18 | sentence | It has "Sacrifice this token: Add {}." | it has "sacrifice this <obj>: add {m}." | Pawn of Ulamog |
| 45 | 16 | 16 | 16 | 16 | cost | Discard a card at random | discard a <obj> at random | Amok |
| 46 | 15.5 | 25 | 6 | 25 | trigger-head | Whenever one or more creatures you control deal combat damage to a player | whenever # or more <obj> you control deal combat damage to a <player> | Professional Face-Breaker |
| 47 | 15 | 20 | 10 | 20 | sentence | the Ring tempts you | the ring tempts you | Fiery Inscription |
| 48 | 15 | 19 | 11 | 20 | sentence | Tap it | tap it | Underrealm Lich |
| 49 | 15 | 16 | 14 | 16 | sentence | ~ can attack this turn as though it didn't have defender | ~ can attack this turn as though it didn't have <kw> | Nivix Cyclops |
| 50 | 14.5 | 19 | 10 | 19 | sentence | The Ring tempts you | the ring tempts you | Boromir, Warden of the Tower |
| 51 | 14 | 25 | 3 | 25 | sentence | exile it | exile it | Patron of the Vein |
| 52 | 14 | 17 | 11 | 17 | trigger-head | Whenever one or more +#/+# counters are put on ~ | whenever # or more <counter> counters are put on ~ | Evolution Witness |
| 53 | 14 | 15 | 13 | 15 | sentence | Regenerate enchanted creature | regenerate enchanted <obj> | Blessing of Leeches |
| 54 | 13.5 | 23 | 4 | 23 | trigger-head | At the beginning of each combat | at the beginning of each combat | Unnatural Growth |
| 55 | 13.5 | 21 | 6 | 21 | trigger-head | At the beginning of the upkeep of enchanted creature's controller | at the beginning of the upkeep of enchanted <obj>'s <player> | Dance of the Dead |
| 56 | 13.5 | 21 | 6 | 21 | trigger-head | At the beginning of your second main phase | at the beginning of your second main phase | Kona, Rescue Beastie |
| 57 | 13.5 | 18 | 9 | 18 | trigger-head | Whenever you commit a crime | whenever you commit a crime | Magda, the Hoardmaster |
| 58 | 13.5 | 18 | 9 | 18 | trigger-head | Whenever ~ becomes blocked by a creature | whenever ~ becomes blocked by a <obj> | Vicious Battlerager |
| 59 | 13.5 | 16 | 11 | 16 | trigger-head | Whenever you cast a spell with mana value # or greater | whenever you cast a <obj> with mana value # or greater | Spider Manifestation |
| 60 | 13.5 | 15 | 12 | 15 | sentence | They have "Sacrifice this token: Add {}." | they have "sacrifice this <obj>: add {m}." | Skittering Invasion |

## Top 60 shapes

| weight | cards | finishes | keys | stage | shape | e.g. key |
|---:|---:|---:|---:|---|---|---|
| 279.5 | 542 | 17 | 1 | condition | you do | you do |
| 78.5 | 157 | 0 | 18 | sentence | look at the top # <obj> of your <zone> | Look at the top four cards of your library |
| 54 | 65 | 43 | 1 | trigger-head | whenever ~ is dealt damage | Whenever ~ is dealt damage |
| 52.5 | 66 | 39 | 35 | static | other <subtype> you control get +#/+# | Other Goblins you control get +#/+# |
| 50.5 | 88 | 13 | 1 | trigger-head | when you cast ~ | When you cast ~ |
| 49.5 | 99 | 0 | 1 | condition | able | able |
| 46.5 | 80 | 13 | 1 | trigger-head | at the beginning of each <player>'s upkeep | At the beginning of each player's upkeep |
| 45.5 | 80 | 11 | 2 | sentence | you may pay {m} | you may pay {} |
| 43.5 | 60 | 27 | 2 | trigger-head | when enchanted <obj> dies | When enchanted creature dies |
| 39 | 69 | 9 | 4 | trigger-head | when this <subtype> enters | When this Class enters |
| 35.5 | 49 | 22 | 1 | trigger-head | when you cycle ~ | When you cycle ~ |
| 35 | 67 | 3 | 5 | condition | it's a <obj> <obj> | it's a land card |
| 34.5 | 63 | 6 | 2 | sentence | reveal the top <obj> of your <zone> | reveal the top card of your library |
| 34.5 | 60 | 9 | 1 | sentence | ~ deals # damage to that <player> | ~ deals # damage to that player |
| 34 | 37 | 31 | 12 | cost | tap # untapped <obj> you control | Tap two untapped artifacts you control |
| 33 | 66 | 0 | 1 | sentence | it's still a <obj> | It's still a land |
| 32.5 | 51 | 14 | 1 | trigger-head | whenever equipped <obj> attacks | Whenever equipped creature attacks |
| 32.5 | 37 | 28 | 33 | cost | tap # untapped <subtype> you control | Tap five untapped Soldiers you control |
| 31.5 | 41 | 22 | 1 | static | start your engines! | Start your engines! |
| 29.5 | 39 | 20 | 2 | sentence | the ring tempts you | the Ring tempts you |
| 28.5 | 52 | 5 | 1 | sentence | you may pay {m}{m} | you may pay {}{} |
| 28 | 55 | 1 | 1 | condition | you don't | you don't |
| 27.5 | 30 | 25 | 1 | sentence | ~ costs {m} less to cast | ~ costs {} less to cast |
| 27 | 40 | 14 | 1 | trigger-head | whenever equipped <obj> deals combat damage to a <player> | Whenever equipped creature deals combat damage to a player |
| 26.5 | 36 | 17 | 7 | sentence | ~ deals # damage to that <obj>'s <player> | ~ deals # damage to that spell's controller |
| 26.5 | 33 | 20 | 1 | sentence | activate only during your upkeep | Activate only during your upkeep |
| 24.5 | 36 | 13 | 1 | sentence | you may gain # life | you may gain # life |
| 24.5 | 28 | 21 | 5 | trigger-head | whenever a <player> casts a <color> <obj> | Whenever a player casts a black spell |
| 24.5 | 26 | 23 | 1 | sentence | activate only during your turn, before attackers are declared | Activate only during your turn, before attackers are declared |
| 24 | 47 | 1 | 2 | sentence | exile the top <obj> of your <zone> | Exile the top card of your library |
| 24 | 35 | 13 | 1 | sentence | activate only during your turn | Activate only during your turn |
| 24 | 31 | 17 | 22 | cost | sacrifice # <subtype> | Sacrifice three Treasures |
| 24 | 29 | 19 | 4 | sentence | create a <subtype> <obj> | create a Lander token |
| 23.5 | 33 | 14 | 2 | sentence | venture into the dungeon | venture into the dungeon |
| 23 | 45 | 1 | 15 | sentence | exile the top # <obj> of your <zone> | Exile the top X cards of your library |
| 22 | 25 | 19 | 3 | cost | discard a <obj> <obj> | Discard a creature card |
| 21.5 | 25 | 18 | 1 | trigger-head | when ~ enters or dies | When ~ enters or dies |
| 21.5 | 25 | 18 | 1 | static | ~ enters prepared | ~ enters prepared |
| 21 | 25 | 17 | 1 | trigger-head | whenever ~ attacks while saddled | Whenever ~ attacks while saddled |
| 21 | 24 | 18 | 15 | sentence | destroy target <subtype> | destroy target Angel |
| 20.5 | 32 | 9 | 1 | static | choose a <subtype> | Choose a Background |
| 20 | 25 | 15 | 3 | trigger-head | whenever ~ and at least # other <obj> attack | Whenever ~ and at least two other creatures attack |
| 20 | 23 | 17 | 4 | sentence | you may tap or untap target <obj> | you may tap or untap target permanent |
| 19.5 | 25 | 14 | 5 | sentence | that <obj> doesn't untap during its <player>'s next untap step | That creature doesn't untap during its controller's next untap step |
| 19 | 35 | 3 | 15 | sentence | remove a <counter> counter from ~ | remove a -#/-# counter from ~ |
| 19 | 33 | 5 | 1 | sentence | sacrifice it | sacrifice it |
| 19 | 32 | 6 | 2 | trigger-head | whenever a <player> casts a <obj> | Whenever a player casts a spell |
| 19 | 31 | 7 | 6 | sentence | it gains <kw> | It gains haste |
| 19 | 30 | 8 | 5 | trigger-head | at the beginning of the upkeep of enchanted <obj>'s <player> | At the beginning of the upkeep of enchanted creature's controller |
| 19 | 19 | 19 | 2 | cost | discard a <obj> at random | Discard a card at random |
| 18.5 | 32 | 5 | 1 | sentence | do this only once each turn | Do this only once each turn |
| 18.5 | 20 | 17 | 2 | sentence | ~ deals # damage to target <player> or <obj> | ~ deals # damage to target opponent or planeswalker |
| 18 | 23 | 13 | 1 | trigger-head | whenever ~ becomes untapped | Whenever ~ becomes untapped |
| 18 | 22 | 14 | 2 | sentence | create a tapped <subtype> <obj> | Create a tapped Powerstone token |
| 18 | 22 | 14 | 1 | trigger-head | whenever a <obj> you control attacks alone | Whenever a creature you control attacks alone |
| 18 | 18 | 18 | 3 | cost | remove any number of <counter> counters from ~ | Remove any number of storage counters from ~ |
| 17 | 34 | 0 | 1 | sentence | level # | Level # |
| 17 | 27 | 7 | 1 | sentence | any <player> may activate this <obj> | Any player may activate this ability |
| 16.5 | 31 | 2 | 1 | trigger-head | whenever ~ attacks and isn't blocked | Whenever ~ attacks and isn't blocked |
| 16.5 | 31 | 2 | 1 | trigger-head | whenever ~ mutates | Whenever ~ mutates |

## Top 60 prefixes

| weight | cards | finishes | keys | stage | prefix |
|---:|---:|---:|---:|---|---|
| 349.5 | 433 | 266 | 430 | static | as long as |
| 324 | 429 | 219 | 223 | sentence | ~ deals # |
| 285.5 | 376 | 195 | 347 | sentence | until end of |
| 279.5 | 542 | 17 | 1 | condition | you do |
| 188.5 | 263 | 114 | 215 | sentence | put a <counter> |
| 177.5 | 260 | 95 | 165 | trigger-head | whenever # or more |
| 160 | 222 | 98 | 157 | sentence | create a #/# |
| 158.5 | 196 | 121 | 154 | static | enchanted <obj> gets |
| 147 | 255 | 39 | 44 | trigger-head | at the beginning of |
| 127 | 238 | 16 | 83 | sentence | look at the |
| 126 | 177 | 75 | 103 | trigger-head | whenever a <obj> you |
| 125.5 | 173 | 78 | 134 | sentence | you may have |
| 122.5 | 173 | 72 | 165 | sentence | search your <zone> |
| 120.5 | 222 | 19 | 39 | sentence | you may pay |
| 117 | 203 | 31 | 146 | sentence | you may cast |
| 111.5 | 144 | 79 | 128 | static | equipped <obj> gets |
| 110 | 181 | 39 | 145 | sentence | you may put |
| 110 | 152 | 68 | 80 | trigger-head | whenever you cast a |
| 106 | 124 | 88 | 77 | sentence | destroy target <obj> |
| 105.5 | 138 | 73 | 106 | sentence | spend this mana |
| 93 | 120 | 66 | 16 | sentence | activate only during |
| 84 | 159 | 9 | 63 | sentence | exile the top |
| 83 | 118 | 48 | 112 | sentence | ~ deals damage |
| 81.5 | 97 | 66 | 85 | sentence | you may search |
| 79.5 | 100 | 59 | 80 | sentence | target <obj> you |
| 78.5 | 113 | 44 | 35 | trigger-head | whenever a <player> casts |
| 77.5 | 134 | 21 | 93 | static | as ~ enters, |
| 77.5 | 106 | 49 | 81 | static | ~ enters with |
| 72 | 96 | 48 | 88 | static | <obj> you control |
| 69.5 | 83 | 56 | 72 | static | ~ gets +#/+# |
| 69.5 | 82 | 57 | 77 | static | enchanted <obj> has |
| 66.5 | 88 | 45 | 82 | static | if a <obj> |
| 66 | 82 | 50 | 61 | static | ~ has <kw> |
| 64 | 84 | 44 | 53 | static | other <subtype> you |
| 62.5 | 77 | 48 | 75 | sentence | ~ becomes a |
| 62 | 79 | 45 | 60 | static | you may cast |
| 61 | 79 | 43 | 66 | sentence | return up to |
| 58.5 | 74 | 43 | 57 | sentence | add # mana |
| 58.5 | 71 | 46 | 4 | trigger-head | whenever ~ is dealt |
| 56.5 | 68 | 45 | 47 | sentence | counter target <obj> |
| 55.5 | 95 | 16 | 7 | trigger-head | when you cast ~ |
| 54.5 | 98 | 11 | 61 | sentence | you may exile |
| 54.5 | 76 | 33 | 66 | sentence | destroy all <obj> |
| 54 | 101 | 7 | 50 | sentence | choose target <obj> |
| 54 | 70 | 38 | 69 | sentence | create # #/# |
| 53 | 91 | 15 | 87 | sentence | when you do, |
| 52.5 | 62 | 43 | 56 | static | ~ can't attack |
| 52 | 72 | 32 | 50 | sentence | exile target <obj> |
| 52 | 68 | 36 | 55 | sentence | you gain # |
| 52 | 63 | 41 | 54 | static | ~ can't be |
| 50.5 | 86 | 15 | 82 | sentence | you get an |
| 50 | 81 | 19 | 71 | sentence | for each <player>, |
| 50 | 79 | 21 | 78 | sentence | for each <obj> |
| 50 | 62 | 38 | 20 | sentence | ~ costs {m} |
| 50 | 60 | 40 | 7 | trigger-head | when ~ enters or |
| 49.5 | 99 | 0 | 1 | condition | able |
| 49.5 | 72 | 27 | 69 | sentence | put # <counter> |
| 49 | 93 | 5 | 21 | condition | it's a <obj> |
| 49 | 66 | 32 | 57 | static | during your turn, |
| 49 | 56 | 42 | 52 | sentence | the next time |

## Nested causes (what a registry rule's own sub-parse could not claim; not a line's cause without --nested)

| cards | lines | key | e.g. |
|---:|---:|---|---|
| 9 | 9 | sentence\|graveyard into your library | Game Plan |
| 9 | 9 | sentence\|shuffle your hand and graveyard into your library | Game Plan |
| 8 | 8 | sentence\|search your library for a card named ~, reveal it, put it into your hand | Screaming Seahawk |
| 6 | 6 | sentence\|Discard all the cards in your hand | Queen Kayla bin-Kroog |
| 5 | 15 | sentence\|discard all the cards in your hand | Awaken the Erstwhile |
| 5 | 13 | sentence\|shuffle the cards from your hand into your library | Whirlpool Rider |
| 5 | 5 | sentence\|discard up to two cards | Kinetic Augur |
| 4 | 4 | sentence\|reveal a creature card from among them | Twists and Turns // Mycoid Maze |
| 4 | 4 | sentence\|reveal a creature card with power # or less from among them | Star Charter |
| 4 | 4 | sentence\|reveal a creature or land card from among them | Follow the Lumarets |
| 4 | 4 | sentence\|search your library for up to three cards named ~, reveal them, put them into your hand | Squadron Hawk |
| 3 | 7 | sentence\|discard any number of cards | Cavalier of Flame |
| 3 | 5 | sentence\|each player | Breath of Darigaaz |
| 3 | 5 | sentence\|exile all cards from your hand face down | Induced Amnesia |
| 3 | 5 | sentence\|put the cards in your hand on the bottom of your library in any order | Teferi's Puzzle Box |
| 3 | 3 | sentence\|Discard up to two cards | Greasewrench Goblin |
| 3 | 3 | sentence\|draw a card for each card exiled from your hand this way | Deadly Cover-Up |
| 3 | 3 | sentence\|draw cards equal to the greatest number of cards a player discarded this way | Windfall |
| 3 | 3 | sentence\|search your library for any number of cards named ~, reveal them, put them into your hand | Legion Conquistador |
| 3 | 3 | sentence\|~ each player | Breath of Darigaaz |
| 2 | 5 | sentence\|all permanents you own into your library | The Great Aurora |
| 2 | 3 | sentence\|exile it | Gossip's Talent |
| 2 | 3 | sentence\|reveal a card at random from your hand | Singe-Mind Ogre |
| 2 | 2 | sentence\|Discard any number of cards | The Elder Dragon War |
| 2 | 2 | sentence\|discard a card at random | Noggle Ransacker |
| 2 | 2 | sentence\|discard three cards at random | Balor |
| 2 | 2 | sentence\|each opponent who didn't draw a card | Kynaios and Tiro of Meletis |
| 2 | 2 | sentence\|each player returns to their hand each card they exiled this way | Magus of the Jar |
| 2 | 2 | sentence\|return to your hand each card you exiled this way | Magus of the Jar |
| 2 | 2 | sentence\|reveal a creature card with mana value # or less from among them | Gavony Dawnguard |
| 2 | 2 | sentence\|reveal a land card from among them | Nessian Wanderer |
| 2 | 2 | sentence\|reveal up to two creature cards from among them | Domri, Chaos Bringer |
| 2 | 2 | sentence\|sacrifice a creature, discard a card, | Scarring Memories |
| 2 | 2 | sentence\|sacrifice it | RMS Titanic |
| 2 | 2 | sentence\|search your library for a land card | Tempt with Discovery |
| 2 | 2 | sentence\|you lose # life, search your library for a card, put it into your hand | Maralen of the Mornsong |
| 1 | 3 | sentence\|exile cards from the top of your library until you exile a nonland card with a different name than that spell | Tibalt's Trickery |
| 1 | 3 | sentence\|search your library for a basic land card or a Desert card, reveal it | Silver Deputy |
| 1 | 3 | sentence\|search your library for a colorless creature card with mana value # or greater, reveal it | Conduit of Ruin |
| 1 | 3 | sentence\|shuffle all cards from your hand and all permanents you own into your library | The Great Aurora |
| 1 | 3 | sentence\|you that opponent gains # life, | Game of Chaos |
| 1 | 2 | sentence\|create a #/# green Saproling creature token for each permanent of that color | Rith, the Awakener |
| 1 | 2 | sentence\|return all creatures of that color to their owners' hands | Dromar, the Banisher |
| 1 | 2 | sentence\|reveal the top X cards of your library, put all Dwarf and Vehicle cards from among them into your hand | Depala, Pilot Exemplar |
| 1 | 2 | sentence\|reveal the top card of your library | Stronghold Arena |
| 1 | 2 | sentence\|search your library for a card named ~, put that card onto the battlefield | Llanowar Sentinel |
| 1 | 2 | sentence\|search your library for any number of land cards, exile them | Trench Gorger |
| 1 | 2 | sentence\|that player reveals their hand | Darigaaz, the Igniter |
| 1 | 2 | sentence\|that player reveals their hand and discards all cards of that color | Crosis, the Purger |
| 1 | 2 | sentence\|that player reveals their hand and ~ deals damage to the player equal to the number of cards of that color revealed this way | Darigaaz, the Igniter |
| 1 | 2 | sentence\|you create three Treasure tokens | Ziatora, the Incinerator |
| 1 | 2 | sentence\|you gain # life for each permanent of that color | Treva, the Renewer |
| 1 | 2 | sentence\|~ X damage to up to one target creature | Dragonspark Reactor |
| 1 | 2 | sentence\|~ gains trample | Arahbo, Roar of the World |
| 1 | 2 | sentence\|~ you create three Treasure tokens | Ziatora, the Incinerator |
| 1 | 1 | sentence\|Discard up to three cards | Jaya Ballard |
| 1 | 1 | sentence\|Exile all attacking creatures target player controls | Settle the Wreckage |
| 1 | 1 | sentence\|Exile all the cards from your hand | Hex Magic |
| 1 | 1 | sentence\|If damage would be dealt to that creature this turn, prevent that damage | Gatta and Luzzu |
| 1 | 1 | sentence\|If one or more +#/+# counters are moved this way, you gain X life | Black Panther, Wakandan King |
