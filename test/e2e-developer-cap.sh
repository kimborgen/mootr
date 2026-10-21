#!/bin/sh
# The developer slot cap on the daemon's spawn path (S-2008), free: with developerCap 1, a first
# developer spawns, a second spawned without the human key is queued (place, holder named) and leaves
# no worktree and no registry row, a daemon restart keeps the queue, an urgent one queues ahead of it, a bad urgent reason is a 400, a reviewer type is not capped, and the human spawns past the cap.
# A queued spawn is cancelled by name, and survives a restart cancelled (S-2134); a peer's spawn drops the same-name one from the same caller.
# A fake `claude` stands in, so no model runs. Runs against its own daemon (test/lib.sh).
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
trap stam_test_cleanup EXIT
FAKE="$TEST_TMP/fake-bin"
mkdir -p "$FAKE"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nexec sleep 600\n' >"$FAKE/claude"
chmod +x "$FAKE/claude"
PATH="$FAKE:$PATH"
export PATH
# A fixed /proc (STAM_PROC_DIR), so the queue's load guard (S-2120) sees a quiet machine whatever this one's load is.
PROC_DIR="$TEST_TMP/proc"
mkdir -p "$PROC_DIR"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n' >"$PROC_DIR/stat"
printf 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       2000000 kB\n' >"$PROC_DIR/meminfo"
printf '0.10 0.10 0.10 1/200 1234\n' >"$PROC_DIR/loadavg"
export STAM_PROC_DIR="$PROC_DIR"
daemon_home main
printf '{ "peers": [], "developerCap": 1 }\n' >"$TEST_TMP/main/settings.json"
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
agent() { curl -s -w '\n%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL/api/agents" -d "$1"; }
worktrees() { git -C "$REPO" worktree list | wc -l; }

echo "-- 1. the first developer takes the slot"
R=$(human POST /api/agents "{\"name\":\"dev1\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"name":"dev1"' || fail "first developer: $R"
[ "$(worktrees)" = 2 ] || fail "expected the repo and one worktree, got $(worktrees)"

echo "-- 2. a second developer spawned without the human key is queued, naming the holder, leaving nothing"
R=$(agent "{\"name\":\"dev2\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 200 ] || fail "second developer not answered: $R"
printf %s "$R" | grep -q '"queued":true' || fail "not queued: $R"
printf %s "$R" | grep -q '"place":1' || fail "no place: $R"
printf %s "$R" | grep -q 'dev1' || fail "holder not named: $R"
[ "$(worktrees)" = 2 ] || fail "the queued spawn left a worktree ($(worktrees))"
human GET /api/agents | grep -q '"name":"dev2"' && fail "the queued spawn left a registry row"
R=$(agent "{\"name\":\"dev4\",\"type\":\"developer\",\"urgent\":\"red-main\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"place":1' || fail "urgent spawn not first: $R"
R=$(agent "{\"name\":\"dev5\",\"type\":\"developer\",\"urgent\":\"because\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 400 ] || fail "bad urgent reason accepted: $R"
R=$(agent "{\"name\":\"dev6\",\"type\":\"developer\",\"urgent\":\"incident\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 403 ] || fail "incident spawn with no marked ITSA not refused: $R"
[ "$(worktrees)" = 2 ] || fail "the refused incident spawn left a worktree ($(worktrees))"

echo "-- 3. a reviewer is not capped"
R=$(agent "{\"name\":\"rev1\",\"type\":\"reviewer\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 200 ] || fail "reviewer capped: $R"

echo "-- 4. the human spawns past the cap"
R=$(human POST /api/agents "{\"name\":\"dev3\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"name":"dev3"' || fail "human blocked by the cap: $R"
echo "-- 5. shutting down the holders starts the head of the queue, the urgent one, and then the cap holds it"
human POST /api/agents/dev3/shutdown '{"now":true}' >/dev/null
human POST /api/agents/dev1/shutdown '{"now":true}' >/dev/null
i=0
while ! human GET /api/agents | grep -q '"name":"dev4"'; do
  i=$((i + 1)); [ "$i" -le 40 ] || fail "dev4 never started from the queue"
  sleep 1
done
human GET /api/agents | grep -q '"name":"dev2"' && fail "dev2 started ahead of the urgent dev4"
echo "-- 6. a daemon restart keeps the queue: dev2 still waits, and starts when dev4 frees the slot"
[ -s "$STAM_HOME/slot-queue.json" ] || fail "no saved queue"
daemon_stop main
daemon_up main
use main
human GET /api/agents | grep -q '"name":"dev2"' && fail "dev2 started with the slot still held"
human POST /api/agents/dev4/shutdown '{"now":true}' >/dev/null
i=0
while ! human GET /api/agents | grep -q '"name":"dev2"'; do
  i=$((i + 1)); [ "$i" -le 40 ] || fail "dev2 was lost by the restart"
  sleep 1
done
echo "-- 7. a developer spawn with a free slot waits on a busy host (the load guard), and starts when the load drops"
human POST /api/agents/dev2/shutdown '{"now":true}' >/dev/null
printf '9.00 8.00 7.00 1/200 1234\n' >"$PROC_DIR/loadavg"
i=0
while ! human GET /api/machines | grep -q '"load":\[9'; do
  i=$((i + 1)); [ "$i" -le 40 ] || fail "the sampler never saw the load of 9"
  sleep 1
done
R=$(agent "{\"name\":\"dev6\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"queued":true' || fail "a busy host didn't queue a free-slot spawn: $R"
printf %s "$R" | grep -q '"reason":"queued: load 9.0"' || fail "no load reason: $R"
human GET /api/agents | grep -q '"name":"dev6"' && fail "dev6 started on a busy host"
printf '0.10 0.10 0.10 1/200 1234\n' >"$PROC_DIR/loadavg"
i=0
while ! human GET /api/agents | grep -q '"name":"dev6"'; do
  i=$((i + 1)); [ "$i" -le 40 ] || fail "dev6 never started once the host had room"
  sleep 1
done
# The status code of a POST to the queue, for the cancel steps.
code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$1" -d '{}'; }
echo "-- 8. a queued spawn is cancelled by its name: an unknown name is a 404, a queued one 200, and the cancel survives a restart"
R=$(agent "{\"name\":\"dev7\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"queued":true' || fail "dev7 not queued behind dev6: $R"
R=$(agent "{\"name\":\"dev8\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"queued":true' || fail "dev8 not queued behind dev6: $R"
[ "$(code /api/slot-queue/nosuch/cancel)" = 404 ] || fail "a name that isn't queued wasn't a 404"
[ "$(code /api/slot-queue/dev7/cancel)" = 200 ] || fail "dev7 not cancelled"
[ "$(code /api/slot-queue/dev7/cancel)" = 404 ] || fail "dev7 is still queued after its cancel"
daemon_stop main
daemon_up main
use main
[ "$(code /api/slot-queue/dev7/cancel)" = 404 ] || fail "dev7 came back after the restart"
grep -q '"name":"dev7"' "$STAM_HOME/slot-queue.json" && fail "the saved queue still holds dev7"
grep -q '"name":"dev8"' "$STAM_HOME/slot-queue.json" || fail "the saved queue lost dev8"
human POST /api/agents/dev6/shutdown '{"now":true}' >/dev/null
i=0
while ! human GET /api/agents | grep -q '"name":"dev8"'; do
  i=$((i + 1)); [ "$i" -le 40 ] || fail "dev8 never started after dev7 was cancelled"
  sleep 1
done
human GET /api/agents | grep -q '"name":"dev7"' && fail "the cancelled dev7 started"
echo "-- 9. a peer's duplicate drops nothing unless the caller matches, and the same-caller drop is in the unit tests"
R=$(agent "{\"name\":\"dev11\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"queued":true' || fail "dev11 not queued behind dev8: $R"
R=$(human POST /api/slot-queue/dev11/duplicate '{"caller":"dev8"}')
printf %s "$R" | grep -q '"dropped":false' || fail "a waiter with no caller was dropped for dev8: $R"
[ "$(code /api/slot-queue/dev11/cancel)" = 200 ] || fail "dev11 not cancelled after the duplicate check"
echo "PASS"
