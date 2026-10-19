#!/bin/sh
# Search by meaning, free (no model): mail is indexed as it's sent, and a query worded differently
# from the subject (sharing stems with the body only) finds its thread first, ranked by meaning. With
# search.embedder 'off' (and no stub), the same daemon falls back to keyword search. Runs on
# throwaway daemons (test/lib.sh), which use the stub embedder (STAM_EMBEDDER=stub) unless a test
# unsets it. The fake Claude Code runs no turns, so no model runs.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/idle.json" <<'EOJ'
{ "agents": {} }
EOJ
fake_claude "$TEST_TMP/idle.json"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
# agent METHOD PATH [JSON] as the daemon's own human-side caller; field PATH reads a JSON field from stdin.
agent() { curl -s -X "$1" -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
# An agent is spawned without starting a model: the fake Claude Code above runs nothing.
spawn() { agent POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"claude-sonnet-5-5\",\"cwd\":\"$TEST_TMP\",\"role\":\"test\"}" | field id; }
indexed() { "$STAM" embedder status | grep -q "indexed: mail: $1\$"; }

PM=$(spawn pm)
[ -n "$PM" ] || fail "spawn pm"
# Two mails to the human, sent after the daemon started: each is queued for indexing on send.
as_agent "$PM" POST /api/mail "{\"from\":\"$PM\",\"to\":[\"human\"],\"subject\":\"Sign-in bounce\",\"body\":\"users keep getting redirected back to the sign-in page after logout\",\"new_thread\":true}" >/dev/null
as_agent "$PM" POST /api/mail "{\"from\":\"$PM\",\"to\":[\"human\"],\"subject\":\"Quarterly invoice\",\"body\":\"invoice reconciliation for September\",\"new_thread\":true}" >/dev/null
# Wait on the index's state, not on time: both mails are rows of the mail source.
wait_until indexed 2
"$STAM" embedder status | grep -q '^state: stub$' || fail "the stub embedder isn't the one in use"

# By meaning: the query shares stems with the body only, so no keyword matches it. The sign-in thread comes first.
HITS=$(agent GET "/api/mail/search?box=$PM&q=keeps%20redirecting%20users")
echo "$HITS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);if(!h.length||h[0].subject!=="Sign-in bounce"||h[0].by!=="meaning")process.exit(1)})' ||
  fail "the query by meaning didn't find the sign-in thread first: $HITS"
# The other thread is still found, by its own words, and ranks first for its own query.
HITS=$(agent GET "/api/mail/search?box=$PM&q=invoice%20september")
echo "$HITS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);if(!h.length||h[0].subject!=="Quarterly invoice")process.exit(1)})' ||
  fail "the invoice query didn't rank the invoice thread first: $HITS"

# With search.embedder 'off', and the stub unset so the setting decides: keyword search only.
unset STAM_EMBEDDER
daemon_home off
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.search={embedder:"off"};require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$TEST_TMP/off/settings.json"
daemon_up off
use off
OFF_PM=$(spawn pm)
as_agent "$OFF_PM" POST /api/mail "{\"from\":\"$OFF_PM\",\"to\":[\"human\"],\"subject\":\"Sign-in bounce\",\"body\":\"users keep getting redirected back to the sign-in page after logout\",\"new_thread\":true}" >/dev/null
HITS=$(agent GET "/api/mail/search?box=$OFF_PM&q=redirect")
echo "$HITS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);if(!h.length||h[0].by!=="keyword")process.exit(1)})' ||
  fail "with the embedder off, the keyword search didn't answer: $HITS"
[ "$(agent GET "/api/mail/search?box=$OFF_PM&q=keeps%20redirecting%20users" | field length)" = 0 ] || fail "with the embedder off, a query by meaning still matched"
"$STAM" embedder status | grep -q '^state: off$' || fail "the off embedder didn't report off"
"$STAM" embedder status | grep -q 'indexed: nothing yet' || fail "the off embedder indexed mail"
export STAM_EMBEDDER=stub
use main
echo "PASS e2e-mail-embed"
