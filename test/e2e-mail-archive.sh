#!/bin/sh
# Mail archive end to end: archiving hides a thread from a mailbox's list without deleting
# it, unarchiving brings it back, `archived=1` lists what archive hides, and a new message
# in an archived thread returns it. The decision is over message ids, not clocks; a pending
# permission request keeps its thread in the inbox; the limit is applied after the filter;
# only a mailbox's owner (or the human) may archive it. One daemon, no running agents, so it
# is free.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
T=$(date +%s)
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }

get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
# The status of a POST, with the human flag and without it.
hpost() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
agentpost() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }
# One thread id per line, from a list on stdin, and its length.
tids() { python3 -c 'import json,sys; [print(t["thread_id"]) for t in json.load(sys.stdin)]'; }
count() { python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
has() { tids | grep -qx "$1"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]??""))' "$1"; }
# Test-only routes: shape the mail the API can't (a fixed timestamp, a forced archive, a shut-down mailbox).
test_agent() { post /api/test/mail "{\"action\":\"agent\",\"id\":\"$1\",\"name\":\"$2\"}" >/dev/null; }
set_time() { post /api/test/mail "{\"action\":\"set-time\",\"mail\":\"$1\",\"at\":\"$2\"}" >/dev/null; }
force_archive() { post /api/test/mail "{\"action\":\"archive\",\"mailbox\":\"$1\",\"thread\":\"$2\"}" >/dev/null; }
# A mail as the human; prints the new mail's id.
send() { post /api/mail "$1" | field id; }
# A mail as an agent (no human flag); prints the response body.
agentsend() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }

# It is listed, and archiving hides it without deleting its mail.
TID=$(send "{\"from\":\"human\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Archive check $T\",\"body\":\"first\"}")
# A new thread from the human is archived on send; bring it back to test archive by hand.
post "/api/agents/human/threads/$TID/unarchive" '{}' >/dev/null
get "/api/agents/human/threads?limit=60" | has "$TID" || fail "the thread is not in the list"
post "/api/agents/human/threads/$TID/archive" '{}' >/dev/null
get "/api/agents/human/threads?limit=60" | has "$TID" && fail "archiving didn't hide the thread"
get "/api/agents/human/threads?limit=60&archived=1" | has "$TID" || fail "the archived list doesn't show the thread"
get "/api/threads/$TID" | grep -q "Archive check $T" || fail "archiving deleted the mail"

# Unarchiving brings it back to the list and out of the archived list.
post "/api/agents/human/threads/$TID/unarchive" '{}' >/dev/null
get "/api/agents/human/threads?limit=60" | has "$TID" || fail "unarchiving didn't bring the thread back"
get "/api/agents/human/threads?limit=60&archived=1" | has "$TID" && fail "the archived list still shows the unarchived thread"

# The agent the replies below come from (it has no running harness, so it is only a row).
test_agent pa-test "Permission Helper"

# The decision is over ids, not clocks: an agent's reply returns the thread even with a timestamp
# equal to the archived one, and a reply with an older timestamp returns it too. The agent is a
# recipient, so it may reply (S-466).
C="Clock check $T"
M1=$(send "{\"from\":\"human\",\"to\":[\"human\",\"pa-test\"],\"new_thread\":true,\"subject\":\"$C\",\"body\":\"one\"}")
CTID=$M1
post "/api/agents/human/threads/$CTID/archive" '{}' >/dev/null
M2=$(agentsend /api/mail "{\"from\":\"pa-test\",\"to\":[\"human\"],\"reply_to\":\"$M1\",\"body\":\"two\"}" | field id)
set_time "$M2" "$(get "/api/threads/$CTID" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["created_at"])')"
get "/api/agents/human/threads?limit=60" | has "$CTID" || fail "a reply with an equal timestamp didn't un-archive the thread"
force_archive human "$CTID"
get "/api/agents/human/threads?limit=60" | has "$CTID" && fail "the thread stayed listed after re-archiving"
M3=$(agentsend /api/mail "{\"from\":\"pa-test\",\"to\":[\"human\"],\"reply_to\":\"$M1\",\"body\":\"three\"}" | field id)
set_time "$M3" "2000-01-01T00:00:00.000Z"
get "/api/agents/human/threads?limit=60" | has "$CTID" || fail "a reply older than the archive time didn't un-archive the thread"
get "/api/agents/human/threads?limit=60&archived=1" | has "$CTID" && fail "the thread is still archived after a new message"

# A pending permission request keeps its thread in the inbox, and its thread can't be archived.
post /api/permissions "{\"agent\":\"pa-test\",\"action\":\"Run the archive check\",\"reason\":\"because\",\"details\":\"none\",\"audience\":\"human\"}" >/dev/null
PTID=$(get "/api/agents/human/threads?limit=60" | python3 -c "import json,sys; print([t['thread_id'] for t in json.load(sys.stdin) if t['mails'][0]['subject'].startswith('Permission: ')][0])")
[ "$(hpost "/api/agents/human/threads/$PTID/archive" '{}')" = 409 ] || fail "archiving a pending permission thread wasn't refused with 409"
force_archive human "$PTID"
get "/api/agents/human/threads?limit=60" | has "$PTID" || fail "a pending permission thread was hidden by archive"
get "/api/agents/human/threads?limit=60&archived=1" | has "$PTID" && fail "a pending permission thread appeared in the archived list"

