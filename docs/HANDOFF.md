# Handoff — "every card scripted" program

Written 2026-09-04/05 at the end of the first orchestration session. Everything a new session (any account, any
machine) needs is in this repository: the plan, the workflow scripts, the conventions, the state of every branch,
and the backlog. Read this file, then `docs/plans/every-card-scripted.md` (the approved plan), then
`docs/workflows/README.md` (how the work is executed).

## 1. What the program is

Take the rules engine from 33.4% of the playable pool fully simulated to 100% of the **paper pool** by writing a
per-card script for every card the oracle-text parser cannot finish (22,972 cards), using Opus subagents
orchestrated by a Claude Code session. The plan has three phases, continuing the repository's Phase 1–7 history:

- **Phase 8 — harness hardening** (in progress; slices 8a–8k): engine extensibility (registries + declaration
  merging), script format v2 with airtight accounting, a script verification pipeline, blind scenarios, a parallel
  pool sandbox, a fuzzer, goldens, a fidelity ratchet, an op-coverage ratchet, the speed ladder, dashboard v2 and the
  queue/promote tooling.
- **Phase 9 — vocabulary waves**: 9.0 composition core (serial), 9.1 rules-depth families (parallel worktrees),
  9.2 named-keyword bundles, 9.3+ blocked-by rounds driven by what script authors report as missing.
- **Phase 10 — script waves**: 10.0 the owner's six decks (179 cards), 10.1 EDHREC ≤ 5k Commander-legal, 10.2 the
  rest ranked, 10.3 unranked; author → blind scenario author → judge, promotion by the orchestrator only.

### Decisions taken by the owner (2026-09-04)

- Denominator = **paper pool** (cards with `paper` or `mtgo` in Scryfall `games`, not `set_type: funny`, not
  Attraction/Contraption/Sticker/Hero card types, not ante). Measured: paper 32,081 · digital 1,000 · un 1,423 ·
  ante 9. Un/digital tiers are tracked on the dashboard but are not part of the 100%.
- Evidence bar = mechanical gates **+ blind scenario + independent judge** for every card ("covered" = `judged`).
- Run mode = **Phase 8 continuously**, then waves with a check-in after each wave.
- Subagents on Opus; the orchestrating session is the only committer.

## 2. Status at handoff

`main` (pushed to `origin/main`):

