#!/bin/sh
# Mail between agents in a thread the human started stays out of the human's inbox (S-542), free
# (no models). Registered agents on one daemon, mail driven through the API:
#   - plain thread: an agent's reply to the human's mail addressed to another agent leaves the
#     thread archived (as the human's new thread is on send) and doesn't move it up the list; a
#     reply addressed to the human brings the thread back
#   - ITSA thread: an agent's reply to the human's post addressed to another agent doesn't name
#     the human nor is unread for them (S-308 added them always); one addressed to the human does
#   - either way, a reply to the human's mail that doesn't name them tells its sender (misses_human)
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
trap stam_test_cleanup EXIT
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${4:+-H 'x-stam-human: 1'} "$STAM_URL$2" ${3:+-d "$3"}; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
fail() { echo "FAIL: $1"; exit 1; }
# send JSON: a mail; prints its id.
send() { api POST /api/mail "$1" human | jget "d['id']"; }
# misses JSON: sends a mail; prints whether its sender was told it doesn't reach the human.
misses() { api POST /api/mail "$1" human | jget "d.get('misses_human', False)"; }
# listed TID [archived]: whether the human's list (or archived list) holds the thread.
listed() { api GET "/api/agents/human/threads?limit=60${2:+&archived=1}" | jget "any(t['thread_id']=='$1' for t in d)"; }
# to_human MAIL THREAD: whether the human is a recipient of MAIL.
to_human() { api GET "/api/threads/$2" | jget "any(r['id']=='human' for m in d if m['id']=='$1' for r in m['recipients'])"; }
unread() { api GET "/api/agents/human/inbox?unread=1&limit=100" | jget "len(d)"; }

A=$(reg alpha); B=$(reg beta)

echo "-- plain thread: agents talking among themselves leave the human's thread archived and unread-free"
M=$(send "{\"from\":\"human\",\"to\":[\"$A\",\"$B\"],\"new_thread\":true,\"subject\":\"Plan\",\"body\":\"Work it out between you.\"}")
[ "$(listed "$M" archived)" = True ] || fail "the human's new thread wasn't archived on send"
R=$(send "{\"from\":\"$A\",\"to\":[\"$B\"],\"reply_to\":\"$M\",\"body\":\"alpha to beta\"}")
[ "$(to_human "$R" "$M")" = False ] || fail "alpha's mail to beta named the human"
[ "$(listed "$M")" = False ] || fail "alpha's mail to beta brought the human's archived thread back"

echo "-- plain thread: mail between agents doesn't move the thread up the human's list"
O=$(send "{\"from\":\"human\",\"to\":[\"$B\"],\"new_thread\":true,\"subject\":\"Other\",\"body\":\"later\"}")
api POST "/api/agents/human/threads/$M/unarchive" '{}' human >/dev/null
api POST "/api/agents/human/threads/$O/unarchive" '{}' human >/dev/null
send "{\"from\":\"$B\",\"to\":[\"$A\"],\"reply_to\":\"$M\",\"body\":\"beta to alpha\"}" >/dev/null
ORDER=$(api GET "/api/agents/human/threads?limit=60" | jget "' '.join(t['thread_id'] for t in d if t['thread_id'] in ('$M','$O'))")
[ "$ORDER" = "$O $M" ] || fail "beta's mail to alpha moved the thread up the human's list ($ORDER, want $O $M)"
[ "$(misses "{\"from\":\"$B\",\"to\":[\"$A\"],\"reply_to\":\"$M\",\"body\":\"beta again\"}")" = True ] || fail "beta wasn't told its reply to the human's mail doesn't reach them"
api POST "/api/agents/human/threads/$M/archive" '{}' human >/dev/null

echo "-- plain thread: a reply addressed to the human brings it back"
R=$(send "{\"from\":\"$A\",\"to\":[\"human\"],\"reply_to\":\"$M\",\"body\":\"done\"}")
[ "$(to_human "$R" "$M")" = True ] || fail "alpha's reply to the human didn't name the human"
[ "$(listed "$M")" = True ] || fail "alpha's reply to the human didn't bring the thread back"

echo "-- ITSA thread: a reply to the human's post names the human only when addressed to them"
KEY=$("$STAM" itsa new "Quiet thread" --owner alpha --participant beta | awk '{print $1}')
P=$(api POST "/api/itsas/$KEY/post" '{"by":"human","body":"over to you"}' human | jget "d['id']")
TID=$(api GET "/api/itsas/$KEY" | jget "d['thread_id']")
U=$(unread)
R=$(send "{\"from\":\"$A\",\"to\":[\"$B\"],\"reply_to\":\"$P\",\"body\":\"alpha to beta in the ITSA\"}")
[ "$(to_human "$R" "$TID")" = False ] || fail "alpha's reply to the human's post, to beta, named the human"
[ "$(unread)" = "$U" ] || fail "alpha's reply to the human's post, to beta, is unread for the human"
[ "$(misses "{\"from\":\"$A\",\"to\":[\"$B\"],\"reply_to\":\"$P\",\"body\":\"again\"}")" = True ] || fail "alpha wasn't told its ITSA reply doesn't reach the human"
[ "$(misses "{\"from\":\"$A\",\"to\":[\"human\"],\"reply_to\":\"$P\",\"body\":\"to you\"}")" = False ] || fail "alpha's reply that names the human was flagged"
R=$(send "{\"from\":\"$A\",\"to\":[\"human\"],\"reply_to\":\"$P\",\"body\":\"alpha to the human in the ITSA\"}")
[ "$(to_human "$R" "$TID")" = True ] || fail "alpha's reply to the human's post, to the human, didn't name them"

echo "PASS: mail between agents in the human's threads stays out of the human's inbox"
