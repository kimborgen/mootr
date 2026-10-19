#!/bin/sh
# S-351 end to end, free (no models): the agent waits the web reads carry the mail thread they
# are tied to. One isolated daemon; agents are registered, not spawned. Checks:
#   - an ITSA moved to needs_review asks the human in its own thread (its ask mail)
#   - a human wait declared with thread = the ask's mail id shows that ask's thread id as its
#     `thread` on GET /api/agents, GET /api/agents/:id and GET /api/agents/:id/waits
#   - a human wait with no thread shows thread null, and one naming a thread shows it as given
#   - the ITSA's attention row carries the same ask thread the wait is tied to
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"; }
register() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
# The thread's waits of agent $1, as the agent's own row shows them: the first wait's thread.
wait_thread() { api GET "/api/agents/$1" | jget "[w['thread'] for w in d['waits'] if w['kind']=='human'][0]"; }

ALICE=$(register alice)
BOB=$(register bob)
KEY=$("$STAM" itsa new "Ask block e2e" --owner alice --status in_progress | awk '{print $1}')
api POST "/api/itsas/$KEY/post" "{\"by\":\"$ALICE\",\"body\":\"Done: ready to look at.\"}" >/dev/null
api PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$ALICE\"}" >/dev/null

# The ask: the human's mail about the ITSA, in its own thread.
api GET "/api/itsas/$KEY/thread" >"$TEST_TMP/t.json"
ASK_ID=$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['id']" <"$TEST_TMP/t.json")
ASK_TID=$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['thread_id']" <"$TEST_TMP/t.json")
[ -n "$ASK_ID" ] || fail "no ask mail"

echo "-- a wait tied to the ask's mail id carries the ask's thread"
W=$(api POST "/api/agents/$BOB/waits/declared" "{\"on\":\"human\",\"thread\":\"$ASK_ID\",\"note\":\"the review\",\"by\":\"$BOB\"}" | jget "d['id']")
[ "$(wait_thread "$BOB")" = "$ASK_TID" ] || fail "the agent row's wait isn't tied to the ask's thread ($(wait_thread "$BOB"))"
[ "$(api GET "/api/agents/$BOB/waits" | jget "[w['thread'] for w in d if w['id']=='$W'][0]")" = "$ASK_TID" ] || fail "GET /waits doesn't carry the thread"
[ "$(api GET /api/agents | jget "[w['thread'] for a in d if a['id']=='$BOB' for w in a['waits'] if w['id']=='$W'][0]")" = "$ASK_TID" ] || fail "GET /api/agents doesn't carry the thread"
[ "$(api GET /api/itsas/attention | jget "[x['ask_thread_id'] for x in d if x['key']=='$KEY'][0]")" = "$ASK_TID" ] || fail "the attention row's ask thread isn't the one the wait is tied to"
api POST "/api/agents/$BOB/waits/done" "{\"id\":\"$W\",\"by\":\"$BOB\"}" >/dev/null

echo "-- an untied wait carries no thread; a wait naming a thread keeps it"
W=$(api POST "/api/agents/$BOB/waits/declared" "{\"on\":\"human\",\"note\":\"anything\",\"by\":\"$BOB\"}" | jget "d['id']")
[ "$(api GET "/api/agents/$BOB" | jget "[w['thread'] for w in d['waits'] if w['id']=='$W'][0]")" = None ] || fail "an untied wait has a thread"
api POST "/api/agents/$BOB/waits/done" "{\"id\":\"$W\",\"by\":\"$BOB\"}" >/dev/null
W=$(api POST "/api/agents/$BOB/waits/declared" "{\"on\":\"human\",\"thread\":\"t-unknown\",\"note\":\"elsewhere\",\"by\":\"$BOB\"}" | jget "d['id']")
[ "$(api GET "/api/agents/$BOB" | jget "[w['thread'] for w in d['waits'] if w['id']=='$W'][0]")" = t-unknown ] || fail "a thread naming no mail isn't kept as given"

echo "ok: ask-block"
