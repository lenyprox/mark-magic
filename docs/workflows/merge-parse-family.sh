#!/usr/bin/env bash
# Merge one parser-rule family branch into main and run the per-merge gate (Phase 9.1p+; docs/workflows/README.md
# "Merge procedure"). Leaves the merge STAGED and uncommitted so the orchestrator reads the parse:diff groups and the
# forge:diff findings before `npm run parse:accept && git add data/master/parse-snapshot.json && git commit`.
#
#   bash docs/workflows/merge-parse-family.sh <branch> <family> <n>        (n = the 9.1p.<n> commit number)
#
# Conflicts it resolves itself: the generated barrels (regenerated), test/scenarios.test.ts (union-scenarios.py:
# main's file plus the branch's import + suites entry), data/master/parse-snapshot.json (ours, re-accepted after
# the gate). Any other conflict or gate failure stops the script with the merge still staged. Logs go to
# $MM_LOGDIR (default data/bench/merge-logs, gitignored): vq-<family>.log, test-<family>.log, pd-<family>.log
# (the parse:diff groups), forge-<family>.md / .json, golden-<family>.log.
set -u
ROOT=/c/Users/vprog/dev/mark-magic
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="${MM_LOGDIR:-$ROOT/data/bench/merge-logs}"; mkdir -p "$LOG"
BRANCH="$1"; FAMILY="$2"; N="$3"
cd "$ROOT" || exit 2
echo "=== merge $BRANCH ($FAMILY) as 9.1p.$N — $(date +%H:%M:%S)"
[ -z "$(git status --porcelain | grep -v '^??')" ] || { echo "ABORT: working tree not clean"; exit 2; }
git merge --no-ff --no-commit "$BRANCH" >/dev/null 2>&1 || true
CONFLICTS=$(git diff --name-only --diff-filter=U)
echo "conflicts: ${CONFLICTS:-none}"
for f in $CONFLICTS; do
  case "$f" in
    src/cards/rules/_registry.ts|src/engine/ops/_registry.ts|src/cards/_schemas.ts) echo "  $f -> regenerated";;
    test/scenarios.test.ts) python "$HERE/union-scenarios.py" "$BRANCH" || { echo "ABORT: scenarios union failed"; exit 3; }; git add test/scenarios.test.ts;;
    data/master/parse-snapshot.json) git checkout --ours -- "$f"; git add "$f"; echo "  $f -> ours (re-accepted after the gate)";;
    *) echo "ABORT: unexpected conflict in $f"; exit 3;;
  esac
done
node scripts/gen-registry.mjs >/dev/null && git add src/cards/rules/_registry.ts src/engine/ops/_registry.ts src/cards/_schemas.ts 2>/dev/null
[ -z "$(git diff --name-only --diff-filter=U)" ] || { echo "ABORT: conflicts remain"; git diff --name-only --diff-filter=U; exit 3; }
gate() { local name="$1"; shift; echo "--- $name"; if "$@"; then echo "    ok"; else echo "ABORT: $name failed"; exit 4; fi; }
gate "gen:registry up to date" bash -c 'node scripts/gen-registry.mjs | grep -q "up to date"'
gate "typecheck:all" npm run -s typecheck:all
gate "verify:quick" bash -c "npm run -s verify:quick > '$LOG/vq-$FAMILY.log' 2>&1 || { tail -30 '$LOG/vq-$FAMILY.log'; exit 1; }"
gate "npm test" bash -c "npm test > '$LOG/test-$FAMILY.log' 2>&1 || { grep -n 'not ok\|# fail' '$LOG/test-$FAMILY.log' | head -40; exit 1; }"
echo "--- coverage:pool (with scripts)"; npm run -s coverage:pool | grep -i '"fully_parsed"\|"paper"' | head -3; git checkout -- data/master/parser-coverage.json
echo "--- parse:diff (read every group: a NO LONGER line or a previously fully-parsed card that moved is an over-claim; a (same unparsed lines) group is one unless every card is an inner unknown that now parses under a still-failing head — dump the parser-alone ASTs before/after and say so)"
npm run -s parse:diff > "$LOG/pd-$FAMILY.log" 2>&1
echo "    NO LONGER lines: $(grep -c 'NO LONGER parses' "$LOG/pd-$FAMILY.log")"
echo "    same-unparsed groups: $(grep -c 'same unparsed lines' "$LOG/pd-$FAMILY.log")"
tail -3 "$LOG/pd-$FAMILY.log"
echo "--- forge:diff --changed (read every target-missing / may-missing / trigger-kind finding on a newly claimed line)"
npm run -s forge:diff -- --changed --md "$LOG/forge-$FAMILY.md" --out "$LOG/forge-$FAMILY.json" | head -30
gate "golden:check (parser only)" bash -c "MTG_SCRIPTS=0 npm run -s golden:check > '$LOG/golden-$FAMILY.log' 2>&1 || { tail -20 '$LOG/golden-$FAMILY.log'; exit 1; }"
echo "--- coverage:ops"; npm run -s coverage:ops | tail -3
echo "--- CR bytes in staged diff: $(git diff --cached | tr -cd '\r' | wc -c)"
echo "=== gate done $(date +%H:%M:%S) — read $LOG/pd-$FAMILY.log and $LOG/forge-$FAMILY.md, then: npm run parse:accept && git add data/master/parse-snapshot.json && git commit"
