# forge:diff — the Forge cross-check

forge:diff — 12837 cards (claimed), 12829 with a Forge file, 12185 agree / 644 disagree, 0 second faces skipped; Forge ff6b6c3d (34656 files)

A finding is a claim to verify against the printed text, never a verdict: Forge is sometimes wrong and its encoding is sometimes just different. Rate = cards with a finding of the category over the cards with a Forge file. Labelled precision = the calibration sample (data/master/forge-calibration.json, Forge ff6b6c3d): how many of the labelled findings were the parser's fault.

| category | cards | findings | rate | labelled precision |
|---|---:|---:|---:|---:|
| ability-count | 403 | 430 | 3.1% | 0/4 parser-wrong |
| trigger-kind | 30 | 30 | 0.2% | 4/4 parser-wrong |
| target-missing | 8 | 8 | 0.1% | 4/4 parser-wrong |
| target-extra | 27 | 27 | 0.2% | 0/4 parser-wrong |
| target-optionality | 26 | 26 | 0.2% | 3/4 parser-wrong |
| may-missing | 3 | 3 | 0.0% | 0/3 parser-wrong |
| may-extra | 79 | 81 | 0.6% | 0/4 parser-wrong |
| token-shape | 2 | 2 | 0.0% | 1/2 parser-wrong |
| magnitude | 108 | 108 | 0.8% | 1/4 parser-wrong |
| mode-count | 2 | 2 | 0.0% | 1/2 parser-wrong |
| keyword-set | 6 | 6 | 0.1% | 2/4 parser-wrong |
| unless-cost | 0 | 0 | 0.0% | — |
| unmatched-forge-ability | 4 | 4 | 0.0% | 3/4 parser-wrong |

## ability-count

- Waterknot — ours: 1 static / forge: 0 static (static)
- Soul-Scar Mage — ours: 1 static / forge: 0 static (static)
- Utopia Sprawl — ours: 0 triggered / forge: 1 triggered (triggered)
- Utopia Sprawl — ours: 1 static / forge: 0 static (static)
- Doubling Season — ours: 2 static / forge: 0 static (static)

## trigger-kind

- Vedalken Heretic — ours: combat-damage-player / forge: deals-damage (whenever ~ deals damage to an opponent you may draw a card)
- Saltwater Stalwart — ours: combat-damage-player / forge: deals-damage (whenever ~ deals damage to an opponent target player draws a card)
- Hunting Cheetah — ours: combat-damage-player / forge: deals-damage (whenever ~ deals damage to an opponent you may search your library for a forest card reveal that card put it into your h)
- Reef Pirates — ours: combat-damage-player / forge: deals-damage (whenever ~ deals damage to an opponent that player mills a card)
- Thieving Magpie — ours: combat-damage-player / forge: deals-damage (whenever ~ deals damage to an opponent draw a card)

## target-missing

- Vat Emergence — ours: no target / forge: 1 target (put target creature card from a graveyard onto the battlefield under your control proliferate)
- Endless Obedience — ours: no target / forge: 1 target (put target creature card from a graveyard onto the battlefield under your control)
- Shaman of the Pack — ours: no target / forge: 1 target (when ~ enters target opponent loses life equal to the number of elves you control)
- Reanimate — ours: no target / forge: 1 target (put target creature card from a graveyard onto the battlefield under your control you lose life equal to its mana value)
- Dream Beavers — ours: no target / forge: 1 target (when ~ enters each opponent loses 1 life and you gain 1 life scry 1)

## target-extra

- Earth Village Ruffians — ours: 1 target / forge: no target (when ~ dies earthbend 2)
- Expedition Raptor — ours: up to 2 targets / forge: no target (when ~ enters support 2)
- Aerie Auxiliary — ours: up to 2 targets / forge: no target (when ~ enters support 2)
- Stockpiling Celebrant — ours: 1 target / forge: no target (when ~ enters you may return another target nonland permanent you control to its owner s hand if you do scry 2)
- Badgermole — ours: 1 target / forge: no target (when ~ enters earthbend 2)

## target-optionality

