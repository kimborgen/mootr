#!/bin/sh
# The machine-wide test slots (scripts/test-slot.sh, S-692), free: with one slot, a second command
# waits and names the holder (pid, worktree), then runs once the first ends; a killed holder frees
# its slot; a nested covered command doesn't wait on its parent's slot; two slots run two at once;
# STAM_TEST_NOSLOT=1 skips the slots; the light pool (--light, S-1288) runs while every heavy slot is held,
# and a heavy run still waits; test/run.sh's LIGHT names are plain node --test files. Uses a throwaway slot folder, never the machine's.
set -e
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
. "$ROOT/test/tmpdir.sh"
WORK="$(mktemp -d "$STAM_TEST_TMPDIR/stam-slottest.XXXXXX")"
export STAM_TEST_SLOT_DIR="$WORK/slots"
unset STAM_TEST_SLOT_HELD STAM_TEST_NOSLOT STAM_TEST_SLOTS
SLOT="sh $ROOT/scripts/test-slot.sh"
fail() { echo "FAIL: $1"; exit 1; }
cleanup() { set +e; kill $P1 $P2 $P3 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM HUP
P1=; P2=; P3=
# worker LOG NAME SECONDS: logs start and end.
cat >"$WORK/worker.sh" <<'EOS'
echo "start $2" >>"$1"; sleep "$3"; echo "end $2" >>"$1"
EOS
wait_for_line() { # FILE PATTERN
  i=0; until grep -q "$2" "$1" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 100 ] && fail "no '$2' in $1"; sleep 0.1; done
}

echo "== one slot: the second waits, names the holder, then runs"
export STAM_TEST_SLOTS=1
LOG="$WORK/a.log"
$SLOT sh "$WORK/worker.sh" "$LOG" first 2 >"$WORK/o1" 2>&1 & P1=$!
wait_for_line "$LOG" "start first"
$SLOT sh "$WORK/worker.sh" "$LOG" second 0 >"$WORK/o2" 2>&1 & P2=$!
wait_for_line "$WORK/o2" "waiting for a test slot"
wait_for_line "$WORK/o2" "worker.sh"
grep -q "pid [0-9]* in $ROOT " "$WORK/o2" || fail "holder not named with pid and worktree: $(cat "$WORK/o2")"
grep -q "start second" "$LOG" && fail "second ran while first held the slot"
wait $P1; wait $P2; P1=; P2=
[ "$(tr '\n' ' ' <"$LOG")" = "start first end first start second end second " ] || fail "order: $(cat "$LOG")"

echo "== a killed holder frees its slot"
LOG="$WORK/b.log"
$SLOT sh "$WORK/worker.sh" "$LOG" victim 30 >/dev/null 2>&1 & P1=$!
wait_for_line "$LOG" "start victim"
$SLOT sh "$WORK/worker.sh" "$LOG" next 0 >"$WORK/o3" 2>&1 & P2=$!
wait_for_line "$WORK/o3" "waiting for a test slot"
HOLDER=$(cut -d' ' -f1 "$WORK/slots/slot.0.owner")
pkill -9 -P "$HOLDER" 2>/dev/null || true # the sleep
kill -9 "$HOLDER"
wait_for_line "$LOG" "end next"
wait $P2; P2=
kill $P1 2>/dev/null || true; wait $P1 2>/dev/null || true; P1=

echo "== a nested covered command doesn't wait on its parent's slot"
timeout 20 $SLOT sh -c "$SLOT echo nested-ran" >"$WORK/o4" 2>&1 || fail "nested deadlocked: $(cat "$WORK/o4")"
grep -q nested-ran "$WORK/o4" || fail "nested didn't run"

echo "== the exit status passes through"
$SLOT sh -c 'exit 3' || [ $? = 3 ] || fail "exit status lost"

echo "== a command that exits 75 runs once and its status passes through"
: >"$WORK/count"
$SLOT sh -c "echo x >>$WORK/count; exit 75" && fail "exit 75 reported success"
[ "$(wc -l <"$WORK/count")" = 1 ] || fail "exit-75 command ran $(wc -l <"$WORK/count") times"

