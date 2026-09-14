# forge:diff — the Forge cross-check

forge:diff — 140 cards (scripted), 140 with a Forge file, 84 agree / 56 disagree, 1 second face skipped; Forge ff6b6c3d (34656 files)

A finding is a claim to verify against the printed text, never a verdict: Forge is sometimes wrong and its encoding is sometimes just different. Rate = cards with a finding of the category over the cards with a Forge file. Labelled precision = the calibration sample (data/master/forge-calibration.json, Forge ff6b6c3d): how many of the labelled findings were the parser's fault.

| category | cards | findings | rate | labelled precision |
|---|---:|---:|---:|---:|
| ability-count | 21 | 34 | 15.0% | 0/4 parser-wrong |
| trigger-kind | 2 | 2 | 1.4% | 4/4 parser-wrong |
| target-missing | 6 | 6 | 4.3% | 4/4 parser-wrong |
| target-extra | 1 | 1 | 0.7% | 0/4 parser-wrong |
| target-optionality | 3 | 3 | 2.1% | 3/4 parser-wrong |
| may-missing | 2 | 2 | 1.4% | 0/3 parser-wrong |
| may-extra | 3 | 3 | 2.1% | 0/4 parser-wrong |
| token-shape | 7 | 7 | 5.0% | 1/2 parser-wrong |
| magnitude | 10 | 10 | 7.1% | 1/4 parser-wrong |
| mode-count | 0 | 0 | 0.0% | 1/2 parser-wrong |
| keyword-set | 10 | 10 | 7.1% | 2/4 parser-wrong |
| unless-cost | 0 | 0 | 0.0% | — |
| unmatched-forge-ability | 1 | 1 | 0.7% | 3/4 parser-wrong |

## ability-count

- Stormchaser's Talent — ours: 3 triggered / forge: 1 triggered (triggered)
- Stormchaser's Talent — ours: 2 activated / forge: 0 activated (activated)
- Cool but Rude — ours: 3 triggered / forge: 1 triggered (triggered)
- Cool but Rude — ours: 2 activated / forge: 0 activated (activated)
- The Serpent Society — ours: 2 triggered / forge: 1 triggered (triggered)

## trigger-kind

- Relic Retriever — ours: leaves-graveyard / forge: end-step (at the beginning of each end step if a card left your graveyard this turn create a treasure token)
- Archaeomancer's Map — ours: etb / forge: landfall (whenever a land enters under an opponent s control if that player controls more lands than you you may put a land card f)

## target-missing

- Eldrazi Confluence — ours: no target / forge: 1 target, 1 target (choose three you may choose the same mode more than once target creature gets 3 3 until end of turn exile target nonland)
- Breeches, Eager Pillager — ours: no target / forge: 1 target (whenever a pirate you control attacks create a treasure token target creature can t block this turn exile the top card o)
- Rot Hulk — ours: no target / forge: up to 1 target (when ~ enters return up to x target zombie cards from your graveyard to the battlefield where x is the number of opponen)
- Fiery Confluence — ours: no target / forge: 1 target (choose three you may choose the same mode more than once fiery confluence deals 1 damage to each creature fiery confluen)
- Silent Hallcreeper — ours: no target / forge: 1 target (whenever ~ deals combat damage to a player put two 1 1 counters on ~ draw a card ~ becomes a copy of another target crea)

## target-extra

- Toph, the Blind Bandit — ours: 1 target / forge: no target (when ~ enters earthbend 2)

## target-optionality

- Perpetual Timepiece — ours: up to 99 targets / forge: up to 1 target (shuffle any number of target cards from your graveyard into your library)
- Untimely Malfunction — ours: 1 target, 1 target, up to 2 targets / forge: 1 target, 1 target, 2 targets (choose one destroy target artifact change the target of target spell or ability with a single target one or two target c)
- Kozilek's Command — ours: 1 target, 1 target, up to 1 target / forge: 1 target, 1 target, 1 target, up to 1 target (choose two target player creates x 0 1 colorless eldrazi spawn creature tokens with sacrifice ~ add c target player scri)

## may-missing

- Cool but Rude — ours: mandatory / forge: you may (whenever you attack you may discard a card if you do draw a card)
- Timeless Witness — ours: mandatory / forge: you may (when ~ enters you may return target card from your graveyard to your hand)

## may-extra

- Fire Lord Azula — ours: you may / forge: mandatory (whenever you cast a spell while ~ is attacking copy that spell you may choose new targets for the copy)
- Deflecting Swat — ours: you may / forge: mandatory (you may choose new targets for target spell or ability)
- Dowsing Dagger // Lost Vale — ours: you may / forge: mandatory (whenever ~ deals combat damage to a player you may transform ~)

## token-shape

- Crib Swap — ours: 1/1 colorless Creature Shapeshifter / forge: 1/1 colorless Creature Shapeshifter changeling (exile target creature its controller creates a 1 1 colorless shapeshifter creature token with changeling)
- Mirrex — ours: 1/1 colorless Artifact Creature Mite Phyrexian cant block, toxic / forge: 1/1 colorless Artifact Creature Mite Phyrexian toxic (create a 1 1 colorless phyrexian mite artifact creature token with toxic 1 and ~ can t block)
- Maskwood Nexus — ours: 2/2 U Creature Shapeshifter / forge: 2/2 U Creature Shapeshifter changeling (create a 2 2 blue shapeshifter creature token with changeling)
- Springleaf Parade — ours: 1/1 colorless Creature Shapeshifter / forge: 1/1 colorless Creature Shapeshifter changeling (when ~ enters create x 1 1 colorless shapeshifter creature tokens with changeling)
- Black Market Connections — ours: - colorless Artifact Treasure \| 3/2 colorless Creature Shapeshifter / forge: - colorless Artifact Treasure \| 3/2 colorless Creature Shapeshifter changeling (at the beginning of your first main phase sell contraband create a treasure token you lose 1 life buy information draw a)

## magnitude

- Victimize — ours: 2 / forge: none (choose two target creature cards in your graveyard sacrifice a creature if you do return the chosen cards to the battlef)
- Kozilek's Command — ours: 2 / forge: none (choose two target player creates x 0 1 colorless eldrazi spawn creature tokens with sacrifice ~ add c target player scri)
- Bow of Nylea — ours: 2, 3, 4 / forge: 2, 3 (1 g t choose one put a 1 1 counter on target creature bow of nylea deals 2 damage to target creature with flying you gai)
- Fiery Confluence — ours: 2, 3 / forge: 2 (choose three you may choose the same mode more than once fiery confluence deals 1 damage to each creature fiery confluen)
- Nissa, Worldwaker — ours: 99 / forge: none (search your library for any number of basic land cards put them onto the battlefield then shuffle those lands become 4 4)

## keyword-set

- The Serpent Society — ours: deathtouch / forge: deathtouch, ward (keywords)
- Woe Strider — ours: escape / forge: as-enters, escape (keywords)
- Iridescent Vinelasher — ours: kicker / forge: none (keywords)
- Darkstar Augur — ours: flying, kicker / forge: flying (keywords)
- Pentad Prism — ours: none / forge: as-enters (keywords)

## unmatched-forge-ability

- Deflecting Swat — ours: no partner / forge: static: (no chain) (if you control a commander you may cast ~ without paying its mana cost)

