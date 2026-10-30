#!/bin/sh
# Decision steps over HTTP, free (stubbed decisions endpoint, registered agents, no model
# turns): create, list, read, update, and delete a step, with 400 for a bad step and 404 for
# an unknown one; a mail to the human runs its step in the background and logs the decision
# (also found by subject); a model error fails open with the mail delivered; and the preview
# answers on the last N mails to the human without writing the log. Tool steps are checked
# before the tool runs (POST /api/steps/check), through mcp.ts too (a denial is an error result).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
stub_key main
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$(dirname "$(readlink -f "$0")")/decide-stub.mjs" "$STUB" &
STUB_PID=$!
for _i in $(seq 1 50); do
  [ -s "$STUB/url" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || { echo "FAIL: the stub endpoint didn't start"; exit 1; }
  sleep 0.2
done
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
call() { curl -s -o "$TEST_TMP/out.json" -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$3" "$STAM_URL$2"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# Waits for a step's log to hold n decisions.
until_logged() {
  _i=0
  while [ "$(get "/api/steps/$1/log" | jget "len(d['decisions'])")" -lt "$2" ]; do
    _i=$((_i + 1))
    [ "$_i" -gt 60 ] && fail "step $1 logged fewer than $2 decisions"
    sleep 0.2
  done
}

SENDER=$(post /api/register '{"name":"sender","role":"developer"}' | jget "d['id']")

# A bad step is 400 and names what's wrong; an unknown step is 404.
[ "$(call POST /api/steps '{"name":"x","question":"q","trigger":{"kind":"event","event":"nope"}}')" = 400 ] || fail "a bad trigger wasn't 400"
grep -q mail-to-human "$TEST_TMP/out.json" || fail "the 400 doesn't list the events"
[ "$(call GET /api/steps/stnothere '')" = 404 ] || fail "an unknown step wasn't 404"

# Create with defaults, list, read, and update.
[ "$(call POST /api/steps '{"name":"long mail","question":"Is this mail longer than it needs to be?","trigger":{"kind":"event","event":"mail-to-human"}}')" = 200 ] || fail "create failed: $(cat "$TEST_TMP/out.json")"
ID=$(jget "d['id']" <"$TEST_TMP/out.json")
[ "$(jget "(d['threshold'], d['action'], d['enabled'])" <"$TEST_TMP/out.json")" = "(0.5, 'flag', True)" ] || fail "defaults wrong: $(cat "$TEST_TMP/out.json")"
[ "$(get /api/steps | jget "[s['id'] for s in d['steps']] == ['$ID'] and 'itsa-status' in d['events']")" = True ] || fail "the list doesn't hold the step and the events"
[ "$(call PATCH "/api/steps/$ID" '{"threshold":0.6}')" = 200 ] || fail "update failed: $(cat "$TEST_TMP/out.json")"
[ "$(get "/api/steps/$ID" | jget "d['threshold']")" = 0.6 ] || fail "the update didn't stick"

# A mail to the human runs the step after the send; the log has the subject and the answer.
M=$(post /api/mail "{\"from\":\"$SENDER\",\"to\":[\"human\"],\"subject\":\"Report\",\"body\":\"long text P=0.83\",\"new_thread\":true}" | jget "d['id']")
until_logged "$ID" 1
[ "$(get "/api/steps/$ID/log" | jget "(d['decisions'][0]['subject'], d['decisions'][0]['p'], d['decisions'][0]['answer'], d['decisions'][0]['action'])")" = "('mail:$M', 0.83, True, 'flagged')" ] ||
  fail "the log is wrong: $(get "/api/steps/$ID/log")"
[ "$(get "/api/steps/decisions?subject=mail:$M" | jget "len(d['decisions'])")" = 1 ] || fail "the decision isn't found by subject"

# A model error fails open: the mail is delivered and the failure is logged.
M2=$(post /api/mail "{\"from\":\"$SENDER\",\"to\":[\"human\"],\"subject\":\"Broken\",\"body\":\"STUB:FAIL\",\"new_thread\":true}" | jget "d['id']")
[ -n "$M2" ] || fail "the mail wasn't sent"
until_logged "$ID" 2
[ "$(get "/api/steps/$ID/log" | jget "d['decisions'][0]['action']")" = failed-open ] || fail "a model error wasn't logged as failed-open"

# The preview answers on the last 2 mails to the human, newest first, and logs nothing.
[ "$(call POST "/api/steps/$ID/preview" '{"n":2}')" = 200 ] || fail "preview failed: $(cat "$TEST_TMP/out.json")"
[ "$(jget "[e['summary'] for e in d['examples']]" <"$TEST_TMP/out.json")" = "['Broken', 'Report']" ] || fail "preview examples wrong: $(cat "$TEST_TMP/out.json")"
[ "$(jget "(d['examples'][1]['p'], d['examples'][1]['answer'], 'error' in d['examples'][0])" <"$TEST_TMP/out.json")" = "(0.83, True, True)" ] || fail "preview answers wrong: $(cat "$TEST_TMP/out.json")"
[ "$(get "/api/steps/$ID/log" | jget "len(d['decisions'])")" = 2 ] || fail "the preview wrote the log"

# Turned off, the step doesn't run; deleted, it's gone.
call PATCH "/api/steps/$ID" '{"enabled":false}' >/dev/null
QUIET=$(post /api/mail "{\"from\":\"$SENDER\",\"to\":[\"human\"],\"subject\":\"Quiet\",\"body\":\"P=0.9\",\"new_thread\":true}" | jget "d['id']")
# A later mail, after the step is back on, is logged; the step runs on events as they commit, so
# the log holds the later mail and never the quiet one.
call PATCH "/api/steps/$ID" '{"enabled":true}' >/dev/null
post /api/mail "{\"from\":\"$SENDER\",\"to\":[\"human\"],\"subject\":\"Loud\",\"body\":\"P=0.2\",\"new_thread\":true}" >/dev/null
until_logged "$ID" 3
[ "$(get "/api/steps/decisions?subject=mail:$QUIET" | jget "len(d['decisions'])")" = 0 ] || fail "a step that is off ran"
call PATCH "/api/steps/$ID" '{"enabled":false}' >/dev/null
[ "$(call DELETE "/api/steps/$ID" '{}')" = 200 ] || fail "delete failed: $(cat "$TEST_TMP/out.json")"
[ "$(call GET "/api/steps/$ID" '')" = 404 ] || fail "a deleted step is still there"

# A tool step checks a call before it runs: the daemon's check says deny on P=0.9, and mcp.ts
# withholds the call (an error result, nothing sent). A "no" lets it run, a model error fails
# open, a tool with no step asks no model, and the preview answers on recorded calls.
RECV=$(post /api/register '{"name":"receiver","role":"developer"}' | jget "d['id']")
TOOLSTEP=$(post /api/steps '{"name":"no spam","question":"Is this mail spam?","trigger":{"kind":"tool","tool":"send_mail"},"action":"deny-if-yes"}' | jget "d['id']")
check() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$1" "$STAM_URL/api/steps/check"; }
[ "$(check "{\"agent\":\"$SENDER\",\"tool\":\"send_mail\",\"args\":{\"body\":\"P=0.9\"}}" | jget "(d['allow'], d['step']['name'], 'no spam' in d['error'])")" = "(False, 'no spam', True)" ] || fail "the check didn't deny P=0.9"
[ "$(check "{\"agent\":\"$SENDER\",\"tool\":\"send_mail\",\"args\":{\"body\":\"P=0.1\"}}" | jget "d['allow']")" = True ] || fail "the check denied P=0.1"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"agent":"nobody","tool":"send_mail","args":{}}' "$STAM_URL/api/steps/check")" = 404 ] || fail "a check for an unknown agent wasn't 404"
BEFORE=$(cat "$STUB/count")
[ "$(check "{\"agent\":\"$SENDER\",\"tool\":\"whoami\",\"args\":{}}" | jget "d['allow']")" = True ] || fail "a tool with no step was denied"
[ "$(cat "$STUB/count")" = "$BEFORE" ] || fail "a tool with no step asked the model"
[ "$(check "{\"agent\":\"$SENDER\",\"tool\":\"send_mail\",\"args\":{\"body\":\"STUB:FAIL\"}}" | jget "d['allow']")" = True ] || fail "a model error didn't fail open"
until_logged "$TOOLSTEP" 3
[ "$(get "/api/steps/$TOOLSTEP/log" | jget "d['decisions'][0]['action']")" = failed-open ] || fail "the model error wasn't logged as failed-open"

# Through mcp.ts: a denied call returns an error and doesn't run; a call the step lets through runs.
MCP="$(dirname "$(readlink -f "$0")")/mcp-call.mjs"
mcp_send() {
  STAM_BIN="$STAM" with_agent_id "$SENDER" node "$MCP" \
    "$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_mail","arguments":{"to":[sys.argv[1]],"subject":"Pitch","body":sys.argv[2]}}}))' "$RECV" "$1")"
}
DENIED=$(mcp_send "P=0.9 buy now")
[ "$(echo "$DENIED" | jget "(d['result']['isError'], 'no spam' in d['result']['content'][0]['text'])")" = "(True, True)" ] || fail "the denied send wasn't an error naming the step: $DENIED"
[ "$(get "/api/steps/$TOOLSTEP/log" | jget "d['decisions'][0]['action']")" = denied ] || fail "the denial wasn't logged"
ALLOWED=$(mcp_send "P=0.1 hello")
[ "$(echo "$ALLOWED" | jget "('isError' in d['result'], d['result']['content'][0]['text'][:6])")" = "(False, 'Sent m')" ] || fail "the allowed send didn't run: $ALLOWED"

# The preview answers on the recorded calls of the tool: the last two checked calls.
[ "$(call POST "/api/steps/$TOOLSTEP/preview" '{"n":2}')" = 200 ] || fail "tool preview failed: $(cat "$TEST_TMP/out.json")"
[ "$(jget "[e['subject'] for e in d['examples']]" <"$TEST_TMP/out.json")" = "['tool:send_mail', 'tool:send_mail']" ] || fail "tool preview examples wrong: $(cat "$TEST_TMP/out.json")"

kill "$STUB_PID" 2>/dev/null || true
echo PASS
