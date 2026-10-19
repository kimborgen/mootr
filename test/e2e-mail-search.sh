#!/bin/sh
# Mail search, free (no model): a developer finds its manager's thread with the human by keyword,
# through the search_mail and read_thread MCP tools, and can't find another agent's mail or the
# thread that agent has with the human. Its reply_to lands in the manager's thread. Runs on its
# own throwaway daemon (test/lib.sh); the fake Claude Code (test/fake-claude) runs the developer's
# turn, so no model runs and nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
cat >"$TEST_TMP/mail-search.json" <<'EOJ'
{ "agents": { "dev": { "turns": [
  { "match": "search for the redirect thread", "steps": [
    { "mcp": "search_mail", "expect": "Login redirect loop", "save": { "thread": "(\\S+) · Login redirect loop" },
      "args": { "query": "redirect" } },
    { "mcp": "search_mail", "expect": "No mail matches", "args": { "query": "invoice" } },
    { "mcp": "read_thread", "expect": "login redirect loop comes back", "args": { "thread_id": "${thread}" } },
    { "reply": "${result}" } ] } ] } } }
EOJ
fake_claude "$TEST_TMP/mail-search.json"
isolate
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
# agent METHOD PATH [JSON] as an agent's own call; field PATH reads a JSON field from stdin.
agent() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
spawn() { agent POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"$3\",\"cwd\":\"$DIR\",\"role\":\"test\"$2}" | field id; }

# The manager and the other agent use a model that may mail the human; haiku may not by default.
PM=$(spawn pm "" claude-sonnet-5-5)
OTHER=$(spawn other "" claude-sonnet-5-5)
[ -n "$PM" ] && [ -n "$OTHER" ] || fail "spawn pm/other: $PM $OTHER"

# The manager's thread with the human about the redirect loop, and the other agent's mail that
# shares no ancestor with the developer: one thread with the human, one agent-to-manager thread.
MAIL_RAW=$(as_agent "$PM" POST /api/mail "{\"from\":\"$PM\",\"to\":[\"human\"],\"subject\":\"Login redirect loop\",\"body\":\"the login redirect loop comes back after logout\",\"new_thread\":true}")
MAIL_PM=$(echo "$MAIL_RAW" | field id)
THREAD=$MAIL_PM
[ -n "$THREAD" ] || fail "the manager's mail to the human wasn't sent: $MAIL_RAW"
as_agent "$OTHER" POST /api/mail "{\"from\":\"$OTHER\",\"to\":[\"human\"],\"subject\":\"Invoice run\",\"body\":\"invoice reconciliation for September\",\"new_thread\":true}" >/dev/null
as_agent "$OTHER" POST /api/mail "{\"from\":\"$OTHER\",\"to\":[\"$PM\"],\"subject\":\"Invoice cleanup\",\"body\":\"invoice notes for the manager\",\"new_thread\":true}" >/dev/null

# The developer, under the manager, searches and reads through MCP.
"$STAM" spawn dev --parent pm --model claude-haiku-5-5 --cwd "$DIR" "search for the redirect thread, then read it" >/dev/null
"$STAM" wait dev --until idle --timeout 60
for tool in search_mail read_thread; do
  "$STAM" events dev | grep -q "mcp__stam__$tool" || fail "the developer never called $tool"
done

# Over HTTP as the developer: its ancestor's thread comes back, and the other agent's mail doesn't.
DEV=$(agent GET /api/agents/dev | field id)
agent GET "/api/mail/search?box=$DEV&q=redirect" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);if(h.length!==1||h[0].thread_id!=="'"$THREAD"'")process.exit(1)})' ||
  fail "the developer's search for redirect didn't return its manager's thread alone"
[ "$(agent GET "/api/mail/search?box=$DEV&q=invoice" | field length)" = 0 ] || fail "the developer found the other agent's invoice mail"
# The other agent can't read the manager's thread, and the developer's read is the whole thread.
[ "$(agent GET "/api/threads/$THREAD?box=$OTHER" | field length)" = 0 ] || fail "the other agent read the manager's thread"
[ "$(agent GET "/api/threads/$THREAD?box=$DEV" | field length)" -ge 1 ] || fail "the developer can't read the manager's thread"

# A reply from the developer with reply_to lands in the manager's thread.
REPLY=$(as_agent "$DEV" POST /api/mail "{\"from\":\"$DEV\",\"to\":[\"$PM\"],\"body\":\"the redirect loop is in the session cookie\",\"reply_to\":\"$MAIL_PM\"}")
[ "$(echo "$REPLY" | field thread_id)" = "$THREAD" ] || fail "the developer's reply_to didn't land in the manager's thread: $REPLY"

"$STAM" kill dev >/dev/null
"$STAM" wait dev --until shut_down --timeout 20
"$STAM" forget dev >/dev/null
echo "PASS e2e-mail-search"
