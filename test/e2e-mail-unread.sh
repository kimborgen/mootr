#!/bin/sh
# Mark unread (S-2246): POST /api/agents/human/threads/ID/unread turns the human's copies of the
# named mail unread again, and the read route turns them read. The ids name the mail; a mail already
# unread, or one the thread doesn't hold, marks nothing, and an empty list is refused with 400. Only
# the human marks mail unread: a request without the human's header, another mailbox, and an agent's
# own token each get 403, and leave the mail as it was. One daemon; one fake agent, which costs nothing.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
echo '{"agents":{}}' >"$TEST_TMP/mail-unread.json"
fake_claude "$TEST_TMP/mail-unread.json"
isolate
T=$(date +%s)
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }

get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
# The status of a POST as the human.
hpost() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]??""))' "$1"; }
# A mail as an agent (no human flag); prints the response body.
agentsend() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }
# How many of the human's copies of a thread's mail are unread.
unread() { get "/api/threads/$1" | python3 -c 'import json,sys; print(sum(1 for m in json.load(sys.stdin) for r in m["recipients"] if r["id"] == "human" and not r["read_at"]))'; }

post /api/test/mail '{"action":"agent","id":"un-test","name":"Unread Helper"}' >/dev/null
TID=$(agentsend /api/mail "{\"from\":\"un-test\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Unread check $T\",\"body\":\"one\"}" | field id)
[ "$(unread "$TID")" = 1 ] || fail "a new mail to the human isn't unread"

# Reading it, then marking it unread again: the human's copy goes back to unread.
post /api/agents/human/read "{\"ids\":[\"$TID\"]}" >/dev/null
[ "$(unread "$TID")" = 0 ] || fail "reading didn't mark the mail read"
post "/api/agents/human/threads/$TID/unread" "{\"ids\":[\"$TID\"]}" | grep -q "\"$TID\"" || fail "marking unread didn't name the mail it marked"
[ "$(unread "$TID")" = 1 ] || fail "marking unread didn't leave the mail unread"
get "/api/threads/$TID" | grep -q "Unread check $T" || fail "marking unread deleted the mail"

# A mail already unread marks nothing, and an id the thread doesn't hold marks nothing.
post "/api/agents/human/threads/$TID/unread" "{\"ids\":[\"$TID\"]}" | grep -q "\"$TID\"" && fail "a mail already unread was marked again"
post "/api/agents/human/threads/$TID/unread" '{"ids":["no-such-mail"]}' | grep -q "no-such-mail" && fail "an id the thread doesn't hold was marked"
[ "$(unread "$TID")" = 1 ] || fail "a no-op changed the read state"

# An empty list is refused, and the mail stays as it was.
[ "$(hpost "/api/agents/human/threads/$TID/unread" '{"ids":[]}')" = 400 ] || fail "an empty ids list wasn't refused with 400"
[ "$(unread "$TID")" = 1 ] || fail "a refused request changed the read state"

# Only the human marks mail unread. The owner's token without x-stam-human is refused, another mailbox
# is refused with the human's header, and an agent's own token is refused even with the header.
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"ids\":[\"$TID\"]}" "$STAM_URL/api/agents/human/threads/$TID/unread")" = 403 ] || fail "a write without x-stam-human wasn't refused with 403"
[ "$(unread "$TID")" = 1 ] || fail "a refused write without x-stam-human changed the read state"
post /api/test/mail '{"action":"agent","id":"un-other","name":"Other Helper"}' >/dev/null
[ "$(hpost "/api/agents/un-other/threads/$TID/unread" "{\"ids\":[\"$TID\"]}")" = 403 ] || fail "another mailbox wasn't refused with 403"
[ "$(unread "$TID")" = 1 ] || fail "a refused request on another mailbox changed the read state"
SPAWN=$(curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "{\"name\":\"un-agent\",\"harness\":\"claude\",\"model\":\"claude-sonnet-5-5\",\"cwd\":\"$TEST_TMP\",\"role\":\"test\"}" "$STAM_URL/api/agents" | field id)
AGENT_TOKEN=$(agent_token "$SPAWN")
[ -n "$AGENT_TOKEN" ] || fail "the agent has no token to try"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $AGENT_TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "{\"ids\":[\"$TID\"]}" "$STAM_URL/api/agents/human/threads/$TID/unread")" = 403 ] || fail "an agent's token with x-stam-human wasn't refused with 403"
[ "$(unread "$TID")" = 1 ] || fail "a refused agent request changed the read state"

# The read route reads it again, so the unread state round-trips.
post /api/agents/human/read "{\"ids\":[\"$TID\"]}" >/dev/null
[ "$(unread "$TID")" = 0 ] || fail "reading after marking unread didn't mark the mail read"
echo "mail-unread: ok"
