#!/bin/sh
# ITSAs step 8 end to end, free (no models): one isolated daemon. Agents are registered, not
# spawned. Checks:
#   - an agent moving an ITSA to needs_review mails the human once in the ITSA's thread (kind
#     ask, from the agent, to the human only, with the owner's latest comment), and adds the
#     human as a participant
#   - the same status set again sends nothing; a different human status sends again
#   - a move to a status that doesn't wait on the human, and the human's own change, send nothing
#   - GET /api/itsas/attention lists the ITSA with its actions and its ask mail's thread; GET /api/itsas/:id has them too
#   - Request changes needs text, moves the ITSA to in_progress, and posts the text as a
#     comment from the human that interrupts the owner
#   - Approve (needs_review) moves it to ready_to_merge, which doesn't ask the human (release merges) and has no actions
#   - an agent can't use the act route
#   - settings.itsa.actions overrides a status's actions
#   - an agent can't move an ITSA into a human status until it has commented since its last status change
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TOKEN=$(cat "$STAM_HOME/token")
# api METHOD PATH [BODY] [human]: a call to the daemon; the 4th word "human" acts as the human.
api() {
  if [ "$4" = human ]; then
    curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' ${3:+-d "$3"} "$STAM_URL$2"
  else
    curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"
  fi
}
code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }
register() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
asks() { api GET "/api/itsas/$1/thread" | jget "len([i for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'])"; }
notice() { api POST "/api/hook/claude/$1" '{"hook_event_name":"PostToolUse"}' | jget "d.get('stdout','')"; }

ALICE=$(register alice)
KEY=$("$STAM" itsa new "Human e2e" --owner alice --status in_progress | awk '{print $1}')
api POST "/api/itsas/$KEY/post" "{\"by\":\"$ALICE\",\"body\":\"Done: tests pass.\"}" >/dev/null

