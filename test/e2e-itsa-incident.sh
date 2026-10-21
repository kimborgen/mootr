#!/bin/sh
# The incident mark end to end, free (S-2406): a fake `claude` stands in, so no model runs, and one daemon
# with developerCap 1 and the chief of staff named in settings. Checks: the mark is set and cleared by the
# chief of staff and the human only (a registered agent's token is refused, with a forged `by` or `self`, and
# the mark stays as it was); an unmarked incident spawn is refused with no worktree, a marked one starts on a
# free slot; a queued incident whose mark is cleared while it waits loses its priority, and one whose ITSA
# closes does too; the chief of staff's token still works.
# Not here: a mark set through a peer's relay (the route's relayed-caller case), and an assistant's token.
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
# A fixed /proc, so the load guard (S-2120) sees a quiet machine whatever this one's load is.
PROC_DIR="$TEST_TMP/proc"
mkdir -p "$PROC_DIR"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n' >"$PROC_DIR/stat"
printf 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       2000000 kB\n' >"$PROC_DIR/meminfo"
printf '0.10 0.10 0.10 1/200 1234\n' >"$PROC_DIR/loadavg"
export STAM_PROC_DIR="$PROC_DIR"
daemon_home main
printf '{ "peers": [], "developerCap": 1, "chiefOfStaff": "cosagent" }\n' >"$TEST_TMP/main/settings.json"
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
agent() { curl -s -w '\n%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL/api/agents" -d "$1"; }
worktrees() { git -C "$REPO" worktree list | wc -l; }
# An ITSA's incident flag, as the shared token reads it.
mark() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL/api/itsas/$1" | python3 -c 'import json, sys; print(json.load(sys.stdin)["incident"])'; }
# A PATCH as a caller: the agent's token, or the human's (the shared token with x-stam-human). Prints the status.
patch_as() { curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $1" -H 'content-type: application/json' ${3:+-H 'x-stam-human: 1'} -d "$2" "$STAM_URL/api/itsas/$K"; }
# A registered agent and its own token (S-237), the way the owners test registers one.
reg() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL/api/register" -d "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\",\"token\":true}" | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])'; }
# Waits until the named agent is (or isn't) in the registry.
started() { human GET /api/agents | grep -q "\"name\":\"$1\""; }
wait_started() {
  i=0
  while ! started "$1"; do
    i=$((i + 1)); [ "$i" -le 40 ] || fail "$1 never started"
    sleep 1
  done
}

K=$("$STAM" itsa new "Outage" | awk '{print $1}')
CT=$(reg cosagent)
MT=$(reg mgr)
BASE=$(worktrees)
# The manager owns the ITSA, so a refusal below is the mark's rule and not the ITSA's permissions.
human PATCH "/api/itsas/$K" '{"owner":"mgr"}' >/dev/null

echo "-- 1. only the chief of staff or the human sets and clears the mark"
[ "$(patch_as "$MT" '{"incident":true}')" = 403 ] || fail "a registered agent set the mark"
[ "$(patch_as "$MT" '{"incident":true,"by":"cosagent"}')" = 403 ] || fail "a forged by set the mark"
[ "$(patch_as "$MT" '{"incident":true,"self":"cosagent"}')" = 403 ] || fail "a forged self set the mark"
[ "$(mark "$K")" = 0 ] || fail "a refused set left the mark on: $(mark "$K")"
[ "$(patch_as "$CT" '{"incident":true}')" = 200 ] || fail "the chief of staff couldn't set the mark"
[ "$(mark "$K")" = 1 ] || fail "the chief of staff's mark didn't stick"
[ "$(patch_as "$MT" '{"incident":false}')" = 403 ] || fail "a registered agent cleared the mark"
[ "$(patch_as "$MT" '{"incident":false,"by":"cosagent"}')" = 403 ] || fail "a forged by cleared the mark"
[ "$(mark "$K")" = 1 ] || fail "a refused clear took the mark off"
[ "$(patch_as "$CT" '{"incident":false}')" = 200 ] || fail "the chief of staff couldn't clear the mark"
[ "$(patch_as "$TOKEN" '{"incident":true}' human)" = 200 ] || fail "the human couldn't set the mark"
[ "$(mark "$K")" = 1 ] || fail "the human's mark didn't stick"

