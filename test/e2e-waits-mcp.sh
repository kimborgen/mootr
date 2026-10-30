#!/bin/sh
# Waiting states change 5: the MCP waits (wait_for, wait_done, wake_me) and the daemon
# scheduler for declared-wait timeouts and timers. Free, no models: it registers two agents,
# drives their mail and activity through the API, and fires timers with short times. Runs
# against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
hook() { api POST "/api/hook/claude/$1" "$2" >/dev/null; }
work() { hook "$1" '{"hook_event_name":"UserPromptSubmit"}'; }
finish() { hook "$1" "{\"hook_event_name\":\"Stop\",\"last_assistant_message\":\"$2\"}"; }
state() { api GET "/api/agents/$1" | field '["activity"]'; }
detail() { api GET "/api/agents/$1" | field '["activity_detail"]'; }
ids() { api GET "/api/agents/$1/waits" | python3 -c 'import json,sys; print("".join(w["id"] for w in json.load(sys.stdin)))'; }
empty() { [ -z "$(ids "$1")" ]; }
notices() {
  api GET "/api/agents/$1/events" | python3 -c 'import json,sys; t=sys.argv[1]; print(sum(1 for e in json.load(sys.stdin) if e["type"]=="notice:queued" and t in (e.get("data") or "")))' "$2"
}
has_notice() {
  api GET "/api/agents/$1/events" | python3 -c 'import json,sys; t=sys.argv[1]; print(any(e["type"]=="notice:queued" and t in (e.get("data") or "") for e in json.load(sys.stdin)))' "$2" | grep -q True
}
wait_for() {
  _fn=$1; shift
  for _i in $(seq 1 40); do $_fn "$@" && return 0; sleep 0.5; done
  return 1
}
future_until() { # future_until AGENT WAITID [MAXMIN]
  api GET "/api/agents/$1/waits" | python3 -c "
import json,sys,datetime
wid=sys.argv[1]; maxmin=float(sys.argv[2])
w=[x for x in json.load(sys.stdin) if x['id']==wid]
assert w, 'wait %s is gone' % wid
u=datetime.datetime.fromisoformat(w[0]['until'].replace('Z','+00:00'))
now=datetime.datetime.now(datetime.timezone.utc)
assert u > now - datetime.timedelta(seconds=10) and u <= now + datetime.timedelta(minutes=maxmin, seconds=5), u" "$2" "${3:-2}"
}
fail() { echo "FAIL: $1"; exit 1; }

P=$(reg parent); C=$(reg child); X=$(reg unrelated)
api POST "/api/agents/$C/set-parent" "{\"parent\":[\"$P\"]}" >/dev/null

echo "-- only the agent itself, a parent, or the human may create or clear its waits"
[ "$(code POST "/api/agents/$C/waits/declared" '{"on":"human","note":"x","by":"'"$X"'"}')" = 403 ] || fail "an unrelated agent could declare a wait"
[ "$(code POST "/api/agents/$C/waits/wake" '{"in_minutes":1,"note":"x","by":"'"$X"'"}')" = 403 ] || fail "an unrelated agent could set a timer"
[ "$(code POST "/api/agents/$C/waits" '{"kind":"timer","by":"'"$X"'"}')" = 403 ] || fail "an unrelated agent could add a wait"
W=$(api POST "/api/agents/$C/waits/declared" '{"on":"human","note":"mine","by":"'"$C"'"}' | field '["id"]')
[ -n "$W" ] || fail "the agent couldn't declare its own wait"
[ "$(code POST "/api/agents/$C/waits/done" '{"id":"'"$W"'","by":"'"$X"'"}')" = 403 ] || fail "an unrelated agent could clear a wait"
[ "$(code POST "/api/agents/$C/waits/clear" '{"id":"'"$W"'","by":"'"$X"'"}')" = 403 ] || fail "an unrelated agent could clear a wait by id"
[ "$(code POST "/api/agents/$C/waits/clear" '{"kind":"human","by":"'"$X"'"}')" = 403 ] || fail "an unrelated agent could clear a wait by kind"
[ "$(api POST "/api/agents/$C/waits/done" '{"id":"'"$W"'","by":"'"$P"'"}' | field '["cleared"]')" = True ] || fail "a parent couldn't clear its child's wait"
WP=$(api POST "/api/agents/$C/waits/wake" '{"in_minutes":30,"note":"parent timer","by":"'"$P"'"}' | field '["id"]')
[ -n "$WP" ] || fail "a parent couldn't set its child's timer"
api POST "/api/agents/$C/waits/clear" "{\"id\":\"$WP\"}" >/dev/null
wait_for empty "$C" || fail "the authorization test left waits behind"

