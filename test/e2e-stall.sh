#!/bin/sh
# The event-loop stall watch (S-322), end to end, free: a throwaway daemon. POST /api/test/stall blocks
# the loop for `ms`; /api/health lists the stall under that route. A request that is awaiting
# (POST /api/test/await, held until a file appears) must not be blamed for another request's block.
# Waits on state, never on time.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
use main
daemon_up main
auth="authorization: Bearer $(cat "$STAM_HOME/token")"
fail() { echo "FAIL: $1"; exit 1; }
post() { curl -s -m 60 -H "$auth" -H 'content-type: application/json' -d "$2" "$STAM_URL/api/test/$1"; }

# An awaiting request is in flight when another request blocks the loop well over the 100 ms default.
post await '{}' >"$TEST_TMP/await.out" &
AWAIT=$!
awaiting() { [ -e "$STAM_HOME/stall-awaiting" ]; }
wait_until awaiting
post stall '{ "ms": 400 }' | grep -q '"ok":true' || fail "the block didn't run"

# The injected stall is judged on /api/health, which keeps every stall; the log line is rate-limited,
# and startup may have used up its line already.
health() { curl -s -m 5 -H "$auth" "$STAM_URL/api/health"; }
blocked() { health | python3 -c 'import json, sys; s = json.load(sys.stdin)["stalls"]; sys.exit(0 if any(x["label"] == "POST /api/test/stall" for x in s) else 1)'; }
wait_until blocked
health | python3 -c 'import json, sys; s = json.load(sys.stdin)["stalls"]; sys.exit(1 if any(x["label"] == "POST /api/test/await" for x in s) else 0)' || fail "the awaiting request was blamed"

# Let the awaiting request finish, and check its answer.
touch "$STAM_HOME/stall-release"
wait "$AWAIT"
grep -q '"ok":true' "$TEST_TMP/await.out" || fail "the awaiting request didn't finish"
echo "ok: a stall is listed under the route that blocked, not the awaiting one"
