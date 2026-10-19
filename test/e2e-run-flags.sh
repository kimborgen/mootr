#!/bin/sh
# test/run.sh refuses a --flag it doesn't know with usage, before it takes a test slot or runs anything (S-1943).
# Before, `--light` was a test name: run.sh queued for a slot, then printed the whole test list. Uses a throwaway
# slot folder, with its one slot held by a sleeping holder, so a run.sh that waits for a slot times out here.
set -e
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
. "$ROOT/test/tmpdir.sh"
WORK="$(mktemp -d "$STAM_TEST_TMPDIR/stam-runflags.XXXXXX")"
export STAM_TEST_SLOT_DIR="$WORK/slots"
export STAM_TEST_SLOTS=1
unset STAM_TEST_SLOT_HELD STAM_TEST_NOSLOT STAM_TEST_LIGHT
fail() { echo "FAIL: $1"; exit 1; }
cleanup() { set +e; HOLDER=$(cut -d' ' -f1 "$WORK/slots/slot.0.owner" 2>/dev/null); [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM HUP
cd "$ROOT"

echo "== an unknown flag exits 2 with usage and the flag's name, without waiting for a slot"
sh scripts/test-slot.sh sh -c 'touch "$0"; exec sleep 30' "$WORK/held" >/dev/null 2>&1 &
i=0; until [ -e "$WORK/held" ]; do i=$((i + 1)); [ "$i" -gt 100 ] && fail "the holder never took the slot"; sleep 0.1; done
status=0
timeout 20 sh test/run.sh --bogus >"$WORK/out" 2>&1 || status=$?
[ "$status" = 2 ] || fail "exit $status, want 2 (124 = it waited for the slot): $(cat "$WORK/out")"
grep -q "unknown flag --bogus" "$WORK/out" || fail "the message doesn't name the flag: $(cat "$WORK/out")"
grep -q "usage: test/run.sh" "$WORK/out" || fail "no usage in the message: $(cat "$WORK/out")"
grep -q "test/run.sh NAME" "$WORK/out" || fail "no pointer to the single-test form: $(cat "$WORK/out")"
grep -q "running:\|waiting for\|no test" "$WORK/out" && fail "it ran or listed tests: $(cat "$WORK/out")"
echo "PASS"