- Eerie Interlude — ours: up to 99 targets / forge: up to 1 target (exile any number of target creatures you control return those cards to the battlefield under their owner s control at th)
- Inferno Titan — ours: up to 3 targets / forge: 3 targets (whenever ~ enters or attacks it deals 3 damage divided as you choose among one two or three targets)
- Conflagrate — ours: up to 3 targets / forge: up to 1 target (~ deals x damage divided as you choose among any number of targets)
- Clash of Titans — ours: 1 target / forge: 2 targets (target creature fights another target creature)
- Fight with Fire — ours: up to 3 targets, 1 target / forge: 1 target, up to 1 target (~ deals 5 damage to target creature if ~ was kicked it deals 10 damage divided as you choose among any number of targets)

## may-missing

- Blood Speaker — ours: mandatory / forge: you may (whenever a demon you control enters you may return ~ from your graveyard to your hand)
- Incinerating Blast — ours: mandatory / forge: you may (~ deals 6 damage to target creature you may discard a card if you do draw a card)
- Uro, Titan of Nature's Wrath — ours: mandatory / forge: you may (when ~ enters or attacks you gain 3 life and draw a card then you may put a land card from your hand onto the battlefiel)

## may-extra

- Puresight Merrow — ours: you may / forge: mandatory (look at the top card of your library you may exile that card)
- Nef-Crop Entangler — ours: you may / forge: mandatory (you may exert ~ as it attacks when you do it gets 1 2 until end of turn)
- Anep, Vizier of Hazoret — ours: you may / forge: mandatory (you may exert ~ as it attacks when you do exile the top two cards of your library until the end of your next turn you ma)
- Lithoform Engine — ours: you may / forge: mandatory (copy target activated or triggered ability you control you may choose new targets for the copy)
- Lithoform Engine — ours: you may / forge: mandatory (copy target instant or sorcery spell you control you may choose new targets for the copy)

## token-shape

- Awaken the Woods — ours: 1/1 G Creature Dryad Forest Land / forge: 1/1 G Creature Land Dryad Forest (create x 1 1 green forest dryad land creature tokens)
- Thranduil the Strategist — ours: 1/1 G Creature Elf / forge: 1/1 G Creature Elf Warrior (landfall whenever a land you control enters create a 1 1 green elf creature token)

## magnitude

- Earth-Cult Elemental — ours: 2 / forge: none (siege monster when ~ enters)
- Nef-Crop Entangler — ours: 2 / forge: none (you may exert ~ as it attacks when you do it gets 1 2 until end of turn)
- Goblin Artillery — ours: 2 / forge: 2, 3 (~ deals 2 damage to any target and 3 damage to you)
- Ill-Tempered Cyclops — ours: 3 / forge: none (5 r monstrosity 3)
- Anep, Vizier of Hazoret — ours: 2 / forge: none (you may exert ~ as it attacks when you do exile the top two cards of your library until the end of your next turn you ma)

## mode-count

- Golem Artisan — ours: 2 modes / forge: not modal (target artifact creature gains your choice of flying trample or haste until end of turn)
- Practiced Offense — ours: 2 modes / forge: not modal (put a 1 1 counter on each creature target player controls target creature gains your choice of double strike or lifelink)

## keyword-set

- The Cruelty of Gix — ours: as-enters / forge: none (keywords)
- Bog Badger — ours: kicker / forge: flash, kicker (keywords)
- Signal Pest — ours: flying / forge: none (keywords)
- Spire Tracer — ours: flying / forge: none (keywords)
- Orchard Spirit — ours: flying / forge: none (keywords)

## unmatched-forge-ability

- Signal Pest — ours: no partner / forge: static: (no chain) (~ can t be blocked except by creatures with flying or reach)
- Spire Tracer — ours: no partner / forge: static: (no chain) (~ can t be blocked except by creatures with flying or reach)
- Orchard Spirit — ours: no partner / forge: static: (no chain) (~ can t be blocked except by creatures with flying or reach)
- Grafted Identity — ours: no partner / forge: static: (no chain) (as an additional cost to cast ~ sacrifice a creature)

