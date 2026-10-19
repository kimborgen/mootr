#!/bin/sh
# Runs CMD... in one of N machine-wide slots, so heavy test commands (test/run.sh, web vitest,
# web/check) don't pile up: storage hit load 41 on 8 cores from six worktrees at once (S-692).
#   scripts/test-slot.sh [--light] CMD [ARGS...]
# N is STAM_TEST_SLOTS, else max(1, nproc/4). Each slot is a flock on $STAM_TEST_SLOT_DIR/slot.I
# (default /tmp/stam-test-slots). It tries every slot without waiting, then polls them every second
# and, once, names the holders (pid, worktree) from the slot.I.owner files. The lock is released when
# CMD ends, however it ends: a killed holder's flock dies with it. STAM_TEST_NOSLOT=1 skips the slots.
# --light (or STAM_TEST_LIGHT=1) takes the light pool instead: slot files $STAM_TEST_SLOT_DIR/light.I, count
# STAM_TEST_LIGHT_SLOTS (default STAM_TEST_SLOTS, else as N), for plain unit tests with no daemon or browser (S-1288), so a 30 ms
# `node --test` never queues behind phone checks. Heavy runs keep the slot.I pool; the pools don't block each other.
# Nesting: the run sets STAM_TEST_SLOT_HELD, so a covered command inside a covered one (web/check/run.sh
# under test/run.sh) runs at once instead of waiting for its own slot, which would deadlock at N=1.
# --held exits 0 when CMD needs no slot of its own (STAM_TEST_NOSLOT, no flock, or STAM_TEST_SLOT_HELD names
# a slot file that is locked right now by an ancestor of this process), so callers write `sh scripts/test-slot.sh --held || exec sh scripts/test-slot.sh ...`.
# A stale STAM_TEST_SLOT_HELD, inherited by a process outside the run, finds its slot free and takes a slot.
# The merge gate runs its commands with STAM_TEST_SLOT_DIR=/tmp/stam-test-slots-gate and one slot, so
# a gate never queues behind developers' runs; it can add one run to the machine's load.
# Lock order: gate.lock (the merge gate), then a slot (heavy or light), then test/run.sh's suite lock, then the Chromium
# lock. Nothing takes a slot and then an earlier lock, so they never cycle. The gate takes no slot of
# its own: each gate command it runs (test/run.sh, npm test, web/check/run.sh) takes one, in turn.
held() {
  [ -n "$STAM_TEST_NOSLOT" ] && return 0
  command -v flock >/dev/null || return 0
  [ -n "$STAM_TEST_SLOT_HELD" ] && [ -f "$STAM_TEST_SLOT_HELD" ] || return 1
  flock -n -E 75 "$STAM_TEST_SLOT_HELD" true
  [ $? = 75 ] || return 1
  # Locked by this run, not by someone else: the holder (the owner file's pid) is our ancestor.
  read -r owner _ <"$STAM_TEST_SLOT_HELD.owner" 2>/dev/null || return 1
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$p" = "$owner" ] && return 0
    p=$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$p/status" 2>/dev/null)
  done
  return 1
}
POOL=slot; COUNT=$STAM_TEST_SLOTS
if [ "$1" = --light ] || [ "$STAM_TEST_LIGHT" = 1 ]; then
  POOL=light; COUNT=${STAM_TEST_LIGHT_SLOTS:-$STAM_TEST_SLOTS}; COUNTVAR=LIGHT_
  [ "$1" = --light ] && shift
fi
if [ "$1" = --held ]; then held; exit; fi
[ "$#" -gt 0 ] || { echo "usage: scripts/test-slot.sh CMD [ARGS...]"; exit 2; }
if [ "$STAM_TEST_SLOT_RUN" = 1 ]; then
  # Re-exec'd under flock: mark that CMD started (a CMD that exits 75 isn't a busy slot), record the
  # holder (exec keeps this pid), then become CMD.
  : >"$STAM_TEST_SLOT_STARTED"
  printf '%s %s %s\n' "$$" "$(pwd)" "$*" >"$STAM_TEST_SLOT_FILE.owner"
  unset STAM_TEST_SLOT_RUN STAM_TEST_SLOT_FILE STAM_TEST_SLOT_STARTED
  exec "$@"
fi
if held; then exec "$@"; fi
N=${COUNT:-$(( $(nproc 2>/dev/null || echo 4) / 4 ))}
case $N in ''|*[!0-9]*) N=1 ;; esac
[ "$N" -ge 1 ] || N=1
DIR=${STAM_TEST_SLOT_DIR:-/tmp/stam-test-slots}
mkdir -p "$DIR" 2>/dev/null && chmod 1777 "$DIR" 2>/dev/null
HERE=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
# -o closes the lock fd in CMD, so a daemon it starts can't keep the slot. -E 75: busy.
try() {
  i=0
  while [ "$i" -lt "$N" ]; do
    f=$DIR/$POOL.$i
    started=$DIR/.started.$$.$i
    rm -f "$started"
    STAM_TEST_SLOT_RUN=1 STAM_TEST_SLOT_FILE=$f STAM_TEST_SLOT_STARTED=$started STAM_TEST_SLOT_HELD=$f \
      flock -n -o -E 75 "$f" sh "$HERE" "$@"
    rc=$?
    if [ -e "$started" ]; then rm -f "$started"; exit "$rc"; fi
    [ "$rc" = 75 ] || exit "$rc"
    i=$((i + 1))
  done
}
holders() {
  for o in "$DIR"/$POOL.*.owner; do
    [ -f "$o" ] || continue
    read -r pid rest <"$o" || continue
    kill -0 "$pid" 2>/dev/null && echo "  pid $pid in $rest"
  done
}
try "$@"
echo "waiting for a test slot (all $N busy, STAM_TEST_${COUNTVAR}SLOTS to change); holders:"
holders
while :; do
  sleep 1
  try "$@"
done