# The limit is applied after the archive filter: the newest three of six are archived, and
# a page of three still returns three active threads (and three archived).
for n in 1 2 3 4 5 6; do send "{\"from\":\"human\",\"to\":[\"pa-test\"],\"new_thread\":true,\"subject\":\"Limit $T-$n\",\"body\":\"x\"}" >/dev/null; done
for tid in $(get "/api/agents/pa-test/threads?limit=60" | tids | head -3); do post "/api/agents/pa-test/threads/$tid/archive" '{}' >/dev/null; done
[ "$(get '/api/agents/pa-test/threads?limit=3' | count)" = 3 ] || fail "the inbox returned fewer than limit active threads"
[ "$(get '/api/agents/pa-test/threads?limit=3&archived=1' | count)" = 3 ] || fail "the archived list returned fewer than limit archived threads"

# Who may archive: the human for the human mailbox; an agent for its own mailbox; nobody
# else for the human mailbox.
[ "$(agentpost "/api/agents/human/threads/$TID/archive" '{}')" = 403 ] || fail "a non-human archive of the human mailbox wasn't refused"
[ "$(agentpost "/api/agents/human/threads/$TID/unarchive" '{}')" = 403 ] || fail "a non-human unarchive of the human mailbox wasn't refused"
PT1=$(get "/api/agents/pa-test/threads?limit=60&archived=1" | tids | head -1)
[ "$(agentpost "/api/agents/pa-test/threads/$PT1/unarchive" "{\"by\":\"pa-test\"}")" = 200 ] || fail "an agent couldn't unarchive its own mailbox"

# A new thread the human starts is archived for the human on send, and the first reply from
# the agent brings it back to the inbox.
NTID=$(post /api/mail "{\"from\":\"human\",\"to\":[\"pa-test\"],\"new_thread\":true,\"subject\":\"Awaiting $T\",\"body\":\"ask\"}" | field thread_id)
NMID=$(get "/api/threads/$NTID" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
get "/api/agents/human/threads?limit=60" | has "$NTID" && fail "a new thread from the human was not archived on send"
get "/api/agents/human/threads?limit=60&archived=1" | has "$NTID" || fail "the new thread isn't in the archived list"
[ "$(agentpost /api/mail "{\"from\":\"pa-test\",\"to\":[\"human\"],\"reply_to\":\"$NMID\",\"body\":\"answer\"}")" = 200 ] || fail "the agent's reply wasn't sent"
get "/api/agents/human/threads?limit=60" | has "$NTID" || fail "the agent's reply didn't bring the thread back to the inbox"

# The human's own follow-up in a thread it archived stays archived: only someone else's message
# brings the thread back.
FTID=$(post /api/mail "{\"from\":\"human\",\"to\":[\"pa-test\"],\"new_thread\":true,\"subject\":\"Follow-up $T\",\"body\":\"ask\"}" | field thread_id)
FMID=$(get "/api/threads/$FTID" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
post /api/mail "{\"from\":\"human\",\"to\":[\"pa-test\"],\"reply_to\":\"$FMID\",\"body\":\"again\"}" >/dev/null
get "/api/agents/human/threads?limit=60" | has "$FTID" && fail "the human's follow-up brought its archived thread back"
get "/api/agents/human/threads?limit=60&archived=1" | has "$FTID" || fail "the human's follow-up left the thread out of the archived list"

# `with=ID` (S-1121) keeps the threads that agent sent or received, in every box, and combines
# with archived=1 and the limit. Threads with other agents stay out.
test_agent pw-other "With Other"
OTID=$(post /api/mail "{\"from\":\"human\",\"to\":[\"pw-other\"],\"new_thread\":true,\"subject\":\"With other $T\",\"body\":\"x\"}" | field thread_id)
get "/api/agents/human/threads?limit=60&with=pa-test" | has "$NTID" || fail "with= left out the agent's inbox thread"
get "/api/agents/human/threads?limit=60&with=pa-test" | has "$OTID" && fail "with= listed another agent's thread"
get "/api/agents/human/threads?limit=60&with=pa-test&archived=1" | has "$FTID" || fail "with= and archived=1 left out the agent's archived thread"
get "/api/agents/human/threads?limit=60&with=pa-test&archived=1" | has "$OTID" && fail "with= and archived=1 listed another agent's thread"
[ "$(get '/api/agents/human/threads?limit=60&with=pw-other&archived=1' | count)" = 1 ] || fail "with=pw-other&archived=1 isn't its one thread"
[ "$(get '/api/agents/human/threads?limit=60&with=pw-other' | count)" = 0 ] || fail "with=pw-other lists archived threads in the inbox"
[ "$(get '/api/agents/human/threads?limit=1&with=pa-test&archived=1' | count)" = 1 ] || fail "with= ignores the limit"
[ "$(get '/api/agents/human/threads?limit=60&with=nobody' | count)" = 0 ] || fail "with= an unknown agent lists threads"

echo "PASS e2e-mail-archive"
