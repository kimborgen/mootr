#!/bin/sh
# Waits: an agent whose turn ended with open waits is 'waiting', names its top wait, and
# goes idle when the last one clears; its tree-idle parent hears once, then. Free and no
# models: it registers agents, drives their activity through the Claude hook endpoint,
# and adds and clears waits through the API. Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
hook() { api POST "/api/hook/claude/$1" "$2" >/dev/null; }
work() { hook "$1" '{"hook_event_name":"UserPromptSubmit"}'; }
finish() { hook "$1" "{\"hook_event_name\":\"Stop\",\"last_assistant_message\":\"$2\"}"; }
parent() { api POST "/api/agents/$1/set-parent" "{\"parent\":[\"$2\"]}" >/dev/null; }
wait_add() { api POST "/api/agents/$1/waits" "$2" | field '["id"]'; }
wait_clear() { api POST "/api/agents/$1/waits/clear" "$2" | field '["cleared"]'; }
state() { api GET "/api/agents/$1" | field '["activity"]'; }
detail() { api GET "/api/agents/$1" | field '["activity_detail"]'; }
turns() { api GET "/api/agents/$1/events" | python3 -c 'import json,sys; print(sum(e["type"]=="notice:queued" and "finished its turn" in (e.get("data") or "") for e in json.load(sys.stdin)))'; }
fail() { echo "FAIL: $1"; exit 1; }

P=$(reg parent); C=$(reg child)
parent "$C" "$P"

echo "-- a wait added mid-turn doesn't override working"
work "$C"
wait_add "$C" '{"kind":"timer","detail":"a 10-minute timer","until":"2099-01-01T00:00:00Z"}' >/dev/null
[ "$(state "$C")" = working ] || fail "a wait overrode working (got $(state "$C"))"

echo "-- the turn ends with a wait: waiting, and the parent isn't told yet"
finish "$C" "waiting on a timer"
[ "$(state "$C")" = waiting ] || fail "turn ended with a wait but agent is $(state "$C")"
[ "$(detail "$C")" = "waiting for a 10-minute timer" ] || fail "detail: $(detail "$C")"
[ "$(turns "$P")" = 0 ] || fail "the parent was told while the child waited"

echo "-- the detail names the top wait (human over timer) and counts the rest"
wait_add "$C" '{"kind":"human","target":"m123","detail":"Kim to pick a token lifetime","source":"declared"}' >/dev/null
[ "$(detail "$C")" = "waiting for Kim to pick a token lifetime (+1 more)" ] || fail "detail: $(detail "$C")"
api GET /api/agents | python3 -c "import json,sys; a=[x for x in json.load(sys.stdin) if x['id']=='$C'][0]; assert [w['kind'] for w in a['waits']]==['human','timer'], a['waits']" || fail "the agent list doesn't carry its waits, top first"

echo "-- clearing by kind and target leaves the other wait"
[ "$(wait_clear "$C" '{"kind":"human","target":"m123"}')" = 1 ] || fail "clear by kind and target"
[ "$(state "$C")" = waiting ] || fail "one wait left but agent is $(state "$C")"
[ "$(detail "$C")" = "waiting for a 10-minute timer" ] || fail "detail after clear: $(detail "$C")"

