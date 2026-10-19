#!/bin/sh
# S-352 end to end, free (no models): an agent's mail to the human with a decision block waits on
# the human (GET /api/mail/decisions) until they reply in its thread. One isolated daemon; agents
# are registered, not spawned. Checks:
#   - an agent's mail with a decision block is listed; a mail with no block is not
#   - a stam mail (its subject starts with `[stam]`) with a block is not listed
#   - a from_stam mail, sent with the peer token as a peer's own daemon sends it, with a block is not listed
#   - an ITSA's ask mail is never listed, while the ITSA is open or after it closes
#   - a plain decision mail about an ITSA in a human status is left out, and listed once it leaves
#   - the human's reply in the mail's thread clears it
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
# The ids of the decision mails listed now.
listed() { api GET /api/mail/decisions | jget "[x['mail_id'] for x in d]"; }
has() { listed | grep -q "'$1'"; }
# A decision block, as a JSON string: BT is a backtick, so the fence stays out of shell quoting.
BT='`'
FENCE="${BT}${BT}${BT}"
ALICE=$(register alice)
PICK="{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Pick one\",\"body\":\"Which one?\n\n${FENCE}pick\nship\nhold\n${FENCE}\"}"

echo "-- an agent's decision mail is listed; a plain mail is not"
PLAIN=$(api POST /api/mail '{"from":"alice","to":["human"],"subject":"Status","body":"All done, nothing to decide."}' | jget "d['id']")
M1=$(api POST /api/mail "$PICK" | jget "d['id']")
has "$M1" || fail "the decision mail isn't listed"
has "$PLAIN" && fail "a mail with no decision block is listed"

echo "-- a stam-subject mail with a block is not listed (from_stam is set only by stam, so it can't be sent over HTTP)"
S=$(api POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"[stam] Pick\",\"body\":\"${FENCE}yesno\nok?\n${FENCE}\"}" | jget "d['id']")
has "$S" && fail "a stam mail is listed"

echo "-- a from_stam mail (sent as a peer's own daemon does, S-2033) with a block is not listed"
PEER_TOKEN=$(cat "$STAM_HOME/peer-token")
F=$(curl -sf -X POST -H "authorization: Bearer $PEER_TOKEN" -H 'x-stam-local: 1' -H 'content-type: application/json' -d "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Pick\",\"body\":\"${FENCE}yesno\nok?\n${FENCE}\",\"from_stam\":true}" "$STAM_URL/api/mail" | jget "d['id']")
has "$F" && fail "a from_stam mail is listed"

echo "-- an ITSA's ask is never listed: the ITSA row covers it, and it is over once the ITSA closes"
KEY=$("$STAM" itsa new "Decision mail e2e" --owner alice --status in_progress | awk '{print $1}')
# The owner's comment carries a decision block, which the ask repeats.
api POST "/api/itsas/$KEY/post" "{\"by\":\"$ALICE\",\"body\":\"Pick:\n\n${FENCE}pick\nship\nhold\n${FENCE}\"}" >/dev/null
api PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$ALICE\"}" >/dev/null
api GET "/api/itsas/$KEY/thread" >"$TEST_TMP/t.json"
ASK_ID=$(jget "[i['mail'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]['id']" <"$TEST_TMP/t.json")
[ -n "$ASK_ID" ] || fail "no ask mail"
# The ask must carry the block, or the check below proves nothing.
ASK_BODY=$(jget "[i['mail']['body'] for i in d['items'] if i['type']=='mail' and i['mail']['kind']=='ask'][0]" <"$TEST_TMP/t.json")
printf '%s' "$ASK_BODY" | grep -q "${FENCE}pick" || fail "the ask doesn't repeat the decision block"
has "$ASK_ID" && fail "an ITSA's ask is listed"

echo "-- a plain decision mail about an ITSA in a human status is left out, and listed once it leaves"
ITSA_MAIL=$(api POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"About $KEY\",\"body\":\"Pick:\n\n${FENCE}question\nyes?\n${FENCE}\",\"itsa\":\"$KEY\"}" | jget "d['id']")
has "$ITSA_MAIL" && fail "a decision mail about a waiting ITSA is listed"
api PATCH "/api/itsas/$KEY" "{\"status\":\"in_progress\",\"by\":\"$ALICE\"}" >/dev/null
has "$ITSA_MAIL" || fail "the decision mail isn't listed once its ITSA leaves the human status"
has "$ASK_ID" && fail "the ask is listed once its ITSA leaves the human status"
api PATCH "/api/itsas/$KEY" "{\"status\":\"done\",\"by\":\"$ALICE\"}" >/dev/null
has "$ASK_ID" && fail "an ask is listed after its ITSA closes"

echo "-- the human's reply in the thread clears the decision mail"
REPLY=$(human "{\"from\":\"human\",\"to\":[\"alice\"],\"subject\":\"Re: Pick one\",\"body\":\"ship\",\"reply_to\":\"$M1\"}" | jget "d['id']")
has "$M1" && fail "the decision mail is still listed after the human's reply"
[ -n "$REPLY" ] || fail "the human's reply wasn't sent"

echo "ok: decision-mail"
