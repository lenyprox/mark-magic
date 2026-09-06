# parse:why — failure-cause histogram

Selection: `edhrec<=5000 commander:legal pool:paper` (tier paper); parser v5, rules a7f6b858.

4987 cards, 3064 with unparsed lines (2040 one line short, 1587 of them with one cause on it), 4451 lines carrying 5271 causes, 4083 distinct.

| stage | lines | cards | finishes |
|---|---:|---:|---:|
| sentence | 2651 | 1873 | 762 |
| static | 1049 | 880 | 432 |
| trigger-head | 687 | 643 | 199 |
| condition | 416 | 378 | 40 |
| keyword | 227 | 226 | 81 |
| intervening | 96 | 94 | 24 |
| cost | 95 | 91 | 49 |
| second-face | 39 | 37 | 0 |
| untraced | 11 | 11 | 0 |

## Top 60 constructs

weight = finishes + 0.5 × other cards; a card finishes when this is its only unparsed line and the only failure on it.

| # | weight | cards | finishes | lines | stage | key | shape | e.g. |
|---:|---:|---:|---:|---:|---|---|---|---|
| 1 | 37 | 74 | 0 | 76 | condition | you do | you do | Victimize |
| 2 | 14 | 25 | 3 | 26 | trigger-head | When you cast ~ | when you cast ~ | Kozilek, Butcher of Truth |
| 3 | 14 | 21 | 7 | 21 | trigger-head | Whenever equipped creature deals combat damage to a player | whenever equipped <obj> deals combat damage to a <player> | Sword of Feast and Famine |
| 4 | 10.5 | 17 | 4 | 17 | trigger-head | Whenever equipped creature attacks | whenever equipped <obj> attacks | Sword of the Animist |
| 5 | 10 | 20 | 0 | 40 | sentence | Level # | level # | Caretaker's Talent |
| 6 | 10 | 12 | 8 | 12 | trigger-head | Whenever ~ is dealt damage | whenever ~ is dealt damage | Brash Taunter |
| 7 | 7.5 | 12 | 3 | 12 | sentence | ~ deals # damage to that player | ~ deals # damage to that <player> | Underworld Dreams |
| 8 | 7 | 11 | 3 | 11 | sentence | Do this only once each turn | do this only once each turn | Terrasymbiosis |
| 9 | 7 | 11 | 3 | 11 | sentence | you win the game | you win the game | Hellkite Tyrant |
| 10 | 7 | 10 | 4 | 10 | static | Choose a Background | choose a <subtype> | Jaheira, Friend of the Forest |
| 11 | 6.5 | 11 | 2 | 11 | trigger-head | Whenever one or more creatures you control deal combat damage to a player | whenever # or more <obj> you control deal combat damage to a <player> | Professional Face-Breaker |
| 12 | 6.5 | 9 | 4 | 9 | sentence | The Ring tempts you | the ring tempts you | Boromir, Warden of the Tower |
| 13 | 6 | 12 | 0 | 12 | sentence | It's still a land | it's still a <obj> | Destiny Spinner |
| 14 | 6 | 10 | 2 | 10 | condition | you're the monarch | you're the monarch | Court of Grace |
| 15 | 6 | 7 | 5 | 7 | sentence | sacrifice it | sacrifice it | Riveteers Overlook |
| 16 | 5.5 | 9 | 2 | 9 | trigger-head | When you cycle ~ | when you cycle ~ | Shark Typhoon |
| 17 | 5.5 | 6 | 5 | 6 | static | Start your engines! | start your engines! | Muraganda Raceway |
| 18 | 5 | 10 | 0 | 10 | condition | you don't | you don't | Pact of Negation |
| 19 | 5 | 10 | 0 | 10 | sentence | Add {} or one mana of the chosen color | add {m} or # mana of the chosen color | Thriving Isle |
| 20 | 5 | 9 | 1 | 9 | condition | X is # or more | # is # or more | Finale of Devastation |
| 21 | 5 | 9 | 1 | 9 | sentence | reveal the top card of your library | reveal the top <obj> of your <zone> | Twilight Prophet |
| 22 | 5 | 8 | 2 | 8 | trigger-head | At the beginning of each player's upkeep | at the beginning of each <player>'s upkeep | Alexios, Deimos of Kosmos |
| 23 | 5 | 7 | 3 | 7 | sentence | the Ring tempts you | the ring tempts you | Fiery Inscription |
| 24 | 5 | 7 | 3 | 7 | static | If ~ is in your opening hand, you may begin the game with it on the battlefield | if ~ is in your opening <zone>, you may begin the game with it on the <zone> | Leyline of Anticipation |
| 25 | 5 | 5 | 5 | 5 | sentence | ~ costs {} less to cast | ~ costs {m} less to cast | Bolt Bend |
| 26 | 5 | 5 | 5 | 5 | trigger-head | When ~ enters untapped | when ~ enters untapped | Mystic Sanctuary |
| 27 | 5 | 5 | 5 | 5 | trigger-head | Whenever one or more +#/+# counters are put on ~ | whenever # or more <counter> counters are put on ~ | Evolution Witness |
| 28 | 4.5 | 7 | 2 | 7 | trigger-head | Whenever a player casts a spell | whenever a <player> casts a <obj> | Forgotten Ancient |
| 29 | 4.5 | 6 | 3 | 6 | trigger-head | Whenever an opponent discards a card | whenever an <player> discards a <obj> | Sangromancer |
| 30 | 4.5 | 5 | 4 | 5 | sentence | It has "Sacrifice this token: Add {}." | it has "sacrifice this <obj>: add {m}." | Pawn of Ulamog |
| 31 | 4.5 | 5 | 4 | 5 | sentence | you may cast ~ without paying its mana cost | you may cast ~ without paying its mana cost | Deflecting Swat |
| 32 | 4 | 8 | 0 | 8 | condition | it's a land card | it's a <obj> <obj> | Archdruid's Charm |
| 33 | 4 | 8 | 0 | 8 | condition | the gift was promised | the gift was promised | Dawn's Truce |
| 34 | 4 | 8 | 0 | 8 | sentence | You may choose the same mode more than once | you may choose the same mode more than once | Mystic Confluence |
| 35 | 4 | 8 | 0 | 8 | trigger-head | At the beginning of each player's draw step | at the beginning of each <player>'s draw step | Howling Mine |
| 36 | 4 | 7 | 1 | 7 | sentence | Activate only during your turn | activate only during your turn | Wishclaw Talisman |
| 37 | 4 | 7 | 1 | 7 | static | Ward—Pay # life | <kw>—pay # life | Hexing Squelcher |
| 38 | 4 | 6 | 2 | 6 | condition | this is the second time this ability has resolved this turn | this is the second time this <obj> has resolved this turn | Rumor Gatherer |
| 39 | 4 | 5 | 3 | 5 | sentence | This ability costs {} less to activate for each legendary creature you control | this <obj> costs {m} less to activate for each legendary <obj> you control | Boseiju, Who Endures |
| 40 | 4 | 5 | 3 | 5 | sentence | You gain life equal to the life lost this way | you gain life equal to the life lost this way | Gray Merchant of Asphodel |
| 41 | 4 | 4 | 4 | 4 | sentence | Target creature you control gains protection from the color of your choice until end of turn | target <obj> you control gains <kw> from the color of your choice until end of turn | Mother of Runes |
| 42 | 4 | 4 | 4 | 4 | static | ~ enters tapped. As it enters, choose a color | ~ enters tapped. as it enters, choose a color | Valgavoth's Lair |
| 43 | 3.5 | 7 | 0 | 7 | condition | able | able | Bident of Thassa |
| 44 | 3.5 | 7 | 0 | 7 | sentence | Choose one — | choose # — | Cankerbloom |
| 45 | 3.5 | 7 | 0 | 7 | sentence | you may pay {} | you may pay {m} | Electro, Assaulting Battery |
| 46 | 3.5 | 7 | 0 | 7 | trigger-head | When this Class enters | when this <subtype> enters | Alchemist's Talent |
| 47 | 3.5 | 6 | 1 | 6 | condition | they don't | they don't | Charismatic Conqueror |
| 48 | 3.5 | 6 | 1 | 6 | trigger-head | When enchanted creature dies | when enchanted <obj> dies | Sticky Fingers |
| 49 | 3.5 | 5 | 2 | 5 | trigger-head | At the beginning of your second main phase | at the beginning of your second main phase | Kona, Rescue Beastie |
| 50 | 3.5 | 4 | 3 | 4 | static | Creature spells you control can't be countered | <obj> <obj> you control can't be countered | Rhythm of the Wild |
| 51 | 3.5 | 4 | 3 | 4 | static | Other Elves you control get +#/+# | other <subtype> you control get +#/+# | Imperious Perfect |
| 52 | 3.5 | 4 | 3 | 4 | trigger-head | Whenever you cast a spell from anywhere other than your hand | whenever you cast a <obj> from anywhere other than your <zone> | Vega, the Watcher |
| 53 | 3 | 6 | 0 | 6 | condition | you cast a spell this way | you cast a <obj> this way | Nashi, Moon Sage's Scion |
| 54 | 3 | 6 | 0 | 6 | sentence | Exile the top card of your library | exile the top <obj> of your <zone> | Mystic Forge |
| 55 | 3 | 6 | 0 | 6 | sentence | It gains haste | it gains <kw> | Whip of Erebos |
| 56 | 3 | 6 | 0 | 6 | sentence | Until end of turn, you don't lose this mana as steps and phases end | until end of turn, you don't lose this mana as steps and phases end | Birgi, God of Storytelling // Harnfel, Horn of Bounty |
| 57 | 3 | 6 | 0 | 6 | sentence | choose one that hasn't been chosen this turn — | choose # that hasn't been chosen this turn — | Monument to Endurance |
| 58 | 3 | 6 | 0 | 6 | sentence | exile the top card of your library | exile the top <obj> of your <zone> | Valakut Exploration |
| 59 | 3 | 6 | 0 | 6 | sentence | that player draws an additional card | that <player> draws an additional <obj> | Howling Mine |
| 60 | 3 | 6 | 0 | 6 | trigger-head | At the beginning of each combat | at the beginning of each combat | Unnatural Growth |