work "$C"; finish "$C" "idle for tests"

echo "-- wait_for on an agent: waiting, the target is told, and mail in reply clears it"
W=$(api POST "/api/agents/$C/waits/declared" '{"on":"agent","target":"'"$P"'","note":"a reply about the spec"}' | field '["id"]')
[ -n "$W" ] || fail "wait_for returned no id"
[ "$(state "$C")" = waiting ] || fail "declaring a wait didn't make $C waiting (got $(state "$C"))"
[ "$(detail "$C")" = "waiting for a reply about the spec" ] || fail "wait detail: $(detail "$C")"
has_notice "$P" "child is waiting for your reply" || fail "the awaited agent wasn't told"
api POST /api/mail "{\"from\":\"$P\",\"to\":[\"$C\"],\"subject\":\"the spec\",\"body\":\"here you go\"}" >/dev/null
wait_for empty "$C" || fail "the wait didn't clear when the mail arrived"
[ "$(state "$C")" = idle ] || fail "agent is $(state "$C") after its wait cleared, not idle"

echo "-- a thread-restricted wait ignores other mail and clears on a reply in that thread"
M1=$(api POST /api/mail "{\"from\":\"$P\",\"to\":[\"$C\"],\"subject\":\"thread topic\",\"body\":\"one\",\"new_thread\":true}" | field '["id"]')
W=$(api POST "/api/agents/$C/waits/declared" '{"on":"agent","target":"'"$P"'","thread":"'"$M1"'","note":"answer in the thread"}' | field '["id"]')
api POST /api/mail "{\"from\":\"$P\",\"to\":[\"$C\"],\"subject\":\"something else\",\"body\":\"two\",\"new_thread\":true}" >/dev/null
# Clearing a wait happens inside the mail POST, so the POST's return is the state to check.
[ "$(ids "$C")" = "$W" ] || fail "unrelated mail cleared a thread-restricted wait"
api POST /api/mail "{\"from\":\"$P\",\"to\":[\"$C\"],\"subject\":\"Re: thread topic\",\"body\":\"three\",\"reply_to\":\"$M1\"}" >/dev/null
wait_for empty "$C" || fail "a reply in the named thread didn't clear the wait"

echo "-- a wait_for on the human with a timeout clears and tells the agent"
W=$(api POST "/api/agents/$C/waits/declared" '{"on":"human","timeout_minutes":0.05,"note":"the go-ahead"}' | field '["id"]')
wait_for has_notice "$C" "timed out" || fail "no timeout notice"
wait_for empty "$C" || fail "the timed-out wait didn't clear"

echo "-- wake_me one-off: it fires its note, then clears"
W=$(api POST "/api/agents/$C/waits/wake" '{"in_minutes":0.05,"note":"check the build"}' | field '["id"]')
[ -n "$W" ] || fail "wake_me returned no id"
wait_for has_notice "$C" "check the build" || fail "the one-off timer didn't fire"
wait_for empty "$C" || fail "the one-off timer didn't clear"

