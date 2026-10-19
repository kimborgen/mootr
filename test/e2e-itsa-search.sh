#!/bin/sh
# Search by meaning over ITSAs and mail, free (no model): ITSAs are indexed as they're created and
# when their text is edited, and the agent's `search` tool ranks them by meaning, with a query
# worded differently from every title (it shares stems with one ITSA's body only). `kinds` limits
# the search to ITSAs; with search.embedder 'off' the same daemon answers by keyword. Runs on a
# throwaway daemon (test/lib.sh) with the stub embedder (STAM_EMBEDDER=stub) unless a test unsets
# it. The fake Claude Code runs the agent's turns, so no model runs; nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/itsa-search.json" <<'EOJ'
{ "agents": {
  "e2e-search-signin": { "turns": [
    { "match": "FIND-SIGNIN", "steps": [
      { "mcp": "search", "args": { "query": "keeps redirecting users", "kinds": ["itsa"] }, "save": { "first": "\\[itsa\\] (S-[0-9]+)" }, "expect": "[itsa] S-" },
      { "reply": "FIRST=${first}" } ] } ] },
  "e2e-search-all": { "turns": [
    { "match": "FIND-ALL", "steps": [
      { "mcp": "send_mail", "args": { "to": ["pm"], "subject": "Sign-in bounce", "body": "users keep getting redirected back to the sign-in page after logout", "new_thread": true } },
      { "mcp": "search", "args": { "query": "sign-in" }, "save": "ALL", "expect": "[mail]" },
      { "reply": "${ALL}" } ] } ] },
  "e2e-search-itsa": { "turns": [
    { "match": "FIND-ITSA", "steps": [
      { "mcp": "search", "args": { "query": "keeps redirecting users", "kinds": ["itsa"] }, "save": "ALL", "expect": "[itsa]" },
      { "reply": "${ALL}" } ] } ] }
} }
EOJ
fake_claude "$TEST_TMP/itsa-search.json"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
# agent METHOD PATH [JSON] as the daemon's own human-side caller; field PATH reads a JSON field from stdin.
agent() { curl -s -X "$1" -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
# As the human (x-stam-human): only a human request may pass by "human".
human() { curl -s -X "$1" -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'content-type: application/json' -H 'x-stam-human: 1' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
# The key of an ITSA the test created: `itsa KEY-NAME` reads the key saved for that title.
spawn() { agent POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"claude-sonnet-5-5\",\"cwd\":\"$TEST_TMP\",\"role\":\"test\"}" | field id; }
# The best ITSA for a query, by the daemon's search route.
top() { agent GET "/api/itsas/search?q=$(printf '%s' "$1" | sed 's/ /%20/g')&limit=5" | field 0.key; }
# ITSAs created through the API: one with the sign-in text in its body, two that don't share it.
create() { human POST /api/itsas "$(printf '%s' "$1" | sed 's/^{/{"by":"human",/')" | field key; }
SIGNIN=$(create '{"title":"Login regression","summary":"Sign-in breaks for returning people","body":"Users keep getting redirected back to the sign-in page after logout; the session cookie is dropped."}')
INVOICE=$(create '{"title":"Invoice reconciliation","summary":"Match the September invoices","body":"Reconcile the September invoices against the ledger before the close."}')
CHART=$(create '{"title":"Cost chart palette","summary":"Colours for the spend chart","body":"Pick a palette for the spend chart on the dashboard."}')
[ -n "$SIGNIN" ] && [ -n "$INVOICE" ] && [ -n "$CHART" ] || fail "creating the ITSAs: $SIGNIN $(agent POST /api/itsas "{\"title\":\"x\"}")"
indexed() { "$STAM" embedder status | grep -Eq "itsa: 3(,|\$)"; }
# Wait on the index's state: all three ITSAs are rows of the itsa source.
wait_until indexed
"$STAM" embedder status | grep -q '^state: stub$' || fail "the stub embedder isn't the one in use"

# By meaning, through the search route: the query shares stems with the sign-in body only.
[ "$(top "keeps redirecting users")" = "$SIGNIN" ] || fail "the sign-in ITSA doesn't rank first by meaning"

# Through the agent's search tool, ITSAs only: the sign-in ITSA first, and no mail line.
spawn pm >/dev/null
"$STAM" spawn e2e-search-signin --model claude-haiku-5-5 --cwd "$TEST_TMP" "FIND-SIGNIN"
"$STAM" wait e2e-search-signin --until idle --timeout 60
"$STAM" show e2e-search-signin | grep -q "FIRST=$SIGNIN" || fail "the search tool didn't rank the sign-in ITSA first: $("$STAM" show e2e-search-signin | tail -5)"

# Both kinds: the mail is in the list too, tagged [mail].
"$STAM" spawn e2e-search-all --model claude-haiku-5-5 --cwd "$TEST_TMP" "FIND-ALL"
"$STAM" wait e2e-search-all --until idle --timeout 60
"$STAM" show e2e-search-all | grep -q "\[mail\] " || fail "the mail hit is missing from the search with both kinds"

# Only ITSAs: no mail line, even though the mail matches.
"$STAM" spawn e2e-search-itsa --model claude-haiku-5-5 --cwd "$TEST_TMP" "FIND-ITSA"
"$STAM" wait e2e-search-itsa --until idle --timeout 60
"$STAM" show e2e-search-itsa | grep -q "\[itsa\] " || fail "the ITSA-only search found no ITSA"
"$STAM" show e2e-search-itsa | grep -q "\[mail\] " && fail "the ITSA-only search returned mail"

# Edit the sign-in ITSA's body to other words: its old text no longer ranks it first (re-embedded).
human PATCH "/api/itsas/$SIGNIN" '{"by":"human","body":"Quarterly headcount forecast for each team."}' >/dev/null
# The old text is gone from the index: the sign-in ITSA no longer matches the query it was found by.
gone() { ! agent GET "/api/itsas/search?q=keeps%20redirecting%20users&limit=5" | grep -q "$SIGNIN"; }
wait_until gone
# The new text is searchable by meaning too: the edited ITSA ranks first for its new words.
[ "$(top "headcount forecast")" = "$SIGNIN" ] || fail "the edited ITSA didn't re-embed its new text"

# With search.embedder 'off' (and the stub unset so the setting decides): keyword search only.
unset STAM_EMBEDDER
daemon_home off
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.search={embedder:"off"};require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$TEST_TMP/off/settings.json"
daemon_up off
use off
OFF_KEY=$(human POST /api/itsas '{"by":"human","title":"Login regression","body":"Users keep getting redirected back to the sign-in page after logout."}' | field key)
HITS=$(agent GET "/api/itsas/search?q=sign-in&limit=5")
echo "$HITS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);if(!h.length||h[0].by!=="keyword")process.exit(1)})' ||
  fail "with the embedder off, the keyword search didn't answer: $HITS"
[ "$(agent GET "/api/itsas/search?q=keeps%20redirecting%20users&limit=5" | field length)" = 0 ] || fail "with the embedder off, a query by meaning still matched"
# A query that is only a key finds that ITSA first, by keyword, with the embedder off.
[ "$(agent GET "/api/itsas/search?q=$OFF_KEY&limit=5" | field 0.key)" = "$OFF_KEY" ] || fail "with the embedder off, a key-only query didn't find $OFF_KEY first"
"$STAM" embedder status | grep -q '^state: off$' || fail "the off embedder didn't report off"
export STAM_EMBEDDER=stub
use main
echo "PASS e2e-itsa-search"