# 1. Entering needs_review, by alice, mails the human once.
api PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$ALICE\"}" >/dev/null
sleep 1
[ "$(asks "$KEY")" = 1 ] || fail "entering needs_review didn't send exactly one ask mail"
api GET "/api/itsas/$KEY/thread" >"$TEST_TMP/t.json"
ASK=$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]" <"$TEST_TMP/t.json")
echo "$ASK" | grep -q "needs review" || fail "the ask doesn't say what is asked"
echo "$ASK" | grep -q "Done: tests pass" || fail "the ask doesn't carry the owner's latest comment"
[ "$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['from_id']" <"$TEST_TMP/t.json")" = "$ALICE" ] || fail "the ask isn't from alice"
[ "$(jget "[r['id'] for r in [i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['recipients']]" <"$TEST_TMP/t.json")" = "['human']" ] || fail "the ask goes to someone besides the human"
api GET "/api/itsas/$KEY" | jget "'human' in d['participants']" | grep -q True || fail "the human isn't a participant"

# 1b. `stam itsa mails` (S-1490) gives the ITSA thread whole, with the ask's kind, sender and body.
"$STAM" itsa mails "$KEY" >"$TEST_TMP/mails.json" || fail "stam itsa mails failed"
[ "$(jget "[m['id'] for m in d if m['kind']=='ask']" <"$TEST_TMP/mails.json")" = "['$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['id']" <"$TEST_TMP/t.json")']" ] || fail "itsa mails doesn't list the ask"
[ "$(jget "[m['from_id'] for m in d if m['kind']=='ask'][0]" <"$TEST_TMP/mails.json")" = "$ALICE" ] || fail "itsa mails: the ask isn't from alice"
jget "'Done: tests pass' in [m['body'] for m in d if m['kind']=='ask'][0]" <"$TEST_TMP/mails.json" | grep -q True || fail "itsa mails: the ask body is missing"
"$STAM" itsa mails S-99999 >/dev/null 2>&1 && fail "itsa mails on an unknown ITSA succeeded"

# 2. The same status again sends nothing.
api PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$ALICE\"}" >/dev/null
sleep 1
[ "$(asks "$KEY")" = 1 ] || fail "setting the same status sent a second mail"

# 3. The attention list and the actions.
[ "$(api GET /api/itsas/attention | jget "[x['key'] for x in d].count('$KEY')")" = 1 ] || fail "the ITSA isn't on the attention list"
ASK_ID=$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['id']" <"$TEST_TMP/t.json")
ASK_TID=$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['thread_id']" <"$TEST_TMP/t.json")
[ "$(api GET /api/itsas/attention | jget "[(x['ask_thread_id'], x['ask_mail_id']) for x in d if x['key']=='$KEY'][0]")" = "('$ASK_TID', '$ASK_ID')" ] || fail "the attention row doesn't carry its ask mail's thread"
[ "$(api GET "/api/itsas/$KEY" | jget "[a['id'] for a in d['actions']]")" = "['approve', 'changes']" ] || fail "needs_review doesn't offer Approve and Request changes"
[ "$(api GET "/api/itsas/$KEY" | jget "[a['to'] for a in d['actions']]")" = "['ready_to_merge', 'in_progress']" ] || fail "the default targets are wrong"

# 4. Request changes needs text; with it, the status moves and the comment interrupts alice.
[ "$(code "/api/itsas/$KEY/act" '{"action":"changes","text":""}')" = 403 ] || fail "an agent could use the act route (or the route is missing)"
api POST "/api/itsas/$KEY/act" '{"action":"changes","text":""}' human >/dev/null 2>&1 && fail "Request changes without text was accepted"
api POST "/api/itsas/$KEY/act" '{"action":"changes","text":"Please rename the flag"}' human >/dev/null || fail "Request changes failed"
[ "$(api GET "/api/itsas/$KEY" | jget "d['status']")" = in_progress ] || fail "Request changes didn't move it to in_progress"
api GET "/api/itsas/$KEY/thread" | jget "[i['mail']['body'] for i in d['items'] if i['type']=='mail' and i['mail']['from_id']=='human']" | grep -q "Please rename the flag" || fail "the text isn't a comment from the human"
notice "$ALICE" | grep -q "unread mail" || fail "the human's comment didn't interrupt the owner"
[ "$(api GET /api/itsas/attention | jget "[x['key'] for x in d].count('$KEY')")" = 0 ] || fail "it stays on the attention list after the action"

# 5. A human status entered again asks again; Approve moves to ready_to_merge, which doesn't ask and has no actions.
api POST "/api/itsas/$KEY/post" "{\"by\":\"$ALICE\",\"body\":\"Fixed the flag.\"}" >/dev/null
api PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$ALICE\"}" >/dev/null
sleep 1
[ "$(asks "$KEY")" = 2 ] || fail "re-entering a human status didn't ask again"
api POST "/api/itsas/$KEY/act" '{"action":"approve","text":""}' human >/dev/null || fail "Approve failed"
sleep 1
[ "$(api GET "/api/itsas/$KEY" | jget "d['status']")" = ready_to_merge ] || fail "Approve didn't move needs_review to ready_to_merge"
[ "$(asks "$KEY")" = 2 ] || fail "ready_to_merge asked the human"
[ "$(api GET "/api/itsas/$KEY" | jget "d['actions']")" = "[]" ] || fail "ready_to_merge has human actions"
[ "$(api GET /api/itsas/attention | jget "[x['key'] for x in d].count('$KEY')")" = 0 ] || fail "ready_to_merge is on the attention list"

# 6. Statuses that don't wait on the human, and the human's own change, send nothing.
KEY2=$("$STAM" itsa new "Quiet e2e" --owner alice | awk '{print $1}')
api PATCH "/api/itsas/$KEY2" "{\"status\":\"in_review\",\"by\":\"$ALICE\"}" >/dev/null
api PATCH "/api/itsas/$KEY2" "{\"status\":\"needs_approval\",\"by\":\"$ALICE\"}" >/dev/null 2>&1 && fail "alice moved to needs_approval without a comment"
api PATCH "/api/itsas/$KEY2" '{"status":"needs_approval"}' human >/dev/null
sleep 1
[ "$(api GET "/api/itsas/$KEY2" | jget "d['thread_id']")" = None ] || fail "a quiet change started a thread"

# 7. Settings override a status's actions.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
s.setdefault("itsa", {})["actions"] = {"needs_test": [{"id": "approve", "label": "Ship it", "to": "deploying", "text": "none"}]}
json.dump(s, open(sys.argv[1], "w"))
PY
KEY3=$("$STAM" itsa new "Override e2e" --owner alice --status needs_test | awk '{print $1}')
[ "$(api GET "/api/itsas/$KEY3" | jget "[(a['label'], a['to']) for a in d['actions']]")" = "[('Ship it', 'deploying')]" ] || fail "settings.itsa.actions didn't override"
api POST "/api/itsas/$KEY3/act" '{"action":"approve","text":""}' human >/dev/null || fail "the overridden action failed"
[ "$(api GET "/api/itsas/$KEY3" | jget "d['status']")" = deploying ] || fail "the overridden action didn't move it"
echo "PASS: itsa-human e2e"
