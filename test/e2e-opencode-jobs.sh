#!/bin/sh
# OpenCode job waits (S-4237), free: a background shell still running when an execution ends is a job wait, so the agent
# ends waiting, not idle; the shell's end keeps the wait until the next execution starts and clears it. A daemon restart
# with a shell still running restores the wait from the server's listing. The OpenCode server is the fake
# (test/fake-opencode), which starts and ends shells on request. Runs on either daemon (STAM_DAEMON=go for the Go one).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
isolate
SHARED=$(cat "$STAM_HOME/token")
OC="e2e-oc-jobs-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$OC" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello."
"$STAM" wait "$OC" --until idle --timeout 60

api() { curl -s -X "$1" -H "authorization: Bearer $SHARED" ${3:+-H x-stam-human:1} -H 'content-type: application/json' ${4:+-d "$4"} "$STAM_URL$2"; }
fake() { curl -s -X POST -H 'content-type: application/json' -d "$2" "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/$1" >/dev/null; }
field() { api GET /api/agents | python3 -c 'import json, sys; print(next(a[sys.argv[2]] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$OC" "$1"; }
SID=$(field session_id)
ID=$(field id)
[ -n "$SID" ] || { echo "FAIL: $OC has no session"; exit 1; }
# job_targets: the agent's job waits' targets, space separated.
job_targets() { api GET "/api/agents/$ID/waits" | python3 -c 'import json, sys; print(" ".join(w["target"] for w in json.load(sys.stdin) if w["kind"] == "job"))'; }
await() {
  _i=0
  until eval "$2"; do
    _i=$((_i + 1))
    [ $_i -lt 150 ] || { echo "FAIL: timed out waiting for $1"; exit 1; }
    sleep 0.2
  done
}

echo "-- an execution that ends with a shell running ends waiting, with the shell's wait"
fake execution '{"session":"'"$SID"'","kind":"started"}'
await "working" '[ "$(field activity)" = working ]'
fake shell '{"id":"sh_e2e_1","session":"'"$SID"'","command":"sleep 1000","directory":"'"$DIR"'"}'
fake execution '{"session":"'"$SID"'","kind":"succeeded"}'
await "waiting" '[ "$(field activity)" = waiting ]'
[ "$(job_targets)" = sh_e2e_1 ] || { echo "FAIL: waits '$(job_targets)'"; exit 1; }

echo "-- the shell's end keeps the wait until the next execution starts, which clears it with the agent working"
fake shell '{"id":"sh_e2e_1","exit":true}'
sleep 1
[ "$(field activity)" = waiting ] && [ "$(job_targets)" = sh_e2e_1 ] || { echo "FAIL: the wait went with the shell"; exit 1; }
fake execution '{"session":"'"$SID"'","kind":"started"}'
await "the wait cleared" '[ -z "$(job_targets)" ]'
[ "$(field activity)" = working ] || { echo "FAIL: activity $(field activity) after the notice"; exit 1; }
fake execution '{"session":"'"$SID"'","kind":"succeeded"}'
await "idle" '[ "$(field activity)" = idle ]'

echo "-- a daemon restart with a shell still running restores its wait"
fake shell '{"id":"sh_e2e_2","session":"'"$SID"'","command":"tail -f log","directory":"'"$DIR"'"}'
daemon_stop main
daemon_up main
await "the wait restored" '[ "$(job_targets)" = sh_e2e_2 ]'
await "waiting" '[ "$(field activity)" = waiting ]'
echo PASS