echo "-- the last wait clears: idle, and the parent is told once"
W=$(api GET "/api/agents/$C/waits" | field '[0]["id"]')
[ "$(wait_clear "$P" "{\"id\":\"$W\"}")" = 0 ] || fail "cleared another agent's wait by id"
[ "$(wait_clear "$C" "{\"id\":\"$W\"}")" = 1 ] || fail "clear by id"
[ "$(state "$C")" = idle ] || fail "no waits left but agent is $(state "$C")"
[ "$(turns "$P")" = 1 ] || fail "the parent wasn't told once (got $(turns "$P"))"

echo "-- a wait on an idle agent makes it waiting; clearing it doesn't repeat the notice"
wait_add "$C" '{"kind":"job","target":"j1"}' >/dev/null
[ "$(state "$C")" = waiting ] || fail "an idle agent with a wait is $(state "$C")"
[ "$(detail "$C")" = "waiting for job j1" ] || fail "detail: $(detail "$C")"
[ "$(wait_clear "$C" '{"kind":"job","target":"j1"}')" = 1 ] || fail "clear the job wait"
[ "$(state "$C")" = idle ] || fail "agent is $(state "$C") after its wait cleared"
[ "$(turns "$P")" = 1 ] || fail "the parent was told twice for one turn (got $(turns "$P"))"

echo "-- a waiting child holds its grandparent's notice; a turn parent hears at turn end"
G=$(reg grand); parent "$G" "$C"
"$STAM" child-notices "$P" turn >/dev/null
work "$C"; work "$G"
wait_add "$G" '{"kind":"agent","target":"'"$P"'"}' >/dev/null
finish "$G" "asked parent"
finish "$C" "child turn"
[ "$(turns "$P")" = 2 ] || fail "the turn parent wasn't told at the end of the turn (got $(turns "$P"))"
[ "$(turns "$C")" = 0 ] || fail "the child was told while the grandchild waited"
[ "$(state "$G")" = waiting ] || fail "grandchild is $(state "$G")"

echo "-- waits survive a daemon restart; clearing then releases the notice"
daemon_stop main; daemon_up main
[ "$(state "$G")" = waiting ] || fail "after a restart the grandchild is $(state "$G")"
[ "$(wait_clear "$G" "{\"kind\":\"agent\",\"target\":\"$P\"}")" = 1 ] || fail "clear after restart"
[ "$(turns "$C")" = 1 ] || fail "the child wasn't told once the grandchild's wait cleared (got $(turns "$C"))"

echo "-- Claude Code hooks: Stop lists open jobs and crons; they become hook waits"
K=$(reg hooked)
work "$K"
hook "$K" '{"hook_event_name":"Stop","last_assistant_message":"started","background_tasks":[{"id":"b1","type":"shell","status":"running","description":"Sleep 20 seconds","command":"sleep 20"}],"session_crons":[{"id":"c1","schedule":"28 14 * * *","recurring":false,"prompt":"wake up"},{"id":"c2","schedule":"*/30 * * * *","recurring":true,"prompt":"tick"}]}'
[ "$(state "$K")" = waiting ] || fail "jobs and crons at Stop, but agent is $(state "$K")"
api GET "/api/agents/$K/waits" | python3 -c "
import json,sys; w={x['target']:x for x in json.load(sys.stdin)}
assert sorted(w)==['b1','c1','c2'], w
assert w['b1']['kind']=='job' and w['b1']['source']=='hook' and w['b1']['detail']=='background command \"Sleep 20 seconds\"', w['b1']
assert w['c1']['kind']=='timer' and w['c1']['until'] and w['c2']['until'] is None, w" || fail "hook waits from Stop"

echo "-- a task notification and a one-shot timer's prompt clear their waits as the turn starts"
hook "$K" '{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"}'
[ "$(state "$K")" = working ] || fail "a task notification started a turn, but agent is $(state "$K")"
hook "$K" '{"hook_event_name":"UserPromptSubmit","prompt":"wake up"}'
[ "$(api GET "/api/agents/$K/waits" | python3 -c 'import json,sys; print(" ".join(w["target"] for w in json.load(sys.stdin)))')" = c2 ] || fail "job or timer wait not cleared at turn start"

echo "-- the next Stop's lists replace the hook waits; empty lists go idle"
hook "$K" '{"hook_event_name":"Stop","last_assistant_message":"x","background_tasks":[],"session_crons":[{"id":"c2","schedule":"*/30 * * * *","recurring":true,"prompt":"tick"}]}'
[ "$(detail "$K")" = "waiting for cron */30 * * * *" ] || fail "detail: $(detail "$K")"
work "$K"; hook "$K" '{"hook_event_name":"Stop","last_assistant_message":"x","background_tasks":[],"session_crons":[]}'
[ "$(state "$K")" = idle ] || fail "nothing open at Stop, but agent is $(state "$K")"

echo "-- /clear keeps hook waits; a restarted process drops them"
work "$K"; hook "$K" '{"hook_event_name":"Stop","last_assistant_message":"x","background_tasks":[{"id":"b2","type":"subagent","status":"running","description":"helper"}],"session_crons":[]}'
hook "$K" '{"hook_event_name":"SessionStart","source":"clear"}'
[ "$(state "$K")" = waiting ] || fail "/clear dropped the waits (agent is $(state "$K"))"
hook "$K" '{"hook_event_name":"SessionStart","source":"resume"}'
[ "$(state "$K")" = idle ] || fail "a resumed process kept the old waits (agent is $(state "$K"))"

echo "PASS e2e-waits"