## Top 60 shapes

| weight | cards | finishes | keys | stage | shape | e.g. key |
|---:|---:|---:|---:|---|---|---|
| 37 | 74 | 0 | 1 | condition | you do | you do |
| 14.5 | 18 | 11 | 10 | static | other <subtype> you control get +#/+# | Other Goblins you control get +#/+# |
| 14 | 25 | 3 | 1 | trigger-head | when you cast ~ | When you cast ~ |
| 14 | 21 | 7 | 1 | trigger-head | whenever equipped <obj> deals combat damage to a <player> | Whenever equipped creature deals combat damage to a player |
| 11.5 | 16 | 7 | 2 | sentence | the ring tempts you | the Ring tempts you |
| 10.5 | 21 | 0 | 10 | sentence | look at the top # <obj> of your <zone> | look at the top six cards of your library |
| 10.5 | 17 | 4 | 1 | trigger-head | whenever equipped <obj> attacks | Whenever equipped creature attacks |
| 10.5 | 15 | 6 | 12 | cost | sacrifice # <subtype> | Sacrifice three Foods |
| 10 | 20 | 0 | 1 | sentence | level # | Level # |
| 10 | 12 | 8 | 1 | trigger-head | whenever ~ is dealt damage | Whenever ~ is dealt damage |
| 8.5 | 10 | 7 | 5 | static | as long as your devotion to <color> is less than #, ~ isn't a <obj> | As long as your devotion to black is less than five, ~ isn't a creature |
| 7.5 | 12 | 3 | 1 | sentence | ~ deals # damage to that <player> | ~ deals # damage to that player |
| 7 | 14 | 0 | 5 | condition | it's a <obj> <obj> | it's a permanent card |
| 7 | 11 | 3 | 1 | sentence | do this only once each turn | Do this only once each turn |
| 7 | 11 | 3 | 1 | sentence | you win the game | you win the game |
| 7 | 10 | 4 | 1 | static | choose a <subtype> | Choose a Background |
| 6.5 | 11 | 2 | 1 | trigger-head | whenever # or more <obj> you control deal combat damage to a <player> | Whenever one or more creatures you control deal combat damage to a player |
| 6 | 12 | 0 | 2 | sentence | exile the top <obj> of your <zone> | Exile the top card of your library |
| 6 | 12 | 0 | 1 | sentence | it's still a <obj> | It's still a land |
| 6 | 11 | 1 | 2 | sentence | reveal the top <obj> of your <zone> | reveal the top card of your library |
| 6 | 10 | 2 | 1 | condition | you're the monarch | you're the monarch |
| 6 | 7 | 5 | 1 | sentence | sacrifice it | sacrifice it |
| 5.5 | 9 | 2 | 1 | trigger-head | when you cycle ~ | When you cycle ~ |
| 5.5 | 7 | 4 | 7 | cost | tap # untapped <obj> you control | Tap two untapped artifacts you control |
| 5.5 | 6 | 5 | 1 | static | start your engines! | Start your engines! |
| 5 | 10 | 0 | 1 | sentence | add {m} or # mana of the chosen color | Add {} or one mana of the chosen color |
| 5 | 10 | 0 | 10 | static | equipped <obj> gets +#/+# and has <kw> from <color> and from <color> | Equipped creature gets +#/+# and has protection from white and from black |
| 5 | 10 | 0 | 3 | trigger-head | when this <subtype> enters | When this Class enters |
| 5 | 10 | 0 | 1 | condition | you don't | you don't |
| 5 | 9 | 1 | 1 | condition | # is # or more | X is # or more |
| 5 | 8 | 2 | 1 | trigger-head | at the beginning of each <player>'s upkeep | At the beginning of each player's upkeep |
| 5 | 7 | 3 | 1 | static | if ~ is in your opening <zone>, you may begin the game with it on the <zone> | If ~ is in your opening hand, you may begin the game with it on the battlefield |
| 5 | 7 | 3 | 2 | trigger-head | whenever a <obj> an <player> controls enters | Whenever a land an opponent controls enters |
| 5 | 6 | 4 | 3 | trigger-head | whenever you sacrifice a <subtype> | Whenever you sacrifice a Food |
| 5 | 5 | 5 | 1 | trigger-head | when ~ enters untapped | When ~ enters untapped |
| 5 | 5 | 5 | 1 | trigger-head | whenever # or more <counter> counters are put on ~ | Whenever one or more +#/+# counters are put on ~ |
| 5 | 5 | 5 | 1 | sentence | ~ costs {m} less to cast | ~ costs {} less to cast |
| 4.5 | 7 | 2 | 1 | trigger-head | whenever a <player> casts a <obj> | Whenever a player casts a spell |
| 4.5 | 7 | 2 | 2 | sentence | you create a <subtype> <obj> | you create a Treasure token |
| 4.5 | 6 | 3 | 1 | trigger-head | whenever an <player> discards a <obj> | Whenever an opponent discards a card |
| 4.5 | 5 | 4 | 1 | sentence | it has "sacrifice this <obj>: add {m}." | It has "Sacrifice this token: Add {}." |
| 4.5 | 5 | 4 | 1 | sentence | you may cast ~ without paying its mana cost | you may cast ~ without paying its mana cost |
| 4 | 8 | 0 | 1 | trigger-head | at the beginning of each <player>'s draw step | At the beginning of each player's draw step |
| 4 | 8 | 0 | 5 | sentence | exile the top # <obj> of your <zone> | Exile the top two cards of your library |
| 4 | 8 | 0 | 1 | condition | the gift was promised | the gift was promised |
| 4 | 8 | 0 | 1 | sentence | you may choose the same mode more than once | You may choose the same mode more than once |
| 4 | 7 | 1 | 1 | static | <kw>—pay # life | Ward—Pay # life |
| 4 | 7 | 1 | 1 | sentence | activate only during your turn | Activate only during your turn |
| 4 | 7 | 1 | 6 | static | as long as your devotion to <color> and <color> is less than #, ~ isn't a <obj> | As long as your devotion to red and white is less than seven, ~ isn't a creature |
| 4 | 6 | 2 | 2 | sentence | exile all <zone> | exile all graveyards |
| 4 | 6 | 2 | 1 | condition | this is the second time this <obj> has resolved this turn | this is the second time this ability has resolved this turn |
| 4 | 5 | 3 | 5 | cost | tap # untapped <subtype> you control | Tap three untapped Zombies you control |
| 4 | 5 | 3 | 1 | sentence | this <obj> costs {m} less to activate for each legendary <obj> you control | This ability costs {} less to activate for each legendary creature you control |
| 4 | 5 | 3 | 1 | sentence | you gain life equal to the life lost this way | You gain life equal to the life lost this way |
| 4 | 4 | 4 | 4 | static | <color> <obj> <obj> you cast cost {m} less to cast | White creature spells you cast cost {} less to cast |
| 4 | 4 | 4 | 4 | static | <obj> your <player> control lose <kw> and can't have or gain <kw> | Creatures your opponents control lose trample and can't have or gain trample |
| 4 | 4 | 4 | 4 | static | as an additional cost to cast <color> <obj> <obj>, you may pay # life. those <obj> cost {m} less to cast if you paid life this way. this effect reduces only the amount of <color> mana you pay | As an additional cost to cast green permanent spells, you may pay # life. Those spells cost {} less to cast if you paid life this way. This effect reduces only the amount of green mana you pay |
| 4 | 4 | 4 | 2 | sentence | create a #/# <color> <subtype> <obj> <obj> with "whenever you cast a noncreature <obj>, this <obj> deals # damage to each <player>." | create a #/# black Wizard creature token with "Whenever you cast a noncreature spell, this token deals # damage to each opponent." |
| 4 | 4 | 4 | 3 | static | enchanted <obj> loses all <obj> and is a <color> <subtype> <obj> with base power and toughness #/# | Enchanted creature loses all abilities and is a blue Frog creature with base power and toughness #/# |
| 4 | 4 | 4 | 4 | static | other <subtype> <obj> you control get +#/+# and have <kw> | Other Goblin creatures you control get +#/+# and have haste |

