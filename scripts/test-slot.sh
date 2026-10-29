#!/bin/sh
# Runs CMD... in one of N machine-wide slots, so heavy test commands (test/run.sh,
# web/check) don't pile up: storage hit load 41 on 8 cores from six worktrees at once (S-692).
#   scripts/test-slot.sh [--light] CMD [ARGS...]
# A CMD that is test/run.sh takes no slot here: run.sh takes its own, light or heavy, from its names (S-3585).
# N is STAM_TEST_SLOTS, else max(1, nproc/4). Each slot is a flock on $STAM_TEST_SLOT_DIR/slot.I
# (default /tmp/stam-test-slots). It tries every slot without waiting, then polls them every second
# and, once, names the holders (pid, worktree) from the slot.I.owner files. The lock is released when
# CMD ends, however it ends: a killed holder's flock dies with it. STAM_TEST_NOSLOT=1 skips the slots.
# Waiters are first come, first served (S-2153): each takes a ticket, a number in $DIR/queue.POOL/ that holds
# its pid, numbered under $DIR/queue.POOL.lock. Only the lowest ticket whose pid is alive tries for a slot, so a
# later run that polls first can't take a freed slot from an earlier one. No queue lock is held across that check
# and the flock try: a ticket leaves the queue only when its owner takes a slot (the holder removes it before CMD
# starts) or exits (a trap; a killed waiter's pid fails the check). So two waiters never both see themselves
# first while the other is still queued, and the flock stays the atomic step that decides which slot is taken.
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
# Runs CMD with its own TMPDIR under the worktree when the caller set none (S-2586, test/runtmp.sh): CMD is a
# child then, so the folder can be removed when it ends; with a TMPDIR already set it is exec'd as before.
runcmd() {
  # S-3463: a missing command still exits 127 below; this only says why, on stderr.
  command -v "$1" >/dev/null 2>&1 || echo "test-slot: $1 isn't found or runnable. For a vitest file, run \`npm test -- FILE\` from web/ (S-3463)." >&2
  root=$(dirname "$(dirname "$HERE")")
  . "$root/test/runtmp.sh"
  runtmp_make "$root"
  [ -n "$RUNTMP_OWNED" ] || exec "$@"
  # Foreground, so Ctrl-C reaches CMD and CMD keeps stdin; a signal to this shell runs the EXIT trap once CMD is gone.
  trap 'rm -rf "$RUNTMP_OWNED"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  "$@"
  rc=$?
  exit $rc
}
held() {
  [ -n "${MOOTR_TEST_NOSLOT:-${STAM_TEST_NOSLOT:-}}" ] && return 0
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
HERE=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
POOL=slot; COUNT=${MOOTR_TEST_SLOTS:-${STAM_TEST_SLOTS:-}}
if [ "$1" = --light ] || [ "${MOOTR_TEST_LIGHT:-${STAM_TEST_LIGHT:-}}" = 1 ]; then
  POOL=light; COUNT=${MOOTR_TEST_LIGHT_SLOTS:-${STAM_TEST_LIGHT_SLOTS:-${MOOTR_TEST_SLOTS:-${STAM_TEST_SLOTS:-}}}}; COUNTVAR=LIGHT_
  [ "$1" = --light ] && shift
fi
if [ "$1" = --held ]; then held; exit; fi
[ "$#" -gt 0 ] || { echo "usage: scripts/test-slot.sh CMD [ARGS...]"; exit 2; }
if [ "$STAM_TEST_SLOT_RUN" = 1 ]; then
  # Re-exec'd under flock: mark that CMD started (a CMD that exits 75 isn't a busy slot), record the
  # holder (exec keeps this pid), then become CMD.
  : >"$STAM_TEST_SLOT_STARTED"
  printf '%s %s %s\n' "$$" "$(pwd)" "$*" >"$STAM_TEST_SLOT_FILE.owner"
  rm -f "$STAM_TEST_SLOT_TICKET" # the slot is ours: the next ticket in line may try now
  unset STAM_TEST_SLOT_RUN STAM_TEST_SLOT_FILE STAM_TEST_SLOT_STARTED STAM_TEST_SLOT_TICKET
  runcmd "$@"
fi
if held; then runcmd "$@"; fi
# test/run.sh takes its own slot once it knows its names (its exec of this script, below): a light pool when every
# name is LIGHT (run.sh:1242). A slot taken here first would hide that pool, so a run of only LIGHT names queued behind
# heavy runs (S-3585). So the wrapped form runs at once, and that exec below takes the slot.
case "$1" in */test/run.sh | test/run.sh) runcmd "$@" ;; esac
N=${COUNT:-$(( $(nproc 2>/dev/null || echo 4) / 4 ))}
case $N in ''|*[!0-9]*) N=1 ;; esac
[ "$N" -ge 1 ] || N=1
DIR=${MOOTR_TEST_SLOT_DIR:-${STAM_TEST_SLOT_DIR:-/tmp/stam-test-slots}}
mkdir -p "$DIR" 2>/dev/null && chmod 1777 "$DIR" 2>/dev/null
HERE=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
QUEUE=$DIR/queue.$POOL
# A ticket is a file named by its number, written as "$$" (the waiter's pid) through a temp name, so a reader
# never sees it half written. Numbers come from the counter under the queue lock, so they are unique and in arrival order.
take_ticket() {
  mkdir -p "$QUEUE" 2>/dev/null && chmod 1777 "$QUEUE" 2>/dev/null
  (
    flock 9
    n=$(cat "$DIR/queue.$POOL.next" 2>/dev/null)
    n=$((${n:-0} + 1))
    echo "$n" >"$DIR/queue.$POOL.next"
    echo "$$" >"$QUEUE/.$n"
    mv "$QUEUE/.$n" "$QUEUE/$n"
    echo "$n"
  ) 9>"$DIR/queue.$POOL.lock"
}
# A pid that is running. A zombie (killed, not yet reaped by its parent) is dead; without /proc, kill -0 decides.
live() {
  st=$(sed -n 's/^.*) \([A-Za-z]\).*/\1/p' "/proc/$1/stat" 2>/dev/null)
  [ -n "$st" ] && { [ "$st" != Z ]; return; }
  kill -0 "$1" 2>/dev/null
}
# The lowest ticket whose pid is alive; the dead ones are dropped on the way.
first() {
  for n in $(ls "$QUEUE" 2>/dev/null | sort -n); do
    pid=$(cat "$QUEUE/$n" 2>/dev/null)
    if [ -n "$pid" ] && live "$pid"; then
      echo "$n"
      return
    fi
    rm -f "$QUEUE/$n"
  done
}
# -o closes the lock fd in CMD, so a daemon it starts can't keep the slot. -E 75: busy.
try() {
  i=0
  while [ "$i" -lt "$N" ]; do
    f=$DIR/$POOL.$i
    started=$DIR/.started.$$.$i
    rm -f "$started"
    STAM_TEST_SLOT_RUN=1 STAM_TEST_SLOT_FILE=$f STAM_TEST_SLOT_STARTED=$started STAM_TEST_SLOT_HELD=$f \
      STAM_TEST_SLOT_TICKET=$TICKET flock -n -o -E 75 "$f" sh "$HERE" "$@"
    rc=$?
    if [ -e "$started" ]; then rm -f "$started"; exit "$rc"; fi
    [ "$rc" = 75 ] || exit "$rc"
    i=$((i + 1))
  done
}
# This waiter's place among the queued tickets, 1 first (S-3403).
position() {
  p=0
  for n in $(ls "$QUEUE" 2>/dev/null | sort -n); do
    p=$((p + 1))
    [ "$n" = "$MINE" ] && { echo "$p"; return; }
  done
  echo 0
}
holders() {
  for o in "$DIR"/$POOL.*.owner; do
    [ -f "$o" ] || continue
    read -r pid rest <"$o" || continue
    kill -0 "$pid" 2>/dev/null && echo "  pid $pid in $rest"
  done
}
MINE=$(take_ticket)
TICKET=$QUEUE/$MINE
# A signal exits through the EXIT trap, which drops this waiter's ticket. A holder has already removed its ticket.
trap 'rm -f "$TICKET"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$(first)" = "$MINE" ]; then try "$@"; fi
echo "waiting for a test slot (all $N busy, STAM_TEST_${COUNTVAR}SLOTS to change); queue position $(position) of $(ls "$QUEUE" 2>/dev/null | wc -l | tr -d ' '); holders:"
holders
while :; do
  sleep 1
  # A cleared queue (its dir or this ticket removed) would leave no ticket to be first: take a new one.
  [ -f "$TICKET" ] || { MINE=$(take_ticket); TICKET=$QUEUE/$MINE; }
  if [ "$(first)" = "$MINE" ]; then try "$@"; fi
done
