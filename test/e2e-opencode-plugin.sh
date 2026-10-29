#!/bin/sh
# The routes the OpenCode plugin calls for the session it runs (S-4237): the notice after a tool call, the stam system
# prompt and the instructions of a compaction. The plugin knows a session id, not the agent. The OpenCode server is the
# fake (test/fake-opencode). Runs on either daemon (STAM_DAEMON=go for the Go one).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
isolate
SHARED=$(cat "$STAM_HOME/token")
OC="e2e-oc-plugin-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$OC" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello."
"$STAM" wait "$OC" --until idle --timeout 60

api() { curl -s -X "$1" -H "authorization: Bearer $SHARED" -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"; }
fake() { curl -s -X POST -H 'content-type: application/json' -d "$2" "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/$1"; }
calls() { curl -s "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/calls" | python3 -c 'import json, sys; d = json.load(sys.stdin)["data"]; print(len(d[sys.argv[1]]), *d[sys.argv[1]])' "$1"; }
field() { api GET /api/agents | python3 -c 'import json, sys; print(next(a[sys.argv[2]] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$OC" "$1"; }
text() { api GET "/api/by-session/$1/$2" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("text", "<none>"))'; }
status() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $1" "$STAM_URL$2"; }
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

echo "-- an unknown session has no text"
[ "$(text ses_nobody notice)" = "<none>" ] || { echo "FAIL: an unknown session's notice: $(text ses_nobody notice)"; exit 1; }

echo "-- the system prompt is the agent's"
SYS=$(text "$SID" system)
case "$SYS" in *"$OC"*) ;; *) echo "FAIL: the system prompt doesn't name $OC"; exit 1 ;; esac

echo "-- a notice reaches the working agent after a tool call"
fake execution '{"session":"'"$SID"'","kind":"started"}' >/dev/null
await "working" '[ "$(field activity)" = working ]'
"$STAM" mail send --to "$OC" --subject "plugin-ping" "hello"
await "the notice" 'text "$SID" notice | grep -q plugin-ping'
EVENTS=$(api GET "/api/agents/$OC/events" | grep -o 'mail:notice' | wc -l)
[ "$EVENTS" -ge 1 ] || { echo "FAIL: no mail:notice event"; exit 1; }

echo "-- compaction instructions are taken once"
fake execution '{"session":"'"$SID"'","kind":"succeeded"}' >/dev/null
await "idle" '[ "$(field activity)" = idle ]'
"$STAM" compact "$OC" "keep the plan"
await "the compaction asked for" '[ "$(calls compacts | cut -d" " -f1)" = 1 ]'
[ "$(text "$SID" compact-instructions)" = "keep the plan" ] || { echo "FAIL: instructions $(text "$SID" compact-instructions)"; exit 1; }
[ "$(text "$SID" compact-instructions)" = "<none>" ] || { echo "FAIL: the instructions were taken twice"; exit 1; }

echo "-- another agent's token reads nothing by this session"
[ "$(status bogus-token "/api/by-session/$SID/system")" = 401 ] || { echo "FAIL: a bad token read a session"; exit 1; }
echo PASS
