#!/bin/sh
# S-353 end to end, free (no models): the human's deferral ("Decide later") moves an open ask or
# decision mail to the deferred state, which takes it off the waiting list and keeps it open; a
# later mail from an agent clears it. One isolated daemon; agents are registered, not spawned.
# Checks:
#   - an ITSA's ask is listed by GET /api/itsas/attention, not deferred, until the human defers it
#   - the human's deferral reply in the ask's thread marks the ask deferred, and it stays listed
#   - the human's answer in the thread (a choice) clears the deferral, and a later deferral sets it again
#   - an agent's mail in the thread clears the deferral
#   - a decision mail's deferral is listed as deferred in GET /api/mail/decisions, and an agent's mail clears it
#   - a note with a deferral, or a deferral with an attachment, doesn't defer
#   - an agent's mail that isn't to the human doesn't clear a deferral; mail to the human does
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"; }
# Mail as the human, from the web UI: the x-stam-human header marks the caller as the human.
human() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "$1" "$STAM_URL/api/mail"; }
register() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
# The deferred flag of the ITSA's attention row, and of a decision mail's row.
attention_deferred() { api GET /api/itsas/attention | jget "[x['deferred'] for x in d if x['key']=='$1']"; }
decision_deferred() { api GET /api/mail/decisions | jget "[x['deferred'] for x in d if x['mail_id']=='$1']"; }
# A decision block, as a JSON string: BT is a backtick, so the fence stays out of shell quoting.
BT='`'
FENCE="${BT}${BT}${BT}"
DEFER="Deferring this one: still open, I'll decide later. Keep working on what doesn't depend on it."
ALICE=$(register alice)
BOB=$(register bob)

echo "-- an ITSA's ask is listed, not deferred"
KEY=$("$STAM" itsa new "Deferred e2e" --owner alice --status in_progress | awk '{print $1}')
api POST "/api/itsas/$KEY/post" "{\"by\":\"$ALICE\",\"body\":\"Pick:\n\n${FENCE}pick\nship\nhold\n${FENCE}\"}" >/dev/null
api PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$ALICE\"}" >/dev/null
api GET "/api/itsas/$KEY/thread" >"$TEST_TMP/t.json"
ASK_ID=$(jget "[i['mail']['id'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]" <"$TEST_TMP/t.json")
[ -n "$ASK_ID" ] || fail "no ask mail"
[ "$(attention_deferred "$KEY")" = "[False]" ] || fail "a new ask is deferred"

echo "-- the human's deferral in the ask's thread defers it, and the ask stays listed"
human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: $KEY\",\"body\":\"> Pick\n\n$DEFER\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[True]" ] || fail "the deferral doesn't defer the ask"
api GET /api/itsas/attention | jget "[x['key'] for x in d]" | grep -q "$KEY" || fail "a deferred ask left the attention list"

echo "-- an answer in the thread clears the deferral; a later deferral sets it again"
human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: $KEY\",\"body\":\"> Pick\n\nChose **ship**.\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[False]" ] || fail "an answer doesn't clear the deferral"
human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: $KEY\",\"body\":\"> Pick\n\n$DEFER\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[True]" ] || fail "a second deferral doesn't defer the ask"

echo "-- an agent's mail in the thread clears the deferral"
api POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Re: $KEY\",\"body\":\"Thanks, I'll keep going.\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[False]" ] || fail "an agent's mail doesn't clear the deferral"

echo "-- a note with a deferral doesn't defer, and neither does a deferral with an attachment"
human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: $KEY\",\"body\":\"> Pick\n\n$DEFER\n\nNote: later.\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[False]" ] || fail "a note with a deferral defers the ask"
human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: $KEY\",\"body\":\"> Pick\n\n$DEFER\",\"reply_to\":\"$ASK_ID\",\"attachments\":[{\"name\":\"n.txt\",\"content\":\"x\"}]}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[False]" ] || fail "a deferral with an attachment defers the ask"

echo "-- a deferred ask stays deferred through mail that isn't to the human, and mail to the human clears it"
human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: $KEY\",\"body\":\"> Pick\n\n$DEFER\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[True]" ] || fail "the deferral doesn't defer the ask again"
api POST /api/mail "{\"from\":\"alice\",\"to\":[\"bob\"],\"subject\":\"Re: $KEY\",\"body\":\"ok, noted.\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[True]" ] || fail "an agent's mail not to the human clears the deferral"
api POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Re: $KEY\",\"body\":\"Thanks, I'll keep going.\",\"reply_to\":\"$ASK_ID\"}" >/dev/null
[ "$(attention_deferred "$KEY")" = "[False]" ] || fail "an agent's mail to the human doesn't clear the deferral"

echo "-- a decision mail's deferral is listed as deferred, and an agent's mail clears it"
M1=$(api POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Pick one\",\"body\":\"Which one?\n\n${FENCE}pick\nship\nhold\n${FENCE}\"}" | jget "d['id']")
[ "$(decision_deferred "$M1")" = "[False]" ] || fail "a new decision mail is deferred"
human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: Pick one\",\"body\":\"> Which one?\n\n$DEFER\",\"reply_to\":\"$M1\"}" >/dev/null
[ "$(decision_deferred "$M1")" = "[True]" ] || fail "the deferral doesn't defer the decision mail"
api POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Re: Pick one\",\"body\":\"Still waiting on the data.\",\"reply_to\":\"$M1\"}" >/dev/null
[ "$(decision_deferred "$M1")" = "[False]" ] || fail "an agent's mail doesn't clear the deferral of the decision mail"

echo "ok: deferred"
