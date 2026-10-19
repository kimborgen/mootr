#!/bin/sh
# The developer slot cap on the daemon's spawn path (S-2008), free: with developerCap 1, a first
# developer spawns, a second spawned without the human key is queued (place, holder named) and leaves
# no worktree and no registry row, a daemon restart keeps the queue, an urgent one queues ahead of it, a bad urgent reason is a 400, a reviewer type is not capped, and the human spawns past the cap.
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
echo "PASS"
