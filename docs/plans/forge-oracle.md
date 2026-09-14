# Forge as a cross-check oracle

Decided 2026-09-14 from the owner's note `forge consideration.txt` (2026-09-06). Runs as one tooling slice
(`docs/workflows/tooling-slice.js` + `docs/workflows/briefs/forge-slice.md`) BEFORE the pool-wide parser wave 9.1p,
so the wave's merge gate and the Phase 10 judges get a second, independent reading of every card.

## Context

Forge (github.com/Card-Forge/forge, GPL-3.0) carries one human-written script per Magic card. Each script is a
small text file whose ability lines make explicit exactly the facts the 10.0 / 10.1 judges rejected scripts for:
the trigger event, whether an effect has a target and how many, whether a target is "up to", whether an ability is
"you may", which token is created, the literal magnitudes. Today the only independent check on a card this engine
claims is a 20-card `parse:diff` sample per parser family plus a sampled judge; a wrong parser rule is wrong across
hundreds of cards at once. A mechanical structural diff against Forge over every card a wave newly claims is a far
stronger per-merge gate, and over the whole claimed pool it is the calibration number the programme lacks: how often
the parser is wrong on a card it claims.

What this is NOT: a translator. Forge's `Execute$` / `SubAbility$` chains and `SVar` indirection encode timing and
choice differently from this engine's ops and composition core; a translator would produce plausible-but-wrong
scripts at scale — the failure mode the whole verification stack exists to prevent. Forge's scripts are read
locally as a comparison source only. **No Forge text is committed to this repository**: the checkout lives outside
it, test fixtures are synthetic, and the reports quote oracle text (which is not Forge's) plus Forge parameter names
and values, never whole script files. Forge's token catalogue is NOT extracted either: Scryfall's bulk data already
carries every token as a card object (`layout: token`) with `all_parts` links — that is the licence-free source if
the token vocabulary is ever tabulated.

## The checkout (done 2026-09-14)

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/Card-Forge/forge.git C:/Users/vprog/dev/forge
cd C:/Users/vprog/dev/forge && git sparse-checkout set forge-gui/res/cardsfolder forge-gui/res/tokenscripts
```

`C:/Users/vprog/dev/forge/forge-gui/res` at Forge commit ff6b6c3d (2026-09-14): **33,805 card files** under
`cardsfolder/<letter>/<name>.txt` (`Name:` is exact; the file name is normalised) and **851 token scripts** under
`tokenscripts/<id>.txt`. `src/config/paths.ts` resolves it as `FORGE_RES()`: `MTG_FORGE_RES` if set, else
`<main checkout>/../forge/forge-gui/res` (a linked worktree resolves through `mainCheckoutOf`, like `DATA_DIR`).

## The format (measured on the checkout)

Field keys over all files: `SVar:` 59,722 · `Name:` / `Types:` / `Oracle:` 34,757 · `ManaCost:` 34,756 · `PT:` 19,261 ·
`A:` 18,509 (activated / spell abilities) · `K:` 18,305 (keywords, 244 distinct spellings, parameters after `:`) ·
`T:` 17,093 (triggers) · `S:` 7,120 (statics) · `R:` 1,696 (replacements) · `AlternateMode:` 909 · `Colors:` 379 ·
`Loyalty:` 355 · `Defense:` 37. `DeckHas:` / `DeckHints:` / `DeckNeeds:` / `AI:` / `Draft:` and the AI-only SVars
(`PlayMain1`, `AIPreference`, `SacMeAfterBlock`, `NonStackingEffect`, `RemAIDeck`, …) are deck-building and AI hints:
ignore them.

Shapes:

```
A:SP$ DealDamage | ValidTgts$ Any | NumDmg$ 3 | SpellDescription$ CARDNAME deals 3 damage to any target.      (spell)
A:AB$ Mana | Cost$ T | Produced$ G | SpellDescription$ Add {G}.                                                (activated)
A:AB$ ChangeZone | Cost$ Sac<1/CARDNAME> | Origin$ Library | Destination$ Battlefield | ... | SpellDescription$ ...
T:Mode$ ChangesZone | Origin$ Any | Destination$ Battlefield | ValidCard$ Card.Self | Execute$ TrigDraw | TriggerDescription$ When CARDNAME enters, draw two cards.
SVar:TrigDraw:DB$ Draw | Defined$ You | NumCards$ 2
T:Mode$ Phase | Phase$ Upkeep | ValidPlayer$ You | TriggerZones$ Battlefield | Execute$ TrigX | TriggerDescription$ At the beginning of your upkeep, ...
T:Mode$ SpellCast | ValidCard$ Card | ValidActivatingPlayer$ Opponent | ... | TriggerDescription$ Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.
SVar:TrigDraw:DB$ Draw | Defined$ You | UnlessCost$ 1 | UnlessPayer$ TriggeredActivator | NumCards$ 1 | OptionalDecider$ You
S:Mode$ Continuous | Affected$ Creature.YouCtrl | AddPower$ 1 | AddToughness$ 1 | Description$ Creatures you control get +1/+1.
R:Event$ Moved | ActiveZones$ Battlefield | Destination$ Graveyard | ValidCard$ Card | ReplaceWith$ Exile | Description$ If a card or token would be put into a graveyard from anywhere, exile it instead.
SVar:TrigCharm:DB$ Charm | Choices$ DBToken,DBUnblockable,DBExileTop | ChoiceRestriction$ ThisTurn              (modes)
SVar:DBUnblockable:DB$ Pump | ValidTgts$ Creature | KW$ HIDDEN CARDNAME can't block. | IsCurse$ True | SpellDescription$ Target creature can't block this turn.
A:SP$ Token | TokenAmount$ 2 | TokenScript$ w_1_1_soldier | TokenOwner$ You | SpellDescription$ Create two 1/1 white Soldier creature tokens.
A:SP$ DealDamage | ValidTgts$ Any | NumDmg$ 2 | TargetMin$ 1 | TargetMax$ 2 | DividedAsYouChoose$ 2 | ...       (one or two targets)
```

- An ability's effect is the `DB$`/`SP$`/`AB$` name; a chain continues through `Execute$ <SVar>` (triggers) and
  `SubAbility$ <SVar>` (the next effect). `SVar:<name>:DB$ …` resolves the name. Top effect names: ChangeZone 6,633 ·
  Pump 5,007 · Draw 3,755 · Token 3,595 · PutCounter 3,316 · Cleanup 3,002 (bookkeeping — ignore) · DealDamage 2,876 ·
  Mana 2,509 · Effect 1,923 · GainLife 1,788 · Destroy 1,552 · Tap 1,472 · LoseLife 1,218 · Discard 1,103 · PumpAll
  1,054 · Animate 1,028 · Dig 989 · Sacrifice 895 · Charm 804 (modes) · ChangeZoneAll 671 · Mill 592 · Counter 537 ·
  Untap 484 · DelayedTrigger 476 · Scry 454 · ChooseCard 447 · DamageAll 427 · CopyPermanent 369 · DestroyAll 366 ·
  RepeatEach 363 · SetState 348 · GainControl 328 · Play 326 · ImmediateTrigger 324 (reflexive "when you do").
- **Targets**: `ValidTgts$ <filter>` on the effect that targets; `TargetMin$ 0` = "up to" (1,344 files);
  `TargetMax$ N` = "up to N"; `TgtPrompt$` is UI text. `Defined$ You/Self/TriggeredCard/Remembered/…` = no target.
- **Optional**: `OptionalDecider$ You` on the effect (1,500 files) = "you may"; `Optional$ True` on some; `UnlessCost$`
  / `UnlessPayer$` = "unless … pays". `RevealOptional$`, `Optional$` inside Dig etc. are effect-internal choices.
- **Descriptions**: `SpellDescription$` (17,302 files), `TriggerDescription$` (14,890) and `| Description$` (9,100)
  carry the oracle sentence the ability implements with `CARDNAME` for the card's name and `ABILITY` as a placeholder
  when the modes follow — the alignment key against this engine's per-line `text`. Some abilities have none (the
  `Oracle:` line then holds the whole text with `\n` between lines).
- **Trigger modes** (top): ChangesZone 7,570 · Continuous (static) 4,830 · Phase 2,375 · Attacks 1,607 · SpellCast
  1,413 · Event$ Moved 957 (replacement) · DamageDone 875 · ReduceCost 530 · CantBlockBy 364 · AttackersDeclared 242 ·
  Event$ DamageDone 218 · DamageDoneOnce 206 · CantAttack 204 · Event$ Untap 157 · Drawn 149 · AlternativeCost 148 ·
  CantBlock 139 · Blocks 128 · AttackerBlocked 127 · TurnFaceUp 126 · ChangesZoneAll 126 · BecomesTarget 118 ·
  Event$ Counter 118 · Sacrificed 115 · Taps 112 · CantBeCast 103 · AttackerBlockedByCreature 102 · MustAttack 101 ·
  RaiseCost 96 · LifeGained 94 · Discarded 83 · Cycled 78 · TapsForMana 65 · CounterAddedOnce 47 · LandPlayed 42.
- **Faces**: `AlternateMode:` DoubleFaced 399 · Adventure 151 · Split 128 · Modal 100 · Prepare 62 · Flip 20 ·
  Specialize 19 · Omen 16; the other face follows a line `ALTERNATE` (882 files) with its own `Name:` — index each
  face name AND the joined `Front // Back` name (this engine's `CardDef.name` for multi-face cards is the joined
  Scryfall name; `CardDB.get` also matches a front-face name).
