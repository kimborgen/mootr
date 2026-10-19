#!/bin/sh
# Cited mail, free (no model) (S-448): a developer reads mail ids cited in its brief through
# read_thread: a later mail in its manager's thread with the human (not the thread's first mail),
# and a comment in the thread of an ITSA its manager owns, which the developer never received.
# read_mail on a cited id that isn't addressed to it points at read_thread. An agent outside both
# reads none of it, and can't reply into the manager's thread, even naming its own ITSA (S-466). Runs on its
# own throwaway daemon (test/lib.sh); the fake Claude Code (test/fake-claude) runs the developer's
# turn, so no model runs and nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
cat >"$TEST_TMP/mail-read-cited.json" <<'EOJ'
{ "agents": { "dev": { "turns": [
  { "match": "/read (m[0-9a-f]+) and (m[0-9a-f]+)/", "steps": [
    { "mcp": "read_mail", "expect": "Not addressed to you: ${1}", "args": { "ids": ["${1}"] } },
    { "mcp": "read_thread", "expect": "the cache key is per tenant", "args": { "thread_id": "${1}" } },
    { "mcp": "read_thread", "expect": "design: keep the queue per machine", "args": { "thread_id": "${2}" } },
    { "reply": "${result}" } ] } ] } } }
EOJ
fake_claude "$TEST_TMP/mail-read-cited.json"
isolate
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
# agent METHOD PATH [JSON] as an agent's own call; field PATH reads a JSON field from stdin.
agent() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
spawn() { agent POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"claude-sonnet-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\"}" | field id; }

PM=$(spawn pm)
QA=$(spawn qa)
OTHER=$(spawn other)
[ -n "$PM" ] && [ -n "$QA" ] && [ -n "$OTHER" ] || fail "spawn pm/qa/other: $PM $QA $OTHER"

# The manager's thread with the human; the cited mail is its second, so its id isn't the thread id.
ROOT=$(as_agent "$PM" POST /api/mail "{\"from\":\"$PM\",\"to\":[\"human\"],\"subject\":\"Cache plan\",\"body\":\"which cache key?\",\"new_thread\":true}" | field id)
CITED=$(as_agent "$PM" POST /api/mail "{\"from\":\"$PM\",\"to\":[\"human\"],\"body\":\"the cache key is per tenant\",\"reply_to\":\"$ROOT\"}" | field id)
[ -n "$ROOT" ] && [ -n "$CITED" ] && [ "$CITED" != "$ROOT" ] || fail "the manager's mails weren't sent: $ROOT $CITED"

# An ITSA the manager owns; qa's comment goes to the manager, not the developer.
KEY=$("$STAM" itsa new "Queue design" --owner pm --participant qa | awk '{print $1}')
STAM_AGENT_ID="$QA" STAM_TOKEN="$(agent_token "$QA")" "$STAM" itsa post "$KEY" "design: keep the queue per machine" >/dev/null || fail "qa's comment failed"
TID=$(agent GET "/api/itsas/$KEY" | field thread_id)
COMMENT=$(agent GET "/api/threads/$TID" | field 0.id)
[ -n "$COMMENT" ] || fail "no comment in $KEY's thread"

"$STAM" spawn dev --parent pm --model claude-haiku-5-5 --cwd "$DIR" "read $CITED and $COMMENT, cited in your brief" >/dev/null
"$STAM" wait dev --until idle --timeout 60
"$STAM" events dev | grep -q "mcp__stam__read_thread" || fail "the developer never called read_thread"
DEV=$(agent GET /api/agents/dev | field id)

# Over HTTP: the developer reads both whole threads by the cited ids; the other agent reads neither.
[ "$(agent GET "/api/threads/$CITED?box=$DEV" | field length)" = 2 ] || fail "the developer can't read the manager's thread by a cited later mail"
[ "$(agent GET "/api/threads/$COMMENT?box=$DEV" | field length)" = 1 ] || fail "the developer can't read the ITSA comment its manager received"
[ "$(agent GET "/api/threads/$CITED?box=$OTHER" | field length)" = 0 ] || fail "the other agent read the manager's thread"
[ "$(agent GET "/api/threads/$COMMENT?box=$OTHER" | field length)" = 0 ] || fail "the other agent read the ITSA's thread"
# The same for a cited mail's thread id and subject (S-388), which threadOfMail asks peers for.
[ "$(agent GET "/api/mail/$CITED/thread?box=$DEV" | field 0.thread_id)" = "$ROOT" ] || fail "the developer can't resolve a cited mail's thread"
[ "$(agent GET "/api/mail/$COMMENT/thread?box=$DEV" | field 0.thread_id)" = "$TID" ] || fail "the developer can't resolve the ITSA comment's thread"
[ "$(agent GET "/api/mail/$CITED/thread?box=$OTHER" | field length)" = 0 ] || fail "the other agent resolved the manager's thread"
[ "$(agent GET "/api/mail/$COMMENT/thread?box=$OTHER" | field length)" = 0 ] || fail "the other agent resolved the ITSA's thread"

