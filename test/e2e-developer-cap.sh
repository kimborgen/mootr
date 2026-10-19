#!/bin/sh
# The developer slot cap on the daemon's spawn path (S-2008), free: with developerCap 1, a first
# developer spawns, a second spawned without the human key is refused with a 409 naming the holder and leaves
# no worktree and no registry row, a reviewer type is not capped, and the human spawns past the cap.
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

echo "-- 2. a second developer spawned without the human key is refused, naming the holder, leaving nothing"
R=$(agent "{\"name\":\"dev2\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 409 ] || fail "second developer not refused: $R"
printf %s "$R" | grep -q 'developer slots full' || fail "no cap message: $R"
printf %s "$R" | grep -q 'dev1' || fail "holder not named: $R"
[ "$(worktrees)" = 2 ] || fail "the refusal left a worktree ($(worktrees))"
human GET /api/agents | grep -q '"name":"dev2"' && fail "the refused spawn left a registry row"

echo "-- 3. a reviewer is not capped"
R=$(agent "{\"name\":\"rev1\",\"type\":\"reviewer\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 200 ] || fail "reviewer capped: $R"

echo "-- 4. the human spawns past the cap"
R=$(human POST /api/agents "{\"name\":\"dev3\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"name":"dev3"' || fail "human blocked by the cap: $R"
echo "PASS"