## Top 60 prefixes

| weight | cards | finishes | keys | stage | prefix |
|---:|---:|---:|---:|---|---|
| 63 | 90 | 36 | 69 | trigger-head | whenever # or more |
| 56.5 | 76 | 37 | 69 | sentence | until end of |
| 47 | 66 | 28 | 63 | static | as long as |
| 37 | 74 | 0 | 1 | condition | you do |
| 37 | 47 | 27 | 48 | sentence | search your <zone> |
| 33.5 | 46 | 21 | 38 | sentence | create a #/# |
| 32.5 | 43 | 22 | 37 | sentence | add # mana |
| 25.5 | 40 | 11 | 30 | sentence | you may cast |
| 25 | 34 | 16 | 33 | sentence | spend this mana |
| 24 | 44 | 4 | 14 | trigger-head | at the beginning of |
| 24 | 38 | 10 | 37 | static | equipped <obj> gets |
| 24 | 35 | 13 | 32 | sentence | create a <obj> |
| 23.5 | 33 | 14 | 24 | trigger-head | whenever you cast a |
| 22 | 35 | 9 | 22 | sentence | ~ deals # |
| 22 | 32 | 12 | 29 | static | <obj> you control |
| 20.5 | 38 | 3 | 23 | sentence | exile the top |
| 20 | 32 | 8 | 29 | sentence | put a <counter> |
| 19.5 | 36 | 3 | 32 | sentence | you may put |
| 18.5 | 24 | 13 | 16 | static | other <subtype> you |
| 18 | 20 | 16 | 20 | static | you may have |
| 17.5 | 26 | 9 | 22 | trigger-head | whenever a <obj> you |
| 17.5 | 24 | 11 | 23 | static | if a <obj> |
| 17 | 22 | 12 | 22 | sentence | create # #/# |
| 16.5 | 25 | 8 | 3 | trigger-head | whenever equipped <obj> deals |
| 16 | 32 | 0 | 20 | sentence | look at the |
| 15.5 | 23 | 8 | 19 | static | if you would |
| 14.5 | 26 | 3 | 2 | trigger-head | when you cast ~ |
| 14.5 | 24 | 5 | 24 | sentence | you get an |
| 14.5 | 23 | 6 | 22 | sentence | for each <player>, |
| 14.5 | 21 | 8 | 17 | static | enchanted <obj> gets |
| 14.5 | 20 | 9 | 17 | static | <obj> <obj> you |
| 14.5 | 18 | 11 | 18 | sentence | for each <obj> |
| 14 | 18 | 10 | 16 | sentence | destroy all <obj> |
| 14 | 17 | 11 | 17 | static | equipped <obj> has |
| 14 | 17 | 11 | 15 | static | you may cast |
| 13.5 | 16 | 11 | 13 | sentence | target <obj> you |
| 13 | 23 | 3 | 22 | static | as ~ enters, |
| 13 | 19 | 7 | 10 | trigger-head | whenever a <player> casts |
| 12.5 | 18 | 7 | 17 | sentence | ~ deals damage |
| 12.5 | 17 | 8 | 17 | sentence | <obj> you control |
| 12.5 | 17 | 8 | 3 | sentence | the ring tempts |
| 12.5 | 13 | 12 | 13 | static | commander <obj> you |
| 12 | 16 | 8 | 13 | sentence | draw <obj> equal |
| 12 | 15 | 9 | 15 | static | <obj> your <player> |
| 11.5 | 19 | 4 | 3 | trigger-head | whenever equipped <obj> attacks |
| 11.5 | 17 | 6 | 17 | static | during your turn, |
| 11.5 | 15 | 8 | 15 | sentence | double the number |
| 11 | 22 | 0 | 11 | sentence | you may pay |
| 10.5 | 18 | 3 | 13 | sentence | choose target <obj> |
| 10.5 | 15 | 6 | 12 | cost | sacrifice # <subtype> |
| 10 | 20 | 0 | 1 | sentence | level # |
| 10 | 19 | 1 | 17 | sentence | you may play |
| 10 | 16 | 4 | 11 | sentence | you create a |
| 10 | 12 | 8 | 12 | sentence | create a number |
| 10 | 12 | 8 | 1 | trigger-head | whenever ~ is dealt |
| 10 | 11 | 9 | 10 | sentence | return all <obj> |
| 9.5 | 19 | 0 | 10 | condition | it's a <obj> |
| 9.5 | 16 | 3 | 11 | sentence | return ~ to |
| 9.5 | 16 | 3 | 14 | sentence | you may have |
| 9.5 | 14 | 5 | 13 | sentence | return up to |