# The other agent can't reply into the manager's thread, even naming its own ITSA (S-466): a reply
# needs a mail its sender may read, as on a peer (S-400). So the thread stays closed to it.
KEY2=$("$STAM" itsa new "Other work" --owner other | awk '{print $1}')
INTO=$(as_agent "$OTHER" POST /api/mail "{\"from\":\"$OTHER\",\"to\":[\"$PM\"],\"body\":\"about my own work\",\"reply_to\":\"$CITED\",\"itsa\":\"$KEY2\"}")
echo "$INTO" | grep -q "mail $CITED isn't visible to you (you aren't in its thread)" || fail "the other agent's reply into the manager's thread wasn't refused: $INTO"
SEEN=$(agent GET "/api/threads/$CITED?box=$OTHER")
[ "$(echo "$SEEN" | field length)" = 0 ] || fail "the other agent reads the manager's thread after its refused reply: $SEEN"
# The manager's own mail in its thread about the other agent's ITSA (the about_itsa chip) doesn't
# open that thread to the other agent: only an ITSA's own thread counts (S-448).
ABOUT=$(as_agent "$PM" POST /api/mail "{\"from\":\"$PM\",\"to\":[\"human\"],\"body\":\"this touches other work\",\"reply_to\":\"$CITED\",\"itsa\":\"$KEY2\"}")
[ "$(echo "$ABOUT" | field thread_id)" = "$ROOT" ] || fail "the manager's mail about the other ITSA didn't land in its thread: $ABOUT"
[ -n "$(echo "$ABOUT" | field about_itsa)" ] || fail "the manager's mail carries no about_itsa: $ABOUT"
SEEN=$(agent GET "/api/threads/$CITED?box=$OTHER")
[ "$(echo "$SEEN" | field length)" = 0 ] || fail "a mail about the other agent's ITSA let it read the manager's thread: $SEEN"

# A thread between the manager and qa, none of the new agents', cited in a reviewer's brief (S-1107):
# the spawner may read it, so the reviewer reads it whole and can reply in it. A thread the spawner
# can't read opens nothing, and an agent given no id still reads none of it.
PQ=$(as_agent "$PM" POST /api/mail "{\"from\":\"$PM\",\"to\":[\"$QA\"],\"subject\":\"Re-review\",\"body\":\"re-review of PR 350\",\"new_thread\":true}" | field id)
PQ2=$(as_agent "$QA" POST /api/mail "{\"from\":\"$QA\",\"to\":[\"$PM\"],\"body\":\"found two issues\",\"reply_to\":\"$PQ\"}" | field id)
HIDDEN=$(as_agent "$OTHER" POST /api/mail "{\"from\":\"$OTHER\",\"to\":[\"$QA\"],\"subject\":\"Private\",\"body\":\"not for pm\",\"new_thread\":true}" | field id)
[ -n "$PQ" ] && [ -n "$PQ2" ] && [ -n "$HIDDEN" ] || fail "thread mails weren't sent: $PQ $PQ2 $HIDDEN"
"$STAM" spawn rev --parent pm --model claude-haiku-5-5 --cwd "$DIR" "review the work; brief thread $PQ, also $HIDDEN" >/dev/null
REV=$(agent GET /api/agents/rev | field id)
[ "$(agent GET "/api/threads/$PQ?box=$REV" | field length)" = 2 ] || fail "the reviewer can't read the thread cited in its brief"
# qa answers the manager in the private thread: the manager now holds one mail of it, not the thread.
HID2=$(as_agent "$QA" POST /api/mail "{\"from\":\"$QA\",\"to\":[\"$PM\"],\"body\":\"fyi\",\"reply_to\":\"$HIDDEN\"}" | field id)
[ -n "$HID2" ] || fail "qa's reply in the private thread wasn't sent"
"$STAM" spawn rev2 --parent pm --model claude-haiku-5-5 --cwd "$DIR" "see $HID2" >/dev/null
REV2=$(agent GET /api/agents/rev2 | field id)
[ "$(agent GET "/api/threads/$HIDDEN?box=$PM" | field length)" = 1 ] || fail "the manager reads more than its own mail of the private thread"
[ "$(agent GET "/api/threads/$HIDDEN?box=$REV2" | field length)" = 0 ] || fail "a spawn citing one mail opened the whole thread"
"$STAM" kill rev2 >/dev/null
"$STAM" wait rev2 --until shut_down --timeout 20
"$STAM" forget rev2 >/dev/null
[ "$(agent GET "/api/threads/$HIDDEN?box=$REV" | field length)" = 0 ] || fail "the reviewer read a thread its spawner can't read"
[ "$(agent GET "/api/threads/$PQ?box=$OTHER" | field length)" = 0 ] || fail "an agent given no id read the cited thread"
REPLY=$(as_agent "$REV" POST /api/mail "{\"from\":\"$REV\",\"to\":[\"$PM\"],\"body\":\"verdict\",\"reply_to\":\"$PQ2\"}")
[ "$(echo "$REPLY" | field thread_id)" = "$PQ" ] || fail "the reviewer's reply didn't join the cited thread: $REPLY"
"$STAM" kill rev >/dev/null
"$STAM" wait rev --until shut_down --timeout 20
"$STAM" forget rev >/dev/null

"$STAM" kill dev >/dev/null
"$STAM" wait dev --until shut_down --timeout 20
"$STAM" forget dev >/dev/null
echo "PASS e2e-mail-read-cited"
