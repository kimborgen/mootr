#!/bin/sh
# The sweep of pending OpenCode asks (S-4280), free, Go daemon only: a permission the server lists as pending whose event
# the daemon never heard (a restart, a dropped stream) is raised as an ask when the daemon connects to the stream again, once;
# one already answered is not raised. The OpenCode server is the fake (test/fake-opencode); TS has no such sweep.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
[ "$STAM_DAEMON" = go ] || { echo "SKIP: the ask sweep is the Go daemon's (STAM_DAEMON=go)"; exit 0; }
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
isolate
SHARED=$(cat "$STAM_HOME/token")
OC="e2e-oc-sweep-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$OC" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello."
"$STAM" wait "$OC" --until idle --timeout 60
api() { curl -s -X "$1" -H "authorization: Bearer $SHARED" -H 'content-type: application/json' "$STAM_URL$2"; }
fake() { curl -s -X POST -H 'content-type: application/json' -d "$2" "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/$1"; }
SID=$(api GET /api/agents | python3 -c 'import json, sys; print(next(a["session_id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$OC")
[ -n "$SID" ] || { echo "FAIL: $OC has no session"; exit 1; }
count() {
  api GET /api/permissions | python3 -c 'import json, sys; print(sum(1 for r in json.load(sys.stdin) if json.loads(r.get("details") or "{}").get("permission") == sys.argv[1]))' "$1"
}
await() {
  _i=0
  until eval "$2"; do
    _i=$((_i + 1))
    [ $_i -lt 200 ] || { echo "FAIL: timed out waiting for $1"; exit 1; }
    sleep 0.2
  done
}

echo "-- a pending permission no event told of is raised once the stream is connected again"
fake listed '{"session":"'"$SID"'","id":"per_sweep_lost","action":"shell","resources":["make test"]}' >/dev/null
[ "$(count per_sweep_lost)" = 0 ] || { echo "FAIL: raised before any connect"; exit 1; }
fake dropstream '{}' >/dev/null
await "the sweep's ask" '[ "$(count per_sweep_lost)" = 1 ]'

echo "-- another connect raises it no second time, and not a permission answered meanwhile"
fake listed '{"session":"'"$SID"'","id":"per_sweep_gone","action":"shell","resources":["make test"]}' >/dev/null
fake drop '{"session":"'"$SID"'","id":"per_sweep_gone"}' >/dev/null
fake dropstream '{}' >/dev/null
sleep 6
[ "$(count per_sweep_lost)" = 1 ] || { echo "FAIL: a second connect raised it again"; exit 1; }
[ "$(count per_sweep_gone)" = 0 ] || { echo "FAIL: a permission no longer listed was raised"; exit 1; }
echo PASS
