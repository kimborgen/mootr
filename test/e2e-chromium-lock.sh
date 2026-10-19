#!/bin/sh
# The Chromium check lock (web/check/chromium-lock.mjs), free (no Chromium): two checks
# that import it run one at a time, the second naming the holder while it waits, the holder's
# time limit (STAM_CHROMIUM_TIMEOUT) ends it with 124 and doesn't count the wait, and
# STAM_CHROMIUM_NOLOCK=1 lets them run at once. Uses a throwaway worker, not Playwright.
set -e
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
. "$ROOT/test/tmpdir.sh"
WORK="$(mktemp -d "$STAM_TEST_TMPDIR/stam-locktest.XXXXXX")"
# The test's own lock, in its folder: never the machine's /tmp/stam-chromium.lock, which a real check may hold.
LOCK="$WORK/chromium.lock"
export STAM_CHROMIUM_LOCK="$LOCK"
fail() { echo "FAIL: $1"; exit 1; }
cleanup() { set +e; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM HUP
export STAM_TEST_NOSLOT=1
unset STAM_CHROMIUM_LOCKED STAM_CHROMIUM_NOLOCK STAM_CHROMIUM_TIMEOUT STAM_CHROMIUM_PRIORITY # the merge gate sets the last for its gates

# worker.mjs LOG [SLEEP_MS]: logs its start and end, holding the lock for SLEEP_MS.
cat >"$WORK/worker.mjs" <<EOF
import '$ROOT/web/check/chromium-lock.mjs';
import { appendFileSync } from 'node:fs';
const [log, ms = '1500'] = process.argv.slice(2);
appendFileSync(log, 'start ' + Date.now() + '\n');
await new Promise((r) => setTimeout(r, Number(ms)));
appendFileSync(log, 'end ' + Date.now() + '\n');
EOF

# Waits until a check holds the lock and has written its owner file, so the next check sees a holder.
wait_owner() {
  i=0
  while [ ! -f "$LOCK.owner" ]; do
    i=$((i + 1)); [ "$i" -gt 100 ] && fail "no owner file"
    sleep 0.1
  done
}

echo "== two checks run one at a time, the second naming the holder"
rm -f "$LOCK"
LOG="$WORK/serial.log"
node "$WORK/worker.mjs" "$LOG" 1500 >"$WORK/serial1.out" 2>&1 & P1=$!
wait_owner
node "$WORK/worker.mjs" "$LOG" 100 >"$WORK/serial2.out" 2>&1 & P2=$!
wait "$P1"; wait "$P2"
grep -q "^waiting for the Chromium lock: worker\.mjs in .* since [0-9][0-9]:[0-9][0-9] (pid [0-9]*)\$" "$WORK/serial2.out" \
  || fail "the waiting check didn't name the holder: $(cat "$WORK/serial2.out")"
# Each check appends its start and end markers in order, so the file's order is the order of
# events: one check at a time means start, end, start, end. Interleaving would show start, start.
python3 - "$LOG" <<'PY' || fail "the checks overlapped: $(cat "$LOG")"
import sys
kinds = [l.split()[0] for l in open(sys.argv[1]) if l.strip()]
assert kinds == ['start', 'end', 'start', 'end'], kinds
PY
[ ! -f "$LOCK.owner" ] || fail "the owner file was left behind"

echo "== STAM_CHROMIUM_TIMEOUT ends a check that runs too long with 124"
rm -f "$LOCK"
START=$(date +%s)
rc=0
STAM_CHROMIUM_TIMEOUT=1 node "$WORK/worker.mjs" "$WORK/timeout.log" 10000 >"$WORK/timeout.out" 2>&1 || rc=$?
[ "$rc" -eq 124 ] || fail "expected exit 124, got $rc: $(cat "$WORK/timeout.out")"
[ $(( $(date +%s) - START )) -lt 8 ] || fail "the check ran on past its time limit"
grep -q 'timed out after 1s' "$WORK/timeout.out" || fail "no timeout line: $(cat "$WORK/timeout.out")"
[ ! -f "$LOCK.owner" ] || fail "the owner file was left behind after a timeout"

echo "== the wait doesn't count against STAM_CHROMIUM_TIMEOUT"
rm -f "$LOCK"
node "$WORK/worker.mjs" "$WORK/hold.log" 2000 >"$WORK/hold.out" 2>&1 & P3=$!
wait_owner
# Waits about 2s for the lock, more than its 1s limit; its own run is 0.1s, so it must exit 0.
rc=0
STAM_CHROMIUM_TIMEOUT=1 node "$WORK/worker.mjs" "$WORK/waited.log" 100 >"$WORK/waited.out" 2>&1 || rc=$?
wait "$P3" || true
[ "$rc" -eq 0 ] || fail "a check waiting for the lock was killed by its limit: $(cat "$WORK/waited.out")"
grep -q 'waiting for the Chromium lock' "$WORK/waited.out" || fail "the waiting check printed no holder"

echo "== a gate check queued after a plain one runs first, and the ticker stops once the lock is held"
rm -f "$LOCK"
LOG3="$WORK/prio.log"
RELEASE="$WORK/release"
# prio.mjs LOG NAME HOLD: logs "NAME start" and "NAME end" while it holds the lock; HOLD is a milliseconds
# count, or file:PATH to hold until that file exists.
cat >"$WORK/prio.mjs" <<EOF2
import '$ROOT/web/check/chromium-lock.mjs';
import { appendFileSync, existsSync } from 'node:fs';
const [log, name, hold] = process.argv.slice(2);
console.error(name + ' start');
appendFileSync(log, name + ' start\\n');
if (hold.startsWith('file:')) while (!existsSync(hold.slice(5))) await new Promise((r) => setTimeout(r, 20));
else await new Promise((r) => setTimeout(r, Number(hold)));
appendFileSync(log, name + ' end\\n');
EOF2
export STAM_CHROMIUM_TICK_MS=200 STAM_CHROMIUM_POLL_MS=100
node "$WORK/prio.mjs" "$LOG3" holder "file:$RELEASE" >"$WORK/prio-h.out" 2>&1 & PH=$!
wait_owner
node "$WORK/prio.mjs" "$LOG3" plain 100 >"$WORK/prio-p.out" 2>&1 & PP=$!
# Waits until the plain check is queued (it prints that it waits), so the gate check queues after it.
i=0
while ! grep -q 'waiting for' "$WORK/prio-p.out" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 100 ] && fail "plain check never queued"; sleep 0.1; done
STAM_CHROMIUM_PRIORITY=gate node "$WORK/prio.mjs" "$LOG3" gate 100 >"$WORK/prio-g.out" 2>&1 & PG=$!
# The gate check is queued once it has marked itself; the plain check has waited at least one tick by then.
i=0
while ! ls "$LOCK".gate.* >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -gt 100 ] && fail "gate check never queued"; sleep 0.1; done
i=0
while ! grep -q '^still waiting' "$WORK/prio-p.out"; do i=$((i + 1)); [ "$i" -gt 100 ] && fail "plain check never ticked"; sleep 0.1; done
: >"$RELEASE"
wait "$PH"; wait "$PP"; wait "$PG"
unset STAM_CHROMIUM_TICK_MS STAM_CHROMIUM_POLL_MS
python3 - "$LOG3" <<'PY' || fail "the gate check didn't go first: $(cat "$LOG3")"
import sys
order = [l.strip() for l in open(sys.argv[1]) if l.strip()]
assert order == ['holder start', 'holder end', 'gate start', 'gate end', 'plain start', 'plain end'], order
PY
# The plain check printed "still waiting" while queued; once it started (printing "plain start") it holds the lock
# and the ticker must be quiet.
python3 - "$WORK/prio-p.out" <<'PY' || fail "the still-waiting ticker kept running after the lock was taken: $(cat "$WORK/prio-p.out")"
import sys
lines = [l.strip() for l in open(sys.argv[1]) if l.strip()]
i = lines.index('plain start')
assert not any(l.startswith('still waiting') for l in lines[i:]), lines
PY
ls "$LOCK".gate.* >/dev/null 2>&1 && fail "a gate marker was left behind"

echo "== STAM_CHROMIUM_NOLOCK=1 skips the lock"
rm -f "$LOCK"
LOG2="$WORK/nolock.log"
STAM_CHROMIUM_NOLOCK=1 node "$WORK/worker.mjs" "$LOG2" 1500 >/dev/null 2>&1 & P4=$!
STAM_CHROMIUM_NOLOCK=1 node "$WORK/worker.mjs" "$LOG2" 1500 >/dev/null 2>&1 & P5=$!
wait "$P4"; wait "$P5"
# Unlocked, both checks start before either ends: the first two markers are both starts.
python3 - "$LOG2" <<'PY' || fail "the unlocked checks didn't run at once: $(cat "$LOG2")"
import sys
kinds = [l.split()[0] for l in open(sys.argv[1]) if l.strip()]
assert len(kinds) == 4 and kinds[:2] == ['start', 'start'], kinds
PY

echo "PASS e2e-chromium-lock"