echo "-- wake_me periodic: it fires, rolls until forward, and stays until wait_done"
W=$(api POST "/api/agents/$C/waits/wake" '{"every_minutes":0.05,"note":"tick tock"}' | field '["id"]')
wait_for has_notice "$C" "tick tock" || fail "the periodic timer didn't fire"
future_until "$C" "$W" 1 || fail "the periodic timer didn't roll its until forward"
[ "$(api POST "/api/agents/$C/waits/done" "{\"id\":\"$W\"}" | field '["cleared"]')" = True ] || fail "wait_done didn't clear the timer"
wait_for empty "$C" || fail "the timer stayed after wait_done"

echo "-- wake_me cron: until is the next fire, and wait_done clears it"
W=$(api POST "/api/agents/$C/waits/wake" '{"cron":"*/5 * * * *","note":"cron tick"}' | field '["id"]')
future_until "$C" "$W" 5.1 || fail "cron until isn't the next fire time"
[ "$(api POST "/api/agents/$C/waits/done" "{\"id\":\"$W\"}" | field '["cleared"]')" = True ] || fail "wait_done didn't clear the cron timer"
wait_for empty "$C" || fail "the cron timer stayed after wait_done"

echo "-- wake_me rejects no schedule, two schedules, and a bad cron"
[ "$(code POST "/api/agents/$C/waits/wake" '{"note":"x"}')" = 400 ] || fail "wake_me without a schedule wasn't refused"
[ "$(code POST "/api/agents/$C/waits/wake" '{"in_minutes":1,"every_minutes":1,"note":"x"}')" = 400 ] || fail "wake_me with two schedules wasn't refused"
[ "$(code POST "/api/agents/$C/waits/wake" '{"cron":"nope","note":"x"}')" = 400 ] || fail "a bad cron wasn't refused"

echo "-- wait_done clears a declared wait, and leaves a hook wait alone"
W=$(api POST "/api/agents/$C/waits/declared" '{"on":"human","note":"manual"}' | field '["id"]')
[ "$(api POST "/api/agents/$C/waits/done" "{\"id\":\"$W\"}" | field '["cleared"]')" = True ] || fail "wait_done didn't clear a declared wait"
HW=$(api POST "/api/agents/$C/waits" '{"kind":"job","source":"hook","target":"z1"}' | field '["id"]')
[ "$(api POST "/api/agents/$C/waits/done" "{\"id\":\"$HW\"}" | field '["cleared"]')" = False ] || fail "wait_done cleared a hook wait"
api POST "/api/agents/$C/waits/clear" "{\"id\":\"$HW\"}" >/dev/null
wait_for empty "$C" || fail "cleanup left waits behind"

echo "-- the MCP tools drive the same waits over stdio"
mcp() {
  STAM_BIN="$STAM" with_agent_id "$1" node "$ROOT/test/mcp-call.mjs" \
    "$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$2" "$3")" |
    python3 -c 'import json,sys
m=json.load(sys.stdin); r=m.get("result",{}); t=r.get("content",[{}])[0].get("text","")
if r.get("isError"): sys.stderr.write(t+"\n"); sys.exit(1)
print(t)'
}
mcp "$C" wait_for "{\"on\":\"agent\",\"target\":\"$P\",\"note\":\"mcp reply\"}" | grep -q "Waiting (" || fail "wait_for MCP tool"
[ "$(detail "$C")" = "waiting for mcp reply" ] || fail "wait_for MCP didn't set the wait"
W=$(ids "$C")
mcp "$C" wait_done "{\"id\":\"$W\"}" | grep -q "Cleared wait" || fail "wait_done MCP tool"
wait_for empty "$C" || fail "wait_done MCP didn't clear the wait"
mcp "$C" wake_me '{"in_minutes":30,"note":"mcp timer"}' | grep -q "Wake-up (" || fail "wake_me MCP tool"
W=$(ids "$C")
[ "$(api POST "/api/agents/$C/waits/done" "{\"id\":\"$W\"}" | field '["cleared"]')" = True ] || fail "the wake_me MCP timer isn't clearable"
wait_for empty "$C" || fail "the wake_me MCP timer not cleared"

echo "-- a timer due while the daemon was down fires once on start"
daemon_stop main
python3 - "$STAM_HOME/test-seed.json" "$C" <<'PY'
import json, sys
json.dump({"waits": [{"id": "wrestarttest", "agent": sys.argv[2], "kind": "timer", "detail": "restart timer", "since": "2000-01-01T00:00:00Z", "until": "2000-01-01T00:00:00Z", "source": "stam", "data": {"every_minutes": 60}}]}, open(sys.argv[1], "w"))
PY
daemon_up main
wait_for has_notice "$C" "restart timer" || fail "a timer due while the daemon was down didn't fire at start"
# Firing rolls the timer's until forward; with that done, a second firing is not due, so the count is final.
future_until "$C" wrestarttest 61 || fail "the restart timer didn't roll its until forward"
[ "$(notices "$C" "restart timer")" = 1 ] || fail "a due timer fired $(notices "$C" "restart timer") times at start, not once"
api POST "/api/agents/$C/waits/done" '{"id":"wrestarttest"}' >/dev/null

echo "PASS e2e-waits-mcp"