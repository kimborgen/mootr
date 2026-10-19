#!/bin/sh
# Event waits and ITSA link subscriptions end to end, free (no models): one isolated daemon.
# An agent row declares an event wait over HTTP; a non-matching event leaves it waiting and a
# matching event POSTed to /api/events clears it, leaving the event line as an in-turn notice.
# An ITSA linked to a GitHub pull request is subscribed by stam; closing it drops that
# subscription and reopening recreates it. Checks:
#   - the declared event wait shows as the agent's wait (kind event) and clears on the first
#     matching event only; the agent goes idle and the notice names the summary and url
#   - an ITSA link creates one stam subscription on that subject; a closed ITSA has none;
#     reopening recreates it
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
count() { python3 -c "import json,sys; print(len(json.load(sys.stdin)))"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
event() { api POST /api/events "$1" >/dev/null; }
hook() { api POST "/api/hook/claude/$1" "$2" >/dev/null; }
work() { hook "$1" '{"hook_event_name":"UserPromptSubmit"}'; }
finish() { hook "$1" "{\"hook_event_name\":\"Stop\",\"last_assistant_message\":\"$2\"}"; }
subs() { curl -s -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' "$STAM_URL/api/subscriptions"; }
fail() { echo "FAIL: $1"; exit 1; }

A=$(reg alice)
# Drive one turn to idle, as a real agent reaches between turns, before it declares its wait.
work "$A"; finish "$A" "ready"

echo "-- a declared event wait shows as the agent's wait"
W=$(api POST "/api/agents/$A/waits/declared" '{"on":"event","filter":{"source":"github","subjects":["github:o/r#12"]},"note":"CI on PR 12"}' | field '["id"]')
case "$W" in w*) ;; *) fail "no wait id: $W" ;; esac
[ "$(api GET "/api/agents/$A" | field '["activity"]')" = waiting ] || fail "the agent isn't waiting (got $(api GET "/api/agents/$A" | field '["activity"]'))"
[ "$(api GET "/api/agents/$A" | field '["activity_detail"]')" = "waiting for CI on PR 12" ] || fail "detail: $(api GET "/api/agents/$A" | field '["activity_detail"]')"
api GET "/api/agents/$A/waits" | python3 -c "import json,sys; w=json.load(sys.stdin); assert len(w)==1 and w[0]['kind']=='event', w" || fail "the wait row isn't an event"

echo "-- an event outside the filter leaves it waiting"
event '{"source":"github","type":"check_run","subjects":["github:o/r#13"],"summary":"another PR","dedupe_key":"n1"}'
[ "$(api GET "/api/agents/$A/waits" | count)" = 1 ] || fail "an event outside the filter cleared the wait"

echo "-- a matching event clears it and leaves the event line as a notice"
event '{"source":"github","type":"check_run.completed","subjects":["github:o/r#12"],"url":"https://gh/12","summary":"CI passed","dedupe_key":"m1"}'
[ "$(api GET "/api/agents/$A/waits" | count)" = 0 ] || fail "the matching event didn't clear the wait"
[ "$(api GET "/api/agents/$A" | field '["activity"]')" = idle ] || fail "the agent is $(api GET "/api/agents/$A" | field '["activity"]') after its wait cleared"
# A PostToolUse hook returns the queued notice, which names the event's summary and url.
NOTICE=$(api POST "/api/hook/claude/$A" '{"hook_event_name":"PostToolUse"}' | field '["stdout"]')
echo "$NOTICE" | grep -q "CI passed" || fail "the notice doesn't name the event summary: $NOTICE"
echo "$NOTICE" | grep -q "https://gh/12" || fail "the notice doesn't name the event url: $NOTICE"

echo "-- an ITSA linked to a PR is subscribed as stam; closing drops it and reopening recreates it"
KEY=$("$STAM" itsa new "PR 12" | awk '{print $1}')
ITSAID=$(api GET "/api/itsas/$KEY" | field '["id"]')
"$STAM" itsa link "$KEY" "https://github.com/o/r/pull/12" >/dev/null
subs >"$TEST_TMP/subs.json"
python3 -c "
import json
s=json.load(open('$TEST_TMP/subs.json'))
assert len(s)==1, s
assert s[0]['subscriber_kind']=='itsa' and s[0]['subscriber_id']=='$ITSAID', s
assert s[0]['created_by']=='stam', s
assert s[0]['filter']['subjects']==['github:o/r#12'], s
assert s[0]['note']=='linked github:o/r#12', s
" || fail "the link made no stam subscription on its subject"
"$STAM" itsa set "$KEY" --status done >/dev/null
[ "$(subs | count)" = 0 ] || fail "a closed ITSA kept its link subscription"
"$STAM" itsa set "$KEY" --status in_progress >/dev/null
[ "$(subs | count)" = 1 ] || fail "reopening didn't recreate the link subscription"

echo "PASS e2e-event-waits"
