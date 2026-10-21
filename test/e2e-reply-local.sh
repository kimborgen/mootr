#!/bin/sh
# A reply to a mail this daemon stores (S-466), free (no models): the sender must be allowed to
# read the mail, by the same rule as a mail a peer stores (S-359, mail-visibility.ts). Registered
# agents on one daemon, mail driven through the API:
#   - stranger, in none of its threads, can't reply to alice's mail to bob, nor to a comment in an
#     ITSA it doesn't take part in, and the error is S-400's; nothing reaches bob
#   - bob (a recipient), the human, and boss (the chief of staff) may reply
#   - a child replies to its parent's mail, and a parent replies in its child's thread
#   - an ITSA participant's reply to the ITSA's comment lands in the ITSA's thread
#   - a cost_switch successor replies to mail its predecessor got
#   - an agent's own token can't set the fields only stam sets (thread_id, itsa_id, forwarded, ...),
#     which would place mail in any thread or skip these checks; its plain mail still goes out
#     (inferred too, S-608: naming a recipient as inferred would skip a refusal), and the ITSA post
#     route refuses the same fields (S-945), but not kind or health, which a comment or update sets
# intruder is a fake Claude Code run (test/fake-claude), for a real agent token; no model runs.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
printf '%s\n' '{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }' >"$TEST_TMP/reply.json"
fake_claude "$TEST_TMP/reply.json"
isolate
trap stam_test_cleanup EXIT
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${4:+-H 'x-stam-human: 1'} "$STAM_URL$2" ${3:+-d "$3"}; }
# tapi: api for /api/test/* routes; -f fails at the call when the gate answers 404.
tapi() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${4:+-H 'x-stam-human: 1'} "$STAM_URL$2" ${3:+-d "$3"}; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
fail() { echo "FAIL: $1"; exit 1; }
# send FROM TO REPLY_TO BODY: a reply as FROM; prints the daemon's answer.
send() { api POST /api/mail "{\"from\":\"$1\",\"to\":[\"$2\"],\"reply_to\":\"$3\",\"body\":\"$4\"}" ${5:+human}; }
# thread_of ANSWER: the thread id of the mail in a send's answer.
thread_of() { printf "%s" "$1" | jget "d['thread_id']"; }
# got BOX FROM: whether BOX has any mail from FROM.
got() { api GET "/api/agents/$1/inbox?unread=0&limit=50" | jget "any(m['from_id']=='$2' for m in d)"; }

ALICE=$(reg alice); BOB=$(reg bob); STRANGER=$(reg stranger); BOSS=$(reg boss)
PARENT=$(reg parent); CHILD=$(reg child)
api POST "/api/agents/$CHILD/set-parent" "{\"parent\":[\"$PARENT\"]}" >/dev/null
api POST "/api/agents/$BOSS/chief-of-staff" '{}' >/dev/null

M1=$(api POST /api/mail "{\"from\":\"$ALICE\",\"to\":[\"bob\"],\"subject\":\"Private\",\"body\":\"Just us.\",\"new_thread\":true}" | jget "d['id']")

echo "-- stranger, in none of its threads, can't reply to it and is told why"
R=$(send "$STRANGER" bob "$M1" "Let me in.")
printf "%s" "$R" | grep -q "mail $M1 isn't visible to you (you aren't in its thread)" || fail "stranger's reply wasn't refused (got: $R)"
printf "%s" "$R" | grep -q "new_thread: true" || fail "the refusal doesn't say to start a new thread (got: $R)"
[ "$(got bob "$STRANGER")" = False ] || fail "stranger's refused reply reached bob"

echo "-- bob, a recipient, replies in the thread"
R=$(send "$BOB" alice "$M1" "Agreed.")
[ "$(thread_of "$R")" = "$M1" ] || fail "bob's reply isn't in the thread (got: $R)"

echo "-- the human and boss, the chief of staff, may reply too"
R=$(send human bob "$M1" "From Dana." human)
[ "$(thread_of "$R")" = "$M1" ] || fail "the human's reply isn't in the thread (got: $R)"
R=$(send "$BOSS" bob "$M1" "From boss.")
[ "$(thread_of "$R")" = "$M1" ] || fail "boss's reply isn't in the thread (got: $R)"

echo "-- a child replies to its parent's mail, and a parent replies in its child's thread"
M2=$(api POST /api/mail "{\"from\":\"$PARENT\",\"to\":[\"child\"],\"subject\":\"Task\",\"body\":\"Do it.\",\"new_thread\":true}" | jget "d['id']")
R=$(send "$CHILD" parent "$M2" "Done.")
[ "$(thread_of "$R")" = "$M2" ] || fail "the child's reply to its parent isn't in the thread (got: $R)"
M3=$(api POST /api/mail "{\"from\":\"$CHILD\",\"to\":[\"alice\"],\"subject\":\"Question\",\"body\":\"Which one?\",\"new_thread\":true}" | jget "d['id']")
R=$(send "$PARENT" alice "$M3" "The first.")
[ "$(thread_of "$R")" = "$M3" ] || fail "the parent's reply in its child's thread isn't in the thread (got: $R)"