## Nested causes (what a registry rule's own sub-parse could not claim; not a line's cause without --nested)

| cards | lines | key | e.g. |
|---:|---:|---|---|
| 3 | 3 | sentence\|draw cards equal to the greatest number of cards a player discarded this way | Windfall |
| 2 | 6 | sentence\|shuffle the cards from your hand into your library | Molten Psyche |
| 2 | 2 | sentence\|Discard up to two cards | Daretti, Scrap Savant |
| 2 | 2 | sentence\|discard three cards at random | Balor |
| 2 | 2 | sentence\|graveyard into your library | Echo of Eons |
| 2 | 2 | sentence\|shuffle your hand and graveyard into your library | Echo of Eons |
| 1 | 3 | sentence\|exile cards from the top of your library until you exile a nonland card with a different name than that spell | Tibalt's Trickery |
| 1 | 3 | sentence\|put the cards in your hand on the bottom of your library in any order | Teferi's Puzzle Box |
| 1 | 3 | sentence\|search your library for a colorless creature card with mana value # or greater, reveal it | Conduit of Ruin |
| 1 | 2 | sentence\|you create three Treasure tokens | Ziatora, the Incinerator |
| 1 | 2 | sentence\|~ you create three Treasure tokens | Ziatora, the Incinerator |
| 1 | 1 | sentence\|Discard all the cards in your hand | Tolarian Winds |
| 1 | 1 | sentence\|Exile all attacking creatures target player controls | Settle the Wreckage |
| 1 | 1 | sentence\|copy that spell, | Krark, the Thumbless |
| 1 | 1 | sentence\|create X #/# colorless Gnome artifact creature tokens that are tapped and attacking | Anim Pakal, Thousandth Moon |
| 1 | 1 | sentence\|create an X/# red Phyrexian Horror creature token with trample and haste | Urabrask's Forge |
| 1 | 1 | sentence\|discard up to two cards | Joshua, Phoenix's Dominant // Phoenix, Warden of Fire |
| 1 | 1 | sentence\|draw another card if the sacrificed permanent was a commander | Tevesh Szat, Doom of Fools |
| 1 | 1 | sentence\|draw cards equal to the damage dealt to target opponent this turn | Knollspine Dragon |
| 1 | 1 | sentence\|draw cards equal to your devotion to red | Clive, Ifrit's Dominant // Ifrit, Warden of Inferno |
| 1 | 1 | sentence\|each opponent who didn't discard a nonland card this way you lose # life | Kroxa, Titan of Death's Hunger |
| 1 | 1 | sentence\|each player who drew a card this way you gain # life | Kwain, Itinerant Meddler |
| 1 | 1 | sentence\|exile all cards from that player's hand | Elder Brain |
| 1 | 1 | sentence\|exile it | Gossip's Talent |
| 1 | 1 | sentence\|exiles cards from the top of their library until they exile a nonland card with a different name than that spell | Tibalt's Trickery |
| 1 | 1 | sentence\|he deals X damage to any target | Ajani, Nacatl Pariah // Ajani, Nacatl Avenger |
| 1 | 1 | sentence\|he deals damage equal to the number of creatures you control to any target | Ajani, Nacatl Pariah // Ajani, Nacatl Avenger |
| 1 | 1 | sentence\|put that card on top | Conduit of Ruin |
| 1 | 1 | sentence\|put them into their owner's graveyard | Valakut Exploration |
| 1 | 1 | sentence\|put up to X land cards from your hand onto the battlefield tapped | The Gitrog, Ravenous Ride |
| 1 | 1 | sentence\|put up to X land cards from your hand onto the battlefield tapped, where X is the sacrificed creature's power | The Gitrog, Ravenous Ride |
| 1 | 1 | sentence\|reveal a creature card of the chosen type from among them | Icon of Ancestry |
| 1 | 1 | sentence\|reveal a creature card with mana value less than or equal to the number of lands you control from among them | Loot, Exuberant Explorer |
| 1 | 1 | sentence\|reveal a creature or land card from among them | Seismic Sense |
| 1 | 1 | sentence\|reveal an enchantment card from among them | Calix, Destiny's Hand |
| 1 | 1 | sentence\|sacrifice a creature or planeswalker, discard a card, | Archon of Cruelty |
| 1 | 1 | sentence\|sacrifice any number of other permanents | God-Eternal Bontu |
| 1 | 1 | sentence\|sacrifice it | RMS Titanic |
| 1 | 1 | sentence\|search your library for a Plains card | Claim Jumper |
| 1 | 1 | sentence\|search your library for a creature card with mana value # or greater, reveal it, put it into your hand | Fierce Empath |
| 1 | 1 | sentence\|search your library for a creature card with toughness # or less, reveal it, put it into your hand | Recruiter of the Guard |
| 1 | 1 | sentence\|search your library for a land card | Tempt with Discovery |
| 1 | 1 | sentence\|search your library for a land card with a basic land type, put it onto the battlefield | Boseiju, Who Endures |
| 1 | 1 | sentence\|search your library for an Aura card with mana value less than or equal to that Aura and with a different name than each Aura you control, put that card onto the battlefield attached to ~ | Light-Paws, Emperor's Voice |
| 1 | 1 | sentence\|search your library for an artifact card with mana value #, reveal it, put it into your hand | Trophy Mage |
| 1 | 1 | sentence\|search your library for an artifact card with mana value #, reveal that card, put it into your hand | Tribute Mage |
| 1 | 1 | sentence\|search your library for an artifact card, put it into your graveyard | Goblin Engineer |
| 1 | 1 | sentence\|search your library for up to X basic land cards, where X is the total amount of mana paid this way, put them onto the battlefield tapped | Collective Voyage |
| 1 | 1 | sentence\|search your library for up to two artifact, creature, and/or enchantment cards with mana value # or less, reveal them, put them into your hand | Brightglass Gearhulk |
| 1 | 1 | sentence\|target player may search their library for X basic land cards, put those cards onto the battlefield tapped | Settle the Wreckage |
| 1 | 1 | sentence\|who controlled one of those permanents exile cards from the top of your library until you exile a nonland card | Guff Rewrites History |
| 1 | 1 | sentence\|who didn't choose the lowest number discard your hand | Wheel of Misfortune |
| 1 | 1 | sentence\|~ deals X damage to the player or planeswalker ~'s attacking | Myr Battlesphere |
| 1 | 1 | sentence\|~ planeswalker your opponents control | Volcanic Torrent |
