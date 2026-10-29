#!/bin/sh
# test/run.sh's per-test time limit (S-323), free: a test that hangs past STAM_TEST_TIMEOUT
# shows as HUNG with its name and time, its whole process group goes (a grandchild that
# ignores SIGTERM included), the tests after it still run, and a SIGTERM to run.sh stops
# the running test's group, its SIGTERM-ignoring grandchild too, before run.sh exits. Runs a copy of run.sh in its own folder, with fake m1 (hangs) and m2
# (passes) tests, so no daemon starts and the machine's suite lock isn't taken.
set -e
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
. "$ROOT/test/tmpdir.sh"
WORK="$(mktemp -d "$STAM_TEST_TMPDIR/stam-runtimeout.XXXXXX")"
fail() { echo "FAIL: $1"; exit 1; }
cleanup() {
  set +e
  # Only the processes this test started, by their pids, if a run left them.
  for f in child.pid test.pid; do [ -s "$WORK/$f" ] && kill -KILL "$(cat "$WORK/$f")" 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM HUP

mkdir "$WORK/test"
cp "$ROOT/test/run.sh" "$ROOT/test/tmpdir.sh" "$ROOT/test/runtmp.sh" "$WORK/test/"
# m1 starts a grandchild that ignores SIGTERM, records its own pid and the grandchild's, then hangs.
cat >"$WORK/test/e2e-m1.sh" <<EOF
#!/bin/sh
sh -c 'trap "" TERM; while :; do sleep 1; done' &
echo \$! >"$WORK/child.pid"
echo \$\$ >"$WORK/test.pid"
while :; do sleep 1; done
EOF
printf '#!/bin/sh\necho ok\n' >"$WORK/test/e2e-m2.sh"

echo "== a hung test is stopped and named, and the next one runs"
set +e
STAM_TEST_NOSLOT=1 STAM_TEST_NOLOCK=1 STAM_TEST_TIMEOUT=2 STAM_TEST_KILL_AFTER=1 STAM_TEST_TMPDIR="$WORK" sh "$WORK/test/run.sh" m1 m2 >"$WORK/out" 2>&1
code=$?
set -e
cat "$WORK/out"
[ "$code" = 1 ] || fail "run.sh exited $code, want 1"
grep -q '^test m1 hung: stopped after [0-9]*s (STAM_TEST_TIMEOUT=2)' "$WORK/out" || fail "no hung line for m1"
grep -q '^m1 *HUNG' "$WORK/out" || fail "m1 not HUNG in the table"
grep -q '^m2 *PASS' "$WORK/out" || fail "m2 didn't run after the hung test"

echo "== the hung test's process group is gone, the SIGTERM-ignoring grandchild included"
[ -s "$WORK/child.pid" ] || fail "m1 never started its grandchild"
child=$(cat "$WORK/child.pid")
# Waits until process $1 is gone (or a zombie), failing with $2 if it stays.
gone() {
  i=0
  while kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]; do
    i=$((i + 1)); [ "$i" -gt 50 ] && fail "$2"
    sleep 0.1
  done
}
# run.sh sent the SIGKILL before it moved on; this only gives the kernel a moment to reap it.
gone "$child" "grandchild $child outlived the hung test"

echo "== a SIGTERM to run.sh stops the test it is running"
rm -f "$WORK/child.pid" "$WORK/test.pid"
STAM_TEST_NOSLOT=1 STAM_TEST_NOLOCK=1 STAM_TEST_KILL_AFTER=1 STAM_TEST_TMPDIR="$WORK" sh "$WORK/test/run.sh" m1 >"$WORK/out2" 2>&1 &
run=$!
i=0
while [ ! -s "$WORK/test.pid" ] || [ ! -s "$WORK/child.pid" ]; do
  i=$((i + 1)); [ "$i" -gt 100 ] && fail "m1 never started"
  sleep 0.1
done
kill -TERM "$run"
set +e
wait "$run"
code=$?
set -e
[ "$code" = 130 ] || fail "run.sh exited $code on SIGTERM, want 130"
gone "$(cat "$WORK/test.pid")" "the test outlived run.sh's SIGTERM"
gone "$(cat "$WORK/child.pid")" "the SIGTERM-ignoring grandchild outlived run.sh's SIGTERM"
echo "PASS"
