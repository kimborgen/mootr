#!/bin/sh
# OpenCode turn end and control calls (S-4237), free: an execution's end reports the session's cumulative usage once (a
# repeat adds nothing) and sets the agent's context size from its last assistant message; a compaction asks the server to
# compact the agent's session, with no relaunch, and the agent ends idle when the server's execution ends; an MCP
# reconnect asks the server to reload its client for the agent's directory. The OpenCode server is the fake
# (test/fake-opencode). Runs on either daemon (STAM_DAEMON=go for the Go one).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
isolate
SHARED=$(cat "$STAM_HOME/token")
OC="e2e-oc-turnend-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$OC" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello."
"$STAM" wait "$OC" --until idle --timeout 60

api() { curl -s -X "$1" -H "authorization: Bearer $SHARED" ${3:+-H x-stam-human:1} -H 'content-type: application/json' ${4:+-d "$4"} "$STAM_URL$2"; }
fake() { curl -s -X POST -H 'content-type: application/json' -d "$2" "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/$1"; }
field() { api GET /api/agents | python3 -c 'import json, sys; print(next(a[sys.argv[2]] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$OC" "$1"; }
# calls: how many compactions (compacts) or reconnects (connects) the fake server was asked for, and the reconnects' directories.
calls() { curl -s "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/calls" | python3 -c 'import json, sys; d = json.load(sys.stdin)["data"]; print(len(d[sys.argv[1]]), *d[sys.argv[1]])' "$1"; }
SID=$(field session_id)
[ -n "$SID" ] || { echo "FAIL: $OC has no session"; exit 1; }
await() {
  _i=0
  until eval "$2"; do
    _i=$((_i + 1))
    [ $_i -lt 150 ] || { echo "FAIL: timed out waiting for $1"; exit 1; }
    sleep 0.2
  done
}

echo "-- an execution's end reports the session's usage and sets the context size"
fake usage '{"session":"'"$SID"'","tokens":{"input":100,"output":40,"reasoning":10,"cache":{"read":500,"write":60}}}'
fake seed '{"session":"'"$SID"'","messages":[{"id":"msg_u","type":"assistant","content":[],"time":{"created":1,"completed":2},"tokens":{"input":120,"cache":{"read":700}}}]}' >/dev/null
fake execution '{"session":"'"$SID"'","kind":"started"}' >/dev/null
fake execution '{"session":"'"$SID"'","kind":"succeeded"}' >/dev/null
await "the context size" '[ "$(field context_tokens)" = 820 ]'
await "the usage baseline" 'field usage_last | grep -q "\"tout\":50"'
BASE=$(field usage_last)
case "$BASE" in *'"tin":100'*'"tout":50'*'"tcr":500'*'"tcw":60'*) ;; *) echo "FAIL: baseline $BASE"; exit 1 ;; esac

echo "-- the same numbers at a later end add nothing"
fake execution '{"session":"'"$SID"'","kind":"started"}' >/dev/null
fake execution '{"session":"'"$SID"'","kind":"succeeded"}' >/dev/null
await "idle" '[ "$(field activity)" = idle ]'
sleep 1
[ "$(field usage_last)" = "$BASE" ] || { echo "FAIL: baseline moved to $(field usage_last)"; exit 1; }

echo "-- a compaction asks the server for the session's compaction, with no relaunch, and the server's events end it"
"$STAM" compact "$OC" "keep the plan"
await "the compaction asked for" '[ "$(calls compacts | cut -d" " -f1)" = 1 ]'
[ "$(calls compacts | cut -d" " -f2)" = "$SID" ] || { echo "FAIL: compacted $(calls compacts)"; exit 1; }
await "compacting" '[ "$(field activity)" = working ]'
[ "$(field session_id)" = "$SID" ] || { echo "FAIL: the session changed to $(field session_id)"; exit 1; }
fake execution '{"session":"'"$SID"'","kind":"succeeded"}' >/dev/null
await "idle again" '[ "$(field activity)" = idle ]'

echo "-- a reconnect asks the server to reload its MCP client for the agent's directory"
"$STAM" reconnect-mcp "$OC"
await "the reconnect" '[ "$(calls connects | cut -d" " -f1)" = 1 ]'
[ "$(calls connects | cut -d" " -f2-)" = "$DIR" ] || { echo "FAIL: reconnected $(calls connects)"; exit 1; }
echo PASS