| Commit | Slice | What it gives |
|---|---|---|
| 1797764, 460294e | 8b | `src/config/paths.ts` resolves `data/` from a linked worktree to the main checkout; `.gitattributes` pins LF |
| fde79f4 | — | `.claude/worktrees/` ignored |
| 8700360 | 8a-1 | `src/engine/ops/` registry (`npm run gen:registry`), hook points in every core function, `Core*` unions + registries in `types.ts`/`state.ts`/`events.ts`, `ext` bags, `docs/vocabulary/README.md`, `test/registry.test.ts` |
| 97983df | 8d | `src/verify/scenarioDsl.ts`, JSON corpus `data/scenarios/<2-hex>/<oracle_id>.json`, `npm run verify:scenarios` (sharded), `test/scenarios/README.md` for blind authors |
| 4e09a7c | 8a-1 fixes | extra-combat leak, step-hook placement, mode costs, counters fold, phasing scans, lints |
| 8249a67 | 8e + 8f | `src/engine/invariants.ts`, parallel `npm run verify:pool` (`--workers/--seats 2|4|both/--ids/--changed/--tier/--limit`), `npm run fuzz` / `fuzz:deep` with ddmin shrinking and `--repro` |
| d1f454e | docs | this handoff, the plan copy, `docs/workflows/` |
| 18a0939 | 8h | op-coverage ratchet: `npm run coverage:ops`, `test/lint-op-coverage.test.ts`, `test/fixtures/op-allowlist.json` (only shrinks; dead trigger events pinned) |
| 4aa3559 | 8a-2 | parser rule registry (`src/cards/rules/`, generated barrel), `PARSER_VERSION`, `npm run parse:diff` / `parse:accept` over `data/master/parse-snapshot.json`; `verify:all` includes `parse:diff` |
| 6e35aa7 | 8g | goldens (`test/fixtures/golden/`, `golden:check` / `golden:accept`), fidelity ratchet (`fidelity:check` / `fidelity:accept`, `test/fixtures/fidelity.json`), `test/determinism.test.ts`, inert-clause aggregation (`sim:batch --track-unsimulated`), worker pools settle on thread death |
| 9d945ba | 8x | engine fixes: static-mods recursion (layer-6 re-entrant reads), one `landScorer` for AiAgent/RolloutAgent (land from graveyard/exile), `Game.blockLegal` shared by declare-blockers and `simulateCombat` (menace, CR 509.1a) |
| e817a4f | 8a-3 | script format v2 (sharded, `llm` source, backFace/secondFace, typed value-matched covers, ignore whitelist, verification block, `scriptHash`), line-claim accounting for `fullyParsed`, `src/cards/pool.ts` tiers, `src/cards/schema.ts` (zod) + `typecheck:schema`, `scripts:check` v2, `scripts:shard`, `scripts:schema` |
| edceb29 | 9.0a | composition core, engine side: `Ref`, ten composition ops, amount forms, `multi` targets, four delayed-at points, `src/engine/refs.ts`, zod schema + structural gate + op-coverage probes extended, `docs/vocabulary/composition.md`; soft cast-time target requirements for older-container branches; `docs/workflows/phase-9-0a-composition-core.js` |
| (9.0b) | 9.0b | composition parser rules (`src/cards/rules/composition.ts`, 74 effect rules + 1 line rule; `EffectCtx` sub-parsers handed to registry rules; built-in "you may" wrapped in `may`), parser debts 4 and 5 (second faces unparsed, 0x08 bytes), subtype vocabulary (`npm run gen:subtypes` → `src/cards/subtype-vocab.ts`; unknown words no longer become subtypes), antecedent-aware frame binding (`bindAntecedent`, `withFrame`), `PARSER_VERSION` 3, parse snapshot + fidelity ceilings accepted; `docs/workflows/phase-9-0b-composition-parser.js` |
| (9.0c) | 9.0c | engine bindings (`noteAffected` in pump / grant-keyword / counters / untap / untap-all / gain-control / sacrifice / look-top / counter — the countered spell with its stack-time controller and mana value; `bind` reads spell targets), scopes `target-opponent` (legal.ts offers opponents only) and `owner-of-that`, `unless-pays.otherwiseAs`, `Filter` fields (`notSubtypes`, `supertypes` / `notSupertypes`, `notKeywords`, `powerEQ` / `toughnessEQ` / `toughnessGE`, `typesAll`, the adjective flags, `dealtDamageBySource` with the per-turn `ext.damagedBy` record), `dies` / `etb` `controller: 'opponent'`, `return-from-graveyard` `count` / `optional`, `graveyard-card` `who`, `TargetSpec.count: 'X'`, aggregate amounts (`agg` + `over`), `count: 'that-many'` from `item.lastAmount` (and the trigger's amount), `scry` / `surveil` amounts, the `set-pt` static, LKI for `power-of-source`; parser: `PARSER_VERSION` 4 (the "-X" sign, "target A and target B" as a `multi` spec, 'All creatures have "…"', the "you control enters" template first, adjacent type words all-of), the `bind` / `for-each` repairs dropped where the engine now binds, the 9.0b declines claimed; op-allowlist shrunk by 8 |

Numbers on `main` after 9.0b (2026-09-05, machine shared with a second session): `coverage:pool` 11,713 / 34,513 fully
parsed overall, paper headline 11,583 / 32,081 (36.1%; 9.0a: 11,391 — +848 gained by the composition rules, −170
second faces, −474 garbage-filter cards honestly unparsed, +46 anthem/self-trigger fixes); owner's six decks 274 /
444 fully parsed (was 266); `verify:pool` 11,290 sandbox-ok / 423 unreachable (was 11,064 / 477); `parse:diff` 0
after `parse:accept` (parserVersion 3, 4,809 cards changed, 2,524 of them "same unparsed lines, shape changed" —
the built-in "you may …" wrapped in `may`); goldens replay identically; fidelity ceilings lowered to 10.93 / 10.72 /
6.85 / 17.17 hits per game (was 13.28 / 16.12 / 8.33 / 20.38); `npm test` 607 tests; `coverage:ops` 0 not
allowlisted; bench 38–39 games/s 60-card and 3.6–3.9 Commander UNDER LOAD (the second session renders; the 9.0b fix
agent's interleaved A/B against a HEAD worktree was within noise — re-measure on a quiet machine, item 7).

Numbers after 9.0c (2026-09-05, same shared machine, measured before the orchestrator's `parse:accept`): `coverage:pool`
12,143 / 34,513 fully parsed overall, paper headline 12,008 / 32,081 (37.43%; 9.0b: 11,583 — +430 gained: the
counterspells, "up to N target … cards from your graveyard", "an opponent controls dies", "dealt damage by ~ this
turn", non-<Subtype> / legendary / snow / without-flying / N/N filters, "target opponent …", Rhystic Study's shape,
aggregate amounts, "that many"); owner's six decks 279 / 444 fully parsed (was 274); `verify:pool` 11,670 sandbox-ok
/ 473 unreachable (was 11,290 / 423; no sandbox throws, no hang, 20 s); `parse:diff` 1,225 cards changed, 0 lost,
0 removed (parserVersion 3 → 4; 595 "same unparsed lines, shape changed": 201 `bind` / `for-each` repairs dropped, 126
"that many" / "that much" (a constant 1 before, `count: 'that-many'` now — 0 under a trigger the engine gives no
amount), 81 new filter fields, 60 `typesAll`, 28 `return-from-graveyard` `count` / `optional`, 20 `controller:
'opponent'`, 18 "untap all creatures you control" (creatures only), 16 "-X" signs, 14 `target-opponent`, 9
`otherwiseAs`, 2 `count: 'X'`, 2 aggregates, 1 scry amount, 1 `owner-of-that`, 27 other; the "you control enters"
reorder moved 0 cards); goldens reproduce exactly; fidelity 10.68 / 11.22 / 6.80 / 17.13 hits per game against
ceilings 10.93 / 10.72 / 6.85 / 17.17 (the Goph vs Quintorius pairing is above its ceiling and reported "ok" by the
script's tolerance — not accepted); `npm test` 676 tests; `coverage:ops` 0 not allowlisted, the allowlist shrunk by 8
(look-top, put-from-hand, grant-ability, power-of-source, power-of-that, that-many, costParts untap, keywords flash);
bench under load 42.7 / 18.7 / 40.2 games/s 60-card and 2.93 / 2.40 / 3.80 Commander over three runs (the second
session renders; the 9.0b numbers were 38–39 / 3.6–3.9 under the same load — re-measure on a quiet machine, item 7).

**9.0c review fixes (2026-09-05, same machine, still before `parse:accept`).** The two reviews found that several
"now parses" lines could never act: `deals-damage` was queued only for damage to creatures (Exalted Angel's "you gain
that much life" gained nothing on the common line), `life-loss-opponent` carried no amount (Exquisite Blood,
Mindcrank read 0), "whenever equipped creature dies" was matched AFTER `moveTo` detached the Equipment and meant "any
equipped creature" (Skullclamp never drew, and would have drawn off an opponent's creature), Abattoir Ghoul read its
own power for "that creature's toughness", Wight's "exile that card" exiled its own Zombie token (a `token` re-points
the frame), Necropolis Regent's "put that many counters on it" put them on the Regent, `return-from-graveyard` picked
afresh on resolution instead of using its targets (Morbid Plunder), an activated "that much" read 0 (Relic Amulet),
the `that many` rule minted readings nothing fed (43 fully-parsed cards), Withdraw's "unless its controller pays"
charged the first target's controller, and `ext.damagedBy` left empty bags behind. Fixed: `dealDamageToPlayer` queues
`deals-damage` (with the amount) and `loseLife` / `dealDamageToPlayer` pass `amount` to `life-loss-opponent`;
`moveTo` matches `dies` / `ltb` before detaching (CR 603.10a) and drops the damage record afterwards; `Filter.
attachedToSource` ("equipped / enchanted creature" with no article = the creature this is attached to, CR 702.6a);
"you gain life equal to its / that creature's power / toughness" is `{ prop, of: 'that' }` (a sacrifice-self cost's
"its" stays the source); `bindAntecedent` re-binds the trigger's object after a `token` when the sentence says "that
card" (CR 111.1); "on it" in a trigger about another permanent is that permanent (the built-in "put N counters on
that creature → self" template is gone: `that`); a targeted `return-from-graveyard` is a real `graveyard-card`
requirement (`ownTargetSpecs`; chosen on cast, only those return, and the count feeds "that many"); `removeCounters.
all` ("Remove all charge counters from ~", the count removed feeds "that much"); the parser keeps `that-many` only
where something feeds it (`feedThatMany`: an earlier amount, a trigger about an amount — now `life-loss-opponent`
too — or a removed-counters cost) and makes the line unparsed otherwise; the unless-pays rule declines a payer named
by the clause's own target; "whenever an opponent casts a noncreature / <filter> spell" (Mystic Remora and 17 more
lines); `wipeExtEot` deletes an emptied bag. Numbers: `coverage:pool` 12,157 / 34,513, paper 12,022 / 32,081
(37.47%; +14 cards over the 9.0c figure, the opponent-cast head; Withdraw and the unfed "that many" cards are
honestly unparsed now), owner's decks 280 / 444; `parse:diff` 1,342 changed, 0 lost, 4 "no longer parses" lines, every
one on a card whose earlier sentence was already unknown (Pip-Boy 3000's mode, Infernal Reckoning, Exile, Grave
Strength — their old parse was a wrong `self` / `power-of-source`); `verify:pool` 11,613 sandbox-ok / 544
unreachable (was 11,670 / 473: the targeted graveyard returns need a graveyard card to be cast, which the sandbox
(8c's file) does not seed — see item 25); goldens reproduce exactly; fidelity 10.68 / 12.62 / 6.75 / 16.62 — the Goph
vs Quintorius pairing is above its 1.1× tolerance with the SAME five unparsed clauses as before (Nissa 72 → 80 hits,
Augusta 41 → 58 over the same 12 games: the engine changes shift the seeded games, no new clause) — not accepted;
`npm test` 696 (20 new: 17 card scenarios, 2 parser tests, 1 engine test); `coverage:ops` 0 not allowlisted, the
allowlist shrunk by 4 more (`deals-damage`, `life-loss-opponent`, `removeCounters`, `defender`); bench 38.5 / 35.1
games/s 60-card and 3.82 / 3.92 Commander UNDER THE SAME LOAD (budget 4.0; the review's pre-fix runs were 4.04 /
3.91 and this report's 2.93 / 2.40 / 3.80 — nothing added touches a per-effect path; re-measure quiet, item 7).

**9.0c as committed (orchestrator gate, 2026-09-05):** `parse:accept` (parserVersion 4, 1,342 cards changed) and
`fidelity:accept --force` (ceilings 10.68 / 12.55 / 6.75 / 16.57 — the Goph vs Quintorius rise carries the same five
inert clauses as before; ceilings only ratchet down from here); `coverage:pool` 12,157 / 34,513, paper 12,022 /
32,081 (37.47%); `verify:pool` 11,613 sandbox-ok / 544 unreachable, no throws; goldens exact; `npm test` 699;
`coverage:ops` 0 not allowlisted; bench 37.3 / 4.01 games/s under the second session's load.

### Branches not yet merged

None. Every Phase 8 branch produced in this session was merged into `main` after its review rounds; the worktrees
and the remote `worktree-*` branches were deleted. Section 6 records what each merge left open.

## 3. Known defects and backlog (found by reviewers and the fuzzer; not yet fixed unless noted)

1. `Game.simulateCombat` accepts a lone blocker against a menace attacker (CR 702.110b); `combatFrom` enforces it,
   `simulateCombat` does not. The scenario DSL's block-acceptance check depends on the engine refusing it. → 8x.
2. `characteristics.ts` `computeStaticMods → staticMods → keywords` can recurse without bound (fuzz bucket
   `a909b8b2`, `npm run fuzz -- --repro a909b8b2` after a seed-1 300-game run). → 8x.
3. `src/analysis/rolloutAgent.ts` `score` dereferences an undefined object (fuzz bucket `3492eb01`). → 8x.
4. ~~The parser certifies 170 split/adventure/flip cards as fully parsed although it never parses `faces[1]`~~ —
   **done in 9.0b**: `parseCard` records the second face's lines (normalised against the second face's own name by
   the shared `src/cards/oracle-lines.ts`, the same list `secondFaceLines` / `secondFaceUnclaimed` account for) in
   `def.unparsed` and clears `fullyParsed`; exactly 170 cards left the fully-parsed set (`parse:diff` group
   "NO LONGER parses: <second-face line>"). modal_dfc / transform are unchanged. Casting the second half is still
   engine work (split / adventure / flip casting), not parser work.
5. ~~`parse.ts` `parseGrantedAbility` contains literal 0x08 backspace bytes where `\b` was intended~~ — **done in
   9.0b** (`grep -cP '\x08' src/cards/parse.ts` → 0, `PARSER_VERSION` 2; test/parser-composition.test.ts pins both).
   No card moved on that fix alone: `parseCard` already rewrites "this creature" to `~` for the whole text.
6. `state.attackers` is not cleared by `simulateCombat` (only by `simulateRemainingCombat`); harmless today.
7. `npm run bench:games` is unreliable while agents share the CPU (Commander 1.7–2.6 games/s under load vs ≈ 5
   quiet) — run the bench gate only on a quiet machine.
8. `verify:deep` is a stub until 8g (goldens + fidelity) and 8i (Playwright leg) are merged; the fuzz legs are in
   `fuzz:deep`.
9. `BatchPool.run()` can stall if a worker dies mid-chunk (8g fix round 2 addresses it).
11. **Dead trigger events** (found by the 8h probe): `turned-face-up` is raised by `Game.turnFaceUp` but no
    `queueTriggers` case dispatches it, so a morph card's "When ~ is turned face up" trigger can never fire
    (proof: Ainok Survivalist turned face up destroys nothing); `tapped` has a case but is never raised. Both are
    pinned under `deadEvents` in `test/fixtures/op-allowlist.json`; fixing them is a `game.ts` change (add the
    dispatch / raise the event) after which the allowlist entry must be removed.
12. Op-coverage strictness gaps (8h re-review): the probe's `unknown` assertion can false-positive on cards whose
    parser output carries the `unknown` sentinel; keywords/alt-cost/cost-modifier vocabularies have no runtime source
    (type-only registries) — derive them from the zod schema barrel once 8a-3 lands.
13. Parser-registry purity gap (8a-2 re-review): the built-in `EFFECT_RULES` entry `~ gains "(.+)"` (parse.ts ~472)
    calls `parseActivatedLine` with the registry enabled even during the built-ins-only pass, and four line-loop
    condition slots consult condition rules in place (documented in parse.ts's header). With catch-all claiming
    families the measured effect is 0 fully-parsed cards moved; a proper fix threads the pass flag into table
    `make` callbacks. Always read `npm run parse:diff` after a rule family lands.
14. Analysis worker pool (`src/analysis/pool.ts`, 8g re-review): `AnalysisPool.rerun()` never settles when the
    worker it was posted to dies while another worker lives (the pool does not record which slot a rerun went to);
    a slot that dies before `init()` leaves `init()` waiting; `killSlot` charges an in-flight rerun to the current
    analysis. In `src/sim/batchPool.ts` a worker answering `load` with an error while another worker already loaded
    is never retired. All edge cases of worker death, not of normal runs.
15. Fidelity ceilings were re-baselined with `fidelity:accept --force` in 8g (Goph vs Quintorius 14.3 → 16.1, pod
    19.8 → 20.5): the earlier ceilings came from runs where 18 of 240 games died on the land-drop crash, so they
    undercounted inert clauses. This is a measurement correction; ceilings only ratchet down from here.
16. Layer dependency cycles (8x): `staticMods` now parks an in-progress marker and answers a re-entrant read with
    `layer6Mods` (keywords/flags kept, layer-7 P/T terms zeroed), so keyword-filtered anthems see granted keywords
    and no longer overflow the stack; a filter that reads P/T (`powerGE`, `toughnessLE`, `toughnessGtPower`) still
    sees printed values on a re-entrant read — the real fix is CR 613.8 dependency ordering (plan B3).
17. `Game.blockLegal` (shared by the declare-blockers step and `simulateCombat`) now enforces CR 509.1a (only the
    defending player's creatures block). The 8x re-review warns that `simulateCombat` sets every attacker's
    `attacking` to the primary opponent, so simulated blocks by a non-primary defender in a pod are refused; the
    3-player golden and the fidelity pod were the gates: 3 of 30 pod golden games changed (accepted, first
    difference at a turn where a non-defending seat's block is no longer simulated), both 2-player goldens and the
    three seeded baselines reproduced exactly, and the fidelity pod improved (20.52 → 20.38 hits/game). If pods
    with attackers aimed at several defenders ever matter to the AI's combat evaluation, `simulateCombat`'s
    `targets` parameter must be used instead of the primary-opponent default.
18. Script accounting — residual mechanical bypasses (8a-3 round-5 re-review; deliberately left to 8c): the
    structural gate in `src/cards/scripts.ts` (claims, per-line substantive-effect budget, marker ops, zero
    magnitudes, typed covers) still accepts an `Amount` object with `times: 0`, negative magnitudes, `add-mana` with
    `mana: []`, zero-valued statics (`cost-adjust 0`, `extra-land 0`, `equipment 0/0`, `aura 0/0` with no flags),
    `costModifiers` covers whose printed reduction has non-numeric symbols, and all-empty `animate`/`token` bodies.
    The structural gate is the first filter only: 8c's round-trip renderer rejects every one of these because the
    rendered text cannot match the oracle line's numbers, and the blind scenario and judge follow. When writing 8c,
    also extend `MAGNITUDE_RULES`/`EMPTY_LIST_RULES` for these cases so the cheap gate catches them too.
19. **Fight targets fizzle** (found while building 9.0a): `targetingEffects` registers a `fight`'s two requirements
    under the same effect index and `assignTargets` overwrites the first pick with the second, so `Prey Upon`
    ("target creature you control fights target creature you don't control") is cast with only the opposing creature
    in its target list and fizzles at resolution ("all targets illegal"). Left exactly as it was because fixing it
    changes AI play and the goldens; the composition core's `part` mechanism (a second requirement appends instead
    of replacing) is the fix — mark fight's second requirement as `part: 1` and re-baseline the goldens deliberately.
20. Composition core (9.0a) — deliberately left open, see docs/vocabulary/composition.md §7: control changes with
    durations (`exchange` is permanent; 9.1's `o.ext.controlReturn`), timestamp order for `lose-abilities` /
    `set-pt` (approximated: keyword counters and eot grants survive an "all" loss, a later `set-pt` wins), targets
    inside the older containers (`conditional`, `optional-then`, `optional-pay`) are asked for at cast time as *soft*
    requirements (an empty option list never refuses the cast; the cast gate does not evaluate which branch will run;
    `then` and `else` share the container's index, so for the four parser-produced kicker cards that target in both
    branches — Fight with Fire, Hypnotic Cloud, Tear Asunder, Bog Down — the `else` pick overwrites the `then` pick;
    the script schema rejects that shape, so scripts are unaffected), a delayed
    trigger whose source was a token that has ceased to exist cannot fire, `for-each` iterates objects only (players
    go through `scoped`), and `unless-pays` cannot name "the controller of target spell" (use `counter`'s
    `unlessPay`). The parser rules for these wordings are slice 9.0b; until then only scripts and the scenario DSL's
    `scripts` field (test/scenarios/README.md §2) emit them.
21. Composition core (9.0a) — reviewer minors left to the backlog under the two-fix-round rule (none changes a gate):
    `cloneStackItem` copies the new `item.sacrificed` array by reference (the `{...it}` spread); a `reflexive` at the
    head of a NESTED list fires off its container's preceding sibling (`lastHappened` is reset once per item, not
    per list); `exchange` with `what: 'life'` between a player WORD and a TargetSpec advances the target cursor only
    in the object branch; the CR 115.3 duplicate-pick guard in `chooseTargets` runs only for `part`-numbered picks,
    so a plain spec with `count > 1` ("two target creatures") can still accept one object twice; `unless-pays`
    charges the mana before `payCost` pays the non-mana parts, so a refused non-mana part leaves the mana spent;
    `move` sets `faceDown` before `enterBattlefield` and does not clear it when the entry is refused; the cleanup
    step repeats at most once after `until-eot:end` fires (CR 514.3a allows a chain); `resolveTop` falls back to the
    union check for a stack item without a `targetParts` record (states serialized before 9.0a); `childIndex`'s
    nesting/list limits (3 levels, 63 effects) are enforced by the helper's throw, not by the schema or the
    structural gate.
10. `test/` is not covered by `tsconfig.json` (only `src/**`); test files are transpile-only under tsx. 8a-3 added
    `tsconfig.schema.json` for its type-equality test; a whole-of-test typecheck has ~40 pre-existing errors.
22. **Built-in parser defects found while measuring 9.0b** (none fixed there — every one changes the AST of cards
    that were fully parsed before, so each is an orchestrator decision behind `parse:diff`; `PARSER_VERSION` bumps):
    * `parseTrigger`'s generic "whenever (another |an? )?(.+?) enters" template (parse.ts ~902) runs before the
      "(.+?) you control enters" one, so "Whenever a creature you control enters" / "Whenever ~ or another Dragon
      you control enters" get the words `you control` / `another` / `or` as SUBTYPES (`filter.subtypes: ['You',
      'Control']`) and the trigger can never fire: 740 pool cards carry such a filter, 358 of them fully parsed
      (Jaws of Defeat, Scourge of Valkas, Impact Tremors-likes). One-line fix: try the "you control" template first
      (or strip the controller phrase before `parseFilterWords`); goldens and fidelity will move.
    * ~~`pm()` (parse.ts ~597) reads "-X" as a bare `'X'`~~ — **done in 9.0c** (`PARSER_VERSION` 4): "-X" is
      `{ sum: ['X'], times: -1 }` (Death Wind's scenario in test/scenarios/composition-cards.ts); 16 fully-parsed
      cards changed shape.
    * `parseTarget`'s TGT slot swallows "target A and target B" ("Destroy target artifact and target enchantment"
      → one target with subtypes `And` / `Target`); the "All creatures have "…"" grant static (parse.ts ~1099)
      captures `All` as a subtype; `parseFilterWords` turns every unknown word into a subtype ("of their choice",
      "nonlegendary") — the composition family guards its own sub-parses against garbage subtypes, the built-ins
      do not. **Fixed after the 9.0b review:** every word that becomes a `Filter.subtypes` entry now goes through
      the subtype vocabulary (`src/cards/subtypes.ts` ← `npm run gen:subtypes` → `src/cards/subtype-vocab.ts`,
      515 subtypes of the playable pool with their card type); an unknown word makes the filter null and the line
      unparsed. 474 cards that were "fully parsed" with a filter no object could match (You / Control, Up / To /
      Three / Target, Zomby, Slivers, Legendary, Snow, Without / Flying, non-Aura …) are honestly unparsed now; the
      "you control enters" ordering defect is moot (the first template declines the controller words; 9.0c put
      the "you control" template first anyway — 0 cards moved), and "~ or another X you control enters / dies", "…
      you control with power N or greater enters", "creature of the chosen type", "creature other than ~" and comma
      lists ("basic Forest, Plains, or Island card") parse correctly. **Done in 9.0c**: `Filter.notSubtypes`
      (`non-<Subtype>`), `supertypes` / `notSupertypes` (`legendary` / `snow`), `notKeywords` ("without flying"),
      `powerEQ` / `toughnessEQ` ("N/N creature"), `dealtDamageBySource` ("dealt damage by ~ this turn"), the `dies` /
      `etb` `controller: 'opponent'`, `return-from-graveyard` `count` / `optional` (Life from the Loam is pinned again
      in test/staples.test.ts), "target A and target B" as a `multi` spec (9 cards), 'All creatures have "…"' (5),
      `typesAll` for adjacent type words ("artifact creature" was an any-of list: 60 fully-parsed cards changed
      shape, the anthem fallthrough "<type> creatures you control get +N/+N" among them).
      The built-in "you may *sentence*" also wraps its op in a `may` now (ops with no `optional` form of their own;
      permissions such as `play-exiled` excepted), so a declined "may" no longer acts.
    * `~ gains "(.+)"` and the four line-loop condition slots still consult the registry in the built-ins-only
      pass (item 13, unchanged).
23. **Engine gaps the 9.0b parses run into** (the AST is right; the engine's binding frame is not filled). **Since
    the 9.0b review the parser no longer claims a sentence whose antecedent binds nothing** (parse.ts
    `bindAntecedent`, composition.md §"Parser wordings"): a targeted antecedent gets a `bind` of the item's targets
    put before it (Slave of Bolas, Snakeskin Veil, Spidery Grasp, Soul's Might — scenarios in
    test/scenarios/composition-cards.ts), a group antecedent's "those" iterates the same set as a `for-each` (Gleam
    of Resistance, Dauntless Unity, Savage Offensive), and everything else is unparsed. What still waits on the
    engine: `counter` does not `noteAffected` the countered spell and a spell target is a `stack` ref the `bind` op
    does not take (game.ts `objs`), so "Counter target spell. Its controller draws a card / mills three cards /
    creates two Treasures / … where X is that spell's mana value" (Dream Fracture, Access Denied, Undermine,
    Countersquall, Psychic Strike, Thought Collapse, Countermand, Dismal Failure, Punish Ignorance, An Offer You
    Can't Refuse, Glen Elendra Guardian, Vex, Didn't Say Please, Strix Serenade) is unparsed until `counter` binds
    what it countered (with the spell's last known controller and mana value); the `sacrifice` *op* binds nothing
    either (only a sacrifice cost does), so "sacrifice another creature. You gain X life …, where X is that
    creature's power" (Disciple of Bolas, Heart-Piercer Manticore) is unparsed; "Untap all creatures you control.
    Those creatures get +1/+1" (Gideon, Martial Paragon: `untap all-you-control` names no set) and "Look at the top
    card of your library. You may exile that card" (Puresight Merrow: `look-top` binds nothing) likewise.
    **Done in 9.0c**: `noteAffected` in `pump`, `grant-keyword`, `counters`, `untap` (with the new
    `'creatures-you-control'` target word — "untap all creatures you control" untapped every permanent before),
    `untap-all`, `gain-control`, `sacrifice` (values taken before they leave), `look-top` and `counter` (the targeted
    spell with the controller and mana value it had on the stack, X included; `objs(refs, true)` / `bind from
    targets` read a `stack` ref as the spell's card); the parser's `BINDING_OPS` grew accordingly and the `bind` /
    `for-each` repairs are gone from 201 fully-parsed cards (Slave of Bolas, Snakeskin Veil, Spidery Grasp, Gleam of
    Resistance, Savage Offensive …); the counterspells, Disciple of Bolas, Heart-Piercer Manticore, Puresight
    Merrow and Gideon each have a scenario in test/scenarios/composition-cards.ts. `ScopeWho` has `target-opponent`
    (`ownTargetSpecs` emits `{ kind: 'opponent' }`; Sphinx of Enlightenment, Chimney Imp, Questing Phelddagrif,
    Soldevi Heretic … parse; Archive Trap still has its alternative-cost line) and `owner-of-that`; `unless-pays`
    has `otherwiseAs: 'controller'` (Rhystic Study; Mystic Remora too since the review fixes gave `parseTrigger`
    the "whenever an opponent casts a noncreature / <filter> spell" head). Still open: an `optional-pay` of `{X}`
    (Relentless Dead) has no way to choose X; "Boast — {1}{B}: …" parses as a plain activated ability once the
    reminder text is stripped (Varragoth, Bloodsky Sire) — the boast restriction is a 9.2 keyword family.
    **Closed by the orchestrator after the second fix round (9.0b re-review 2):** a plain trigger puts only
    `triggeringId` on its stack item, never `item.affected`, so `triggerBody` and `parseGrantedAbility` now put a
    `bind … from 'triggering'` before EVERY complete non-self body that reads the frame (built-in parses included),
    and `bindAntecedent` treats a preceding effect on the source itself as the antecedent of a following plain "it"
    ("this creature gets +1/+1 until end of turn. Untap it." → `untap self`, Blistercoil Weird; pinned in
    test/parser-composition.test.ts and test/scenarios/composition-cards.ts). `those` / player / count words after
    a source-only sentence still fall back to the frame rules.
24. **Left open by 9.0c** (each is a small, separate change): (a) an amount never introduces a target — "draw a card
    for each tapped creature target opponent controls" (Theft of Dreams) stays declined; `ownTargetSpecs` would have
    to scan amount `of` / `who` fields and the parser's `objectSet` would have to emit `who: 'target-opponent'` (11
    cards). (b) `Filter.equipped` / `kicked` / `transformed` are answered by `matchesFilter` and unit-tested, but
    only `enchanted` / `modified` / `monocolored` / `historic` have a scenario; "equipped creature" lines (467
    cards) are Equipment statics / triggers about the equipped creature, not filters, and belong to an Equipment
    family — the review fixes took the "whenever equipped / enchanted creature dies" head (`Filter.attachedToSource`,
    Skullclamp's scenario); "whenever equipped creature attacks / deals combat damage" and the rest stay declined. (c) "the number of <counter> counters on it / that creature" (a counter count on a bound object) has no
    amount form. (d) "It deals that much damage to each other opponent" (Super State's trigger) needs an "each
    other opponent" damage word; the trigger amount (`TriggerCtx.amount` → `item.lastAmount`) is set for
    `deals-damage` (damage to a creature or a player), `combat-damage-player`, `life-gain` and `life-loss-opponent`
    (the review fixes), and the parser declines a "that many" under any other trigger (`feedThatMany`). (e) "Exile all multicolored permanents" and
    "Destroy each creature dealt damage by ~ this turn" have the filter field but no "<verb> all / each <filter>
    permanents" template. (f) `STATIC_MAGNITUDE_RULES` in src/cards/scripts.ts (8c's file) has no entry for the
    `set-pt` static — a `set-pt` 0/0 is not dead (the creature dies), so none is needed, but 8c's renderer should
    print it. (g) `target-opponent` on `exchange` sides and `move.controller` is accepted by the types and asked for
    on cast but has no parser wording yet. (h) The Dauntless Unity fold ("… those creatures get +2/+1 instead")
    still iterates the set with a `for-each` because the pump it refers to runs after it in document order; every
    other group reference is a plain `those` now. (i) `TargetSpec.count: 'X'` on an ACTIVATED ability reads 0 (an
    activation carries no X today), so "destroy up to X target artifacts" on an ability targets nothing.
25. **Left open by the 9.0c review fixes**: (a) `src/verify/sandbox.ts` (8c's file) seeds no graveyard, so a spell
    whose only effect is a targeted `return-from-graveyard` (Raise Dead, Morbid Plunder, Life from the Loam …) is
    "unreachable" for `verify:pool` now that it is a real target requirement (544 unreachable, was 473): the sandbox
    should put a card matching the `graveyard-card` filter into the caster's graveyard. (b) "Sacrifice a creature:
    … that many" (a sacrifice cost feeds no number), "the number of counters removed this way", and a `sacrifice`
    op whose `amount` is "that many" (a number in the type) stay declined by `feedThatMany`. (c) A `dies` trigger
    with `attachedToSource` on an Aura fires while the Aura is still on the battlefield (state-based actions move it
    afterwards) — correct, but no Aura card has a scenario yet. (d) ~~The infect path of `dealDamageToPlayer` still
    queues `life-loss-opponent`~~ — **done in the 9.0c fix round 2** (CR 120.3c: the infect branch queues only
    `deals-damage`; two scenarios in test/scenarios/composition-cards.ts pin Exquisite Blood and Mindcrank against
    Glistener Elf — poison counter, no life gain, no mill).
    **Closed by the orchestrator after the second fix round (9.0c re-review 2):** "… permanent card(s) from your
    graveyard" is a permanent-type filter (CR 110.4c; `permanentCardFilter` in composition.ts — Regenesis, Rite of
    Renewal, Rydia's Return no longer offer an instant or sorcery card), and "~ gets +1/+0 for each other snow
    permanent you control" counts PERMANENTS with `other: true` (`eachYouControl` in parse.ts; Spirit of the
    Aldergard is 2/4 with two Snow-Covered Forests — the old template counted creatures and the source itself).
    Both pinned in test/parser-composition.test.ts and test/scenarios/composition-cards.ts.

## 4. Remaining Phase 8 slices (8k done; the rest not started)

- **8c `scripts:verify`** — the mechanical gate for a batch of scripts: strict schema → freshness (`oracleHash`,
  `PARSER_VERSION`, `registryHash`, `scriptHash`) → registry → lint → 2p/4p sandbox with per-ability reachability
  probes → round-trip renderer `src/cards/render.ts` (numbers exact, keyword/zone tokens present, Jaccard ≥ 0.55) →
  `verification` block written into the script + batch report `data/scripts/reports/<batch>.json`. Depends on
  8a-3 (schema, script format), 8e (sandbox), 8a-1 (registry), 8a-2 (`PARSER_VERSION`).
- **8i speed ladder** — `verify:quick` (≤ 15 s), `verify:all` (≤ 2.5 min full, incremental ≈ 70 s), `verify:deep`
  (fuzz + goldens + fidelity + Playwright against `next build --webpack` + `next start -p 3199`); the parse cache
  `data/master/parse-cache.sqlite` keyed by `(oracleId, oracleHash, scriptHash, PARSER_VERSION, registryHash)`;
  `MTG_PARSE_CACHE=0` escape hatch. Touches `src/cards/db.ts` (merge after 8a-3).
- ~~**8k fan-out tooling**~~ — **done**. `src/cards/scriptState.ts` (nine states derived from files only: master row,
  script, blocked note, scenario shard, live registry — `SCRIPT_STATE_TABLE` says which count as simulated /
  covered / queueable, and a blocked note auto-clears when every family it names exists); `src/cards/taxonomy.ts`
  (the plan Part 3 families as one ordered rule table, replacing the `owner-decks-needs.md` regex heuristic and its
  two known over-tags — "creatures you control gain …" is generic, "return … under its owner's control" is a zone
  move — pinned on 68 real cards in `test/taxonomy.test.ts`); `scripts:queue` (selection language
  `decks:owner | pool:<tier> | commander:legal | edhrec<=N`, family/type/EDHREC ordering, parser draft, nearest
  judged scripts, vocabulary excerpt, DSL cheat sheet, plus the blind copy with the ASTs stripped and the rulings
  added); `scripts:promote` (writes `verification.scenarios` / `.judge` / `.status` and the blocked notes; refuses
  on a dirty `src test apps scripts package.json` tree, with `--allow-dirty <prefix>` for another session's known
  files; `--human --by <person> --ids …` writes the review notes under `data/scripts/reviewed/` that are the only
  route to `reviewed`); `scripts:quarantine` (`_quarantine/`, which `ScriptStore` ignores; `--restore`);
  `scripts:needs` (`needs.json` ranked by cards blocked, and `--taxonomy` for the pool-wide family histogram);
  `vocab:doc` → `data/scripts/VOCABULARY.md` (generated from the zod barrel + registry + `docs/vocabulary/` and
  from NO wave output, idempotent, pinned by `test/lint-vocab-doc.test.ts`). `data/scripts/README.md` § "Queue,
  promotion and needs" documents the loop. How many judges a card needs is `src/cards/waveScope.ts`'s answer (two
  for the owner's decks and the EDHREC top-1k), asked per card rather than per invocation.
  **Deferred from 8k:** `scripts:render` and `scripts:shard` belong to the 8c slice, so they are not here; the
  batch `examples` list is empty until a wave is judged (the code is live, there is simply nothing judged yet);
  `scripts:promote` cannot itself re-run `scripts:verify`, so a wave must run 8c's gate before promotion; and
  `scripts/` is still outside every `tsconfig` (item 10), so the new CLIs are type-checked only by an explicit
  `tsc` invocation, not by `npm run typecheck:all`.
- **8j dashboard v2** — `verification.json` with pool tiers, slices (Commander-legal, owner's decks, EDHREC top-1k/5k,
  by type), script statuses, fidelity, fuzz, goldens, blocked families; `apps/web/components/coverage/CoveragePage.tsx`.
- **Phase 8 gate** — `verify:all` and `verify:deep` green on a quiet machine; goldens/fidelity/parse-snapshot
  fixtures accepted; dashboard shows tiers; Playwright green; then the first check-in with the owner (numbers, git
  log, cost so far, proposed 9.0).

## 5. How to continue (checklist for the next session)

1. Read the plan (`docs/plans/every-card-scripted.md`) Part 6 (orchestrator loop) and `docs/workflows/README.md`.
2. `git fetch --all`; inspect the branches in section 6; for each unmerged branch decide: merge (run the gates), or
   run one more fix round (`docs/workflows/example-fix-round.js` shape) with the listed issues, or re-implement.
3. Finish 8c → 8i → 8k → 8j with `core-wave.js` / `harness-wave.js` (two reviewers + fix round each), merge serially.
4. Run the Phase 8 gate on a quiet machine, commit `Phase 8: gate`, check in with the owner.
5. Phase 9.0 (composition core) is a serial core slice like 8a-1; 9.1/9.2 use the `vocab-wave` script from the plan
   (Part 5) with the family list from Part 3 and the taxonomy counts; Phase 10 uses `script-wave` over
   `scripts:queue` batches, promotion by the orchestrator only.
6. Keep this file and the memory notes current after every wave.

Commit convention: `Phase 8x: …` harness, `Phase 9.n: …` vocabulary, `Phase 10.x.g: …` scripts; end every commit
message with the co-author trailer your session is instructed to use.

## 6. State at the end of the session (2026-09-05)

- `main` = `e817a4f` (pushed). No unmerged branches, no worktrees, working tree clean.
- Every slice went through Opus implementation + two or three adversarial reviews + fix rounds: 8a-1 (1 fix
  round + a follow-up slice), 8a-2 (2), 8a-3 (5), 8d (2), 8e (1), 8f (1), 8g (2), 8h (1), 8x (1). The findings the
  last reviews left open are items 11–18 in section 3; none of them breaks a gate.
- What the gates say on `main`: `npm run verify:all` green (typecheck:all incl. `typecheck:schema`, 439 tests,
  `scripts:check`, `coverage:pool`, `parse:diff` 0, `verify:pool` 11064/477, bench 45.4 / 4.66 games/s);
  `npm run golden:check` reproduces exactly; `npm run fidelity:check` 13.28 / 16.12 / 8.33 / 20.38 hits per game;
  `npm run fuzz -- --games 300 --seed 1` 0 buckets; `npm run coverage:ops` 0 not allowlisted.
- Not done in Phase 8: 8c (`scripts:verify` + renderer), 8i (speed ladder, parse cache, Playwright leg of
  `verify:deep`), 8k (queue/promote/needs/vocab tooling), 8j (dashboard v2), the Phase 8 gate and the owner
  check-in. `verify:deep` today = `golden:check && fidelity:check`; the fuzz legs are `npm run fuzz:deep`.
- Cost of this session: ≈ 15 workflows, ≈ 55 Opus agents, ≈ 14 M subagent tokens, ≈ 20 h wall-clock including
  review loops.
- Owner's memory notes for this project live outside the repo (`~/.claude/projects/…/memory/`); everything they
  contain that matters is in this file, `docs/plans/every-card-scripted.md` and `docs/workflows/README.md`.