echo "== a stale STAM_TEST_SLOT_HELD (its slot is free) doesn't skip the slot"
touch "$WORK/slots/slot.0"
STAM_TEST_SLOT_HELD="$WORK/slots/slot.0" $SLOT sh -c 'echo $STAM_TEST_SLOT_HELD' >"$WORK/o5"
[ -s "$WORK/o5" ] || fail "no output"
sh "$ROOT/scripts/test-slot.sh" --held && fail "--held true outside a run"
STAM_TEST_SLOT_HELD="$WORK/slots/slot.0" sh "$ROOT/scripts/test-slot.sh" --held && fail "--held true for a free slot"
$SLOT sh -c 'sh "$0" --held' "$ROOT/scripts/test-slot.sh" || fail "--held false inside a run"
LOG="$WORK/e.log"
$SLOT sh "$WORK/worker.sh" "$LOG" holder 3 >/dev/null 2>&1 & P1=$!
wait_for_line "$LOG" "start holder"
STAM_TEST_SLOT_HELD="$WORK/slots/slot.0" timeout 1 $SLOT sh "$WORK/worker.sh" "$LOG" stale 0 >/dev/null 2>&1 && fail "a held-looking stale env skipped the busy slot"
wait $P1; P1=

echo "== two slots run two at once"
export STAM_TEST_SLOTS=2
LOG="$WORK/c.log"
$SLOT sh "$WORK/worker.sh" "$LOG" x 2 >/dev/null 2>&1 & P1=$!
$SLOT sh "$WORK/worker.sh" "$LOG" y 2 >/dev/null 2>&1 & P2=$!
wait_for_line "$LOG" "start x"; wait_for_line "$LOG" "start y"
grep -q "end" "$LOG" && fail "one ended before both started"
wait $P1; wait $P2; P1=; P2=

echo "== the light pool runs while every heavy slot is held; a heavy run still waits"
export STAM_TEST_SLOTS=1
LOG="$WORK/f.log"
$SLOT sh "$WORK/worker.sh" "$LOG" heavy 4 >/dev/null 2>&1 & P1=$!
wait_for_line "$LOG" "start heavy"
timeout 3 $SLOT --light sh "$WORK/worker.sh" "$LOG" light 0 >"$WORK/o6" 2>&1 || fail "light run waited behind the heavy slot: $(cat "$WORK/o6")"
grep -q "end light" "$LOG" || fail "light run didn't finish"
grep -q "end heavy" "$LOG" && fail "heavy ended before the light run (test too slow)"
STAM_TEST_LIGHT=1 timeout 3 $SLOT sh "$WORK/worker.sh" "$LOG" light2 0 >/dev/null 2>&1 || fail "STAM_TEST_LIGHT=1 waited"
timeout 1 $SLOT sh "$WORK/worker.sh" "$LOG" heavy2 0 >/dev/null 2>&1 && fail "a heavy run skipped the busy heavy slot"
[ -e "$WORK/slots/light.0" ] || fail "no light.0 slot file"
wait $P1; P1=
echo "== the light pool has its own count and waits when full"
export STAM_TEST_LIGHT_SLOTS=1
LOG="$WORK/g.log"
$SLOT --light sh "$WORK/worker.sh" "$LOG" l1 3 >/dev/null 2>&1 & P1=$!
wait_for_line "$LOG" "start l1"
timeout 1 $SLOT --light sh "$WORK/worker.sh" "$LOG" l2 0 >/dev/null 2>&1 && fail "second light run skipped the full light pool"
wait $P1; P1=
unset STAM_TEST_LIGHT_SLOTS
echo "== a light run under a held heavy slot runs at once"
timeout 20 $SLOT sh -c "$SLOT --light echo light-nested" >"$WORK/o7" 2>&1 || fail "light nested waited: $(cat "$WORK/o7")"
grep -q light-nested "$WORK/o7" || fail "light nested didn't run"
echo "== test/run.sh's LIGHT names are plain node --test files"
LIGHT=$(sed -n '/^LIGHT="$/,/^"$/p' "$ROOT/test/run.sh" | grep -v '^LIGHT=\|^"$')
[ -n "$LIGHT" ] || fail "no LIGHT names"
for n in $LIGHT; do
  line=$(grep "^    $n) echo \"node --test test/[^ ]*\.test\.mjs\" ;;$" "$ROOT/test/run.sh") || fail "$n isn't a node --test entry"
  f=$(echo "$line" | sed 's/.*node --test \(test\/[^"]*\)".*/\1/')
  grep -qiE "lib\.sh|tmux|playwright|chromium|daemon|listen|spawn|fork\(|exec|child_process|cli\.ts|stam-fast|dist/|fetch\(|http" "$ROOT/$f" && fail "$n ($f) looks like a daemon or browser test"
done
echo "== STAM_TEST_NOSLOT=1 skips the slots"
export STAM_TEST_SLOTS=1
LOG="$WORK/d.log"
$SLOT sh "$WORK/worker.sh" "$LOG" held 3 >/dev/null 2>&1 & P1=$!
wait_for_line "$LOG" "start held"
STAM_TEST_NOSLOT=1 timeout 2 $SLOT sh "$WORK/worker.sh" "$LOG" free 0 >/dev/null 2>&1 || fail "NOSLOT run waited"
wait $P1; P1=
echo "PASS"