- **Tokens**: `TokenScript$ <id>` (3,392 files) names `tokenscripts/<id>.txt`: `Name:`, `ManaCost:no cost`, `Colors:`,
  `Types:`, `PT:`, `K:` lines — the token's exact shape.

## Design

1. **Loader** (`src/cards/forge/loader.ts`): read the checkout once per process into an index keyed by face name and
   joined name; parse a file into faces, each face into typed fields (`K:` list, `A:`/`T:`/`S:`/`R:` lines as
   `key$ value` parameter maps, `SVar` map, `Oracle`, `AlternateMode`). Resolve `Execute$` / `SubAbility$` chains
   and `TokenScript$` ids. A JSON cache under `data/master/` (gitignored) keyed by the checkout's HEAD + file count
   keeps a whole-pool run under 90 s.
2. **Shapes** (`src/cards/forge/shape.ts`): the same `AbilityShape` record built from both sides — class
   (keyword / activated / triggered / static / replacement / spell), the description or `text`, the trigger kind
   (Forge `Mode$` + qualifiers mapped to this engine's `on` kinds through a table that leaves unmapped modes OUT),
   the effect chain (names), targets (`{ optional, max }` per targeting effect), `optional` (you may), `unless`,
   token specs (P/T, colours, types, subtypes, keywords), literal magnitudes, mode counts. Our side is built from a
   `CardDef` (parser-alone through the `.no-scripts` store as `scripts/parse-snapshot.ts` does, or scripted through
   `CardDB`), every face.
3. **Comparator** (`src/cards/forge/compare.ts`): align abilities by description-vs-text (name → `~`, lowercase,
   punctuation stripped, token Jaccard ≥ 0.5), fall back to class + printed order; emit findings by category:
   `ability-count`, `trigger-kind`, `target-missing`, `target-extra`, `target-optionality`, `may-missing`,
   `may-extra`, `token-shape`, `magnitude`, `mode-count`, `keyword-set`, `unless-cost`, `unmatched-forge-ability`.
   A finding is a claim to verify, never a verdict: Forge is sometimes wrong and its encoding is sometimes just
   different. The **calibration run** measures, per category, the disagreement rate over the cards the parser fully
   claims and the precision of a deterministic labelled sample (`parser-wrong` / `forge-wrong` /
   `encoding-difference`); only categories whose measured precision earns it are fed to the merge gate as a hard
   signal — the rest stay advisory in the judge prompt.
4. **CLI** `npm run forge:diff` (`scripts/forge-diff.ts`): `--tier`, `--select` (the `scripts:queue` mini-language),
   `--ids`, `--claimed` (the calibration set: fully parsed, parser-alone), `--scripted` (compare the scripted
   `CardDef` of every card with a script), `--changed` (only the cards whose parse moved against
   `data/master/parse-snapshot.json` — the per-merge mode of the parser wave), `--out` / `--md`, deterministic
   bytes, no timestamps.
5. **Consumers**: the parser wave's per-merge gate (`forge:diff --changed` after `parse:diff`, before
   `parse:accept`; the reviewer lens of `parse-wave.js` runs it in the worktree), the Phase 10 judge prompt
   (`forge:diff --ids … --scripted` per batch — each finding is a line to check against the printed text), and
   docs/HANDOFF.md's calibration number.

## What it cannot do

Forge encodes some things differently (two `T:` lines for "attacks or blocks", `Charm` for modes, `Effect` +
`StaticAbilities$` for "until end of turn" statics, `RepeatEach` for "for each"); raw disagreement is not a verdict.
Un-set and Alchemy cards may have no Forge file (`no-forge-file` is a card status, not a finding). Second faces of
split / adventure / flip cards are unparsed on this side unless scripted — compared only in `--scripted` mode.