echo "-- in an ITSA thread, a participant's reply is a comment; stranger's is refused"
KEY=$("$STAM" itsa new "Reply scope" --owner alice --participant bob | awk '{print $1}')
C1=$(api POST "/api/itsas/$KEY/post" "{\"by\":\"$ALICE\",\"body\":\"first comment\"}" | jget "d['id']")
TID=$(api GET "/api/itsas/$KEY" | jget "d['thread_id']")
R=$(send "$BOB" alice "$C1" "A comment back.")
[ "$(thread_of "$R")" = "$TID" ] || fail "bob's reply to the ITSA comment isn't in its thread (got: $R)"
R=$(send "$STRANGER" alice "$C1" "Sneaking in.")
printf "%s" "$R" | grep -q "mail $C1 isn't visible to you" || fail "stranger's reply to the ITSA comment wasn't refused (got: $R)"
api GET "/api/itsas/$KEY" | jget "'$STRANGER' in d['participants']" | grep -qx False || fail "stranger's refused reply made it a participant"
ITSA_ID=$(api GET "/api/itsas/$KEY" | jget "d['id']")

echo "-- a cost_switch successor replies to mail its predecessor got"
PRED=$(reg pred); SUCC=$(reg succ)
M4=$(api POST /api/mail "{\"from\":\"$ALICE\",\"to\":[\"pred\"],\"subject\":\"Handover\",\"body\":\"Carry on.\",\"new_thread\":true}" | jget "d['id']")
tapi POST /api/test/agent "{\"agent\":\"$PRED\",\"forwarded_to\":\"$SUCC\"}" >/dev/null
R=$(send "$SUCC" alice "$M4" "On it.")
[ "$(thread_of "$R")" = "$M4" ] || fail "the successor's reply to its predecessor's mail isn't in the thread (got: $R)"

echo "-- an agent's own token can't set the fields only stam sets"
"$STAM" spawn intruder --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
"$STAM" wait intruder --until idle --timeout 60
INTRUDER=$(api GET /api/agents/intruder | jget "d['id']")
ITOKEN=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$INTRUDER" STAM_TOKEN | cut -d= -f2-)
[ -n "$ITOKEN" ] || fail "intruder has no token"
as_intruder() { curl -s -X POST -H "authorization: Bearer $ITOKEN" -H 'content-type: application/json' "$STAM_URL/api/mail" -d "$1"; }
refused() { # refused FIELDS JSON_EXTRA: intruder's mail to bob with JSON_EXTRA is refused naming FIELDS
  _r=$(as_intruder "{\"to\":[\"bob\"],\"body\":\"injected\",$2}")
  printf "%s" "$_r" | grep -q "$1 [a-z]* set only by stam" || fail "intruder's mail with $1 wasn't refused (got: $_r)"
}
refused "thread_id, itsa_id" "\"thread_id\":\"$M1\",\"itsa_id\":\"$ITSA_ID\""
refused "thread_id" "\"thread_id\":\"$M1\""
refused "forwarded" "\"forwarded\":{\"from_name\":\"alice\"},\"reply_to\":\"$M1\""
for f in '"relay":true' '"itsa_id":"'"$ITSA_ID"'"' '"mail_id":"m1234abcd"' '"from_stam":true' '"permission_id":"p1"' \
  '"interrupt":["bob"]' '"inferred":["bob"]' '"kind":"comment"' '"health":"on_track"' '"auto_threaded":true' '"about_itsa":"'"$ITSA_ID"'"' \
  '"title":"t"' '"system":"deploy"'; do
  refused "$(printf "%s" "$f" | sed 's/^"\([a-z_]*\)".*/\1/')" "$f"
done
[ "$(got bob "$INTRUDER")" = False ] || fail "a refused mail from intruder reached bob"
# The ITSA post route refuses the same fields (S-945) before it checks the poster, so the field refusal shows.
as_post() { curl -s -X POST -H "authorization: Bearer $ITOKEN" -H 'content-type: application/json' "$STAM_URL/api/itsas/$KEY/post" -d "$1"; }
for f in '"inferred":["bob"]' '"thread_id":"'"$M1"'"'; do
  _r=$(as_post "{\"body\":\"injected\",$f}")
  printf "%s" "$_r" | grep -q "set only by stam, not in an agent's post" || fail "intruder's ITSA post with $f wasn't refused (got: $_r)"
done
# The intruder becomes a participant, so its post is authorized: an update's kind and health are accepted and stored.
api PATCH "/api/itsas/$KEY" "{\"participants\":[\"$BOB\",\"$INTRUDER\"],\"by\":\"human\"}" human >/dev/null
api GET "/api/itsas/$KEY" | jget "'$INTRUDER' in d['participants']" | grep -qx True || fail "intruder wasn't made a participant"
_r=$(as_post "{\"by\":\"$INTRUDER\",\"body\":\"an update\",\"kind\":\"update\",\"health\":\"at_risk\"}")
PID=$(printf "%s" "$_r" | jget "d['id']") || fail "intruder's update post wasn't accepted (got: $_r)"
TID=$(api GET "/api/itsas/$KEY" | jget "d['thread_id']")
api GET "/api/threads/$TID" | jget "[(m['kind'], m['health']) for m in d if m['id']=='$PID']" | grep -qx "\[('update', 'at_risk')\]" || fail "the stored post lacks kind update and health at_risk"
api GET "/api/threads/$M1" | jget "any(m['from_id']=='$INTRUDER' for m in d)" | grep -qx False || fail "intruder's mail landed in alice's thread"
R=$(as_intruder "{\"to\":[\"bob\"],\"reply_to\":\"$M1\",\"body\":\"by reply\"}")
printf "%s" "$R" | grep -q "mail $M1 isn't visible to you" || fail "intruder's reply by its own token wasn't refused (got: $R)"
R=$(as_intruder '{"to":["bob"],"subject":"Hello","body":"a plain mail","new_thread":true}')
[ "$(printf "%s" "$R" | jget "d['from_id']")" = "$INTRUDER" ] || fail "intruder's plain mail didn't go out (got: $R)"
echo "PASS: a reply to a local mail needs a sender who may read it"
