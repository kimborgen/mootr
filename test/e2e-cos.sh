#!/bin/sh
# The cos agent type (S-2142), free (the fake Claude Code, no model): spawning type cos makes the agent the
# chief of staff, at most one runs, only the human and the assistant spawn it, /api/cos/start and /stop run
# and end one, and a chief of staff named the old way keeps working.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fake_claude ""
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
cos_now() { human GET /api/chief-of-staff | field chiefOfStaff; }

# A worker can't spawn the cos type.
W=$(human POST /api/agents "{\"name\":\"worker\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"t\"}" | field id)
as_agent "$W" POST /api/agents "{\"by\":\"$W\",\"type\":\"cos\",\"name\":\"sneaky\",\"cwd\":\"$DIR\"}" | grep -q 'only the human and the assistant' || fail "worker spawned a cos"
[ -z "$(cos_now)" ] || fail "a chief of staff before any spawn"

# The human's spawn of the type sets it, with the type's harness, model, effort, and standing.
A=$(human POST /api/agents "{\"name\":\"boss\",\"type\":\"cos\",\"cwd\":\"$DIR\"}")
[ "$(echo "$A" | field model)" = claude-opus-5-5 ] || fail "model: $A"
[ "$(echo "$A" | field effort)" = medium ] || fail "effort: $A"
[ "$(echo "$A" | field standing)" = 1 ] || [ "$(echo "$A" | field standing)" = true ] || fail "standing: $A"
[ "$(cos_now)" = boss ] || fail "spawn didn't set the chief of staff: $(cos_now)"

# At most one is active; start with one active returns it.
human POST /api/agents "{\"name\":\"boss2\",\"type\":\"cos\",\"cwd\":\"$DIR\"}" | grep -q 'already the chief of staff' || fail "a second cos spawned"
[ "$(human POST /api/cos/start | field name)" = boss ] || fail "start with one active started another"

# Only the human uses start and stop.
as_agent "$W" POST /api/cos/stop "{\"by\":\"$W\"}" | grep -q 'only the human' || fail "worker stopped the cos"

# Stop shuts it down; start then runs a new one from the type.
human POST /api/cos/stop | grep -q . || fail "stop"
[ -z "$(cos_now)" ] || fail "cos active after stop: $(cos_now)"
human POST /api/cos/stop | grep -q 'no chief of staff' || fail "stop with none"
N=$(human POST /api/cos/start)
[ "$(echo "$N" | field type)" = cos ] || fail "start: $N"
[ "$(cos_now)" = "$(echo "$N" | field name)" ] || fail "start didn't set the chief of staff"

# Concurrent starts, and a start beside a spawn, leave exactly one chief of staff.
human POST /api/cos/stop >/dev/null
human POST /api/cos/start > "$TEST_TMP/s1" &
human POST /api/cos/start > "$TEST_TMP/s2" &
human POST /api/agents "{\"name\":\"racer\",\"type\":\"cos\",\"cwd\":\"$DIR\"}" > "$TEST_TMP/s3" &
wait
COUNT=$(human GET /api/agents | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).filter(a=>a.type==="cos"&&["active","paused"].includes(a.lifecycle)).length))')
[ "$COUNT" = 1 ] || fail "$COUNT active cos after concurrent starts"

# The old way keeps working: a chief of staff named by chief_of_staff.
human POST /api/cos/stop >/dev/null
O=$(human POST /api/agents "{\"name\":\"legacy\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"t\",\"chief_of_staff\":true}" | field name)
[ "$O" = legacy ] && [ "$(cos_now)" = legacy ] || fail "chief_of_staff spawn: $(cos_now)"
echo "PASS e2e-cos"
