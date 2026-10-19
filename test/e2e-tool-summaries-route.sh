#!/bin/sh
# POST /api/tool-summaries through the daemon (S-1481), with the stubbed model (free): the human's
# view gets a call's summary, an agent's own token is refused with 403, a bad request with 400
# (no agent, an agent name over 200 characters, a call without a name), and with the step off the
# answer is empty and no model is asked. One daemon, one registered agent, no model turns.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
stub_key main
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$(dirname "$(readlink -f "$0")")/decide-stub.mjs" "$STUB" &
STUB_PID=$!
for _i in $(seq 1 50); do
  [ -s "$STUB/url" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || { echo "FAIL: the stub endpoint didn't start"; exit 1; }
  sleep 0.2
done
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
python3 - "$TEST_TMP/main/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.setdefault('tiny', {})['toolSummary'] = {'enabled': True}
json.dump(s, open(p, 'w'), indent=2)
PY
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
calls() { cat "$STUB/titles" 2>/dev/null || echo 0; }
# code TOKEN BODY: the HTTP status of a tool-summaries request, its body in $TEST_TMP/out.json.
code() { codep "$1" /api/tool-summaries "$2"; }
# codep TOKEN PATH BODY: the HTTP status of a POST to PATH, its body in $TEST_TMP/out.json.
codep() { curl -s -o "$TEST_TMP/out.json" -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$3" "$STAM_URL$2"; }
CALL='{"id":"toolu_1","name":"Read","input":{"file_path":"/a.ts"}}'

[ "$(code "$TOKEN" '{"agent":"ag","calls":['"$CALL"'],"wait":5000}')" = 200 ] || fail "the human's request got $(cat "$TEST_TMP/out.json")"
grep -q '"toolu_1":{"tool":"stub Read","doing":"doing the stub work of Read"}' "$TEST_TMP/out.json" || fail "no summary: $(cat "$TEST_TMP/out.json")"
echo "ok: the human's view gets a call's summary"

REG=$(curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d '{"name":"reader","role":"test","token":true}' "$STAM_URL/api/register")
AGENT_TOKEN=$(echo "$REG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
[ -n "$AGENT_TOKEN" ] || fail "no agent token"
[ "$(code "$AGENT_TOKEN" '{"agent":"ag","calls":['"$CALL"']}')" = 403 ] || fail "an agent's token wasn't refused: $(cat "$TEST_TMP/out.json")"
echo "ok: an agent's own token is refused with 403"

# The mail titles route (S-1843) is the human's view too: an agent's token is refused, and ids must be a list of ids.
[ "$(codep "$AGENT_TOKEN" /api/mail-titles '{"ids":["m1"]}')" = 403 ] || fail "an agent's token wasn't refused by mail titles: $(cat "$TEST_TMP/out.json")"
[ "$(codep "$TOKEN" /api/mail-titles '{"ids":"m1"}')" = 400 ] || fail "mail titles took ids that aren't a list"
[ "$(codep "$TOKEN" /api/mail-titles '{"ids":[]}')" = 200 ] || fail "mail titles refused an empty list"
echo "ok: mail titles refuse an agent and take only a list of ids"

# The tool names route (S-1933) is the human's view too: an agent's token is refused, the request is checked,
# an unknown agent is 404, and a registered agent's tools get the model's label once.
[ "$(codep "$AGENT_TOKEN" /api/tool-names '{"agent":"reader","names":["Bash"]}')" = 403 ] || fail "an agent's token wasn't refused by tool names: $(cat "$TEST_TMP/out.json")"
[ "$(codep "$TOKEN" /api/tool-names '{"names":["Bash"]}')" = 400 ] || fail "tool names took a request with no agent"
[ "$(codep "$TOKEN" /api/tool-names '{"agent":"reader","names":"Bash"}')" = 400 ] || fail "tool names took names that aren't a list"
[ "$(codep "$TOKEN" /api/tool-names '{"agent":"nobody","names":["Bash"]}')" = 404 ] || fail "tool names took an unknown agent"
before=$(calls)
[ "$(codep "$TOKEN" /api/tool-names '{"agent":"reader","names":["mcp__stam__send_mail"],"wait":5000}')" = 200 ] || fail "tool names for a registered agent failed: $(cat "$TEST_TMP/out.json")"
grep -q '"mcp__stam__send_mail":"Stub send_mail"' "$TEST_TMP/out.json" || fail "no label: $(cat "$TEST_TMP/out.json")"
[ "$(codep "$TOKEN" /api/tool-names '{"agent":"reader","names":["mcp__stam__send_mail"]}')" = 200 ] || fail "the second request failed"
[ "$(calls)" = "$((before + 1))" ] || fail "the tool was named more than once"
echo "ok: tool names refuse an agent and bad requests, and name a tool once"

LONG=$(printf 'a%.0s' $(seq 1 201))
[ "$(code "$TOKEN" '{"calls":[]}')" = 400 ] || fail "a request with no agent wasn't refused"
[ "$(code "$TOKEN" '{"agent":"'"$LONG"'","calls":[]}')" = 400 ] || fail "an agent name of 201 characters wasn't refused"
[ "$(code "$TOKEN" '{"agent":"ag","calls":[{"id":"x"}]}')" = 400 ] || fail "a call with no name wasn't refused"
echo "ok: bad requests are refused with 400"

# A hand edit of the file turns the step off: the daemon reads it on the next request.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s['tiny']['toolSummary']['enabled'] = False
json.dump(s, open(p, 'w'), indent=2)
PY
before=$(calls)
[ "$(code "$TOKEN" '{"agent":"ag","calls":['"$CALL"',{"id":"new","name":"Bash"}],"wait":500}')" = 200 ] || fail "the request with the step off failed"
# The stored summary still shows (S-1843); the call with none is neither asked nor pending.
grep -q '^{"enabled":false,"summaries":{"toolu_1":{"tool":"stub Read","doing":"doing the stub work of Read"}},"pending":\[\]}$' "$TEST_TMP/out.json" || fail "the step off didn't return the stored summary alone: $(cat "$TEST_TMP/out.json")"
[ "$(calls)" = "$before" ] || fail "the step off still asked the model"
echo "ok: with the step off nothing is asked, and stored summaries are returned"
kill "$STUB_PID" 2>/dev/null || true
