# Brief: forge-slice — Forge's card scripts as a cross-check oracle (`forge:diff`)

Plan: `docs/plans/forge-oracle.md` — read it IN FULL first (context, the licence rule, the measured format, the design,
what the tool cannot do). Then read: `docs/workflows/README.md` ("Process rules adopted 2026-09-05"), `src/cards/types.ts`
(CardDef, Ability, TargetSpec, CoreTriggerEvent, CoreEffect — `may`, `optional-then`, `optional-pay`, `unless-pays`,
`choose-mode`, `token`, `reflexive`), `src/cards/scripts.ts` (the script format, `ScriptStore`, `applyScript`,
`secondFaceLines`), `scripts/parse-snapshot.ts` (`useBareParses` — the `.no-scripts` store; the snapshot shape and how the
changed set is computed), `scripts/parse-why.ts` (how a CLI reuses `parseSelection` / `selectionIndex` / `selected` from
`scripts/scripts-queue.ts`, `poolRows`, byte-identical output, `--md`), `src/cards/scriptState.ts` (`poolRows`,
`deriveStates`, `PLAYABLE_SQL`), `src/config/paths.ts` (`projectRoot`, `mainCheckoutOf`, `DATA_DIR`), `src/cards/db.ts`
(`CardDB.get` name matching, `all()`), `src/cards/rules/_registry.ts` + `src/engine/ops/_registry.ts` (the registered
trigger kinds beyond the core union), `docs/workflows/parse-wave.js` (the reviewer LENS and the merge-pipeline return
shape), `docs/workflows/script-wave.js` (the judge prompt), `data/scripts/reports/10.1-g1.json` (the group-1 verdicts:
which classes the judges rejected — target dropped, "may" flattened, token naming), `docs/HANDOFF.md` §11 (the Breeches
audit: a `choose-objects` standing in for a printed "target"). The Forge checkout is at
`C:/Users/vprog/dev/forge/forge-gui/res` (read-only for you; never copy a file from it into the repo — synthetic fixtures
only; never commit any of its text).

## Items

- **F-1 `FORGE_RES()`** in `src/config/paths.ts`: `MTG_FORGE_RES` if set and existing, else
  `<main checkout or root>/../forge/forge-gui/res` (resolve through `mainCheckoutOf(projectRoot())` so a linked
  worktree finds it). A missing directory throws one clear error carrying the two-line clone recipe from the plan.