echo "-- 2. an incident spawn is refused unless its ITSA is marked, slot free or not, and leaves no worktree"
[ "$(patch_as "$CT" '{"incident":false}')" = 200 ] || fail "the chief of staff couldn't clear the mark for step 2"
R=$(agent '{"name":"incfree","type":"developer","urgent":"incident","cwd":"'"$REPO"'"}')
[ "$(printf %s "$R" | tail -1)" = 403 ] || fail "an incident spawn with no ITSA started on a free slot: $R"
[ "$(worktrees)" = "$BASE" ] || fail "the refused incident spawn left a worktree"
R=$(agent '{"name":"inc1","type":"developer","urgent":"incident","itsa":"'"$K"'","cwd":"'"$REPO"'"}')
[ "$(printf %s "$R" | tail -1)" = 403 ] || fail "an incident spawn under an unmarked ITSA started: $R"
[ "$(patch_as "$CT" '{"incident":true}')" = 200 ] || fail "the chief of staff couldn't re-mark the ITSA"
R=$(agent '{"name":"inc1","type":"developer","urgent":"incident","itsa":"'"$K"'","cwd":"'"$REPO"'"}')
printf %s "$R" | grep -q '"name":"inc1"' || fail "a marked incident spawn on a free slot didn't start: $R"
wait_started inc1

echo "-- 3. a queued incident loses its priority when its mark is cleared while it waits"
R=$(agent '{"name":"iw","type":"developer","urgent":"incident","itsa":"'"$K"'","cwd":"'"$REPO"'"}')
printf %s "$R" | grep -q '"queued":true' || fail "a marked incident spawn wasn't queued behind inc1: $R"
[ "$(patch_as "$CT" '{"incident":false}')" = 200 ] || fail "the chief of staff couldn't clear the mark while iw waited"
R=$(agent '{"name":"rw","type":"developer","urgent":"red-main","cwd":"'"$REPO"'"}')
printf %s "$R" | grep -q '"queued":true' || fail "rw wasn't queued: $R"
human POST /api/agents/inc1/shutdown '{"now":true}' >/dev/null
wait_started rw
started iw && fail "iw started ahead of rw after its mark was cleared"
grep -q '"name":"iw"' "$STAM_HOME/slot-queue.json" || fail "iw left the queue"
human POST /api/agents/rw/shutdown '{"now":true}' >/dev/null
wait_started iw

echo "-- 4. a queued incident loses its priority when its ITSA closes while it waits"
[ "$(patch_as "$CT" '{"incident":true}')" = 200 ] || fail "the chief of staff couldn't re-mark the ITSA for iw2"
R=$(agent '{"name":"iw2","type":"developer","urgent":"incident","itsa":"'"$K"'","cwd":"'"$REPO"'"}')
printf %s "$R" | grep -q '"queued":true' || fail "iw2 wasn't queued behind iw: $R"
"$STAM" itsa set "$K" --status done >/dev/null
[ "$(mark "$K")" = 0 ] || fail "closing the ITSA didn't clear the mark"
R=$(agent '{"name":"rw2","type":"developer","urgent":"red-main","cwd":"'"$REPO"'"}')
printf %s "$R" | grep -q '"queued":true' || fail "rw2 wasn't queued: $R"
human POST /api/agents/iw/shutdown '{"now":true}' >/dev/null
wait_started rw2
started iw2 && fail "iw2 started ahead of rw2 after its ITSA closed"
grep -q '"name":"iw2"' "$STAM_HOME/slot-queue.json" || fail "iw2 left the queue"
echo "PASS"
