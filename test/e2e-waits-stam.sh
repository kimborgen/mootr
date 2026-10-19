#!/bin/sh
# Waits from stam's own data (waiting states change 2 of 6): a parent has one 'children'
# wait while any agent below it is busy, with a count, and loses it (hearing one tree-idle
# notice) when the subtree goes quiet; an agent has one 'human' wait per pending permission
# request; and a restart rebuilds both kinds. Free and no models: registered agents driven
# through the Claude hook endpoint, plus the permission API. Runs against its own daemon
# (test/lib.sh).
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
state() { api GET "/api/agents/$1" | field '["activity"]'; }
detail() { api GET "/api/agents/$1" | field '["activity_detail"]'; }
kinds() { api GET "/api/agents/$1/waits" | python3 -c 'import json,sys; print(",".join((w["kind"] or "") + ("/" + w["target"] if w["target"] else "") for w in json.load(sys.stdin)))'; }
turns() { api GET "/api/agents/$1/events" | python3 -c 'import json,sys; print(sum(e["type"]=="notice:queued" and "finished its turn" in (e.get("data") or "") for e in json.load(sys.stdin)))'; }
request() { api POST /api/permissions "{\"agent\":\"$1\",\"action\":\"$2\",\"reason\":\"because\",\"details\":\"\",\"audience\":\"human\"}" | field '["id"]'; }
answer() { curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL/api/permissions/$1/answer" -d "{\"approve\":$2}" >/dev/null; }
fail() { echo "FAIL: $1"; exit 1; }

P=$(reg parent); C=$(reg child)
parent "$C" "$P"

echo "-- a parent is idle on its own, then waiting on children while its child works"
work "$P"; finish "$P" "parent idle"
[ "$(state "$P")" = idle ] || fail "the parent is $(state "$P") after its turn"
work "$C"
[ "$(state "$P")" = waiting ] || fail "the parent is $(state "$P") while its child works"
[ "$(detail "$P")" = "waiting for 1 child" ] || fail "parent detail: $(detail "$P")"
[ "$(kinds "$P")" = children ] || fail "parent waits: $(kinds "$P")"
[ "$(turns "$P")" = 0 ] || fail "the parent was told while the child worked"

echo "-- the child finishes: the parent clears the wait, goes idle, and hears once"
finish "$C" "child done"
[ "$(state "$P")" = idle ] || fail "the parent is $(state "$P") after the child finished"
[ "$(kinds "$P")" = "" ] || fail "the children wait stayed: $(kinds "$P")"
[ "$(turns "$P")" = 1 ] || fail "the parent wasn't told exactly once (got $(turns "$P"))"
[ "$(turns "$P")" = 1 ] || fail "the parent was told twice"

echo "-- a busy grandchild counts too, and releases both levels when it goes quiet"
G=$(reg grand); parent "$G" "$C"
work "$C"; work "$G"
[ "$(state "$P")" = waiting ] || fail "the parent is $(state "$P") with a working grandchild"
[ "$(detail "$P")" = "waiting for 2 children" ] || fail "parent detail: $(detail "$P")"
[ "$(state "$C")" = working ] || fail "the child is $(state "$C"), not working"
finish "$G" "grandchild done"
[ "$(state "$P")" = waiting ] || fail "the parent is $(state "$P") while the child still works"
[ "$(detail "$P")" = "waiting for 1 child" ] || fail "parent detail: $(detail "$P")"
finish "$C" "child done"
[ "$(state "$P")" = idle ] || fail "the parent is $(state "$P") once the subtree is quiet"
[ "$(state "$C")" = idle ] || fail "the child is $(state "$C")"
[ "$(kinds "$P")" = "" ] || fail "the parent's children wait stayed: $(kinds "$P")"
[ "$(turns "$P")" = 2 ] || fail "the parent wasn't told exactly twice (got $(turns "$P"))"

echo "-- a pending permission is a human wait, and makes the parent wait on children"
R=$(request "$C" "Write /etc/hosts")
[ "$(state "$C")" = waiting ] || fail "the requester is $(state "$C")"
[ "$(detail "$C")" = "waiting for your approval" ] || fail "requester detail: $(detail "$C")"
[ "$(kinds "$C")" = "human/$R" ] || fail "requester waits: $(kinds "$C")"
[ "$(state "$P")" = waiting ] || fail "the parent is $(state "$P") during the request"
answer "$R" true "$P"
[ "$(state "$C")" = idle ] || fail "the requester is $(state "$C") after the answer"
[ "$(kinds "$C")" = "" ] || fail "the human wait stayed: $(kinds "$C")"
[ "$(state "$P")" = idle ] || fail "the parent is $(state "$P") after the answer"
[ "$(turns "$P")" = 2 ] || fail "answering told the parent again (got $(turns "$P"))"

echo "-- a restart rebuilds both kinds, neither losing nor leaving a stale wait"
R=$(request "$C" "Write /etc/passwd")
[ "$(state "$C")" = waiting ] || fail "the requester is $(state "$C")"
daemon_stop main; daemon_up main
[ "$(state "$C")" = waiting ] || fail "after a restart the requester is $(state "$C")"
[ "$(kinds "$C")" = "human/$R" ] || fail "after a restart the requester waits: $(kinds "$C")"
[ "$(detail "$C")" = "waiting for your approval" ] || fail "after a restart detail: $(detail "$C")"
[ "$(state "$P")" = waiting ] || fail "after a restart the parent is $(state "$P")"
answer "$R" true "$P"
[ "$(state "$C")" = idle ] || fail "the requester is $(state "$C") after the restart answer"
[ "$(state "$P")" = idle ] || fail "the parent is $(state "$P") after the restart answer"
[ "$(kinds "$P")" = "" ] || fail "a stale parent wait after the restart answer: $(kinds "$P")"

echo "PASS e2e-waits-stam"