- **F-2 loader** `src/cards/forge/loader.ts`: `loadForge(res = FORGE_RES())` → an index of every face by exact
  `Name:` and, for multi-face files, by the joined `Front // Back` name; `ForgeFace` = `{ name, manaCost, types,
  pt, loyalty, colors, keywords: string[], abilities: ForgeAbility[], svars: Map, oracle, alternateMode, file }`;
  `ForgeAbility` = `{ cls: 'activated'|'spell'|'triggered'|'static'|'replacement', params: Record<string,string>
  (the `Key$ value` pairs), description (SpellDescription / TriggerDescription / Description with CARDNAME → ~,
  or null), chain: ForgeEffect[] }` where the chain resolves `Execute$` then every `SubAbility$` through `SVar`
  (each `ForgeEffect` = `{ api: 'Draw'|'Token'|…, params }`, `Cleanup` dropped, cycles guarded), and `Charm`'s
  `Choices$` resolved into `modes: ForgeEffect[][]`. Token ids (`TokenScript$`) resolve through
  `tokenscripts/<id>.txt` into `{ name, colors, types, subtypes, pt, keywords }`. A JSON cache at
  `data/master/forge-index.json` (gitignored already by `data/master/*.json`) keyed by the checkout's HEAD (`git
  rev-parse HEAD` in the checkout, or the directory mtime if git is absent) + file count; a whole-checkout load
  from cache under 5 s, from files under 60 s. Deck-building and AI keys (`DeckHas`, `DeckHints`, `DeckNeeds`,
  `AI`, `Draft`, the AI-only SVars) are never read into the shape.
- **F-3 shapes** `src/cards/forge/shape.ts`: one `AbilityShape` type for both sides: `{ cls, text (normalised:
  lowercase, name → ~, punctuation and reminder text stripped), trigger?: { kinds: string[] }, effects: string[],
  targets: { optional: boolean; max: number | null }[], optional: boolean, unless: boolean, tokens: TokenShape[],
  magnitudes: number[], modes: number | null, keywords: string[] }`. `forgeShapes(face)`: `K:` lines → keyword
  shapes (a `FORGE_KEYWORD_ALIASES` table maps Forge spellings to this engine's keyword ids; unmapped spellings kept
  verbatim), `A:` → activated (`Cost$` present) or spell, `T:` → triggered with `kinds` from a `FORGE_TRIGGER_MAP`
  seeded with at least: ChangesZone(Origin Any/Hand/…, Destination Battlefield, ValidCard Card.Self) → etb;
  ChangesZone(Origin Battlefield, Destination Graveyard) → dies; ChangesZone(Origin Battlefield, Destination Any)
  → ltb; ChangesZone(Destination Battlefield, ValidCard Land…) → landfall; Phase Upkeep → upkeep; Phase End of
  Turn / EndOfTurn → end-step; Phase Draw → draw-step; Phase BeginCombat → combat-begin; Attacks → attacks;
  AttackersDeclared → you-attack; Blocks → blocks; AttackerBlocked → becomes-blocked; DamageDone (CombatDamage True,
  ValidTarget Player) → combat-damage-player; DamageDone otherwise → deals-damage; SpellCast → cast; LandPlayed →
  landfall; Drawn → draw; TurnFaceUp → turned-face-up; Sacrificed → sacrifice; Taps → tapped; BecomesTarget →
  targeted; Discarded → discard; LifeGained → life-gain; Cycled → the registered cycling trigger kind if one
  exists — complete the table from the plan's mode histogram against the trigger kinds actually registered
  (`TRIGGERS` / the `on` unions), and leave every mode you cannot map OUT of the table (an unmapped mode yields
  `kinds: []` and never a `trigger-kind` finding). `S:` → static, `R:` → replacement. Targets: every chain effect
  with `ValidTgts$` → `{ optional: TargetMin$ === '0', max: TargetMax$ number or null }`; `optional` = any
  `OptionalDecider$` / `Optional$ True` on the chain; `unless` = `UnlessCost$`; magnitudes = the literal integers of
  `NumCards$`, `NumDmg$`, `NumCounters$`, `TokenAmount$`, `LifeAmount$`, `NumCards$`, `Amount$`; `modes` = Charm
  choices count. `ourShapes(def: CardDef)`: keywords (+ parameter-bearing fields), `abilities[]` by `kind`
  (`activated` / `triggered` / `static` / `spell`), `trigger.kinds` = the `on` (flatten `or`), `targets` from every
  `TargetSpec` found at any depth in the effects (`optional`, `count` → max), `optional` = `TriggeredAbility.optional`
  or a `may` / `optional-then` / `optional-pay` at the top of the effects, `unless` = `unless-pays` / `counter.unlessPay`
  / `sacrifice-unless-pay`, tokens from `token` ops (+ `token-copy` as a token with no shape), magnitudes = the numeric
  `amount` / `count` / `power` of the top-level effects, `modes` = `choose-mode.modes.length`, plus `altCosts` /
  `kicker` / `cycling` / `asEnters` rendered as keyword shapes so Forge's `K:Kicker:…` / `K:Cycling:…` lines align.
  Every face: front and `backFace`; a split / adventure / flip second face only when the def carries a script
  (`secondFaceLines`) — otherwise skipped and counted.
- **F-4 comparator** `src/cards/forge/compare.ts`: `compareCard(ours: AbilityShape[], forge: AbilityShape[]) →
  { status: 'agree'|'disagree', findings: Finding[], alignment: … }`. Alignment: greedy best-match by token Jaccard
  over the normalised texts (≥ 0.5), same `cls` preferred, then class + printed order for the rest; a Forge
  ability with no partner → `unmatched-forge-ability` (only when our side is fully parsed, i.e. the calibration and
  changed modes; in `--scripted` mode always). Findings (`{ category, ours, forge, ability }`), categories exactly:
  `ability-count` (per class after keyword aliasing), `trigger-kind` (both mapped, no overlap), `target-missing`
  (Forge chain targets, ours has none anywhere in the ability — the Breeches class), `target-extra`,
  `target-optionality` (`optional` or `max` differ), `may-missing`, `may-extra`, `token-shape` (P/T, colours, types,
  subtypes or keywords differ), `magnitude` (literal sets differ), `mode-count`, `keyword-set`, `unless-cost`,
  `unmatched-forge-ability`. No confidence numbers are invented: the calibration run (F-7) is the only source of
  per-category precision.
- **F-5 CLI** `scripts/forge-diff.ts` + `"forge:diff": "tsx scripts/forge-diff.ts"` in package.json. Flags:
  `--tier paper|digital|un|ante|all` (default paper), `--select "<terms>"` (scripts-queue's mini-language),
  `--ids <a,b | @file>`, `--claimed` (only cards fully parsed by the PARSER ALONE — the calibration set; parser-alone
  is the default mode: `useBareParses` as parse-snapshot.ts does), `--scripted` (only cards with a script, compared
  on the SCRIPTED def through `CardDB`), `--changed` (only the cards whose parser-alone hash differs from
  `data/master/parse-snapshot.json`, computed in-process exactly as `parse:diff` does — the per-merge mode; prints
  `forge:diff — 0 changed cards` and exits 0 on a clean tree), `--category <a,b>`, `--top N` (examples per category
  in the markdown, default 5), `--out <json>`, `--md <markdown>`. Output JSON: `{ forge: { head, files }, mode,
  totals: { cards, withForgeFile, agree, disagree, skippedSecondFace }, byCategory: { [category]: { cards, findings,
  rate } }, cards: [{ oracleId, name, status, findings }] sorted by oracleId }` — no timestamp, byte-identical on a
  second run. The markdown: the totals, the per-category table (cards, findings, rate over the compared set, and —
  when `data/master/forge-calibration.json` exists — the labelled precision), then `--top` examples per category as
  `name — ours: … / forge: …`. Stdout: the totals line and the category table. The whole paper pool (`--tier paper`
  with no other filter) must finish in under 90 s from a warm cache; report the time.
- **F-6 consumers**: (a) `docs/workflows/parse-wave.js` — the reviewer LENS gains step (2b): run `npm run forge:diff --
  --changed --md <scratch>` in the worktree and, for every sampled card and every card with a `target-missing`,
  `may-missing` or `trigger-kind` finding, decide against the printed text whether the parser or Forge is right; a
  parser-wrong finding on a newly claimed line is a blocker (an over-claim), a Forge-wrong one goes in the report as
  `checksRun`; (b) `docs/workflows/script-wave.js` — the judge prompt tells the judge to run `npm run forge:diff --
  --ids <ids> --scripted --md <scratch>` and treat each finding as a line to check (Forge can be wrong; a finding is
  evidence, not a verdict); both edits keep the scripts' no-inner-backticks rule and pass the syntax check below;
  (c) `docs/workflows/README.md` — the merge procedure for parser waves gains `npm run forge:diff -- --changed` after
  `parse:diff` and before `parse:accept`, with the rule that the orchestrator reads every `target-missing` /
  `may-missing` / `trigger-kind` finding on the newly claimed cards before accepting; a `forge:diff` row in the tools
  table of `docs/vocabulary/README.md` and a short section (what a finding is, the categories, the calibration
  numbers, the licence rule, the clone recipe).
- **F-7 calibration**: run `npm run forge:diff -- --tier paper --claimed --out data/master/forge-diff.json --md
  data/master/forge-diff.md` and `npm run forge:diff -- --scripted --out <scratch>/forge-scripted.json --md
  data/master/forge-scripted.md`. Then LABEL a deterministic sample of the disagreeing claimed cards: per category,
  the first 4 by sorted oracleId (so at most 52), each read against the printed text and the parser-alone AST
  (dump it the way parse-snapshot.ts does) and labelled `parser-wrong` | `forge-wrong` | `encoding-difference` with
  a one-line reason, written to `data/master/forge-calibration.json` (`{ forgeHead, sample: [{ oracleId, name,
  category, label, reason }], precision: { [category]: { n, parserWrong } } }`) and added to `.gitignore` as an
  exception (`!data/master/forge-calibration.json`) — it is the only committed JSON of this slice; `forge-diff.json`
  stays gitignored and `forge-diff.md` / `forge-scripted.md` are committed. Report in `numbers`: cards compared,
  with-Forge-file rate, per-category cards / rate, per-category labelled precision, the runtime, and the
  parser-wrong cards found (names) — those go to docs/HANDOFF.md §3 as a new item for the parser core slice.
- **F-8 tests** (node:test, synthetic Forge-syntax fixtures written by you — not copied files): `test/forge-loader.test.ts`
  (fields, `ALTERNATE` split + joined-name key, SVar chain resolution incl. `SubAbility$`, `Charm` modes, token
  resolution against a fixture directory, cycle guard, the AI/deck keys ignored; the real checkout is exercised
  only when `FORGE_RES()` exists — skip cleanly otherwise), `test/forge-shape.test.ts` (Forge faces → shapes: etb /
  dies / upkeep / attacks mapping, `TargetMin$ 0` → optional, `OptionalDecider$` → optional, `UnlessCost$`, token
  shape; CardDefs → shapes: a `may`-wrapped trigger, a `TargetSpec` nested in a `conditional`, `choose-mode`,
  `token`, `altCosts` as keyword shapes), `test/forge-compare.test.ts` (an agreeing card yields no finding; the
  Breeches shape — Forge `Pump | ValidTgts$ Creature` vs ours with `choose-objects` and no `TargetSpec` — yields
  `target-missing`; `TargetMin$ 0` vs `optional: false` → `target-optionality`; unmapped mode → no `trigger-kind`;
  `Charm` 3 vs `choose-mode` 2 → `mode-count`; alignment by description beats printed order when the order differs).

## Proofs (report the exact output line)
- `npm run typecheck:all`; `node --test --import tsx test/forge-loader.test.ts test/forge-shape.test.ts test/forge-compare.test.ts`;
  `npm test` green; `npm run verify:quick`; `npm run parse:diff` → 0 changed; `npm run coverage:pool` numbers
  unchanged (paper 12,877 / 32,081 parser-alone), then `git checkout -- data/master/parser-coverage.json`.
- `npm run forge:diff -- --tier paper --claimed --out data/master/forge-diff.json --md data/master/forge-diff.md`
  twice → identical bytes (`fc` / `cmp`); report the totals line, the category table and the wall time.
- `npm run forge:diff -- --scripted --md data/master/forge-scripted.md` → totals line.
- `npm run forge:diff -- --ids <Breeches, Eager Pillager's oracle id> --scripted` → prints a `target-missing` finding
  for the "target creature can't block" mode (the §11 audit's finding — a known true positive).
- `npm run forge:diff -- --changed` on the clean tree → `forge:diff — 0 changed cards`, exit 0.
- Syntax check of both edited workflow files: `node -e "const s=require('fs').readFileSync('<file>','utf8').replace(/^export const meta/m,'const meta');new Function('args','agent','parallel','pipeline','phase','log','budget','workflow','return (async()=>{'+s+'})()');console.log('syntax ok')"`.
- `git status --short` shows only: `src/cards/forge/`, `src/config/paths.ts`, `scripts/forge-diff.ts`,
  `test/forge-*.test.ts`, `package.json`, `.gitignore`, `docs/plans/forge-oracle.md` (only if you correct a measured
  fact), `docs/workflows/parse-wave.js`, `docs/workflows/script-wave.js`, `docs/workflows/README.md`,
  `docs/vocabulary/README.md`, `docs/HANDOFF.md`, `data/master/forge-diff.md`, `data/master/forge-scripted.md`,
  `data/master/forge-calibration.json`; nothing under `data/scripts` or `data/scenarios`; no CRLF
  (`git diff | grep -c $'\r'` is 0 and the new files too); no file copied from the Forge checkout
  (`grep -rl "DeckHints\|PlayMain1" src test docs` finds only the plan's and the docs' own prose).

## Reviewer lens
Run every proof yourself. Then attack: (1) **precision** — take 15 disagreeing claimed cards spread over the
categories (not the ones in the calibration sample) and decide each against the printed text and the parser-alone
AST: a category whose findings are mostly encoding differences and that F-6 still feeds to the merge gate as a
blocker class (`target-missing`, `may-missing`, `trigger-kind`) is a major unless the docs state its measured rate
and the gate text says "read, then decide"; (2) **recall** — Breeches plus five 10.1 group-1 cards the judges
rejected for a dropped target, a flattened "may" or a wrong token (read `data/scripts/reports/10.1-g1.json`
verdicts; the scripts are under data/scripts — read-only): does `--scripted` flag them? A class the docs claim to
catch that misses on those is a major (document the miss); (3) **determinism** — both reports twice, identical
bytes; the JSON has no timestamp or absolute path; (4) **licence** — no file in the diff is a copy of a Forge script
or token file; fixtures are synthetic; the markdown quotes oracle text and parameter values only; (5) **identity** —
`parse:diff` 0 changed, coverage unchanged, no `CardDef` field added, no change under `src/cards/parse.ts` or
`src/engine/`, nothing under data/scripts touched; (6) **`--changed`** — move one rule file aside in a scratch copy
of the tree? No: instead point `--changed` at a scratch snapshot (`MTG_ROOT` or a flag you verify exists) whose hash
for two cards is altered and confirm exactly those two are compared; if the CLI offers no such seam, say so and
verify the in-process changed-set computation by unit test; (7) **workflow edits** — the two workflow scripts pass
the syntax check, keep their HARD lists, and the new judge / reviewer sentences say a finding is evidence, not a
verdict; (8) **hygiene** — no CRLF, no scratch files, the calibration sample's labels re-checked on 10 of its rows
(report agreement). A copied Forge file, a parse output change, or a committed `forge-diff.json` is a blocker.
